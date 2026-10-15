import { checkParams, chooseVersionCode, resolvePlan } from './plan';

describe('checkParams', () => {
  it('defaults a build to Android, the internal track, rolled out, no rehearsal, no pinned version code', () => {
    expect(checkParams({ mode: 'build' })).toEqual({
      platform: 'android', mode: 'build', track: 'internal', releaseNotes: '', releaseStatus: 'completed', versionName: '', versionCode: null, rehearsal: false,
    });
  });

  it('takes iOS runs to TestFlight by default, and only to TestFlight or App Store review', () => {
    expect(checkParams({ platform: 'ios', mode: 'build' })).toMatchObject({ platform: 'ios', track: 'testflight' });
    expect(checkParams({ platform: 'ios', mode: 'release', track: 'app_store', releaseNotes: 'x' }).track).toBe('app_store');
    expect(() => checkParams({ platform: 'ios', mode: 'build', track: 'internal' })).toThrow('testflight or app_store');
    expect(() => checkParams({ mode: 'build', track: 'testflight' })).toThrow('track must be');
    expect(() => checkParams({ platform: 'windows', mode: 'build' })).toThrow('platform must be');
  });

  it("allows App Store Connect's 4000 characters of notes on iOS", () => {
    expect(checkParams({ platform: 'ios', mode: 'release', releaseNotes: 'a'.repeat(4000) }).releaseNotes).toHaveLength(4000);
    expect(() => checkParams({ platform: 'ios', mode: 'release', releaseNotes: 'a'.repeat(4001) })).toThrow('App Store Connect allows 4000');
    expect(() => checkParams({ platform: 'ios', mode: 'release', releaseNotes: ' ' })).toThrow('What to Test');
  });

  it('requires notes for a release and caps them at 500 characters', () => {
    expect(() => checkParams({ mode: 'release', releaseNotes: '  ' })).toThrow('Release notes are required');
    expect(() => checkParams({ mode: 'release', releaseNotes: 'a'.repeat(501) })).toThrow('allows 500');
    expect(checkParams({ mode: 'release', releaseNotes: 'a'.repeat(500) }).releaseNotes).toHaveLength(500);
  });

  it('only rehearses releases, and drops notes from a build', () => {
    expect(checkParams({ mode: 'build', rehearsal: true, releaseNotes: 'x' })).toMatchObject({ rehearsal: false, releaseNotes: '' });
    expect(checkParams({ mode: 'release', releaseNotes: 'x', rehearsal: true }).rehearsal).toBe(true);
  });

  it('keeps a pinned version code', () => {
    expect(checkParams({ mode: 'build', versionCode: 1012 }).versionCode).toBe(1012);
    expect(checkParams({ mode: 'build', versionCode: null }).versionCode).toBeNull();
  });

  it.each([
    [{ mode: 'deploy' }, 'mode must be'],
    [{ mode: 'build', track: 'staging' }, 'track must be'],
    [{ mode: 'build', releaseStatus: 'halted' }, 'releaseStatus'],
    [{ mode: 'build', versionName: '1.2' }, 'MAJOR.MINOR.PATCH'],
    [{ mode: 'build', versionCode: 0 }, 'versionCode'],
    [{ mode: 'build', versionCode: 1.5 }, 'versionCode'],
  ])('refuses %j', (input, message) => {
    expect(() => checkParams(input)).toThrow(message);
  });
});

describe('chooseVersionCode', () => {
  it('builds above Google Play, above this console\'s own codes and not below pubspec', () => {
    expect(chooseVersionCode({ pinned: null, playHighest: 1009, usedHighest: 1007, pubspecBuild: 9 })).toEqual({ code: 1010, from: "Google Play's highest, 1009, + 1" });
    expect(chooseVersionCode({ pinned: null, playHighest: 9, usedHighest: 1012, pubspecBuild: 9 })).toEqual({ code: 1013, from: 'the last code this console built for the app, 1012, + 1' });
    expect(chooseVersionCode({ pinned: null, playHighest: null, usedHighest: 0, pubspecBuild: 13 })).toEqual({ code: 13, from: "pubspec.yaml's build number, 13" });
    expect(chooseVersionCode({ pinned: null, playHighest: null, usedHighest: 0, pubspecBuild: null }).code).toBe(1);
  });

  it("names Google Play when it and this console's own codes agree", () => {
    expect(chooseVersionCode({ pinned: null, playHighest: 1009, usedHighest: 1009, pubspecBuild: 9 })).toEqual({ code: 1010, from: "Google Play's highest, 1009, + 1" });
  });

  it('keeps a pinned code', () => {
    expect(chooseVersionCode({ pinned: 77, playHighest: 1009, usedHighest: 1, pubspecBuild: 2 })).toEqual({ code: 77, from: 'pinned when the run was started' });
  });

  it('names App Store Connect and build numbers for iOS', () => {
    expect(chooseVersionCode({ pinned: null, playHighest: 41, usedHighest: 0, pubspecBuild: 9, store: 'App Store Connect', unit: 'build number' })).toEqual({
      code: 42,
      from: "App Store Connect's highest, 41, + 1",
    });
    expect(chooseVersionCode({ pinned: null, playHighest: null, usedHighest: 50, pubspecBuild: 9, store: 'App Store Connect', unit: 'build number' }).from).toBe(
      'the last build number this console built for the app, 50, + 1',
    );
  });
});

describe('resolvePlan', () => {
  const params = checkParams({ mode: 'release', track: 'beta', releaseNotes: 'Hi', releaseStatus: 'draft' });
  const base = { versionCode: { code: 1012, from: 'x' }, trigger: 'git' as const, sha: 'abc', ref: 'main', packageName: 'com.x.app' };

  it('takes the version name from pubspec.yaml and records the commit, the branch and the package', () => {
    expect(resolvePlan(params, { ...base, pubspecVersion: '1.0.2' })).toMatchObject({
      mode: 'release', trigger: 'git', track: 'beta', releaseStatus: 'draft', versionName: '1.0.2', versionCode: 1012,
      publish: true, rehearsal: false, releaseNotes: 'Hi', commit: 'abc', ref: 'main', packageName: 'com.x.app',
    });
  });

  it('prefers an override from the start sheet', () => {
    expect(resolvePlan({ ...params, versionName: '9.9.9' }, { ...base, pubspecVersion: '1.0.2' }).versionName).toBe('9.9.9');
  });

  it('refuses a project without a usable version', () => {
    expect(() => resolvePlan(params, { ...base, pubspecVersion: null })).toThrow('(none)');
    expect(() => resolvePlan(params, { ...base, pubspecVersion: '1.0' })).toThrow("'1.0'");
  });
});
