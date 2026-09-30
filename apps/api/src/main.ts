import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { CONSOLE_CONFIG, ConsoleConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConsoleConfig>(CONSOLE_CONFIG);
  // Requests arrive through the web container (and usually a TLS proxy); both sit on private
  // networks, so X-Forwarded-For from them is trusted and req.ip is the browser's address.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      // One message per field, in the words the DTO wrote.
      stopAtFirstError: true,
    }),
  );
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  new Logger('Console').log(
    `API on :${config.port} for ${config.githubRepo} (${config.workflowFile})` +
      (config.githubToken ? '' : ' — no GITHUB_TOKEN, setup-only mode'),
  );
}

void bootstrap();
