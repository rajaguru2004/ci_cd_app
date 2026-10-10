import { promises as fs } from 'fs';
import { join } from 'path';
import type { JobDef, Services } from './pipeline';
import { Runner } from './runner';
import { RunStore } from './store';
import { tempConfig } from './testing';
import type { RunApp, RunParams, RunRecord } from './types';

/**
 * The engine with a pipeline of plain shell commands (no Flutter), checking the states it
 * records against what GitHub Actions would report for the same outcomes.
 */

const params: RunParams = { mode: 'build', track: 'internal', releaseNotes: '', releaseStatus: 'completed', versionName: '', versionCode: 7, rehearsal: false };
const app: RunApp = { id: 'demo', name: 'Demo', packageName: 'com.example.demo', signing: 'repository', projectPath: '' };
const services = {} as Services;

async function setup(pipeline: JobDef[]) {
  const cfg = await tempConfig();
  const data = cfg.dataDir;
  const uploads = join(data, 'uploads');
  await fs.mkdir(uploads, { recursive: true });
  await fs.writeFile(join(uploads, 'u.zip'), 'zip');
  const store = new RunStore(join(data, 'runs'));
  await store.init();
  const runner = new Runner(cfg, store, () => pipeline, uploads, services);
  let number = 0;
  // The engine runs steps in the project folder; give these runs one.
  const start = async () => {
    number += 1;
    const run = await runner.create({ app, number, source: { kind: 'zip', upload: 'u.zip', fileName: 'src.zip', sizeBytes: 3 }, startedBy: 'test', params });
    await fs.mkdir(join(store.dir(run.id), 'src'), { recursive: true });
    return run;
  };
  return { runner, store, data, start, cfg };
}

const job = (key: string, needs: string[], steps: JobDef['steps']): JobDef => ({ key, name: key, needs, timeoutMin: 1, steps });
const shStep = (name: string, cmd: string, extra: Partial<JobDef['steps'][number]> = {}) => ({ name, run: (ctx: Parameters<JobDef['steps'][number]['run']>[0]) => ctx.sh(cmd), ...extra });
const states = (run: RunRecord) => run.jobs.map((j) => [j.name, j.conclusion, j.steps.map((s) => `${s.name}:${s.conclusion}`)]);

describe('Runner', () => {
  it('runs every job and step in order and records GitHub-style success', async () => {
    const { runner, store, start } = await setup([
      job('Plan', [], [shStep('Set up job', 'echo setting up'), shStep('Resolve plan', 'echo planned')]),
      job('Tests', ['Plan'], [shStep('Unit and widget tests', 'echo "All tests passed!"')]),
    ]);
    const run = await start();
    expect(run.jobs.every((j) => j.status === 'queued' && j.steps.every((s) => s.status === 'queued'))).toBe(true);
    await runner.drain();
    const done = (await store.get(run.id))!;
    expect(done).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(states(done)).toEqual([
      ['Plan', 'success', ['Set up job:success', 'Resolve plan:success']],
      ['Tests', 'success', ['Unit and widget tests:success']],
    ]);
    for (const s of done.jobs.flatMap((j) => j.steps)) expect(Date.parse(s.completed_at!)).toBeGreaterThanOrEqual(Date.parse(s.started_at!));
  });

  it('writes logs GitHub\'s way: timestamps, a Run group per step, the error at the end', async () => {
    const { runner, store, start } = await setup([job('Tests', [], [shStep('Unit and widget tests', 'echo one; echo two >&2; exit 3')])]);
    const run = await start();
    await runner.drain();
    const log = await fs.readFile(join(store.dir(run.id), 'logs', '1.log'), 'utf8');
    const lines = log.trim().split('\n').map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ''));
    expect(lines).toEqual(['##[group]Run echo one; echo two >&2; exit 3', '##[endgroup]', 'one', 'two', '##[error]Process completed with exit code 3.']);
  });

  it('skips the rest of a failed job except "always" and cleanup steps, and skips jobs that needed it', async () => {
    const { runner, store, start } = await setup([
      job('Tests', [], [
        shStep('Static analysis', 'exit 1'),
        shStep('Unit and widget tests', 'echo never'),
        shStep('Upload test results', 'echo saved', { always: true }),
        shStep('Complete job', 'echo cleaned', { cleanup: true }),
      ]),
      job('Signed AAB', ['Tests'], [shStep('Build signed AAB', 'echo never')]),
    ]);
    const run = await start();
    await runner.drain();
    const done = (await store.get(run.id))!;
    expect(done.conclusion).toBe('failure');
    expect(states(done)).toEqual([
      ['Tests', 'failure', ['Static analysis:failure', 'Unit and widget tests:skipped', 'Upload test results:success', 'Complete job:success']],
      ['Signed AAB', 'skipped', ['Build signed AAB:skipped']],
    ]);
  });

  it('cancels a running step by killing its process group, and cancels what is left', async () => {
    const { runner, store, start } = await setup([
      job('Tests', [], [
        shStep('Unit and widget tests', 'sleep 30 & sleep 30; echo unreachable'),
        shStep('Upload test results', 'echo saved', { always: true }),
        shStep('Complete job', 'echo cleaned', { cleanup: true }),
      ]),
      job('Signed AAB', ['Tests'], [shStep('Build signed AAB', 'echo never')]),
    ]);
    const run = await start();
    for (let i = 0; i < 50 && (await store.get(run.id))!.jobs[0].steps[0].status !== 'in_progress'; i += 1) await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await runner.cancel(run.id);
    await runner.drain();
    expect(Date.now() - t0).toBeLessThan(8000);
    const done = (await store.get(run.id))!;
    expect(done.conclusion).toBe('cancelled');
    expect(states(done)).toEqual([
      ['Tests', 'cancelled', ['Unit and widget tests:cancelled', 'Upload test results:cancelled', 'Complete job:success']],
      ['Signed AAB', 'cancelled', ['Build signed AAB:cancelled']],
    ]);
  }, 15000);

  it('cancels a queued run without starting it', async () => {
    const { runner, store, start } = await setup([job('Tests', [], [shStep('Unit and widget tests', 'sleep 1')])]);
    const first = await start();
    const second = await start();
    await runner.cancel(second.id);
    await runner.drain();
    expect((await store.get(first.id))!.conclusion).toBe('success');
    const cancelled = (await store.get(second.id))!;
    expect(cancelled).toMatchObject({ status: 'completed', conclusion: 'cancelled', startedAt: null });
  });

  it('marks a run the builder was killed in as failed on restart, and resumes queued ones', async () => {
    const { store, data, cfg } = await setup([]);
    const base = { app, number: 1, createdAt: 'x', updatedAt: 'x', completedAt: null, params, plan: null, error: null, runner: 'server' as const, remote: null, source: { kind: 'zip' as const, fileName: 'a.zip', upload: 'u.zip', sizeBytes: 1, sha: null, root: null, commit: null, startedBy: 't', rerunOf: null } };
    await store.save({ ...base, id: 1, status: 'in_progress', conclusion: null, startedAt: 'x', jobs: [{ id: 1, name: 'Tests', status: 'in_progress', conclusion: null, started_at: 'x', completed_at: null, steps: [{ name: 'Unit and widget tests', number: 1, status: 'in_progress', conclusion: null, started_at: 'x', completed_at: null }] }] });
    await store.save({ ...base, id: 2, status: 'queued', conclusion: null, startedAt: null, jobs: [{ id: 1, name: 'Tests', status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [{ name: 'Unit and widget tests', number: 1, status: 'queued', conclusion: null, started_at: null, completed_at: null }] }] });
    await fs.mkdir(join(store.dir(2), 'src'), { recursive: true });
    const runner = new Runner(cfg, store, () => [job('Tests', [], [shStep('Unit and widget tests', 'echo resumed')])], join(data, 'uploads'), services);
    await runner.recover();
    await runner.drain();
    expect(await store.get(1)).toMatchObject({ status: 'completed', conclusion: 'failure', error: expect.stringContaining('restarted') });
    expect((await store.get(2))!.conclusion).toBe('success');
  });

  it('reads runs recorded before apps existed as ZIP runs of no app, numbered by their id', async () => {
    const { store } = await setup([]);
    await fs.mkdir(store.dir(7), { recursive: true });
    await fs.writeFile(
      join(store.dir(7), 'run.json'),
      JSON.stringify({ id: 7, status: 'completed', conclusion: 'success', createdAt: 'x', startedAt: 'x', updatedAt: 'x', completedAt: 'x', source: { fileName: 'a.zip', upload: 'u.zip', sizeBytes: 1, sha: 'abc', root: 'r', uploadedBy: 'console', rerunOf: null }, params: { ...params, versionCode: 1007 }, plan: null, jobs: [], error: null }),
    );
    expect(await store.get(7)).toMatchObject({ app: null, number: 7, source: { kind: 'zip', fileName: 'a.zip', sha: 'abc', startedBy: 'console', commit: null }, params: { versionCode: 1007 } });
  });

  it('tells which app is uploading to Google Play, so nothing reads Play meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { runner, start } = await setup([job('Google Play', [], [{ name: 'Upload to Google Play', run: () => gate }])]);
    const run = await start();
    for (let i = 0; i < 50 && !runner.uploading('com.example.demo'); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(runner.uploading('com.example.demo')).toBe(`Demo #${run.number} is uploading to Google Play.`);
    expect(runner.uploading('com.other.app')).toBeNull();
    expect(runner.current).toMatchObject({ id: run.id, appId: 'demo', number: run.number, job: 'Google Play' });
    release();
    await runner.drain();
    expect(runner.uploading('com.example.demo')).toBeNull();
  });

  it('removes the unpacked source after a run and keeps the artifacts', async () => {
    const { runner, store, start } = await setup([
      job('Signed AAB', [], [{ name: 'Upload AAB', run: async (ctx) => { await fs.mkdir(ctx.paths.artifacts, { recursive: true }); await fs.writeFile(join(ctx.paths.artifacts, 'a.aab'), 'x'); } }]),
    ]);
    const run = await start();
    await runner.drain();
    await expect(fs.access(join(store.dir(run.id), 'src'))).rejects.toThrow();
    await expect(fs.access(join(store.dir(run.id), 'artifacts', 'a.aab'))).resolves.toBeUndefined();
  });
});
