import type { Plan, PlayTrack, RunParams } from './types';

/**
 * The same rules release-plan.sh applies to a console run on GitHub, for a run on this
 * server. Every refusal is one sentence that says what to fix.
 */
export const TRACKS: readonly PlayTrack[] = ['internal', 'alpha', 'beta', 'production'];
export const MAX_NOTES = 500;
const VERSION = /^\d+\.\d+\.\d+$/;

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
  const versionCode = Number(p.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new PlanError('versionCode must be a whole number between 1 and 2100000000.');
  }
  return {
    mode,
    track,
    releaseNotes,
    releaseStatus,
    versionName,
    versionCode,
    // Only a release can be rehearsed: there is nothing to validate with Google otherwise.
    rehearsal: mode === 'release' && p.rehearsal === true,
  };
}

export function resolvePlan(params: RunParams, pubspecVersion: string | null, sha: string | null, fileName: string): Plan {
  const versionName = params.versionName || pubspecVersion || '';
  if (!VERSION.test(versionName)) {
    throw new PlanError(
      `Version name '${versionName || '(none)'}' is not MAJOR.MINOR.PATCH (set it in pubspec.yaml or in the start sheet).`,
    );
  }
  return {
    mode: params.mode,
    trigger: 'upload',
    tag: null,
    track: params.track,
    releaseStatus: params.releaseStatus,
    versionName,
    versionCode: params.versionCode,
    integrationTests: false,
    publish: params.mode === 'release',
    rehearsal: params.rehearsal,
    releaseNotes: params.releaseNotes,
    requestId: null,
    commit: sha ?? '',
    ref: fileName,
  };
}
