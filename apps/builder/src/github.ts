import { createHash } from 'crypto';
import { parseRepoUrl } from './git';

/**
 * The builder's only way to GitHub's REST API, for apps that build on GitHub Actions. Each call
 * carries the token it was given (an app's own, or the console's default); nothing here keeps
 * one.
 *
 * Every GET carries the ETag of the last answer for that URL and token: GitHub answers an
 * unchanged resource with 304, and 304s do not count against the hourly limit. That is what
 * lets the console follow a running workflow every few seconds.
 */

export class GithubError extends Error {
  constructor(
    message: string,
    /** The status the console answers with. */
    readonly status: number,
    /** GitHub's own status, when it answered. */
    readonly upstream: number | null = null,
    /** GitHub's own words, for the caller to quote. */
    readonly detail: string = '',
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  reset: number;
}

export interface TokenInfo {
  login: string;
  kind: 'fine-grained' | 'classic' | 'other';
  /** Classic tokens list their scopes; fine-grained ones do not. */
  scopes: string[] | null;
  expiresAt: string | null;
}

export interface GhResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

type Params = Record<string, string | number | boolean>;

const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/** owner/name of a repository on github.com from its SSH URL; null for any other host. */
export function githubRepoOf(url: string): string | null {
  try {
    const repo = parseRepoUrl(url);
    const host = repo.host.toLowerCase();
    // GitHub's SSH also answers on ssh.github.com:443, for networks that close port 22.
    if (!(host === 'github.com' && !repo.port) && !(host === 'ssh.github.com' && (repo.port === 443 || !repo.port))) return null;
    const slug = repo.path.replace(/\.git$/, '').replace(/^\/+/, '');
    return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

/** A token as pasted: trimmed, checked to look like one. Throws a sentence otherwise. */
export function checkToken(input: unknown): string {
  const token = typeof input === 'string' ? input.trim() : '';
  if (!token) throw new GithubError('Paste the GitHub token.', 400);
  if (!TOKEN.test(token)) throw new GithubError('That is not a GitHub token (they look like github_pat_… or ghp_…).', 400);
  return token;
}

export function tokenKind(token: string): TokenInfo['kind'] {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  return 'other';
}

/** "the workflow dispatch" from "/repos/o/r/actions/workflows/x/dispatches": for sentences. */
export function describe(path: string): string {
  const p = path.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  if (/\/actions\/workflows\/[^/]+\/dispatches$/.test(p)) return 'the workflow dispatch';
  if (/\/actions\/workflows\/[^/]+\/runs/.test(p)) return 'the workflow runs';
  if (/\/actions\/workflows\/[^/]+/.test(p)) return 'the workflow';
  if (/\/actions\/runs\/\d+\/jobs/.test(p)) return 'the jobs of that run';
  if (/\/actions\/runs\/\d+\/artifacts/.test(p)) return 'the artifacts of that run';
  if (/\/actions\/runs\/\d+\/cancel/.test(p)) return 'the cancel';
  if (/\/actions\/runs\/\d+/.test(p)) return 'that workflow run';
  if (/\/actions\/jobs\/\d+\/logs/.test(p)) return 'the log of that job';
  if (/\/actions\/artifacts\/\d+/.test(p)) return 'that artifact';
  if (/\/actions\/secrets/.test(p)) return 'the repository secrets';
  if (/\/contents\//.test(p)) return 'that file';
  if (/\/git\/refs?/.test(p)) return 'that branch';
  if (/\/pulls/.test(p)) return 'the pull request';
  if (p === '') return 'that repository';
  if (path === '/user') return 'the token’s account';
  return p;
}

function messageOf(data: unknown): string {
  if (data && typeof data === 'object' && 'message' in data) {
    const m = String((data as { message: unknown }).message);
    const errors = (data as { errors?: Array<{ message?: string } | string> }).errors;
    const extra = Array.isArray(errors) ? errors.map((e) => (typeof e === 'string' ? e : e.message)).filter(Boolean).join('; ') : '';
    return extra ? `${m} (${extra})` : m;
  }
  if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, 200) || 'no message';
  return typeof data === 'string' && data ? data.slice(0, 200) : 'no message';
}

const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 16);

export class GithubClient {
  static timeoutMs = 20_000;
  private readonly etags = new Map<string, { etag: string; data: unknown }>();
  private readonly rates = new Map<string, RateLimit>();

  constructor(readonly apiUrl: string) {}

  /** The token's account and what kind of token it is; refuses a token GitHub does not take. */
  async whoami(token: string): Promise<TokenInfo> {
    const res = await this.request<{ login: string }>(token, 'GET', '/user');
    this.assertOk(res, '/user');
    const scopes = res.headers.get('x-oauth-scopes');
    const expires = res.headers.get('github-authentication-token-expiration');
    const at = expires ? new Date(expires.replace(' UTC', 'Z').replace(' ', 'T')) : null;
    return {
      login: res.data.login,
      kind: tokenKind(token),
      scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean),
      expiresAt: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
    };
  }

  rate(token: string): RateLimit | null {
    return this.rates.get(fingerprint(token)) ?? null;
  }

  async get<T>(token: string, path: string, params?: Params): Promise<T> {
    const res = await this.request<T>(token, 'GET', path, { params, conditional: true });
    this.assertOk(res, path);
    return res.data;
  }

  /** Like get(), but GitHub's 404 comes back as null. */
  async getOrNull<T>(token: string, path: string, params?: Params): Promise<T | null> {
    const res = await this.request<T>(token, 'GET', path, { params, conditional: true });
    if (res.status === 404) return null;
    this.assertOk(res, path);
    return res.data;
  }

  async post<T>(token: string, path: string, body?: unknown): Promise<GhResponse<T>> {
    const res = await this.request<T>(token, 'POST', path, { body });
    this.assertOk(res, path);
    return res;
  }

  async put<T>(token: string, path: string, body?: unknown): Promise<GhResponse<T>> {
    const res = await this.request<T>(token, 'PUT', path, { body });
    this.assertOk(res, path);
    return res;
  }

  /** DELETE; a 404 (already gone) is fine. */
  async delete(token: string, path: string): Promise<void> {
    const res = await this.request<unknown>(token, 'DELETE', path);
    if (res.status === 404) return;
    this.assertOk(res, path);
  }

  /**
   * An endpoint that answers with a redirect to storage (job logs, artifact ZIPs). The signed
   * storage URL is fetched without the token: it must not travel to another host.
   */
  async download(token: string, path: string, maxBytes = 500 * 1024 * 1024): Promise<Buffer> {
    const res = await this.raw(token, 'GET', path, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new GithubError('GitHub sent a download redirect without a location.', 502);
      let file: Response;
      try {
        file = await fetch(location, { signal: AbortSignal.timeout(10 * 60_000) });
      } catch (e) {
        throw new GithubError(`GitHub's storage did not deliver ${describe(path)} (${(e as Error).message}).`, 502);
      }
      if (!file.ok) throw new GithubError(`GitHub's storage answered ${file.status} for ${describe(path)}.`, 502, file.status);
      const data = Buffer.from(await file.arrayBuffer());
      if (data.length > maxBytes) throw new GithubError(`${describe(path)} is larger than the console takes.`, 502);
      return data;
    }
    const data = Buffer.from(await res.arrayBuffer());
    const parsed = (() => {
      try {
        return JSON.parse(data.toString('utf8')) as unknown;
      } catch {
        return data;
      }
    })();
    this.assertOk({ status: res.status, data: parsed, headers: res.headers }, path);
    return data;
  }

  async request<T>(token: string, method: string, path: string, opts: { params?: Params; body?: unknown; conditional?: boolean } = {}): Promise<GhResponse<T>> {
    const query = opts.params ? `?${new URLSearchParams(Object.entries(opts.params).map(([k, v]): [string, string] => [k, String(v)])).toString()}` : '';
    const key = `${fingerprint(token)} ${path}${query}`;
    const cached = opts.conditional ? this.etags.get(key) : undefined;
    const attempt = () =>
      this.raw(token, method, `${path}${query}`, {
        headers: cached ? { 'If-None-Match': cached.etag } : {},
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    let res: Response;
    try {
      res = await attempt();
    } catch (first) {
      // One retry for a read that failed in transit. Never for a write: a dispatch that reached
      // GitHub before the connection dropped would start a second run.
      if (method !== 'GET') throw new GithubError(`GitHub did not answer (${(first as Error).message}).`, 502);
      await new Promise((r) => setTimeout(r, 500));
      try {
        res = await attempt();
      } catch (e) {
        throw new GithubError(`GitHub did not answer (${(e as Error).message}).`, 502);
      }
    }
    this.trackRate(token, res.headers);
    if (res.status === 304 && cached) return { status: 200, data: cached.data as T, headers: res.headers };
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const etag = res.headers.get('etag');
    if (opts.conditional && res.status === 200 && etag) {
      this.etags.delete(key);
      this.etags.set(key, { etag, data });
      // Maps keep insertion order: the first key is the least recently refreshed one.
      if (this.etags.size > 2000) this.etags.delete(this.etags.keys().next().value as string);
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  private async raw(token: string, method: string, path: string, init: { headers?: Record<string, string>; body?: string; redirect?: 'follow' | 'manual' }): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, {
      method,
      redirect: init.redirect ?? 'follow',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'release-console',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(GithubClient.timeoutMs),
    });
  }

  private trackRate(token: string, headers: Headers): void {
    const limit = Number(headers.get('x-ratelimit-limit'));
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (headers.get('x-ratelimit-limit') !== null && Number.isFinite(limit) && Number.isFinite(remaining)) {
      this.rates.set(fingerprint(token), { limit, remaining, reset });
    }
  }

  private assertOk(res: { status: number; data: unknown; headers: Headers }, path: string): void {
    if (res.status >= 200 && res.status < 300) return;
    const upstream = messageOf(res.data);
    const what = describe(path);
    if (res.status === 401) {
      throw new GithubError('GitHub refused the token (401): it is wrong, expired or revoked. Paste a new one.', 502, 401, upstream);
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      if (res.headers.get('x-ratelimit-remaining') !== null && remaining === 0) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const at = Number.isFinite(reset) ? new Date(reset * 1000).toISOString().slice(11, 16) : 'the top of the hour';
        throw new GithubError(`GitHub's hourly API limit for this token is used up; it resets at ${at} UTC.`, 429, res.status, upstream);
      }
      throw new GithubError(`GitHub refused ${what} (${res.status}): ${upstream}.`, 403, res.status, upstream);
    }
    if (res.status === 404) throw new GithubError(`GitHub has no ${what.replace(/^(the|that) /, '')} (404), or the token cannot see it.`, 404, 404, upstream);
    if (res.status === 409 || res.status === 422) throw new GithubError(`GitHub refused ${what}: ${upstream}.`, res.status, res.status, upstream);
    throw new GithubError(`GitHub answered ${res.status} for ${what}: ${upstream}.`, 502, res.status, upstream);
  }
}
