import { existsSync, promises as fs, readFileSync } from 'fs';
import { join } from 'path';
import { AppStoreError, parseAppStoreKey, type AppStoreKey } from './appstore';
import { checkBranch, Git, GitError, parseRepoUrl } from './git';
import { githubRepoOf } from './github';
import { IosError, isBundleId, parseProfile, readP12 } from './ios';
import type { KeyStore } from './keys';
import { parseServiceAccount, PlayError, type ServiceAccountKey } from './play';
import { isPackageName } from './project';
import { checkUploadKey, SigningError, type UploadKey } from './signing';
import type { AppRecord, AppStoreKeyInfo, GithubSetup, IosSetup, Platform, RepoConfig, RunApp, RunnerKind } from './types';
import type { Vault } from './vault';
import { WORKFLOW_FILE } from './workflow';

export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PROJECT_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{0,200}$/;
const MAX_KEYSTORE = 1024 * 1024;

export interface RepoInput {
  url?: unknown;
  keyId?: unknown;
  branch?: unknown;
  path?: unknown;
}

export interface SigningInput {
  /** The keystore file, base64. */
  keystore?: unknown;
  fileName?: unknown;
  storePassword?: unknown;
  keyAlias?: unknown;
  keyPassword?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'app';
}

/**
 * The organization's apps: name, package, repository and the keys each one releases with.
 * The record (apps/<id>/app.json) holds nothing secret; the keystore, its passwords and an
 * app's own Play key are sealed in the vault under apps/<id>/.
 */
export class AppStore {
  constructor(
    private readonly appsDir: string,
    private readonly vault: Vault,
    private readonly keys: KeyStore,
    private readonly git: Git,
    private readonly scratchDir: string,
    private readonly defaultPlayKeyFile: string,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.appsDir, { recursive: true });
  }

  async list(): Promise<AppRecord[]> {
    const ids = await fs.readdir(this.appsDir).catch(() => [] as string[]);
    const apps: AppRecord[] = [];
    for (const id of ids) {
      if (!ID.test(id)) continue;
      const app = await this.get(id);
      if (app) apps.push(app);
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<AppRecord | null> {
    if (!ID.test(id)) return null;
    try {
      const app = JSON.parse(await fs.readFile(join(this.appsDir, id, 'app.json'), 'utf8')) as AppRecord;
      // Apps added before GitHub Actions came back default to this server, but an app whose
      // repository is already on github.com still gets the option without anyone re-saving it.
      app.runner ??= { kind: 'server', github: null };
      app.runner.github ??= app.repo ? this.githubSetupFor(app.repo.url, null) : null;
      // Apps added before iOS came are Android-only until someone sets their iOS side up.
      app.ios ??= null;
      return app;
    } catch {
      return null;
    }
  }

  async require(id: string): Promise<AppRecord> {
    const app = await this.get(id);
    if (!app) throw new AppError(`There is no app '${id}' on this console.`, 404);
    return app;
  }

  async create(input: { name?: unknown; packageName?: unknown; repo?: RepoInput | null }): Promise<AppRecord> {
    const name = this.checkName(input.name);
    const packageName = this.checkPackage(input.packageName);
    const existing = await this.list();
    const clash = existing.find((a) => a.packageName === packageName);
    if (clash) throw new AppError(`${clash.name} already releases ${packageName}.`, 409);
    let id = slugify(name);
    for (let n = 2; existing.some((a) => a.id === id); n += 1) id = `${slugify(name).slice(0, 36)}-${n}`;
    const at = new Date().toISOString();
    const app: AppRecord = {
      id,
      name,
      packageName,
      repo: input.repo ? await this.checkRepo(input.repo, null) : null,
      signing: { mode: 'repository', fileName: null, keyAlias: null, certificate: null, updatedAt: null },
      play: { source: 'default', clientEmail: this.defaultPlayEmail(), projectId: null, updatedAt: null },
      runner: { kind: 'server', github: null },
      ios: null,
      createdAt: at,
      updatedAt: at,
    };
    app.runner = this.runnerFor(app, 'server');
    await this.save(app);
    return app;
  }

  async update(id: string, patch: { name?: unknown; packageName?: unknown; repo?: RepoInput | null }): Promise<AppRecord> {
    const app = await this.require(id);
    if (patch.name !== undefined) app.name = this.checkName(patch.name);
    if (patch.packageName !== undefined) {
      const packageName = this.checkPackage(patch.packageName);
      const clash = (await this.list()).find((a) => a.packageName === packageName && a.id !== id);
      if (clash) throw new AppError(`${clash.name} already releases ${packageName}.`, 409);
      app.packageName = packageName;
    }
    if (patch.repo === null) {
      app.repo = null;
      await this.git.removeMirror(id);
    } else if (patch.repo !== undefined) {
      const before = app.repo?.url;
      app.repo = await this.checkRepo(patch.repo, app.repo);
      if (before && before !== app.repo.url) await this.git.removeMirror(id);
    }
    // GitHub Actions follows the repository: another GitHub repository resets its checks, a
    // repository elsewhere (or none) sends the builds back to this server.
    app.runner = this.runnerFor(app, app.runner.kind);
    app.updatedAt = new Date().toISOString();
    await this.save(app);
    return app;
  }

  /** Where Android's Build and Release run by default (iOS always runs on a Mac runner). */
  async setRunner(id: string, kind: unknown): Promise<AppRecord> {
    const app = await this.require(id);
    if (kind !== 'server' && kind !== 'github') throw new AppError('Android builds run on this server (server) or on GitHub Actions (github).');
    if (kind === 'github' && !(app.repo && githubRepoOf(app.repo.url))) {
      throw new AppError(`${app.name}'s repository is not on github.com, so its builds cannot run on GitHub Actions; they run on this server.`, 409);
    }
    app.runner = this.runnerFor(app, kind);
    app.updatedAt = new Date().toISOString();
    await this.save(app);
    return app;
  }

  /** Records what the console last did or found on GitHub for the app. */
  async noteGithub(id: string, patch: Partial<Pick<GithubSetup, 'token' | 'tokenLogin' | 'check' | 'secrets'>>): Promise<AppRecord> {
    const app = await this.require(id);
    if (!app.runner.github) throw new AppError(`${app.name}'s repository is not on github.com.`, 409);
    app.runner.github = { ...app.runner.github, ...patch };
    await this.save(app);
    return app;
  }

  /** The runner settings for the app's repository: GitHub setup kept, reset or dropped as it changed. */
  private runnerFor(app: AppRecord, kind: Exclude<RunnerKind, 'mac'>): AppRecord['runner'] {
    const github = app.repo ? this.githubSetupFor(app.repo.url, app.runner?.github ?? null) : null;
    return { kind: github ? kind : 'server', github };
  }

  /** A fresh GitHub setup for a repository URL, carrying over the current one's token and secrets when it is the same repository; null off github.com. */
  private githubSetupFor(repoUrl: string, current: GithubSetup | null): GithubSetup | null {
    const repo = githubRepoOf(repoUrl);
    if (!repo) return null;
    if (current && current.repo === repo) return current;
    return { repo, workflow: WORKFLOW_FILE, token: current?.token ?? 'default', tokenLogin: current?.tokenLogin ?? null, check: null, secrets: { syncedAt: null, hash: null } };
  }

  /** Checks the repository again with ls-remote and records the answer on the app. */
  async checkAccess(id: string): Promise<AppRecord> {
    const app = await this.require(id);
    if (!app.repo) throw new AppError(`${app.name} has no repository; it builds from uploaded ZIPs.`, 409);
    app.repo = await this.probe(app.repo);
    app.updatedAt = new Date().toISOString();
    await this.save(app);
    return app;
  }

  /** Notes the result of a fetch on the app, so the overview shows a repository gone wrong. */
  async noteAccess(id: string, error: string | null): Promise<void> {
    const app = await this.get(id);
    if (!app?.repo) return;
    const state = error ? 'failed' : 'ok';
    if (app.repo.access.state === state && app.repo.access.message === error) return;
    app.repo.access = { state, checkedAt: new Date().toISOString(), message: error };
    await this.save(app);
  }

  async remove(id: string): Promise<void> {
    await this.require(id);
    await this.git.removeMirror(id);
    await this.vault.remove(`apps/${id}`);
    await fs.rm(join(this.appsDir, id), { recursive: true, force: true });
  }

  // ─── Signing ─────────────────────────────────────────────────────────────────────────

  async setSigning(id: string, input: SigningInput): Promise<AppRecord> {
    const app = await this.require(id);
    const b64 = typeof input.keystore === 'string' ? input.keystore.replace(/^data:[^,]*,/, '') : '';
    const keystore = Buffer.from(b64, 'base64');
    if (!keystore.length) throw new AppError('Choose the keystore file (.jks, .keystore or .p12).');
    if (keystore.length > MAX_KEYSTORE) throw new AppError('That file is too large to be a keystore.');
    const storePassword = typeof input.storePassword === 'string' ? input.storePassword : '';
    if (!storePassword) throw new AppError('Enter the keystore password.');
    const keyPassword = typeof input.keyPassword === 'string' && input.keyPassword ? input.keyPassword : storePassword;
    let checked;
    try {
      checked = await checkUploadKey({ keystore, storePassword, keyAlias: str(input.keyAlias), keyPassword }, this.scratchDir);
    } catch (e) {
      if (e instanceof SigningError) throw new AppError(e.message, 422);
      throw e;
    }
    await this.vault.put(`apps/${id}/keystore`, keystore);
    await this.vault.put(`apps/${id}/signing.json`, Buffer.from(JSON.stringify({ storePassword, keyAlias: checked.alias, keyPassword })));
    app.signing = {
      mode: 'console',
      fileName: str(input.fileName).replace(/[^\w.\- ]/g, '').slice(0, 120) || 'upload.keystore',
      keyAlias: checked.alias,
      certificate: checked.certificate,
      updatedAt: new Date().toISOString(),
    };
    app.updatedAt = app.signing.updatedAt!;
    await this.save(app);
    return app;
  }

  /** Back to the project's own signing (its key.properties); the stored keystore is deleted. */
  async clearSigning(id: string): Promise<AppRecord> {
    const app = await this.require(id);
    await this.vault.remove(`apps/${id}/keystore`);
    await this.vault.remove(`apps/${id}/signing.json`);
    app.signing = { mode: 'repository', fileName: null, keyAlias: null, certificate: null, updatedAt: new Date().toISOString() };
    app.updatedAt = app.signing.updatedAt!;
    await this.save(app);
    return app;
  }

  async uploadKey(id: string): Promise<UploadKey | null> {
    const [keystore, secrets] = await Promise.all([this.vault.get(`apps/${id}/keystore`), this.vault.get(`apps/${id}/signing.json`)]);
    if (!keystore || !secrets) return null;
    const s = JSON.parse(secrets.toString('utf8')) as { storePassword: string; keyAlias: string; keyPassword: string };
    return { keystore, ...s };
  }

  // ─── Google Play key ─────────────────────────────────────────────────────────────────

  async setPlayKey(id: string, json: unknown): Promise<AppRecord> {
    const app = await this.require(id);
    const text = typeof json === 'string' ? json.trim() : '';
    if (!text) throw new AppError('Choose the service-account JSON key.');
    if (text.length > 20_000) throw new AppError('That file is too large to be a service-account key.');
    let key: ServiceAccountKey;
    try {
      key = parseServiceAccount(text);
    } catch (e) {
      throw new AppError((e as PlayError).message);
    }
    await this.vault.put(`apps/${id}/play.json`, Buffer.from(text));
    app.play = { source: 'app', clientEmail: key.client_email, projectId: key.project_id ?? null, updatedAt: new Date().toISOString() };
    app.updatedAt = app.play.updatedAt!;
    await this.save(app);
    return app;
  }

  async clearPlayKey(id: string): Promise<AppRecord> {
    const app = await this.require(id);
    await this.vault.remove(`apps/${id}/play.json`);
    app.play = { source: 'default', clientEmail: this.defaultPlayEmail(), projectId: null, updatedAt: new Date().toISOString() };
    app.updatedAt = app.play.updatedAt!;
    await this.save(app);
    return app;
  }

  /** The key a run or a read of Play uses for this app: its own, else the console's default. */
  async playKey(app: AppRecord): Promise<{ key: ServiceAccountKey; json: string; source: 'app' | 'default' } | null> {
    if (app.play.source === 'app') {
      const blob = await this.vault.get(`apps/${app.id}/play.json`);
      if (blob) {
        const json = blob.toString('utf8');
        return { key: parseServiceAccount(json), json, source: 'app' };
      }
    }
    const json = this.defaultPlayJson();
    return json ? { key: parseServiceAccount(json), json, source: 'default' } : null;
  }

  defaultPlayJson(): string | null {
    try {
      if (!this.defaultPlayKeyFile || !existsSync(this.defaultPlayKeyFile)) return null;
      const json = readFileSync(this.defaultPlayKeyFile, 'utf8');
      parseServiceAccount(json);
      return json;
    } catch {
      return null;
    }
  }

  defaultPlayEmail(): string | null {
    const json = this.defaultPlayJson();
    return json ? parseServiceAccount(json).client_email : null;
  }

  // ─── iOS ─────────────────────────────────────────────────────────────────────────────

  /** Turns on the app's iOS side, or changes its bundle ID (the signing is kept; the plan checks it fits). */
  async setIos(id: string, input: { bundleId?: unknown }): Promise<AppRecord> {
    const app = await this.require(id);
    const bundleId = str(input.bundleId);
    if (!isBundleId(bundleId)) throw new AppError(`'${bundleId || '(empty)'}' is not a bundle ID (CFBundleIdentifier), e.g. com.company.app.`);
    const clash = (await this.list()).find((a) => a.id !== id && a.ios?.bundleId === bundleId);
    if (clash) throw new AppError(`${clash.name} already releases ${bundleId} on iOS.`, 409);
    const at = new Date().toISOString();
    const before = app.ios;
    app.ios = before
      ? {
          ...before,
          bundleId,
          // Another app on App Store Connect: the key stays, the app it found does not.
          appStore: before.appStore && before.bundleId !== bundleId ? { ...before.appStore, appId: null, appName: null, checkedAt: null, message: null } : before.appStore,
          updatedAt: at,
        }
      : { bundleId, certificate: null, profiles: [], appStore: null, updatedAt: at };
    app.updatedAt = at;
    await this.save(app);
    return app;
  }

  /** Back to Android only: the iOS certificate, profiles and App Store Connect key are deleted. */
  async clearIos(id: string): Promise<AppRecord> {
    const app = await this.require(id);
    await this.vault.remove(`apps/${id}/ios`);
    app.ios = null;
    app.updatedAt = new Date().toISOString();
    await this.save(app);
    return app;
  }

  async setIosCertificate(id: string, input: { p12?: unknown; password?: unknown; fileName?: unknown }): Promise<AppRecord> {
    const app = await this.require(id);
    const ios = this.iosOf(app);
    const b64 = typeof input.p12 === 'string' ? input.p12.replace(/^data:[^,]*,/, '') : '';
    const p12 = Buffer.from(b64, 'base64');
    const password = typeof input.password === 'string' ? input.password : '';
    let cert;
    try {
      cert = await readP12(p12, password, str(input.fileName), this.scratchDir);
    } catch (e) {
      if (e instanceof IosError) throw new AppError(e.message, e.status);
      throw e;
    }
    if (cert.kind === 'development') {
      throw new AppError(`${cert.name} is a development certificate; App Store Connect builds are signed with an Apple Distribution certificate.`, 422);
    }
    const otherTeam = ios.profiles.find((p) => cert.teamId && p.teamId !== cert.teamId);
    if (otherTeam) throw new AppError(`${cert.name} belongs to team ${cert.teamId}, but the profile ${otherTeam.name} is team ${otherTeam.teamId}: remove that profile first.`, 422);
    await this.vault.put(`apps/${id}/ios/certificate.p12`, p12);
    await this.vault.put(`apps/${id}/ios/certificate.json`, Buffer.from(JSON.stringify({ password })));
    ios.certificate = cert;
    ios.updatedAt = app.updatedAt = cert.uploadedAt;
    await this.save(app);
    return app;
  }

  async clearIosCertificate(id: string): Promise<AppRecord> {
    const app = await this.require(id);
    const ios = this.iosOf(app);
    await this.vault.remove(`apps/${id}/ios/certificate.p12`);
    await this.vault.remove(`apps/${id}/ios/certificate.json`);
    ios.certificate = null;
    ios.updatedAt = app.updatedAt = new Date().toISOString();
    await this.save(app);
    return app;
  }

  /** Adds a provisioning profile; a renewed one (same name and App ID) replaces the old one. */
  async addIosProfile(id: string, input: { data?: unknown; fileName?: unknown }): Promise<AppRecord> {
    const app = await this.require(id);
    const ios = this.iosOf(app);
    const data = Buffer.from(typeof input.data === 'string' ? input.data.replace(/^data:[^,]*,/, '') : '', 'base64');
    if (!data.length) throw new AppError('Choose the .mobileprovision file.');
    if (data.length > 512 * 1024) throw new AppError('That file is too large to be a provisioning profile.');
    let profile;
    try {
      profile = parseProfile(data, str(input.fileName));
    } catch (e) {
      if (e instanceof IosError) throw new AppError(e.message, 422);
      throw e;
    }
    if (profile.platforms.length && !profile.platforms.includes('iOS')) throw new AppError(`${profile.name} is a ${profile.platforms.join('/')} profile, not an iOS one.`, 422);
    if (profile.type !== 'app-store') {
      throw new AppError(`${profile.name} is ${profile.type === 'ad-hoc' ? 'an ad hoc' : `a ${profile.type}`} profile; App Store Connect takes builds signed with an App Store profile (developer.apple.com → Profiles → + → App Store Connect).`, 422);
    }
    if (Date.parse(profile.expiresAt) < Date.now()) throw new AppError(`${profile.name} expired on ${profile.expiresAt.slice(0, 10)}: download it again from developer.apple.com.`, 422);
    if (ios.certificate?.teamId && profile.teamId !== ios.certificate.teamId) {
      throw new AppError(`${profile.name} is for team ${profile.teamId}, but the certificate is team ${ios.certificate.teamId}.`, 422);
    }
    if (ios.certificate && !profile.certificates.includes(ios.certificate.sha1)) {
      throw new AppError(`${profile.name} does not include ${ios.certificate.name}: edit the profile at developer.apple.com to include that certificate, then download it again.`, 422);
    }
    const { platforms: _platforms, ...stored } = profile;
    const replaced = ios.profiles.filter((p) => p.uuid === profile.uuid || (p.name === profile.name && p.appId === profile.appId));
    for (const old of replaced) await this.vault.remove(`apps/${id}/ios/profiles/${old.uuid.toLowerCase()}.mobileprovision`);
    await this.vault.put(`apps/${id}/ios/profiles/${profile.uuid.toLowerCase()}.mobileprovision`, data);
    ios.profiles = [...ios.profiles.filter((p) => !replaced.includes(p)), stored].sort((a, b) => a.appId.localeCompare(b.appId));
    ios.updatedAt = app.updatedAt = stored.uploadedAt;
    await this.save(app);
    return app;
  }

  async removeIosProfile(id: string, uuid: string): Promise<AppRecord> {
    const app = await this.require(id);
    const ios = this.iosOf(app);
    const profile = ios.profiles.find((p) => p.uuid.toLowerCase() === uuid.toLowerCase());
    if (!profile) throw new AppError('That profile is not stored for this app.', 404);
    await this.vault.remove(`apps/${id}/ios/profiles/${profile.uuid.toLowerCase()}.mobileprovision`);
    ios.profiles = ios.profiles.filter((p) => p !== profile);
    ios.updatedAt = app.updatedAt = new Date().toISOString();
    await this.save(app);
    return app;
  }

  /** Stores an App Store Connect API key (checked against App Store Connect by the caller). */
  async setAppStoreKey(id: string, input: { keyId?: unknown; issuerId?: unknown; p8?: unknown }): Promise<{ app: AppRecord; key: AppStoreKey }> {
    const app = await this.require(id);
    const ios = this.iosOf(app);
    let key: AppStoreKey;
    try {
      key = parseAppStoreKey(input);
    } catch (e) {
      if (e instanceof AppStoreError) throw new AppError(e.message, e.status);
      throw e;
    }
    await this.vault.put(`apps/${id}/ios/appstore.json`, Buffer.from(JSON.stringify(key)));
    const at = new Date().toISOString();
    ios.appStore = { keyId: key.keyId, issuerId: key.issuerId, appId: null, appName: null, checkedAt: null, message: null, updatedAt: at };
    ios.updatedAt = app.updatedAt = at;
    await this.save(app);
    return { app, key };
  }

  async clearAppStoreKey(id: string): Promise<AppRecord> {
    const app = await this.require(id);
    const ios = this.iosOf(app);
    await this.vault.remove(`apps/${id}/ios/appstore.json`);
    ios.appStore = null;
    ios.updatedAt = app.updatedAt = new Date().toISOString();
    await this.save(app);
    return app;
  }

  /** Records what App Store Connect last said about the app's key (found the app, or why not). */
  async noteAppStore(id: string, patch: Pick<AppStoreKeyInfo, 'appId' | 'appName' | 'message'>): Promise<AppRecord> {
    const app = await this.require(id);
    if (!app.ios?.appStore) return app;
    app.ios.appStore = { ...app.ios.appStore, ...patch, checkedAt: new Date().toISOString() };
    await this.save(app);
    return app;
  }

  async appStoreKey(app: AppRecord): Promise<AppStoreKey | null> {
    if (!app.ios?.appStore) return null;
    const blob = await this.vault.get(`apps/${app.id}/ios/appstore.json`);
    return blob ? (JSON.parse(blob.toString('utf8')) as AppStoreKey) : null;
  }

  /** The certificate and every profile a Mac needs to sign the app, out of the vault. */
  async iosSigning(app: AppRecord): Promise<{ p12: Buffer; password: string; profiles: Array<{ uuid: string; data: Buffer }> } | null> {
    if (!app.ios?.certificate) return null;
    const [p12, secrets] = await Promise.all([this.vault.get(`apps/${app.id}/ios/certificate.p12`), this.vault.get(`apps/${app.id}/ios/certificate.json`)]);
    if (!p12 || !secrets) return null;
    const profiles: Array<{ uuid: string; data: Buffer }> = [];
    for (const p of app.ios.profiles) {
      const data = await this.vault.get(`apps/${app.id}/ios/profiles/${p.uuid.toLowerCase()}.mobileprovision`);
      if (data) profiles.push({ uuid: p.uuid, data });
    }
    return { p12, password: (JSON.parse(secrets.toString('utf8')) as { password: string }).password, profiles };
  }

  private iosOf(app: AppRecord): IosSetup {
    if (!app.ios) throw new AppError(`${app.name} has no iOS setup yet: enter its bundle ID first.`, 409);
    return app.ios;
  }

  // ─── Run numbers ─────────────────────────────────────────────────────────────────────

  /** The next run number of this app (#1, #2, …), never reused. */
  async nextNumber(id: string, atLeast = 0): Promise<number> {
    const file = join(this.appsDir, id, 'counter.json');
    let last = 0;
    try {
      last = Number(JSON.parse(await fs.readFile(file, 'utf8')).last) || 0;
    } catch {
      /* first run */
    }
    const next = Math.max(last, atLeast) + 1;
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ last: next }));
    await fs.rename(`${file}.tmp`, file);
    return next;
  }

  snapshot(app: AppRecord, platform: Platform = 'android'): RunApp {
    return {
      id: app.id,
      name: app.name,
      packageName: app.packageName,
      signing: app.signing.mode,
      projectPath: app.repo?.path ?? '',
      certSha256: app.signing.mode === 'console' ? (app.signing.certificate?.sha256 ?? null) : null,
      ...(platform === 'ios' && app.ios ? { bundleId: app.ios.bundleId, iosCertSha1: app.ios.certificate?.sha1 ?? null } : {}),
    };
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────

  private async checkRepo(input: RepoInput, current: RepoConfig | null): Promise<RepoConfig> {
    const repo = parseRepoUrl(input.url ?? current?.url);
    const keyId = str(input.keyId) || current?.keyId || '';
    if (!keyId) throw new AppError('Pick the SSH key that reaches this repository.');
    await this.keys.require(keyId);
    const path = str(input.path ?? current?.path ?? '').replace(/^\/+|\/+$/g, '');
    if (!PROJECT_PATH.test(path)) throw new AppError(`'${path}' is not a folder inside the repository.`);
    const branchInput = input.branch !== undefined ? input.branch : current?.branch;
    const config: RepoConfig = {
      url: repo.url,
      keyId,
      branch: branchInput !== undefined && str(branchInput) ? checkBranch(branchInput) : '',
      defaultBranch: current && current.url === repo.url ? current.defaultBranch : null,
      path,
      access: { state: 'unchecked', checkedAt: null, message: null },
    };
    return this.probe(config);
  }

  /** ls-remote with the app's key: records whether it works and the remote's default branch. */
  private async probe(config: RepoConfig): Promise<RepoConfig> {
    const repo = parseRepoUrl(config.url);
    try {
      const remote = await this.git.lsRemote(repo, config.keyId);
      const branch = config.branch || remote.defaultBranch || remote.branches[0] || 'main';
      if (remote.branches.length && !remote.branches.includes(branch)) {
        throw new AppError(`${repo.path.replace(/\.git$/, '')} has no branch '${branch}'. It has ${remote.branches.slice(0, 8).join(', ')}.`, 422);
      }
      return { ...config, branch, defaultBranch: remote.defaultBranch, access: { state: 'ok', checkedAt: new Date().toISOString(), message: null } };
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (!(e instanceof GitError)) throw e;
      return { ...config, branch: config.branch || 'main', access: { state: 'failed', checkedAt: new Date().toISOString(), message: e.message } };
    }
  }

  private checkName(input: unknown): string {
    const name = str(input).replace(/\s+/g, ' ');
    if (!name) throw new AppError('Give the app a name.');
    if (name.length > 60) throw new AppError('Keep the app name under 60 characters.');
    return name;
  }

  private checkPackage(input: unknown): string {
    const packageName = str(input);
    if (!isPackageName(packageName)) {
      throw new AppError(`'${packageName || '(empty)'}' is not an Android package name (applicationId), e.g. com.company.app.`);
    }
    return packageName;
  }

  private async save(app: AppRecord): Promise<void> {
    const dir = join(this.appsDir, app.id);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, 'app.json');
    await fs.writeFile(`${file}.tmp`, JSON.stringify(app, null, 2));
    await fs.rename(`${file}.tmp`, file);
  }
}
