/**
 * The console API end to end, against a builder-shaped HTTP server and a shared volume:
 * sign-in, the apps overview, an app's commit stream with its runs, starting git and ZIP runs,
 * run detail from the run record and its artifacts, the AAB, and the builder's refusals passed
 * through in its own words. Keys and keystores only ever travel towards the builder.
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
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const t = (m: number) => new Date(Date.UTC(2026, 9, 10, 12, m)).toISOString();
let app: INestApplication;
let builder: Server;
let base = '';
let cookie = '';
let data = '';
const received: Array<{ method: string; url: string; body: unknown }> = [];

const ok = (name: string, n: number, a: number, b: number) => ({ name, number: n, status: 'completed', conclusion: 'success', started_at: t(a), completed_at: t(b) });
const fusion = {
  id: 'fusionhrm',
  name: 'FusionHRM',
  packageName: 'com.fusionapps.fusionhrm',
  repo: {
    url: 'git@github.com:the-reciprocal-solutions/human-resource-management-mobile-ess.git',
    keyId: 'k_0123456789',
    branch: 'main',
    defaultBranch: 'main',
    path: '',
    access: { state: 'ok', checkedAt: t(0), message: null },
    host: 'github.com',
    hostLabel: 'GitHub',
    slug: 'the-reciprocal-solutions/human-resource-management-mobile-ess',
    webUrl: 'https://github.com/the-reciprocal-solutions/human-resource-management-mobile-ess',
  },
  signing: { mode: 'console', fileName: 'upload-keystore.jks', keyAlias: 'upload', certificate: { owner: 'CN=PrithiyaC', sha256: 'ED:6C', sha1: '67:D7', validFrom: t(0), validUntil: t(0), algorithm: 'RSA' }, updatedAt: t(0) },
  play: { source: 'default', clientEmail: 'ci@proj.iam.gserviceaccount.com', projectId: null, updatedAt: null },
  createdAt: t(0),
  updatedAt: t(0),
};
const run = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  app: { id: 'fusionhrm', name: 'FusionHRM', packageName: 'com.fusionapps.fusionhrm', signing: 'console', projectPath: '' },
  number: id,
  status: 'completed',
  conclusion: 'success',
  createdAt: t(0),
  startedAt: t(0),
  updatedAt: t(9),
  completedAt: t(9),
  source: { kind: 'git', url: fusion.repo.url, branch: 'main', requestedSha: SHA1, sha: SHA1, root: '', commit: { subject: 'feat: payslips offline', author: 'Raja', email: 'raja@company.com', date: t(0) }, startedBy: 'console', rerunOf: null },
  params: { mode: 'build', track: 'internal', releaseNotes: '', releaseStatus: 'completed', versionName: '', versionCode: null, rehearsal: false },
  plan: { mode: 'build', versionName: '1.0.1', versionCode: 1010 },
  jobs: [
    { id: 1, name: 'Plan', status: 'completed', conclusion: 'success', started_at: t(0), completed_at: t(1), steps: [ok('Set up job', 1, 0, 0), ok('Checkout code', 2, 0, 1), ok('Resolve plan', 3, 1, 1)] },
    { id: 2, name: 'Tests', status: 'completed', conclusion: 'success', started_at: t(1), completed_at: t(5), steps: [ok('Set up job', 1, 1, 1), ok('Set up Flutter', 2, 1, 2), ok('Install dependencies', 3, 2, 3), ok('Unit and widget tests', 4, 3, 5)] },
    { id: 3, name: 'Signed AAB', status: 'completed', conclusion: 'success', started_at: t(5), completed_at: t(9), steps: [ok('Build AAB', 1, 5, 8), ok('Sign with the upload key', 2, 8, 9)] },
  ],
  error: null,
  ...over,
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
  data = await fs.mkdtemp(join(tmpdir(), 'console-'));
  // What the builder leaves on the shared volume for run 1.
  const art = join(data, 'runs/1/artifacts');
  await fs.mkdir(join(art, 'pipeline-plan'), { recursive: true });
  await fs.writeFile(join(art, 'pipeline-plan/plan.json'), JSON.stringify({ mode: 'build', trigger: 'git', versionName: '1.0.1', versionCode: 1010, versionCodeFrom: "Google Play's highest, 1009, + 1", publish: false, packageName: 'com.fusionapps.fusionhrm' }));
  await fs.mkdir(join(art, 'build-info'), { recursive: true });
  await fs.writeFile(join(art, 'build-info/build-info.json'), JSON.stringify({ versionName: '1.0.1', versionCode: 1010, sizeBytes: 3, signer: 'CN=PrithiyaC', signedBy: 'console' }));
  await fs.mkdir(join(art, 'app-release-aab/bundle/release'), { recursive: true });
  await fs.writeFile(join(art, 'app-release-aab/bundle/release/app-release.aab'), 'AAB');
  await fs.mkdir(join(art, 'test-results'), { recursive: true });
  await fs.writeFile(
    join(art, 'test-results/flutter-test.json'),
    [JSON.stringify({ type: 'testStart', test: { id: 1, name: 'a', suiteID: 0 } }), JSON.stringify({ type: 'testDone', testID: 1, result: 'success', hidden: false, skipped: false }), JSON.stringify({ type: 'done', success: true, time: 5000 })].join('\n'),
  );

  builder = createServer((req, res) => {
    void (async () => {
      if (req.headers['x-builder-token'] !== TOKEN) return json(res, 401, { message: 'no' });
      const url = req.url ?? '';
      // The Mac runners' gateway: bytes and headers as the agent sent them.
      if (url.startsWith('/runner/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const sent = Buffer.concat(chunks);
        if (url === '/runner/v1/runs/5/source') {
          res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': '6' });
          return res.end(Buffer.from([0x1f, 0x8b, 0, 1, 2, 3]));
        }
        // A long poll: the builder holds it before answering.
        if (url === '/runner/v1/held') {
          await new Promise((r) => setTimeout(r, 1500));
          return json(res, 200, { held: true });
        }
        return json(res, url.endsWith('/denied') ? 401 : 200, {
          url,
          method: req.method,
          authorization: req.headers.authorization ?? null,
          address: req.headers['x-runner-address'] ?? null,
          type: req.headers['content-type'] ?? null,
          bytes: sent.length,
          json: req.headers['content-type'] === 'application/json' ? JSON.parse(sent.toString() || 'null') : null,
        });
      }
      const text = await body(req);
      received.push({ method: req.method ?? '', url, body: text ? JSON.parse(text) : null });
      const p = new URL(url, 'http://b').pathname;
      if (p === '/apps' && req.method === 'GET') return json(res, 200, [fusion]);
      if (p === '/apps/fusionhrm' && req.method === 'GET') return json(res, 200, fusion);
      if (p === '/apps/nope') return json(res, 404, { message: "There is no app 'nope' on this console." });
      if (p === '/apps/fusionhrm/signing' && req.method === 'PUT') return json(res, 200, fusion);
      if (p === '/apps/fusionhrm/commits') {
        return json(res, 200, {
          branch: 'main', branches: ['main', 'feat/x'], defaultBranch: 'main', fetchedAt: t(9), fetching: false, error: null, connected: true,
          commits: [
            { sha: SHA2, subject: 'fix: week row', body: '', author: 'Raja', email: 'raja@company.com', date: t(8), tags: ['v1.0.2'], url: `https://github.com/x/commit/${SHA2}` },
            { sha: SHA1, subject: 'feat: payslips offline', body: 'Details.', author: 'Raja', email: 'raja@company.com', date: t(0), tags: [], url: `https://github.com/x/commit/${SHA1}` },
          ],
        });
      }
      if (p === '/runs' && req.method === 'GET') {
        return json(res, 200, [run(2, { status: 'in_progress', conclusion: null, source: { kind: 'zip', fileName: 'src.zip', upload: 'u.zip', sizeBytes: 3, sha: null, root: null, commit: null, startedBy: 'console', rerunOf: null } }), run(1)]);
      }
      if (p === '/runs' && req.method === 'POST') return json(res, 202, { ...run(3), status: 'queued', number: 3 });
      if (p === '/runs/1') return json(res, 200, run(1));
      if (p === '/runs/1/logs/2') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`${t(3)} ##[group]Run flutter test\n${t(3)} ##[endgroup]\n${t(4)} 00:05 +1: All tests passed!\n`);
      }
      if (p === '/runs/1/rerun') return json(res, 202, { ...run(4), number: 4 });
      if (p === '/runs/1/cancel') return json(res, 409, { message: 'The run has already finished; there is nothing to cancel.' });
      if (p === '/keys' && req.method === 'POST') return json(res, 201, { id: 'k_0123456789', email: 'raja@company.com', publicKey: 'ssh-ed25519 AAAA raja@company.com', fingerprint: 'SHA256:x' });
      if (p === '/git/check') return json(res, 422, { message: 'github.com refused the key for raja@company.com (Permission denied).' });
      json(res, 404, { message: 'No run 9 on this server.' });
    })();
  });
  // Keep-Alive: timeout=2, so a pooled socket idles out after 1 s, inside the held poll below.
  builder.keepAliveTimeout = 2000;
  await new Promise<void>((r) => builder.listen(0, '127.0.0.1', r));

  Object.assign(process.env, {
    CONSOLE_PASSWORD: 'correct horse battery',
    SESSION_SECRET: 's'.repeat(64),
    BUILDER_URL: `http://127.0.0.1:${(builder.address() as AddressInfo).port}`,
    BUILDER_TOKEN: TOKEN,
    BUILDS_DIR: data,
  });
  const { AppModule } = await import('./app.module');
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
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`, { headers: { cookie } })).json();
const send = (path: string, method: string, payload: unknown) =>
  fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const message = async (res: Response): Promise<string> => [((await res.json()) as { message: string | string[] }).message].flat().join(' ');
const last = () => received[received.length - 1];

describe('the console API', () => {
  it('lets nobody in without signing in', async () => {
    expect((await fetch(`${base}/overview`)).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('lists every app with its latest run, and the recent runs across apps', async () => {
    const o = await get('/overview');
    expect(o.apps).toHaveLength(1);
    expect(o.apps[0]).toMatchObject({ id: 'fusionhrm', runCount: 2, latestRun: { id: 2, state: 'running' }, activeRun: { id: 2 } });
    expect(o.recent.map((r: { id: number }) => r.id)).toEqual([2, 1]);
  });

  it('puts each run on its commit in the stream, and the rest under other runs', async () => {
    const s = await get('/apps/fusionhrm/stream?branch=main');
    expect(s.commits.map((c: { sha: string; runs: Array<{ id: number }> }) => [c.sha, c.runs.map((r) => r.id)])).toEqual([[SHA2, []], [SHA1, [1]]]);
    expect(s.commits[0]).toMatchObject({ tags: ['v1.0.2'], author: { name: 'Raja', email: 'raja@company.com' } });
    expect(s.otherRuns.map((r: { id: number }) => r.id)).toEqual([2]);
    expect(s).toMatchObject({ branch: 'main', branches: ['main', 'feat/x'], connected: true, app: { id: 'fusionhrm' } });
  });

  it('starts a build or a release of the branch tip or of one commit on the builder', async () => {
    const res = await send('/apps/fusionhrm/runs', 'POST', { mode: 'release', track: 'beta', releaseNotes: ' Offline payslips ', rehearsal: true, sha: SHA1 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: 3, number: 3 });
    expect(last().body).toEqual({
      app: 'fusionhrm',
      source: { kind: 'git', sha: SHA1 },
      params: { platform: 'android', mode: 'release', track: 'beta', releaseNotes: 'Offline payslips', releaseStatus: 'completed', versionName: '', rehearsal: true },
      startedBy: 'console',
    });
    const noNotes = await send('/apps/fusionhrm/runs', 'POST', { mode: 'release' });
    expect(noNotes.status).toBe(400);
    expect(await message(noNotes)).toContain('Release notes are required');
    const badSha = await send('/apps/fusionhrm/runs', 'POST', { mode: 'build', sha: 'abc' });
    expect(await message(badSha)).toContain('full 40-character commit id');
  });

  it('stores an uploaded ZIP where the builder reads it, and refuses what is not a ZIP', async () => {
    const form = (file: Blob | null, fields: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.append(k, v);
      if (file) f.append('source', file, 'human-resource-management-mobile-ess-main.zip');
      return f;
    };
    const zip = new Blob([Buffer.from('PK\u0003\u0004rest-of-a-zip')], { type: 'application/zip' });
    const res = await fetch(`${base}/runs/upload`, { method: 'POST', headers: { cookie }, body: form(zip, { app: 'fusionhrm', mode: 'build' }) });
    expect(res.status).toBe(202);
    const sent = last().body as { app: string; source: { kind: string; upload: string; fileName: string } };
    expect(sent).toMatchObject({ app: 'fusionhrm', source: { kind: 'zip', fileName: 'human-resource-management-mobile-ess-main.zip' } });
    // The stored name is the console's, never the browser's.
    expect(sent.source.upload).toMatch(/^\d+-[0-9a-f]{12}\.zip$/);
    await expect(fs.readFile(join(data, 'uploads', sent.source.upload), 'utf8')).resolves.toContain('rest-of-a-zip');
    const before = (await fs.readdir(join(data, 'uploads'))).length;
    const notZip = await fetch(`${base}/runs/upload`, { method: 'POST', headers: { cookie }, body: form(new Blob(['hello']), { app: 'fusionhrm', mode: 'build' }) });
    expect(await message(notZip)).toContain('not a ZIP');
    const noApp = await fetch(`${base}/runs/upload`, { method: 'POST', headers: { cookie }, body: form(zip, { mode: 'build' }) });
    expect(await message(noApp)).toContain('Pick the app this ZIP belongs to');
    expect((await fs.readdir(join(data, 'uploads'))).length).toBe(before);
  });

  it('reads a run from its record and its artifacts: stages, plan, tests, build, commit link', async () => {
    const d = await get('/runs/1');
    expect(d.run).toMatchObject({ id: 1, number: 1, app: { id: 'fusionhrm' }, state: 'success', source: { kind: 'git', branch: 'main', sha: SHA1, subject: 'feat: payslips offline' }, versionCode: 1010 });
    expect(d.stages.map((s: { key: string; state: string }) => `${s.key}:${s.state}`)).toEqual([
      'checkout:success', 'dependencies:success', 'tests:success', 'aab:success', 'fastlane:skipped', 'play:skipped',
    ]);
    expect(d.plan).toMatchObject({ versionCode: 1010, versionCodeFrom: "Google Play's highest, 1009, + 1" });
    expect(d.tests).toMatchObject({ passed: 1, failed: 0, durationMs: 5000 });
    expect(d.build).toMatchObject({ signer: 'CN=PrithiyaC', signedBy: 'console' });
    expect(d.commit).toMatchObject({ sha: SHA1, url: `https://github.com/the-reciprocal-solutions/human-resource-management-mobile-ess/commit/${SHA1}` });
  });

  it('serves the live log and the AAB, named for the app and version', async () => {
    expect(await get('/runs/1/jobs/2/log')).toEqual({ available: true, text: expect.stringContaining('All tests passed!') });
    const aab = await fetch(`${base}/runs/1/aab`, { headers: { cookie } });
    expect(aab.headers.get('content-disposition')).toBe('attachment; filename="fusionhrm-1.0.1-1010.aab"');
    expect(await aab.text()).toBe('AAB');
  });

  it("passes the builder's refusals through in its words, with its status", async () => {
    const missing = await fetch(`${base}/runs/9`, { headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(await message(missing)).toBe('No run 9 on this server.');
    const done = await fetch(`${base}/runs/1/cancel`, { method: 'POST', headers: { cookie } });
    expect(done.status).toBe(409);
    const app = await fetch(`${base}/apps/nope`, { headers: { cookie } });
    expect(await message(app)).toBe("There is no app 'nope' on this console.");
    const check = await send('/git/check', 'POST', { url: 'git@github.com:o/r.git', keyId: 'k_0123456789' });
    expect(check.status).toBe(422);
    expect(await message(check)).toContain('refused the key');
  });

  it('hands a keystore to the builder and a key request with the email', async () => {
    const res = await send('/apps/fusionhrm/signing', 'PUT', { keystore: Buffer.from('JKS').toString('base64'), fileName: 'upload.jks', storePassword: 'sp', keyAlias: 'upload', keyPassword: 'kp', extra: 'dropped' });
    expect(res.status).toBe(200);
    expect(last().body).toEqual({ keystore: 'SktT', fileName: 'upload.jks', storePassword: 'sp', keyAlias: 'upload', keyPassword: 'kp' });
    const key = await send('/keys', 'POST', { email: 'raja@company.com' });
    expect(((await key.json()) as { publicKey: string }).publicKey).toContain('ssh-ed25519');
    expect(last().body).toEqual({ email: 'raja@company.com', name: null });
  });

  it('passes a Mac runner through to the builder without a session: its token, its JSON, its files both ways', async () => {
    const auth = { authorization: 'Bearer rcr_0123abcd_x' };
    const poll = await fetch(`${base}/runner/v1/poll`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ activeRun: null }) });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ url: '/runner/v1/poll', method: 'POST', authorization: 'Bearer rcr_0123abcd_x', json: { activeRun: null } });
    const ipa = Buffer.alloc(3 * 1024 * 1024, 7);
    const put = await fetch(`${base}/runner/v1/runs/5/artifacts/app-release-ipa/app-release.ipa`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: ipa });
    expect(await put.json()).toMatchObject({ method: 'PUT', type: 'application/octet-stream', bytes: ipa.length });
    const src = await fetch(`${base}/runner/v1/runs/5/source`, { headers: auth });
    expect(src.headers.get('content-type')).toBe('application/gzip');
    expect(Buffer.from(await src.arrayBuffer())).toEqual(Buffer.from([0x1f, 0x8b, 0, 1, 2, 3]));
    const denied = await fetch(`${base}/runner/v1/denied`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(401);
  });

  it('re-runs through the builder and follows the new run', async () => {
    const res = await fetch(`${base}/runs/1/rerun`, { method: 'POST', headers: { cookie } });
    expect(await res.json()).toEqual({ runId: 4, number: 4 });
  });

  it('holds a Mac runner long poll open after the console API has used a pooled connection to the builder', async () => {
    // An ordinary console request: BuilderClient's axios returns its socket to the global pool.
    expect((await fetch(`${base}/apps`, { headers: { cookie } })).status).toBe(200);
    const started = Date.now();
    const poll = await fetch(`${base}/runner/v1/held`, { method: 'POST', headers: { authorization: 'Bearer rcr_0123abcd_x', 'content-type': 'application/json' }, body: '{}' });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({ held: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  });
});
