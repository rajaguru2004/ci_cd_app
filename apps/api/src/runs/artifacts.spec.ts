import { errorLines, parseFlutterTestReport } from './artifacts';

const ev = (o: object) => JSON.stringify(o);

describe('parseFlutterTestReport', () => {
  const report = [
    ev({ type: 'start', time: 0 }),
    ev({ type: 'suite', suite: { id: 0, path: 'test/leave_test.dart' }, time: 1 }),
    ev({ type: 'testStart', test: { id: 1, name: 'loading test/leave_test.dart', suiteID: 0 }, time: 2 }),
    ev({ type: 'testDone', testID: 1, result: 'success', hidden: true, skipped: false, time: 900 }),
    ev({ type: 'testStart', test: { id: 2, name: 'leave balance rounds half days', suiteID: 0 }, time: 901 }),
    ev({ type: 'testDone', testID: 2, result: 'success', hidden: false, skipped: false, time: 950 }),
    ev({ type: 'testStart', test: { id: 3, name: 'check-in refuses outside the geofence', suiteID: 0 }, time: 951 }),
    ev({ type: 'print', testID: 3, message: 'noise', time: 952 }),
    ev({ type: 'error', testID: 3, error: 'Expected: <true>\n  Actual: <false>', stackTrace: 'package:test_api expect\ntest/leave_test.dart 42:5', isFailure: true, time: 960 }),
    ev({ type: 'error', testID: 3, error: 'second error, a consequence', stackTrace: '', isFailure: false, time: 961 }),
    ev({ type: 'testDone', testID: 3, result: 'failure', hidden: false, skipped: false, time: 962 }),
    ev({ type: 'testStart', test: { id: 4, name: 'skipped on CI', suiteID: 0 }, time: 963 }),
    ev({ type: 'testDone', testID: 4, result: 'success', hidden: false, skipped: true, time: 963 }),
    'not json at all',
    ev({ type: 'done', success: false, time: 1000 }),
  ].join('\n');

  it('counts visible tests and ignores the runner loading entries', () => {
    const s = parseFlutterTestReport(report);
    expect(s).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1, durationMs: 1000, success: false, truncatedFailures: 0 });
  });

  it('keeps the first error of a failing test with its suite path', () => {
    const [f] = parseFlutterTestReport(report).failures;
    expect(f).toEqual({
      name: 'check-in refuses outside the geofence',
      suite: 'test/leave_test.dart',
      error: 'Expected: <true>\n  Actual: <false>',
      stack: 'package:test_api expect\ntest/leave_test.dart 42:5',
    });
  });

  it('counts a file that failed to load as a failure', () => {
    const s = parseFlutterTestReport(
      [
        ev({ type: 'suite', suite: { id: 0, path: 'test/broken_test.dart' } }),
        ev({ type: 'testStart', test: { id: 1, name: 'loading test/broken_test.dart', suiteID: 0 } }),
        ev({ type: 'error', testID: 1, error: 'Compilation failed', stackTrace: '' }),
        ev({ type: 'testDone', testID: 1, result: 'error', hidden: false, skipped: false }),
      ].join('\n'),
    );
    expect(s.failed).toBe(1);
    expect(s.failures[0].error).toBe('Compilation failed');
    expect(s.success).toBeNull();
  });

  it('caps the listed failures and says how many more there are', () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      lines.push(ev({ type: 'testStart', test: { id: i, name: `t${i}`, suiteID: 0 } }));
      lines.push(ev({ type: 'testDone', testID: i, result: 'failure', hidden: false, skipped: false }));
    }
    const s = parseFlutterTestReport(lines.join('\n'));
    expect(s.failures).toHaveLength(50);
    expect(s.truncatedFailures).toBe(10);
  });
});

describe('errorLines', () => {
  it('returns the ::error:: messages and drops the generic exit-code line', () => {
    const log = [
      '2026-09-29T10:00:00.0000000Z ##[group]Run bash .github/scripts/release-plan.sh',
      '2026-09-29T10:00:01.0000000Z ##[error]Release notes are required: they are the "What\'s new" text on Google Play.',
      '2026-09-29T10:00:01.1000000Z ##[error]Process completed with exit code 1.',
    ].join('\n');
    expect(errorLines(log)).toEqual(['Release notes are required: they are the "What\'s new" text on Google Play.']);
  });

  it('keeps the exit-code line when it is all there is', () => {
    expect(errorLines('2026-09-29T10:00:01.1Z ##[error]Process completed with exit code 1.')).toEqual(['Process completed with exit code 1.']);
  });
});
