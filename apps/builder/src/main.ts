import { createHash, timingSafeEqual } from 'crypto';
import { GithubActions } from './actions';
import { createReadStream, promises as fs } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { basename, join } from 'path';
import type { Readable } from 'stream';
import { AppError, AppStore } from './apps';
import { AppStoreClient, AppStoreError, type AppStoreKey } from './appstore';
import { dirs, readConfig, type BuilderConfig } from './config';
import { checkBranch, commitUrl, Git, GitError, isSha, parseRepoUrl } from './git';
import { GithubClient, GithubError } from './github';
import { iosProblems, IosError } from './ios';
import { KeyError, KeyStore } from './keys';
import { MacError, MacPool } from './macs';
import { checkParams, PlanError } from './plan';
import { PlayClient, PlayError } from './play';
import { releasePipeline, type Services } from './pipeline';
import { closeToBuilds, Runner, type NewSource, type PipelineFor } from './runner';
import { SealError } from './seal';
import { RunStore } from './store';
import type { AppRecord, RunRecord } from './types';
import { Vault, VaultError } from './vault';

/**
 * The builder's HTTP interface, reachable only on the compose network and only with the
 * shared BUILDER_TOKEN. The console API is its one client. Secrets go in (a keystore, a Play
 * key) and never come back out: responses carry fingerprints and certificates, not keys.
 *
 *   GET    /health
 *   GET    /keys                      POST /keys {email,name}       DELETE /keys/:id
 *   GET    /known-hosts               DELETE /known-hosts/:host
 *   POST   /git/check {url,keyId}     POST /git/inspect {url,keyId,branch,path}
 *   GET    /apps                      POST /apps {name,packageName,repo}
 *   GET    /apps/:id                  PATCH /apps/:id               DELETE /apps/:id
 *   POST   /apps/:id/access           re-check the repository
 *   PUT    /apps/:id/signing          DELETE /apps/:id/signing
 *   PUT    /apps/:id/play             DELETE /apps/:id/play         GET /apps/:id/play
 *   GET    /apps/:id/commits?branch=&refresh=1
 *   PUT    /apps/:id/runner {kind}    where Build and Release run: server or github
 *   PUT    /apps/:id/github/token     DELETE /apps/:id/github/token   (the app's own GitHub token)
 *   POST   /apps/:id/github/check     GET|POST /apps/:id/github/workflow   POST /apps/:id/github/secrets
 *   GET    /github                    PUT /github/token             DELETE /github/token  (the default)
 *   PUT    /apps/:id/ios {bundleId}   DELETE /apps/:id/ios              (the app's iOS side)
 *   PUT    /apps/:id/ios/certificate  DELETE /apps/:id/ios/certificate
 *   POST   /apps/:id/ios/profiles     DELETE /apps/:id/ios/profiles/:uuid
 *   PUT    /apps/:id/ios/app-store    DELETE /apps/:id/ios/app-store    GET /apps/:id/ios/app-store?refresh=1
 *   GET    /macs                      POST /macs {name}             PATCH /macs/:id {name}   DELETE /macs/:id
 *   POST   /macs/:id/token            POST /macs/:id/reset-key
 *   GET    /runs?app=&limit=          POST /runs {app,source,params,startedBy,runner}
 *   GET    /runs/:id                  GET /runs/:id/logs/:jobId
 *   POST   /runs/:id/cancel           POST /runs/:id/rerun
 *
 * And the Mac runners' agents, through the console API (which adds the builder token), each
 * with its own runner token (mac-protocol.ts):
 *   POST /runner/v1/connect   POST /runner/v1/poll   POST /runner/v1/runs/:id/accept
 *   GET  /runner/v1/runs/:id/source   POST /runner/v1/runs/:id/events   POST /runner/v1/runs/:id/complete
 *   PUT  /runner/v1/runs/:id/artifacts/:name/:file   GET /runner/v1/files/:name (the Mac's setup files)
 */

const API_UID = 1000; // the `node` user of the console API image, which writes uploads/

/** The files a Mac needs to set its runner up, served to anyone who asks (they hold nothing secret). */
const MAC_FILES: Record<string, string> = { 'docker-compose.yml': 'text/yaml; charset=utf-8', 'setup-mac.sh': 'text/x-shellscript; charset=utf-8', 'env.example': 'text/plain; charset=utf-8' };

type Reply = { status: number; body: unknown } | { status: number; stream: Readable; headers: Record<string, string> };
type Handler = (ctx: {
  req: IncomingMessage;
  params: Record<string, string>;
  url: URL;
  body: () => Promise<Record<string, unknown>>;
  /** Aborted when the client goes away (a long poll whose agent hung up). */
  signal: AbortSignal;
}) => Promise<Reply>;

export interface Deps {
  cfg: BuilderConfig;
  store: RunStore;
  runner: Runner;
  apps: AppStore;
  keys: KeyStore;
  git: Git;
  play: PlayClient;
  github: GithubActions;
  appStore: AppStoreClient;
  macs: MacPool;
}

async function prepare(cfg: BuilderConfig): Promise<void> {
  const d = dirs(cfg);
  for (const dir of [d.uploads, d.runs, d.apps, d.repos]) await fs.mkdir(dir, { recursive: true });
  await fs.chmod(d.repos, 0o700);
  if (process.getuid?.() !== 0) return;
  await fs.chown(d.uploads, API_UID, API_UID);
  // Runs recorded before artifacts were closed to the build user.
  for (const id of await fs.readdir(d.runs).catch(() => [] as string[])) {
    if (/^\d+$/.test(id)) await closeToBuilds(join(d.runs, id)).catch(() => undefined);
  }
  // Fresh cache volumes arrive owned by root; the build user must be able to fill them.
  for (const dir of [process.env.PUB_CACHE, process.env.GRADLE_USER_HOME, process.env.ANDROID_HOME]) {
    if (!dir) continue;
    await fs.mkdir(dir, { recursive: true });
    const st = await fs.stat(dir);
    if (st.uid !== cfg.buildUid) await chownDeep(dir, cfg.buildUid, cfg.buildGid);
  }
  // Caps Gradle's memory for every project: GRADLE_USER_HOME/gradle.properties outranks the
  // project's own (an app may ask for more heap than a small server has).
  if (process.env.GRADLE_USER_HOME) {
    const props = join(process.env.GRADLE_USER_HOME, 'gradle.properties');
    await fs.writeFile(
      props,
      [
        `org.gradle.jvmargs=-Xmx${cfg.gradleHeap} -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8`,
        // No daemon: nothing the build starts outlives the build.
        'org.gradle.daemon=false',
        // Kotlin compiles inside Gradle's JVM, so the heap above bounds the whole build.
        'kotlin.compiler.execution.strategy=in-process',
        'org.gradle.caching=true',
        '',
      ].join('\n'),
    );
    await fs.chown(props, cfg.buildUid, cfg.buildGid);
  }
}

async function chownDeep(dir: string, uid: number, gid: number): Promise<void> {
  await fs.lchown(dir, uid, gid);
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await chownDeep(p, uid, gid);
    else await fs.lchown(p, uid, gid);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' });
  res.end(text);
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new PlanError('Request body too large.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new PlanError('The request body is not JSON.');
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const given = req.headers['x-builder-token'];
  if (typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

const ok = (body: unknown, status = 200): Reply => ({ status, body });

/** An app as the console shows it: the record plus what only the builder can tell. */
function appView(app: AppRecord, deps: Deps) {
  const repo = app.repo ? parseRepoUrl(app.repo.url) : null;
  return {
    ...app,
    repo: app.repo && repo ? { ...app.repo, host: repo.host, hostLabel: repo.hostLabel, path: app.repo.path, slug: repo.path.replace(/\.git$/, '').replace(/^\/+/, ''), webUrl: repo.webUrl } : null,
    play: { ...app.play, clientEmail: app.play.source === 'app' ? app.play.clientEmail : deps.apps.defaultPlayEmail() },
    // What stops a build and a release on iOS now, each a sentence with the way out.
    iosProblems: app.ios ? { build: iosProblems(app.ios, app.name, false), release: iosProblems(app.ios, app.name, true) } : null,
  };
}

/** The address an agent connected from, as the web and api hops saw it. */
function agentAddress(req: IncomingMessage): string | null {
  const given = req.headers['x-runner-address'];
  return (typeof given === 'string' && given ? given : req.socket.remoteAddress ?? '').slice(0, 64) || null;
}

export function routes(deps: Deps): Array<[string, RegExp, Handler]> {
  const { cfg, store, runner, apps, keys, git, play, github, appStore, macs } = deps;
  const d = dirs(cfg);

  /** Reads App Store Connect with the app's key and records what it said on the app. */
  const checkAppStore = async (app: AppRecord, key: AppStoreKey, force: boolean) => {
    if (!app.ios) throw new AppError(`${app.name} has no iOS setup.`, 409);
    try {
      const snap = await appStore.snapshot(key, app.ios.bundleId, force);
      return { app: await apps.noteAppStore(app.id, { appId: snap.appId, appName: snap.appName, message: null }), snapshot: snap };
    } catch (e) {
      if (e instanceof AppStoreError && !e.transient) return { app: await apps.noteAppStore(app.id, { appId: null, appName: null, message: e.message }), snapshot: null, error: e.message };
      throw e;
    }
  };
  const agent = (req: IncomingMessage) => macs.authenticate(req.headers.authorization);

  const startRun = async (app: AppRecord, source: NewSource, params: ReturnType<typeof checkParams>, startedBy: string, rerunOf: number | null = null, kind: unknown = undefined) => {
    const runs = await store.list();
    if (params.platform === 'ios') {
      if (!app.ios) throw new AppError(`${app.name} has no iOS setup: add its bundle ID, certificate and profile in its settings → iOS.`, 409);
      const problems = iosProblems(app.ios, app.name, params.mode === 'release');
      if (problems.length) throw new AppError(problems[0], 409);
      if (!(await macs.records()).length) throw new AppError('No Mac runner is set up yet: add one on the Runners page, then start the iOS run.', 409);
      const highest = Math.max(0, ...runs.filter((r) => r.app?.id === app.id).map((r) => r.number));
      return runner.create({ app: apps.snapshot(app, 'ios'), number: await apps.nextNumber(app.id, highest), source, params, startedBy, rerunOf, runner: 'mac' });
    }
    const where = kind === 'server' || kind === 'github' ? kind : app.runner.kind;
    if (where === 'github') {
      if (source.kind === 'zip') throw new AppError('An uploaded ZIP builds on this server; GitHub Actions builds commits of the repository.', 409);
      if (!app.runner.github) throw new AppError(`${app.name}'s repository is not on github.com, so it builds on this server.`, 409);
      if (!(await github.tokenFor(app))) {
        throw new AppError('There is no GitHub token to start the run with: add one in the app’s settings → Where builds run, or the console’s default on the Setup page.', 409);
      }
      if (params.mode === 'release') {
        // GitHub queues one more upload of an app behind the running one; a third would replace it.
        const flying = runs.filter((r) => r.app?.id === app.id && r.runner === 'github' && r.params.mode === 'release' && r.status !== 'completed');
        if (flying.length >= 2) {
          throw new AppError(`${flying.map((r) => `#${r.number}`).join(' and ')} of ${app.name} are already releasing on GitHub Actions; start this one when one of them ends.`, 409);
        }
      }
    }
    const highest = Math.max(0, ...runs.filter((r) => r.app?.id === app.id).map((r) => r.number));
    return runner.create({
      app: apps.snapshot(app),
      number: await apps.nextNumber(app.id, highest),
      source,
      params,
      startedBy,
      rerunOf,
      runner: where,
      github: where === 'github' && app.runner.github ? { repo: app.runner.github.repo, workflow: app.runner.github.workflow } : null,
    });
  };

  return [
    ['GET', /^\/keys$/, async () => ok(await keys.list())],
    ['POST', /^\/keys$/, async ({ body }) => {
      const b = await body();
      return ok(await keys.create(b.email, b.name), 201);
    }],
    ['DELETE', /^\/keys\/([\w-]+)$/, async ({ params }) => {
      const users = (await apps.list()).filter((a) => a.repo?.keyId === params[1]);
      if (users.length) throw new KeyError(`${users.map((a) => a.name).join(', ')} still ${users.length === 1 ? 'uses' : 'use'} this key; give ${users.length === 1 ? 'it' : 'them'} another key first.`, 409);
      await keys.remove(params[1]);
      return ok({ ok: true });
    }],
    ['GET', /^\/known-hosts$/, async () => ok(await git.knownHosts())],
    ['DELETE', /^\/known-hosts\/(.+)$/, async ({ params }) => {
      await git.forgetHost(decodeURIComponent(params[1]));
      return ok({ ok: true });
    }],

    ['POST', /^\/git\/check$/, async ({ body }) => {
      const b = await body();
      const repo = parseRepoUrl(b.url);
      const keyId = typeof b.keyId === 'string' ? b.keyId : '';
      const remote = await git.lsRemote(repo, keyId);
      const host = (await git.knownHosts()).find((h) => h.host === repo.host || h.host === `[${repo.host}]:${repo.port}`) ?? null;
      return ok({ url: repo.url, host: repo.host, hostLabel: repo.hostLabel, slug: repo.path.replace(/\.git$/, '').replace(/^\/+/, ''), webUrl: repo.webUrl, hostKey: host, ...remote });
    }],
    ['POST', /^\/git\/inspect$/, async ({ body }) => {
      const b = await body();
      const repo = parseRepoUrl(b.url);
      const path = typeof b.path === 'string' ? b.path.trim().replace(/^\/+|\/+$/g, '') : '';
      return ok(await git.inspect(repo, typeof b.keyId === 'string' ? b.keyId : '', checkBranch(b.branch), path));
    }],

    ['GET', /^\/apps$/, async () => ok((await apps.list()).map((a) => appView(a, deps)))],
    ['POST', /^\/apps$/, async ({ body }) => {
      const b = await body();
      const app = await apps.create({ name: b.name, packageName: b.packageName, repo: (b.repo as Record<string, unknown> | null | undefined) ?? null });
      return ok(appView(app, deps), 201);
    }],
    ['GET', /^\/apps\/([\w-]+)$/, async ({ params }) => ok(appView(await apps.require(params[1]), deps))],
    ['PATCH', /^\/apps\/([\w-]+)$/, async ({ params, body }) => {
      const b = await body();
      const app = await apps.update(params[1], { name: b.name, packageName: b.packageName, repo: b.repo === null ? null : (b.repo as Record<string, unknown> | undefined) });
      play.forget(app.packageName);
      return ok(appView(app, deps));
    }],
    ['DELETE', /^\/apps\/([\w-]+)$/, async ({ params }) => {
      const app = await apps.require(params[1]);
      const runs = (await store.list()).filter((r) => r.app?.id === app.id);
      if (runs.some((r) => r.status !== 'completed')) throw new AppError(`${app.name} has a run queued or in progress; cancel it first.`, 409);
      for (const r of runs) await store.remove(r.id);
      await apps.remove(app.id);
      return ok({ ok: true, removedRuns: runs.length });
    }],
    ['POST', /^\/apps\/([\w-]+)\/access$/, async ({ params }) => ok(appView(await apps.checkAccess(params[1]), deps))],
    ['PUT', /^\/apps\/([\w-]+)\/signing$/, async ({ params, body }) => ok(appView(await apps.setSigning(params[1], await body()), deps))],
    ['DELETE', /^\/apps\/([\w-]+)\/signing$/, async ({ params }) => ok(appView(await apps.clearSigning(params[1]), deps))],
    ['PUT', /^\/apps\/([\w-]+)\/play$/, async ({ params, body }) => {
      const app = await apps.setPlayKey(params[1], (await body()).json);
      play.forget(app.packageName);
      return ok(appView(app, deps));
    }],
    ['DELETE', /^\/apps\/([\w-]+)\/play$/, async ({ params }) => {
      const app = await apps.clearPlayKey(params[1]);
      play.forget(app.packageName);
      return ok(appView(app, deps));
    }],
    ['GET', /^\/apps\/([\w-]+)\/play$/, async ({ params, url }) => {
      const app = await apps.require(params[1]);
      const key = await apps.playKey(app);
      if (!key) return ok({ configured: false, packageName: app.packageName, reason: 'No Google Play key: upload the service-account JSON in the app’s settings.' });
      const snap = await play.snapshot(app.packageName, key.key, url.searchParams.get('refresh') === '1');
      return ok({ configured: true, source: key.source, ...snap });
    }],
    ['PUT', /^\/apps\/([\w-]+)\/runner$/, async ({ params, body }) => ok(appView(await apps.setRunner(params[1], (await body()).kind), deps))],
    ['PUT', /^\/apps\/([\w-]+)\/github\/token$/, async ({ params, body }) => ok(appView(await github.setAppToken(params[1], (await body()).token), deps))],
    ['DELETE', /^\/apps\/([\w-]+)\/github\/token$/, async ({ params }) => ok(appView(await github.clearAppToken(params[1]), deps))],
    ['POST', /^\/apps\/([\w-]+)\/github\/check$/, async ({ params }) => ok(appView(await github.check(params[1]), deps))],
    ['GET', /^\/apps\/([\w-]+)\/github\/workflow$/, async () => ok(await github.workflow())],
    ['POST', /^\/apps\/([\w-]+)\/github\/workflow$/, async ({ params }) => {
      const res = await github.install(params[1]);
      return ok({ app: appView(res.app, deps), result: res.result });
    }],
    ['POST', /^\/apps\/([\w-]+)\/github\/secrets$/, async ({ params }) => {
      const res = await github.syncSecrets(params[1]);
      return ok({ app: appView(await github.check(res.app.id), deps), synced: res.synced, removed: res.removed });
    }],
    ['GET', /^\/github$/, async () => ok({ token: await github.defaultToken(), apiUrl: cfg.githubApiUrl })],
    ['PUT', /^\/github\/token$/, async ({ body }) => ok({ token: await github.setDefaultToken((await body()).token), apiUrl: cfg.githubApiUrl })],
    ['DELETE', /^\/github\/token$/, async () => {
      await github.clearDefaultToken();
      return ok({ token: null, apiUrl: cfg.githubApiUrl });
    }],
    // ─── iOS ───────────────────────────────────────────────────────────────────────────
    ['PUT', /^\/apps\/([\w-]+)\/ios$/, async ({ params, body }) => {
      const app = await apps.setIos(params[1], await body());
      appStore.forget(app.ios!.bundleId);
      return ok(appView(app, deps));
    }],
    ['DELETE', /^\/apps\/([\w-]+)\/ios$/, async ({ params }) => {
      const app = await apps.require(params[1]);
      if ((await store.list()).some((r) => r.app?.id === app.id && r.params.platform === 'ios' && r.status !== 'completed')) {
        throw new AppError(`${app.name} has an iOS run queued or in progress; cancel it first.`, 409);
      }
      return ok(appView(await apps.clearIos(app.id), deps));
    }],
    ['PUT', /^\/apps\/([\w-]+)\/ios\/certificate$/, async ({ params, body }) => ok(appView(await apps.setIosCertificate(params[1], await body()), deps))],
    ['DELETE', /^\/apps\/([\w-]+)\/ios\/certificate$/, async ({ params }) => ok(appView(await apps.clearIosCertificate(params[1]), deps))],
    ['POST', /^\/apps\/([\w-]+)\/ios\/profiles$/, async ({ params, body }) => ok(appView(await apps.addIosProfile(params[1], await body()), deps), 201)],
    ['DELETE', /^\/apps\/([\w-]+)\/ios\/profiles\/([0-9A-Fa-f-]{36})$/, async ({ params }) => ok(appView(await apps.removeIosProfile(params[1], params[2]), deps))],
    ['PUT', /^\/apps\/([\w-]+)\/ios\/app-store$/, async ({ params, body }) => {
      const { app, key } = await apps.setAppStoreKey(params[1], await body());
      try {
        return ok(appView((await checkAppStore(app, key, true)).app, deps));
      } catch (e) {
        if (e instanceof AppStoreError) throw new AppError(`The key is stored, but App Store Connect did not answer (${e.message}); check it again in a minute.`, 502);
        throw e;
      }
    }],
    ['DELETE', /^\/apps\/([\w-]+)\/ios\/app-store$/, async ({ params }) => ok(appView(await apps.clearAppStoreKey(params[1]), deps))],
    ['GET', /^\/apps\/([\w-]+)\/ios\/app-store$/, async ({ params, url }) => {
      const app = await apps.require(params[1]);
      const key = app.ios ? await apps.appStoreKey(app) : null;
      if (!app.ios || !key) {
        return ok({ configured: false, bundleId: app.ios?.bundleId ?? null, reason: 'No App Store Connect API key: add one in the app’s settings → iOS.' });
      }
      const res = await checkAppStore(app, key, url.searchParams.get('refresh') === '1');
      if (!res.snapshot) return ok({ configured: true, bundleId: app.ios.bundleId, keyId: key.keyId, error: res.error, app: appView(res.app, deps) });
      return ok({ configured: true, ...res.snapshot, app: appView(res.app, deps) });
    }],

    // ─── Mac runners: the console's side ───────────────────────────────────────────────
    ['GET', /^\/macs$/, async () => ok({ runners: await macs.list(), waiting: macs.waiting(), image: cfg.macRunnerImage })],
    ['POST', /^\/macs$/, async ({ body }) => ok({ ...(await macs.create((await body()).name)), image: cfg.macRunnerImage }, 201)],
    ['PATCH', /^\/macs\/([a-f0-9]{8})$/, async ({ params, body }) => ok(await macs.rename(params[1], (await body()).name))],
    ['POST', /^\/macs\/([a-f0-9]{8})\/token$/, async ({ params }) => ok({ ...(await macs.rotate(params[1])), image: cfg.macRunnerImage })],
    ['POST', /^\/macs\/([a-f0-9]{8})\/reset-key$/, async ({ params }) => ok(await macs.resetKey(params[1]))],
    ['DELETE', /^\/macs\/([a-f0-9]{8})$/, async ({ params }) => {
      await macs.remove(params[1]);
      return ok({ ok: true });
    }],

    // ─── Mac runners: the agent's side ─────────────────────────────────────────────────
    ['GET', /^\/runner\/v1\/files\/([\w.-]+)$/, async ({ params }) => {
      const type = MAC_FILES[params[1]];
      if (!type) return ok({ message: 'No such file.' }, 404);
      const file = join(cfg.macRunnerDir, params[1] === 'env.example' ? '.env.example' : params[1]);
      const st = await fs.stat(file).catch(() => null);
      if (!st) return ok({ message: `This console was built without ${params[1]}.` }, 404);
      return { status: 200, stream: createReadStream(file), headers: { 'content-type': type, 'content-length': String(st.size) } };
    }],
    ['POST', /^\/runner\/v1\/connect$/, async ({ req, body }) => ok(await macs.connect(await agent(req), await body(), agentAddress(req)))],
    ['POST', /^\/runner\/v1\/poll$/, async ({ req, body, signal }) => ok(await macs.poll(await agent(req), await body(), agentAddress(req), signal))],
    ['POST', /^\/runner\/v1\/runs\/(\d+)\/accept$/, async ({ req, params }) => {
      await macs.accept(await agent(req), Number(params[1]));
      return ok({ ok: true });
    }],
    ['GET', /^\/runner\/v1\/runs\/(\d+)\/source$/, async ({ req, params }) => {
      const file = macs.sourceFor(await agent(req), Number(params[1]));
      const st = await fs.stat(file).catch(() => null);
      if (!st) return ok({ message: 'The run’s source is gone from the console (the run ended).' }, 410);
      return { status: 200, stream: createReadStream(file), headers: { 'content-type': 'application/gzip', 'content-length': String(st.size) } };
    }],
    ['POST', /^\/runner\/v1\/runs\/(\d+)\/events$/, async ({ req, params, body }) => ok(await macs.report(await agent(req), Number(params[1]), await body()))],
    ['PUT', /^\/runner\/v1\/runs\/(\d+)\/artifacts\/([\w-]+)\/([\w.-]+)$/, async ({ req, params }) => ok(await macs.artifact(await agent(req), Number(params[1]), params[2], params[3], req))],
    ['POST', /^\/runner\/v1\/runs\/(\d+)\/complete$/, async ({ req, params, body }) => {
      await macs.complete(await agent(req), Number(params[1]), await body());
      return ok({ ok: true });
    }],

    ['GET', /^\/apps\/([\w-]+)\/commits\/([0-9a-f]{40})$/, async ({ params }) => {
      const app = await apps.require(params[1]);
      if (!app.repo || !(await git.resolve(app.id, { sha: params[2] }))) return ok({ message: 'That commit is not in the app’s repository mirror.' }, 404);
      return ok({ sha: params[2], ...(await git.commitInfo(app.id, params[2])) });
    }],
    ['GET', /^\/apps\/([\w-]+)\/commits$/, async ({ params, url }) => {
      const app = await apps.require(params[1]);
      if (!app.repo) return ok({ branch: null, branches: [], defaultBranch: null, commits: [], fetchedAt: null, fetching: false, error: null, connected: false });
      const repo = parseRepoUrl(app.repo.url);
      const branch = url.searchParams.get('branch') ? checkBranch(url.searchParams.get('branch')) : app.repo.branch;
      const state = await git.refresh(app.id, repo, app.repo.keyId, url.searchParams.get('refresh') === '1' ? 0 : 30_000, 20_000);
      await apps.noteAccess(app.id, state.fetching ? app.repo.access.message : state.error);
      const [branches, tags] = await Promise.all([git.branches(app.id), git.tags(app.id)]);
      // A branch the mirror does not have yet (first pull running, or the pull failed) lists no
      // commits and says why; only a healthy pull without it means the branch does not exist.
      if (!branches.includes(branch) && branches.length && !state.fetching && !state.error) {
        throw new GitError(`${repo.path.replace(/\.git$/, '').replace(/^\/+/, '')} has no branch '${branch}'.`, 404);
      }
      const commits = branches.includes(branch) ? await git.log(app.id, branch) : [];
      return ok({
        branch,
        branches,
        defaultBranch: app.repo.defaultBranch,
        commits: commits.map((c) => ({ ...c, tags: tags.get(c.sha) ?? [], url: commitUrl(repo, c.sha) })),
        ...state,
        connected: true,
      });
    }],

    ['GET', /^\/runs$/, async ({ url }) => {
      const appId = url.searchParams.get('app');
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 200);
      const all = await store.list();
      return ok((appId ? all.filter((r) => r.app?.id === appId) : all).slice(0, limit));
    }],
    ['POST', /^\/runs$/, async ({ body }) => {
      const b = await body();
      const app = await apps.require(String(b.app ?? ''));
      const params = checkParams(b.params);
      const startedBy = String(b.startedBy ?? 'console').slice(0, 100);
      const s = (b.source ?? {}) as Record<string, unknown>;
      let source: NewSource;
      if (s.kind === 'zip') {
        const upload = basename(String(s.upload ?? ''));
        if (!upload || upload !== s.upload) throw new PlanError('upload must be a file name under uploads/.');
        await fs.access(join(d.uploads, upload)).catch(() => {
          throw new PlanError(`No uploaded file ${upload}.`);
        });
        source = { kind: 'zip', upload, fileName: String(s.fileName ?? upload).slice(0, 200), sizeBytes: Number(s.sizeBytes) || 0 };
      } else {
        if (!app.repo) throw new AppError(`${app.name} has no repository yet: connect it in the app's settings, or build from a ZIP.`, 409);
        const repo = parseRepoUrl(app.repo.url);
        const branch = s.branch ? checkBranch(s.branch) : app.repo.branch;
        let sha = isSha(s.sha) ? s.sha : null;
        if (!sha) {
          // Pull now, so the run sits on the commit it will build from the moment it is queued.
          await git.refresh(app.id, repo, app.repo.keyId, 0, 20_000);
          sha = (await git.resolve(app.id, { branch }).catch(() => null)) ?? null;
        }
        const commit = sha ? await git.commitInfo(app.id, sha).catch(() => null) : null;
        source = { kind: 'git', url: app.repo.url, branch, requestedSha: sha, commit };
      }
      return ok(await startRun(app, source, params, startedBy, null, b.runner), 202);
    }],
    ['GET', /^\/runs\/(\d+)$/, async ({ params }) => {
      const run = await store.get(Number(params[1]));
      if (!run) return ok({ message: `No run ${params[1]} on this server.` }, 404);
      return ok(run);
    }],
    ['GET', /^\/runs\/(\d+)\/logs\/(\d+)$/, async ({ params }) => {
      const run = await store.get(Number(params[1]));
      if (!run) return ok({ message: `No run ${params[1]} on this server.` }, 404);
      const jobId = Number(params[2]);
      if (!run.jobs.some((j) => j.id === jobId)) return ok({ message: 'No such job in this run.' }, 404);
      return ok(await fs.readFile(join(store.dir(run.id), 'logs', `${jobId}.log`), 'utf8').catch(() => ''));
    }],
    ['POST', /^\/runs\/(\d+)\/cancel$/, async ({ params }) => {
      const run = await store.get(Number(params[1]));
      if (!run) return ok({ message: `No run ${params[1]} on this server.` }, 404);
      if (run.status === 'completed') return ok({ message: 'The run has already finished; there is nothing to cancel.' }, 409);
      await runner.cancel(run.id);
      return ok({ ok: true }, 202);
    }],
    ['POST', /^\/runs\/(\d+)\/rerun$/, async ({ params }) => {
      const run = await store.get(Number(params[1]));
      if (!run) return ok({ message: `No run ${params[1]} on this server.` }, 404);
      if (run.status !== 'completed') return ok({ message: 'Only a finished run can be run again.' }, 409);
      if (!run.app) return ok({ message: 'This run belongs to no app; adopt it first (cli adopt-runs).' }, 409);
      const app = await apps.require(run.app.id);
      let source: NewSource;
      if (run.source.kind === 'zip') {
        const upload = run.source.upload;
        if (!(await fs.access(join(d.uploads, upload)).then(() => true, () => false))) {
          return ok({ message: 'The uploaded ZIP for this run has been cleaned up; upload it again.' }, 410);
        }
        source = { kind: 'zip', upload, fileName: run.source.fileName, sizeBytes: run.source.sizeBytes };
      } else {
        // The same commit again (or the branch tip, if the first run never got as far as resolving it).
        source = { kind: 'git', url: app.repo?.url ?? run.source.url, branch: run.source.branch, requestedSha: run.source.sha ?? run.source.requestedSha, commit: run.source.commit };
      }
      // A fresh version code: the Plan job takes the next free one. Where it ran, it runs again
      // (this server when the app can no longer build on GitHub; a Mac for an iOS run).
      const params2 = checkParams({ ...run.params, versionCode: null });
      const where = run.runner === 'github' && app.runner.github ? 'github' : 'server';
      return ok(await startRun(app, source, params2, run.source.startedBy, run.id, where), 202);
    }],
  ];
}

/** The largest JSON body a route takes: keystores and iOS files travel base64, a Mac's report carries log lines. */
function bodyLimit(path: string): number {
  if (/\/signing$|\/ios(\/|$)/.test(path)) return 2 * 1024 * 1024;
  if (/^\/runner\/v1\/runs\/\d+\/(events|complete)$/.test(path)) return 4 * 1024 * 1024;
  return 128 * 1024;
}

export function createApp(deps: Deps) {
  const table = routes(deps);
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://builder');
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true,
          busy: deps.runner.busy,
          queued: deps.runner.queued.length,
          current: deps.runner.current,
          onGithub: deps.runner.onGithub,
          onMac: deps.runner.onMac,
          macs: await deps.macs.summary(),
          defaultPlayKey: deps.apps.defaultPlayEmail(),
          toolchain: { flutter: process.env.TOOLCHAIN_FLUTTER ?? null, java: process.env.JAVA_VERSION ?? null },
        });
      }
      if (!authorized(req, deps.cfg.token)) return send(res, 401, { message: 'Missing or wrong builder token.' });
      for (const [method, pattern, handler] of table) {
        if (req.method !== method) continue;
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        m.forEach((v, i) => (params[i] = v));
        const gone = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) gone.abort();
        });
        const reply = await handler({ req, params, url, body: () => readJson(req, bodyLimit(url.pathname)), signal: gone.signal });
        if ('stream' in reply) {
          res.writeHead(reply.status, reply.headers);
          reply.stream.on('error', () => res.destroy());
          reply.stream.pipe(res);
          return;
        }
        return send(res, reply.status, reply.body);
      }
      return send(res, 404, { message: 'Not found.' });
    })().catch((e: unknown) => {
      if (e instanceof PlanError) return send(res, 400, { message: e.message });
      if (e instanceof GitError || e instanceof AppError || e instanceof KeyError || e instanceof MacError || e instanceof IosError) return send(res, e.status, { message: e.message });
      if (e instanceof PlayError || e instanceof AppStoreError) return send(res, e.status, { message: e.message });
      if (e instanceof GithubError) return send(res, e.status, { message: e.message });
      if (e instanceof SealError) return send(res, 400, { message: e.message });
      if (e instanceof VaultError) return send(res, 500, { message: e.message });
      console.error(e);
      send(res, 500, { message: 'The builder failed to handle that request.' });
    });
  });
}

export async function boot(cfg: BuilderConfig, pipelineFor: PipelineFor = releasePipeline): Promise<Deps> {
  const d = dirs(cfg);
  await prepare(cfg);
  const vault = new Vault(d.vault, cfg.vaultKey, cfg.scratchDir);
  await vault.init();
  const keys = new KeyStore(vault);
  const git = new Git(d.repos, vault, keys, cfg.gitTimeoutMs);
  const apps = new AppStore(d.apps, vault, keys, git, cfg.scratchDir, cfg.playKeyFile);
  await apps.init();
  const play = new PlayClient(cfg.playApiUrl);
  const github = new GithubActions(new GithubClient(cfg.githubApiUrl), vault, apps, cfg.pipelineDir);
  const appStore = new AppStoreClient(cfg.appStoreApiUrl);
  const store = new RunStore(d.runs);
  await store.init();
  const macs = new MacPool(vault, store);
  const locks = new Map<string, Promise<unknown>>();
  const services: Services = {
    apps,
    git,
    play,
    github,
    appStore,
    macs,
    usedVersionCodes: async (appId, exceptRunId, platform) =>
      (await store.list())
        .filter((r: RunRecord) => r.app?.id === appId && r.id !== exceptRunId && r.params.platform === platform)
        .map((r) => r.plan?.versionCode ?? r.params.versionCode ?? 0)
        .filter((c) => c > 0),
    lockApp: <T>(appId: string, fn: () => Promise<T>): Promise<T> => {
      const next = (locks.get(appId) ?? Promise.resolve()).catch(() => undefined).then(fn);
      locks.set(appId, next);
      return next.finally(() => {
        if (locks.get(appId) === next) locks.delete(appId);
      });
    },
  };
  const runner = new Runner(cfg, store, pipelineFor, d.uploads, services);
  play.setGuard((pkg) => runner.uploading(pkg));
  return { cfg, store, runner, apps, keys, git, play, github, appStore, macs };
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const deps = await boot(cfg);
  await deps.runner.recover();
  createApp(deps).listen(cfg.port, '0.0.0.0', () => console.log(`builder listening on :${cfg.port}`));
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
