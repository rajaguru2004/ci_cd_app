import { spawn } from 'child_process';
import { JobLog } from './log';

export class StepFailed extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'StepFailed';
  }
}

export class StepCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'StepCancelled';
  }
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Run as this user (only possible when the runner is root). */
  uid?: number;
  gid?: number;
  log: JobLog;
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * Runs one shell command for a step, streaming its output into the job log. The command gets
 * its own process group, so cancelling or timing out kills everything it started (Gradle,
 * the Dart VM, test isolates), not only the shell.
 */
export function runCommand(command: string, opts: RunOptions): Promise<void> {
  return new Promise((done, fail) => {
    if (opts.signal.aborted) return fail(new StepCancelled());
    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      env: opts.env,
      uid: opts.uid,
      gid: opts.gid,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let reason: 'cancel' | 'timeout' | null = null;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const stop = (why: 'cancel' | 'timeout') => {
      if (reason) return;
      reason = why;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    };
    const onAbort = () => stop('cancel');
    opts.signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);

    child.stdout?.on('data', (d: Buffer) => opts.log.chunk(d));
    child.stderr?.on('data', (d: Buffer) => opts.log.chunk(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      fail(new StepFailed(`Could not start the step: ${e.message}`, null));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      opts.log.flush();
      if (reason === 'cancel') return fail(new StepCancelled());
      if (reason === 'timeout') {
        return fail(new StepFailed(`The step ran longer than ${Math.round(opts.timeoutMs / 60000)} minutes and was stopped.`, code));
      }
      if (code === 0) return done();
      fail(new StepFailed(`Process completed with exit code ${code ?? 'unknown'}.`, code));
    });
  });
}
