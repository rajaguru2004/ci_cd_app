/** Shapes the console API returns (apps/api/src/runs/*.ts, apps/api/src/builder/builder.types.ts). */

export type StageKey = 'checkout' | 'dependencies' | 'tests' | 'aab' | 'fastlane' | 'play';
export type StageState = 'pending' | 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped';
export type RunState = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'waiting';
export type Mode = 'build' | 'release';
export type PlayTrack = 'internal' | 'alpha' | 'beta' | 'production';
export type IosTrack = 'testflight' | 'app_store';
export type Platform = 'android' | 'ios';
export type RunnerKind = 'server' | 'github' | 'mac';

export interface IosCertificate {
  fileName: string;
  name: string;
  teamId: string | null;
  kind: 'distribution' | 'development' | 'other';
  sha1: string;
  sha256: string;
  validFrom: string;
  validUntil: string;
  uploadedAt: string;
}

export interface IosProfile {
  uuid: string;
  name: string;
  teamId: string;
  appId: string;
  type: 'app-store' | 'ad-hoc' | 'development' | 'enterprise';
  expiresAt: string;
  certificates: string[];
  fileName: string;
  uploadedAt: string;
}

export interface IosSetup {
  bundleId: string;
  certificate: IosCertificate | null;
  profiles: IosProfile[];
  appStore: { keyId: string; issuerId: string; appId: string | null; appName: string | null; checkedAt: string | null; message: string | null; updatedAt: string } | null;
  updatedAt: string;
}

export interface AppStoreBuild {
  buildNumber: string;
  versionName: string | null;
  uploadedAt: string | null;
  processingState: string | null;
  expired: boolean;
}

export type AppStoreResponse =
  | { configured: false; bundleId: string | null; reason: string }
  | { configured: true; bundleId: string; keyId: string; error: string; app: AppView }
  | { configured: true; bundleId: string; keyId: string; appId: string; appName: string; checkedAt: string; builds: AppStoreBuild[]; highestBuild: number | null; app: AppView; error?: undefined };

export interface HostFacts {
  checkedAt: string;
  reachable: boolean;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  cpu: string | null;
  memoryGb: number | null;
  diskFreeGb: number | null;
  xcode: string | null;
  iosSdk: string | null;
  flutter: string | null;
  cocoapods: string | null;
  ruby: string | null;
  fastlane: string | null;
  problems: string[];
  ready: boolean;
}

export interface MacRunnerView {
  id: string;
  name: string;
  tokenHint: string;
  tokenCreatedAt: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
  online: boolean;
  state: 'offline' | 'not-ready' | 'idle' | 'busy';
  run: { id: number; appId: string | null; appName: string | null; number: number } | null;
  keyFingerprint: string | null;
  keyPinnedAt: string | null;
  refusedKey: { fingerprint: string; at: string } | null;
  agent: { version: string; executor: 'ssh' | 'local'; hostUser: string | null; hostAddress: string | null } | null;
  host: HostFacts | null;
}

export interface MacsResponse {
  runners: MacRunnerView[];
  waiting: Array<{ id: number; appId: string | null; appName: string | null; number: number; queuedAt: string | null }>;
  image: string;
}

export interface NewMacRunner {
  runner: MacRunnerView;
  token: string;
  image: string;
}

export interface GithubCheck {
  checkedAt: string;
  login: string | null;
  token: 'ok' | 'missing' | 'refused';
  repo: 'ok' | 'hidden' | 'unknown';
  workflow: 'ok' | 'outdated' | 'missing' | 'disabled' | 'unknown';
  secrets: 'ok' | 'stale' | 'missing' | 'unknown';
  defaultBranch: string | null;
  message: string | null;
}

export interface GithubSetup {
  /** owner/name on github.com. */
  repo: string;
  workflow: string;
  token: 'app' | 'default';
  tokenLogin: string | null;
  check: GithubCheck | null;
  secrets: { syncedAt: string | null; hash: string | null };
}

export interface GithubTokenView {
  login: string;
  kind: 'fine-grained' | 'classic' | 'other';
  scopes: string[] | null;
  expiresAt: string | null;
  savedAt: string;
}

export interface CertInfo {
  owner: string;
  sha256: string;
  sha1: string;
  validFrom: string;
  validUntil: string;
  algorithm: string;
}

export interface AppView {
  id: string;
  name: string;
  packageName: string;
  repo: {
    url: string;
    keyId: string;
    branch: string;
    defaultBranch: string | null;
    /** Folder of pubspec.yaml in the repository ('' = found automatically). */
    path: string;
    access: { state: 'ok' | 'failed' | 'unchecked'; checkedAt: string | null; message: string | null };
    host: string;
    hostLabel: string;
    slug: string;
    webUrl: string | null;
  } | null;
  signing: { mode: 'console' | 'repository'; fileName: string | null; keyAlias: string | null; certificate: CertInfo | null; updatedAt: string | null };
  play: { source: 'app' | 'default'; clientEmail: string | null; projectId: string | null; updatedAt: string | null };
  /** Where Android's Build and Release run by default; a run can ask for the other. iOS runs on a Mac. */
  runner: { kind: Exclude<RunnerKind, 'mac'>; github: GithubSetup | null };
  /** The app's iOS side, once set up. */
  ios: IosSetup | null;
  /** What stops an iOS build and an iOS release now; null without iOS. */
  iosProblems: { build: string[]; release: string[] } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunSummary {
  /** Unique on this console. */
  id: number;
  /** The run's number within its app. */
  number: number;
  app: { id: string; name: string; packageName: string; bundleId?: string | null } | null;
  /** android, or ios (built and released on a Mac runner). */
  platform: Platform;
  mode: Mode;
  track: PlayTrack | IosTrack | null;
  /** A release Google validated without publishing. */
  rehearsal: boolean;
  /** This server's builder, or the app's GitHub Actions. */
  runner: RunnerKind;
  /** Where to open the run on GitHub, once it has dispatched; null for a server run. */
  remoteUrl: string | null;
  /** An iOS run: the Mac that has it, and whether it still waits for one. */
  mac: { runner: string | null; waiting: boolean } | null;
  source: { kind: 'git' | 'zip'; branch: string | null; fileName: string | null; sha: string | null; subject: string | null; author: string | null };
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

export interface AppOverview extends AppView {
  latestRun: RunSummary | null;
  activeRun: RunSummary | null;
  runCount: number;
}

export interface OverviewResponse {
  apps: AppOverview[];
  recent: RunSummary[];
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
  otherRuns: RunSummary[];
  fetchedAt: string | null;
  fetching: boolean;
  error: string | null;
  connected: boolean;
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
  steps: StepView[];
}

export interface PipelinePlan {
  platform?: Platform;
  mode: Mode;
  trigger: 'git' | 'upload';
  track: PlayTrack | IosTrack;
  releaseStatus: 'completed' | 'draft';
  versionName: string;
  versionCode: number;
  versionCodeFrom?: string;
  publish: boolean;
  rehearsal?: boolean;
  releaseNotes: string;
  commit: string;
  ref: string;
  packageName?: string;
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
  platform?: 'ios';
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  sha256: string;
  signer: string;
  certSha256?: string;
  certSha1?: string;
  teamId?: string;
  bundleId?: string;
  profile?: { name: string; uuid: string };
  usesNonExemptEncryption?: boolean | null;
  xcode?: string;
  commit: string;
  ref: string;
  signedBy?: 'console' | 'repository';
  builtAt: string;
}

export interface ReleaseInfo {
  platform?: 'ios';
  destination?: IosTrack;
  processing?: string;
  exportCompliance?: string;
  submittedForReview?: boolean;
  appStoreConnectUrl?: string;
  packageName: string;
  track: PlayTrack | IosTrack;
  releaseStatus: string;
  versionName: string | null;
  versionCode: number;
  previousHighestVersionCode: number | null;
  /** True for a rehearsal: Google validated it, nothing was published. */
  validatedOnly?: boolean;
  uploadedAt: string;
  storeUrl: string;
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
  failure: { stage: StageKey | null; jobId: number; jobName: string; step: string | null; messages: string[] } | null;
}

export type LogResponse = { available: true; text: string };

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

export type PlayResponse =
  | { configured: true; source: 'app' | 'default'; packageName: string; clientEmail: string; projectId: string | null; checkedAt: string; tracks: PlayTrackState[]; highestVersionCode: number | null }
  | { configured: false; packageName: string; reason: string };

export interface KeyRecord {
  id: string;
  email: string;
  name: string | null;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface HostKey {
  host: string;
  type: string;
  fingerprint: string;
}

export interface AccessCheck {
  url: string;
  host: string;
  hostLabel: string;
  slug: string;
  webUrl: string | null;
  hostKey: HostKey | null;
  defaultBranch: string | null;
  branches: string[];
}

export interface ProjectInfo {
  path: string;
  name: string | null;
  versionName: string | null;
  buildNumber: number | null;
  applicationId: string | null;
  gradleFile: string | null;
  label: string | null;
  keyProperties: boolean;
  flutter: boolean;
  sha: string;
  commit: { subject: string; author: string; email: string; date: string };
}

export interface BuilderStatus {
  ok: boolean;
  busy: boolean;
  queued: number;
  current: { id: number; appId: string | null; appName: string | null; number: number; job: string | null } | null;
  onGithub: Array<{ id: number; appId: string | null; appName: string | null; number: number; job: string | null }>;
  onMac?: Array<{ id: number; appId: string | null; appName: string | null; number: number; job: string | null; runner: string | null; waiting: boolean }>;
  macs?: { registered: number; online: number; ready: number; busy: number; waiting: number } | null;
  defaultPlayKey: string | null;
  toolchain: { flutter: string | null; java: string | null };
}

export interface SetupResponse {
  builder: BuilderStatus | null;
  apps: AppView[];
  keys: KeyRecord[];
  knownHosts: HostKey[];
  error: string | null;
}

export interface StartRunBody {
  platform?: Platform;
  mode: Mode;
  /** Omitted: the app's own default (its settings → Where builds run). */
  runner?: Exclude<RunnerKind, 'mac'>;
  track?: PlayTrack | IosTrack;
  releaseNotes?: string;
  releaseStatus?: 'completed' | 'draft';
  versionName?: string;
  rehearsal?: boolean;
  branch?: string;
  sha?: string;
}

export interface StartedRun {
  runId: number;
  number: number;
}
