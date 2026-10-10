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
export async function runCommand(command: string, opts: RunOptions): Promise<void> {
  const res = await execArgv('bash', ['-c', command], opts);
  if (res.code !== 0) throw new StepFailed(`Process completed with exit code ${res.code ?? 'unknown'}.`, res.code);
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  /** Output goes line by line into this job log as well as into the result. */
  log?: JobLog;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const KEEP = 256 * 1024;

/**
 * Runs a program with an argument list (no shell), in its own process group. Resolves with its
 * exit code and the tail of its output; rejects only on cancel, timeout, or a program that
 * cannot start.
 */
export function execArgv(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((done, fail) => {
    if (opts.signal?.aborted) return fail(new StepCancelled());
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      uid: opts.uid,
      gid: opts.gid,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
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
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString('utf8')).slice(-KEEP);
      opts.log?.chunk(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-KEEP);
      opts.log?.chunk(d);
    });
    child.on('error', (e) => {
      finish();
      fail(new StepFailed(`Could not start ${file}: ${e.message}`, null));
    });
    child.on('close', (code) => {
      finish();
      opts.log?.flush();
      if (reason === 'cancel') return fail(new StepCancelled());
      if (reason === 'timeout') {
        return fail(new StepFailed(`It ran longer than ${Math.max(1, Math.round(opts.timeoutMs / 60000))} minutes and was stopped.`, code));
      }
      done({ code, stdout, stderr });
    });
  });
}
