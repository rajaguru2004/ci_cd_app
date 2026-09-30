/**
 * Uploaded-ZIP runs through the whole API: multipart upload → the builder, the run read back
 * from the builder and the shared volume, its live log, its AAB, the refusals, and the run
 * appearing on its commit in the stream. The builder and GitHub are loopback HTTP servers
 * speaking their real shapes.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { promises as fs } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const TOKEN = 'k'.repeat(48);
const t = (m: number) => new Date(Date.UTC(2026, 8, 30, 12, m)).toISOString();
let app: INestApplication;
let builder: Server;
let github: Server;
let base = '';
let cookie = '';
let data = '';
const created: Array<Record<string, unknown>> = [];

const ok = (name: string, n: number, a: number, b: number) => ({ name, number: n, status: 'completed', conclusion: 'success', started_at: t(a), completed_at: t(b) });
const localRun = (id: number) => ({
  id,
  status: 'completed',
  conclusion: 'success',
  createdAt: t(0),
  startedAt: t(0),
  updatedAt: t(9),
  completedAt: t(9),
  source: { fileName: 'human-resource-management-mobile-ess-main.zip', upload: 'x.zip', sizeBytes: 10, sha: 'c1', root: 'human-resource-management-mobile-ess-main', uploadedBy: 'console', rerunOf: null },
  params: { mode: 'build', track: 'internal', releaseNotes: '', releaseStatus: 'completed', versionName: '', versionCode: 1001, rehearsal: false },
  plan: null,
  jobs: [
    { id: 1, name: 'Plan', status: 'completed', conclusion: 'success', started_at: t(0), completed_at: t(1), steps: [ok('Set up job', 1, 0, 0), ok('Checkout code', 2, 0, 1), ok('Resolve plan', 3, 1, 1)] },
    { id: 2, name: 'Tests', status: 'completed', conclusion: 'success', started_at: t(1), completed_at: t(5), steps: [ok('Set up job', 1, 1, 1), ok('Set up Flutter', 2, 1, 2), ok('Install dependencies', 3, 2, 3), ok('Unit and widget tests', 4, 3, 5)] },
    { id: 3, name: 'Signed AAB', status: 'completed', conclusion: 'success', started_at: t(5), completed_at: t(9), steps: [ok('Build signed AAB', 1, 5, 9)] },
  ],
  error: null,
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<string> {
  let b = '';
  for await (const c of req) b += c;
  return b;
}

beforeAll(async () => {
  data = await fs.mkdtemp(join(tmpdir(), 'builds-'));
  // What the builder leaves on the shared volume for run 1.
  const art = join(data, 'runs/1/artifacts');
  await fs.mkdir(join(art, 'pipeline-plan'), { recursive: true });
  await fs.writeFile(join(art, 'pipeline-plan/plan.json'), JSON.stringify({ mode: 'build', trigger: 'upload', versionName: '1.0.1', versionCode: 1001, publish: false }));
  await fs.mkdir(join(art, 'build-info'), { recursive: true });
  await fs.writeFile(join(art, 'build-info/build-info.json'), JSON.stringify({ versionName: '1.0.1', versionCode: 1001, sizeBytes: 3, signer: 'CN=PrithiyaC' }));
  await fs.mkdir(join(art, 'app-release-aab/bundle/release'), { recursive: true });
  await fs.writeFile(join(art, 'app-release-aab/bundle/release/app-release.aab'), 'AAB');
  await fs.mkdir(join(art, 'test-results'), { recursive: true });
  await fs.writeFile(join(art, 'test-results/flutter-test.json'), [JSON.stringify({ type: 'testStart', test: { id: 1, name: 'a', suiteID: 0 } }), JSON.stringify({ type: 'testDone', testID: 1, result: 'success', hidden: false, skipped: false }), JSON.stringify({ type: 'done', success: true, time: 5000 })].join('\n'));

  builder = createServer((req, res) => {
    void (async () => {
      if (req.headers['x-builder-token'] !== TOKEN) return json(res, 401, { message: 'no' });
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/runs') {
        created.push(JSON.parse(await body(req)) as Record<string, unknown>);
        return json(res, 202, { ...localRun(2), status: 'queued', conclusion: null });
      }
      if (url === '/runs') return json(res, 200, [localRun(1)]);
      if (url === '/runs/1') return json(res, 200, localRun(1));
      if (url === '/runs/1/logs/2') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`${t(3)} ##[group]Run flutter test\n${t(3)} ##[endgroup]\n${t(4)} 00:05 +1: All tests passed!\n`);
      }
      if (req.method === 'POST' && url === '/runs/1/rerun') return json(res, 202, localRun(3));
      json(res, 404, { message: 'No run #9 on this server.' });
    })();
  });
  await new Promise<void>((r) => builder.listen(0, '127.0.0.1', r));

  github = createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://gh').pathname;
    if (p === '/repos/o/r') return json(res, 200, { full_name: 'o/r', private: true, default_branch: 'main', html_url: 'https://gh/o/r' });
    if (p === '/repos/o/r/commits') return json(res, 200, [{ sha: 'c1', html_url: 'https://gh/c1', commit: { message: 'feat: payslips offline', author: { name: 'Raja', date: t(0) } }, author: null }]);
    if (p === '/repos/o/r/commits/c1') return json(res, 200, { commit: { message: 'feat: payslips offline\n\nbody' } });
    if (p === '/repos/o/r/tags') return json(res, 200, []);
    if (p === '/repos/o/r/actions/workflows/release.yml/runs') return json(res, 200, { total_count: 0, workflow_runs: [] });
    json(res, 404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r));

  Object.assign(process.env, {
    GITHUB_TOKEN: 'ghp_local',
    GITHUB_REPO: 'o/r',
    GITHUB_API_URL: `http://127.0.0.1:${(github.address() as AddressInfo).port}`,
    CONSOLE_PASSWORD: 'correct horse battery',
    SESSION_SECRET: 's'.repeat(64),
    PLAY_SERVICE_ACCOUNT_FILE: '/nonexistent/play.json',
    BUILDER_URL: `http://127.0.0.1:${(builder.address() as AddressInfo).port}`,
    BUILDER_TOKEN: TOKEN,
    BUILDS_DIR: data,
  });
  const { AppModule } = await import('../app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, stopAtFirstError: true }));
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => builder.close(() => r()));
  await new Promise<void>((r) => github.close(() => r()));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`, { headers: { cookie } })).json();

const message = async (res: Response): Promise<string> => ((await res.json()) as { message: string }).message;

function form(file: Blob | null, fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (file) f.append('source', file, 'human-resource-management-mobile-ess-main.zip');
  return f;
}

describe('uploaded-ZIP runs through the API', () => {
  it('stores the ZIP where the builder reads it and starts a run there with an allocated version code', async () => {
    const zip = new Blob([Buffer.from('PK\u0003\u0004rest-of-a-zip')], { type: 'application/zip' });
    const res = await fetch(`${base}/runs/upload`, { method: 'POST', headers: { cookie }, body: form(zip, { mode: 'release', track: 'beta', releaseNotes: ' Offline payslips ', rehearsal: 'true' }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: -2, requestId: '', url: null });
    const sent = created.at(-1)!;
    expect(sent).toMatchObject({
      fileName: 'human-resource-management-mobile-ess-main.zip',
      uploadedBy: 'console',
      params: { mode: 'release', track: 'beta', releaseNotes: 'Offline payslips', releaseStatus: 'completed', rehearsal: true, versionCode: 1002 },
    });
    // The stored name is the console's, never the browser's.
    expect(sent.upload).toMatch(/^\d+-[0-9a-f]{12}\.zip$/);
    await expect(fs.readFile(join(data, 'uploads', String(sent.upload)), 'utf8')).resolves.toContain('rest-of-a-zip');
  });

  it('refuses a file that is not a ZIP, and a release without notes, and removes the upload', async () => {
    const before = (await fs.readdir(join(data, 'uploads'))).length;
    const notZip = await fetch(`${base}/runs/upload`, { method: 'POST', headers: { cookie }, body: form(new Blob(['hello']), { mode: 'build' }) });
    expect(notZip.status).toBe(400);
    expect(await message(notZip)).toContain('not a ZIP');
    const noNotes = await fetch(`${base}/runs/upload`, { method: 'POST', headers: { cookie }, body: form(new Blob([Buffer.from('PK\u0003\u0004x')]), { mode: 'release' }) });
    expect(noNotes.status).toBe(400);
    expect(await message(noNotes)).toContain('Release notes are required');
    const noFile = await fetch(`${base}/runs/upload`, { method: 'POST', headers: { cookie }, body: form(null, { mode: 'build' }) });
    expect(await message(noFile)).toBe('Choose the source ZIP to upload.');
    expect((await fs.readdir(join(data, 'uploads'))).length).toBe(before);
  });

  it('reads a local run like a GitHub one: stages, plan, tests, build info from the shared volume', async () => {
    const d = await get('/runs/-1');
    expect(d.run).toMatchObject({ id: -1, number: 1, trigger: 'upload', state: 'success', url: '', sha: 'c1', rehearsal: false });
    expect(d.commit).toMatchObject({ sha: 'c1', subject: 'feat: payslips offline' });
    expect(d.stages.map((s: { key: string; state: string }) => `${s.key}:${s.state}`)).toEqual([
      'checkout:success', 'dependencies:success', 'tests:success', 'aab:success', 'fastlane:skipped', 'play:skipped',
    ]);
    expect(d.plan).toMatchObject({ versionCode: 1001 });
    expect(d.tests).toMatchObject({ passed: 1, failed: 0, durationMs: 5000 });
    expect(d.build).toMatchObject({ versionName: '1.0.1', signer: 'CN=PrithiyaC' });
    expect(d.jobs.every((j: { url: string }) => j.url === '')).toBe(true);
  });

  it('serves the live log and the AAB of a local run', async () => {
    expect(await get('/runs/-1/jobs/2/log')).toEqual({ available: true, text: expect.stringContaining('All tests passed!') });
    const aab = await fetch(`${base}/runs/-1/aab`, { headers: { cookie } });
    expect(aab.headers.get('content-disposition')).toBe('attachment; filename="fusionhrm-1.0.1-1001.aab"');
    expect(await aab.text()).toBe('AAB');
  });

  it('re-runs through the builder and passes the builder\'s own refusals through', async () => {
    const res = await fetch(`${base}/runs/-1/rerun`, { method: 'POST', headers: { cookie } });
    expect(await res.json()).toEqual({ runId: -3 });
    const missing = await fetch(`${base}/runs/-9`, { headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(await message(missing)).toBe('No run #9 on this server.');
  });

  it('puts a local run on its commit in the stream, and lists local runs on their own', async () => {
    const s = await get('/stream');
    expect(s.commits[0].runs.map((r: { id: number }) => r.id)).toEqual([-1]);
    expect((await get('/local-runs')).map((r: { id: number }) => r.id)).toEqual([-1]);
  });
});
