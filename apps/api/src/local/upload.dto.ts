import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { MAX_RELEASE_NOTES } from '../pipeline/pipeline.dto';
import { PLAY_TRACKS, type PlayTrack } from '../pipeline/stages';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * The fields sent with a source ZIP (multipart, so every value arrives as text). A build on
 * this server can build or release; the Play access check needs no build and stays on GitHub.
 */
export class UploadRunDto {
  @IsIn(['build', 'release'], { message: 'mode must be build or release for an uploaded ZIP.' })
  mode!: 'build' | 'release';

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
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  rehearsal?: boolean;
}
