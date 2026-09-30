import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';

/**
 * Everything the console needs from its environment (`ci_cd_app/.env` through Docker
 * Compose). Read once at boot: a changed `.env` takes effect on `docker compose up -d`.
 *
 * The GitHub token is the only credential the console holds. The Google Play key is never
 * stored here: the Setup page encrypts it straight into a GitHub Actions secret.
 */
export interface ConsoleConfig {
  /** Fine-grained token on the mobile repo. Empty = the console runs in setup-only mode. */
  githubToken: string;
  /** `owner/name` of the mobile app repository. */
  githubRepo: string;
  /** File name of the pipeline workflow in that repo. */
  workflowFile: string;
  githubApiUrl: string;
  /** Shared password for the console. Empty = nobody can sign in. */
  consolePassword: string;
  sessionSecret: string;
  /** Mark the session cookie Secure (set when the console is served over https). */
  cookieSecure: boolean;
  port: number;
  /** Google Play service-account key file (Docker: a read-only mount under /run/secrets). */
  playKeyFile: string;
  /** The same key inline, for hosts that pass secrets as variables. Wins over the file. */
  playKeyJson: string;
  /** Package the console reads on Google Play. */
  androidPackage: string;
  playApiUrl: string;
  /** The builder that runs the pipeline for uploaded source ZIPs; empty = uploads are off. */
  builderUrl: string;
  builderToken: string;
  /** Volume shared with the builder: uploads/ written here, runs/ read here. */
  buildsDir: string;
  /** Largest source ZIP accepted. */
  maxUploadBytes: number;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const read = (key: string) => (env[key] ?? '').trim();
  const logger = new Logger('Config');

  const githubRepo =
    read('GITHUB_REPO') || 'the-reciprocal-solutions/human-resource-management-mobile-ess';
  if (!REPO_PATTERN.test(githubRepo)) {
    throw new Error(`GITHUB_REPO must be owner/name; it is '${githubRepo}'.`);
  }

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
    githubToken: read('GITHUB_TOKEN'),
    githubRepo,
    workflowFile: read('WORKFLOW_FILE') || 'release.yml',
    githubApiUrl: (read('GITHUB_API_URL') || 'https://api.github.com').replace(/\/+$/, ''),
    consolePassword,
    sessionSecret,
    cookieSecure: read('COOKIE_SECURE') === 'true',
    port: Number(read('PORT') || 3001),
    playKeyFile: read('PLAY_SERVICE_ACCOUNT_FILE') || '/run/secrets/play-service-account.json',
    playKeyJson: read('PLAY_SERVICE_ACCOUNT_JSON'),
    androidPackage: read('ANDROID_PACKAGE_NAME') || 'com.fusionapps.fusionhrm',
    playApiUrl: (read('PLAY_API_URL') || 'https://androidpublisher.googleapis.com/androidpublisher/v3').replace(/\/+$/, ''),
    builderUrl: read('BUILDER_URL').replace(/\/+$/, ''),
    builderToken: read('BUILDER_TOKEN'),
    buildsDir: read('BUILDS_DIR') || '/data',
    maxUploadBytes: Number(read('MAX_UPLOAD_MB') || 500) * 1024 * 1024,
  };
}

export const CONSOLE_CONFIG = Symbol('CONSOLE_CONFIG');
