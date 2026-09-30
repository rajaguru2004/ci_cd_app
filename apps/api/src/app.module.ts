import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Global,
  Inject,
  Module,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MulterModule } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import type { Response } from 'express';
import { mkdir } from 'fs/promises';
import { diskStorage } from 'multer';
import { join } from 'path';
import { AuthController } from './auth/auth.controller';
import { Public, SessionGuard } from './auth/auth.guard';
import { CONSOLE_CONFIG, ConsoleConfig, readConfig } from './config';
import { GithubClient, GithubError } from './github/github.client';
import { BuilderClient, BuilderError } from './local/builder.client';
import { LocalRunsService } from './local/local-runs.service';
import { VersionCodes } from './local/version-codes';
import { PipelineController } from './pipeline/pipeline.controller';
import { PipelineService } from './pipeline/pipeline.service';
import { PlayEditGuard } from './play/edit-guard';
import { PlayClient, PlayError } from './play/play.client';
import { PlayController } from './play/play.controller';
import { SetupController } from './setup/setup.controller';
import { SetupService } from './setup/setup.service';

/** GitHub's, Google's and the builder's refusals reach the browser as the sentence written for them. */
@Catch(GithubError, PlayError, BuilderError)
class UpstreamErrorFilter implements ExceptionFilter {
  catch(error: GithubError | PlayError | BuilderError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(error.status)
      .json({ statusCode: error.status, message: error.message });
  }
}

@Controller('health')
class HealthController {
  constructor(@Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig) {}

  /** For the container health check; says nothing about the tokens beyond whether they are set. */
  @Public()
  @Get()
  health() {
    return {
      ok: true,
      githubConfigured: Boolean(this.config.githubToken),
      builderConfigured: Boolean(this.config.builderUrl && this.config.builderToken),
      repo: this.config.githubRepo,
    };
  }
}

/** The console's configuration, read once and shared (the upload storage needs it too). */
@Global()
@Module({
  providers: [{ provide: CONSOLE_CONFIG, useFactory: () => readConfig() }],
  exports: [CONSOLE_CONFIG],
})
class ConsoleConfigModule {}

@Module({
  imports: [
    ConsoleConfigModule,
    // Uploaded ZIPs go straight to the volume the builder reads, under a name the console
    // chooses (never the browser's file name), capped in size.
    MulterModule.registerAsync({
      inject: [CONSOLE_CONFIG],
      useFactory: (config: ConsoleConfig) => ({
        storage: diskStorage({
          // Created on the first upload, not at boot: a console without a builder never needs it.
          destination: (_req, _file, cb) => {
            const dir = join(config.buildsDir, 'uploads');
            mkdir(dir, { recursive: true }).then(
              () => cb(null, dir),
              (e: Error) => cb(e, dir),
            );
          },
          filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}.zip`),
        }),
        limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 },
      }),
    }),
  ],
  controllers: [HealthController, AuthController, PipelineController, PlayController, SetupController],
  providers: [
    GithubClient,
    PlayClient,
    PlayEditGuard,
    BuilderClient,
    VersionCodes,
    LocalRunsService,
    PipelineService,
    SetupService,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: UpstreamErrorFilter },
  ],
})
export class AppModule {}
