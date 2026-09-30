import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { BuilderConfig } from './config';
import { chownTree, ExtractError, extractZip, pubspecVersion } from './extract';
import type { JobLog } from './log';
import { resolvePlan } from './plan';
import { StepFailed } from './process';
import type { Plan, RunRecord } from './types';

const exec = promisify(execFile);

/**
 * The release pipeline, step for step as .github/workflows/release.yml runs it on GitHub,
 * for a source ZIP uploaded to the console. The job and step names are the console's
 * contract (apps/api/src/pipeline/stages.ts maps them onto the six stages); keep them equal
 * to release.yml's.
 *
 * Every build step runs as the unprivileged `builder` user: the uploaded code (Gradle build
 * scripts, tests) executes there and cannot read the Play key. Only the Fastlane upload, which
 * runs the lanes baked into this image and no uploaded code, gets the key, as root, after
 * every process the build user started has been killed.
 */

export interface RunPaths {
  run: string;
  src: string;
  artifacts: string;
  logs: string;
  play: string;
  upload: string;
}

export interface ShOptions {
  /** Root, not the build user: only for the Fastlane steps, which run no uploaded code. */
  asRoot?: boolean;
  /** Working directory: the project (default) or the run's Fastlane folder. */
  where?: 'project' | 'play';
  env?: Record<string, string>;
}

export interface StepContext {
  cfg: BuilderConfig;
  run: RunRecord;
  paths: RunPaths;
  log: JobLog;
  signal: AbortSignal;
  /** Where pubspec.yaml is, once the Plan job has unpacked the upload. */
  project(): string;
  sh(command: string, opts?: ShOptions): Promise<void>;
  save(): Promise<void>;
}

export interface StepDef {
  name: string;
  /** Runs after an earlier step of its job failed (not after a cancel). */
  always?: boolean;
  /** Runs no matter what, even after a cancel (cleanup). */
  cleanup?: boolean;
  run: (ctx: StepContext) => Promise<void>;
}

export interface JobDef {
  key: string;
  name: string;
  needs: string[];
  timeoutMin: number;
  steps: StepDef[];
}

export const ARTIFACTS = {
  plan: 'pipeline-plan',
  tests: 'test-results',
  aab: 'app-release-aab',
  buildInfo: 'build-info',
  release: 'play-release',
} as const;

const setUp = (jobName: string): StepDef => ({
  name: 'Set up job',
  run: async (ctx) => {
    ctx.log.line(`Runner: ${hostname()} (the console's builder)`);
    ctx.log.line(`Job: ${jobName}`);
    ctx.log.line(`Run: #${ctx.run.id} · ${ctx.run.source.fileName}${ctx.run.source.sha ? ` · commit ${ctx.run.source.sha}` : ''}`);
  },
});

/** Ends a job. Kills whatever the build user left running (a Gradle daemon, a test isolate). */
const complete = (killBuildUser: boolean): StepDef => ({
  name: 'Complete job',
  cleanup: true,
  run: async (ctx) => {
    ctx.log.line('Cleaning up orphan processes');
    if (killBuildUser && process.getuid?.() === 0) {
      await exec('pkill', ['-KILL', '-u', String(ctx.cfg.buildUid)]).catch(() => undefined);
    }
  },
});

const sh = (name: string, command: string, opts: ShOptions = {}): StepDef => ({
  name,
  run: (ctx) => ctx.sh(command, opts),
});

async function copyInto(from: string, toDir: string, name: string): Promise<boolean> {
  try {
    await fs.access(from);
  } catch {
    return false;
  }
  await fs.mkdir(toDir, { recursive: true });
  await fs.copyFile(from, join(toDir, name));
  return true;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function readPlan(paths: RunPaths): Promise<Plan> {
  return JSON.parse(await fs.readFile(join(paths.artifacts, ARTIFACTS.plan, 'plan.json'), 'utf8')) as Plan;
}

const aabPath = (ctx: StepContext) => join(ctx.project(), 'build/app/outputs/bundle/release/app-release.aab');
const mappingPath = (ctx: StepContext) => join(ctx.project(), 'build/app/outputs/mapping/release/mapping.txt');

export function releasePipeline(run: RunRecord): JobDef[] {
  const jobs: JobDef[] = [
    {
      key: 'plan',
      name: 'Plan',
      needs: [],
      timeoutMin: 10,
      steps: [
        setUp('Plan'),
        {
          name: 'Checkout code',
          run: async (ctx) => {
            ctx.log.step(`unzip ${ctx.run.source.fileName}`);
            try {
              const x = await extractZip(ctx.paths.upload, ctx.paths.src, {
                maxBytes: ctx.cfg.maxExtractBytes,
                maxEntries: ctx.cfg.maxEntries,
              });
              ctx.run.source.sha = x.sha;
              ctx.run.source.root = x.rootName;
              await ctx.save();
              ctx.log.line(`Unpacked ${x.files} files (${(x.bytes / 1024 / 1024).toFixed(1)} MB).`);
              ctx.log.line(`Project: ${x.rootName || '(ZIP root)'}`);
              ctx.log.line(x.sha ? `Commit: ${x.sha} (from the ZIP)` : 'Commit: unknown — the ZIP carries no commit id.');
              if (x.skippedLinks) ctx.log.warning(`${x.skippedLinks} symbolic links in the ZIP were not unpacked.`);
            } catch (e) {
              if (e instanceof ExtractError) throw new StepFailed(e.message, null);
              throw e;
            }
            if (process.getuid?.() === 0) await chownTree(ctx.paths.src, ctx.cfg.buildUid, ctx.cfg.buildGid);
          },
        },
        {
          name: 'Resolve plan',
          run: async (ctx) => {
            ctx.log.step('resolve the release plan');
            let plan: Plan;
            try {
              plan = resolvePlan(ctx.run.params, await pubspecVersion(ctx.project()), ctx.run.source.sha, ctx.run.source.fileName);
            } catch (e) {
              throw new StepFailed((e as Error).message, null);
            }
            ctx.run.plan = plan;
            await ctx.save();
            await fs.mkdir(join(ctx.paths.artifacts, ARTIFACTS.plan), { recursive: true });
            await fs.writeFile(join(ctx.paths.artifacts, ARTIFACTS.plan, 'plan.json'), JSON.stringify(plan, null, 2));
            ctx.log.line(`Mode: ${plan.mode}${plan.publish ? ` → Google Play ${plan.track} (${plan.releaseStatus})` : ''}${plan.rehearsal ? ', rehearsal: nothing is published' : ''}`);
            ctx.log.line(`Version: ${plan.versionName} (${plan.versionCode})`);
          },
        },
        {
          name: 'Upload plan',
          run: async (ctx) => {
            ctx.log.step('save plan.json');
            ctx.log.line(`Saved ${ARTIFACTS.plan}/plan.json`);
          },
        },
        complete(false),
      ],
    },
    {
      key: 'tests',
      name: 'Tests',
      needs: ['plan'],
      timeoutMin: 40,
      steps: [
        setUp('Tests'),
        {
          name: 'Checkout code',
          run: async (ctx) => {
            ctx.log.step('use the uploaded source');
            ctx.log.line(ctx.project());
          },
        },
        sh('Set up Flutter', 'flutter --version'),
        sh('Install dependencies', 'flutter pub get'),
        // Errors only, as on GitHub: the tree still carries pre-existing infos and warnings.
        sh('Static analysis', 'flutter analyze --no-fatal-infos --no-fatal-warnings'),
        sh(
          'Unit and widget tests',
          'mkdir -p build/test-results\nflutter test --exclude-tags live --file-reporter json:build/test-results/flutter-test.json',
        ),
        sh(
          'Translation and widget-key checks',
          'if [ -f tool/check_i18n.dart ]; then dart run tool/check_i18n.dart; fi\nif [ -f tool/check_keys.dart ]; then dart run tool/check_keys.dart; fi',
        ),
        {
          name: 'Upload test results',
          always: true,
          run: async (ctx) => {
            ctx.log.step('save the test report');
            const saved = await copyInto(
              join(ctx.project(), 'build/test-results/flutter-test.json'),
              join(ctx.paths.artifacts, ARTIFACTS.tests),
              'flutter-test.json',
            );
            ctx.log.line(saved ? `Saved ${ARTIFACTS.tests}/flutter-test.json` : 'No test report was written.');
          },
        },
        complete(true),
      ],
    },
    {
      key: 'aab',
      name: 'Signed AAB',
      needs: ['tests'],
      timeoutMin: 45,
      steps: [
        setUp('Signed AAB'),
        sh('Set up Java', 'java -version'),
        sh('Build signed AAB', 'flutter build appbundle --release --build-name="$VERSION_NAME" --build-number="$VERSION_CODE"'),
        {
          name: 'Verify signature',
          run: async (ctx) => {
            ctx.log.step('keytool -printcert -jarfile app-release.aab');
            const plan = await readPlan(ctx.paths);
            const aab = aabPath(ctx);
            try {
              await fs.access(aab);
            } catch {
              throw new StepFailed(`No bundle at ${aab}.`, null);
            }
            const { stdout } = await exec('keytool', ['-printcert', '-jarfile', aab], { timeout: 60_000 });
            for (const l of stdout.split('\n').slice(0, 20)) ctx.log.line(l);
            if (/CN=Android Debug/.test(stdout)) {
              throw new StepFailed(
                'The bundle is signed with the debug key (android/key.properties or the keystore is missing from the ZIP); Google Play would refuse it.',
                null,
              );
            }
            const owner = /^Owner: (.*)$/m.exec(stdout)?.[1] ?? '';
            const certSha256 = /^\s*SHA256: (.*)$/m.exec(stdout)?.[1]?.trim() ?? '';
            const info = {
              versionName: plan.versionName,
              versionCode: plan.versionCode,
              sizeBytes: (await fs.stat(aab)).size,
              sha256: await sha256(aab),
              signer: owner,
              certSha256,
              commit: ctx.run.source.sha ?? '',
              ref: ctx.run.source.fileName,
              builtAt: new Date().toISOString(),
            };
            await fs.mkdir(join(ctx.paths.artifacts, ARTIFACTS.buildInfo), { recursive: true });
            await fs.writeFile(join(ctx.paths.artifacts, ARTIFACTS.buildInfo, 'build-info.json'), JSON.stringify(info, null, 2));
            ctx.log.line(JSON.stringify(info));
          },
        },
        {
          name: 'Upload AAB',
          run: async (ctx) => {
            ctx.log.step('save the AAB and the R8 mapping');
            const dir = join(ctx.paths.artifacts, ARTIFACTS.aab);
            await copyInto(aabPath(ctx), join(dir, 'bundle/release'), 'app-release.aab');
            const mapping = await copyInto(mappingPath(ctx), join(dir, 'mapping/release'), 'mapping.txt');
            ctx.log.line(`Saved ${ARTIFACTS.aab}/bundle/release/app-release.aab${mapping ? ' and mapping.txt' : ''}`);
          },
        },
        {
          name: 'Upload build info',
          run: async (ctx) => {
            ctx.log.step('save build-info.json');
            ctx.log.line(`Saved ${ARTIFACTS.buildInfo}/build-info.json`);
          },
        },
        complete(true),
      ],
    },
  ];

  if (run.params.mode === 'release') {
    jobs.push({
      key: 'play',
      name: 'Google Play',
      needs: ['aab'],
      timeoutMin: 20,
      steps: [
        setUp('Google Play'),
        {
          name: 'Checkout code',
          run: async (ctx) => {
            ctx.log.step('copy the Fastlane lanes baked into the builder');
            await fs.mkdir(ctx.paths.play, { recursive: true });
            await fs.cp(join(ctx.cfg.pipelineDir, 'fastlane'), join(ctx.paths.play, 'fastlane'), { recursive: true });
            await fs.copyFile(join(ctx.cfg.pipelineDir, 'Gemfile'), join(ctx.paths.play, 'Gemfile'));
            await fs.copyFile(join(ctx.cfg.pipelineDir, 'Gemfile.lock'), join(ctx.paths.play, 'Gemfile.lock'));
          },
        },
        sh('Set up Ruby and Fastlane', 'bundle exec fastlane --version | tail -n 2', { asRoot: true, where: 'play' }),
        {
          name: 'Download AAB',
          run: async (ctx) => {
            ctx.log.step('use the AAB from the Signed AAB job');
            ctx.log.line(join(ctx.paths.artifacts, ARTIFACTS.aab, 'bundle/release/app-release.aab'));
          },
        },
        {
          name: 'Write release notes',
          run: async (ctx) => {
            const plan = await readPlan(ctx.paths);
            ctx.log.step(`write fastlane/metadata/android/en-US/changelogs/${plan.versionCode}.txt`);
            const dir = join(ctx.paths.play, 'fastlane/metadata/android/en-US/changelogs');
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(join(dir, `${plan.versionCode}.txt`), `${plan.releaseNotes}\n`);
            ctx.log.line(plan.releaseNotes);
          },
        },
        {
          name: 'Upload to Google Play',
          run: async (ctx) => {
            const plan = await readPlan(ctx.paths);
            let key: string;
            try {
              key = await fs.readFile(ctx.cfg.playKeyFile, 'utf8');
            } catch {
              throw new StepFailed(
                `No Google Play key on the builder at ${ctx.cfg.playKeyFile}; mount the service-account JSON (docker-compose.yml, secrets/).`,
                null,
              );
            }
            await ctx.sh('bundle exec fastlane android deploy', {
              asRoot: true,
              where: 'play',
              env: {
                PLAY_SERVICE_ACCOUNT_JSON: key,
                PLAY_TRACK: plan.track,
                PLAY_RELEASE_STATUS: plan.releaseStatus,
                VERSION_NAME: plan.versionName,
                VERSION_CODE: String(plan.versionCode),
                AAB_PATH: join(ctx.paths.artifacts, ARTIFACTS.aab, 'bundle/release/app-release.aab'),
                MAPPING_PATH: join(ctx.paths.artifacts, ARTIFACTS.aab, 'mapping/release/mapping.txt'),
                PLAY_VALIDATE_ONLY: plan.rehearsal ? 'true' : 'false',
              },
            });
          },
        },
        {
          name: 'Upload release info',
          always: true,
          run: async (ctx) => {
            ctx.log.step('save release-info.json');
            const saved = await copyInto(
              join(ctx.paths.play, 'fastlane/release-info.json'),
              join(ctx.paths.artifacts, ARTIFACTS.release),
              'release-info.json',
            );
            ctx.log.line(saved ? `Saved ${ARTIFACTS.release}/release-info.json` : 'Fastlane wrote no release info.');
          },
        },
        complete(false),
      ],
    });
  }
  return jobs;
}
