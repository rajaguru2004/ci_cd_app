import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { RunnerKind } from '../builder/builder.types';
import { PLAY_TRACKS, type PlayTrack } from './stages';

/** Google Play caps "What's new" at 500 characters per language. */
export const MAX_RELEASE_NOTES = 500;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => value === true || value === 'true';

/** What a run does; the same fields for a git run (JSON) and a ZIP run (multipart text). */
export class RunOptionsDto {
  @IsIn(['build', 'release'], { message: 'mode must be build or release.' })
  mode!: 'build' | 'release';

  /** Omitted: the app's own default (its settings → Where builds run). */
  @IsOptional()
  @IsIn(['server', 'github'], { message: 'runner must be server or github.' })
  runner?: RunnerKind;

  @IsOptional()
  @IsIn(PLAY_TRACKS, { message: `track must be one of: ${PLAY_TRACKS.join(', ')}.` })
  track?: PlayTrack;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_RELEASE_NOTES, { message: `Release notes must be at most ${MAX_RELEASE_NOTES} characters; Google Play allows no more.` })
  releaseNotes?: string;

  @IsOptional()
  @IsIn(['completed', 'draft'], { message: 'releaseStatus must be completed or draft.' })
  releaseStatus?: 'completed' | 'draft';

  @IsOptional()
  @Transform(trim)
  @Matches(/^(\d+\.\d+\.\d+)?$/, { message: 'Version name must be MAJOR.MINOR.PATCH, e.g. 1.0.2.' })
  versionName?: string;

  /** Release only: Google Play validates the whole upload, nothing is published. */
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  rehearsal?: boolean;
}

/** A run of an app's repository: the branch tip (pulled at start), or one commit. */
export class StartRunDto extends RunOptionsDto {
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9._/-]{1,200}$/, { message: 'That is not a branch name.' })
  branch?: string;

  @IsOptional()
  @Transform(trim)
  @Matches(/^[0-9a-f]{40}$/, { message: 'sha must be a full 40-character commit id.' })
  sha?: string;
}

/** A run of an uploaded source ZIP (multipart: every value arrives as text). */
export class UploadRunDto extends RunOptionsDto {
  @Transform(trim)
  @Matches(/^[a-z0-9][a-z0-9-]{0,47}$/, { message: 'Pick the app this ZIP belongs to.' })
  app!: string;
}

export function params(dto: RunOptionsDto) {
  return {
    mode: dto.mode,
    track: dto.track ?? 'internal',
    releaseNotes: dto.mode === 'release' ? (dto.releaseNotes ?? '') : '',
    releaseStatus: dto.releaseStatus ?? 'completed',
    versionName: dto.versionName ?? '',
    rehearsal: dto.mode === 'release' && dto.rehearsal === true,
  };
}

export function runner(dto: RunOptionsDto): RunnerKind | undefined {
  return dto.runner;
}
