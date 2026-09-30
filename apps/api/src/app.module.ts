import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Inject,
  Module,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Response } from 'express';
import { AuthController } from './auth/auth.controller';
import { Public, SessionGuard } from './auth/auth.guard';
import { CONSOLE_CONFIG, ConsoleConfig, readConfig } from './config';
import { GithubClient, GithubError } from './github/github.client';
import { PipelineController } from './pipeline/pipeline.controller';
import { PipelineService } from './pipeline/pipeline.service';
import { PlayClient, PlayError } from './play/play.client';
import { PlayController } from './play/play.controller';
import { SetupController } from './setup/setup.controller';
import { SetupService } from './setup/setup.service';

/** GitHub's and Google's refusals reach the browser as the sentence the client wrote. */
@Catch(GithubError, PlayError)
class GithubErrorFilter implements ExceptionFilter {
  catch(error: GithubError | PlayError, host: ArgumentsHost): void {
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

  /** For the container health check; says nothing about the token beyond whether one is set. */
  @Public()
  @Get()
  health() {
    return { ok: true, githubConfigured: Boolean(this.config.githubToken), repo: this.config.githubRepo };
  }
}

@Module({
  controllers: [HealthController, AuthController, PipelineController, PlayController, SetupController],
  providers: [
    { provide: CONSOLE_CONFIG, useFactory: () => readConfig() },
    GithubClient,
    PlayClient,
    PipelineService,
    SetupService,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: GithubErrorFilter },
  ],
})
export class AppModule {}
