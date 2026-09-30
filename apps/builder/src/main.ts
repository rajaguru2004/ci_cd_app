import { createHash, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { basename, join } from 'path';
import { dirs, readConfig, type BuilderConfig } from './config';
import { checkParams, PlanError } from './plan';
import { releasePipeline } from './pipeline';
import { Runner } from './runner';
import { RunStore } from './store';

/**
 * The builder's HTTP interface, reachable only on the compose network and only with the
 * shared BUILDER_TOKEN. The console API is its one client:
 *
 *   GET  /health
 *   GET  /runs                    every run on this server, newest first
 *   GET  /runs/:id                one run (GitHub-shaped jobs and steps)
 *   GET  /runs/:id/logs/:jobId    a job's log so far (it grows while the job runs)
 *   POST /runs                    { upload, fileName, sizeBytes, uploadedBy, params }
 *   POST /runs/:id/cancel
 *   POST /runs/:id/rerun          { versionCode }  same upload, same settings
 */

const API_UID = 1000; // the `node` user of the console API image, which writes uploads/

async function prepare(cfg: BuilderConfig): Promise<void> {
  const d = dirs(cfg);
  await fs.mkdir(d.uploads, { recursive: true });
  await fs.mkdir(d.runs, { recursive: true });
  if (process.getuid?.() !== 0) return;
  await fs.chown(d.uploads, API_UID, API_UID);
  // Fresh cache volumes arrive owned by root; the build user must be able to fill them.
  for (const dir of [process.env.PUB_CACHE, process.env.GRADLE_USER_HOME, process.env.ANDROID_HOME]) {
    if (!dir) continue;
    await fs.mkdir(dir, { recursive: true });
    const st = await fs.stat(dir);
    if (st.uid !== cfg.buildUid) await chownDeep(dir, cfg.buildUid, cfg.buildGid);
  }
  // Caps Gradle's memory for every project: GRADLE_USER_HOME/gradle.properties outranks the
  // project's own (the app asks for an 8 GB heap, more than a small server has).
  if (process.env.GRADLE_USER_HOME) {
    const props = join(process.env.GRADLE_USER_HOME, 'gradle.properties');
    await fs.writeFile(
      props,
      [
        `org.gradle.jvmargs=-Xmx${cfg.gradleHeap} -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8`,
        // No daemon: nothing the build starts outlives the build.
        'org.gradle.daemon=false',
        // Kotlin compiles inside Gradle's JVM, so the heap above bounds the whole build
        // (a separate Kotlin daemon would take a second heap of the same size).
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
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new PlanError('Request body too large.');
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

export function createApp(cfg: BuilderConfig, runner: Runner, store: RunStore) {
  const d = dirs(cfg);
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://builder');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, busy: runner.busy, queued: runner.queued.length });
      }
      if (!authorized(req, cfg.token)) return send(res, 401, { message: 'Missing or wrong builder token.' });

      if (parts[0] !== 'runs') return send(res, 404, { message: 'Not found.' });
      if (req.method === 'GET' && parts.length === 1) return send(res, 200, await store.list());

      if (req.method === 'POST' && parts.length === 1) {
        const body = await readJson(req);
        const upload = basename(String(body.upload ?? ''));
        if (!upload || upload !== body.upload) return send(res, 400, { message: 'upload must be a file name under uploads/.' });
        try {
          await fs.access(join(d.uploads, upload));
        } catch {
          return send(res, 400, { message: `No uploaded file ${upload}.` });
        }
        const params = checkParams(body.params);
        const run = await runner.create({
          upload,
          fileName: String(body.fileName ?? upload).slice(0, 200),
          sizeBytes: Number(body.sizeBytes) || 0,
          uploadedBy: String(body.uploadedBy ?? 'console').slice(0, 100),
          params,
        });
        return send(res, 202, run);
      }

      const id = Number(parts[1]);
      if (!Number.isInteger(id) || id < 1) return send(res, 404, { message: 'No such run.' });
      const run = await store.get(id);
      if (!run) return send(res, 404, { message: `No run #${id} on this server.` });

      if (req.method === 'GET' && parts.length === 2) return send(res, 200, run);
      if (req.method === 'GET' && parts[2] === 'logs' && parts.length === 4) {
        const jobId = Number(parts[3]);
        if (!run.jobs.some((j) => j.id === jobId)) return send(res, 404, { message: 'No such job in this run.' });
        const text = await fs.readFile(join(store.dir(id), 'logs', `${jobId}.log`), 'utf8').catch(() => '');
        return send(res, 200, text);
      }
      if (req.method === 'POST' && parts[2] === 'cancel') {
        if (run.status === 'completed') return send(res, 409, { message: 'The run has already finished; there is nothing to cancel.' });
        await runner.cancel(id);
        return send(res, 202, { ok: true });
      }
      if (req.method === 'POST' && parts[2] === 'rerun') {
        if (run.status !== 'completed') return send(res, 409, { message: 'Only a finished run can be re-run.' });
        try {
          await fs.access(join(d.uploads, run.source.upload));
        } catch {
          return send(res, 410, { message: 'The uploaded ZIP for this run has been cleaned up; upload it again.' });
        }
        const body = await readJson(req);
        const params = checkParams({ ...run.params, versionCode: body.versionCode ?? run.params.versionCode });
        const next = await runner.create({
          upload: run.source.upload,
          fileName: run.source.fileName,
          sizeBytes: run.source.sizeBytes,
          uploadedBy: run.source.uploadedBy,
          params,
          rerunOf: run.id,
        });
        return send(res, 202, next);
      }
      return send(res, 404, { message: 'Not found.' });
    })().catch((e: unknown) => {
      if (e instanceof PlanError) return send(res, 400, { message: e.message });
      console.error(e);
      send(res, 500, { message: 'The builder failed to handle that request.' });
    });
  });
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const d = dirs(cfg);
  await prepare(cfg);
  const store = new RunStore(d.runs);
  await store.init();
  const runner = new Runner(cfg, store, releasePipeline, d.uploads);
  await runner.recover();
  createApp(cfg, runner, store).listen(cfg.port, '0.0.0.0', () => console.log(`builder listening on :${cfg.port}`));
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
