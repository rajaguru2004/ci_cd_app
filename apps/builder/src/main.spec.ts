import { promises as fs } from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { readConfig } from './config';
import { createApp } from './main';
import type { JobDef } from './pipeline';
import { Runner } from './runner';
import { RunStore } from './store';

const TOKEN = 'b'.repeat(40);
let server: Server;
let base = '';
let runner: Runner;
let uploads = '';

const pipeline: JobDef[] = [{ key: 'Tests', name: 'Tests', needs: [], timeoutMin: 1, steps: [{ name: 'Unit and widget tests', run: (ctx) => ctx.sh('echo "All tests passed!"') }] }];

beforeAll(async () => {
  const data = await fs.mkdtemp(join(tmpdir(), 'builder-http-'));
  uploads = join(data, 'uploads');
  await fs.mkdir(uploads, { recursive: true });
  const cfg = readConfig({ BUILDER_TOKEN: TOKEN, DATA_DIR: data });
  const store = new RunStore(join(data, 'runs'));
  await store.init();
  runner = new Runner(cfg, store, () => pipeline, uploads);
  // Runs execute in the project folder; the fake pipeline never unpacks one, so give it one.
  const create = runner.create.bind(runner);
  runner.create = async (input) => {
    const id = await store.nextId().then((n) => n + 1);
    await fs.mkdir(join(store.dir(id), 'src'), { recursive: true });
    await fs.writeFile(join(data, 'runs', '.counter'), JSON.stringify({ last: id - 1 }));
    return create(input);
  };
  server = createApp(cfg, runner, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-builder-token': token, ...(init.headers ?? {}) } });

describe('builder HTTP', () => {
  it('answers health without a token and everything else only with it', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await call('/runs', {}, 'wrong')).status).toBe(401);
    expect((await fetch(`${base}/runs`)).status).toBe(401);
  });

  it('starts a run for an uploaded file, then serves it, its log, and refuses to cancel it once done', async () => {
    await fs.writeFile(join(uploads, 'a1.zip'), 'zip');
    const res = await call('/runs', { method: 'POST', body: JSON.stringify({ upload: 'a1.zip', fileName: 'src-main.zip', sizeBytes: 3, params: { mode: 'build', versionCode: 1001 } }) });
    expect(res.status).toBe(202);
    const run = (await res.json()) as { id: number; status: string };
    expect(run.status).toBe('queued');
    await runner.drain();
    const done = (await (await call(`/runs/${run.id}`)).json()) as { conclusion: string; jobs: Array<{ id: number }> };
    expect(done.conclusion).toBe('success');
    expect(await (await call(`/runs/${run.id}/logs/${done.jobs[0].id}`)).text()).toContain('All tests passed!');
    expect((await call(`/runs/${run.id}/cancel`, { method: 'POST' })).status).toBe(409);
    const list = (await (await call('/runs')).json()) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses bad parameters in words, and paths outside uploads/', async () => {
    await fs.writeFile(join(uploads, 'a2.zip'), 'zip');
    const bad = await call('/runs', { method: 'POST', body: JSON.stringify({ upload: 'a2.zip', params: { mode: 'release', versionCode: 5 } }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain('Release notes are required');
    const escape = await call('/runs', { method: 'POST', body: JSON.stringify({ upload: '../runs/.counter', params: { mode: 'build', versionCode: 5 } }) });
    expect(escape.status).toBe(400);
    expect((await call('/runs/999')).status).toBe(404);
  });

  it('re-runs with a new version code, and says so when the upload is gone', async () => {
    await fs.writeFile(join(uploads, 'a3.zip'), 'zip');
    const first = (await (await call('/runs', { method: 'POST', body: JSON.stringify({ upload: 'a3.zip', params: { mode: 'build', versionCode: 10 } }) })).json()) as { id: number };
    await runner.drain();
    const again = await call(`/runs/${first.id}/rerun`, { method: 'POST', body: JSON.stringify({ versionCode: 11 }) });
    expect(again.status).toBe(202);
    const second = (await again.json()) as { id: number; params: { versionCode: number }; source: { rerunOf: number } };
    expect(second.params.versionCode).toBe(11);
    expect(second.source.rerunOf).toBe(first.id);
    await runner.drain();
    await fs.rm(join(uploads, 'a3.zip'));
    expect((await call(`/runs/${first.id}/rerun`, { method: 'POST', body: '{}' })).status).toBe(410);
  });
});
