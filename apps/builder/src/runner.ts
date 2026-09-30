import { promises as fs } from 'fs';
import { join } from 'path';
import type { BuilderConfig } from './config';
import { zipCommit } from './extract';
import { JobLog } from './log';
import type { JobDef, RunPaths, ShOptions, StepContext } from './pipeline';
import { runCommand, StepCancelled } from './process';
import type { RunStore } from './store';
import type { Conclusion, JobRecord, RunParams, RunRecord } from './types';

const now = () => new Date().toISOString();

/** Environment a build step sees: the toolchain and nothing else (no tokens, no keys). */
const TOOLCHAIN_VARS = ['PATH', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'FLUTTER_ROOT', 'PUB_CACHE', 'GRADLE_USER_HOME', 'JAVA_HOME'];

export type PipelineFor = (run: RunRecord) => JobDef[];

export interface NewRun {
  upload: string;
  fileName: string;
  sizeBytes: number;
  uploadedBy: string;
  params: RunParams;
  rerunOf?: number | null;
}

/**
 * Executes runs one at a time with GitHub Actions' semantics, so the console can read a
 * local run exactly like a GitHub one:
 * - a failed step skips the rest of its job, except steps marked `always` (report uploads);
 * - a job whose `needs` did not succeed is skipped;
 * - a cancel stops the running step's whole process group and cancels what is left;
 * - cleanup steps ("Complete job") run no matter what.
 */
export class Runner {
  private queue: number[] = [];
  private active: { id: number; abort: AbortController } | null = null;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: BuilderConfig,
    private readonly store: RunStore,
    private readonly pipelineFor: PipelineFor,
    private readonly uploadsDir: string,
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  get queued(): number[] {
    return [...this.queue];
  }

  paths(id: number, upload: string): RunPaths {
    const run = this.store.dir(id);
    return {
      run,
      src: join(run, 'src'),
      artifacts: join(run, 'artifacts'),
      logs: join(run, 'logs'),
      play: join(run, 'play'),
      upload: join(this.uploadsDir, upload),
    };
  }

  async create(input: NewRun): Promise<RunRecord> {
    const id = await this.store.nextId();
    const at = now();
    const run: RunRecord = {
      id,
      status: 'queued',
      conclusion: null,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      completedAt: null,
      source: {
        fileName: input.fileName,
        upload: input.upload,
        sizeBytes: input.sizeBytes,
        sha: await zipCommit(join(this.uploadsDir, input.upload)),
        root: null,
        uploadedBy: input.uploadedBy,
        rerunOf: input.rerunOf ?? null,
      },
      params: input.params,
      plan: null,
      jobs: [],
      error: null,
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
    this.enqueue(id);
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

  /** Resolves when nothing is running or queued (for tests and shutdown). */
  async drain(): Promise<void> {
    while (this.active || this.queue.length) await this.idle;
  }

  /** After a restart: a run caught mid-flight cannot resume; a queued one simply waits again. */
  async recover(): Promise<void> {
    for (const run of (await this.store.list()).reverse()) {
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
    this.active = { id, abort };
    let release!: () => void;
    this.idle = new Promise((r) => (release = r));
    try {
      const run = await this.store.get(id);
      if (run && run.status === 'queued') await this.execute(run, abort.signal);
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

  private async execute(run: RunRecord, signal: AbortSignal): Promise<void> {
    const paths = this.paths(run.id, run.source.upload);
    await fs.mkdir(paths.logs, { recursive: true });
    await fs.mkdir(paths.artifacts, { recursive: true });
    const save = async () => {
      run.updatedAt = now();
      await this.store.save(run);
    };
    run.status = 'in_progress';
    run.startedAt = now();
    await save();

    const defs = this.pipelineFor(run);
    const results = new Map<string, Conclusion>();

    for (const [i, def] of defs.entries()) {
      const job = run.jobs[i];
      if (signal.aborted) {
        this.finishUnrun(job, 'cancelled');
        results.set(def.key, 'cancelled');
        await save();
        continue;
      }
      if (def.needs.some((n) => results.get(n) !== 'success')) {
        this.finishUnrun(job, 'skipped');
        results.set(def.key, 'skipped');
        await save();
        continue;
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
      results.set(def.key, job.conclusion);
      await save();
    }

    const all = [...results.values()];
    run.status = 'completed';
    run.conclusion = all.includes('cancelled') ? 'cancelled' : all.includes('failure') ? 'failure' : 'success';
    run.completedAt = now();
    await save();
  }

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
   * After each run: the unpacked source and the Fastlane folder go (they are large and
   * reproducible), older runs beyond the retention limit go, and uploads no recent run can
   * re-run from go.
   */
  private async housekeeping(id: number): Promise<void> {
    const paths = this.paths(id, '');
    await fs.rm(paths.src, { recursive: true, force: true });
    await fs.rm(paths.play, { recursive: true, force: true });
    const runs = await this.store.list();
    const finished = runs.filter((r) => r.status === 'completed');
    for (const old of finished.slice(this.cfg.keepRuns)) await this.store.remove(old.id);
    const keep = new Set(runs.slice(0, this.cfg.keepUploads).map((r) => r.source.upload));
    for (const r of runs) if (r.status !== 'completed') keep.add(r.source.upload);
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
