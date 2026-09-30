import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import { createSign } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';

/**
 * Reads Google Play directly with the service-account key, so the console can show what is
 * on every track and prove the key works without waiting for a pipeline run.
 *
 * Read-only by construction: it opens an edit, reads the tracks, and deletes the edit. It
 * never commits one. Publishing stays with Fastlane in the pipeline, where the upload is
 * logged next to the build that produced it.
 */

export const PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export interface ServiceAccountKey {
  type: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  token_uri?: string;
}

export class PlayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Google was not reached at all (DNS, connection, timeout); worth one more try. */
    readonly transient = false,
  ) {
    super(message);
    this.name = 'PlayError';
  }
}

export interface PlayRelease {
  name: string | null;
  versionCodes: number[];
  status: string;
  userFraction: number | null;
  releaseNotes: Array<{ language: string; text: string }>;
}

export interface PlayTrack {
  track: string;
  releases: PlayRelease[];
}

export interface PlaySnapshot {
  packageName: string;
  clientEmail: string;
  projectId: string | null;
  checkedAt: string;
  tracks: PlayTrack[];
  highestVersionCode: number | null;
}

export type KeyState =
  | { kind: 'missing'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ready'; key: ServiceAccountKey; source: string };

/** Validates a service-account key's shape. Throws a sentence that says what is wrong. */
export function parseServiceAccount(json: string): ServiceAccountKey {
  let data: Partial<ServiceAccountKey>;
  try {
    data = JSON.parse(json) as Partial<ServiceAccountKey>;
  } catch {
    throw new Error('the key file is not JSON');
  }
  if (data.type !== 'service_account') throw new Error('the key is not a service-account key ("type" must be "service_account")');
  if (typeof data.client_email !== 'string' || !data.client_email) throw new Error('the key has no client_email');
  if (typeof data.private_key !== 'string' || !data.private_key.includes('PRIVATE KEY')) {
    throw new Error('the key has no PEM private_key');
  }
  return data as ServiceAccountKey;
}

export function loadServiceAccount(config: Pick<ConsoleConfig, 'playKeyJson' | 'playKeyFile'>): KeyState {
  try {
    if (config.playKeyJson) {
      return { kind: 'ready', key: parseServiceAccount(config.playKeyJson), source: 'PLAY_SERVICE_ACCOUNT_JSON' };
    }
    if (config.playKeyFile && existsSync(config.playKeyFile)) {
      return { kind: 'ready', key: parseServiceAccount(readFileSync(config.playKeyFile, 'utf8')), source: config.playKeyFile };
    }
  } catch (e) {
    return { kind: 'invalid', reason: `The Google Play key is unusable: ${(e as Error).message}.` };
  }
  return {
    kind: 'missing',
    reason: `No Google Play key on the console. Mount the service-account JSON at ${config.playKeyFile || 'PLAY_SERVICE_ACCOUNT_FILE'}.`,
  };
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** An RS256-signed JWT for Google's OAuth 2.0 JWT-bearer grant (RFC 7523). */
export function signServiceJwt(key: ServiceAccountKey, scope: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const payload = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: key.token_uri || 'https://oauth2.googleapis.com/token',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key.private_key);
  return `${header}.${payload}.${b64url(signature)}`;
}

@Injectable()
export class PlayClient {
  private readonly logger = new Logger(PlayClient.name);
  private state: KeyState;
  private loadedAt = 0;
  private token: { value: string; expiresAt: number } | null = null;
  private cached: { data: PlaySnapshot; at: number } | null = null;
  /** A snapshot this recent is served from memory: tracks change on a release, not a poll. */
  static cacheMs = 60_000;
  static timeoutMs = 20_000;

  constructor(@Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig) {
    this.state = loadServiceAccount(config);
    this.loadedAt = Date.now();
  }

  /** The key as it is now; a replaced key file is picked up without a restart. */
  keyState(): KeyState {
    const file = this.config.playKeyFile;
    if (!this.config.playKeyJson && file && existsSync(file)) {
      const mtime = statSync(file).mtimeMs;
      if (mtime > this.loadedAt) {
        this.state = loadServiceAccount(this.config);
        this.loadedAt = Date.now();
        this.token = null;
        this.cached = null;
      }
    }
    return this.state;
  }

  get packageName(): string {
    return this.config.androidPackage;
  }

  /** The key's JSON, for copying into the GitHub secret. Never logged, never returned to a browser. */
  keyJson(): string | null {
    const state = this.keyState();
    return state.kind === 'ready' ? JSON.stringify(state.key) : null;
  }

  async snapshot(force = false): Promise<PlaySnapshot> {
    const state = this.keyState();
    if (state.kind !== 'ready') throw new PlayError(state.reason, HttpStatus.SERVICE_UNAVAILABLE);
    if (!force && this.cached && Date.now() - this.cached.at < PlayClient.cacheMs) return this.cached.data;
    try {
      return await this.read(state.key);
    } catch (e) {
      // Reading tracks has no side effects, so a read that failed in transit (a DNS blip right
      // after the container starts, a reset connection) is simply tried once more.
      if (e instanceof PlayError && e.transient) {
        await new Promise((r) => setTimeout(r, 500));
        return this.read(state.key);
      }
      throw e;
    }
  }

  private async read(key: ServiceAccountKey): Promise<PlaySnapshot> {
    const state = { key };

    const pkg = encodeURIComponent(this.config.androidPackage);
    const edit = await this.call<{ id: string }>('post', `/applications/${pkg}/edits`, {});
    try {
      const res = await this.call<{ tracks?: Array<{ track: string; releases?: Array<Record<string, unknown>> }> }>(
        'get',
        `/applications/${pkg}/edits/${encodeURIComponent(edit.id)}/tracks`,
      );
      const tracks: PlayTrack[] = (res.tracks ?? []).map((t) => ({
        track: t.track,
        releases: (t.releases ?? []).map((r) => ({
          name: (r.name as string | undefined) ?? null,
          versionCodes: ((r.versionCodes as string[] | undefined) ?? []).map((c) => Number(c)).filter(Number.isFinite),
          status: (r.status as string | undefined) ?? 'unknown',
          userFraction: (r.userFraction as number | undefined) ?? null,
          releaseNotes: ((r.releaseNotes as Array<{ language: string; text: string }> | undefined) ?? []).map((n) => ({
            language: n.language,
            text: n.text,
          })),
        })),
      }));
      const codes = tracks.flatMap((t) => t.releases.flatMap((r) => r.versionCodes));
      const data: PlaySnapshot = {
        packageName: this.config.androidPackage,
        clientEmail: state.key.client_email,
        projectId: state.key.project_id ?? null,
        checkedAt: new Date().toISOString(),
        tracks: sortTracks(tracks),
        highestVersionCode: codes.length ? Math.max(...codes) : null,
      };
      this.cached = { data, at: Date.now() };
      return data;
    } finally {
      // An open edit is harmless (Google expires it), but deleting it keeps the account tidy.
      await this.call('delete', `/applications/${pkg}/edits/${encodeURIComponent(edit.id)}`).catch((e: unknown) =>
        this.logger.warn(`Could not delete Play edit ${edit.id}: ${(e as Error).message}`),
      );
    }
  }

  private async accessToken(key: ServiceAccountKey): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const assertion = signServiceJwt(key, PUBLISHER_SCOPE);
    const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
    let res;
    try {
      res = await axios.post<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(
        tokenUri,
        new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: PlayClient.timeoutMs,
          validateStatus: () => true,
        },
      );
    } catch (e) {
      throw new PlayError(`Google sign-in did not answer (${(e as Error).message}).`, HttpStatus.BAD_GATEWAY, true);
    }
    if (res.status !== 200 || !res.data.access_token) {
      const why = res.data.error_description || res.data.error || `status ${res.status}`;
      throw new PlayError(
        `Google refused the service-account key (${why}). The key may have been deleted or disabled in Google Cloud; create a new key and mount it.`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    this.token = { value: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: 'get' | 'post' | 'delete', path: string, data?: unknown): Promise<T> {
    const state = this.keyState();
    if (state.kind !== 'ready') throw new PlayError(state.reason, HttpStatus.SERVICE_UNAVAILABLE);
    const token = await this.accessToken(state.key);
    const req: AxiosRequestConfig = {
      method,
      url: `${this.config.playApiUrl}${path}`,
      data,
      timeout: PlayClient.timeoutMs,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    };
    let res;
    try {
      res = await axios.request<T>(req);
    } catch (e) {
      throw new PlayError(`Google Play did not answer (${(e as Error).message}).`, HttpStatus.BAD_GATEWAY, true);
    }
    if (res.status >= 200 && res.status < 300) return res.data;
    throw this.explain(res.status, res.data, state.key);
  }

  private explain(status: number, body: unknown, key: ServiceAccountKey): PlayError {
    const err = (body as { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } } | null)?.error;
    const message = err?.message ?? `status ${status}`;
    const reason = err?.details?.find((d) => d.reason)?.reason ?? err?.status ?? '';
    if (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/.test(message)) {
      return new PlayError(
        `The Google Play Android Developer API is off for Google Cloud project ${key.project_id ?? ''}. Enable it at ` +
          `https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com?project=${key.project_id ?? ''} and try again in a few minutes.`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (status === 401 || status === 403) {
      return new PlayError(
        `Google Play refused ${key.client_email} (${message}). In Play Console > Users and permissions, invite that address ` +
          `and give it access to ${this.config.androidPackage} with permission to release.`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (status === 404) {
      return new PlayError(
        `Google Play has no app ${this.config.androidPackage} that ${key.client_email} can see (${message}).`,
        HttpStatus.NOT_FOUND,
      );
    }
    return new PlayError(`Google Play answered ${status}: ${message}.`, HttpStatus.BAD_GATEWAY);
  }
}

const TRACK_ORDER = ['production', 'beta', 'alpha', 'internal'];

function sortTracks(tracks: PlayTrack[]): PlayTrack[] {
  const rank = (t: string) => {
    const i = TRACK_ORDER.indexOf(t);
    return i === -1 ? TRACK_ORDER.length : i;
  };
  return [...tracks].sort((a, b) => rank(a.track) - rank(b.track) || a.track.localeCompare(b.track));
}
