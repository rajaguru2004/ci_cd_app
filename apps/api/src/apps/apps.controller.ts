import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { BuilderClient } from '../builder/builder.client';

class RepoDto {
  @IsOptional()
  @IsString({ message: "Paste the repository's SSH URL." })
  @MaxLength(300)
  url?: string;

  @IsOptional()
  @IsString({ message: 'Pick the SSH key that reaches this repository.' })
  @MaxLength(40)
  keyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  path?: string;
}

class CreateAppDto {
  @IsString({ message: 'Give the app a name.' })
  @MaxLength(60, { message: 'Keep the app name under 60 characters.' })
  name!: string;

  @IsString({ message: 'Enter the Android package name (applicationId).' })
  @MaxLength(150)
  packageName!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RepoDto)
  repo?: RepoDto;
}

class UpdateAppDto {
  @IsOptional()
  @IsString()
  @MaxLength(60, { message: 'Keep the app name under 60 characters.' })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  packageName?: string;

  /** null disconnects the repository (the app then builds from ZIPs only). */
  @IsOptional()
  @ValidateNested()
  @Type(() => RepoDto)
  repo?: RepoDto | null;
}

class SigningDto {
  /** The keystore file, base64. */
  @IsString({ message: 'Choose the keystore file (.jks, .keystore or .p12).' })
  @MaxLength(1_500_000, { message: 'That file is too large to be a keystore.' })
  keystore!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;

  @IsString({ message: 'Enter the keystore password.' })
  @MaxLength(500)
  storePassword!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyAlias?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyPassword?: string;
}

class PlayKeyDto {
  @IsString({ message: 'Choose the service-account JSON file.' })
  @MaxLength(20_000, { message: 'That file is too large to be a service-account key.' })
  json!: string;
}

class RunnerDto {
  @IsIn(['server', 'github'], { message: 'runner must be server or github.' })
  kind!: 'server' | 'github';
}

class GithubTokenDto {
  @IsString({ message: 'Paste the GitHub token.' })
  @MaxLength(255)
  token!: string;
}

class IosDto {
  @IsString({ message: 'Enter the bundle ID (CFBundleIdentifier), e.g. com.company.app.' })
  @MaxLength(155)
  bundleId!: string;
}

class IosCertificateDto {
  /** The .p12, base64. */
  @IsString({ message: 'Choose the certificate’s .p12 file.' })
  @MaxLength(200_000, { message: 'That file is too large to be an exported certificate (.p12).' })
  p12!: string;

  @IsString({ message: 'Enter the .p12 password.' })
  @MaxLength(500)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;
}

class IosProfileDto {
  /** The .mobileprovision, base64. */
  @IsString({ message: 'Choose the .mobileprovision file.' })
  @MaxLength(800_000, { message: 'That file is too large to be a provisioning profile.' })
  data!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;
}

class AppStoreKeyDto {
  @IsString({ message: 'Enter the key ID.' })
  @MaxLength(20)
  keyId!: string;

  @IsString({ message: 'Enter the issuer ID.' })
  @MaxLength(60)
  issuerId!: string;

  /** The .p8's text. */
  @IsString({ message: 'Choose the .p8 key file.' })
  @MaxLength(5000, { message: 'That file is too large to be an App Store Connect key.' })
  p8!: string;
}

/**
 * The organization's apps. Secrets go one way: a keystore or a Play key is handed to the
 * builder's vault and never comes back; answers carry its certificate or account, not the key.
 */
@Controller('apps')
export class AppsController {
  constructor(private readonly builder: BuilderClient) {}

  @Get()
  list() {
    return this.builder.apps();
  }

  @Post()
  create(@Body() dto: CreateAppDto) {
    return this.builder.createApp({ ...dto });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.builder.app(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAppDto) {
    return this.builder.updateApp(id, { ...dto });
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.builder.deleteApp(id);
  }

  /** ls-remote again with the app's key, and record the answer on the app. */
  @Post(':id/access')
  access(@Param('id') id: string) {
    return this.builder.recheckAccess(id);
  }

  @Put(':id/signing')
  signing(@Param('id') id: string, @Body() dto: SigningDto) {
    return this.builder.setSigning(id, { ...dto });
  }

  /** Back to the project's own signing (its key.properties); the stored keystore is deleted. */
  @Delete(':id/signing')
  clearSigning(@Param('id') id: string) {
    return this.builder.clearSigning(id);
  }

  @Put(':id/play')
  playKey(@Param('id') id: string, @Body() dto: PlayKeyDto) {
    return this.builder.setPlayKey(id, dto.json);
  }

  @Delete(':id/play')
  clearPlayKey(@Param('id') id: string) {
    return this.builder.clearPlayKey(id);
  }

  /** What is on every Google Play track for this app right now. */
  @Get(':id/play')
  play(@Param('id') id: string, @Query('refresh') refresh?: string) {
    return this.builder.play(id, refresh === '1');
  }

  /** Where Build and Release run by default for this app: this server, or GitHub Actions. */
  @Put(':id/runner')
  setRunner(@Param('id') id: string, @Body() dto: RunnerDto) {
    return this.builder.setRunner(id, dto.kind);
  }

  /** The app's own GitHub token; without one it uses the console's default (Setup). */
  @Put(':id/github/token')
  setGithubToken(@Param('id') id: string, @Body() dto: GithubTokenDto) {
    return this.builder.setGithubToken(id, dto.token);
  }

  @Delete(':id/github/token')
  clearGithubToken(@Param('id') id: string) {
    return this.builder.clearGithubToken(id);
  }

  /** Checks the token, the repository, the workflow file and the Actions secrets again. */
  @Post(':id/github/check')
  checkGithub(@Param('id') id: string) {
    return this.builder.checkGithub(id);
  }

  /** The workflow the console writes into the app's repository. */
  @Get(':id/github/workflow')
  githubWorkflow(@Param('id') id: string) {
    return this.builder.githubWorkflow(id);
  }

  /** Commits the workflow to the repository's default branch, or opens a pull request. */
  @Post(':id/github/workflow')
  installGithubWorkflow(@Param('id') id: string) {
    return this.builder.installGithubWorkflow(id);
  }

  /** Copies the app's upload key and Google Play key into the repository's Actions secrets. */
  @Post(':id/github/secrets')
  syncGithubSecrets(@Param('id') id: string) {
    return this.builder.syncGithubSecrets(id);
  }

  // ─── iOS (built and released on a Mac runner) ──────────────────────────────────────

  /** Turns the app's iOS side on, or changes its bundle ID. */
  @Put(':id/ios')
  setIos(@Param('id') id: string, @Body() dto: IosDto) {
    return this.builder.setIos(id, dto.bundleId);
  }

  /** Back to Android only: the certificate, profiles and App Store Connect key are deleted. */
  @Delete(':id/ios')
  clearIos(@Param('id') id: string) {
    return this.builder.clearIos(id);
  }

  @Put(':id/ios/certificate')
  setIosCertificate(@Param('id') id: string, @Body() dto: IosCertificateDto) {
    return this.builder.setIosCertificate(id, { ...dto });
  }

  @Delete(':id/ios/certificate')
  clearIosCertificate(@Param('id') id: string) {
    return this.builder.clearIosCertificate(id);
  }

  @Post(':id/ios/profiles')
  addIosProfile(@Param('id') id: string, @Body() dto: IosProfileDto) {
    return this.builder.addIosProfile(id, { ...dto });
  }

  @Delete(':id/ios/profiles/:uuid')
  removeIosProfile(@Param('id') id: string, @Param('uuid') uuid: string) {
    return this.builder.removeIosProfile(id, uuid);
  }

  @Put(':id/ios/app-store')
  setAppStoreKey(@Param('id') id: string, @Body() dto: AppStoreKeyDto) {
    return this.builder.setAppStoreKey(id, { ...dto });
  }

  @Delete(':id/ios/app-store')
  clearAppStoreKey(@Param('id') id: string) {
    return this.builder.clearAppStoreKey(id);
  }

  /** What App Store Connect says about the app now: found by its bundle ID, its latest builds. */
  @Get(':id/ios/app-store')
  appStore(@Param('id') id: string, @Query('refresh') refresh?: string) {
    return this.builder.appStore(id, refresh === '1');
  }
}
