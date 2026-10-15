import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { BuilderClient } from '../builder/builder.client';
import type { AppView, BuilderRun, CommitEntry, IosTrack, Platform, RunnerKind } from '../builder/builder.types';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';
import { ARTIFACTS, BuildInfo, errorLines, parseFlutterTestReport, PipelinePlan, ReleaseInfo, TestSummary } from './artifacts';
import { JobView, jobView, mapStages, PlayTrack, RunState, runState, StageKey, StageState, StageView } from './stages';

export interface RunSummary {
  id: number;
  /** The run's number within its app (#12). */
  number: number;
  app: { id: string; name: string; packageName: string; bundleId: string | null } | null;
  /** android, or ios (built and released on a Mac runner). */
  platform: Platform;
  mode: 'build' | 'release';
  track: PlayTrack | IosTrack | null;
  /** A release Google validates without publishing. */
  rehearsal: boolean;
  /** This server's builder, or the app's GitHub Actions. */
  runner: RunnerKind;
  /** Where to open the run on GitHub, once it has dispatched; null for a server run. */
  remoteUrl: string | null;
  /** An iOS run: the Mac that has it, and whether it still waits for one. */
  mac: { runner: string | null; waiting: boolean } | null;
  source: {
    kind: 'git' | 'zip';
    branch: string | null;
    fileName: string | null;
    sha: string | null;
    subject: string | null;
    author: string | null;
  };
  state: RunState;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  startedBy: string;
  rerunOf: number | null;
  versionName: string | null;
  versionCode: number | null;
  stages: Array<{ key: StageKey; state: StageState }>;
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
  commit: { sha: string; subject: string; author: string | null; date: string | null; url: string | null };
  plan: PipelinePlan | null;
  stages: StageView[];
  jobs: JobView[];
  artifacts: Array<{ id: number; name: string; sizeBytes: number }>;
  tests: TestSummary | null;
  build: BuildInfo | null;
  release: ReleaseInfo | null;
  failure: RunFailure | null;
}

export interface StreamCommit {
  sha: string;
  subject: string;
  body: string;
  author: { name: string; email: string };
  date: string;
  url: string | null;
  tags: string[];
  runs: RunSummary[];
}

export interface StreamResponse {
  app: AppView;
  branch: string | null;
  branches: string[];
  defaultBranch: string | null;
  commits: StreamCommit[];
  /** Runs of this app whose commit is not on this page: other branches, older commits, ZIPs without a commit. */
  otherRuns: RunSummary[];
  fetchedAt: string | null;
  fetching: boolean;
  error: string | null;
  connected: boolean;
}

export interface AppOverview extends AppView {
  latestRun: RunSummary | null;
  activeRun: RunSummary | null;
  runCount: number;
}

/** An iOS release's report (written by the Fastfile's ios deploy lane) read like Google Play's. */
function storeRelease(rel: ReleaseInfo): ReleaseInfo {
  return {
    ...rel,
    packageName: rel.packageName ?? rel.bundleId ?? '',
    track: rel.track ?? rel.destination ?? 'testflight',
    previousHighestVersionCode: rel.previousHighestVersionCode ?? rel.previousHighestBuild ?? null,
    storeUrl: rel.storeUrl ?? rel.appStoreConnectUrl ?? 'https://appstoreconnect.apple.com/apps',
    uploadedAt: rel.uploadedAt ?? '',
  };
}

const KNOWN_HOSTS: Record<string, (path: string, sha: string) => string> = {
  'github.com': (p, sha) => `https://github.com/${p}/commit/${sha}`,
  'gitlab.com': (p, sha) => `https://gitlab.com/${p}/-/commit/${sha}`,
  'bitbucket.org': (p, sha) => `https://bitbucket.org/${p}/commits/${sha}`,
};

/** Where a commit of an SSH repository opens in the browser, on the hosts whose URLs are known. */
export function commitWebUrl(sshUrl: string, sha: string): string | null {
  const m = /^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(sshUrl);
  if (!m || /^ssh:\/\/[^@]+@[^/]+:\d+\//.test(sshUrl)) return null;
  const link = KNOWN_HOSTS[m[1].toLowerCase()];
  return link ? link(m[2].replace(/^\/+/, ''), sha) : null;
}

/**
 * Runs as the console shows them: every run is the builder's record of a real run, mapped onto
 * the six stages, with what its artifacts say (plan, tests, AAB, Play upload) read from the
 * shared volume.
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);
  /** Commits never change: subjects of runs that did not record theirs (uploaded ZIPs). */
  private readonly subjects = new Map<string, { subject: string; author: string; date: string } | null>();

  constructor(
    private readonly builder: BuilderClient,
    @Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig,
  ) {}

  async overview(): Promise<{ apps: AppOverview[]; recent: RunSummary[] }> {
    const [apps, runs] = await Promise.all([this.builder.apps(), this.builder.runs(undefined, 200)]);
    const summaries = runs.map((r) => this.toSummary(r));
    return {
      apps: apps.map((app) => {
        const mine = summaries.filter((r) => r.app?.id === app.id);
        return {
          ...app,
          latestRun: mine[0] ?? null,
          activeRun: mine.find((r) => r.state === 'running' || r.state === 'queued') ?? null,
          runCount: mine.length,
        };
      }),
      recent: summaries.slice(0, 12),
    };
  }

  async list(appId?: string): Promise<RunSummary[]> {
    return (await this.builder.runs(appId)).map((r) => this.toSummary(r));
  }

  /** An app's branch, commit by commit, each commit carrying its runs. */
  async stream(appId: string, branch?: string, refresh = false): Promise<StreamResponse> {
    const [app, commits, runs] = await Promise.all([
      this.builder.app(appId),
      this.builder.commits(appId, branch, refresh),
      this.builder.runs(appId),
    ]);
    const bySubject = new Map(commits.commits.map((c) => [c.sha, c]));
    const summaries = runs.map((r) => {
      const sum = this.toSummary(r);
      // A ZIP run knows its commit but not the commit's words; the stream does.
      const c = sum.source.sha ? bySubject.get(sum.source.sha) : undefined;
      if (c && !sum.source.subject) sum.source = { ...sum.source, subject: c.subject, author: c.author };
      return sum;
    });
    const shas = new Set(commits.commits.map((c) => c.sha));
    const bySha = new Map<string, RunSummary[]>();
    for (const r of summaries) if (r.source.sha && shas.has(r.source.sha)) bySha.set(r.source.sha, [...(bySha.get(r.source.sha) ?? []), r]);
    return {
      app,
      branch: commits.branch,
      branches: commits.branches,
      defaultBranch: commits.defaultBranch,
      commits: commits.commits.map((c: CommitEntry) => ({
        sha: c.sha,
        subject: c.subject,
        body: c.body,
        author: { name: c.author, email: c.email },
        date: c.date,
        url: c.url,
        tags: c.tags,
        // Newest first: the ring on the rail shows the latest verdict.
        runs: bySha.get(c.sha) ?? [],
      })),
      otherRuns: summaries.filter((r) => !r.source.sha || !shas.has(r.source.sha)).slice(0, 16),
      fetchedAt: commits.fetchedAt,
      fetching: commits.fetching,
      error: commits.error,
      connected: commits.connected,
    };
  }

  async detail(id: number): Promise<RunDetail> {
    const r = await this.builder.run(id);
    const jobs = r.jobs;
    const stages = mapStages(jobs, r);
    const art = (p: string) => join(this.runDir(id), 'artifacts', p);
    const ios = r.params.platform === 'ios';
    const [plan, build, release, tests, artifacts] = await Promise.all([
      this.json<PipelinePlan>(art(`${ARTIFACTS.plan}/plan.json`)),
      this.json<BuildInfo>(art(`${ARTIFACTS.buildInfo}/build-info.json`)),
      this.json<ReleaseInfo>(art(ios ? `${ARTIFACTS.storeRelease}/release-info.json` : `${ARTIFACTS.release}/release-info.json`)).then((rel) => (rel && ios ? storeRelease(rel) : rel)),
      this.tests(art(`${ARTIFACTS.tests}/flutter-test.json`)),
      this.artifacts(id),
    ]);
    const s = r.source;
    const known = s.commit ?? (s.sha && r.app ? await this.lookup(r.app.id, s.sha) : null);
    const run = this.toSummary(r);
    if (known && !run.source.subject) run.source = { ...run.source, subject: known.subject, author: known.author };
    return {
      run,
      commit: {
        sha: s.sha ?? '',
        subject: known?.subject ?? (s.kind === 'zip' ? `Uploaded ${s.fileName}` : `${s.branch} (not checked out yet)`),
        author: known?.author ?? null,
        date: known?.date ?? null,
        url: s.kind === 'git' && s.sha ? commitWebUrl(s.url, s.sha) : null,
      },
      plan: plan ?? (r.plan as PipelinePlan | null),
      stages,
      jobs: jobs.map((j) => jobView(j, stages)),
      artifacts,
      tests,
      build,
      release,
      failure: await this.failure(r, stages),
    };
  }

  /** A job's log is readable while it runs: the builder writes it line by line. */
  async log(id: number, jobId: number): Promise<{ available: true; text: string }> {
    return { available: true, text: await this.builder.log(id, jobId) };
  }

  /** An iOS run's IPA, or its dSYMs (crash symbols), as the Mac sent them. */
  async ipa(id: number, file: 'ipa' | 'dsym'): Promise<{ name: string; path: string; size: number }> {
    const dir = join(this.runDir(id), 'artifacts', ARTIFACTS.ipa);
    const path = join(dir, file === 'ipa' ? 'app-release.ipa' : 'dSYMs.zip');
    const stat = await fs.stat(path).catch(() => null);
    if (!stat) {
      throw new NotFoundException(file === 'ipa' ? 'This run has no IPA: it did not reach the build stage on the Mac, or failed there.' : 'This run has no dSYMs.');
    }
    const [info, run] = await Promise.all([this.json<BuildInfo>(join(this.runDir(id), 'artifacts', ARTIFACTS.buildInfo, 'build-info.json')), this.builder.run(id)]);
    const app = (run.app?.id ?? 'app').replace(/[^a-z0-9-]/g, '');
    const stem = info ? `${app}-${info.versionName}-${info.versionCode}` : `${app}-run-${run.number}`;
    return { name: file === 'ipa' ? `${stem}.ipa` : `${stem}-dSYMs.zip`, path, size: stat.size };
  }

  async bundle(id: number, file: 'aab' | 'mapping'): Promise<{ name: string; path: string; size: number }> {
    const dir = join(this.runDir(id), 'artifacts', ARTIFACTS.aab);
    const path = file === 'aab' ? join(dir, 'bundle/release/app-release.aab') : join(dir, 'mapping/release/mapping.txt');
    const stat = await fs.stat(path).catch(() => null);
    if (!stat) {
      throw new NotFoundException(file === 'aab' ? 'This run has no signed AAB: it did not reach the build stage, or failed there.' : 'This run has no R8 mapping.');
    }
    const [info, run] = await Promise.all([this.json<BuildInfo>(join(this.runDir(id), 'artifacts', ARTIFACTS.buildInfo, 'build-info.json')), this.builder.run(id)]);
    const app = (run.app?.id ?? 'app').replace(/[^a-z0-9-]/g, '');
    const stem = info ? `${app}-${info.versionName}-${info.versionCode}` : `${app}-run-${run.number}`;
    return { name: file === 'aab' ? `${stem}.aab` : `${stem}-mapping.txt`, path, size: stat.size };
  }

  toSummary(r: BuilderRun): RunSummary {
    const plan = r.plan as Partial<PipelinePlan> | null;
    const s = r.source;
    return {
      id: r.id,
      number: r.number,
      app: r.app ? { id: r.app.id, name: r.app.name, packageName: r.app.packageName, bundleId: r.app.bundleId ?? null } : null,
      platform: r.params.platform ?? 'android',
      mode: r.params.mode,
      track: r.params.mode === 'release' ? r.params.track : null,
      rehearsal: r.params.rehearsal,
      runner: r.runner,
      remoteUrl: r.remote?.kind === 'github' ? r.remote.url : null,
      mac: r.remote?.kind === 'mac' ? { runner: r.remote.runnerName, waiting: r.status !== 'completed' && (r.remote.state === 'waiting' || r.remote.state === 'offered') } : null,
      source: {
        kind: s.kind,
        branch: s.kind === 'git' ? s.branch : null,
        fileName: s.kind === 'zip' ? s.fileName : null,
        sha: s.sha,
        subject: s.commit?.subject ?? null,
        author: s.commit?.author ?? null,
      },
      state: runState(r),
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      completedAt: r.completedAt,
      startedBy: s.startedBy,
      rerunOf: s.rerunOf,
      versionName: plan?.versionName ?? null,
      versionCode: plan?.versionCode ?? null,
      stages: mapStages(r.jobs, r).map((st) => ({ key: st.key, state: st.state })),
    };
  }

  /** A commit's subject from the app's mirror, when a run did not record it. */
  private async lookup(appId: string, sha: string): Promise<{ subject: string; author: string; date: string } | null> {
    const key = `${appId}:${sha}`;
    if (this.subjects.has(key)) return this.subjects.get(key) ?? null;
    const found = await this.builder.commit(appId, sha).then(
      (c) => ({ subject: c.subject, author: c.author, date: c.date }),
      () => null,
    );
    if (found) this.subjects.set(key, found);
    return found;
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
    for (const [i, name] of names.sort().entries()) out.push({ id: i + 1, name, sizeBytes: await this.size(join(dir, name)) });
    return out;
  }

  private async size(path: string): Promise<number> {
    const st = await fs.stat(path);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of await fs.readdir(path)) total += await this.size(join(path, e));
    return total;
  }

  /** The first failed step, with what its log said about it. */
  private async failure(r: BuilderRun, stages: StageView[]): Promise<RunFailure | null> {
    const failed = r.jobs.find((j) => j.conclusion === 'failure');
    if (!failed) return r.error ? { stage: null, jobId: 0, jobName: 'Builder', step: null, messages: [r.error] } : null;
    const stage = stages.find((s) => s.state === 'failed' && s.jobIds.includes(failed.id)) ?? null;
    const step = stage?.steps.find((s) => s.jobId === failed.id && s.state === 'failed') ?? null;
    let messages: string[] = r.error ? [r.error] : [];
    try {
      messages = [...messages, ...errorLines(await this.builder.log(r.id, failed.id))];
    } catch (e) {
      this.logger.warn(`log for run ${r.id}: ${(e as Error).message}`);
    }
    return { stage: stage?.key ?? null, jobId: failed.id, jobName: failed.name, step: step?.name ?? null, messages };
  }
}
