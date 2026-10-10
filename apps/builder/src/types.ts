/**
 * What the builder keeps on disk: apps, the keys that reach their repositories, and runs.
 *
 * A run is recorded in the shape GitHub reports workflow runs and jobs (status / conclusion /
 * started_at / steps), so the console reads every run with the same stage mapping: six
 * stages from the job and step names below, whether the run executed on this server or on
 * GitHub Actions (whose jobs are mirrored into the record as they progress).
 */

export type Mode = 'build' | 'release';
export type PlayTrack = 'internal' | 'alpha' | 'beta' | 'production';
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

/** Where an app's runs execute. */
export type RunnerKind = 'server' | 'github';

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
  /** Where Build and Release run by default; a run can pick the other. */
  runner: { kind: RunnerKind; github: GithubSetup | null };
  createdAt: string;
  updatedAt: string;
}

// ─── Runs ──────────────────────────────────────────────────────────────────────────────

export interface RunParams {
  mode: Mode;
  track: PlayTrack;
  releaseNotes: string;
  releaseStatus: 'completed' | 'draft';
  /** Blank = the version in pubspec.yaml. */
  versionName: string;
  /** Pinned only when asked; otherwise the Plan job takes the next free code from Google Play. */
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
export interface RemoteRun {
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

export interface Plan {
  mode: Mode;
  trigger: 'git' | 'upload';
  tag: null;
  track: PlayTrack;
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
  /** This server's builder, or GitHub Actions. */
  runner: RunnerKind;
  remote: RemoteRun | null;
}
