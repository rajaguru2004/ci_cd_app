import { join } from 'path';

/**
 * The builder's settings, from its environment (docker-compose.yml passes only these; it does
 * not get the console's .env). The builder is the only part of the console that holds secrets:
 * the vault key, and through it every SSH key, keystore and Google Play key.
 */
export interface BuilderConfig {
  port: number;
  /** Shared with the console API; every request must carry it. */
  token: string;
  /** Encrypts the vault (AES-256-GCM). Losing it loses every stored key. */
  vaultKey: string;
  /** Shared volume: uploads/ from the API; apps/, vault/, repos/ and runs/ written here. */
  dataDir: string;
  /** Where decrypted secrets live for the seconds an operation needs them (a tmpfs). */
  scratchDir: string;
  /** Fastlane lanes and Gemfile baked into the image (mobile-pipeline/ in the repo). */
  pipelineDir: string;
  /** The console's default Google Play key (mounted read-only); apps may bring their own. */
  playKeyFile: string;
  playApiUrl: string;
  /** The unprivileged account build steps run as (the app's own code executes there). */
  buildUid: number;
  buildGid: number;
  buildHome: string;
  /** Caps Gradle's heap regardless of what the project asks for. */
  gradleHeap: string;
  /** Finished runs kept per app; older ones are deleted. */
  keepRuns: number;
  /** Uploads kept for re-runs. */
  keepUploads: number;
  /** Limits for what an uploaded ZIP may expand to. */
  maxExtractBytes: number;
  maxEntries: number;
  /** How long one git network operation (ls-remote, fetch) may take. */
  gitTimeoutMs: number;
  /** The Flutter the builder has; runs on GitHub Actions set up the same one. */
  flutterVersion: string;
  /** GitHub's REST API, for apps that build on GitHub Actions. */
  githubApiUrl: string;
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): BuilderConfig {
  const token = (env.BUILDER_TOKEN ?? '').trim();
  if (token.length < 32) {
    throw new Error('BUILDER_TOKEN must be set to at least 32 characters (the same value the console API uses).');
  }
  const vaultKey = (env.VAULT_KEY ?? '').trim();
  if (vaultKey.length < 32) {
    throw new Error('VAULT_KEY must be set to at least 32 characters (openssl rand -hex 32); it encrypts the stored keys.');
  }
  const dataDir = env.DATA_DIR || '/data';
  return {
    port: num(env.PORT, 4000),
    token,
    vaultKey,
    dataDir,
    scratchDir: env.SCRATCH_DIR || '/dev/shm',
    pipelineDir: env.PIPELINE_DIR || '/opt/pipeline',
    playKeyFile: env.PLAY_SERVICE_ACCOUNT_FILE || '/run/secrets/play-service-account.json',
    playApiUrl: (env.PLAY_API_URL || 'https://androidpublisher.googleapis.com/androidpublisher/v3').replace(/\/+$/, ''),
    buildUid: num(env.BUILD_UID, 1001),
    buildGid: num(env.BUILD_GID, 1001),
    buildHome: env.BUILD_HOME || '/home/builder',
    gradleHeap: env.GRADLE_HEAP || '4g',
    keepRuns: num(env.KEEP_RUNS, 30),
    keepUploads: num(env.KEEP_UPLOADS, 10),
    maxExtractBytes: num(env.MAX_EXTRACT_BYTES, 3 * 1024 * 1024 * 1024),
    maxEntries: num(env.MAX_ENTRIES, 200_000),
    gitTimeoutMs: num(env.GIT_TIMEOUT_MS, 10 * 60 * 1000),
    flutterVersion: (env.TOOLCHAIN_FLUTTER || '3.47.5').trim(),
    githubApiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

export const dirs = (cfg: Pick<BuilderConfig, 'dataDir'>) => ({
  uploads: join(cfg.dataDir, 'uploads'),
  runs: join(cfg.dataDir, 'runs'),
  apps: join(cfg.dataDir, 'apps'),
  vault: join(cfg.dataDir, 'vault'),
  repos: join(cfg.dataDir, 'repos'),
});
