import { promises as fs } from 'fs';
import { join } from 'path';
import type { KeyStore } from './keys';
import type { JobLog } from './log';
import { execArgv, ExecResult } from './process';
import { describeProject, pickProjectPath, type ProjectInfo } from './project';
import type { CommitInfo, KeyRecord } from './types';
import type { Vault } from './vault';

/**
 * Everything the console does with git, over SSH only, with the keys it generated:
 * `ls-remote` to prove access, a bare mirror per app for the commit stream and for runs, and a
 * checkout of one commit for a run. Every command gets an argument list (no shell), SSH with no
 * config but its own known_hosts, and git restricted to the ssh transport, so neither a pasted
 * URL nor a repository's .gitmodules can reach a local path or run a command.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface RepoUrl {
  /** The URL as git uses it. */
  url: string;
  user: string;
  host: string;
  port: number | null;
  /** owner/name.git */
  path: string;
  /** Browser address of the repository on GitHub, GitLab or Bitbucket; null elsewhere. */
  webUrl: string | null;
  hostLabel: string;
}

export interface CommitEntry extends CommitInfo {
  sha: string;
  body: string;
}

export interface HostKey {
  host: string;
  type: string;
  fingerprint: string;
}

const SCP = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)([A-Za-z0-9._~/-]+)$/;
const SSH = /^ssh:\/\/(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/([A-Za-z0-9._~/-]+)$/;
const HTTPS = /^https?:\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/([A-Za-z0-9._~/-]+?)(?:\.git)?\/?$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const SHA = /^[0-9a-f]{40}$/;

const LABELS: Record<string, string> = { 'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'bitbucket.org': 'Bitbucket' };

export function parseRepoUrl(input: unknown): RepoUrl {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new GitError("Paste the repository's SSH URL, e.g. git@github.com:your-org/your-app.git.");
  if (raw.length > 300) throw new GitError('That URL is too long to be a repository address.');
  let user: string;
  let host: string;
  let port: number | null = null;
  let path: string;
  let m = SCP.exec(raw);
  if (m) {
    [, user, host, path] = m;
  } else if ((m = SSH.exec(raw))) {
    user = m[1] ?? 'git';
    host = m[2];
    port = m[3] ? Number(m[3]) : null;
    path = m[4];
  } else {
    const https = HTTPS.exec(raw);
    if (https) {
      throw new GitError(
        `That is an HTTPS address; the console connects over SSH. Use git@${https[1]}:${https[2]}.git (on GitHub: Code → SSH).`,
      );
    }
    throw new GitError('That is not an SSH URL. On GitHub: Code → SSH, then copy it (it looks like git@github.com:your-org/your-app.git).');
  }
  const segments = path.split('/').filter(Boolean);
  if (
    !segments.length ||
    segments.some((s) => s === '.' || s === '..' || s.startsWith('-')) ||
    host.startsWith('-') ||
    user.startsWith('-') ||
    (port !== null && (port < 1 || port > 65535))
  ) {
    throw new GitError('That SSH URL has a part git cannot use safely (a path or host starting with "-", or "..").');
  }
  const name = path.replace(/\.git$/, '').replace(/^\/+/, '');
  const known = LABELS[host.toLowerCase()];
  return {
    url: raw,
    user,
    host,
    port,
    path,
    webUrl: known && !port ? `https://${host.toLowerCase()}/${name}` : null,
    hostLabel: known ?? host,
  };
}

/** Where a commit opens in the browser, on the hosts whose URLs are known. */
export function commitUrl(repo: RepoUrl, sha: string): string | null {
  if (!repo.webUrl) return null;
  if (repo.hostLabel === 'GitLab') return `${repo.webUrl}/-/commit/${sha}`;
  if (repo.hostLabel === 'Bitbucket') return `${repo.webUrl}/commits/${sha}`;
  return `${repo.webUrl}/commit/${sha}`;
}

export function checkBranch(input: unknown): string {
  const branch = typeof input === 'string' ? input.trim() : '';
  if (!BRANCH.test(branch)) throw new GitError(`'${branch || '(empty)'}' is not a branch name.`);
  return branch;
}

export const isSha = (s: unknown): s is string => typeof s === 'string' && SHA.test(s);

/** Turns what git and ssh printed into one sentence that says what to do. */
export function explainGitFailure(stderr: string, repo: RepoUrl, key: KeyRecord | null): GitError {
  const at = `${repo.host}${repo.port ? `:${repo.port}` : ''}`;
  if (/Permission denied \(publickey|Permission denied, please try again/i.test(stderr)) {
    return new GitError(
      `${repo.host} refused the key${key ? ` for ${key.email}` : ''} (Permission denied). Add its public key to the ${repo.hostLabel} account ` +
        `that can open ${repo.path.replace(/\.git$/, '')}, or as a deploy key on the repository, then check again.`,
      422,
    );
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) {
    return new GitError(
      `The SSH host key of ${at} is not the one the console saw the first time. If ${repo.host} really changed its key, forget it under ` +
        'Git keys → Known hosts and check again; if not, stop: the connection may be intercepted.',
      422,
    );
  }
  if (/Repository not found|could not be found|does not exist|does not appear to be a git repository|No such file or directory/i.test(stderr)) {
    return new GitError(
      `The key works on ${repo.host}, but ${repo.path.replace(/\.git$/, '')} was not found there, or the account behind the key cannot open it. ` +
        'Check the URL and that account’s access to the repository.',
      422,
    );
  }
  if (/Could not resolve hostname|Name or service not known|Temporary failure in name resolution|nodename nor servname/i.test(stderr)) {
    return new GitError(`${repo.host} could not be found (DNS). Check the host in the URL.`, 422);
  }
  if (/Connection timed out|Connection refused|No route to host|Network is unreachable|Operation timed out|Connection closed by/i.test(stderr)) {
    return new GitError(`${at} did not answer on SSH. Check the host and port, and that this server can reach it.`, 502);
  }
  const last = stderr
    .split('\n')
    .map((l) => l.replace(/^(fatal|error): /, '').trim())
    .filter(Boolean)
    .pop();
  return new GitError(`git could not read ${repo.url}${last ? `: ${last}` : '.'}`, 502);
}

interface FetchState {
  at: number;
  error: string | null;
  running: Promise<void> | null;
}

export class Git {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly fetches = new Map<string, FetchState>();

  constructor(
    private readonly reposDir: string,
    private readonly vault: Vault,
    private readonly keys: KeyStore,
    private readonly timeoutMs: number,
  ) {}

  get knownHostsFile(): string {
    return join(this.vault.dir, 'known_hosts');
  }

  mirrorDir(appId: string): string {
    return join(this.reposDir, `${appId}.git`);
  }

  /** The default branch and the branches of a remote, proving the key can read it. */
  async lsRemote(repo: RepoUrl, keyId: string): Promise<{ defaultBranch: string | null; branches: string[] }> {
    const key = await this.keys.require(keyId);
    const res = await this.withKey(keyId, (env) =>
      execArgv('git', ['ls-remote', '--symref', repo.url, 'HEAD', 'refs/heads/*'], { env, timeoutMs: 90_000 }),
    );
    if (res.code !== 0) throw explainGitFailure(res.stderr, repo, key);
    await this.keys.touch(keyId);
    let defaultBranch: string | null = null;
    const branches: string[] = [];
    for (const line of res.stdout.split('\n')) {
      const sym = /^ref: refs\/heads\/(\S+)\s+HEAD$/.exec(line);
      if (sym) defaultBranch = sym[1];
      const head = /^[0-9a-f]{40}\s+refs\/heads\/(\S+)$/.exec(line);
      if (head) branches.push(head[1]);
    }
    branches.sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)));
    return { defaultBranch, branches };
  }

  /**
   * Looks at one branch of a repository without keeping it: a depth-1 fetch into a throwaway
   * bare repository, then the app's pubspec, Gradle file and manifest read with `git show`.
   */
  async inspect(repo: RepoUrl, keyId: string, branch: string, path = ''): Promise<ProjectInfo & { sha: string; commit: CommitInfo }> {
    const key = await this.keys.require(keyId);
    const tmp = join(this.reposDir, `.inspect-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    await fs.mkdir(this.reposDir, { recursive: true, mode: 0o700 });
    try {
      await this.git(['init', '--bare', '--quiet', tmp]);
      const fetched = await this.withKey(keyId, (env) =>
        execArgv('git', ['-C', tmp, 'fetch', '--quiet', '--depth', '1', '--no-tags', repo.url, `refs/heads/${branch}`], { env, timeoutMs: this.timeoutMs }),
      );
      if (fetched.code !== 0) {
        if (/couldn't find remote ref|not our ref/i.test(fetched.stderr)) throw new GitError(`${repo.path.replace(/\.git$/, '')} has no branch '${branch}'.`, 422);
        throw explainGitFailure(fetched.stderr, repo, key);
      }
      await this.keys.touch(keyId);
      const sha = (await this.git(['-C', tmp, 'rev-parse', 'FETCH_HEAD'])).trim();
      const files = (await this.git(['-C', tmp, 'ls-tree', '-r', '--name-only', 'FETCH_HEAD'])).split('\n').filter(Boolean);
      const project = pickProjectPath(files, path);
      if (project === null) {
        const native = files.some((f) => /^(settings\.gradle(\.kts)?|app\/build\.gradle(\.kts)?)$/.test(f));
        throw new GitError(
          path
            ? `There is no pubspec.yaml in ${path}/ on ${branch}. Check the project folder.`
            : native
              ? 'This looks like a native Android project. The console builds Flutter apps (a pubspec.yaml at the top, or one or two folders down).'
              : `No pubspec.yaml on ${branch}, at the top or one or two folders down: the console builds Flutter apps.`,
          422,
        );
      }
      const read = async (rel: string) => {
        const res = await execArgv('git', ['-C', tmp, 'show', `FETCH_HEAD:${rel}`], { env: this.env(null), timeoutMs: 30_000 });
        return res.code === 0 ? res.stdout : null;
      };
      const info = await describeProject(read, project);
      return { ...info, sha, commit: await this.commitInfoIn(tmp, sha) };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /** Brings an app's mirror up to date with its remote (one fetch at a time per app). */
  async fetch(appId: string, repo: RepoUrl, keyId: string, opts: { log?: JobLog; signal?: AbortSignal } = {}): Promise<void> {
    try {
      const key = await this.keys.require(keyId);
      await this.locked(appId, async () => {
        const dir = await this.ensureMirror(appId, repo);
        const res = await this.withKey(keyId, (env) =>
          execArgv(
            'git',
            ['-C', dir, 'fetch', '--prune', '--prune-tags', '--force', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
            { env, log: opts.log, signal: opts.signal, timeoutMs: this.timeoutMs },
          ),
        );
        if (res.code !== 0) throw explainGitFailure(res.stderr, repo, key);
        await this.keys.touch(keyId);
      });
      this.mark(appId, null);
    } catch (e) {
      this.mark(appId, (e as Error).message);
      throw e;
    }
  }

  /**
   * Fetches when the mirror is older than `maxAgeMs` (or never fetched), waiting up to
   * `waitMs` for it; a slow first fetch carries on in the background and the caller says so.
   */
  async refresh(appId: string, repo: RepoUrl, keyId: string, maxAgeMs: number, waitMs: number): Promise<{ fetchedAt: string | null; fetching: boolean; error: string | null }> {
    const state = this.state(appId);
    if (!state.running && Date.now() - state.at > maxAgeMs) {
      state.running = this.fetch(appId, repo, keyId)
        .catch(() => undefined)
        .finally(() => {
          state.running = null;
        });
    }
    if (state.running) await Promise.race([state.running, new Promise((r) => setTimeout(r, waitMs))]);
    return { fetchedAt: state.at ? new Date(state.at).toISOString() : null, fetching: Boolean(state.running), error: state.error };
  }

  private state(appId: string): FetchState {
    let st = this.fetches.get(appId);
    if (!st) {
      st = { at: 0, error: null, running: null };
      this.fetches.set(appId, st);
    }
    return st;
  }

  private mark(appId: string, error: string | null): void {
    const st = this.state(appId);
    st.at = Date.now();
    st.error = error;
  }

  forget(appId: string): void {
    this.fetches.delete(appId);
  }

  async removeMirror(appId: string): Promise<void> {
    this.forget(appId);
    await this.locked(appId, () => fs.rm(this.mirrorDir(appId), { recursive: true, force: true }));
  }

  async hasMirror(appId: string): Promise<boolean> {
    return fs
      .access(join(this.mirrorDir(appId), 'HEAD'))
      .then(() => true)
      .catch(() => false);
  }

  async branches(appId: string): Promise<string[]> {
    if (!(await this.hasMirror(appId))) return [];
    const out = await this.git(['-C', this.mirrorDir(appId), 'for-each-ref', '--sort=-committerdate', '--format=%(refname:strip=2)', 'refs/heads']);
    return out.split('\n').filter(Boolean);
  }

  async log(appId: string, branch: string, limit = 30): Promise<CommitEntry[]> {
    if (!(await this.hasMirror(appId))) return [];
    const res = await execArgv(
      'git',
      ['-C', this.mirrorDir(appId), 'log', `--max-count=${limit}`, '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e', `refs/heads/${branch}`, '--'],
      { env: this.env(null), timeoutMs: 30_000 },
    );
    if (res.code !== 0) {
      if (/unknown revision|bad revision|ambiguous argument/i.test(res.stderr)) throw new GitError(`The repository has no branch '${branch}'.`, 404);
      throw new GitError(`git log failed: ${res.stderr.trim().split('\n').pop()}`, 500);
    }
    return res.stdout
      .split('\x1e')
      .map((r) => r.replace(/^\n/, ''))
      .filter((r) => r.includes('\x1f'))
      .map((r) => {
        const [sha, author, email, date, subject, body] = r.split('\x1f');
        return { sha, author, email, date, subject, body: (body ?? '').trim() };
      });
  }

  /** Tag names by the commit they point at (annotated tags peeled). */
  async tags(appId: string): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!(await this.hasMirror(appId))) return out;
    const text = await this.git(['-C', this.mirrorDir(appId), 'for-each-ref', '--format=%(objectname) %(*objectname) %(refname:strip=2)', 'refs/tags']);
    for (const line of text.split('\n').filter(Boolean)) {
      const [obj, peeled, ...name] = line.split(' ');
      const sha = peeled && /^[0-9a-f]{40}$/.test(peeled) ? peeled : obj;
      out.set(sha, [...(out.get(sha) ?? []), name.join(' ')]);
    }
    return out;
  }

  /** The commit a branch points at, or a full SHA checked to exist; null when neither. */
  async resolve(appId: string, ref: { branch?: string; sha?: string | null }): Promise<string | null> {
    const target = ref.sha ? `${ref.sha}^{commit}` : `refs/heads/${ref.branch}^{commit}`;
    const res = await execArgv('git', ['-C', this.mirrorDir(appId), 'rev-parse', '--verify', '--quiet', target], { env: this.env(null), timeoutMs: 30_000 });
    return res.code === 0 ? res.stdout.trim() : null;
  }

  async commitInfo(appId: string, sha: string): Promise<CommitInfo> {
    return this.commitInfoIn(this.mirrorDir(appId), sha);
  }

  /** Every file path of a commit in the app's mirror (no checkout needed). */
  async files(appId: string, sha: string): Promise<string[]> {
    return (await this.git(['-C', this.mirrorDir(appId), 'ls-tree', '-r', '--name-only', sha])).split('\n').filter(Boolean);
  }

  /** One file of a commit in the app's mirror; null when the commit has no such file. */
  async show(appId: string, sha: string, rel: string): Promise<string | null> {
    const res = await execArgv('git', ['-C', this.mirrorDir(appId), 'show', `${sha}:${rel}`], { env: this.env(null), timeoutMs: 30_000 });
    return res.code === 0 ? res.stdout : null;
  }

  /**
   * One commit of the mirror, checked out at `dest` with its submodules (fetched over SSH with
   * the same key). Runs as root; the caller hands the tree to the build user afterwards.
   */
  async checkout(appId: string, repo: RepoUrl, keyId: string, sha: string, dest: string, opts: { log?: JobLog; signal?: AbortSignal }): Promise<void> {
    const key = await this.keys.require(keyId);
    const step = async (args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10 * 60_000): Promise<ExecResult> => {
      const res = await execArgv('git', args, { env, log: opts.log, signal: opts.signal, timeoutMs });
      if (res.code !== 0) throw new GitError(`git ${args.find((a) => !a.startsWith('-') && a !== dest) ?? ''} failed: ${res.stderr.trim().split('\n').pop() ?? ''}`, 500);
      return res;
    };
    await this.locked(appId, async () => {
      // A local clone of the mirror: the only place git may read a path rather than ssh.
      await step(['clone', '--quiet', '--no-hardlinks', '--no-checkout', this.mirrorDir(appId), dest], this.env(null, { GIT_ALLOW_PROTOCOL: 'file' }));
    });
    await step(['-C', dest, 'checkout', '--quiet', '--detach', sha], this.env(null));
    await step(['-C', dest, 'remote', 'set-url', 'origin', repo.url], this.env(null));
    const hasModules = await fs
      .access(join(dest, '.gitmodules'))
      .then(() => true)
      .catch(() => false);
    if (hasModules) {
      const res = await this.withKey(keyId, (env) =>
        execArgv('git', ['-C', dest, 'submodule', 'update', '--init', '--recursive', '--depth', '1'], {
          env,
          log: opts.log,
          signal: opts.signal,
          timeoutMs: this.timeoutMs,
        }),
      );
      if (res.code !== 0) throw explainGitFailure(res.stderr, repo, key);
    }
  }

  /** Host keys the console has accepted (first seen, then held to). */
  async knownHosts(): Promise<HostKey[]> {
    const res = await execArgv('ssh-keygen', ['-l', '-E', 'sha256', '-f', this.knownHostsFile], { timeoutMs: 30_000 }).catch(() => null);
    if (!res || res.code !== 0) return [];
    return res.stdout
      .split('\n')
      .map((l) => /^\d+\s+(SHA256:\S+)\s+(\S+)\s+\((\S+)\)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => ({ fingerprint: m[1], host: m[2], type: m[3] }));
  }

  async forgetHost(host: string): Promise<void> {
    if (!/^(\[[A-Za-z0-9.-]+\]:\d+|[A-Za-z0-9.-]+)$/.test(host)) throw new GitError('That is not a host name.');
    const res = await execArgv('ssh-keygen', ['-R', host, '-f', this.knownHostsFile], { timeoutMs: 30_000 });
    if (res.code !== 0) throw new GitError(`${host} is not a known host.`, 404);
    await fs.rm(`${this.knownHostsFile}.old`, { force: true });
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────

  private async ensureMirror(appId: string, repo: RepoUrl): Promise<string> {
    const dir = this.mirrorDir(appId);
    if (await this.hasMirror(appId)) {
      const url = (await execArgv('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { env: this.env(null), timeoutMs: 30_000 })).stdout.trim();
      if (url === repo.url) return dir;
      // The app now points at another repository: start its mirror over.
      await fs.rm(dir, { recursive: true, force: true });
    }
    await fs.mkdir(this.reposDir, { recursive: true, mode: 0o700 });
    await this.git(['init', '--bare', '--quiet', dir]);
    await this.git(['-C', dir, 'remote', 'add', 'origin', repo.url]);
    return dir;
  }

  private async commitInfoIn(gitDir: string, sha: string): Promise<CommitInfo> {
    const out = await this.git(['-C', gitDir, 'log', '-1', '--format=%an%x1f%ae%x1f%aI%x1f%s', sha, '--']);
    const [author, email, date, subject] = out.trim().split('\x1f');
    return { author: author ?? '', email: email ?? '', date: date ?? '', subject: subject ?? '' };
  }

  private async git(args: string[]): Promise<string> {
    const res = await execArgv('git', args, { env: this.env(null), timeoutMs: 60_000 });
    if (res.code !== 0) throw new GitError(`git ${args.filter((a) => !a.startsWith('/')).slice(0, 3).join(' ')} failed: ${res.stderr.trim().split('\n').pop() ?? ''}`, 500);
    return res.stdout;
  }

  /** Runs `fn` with the key decrypted onto the tmpfs and an environment whose ssh uses only it. */
  private async withKey<T>(keyId: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const privateKey = await this.keys.privateKey(keyId);
    return this.vault.withFiles({ id_ed25519: privateKey }, (paths) => fn(this.env(paths.id_ed25519)));
  }

  private env(keyFile: string | null, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const ssh = [
      'ssh',
      '-F /dev/null',
      '-o IdentitiesOnly=yes',
      '-o IdentityAgent=none',
      '-o BatchMode=yes',
      '-o StrictHostKeyChecking=accept-new',
      `-o UserKnownHostsFile=${this.knownHostsFile}`,
      '-o ConnectTimeout=20',
      '-o ServerAliveInterval=15',
      '-o ServerAliveCountMax=4',
      keyFile ? `-i ${keyFile}` : '-o PubkeyAuthentication=no',
    ].join(' ');
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME || '/root',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_SSH_COMMAND: ssh,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'ssh',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...extra,
    };
  }

  private async locked<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(appId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = previous.then(() => mine);
    this.locks.set(appId, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(appId) === chain) this.locks.delete(appId);
    }
  }
}
