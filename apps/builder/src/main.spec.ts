import { promises as fs } from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { dirs } from './config';
import { boot, createApp, type Deps } from './main';
import type { JobDef } from './pipeline';
import { tempConfig } from './testing';

let server: Server;
let base = '';
let deps: Deps;
let token = '';

/** A pipeline of plain shell steps: the HTTP layer is under test here, not Flutter. */
const pipeline = (): JobDef[] => [
  {
    key: 'tests',
    name: 'Tests',
    needs: [],
    timeoutMin: 1,
    steps: [
      { name: 'Prepare', run: async (ctx) => { await fs.mkdir(ctx.paths.src, { recursive: true }); } },
      { name: 'Unit and widget tests', run: (ctx) => ctx.sh('echo "All tests passed!"') },
    ],
  },
];

beforeAll(async () => {
  const cfg = await tempConfig();
  token = cfg.token;
  deps = await boot(cfg, pipeline);
  server = createApp(deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (path: string, init: RequestInit = {}, t = token) =>
  fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-builder-token': t, ...(init.headers ?? {}) } });
const post = (path: string, body: unknown, method = 'POST') => call(path, { method, body: JSON.stringify(body) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

async function upload(name: string): Promise<string> {
  await fs.writeFile(join(dirs(deps.cfg).uploads, name), 'zip');
  return name;
}

describe('builder HTTP', () => {
  it('answers health without a token and everything else only with it', async () => {
    const health = await json(await fetch(`${base}/health`));
    expect(health).toMatchObject({ ok: true, busy: false, queued: 0, current: null, defaultPlayKey: null });
    expect((await call('/apps', {}, 'wrong')).status).toBe(401);
    expect((await fetch(`${base}/keys`)).status).toBe(401);
  });

  it('makes a key for a git email and shows only its public half', async () => {
    const res = await post('/keys', { email: 'raja@company.com', name: 'Raja' });
    expect(res.status).toBe(201);
    const key = await json(res);
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ raja@company\.com$/);
    expect(JSON.stringify(await json(await call('/keys')))).not.toContain('PRIVATE KEY');
    expect((await json(await post('/keys', { email: 'nope' }))).message).toContain('Enter the email of your git account');
  });

  it('refuses an HTTPS repository address with the SSH one to use', async () => {
    const keys = await json(await call('/keys'));
    const res = await post('/git/check', { url: 'https://github.com/org/app.git', keyId: keys[0].id });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain('Use git@github.com:org/app.git');
  });

  it('creates, renames and lists apps; refuses a bad package in words', async () => {
    const created = await post('/apps', { name: 'FusionHRM', packageName: 'com.fusionapps.fusionhrm' });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ id: 'fusionhrm', repo: null, signing: { mode: 'repository' } });
    expect((await json(await post('/apps/fusionhrm', { name: 'FusionHRM Android' }, 'PATCH'))).name).toBe('FusionHRM Android');
    const bad = await post('/apps', { name: 'X', packageName: 'not-a-package' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).message).toContain('is not an Android package name');
    expect((await json(await call('/apps'))).map((a: { id: string }) => a.id)).toEqual(['fusionhrm']);
    expect((await call('/apps/nope')).status).toBe(404);
  });

  it('runs an uploaded ZIP for an app, numbered within the app, then serves it and its log', async () => {
    const res = await post('/runs', { app: 'fusionhrm', source: { kind: 'zip', upload: await upload('a1.zip'), fileName: 'src-main.zip', sizeBytes: 3 }, params: { mode: 'build' } });
    expect(res.status).toBe(202);
    const run = await json(res);
    expect(run).toMatchObject({ number: 1, status: 'queued', app: { id: 'fusionhrm', packageName: 'com.fusionapps.fusionhrm' }, source: { kind: 'zip', fileName: 'src-main.zip' } });
    await deps.runner.drain();
    const done = await json(await call(`/runs/${run.id}`));
    expect(done.conclusion).toBe('success');
    expect(await (await call(`/runs/${run.id}/logs/1`)).text()).toContain('All tests passed!');
    expect((await post(`/runs/${run.id}/cancel`, {})).status).toBe(409);
    expect((await json(await call('/runs?app=fusionhrm'))).map((r: { id: number }) => r.id)).toEqual([run.id]);
    expect(await json(await call('/runs?app=other'))).toEqual([]);
  });

  it('runs again with the same source and a fresh version code, and says when the ZIP is gone', async () => {
    const first = await json(await post('/runs', { app: 'fusionhrm', source: { kind: 'zip', upload: await upload('a2.zip'), fileName: 'b.zip' }, params: { mode: 'build', versionCode: 1500 } }));
    await deps.runner.drain();
    const again = await post(`/runs/${first.id}/rerun`, {});
    expect(again.status).toBe(202);
    const second = await json(again);
    expect(second).toMatchObject({ number: first.number + 1, params: { versionCode: null }, source: { rerunOf: first.id, upload: 'a2.zip' } });
    await deps.runner.drain();
    await fs.rm(join(dirs(deps.cfg).uploads, 'a2.zip'));
    expect((await post(`/runs/${first.id}/rerun`, {})).status).toBe(410);
  });

  it('refuses a git run for an app without a repository, bad parameters, and paths outside uploads/', async () => {
    const git = await post('/runs', { app: 'fusionhrm', source: { kind: 'git' }, params: { mode: 'build' } });
    expect(git.status).toBe(409);
    expect((await json(git)).message).toContain('has no repository yet');
    const notes = await post('/runs', { app: 'fusionhrm', source: { kind: 'zip', upload: await upload('a3.zip') }, params: { mode: 'release' } });
    expect((await json(notes)).message).toContain('Release notes are required');
    expect((await post('/runs', { app: 'fusionhrm', source: { kind: 'zip', upload: '../runs/.counter' }, params: { mode: 'build' } })).status).toBe(400);
    expect((await call('/runs/999')).status).toBe(404);
  });

  it('will not delete a key an app uses, and deletes an app with its runs', async () => {
    const keys = await json(await call('/keys'));
    const app = await json(await post('/apps', { name: 'Hive', packageName: 'com.skillhive.hive', repo: { url: 'ssh://git@127.0.0.1:1/org/hive.git', keyId: keys[0].id } }));
    expect(app.repo).toMatchObject({ host: '127.0.0.1', slug: 'org/hive', access: { state: 'failed' } });
    const del = await call(`/keys/${keys[0].id}`, { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect((await json(del)).message).toContain('Hive still uses this key');
    const removed = await json(await call('/apps/fusionhrm', { method: 'DELETE' }));
    expect(removed.removedRuns).toBeGreaterThanOrEqual(3);
    expect(await json(await call('/runs?app=fusionhrm'))).toEqual([]);
  });
});
