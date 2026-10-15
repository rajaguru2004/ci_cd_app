/**
 * What the console and a Mac runner's agent say to each other, over HTTP(S) on the console's own
 * address (`/api/runner/v1/…`, the token as `Authorization: Bearer rcr_…`). The agent only ever
 * dials out: it connects, long-polls for a run, and reports while it runs one.
 *
 *   POST connect                     who it is, its pinned key, what it found on its Mac
 *   POST poll                        waits up to ~25 s for a run (an Assignment), or nothing
 *   POST runs/:id/accept             takes the run it was offered
 *   GET  runs/:id/source             the source, packed by the console (tar.gz)
 *   POST runs/:id/events             job and step states and log lines; the answer carries a cancel
 *   PUT  runs/:id/artifacts/:name/:file   one output file (IPA, dSYMs, reports), streamed
 *   POST runs/:id/complete           how it ended
 *
 * This file is the same in apps/builder/src/mac-protocol.ts and apps/mac-runner/src/protocol.ts
 * (a spec in the builder holds them equal).
 */

export const PROTOCOL = 1;

export type Status = 'queued' | 'in_progress' | 'completed';
export type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;

/** What the agent found on its Mac (checked on start, every few minutes, and before each run). */
export interface HostFacts {
  checkedAt: string;
  /** The agent reached the Mac (over SSH, or it runs on it). */
  reachable: boolean;
  /** "macOS 15.5 (24F74)" */
  os: string | null;
  arch: string | null;
  hostname: string | null;
  cpu: string | null;
  memoryGb: number | null;
  diskFreeGb: number | null;
  /** "Xcode 16.4 (16F6)" */
  xcode: string | null;
  iosSdk: string | null;
  /** "3.35.1 (stable)" */
  flutter: string | null;
  cocoapods: string | null;
  ruby: string | null;
  /** "bundler, Ruby 3.4.1" or "2.228.0 (on PATH)" */
  fastlane: string | null;
  /** Each thing that stops an iOS build on this Mac, as a sentence with the fix. */
  problems: string[];
  /** Nothing in problems: the Mac takes runs. */
  ready: boolean;
}

export interface ConnectRequest {
  protocol: number;
  /** The agent's version (its image tag). */
  version: string;
  /** The agent's X25519 public key, base64; pinned by the console on the first connect. */
  publicKey: string;
  executor: 'ssh' | 'local';
  /** The macOS account builds run as, and where the agent reaches it (host:port), for the console's page. */
  hostUser: string | null;
  hostAddress: string | null;
  host: HostFacts | null;
  /** The run the agent is executing right now, if any. */
  activeRun: number | null;
}

export interface ConnectReply {
  runner: { id: string; name: string };
  /** How long a poll may wait for work. */
  pollSeconds: number;
  /** Runs the agent says it has that the console no longer wants: stop them. */
  abort: number[];
}

export interface PollRequest {
  activeRun: number | null;
}

export interface PollReply {
  assignment: Assignment | null;
  abort: number[];
}

/** A file written into the run's folder on the Mac before a step's script. */
export interface WriteSpec {
  /** Relative to the run folder. */
  path: string;
  text?: string;
  /** A name in the run's sealed secrets; the file gets its (base64-decoded) value. */
  secret?: string;
  /** Octal file mode; secrets default to 0600. */
  mode?: number;
}

export interface StepSpec {
  name: string;
  /** Built in: "Set up job" facts, the source onto the Mac, or the closing step. */
  uses?: 'setup' | 'checkout' | 'complete';
  write?: WriteSpec[];
  /** bash (macOS's /bin/bash, 3.2), run with -eo pipefail. */
  run?: string;
  /** Where the script runs: the Flutter project (default) or the run folder. */
  cwd?: 'project' | 'run';
  env?: Record<string, string>;
  /** Environment variables whose values are names in the run's sealed secrets. */
  secretEnv?: Record<string, string>;
  /** Files sent to the console once the script succeeded (or ran, for an `always` step). */
  upload?: { artifact: string; files: Array<{ path: string; as: string; optional?: boolean }> };
  /** Runs after an earlier step of its job failed (not after a cancel). */
  always?: boolean;
  /** Runs no matter what, a cancel included. */
  cleanup?: boolean;
}

export interface JobSpec {
  key: string;
  name: string;
  /** Keys of jobs that must have succeeded first. */
  needs: string[];
  timeoutMin: number;
  steps: StepSpec[];
}

/** One run's work order for a Mac. */
export interface Assignment {
  protocol: number;
  runId: number;
  /** "Fusion HRM #12 · Release → TestFlight" */
  title: string;
  app: { id: string; name: string; bundleId: string };
  source: {
    /** Path on the console to GET the tar.gz from. */
    path: string;
    sizeBytes: number;
    sha256: string;
    /** The folder holding pubspec.yaml inside the source ('' = its top). */
    root: string;
    sha: string | null;
    ref: string;
  };
  /** Environment for every step (the plan: version, build number, bundle ID, …). */
  env: Record<string, string>;
  jobs: JobSpec[];
  /** The run's secrets: a JSON object of name → base64 value, sealed to the agent's key with `run:<id>`. */
  secrets: string | null;
}

export interface StepReport {
  name: string;
  number: number;
  status: Status;
  conclusion: Conclusion;
  started_at: string | null;
  completed_at: string | null;
}

export interface JobReport {
  name: string;
  status: Status;
  conclusion: Conclusion;
  started_at: string | null;
  completed_at: string | null;
  steps: StepReport[];
}

export interface EventsRequest {
  jobs: JobReport[];
  /** Log text per job, in the console's log format (an ISO time on every line). */
  logs: Array<{ job: string; text: string }>;
}

export interface EventsReply {
  cancel: boolean;
}

export interface CompleteRequest extends EventsRequest {
  conclusion: 'success' | 'failure' | 'cancelled';
  error: string | null;
}
