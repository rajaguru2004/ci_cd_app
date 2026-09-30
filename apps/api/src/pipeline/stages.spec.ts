import type { GhJob, GhStep } from '../github/github.types';
import { describeRun, mapStages, parseReleaseSubject, parseReleaseTag, runState, StageKey } from './stages';

let nextId = 1;
const t = (min: number) => new Date(Date.UTC(2026, 8, 29, 10, min)).toISOString();

function step(name: string, status: string, conclusion: string | null, start?: number, end?: number): GhStep {
  return {
    name,
    status,
    conclusion,
    number: nextId++,
    started_at: start === undefined ? null : t(start),
    completed_at: end === undefined ? null : t(end),
  };
}

function job(name: string, status: string, conclusion: string | null, steps: GhStep[] = []): GhJob {
  return { id: nextId++, run_id: 1, name, status, conclusion, html_url: `https://gh/job/${name}`, steps };
}

const ok = (name: string, a: number, b: number) => step(name, 'completed', 'success', a, b);
const states = (jobs: GhJob[], run = { status: 'in_progress', conclusion: null as string | null }) =>
  Object.fromEntries(mapStages(jobs, run).map((s) => [s.key, s.state])) as Record<StageKey, string>;

const planDone = () => job('Plan', 'completed', 'success', [ok('Set up job', 0, 0), ok('Checkout code', 0, 1), ok('Resolve plan', 1, 1), ok('Upload plan', 1, 1), ok('Complete job', 1, 1)]);

describe('mapStages', () => {
  it('shows everything pending while GitHub has not created a job yet', () => {
    expect(states([], { status: 'queued', conclusion: null })).toEqual({
      checkout: 'pending', dependencies: 'pending', tests: 'pending', aab: 'pending', fastlane: 'pending', play: 'pending',
    });
  });

  it('splits the Tests job into checkout, dependencies and tests by step name', () => {
    const tests = job('Tests', 'in_progress', null, [
      ok('Set up job', 1, 1),
      ok('Checkout code', 1, 2),
      ok('Set up Flutter', 2, 3),
      step('Install dependencies', 'in_progress', null, 3),
      step('Static analysis', 'queued', null),
      step('Unit and widget tests', 'queued', null),
    ]);
    expect(states([planDone(), tests])).toMatchObject({
      checkout: 'success',
      dependencies: 'running',
      tests: 'queued',
      aab: 'pending',
    });
  });

  it('marks the tests stage failed when the unit tests fail, and later stages unreached', () => {
    const tests = job('Tests', 'completed', 'failure', [
      ok('Set up job', 1, 1),
      ok('Checkout code', 1, 2),
      ok('Set up Flutter', 2, 3),
      ok('Install dependencies', 3, 4),
      ok('Static analysis', 4, 5),
      step('Unit and widget tests', 'completed', 'failure', 5, 8),
      step('Translation and widget-key checks', 'completed', 'skipped', 8, 8),
      ok('Upload test results', 8, 8),
      ok('Post Checkout code', 8, 8),
      ok('Complete job', 8, 8),
    ]);
    const skippedBuild = job('Signed AAB', 'completed', 'skipped');
    const skippedPlay = job('Google Play', 'completed', 'skipped');
    const run = { status: 'completed', conclusion: 'failure' };
    const view = mapStages([planDone(), tests, skippedBuild, skippedPlay], run);
    expect(Object.fromEntries(view.map((s) => [s.key, s.state]))).toEqual({
      checkout: 'success', dependencies: 'success', tests: 'failed', aab: 'skipped', fastlane: 'skipped', play: 'skipped',
    });
    // "Post Checkout code" is a trailing step: it belongs to the job's last stage, not to checkout.
    expect(view.find((s) => s.key === 'checkout')!.steps.map((s) => s.name)).not.toContain('Post Checkout code');
    expect(view.find((s) => s.key === 'tests')!.durationMs).toBe(4 * 60_000);
  });

  it('keeps a stage running while its job still has trailing steps to report', () => {
    const tests = job('Tests', 'in_progress', null, [ok('Set up job', 1, 1), ok('Checkout code', 1, 2), ok('Set up Flutter', 2, 3), ok('Install dependencies', 3, 4), ok('Static analysis', 4, 5)]);
    expect(states([planDone(), tests]).tests).toBe('running');
  });

  it('shows a build-only run as done at the AAB with Fastlane and Play not part of it', () => {
    const tests = job('Tests', 'completed', 'success', [ok('Checkout code', 1, 2), ok('Install dependencies', 2, 3), ok('Unit and widget tests', 3, 6)]);
    const build = job('Signed AAB', 'completed', 'success', [ok('Build signed AAB', 6, 12), ok('Verify signature', 12, 12), ok('Upload AAB', 12, 13)]);
    const release = job('Google Play', 'completed', 'skipped');
    expect(states([planDone(), tests, build, release], { status: 'completed', conclusion: 'success' })).toEqual({
      checkout: 'success', dependencies: 'success', tests: 'success', aab: 'success', fastlane: 'skipped', play: 'skipped',
    });
  });

  it('splits the Google Play job into Fastlane setup and the upload itself', () => {
    const release = job('Google Play', 'in_progress', null, [
      ok('Set up job', 13, 13),
      ok('Checkout code', 13, 13),
      ok('Set up Ruby and Fastlane', 13, 14),
      ok('Download AAB', 14, 14),
      ok('Write release notes', 14, 14),
      step('Upload to Google Play', 'in_progress', null, 14),
    ]);
    expect(states([planDone(), release])).toMatchObject({ fastlane: 'success', play: 'running' });
  });

  it('maps the Play access check onto Fastlane and Google Play only', () => {
    const check = job('Google Play access', 'completed', 'failure', [
      ok('Set up job', 1, 1),
      ok('Checkout code', 1, 1),
      ok('Set up Ruby and Fastlane', 1, 2),
      step('Check Play access', 'completed', 'failure', 2, 3),
    ]);
    const skipped = ['Tests', 'Signed AAB', 'Google Play'].map((n) => job(n, 'completed', 'skipped'));
    expect(states([planDone(), check, ...skipped], { status: 'completed', conclusion: 'failure' })).toEqual({
      checkout: 'success', dependencies: 'skipped', tests: 'skipped', aab: 'skipped', fastlane: 'success', play: 'failed',
    });
  });

  it('calls a step cancelled by a job timeout a failure', () => {
    const build = job('Signed AAB', 'completed', 'failure', [ok('Set up job', 6, 6), step('Build signed AAB', 'completed', 'cancelled', 6, 46)]);
    expect(states([planDone(), build], { status: 'completed', conclusion: 'failure' }).aab).toBe('failed');
  });

  it('blames the first stage of a job that died before its first step', () => {
    const tests = job('Tests', 'completed', 'failure', []);
    expect(states([planDone(), tests], { status: 'completed', conclusion: 'failure' })).toMatchObject({
      checkout: 'failed',
      dependencies: 'skipped',
      tests: 'skipped',
    });
  });

  it('turns everything unreached into cancelled when the run was cancelled', () => {
    const tests = job('Tests', 'completed', 'cancelled', [ok('Checkout code', 1, 2), step('Install dependencies', 'completed', 'cancelled', 2, 3)]);
    expect(states([planDone(), tests], { status: 'completed', conclusion: 'cancelled' })).toMatchObject({
      dependencies: 'cancelled',
      aab: 'cancelled',
      play: 'cancelled',
    });
  });

  it('ignores jobs it has no rule for', () => {
    expect(states([job('Some other job', 'completed', 'failure')], { status: 'completed', conclusion: 'failure' }).checkout).toBe('skipped');
  });
});

describe('runState', () => {
  it.each([
    ['queued', null, 'queued'],
    ['in_progress', null, 'running'],
    ['completed', 'success', 'success'],
    ['completed', 'failure', 'failed'],
    ['completed', 'timed_out', 'failed'],
    ['completed', 'startup_failure', 'failed'],
    ['completed', 'cancelled', 'cancelled'],
    ['completed', 'skipped', 'skipped'],
    ['waiting', null, 'waiting'],
  ])('%s/%s → %s', (status, conclusion, expected) => {
    expect(runState({ status, conclusion })).toBe(expected);
  });
});

describe('release markers (same rule as release-plan.sh)', () => {
  it.each([
    ['release: Faster check-in', { track: null, notes: 'Faster check-in' }],
    ['release(beta): Arabic fixes', { track: 'beta', notes: 'Arabic fixes' }],
    ['release(production):Payslips', { track: 'production', notes: 'Payslips' }],
    ['release:', { track: null, notes: '' }],
  ])('%s', (subject, expected) => {
    expect(parseReleaseSubject(subject)).toEqual(expected);
  });

  it.each(['feat: release notes', 'Release: capital', 'release(staging): x', 'released: x'])('%s is not a release', (s) => {
    expect(parseReleaseSubject(s)).toBeNull();
  });

  it('reads version and track from release tags', () => {
    expect(parseReleaseTag('v1.0.2')).toEqual({ version: '1.0.2', track: null });
    expect(parseReleaseTag('v1.0.3-beta')).toEqual({ version: '1.0.3', track: 'beta' });
    expect(parseReleaseTag('release-1')).toBeNull();
    expect(parseReleaseTag('v1.0')).toBeNull();
  });
});

describe('describeRun', () => {
  const base = { head_commit: null, head_branch: 'main' };
  it('reads a console release from its run name', () => {
    expect(describeRun({ ...base, event: 'workflow_dispatch', display_title: 'Release to production · main · a1b2c3' })).toEqual({
      trigger: 'console', mode: 'release', track: 'production', tag: null, requestId: 'a1b2c3', rehearsal: false,
    });
    expect(describeRun({ ...base, event: 'workflow_dispatch', display_title: 'Rehearse release to internal · main · ffffff' })).toMatchObject({
      mode: 'release', track: 'internal', rehearsal: true,
    });
  });
  it('reads console builds and Play checks', () => {
    expect(describeRun({ ...base, event: 'workflow_dispatch', display_title: 'Build and test · feat/x · ffffff' }).mode).toBe('build');
    expect(describeRun({ ...base, event: 'workflow_dispatch', display_title: 'Check Play access · main' })).toMatchObject({ mode: 'validate', requestId: null });
  });
  it('reads release commits and tags', () => {
    expect(describeRun({ ...base, event: 'push', display_title: 'x', head_commit: { id: 'a', message: 'release(alpha): hi\n\nbody', timestamp: '' } })).toMatchObject({ trigger: 'commit', mode: 'release', track: 'alpha' });
    expect(describeRun({ ...base, event: 'push', head_branch: 'v1.2.3-internal', display_title: 'Release tag v1.2.3-internal' })).toMatchObject({ trigger: 'tag', mode: 'release', track: 'internal', tag: 'v1.2.3-internal' });
  });
});
