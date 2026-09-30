import { checkParams, resolvePlan } from './plan';

describe('checkParams', () => {
  it('defaults a build to the internal track, rolled out, no rehearsal', () => {
    expect(checkParams({ mode: 'build', versionCode: 1001 })).toEqual({
      mode: 'build', track: 'internal', releaseNotes: '', releaseStatus: 'completed', versionName: '', versionCode: 1001, rehearsal: false,
    });
  });

  it('requires notes for a release and caps them at 500 characters', () => {
    expect(() => checkParams({ mode: 'release', versionCode: 5, releaseNotes: '  ' })).toThrow('Release notes are required');
    expect(() => checkParams({ mode: 'release', versionCode: 5, releaseNotes: 'a'.repeat(501) })).toThrow('allows 500');
    expect(checkParams({ mode: 'release', versionCode: 5, releaseNotes: 'a'.repeat(500) }).releaseNotes).toHaveLength(500);
  });

  it('only rehearses releases', () => {
    expect(checkParams({ mode: 'build', versionCode: 5, rehearsal: true }).rehearsal).toBe(false);
    expect(checkParams({ mode: 'release', versionCode: 5, releaseNotes: 'x', rehearsal: true }).rehearsal).toBe(true);
  });

  it.each([
    [{ mode: 'deploy', versionCode: 1 }, 'mode must be'],
    [{ mode: 'build', track: 'staging', versionCode: 1 }, 'track must be'],
    [{ mode: 'build', releaseStatus: 'halted', versionCode: 1 }, 'releaseStatus'],
    [{ mode: 'build', versionName: '1.2', versionCode: 1 }, 'MAJOR.MINOR.PATCH'],
    [{ mode: 'build', versionCode: 0 }, 'versionCode'],
    [{ mode: 'build', versionCode: 1.5 }, 'versionCode'],
  ])('refuses %j', (input, message) => {
    expect(() => checkParams(input)).toThrow(message);
  });
});

describe('resolvePlan', () => {
  const params = checkParams({ mode: 'release', track: 'beta', versionCode: 1012, releaseNotes: 'Hi', releaseStatus: 'draft' });

  it('takes the version name from pubspec.yaml and the commit from the ZIP', () => {
    expect(resolvePlan(params, '1.0.2', 'abc', 'src.zip')).toMatchObject({
      mode: 'release', trigger: 'upload', track: 'beta', releaseStatus: 'draft', versionName: '1.0.2', versionCode: 1012,
      publish: true, rehearsal: false, releaseNotes: 'Hi', commit: 'abc', ref: 'src.zip',
    });
  });

  it('prefers an override from the start sheet', () => {
    expect(resolvePlan({ ...params, versionName: '9.9.9' }, '1.0.2', null, 'x.zip').versionName).toBe('9.9.9');
  });

  it('refuses a project without a usable version', () => {
    expect(() => resolvePlan(params, null, null, 'x.zip')).toThrow('(none)');
    expect(() => resolvePlan(params, '1.0', null, 'x.zip')).toThrow("'1.0'");
  });
});
