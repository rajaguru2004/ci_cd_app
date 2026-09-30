import type { GhJob, GhWorkflowRun } from '../github/github.types';

/**
 * The six stages the console draws, mapped from the jobs and steps GitHub reports for a run
 * of release.yml. Pure functions: everything here is derived from GitHub's payload for that
 * run and nothing else, so a stage can never show a state GitHub did not report.
 *
 * The job and step names are the contract with mobile-pipeline/.github/workflows/release.yml.
 */
export type StageKey = 'checkout' | 'dependencies' | 'tests' | 'aab' | 'fastlane' | 'play';

export type StageState =
  /** Upstream work has not finished; no job for this stage exists yet. */
  | 'pending'
  /** Its job exists (or is waiting for a runner) but no step of this stage has started. */
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  /** Not part of this run (e.g. no Google Play stage on a build-only run). */
  | 'skipped';

export type RunState = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'waiting';

export const STAGES: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: 'checkout', label: 'Checkout' },
  { key: 'dependencies', label: 'Dependencies' },
  { key: 'tests', label: 'Tests' },
  { key: 'aab', label: 'Signed AAB' },
  { key: 'fastlane', label: 'Fastlane' },
  { key: 'play', label: 'Google Play' },
];

interface JobRule {
  /** Stage for "Set up job" and for a job that failed before its first step. */
  first: StageKey;
  /** Step name → stage; the first match wins. */
  steps: Array<[RegExp, StageKey]>;
  /** Every step no rule claims, including GitHub's "Post …" and "Complete job". */
  rest: StageKey;
}

const SETUP = /^(Set up job|Checkout code)$/;

export const JOB_RULES: Readonly<Record<string, JobRule>> = {
  Plan: { first: 'checkout', steps: [], rest: 'checkout' },
  Tests: {
    first: 'checkout',
    steps: [
      [SETUP, 'checkout'],
      [/^(Set up Flutter|Install dependencies)$/, 'dependencies'],
    ],
    rest: 'tests',
  },
  'Emulator smoke suite': { first: 'tests', steps: [], rest: 'tests' },
  'Signed AAB': { first: 'aab', steps: [], rest: 'aab' },
  'Google Play': {
    first: 'fastlane',
    steps: [[/^(Set up job|Checkout code|Set up Ruby and Fastlane|Download AAB|Write release notes)$/, 'fastlane']],
    rest: 'play',
  },
  'Google Play access': {
    first: 'fastlane',
    steps: [[/^(Set up job|Checkout code|Set up Ruby and Fastlane)$/, 'fastlane']],
    rest: 'play',
  },
};

export interface StepView {
  jobId: number;
  jobName: string;
  number: number;
  name: string;
  state: StageState;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface StageView {
  key: StageKey;
  label: string;
  state: StageState;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  jobIds: number[];
  steps: StepView[];
}

type RunLike = Pick<GhWorkflowRun, 'status' | 'conclusion'>;

export function runState(run: RunLike): RunState {
  if (run.status === 'completed') {
    switch (run.conclusion) {
      case 'success':
        return 'success';
      case 'cancelled':
        return 'cancelled';
      case 'skipped':
      case 'neutral':
        return 'skipped';
      case 'action_required':
        return 'waiting';
      default:
        // failure, timed_out, startup_failure, stale
        return 'failed';
    }
  }
  if (run.status === 'in_progress') return 'running';
  if (run.status === 'waiting' || run.status === 'action_required') return 'waiting';
  return 'queued';
}

function coverage(rule: JobRule): StageKey[] {
  return [...new Set<StageKey>([rule.first, ...rule.steps.map(([, s]) => s), rule.rest])];
}

function stepState(status: string, conclusion: string | null, job: GhJob): StageState {
  if (status === 'in_progress') return 'running';
  if (status !== 'completed') return 'queued';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'skipped':
      return 'skipped';
    case 'cancelled':
      // A timeout cancels the running step and fails the job: that is a failure.
      return job.conclusion === 'failure' || job.conclusion === 'timed_out' ? 'failed' : 'cancelled';
    default:
      return 'failed';
  }
}

const ms = (iso?: string | null) => (iso ? Date.parse(iso) : NaN);

function span(startedAt: string | null, completedAt: string | null): number | null {
  const a = ms(startedAt);
  const b = ms(completedAt);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

export function mapStages(jobs: GhJob[], run: RunLike): StageView[] {
  const buckets = new Map<StageKey, { steps: StepView[]; jobs: GhJob[] }>(
    STAGES.map((s) => [s.key, { steps: [], jobs: [] }]),
  );

  for (const job of jobs) {
    const rule = JOB_RULES[job.name];
    if (!rule) continue; // a job the pipeline does not know is listed, not staged
    for (const stage of coverage(rule)) buckets.get(stage)!.jobs.push(job);
    for (const step of job.steps ?? []) {
      const stage = rule.steps.find(([re]) => re.test(step.name))?.[1] ?? rule.rest;
      const startedAt = step.started_at ?? null;
      const completedAt = step.completed_at ?? null;
      buckets.get(stage)!.steps.push({
        jobId: job.id,
        jobName: job.name,
        number: step.number,
        name: step.name,
        state: stepState(step.status, step.conclusion, job),
        startedAt,
        completedAt,
        durationMs: span(startedAt, completedAt),
      });
    }
  }

  const finished = run.status === 'completed';
  return STAGES.map(({ key, label }) => {
    const { steps, jobs: stageJobs } = buckets.get(key)!;
    let state = aggregate(key, steps, stageJobs);
    // A finished run leaves nothing waiting: whatever never started was cancelled with the
    // run, or was simply never reached.
    if (finished && (state === 'pending' || state === 'queued' || state === 'running')) {
      state = run.conclusion === 'cancelled' ? 'cancelled' : 'skipped';
    }
    const starts = steps.map((s) => s.startedAt).filter((x): x is string => Boolean(x)).sort();
    const ends = steps.map((s) => s.completedAt).filter((x): x is string => Boolean(x)).sort();
    const startedAt = starts[0] ?? null;
    const terminal = state === 'success' || state === 'failed' || state === 'cancelled';
    const completedAt = terminal ? (ends[ends.length - 1] ?? null) : null;
    return {
      key,
      label,
      state,
      startedAt,
      completedAt,
      durationMs: span(startedAt, completedAt),
      jobIds: [...new Set(stageJobs.map((j) => j.id))],
      steps: steps.sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || a.number - b.number),
    };
  });
}

const ORDER = new Map(STAGES.map((s, i) => [s.key, i]));

function stageOf(job: GhJob, stepName: string): StageKey {
  const rule = JOB_RULES[job.name];
  return rule.steps.find(([re]) => re.test(stepName))?.[1] ?? rule.rest;
}

/**
 * A stage is finished for a job when the job has completed, or has started a step that
 * belongs to a later stage. Until every job covering the stage is past it, the stage is not
 * done, even when every step listed so far succeeded: GitHub lists steps as they come.
 */
function jobPast(job: GhJob, stage: StageKey): boolean {
  if (job.status === 'completed') return true;
  const at = ORDER.get(stage)!;
  return (job.steps ?? []).some((s) => s.started_at && ORDER.get(stageOf(job, s.name))! > at);
}

function aggregate(stage: StageKey, steps: StepView[], jobs: GhJob[]): StageState {
  if (jobs.length === 0) return 'pending';

  // A job that died before its first step (runner never started, startup failure) failed
  // its first stage; its later stages were never reached.
  const diedEarly = jobs.some(
    (j) =>
      j.status === 'completed' &&
      (j.steps ?? []).length === 0 &&
      j.conclusion !== 'success' &&
      j.conclusion !== 'skipped' &&
      j.conclusion !== 'cancelled' &&
      JOB_RULES[j.name]?.first === stage,
  );
  if (steps.some((s) => s.state === 'failed') || diedEarly) return 'failed';
  if (steps.some((s) => s.state === 'running')) return 'running';
  if (steps.some((s) => s.state === 'cancelled')) return 'cancelled';

  const active = jobs.filter((j) => j.conclusion !== 'skipped');
  if (active.length === 0) return 'skipped';

  if (active.every((j) => jobPast(j, stage))) {
    if (steps.length === 0) {
      if (active.some((j) => j.conclusion === 'cancelled')) return 'cancelled';
      // The job ended before it reached this stage.
      if (active.some((j) => j.conclusion !== 'success')) return 'skipped';
      return 'success';
    }
    return steps.every((s) => s.state === 'skipped') ? 'skipped' : 'success';
  }
  return steps.some((s) => s.state === 'success' || s.state === 'skipped') ? 'running' : 'queued';
}

// ─── What started a run ────────────────────────────────────────────────────────────────

export type Trigger = 'console' | 'commit' | 'tag' | 'other';
export type Mode = 'build' | 'release' | 'validate';
export const PLAY_TRACKS = ['internal', 'alpha', 'beta', 'production'] as const;
export type PlayTrack = (typeof PLAY_TRACKS)[number];

export interface ReleaseMarker {
  /** Null = the repository's default track (PLAY_DEFAULT_TRACK). */
  track: PlayTrack | null;
  notes: string;
}

const RELEASE_SUBJECT = /^release(?:\((internal|alpha|beta|production)\))?:\s*(.*)$/;
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)(?:-(internal|alpha|beta|production))?$/;

/** `release: notes` / `release(beta): notes` — the same rule release-plan.sh applies. */
export function parseReleaseSubject(subject: string): ReleaseMarker | null {
  const m = RELEASE_SUBJECT.exec(subject.trim());
  if (!m) return null;
  return { track: (m[1] as PlayTrack | undefined) ?? null, notes: m[2].trim() };
}

export function parseReleaseTag(tag: string): { version: string; track: PlayTrack | null } | null {
  const m = RELEASE_TAG.exec(tag);
  if (!m) return null;
  return { version: m[1], track: (m[2] as PlayTrack | undefined) ?? null };
}

export interface RunIntent {
  trigger: Trigger;
  mode: Mode | null;
  track: PlayTrack | null;
  tag: string | null;
  requestId: string | null;
  /** A release Google validates without publishing (console only). */
  rehearsal: boolean;
}

/**
 * What a run was asked to do, read from what GitHub lists for it (event, ref, title). The
 * run's `pipeline-plan` artifact is the authority once it exists; this is what the stream can
 * say without downloading anything.
 */
export function describeRun(run: Pick<GhWorkflowRun, 'event' | 'head_branch' | 'display_title' | 'head_commit'>): RunIntent {
  const title = run.display_title ?? '';
  if (run.event === 'workflow_dispatch') {
    const parts = title.split(' · ');
    const head = parts[0] ?? '';
    const release = /^(Rehearse release|Release) to (internal|alpha|beta|production)$/.exec(head);
    const mode: Mode | null = release
      ? 'release'
      : head === 'Check Play access'
        ? 'validate'
        : head === 'Build and test'
          ? 'build'
          : null;
    return {
      trigger: 'console',
      mode,
      track: (release?.[2] as PlayTrack | undefined) ?? null,
      tag: null,
      requestId: parts.length >= 3 ? (parts[parts.length - 1] ?? null) : null,
      rehearsal: release?.[1] === 'Rehearse release',
    };
  }
  if (run.event === 'push') {
    const tag = run.head_branch ? parseReleaseTag(run.head_branch) : null;
    if (tag) return { trigger: 'tag', mode: 'release', track: tag.track, tag: run.head_branch, requestId: null, rehearsal: false };
    const subject = (run.head_commit?.message ?? title).split('\n')[0] ?? '';
    const marker = parseReleaseSubject(subject);
    return {
      trigger: 'commit',
      mode: marker ? 'release' : null,
      track: marker?.track ?? null,
      tag: null,
      requestId: null,
      rehearsal: false,
    };
  }
  return { trigger: 'other', mode: null, track: null, tag: null, requestId: null, rehearsal: false };
}
