/** Shapes the console API returns (apps/api/src/pipeline/*.ts, apps/api/src/setup/*.ts). */

export type StageKey = 'checkout' | 'dependencies' | 'tests' | 'aab' | 'fastlane' | 'play';
export type StageState = 'pending' | 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped';
export type RunState = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'waiting';
export type Mode = 'build' | 'release' | 'validate';
export type Trigger = 'console' | 'commit' | 'tag' | 'other';
export type PlayTrack = 'internal' | 'alpha' | 'beta' | 'production';

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

export interface RunSummary {
  id: number;
  number: number;
  attempt: number;
  title: string;
  event: string;
  trigger: Trigger;
  mode: Mode | null;
  track: PlayTrack | null;
  tag: string | null;
  requestId: string | null;
  /** A release Google validated without publishing. */
  rehearsal: boolean;
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
  release: { track: PlayTrack | null; notes: string } | null;
  runs: RunSummary[];
}

export interface StreamResponse {
  repo: { fullName: string; url: string; defaultBranch: string; private: boolean };
  branch: string;
  workflow: { present: boolean; file: string };
  commits: StreamCommit[];
  otherRuns: RunSummary[];
  rate: RateLimit | null;
  refreshedAt: string;
}

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

export interface JobView {
  id: number;
  name: string;
  state: StageState;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
  steps: StepView[];
}

export interface PipelinePlan {
  mode: Mode;
  trigger: 'console' | 'commit' | 'tag';
  tag: string | null;
  track: PlayTrack;
  releaseStatus: 'completed' | 'draft';
  versionName: string;
  versionCode: number;
  integrationTests: boolean;
  publish: boolean;
  rehearsal?: boolean;
  releaseNotes: string;
  requestId: string | null;
  commit: string;
  ref: string;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  success: boolean | null;
  failures: Array<{ name: string; suite: string | null; error: string; stack: string | null }>;
  truncatedFailures: number;
}

export interface BuildInfo {
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  sha256: string;
  signer: string;
  certSha256: string;
  commit: string;
  ref: string;
  builtAt: string;
}

export interface ReleaseInfo {
  packageName: string;
  track: PlayTrack;
  releaseStatus: string;
  versionName: string | null;
  versionCode: number;
  previousHighestVersionCode: number | null;
  /** True for a PLAY_VALIDATE_ONLY rehearsal: Google validated it, nothing was published. */
  validatedOnly?: boolean;
  uploadedAt: string;
  storeUrl: string;
}

export interface PlayStatus {
  packageName: string;
  checkedAt: string;
  tracks: Record<string, number[]>;
  highestVersionCode: number | null;
  runVersionCode: number | null;
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
  failure: { stage: StageKey | null; jobId: number; jobName: string; step: string | null; messages: string[] } | null;
  rate: RateLimit | null;
}

export type LogResponse = { available: true; text: string } | { available: false; reason: string; liveUrl: string };

export type CheckState = 'ok' | 'missing' | 'error' | 'unknown' | 'pending';

export interface PlayTrackState {
  track: string;
  releases: Array<{
    name: string | null;
    versionCodes: number[];
    status: string;
    userFraction: number | null;
    releaseNotes: Array<{ language: string; text: string }>;
  }>;
}

export interface PlaySnapshot {
  packageName: string;
  clientEmail: string;
  projectId: string | null;
  checkedAt: string;
  tracks: PlayTrackState[];
  highestVersionCode: number | null;
}

export type PlayResponse = ({ configured: true } & PlaySnapshot) | { configured: false; packageName: string; reason: string };

export interface SetupResponse {
  configured: boolean;
  repo: { fullName: string; url: string; defaultBranch: string; private: boolean } | null;
  workflowFile: string;
  checks: Array<{
    key: 'token' | 'repo' | 'workflow' | 'fastlane' | 'signing' | 'play-console' | 'play-secret' | 'play-access';
    label: string;
    state: CheckState;
    detail: string;
    fix?: string;
    url?: string;
  }>;
  play: {
    configured: boolean;
    clientEmail: string | null;
    projectId: string | null;
    snapshot: PlaySnapshot | null;
    error: string | null;
  };
  playCheck: {
    runId: number;
    number: number;
    state: RunState;
    at: string;
    url: string;
    status: PlayStatus | null;
    messages: string[];
  } | null;
  signing: { signer: string; certSha256: string; runNumber: number } | null;
  variables: { readable: boolean; defaultTrack: string; versionCodeOffset: number; fromVariables: string[] };
  nextRunNumber: number | null;
  rate: RateLimit | null;
}

export interface StartRunBody {
  branch: string;
  mode: Mode;
  track?: PlayTrack;
  releaseNotes?: string;
  releaseStatus?: 'completed' | 'draft';
  versionName?: string;
  integrationTests?: boolean;
  rehearsal?: boolean;
}
