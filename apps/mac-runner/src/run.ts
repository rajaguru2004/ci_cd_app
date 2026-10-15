import { createHash } from 'crypto';
import { Transform } from 'stream';
import { ConsoleApi, ConsoleError } from './api';
import type { AgentConfig } from './config';
import { envLines, Executor, q } from './executor';
import type { HostEnv } from './host';
import { LogBuffer } from './joblog';
import type { AgentKeys } from './keys';
import type { Assignment, Conclusion, HostFacts, JobReport, JobSpec, StepReport, StepSpec, WriteSpec } from './protocol';
import { open } from './seal';

/**
 * One run on the Mac, with the console's semantics (the same as its own builder and GitHub
 * Actions): a failed step skips the rest of its job except `always` steps; a job whose needs
 * did not succeed is skipped; a cancel stops the running step's whole process group and
 * cancels what is left; cleanup steps (removing the signing, forgetting keys) run no matter what.
 *
 * Job and step states and log lines go to the console every two seconds (every ten when
 * nothing changed, which also tells it the Mac is alive); its answer can carry a cancel.
 */

export class StepFailed extends Error {}
class Cancelled extends Error {}

export interface RunDeps {
  api: ConsoleApi;
  exec: Executor;
  keys: AgentKeys;
  env: HostEnv;
  facts: HostFacts | null;
  cfg: AgentConfig;
  runnerName: string;
  /** The agent's own log (its container output). */
  say: (line: string) => void;
  /** Called whenever the console answered: the agent is alive and connected. */
  heartbeat: () => void;
}

const now = () => new Date().toISOString();
const MB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const REPORT_BYTES = 512 * 1024;

/** The run folder of runs that ended without cleaning up (a crash, a stopped container): keychain list restored, keychains and profiles removed. */
export const SWEEP_SCRIPT = (runsDir: string, keep: string) => `root=${q(runsDir)}
[ -d "$root" ] || exit 0
for d in "$root"/*/; do
  [ -d "$d" ] || continue
  if [ "\${d%/}" = ${q(keep)} ]; then continue; fi
  if [ -f "$d/keychains-before.txt" ]; then
    before=()
    while IFS= read -r k; do
      if [ -n "$k" ]; then before+=("$k"); fi
    done < "$d/keychains-before.txt"
    if [ \${#before[@]} -gt 0 ]; then security list-keychains -d user -s "\${before[@]}" 2>/dev/null || true; fi
    echo "Restored the keychain search list left by $d"
  fi
  if [ -f "$d/signing.keychain-db" ]; then security delete-keychain "$d/signing.keychain-db" 2>/dev/null || true; fi
  if [ -f "$d/installed-profiles.txt" ]; then
    while IFS= read -r p; do rm -f "$p"; done < "$d/installed-profiles.txt"
  fi
  rm -rf "$d"
done`;

export class RunExecution {
  private readonly jobs: JobReport[];
  private readonly logs = new Map<string, LogBuffer>();
  private secrets: Record<string, string> = {};
  private cancelled = false;
  private cancelReason: string | null = null;
  private stepAbort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reporting: Promise<void> = Promise.resolve();
  private lastSent = 0;
  private changed = true;
  private failures = 0;
  readonly dirs: { root: string; run: string; src: string; project: string; out: string; secrets: string; rc: string };

  constructor(
    private readonly a: Assignment,
    private readonly d: RunDeps,
  ) {
    this.jobs = a.jobs.map((j) => ({
      name: j.name,
      status: 'queued',
      conclusion: null,
      started_at: null,
      completed_at: null,
      steps: j.steps.map((s, i): StepReport => ({ name: s.name, number: i + 1, status: 'queued', conclusion: null, started_at: null, completed_at: null })),
    }));
    const root = d.cfg.workDir.replace(/^~(?=\/|$)/, d.env.home).replace(/\/+$/, '');
    const run = `${root}/runs/${a.runId}`;
    const src = `${run}/src`;
    this.dirs = { root, run, src, project: a.source.root ? `${src}/${a.source.root}` : src, out: `${run}/out`, secrets: `${run}/secrets`, rc: `${run}/.rc` };
  }

  /** Stops the run as soon as possible (the console asked, or the agent is shutting down). */
  cancel(reason: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelReason = reason;
    this.d.say(`Cancelling run ${this.a.runId}: ${reason}`);
    this.stepAbort?.abort();
  }

  async execute(): Promise<{ conclusion: 'success' | 'failure' | 'cancelled'; error: string | null }> {
    let error: string | null = null;
    try {
      if (this.a.secrets) this.secrets = JSON.parse(open(this.a.secrets, this.d.keys.sealPem, `run:${this.a.runId}`).toString('utf8')) as Record<string, string>;
    } catch (e) {
      error = (e as Error).message;
    }
    if (!error) {
      const prep = await this.d.exec.exec(
        [SWEEP_SCRIPT(`${this.dirs.root}/runs`, this.dirs.run), `rm -rf ${q(this.dirs.run)}`, `mkdir -p ${q(this.dirs.src)} ${q(this.dirs.out)} ${q(this.dirs.rc)} ${q(this.dirs.secrets)}`, `chmod 700 ${q(this.dirs.run)} ${q(this.dirs.secrets)} ${q(this.dirs.rc)}`].join('\n'),
        { timeoutMs: 120_000 },
      );
      if (prep.code !== 0) error = `Could not prepare ${this.dirs.run} on the Mac: ${prep.stderr.trim().split('\n').pop() ?? `exit ${prep.code}`}`;
    }
    this.timer = setInterval(() => void this.report(false), 2000);
    const results = new Map<string, Conclusion>();
    for (const spec of this.a.jobs) {
      if (error) {
        this.finishUnrun(this.job(spec.name), 'skipped');
        continue;
      }
      results.set(spec.key, await this.runJob(spec, results));
    }
    clearInterval(this.timer);
    const all = [...results.values()];
    const conclusion = this.cancelled || all.includes('cancelled') ? 'cancelled' : error || all.includes('failure') ? 'failure' : 'success';
    if (this.cancelled && this.cancelReason) error ??= this.cancelReason;
    await this.finishOnConsole(conclusion, error);
    if (!this.d.cfg.keepWork) await this.d.exec.exec(`rm -rf ${q(this.dirs.run)}`, { timeoutMs: 300_000 }).catch(() => undefined);
    return { conclusion, error };
  }

  // ─── jobs and steps ──────────────────────────────────────────────────────────────────

  private job(name: string): JobReport {
    return this.jobs.find((j) => j.name === name)!;
  }

  private logFor(name: string): LogBuffer {
    let log = this.logs.get(name);
    if (!log) this.logs.set(name, (log = new LogBuffer()));
    return log;
  }

  private async runJob(spec: JobSpec, results: Map<string, Conclusion>): Promise<Conclusion> {
    const job = this.job(spec.name);
    if (this.cancelled) return this.finishUnrun(job, 'cancelled');
    if (spec.needs.some((n) => results.get(n) !== 'success')) return this.finishUnrun(job, 'skipped');
    const log = this.logFor(spec.name);
    job.status = 'in_progress';
    job.started_at = now();
    this.changed = true;
    const deadline = Date.now() + spec.timeoutMin * 60_000;
    let failed = false;
    let cancelled = false;
    for (const [n, step] of spec.steps.entries()) {
      const rec = job.steps[n];
      const stopped = cancelled || this.cancelled;
      if (stopped ? !step.cleanup : failed && !step.always && !step.cleanup) {
        this.finishStep(rec, stopped ? 'cancelled' : 'skipped');
        continue;
      }
      rec.status = 'in_progress';
      rec.started_at = now();
      this.changed = true;
      // Cleanup must still run after a cancel, so it cannot be cancelled itself.
      const abort = new AbortController();
      if (!step.cleanup) this.stepAbort = abort;
      try {
        await this.runStep(spec, step, n, log, abort.signal, Math.max(60_000, deadline - Date.now()));
        this.finishStep(rec, 'success');
      } catch (e) {
        if (e instanceof Cancelled || (abort.signal.aborted && this.cancelled)) {
          cancelled = true;
          log.error('The run was cancelled.');
          this.finishStep(rec, 'cancelled');
        } else {
          failed = true;
          log.error((e as Error).message);
          this.finishStep(rec, 'failure');
        }
      } finally {
        this.stepAbort = null;
        log.flush();
      }
      this.changed = true;
    }
    job.status = 'completed';
    job.conclusion = cancelled || this.cancelled ? 'cancelled' : failed ? 'failure' : 'success';
    job.completed_at = now();
    this.changed = true;
    await this.report(true);
    return job.conclusion;
  }

  private async runStep(job: JobSpec, step: StepSpec, n: number, log: LogBuffer, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (step.uses === 'setup') return this.setUp(job, log);
    if (step.uses === 'checkout') return this.checkout(log, signal);
    if (step.uses === 'complete') log.line('Cleaning up orphan processes');
    for (const w of step.write ?? []) await this.write(w, log);
    if (step.run) await this.script(job, step, n, log, signal, timeoutMs);
    if (step.upload) await this.upload(step.upload, log);
  }

  private setUp(job: JobSpec, log: LogBuffer): void {
    const f = this.d.facts;
    log.line(`Runner: ${this.d.runnerName} (Release Console Mac runner ${this.d.cfg.version}${this.d.exec.address ? `, ${this.d.exec.address}` : ', on this Mac'})`);
    if (f) log.line(`Mac: ${[f.os, f.arch, f.xcode, f.iosSdk, f.flutter && `Flutter ${f.flutter}`, f.cocoapods && `CocoaPods ${f.cocoapods}`].filter(Boolean).join(' · ')}`);
    log.line(`App: ${this.a.app.name} (${this.a.app.bundleId}, iOS) · ${this.a.title}`);
    log.line(`Job: ${job.name}`);
    log.line(`Folder on the Mac: ${this.dirs.run}`);
  }

  private async checkout(log: LogBuffer, signal: AbortSignal): Promise<void> {
    log.step(`download the source (${MB(this.a.source.sizeBytes)}) and unpack it on the Mac`);
    const { stream } = await this.d.api.source(this.a.runId);
    const hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    stream.pipe(hashing);
    const res = await this.d.exec.exec(`rm -rf ${q(this.dirs.src)} && mkdir -p ${q(this.dirs.src)} && tar -xzf - -C ${q(this.dirs.src)}`, {
      stdin: hashing,
      signal,
      timeoutMs: 30 * 60_000,
      onOutput: (d) => log.chunk(d),
    });
    if (res.stopped === 'cancel') throw new Cancelled();
    if (res.code !== 0) throw new StepFailed(`Could not unpack the source on the Mac (tar exit ${res.code}).`);
    const digest = hash.digest('hex');
    if (digest !== this.a.source.sha256) throw new StepFailed('The source arrived damaged (its checksum is not the one the console packed): start the run again.');
    log.line(`Unpacked into ${this.dirs.src}`);
    log.line(`Project: ${this.a.source.root || '(the top of the source)'}`);
    log.line(this.a.source.sha ? `Commit ${this.a.source.sha} (${this.a.source.ref})` : `Source: ${this.a.source.ref}`);
  }

  private async write(w: WriteSpec, log: LogBuffer): Promise<void> {
    if (!w.path || w.path.startsWith('/') || w.path.split('/').includes('..')) throw new StepFailed(`The console asked to write outside the run folder (${w.path}).`);
    let data: Buffer;
    if (w.secret !== undefined) {
      const value = this.secrets[w.secret];
      if (value === undefined) throw new StepFailed(`The run's sealed secrets have no ${w.secret}.`);
      data = Buffer.from(value, 'base64');
    } else data = Buffer.from(w.text ?? '');
    await this.d.exec.writeFile(`${this.dirs.run}/${w.path}`, data, w.mode ?? (w.secret ? 0o600 : 0o644));
    log.line(w.secret ? `Wrote ${w.path} (from the run's sealed secrets, readable by ${this.d.env.user || 'its owner'} only)` : `Wrote ${w.path}`);
  }

  private async script(job: JobSpec, step: StepSpec, n: number, log: LogBuffer, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const base = `${this.dirs.rc}/${job.key}-${n + 1}`;
    const secretEnv: Record<string, string> = {};
    for (const [k, name] of Object.entries(step.secretEnv ?? {})) {
      const value = this.secrets[name];
      if (value === undefined) throw new StepFailed(`The run's sealed secrets have no ${name}.`);
      secretEnv[k] = Buffer.from(value, 'base64').toString('utf8');
    }
    const env = {
      PATH: this.d.env.path,
      HOME: this.d.env.home,
      USER: this.d.env.user,
      TERM: 'dumb',
      ...this.a.env,
      RC_RUN: this.dirs.run,
      RC_SRC: this.dirs.src,
      RC_PROJECT: this.dirs.project,
      RC_OUT: this.dirs.out,
      RC_SECRETS: this.dirs.secrets,
      RC_HOME: this.dirs.root,
      ...(step.env ?? {}),
      ...secretEnv,
    };
    await this.d.exec.writeFile(`${base}.sh`, `${step.run}\n`, 0o700);
    await this.d.exec.writeFile(`${base}.env`, envLines(env), 0o600);
    log.step(step.run ?? '');
    let res;
    try {
      res = await this.d.exec.exec(`/bin/bash --noprofile --norc -eo pipefail ${q(`${base}.sh`)}`, {
        cwd: step.cwd === 'run' ? this.dirs.run : this.dirs.project,
        envFile: `${base}.env`,
        pidFile: `${base}.pid`,
        onOutput: (d) => log.chunk(d),
        signal,
        timeoutMs,
      });
    } finally {
      log.flush();
      // The variables may hold a secret (the .p12 password): gone as soon as the step ends.
      await this.d.exec.exec(`rm -f ${q(`${base}.env`)}`, { timeoutMs: 60_000 }).catch(() => undefined);
    }
    if (res.stopped === 'cancel') throw new Cancelled();
    if (res.stopped === 'timeout') throw new StepFailed(`It ran longer than ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes and was stopped.`);
    if (res.code !== 0) throw new StepFailed(`Process completed with exit code ${res.code ?? 'unknown'}.`);
  }

  private async upload(spec: NonNullable<StepSpec['upload']>, log: LogBuffer): Promise<void> {
    for (const f of spec.files) {
      const file = await this.d.exec.read(`${this.dirs.run}/${f.path}`);
      if (!file) {
        if (f.optional) continue;
        throw new StepFailed(`${f.path} was not written, so there is nothing to send to the console.`);
      }
      await this.d.api.artifact(this.a.runId, spec.artifact, f.as, file.size, file.stream);
      await file.done;
      log.line(`Sent ${spec.artifact}/${f.as} to the console (${MB(file.size)}).`);
    }
  }

  private finishStep(step: StepReport, conclusion: Conclusion): void {
    step.status = 'completed';
    step.conclusion = conclusion;
    step.started_at ??= now();
    step.completed_at = now();
  }

  private finishUnrun(job: JobReport, conclusion: 'cancelled' | 'skipped'): Conclusion {
    job.status = 'completed';
    job.conclusion = conclusion;
    job.completed_at = now();
    for (const s of job.steps) if (s.status !== 'completed') this.finishStep(s, conclusion);
    this.changed = true;
    return conclusion;
  }

  // ─── the console ─────────────────────────────────────────────────────────────────────

  private drainLogs(): Array<{ job: string; text: string }> {
    const out: Array<{ job: string; text: string }> = [];
    let budget = REPORT_BYTES;
    for (const [job, buf] of this.logs) {
      if (budget <= 0) break;
      const text = buf.drain(budget);
      budget -= text.length;
      if (text) out.push({ job, text });
    }
    return out;
  }

  /** Sends what changed (and every ten seconds a sign of life); takes the console's cancel. */
  private report(force: boolean): Promise<void> {
    this.reporting = this.reporting.then(async () => {
      const pending = [...this.logs.values()].some((b) => b.size > 0);
      if (!force && !pending && !this.changed && Date.now() - this.lastSent < 10_000) return;
      const logs = this.drainLogs();
      this.changed = false;
      try {
        const reply = await this.d.api.events(this.a.runId, { jobs: this.jobs, logs });
        this.lastSent = Date.now();
        this.failures = 0;
        this.d.heartbeat();
        if (reply.cancel) this.cancel('the console cancelled the run');
      } catch (e) {
        for (const l of logs.reverse()) this.logs.get(l.job)?.unshift(l.text);
        this.changed = true;
        this.failures += 1;
        if (e instanceof ConsoleError && [401, 404, 409, 410].includes(e.status)) this.cancel(`the console no longer takes reports for this run (${e.message})`);
        else if (this.failures === 1 || this.failures % 15 === 0) this.d.say(`Reporting run ${this.a.runId} to the console failed (${(e as Error).message}); retrying.`);
      }
    });
    return this.reporting;
  }

  /** The last report and how the run ended, tried for a few minutes if the console is away. */
  private async finishOnConsole(conclusion: 'success' | 'failure' | 'cancelled', error: string | null): Promise<void> {
    await this.reporting;
    for (let i = 0; i < 40; i += 1) {
      for (const buf of this.logs.values()) buf.flush();
      const logs = this.drainLogs();
      const more = [...this.logs.values()].some((b) => b.size > 0);
      try {
        if (more) {
          await this.d.api.events(this.a.runId, { jobs: this.jobs, logs });
          i -= 1;
          continue;
        }
        await this.d.api.complete(this.a.runId, { conclusion, error, jobs: this.jobs, logs });
        this.d.heartbeat();
        return;
      } catch (e) {
        for (const l of logs.reverse()) this.logs.get(l.job)?.unshift(l.text);
        if (e instanceof ConsoleError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          this.d.say(`The console refused the end of run ${this.a.runId}: ${e.message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(i, 5))));
      }
    }
    this.d.say(`Could not tell the console how run ${this.a.runId} ended; it marks the run failed when it stops hearing from this Mac.`);
  }
}
