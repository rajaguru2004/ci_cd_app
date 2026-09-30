import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';

/**
 * GitHub refused, failed, or did not answer. The message is written for the engineer looking
 * at the console: what went wrong and what to change. It never contains the token.
 */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** GitHub's own status, when it answered. */
    readonly upstreamStatus?: number,
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

interface CacheEntry {
  etag: string;
  data: unknown;
}

/** GET paths whose 404 means something specific; the caller turns it into a sentence. */
export type NotFound = { notFound: true };

/**
 * The only place that speaks HTTP to GitHub.
 *
 * Every GET carries the ETag of the last answer for that URL: GitHub answers an unchanged
 * resource with 304, and 304s do not count against the 5,000-requests-an-hour limit. That is
 * what lets the console poll a running pipeline every few seconds.
 */
@Injectable()
export class GithubClient {
  private readonly logger = new Logger(GithubClient.name);
  private readonly etags = new Map<string, CacheEntry>();
  private rate: RateLimit | null = null;
  /** Overridden by specs so a hung mock fails fast. */
  static timeoutMs = 20_000;

  constructor(@Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig) {}

  get configured(): boolean {
    return Boolean(this.config.githubToken);
  }

  get repo(): string {
    return this.config.githubRepo;
  }

  get rateLimit(): RateLimit | null {
    return this.rate;
  }

  /** `/repos/{owner}/{name}` + path. */
  repoPath(path = ''): string {
    return `/repos/${this.config.githubRepo}${path}`;
  }

  async get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const res = await this.send<T>({ method: 'get', url: path, params }, true);
    this.assertOk(res, path);
    return res.data;
  }

  /** Like get(), but a 404 comes back as `{ notFound: true }` instead of an error. */
  async getOrNotFound<T>(
    path: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<T | NotFound> {
    const res = await this.send<T>({ method: 'get', url: path, params }, true);
    if (res.status === 404) return { notFound: true };
    this.assertOk(res, path);
    return res.data;
  }

  async post<T>(path: string, data?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.send<T>({ method: 'post', url: path, data }, false);
    this.assertOk(res, path);
    return { status: res.status, data: res.data };
  }

  async put<T>(path: string, data?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.send<T>({ method: 'put', url: path, data }, false);
    this.assertOk(res, path);
    return { status: res.status, data: res.data };
  }

  /**
   * Downloads an endpoint that answers with a redirect to storage (job logs, artifact zips).
   * The redirect target is signed and must be fetched WITHOUT the token.
   */
  async download(path: string): Promise<Buffer> {
    const res = await this.send<unknown>(
      { method: 'get', url: path, maxRedirects: 0, responseType: 'arraybuffer' },
      false,
    );
    if (res.status === 302 || res.status === 301 || res.status === 307) {
      const location = res.headers['location'] as string | undefined;
      if (!location) throw new GithubError('GitHub sent a download redirect without a location.', 502);
      try {
        const file = await axios.get<ArrayBuffer>(location, {
          responseType: 'arraybuffer',
          timeout: 120_000,
          maxContentLength: 300 * 1024 * 1024,
        });
        return Buffer.from(file.data);
      } catch (e) {
        throw new GithubError(`GitHub storage did not deliver the file (${(e as Error).message}).`, 502);
      }
    }
    this.assertOk(res, path);
    return Buffer.from(res.data as ArrayBuffer);
  }

  private async send<T>(req: AxiosRequestConfig, conditional: boolean): Promise<AxiosResponse<T>> {
    if (!this.configured) {
      throw new GithubError(
        'No GitHub token is configured. Add GITHUB_TOKEN to ci_cd_app/.env and restart the console.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const key = conditional ? `${req.url}?${new URLSearchParams(stringify(req.params)).toString()}` : '';
    const cached = conditional ? this.etags.get(key) : undefined;
    let res: AxiosResponse<T>;
    const attempt = () =>
      axios.request<T>({
        ...req,
        baseURL: this.config.githubApiUrl,
        timeout: GithubClient.timeoutMs,
        headers: {
          Authorization: `Bearer ${this.config.githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'fusionhrm-mobile-ci-console',
          ...(cached ? { 'If-None-Match': cached.etag } : {}),
        },
        // Every status is handled here or by the caller, which knows what a 404 means.
        validateStatus: () => true,
      });
    try {
      res = await attempt();
    } catch (first) {
      // One retry for a read that failed in transit (a DNS blip, a reset connection). Never
      // for a write: a dispatch that reached GitHub before the connection dropped would start
      // a second run.
      if ((req.method ?? 'get') !== 'get') {
        throw new GithubError(`GitHub did not answer (${(first as Error).message}).`, HttpStatus.BAD_GATEWAY);
      }
      await new Promise((r) => setTimeout(r, 400));
      try {
        res = await attempt();
      } catch (e) {
        // A transport failure. The axios message carries no headers, so no token.
        throw new GithubError(`GitHub did not answer (${(e as Error).message}).`, HttpStatus.BAD_GATEWAY);
      }
    }
    this.trackRate(res);
    if (conditional) {
      if (res.status === 304 && cached) {
        return { ...res, status: 200, data: cached.data as T };
      }
      const etag = res.headers['etag'] as string | undefined;
      if (res.status === 200 && etag) {
        this.etags.delete(key);
        this.etags.set(key, { etag, data: res.data });
        // Maps keep insertion order, so the first key is the least recently refreshed one.
        if (this.etags.size > 2000) this.etags.delete(this.etags.keys().next().value as string);
      }
    }
    return res;
  }

  private trackRate(res: AxiosResponse): void {
    const limit = Number(res.headers['x-ratelimit-limit']);
    const remaining = Number(res.headers['x-ratelimit-remaining']);
    const reset = Number(res.headers['x-ratelimit-reset']);
    if (Number.isFinite(limit) && Number.isFinite(remaining)) {
      this.rate = { limit, remaining, reset };
    }
  }

  private assertOk(res: AxiosResponse, path: string): void {
    if (res.status >= 200 && res.status < 300) return;
    const upstream = messageOf(res.data);
    if (res.status === 401) {
      throw new GithubError(
        'GitHub refused the token (401): it is wrong, expired or revoked. Replace GITHUB_TOKEN in ci_cd_app/.env.',
        HttpStatus.BAD_GATEWAY,
        401,
      );
    }
    if (res.status === 403 || res.status === 429) {
      if (this.rate && this.rate.remaining === 0) {
        const at = new Date(this.rate.reset * 1000).toISOString().slice(11, 16);
        throw new GithubError(
          `GitHub's hourly API limit for this token is used up; it resets at ${at} UTC.`,
          HttpStatus.TOO_MANY_REQUESTS,
          res.status,
        );
      }
      throw new GithubError(
        `GitHub refused ${describe(path)} (${res.status}): ${upstream}. The token needs Actions read/write, ` +
          'Contents read and Secrets read/write on the mobile repository.',
        HttpStatus.BAD_GATEWAY,
        res.status,
      );
    }
    if (res.status === 404) {
      throw new GithubError(
        `GitHub has no ${describe(path)} (404), or the token cannot see ${this.config.githubRepo}.`,
        HttpStatus.NOT_FOUND,
        404,
      );
    }
    if (res.status === 422) {
      throw new GithubError(`GitHub refused the request: ${upstream}.`, HttpStatus.UNPROCESSABLE_ENTITY, 422);
    }
    if (res.status === 409) {
      throw new GithubError(`GitHub refused the request: ${upstream}.`, HttpStatus.CONFLICT, 409);
    }
    this.logger.warn(`GitHub ${res.status} on ${path}: ${upstream}`);
    throw new GithubError(`GitHub answered ${res.status} for ${describe(path)}: ${upstream}.`, HttpStatus.BAD_GATEWAY, res.status);
  }
}

function stringify(params?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) out[k] = String(v);
  return out;
}

/** "the workflow run 123" from "/repos/o/r/actions/runs/123" — for error sentences. */
function describe(path: string): string {
  const p = path.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  if (/\/actions\/workflows\/[^/]+\/dispatches$/.test(p)) return 'the workflow dispatch';
  if (/\/actions\/workflows\/[^/]+/.test(p)) return 'pipeline workflow';
  if (/\/actions\/runs\/\d+\/jobs/.test(p)) return 'jobs for that run';
  if (/\/actions\/runs\/\d+\/artifacts/.test(p)) return 'artifacts for that run';
  if (/\/actions\/runs\/\d+/.test(p)) return 'such workflow run';
  if (/\/actions\/jobs\/\d+\/logs/.test(p)) return 'log for that job';
  if (/\/actions\/artifacts\/\d+/.test(p)) return 'such artifact';
  if (/\/actions\/secrets/.test(p)) return 'access to the repository secrets';
  if (/\/branches/.test(p)) return 'such branch';
  if (/\/commits/.test(p)) return 'commits for that branch';
  if (/\/contents\//.test(p)) return 'such file';
  if (p === '') return 'such repository';
  return p;
}

function messageOf(data: unknown): string {
  if (data && typeof data === 'object' && 'message' in data) {
    return String((data as { message: unknown }).message);
  }
  if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, 200) || 'no message';
  return typeof data === 'string' && data ? data.slice(0, 200) : 'no message';
}
