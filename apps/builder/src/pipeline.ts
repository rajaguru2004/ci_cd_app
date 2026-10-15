import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { GithubActions } from './actions';
import { AppError, type AppStore } from './apps';
import { AppStoreError, type AppStoreClient } from './appstore';
import type { BuilderConfig } from './config';
import { chownTree, ExtractError, extractZip } from './extract';
import { GitError, parseRepoUrl, type Git } from './git';
import { iosProblems, parseBundleIds, profileFor } from './ios';
import type { JobLog } from './log';
import { macJobs } from './mac-jobs';
import type { MacPool } from './macs';
import { chooseVersionCode, PlanError, resolvePlan } from './plan';
import type { PlayClient } from './play';
import { execArgv, StepCancelled, StepFailed } from './process';
import { describeDir, describeProject, locateProject, pickProjectPath, type ProjectInfo } from './project';
import { bundleSigner, resignBundle, sameFingerprint, SigningError, throwawayKeystore } from './signing';
import type { Plan, Platform, RunRecord } from './types';
import { PROJECT_CHECKS_SCRIPT, REMOTE_JOBS, TESTS_SCRIPT, type WorkflowPlan } from './workflow';

const exec = promisify(execFile);

/**
 * The release pipeline every run executes, for an app's repository at a commit or for an
 * uploaded ZIP: Plan (checkout, project checks, version code) → Tests → Signed AAB → Google
 * Play. The job and step names are the console's contract: apps/api maps them onto six stages.
 * A run on GitHub Actions plans here the same way, then its jobs run on GitHub under the same
 * names (githubPipeline below, and the workflow in workflow.ts). An iOS run plans here too,
 * then a Mac runner runs Tests → Signed IPA → App Store Connect (iosPipeline, and mac-jobs.ts).
 *
 * Every build step runs as the unprivileged `builder` user: the app's own code (Gradle
 * scripts, tests) executes there and can read no key. git with the SSH key, signing with the
 * upload key and Fastlane with the Play key run as root, in steps that run none of the app's
 * code, after the build user's processes have been killed.
 */

export interface RunPaths {
  run: string;
  src: string;
  artifacts: string;
  logs: string;
  play: string;
  signing: string;
  /** The uploaded ZIP, for a ZIP run. */
  upload: string;
}

export interface ShOptions {
  /** Root, not the build user: only for steps that run none of the app's code. */
  asRoot?: boolean;
  /** Working directory: the project (default) or the run's Fastlane folder. */
  where?: 'project' | 'play';
  env?: Record<string, string>;
}

/** What steps reach besides the run itself. */
export interface Services {
  apps: AppStore;
  git: Git;
  play: PlayClient;
  github: GithubActions;
  appStore: AppStoreClient;
  macs: MacPool;
  /** Version codes (Android) or build numbers (iOS) this console's other runs of the app planned. */
  usedVersionCodes(appId: string, exceptRunId: number, platform: Platform): Promise<number[]>;
  /** Runs `fn` alone among the app's runs (choosing a version code must not race). */
  lockApp<T>(appId: string, fn: () => Promise<T>): Promise<T>;
}

export interface StepContext {
  cfg: BuilderConfig;
  run: RunRecord;
  paths: RunPaths;
  log: JobLog;
  signal: AbortSignal;
  services: Services;
  /** Where pubspec.yaml is, once the Plan job has checked the source out. */
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
  /** Runs on GitHub Actions: the console only mirrors it (its steps are what GitHub will report). */
  remote?: boolean;
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
    const remote = ctx.run.remote;
    ctx.log.line(
      remote?.kind === 'github'
        ? `Runner: ${hostname()} (the console's builder) plans this run; GitHub Actions (${remote.repo}) runs its jobs`
        : remote?.kind === 'mac'
          ? `Runner: ${hostname()} (the console's builder) plans this run; a Mac runner builds and releases it`
          : `Runner: ${hostname()} (the console's builder)`,
    );
    const ios = ctx.run.params.platform === 'ios';
    ctx.log.line(`App: ${ctx.run.app?.name ?? 'unknown'} (${(ios ? ctx.run.app?.bundleId : ctx.run.app?.packageName) ?? '?'}${ios ? ', iOS' : ''}) · run #${ctx.run.number}`);
    ctx.log.line(`Job: ${jobName}`);
    const s = ctx.run.source;
    ctx.log.line(s.kind === 'git' ? `Source: ${s.url} · ${s.requestedSha ?? s.branch}` : `Source: ${s.fileName} (uploaded ZIP)`);
  },
});

/** Kills whatever the build user left running (a Gradle or Kotlin daemon, a test isolate). */
async function killBuildUser(ctx: StepContext): Promise<void> {
  if (process.getuid?.() === 0) await exec('pkill', ['-KILL', '-u', String(ctx.cfg.buildUid)]).catch(() => undefined);
}

const complete = (killBuild: boolean): StepDef => ({
  name: 'Complete job',
  cleanup: true,
  run: async (ctx) => {
    ctx.log.line('Cleaning up orphan processes');
    if (killBuild) await killBuildUser(ctx);
  },
});

const sh = (name: string, command: string, opts: ShOptions = {}): StepDef => ({ name, run: (ctx) => ctx.sh(command, opts) });

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

/** Turns a known failure into the step's one-line error; anything else stays an error. */
function asStep(e: unknown): unknown {
  if (e instanceof GitError || e instanceof AppError || e instanceof ExtractError || e instanceof PlanError || e instanceof SigningError) {
    return new StepFailed(e.message, null);
  }
  return e;
}

const savedAab = (ctx: StepContext) => join(ctx.paths.artifacts, ARTIFACTS.aab, 'bundle/release/app-release.aab');

/** The bundle Gradle wrote: release/app-release.aab, or the only .aab under bundle/ (a flavor's). */
async function builtAab(ctx: StepContext): Promise<string | null> {
  const base = join(ctx.project(), 'build/app/outputs/bundle');
  const plain = join(base, 'release/app-release.aab');
  if (await fs.access(plain).then(() => true, () => false)) return plain;
  const found: string[] = [];
  for (const dir of await fs.readdir(base).catch(() => [] as string[])) {
    for (const f of await fs.readdir(join(base, dir)).catch(() => [] as string[])) if (f.endsWith('.aab')) found.push(join(base, dir, f));
  }
  return found.length === 1 ? found[0] : null;
}

// ─── Checkout ──────────────────────────────────────────────────────────────────────────

/** git fetch into the app's mirror, then the commit the run builds, recorded on the run. */
async function pullCommit(ctx: StepContext): Promise<{ appId: string; sha: string } | null> {
  const source = ctx.run.source;
  if (source.kind !== 'git' || !ctx.run.app) return null;
  const app = await ctx.services.apps.require(ctx.run.app.id);
  if (!app.repo) throw new StepFailed(`${app.name} no longer has a repository; build it from a ZIP, or connect the repository in its settings.`, null);
  const repo = parseRepoUrl(source.url);
  ctx.log.step(`git fetch origin (${repo.url})`);
  try {
    await ctx.services.git.fetch(app.id, repo, app.repo.keyId, { log: ctx.log, signal: ctx.signal });
    await ctx.services.apps.noteAccess(app.id, null);
  } catch (e) {
    if (e instanceof GitError) await ctx.services.apps.noteAccess(app.id, e.message);
    throw e;
  }
  const sha = await ctx.services.git.resolve(app.id, source.requestedSha ? { sha: source.requestedSha } : { branch: source.branch });
  if (!sha) {
    throw new StepFailed(
      source.requestedSha
        ? `Commit ${source.requestedSha.slice(0, 7)} is not in ${repo.path.replace(/\.git$/, '')} any more (rewritten history?).`
        : `${repo.path.replace(/\.git$/, '')} has no branch '${source.branch}'.`,
      null,
    );
  }
  source.sha = sha;
  source.commit = await ctx.services.git.commitInfo(app.id, sha);
  await ctx.save();
  ctx.log.line(`Commit ${sha} on ${source.branch}: ${source.commit.subject}`);
  ctx.log.line(`by ${source.commit.author} <${source.commit.email}>, ${source.commit.date}`);
  return { appId: app.id, sha };
}

async function checkoutGit(ctx: StepContext): Promise<void> {
  const pulled = await pullCommit(ctx);
  const source = ctx.run.source;
  if (!pulled || source.kind !== 'git' || !ctx.run.app) return;
  const app = await ctx.services.apps.require(pulled.appId);
  if (!app.repo) throw new StepFailed(`${app.name} no longer has a repository.`, null);
  const repo = parseRepoUrl(source.url);
  const sha = pulled.sha;
  ctx.log.step(`git checkout --detach ${sha.slice(0, 12)}`);
  await ctx.services.git.checkout(app.id, repo, app.repo.keyId, sha, ctx.paths.src, { log: ctx.log, signal: ctx.signal });
  const root = await locateProject(ctx.paths.src, ctx.run.app.projectPath);
  if (root === null) {
    throw new StepFailed(
      ctx.run.app.projectPath
        ? `There is no pubspec.yaml in ${ctx.run.app.projectPath}/ at this commit; check the app's project folder.`
        : 'No pubspec.yaml at the top of the repository or one or two folders down: the console builds Flutter apps.',
      null,
    );
  }
  source.root = root;
  await ctx.save();
  ctx.log.line(`Project: ${root || '(repository root)'}`);
}

async function checkoutZip(ctx: StepContext): Promise<void> {
  const source = ctx.run.source;
  if (source.kind !== 'zip') return;
  ctx.log.step(`unzip ${source.fileName}`);
  const x = await extractZip(ctx.paths.upload, ctx.paths.src, { maxBytes: ctx.cfg.maxExtractBytes, maxEntries: ctx.cfg.maxEntries }, ctx.run.app?.projectPath ?? '');
  source.sha = x.sha;
  source.root = x.rootName;
  await ctx.save();
  ctx.log.line(`Unpacked ${x.files} files (${(x.bytes / 1024 / 1024).toFixed(1)} MB).`);
  ctx.log.line(`Project: ${x.rootName || '(ZIP root)'}`);
  ctx.log.line(x.sha ? `Commit: ${x.sha} (from the ZIP)` : 'Commit: unknown — the ZIP carries no commit id.');
  if (x.skippedLinks) ctx.log.warning(`${x.skippedLinks} symbolic links in the ZIP were not unpacked.`);
}

// ─── Plan ──────────────────────────────────────────────────────────────────────────────

async function plan(ctx: StepContext, info: ProjectInfo): Promise<void> {
  ctx.log.step('read the project and choose the version');
  const runApp = ctx.run.app;
  if (!runApp) throw new StepFailed('This run belongs to no app.', null);
  if (!info.flutter) throw new StepFailed(`${info.path || 'The'} pubspec.yaml does not depend on Flutter: the console builds Flutter apps.`, null);
  if (info.applicationId && info.applicationId !== runApp.packageName) {
    throw new StepFailed(
      `This project builds ${info.applicationId} (android/app/${info.gradleFile?.replace('android/app/', '') ?? 'build.gradle'}), but ${runApp.name} releases ${runApp.packageName}. ` +
        'Build the right repository, or correct the package name in the app’s settings.',
      null,
    );
  }
  if (!info.applicationId) ctx.log.warning(`The applicationId could not be read from the Gradle file; Google Play will check it is ${runApp.packageName}.`);
  if (runApp.signing === 'repository' && !info.keyProperties) {
    ctx.log.warning('The project has no android/key.properties and the console holds no upload key for this app: the build may be debug-signed, which the Signed AAB job refuses.');
  }

  const app = await ctx.services.apps.get(runApp.id);
  let playHighest: number | null = null;
  let playError: string | null = null;
  const key = app ? await ctx.services.apps.playKey(app).catch((e: unknown) => {
    playError = (e as Error).message;
    return null;
  }) : null;
  if (key) {
    try {
      playHighest = (await ctx.services.play.snapshot(runApp.packageName, key.key, true)).highestVersionCode;
      ctx.log.line(`Google Play (${key.key.client_email}): highest versionCode ${playHighest ?? 'none yet'}.`);
    } catch (e) {
      playError = (e as Error).message;
    }
  } else if (!playError) {
    playError = 'there is no Google Play key for this app (upload one in its settings, or mount the console’s default key)';
  }
  if (playError) {
    if (ctx.run.params.mode === 'release') throw new StepFailed(`Google Play could not be read for ${runApp.packageName}: ${playError}`, null);
    ctx.log.warning(`Google Play was not read (${playError}); the version code comes from this console's runs and pubspec.yaml.`);
  }
  const source = ctx.run.source;
  // Two runs of one app planning at once (GitHub runs do not queue) must not take one code.
  const result = await ctx.services.lockApp(runApp.id, async () => {
    const used = await ctx.services.usedVersionCodes(runApp.id, ctx.run.id, 'android');
    const versionCode = chooseVersionCode({
      pinned: ctx.run.params.versionCode,
      playHighest,
      usedHighest: used.length ? Math.max(...used) : 0,
      pubspecBuild: info.buildNumber,
    });
    const planned = resolvePlan(ctx.run.params, {
      pubspecVersion: info.versionName,
      versionCode,
      trigger: source.kind === 'git' ? 'git' : 'upload',
      sha: source.sha,
      ref: source.kind === 'git' ? source.branch : source.fileName,
      packageName: runApp.packageName,
    });
    ctx.run.plan = planned;
    await ctx.save();
    return planned;
  });
  await fs.mkdir(join(ctx.paths.artifacts, ARTIFACTS.plan), { recursive: true });
  await fs.writeFile(join(ctx.paths.artifacts, ARTIFACTS.plan, 'plan.json'), JSON.stringify(result, null, 2));
  ctx.log.line(`Mode: ${result.mode}${result.publish ? ` → Google Play ${result.track} (${result.releaseStatus})` : ''}${result.rehearsal ? ', rehearsal: nothing is published' : ''}`);
  ctx.log.line(`Version: ${result.versionName} (${result.versionCode}) — the code is ${result.versionCodeFrom}.`);
  ctx.log.line(`Signing: ${runApp.signing === 'console' ? "the console's upload key, applied after the build" : "the project's own (android/key.properties)"}.`);
}

// ─── Signing ───────────────────────────────────────────────────────────────────────────

async function prepareSigning(ctx: StepContext): Promise<void> {
  ctx.log.step('keytool -genkeypair (a throwaway key for Gradle)');
  const tw = await throwawayKeystore(ctx.paths.signing, process.getuid?.() === 0 ? ctx.cfg.buildUid : undefined, process.getuid?.() === 0 ? ctx.cfg.buildGid : undefined);
  await fs.writeFile(join(ctx.paths.run, '.throwaway'), JSON.stringify(tw), { mode: 0o600 });
  ctx.log.line("Gradle signs with a key made for this build alone, so the project's own signing config is never used.");
  ctx.log.line("The upload key is applied to the finished bundle afterwards, outside the build: the app's code never sees it.");
}

async function buildAab(ctx: StepContext): Promise<void> {
  if (ctx.run.app?.signing !== 'console') {
    return ctx.sh('flutter build appbundle --release --build-name="$VERSION_NAME" --build-number="$VERSION_CODE"');
  }
  const tw = JSON.parse(await fs.readFile(join(ctx.paths.run, '.throwaway'), 'utf8')) as { file: string; password: string; alias: string };
  return ctx.sh(
    [
      'flutter build appbundle --release --build-name="$VERSION_NAME" --build-number="$VERSION_CODE" \\',
      '  -Pandroid.injected.signing.store.file="$RC_THROWAWAY_FILE" -Pandroid.injected.signing.store.password="$RC_THROWAWAY_PASS" \\',
      '  -Pandroid.injected.signing.key.alias="$RC_THROWAWAY_ALIAS" -Pandroid.injected.signing.key.password="$RC_THROWAWAY_PASS"',
    ].join('\n'),
    { env: { RC_THROWAWAY_FILE: tw.file, RC_THROWAWAY_PASS: tw.password, RC_THROWAWAY_ALIAS: tw.alias } },
  );
}

async function saveAab(ctx: StepContext): Promise<void> {
  ctx.log.step('save the bundle and the R8 mapping');
  // Nothing the build started may touch the bundle once the console has it.
  await killBuildUser(ctx);
  const aab = await builtAab(ctx);
  if (!aab) throw new StepFailed('Gradle wrote no bundle under build/app/outputs/bundle/.', null);
  const dir = join(ctx.paths.artifacts, ARTIFACTS.aab);
  await copyInto(aab, join(dir, 'bundle/release'), 'app-release.aab');
  const mapping = await copyInto(join(ctx.project(), 'build/app/outputs/mapping/release/mapping.txt'), join(dir, 'mapping/release'), 'mapping.txt');
  ctx.log.line(`Saved ${ARTIFACTS.aab}/bundle/release/app-release.aab${mapping ? ' and the R8 mapping' : ' (no R8 mapping: minification is off)'}`);
}

async function signWithUploadKey(ctx: StepContext): Promise<void> {
  ctx.log.step("jarsigner app-release.aab (the app's upload key, from the console's vault)");
  const key = ctx.run.app ? await ctx.services.apps.uploadKey(ctx.run.app.id) : null;
  if (!key) {
    throw new StepFailed(`${ctx.run.app?.name ?? 'This app'} is set to be signed by the console, but it holds no upload key: upload the keystore in the app's settings → Signing.`, null);
  }
  await resignBundle(savedAab(ctx), key, ctx.cfg.scratchDir, ctx.log);
}

async function verifySignature(ctx: StepContext): Promise<void> {
  ctx.log.step('keytool -printcert -jarfile app-release.aab');
  const plan = await readPlan(ctx.paths);
  const aab = savedAab(ctx);
  const signer = await bundleSigner(aab);
  for (const l of signer.text.split('\n').slice(0, 14)) ctx.log.line(l);
  if (signer.debug) {
    throw new StepFailed(
      "The bundle is signed with Android's debug key: the project has no release signing. Upload the app's upload keystore in its settings → Signing; Google Play refuses debug-signed bundles.",
      null,
    );
  }
  if (!signer.owner) throw new StepFailed('The bundle carries no signature.', null);
  if (ctx.run.app?.signing === 'console') {
    const app = await ctx.services.apps.get(ctx.run.app.id);
    const expected = app?.signing.certificate?.sha256;
    if (expected && !sameFingerprint(expected, signer.sha256)) {
      throw new StepFailed(`The bundle is signed by ${signer.owner}, not by the upload key stored for the app (${expected.slice(0, 23)}…).`, null);
    }
  }
  const info = {
    versionName: plan.versionName,
    versionCode: plan.versionCode,
    sizeBytes: (await fs.stat(aab)).size,
    sha256: await sha256(aab),
    signer: signer.owner,
    certSha256: signer.sha256,
    commit: ctx.run.source.sha ?? '',
    ref: plan.ref,
    packageName: plan.packageName,
    signedBy: ctx.run.app?.signing === 'console' ? 'console' : 'repository',
    builtAt: new Date().toISOString(),
  };
  await fs.mkdir(join(ctx.paths.artifacts, ARTIFACTS.buildInfo), { recursive: true });
  await fs.writeFile(join(ctx.paths.artifacts, ARTIFACTS.buildInfo, 'build-info.json'), JSON.stringify(info, null, 2));
  ctx.log.line(JSON.stringify(info));
}

// ─── The pipeline ──────────────────────────────────────────────────────────────────────

export function releasePipeline(run: RunRecord): JobDef[] {
  if (run.params.platform === 'ios') return iosPipeline(run);
  if (run.runner === 'github') return githubPipeline(run);
  const consoleSigning = run.app?.signing === 'console';
  const jobs: JobDef[] = [
    {
      key: 'plan',
      name: 'Plan',
      needs: [],
      timeoutMin: 30,
      steps: [
        setUp('Plan'),
        {
          name: 'Checkout code',
          run: async (ctx) => {
            try {
              if (ctx.run.source.kind === 'git') await checkoutGit(ctx);
              else await checkoutZip(ctx);
            } catch (e) {
              throw asStep(e);
            }
            if (process.getuid?.() === 0) await chownTree(ctx.paths.src, ctx.cfg.buildUid, ctx.cfg.buildGid);
          },
        },
        {
          name: 'Resolve plan',
          run: async (ctx) => {
            try {
              await plan(ctx, await describeDir(ctx.paths.src, ctx.run.source.root ?? ''));
            } catch (e) {
              throw asStep(e);
            }
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
        sh('Set up Flutter', 'flutter --version'),
        sh('Install dependencies', 'flutter pub get'),
        // Errors only: infos and warnings do not fail a release.
        sh('Static analysis', 'flutter analyze --no-fatal-infos --no-fatal-warnings'),
        sh('Unit and widget tests', TESTS_SCRIPT),
        sh('Project checks', PROJECT_CHECKS_SCRIPT),
        {
          name: 'Save test results',
          always: true,
          run: async (ctx) => {
            ctx.log.step('save the test report');
            const saved = await copyInto(join(ctx.project(), 'build/test-results/flutter-test.json'), join(ctx.paths.artifacts, ARTIFACTS.tests), 'flutter-test.json');
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
        ...(consoleSigning ? [{ name: 'Prepare signing', run: (ctx: StepContext) => prepareSigning(ctx).catch((e: unknown) => Promise.reject(asStep(e))) }] : []),
        { name: 'Build AAB', run: buildAab },
        { name: 'Save AAB', run: saveAab },
        ...(consoleSigning
          ? [{ name: 'Sign with the upload key', run: (ctx: StepContext) => signWithUploadKey(ctx).catch((e: unknown) => Promise.reject(asStep(e))) }]
          : []),
        { name: 'Verify signature', run: verifySignature },
        complete(true),
      ],
    },
  ];

  if (run.params.mode === 'release') {
    jobs.push({
      key: 'play',
      name: 'Google Play',
      needs: ['aab'],
      timeoutMin: 30,
      steps: [
        setUp('Google Play'),
        {
          name: 'Prepare Fastlane',
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
          name: 'Write release notes',
          run: async (ctx) => {
            const p = await readPlan(ctx.paths);
            ctx.log.step(`write fastlane/metadata/android/en-US/changelogs/${p.versionCode}.txt`);
            const dir = join(ctx.paths.play, 'fastlane/metadata/android/en-US/changelogs');
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(join(dir, `${p.versionCode}.txt`), `${p.releaseNotes}\n`);
            ctx.log.line(p.releaseNotes);
          },
        },
        {
          name: 'Upload to Google Play',
          run: async (ctx) => {
            const p = await readPlan(ctx.paths);
            const app = ctx.run.app ? await ctx.services.apps.get(ctx.run.app.id) : null;
            const key = app ? await ctx.services.apps.playKey(app) : null;
            if (!key) {
              throw new StepFailed(`There is no Google Play key for ${p.packageName}: upload one in the app's settings, or mount the console's default key.`, null);
            }
            await ctx.sh('bundle exec fastlane android deploy', {
              asRoot: true,
              where: 'play',
              env: {
                PLAY_SERVICE_ACCOUNT_JSON: key.json,
                PLAY_PACKAGE_NAME: p.packageName,
                PLAY_TRACK: p.track,
                PLAY_RELEASE_STATUS: p.releaseStatus,
                VERSION_NAME: p.versionName,
                VERSION_CODE: String(p.versionCode),
                AAB_PATH: join(ctx.paths.artifacts, ARTIFACTS.aab, 'bundle/release/app-release.aab'),
                MAPPING_PATH: join(ctx.paths.artifacts, ARTIFACTS.aab, 'mapping/release/mapping.txt'),
                PLAY_VALIDATE_ONLY: p.rehearsal ? 'true' : 'false',
              },
            });
          },
        },
        {
          name: 'Save release info',
          always: true,
          run: async (ctx) => {
            ctx.log.step('save release-info.json');
            const saved = await copyInto(join(ctx.paths.play, 'fastlane/release-info.json'), join(ctx.paths.artifacts, ARTIFACTS.release), 'release-info.json');
            ctx.log.line(saved ? `Saved ${ARTIFACTS.release}/release-info.json` : 'Fastlane wrote no release info.');
          },
        },
        complete(false),
      ],
    });
  }
  return jobs;
}

// ─── On GitHub Actions ─────────────────────────────────────────────────────────────────

/** The steps GitHub will report for each job of the workflow, shown queued until it does. */
export const REMOTE_STEPS: Record<(typeof REMOTE_JOBS)[number], string[]> = {
  Tests: ['Set up job', 'Checkout code', 'Set up Flutter', 'Install dependencies', 'Static analysis', 'Unit and widget tests', 'Project checks', 'Save test results', 'Complete job'],
  'Signed AAB': ['Set up job', 'Checkout code', 'Set up Java', 'Set up Flutter', 'Install dependencies', 'Prepare signing', 'Build AAB', 'Save AAB', 'Upload the built AAB', 'Complete job'],
  'Sign AAB': ['Set up job', 'Download AAB', 'Set up Java', 'Sign with the upload key', 'Verify signature', 'Save AAB', 'Save build info', 'Complete job'],
  'Google Play': ['Set up job', 'Prepare Fastlane', 'Set up Ruby and Fastlane', 'Install Fastlane', 'Download AAB', 'Write release notes', 'Upload to Google Play', 'Save release info', 'Complete job'],
};

/** Reads the commit straight out of the mirror: GitHub checks it out itself. */
async function readCommit(ctx: StepContext): Promise<void> {
  const pulled = await pullCommit(ctx);
  if (!pulled || !ctx.run.app) throw new StepFailed('A run on GitHub Actions builds a commit of the app’s repository.', null);
  const files = await ctx.services.git.files(pulled.appId, pulled.sha);
  const root = pickProjectPath(files, ctx.run.app.projectPath);
  if (root === null) {
    throw new StepFailed(
      ctx.run.app.projectPath
        ? `There is no pubspec.yaml in ${ctx.run.app.projectPath}/ at this commit; check the app's project folder.`
        : 'No pubspec.yaml at the top of the repository or one or two folders down: the console builds Flutter apps.',
      null,
    );
  }
  ctx.run.source.root = root;
  await ctx.save();
  ctx.log.line(`Project: ${root || '(repository root)'} — GitHub Actions checks out the same commit.`);
}

async function planFromMirror(ctx: StepContext): Promise<void> {
  const source = ctx.run.source;
  if (!ctx.run.app || !source.sha) throw new StepFailed('The commit was not read.', null);
  const appId = ctx.run.app.id;
  const sha = source.sha;
  await plan(ctx, await describeProject((rel) => ctx.services.git.show(appId, sha, rel), source.root ?? ''));
}

async function copySecrets(ctx: StepContext): Promise<void> {
  ctx.log.step(`check the Actions secrets of ${ctx.run.remote?.kind === 'github' ? ctx.run.remote.repo : 'the repository'}`);
  const app = await ctx.services.apps.require(ctx.run.app?.id ?? '');
  await ctx.services.github.ensureSecrets(app, ctx.log);
}

async function startOnGithub(ctx: StepContext): Promise<void> {
  const remote = ctx.run.remote;
  const source = ctx.run.source;
  if (remote?.kind !== 'github' || !ctx.run.app || source.kind !== 'git' || !source.sha) throw new StepFailed('This run has nothing to start on GitHub.', null);
  const app = await ctx.services.apps.require(ctx.run.app.id);
  const p = await readPlan(ctx.paths);
  const what = p.mode === 'release' ? `${p.rehearsal ? 'Rehearsal' : 'Release'} → ${p.track}` : 'Build and test';
  const plan: WorkflowPlan = {
    title: `${app.name} #${ctx.run.number} · ${what} [${remote.requestId}]`,
    requestId: remote.requestId,
    app: app.id,
    run: ctx.run.number,
    mode: p.mode,
    sha: source.sha,
    ref: source.branch,
    projectDir: source.root || '.',
    submodules: (await ctx.services.git.show(app.id, source.sha, '.gitmodules')) !== null ? 'recursive' : 'false',
    flutterVersion: ctx.cfg.flutterVersion,
    packageName: p.packageName,
    signing: ctx.run.app.signing,
    certSha256: ctx.run.app.signing === 'console' ? (ctx.run.app.certSha256 ?? '') : '',
    versionName: p.versionName,
    versionCode: p.versionCode,
    track: p.track,
    releaseStatus: p.releaseStatus,
    rehearsal: p.rehearsal,
    notes: p.releaseNotes,
  };
  ctx.log.step(`start ${remote.workflow} on ${remote.repo} (${source.sha.slice(0, 12)})`);
  remote.dispatchedAt = new Date().toISOString();
  await ctx.save();
  const res = await ctx.services.github.dispatch(app, plan, ctx.log);
  if (!res.runId) {
    throw new StepFailed(
      `GitHub took the dispatch, but the run did not show up in ${remote.repo}'s Actions list in time, so the console cannot follow it. Look for “${plan.title}” there.`,
      null,
    );
  }
  remote.runId = res.runId;
  remote.url = res.url ?? `https://github.com/${remote.repo}/actions/runs/${res.runId}`;
  await ctx.save();
  ctx.log.line(`Running on GitHub Actions: ${remote.url}`);
  // A cancel that came while GitHub was starting the run reaches it now.
  if (ctx.signal.aborted) throw new StepCancelled();
}

/**
 * A run on GitHub Actions: the console plans it here (pull, project checks, version code, the
 * repository's secrets), starts the workflow, then mirrors GitHub's jobs into the record.
 */
export function githubPipeline(run: RunRecord): JobDef[] {
  const guard = (fn: (ctx: StepContext) => Promise<void>) => async (ctx: StepContext) => {
    try {
      await fn(ctx);
    } catch (e) {
      throw asStep(e);
    }
  };
  const planJob: JobDef = {
    key: 'plan',
    name: 'Plan',
    needs: [],
    timeoutMin: 30,
    steps: [
      setUp('Plan'),
      { name: 'Checkout code', run: guard(readCommit) },
      { name: 'Resolve plan', run: guard(planFromMirror) },
      { name: 'Copy secrets to GitHub', run: guard(copySecrets) },
      { name: 'Start on GitHub Actions', run: guard(startOnGithub) },
      complete(false),
    ],
  };
  const remote = REMOTE_JOBS.filter((name) => name !== 'Google Play' || run.params.mode === 'release').map(
    (name): JobDef => ({
      key: name,
      name,
      needs: ['plan'],
      timeoutMin: 0,
      remote: true,
      steps: REMOTE_STEPS[name].map((step) => ({ name: step, run: async () => undefined })),
    }),
  );
  return [planJob, ...remote];
}

// ─── iOS, on a Mac runner ──────────────────────────────────────────────────────────────

/** The packed source a Mac downloads, next to the run's record. */
export const sourceArchive = (paths: RunPaths) => join(paths.run, 'source.tar.gz');

async function planIos(ctx: StepContext): Promise<void> {
  ctx.log.step('read the project and choose the build number');
  const runApp = ctx.run.app;
  if (!runApp) throw new StepFailed('This run belongs to no app.', null);
  const app = await ctx.services.apps.require(runApp.id);
  const ios = app.ios;
  if (!ios) throw new StepFailed(`${app.name} has no iOS setup: add its bundle ID, certificate and profile in its settings → iOS.`, null);
  const root = ctx.run.source.root ?? '';
  const info = await describeDir(ctx.paths.src, root);
  if (!info.flutter) throw new StepFailed(`${info.path || 'The'} pubspec.yaml does not depend on Flutter: the console builds Flutter apps.`, null);
  const pbxproj = await fs.readFile(join(ctx.paths.src, root, 'ios/Runner.xcodeproj/project.pbxproj'), 'utf8').catch(() => null);
  if (pbxproj === null) {
    throw new StepFailed(`${root ? `${root}/` : 'The project '}has no ios/Runner.xcodeproj: add iOS to the Flutter project (flutter create --platforms ios .) and commit it.`, null);
  }
  const ids = parseBundleIds(pbxproj);
  if (!ids.includes(ios.bundleId)) {
    if (ids.some((id) => id.includes('$('))) {
      ctx.log.warning(`The project sets its bundle ID through a build variable; the Mac checks the built IPA is ${ios.bundleId}.`);
    } else {
      const built = ids.filter((id) => !/Tests$/.test(id));
      throw new StepFailed(
        `This project builds ${built.join(', ') || 'no bundle ID'} (ios/Runner.xcodeproj), but ${app.name} releases ${ios.bundleId} on iOS. ` +
          'Build the right repository, or correct the bundle ID in the app’s settings → iOS.',
        null,
      );
    }
  }
  const release = ctx.run.params.mode === 'release';
  const problems = iosProblems(ios, app.name, release);
  if (problems.length) throw new StepFailed(problems.join(' '), null);
  // Extensions are signed too: each needs an App Store profile of its own (or a wildcard).
  for (const id of ids.filter((x) => x !== ios.bundleId && x.startsWith(`${ios.bundleId}.`) && !/Tests$/.test(x))) {
    if (!profileFor(ios, id)) {
      throw new StepFailed(`The project also signs ${id} (an extension of the app), and no App Store profile covers it: upload its profile in the app’s settings → iOS.`, null);
    }
  }

  let storeHighest: number | null = null;
  let storeError: string | null = null;
  const key = await ctx.services.apps.appStoreKey(app);
  if (key) {
    try {
      const snap = await ctx.services.appStore.snapshot(key, ios.bundleId, true);
      storeHighest = snap.highestBuild;
      await ctx.services.apps.noteAppStore(app.id, { appId: snap.appId, appName: snap.appName, message: null });
      ctx.log.line(`App Store Connect (key ${key.keyId}): ${snap.appName}, highest build ${storeHighest ?? 'none yet'}.`);
    } catch (e) {
      storeError = (e as Error).message;
      // Only App Store Connect's own refusal is kept on the app; a network hiccup is not a setup problem.
      if (e instanceof AppStoreError && !e.transient) await ctx.services.apps.noteAppStore(app.id, { appId: null, appName: null, message: e.message });
    }
  } else {
    storeError = 'there is no App Store Connect API key for this app (add one in its settings → iOS)';
  }
  if (storeError) {
    if (release) throw new StepFailed(`App Store Connect could not be read for ${ios.bundleId}: ${storeError}`, null);
    ctx.log.warning(`App Store Connect was not read (${storeError}); the build number comes from this console's runs and pubspec.yaml.`);
  }

  const source = ctx.run.source;
  const result = await ctx.services.lockApp(runApp.id, async () => {
    const used = await ctx.services.usedVersionCodes(runApp.id, ctx.run.id, 'ios');
    const versionCode = chooseVersionCode({
      pinned: ctx.run.params.versionCode,
      playHighest: storeHighest,
      usedHighest: used.length ? Math.max(...used) : 0,
      pubspecBuild: info.buildNumber,
      store: 'App Store Connect',
      unit: 'build number',
    });
    const planned = resolvePlan(ctx.run.params, {
      pubspecVersion: info.versionName,
      versionCode,
      trigger: source.kind === 'git' ? 'git' : 'upload',
      sha: source.sha,
      ref: source.kind === 'git' ? source.branch : source.fileName,
      packageName: ios.bundleId,
    });
    ctx.run.plan = planned;
    await ctx.save();
    return planned;
  });
  await fs.mkdir(join(ctx.paths.artifacts, ARTIFACTS.plan), { recursive: true });
  await fs.writeFile(join(ctx.paths.artifacts, ARTIFACTS.plan, 'plan.json'), JSON.stringify(result, null, 2));
  const where = result.track === 'app_store' ? 'App Store review' : 'TestFlight';
  ctx.log.line(`Mode: ${result.mode}${result.publish ? ` → ${where}${result.track === 'app_store' ? ` (${result.releaseStatus === 'draft' ? 'released by hand once approved' : 'released once approved'})` : ''}` : ''}${result.rehearsal ? ', rehearsal: App Store Connect validates the IPA, nothing is uploaded' : ''}`);
  ctx.log.line(`Version: ${result.versionName} (build ${result.versionCode}) — the build number is ${result.versionCodeFrom}.`);
  const profile = profileFor(ios, ios.bundleId);
  ctx.log.line(`Signing: ${ios.certificate?.name ?? '?'} with ${profile?.name ?? '?'} (expires ${profile?.expiresAt.slice(0, 10) ?? '?'}).`);
}

async function packSource(ctx: StepContext): Promise<void> {
  const out = sourceArchive(ctx.paths);
  ctx.log.step('tar -czf source.tar.gz (the checkout without .git, for the Mac)');
  const res = await execArgv('tar', ['-czf', out, '--exclude=.git', '--owner=0', '--group=0', '--numeric-owner', '-C', ctx.paths.src, '.'], {
    signal: ctx.signal,
    timeoutMs: 15 * 60_000,
  });
  if (res.code !== 0) throw new StepFailed(`Could not pack the source for the Mac: ${res.stderr.trim().split('\n').pop() ?? ''}`, res.code);
  await fs.chmod(out, 0o600);
  const size = (await fs.stat(out)).size;
  const sum = await sha256(out);
  await fs.writeFile(join(ctx.paths.run, 'source.json'), JSON.stringify({ sizeBytes: size, sha256: sum }));
  ctx.log.line(`Packed ${(size / 1024 / 1024).toFixed(1)} MB (sha256 ${sum.slice(0, 16)}…) for the Mac.`);
}

/** The steps a Mac reports for each of its jobs, listed queued until it does. */
export const MAC_STEPS = (run: RunRecord) => macJobs(run.params);

/**
 * An iOS run: the console plans it here (the commit or ZIP, the bundle ID and signing checks,
 * the build number above App Store Connect's), packs the source, then a Mac runner takes it
 * and its jobs are mirrored into the record as the Mac reports them.
 */
export function iosPipeline(run: RunRecord): JobDef[] {
  const guard = (fn: (ctx: StepContext) => Promise<void>) => async (ctx: StepContext) => {
    try {
      await fn(ctx);
    } catch (e) {
      throw asStep(e);
    }
  };
  const planJob: JobDef = {
    key: 'plan',
    name: 'Plan',
    needs: [],
    timeoutMin: 30,
    steps: [
      setUp('Plan'),
      { name: 'Checkout code', run: guard((ctx) => (ctx.run.source.kind === 'git' ? checkoutGit(ctx) : checkoutZip(ctx))) },
      { name: 'Resolve plan', run: guard(planIos) },
      { name: 'Pack source for the Mac', run: guard(packSource) },
      complete(false),
    ],
  };
  const mac = MAC_STEPS(run).map(
    (job): JobDef => ({
      key: job.key,
      name: job.name,
      needs: job.key === 'tests' ? ['plan'] : job.needs,
      timeoutMin: job.timeoutMin,
      remote: true,
      steps: job.steps.map((s) => ({ name: s.name, run: async () => undefined })),
    }),
  );
  return [planJob, ...mac];
}
