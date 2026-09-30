/** The subset of GitHub REST payloads the console reads. */

export interface GhUser {
  login: string;
  avatar_url?: string;
}

export interface GhWorkflowRun {
  id: number;
  run_number: number;
  run_attempt?: number;
  name?: string;
  display_title?: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  /** Workflow file of the run, e.g. `.github/workflows/release.yml`. */
  path?: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  actor?: GhUser;
  triggering_actor?: GhUser;
  head_commit?: {
    id: string;
    message: string;
    timestamp: string;
    author?: { name?: string; email?: string };
  } | null;
}

export interface GhRunList {
  total_count: number;
  workflow_runs: GhWorkflowRun[];
}

export interface GhStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GhJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url: string;
  steps?: GhStep[];
  runner_name?: string | null;
}

export interface GhJobList {
  total_count: number;
  jobs: GhJob[];
}

export interface GhArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at?: string;
  expires_at?: string;
}

export interface GhArtifactList {
  total_count: number;
  artifacts: GhArtifact[];
}

export interface GhCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
  author?: GhUser | null;
}

export interface GhTag {
  name: string;
  commit: { sha: string };
}

export interface GhBranch {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}

export interface GhRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

export interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
}
