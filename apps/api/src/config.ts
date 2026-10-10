import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';

/**
 * Everything the console API needs from its environment (`ci_cd_app/.env` through Docker
 * Compose). Read once at boot: a changed `.env` takes effect on `docker compose up -d`.
 *
 * The API holds no repository, signing or Google Play key: those live in the builder's vault.
 * It holds the sign-in password, the session secret, and the token it reaches the builder with.
 */
export interface ConsoleConfig {
  /** Shared password for the console. Empty = nobody can sign in. */
  consolePassword: string;
  sessionSecret: string;
  /** Mark the session cookie Secure (set when the console is served over https). */
  cookieSecure: boolean;
  port: number;
  /** The builder: vault, git and the pipeline. */
  builderUrl: string;
  builderToken: string;
  /** Volume shared with the builder: uploads/ written here, runs/ read here. */
  buildsDir: string;
  /** Largest source ZIP accepted. */
  maxUploadBytes: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const read = (key: string) => (env[key] ?? '').trim();
  const logger = new Logger('Config');

  let sessionSecret = read('SESSION_SECRET');
  if (sessionSecret.length < 32) {
    // Sessions then last until the next restart, which is acceptable for a console that a
    // handful of engineers sign in to; a fixed secret keeps them across restarts.
    sessionSecret = randomBytes(32).toString('hex');
    logger.warn('SESSION_SECRET is unset or shorter than 32 characters; sessions end on restart.');
  }

  const consolePassword = read('CONSOLE_PASSWORD');
  if (!consolePassword) {
    logger.error('CONSOLE_PASSWORD is empty: nobody can sign in until it is set in .env.');
  }

  return {
    consolePassword,
    sessionSecret,
    cookieSecure: read('COOKIE_SECURE') === 'true',
    port: Number(read('PORT') || 3001),
    builderUrl: read('BUILDER_URL').replace(/\/+$/, ''),
    builderToken: read('BUILDER_TOKEN'),
    buildsDir: read('BUILDS_DIR') || '/data',
    maxUploadBytes: Number(read('MAX_UPLOAD_MB') || 500) * 1024 * 1024,
  };
}

export const CONSOLE_CONFIG = Symbol('CONSOLE_CONFIG');
