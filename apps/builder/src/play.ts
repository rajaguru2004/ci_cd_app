import { createSign } from 'crypto';

/**
 * Reads Google Play with a service-account key, per app: what is on every track, and the
 * highest version code, which the next run builds above. Read-only by construction: it opens
 * an edit, reads the tracks, deletes the edit, and never commits one. Publishing is Fastlane's,
 * in the run, where the upload is logged next to the build that produced it.
 *
 * Google keeps one open edit per app and a new edit ends the one before it, so reads of one
 * app go one at a time, and none starts while a run of that app is uploading (the guard).
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

/** Validates a service-account key's shape. Throws a sentence that says what is wrong. */
export function parseServiceAccount(json: string): ServiceAccountKey {
  let data: Partial<ServiceAccountKey>;
  try {
    data = JSON.parse(json) as Partial<ServiceAccountKey>;
  } catch {
    throw new PlayError('That file is not JSON. Choose the key file Google Cloud downloaded for the service account.', 400);
  }
  if (data.type !== 'service_account') {
    throw new PlayError('That JSON is not a service-account key ("type" must be "service_account").', 400);
  }
  if (typeof data.client_email !== 'string' || !data.client_email) throw new PlayError('The key has no client_email.', 400);
  if (typeof data.private_key !== 'string' || !data.private_key.includes('PRIVATE KEY')) {
    throw new PlayError('The key has no PEM private_key.', 400);
  }
  return data as ServiceAccountKey;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** An RS256-signed JWT for Google's OAuth 2.0 JWT-bearer grant (RFC 7523). */
export function signServiceJwt(key: ServiceAccountKey, scope: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const payload = b64url(
    JSON.stringify({ iss: key.client_email, scope, aud: key.token_uri || 'https://oauth2.googleapis.com/token', iat: nowSeconds, exp: nowSeconds + 3600 }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key.private_key);
  return `${header}.${payload}.${b64url(signature)}`;
}

const TRACK_ORDER = ['production', 'beta', 'alpha', 'internal'];

function sortTracks(tracks: PlayTrack[]): PlayTrack[] {
  const rank = (t: string) => {
    const i = TRACK_ORDER.indexOf(t);
    return i === -1 ? TRACK_ORDER.length : i;
  };
  return [...tracks].sort((a, b) => rank(a.track) - rank(b.track) || a.track.localeCompare(b.track));
}

export class PlayClient {
  /** A snapshot this recent is served from memory: tracks change on a release, not a poll. */
  static cacheMs = 60_000;
  static timeoutMs = 20_000;
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly cache = new Map<string, { data: PlaySnapshot; at: number }>();
  private readonly inflight = new Map<string, Promise<PlaySnapshot>>();
  private guard: (packageName: string) => string | null = () => null;

  constructor(private readonly apiUrl: string) {}

  /** Names the run uploading this package right now (Fastlane holds its edit), or null. */
  setGuard(guard: (packageName: string) => string | null): void {
    this.guard = guard;
  }

  forget(packageName: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${packageName}|`)) this.cache.delete(k);
  }

  async snapshot(packageName: string, key: ServiceAccountKey, force = false): Promise<PlaySnapshot> {
    const id = `${packageName}|${key.client_email}`;
    const cached = this.cache.get(id);
    if (!force && cached && Date.now() - cached.at < PlayClient.cacheMs) return cached.data;
    const holder = this.guard(packageName);
    if (holder) {
      // Opening an edit now would end the upload's edit and fail the release: show the last read.
      if (cached) return cached.data;
      throw new PlayError(`${holder} The console reads Google Play again once that is done.`, 503);
    }
    let pending = this.inflight.get(packageName);
    if (!pending) {
      pending = this.fresh(packageName, key).finally(() => this.inflight.delete(packageName));
      this.inflight.set(packageName, pending);
    }
    const data = await pending;
    this.cache.set(id, { data, at: Date.now() });
    return data;
  }

  private async fresh(packageName: string, key: ServiceAccountKey): Promise<PlaySnapshot> {
    try {
      return await this.read(packageName, key);
    } catch (e) {
      // Reading tracks has no side effects, so a read that failed in transit is tried once more.
      if (e instanceof PlayError && e.transient) {
        await new Promise((r) => setTimeout(r, 500));
        return this.read(packageName, key);
      }
      throw e;
    }
  }

  private async read(packageName: string, key: ServiceAccountKey): Promise<PlaySnapshot> {
    const pkg = encodeURIComponent(packageName);
    const edit = await this.call<{ id: string }>(key, packageName, 'POST', `/applications/${pkg}/edits`, {});
    try {
      const res = await this.call<{ tracks?: Array<{ track: string; releases?: Array<Record<string, unknown>> }> }>(
        key,
        packageName,
        'GET',
        `/applications/${pkg}/edits/${encodeURIComponent(edit.id)}/tracks`,
      );
      const tracks: PlayTrack[] = (res.tracks ?? []).map((t) => ({
        track: t.track,
        releases: (t.releases ?? []).map((r) => ({
          name: (r.name as string | undefined) ?? null,
          versionCodes: ((r.versionCodes as string[] | undefined) ?? []).map((c) => Number(c)).filter(Number.isFinite),
          status: (r.status as string | undefined) ?? 'unknown',
          userFraction: (r.userFraction as number | undefined) ?? null,
          releaseNotes: ((r.releaseNotes as Array<{ language: string; text: string }> | undefined) ?? []).map((n) => ({ language: n.language, text: n.text })),
        })),
      }));
      const codes = tracks.flatMap((t) => t.releases.flatMap((r) => r.versionCodes));
      return {
        packageName,
        clientEmail: key.client_email,
        projectId: key.project_id ?? null,
        checkedAt: new Date().toISOString(),
        tracks: sortTracks(tracks),
        highestVersionCode: codes.length ? Math.max(...codes) : null,
      };
    } finally {
      // An open edit is harmless (Google expires it), but deleting it keeps the account tidy.
      await this.call(key, packageName, 'DELETE', `/applications/${pkg}/edits/${encodeURIComponent(edit.id)}`).catch((e: unknown) =>
        console.warn(`Could not delete Play edit ${edit.id}: ${(e as Error).message}`),
      );
    }
  }

  private async accessToken(key: ServiceAccountKey): Promise<string> {
    const cached = this.tokens.get(key.client_email);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value;
    const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
    let res: Response;
    try {
      res = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signServiceJwt(key, PUBLISHER_SCOPE) }).toString(),
        signal: AbortSignal.timeout(PlayClient.timeoutMs),
      });
    } catch (e) {
      throw new PlayError(`Google sign-in did not answer (${(e as Error).message}).`, 502, true);
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (res.status !== 200 || !data.access_token) {
      const why = data.error_description || data.error || `status ${res.status}`;
      throw new PlayError(
        `Google refused the service-account key ${key.client_email} (${why}). The key may have been deleted or disabled in Google Cloud; upload a new one.`,
        502,
      );
    }
    this.tokens.set(key.client_email, { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
    return data.access_token;
  }

  private async call<T>(key: ServiceAccountKey, packageName: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken(key);
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(PlayClient.timeoutMs),
      });
    } catch (e) {
      throw new PlayError(`Google Play did not answer (${(e as Error).message}).`, 502, true);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status >= 200 && res.status < 300) return data as T;
    throw this.explain(res.status, data, key, packageName);
  }

  private explain(status: number, body: unknown, key: ServiceAccountKey, packageName: string): PlayError {
    const err = (body as { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } } | null)?.error;
    const message = (err?.message ?? `status ${status}`).replace(/\.+$/, '');
    const reason = err?.details?.find((d) => d.reason)?.reason ?? err?.status ?? '';
    if (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/.test(message)) {
      return new PlayError(
        `The Google Play Android Developer API is off for Google Cloud project ${key.project_id ?? ''}. Enable it at ` +
          `https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com?project=${key.project_id ?? ''} and try again in a few minutes.`,
        502,
      );
    }
    if (status === 401 || status === 403) {
      return new PlayError(
        `Google Play refused ${key.client_email} (${message}). In Play Console → Users and permissions, invite that address ` +
          `and give it access to ${packageName} with permission to release.`,
        502,
      );
    }
    if (status === 404) {
      return new PlayError(
        `Google Play has no app ${packageName} that ${key.client_email} can see. Create the app in Play Console first (and upload its first build by hand: Google requires that), or check the package name.`,
        404,
      );
    }
    return new PlayError(`Google Play answered ${status}: ${message}.`, 502);
  }
}
