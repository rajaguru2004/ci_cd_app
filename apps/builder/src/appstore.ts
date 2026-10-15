import { createPrivateKey, sign } from 'crypto';

/**
 * Reads App Store Connect with an app's API key: proves the key works by finding the app by its
 * bundle ID, and reads its latest builds, whose highest build number the next iOS run builds
 * above. Read-only by construction; uploading is Fastlane's, on the Mac, in the run.
 */

export interface AppStoreKey {
  keyId: string;
  issuerId: string;
  /** The .p8 file's PEM text. */
  p8: string;
}

export class AppStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** App Store Connect was not reached at all, or failed on its side; worth another try later. */
    readonly transient = false,
  ) {
    super(message);
    this.name = 'AppStoreError';
  }
}

export interface AscBuild {
  /** CFBundleVersion, the build number. */
  buildNumber: string;
  /** CFBundleShortVersionString of the version it belongs to. */
  versionName: string | null;
  uploadedAt: string | null;
  processingState: string | null;
  expired: boolean;
}

export interface AscSnapshot {
  keyId: string;
  appId: string;
  appName: string;
  bundleId: string;
  checkedAt: string;
  builds: AscBuild[];
  /** The highest whole-number build number App Store Connect has for the app, any version. */
  highestBuild: number | null;
}

const KEY_ID = /^[A-Z0-9]{10}$/;
const ISSUER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks a key's three parts. Throws a sentence that says which one is wrong. */
export function parseAppStoreKey(input: { keyId?: unknown; issuerId?: unknown; p8?: unknown }): AppStoreKey {
  const keyId = typeof input.keyId === 'string' ? input.keyId.trim().toUpperCase() : '';
  const issuerId = typeof input.issuerId === 'string' ? input.issuerId.trim().toLowerCase() : '';
  const p8 = typeof input.p8 === 'string' ? input.p8.trim() : '';
  if (!KEY_ID.test(keyId)) throw new AppStoreError('The key ID is the 10 characters in the key’s file name (AuthKey_XXXXXXXXXX.p8) and next to it in App Store Connect.', 400);
  if (!ISSUER.test(issuerId)) throw new AppStoreError('The issuer ID is the UUID above the key list in App Store Connect → Users and Access → Integrations → App Store Connect API.', 400);
  if (!p8.includes('PRIVATE KEY')) throw new AppStoreError('Choose the .p8 key file App Store Connect gave you when the key was made.', 400);
  try {
    const key = createPrivateKey(p8);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not P-256');
  } catch {
    throw new AppStoreError('That .p8 is not an App Store Connect API key (an EC P-256 private key).', 400);
  }
  return { keyId, issuerId, p8: `${p8}\n` };
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** An ES256 JWT for the App Store Connect API (team keys; at most 20 minutes). */
export function signAppStoreJwt(key: AppStoreKey, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: key.keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: key.issuerId, iat: nowSeconds, exp: nowSeconds + 15 * 60, aud: 'appstoreconnect-v1' }));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: createPrivateKey(key.p8), dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(signature)}`;
}

interface JsonApi<T> {
  data: T;
  included?: Array<{ id: string; type: string; attributes?: Record<string, unknown> }>;
}

interface Resource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}

export class AppStoreClient {
  static timeoutMs = 20_000;
  /** A snapshot this recent is served from memory. */
  static cacheMs = 60_000;
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly cache = new Map<string, { data: AscSnapshot; at: number }>();

  constructor(private readonly apiUrl = 'https://api.appstoreconnect.apple.com') {}

  forget(bundleId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${bundleId}|`)) this.cache.delete(k);
  }

  async snapshot(key: AppStoreKey, bundleId: string, force = false): Promise<AscSnapshot> {
    const id = `${bundleId}|${key.keyId}`;
    const cached = this.cache.get(id);
    if (!force && cached && Date.now() - cached.at < AppStoreClient.cacheMs) return cached.data;
    const app = await this.findApp(key, bundleId);
    const builds = await this.builds(key, app.id);
    const numbers = builds.map((b) => (/^\d+$/.test(b.buildNumber) ? Number(b.buildNumber) : NaN)).filter(Number.isFinite);
    const data: AscSnapshot = {
      keyId: key.keyId,
      appId: app.id,
      appName: app.name,
      bundleId,
      checkedAt: new Date().toISOString(),
      builds: builds.slice(0, 8),
      highestBuild: numbers.length ? Math.max(...numbers) : null,
    };
    this.cache.set(id, { data, at: Date.now() });
    return data;
  }

  async findApp(key: AppStoreKey, bundleId: string): Promise<{ id: string; name: string }> {
    const res = await this.get<JsonApi<Resource[]>>(key, '/v1/apps', { 'filter[bundleId]': bundleId, 'fields[apps]': 'name,bundleId', limit: '5' });
    const app = res.data.find((a) => a.attributes?.bundleId === bundleId) ?? null;
    if (!app) {
      throw new AppStoreError(
        `App Store Connect has no app with the bundle ID ${bundleId} that key ${key.keyId} can see. Create it in App Store Connect → Apps → + (New App), or check the bundle ID.`,
        404,
      );
    }
    return { id: app.id, name: String(app.attributes?.name ?? bundleId) };
  }

  /** The app's latest builds, newest first (up to 200: the highest build number is among them). */
  async builds(key: AppStoreKey, appId: string): Promise<AscBuild[]> {
    const res = await this.get<JsonApi<Resource[]>>(key, '/v1/builds', {
      'filter[app]': appId,
      sort: '-uploadedDate',
      limit: '200',
      'fields[builds]': 'version,uploadedDate,processingState,expired,preReleaseVersion',
      include: 'preReleaseVersion',
      'fields[preReleaseVersions]': 'version',
    });
    const versions = new Map((res.included ?? []).filter((r) => r.type === 'preReleaseVersions').map((r) => [r.id, String(r.attributes?.version ?? '')]));
    return res.data.map((b) => ({
      buildNumber: String(b.attributes?.version ?? ''),
      versionName: versions.get(b.relationships?.preReleaseVersion?.data?.id ?? '') || null,
      uploadedAt: typeof b.attributes?.uploadedDate === 'string' ? b.attributes.uploadedDate : null,
      processingState: typeof b.attributes?.processingState === 'string' ? b.attributes.processingState : null,
      expired: b.attributes?.expired === true,
    }));
  }

  private token(key: AppStoreKey): string {
    const id = `${key.issuerId}|${key.keyId}`;
    const cached = this.tokens.get(id);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value;
    const value = signAppStoreJwt(key);
    this.tokens.set(id, { value, expiresAt: Date.now() + 15 * 60_000 });
    return value;
  }

  private async get<T>(key: AppStoreKey, path: string, query: Record<string, string>): Promise<T> {
    const url = `${this.apiUrl}${path}?${new URLSearchParams(query).toString()}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${this.token(key)}` }, signal: AbortSignal.timeout(AppStoreClient.timeoutMs) });
    } catch (e) {
      throw new AppStoreError(`App Store Connect did not answer (${(e as Error).message}).`, 502, true);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status >= 200 && res.status < 300) return data as T;
    const err = (data as { errors?: Array<{ code?: string; title?: string; detail?: string }> } | null)?.errors?.[0];
    const why = (err?.detail || err?.title || `status ${res.status}`).replace(/\.+$/, '');
    if (res.status === 401) {
      this.tokens.delete(`${key.issuerId}|${key.keyId}`);
      throw new AppStoreError(`App Store Connect refused key ${key.keyId} (${why}): the issuer ID is wrong, or the key was revoked. Make a new key in App Store Connect → Users and Access → Integrations.`, 422);
    }
    if (res.status === 403) {
      throw new AppStoreError(`App Store Connect does not let key ${key.keyId} read the app (${why}): give the key the App Manager or Admin role.`, 422);
    }
    if (res.status === 429) throw new AppStoreError('App Store Connect is rate-limiting this key; try again in a minute.', 503, true);
    if (res.status >= 500) throw new AppStoreError(`App Store Connect failed on its side (${why}).`, 502, true);
    throw new AppStoreError(`App Store Connect answered ${res.status}: ${why}.`, 502);
  }
}
