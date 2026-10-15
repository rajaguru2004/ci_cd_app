import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { PassThrough, Readable, Writable } from 'stream';
import { Client, type ClientChannel } from 'ssh2';
import type { HostKeyPin } from './keys';

/**
 * Where the agent's commands run: on the Mac over SSH (the agent in a container: Xcode cannot run
 * inside one), or on the machine the agent runs on (EXECUTOR=local). Both run bash the same way:
 *
 *   - every command is `/bin/bash -c <wrapper>`, the wrapper cd's, starts the command as its own
 *     process group (job control on) and records that group in a pid file, so a cancel or a
 *     timeout stops everything the command started (xcodebuild, the Dart VM, pod), not only bash;
 *   - nothing secret is ever in a command line: secret files and variables are written to the
 *     Mac through stdin, 0600, and a step sources its variables from such a file.
 */

export class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostError';
  }
}

export interface ExecOptions {
  /** A folder on the Mac; created if missing. */
  cwd?: string;
  /** Exported for the command (not secret: these go through the command line). */
  env?: Record<string, string>;
  /** A file of `export K='v'` lines on the Mac sourced before the command (secrets go here). */
  envFile?: string;
  stdin?: Readable | Buffer | string;
  onOutput?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Where the command's process group is recorded on the Mac, for stopping it. */
  pidFile?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it ended early, if it did. */
  stopped: 'cancel' | 'timeout' | null;
}

/** One running process on the Mac: its streams and how it ended. */
interface Proc {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exit: Promise<number | null>;
  close(): void;
}

/** A shell word: single-quoted, with any single quote spelled '\'' (bash 3.2 and zsh alike). */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `export K='v'` lines, the format a step's environment file is in. */
export function envLines(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}=${q(v)}\n`)
    .join('');
}

const KEEP = 256 * 1024;

export abstract class Executor {
  abstract readonly kind: 'ssh' | 'local';
  /** user@host:port for SSH; null on the machine itself. */
  abstract readonly address: string | null;
  protected abstract start(command: string): Promise<Proc>;
  abstract close(): void;

  /** Runs bash text on the Mac (with -o pipefail; a step's script adds -e itself). */
  async exec(command: string, o: ExecOptions): Promise<ExecResult> {
    if (o.signal?.aborted) return { code: null, stdout: '', stderr: '', stopped: 'cancel' };
    const lines = ['set -m'];
    if (o.cwd) lines.push(`mkdir -p ${q(o.cwd)} && cd ${q(o.cwd)} || exit 97`);
    if (o.env) lines.push(envLines(o.env).trimEnd());
    const inner = `${o.envFile ? `. ${q(o.envFile)}; ` : ''}exec /bin/bash --noprofile --norc -o pipefail -c ${q(command)}`;
    lines.push(`( ${inner} ) &`, 'rc_child=$!');
    if (o.pidFile) lines.push(`echo "$rc_child" > ${q(o.pidFile)}`);
    lines.push('wait "$rc_child"');
    const proc = await this.start(`/bin/bash --noprofile --norc -c ${q(lines.filter(Boolean).join('\n'))}`);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString('utf8')).slice(-KEEP);
      o.onOutput?.(d);
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-KEEP);
      o.onOutput?.(d);
    });
    if (o.stdin instanceof Readable) o.stdin.pipe(proc.stdin);
    else proc.stdin.end(o.stdin ?? '');
    let stopped: ExecResult['stopped'] = null;
    const stop = (why: 'cancel' | 'timeout') => {
      if (stopped) return;
      stopped = why;
      void this.kill(o.pidFile, proc);
    };
    const onAbort = () => stop('cancel');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs);
    try {
      const code = await proc.exit;
      return { code, stdout, stderr, stopped };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Writes a file on the Mac through stdin (folders made as needed), then moves it into place. */
  async writeFile(path: string, data: Buffer | string, mode: number): Promise<void> {
    const tmp = `${path}.rc-${process.pid}-${Date.now()}`;
    const res = await this.exec(`umask 077 && mkdir -p "$(dirname ${q(path)})" && cat > ${q(tmp)} && chmod ${mode.toString(8)} ${q(tmp)} && mv -f ${q(tmp)} ${q(path)}`, {
      stdin: data,
      timeoutMs: 120_000,
    });
    if (res.code !== 0) throw new HostError(`Could not write ${path} on the Mac: ${res.stderr.trim().split('\n').pop() ?? `exit ${res.code}`}`);
  }

  /** A file on the Mac: its size and its bytes as a stream; null when it does not exist. */
  async read(path: string): Promise<{ size: number; stream: Readable; done: Promise<number | null> } | null> {
    const size = await this.exec(`[ -f ${q(path)} ] && wc -c < ${q(path)}`, { timeoutMs: 60_000 });
    if (size.code !== 0) return null;
    const proc = await this.start(`cat ${q(path)}`);
    proc.stdin.end();
    proc.stderr.resume();
    return { size: Number(size.stdout.trim()), stream: proc.stdout, done: proc.exit };
  }

  /** Stops a command's whole process group: TERM, then KILL ten seconds later. */
  private async kill(pidFile: string | undefined, proc: Proc): Promise<void> {
    if (pidFile) {
      const group = (sig: string) =>
        this.exec(`p="$(cat ${q(pidFile)} 2>/dev/null)"; [ -n "$p" ] && kill -${sig} -- "-$p" 2>/dev/null; true`, { timeoutMs: 30_000 }).catch(() => undefined);
      await group('TERM');
      await new Promise((r) => setTimeout(r, 10_000).unref());
      await group('KILL');
    }
    proc.close();
  }
}

/** The agent runs on the Mac itself. */
export class LocalExecutor extends Executor {
  readonly kind = 'local' as const;
  readonly address = null;

  protected async start(command: string): Promise<Proc> {
    // The environment named outright (not inherited by default), so what the agent's own process.env says is what steps get.
    const child = spawn('/bin/bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env } });
    const exit = new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code));
    });
    child.stdin.on('error', () => undefined);
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exit,
      close: () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      },
    };
  }

  close(): void {}
}

/** The agent in a container reaches its Mac over SSH (Remote Login) with its own key. */
export class SshExecutor extends Executor {
  readonly kind = 'ssh' as const;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly o: { host: string; port: number; user: string; privateKey: string; pin: HostKeyPin },
  ) {
    super();
  }

  get address(): string {
    return `${this.o.user}@${this.o.host}:${this.o.port}`;
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Client>((resolve, reject) => {
      const c = new Client();
      let refused: string | null = null;
      let pinning: Promise<void> = Promise.resolve();
      c.on('ready', () => {
        this.client = c;
        resolve(c);
      });
      c.on('error', (e: Error & { level?: string }) => {
        this.client = null;
        if (refused) return reject(new HostError(refused));
        if (e.level === 'client-authentication') {
          return reject(
            new HostError(
              `${this.o.user}@${this.o.host} refused this runner's SSH key. Add it on the Mac: docker compose exec runner node dist/cli.js pubkey >> ~/.ssh/authorized_keys`,
            ),
          );
        }
        const why = /ECONNREFUSED/.test(e.message)
          ? `nothing answers SSH on ${this.o.host}:${this.o.port}: turn on Remote Login (System Settings → General → Sharing → Remote Login) for ${this.o.user}`
          : /ENOTFOUND|EAI_AGAIN/.test(e.message)
            ? `${this.o.host} is not a known host name from inside the container`
            : e.message;
        reject(new HostError(`Cannot reach the Mac over SSH: ${why}.`));
      });
      c.on('close', () => {
        if (this.client === c) this.client = null;
      });
      c.connect({
        host: this.o.host,
        port: this.o.port,
        username: this.o.user,
        privateKey: this.o.privateKey,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          pinning = this.o.pin.check(`${this.o.host}:${this.o.port}`, key).then((r) => {
            if (!r.ok) {
              refused = `The Mac's SSH host key changed (it offers ${r.offered}; this runner holds ${r.held}). If the Mac was reinstalled, forget the old one: docker compose exec runner rm /data/ssh/host_key`;
            }
            verify(r.ok);
          });
          void pinning;
        },
      } as Parameters<Client['connect']>[0]);
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  protected async start(command: string): Promise<Proc> {
    const client = await this.connect();
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(command, (err, ch) => (err ? reject(new HostError(`The Mac refused a command over SSH: ${err.message}`)) : resolve(ch)));
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    channel.pipe(stdout);
    channel.stderr.pipe(stderr);
    let code: number | null = null;
    channel.on('exit', (c: number | null) => {
      code = typeof c === 'number' ? c : null;
    });
    const exit = new Promise<number | null>((resolve) => channel.on('close', () => resolve(code)));
    return {
      stdin: channel,
      stdout,
      stderr,
      exit,
      close: () => channel.close(),
    };
  }

  close(): void {
    this.client?.end();
    this.client = null;
  }
}
