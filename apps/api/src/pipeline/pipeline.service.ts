import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';
import { GithubClient, GithubError, RateLimit } from '../github/github.client';
import type {
  GhArtifact,
  GhArtifactList,
  GhBranch,
  GhCommit,
  GhJob,
  GhJobList,
  GhRepo,
  GhRunList,
  GhTag,
  GhWorkflowRun,
} from '../github/github.types';
import {
  ARTIFACTS,
  BuildInfo,
  PipelinePlan,
  PlayStatus,
  ReleaseInfo,
  TestSummary,
  errorLines,
  parseFlutterTestReport,
  readJson,
  unzip,
} from './artifacts';
import { MAX_RELEASE_NOTES, StartRunDto } from './pipeline.dto';
import {
  STAGES,
  StageKey,
  StageState,
  StageView,
  StepView,
  describeRun,
  mapStages,
  parseReleaseSubject,
  RunIntent,
  RunState,
  runState,
  ReleaseMarker,
} from './stages';

export interface RunSummary extends RunIntent {
  id: number;
  number: number;
  attempt: number;
  title: string;
  event: string;
  branch: string | null;
  sha: string;
  state: RunState;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  url: string;
  actor: { login: string; avatarUrl: string | null } | null;
  stages: Array<{ key: StageKey; state: StageState }>;
}

export interface StreamCommit {
  sha: string;
  subject: string;
  body: string;
  author: { name: string; login: string | null; avatarUrl: string | null };
  date: string;
  url: string;
  tags: string[];
  release: ReleaseMarker | null;
  runs: RunSummary[];
}

export interface StreamResponse {
  repo: { fullName: string; url: string; defaultBranch: string; private: boolean };
  branch: string;
  workflow: { present: boolean; file: string };
  commits: StreamCommit[];
  /** Runs of this workflow whose commit is not in this page: other branches, older commits. */
  otherRuns: RunSummary[];
  rate: RateLimit | null;
  refreshedAt: string;
}

export interface JobView {
  id: number;
  name: string;
  state: StageState;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
  steps: StepView[];
}

export interface RunFailure {
  stage: StageKey | null;
  jobId: number;
  jobName: string;
  step: string | null;
  messages: string[];
}

export interface RunDetail {
  run: RunSummary;
  commit: { sha: string; subject: string; body: string; author: string | null; date: string | null };
  plan: PipelinePlan | null;
  stages: StageView[];
  jobs: JobView[];
  artifacts: Array<{ id: number; name: string; sizeBytes: number; expired: boolean }>;
  tests: TestSummary | null;
  build: BuildInfo | null;
  release: ReleaseInfo | null;
  playStatus: PlayStatus | null;
  failure: RunFailure | null;
  rate: RateLimit | null;
}

export type LogResponse =
  | { available: true; text: string }
  | { available: false; reason: string; liveUrl: string };

const COMMITS_PER_PAGE = 30;
const JOB_FETCH_CONCURRENCY = 6;

/**
 * Starts, reads and steers runs of the pipeline workflow. Holds no state of its own beyond
 * caches of things GitHub will never change again: the jobs of a finished run attempt, the
 * contents of an artifact, the log of a finished job.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  private readonly finishedJobs = new Map<string, GhJob[]>();
  private readonly artifactFiles = new Map<number, Map<string, Buffer>>();
  private readonly finishedLogs = new Map<number, string>();

  constructor(
    private readonly gh: GithubClient,
    @Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig,
  ) {}

  private workflowPath(suffix = ''): string {
    return this.gh.repoPath(`/actions/workflows/${encodeURIComponent(this.config.workflowFile)}${suffix}`);
  }

  async repo(): Promise<GhRepo> {
    return this.gh.get<GhRepo>(this.gh.repoPath());
  }

  async branches(): Promise<{ defaultBranch: string; branches: string[] }> {
    const [repo, list] = await Promise.all([
      this.repo(),
      this.gh.get<GhBranch[]>(this.gh.repoPath('/branches'), { per_page: 100 }),
    ]);
    const names = list.map((b) => b.name).filter((n) => n !== repo.default_branch);
    return { defaultBranch: repo.default_branch, branches: [repo.default_branch, ...names.sort()] };
  }

  /** Recent runs of the pipeline workflow; null when the workflow is not on the default branch. */
  async listRuns(params: Record<string, string | number> = {}): Promise<GhWorkflowRun[] | null> {
    const res = await this.gh.getOrNotFound<GhRunList>(this.workflowPath('/runs'), { per_page: 100, ...params });
    if ('notFound' in res) return null;
    // Pushes to main that are not release commits end as skipped runs that did nothing.
    return res.workflow_runs.filter((r) => !(r.status === 'completed' && r.conclusion === 'skipped'));
  }

  async stream(branch?: string): Promise<StreamResponse> {
    const repo = await this.repo();
    const ref = branch || repo.default_branch;
    const [commits, runs, tags] = await Promise.all([
      this.gh
        .get<GhCommit[]>(this.gh.repoPath('/commits'), { sha: ref, per_page: COMMITS_PER_PAGE })
        .catch((e: unknown) => {
          if (e instanceof GithubError && e.upstreamStatus === 404) {
            throw new NotFoundException(`${this.gh.repo} has no branch '${ref}'.`);
          }
          throw e;
        }),
      this.listRuns(),
      this.gh.get<GhTag[]>(this.gh.repoPath('/tags'), { per_page: 100 }),
    ]);

    const shas = new Set(commits.map((c) => c.sha));
    const visible = (runs ?? []).filter((r) => shas.has(r.head_sha));
    const others = (runs ?? []).filter((r) => !shas.has(r.head_sha)).slice(0, 12);
    const summaries = await this.summarize([...visible, ...others]);
    const byId = new Map(summaries.map((s) => [s.id, s]));

    const tagsBySha = new Map<string, string[]>();
    for (const t of tags) tagsBySha.set(t.commit.sha, [...(tagsBySha.get(t.commit.sha) ?? []), t.name]);

    const runsBySha = new Map<string, RunSummary[]>();
    for (const r of visible) {
      const s = byId.get(r.id);
      if (s) runsBySha.set(r.head_sha, [...(runsBySha.get(r.head_sha) ?? []), s]);
    }

    return {
      repo: {
        fullName: repo.full_name,
        url: repo.html_url,
        defaultBranch: repo.default_branch,
        private: repo.private,
      },
      branch: ref,
      workflow: { present: runs !== null, file: this.config.workflowFile },
      commits: commits.map((c) => {
        const [subject = '', ...rest] = c.commit.message.split('\n');
        return {
          sha: c.sha,
          subject,
          body: rest.join('\n').trim(),
          author: {
            name: c.commit.author?.name ?? c.author?.login ?? 'unknown',
            login: c.author?.login ?? null,
            avatarUrl: c.author?.avatar_url ?? null,
          },
          date: c.commit.author?.date ?? c.commit.committer?.date ?? '',
          url: c.html_url,
          tags: tagsBySha.get(c.sha) ?? [],
          release: parseReleaseSubject(subject),
          // Newest run first: the ring on the rail shows the latest verdict.
          runs: (runsBySha.get(c.sha) ?? []).sort((a, b) => b.id - a.id),
        };
      }),
      otherRuns: others.map((r) => byId.get(r.id)).filter((s): s is RunSummary => Boolean(s)),
      rate: this.gh.rateLimit,
      refreshedAt: new Date().toISOString(),
    };
  }

  async run(id: number): Promise<RunDetail> {
    const run = await this.gh.get<GhWorkflowRun>(this.gh.repoPath(`/actions/runs/${id}`));
    this.assertPipelineRun(run);
    const [jobs, artifactList] = await Promise.all([
      this.jobs(run),
      this.gh.get<GhArtifactList>(this.gh.repoPath(`/actions/runs/${id}/artifacts`), { per_page: 100 }),
    ]);
    const artifacts = artifactList.artifacts;
    const stages = mapStages(jobs, run);
    const [plan, tests, build, release, playStatus] = await Promise.all([
      this.artifactJson<PipelinePlan>(artifacts, ARTIFACTS.plan, 'plan.json'),
      this.testSummary(artifacts),
      this.artifactJson<BuildInfo>(artifacts, ARTIFACTS.buildInfo, 'build-info.json'),
      this.artifactJson<ReleaseInfo>(artifacts, ARTIFACTS.release, 'release-info.json'),
      this.artifactJson<PlayStatus>(artifacts, ARTIFACTS.playStatus, 'play-status.json'),
    ]);
    const [subject = '', ...body] = (run.head_commit?.message ?? '').split('\n');

    return {
      run: this.toSummary(run, jobs),
      commit: {
        sha: run.head_sha,
        subject,
        body: body.join('\n').trim(),
        author: run.head_commit?.author?.name ?? null,
        date: run.head_commit?.timestamp ?? null,
      },
      plan,
      stages,
      jobs: jobs.map((j) => this.toJobView(j, stages)),
      artifacts: artifacts.map((a) => ({ id: a.id, name: a.name, sizeBytes: a.size_in_bytes, expired: a.expired })),
      tests,
      build,
      release,
      playStatus,
      failure: await this.failure(stages, jobs),
      rate: this.gh.rateLimit,
    };
  }

  async log(runId: number, jobId: number): Promise<LogResponse> {
    const job = await this.gh.get<GhJob>(this.gh.repoPath(`/actions/jobs/${jobId}`));
    if (job.run_id !== runId) throw new NotFoundException('That job is not part of this run.');
    if (job.status !== 'completed') {
      return {
        available: false,
        reason: 'GitHub publishes the full log when the job finishes. The steps above update live.',
        liveUrl: job.html_url,
      };
    }
    return { available: true, text: await this.jobLog(jobId) };
  }

  /** The signed AAB (or its R8 mapping) out of the run's artifact, ready to save. */
  async bundle(runId: number, file: 'aab' | 'mapping'): Promise<{ name: string; data: Buffer }> {
    const artifacts = (
      await this.gh.get<GhArtifactList>(this.gh.repoPath(`/actions/runs/${runId}/artifacts`), { per_page: 100 })
    ).artifacts;
    const artifact = artifacts.find((a) => a.name === ARTIFACTS.aab);
    if (!artifact) throw new NotFoundException('This run has no signed AAB: it did not reach the build stage, or failed there.');
    if (artifact.expired) throw new NotFoundException('GitHub has deleted this AAB: artifacts expire after 30 days.');
    const files = await this.artifactFilesFor(artifact);
    const info = await this.artifactJson<BuildInfo>(artifacts, ARTIFACTS.buildInfo, 'build-info.json');
    const stem = info ? `fusionhrm-${info.versionName}-${info.versionCode}` : `fusionhrm-run-${runId}`;
    for (const [name, data] of files) {
      if (file === 'aab' && name.endsWith('.aab')) return { name: `${stem}.aab`, data };
      if (file === 'mapping' && name.endsWith('mapping.txt')) return { name: `${stem}-mapping.txt`, data };
    }
    throw new NotFoundException(file === 'aab' ? 'The artifact holds no .aab file.' : 'The artifact holds no R8 mapping.');
  }

  async start(dto: StartRunDto): Promise<{ runId: number | null; requestId: string; url: string | null }> {
    const track = dto.track ?? 'internal';
    const notes = dto.releaseNotes ?? '';
    if (dto.mode === 'release' && !notes) {
      throw new BadRequestException('Release notes are required: they are the "What\'s new" text on Google Play.');
    }
    if (notes.length > MAX_RELEASE_NOTES) {
      throw new BadRequestException(`Release notes must be at most ${MAX_RELEASE_NOTES} characters.`);
    }
    const requestId = randomBytes(3).toString('hex');
    const inputs = {
      mode: dto.mode,
      track,
      release_notes: dto.mode === 'release' ? notes : '',
      release_status: dto.releaseStatus ?? 'completed',
      version_name: dto.versionName ?? '',
      integration_tests: dto.integrationTests ? 'true' : 'false',
      rehearsal: dto.mode === 'release' && dto.rehearsal ? 'true' : 'false',
      request_id: requestId,
    };

    let res: { status: number; data: { workflow_run_id?: number; html_url?: string } | '' };
    try {
      res = await this.gh.post(this.workflowPath('/dispatches'), {
        ref: dto.branch,
        inputs,
        return_run_details: true,
      });
    } catch (e) {
      if (e instanceof GithubError && e.upstreamStatus === 404) {
        throw new NotFoundException(
          `${this.config.workflowFile} is not on the default branch of ${this.gh.repo}, so GitHub cannot run it. ` +
            'Push the pipeline commit first (see Setup).',
        );
      }
      if (e instanceof GithubError && e.upstreamStatus === 422) {
        throw new BadRequestException(
          `${e.message} If the branch was cut before the pipeline landed, merge main into '${dto.branch}' first.`,
        );
      }
      throw e;
    }

    const body = typeof res.data === 'object' && res.data ? res.data : {};
    let runId = body.workflow_run_id ?? null;
    let url = body.html_url ?? null;
    if (!runId) {
      // Older API behaviour: 204 without the run. Find it by the request id in its title.
      const found = await this.findDispatchedRun(requestId);
      runId = found?.id ?? null;
      url = found?.html_url ?? null;
    }
    this.logger.log(
      `Started ${dto.mode} on ${dto.branch}${dto.mode === 'release' ? ` → ${track}` : ''}: run ${runId ?? '(not listed yet)'} [${requestId}]`,
    );
    return { runId, requestId, url };
  }

  async cancel(id: number): Promise<void> {
    await this.act(id, 'cancel', 'The run has already finished; there is nothing to cancel.');
  }

  async rerunFailed(id: number): Promise<void> {
    await this.act(id, 'rerun-failed-jobs', 'Only a finished run with failed jobs can re-run them.');
  }

  async rerun(id: number): Promise<void> {
    await this.act(id, 'rerun', 'Only a finished run can be re-run.');
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────

  private async act(id: number, action: string, conflict: string): Promise<void> {
    const run = await this.gh.get<GhWorkflowRun>(this.gh.repoPath(`/actions/runs/${id}`));
    this.assertPipelineRun(run);
    try {
      await this.gh.post(this.gh.repoPath(`/actions/runs/${id}/${action}`));
    } catch (e) {
      if (e instanceof GithubError && (e.upstreamStatus === 409 || e.upstreamStatus === 403)) {
        throw new ConflictException(conflict);
      }
      throw e;
    }
  }

  /** Refuses run ids that belong to some other workflow of the repository. */
  private assertPipelineRun(run: GhWorkflowRun): void {
    // `path` may carry a ref suffix (`…/release.yml@refs/heads/main`).
    const file = run.path?.split('@')[0];
    if (file && file !== `.github/workflows/${this.config.workflowFile}`) {
      throw new NotFoundException('That run belongs to another workflow.');
    }
  }

  private async findDispatchedRun(requestId: string): Promise<GhWorkflowRun | null> {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const runs = await this.listRuns({ event: 'workflow_dispatch', per_page: 20 });
      const hit = runs?.find((r) => (r.display_title ?? '').endsWith(` · ${requestId}`));
      if (hit) return hit;
    }
    return null;
  }

  private async jobs(run: GhWorkflowRun): Promise<GhJob[]> {
    const key = `${run.id}:${run.run_attempt ?? 1}`;
    const cached = this.finishedJobs.get(key);
    if (cached) return cached;
    const res = await this.gh.get<GhJobList>(this.gh.repoPath(`/actions/runs/${run.id}/jobs`), {
      per_page: 100,
      filter: 'latest',
    });
    if (run.status === 'completed' && res.jobs.every((j) => j.status === 'completed')) {
      this.finishedJobs.set(key, res.jobs);
      if (this.finishedJobs.size > 500) this.finishedJobs.delete(this.finishedJobs.keys().next().value as string);
    }
    return res.jobs;
  }

  private async summarize(runs: GhWorkflowRun[]): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (let i = 0; i < runs.length; i += JOB_FETCH_CONCURRENCY) {
      const batch = runs.slice(i, i + JOB_FETCH_CONCURRENCY);
      const jobs = await Promise.all(
        batch.map((r) =>
          this.jobs(r).catch((e: unknown) => {
            // A ring with unknown stages is better than no stream at all.
            this.logger.warn(`jobs for run ${r.id}: ${(e as Error).message}`);
            return [] as GhJob[];
          }),
        ),
      );
      batch.forEach((r, k) => out.push(this.toSummary(r, jobs[k])));
    }
    return out;
  }

  private toSummary(run: GhWorkflowRun, jobs: GhJob[]): RunSummary {
    const actor = run.triggering_actor ?? run.actor;
    return {
      ...describeRun(run),
      id: run.id,
      number: run.run_number,
      attempt: run.run_attempt ?? 1,
      title: run.display_title ?? run.name ?? `Run ${run.run_number}`,
      event: run.event,
      branch: run.head_branch,
      sha: run.head_sha,
      state: runState(run),
      createdAt: run.created_at,
      startedAt: run.run_started_at ?? null,
      updatedAt: run.updated_at,
      url: run.html_url,
      actor: actor ? { login: actor.login, avatarUrl: actor.avatar_url ?? null } : null,
      stages: mapStages(jobs, run).map((s) => ({ key: s.key, state: s.state })),
    };
  }

  private toJobView(job: GhJob, stages: StageView[]): JobView {
    const steps = stages.flatMap((s) => s.steps).filter((s) => s.jobId === job.id).sort((a, b) => a.number - b.number);
    const state: StageState =
      job.status === 'completed'
        ? job.conclusion === 'success'
          ? 'success'
          : job.conclusion === 'skipped'
            ? 'skipped'
            : job.conclusion === 'cancelled'
              ? 'cancelled'
              : 'failed'
        : job.status === 'in_progress'
          ? 'running'
          : 'queued';
    return {
      id: job.id,
      name: job.name,
      state,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      url: job.html_url,
      steps,
    };
  }

  /** The first failed step, with whatever the log said about it. */
  private async failure(stages: StageView[], jobs: GhJob[]): Promise<RunFailure | null> {
    const failedJob = jobs.find((j) => j.status === 'completed' && (j.conclusion === 'failure' || j.conclusion === 'timed_out' || j.conclusion === 'startup_failure'));
    if (!failedJob) return null;
    const stage = stages.find((s) => s.state === 'failed' && s.jobIds.includes(failedJob.id)) ?? null;
    const step = stage?.steps.find((s) => s.jobId === failedJob.id && s.state === 'failed') ?? null;
    let messages: string[] = [];
    try {
      messages = errorLines(await this.jobLog(failedJob.id));
    } catch (e) {
      this.logger.warn(`log for failed job ${failedJob.id}: ${(e as Error).message}`);
    }
    return { stage: stage?.key ?? null, jobId: failedJob.id, jobName: failedJob.name, step: step?.name ?? null, messages };
  }

  private async jobLog(jobId: number): Promise<string> {
    const cached = this.finishedLogs.get(jobId);
    if (cached !== undefined) return cached;
    const text = (await this.gh.download(this.gh.repoPath(`/actions/jobs/${jobId}/logs`))).toString('utf8');
    this.finishedLogs.set(jobId, text);
    // Logs run to megabytes; keep the recent few.
    if (this.finishedLogs.size > 40) this.finishedLogs.delete(this.finishedLogs.keys().next().value as number);
    return text;
  }

  private async artifactFilesFor(artifact: GhArtifact): Promise<Map<string, Buffer>> {
    const cached = this.artifactFiles.get(artifact.id);
    if (cached) return cached;
    const zip = await this.gh.download(this.gh.repoPath(`/actions/artifacts/${artifact.id}/zip`));
    const files = unzip(zip);
    // Artifacts never change once uploaded; the big AAB is not kept, the small reports are.
    if (artifact.size_in_bytes < 5 * 1024 * 1024) {
      this.artifactFiles.set(artifact.id, files);
      if (this.artifactFiles.size > 300) this.artifactFiles.delete(this.artifactFiles.keys().next().value as number);
    }
    return files;
  }

  private async artifactJson<T>(artifacts: GhArtifact[], name: string, file: string): Promise<T | null> {
    const artifact = artifacts.find((a) => a.name === name && !a.expired);
    if (!artifact) return null;
    try {
      return readJson<T>(await this.artifactFilesFor(artifact), file);
    } catch (e) {
      this.logger.warn(`artifact ${name}: ${(e as Error).message}`);
      return null;
    }
  }

  private async testSummary(artifacts: GhArtifact[]): Promise<TestSummary | null> {
    const artifact = artifacts.find((a) => a.name === ARTIFACTS.tests && !a.expired);
    if (!artifact) return null;
    try {
      const files = await this.artifactFilesFor(artifact);
      const report = [...files.entries()].find(([n]) => n.endsWith('.json'))?.[1];
      return report ? parseFlutterTestReport(report.toString('utf8')) : null;
    } catch (e) {
      this.logger.warn(`test results: ${(e as Error).message}`);
      return null;
    }
  }
}

/** Exported for the stage legend the UI shows. */
export const STAGE_LABELS = STAGES;
