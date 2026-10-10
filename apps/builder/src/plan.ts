import type { Plan, PlayTrack, RunParams } from './types';

/**
 * What a run will do, decided before anything is built. Every refusal is one sentence that
 * says what to fix.
 */
export const TRACKS: readonly PlayTrack[] = ['internal', 'alpha', 'beta', 'production'];
export const MAX_NOTES = 500;
const VERSION = /^\d+\.\d+\.\d+$/;
export const MAX_VERSION_CODE = 2_100_000_000;

export class PlanError extends Error {}

export function checkParams(input: unknown): RunParams {
  const p = (input ?? {}) as Partial<Record<keyof RunParams, unknown>>;
  const mode = p.mode;
  if (mode !== 'build' && mode !== 'release') throw new PlanError('mode must be build or release.');
  const track = (p.track ?? 'internal') as PlayTrack;
  if (!TRACKS.includes(track)) throw new PlanError(`track must be one of: ${TRACKS.join(', ')}.`);
  const releaseStatus = p.releaseStatus ?? 'completed';
  if (releaseStatus !== 'completed' && releaseStatus !== 'draft') throw new PlanError('releaseStatus must be completed or draft.');
  const releaseNotes = typeof p.releaseNotes === 'string' ? p.releaseNotes.trim() : '';
  if (mode === 'release' && !releaseNotes) {
    throw new PlanError('Release notes are required: they are the "What\'s new" text on Google Play.');
  }
  if (releaseNotes.length > MAX_NOTES) {
    throw new PlanError(`Release notes are ${releaseNotes.length} characters; Google Play allows ${MAX_NOTES}.`);
  }
  const versionName = typeof p.versionName === 'string' ? p.versionName.trim() : '';
  if (versionName && !VERSION.test(versionName)) throw new PlanError(`Version name '${versionName}' is not MAJOR.MINOR.PATCH.`);
  let versionCode: number | null = null;
  if (p.versionCode !== undefined && p.versionCode !== null && p.versionCode !== '') {
    versionCode = Number(p.versionCode);
    if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
      throw new PlanError(`versionCode must be a whole number between 1 and ${MAX_VERSION_CODE}.`);
    }
  }
  return {
    mode,
    track,
    releaseNotes: mode === 'release' ? releaseNotes : '',
    releaseStatus,
    versionName,
    versionCode,
    // Only a release can be rehearsed: there is nothing to validate with Google otherwise.
    rehearsal: mode === 'release' && p.rehearsal === true,
  };
}

/**
 * The version code a run builds: above everything Google Play has, above every code this
 * console already built for the app, and not below the project's own build number.
 */
export function chooseVersionCode(o: { pinned: number | null; playHighest: number | null; usedHighest: number; pubspecBuild: number | null }): {
  code: number;
  from: string;
} {
  if (o.pinned) return { code: o.pinned, from: 'pinned when the run was started' };
  const options: Array<{ code: number; from: string }> = [{ code: 1, from: 'the first code an app can have' }];
  if (o.pubspecBuild) options.push({ code: o.pubspecBuild, from: `pubspec.yaml's build number, ${o.pubspecBuild}` });
  if (o.usedHighest) options.push({ code: o.usedHighest + 1, from: `the last code this console built for the app, ${o.usedHighest}, + 1` });
  if (o.playHighest) options.push({ code: o.playHighest + 1, from: `Google Play's highest, ${o.playHighest}, + 1` });
  // On a tie the later reason wins: Google Play's highest is the one people check.
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
