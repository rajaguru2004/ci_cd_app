/**
 * Shapes the builder answers with (apps/builder/src/types.ts and its HTTP routes). Runs keep
 * GitHub's job and step vocabulary, which the stage mapping in runs/stages.ts reads.
 */

export type Status = 'queued' | 'in_progress' | 'completed';
export type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;
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

/** What a Mac runner last found on its Mac. */
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
  /** The image a Mac pulls. */
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
    /** Folder of pubspec.yaml in the repository. */
    path: string;
    access: { state: 'ok' | 'failed' | 'unchecked'; checkedAt: string | null; message: string | null };
    host: string;
    hostLabel: string;
    /** owner/name */
    slug: string;
    webUrl: string | null;
  } | null;
  signing: { mode: 'console' | 'repository'; fileName: string | null; keyAlias: string | null; certificate: CertInfo | null; updatedAt: string | null };
  play: { source: 'app' | 'default'; clientEmail: string | null; projectId: string | null; updatedAt: string | null };
  /** Where Android's Build and Release run by default; a run can ask for the other. iOS runs on a Mac. */
  runner: { kind: Exclude<RunnerKind, 'mac'>; github: GithubSetup | null };
  /** The app's iOS side, once set up. */
  ios: IosSetup | null;
  /** What stops an iOS build and an iOS release now (sentences with the way out); null without iOS. */
  iosProblems: { build: string[]; release: string[] } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunParams {
  platform: Platform;
  mode: 'build' | 'release';
  /** Omitted: the app's own default. */
  runner?: RunnerKind;
  track: PlayTrack | IosTrack;
  releaseNotes: string;
  releaseStatus: 'completed' | 'draft';
  versionName: string;
  versionCode: number | null;
  rehearsal: boolean;
}

export interface BuilderStep {
  name: string;
  number: number;
  status: Status;
  conclusion: Conclusion;
  started_at: string | null;
  completed_at: string | null;
}

export interface RemoteJob {
  id: number;
  url: string;
}

export interface BuilderJob {
  id: number;
  name: string;
  status: Status;
  conclusion: Conclusion;
  started_at: string | null;
  completed_at: string | null;
  steps: BuilderStep[];
  remote?: RemoteJob | null;
}

export interface CommitInfo {
  subject: string;
  author: string;
  email: string;
  date: string;
}

export interface BuilderRun {
  id: number;
  app: { id: string; name: string; packageName: string; signing: 'console' | 'repository'; projectPath: string; bundleId?: string | null } | null;
  number: number;
  runner: RunnerKind;
  remote:
    | { kind: 'github'; repo: string; url: string | null; dispatchedAt: string | null }
    | { kind: 'mac'; state: 'waiting' | 'offered' | 'running' | 'done'; runnerId: string | null; runnerName: string | null; queuedAt: string | null; acceptedAt: string | null; lastHeardAt: string | null }
    | null;
  status: Status;
  conclusion: Conclusion;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  source:
    | { kind: 'git'; url: string; branch: string; requestedSha: string | null; sha: string | null; root: string | null; commit: CommitInfo | null; startedBy: string; rerunOf: number | null }
    | { kind: 'zip'; fileName: string; upload: string; sizeBytes: number; sha: string | null; root: string | null; commit: CommitInfo | null; startedBy: string; rerunOf: number | null };
  params: RunParams;
  plan: Record<string, unknown> | null;
  jobs: BuilderJob[];
  error: string | null;
}

export interface CommitEntry extends CommitInfo {
  sha: string;
  body: string;
  tags: string[];
  url: string | null;
}

export interface CommitsResponse {
  branch: string | null;
  branches: string[];
  defaultBranch: string | null;
  commits: CommitEntry[];
  fetchedAt: string | null;
  fetching: boolean;
  error: string | null;
  connected: boolean;
}

export interface BuilderHealth {
  ok: boolean;
  busy: boolean;
  queued: number;
  current: { id: number; appId: string | null; appName: string | null; number: number; job: string | null } | null;
  onGithub: Array<{ id: number; appId: string | null; appName: string | null; number: number; job: string | null }>;
  /** iOS runs being planned, waiting for a Mac, or running on one. */
  onMac?: Array<{ id: number; appId: string | null; appName: string | null; number: number; job: string | null; runner: string | null; waiting: boolean }>;
  macs?: { registered: number; online: number; ready: number; busy: number; waiting: number };
  defaultPlayKey: string | null;
  toolchain: { flutter: string | null; java: string | null };
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
  commit: CommitInfo;
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
