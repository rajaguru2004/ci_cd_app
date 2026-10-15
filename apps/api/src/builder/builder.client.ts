import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';
import type {
  AccessCheck,
  AppView,
  BuilderHealth,
  BuilderRun,
  CommitInfo,
  CommitsResponse,
  GithubTokenView,
  HostKey,
  KeyRecord,
  MacRunnerView,
  MacsResponse,
  ProjectInfo,
  RunnerKind,
} from './builder.types';

/** The builder refused, failed or could not be reached; the message is for the engineer. */
export class BuilderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BuilderError';
  }
}

/**
 * The console API's one way to the builder (vault, git, pipeline). Every refusal comes back as
 * the builder's own sentence with its status, so the screen shows what to fix.
 */
@Injectable()
export class BuilderClient {
  static timeoutMs = 30_000;

  constructor(@Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig) {}

  get configured(): boolean {
    return Boolean(this.config.builderUrl && this.config.builderToken);
  }

  // ─── Keys and git ──────────────────────────────────────────────────────────────────

  keys(): Promise<KeyRecord[]> {
    return this.send({ method: 'get', url: '/keys' });
  }

  createKey(email: string, name?: string | null): Promise<KeyRecord> {
    return this.send({ method: 'post', url: '/keys', data: { email, name } });
  }

  deleteKey(id: string): Promise<void> {
    return this.send({ method: 'delete', url: `/keys/${encodeURIComponent(id)}` });
  }

  knownHosts(): Promise<HostKey[]> {
    return this.send({ method: 'get', url: '/known-hosts' });
  }

  forgetHost(host: string): Promise<void> {
    return this.send({ method: 'delete', url: `/known-hosts/${encodeURIComponent(host)}` });
  }

  checkAccess(url: string, keyId: string): Promise<AccessCheck> {
    return this.send({ method: 'post', url: '/git/check', data: { url, keyId } }, 120_000);
  }

  inspect(url: string, keyId: string, branch: string, path?: string): Promise<ProjectInfo> {
    return this.send({ method: 'post', url: '/git/inspect', data: { url, keyId, branch, path } }, 300_000);
  }

  // ─── Apps ──────────────────────────────────────────────────────────────────────────

  apps(): Promise<AppView[]> {
    return this.send({ method: 'get', url: '/apps' });
  }

  app(id: string): Promise<AppView> {
    return this.send({ method: 'get', url: `/apps/${encodeURIComponent(id)}` });
  }

  createApp(body: Record<string, unknown>): Promise<AppView> {
    return this.send({ method: 'post', url: '/apps', data: body }, 120_000);
  }

  updateApp(id: string, body: Record<string, unknown>): Promise<AppView> {
    return this.send({ method: 'patch', url: `/apps/${encodeURIComponent(id)}`, data: body }, 120_000);
  }

  deleteApp(id: string): Promise<{ ok: true; removedRuns: number }> {
    return this.send({ method: 'delete', url: `/apps/${encodeURIComponent(id)}` }, 120_000);
  }

  recheckAccess(id: string): Promise<AppView> {
    return this.send({ method: 'post', url: `/apps/${encodeURIComponent(id)}/access` }, 120_000);
  }

  setSigning(id: string, body: Record<string, unknown>): Promise<AppView> {
    return this.send({ method: 'put', url: `/apps/${encodeURIComponent(id)}/signing`, data: body }, 120_000);
  }

  clearSigning(id: string): Promise<AppView> {
    return this.send({ method: 'delete', url: `/apps/${encodeURIComponent(id)}/signing` });
  }

  setPlayKey(id: string, json: string): Promise<AppView> {
    return this.send({ method: 'put', url: `/apps/${encodeURIComponent(id)}/play`, data: { json } });
  }

  clearPlayKey(id: string): Promise<AppView> {
    return this.send({ method: 'delete', url: `/apps/${encodeURIComponent(id)}/play` });
  }

  play(id: string, refresh = false): Promise<Record<string, unknown>> {
    return this.send({ method: 'get', url: `/apps/${encodeURIComponent(id)}/play`, params: refresh ? { refresh: 1 } : undefined }, 60_000);
  }

  // ─── iOS ───────────────────────────────────────────────────────────────────────────

  setIos(id: string, bundleId: string): Promise<AppView> {
    return this.send({ method: 'put', url: `/apps/${encodeURIComponent(id)}/ios`, data: { bundleId } });
  }

  clearIos(id: string): Promise<AppView> {
    return this.send({ method: 'delete', url: `/apps/${encodeURIComponent(id)}/ios` });
  }

  setIosCertificate(id: string, body: Record<string, unknown>): Promise<AppView> {
    return this.send({ method: 'put', url: `/apps/${encodeURIComponent(id)}/ios/certificate`, data: body }, 120_000);
  }

  clearIosCertificate(id: string): Promise<AppView> {
    return this.send({ method: 'delete', url: `/apps/${encodeURIComponent(id)}/ios/certificate` });
  }

  addIosProfile(id: string, body: Record<string, unknown>): Promise<AppView> {
    return this.send({ method: 'post', url: `/apps/${encodeURIComponent(id)}/ios/profiles`, data: body });
  }

  removeIosProfile(id: string, uuid: string): Promise<AppView> {
    return this.send({ method: 'delete', url: `/apps/${encodeURIComponent(id)}/ios/profiles/${encodeURIComponent(uuid)}` });
  }

  setAppStoreKey(id: string, body: Record<string, unknown>): Promise<AppView> {
    return this.send({ method: 'put', url: `/apps/${encodeURIComponent(id)}/ios/app-store`, data: body }, 60_000);
  }

  clearAppStoreKey(id: string): Promise<AppView> {
    return this.send({ method: 'delete', url: `/apps/${encodeURIComponent(id)}/ios/app-store` });
  }

  appStore(id: string, refresh = false): Promise<Record<string, unknown>> {
    return this.send({ method: 'get', url: `/apps/${encodeURIComponent(id)}/ios/app-store`, params: refresh ? { refresh: 1 } : undefined }, 60_000);
  }

  // ─── Mac runners ───────────────────────────────────────────────────────────────────

  macs(): Promise<MacsResponse> {
    return this.send({ method: 'get', url: '/macs' });
  }

  createMac(name: string): Promise<{ runner: MacRunnerView; token: string; image: string }> {
    return this.send({ method: 'post', url: '/macs', data: { name } });
  }

  renameMac(id: string, name: string): Promise<MacRunnerView> {
    return this.send({ method: 'patch', url: `/macs/${encodeURIComponent(id)}`, data: { name } });
  }

  rotateMacToken(id: string): Promise<{ runner: MacRunnerView; token: string; image: string }> {
    return this.send({ method: 'post', url: `/macs/${encodeURIComponent(id)}/token` });
  }

  resetMacKey(id: string): Promise<MacRunnerView> {
    return this.send({ method: 'post', url: `/macs/${encodeURIComponent(id)}/reset-key` });
  }

  removeMac(id: string): Promise<{ ok: true }> {
    return this.send({ method: 'delete', url: `/macs/${encodeURIComponent(id)}` });
  }

  // ─── Where builds run ──────────────────────────────────────────────────────────────

  setRunner(id: string, kind: RunnerKind): Promise<AppView> {
    return this.send({ method: 'put', url: `/apps/${encodeURIComponent(id)}/runner`, data: { kind } });
  }

  setGithubToken(id: string, token: string): Promise<AppView> {
    return this.send({ method: 'put', url: `/apps/${encodeURIComponent(id)}/github/token`, data: { token } }, 60_000);
  }

  clearGithubToken(id: string): Promise<AppView> {
    return this.send({ method: 'delete', url: `/apps/${encodeURIComponent(id)}/github/token` });
  }

  checkGithub(id: string): Promise<AppView> {
    return this.send({ method: 'post', url: `/apps/${encodeURIComponent(id)}/github/check` }, 60_000);
  }

  githubWorkflow(id: string): Promise<{ path: string; yaml: string }> {
    return this.send({ method: 'get', url: `/apps/${encodeURIComponent(id)}/github/workflow` });
  }

  installGithubWorkflow(id: string): Promise<{ app: AppView; result: { kind: 'commit' | 'pull-request' | 'unchanged'; url: string | null; message: string } }> {
    return this.send({ method: 'post', url: `/apps/${encodeURIComponent(id)}/github/workflow` }, 60_000);
  }

  syncGithubSecrets(id: string): Promise<{ app: AppView; synced: string[]; removed: string[] }> {
    return this.send({ method: 'post', url: `/apps/${encodeURIComponent(id)}/github/secrets` }, 60_000);
  }

  defaultGithubToken(): Promise<{ token: GithubTokenView | null; apiUrl: string }> {
    return this.send({ method: 'get', url: '/github' });
  }

  setDefaultGithubToken(token: string): Promise<{ token: GithubTokenView; apiUrl: string }> {
    return this.send({ method: 'put', url: '/github/token', data: { token } }, 60_000);
  }

  clearDefaultGithubToken(): Promise<{ token: null; apiUrl: string }> {
    return this.send({ method: 'delete', url: '/github/token' });
  }

  commits(id: string, branch?: string, refresh = false): Promise<CommitsResponse> {
    return this.send(
      { method: 'get', url: `/apps/${encodeURIComponent(id)}/commits`, params: { ...(branch ? { branch } : {}), ...(refresh ? { refresh: 1 } : {}) } },
      60_000,
    );
  }

  /** One commit of an app's repository mirror (subject, author, date). */
  commit(id: string, sha: string): Promise<CommitInfo & { sha: string }> {
    return this.send({ method: 'get', url: `/apps/${encodeURIComponent(id)}/commits/${sha}` });
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────────────

  runs(appId?: string, limit?: number): Promise<BuilderRun[]> {
    return this.send({ method: 'get', url: '/runs', params: { ...(appId ? { app: appId } : {}), ...(limit ? { limit } : {}) } });
  }

  run(id: number): Promise<BuilderRun> {
    return this.send({ method: 'get', url: `/runs/${id}` });
  }

  log(id: number, jobId: number): Promise<string> {
    return this.send({ method: 'get', url: `/runs/${id}/logs/${jobId}`, responseType: 'text' });
  }

  startRun(body: Record<string, unknown>): Promise<BuilderRun> {
    return this.send({ method: 'post', url: '/runs', data: body }, 90_000);
  }

  cancel(id: number): Promise<void> {
    return this.send({ method: 'post', url: `/runs/${id}/cancel` });
  }

  rerun(id: number): Promise<BuilderRun> {
    return this.send({ method: 'post', url: `/runs/${id}/rerun` });
  }

  async health(): Promise<BuilderHealth | null> {
    if (!this.configured) return null;
    try {
      const res = await axios.get(`${this.config.builderUrl}/health`, { timeout: 5000 });
      return res.data as BuilderHealth;
    } catch {
      return null;
    }
  }

  private async send<T>(req: AxiosRequestConfig, timeoutMs = BuilderClient.timeoutMs): Promise<T> {
    if (!this.configured) {
      throw new BuilderError('The builder is not configured: BUILDER_URL and BUILDER_TOKEN are not set for the console API.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    let res;
    try {
      res = await axios.request<T>({
        ...req,
        baseURL: this.config.builderUrl,
        timeout: timeoutMs,
        maxBodyLength: 4 * 1024 * 1024,
        headers: { 'x-builder-token': this.config.builderToken, 'content-type': 'application/json' },
        validateStatus: () => true,
      });
    } catch (e) {
      throw new BuilderError(`The builder is not answering (${(e as Error).message}). Check it with: docker compose ps builder`, HttpStatus.BAD_GATEWAY);
    }
    if (res.status >= 200 && res.status < 300) return res.data;
    const message = (res.data as { message?: string } | null)?.message ?? `status ${res.status}`;
    if (res.status === 401) {
      throw new BuilderError('The builder refused the console: BUILDER_TOKEN differs between them.', HttpStatus.BAD_GATEWAY);
    }
    // The builder's own sentence is the answer; its 5xx are upstream failures to the browser.
    throw new BuilderError(message, res.status >= 500 ? HttpStatus.BAD_GATEWAY : res.status);
  }
}
