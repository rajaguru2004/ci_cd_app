import { ChildProcess, execFileSync, spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { userInfo } from 'os';
import { connect } from 'net';
import { join } from 'path';
import { GithubActions } from './actions';
import { AppStore } from './apps';
import { dirs } from './config';
import { Git } from './git';
import { GithubClient } from './github';
import { JobLog } from './log';
import { KeyStore } from './keys';
import { PlayClient } from './play';
import { releasePipeline, type Services } from './pipeline';
import { Runner } from './runner';
import { RunStore } from './store';
import { FakeGithub } from './testing-github';
import { tempConfig } from './testing';
import type { JobRecord, RunParams, RunRecord } from './types';
import { Vault } from './vault';
import { WORKFLOW_PATH, type WorkflowPlan } from './workflow';

/**
 * A run on GitHub Actions through the real `Runner` and the real `githubPipeline`: git pull
 * over a real sshd, the Plan job on this server, then jobs mirrored from a stand-in GitHub API
 * until the run ends — success, resuming after the builder restarts mid-dispatch, and a
 * cancel. `actions.spec.ts` covers `GithubActions` on its own; this is the wiring around it.
 */

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p));
const maybe = SSHD ? describe : describe.skip;
if (!SSHD) console.warn('runner/GitHub specs skipped: no sshd on this machine');

const pipelineDir = join(__dirname, '..', '..', '..', 'mobile-pipeline');
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@company.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString().trim();

async function sshFixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'rc-sshd-'));
  const work = join(root, 'work');
  await fs.mkdir(join(work, 'android/app'), { recursive: true });
  await fs.writeFile(join(work, 'pubspec.yaml'), 'name: acme_app\nversion: 1.0.1+9\ndependencies:\n  flutter:\n    sdk: flutter\n');
  await fs.writeFile(join(work, 'android/app/build.gradle.kts'), 'android {\n    namespace = "com.acme.app"\n    defaultConfig {\n        applicationId = "com.acme.app"\n    }\n}\n');
  sh(work, 'init', '-q');
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', 'feat: first screen');
  sh(root, 'clone', '-q', '--bare', work, join(root, 'repo.git'));

  await fs.writeFile(join(root, 'authorized_keys'), '', { mode: 0o600 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host_key')]);
  const port = 20000 + Math.floor(Math.random() * 20000);
  await fs.writeFile(
    join(root, 'sshd_config'),
    [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(root, 'host_key')}`, `AuthorizedKeysFile ${join(root, 'authorized_keys')}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', `PidFile ${join(root, 'sshd.pid')}`, ''].join('\n'),
  );
  const sshd = spawn(SSHD!, ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    const up = await new Promise<boolean>((r) => {
      const s = connect(port, '127.0.0.1', () => (s.end(), r(true)));
      s.on('error', () => r(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const url = `ssh://${userInfo().username}@127.0.0.1:${port}${join(root, 'repo.git')}`;
  return { root, url, sshd };
}

interface Harness {
  fake: FakeGithub;
  apps: AppStore;
  github: GithubActions;
  runner: Runner;
  store: RunStore;
  appId: string;
}

let fixture: Awaited<ReturnType<typeof sshFixture>>;
const harnesses: Harness[] = [];

beforeAll(async () => {
  if (!SSHD) return;
  fixture = await sshFixture();
}, 30_000);

afterAll(() => {
  fixture?.sshd.kill();
});

afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.fake.stop()));
  harnesses.length = 0;
});

async function harness(): Promise<Harness> {
  const fake = await new FakeGithub().start();
  const cfg = await tempConfig({ GITHUB_API_URL: fake.url, PIPELINE_DIR: pipelineDir });
  const d = dirs(cfg);
  const vault = new Vault(d.vault, cfg.vaultKey, cfg.scratchDir);
  await vault.init();
  const keys = new KeyStore(vault);
  const git = new Git(d.repos, vault, keys, 60_000);
  const apps = new AppStore(d.apps, vault, keys, git, cfg.scratchDir, cfg.playKeyFile);
  await apps.init();
  const github = new GithubActions(new GithubClient(fake.url), vault, apps, cfg.pipelineDir);
  github.pollMs = 15;

  const key = await keys.create('dev@company.com', null);
  await fs.appendFile(join(fixture.root, 'authorized_keys'), `${key.publicKey}\n`);
  const app = await apps.create({ name: 'Acme App', packageName: 'com.acme.app', repo: { url: fixture.url, keyId: key.id } });
  expect(app.repo!.access.state).toBe('ok');
  // The repository lives on a local test sshd, not github.com; point its GitHub setup at the
  // fake server's own repo directly (what `setRunner` would compute were the host github.com).
  const file = join(d.apps, app.id, 'app.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.runner = { kind: 'github', github: { repo: 'acme/app', workflow: 'release-console.yml', token: 'default', tokenLogin: null, check: null, secrets: { syncedAt: null, hash: null } } };
  await fs.writeFile(file, JSON.stringify(raw));
  fake.addRepo('acme/app', { files: { [WORKFLOW_PATH]: (await github.workflow()).yaml } });
  await github.setDefaultToken(fake.token);

  const store = new RunStore(d.runs);
  await store.init();
  const locks = new Map<string, Promise<unknown>>();
  const services: Services = {
    apps,
    git,
    play: new PlayClient('http://127.0.0.1:1'),
    github,
    usedVersionCodes: async () => [],
    lockApp: (id, fn) => {
      const next = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
      locks.set(id, next);
      return next.finally(() => {
        if (locks.get(id) === next) locks.delete(id);
      });
    },
  };
  const runner = new Runner(cfg, store, releasePipeline, d.uploads, services);
  const h: Harness = { fake, apps, github, runner, store, appId: app.id };
  harnesses.push(h);
  return h;
}

const buildParams: RunParams = { mode: 'build', track: 'internal', releaseNotes: '', releaseStatus: 'completed', versionName: '', versionCode: null, rehearsal: false };
const iso = () => new Date().toISOString();

maybe('a run on GitHub Actions, through the real Runner and pipeline', () => {
  it('pulls, plans, dispatches, and mirrors GitHub’s jobs through to success', async () => {
    const h = await harness();
    const app = await h.apps.require(h.appId);
    const run = await h.runner.create({
      app: h.apps.snapshot(app),
      number: 1,
      source: { kind: 'git', url: app.repo!.url, branch: 'main', requestedSha: null },
      params: buildParams,
      startedBy: 'test',
      runner: 'github',
      github: { repo: app.runner.github!.repo, workflow: app.runner.github!.workflow },
    });
    expect(run.runner).toBe('github');

    await h.runner.drain();
    const done = (await h.store.get(run.id))!;
    expect(done.status).toBe('completed');
    expect(done.conclusion).toBe('success');
    expect(done.jobs.map((j) => [j.name, j.conclusion])).toEqual([
      ['Plan', 'success'],
      ['Tests', 'success'],
      ['Signed AAB', 'success'],
      ['Sign AAB', 'success'],
    ]);
    const plan = done.jobs[0];
    expect(plan.steps.map((s) => s.name)).toEqual(['Set up job', 'Checkout code', 'Resolve plan', 'Copy secrets to GitHub', 'Start on GitHub Actions', 'Complete job']);
    expect(plan.steps.every((s) => s.conclusion === 'success')).toBe(true);
    expect(done.remote!.runId).not.toBeNull();
    expect(done.plan).toMatchObject({ versionName: '1.0.1', packageName: 'com.acme.app' });
    expect(done.source.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(h.fake.dispatches).toHaveLength(1);
    expect(h.fake.dispatches[0].plan.sha).toBe(done.source.sha);

    const dir = h.store.dir(run.id);
    for (const name of ['test-results', 'app-release-aab', 'build-info']) {
      expect(await fs.readdir(join(dir, 'artifacts', name)).catch(() => null)).not.toBeNull();
    }
    for (const job of done.jobs) {
      expect(await fs.readFile(join(dir, 'logs', `${job.id}.log`), 'utf8').catch(() => '')).not.toBe('');
    }
  }, 30_000);

  it('resumes following a run after the builder restarts between dispatching it and recording its id', async () => {
    const h = await harness();
    const app = await h.apps.require(h.appId);
    const id = await h.store.nextId();
    const requestId = 'resume1';
    const sha = 'a'.repeat(40);
    const plan: WorkflowPlan = {
      title: `Acme App #${id} · Build and test [${requestId}]`,
      requestId,
      app: app.id,
      run: id,
      mode: 'build',
      sha,
      ref: 'main',
      projectDir: '.',
      submodules: 'false',
      flutterVersion: '3.47.5',
      packageName: app.packageName,
      signing: app.signing.mode,
      certSha256: '',
      versionName: '1.0.1',
      versionCode: 1012,
      track: 'internal',
      releaseStatus: 'completed',
      rehearsal: false,
      notes: '',
    };
    await fs.mkdir(join(h.store.dir(id), 'logs'), { recursive: true });
    const log = new JobLog(join(h.store.dir(id), 'logs', '1.log'));
    // The dispatch itself succeeded on GitHub; the console just never got to record its id.
    await h.github.dispatch(app, plan, log);
    await log.close();

    const step = (name: string, number: number): JobRecord['steps'][number] => ({ name, number, status: 'completed', conclusion: 'success', started_at: iso(), completed_at: iso() });
    const run2: RunRecord = {
      id,
      app: h.apps.snapshot(app),
      number: 1,
      status: 'in_progress',
      conclusion: null,
      createdAt: iso(),
      startedAt: iso(),
      updatedAt: iso(),
      completedAt: null,
      source: { kind: 'git', url: app.repo!.url, branch: 'main', requestedSha: sha, sha, root: '', commit: null, startedBy: 'test', rerunOf: null },
      params: buildParams,
      plan: { mode: 'build', trigger: 'git', tag: null, track: 'internal', releaseStatus: 'completed', versionName: '1.0.1', versionCode: 1012, versionCodeFrom: 'test', integrationTests: false, publish: false, rehearsal: false, releaseNotes: '', requestId: null, commit: sha, ref: 'main', packageName: app.packageName },
      jobs: [
        { id: 1, name: 'Plan', status: 'completed', conclusion: 'success', started_at: iso(), completed_at: iso(), steps: ['Set up job', 'Checkout code', 'Resolve plan', 'Copy secrets to GitHub', 'Start on GitHub Actions', 'Complete job'].map(step) },
        { id: 2, name: 'Tests', status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] },
        { id: 3, name: 'Signed AAB', status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] },
        { id: 4, name: 'Sign AAB', status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] },
      ],
      error: null,
      runner: 'github',
      remote: { kind: 'github', repo: 'acme/app', workflow: 'release-console.yml', requestId, runId: null, url: null, dispatchedAt: iso(), fetched: [] },
    };
    await h.store.save(run2);

    await h.runner.recover();
    await h.runner.drain();
    const done = (await h.store.get(id))!;
    expect(done.status).toBe('completed');
    expect(done.conclusion).toBe('success');
    expect(done.remote!.runId).not.toBeNull();
    expect(done.jobs.slice(1).every((j) => j.conclusion === 'success')).toBe(true);
  }, 30_000);

  it('cancels a run while GitHub is still working on it', async () => {
    const h = await harness();
    const app = await h.apps.require(h.appId);
    h.fake.holdRuns = true;
    const run = await h.runner.create({
      app: h.apps.snapshot(app),
      number: 1,
      source: { kind: 'git', url: app.repo!.url, branch: 'main', requestedSha: null },
      params: buildParams,
      startedBy: 'test',
      runner: 'github',
      github: { repo: app.runner.github!.repo, workflow: app.runner.github!.workflow },
    });

    // Wait until the Plan job has dispatched the run on GitHub.
    for (let i = 0; i < 100; i += 1) {
      const current = await h.store.get(run.id);
      if (current?.remote?.runId) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await h.runner.cancel(run.id);
    h.fake.holdRuns = false; // the fake's own cancel path advances the run to cancelled from here
    await h.runner.drain();
    const done = (await h.store.get(run.id))!;
    expect(done.conclusion).toBe('cancelled');
  }, 30_000);
});
