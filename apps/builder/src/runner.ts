import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { BuilderConfig } from './config';
import { zipCommit } from './extract';
import { JobLog } from './log';
import { loadFastlaneFiles, macAssignment } from './mac-jobs';
import { readPlan, sourceArchive, type JobDef, type RunPaths, type Services, type ShOptions, type StepContext } from './pipeline';
import { runCommand, StepCancelled } from './process';
import type { RunStore } from './store';
import type { CommitInfo, Conclusion, JobRecord, MacRunnerRecord, RunApp, RunnerKind, RunParams, RunRecord, RunSource } from './types';

const now = () => new Date().toISOString();

/** The console API's group (the `node` user of its image): it reads artifacts off the shared volume. */
export const API_GID = 1000;

/**
 * A run's artifacts and logs are for root (which writes them) and the console API (which reads
 * them), not for the build user: one app's build must not read another app's bundle or mapping.
 */
export async function closeToBuilds(runDir: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  for (const sub of ['artifacts', 'logs']) {
    const dir = join(runDir, sub);
    if (!(await fs.stat(dir).catch(() => null))) continue;
    await fs.chown(dir, 0, API_GID);
    await fs.chmod(dir, 0o750);
  }
}

/** Environment a build step sees: the toolchain and nothing else (no tokens, no keys). */
const TOOLCHAIN_VARS = ['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'FLUTTER_ROOT', 'PUB_CACHE', 'GRADLE_USER_HOME', 'JAVA_HOME'];

export type PipelineFor = (run: RunRecord) => JobDef[];

export type NewSource =
  | { kind: 'git'; url: string; branch: string; requestedSha: string | null; commit?: CommitInfo | null }
  | { kind: 'zip'; upload: string; fileName: string; sizeBytes: number };

export interface NewRun {
  app: RunApp;
  number: number;
  source: NewSource;
  params: RunParams;
  startedBy: string;
  rerunOf?: number | null;
  /** Where it runs: this server (default), or GitHub Actions in the app's repository. iOS runs always run on a Mac. */
  runner?: RunnerKind;
  github?: { repo: string; workflow: string } | null;
}

interface Live {
  id: number;
  abort: AbortController;
  run: RunRecord | null;
}

/**
 * Executes runs with GitHub Actions' semantics, so every run reads alike:
 * - a failed step skips the rest of its job, except steps marked `always` (report uploads);
 * - a job whose `needs` did not succeed is skipped;
 * - a cancel stops the running step's whole process group and cancels what is left;
 * - cleanup steps ("Complete job") run no matter what.
 *
 * Runs on this server go one at a time through one queue. Runs on GitHub Actions do not wait
 * for it: each is planned here at once, started on GitHub, and followed until it ends. iOS runs
 * do not wait for it either: each is planned here at once, handed to the Mac runners (macs.ts)
 * and followed until its Mac reports the end.
 */
export class Runner {
  private queue: number[] = [];
  private active: Live | null = null;
  private readonly remote = new Map<number, Live>();
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: BuilderConfig,
    private readonly store: RunStore,
    private readonly pipelineFor: PipelineFor,
    private readonly uploadsDir: string,
    private readonly services: Services,
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  get queued(): number[] {
    return [...this.queue];
  }

  /** The run on this server and the job it is in, for the console's status line. */
  get current(): { id: number; appId: string | null; appName: string | null; number: number; job: string | null } | null {
    const run = this.active?.run;
    if (!this.active || !run) return null;
    return Runner.describe(run);
  }

  /** Runs on GitHub Actions the console is planning or following now. */
  get onGithub(): Array<{ id: number; appId: string | null; appName: string | null; number: number; job: string | null }> {
    return [...this.remote.values()].filter((l) => l.run?.remote?.kind === 'github').map((l) => Runner.describe(l.run!));
  }

  /** iOS runs the console is planning, or that wait for or run on a Mac, now. */
  get onMac(): Array<{ id: number; appId: string | null; appName: string | null; number: number; job: string | null; runner: string | null; waiting: boolean }> {
    return [...this.remote.values()]
      .filter((l) => l.run?.remote?.kind === 'mac')
      .map((l) => {
        const remote = l.run!.remote!;
        return {
          ...Runner.describe(l.run!),
          runner: remote.kind === 'mac' ? remote.runnerName : null,
          waiting: remote.kind === 'mac' && (remote.state === 'waiting' || remote.state === 'offered'),
        };
      });
  }

  private static describe(run: RunRecord) {
    return {
      id: run.id,
      appId: run.app?.id ?? null,
      appName: run.app?.name ?? null,
      number: run.number,
      job: run.jobs.find((j) => j.status === 'in_progress')?.name ?? null,
    };
  }

  /** A sentence naming the run that holds a Google Play edit for this package now, or null. */
  uploading(packageName: string): string | null {
    for (const live of [this.active, ...this.remote.values()]) {
      const run = live?.run;
      if (!run || run.app?.packageName !== packageName) continue;
      const job = run.jobs.find((j) => j.name === 'Google Play' && j.status === 'in_progress');
      if (job) return `${run.app.name} #${run.number} is uploading to Google Play${run.runner === 'github' ? ' from GitHub Actions' : ''}.`;
    }
    return null;
  }

  paths(id: number, upload: string): RunPaths {
    const run = this.store.dir(id);
    return {
      run,
      src: join(run, 'src'),
      artifacts: join(run, 'artifacts'),
      logs: join(run, 'logs'),
      play: join(run, 'play'),
      signing: join(run, 'signing'),
      upload: join(this.uploadsDir, upload),
    };
  }

  async create(input: NewRun): Promise<RunRecord> {
    const id = await this.store.nextId();
    const at = now();
    const base = { sha: null, root: null, commit: null, startedBy: input.startedBy, rerunOf: input.rerunOf ?? null };
    const source: RunSource =
      input.source.kind === 'git'
        ? { kind: 'git', url: input.source.url, branch: input.source.branch, requestedSha: input.source.requestedSha, ...base, commit: input.source.commit ?? null }
        : {
            kind: 'zip',
            fileName: input.source.fileName,
            upload: input.source.upload,
            sizeBytes: input.source.sizeBytes,
            ...base,
            sha: await zipCommit(join(this.uploadsDir, input.source.upload)),
          };
    if (source.kind === 'git' && source.requestedSha) source.sha = source.requestedSha;
    const onMac = input.params.platform === 'ios';
    const onGithub = !onMac && input.runner === 'github' && input.github && source.kind === 'git';
    const run: RunRecord = {
      id,
      app: input.app,
      number: input.number,
      status: 'queued',
      conclusion: null,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      completedAt: null,
      source,
      params: input.params,
      plan: null,
      jobs: [],
      error: null,
      runner: onMac ? 'mac' : onGithub ? 'github' : 'server',
      remote: onMac
        ? { kind: 'mac', state: 'waiting', runnerId: null, runnerName: null, queuedAt: null, offeredAt: null, acceptedAt: null, lastHeardAt: null, cancelRequested: false }
        : onGithub
          ? { kind: 'github', repo: input.github!.repo, workflow: input.github!.workflow, requestId: randomBytes(3).toString('hex'), runId: null, url: null, dispatchedAt: null, fetched: [] }
          : null,
    };
    // Every job and step exists from the start, queued, as GitHub lists a workflow's jobs.
    run.jobs = this.pipelineFor(run).map((job, i) => ({
      id: i + 1,
      name: job.name,
      status: 'queued',
      conclusion: null,
      started_at: null,
      completed_at: null,
      steps: job.steps.map((s, n) => ({ name: s.name, number: n + 1, status: 'queued', conclusion: null, started_at: null, completed_at: null })),
    }));
    await this.store.save(run);
    if (run.runner === 'github' || run.runner === 'mac') void this.startRemote(id, false);
    else this.enqueue(id);
    return run;
  }

  enqueue(id: number): void {
    this.queue.push(id);
    void this.pump();
  }

  async cancel(id: number): Promise<boolean> {
    if (this.active?.id === id) {
      this.active.abort.abort();
      return true;
    }
    const remote = this.remote.get(id);
    if (remote) {
      remote.abort.abort();
      return true;
    }
    const i = this.queue.indexOf(id);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    const run = await this.store.get(id);
    if (run) {
      for (const job of run.jobs) this.finishUnrun(job, 'cancelled');
      run.status = 'completed';
      run.conclusion = 'cancelled';
      run.completedAt = run.updatedAt = now();
      await this.store.save(run);
    }
    return true;
  }

  /** Resolves when nothing is running, queued or followed (for tests and shutdown). */
  async drain(): Promise<void> {
    while (this.active || this.queue.length || this.remote.size) {
      if (this.active || this.queue.length) await this.idle;
      else await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * After a restart: a run caught mid-flight on this server cannot resume, and a queued one
   * waits again. A run on GitHub carried on without the console: following it resumes. An iOS
   * run that its Plan job had already handed over waits for (or keeps reporting from) its Mac.
   */
  async recover(): Promise<void> {
    for (const run of (await this.store.list()).reverse()) {
      const remote = run.remote;
      if (remote?.kind === 'github' && (run.status === 'in_progress' || run.status === 'queued')) {
        if (remote.runId || remote.dispatchedAt) {
          void this.startRemote(run.id, true);
          continue;
        }
        if (run.status === 'queued') {
          void this.startRemote(run.id, false);
          continue;
        }
      }
      if (remote?.kind === 'mac' && (run.status === 'in_progress' || run.status === 'queued')) {
        const planned = run.jobs.find((j) => j.name === 'Plan')?.conclusion === 'success';
        if (planned) {
          void this.startRemote(run.id, true);
          continue;
        }
        if (run.status === 'queued') {
          void this.startRemote(run.id, false);
          continue;
        }
      }
      if (run.status === 'in_progress') {
        for (const job of run.jobs) {
          if (job.status === 'in_progress') {
            for (const s of job.steps) if (s.status !== 'completed') this.finishStep(s, s.status === 'in_progress' ? 'failure' : 'skipped');
            job.status = 'completed';
            job.conclusion = 'failure';
            job.completed_at = now();
          } else if (job.status === 'queued') this.finishUnrun(job, 'skipped');
        }
        run.status = 'completed';
        run.conclusion = 'failure';
        run.error = 'The builder restarted while this run was in progress. Start it again.';
        run.completedAt = run.updatedAt = now();
        await this.store.save(run);
      } else if (run.status === 'queued') {
        this.queue.push(run.id);
      }
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    const abort = new AbortController();
    this.active = { id, abort, run: null };
    let release!: () => void;
    this.idle = new Promise((r) => (release = r));
    try {
      const run = await this.store.get(id);
      if (run && run.status === 'queued') {
        this.active.run = run;
        await this.execute(run, abort.signal);
      }
    } catch (e) {
      console.error(`run ${id}: ${(e as Error).stack ?? e}`);
    } finally {
      // Tidy up before declaring the builder idle, so nothing reads a half-cleaned run.
      await this.housekeeping(id).catch((e: unknown) => console.error(`housekeeping: ${(e as Error).message}`));
      this.active = null;
      release();
      void this.pump();
    }
  }

  private async prepare(run: RunRecord): Promise<{ paths: RunPaths; save: () => Promise<void> }> {
    const paths = this.paths(run.id, run.source.kind === 'zip' ? run.source.upload : '');
    await fs.mkdir(paths.logs, { recursive: true });
    await fs.mkdir(paths.artifacts, { recursive: true });
    await closeToBuilds(paths.run);
    const save = async () => {
      run.updatedAt = now();
      await this.store.save(run);
    };
    return { paths, save };
  }

  private async execute(run: RunRecord, signal: AbortSignal): Promise<void> {
    const { paths, save } = await this.prepare(run);
    run.status = 'in_progress';
    run.startedAt = now();
    await save();

    const defs = this.pipelineFor(run);
    const results = new Map<string, Conclusion>();
    for (const [i, def] of defs.entries()) {
      results.set(def.key, await this.runJob(run, def, run.jobs[i], paths, signal, save, results));
    }
    const all = [...results.values()];
    run.status = 'completed';
    run.conclusion = all.includes('cancelled') ? 'cancelled' : all.includes('failure') ? 'failure' : 'success';
    run.completedAt = now();
    await save();
  }

  /** One job of a run on this server, step by step; returns how it ended. */
  private async runJob(
    run: RunRecord,
    def: JobDef,
    job: JobRecord,
    paths: RunPaths,
    signal: AbortSignal,
    save: () => Promise<void>,
    results: Map<string, Conclusion>,
  ): Promise<Conclusion> {
    if (signal.aborted) {
      this.finishUnrun(job, 'cancelled');
      await save();
      return 'cancelled';
    }
    if (def.needs.some((n) => results.get(n) !== 'success')) {
      this.finishUnrun(job, 'skipped');
      await save();
      return 'skipped';
    }

    job.status = 'in_progress';
    job.started_at = now();
    await save();
    const log = new JobLog(join(paths.logs, `${job.id}.log`));
    const deadline = Date.now() + def.timeoutMin * 60_000;
    const project = () => (run.source.root ? join(paths.src, run.source.root) : paths.src);
    const contextFor = (stepSignal: AbortSignal): StepContext => ({
      cfg: this.cfg,
      run,
      paths,
      log,
      signal: stepSignal,
      services: this.services,
      save,
      project,
      sh: (command: string, opts: ShOptions = {}) => {
        log.step(command);
        return runCommand(command, {
          cwd: opts.where === 'play' ? paths.play : project(),
          env: this.env(run, paths, opts),
          ...(opts.asRoot || process.getuid?.() !== 0 ? {} : { uid: this.cfg.buildUid, gid: this.cfg.buildGid }),
          log,
          signal: stepSignal,
          // Cleanup gets its own minute even when the job ran out of time.
          timeoutMs: Math.max(60_000, deadline - Date.now()),
        });
      },
    });

    let failed = false;
    let cancelled = false;
    for (const [n, step] of def.steps.entries()) {
      const rec = job.steps[n];
      const blocked = cancelled || signal.aborted ? !step.cleanup : failed && !step.always && !step.cleanup;
      if (blocked) {
        this.finishStep(rec, cancelled || signal.aborted ? 'cancelled' : 'skipped');
        continue;
      }
      // A cleanup step must still be able to run after a cancel, so it gets a fresh signal.
      const stepSignal = step.cleanup ? new AbortController().signal : signal;
      rec.status = 'in_progress';
      rec.started_at = now();
      await save();
      try {
        await step.run(contextFor(stepSignal));
        this.finishStep(rec, 'success');
      } catch (e) {
        if (e instanceof StepCancelled || stepSignal.aborted) {
          cancelled = true;
          log.error('The run was cancelled.');
          this.finishStep(rec, 'cancelled');
        } else {
          failed = true;
          log.error((e as Error).message);
          this.finishStep(rec, 'failure');
        }
      }
      await save();
    }
    await log.close();
    job.status = 'completed';
    job.conclusion = cancelled ? 'cancelled' : failed ? 'failure' : 'success';
    job.completed_at = now();
    await save();
    return job.conclusion;
  }

  // ─── Runs on GitHub Actions and on Mac runners ───────────────────────────────────────

  /** Plans and starts a run on GitHub or a Mac (or, after a restart, picks up following it). */
  private async startRemote(id: number, resume: boolean): Promise<void> {
    if (this.remote.has(id)) return;
    const live: Live = { id, abort: new AbortController(), run: null };
    this.remote.set(id, live);
    let where = 'GitHub';
    try {
      const run = await this.store.get(id);
      if (!run || run.status === 'completed' || !run.remote) return;
      live.run = run;
      if (run.remote.kind === 'mac') {
        where = 'Mac';
        await this.executeMac(run, live.abort.signal, resume);
      } else await this.executeRemote(run, live.abort.signal, resume);
    } catch (e) {
      console.error(`run ${id} (${where}): ${(e as Error).stack ?? e}`);
    } finally {
      await this.housekeeping(id).catch((e: unknown) => console.error(`housekeeping: ${(e as Error).message}`));
      this.remote.delete(id);
    }
  }

  /** Closes a remote run: whatever never ran is cancelled or skipped, and the record says how it ended. */
  private closer(run: RunRecord, save: () => Promise<void>) {
    return async (conclusion: Conclusion, error?: string) => {
      for (const job of run.jobs) if (job.status !== 'completed') this.finishUnrun(job, conclusion === 'cancelled' ? 'cancelled' : 'skipped');
      run.status = 'completed';
      run.conclusion = conclusion;
      if (error) run.error = error;
      run.completedAt = now();
      await save();
    };
  }

  /** Runs the jobs this server owns in a remote run (its Plan); returns how they ended. */
  private async planHere(run: RunRecord, paths: RunPaths, signal: AbortSignal, save: () => Promise<void>): Promise<Conclusion[]> {
    run.status = 'in_progress';
    run.startedAt = now();
    await save();
    const results = new Map<string, Conclusion>();
    for (const [i, def] of this.pipelineFor(run).entries()) {
      if (def.remote) continue;
      results.set(def.key, await this.runJob(run, def, run.jobs[i], paths, signal, save, results));
    }
    return [...results.values()];
  }

  private async executeRemote(run: RunRecord, signal: AbortSignal, resume: boolean): Promise<void> {
    const { paths, save } = await this.prepare(run);
    const remote = run.remote;
    if (remote?.kind !== 'github') return;
    const finish = this.closer(run, save);

    if (!resume) {
      const planned = await this.planHere(run, paths, signal, save);
      if (planned.some((c) => c !== 'success') || !remote.runId) {
        // Started on GitHub after all (a cancel in its last moment): stop it there too.
        if (remote.runId && signal.aborted) {
          const app = run.app ? await this.services.apps.get(run.app.id) : null;
          if (app) await this.services.github.cancel(app, remote.runId).catch(() => undefined);
        }
        return finish(planned.includes('cancelled') ? 'cancelled' : 'failure');
      }
    } else if (!remote.runId) {
      // The builder restarted between the dispatch and GitHub naming the run: find it.
      const app = run.app ? await this.services.apps.get(run.app.id) : null;
      const found = app ? await this.services.github.find(app, remote.requestId, 5).catch(() => null) : null;
      if (!found) return finish('failure', `The builder restarted while starting this run on GitHub, and the run was not found in ${remote.repo}'s Actions list. Look for it there, or start it again.`);
      remote.runId = found.id;
      remote.url = found.html_url;
      await save();
    }

    // What following the run does (artifacts copied, GitHub not answering) goes on in the
    // Plan job's log, under its last step.
    const log = new JobLog(join(paths.logs, `${run.jobs.find((j) => j.name === 'Plan')?.id ?? 1}.log`));
    try {
      await this.services.github.follow(run, {
        logsDir: paths.logs,
        artifactsDir: paths.artifacts,
        save,
        signal,
        log: (text) => log.line(text),
      });
    } finally {
      await log.close();
    }
    await finish(run.conclusion ?? 'failure');
  }

  /**
   * An iOS run: its Plan job here (checkout, checks, build number, the source packed), then the
   * Mac runners take it and the pool follows it until its Mac reports the end, goes quiet, or
   * the run is cancelled. After a restart the planning is not repeated: the run waits for a Mac
   * again, or keeps listening to the Mac that has it.
   */
  private async executeMac(run: RunRecord, signal: AbortSignal, resume: boolean): Promise<void> {
    const { paths, save } = await this.prepare(run);
    if (run.remote?.kind !== 'mac') return;
    const finish = this.closer(run, save);
    if (!resume) {
      const planned = await this.planHere(run, paths, signal, save);
      if (planned.some((c) => c !== 'success')) return finish(planned.includes('cancelled') ? 'cancelled' : 'failure');
    }
    // Who took the run and who went quiet goes on in the Plan job's log, under its last step.
    const log = new JobLog(join(paths.logs, `${run.jobs.find((j) => j.name === 'Plan')?.id ?? 1}.log`));
    try {
      await this.services.macs.follow(
        {
          run,
          save,
          logsDir: paths.logs,
          artifactsDir: paths.artifacts,
          sourceFile: sourceArchive(paths),
          note: (text) => log.line(text),
          assignment: (mac) => this.assignmentFor(run, paths, mac),
        },
        signal,
      );
    } finally {
      await log.close();
    }
    await finish(run.conclusion ?? 'failure');
  }

  /** The work order for the Mac that takes an iOS run, its secrets sealed to that Mac's key. */
  private async assignmentFor(run: RunRecord, paths: RunPaths, mac: MacRunnerRecord) {
    if (!mac.publicKey) throw new Error(`${mac.name} has no pinned key yet.`);
    if (!run.app) throw new Error('The run belongs to no app.');
    const app = await this.services.apps.require(run.app.id);
    const plan = await readPlan(paths);
    const signing = await this.services.apps.iosSigning(app);
    if (!signing) throw new Error(`${app.name}'s distribution certificate is no longer stored; upload it again in its settings → iOS.`);
    const appStore = plan.mode === 'release' ? await this.services.apps.appStoreKey(app) : null;
    const source = JSON.parse(await fs.readFile(join(paths.run, 'source.json'), 'utf8')) as { sizeBytes: number; sha256: string };
    return macAssignment({ run, plan, app, publicKey: mac.publicKey, signing, appStore, source, files: await loadFastlaneFiles(this.cfg.pipelineDir) });
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────

  private env(run: RunRecord, paths: RunPaths, opts: ShOptions): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      CI: 'true',
      TERM: 'dumb',
      FLUTTER_SUPPRESS_ANALYTICS: 'true',
    };
    for (const k of TOOLCHAIN_VARS) if (process.env[k]) env[k] = process.env[k];
    if (opts.asRoot) {
      Object.assign(env, {
        HOME: '/root',
        BUNDLE_GEMFILE: join(paths.play, 'Gemfile'),
        GITHUB_WORKSPACE: paths.play,
        FASTLANE_SKIP_UPDATE_CHECK: '1',
        FASTLANE_HIDE_CHANGELOG: '1',
        FASTLANE_OPT_OUT_USAGE: '1',
      });
    } else {
      Object.assign(env, { HOME: this.cfg.buildHome, USER: 'builder' });
    }
    if (run.plan) {
      env.VERSION_NAME = run.plan.versionName;
      env.VERSION_CODE = String(run.plan.versionCode);
    }
    return { ...env, ...(opts.env ?? {}) };
  }

  private finishStep(step: JobRecord['steps'][number], conclusion: Conclusion): void {
    step.status = 'completed';
    step.conclusion = conclusion;
    step.started_at ??= now();
    step.completed_at = now();
  }

  private finishUnrun(job: JobRecord, conclusion: 'cancelled' | 'skipped'): void {
    job.status = 'completed';
    job.conclusion = conclusion;
    job.completed_at = now();
    for (const s of job.steps) if (s.status !== 'completed') this.finishStep(s, conclusion === 'cancelled' ? 'cancelled' : 'skipped');
  }

  /**
   * After each run: the checkout, the Fastlane folder and the throwaway key go (large, or no
   * longer needed); an app's finished runs beyond the retention limit go; uploads no recent
   * run can re-run from go.
   */
  private async housekeeping(id: number): Promise<void> {
    const paths = this.paths(id, '');
    await fs.rm(paths.src, { recursive: true, force: true });
    await fs.rm(paths.play, { recursive: true, force: true });
    await fs.rm(paths.signing, { recursive: true, force: true });
    await fs.rm(join(paths.run, '.throwaway'), { force: true });
    await fs.rm(sourceArchive(paths), { force: true });
    await fs.rm(join(paths.run, 'source.json'), { force: true });
    const runs = await this.store.list();
    const byApp = new Map<string, RunRecord[]>();
    for (const r of runs) {
      if (r.status !== 'completed') continue;
      const key = r.app?.id ?? '';
      byApp.set(key, [...(byApp.get(key) ?? []), r]);
    }
    for (const finished of byApp.values()) for (const old of finished.slice(this.cfg.keepRuns)) await this.store.remove(old.id);
    const zipRuns = runs.filter((r) => r.source.kind === 'zip');
    const keep = new Set(zipRuns.slice(0, this.cfg.keepUploads).map((r) => (r.source.kind === 'zip' ? r.source.upload : '')));
    for (const r of zipRuns) if (r.status !== 'completed' && r.source.kind === 'zip') keep.add(r.source.upload);
    const hourAgo = Date.now() - 60 * 60 * 1000;
    for (const name of await fs.readdir(this.uploadsDir).catch(() => [] as string[])) {
      if (keep.has(name)) continue;
      const file = join(this.uploadsDir, name);
      // A fresh upload may belong to a run the console is creating right now.
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.mtimeMs < hourAgo) await fs.rm(file, { force: true });
    }
  }
}
