import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';
import { GithubClient } from '../github/github.client';
import type { GhJob } from '../github/github.types';
import {
  ARTIFACTS,
  BuildInfo,
  PipelinePlan,
  ReleaseInfo,
  TestSummary,
  errorLines,
  parseFlutterTestReport,
} from '../pipeline/artifacts';
import type { RunDetail, RunFailure, RunSummary } from '../pipeline/pipeline.service';
import { jobView, mapStages, runState } from '../pipeline/stages';
import { BuilderClient, LocalParams, LocalRun } from './builder.client';
import { UploadRunDto } from './upload.dto';
import { VersionCodes } from './version-codes';

/** An uploaded ZIP as multer stored it under uploads/. */
export interface StoredUpload {
  filename: string;
  originalname: string;
  size: number;
  path: string;
}

/**
 * Runs of uploaded source ZIPs on this server's builder, presented exactly like GitHub runs so
 * every screen, stage ring and log view works on both. Their ids are negative (-n for the
 * builder's run n): one number space for every run the console shows.
 */
@Injectable()
export class LocalRunsService {
  private readonly logger = new Logger(LocalRunsService.name);
  private readonly subjects = new Map<string, string>();

  constructor(
    private readonly builder: BuilderClient,
    private readonly versions: VersionCodes,
    private readonly gh: GithubClient,
    @Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig,
  ) {}

  get enabled(): boolean {
    return this.builder.configured;
  }

  async list(): Promise<RunSummary[]> {
    if (!this.enabled) return [];
    return (await this.builder.list()).map((r) => this.toSummary(r));
  }

  /** Every version code a run on this server has used, so none is handed out twice. */
  async knownCodes(): Promise<number[]> {
    if (!this.enabled) return [];
    try {
      return (await this.builder.list()).map((r) => r.params.versionCode);
    } catch {
      return [];
    }
  }

  async start(file: StoredUpload, dto: UploadRunDto): Promise<{ runId: number; requestId: string; url: null }> {
    const notes = dto.releaseNotes ?? '';
    if (dto.mode === 'release' && !notes) {
      await fs.rm(file.path, { force: true });
      throw new BadRequestException('Release notes are required: they are the "What\'s new" text on Google Play.');
    }
    const params: LocalParams = {
      mode: dto.mode,
      track: dto.track ?? 'internal',
      releaseNotes: dto.mode === 'release' ? notes : '',
      releaseStatus: dto.releaseStatus ?? 'completed',
      versionName: dto.versionName ?? '',
      versionCode: await this.versions.next(await this.knownCodes()),
      rehearsal: dto.mode === 'release' && dto.rehearsal === true,
    };
    const run = await this.builder
      .create({ upload: file.filename, fileName: file.originalname, sizeBytes: file.size, uploadedBy: 'console', params })
      .catch(async (e: unknown) => {
        await fs.rm(file.path, { force: true });
        throw e;
      });
    this.logger.log(`Started run #${run.id} on the builder from ${file.originalname} (${params.mode}, versionCode ${params.versionCode})`);
    return { runId: -run.id, requestId: '', url: null };
  }

  async detail(id: number): Promise<RunDetail> {
    const r = await this.builder.get(id);
    const jobs = this.jobs(r);
    const stages = mapStages(jobs, r);
    const art = (p: string) => join(this.runDir(id), 'artifacts', p);
    const [plan, build, release, tests, artifacts] = await Promise.all([
      this.json<PipelinePlan>(art(`${ARTIFACTS.plan}/plan.json`)),
      this.json<BuildInfo>(art(`${ARTIFACTS.buildInfo}/build-info.json`)),
      this.json<ReleaseInfo>(art(`${ARTIFACTS.release}/release-info.json`)),
      this.tests(art(`${ARTIFACTS.tests}/flutter-test.json`)),
      this.artifacts(id),
    ]);
    return {
      run: this.toSummary(r),
      commit: {
        sha: r.source.sha ?? '',
        subject: (await this.subject(r.source.sha)) ?? `Uploaded ${r.source.fileName}`,
        body: '',
        author: r.source.uploadedBy,
        date: r.createdAt,
      },
      plan: plan ?? (r.plan as PipelinePlan | null),
      stages,
      jobs: jobs.map((j) => jobView(j, stages)),
      artifacts,
      tests,
      build,
      release,
      playStatus: null,
      failure: await this.failure(r, jobs, stages),
      rate: null,
    };
  }

  /** A local job's log is readable while it runs: the builder writes it line by line. */
  async log(id: number, jobId: number): Promise<{ available: true; text: string }> {
    return { available: true, text: await this.builder.log(id, jobId) };
  }

  async bundle(id: number, file: 'aab' | 'mapping'): Promise<{ name: string; path: string; size: number }> {
    const dir = join(this.runDir(id), 'artifacts', ARTIFACTS.aab);
    const path = file === 'aab' ? join(dir, 'bundle/release/app-release.aab') : join(dir, 'mapping/release/mapping.txt');
    const stat = await fs.stat(path).catch(() => null);
    if (!stat) {
      throw new NotFoundException(
        file === 'aab' ? 'This run has no signed AAB: it did not reach the build stage, or failed there.' : 'This run has no R8 mapping.',
      );
    }
    const info = await this.json<BuildInfo>(join(this.runDir(id), 'artifacts', ARTIFACTS.buildInfo, 'build-info.json'));
    const stem = info ? `fusionhrm-${info.versionName}-${info.versionCode}` : `fusionhrm-upload-${id}`;
    return { name: file === 'aab' ? `${stem}.aab` : `${stem}-mapping.txt`, path, size: stat.size };
  }

  async cancel(id: number): Promise<void> {
    await this.builder.cancel(id);
  }

  /** Same ZIP, same settings, a fresh version code. */
  async rerun(id: number): Promise<{ runId: number }> {
    const run = await this.builder.rerun(id, await this.versions.next(await this.knownCodes()));
    return { runId: -run.id };
  }

  toSummary(r: LocalRun): RunSummary {
    const stages = mapStages(this.jobs(r), r);
    return {
      trigger: 'upload',
      mode: r.params.mode,
      track: r.params.mode === 'release' ? r.params.track : null,
      tag: null,
      requestId: null,
      rehearsal: r.params.rehearsal,
      id: -r.id,
      number: r.id,
      attempt: 1,
      title: `Upload ${r.source.fileName}`,
      event: 'upload',
      branch: r.source.root || null,
      sha: r.source.sha ?? '',
      state: runState(r),
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      url: '',
      actor: { login: r.source.uploadedBy, avatarUrl: null },
      stages: stages.map((s) => ({ key: s.key, state: s.state })),
    };
  }

  private jobs(r: LocalRun): GhJob[] {
    return r.jobs.map((j) => ({ ...j, run_id: r.id, html_url: '' }));
  }

  private runDir(id: number): string {
    return join(this.config.buildsDir, 'runs', String(id));
  }

  private async json<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(path, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async tests(path: string): Promise<TestSummary | null> {
    try {
      return parseFlutterTestReport(await fs.readFile(path, 'utf8'));
    } catch {
      return null;
    }
  }

  private async artifacts(id: number): Promise<RunDetail['artifacts']> {
    const dir = join(this.runDir(id), 'artifacts');
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const out: RunDetail['artifacts'] = [];
    for (const [i, name] of names.sort().entries()) out.push({ id: i + 1, name, sizeBytes: await this.size(join(dir, name)), expired: false });
    return out;
  }

  private async size(path: string): Promise<number> {
    const st = await fs.stat(path);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of await fs.readdir(path)) total += await this.size(join(path, e));
    return total;
  }

  private async failure(r: LocalRun, jobs: GhJob[], stages: ReturnType<typeof mapStages>): Promise<RunFailure | null> {
    const failed = jobs.find((j) => j.conclusion === 'failure');
    if (!failed) {
      return r.error ? { stage: null, jobId: 0, jobName: 'Builder', step: null, messages: [r.error] } : null;
    }
    const stage = stages.find((s) => s.state === 'failed' && s.jobIds.includes(failed.id)) ?? null;
    const step = stage?.steps.find((s) => s.jobId === failed.id && s.state === 'failed') ?? null;
    let messages: string[] = r.error ? [r.error] : [];
    try {
      messages = [...messages, ...errorLines(await this.builder.log(r.id, failed.id))];
    } catch (e) {
      this.logger.warn(`log for local run ${r.id}: ${(e as Error).message}`);
    }
    return { stage: stage?.key ?? null, jobId: failed.id, jobName: failed.name, step: step?.name ?? null, messages };
  }

  /** The commit's subject from GitHub, when there is a token and the ZIP named its commit. */
  private async subject(sha: string | null): Promise<string | null> {
    if (!sha || !this.gh.configured) return null;
    const cached = this.subjects.get(sha);
    if (cached) return cached;
    try {
      const c = await this.gh.get<{ commit: { message: string } }>(this.gh.repoPath(`/commits/${sha}`));
      const subject = c.commit.message.split('\n')[0];
      this.subjects.set(sha, subject);
      return subject;
    } catch {
      return null;
    }
  }
}
