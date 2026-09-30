/**
 * A run on this server, recorded in the same shape GitHub reports workflow runs and jobs
 * (status / conclusion / started_at / steps), so the console reads it with the code it
 * already uses for GitHub runs: same job and step names as release.yml, same six stages.
 */

export type Mode = 'build' | 'release';
export type PlayTrack = 'internal' | 'alpha' | 'beta' | 'production';
export type Status = 'queued' | 'in_progress' | 'completed';
export type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;

export interface RunParams {
  mode: Mode;
  track: PlayTrack;
  releaseNotes: string;
  releaseStatus: 'completed' | 'draft';
  /** Blank = the version in pubspec.yaml. */
  versionName: string;
  /** Allocated by the console from Google Play (highest + 1). */
  versionCode: number;
  rehearsal: boolean;
}

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
}

export interface Plan {
  mode: Mode;
  trigger: 'upload';
  tag: null;
  track: PlayTrack;
  releaseStatus: 'completed' | 'draft';
  versionName: string;
  versionCode: number;
  integrationTests: false;
  publish: boolean;
  rehearsal: boolean;
  releaseNotes: string;
  requestId: null;
  commit: string;
  ref: string;
}

export interface RunRecord {
  id: number;
  status: Status;
  conclusion: Conclusion;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  source: {
    /** Name the file had on the engineer's machine. */
    fileName: string;
    /** Stored upload under uploads/, kept for re-runs. */
    upload: string;
    sizeBytes: number;
    /** Commit SHA GitHub (and git archive) write into the ZIP's comment; null if absent. */
    sha: string | null;
    /** The folder inside the ZIP that holds pubspec.yaml. */
    root: string | null;
    uploadedBy: string;
    rerunOf: number | null;
  };
  params: RunParams;
  plan: Plan | null;
  jobs: JobRecord[];
  /** Run-level problem that is not a step's (e.g. the builder restarted mid-run). */
  error: string | null;
}
