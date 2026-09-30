/**
 * The whole API, booted as in production (guards, pipes, filters), against a loopback HTTP
 * server that answers like GitHub's REST API: runs, jobs with steps named as release.yml
 * names them, artifact zips and job logs behind 302 redirects to storage. It proves the
 * console's contract with GitHub end to end without touching GitHub.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { strToU8, zipSync } from 'fflate';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

const REPO = '/repos/o/r';
const t = (m: number) => new Date(Date.UTC(2026, 8, 30, 9, m)).toISOString();

let gh: Server;
let ghUrl = '';
let app: INestApplication;
let base = '';
let cookie = '';
const dispatched: unknown[] = [];
const posted: string[] = [];

const ok = (name: string, a: number, b: number, n: number) => ({ name, status: 'completed', conclusion: 'success', number: n, started_at: t(a), completed_at: t(b) });

const jobs11 = [
  { id: 1101, run_id: 11, name: 'Plan', status: 'completed', conclusion: 'success', html_url: 'https://gh/j/1101', started_at: t(0), completed_at: t(1), steps: [ok('Set up job', 0, 0, 1), ok('Checkout code', 0, 1, 2), ok('Resolve plan', 1, 1, 3), ok('Upload plan', 1, 1, 4), ok('Complete job', 1, 1, 5)] },
  { id: 1102, run_id: 11, name: 'Tests', status: 'completed', conclusion: 'success', html_url: 'https://gh/j/1102', started_at: t(1), completed_at: t(7), steps: [ok('Set up job', 1, 1, 1), ok('Checkout code', 1, 2, 2), ok('Set up Flutter', 2, 3, 3), ok('Install dependencies', 3, 4, 4), ok('Static analysis', 4, 5, 5), ok('Unit and widget tests', 5, 7, 6), ok('Translation and widget-key checks', 7, 7, 7), ok('Upload test results', 7, 7, 8), ok('Complete job', 7, 7, 9)] },
  { id: 1103, run_id: 11, name: 'Emulator smoke suite', status: 'completed', conclusion: 'skipped', html_url: 'https://gh/j/1103', steps: [] },
  { id: 1104, run_id: 11, name: 'Signed AAB', status: 'completed', conclusion: 'success', html_url: 'https://gh/j/1104', started_at: t(7), completed_at: t(15), steps: [ok('Set up job', 7, 7, 1), ok('Build signed AAB', 8, 14, 5), ok('Verify signature', 14, 14, 6), ok('Upload AAB', 14, 15, 7)] },
  { id: 1105, run_id: 11, name: 'Google Play', status: 'completed', conclusion: 'success', html_url: 'https://gh/j/1105', started_at: t(15), completed_at: t(18), steps: [ok('Set up job', 15, 15, 1), ok('Checkout code', 15, 15, 2), ok('Set up Ruby and Fastlane', 15, 16, 3), ok('Download AAB', 16, 16, 4), ok('Write release notes', 16, 16, 5), ok('Upload to Google Play', 16, 18, 6), ok('Upload release info', 18, 18, 7)] },
  { id: 1106, run_id: 11, name: 'Google Play access', status: 'completed', conclusion: 'skipped', html_url: 'https://gh/j/1106', steps: [] },
];

const jobs12 = [
  { ...jobs11[0], id: 1201, run_id: 12 },
  { id: 1202, run_id: 12, name: 'Tests', status: 'in_progress', conclusion: null, html_url: 'https://gh/j/1202', started_at: t(21), steps: [ok('Set up job', 21, 21, 1), ok('Checkout code', 21, 22, 2), { name: 'Set up Flutter', status: 'in_progress', conclusion: null, number: 3, started_at: t(22), completed_at: null }] },
];

const run = (id: number, extra: object) => ({
  id,
  run_number: id,
  run_attempt: 1,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: 'c1',
  html_url: `https://gh/run/${id}`,
  path: '.github/workflows/release.yml',
  created_at: t(0),
  updated_at: t(18),
  run_started_at: t(0),
  actor: { login: 'rajaguru2004', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
  head_commit: { id: 'c1', message: 'release(internal): Faster check-in\n\nDetails.', timestamp: t(0), author: { name: 'Raja' } },
  ...extra,
});

const runs = [
  run(13, { event: 'push', head_sha: 'c3', conclusion: 'skipped', display_title: 'chore: docs', head_commit: { id: 'c3', message: 'chore: docs', timestamp: t(30) } }),
  run(12, { head_sha: 'c2', status: 'in_progress', conclusion: null, display_title: 'Build and test · main · abc123', updated_at: t(22), run_started_at: t(21) }),
  run(11, { event: 'push', display_title: 'release(internal): Faster check-in' }),
];

const zip = (files: Record<string, string | Uint8Array>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));

const ev = (o: object) => JSON.stringify(o);
const artifacts: Record<number, { name: string; body: Buffer }> = {
  101: { name: 'pipeline-plan', body: zip({ 'plan.json': JSON.stringify({ mode: 'release', trigger: 'commit', tag: null, track: 'internal', releaseStatus: 'completed', versionName: '1.0.2', versionCode: 1011, integrationTests: false, publish: true, releaseNotes: 'Faster check-in', requestId: null, commit: 'c1', ref: 'refs/heads/main' }) }) },
  102: { name: 'test-results', body: zip({ 'flutter-test.json': [ev({ type: 'testStart', test: { id: 1, name: 'a', suiteID: 0 } }), ev({ type: 'testDone', testID: 1, result: 'success', hidden: false, skipped: false }), ev({ type: 'done', success: true, time: 64000 })].join('\n') }) },
  103: { name: 'build-info', body: zip({ 'build-info.json': JSON.stringify({ versionName: '1.0.2', versionCode: 1011, sizeBytes: 3, sha256: 'ab'.repeat(32), signer: 'CN=PrithiyaC, OU=SkillHive', certSha256: 'ED:6C', commit: 'c1', ref: 'main', builtAt: t(15) }) }) },
  104: { name: 'play-release', body: zip({ 'release-info.json': JSON.stringify({ packageName: 'com.fusionapps.fusionhrm', track: 'internal', releaseStatus: 'completed', versionName: '1.0.2', versionCode: 1011, previousHighestVersionCode: 9, uploadedAt: t(18), storeUrl: 'https://play.google.com/store/apps/details?id=com.fusionapps.fusionhrm' }) }) },
  105: { name: 'app-release-aab', body: zip({ 'bundle/release/app-release.aab': 'AAB', 'mapping/release/mapping.txt': 'map' }) },
};

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function github(req: IncomingMessage, res: ServerResponse, body: string) {
  const url = new URL(req.url ?? '/', ghUrl);
  const p = url.pathname;
  if (p.startsWith('/storage/')) {
    const m = /\/storage\/(\d+)\.zip/.exec(p);
    if (m) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      return res.end(artifacts[Number(m[1])].body);
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`${t(5)} ##[group]Run flutter test\n${t(5)} ##[endgroup]\n${t(6)} All tests passed!\n`);
  }
  if (req.headers.authorization !== 'Bearer ghp_test') return send(res, 401, { message: 'Bad credentials' });
  if (p === REPO) return send(res, 200, { full_name: 'o/r', private: true, default_branch: 'main', html_url: 'https://gh/o/r' });
  if (p === `${REPO}/commits`) {
    return send(res, 200, ['c3', 'c2', 'c1'].map((sha, i) => ({ sha, html_url: `https://gh/c/${sha}`, commit: { message: ['chore: docs', 'feat: payslips offline', 'release(internal): Faster check-in\n\nDetails.'][i], author: { name: 'Raja', date: t(30 - i * 10) } }, author: { login: 'rajaguru2004', avatar_url: null } })));
  }
  if (p === `${REPO}/tags`) return send(res, 200, [{ name: 'v1.0.2', commit: { sha: 'c1' } }]);
  if (p === `${REPO}/branches`) return send(res, 200, [{ name: 'main', commit: { sha: 'c3' } }, { name: 'feat/x', commit: { sha: 'x' } }]);
  if (p === `${REPO}/actions/workflows/release.yml/runs`) return send(res, 200, { total_count: runs.length, workflow_runs: runs });
  if (p === `${REPO}/actions/workflows/release.yml/dispatches` && req.method === 'POST') {
    dispatched.push(JSON.parse(body));
    return send(res, 200, { workflow_run_id: 14, html_url: 'https://gh/run/14' });
  }
  let m = /\/actions\/runs\/(\d+)$/.exec(p);
  if (m) return send(res, 200, runs.find((r) => r.id === Number(m![1])));
  m = /\/actions\/runs\/(\d+)\/jobs$/.exec(p);
  if (m) return send(res, 200, { total_count: 0, jobs: Number(m[1]) === 11 ? jobs11 : jobs12 });
  m = /\/actions\/runs\/(\d+)\/artifacts$/.exec(p);
  if (m) {
    const list = Number(m[1]) === 11 ? Object.entries(artifacts).map(([id, a]) => ({ id: Number(id), name: a.name, size_in_bytes: a.body.length, expired: false })) : [];
    return send(res, 200, { total_count: list.length, artifacts: list });
  }
  m = /\/actions\/artifacts\/(\d+)\/zip$/.exec(p);
  if (m) return send(res, 302, undefined, { location: `${ghUrl}/storage/${m[1]}.zip?sig=x` });
  m = /\/actions\/jobs\/(\d+)\/logs$/.exec(p);
  if (m) return send(res, 302, undefined, { location: `${ghUrl}/storage/log-${m[1]}.txt?sig=x` });
  m = /\/actions\/jobs\/(\d+)$/.exec(p);
  if (m) return send(res, 200, [...jobs11, ...jobs12].find((j) => j.id === Number(m![1])));
  m = /\/actions\/runs\/(\d+)\/(cancel|rerun|rerun-failed-jobs)$/.exec(p);
  if (m && req.method === 'POST') {
    posted.push(`${m[2]} ${m[1]}`);
    return send(res, m[2] === 'cancel' ? 202 : 201, {});
  }
  return send(res, 404, { message: 'Not Found' });
}

beforeAll(async () => {
  gh = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => github(req, res, body));
  });
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
  ghUrl = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;

  Object.assign(process.env, {
    GITHUB_TOKEN: 'ghp_test',
    GITHUB_REPO: 'o/r',
    GITHUB_API_URL: ghUrl,
    CONSOLE_PASSWORD: 'correct horse battery',
    SESSION_SECRET: 's'.repeat(64),
    PLAY_SERVICE_ACCOUNT_FILE: '/nonexistent/play.json',
  });
  const { AppModule } = await import('./app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, stopAtFirstError: true }));
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => gh.close(() => r()));
});

// Response bodies here are asserted field by field; `any` keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonResponse = Omit<Response, 'json'> & { json(): Promise<any> };

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } }) as unknown as Promise<JsonResponse>;

describe('console API against a GitHub-shaped server', () => {
  it('refuses everything but sign-in and health without a session', async () => {
    expect((await fetch(`${base}/stream`)).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const bad = (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })) as unknown as JsonResponse;
    expect(bad.status).toBe(401);
    expect((await bad.json()).message).toBe('That password is not the console password.');
  });

  it('signs in with the console password and sets an httpOnly session cookie', async () => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
    expect(res.status).toBe(204);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/mci_session=.+; .*HttpOnly/i);
    cookie = set.split(';')[0];
    expect((await api('/auth/me')).status).toBe(200);
  });

  it('streams the branch with each commit\'s runs, flags and stage rings; skipped pushes are dropped', async () => {
    const s = await (await api('/stream')).json();
    expect(s.branch).toBe('main');
    expect(s.workflow).toEqual({ present: true, file: 'release.yml' });
    const [c3, c2, c1] = s.commits;
    expect(c3.runs).toEqual([]);
    expect(c2.runs[0]).toMatchObject({ id: 12, state: 'running', trigger: 'console', mode: 'build', requestId: 'abc123' });
    // Tests has moved on to "Set up Flutter", so checkout is finished and dependencies are running.
    expect(c2.runs[0].stages.map((x: { state: string }) => x.state)).toEqual(['success', 'running', 'queued', 'pending', 'pending', 'pending']);
    expect(c1).toMatchObject({ tags: ['v1.0.2'], release: { track: 'internal', notes: 'Faster check-in' } });
    expect(c1.runs[0]).toMatchObject({ id: 11, state: 'success', trigger: 'commit', mode: 'release', track: 'internal' });
    expect(c1.runs[0].stages.every((x: { state: string }) => x.state === 'success')).toBe(true);
  });

  it('details a finished release from its artifacts', async () => {
    const d = await (await api('/runs/11')).json();
    expect(d.plan).toMatchObject({ mode: 'release', versionCode: 1011, track: 'internal' });
    expect(d.tests).toMatchObject({ passed: 1, failed: 0, success: true, durationMs: 64000 });
    expect(d.build).toMatchObject({ versionName: '1.0.2', signer: 'CN=PrithiyaC, OU=SkillHive' });
    expect(d.release).toMatchObject({ track: 'internal', versionCode: 1011 });
    expect(d.failure).toBeNull();
    expect(d.stages.find((x: { key: string }) => x.key === 'play').steps.map((x: { name: string }) => x.name)).toEqual(['Upload to Google Play', 'Upload release info']);
  });

  it('serves a finished job\'s log and says honestly when a running job has none yet', async () => {
    expect(await (await api('/runs/11/jobs/1102/log')).json()).toEqual({ available: true, text: expect.stringContaining('All tests passed!') });
    expect(await (await api('/runs/12/jobs/1202/log')).json()).toMatchObject({ available: false, liveUrl: 'https://gh/j/1202' });
    expect((await api('/runs/11/jobs/1202/log')).status).toBe(404);
  });

  it('hands over the signed AAB named after its version', async () => {
    const res = await api('/runs/11/aab');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="fusionhrm-1.0.2-1011.aab"');
    expect(await res.text()).toBe('AAB');
    expect(await (await api('/runs/11/aab?file=mapping')).text()).toBe('map');
    expect((await api('/runs/12/aab')).status).toBe(404);
  });

  it('dispatches release.yml with the inputs the plan script reads, and gets the run id back', async () => {
    const res = await api('/runs', { method: 'POST', body: JSON.stringify({ branch: 'main', mode: 'release', track: 'beta', releaseNotes: ' Arabic fixes ', releaseStatus: 'draft' }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ runId: 14, url: 'https://gh/run/14' });
    expect(dispatched.at(-1)).toMatchObject({
      ref: 'main',
      return_run_details: true,
      inputs: { mode: 'release', track: 'beta', release_notes: 'Arabic fixes', release_status: 'draft', version_name: '', integration_tests: 'false', rehearsal: 'false', request_id: expect.stringMatching(/^[0-9a-f]{6}$/) },
    });
  });

  it('passes a rehearsal through only for releases', async () => {
    await api('/runs', { method: 'POST', body: JSON.stringify({ branch: 'main', mode: 'release', track: 'internal', releaseNotes: 'x', rehearsal: true }) });
    expect(dispatched.at(-1)).toMatchObject({ inputs: { mode: 'release', rehearsal: 'true' } });
    await api('/runs', { method: 'POST', body: JSON.stringify({ branch: 'main', mode: 'build', rehearsal: true }) });
    expect(dispatched.at(-1)).toMatchObject({ inputs: { mode: 'build', rehearsal: 'false' } });
  });

  it('refuses a release without notes, and bad input, in words', async () => {
    const res = await api('/runs', { method: 'POST', body: JSON.stringify({ branch: 'main', mode: 'release' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('Release notes are required');
    const bad = await api('/runs', { method: 'POST', body: JSON.stringify({ branch: 'main', mode: 'release', track: 'staging', releaseNotes: 'x' }) });
    expect((await bad.json()).message).toEqual(['track must be one of: internal, alpha, beta, production.']);
  });

  it('cancels and re-runs through GitHub', async () => {
    expect((await api('/runs/12/cancel', { method: 'POST' })).status).toBe(202);
    expect((await api('/runs/11/rerun', { method: 'POST' })).status).toBe(202);
    expect(posted).toEqual(['cancel 12', 'rerun 11']);
  });

  it('reports the Play key as missing without calling Google', async () => {
    expect(await (await api('/play')).json()).toMatchObject({ configured: false, packageName: 'com.fusionapps.fusionhrm' });
  });
});
