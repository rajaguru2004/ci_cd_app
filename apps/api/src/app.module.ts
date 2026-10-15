import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, Global, Inject, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MulterModule } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import type { Response } from 'express';
import { mkdir } from 'fs/promises';
import { diskStorage } from 'multer';
import { join } from 'path';
import { AppsController } from './apps/apps.controller';
import { AuthController } from './auth/auth.controller';
import { Public, SessionGuard } from './auth/auth.guard';
import { BuilderClient, BuilderError } from './builder/builder.client';
import { CONSOLE_CONFIG, ConsoleConfig, readConfig } from './config';
import { GithubController } from './github.controller';
import { KeysController } from './keys/keys.controller';
import { RunnerGatewayController } from './runners/runner-gateway.controller';
import { RunnersController } from './runners/runners.controller';
import { RunsController } from './runs/runs.controller';
import { RunsService } from './runs/runs.service';
import { SetupController } from './setup.controller';

/** The builder's refusals reach the browser as the sentence written for them. */
@Catch(BuilderError)
class UpstreamErrorFilter implements ExceptionFilter {
  catch(error: BuilderError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(error.status).json({ statusCode: error.status, message: error.message });
  }
}

@Controller('health')
class HealthController {
  constructor(@Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig) {}

  /** For the container health check; says nothing beyond whether the builder is configured. */
  @Public()
  @Get()
  health() {
    return { ok: true, builderConfigured: Boolean(this.config.builderUrl && this.config.builderToken) };
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
  controllers: [HealthController, AuthController, AppsController, KeysController, RunsController, SetupController, GithubController, RunnersController, RunnerGatewayController],
  providers: [
    BuilderClient,
    RunsService,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: UpstreamErrorFilter },
  ],
})
export class AppModule {}
