/**
 * The small JSON artifacts a run writes (apps/builder/src/pipeline.ts), and the Flutter test
 * report. The console reads them to say what a run did (plan, tests, AAB, Play upload) in its
 * own words instead of sending people into raw logs.
 */

export const ARTIFACTS = {
  plan: 'pipeline-plan',
  tests: 'test-results',
  aab: 'app-release-aab',
  buildInfo: 'build-info',
  release: 'play-release',
  /** iOS runs (sent by the Mac): the IPA and its dSYMs, and App Store Connect's answer. */
  ipa: 'app-release-ipa',
  storeRelease: 'store-release',
} as const;

export interface PipelinePlan {
  mode: 'build' | 'release';
  trigger: 'git' | 'upload';
  tag: string | null;
  track: string;
  releaseStatus: string;
  versionName: string;
  versionCode: number;
  /** How the code was chosen, in words; absent in plans written before apps existed. */
  versionCodeFrom?: string;
  integrationTests: boolean;
  publish: boolean;
  /** Absent in plans written before rehearsals existed. */
  rehearsal?: boolean;
  releaseNotes: string;
  requestId: string | null;
  commit: string;
  ref: string;
  packageName?: string;
}

export interface BuildInfo {
  /** ios for an IPA built on a Mac; absent (Android) otherwise. */
  platform?: 'ios';
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  sha256: string;
  signer: string;
  certSha256?: string;
  /** iOS: the distribution certificate's SHA-1, the team, the bundle ID and the profile it was signed with. */
  certSha1?: string;
  teamId?: string;
  bundleId?: string;
  profile?: { name: string; uuid: string };
  usesNonExemptEncryption?: boolean | null;
  xcode?: string;
  commit: string;
  ref: string;
  packageName?: string;
  /** console: the console's upload key signed it after the build; repository: the project's own signing. */
  signedBy?: 'console' | 'repository';
  builtAt: string;
}

export interface ReleaseInfo {
  /** ios for an App Store Connect upload; absent (Google Play) otherwise. */
  platform?: 'ios';
  bundleId?: string;
  destination?: 'testflight' | 'app_store';
  previousHighestBuild?: number | null;
  processing?: string;
  exportCompliance?: string;
  submittedForReview?: boolean;
  appStoreConnectUrl?: string;
  packageName: string;
  track: string;
  releaseStatus: string;
  versionName: string | null;
  versionCode: number;
  previousHighestVersionCode: number | null;
  /** True for a rehearsal (PLAY_VALIDATE_ONLY): Google validated the release, nothing was published. */
  validatedOnly?: boolean;
  uploadedAt: string;
  storeUrl: string;
}

export interface TestFailure {
  name: string;
  suite: string | null;
  error: string;
  stack: string | null;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Wall time of the whole `flutter test` run. */
  durationMs: number | null;
  /** The reporter's own verdict; null when the run never finished writing the report. */
  success: boolean | null;
  failures: TestFailure[];
  /** More failures than the console lists. */
  truncatedFailures: number;
}

const MAX_FAILURES = 50;
const MAX_ERROR = 1500;
const MAX_STACK_LINES = 12;

interface ReporterEvent {
  type?: string;
  time?: number;
  suite?: { id: number; path?: string | null };
  test?: { id: number; name: string; suiteID: number };
  testID?: number;
  result?: string;
  hidden?: boolean;
  skipped?: boolean;
  error?: string;
  stackTrace?: string;
  success?: boolean | null;
}

/**
 * Summarises `flutter test --file-reporter json:<file>` output: one JSON event per line.
 * Hidden tests are the runner's "loading <file>" entries; a file that fails to compile shows
 * up as a visible failed loading test, so compile errors are counted, not lost.
 */
export function parseFlutterTestReport(text: string): TestSummary {
  const suites = new Map<number, string | null>();
  const tests = new Map<number, { name: string; suiteID: number }>();
  const errors = new Map<number, { error: string; stack: string | null }>();
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs: number | null = null;
  let success: boolean | null = null;
  let lastTime: number | null = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: ReporterEvent;
    try {
      ev = JSON.parse(trimmed) as ReporterEvent;
    } catch {
      continue;
    }
    if (typeof ev.time === 'number') lastTime = ev.time;
    switch (ev.type) {
      case 'suite':
        if (ev.suite) suites.set(ev.suite.id, ev.suite.path ?? null);
        break;
      case 'testStart':
        if (ev.test) tests.set(ev.test.id, { name: ev.test.name, suiteID: ev.test.suiteID });
        break;
      case 'error':
        // Keep the first error per test: later ones are usually consequences of it.
        if (typeof ev.testID === 'number' && !errors.has(ev.testID)) {
          errors.set(ev.testID, { error: ev.error ?? '', stack: ev.stackTrace ?? null });
        }
        break;
      case 'testDone': {
        if (ev.hidden) break;
        if (ev.skipped) {
          skipped += 1;
        } else if (ev.result === 'success') {
          passed += 1;
        } else {
          failed += 1;
          const id = ev.testID ?? -1;
          const test = tests.get(id);
          const err = errors.get(id);
          if (failures.length < MAX_FAILURES) {
            failures.push({
              name: test?.name ?? `test ${id}`,
              suite: test ? (suites.get(test.suiteID) ?? null) : null,
              error: (err?.error ?? `Test ${ev.result ?? 'failed'}`).slice(0, MAX_ERROR),
              stack: err?.stack ? err.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n') : null,
            });
          }
        }
        break;
      }
      case 'done':
        success = ev.success ?? null;
        if (typeof ev.time === 'number') durationMs = ev.time;
        break;
    }
  }

  return {
    total: passed + failed + skipped,
    passed,
    failed,
    skipped,
    durationMs: durationMs ?? lastTime,
    success,
    failures,
    truncatedFailures: Math.max(0, failed - failures.length),
  };
}

/**
 * The `##[error]` lines of a job log: what `::error::` annotations and failing actions said.
 * GitHub's closing "Process completed with exit code N" is dropped when anything more
 * specific was said.
 */
export function errorLines(log: string, max = 5): string[] {
  const out: string[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
    const i = line.indexOf('##[error]');
    if (i >= 0) out.push(line.slice(i + '##[error]'.length).trim());
  }
  const specific = out.filter((l) => !/^Process completed with exit code \d+\.?$/.test(l));
  return [...new Set(specific.length ? specific : out)].slice(0, max);
}
