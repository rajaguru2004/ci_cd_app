import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PLAY_TRACKS, type Mode, type PlayTrack } from './stages';

/** Google Play caps "What's new" at 500 characters per language. */
export const MAX_RELEASE_NOTES = 500;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class StartRunDto {
  @Transform(trim)
  @IsString({ message: 'Pick a branch.' })
  @Matches(/^[A-Za-z0-9._/-]{1,200}$/, { message: 'That is not a branch name.' })
  branch!: string;

  @IsIn(['build', 'release', 'validate'], { message: 'mode must be build, release or validate.' })
  mode!: Mode;

  @IsOptional()
  @IsIn(PLAY_TRACKS, { message: `track must be one of: ${PLAY_TRACKS.join(', ')}.` })
  track?: PlayTrack;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_RELEASE_NOTES, {
    message: `Release notes must be at most ${MAX_RELEASE_NOTES} characters; Google Play allows no more.`,
  })
  releaseNotes?: string;

  @IsOptional()
  @IsIn(['completed', 'draft'], { message: 'releaseStatus must be completed or draft.' })
  releaseStatus?: 'completed' | 'draft';

  @IsOptional()
  @Transform(trim)
  @Matches(/^(\d+\.\d+\.\d+)?$/, { message: 'Version name must be MAJOR.MINOR.PATCH, e.g. 1.0.2.' })
  versionName?: string;

  @IsOptional()
  @IsBoolean()
  integrationTests?: boolean;

  /** Release only: Google Play validates the whole upload, nothing is published. */
  @IsOptional()
  @IsBoolean()
  rehearsal?: boolean;
}

export class PlayKeyDto {
  @IsString({ message: 'Choose the service-account JSON file.' })
  @MaxLength(20_000, { message: 'That file is too large to be a service-account key.' })
  json!: string;
}
