import type { IosTrack, Plan, Platform, PlayTrack, RunParams, Track } from './types';

/**
 * What a run will do, decided before anything is built. Every refusal is one sentence that
 * says what to fix.
 */
export const TRACKS: readonly PlayTrack[] = ['internal', 'alpha', 'beta', 'production'];
export const IOS_TRACKS: readonly IosTrack[] = ['testflight', 'app_store'];
/** Google Play's "What's new" per language. */
export const MAX_NOTES = 500;
/** TestFlight's "What to Test" and the App Store's "What's New" per language. */
export const MAX_IOS_NOTES = 4000;
const VERSION = /^\d+\.\d+\.\d+$/;
export const MAX_VERSION_CODE = 2_100_000_000;

export class PlanError extends Error {}

export function checkParams(input: unknown): RunParams {
  const p = (input ?? {}) as Partial<Record<keyof RunParams, unknown>>;
  const platform = (p.platform ?? 'android') as Platform;
  if (platform !== 'android' && platform !== 'ios') throw new PlanError('platform must be android or ios.');
  const mode = p.mode;
  if (mode !== 'build' && mode !== 'release') throw new PlanError('mode must be build or release.');
  const ios = platform === 'ios';
  const track = (p.track ?? (ios ? 'testflight' : 'internal')) as Track;
  if (ios ? !IOS_TRACKS.includes(track as IosTrack) : !TRACKS.includes(track as PlayTrack)) {
    throw new PlanError(ios ? `An iOS release goes to: ${IOS_TRACKS.join(' or ')}.` : `track must be one of: ${TRACKS.join(', ')}.`);
  }
  const releaseStatus = p.releaseStatus ?? 'completed';
  if (releaseStatus !== 'completed' && releaseStatus !== 'draft') throw new PlanError('releaseStatus must be completed or draft.');
  const releaseNotes = typeof p.releaseNotes === 'string' ? p.releaseNotes.trim() : '';
  if (mode === 'release' && !releaseNotes) {
    throw new PlanError(ios ? 'Release notes are required: they are the "What to Test" text on TestFlight.' : 'Release notes are required: they are the "What\'s new" text on Google Play.');
  }
  const max = ios ? MAX_IOS_NOTES : MAX_NOTES;
  if (releaseNotes.length > max) {
    throw new PlanError(`Release notes are ${releaseNotes.length} characters; ${ios ? 'App Store Connect' : 'Google Play'} allows ${max}.`);
  }
  const versionName = typeof p.versionName === 'string' ? p.versionName.trim() : '';
  if (versionName && !VERSION.test(versionName)) throw new PlanError(`Version name '${versionName}' is not MAJOR.MINOR.PATCH.`);
  let versionCode: number | null = null;
  if (p.versionCode !== undefined && p.versionCode !== null && p.versionCode !== '') {
    versionCode = Number(p.versionCode);
    if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
      throw new PlanError(`${ios ? 'The build number' : 'versionCode'} must be a whole number between 1 and ${MAX_VERSION_CODE}.`);
    }
  }
  return {
    platform,
    mode,
    track,
    releaseNotes: mode === 'release' ? releaseNotes : '',
    releaseStatus,
    versionName,
    versionCode,
    // Only a release can be rehearsed: there is nothing to validate with the store otherwise.
    rehearsal: mode === 'release' && p.rehearsal === true,
  };
}

/**
 * The version code (Android) or build number (iOS) a run builds: above everything the store
 * has, above every code this console already built for the app on that platform, and not below
 * the project's own build number.
 */
export function chooseVersionCode(o: { pinned: number | null; playHighest: number | null; usedHighest: number; pubspecBuild: number | null; store?: string; unit?: string }): {
  code: number;
  from: string;
} {
  const unit = o.unit ?? 'code';
  if (o.pinned) return { code: o.pinned, from: 'pinned when the run was started' };
  const options: Array<{ code: number; from: string }> = [{ code: 1, from: `the first ${unit} an app can have` }];
  if (o.pubspecBuild) options.push({ code: o.pubspecBuild, from: `pubspec.yaml's build number, ${o.pubspecBuild}` });
  if (o.usedHighest) options.push({ code: o.usedHighest + 1, from: `the last ${unit} this console built for the app, ${o.usedHighest}, + 1` });
  if (o.playHighest) options.push({ code: o.playHighest + 1, from: `${o.store ?? 'Google Play'}'s highest, ${o.playHighest}, + 1` });
  // On a tie the later reason wins: the store's highest is the one people check.
  return options.reduce((best, c) => (c.code >= best.code ? c : best));
}

export function resolvePlan(
  params: RunParams,
  o: { pubspecVersion: string | null; versionCode: { code: number; from: string }; trigger: 'git' | 'upload'; sha: string | null; ref: string; packageName: string },
): Plan {
  const versionName = params.versionName || o.pubspecVersion || '';
  if (!VERSION.test(versionName)) {
    throw new PlanError(
      `Version name '${versionName || '(none)'}' is not MAJOR.MINOR.PATCH (set it in pubspec.yaml, or in the start sheet's More options).`,
    );
  }
  if (o.versionCode.code > MAX_VERSION_CODE) throw new PlanError(`versionCode ${o.versionCode.code} is above Google Play's limit.`);
  return {
    platform: params.platform,
    mode: params.mode,
    trigger: o.trigger,
    tag: null,
    track: params.track,
    releaseStatus: params.releaseStatus,
    versionName,
    versionCode: o.versionCode.code,
    versionCodeFrom: o.versionCode.from,
    integrationTests: false,
    publish: params.mode === 'release',
    rehearsal: params.rehearsal,
    releaseNotes: params.releaseNotes,
    requestId: null,
    commit: o.sha ?? '',
    ref: o.ref,
    packageName: o.packageName,
  };
}
