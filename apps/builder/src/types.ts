import type { HostFacts } from './mac-protocol';

/**
 * What the builder keeps on disk: apps, the keys that reach their repositories, and runs.
 *
 * A run is recorded in the shape GitHub reports workflow runs and jobs (status / conclusion /
 * started_at / steps), so the console reads every run with the same stage mapping: six
 * stages from the job and step names below, whether the run executed on this server, on
 * GitHub Actions or on a Mac runner (whose jobs are mirrored into the record as they progress).
 */

export type Mode = 'build' | 'release';
/** What a run builds: the Android app bundle for Google Play, or the iOS app for App Store Connect. */
export type Platform = 'android' | 'ios';
export type PlayTrack = 'internal' | 'alpha' | 'beta' | 'production';
/** Where an iOS release goes: TestFlight, or on to App Store review. */
export type IosTrack = 'testflight' | 'app_store';
export type Track = PlayTrack | IosTrack;
export type Status = 'queued' | 'in_progress' | 'completed';
export type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;

// ─── Keys and apps ─────────────────────────────────────────────────────────────────────

/** An SSH key the console generated for one person's git account. The private half is in the vault. */
export interface KeyRecord {
  id: string;
  /** The git email it was made for; also the key's comment, so it is recognisable on GitHub. */
  email: string;
  name: string | null;
  /** `ssh-ed25519 AAAA… email`, the line to paste into the git host. */
  publicKey: string;
  /** `SHA256:…`, as GitHub and `ssh-keygen -l` print it. */
  fingerprint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type AccessState = 'ok' | 'failed' | 'unchecked';

export interface RepoConfig {
  /** SSH URL, e.g. git@github.com:org/app.git. */
  url: string;
  keyId: string;
  /** The branch Build and Release use unless told otherwise. */
  branch: string;
  /** The remote's own default branch, as `git ls-remote --symref` reported it. */
  defaultBranch: string | null;
  /** Folder of pubspec.yaml inside the repository ('' = find it at the top or two levels down). */
  path: string;
  access: { state: AccessState; checkedAt: string | null; message: string | null };
}

export interface CertInfo {
  owner: string;
  sha256: string;
  sha1: string;
  validFrom: string;
  validUntil: string;
  algorithm: string;
}

/** Where an app's runs execute: Android on this server or GitHub Actions; iOS always on a Mac runner. */
export type RunnerKind = 'server' | 'github' | 'mac';

/** What the console last found on GitHub for an app that builds there. */
export interface GithubCheck {
  checkedAt: string;
  /** Whose token answered (its GitHub login). */
  login: string | null;
  token: 'ok' | 'missing' | 'refused';
  repo: 'ok' | 'hidden' | 'unknown';
  /** On the default branch as the console wrote it, changed since, absent, or turned off. */
  workflow: 'ok' | 'outdated' | 'missing' | 'disabled' | 'unknown';
  /** The Actions secrets a run needs, as the console last copied them. */
  secrets: 'ok' | 'stale' | 'missing' | 'unknown';
  defaultBranch: string | null;
  /** The first thing to fix, as a sentence; null when GitHub is ready. */
  message: string | null;
}

export interface GithubSetup {
  /** owner/name on github.com, from the repository's SSH URL. */
  repo: string;
  /** The workflow file under .github/workflows/ the console starts. */
  workflow: string;
  /** The app's own token, or the console's default one. */
  token: 'app' | 'default';
  /** Login behind the app's own token (the default token's is the console's). */
  tokenLogin: string | null;
  check: GithubCheck | null;
  /** What was last copied into the repository's Actions secrets, as a hash of the material. */
  secrets: { syncedAt: string | null; hash: string | null };
}

/** The Apple Distribution certificate an app's IPA is signed with (its .p12 is in the vault). */
export interface IosCertificate {
  fileName: string;
  /** The certificate's common name, e.g. "Apple Distribution: Acme Ltd (A1B2C3D4E5)". */
  name: string;
  teamId: string | null;
  kind: 'distribution' | 'development' | 'other';
  sha1: string;
  sha256: string;
  validFrom: string;
  validUntil: string;
  uploadedAt: string;
}

/** A provisioning profile the app's targets are signed with (the file is in the vault). */
export interface IosProfile {
  uuid: string;
  name: string;
  teamId: string;
  /** The App ID it covers, without the team prefix: com.acme.app, com.acme.*, or *. */
  appId: string;
  type: 'app-store' | 'ad-hoc' | 'development' | 'enterprise';
  expiresAt: string;
  /** SHA-1 of every certificate the profile allows, upper-case hex without colons. */
  certificates: string[];
  fileName: string;
  uploadedAt: string;
}

/** The App Store Connect API key an app uploads with (the .p8 itself is in the vault). */
export interface AppStoreKeyInfo {
  keyId: string;
  issuerId: string;
  /** App Store Connect's own id and name for the app, found by its bundle ID; null until found. */
  appId: string | null;
  appName: string | null;
  checkedAt: string | null;
  /** What App Store Connect last said was wrong, as a sentence; null when it answered. */
  message: string | null;
  updatedAt: string;
}

/** The iOS half of a Flutter app: built and released from a Mac runner. */
export interface IosSetup {
  /** CFBundleIdentifier of the app (the Runner target). */
  bundleId: string;
  certificate: IosCertificate | null;
  profiles: IosProfile[];
  appStore: AppStoreKeyInfo | null;
  updatedAt: string;
}

export interface AppRecord {
  /** Slug from the name, unique, used in URLs and folders. */
  id: string;
  name: string;
  /** The applicationId Google Play knows the app by. */
  packageName: string;
  /** Null for an app built only from uploaded ZIPs. */
  repo: RepoConfig | null;
  signing: {
    /** console: the uploaded keystore signs the finished bundle. repository: the project's own Gradle signing (key.properties). */
    mode: 'console' | 'repository';
    fileName: string | null;
    keyAlias: string | null;
    certificate: CertInfo | null;
    updatedAt: string | null;
  };
  play: {
    /** app: a service-account key uploaded for this app. default: the key mounted on the console, if any. */
    source: 'app' | 'default';
    clientEmail: string | null;
    projectId: string | null;
    updatedAt: string | null;
  };
  /** Where Android's Build and Release run by default; a run can pick the other. */
  runner: { kind: Exclude<RunnerKind, 'mac'>; github: GithubSetup | null };
  /** Null until the app's iOS side is set up (bundle ID, signing, App Store Connect). */
  ios: IosSetup | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Runs ──────────────────────────────────────────────────────────────────────────────

export interface RunParams {
  /** android for every run recorded before iOS existed. */
  platform: Platform;
  mode: Mode;
  /** A Google Play track (Android) or TestFlight / App Store review (iOS). */
  track: Track;
  releaseNotes: string;
  /** Android: roll out or keep as a draft. iOS App Store review: release when approved, or by hand. */
  releaseStatus: 'completed' | 'draft';
  /** Blank = the version in pubspec.yaml. */
  versionName: string;
  /** Pinned only when asked; otherwise the Plan job takes the next free code (Android) or build number (iOS). */
  versionCode: number | null;
  rehearsal: boolean;
}

/** What a run knew about its app when it was created; the app may be changed or deleted later. */
export interface RunApp {
  id: string;
  name: string;
  packageName: string;
  signing: 'console' | 'repository';
  projectPath: string;
  /** The upload certificate the bundle must carry when the console signs. */
  certSha256?: string | null;
  /** iOS runs: the bundle ID the IPA is built for. */
  bundleId?: string | null;
  /** iOS runs: the SHA-1 of the distribution certificate the IPA must carry. */
  iosCertSha1?: string | null;
}

export interface CommitInfo {
  subject: string;
  author: string;
  email: string;
  date: string;
}

interface SourceBase {
  /** The commit built: from git, or the one GitHub writes into a ZIP's comment; null when unknown. */
  sha: string | null;
  /** The folder holding pubspec.yaml, relative to the checkout or the ZIP. */
  root: string | null;
  commit: CommitInfo | null;
  startedBy: string;
  rerunOf: number | null;
}

export interface GitSource extends SourceBase {
  kind: 'git';
  url: string;
  branch: string;
  /** A specific commit asked for; null = the branch tip at the time the run starts. */
  requestedSha: string | null;
}

export interface ZipSource extends SourceBase {
  kind: 'zip';
  /** Name the file had on the engineer's machine. */
  fileName: string;
  /** Stored upload under uploads/, kept for re-runs. */
  upload: string;
  sizeBytes: number;
}

export type RunSource = GitSource | ZipSource;

export interface StepRecord {
  name: string;
  number: number;
  status: Status;
  conclusion: Conclusion;
  started_at: string | null;
  completed_at: string | null;
}

export interface JobRecord {
  id: number;
  name: string;
  status: Status;
  conclusion: Conclusion;
  started_at: string | null;
  completed_at: string | null;
  steps: StepRecord[];
  /** The GitHub Actions job this one mirrors, for a run on GitHub. */
  remote?: { id: number; url: string } | null;
}

/** A run executing on GitHub Actions: the workflow run the console started and follows. */
export interface GithubRemote {
  kind: 'github';
  /** owner/name */
  repo: string;
  workflow: string;
  /** Written into the run's title on GitHub, so the console can find a run it started. */
  requestId: string;
  runId: number | null;
  url: string | null;
  dispatchedAt: string | null;
  /** Artifacts already copied to the console. */
  fetched: string[];
}

/** A run whose jobs execute on a Mac runner: the console plans it, a Mac takes it and reports back. */
export interface MacRemote {
  kind: 'mac';
  /** Waiting for a free Mac, offered to one (not yet accepted), running there, or over. */
  state: 'waiting' | 'offered' | 'running' | 'done';
  runnerId: string | null;
  runnerName: string | null;
  queuedAt: string | null;
  offeredAt: string | null;
  acceptedAt: string | null;
  /** The Mac's last report about this run. */
  lastHeardAt: string | null;
  /** A cancel waiting to reach the Mac with its next report. */
  cancelRequested: boolean;
}

export type RemoteRun = GithubRemote | MacRemote;

export interface Plan {
  /** android for every plan made before iOS existed. */
  platform?: Platform;
  mode: Mode;
  trigger: 'git' | 'upload';
  tag: null;
  track: Track;
  releaseStatus: 'completed' | 'draft';
  versionName: string;
  versionCode: number;
  /** How the code was chosen, in words (e.g. "Google Play's highest, 1009, + 1"). */
  versionCodeFrom: string;
  integrationTests: false;
  publish: boolean;
  rehearsal: boolean;
  releaseNotes: string;
  requestId: null;
  commit: string;
  ref: string;
  /** The Android package, or the iOS bundle ID. */
  packageName: string;
}

export interface RunRecord {
  /** Unique on this console. */
  id: number;
  /** Null only for a run recorded before apps existed and not yet adopted by one. */
  app: RunApp | null;
  /** The run's number within its app (#12). */
  number: number;
  status: Status;
  conclusion: Conclusion;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  source: RunSource;
  params: RunParams;
  plan: Plan | null;
  jobs: JobRecord[];
  /** Run-level problem that is not a step's (e.g. the builder restarted mid-run). */
  error: string | null;
  /** This server's builder, GitHub Actions, or a Mac runner. */
  runner: RunnerKind;
  remote: RemoteRun | null;
}

// ─── Mac runners ───────────────────────────────────────────────────────────────────────

export type { HostFacts };

/** A Mac the console may hand iOS runs to. The record holds no secret: the token is kept as a hash. */
export interface MacRunnerRecord {
  id: string;
  name: string;
  /** SHA-256 (hex) of the token's secret part. */
  tokenHash: string;
  /** The token's last four characters, to tell tokens apart. */
  tokenHint: string;
  tokenCreatedAt: string;
  /** The agent's X25519 public key (base64), pinned on its first connect; run secrets are sealed to it. */
  publicKey: string | null;
  keyFingerprint: string | null;
  keyPinnedAt: string | null;
  /** A different key the agent offered since (refused until someone resets the pin). */
  refusedKey: { fingerprint: string; at: string } | null;
  createdAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
  agent: { version: string; executor: 'ssh' | 'local'; hostUser: string | null; hostAddress: string | null } | null;
  host: HostFacts | null;
}
