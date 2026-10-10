/**
 * Shapes the builder answers with (apps/builder/src/types.ts and its HTTP routes). Runs keep
 * GitHub's job and step vocabulary, which the stage mapping in runs/stages.ts reads.
 */

export type Status = 'queued' | 'in_progress' | 'completed';
export type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;
export type PlayTrack = 'internal' | 'alpha' | 'beta' | 'production';
export type RunnerKind = 'server' | 'github';

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
  /** Where Build and Release run by default; a run can ask for the other. */
  runner: { kind: RunnerKind; github: GithubSetup | null };
  createdAt: string;
  updatedAt: string;
}

export interface RunParams {
  mode: 'build' | 'release';
  /** Omitted: the app's own default. */
  runner?: RunnerKind;
  track: PlayTrack;
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
  app: { id: string; name: string; packageName: string; signing: 'console' | 'repository'; projectPath: string } | null;
  number: number;
  runner: RunnerKind;
  remote: { repo: string; url: string | null; dispatchedAt: string | null } | null;
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
