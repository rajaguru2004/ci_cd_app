import { join } from 'path';

/**
 * The builder's settings, from its environment (docker-compose.yml passes only these; it does
 * not get the console's .env, so it never holds the GitHub token).
 */
export interface BuilderConfig {
  port: number;
  /** Shared with the console API; every request must carry it. */
  token: string;
  /** Shared volume: uploads/ from the API, runs/ written here. */
  dataDir: string;
  /** Fastlane lanes and Gemfile baked into the image (mobile-pipeline/ in the repo). */
  pipelineDir: string;
  playKeyFile: string;
  /** The unprivileged account build steps run as (uploaded code executes there). */
  buildUid: number;
  buildGid: number;
  buildHome: string;
  /** Caps Gradle's heap regardless of what the project asks for (the app asks for 8 GB). */
  gradleHeap: string;
  /** Finished runs whose artifacts are kept; older ones are deleted. */
  keepRuns: number;
  /** Uploads kept for re-runs. */
  keepUploads: number;
  /** Limits for what an uploaded ZIP may expand to. */
  maxExtractBytes: number;
  maxEntries: number;
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
  const dataDir = env.DATA_DIR || '/data';
  return {
    port: num(env.PORT, 4000),
    token,
    dataDir,
    pipelineDir: env.PIPELINE_DIR || '/opt/pipeline',
    playKeyFile: env.PLAY_SERVICE_ACCOUNT_FILE || '/run/secrets/play-service-account.json',
    buildUid: num(env.BUILD_UID, 1001),
    buildGid: num(env.BUILD_GID, 1001),
    buildHome: env.BUILD_HOME || '/home/builder',
    gradleHeap: env.GRADLE_HEAP || '4g',
    keepRuns: num(env.KEEP_RUNS, 30),
    keepUploads: num(env.KEEP_UPLOADS, 10),
    maxExtractBytes: num(env.MAX_EXTRACT_BYTES, 3 * 1024 * 1024 * 1024),
    maxEntries: num(env.MAX_ENTRIES, 200_000),
  };
}

export const dirs = (cfg: Pick<BuilderConfig, 'dataDir'>) => ({
  uploads: join(cfg.dataDir, 'uploads'),
  runs: join(cfg.dataDir, 'runs'),
});
