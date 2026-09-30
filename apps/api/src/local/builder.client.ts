import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';

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

export type LocalStatus = 'queued' | 'in_progress' | 'completed';
export type LocalConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;

/** Shapes the builder writes (apps/builder/src/types.ts): GitHub-style jobs and steps. */
export interface LocalStep {
  name: string;
  number: number;
  status: LocalStatus;
  conclusion: LocalConclusion;
  started_at: string | null;
  completed_at: string | null;
}

export interface LocalJob {
  id: number;
  name: string;
  status: LocalStatus;
  conclusion: LocalConclusion;
  started_at: string | null;
  completed_at: string | null;
  steps: LocalStep[];
}

export interface LocalParams {
  mode: 'build' | 'release';
  track: 'internal' | 'alpha' | 'beta' | 'production';
  releaseNotes: string;
  releaseStatus: 'completed' | 'draft';
  versionName: string;
  versionCode: number;
  rehearsal: boolean;
}

export interface LocalRun {
  id: number;
  status: LocalStatus;
  conclusion: LocalConclusion;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  source: {
    fileName: string;
    upload: string;
    sizeBytes: number;
    sha: string | null;
    root: string | null;
    uploadedBy: string;
    rerunOf: number | null;
  };
  params: LocalParams;
  plan: Record<string, unknown> | null;
  jobs: LocalJob[];
  error: string | null;
}

@Injectable()
export class BuilderClient {
  static timeoutMs = 15_000;

  constructor(@Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig) {}

  get configured(): boolean {
    return Boolean(this.config.builderUrl && this.config.builderToken);
  }

  list(): Promise<LocalRun[]> {
    return this.send<LocalRun[]>({ method: 'get', url: '/runs' });
  }

  get(id: number): Promise<LocalRun> {
    return this.send<LocalRun>({ method: 'get', url: `/runs/${id}` });
  }

  log(id: number, jobId: number): Promise<string> {
    return this.send<string>({ method: 'get', url: `/runs/${id}/logs/${jobId}`, responseType: 'text' });
  }

  create(body: { upload: string; fileName: string; sizeBytes: number; uploadedBy: string; params: LocalParams }): Promise<LocalRun> {
    return this.send<LocalRun>({ method: 'post', url: '/runs', data: body });
  }

  cancel(id: number): Promise<void> {
    return this.send<void>({ method: 'post', url: `/runs/${id}/cancel` });
  }

  rerun(id: number, versionCode: number): Promise<LocalRun> {
    return this.send<LocalRun>({ method: 'post', url: `/runs/${id}/rerun`, data: { versionCode } });
  }

  async health(): Promise<{ ok: boolean; busy: boolean; queued: number } | null> {
    if (!this.configured) return null;
    try {
      const res = await axios.get(`${this.config.builderUrl}/health`, { timeout: 5000 });
      return res.data as { ok: boolean; busy: boolean; queued: number };
    } catch {
      return null;
    }
  }

  private async send<T>(req: AxiosRequestConfig): Promise<T> {
    if (!this.configured) {
      throw new BuilderError(
        'Builds from uploaded ZIPs are off: BUILDER_URL and BUILDER_TOKEN are not set for the console API.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    let res;
    try {
      res = await axios.request<T>({
        ...req,
        baseURL: this.config.builderUrl,
        timeout: BuilderClient.timeoutMs,
        headers: { 'x-builder-token': this.config.builderToken, 'content-type': 'application/json' },
        validateStatus: () => true,
      });
    } catch (e) {
      throw new BuilderError(
        `The builder is not answering (${(e as Error).message}). Check it with: docker compose ps builder`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (res.status >= 200 && res.status < 300) return res.data;
    const message = (res.data as { message?: string } | null)?.message ?? `status ${res.status}`;
    if (res.status === 401) {
      throw new BuilderError('The builder refused the console: BUILDER_TOKEN differs between them.', HttpStatus.BAD_GATEWAY);
    }
    // 400, 404, 409, 410: the builder's own sentence is the answer.
    throw new BuilderError(message, res.status >= 500 ? HttpStatus.BAD_GATEWAY : res.status);
  }
}
