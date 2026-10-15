import { promises as fs } from 'fs';
import { join } from 'path';
import { GithubActions } from './actions';
import { AppStore } from './apps';
import { dirs } from './config';
import { Git } from './git';
import { GithubClient } from './github';
import { JobLog } from './log';
import { KeyStore } from './keys';
import { FakeGithub } from './testing-github';
import { makeKeystore, tempConfig, useJdk } from './testing';
import type { AppRecord, GithubRemote, JobRecord, RunRecord } from './types';
import { Vault } from './vault';
import { COPIED_ARTIFACTS, REMOTE_JOBS, SECRETS, WORKFLOW_PATH } from './workflow';

/**
 * Everything the console does on GitHub, against a stand-in GitHub API: tokens, the readiness
 * checks, the workflow file (commit and pull-request paths), keeping Actions secrets in step
 * with the vault, and following a dispatched run — success, a failing job, and a cancel — with
 * its logs and artifacts copied back.
 */

const jdk = useJdk();
const pipelineDir = join(__dirname, '..', '..', '..', 'mobile-pipeline');
const PLAY_KEY = JSON.stringify({ type: 'service_account', client_email: 'ci@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n', project_id: 'proj' });

const fakes: FakeGithub[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.stop()));
  fakes.length = 0;
});

async function harness() {
  const fake = await new FakeGithub().start();
  fakes.push(fake);
  const cfg = await tempConfig({ GITHUB_API_URL: fake.url, PIPELINE_DIR: pipelineDir });
  const d = dirs(cfg);
  const vault = new Vault(d.vault, cfg.vaultKey, cfg.scratchDir);
  await vault.init();
  const keys = new KeyStore(vault);
  const git = new Git(d.repos, vault, keys, 60_000);
  const apps = new AppStore(d.apps, vault, keys, git, cfg.scratchDir, cfg.playKeyFile);
  await apps.init();
  const client = new GithubClient(fake.url);
  const github = new GithubActions(client, vault, apps, cfg.pipelineDir);
  github.pollMs = 15;
  return { fake, cfg, d, apps, github };
}

/** An app whose repository the console already found on github.com, without probing it over SSH. */
async function githubApp(apps: AppStore, appsDir: string, o: { repo: string; signingConsole?: boolean }): Promise<AppRecord> {
  const created = await apps.create({ name: 'Acme App', packageName: 'com.acme.app' });
  const file = join(appsDir, created.id, 'app.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.repo = { url: `git@github.com:${o.repo}.git`, keyId: 'k', branch: 'main', defaultBranch: 'main', path: '', access: { state: 'ok', checkedAt: null, message: null } };
  raw.runner = { kind: 'github', github: { repo: o.repo, workflow: 'release-console.yml', token: 'default', tokenLogin: null, check: null, secrets: { syncedAt: null, hash: null } } };
  await fs.writeFile(file, JSON.stringify(raw));
  if (o.signingConsole && jdk) {
    const ks = join(appsDir, `${created.id}.jks`);
    makeKeystore(ks, { alias: 'upload', storePass: 'store-pass', keyPass: 'key-pass', cn: 'Real Upload Key' });
    await apps.setSigning(created.id, { keystore: (await fs.readFile(ks)).toString('base64'), fileName: 'upload.jks', storePassword: 'store-pass', keyAlias: 'upload', keyPassword: 'key-pass' });
  }
  return apps.require(created.id);
}

describe('GithubActions: tokens', () => {
  it('stores the console default and an app’s own token, and falls back to the default', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/app' });
    expect(await github.tokenFor(app)).toBeNull();

    await github.setDefaultToken(fake.token);
    expect((await github.tokenFor(app))!).toMatchObject({ login: fake.login, source: 'default' });

    const other = `github_pat_${'B2'.repeat(30)}`;
    fake.tokens.set(other, 'octo-app');
    const withOwn = await github.setAppToken(app.id, other);
    expect(withOwn.runner.github).toMatchObject({ token: 'app', tokenLogin: 'octo-app' });
    expect((await github.tokenFor(withOwn))!).toMatchObject({ login: 'octo-app', source: 'app' });

    const cleared = await github.clearAppToken(app.id);
    expect((await github.tokenFor(cleared))!).toMatchObject({ login: fake.login, source: 'default' });
  });

  it('refuses a token GitHub does not accept, and reports one revoked after it was stored', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/app' });
    await expect(github.setDefaultToken(`github_pat_${'C3'.repeat(30)}`)).rejects.toThrow(/refused that token/);

    await github.setDefaultToken(fake.token);
    fake.tokens.delete(fake.token);
    const checked = await github.check(app.id);
    expect(checked.runner.github!.check).toMatchObject({ token: 'refused' });
    expect(checked.runner.github!.check!.message).toContain('refused');
  });
});

describe('GithubActions: readiness', () => {
  it('reports a repository the token cannot see', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/ghost' });
    await github.setDefaultToken(fake.token);
    const checked = await github.check(app.id);
    expect(checked.runner.github!.check).toMatchObject({ token: 'ok', repo: 'hidden' });
    expect(checked.runner.github!.check!.message).toMatch(/hides acme\/ghost/);
  });

  it('tells missing, outdated, matching and disabled workflow apart', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/app' });
    await github.setDefaultToken(fake.token);

    fake.addRepo('acme/app');
    expect((await github.check(app.id)).runner.github!.check).toMatchObject({ repo: 'ok', workflow: 'missing' });

    const real = (await github.workflow()).yaml;
    fake.repos.get('acme/app')!.branches.get('main')!.set(WORKFLOW_PATH, `${real}\n# stale\n`);
    expect((await github.check(app.id)).runner.github!.check).toMatchObject({ workflow: 'outdated' });

    fake.repos.get('acme/app')!.branches.get('main')!.set(WORKFLOW_PATH, real);
    expect((await github.check(app.id)).runner.github!.check).toMatchObject({ workflow: 'ok' });

    fake.repos.get('acme/app')!.workflowState = 'disabled';
    expect((await github.check(app.id)).runner.github!.check).toMatchObject({ workflow: 'disabled' });
  });

  (jdk ? it : it.skip)('reports missing secrets, then ok once synced', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/app', signingConsole: true });
    await github.setDefaultToken(fake.token);
    fake.addRepo('acme/app', { files: { [WORKFLOW_PATH]: (await github.workflow()).yaml } });
    expect((await github.check(app.id)).runner.github!.check).toMatchObject({ workflow: 'ok', secrets: 'missing' });

    await github.syncSecrets(app.id);
    expect((await github.check(app.id)).runner.github!.check).toMatchObject({ secrets: 'ok' });
  });
});

describe('GithubActions: the workflow file', () => {
  it('commits it to an open default branch, then sees it already matches', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/app' });
    await github.setDefaultToken(fake.token);
    fake.addRepo('acme/app');

    const first = await github.install(app.id);
    expect(first.result.kind).toBe('commit');
    expect(first.result.message).toContain('Committed');
    expect(first.app.runner.github!.check!.workflow).toBe('ok');
    expect(fake.workflowOn('acme/app')).toBe((await github.workflow()).yaml);

    const again = await github.install(app.id);
    expect(again.result.kind).toBe('unchanged');
  });

  it('opens a pull request when the default branch takes no direct pushes', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/app' });
    await github.setDefaultToken(fake.token);
    fake.addRepo('acme/app', { protectedDefault: true });

    const res = await github.install(app.id);
    expect(res.result.kind).toBe('pull-request');
    expect(res.result.url).toMatch(/\/pull\/\d+/);
    expect(fake.pulls).toHaveLength(1);
    expect(fake.pulls[0].base).toBe('main');
    // The workflow never reached the default branch itself.
    expect(fake.workflowOn('acme/app')).toBeUndefined();
    expect(fake.workflowOn('acme/app', fake.pulls[0].head)).toBe((await github.workflow()).yaml);
  });

  it('refuses a token without the rights to write the workflow, with a sentence that says what to add', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/app' });
    const weak = `github_pat_${'D4'.repeat(30)}`;
    fake.tokens.set(weak, 'read-only-dev');
    fake.readOnlyTokens.add(weak);
    await github.setAppToken(app.id, weak);
    fake.addRepo('acme/app');

    await expect(github.install(app.id)).rejects.toThrow(/Workflows and Contents read and write|repo and workflow scopes/);
  });
});

describe('GithubActions: secrets', () => {
  (jdk ? it : it.skip)('copies the upload key sealed for GitHub, and keeps it in step', async () => {
    const { fake, apps, github, d } = await harness();
    const app = await githubApp(apps, d.apps, { repo: 'acme/app', signingConsole: true });
    await github.setDefaultToken(fake.token);
    fake.addRepo('acme/app');

    const res = await github.syncSecrets(app.id);
    expect(res.synced.sort()).toEqual([SECRETS.keyAlias, SECRETS.keyPassword, SECRETS.keystore, SECRETS.storePassword].sort());
    const secrets = fake.repos.get('acme/app')!.secrets;
    expect(secrets.get(SECRETS.keyAlias)!.value).toBe('upload');
    expect(Buffer.from(secrets.get(SECRETS.keystore)!.value, 'base64').length).toBeGreaterThan(0);
    expect(res.app.runner.github!.secrets.hash).toBeTruthy();

    const putsBefore = fake.calls.filter((c) => c.method === 'PUT' && c.path.includes('/actions/secrets/')).length;
    const log = new JobLog(join(d.apps, 'ensure.log'));
    await github.ensureSecrets(res.app, log);
    await log.close();
    const puts = fake.calls.filter((c) => c.method === 'PUT' && c.path.includes('/actions/secrets/')).length;
    expect(puts).toBe(putsBefore); // unchanged keys: no secret written again

    await apps.setPlayKey(app.id, PLAY_KEY);
    const refreshed = await apps.require(app.id);
    await github.ensureSecrets(refreshed, log);
    expect(fake.repos.get('acme/app')!.secrets.has(SECRETS.play)).toBe(true);
  });
});

describe('GithubActions: dispatch and follow', () => {
  async function dispatched(h: Awaited<ReturnType<typeof harness>>, app: AppRecord, mode: 'build' | 'release', extra: Partial<Record<string, unknown>> = {}) {
    const requestId = 'abc123';
    const plan = {
      title: `Acme App #1 · ${mode === 'release' ? 'Release → internal' : 'Build and test'} [${requestId}]`,
      requestId,
      app: app.id,
      run: 1,
      mode,
      sha: 'a'.repeat(40),
      ref: 'main',
      projectDir: '.',
      submodules: 'false' as const,
      flutterVersion: '3.47.5',
      packageName: app.packageName,
      signing: app.signing.mode,
      certSha256: app.signing.certificate?.sha256 ?? '',
      versionName: '1.0.1',
      versionCode: 1011,
      track: 'internal',
      releaseStatus: 'completed',
      rehearsal: false,
      notes: 'Notes.',
      ...extra,
    };
    const log = new JobLog(join(h.d.apps, `dispatch-${requestId}.log`));
    const res = await h.github.dispatch(app, plan, log);
    await log.close();
    expect(res.runId).not.toBeNull();
    const names = REMOTE_JOBS.filter((n) => n !== 'Google Play' || mode === 'release');
    const run: RunRecord = {
      id: 1,
      app: h.apps.snapshot(app),
      number: 1,
      status: 'queued',
      conclusion: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      source: { kind: 'git', url: app.repo!.url, branch: 'main', requestedSha: plan.sha, sha: plan.sha, root: '', commit: null, startedBy: 'test', rerunOf: null },
      params: { platform: 'android', mode, track: 'internal', releaseNotes: 'Notes.', releaseStatus: 'completed', versionName: '1.0.1', versionCode: null, rehearsal: Boolean(extra.rehearsal) },
      plan: null,
      jobs: names.map((name, i): JobRecord => ({ id: i + 1, name, status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] })),
      error: null,
      runner: 'github',
      remote: { kind: 'github', repo: app.runner.github!.repo, workflow: app.runner.github!.workflow, requestId, runId: res.runId, url: res.url, dispatchedAt: new Date().toISOString(), fetched: [] },
    };
    return run;
  }

  it('follows a run through to success, copying each job’s log and the artifacts the console shows', async () => {
    const h = await harness();
    const app = await githubApp(h.apps, h.d.apps, { repo: 'acme/app' });
    await h.github.setDefaultToken(h.fake.token);
    h.fake.addRepo('acme/app', { files: { [WORKFLOW_PATH]: (await h.github.workflow()).yaml } });
    const run = await dispatched(h, app, 'release');

    const logsDir = join(h.d.apps, 'logs-success');
    const artifactsDir = join(h.d.apps, 'artifacts-success');
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(artifactsDir, { recursive: true });
    const lines: string[] = [];
    await h.github.follow(run, { logsDir, artifactsDir, save: async () => undefined, signal: new AbortController().signal, log: (t) => lines.push(t) });

    expect(run.status).toBe('completed');
    expect(run.conclusion).toBe('success');
    expect(run.jobs.map((j) => j.conclusion)).toEqual(['success', 'success', 'success', 'success']);
    for (const job of run.jobs) {
      expect(job.steps.length).toBeGreaterThan(0);
      const log = await fs.readFile(join(logsDir, `${job.id}.log`), 'utf8');
      expect(log).toContain(`Run ${job.steps[0].name}`);
    }
    for (const name of COPIED_ARTIFACTS) {
      expect(await fs.readdir(join(artifactsDir, name)).catch(() => null)).not.toBeNull();
    }
    const info = JSON.parse(await fs.readFile(join(artifactsDir, 'build-info', 'build-info.json'), 'utf8'));
    expect(info).toMatchObject({ versionName: '1.0.1', versionCode: 1011, packageName: app.packageName });
    const release = JSON.parse(await fs.readFile(join(artifactsDir, 'play-release', 'release-info.json'), 'utf8'));
    expect(release).toMatchObject({ track: 'internal', validatedOnly: false });
    // The storage download never carried the token.
    expect(h.fake.authOnStorage).toBe(0);
    // Re-reading an unchanged resource used a 304, not a fresh body, at least once.
    expect(h.fake.notModified).toBeGreaterThan(0);
  }, 30000);

  it('stops at the job that failed, with the rest skipped', async () => {
    const h = await harness();
    const app = await githubApp(h.apps, h.d.apps, { repo: 'acme/app' });
    await h.github.setDefaultToken(h.fake.token);
    h.fake.addRepo('acme/app', { files: { [WORKFLOW_PATH]: (await h.github.workflow()).yaml } });
    h.fake.failJob = 'Signed AAB';
    const run = await dispatched(h, app, 'build');

    const logsDir = join(h.d.apps, 'logs-fail');
    const artifactsDir = join(h.d.apps, 'artifacts-fail');
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(artifactsDir, { recursive: true });
    await h.github.follow(run, { logsDir, artifactsDir, save: async () => undefined, signal: new AbortController().signal, log: () => undefined });

    expect(run.conclusion).toBe('failure');
    expect(run.jobs.find((j) => j.name === 'Tests')!.conclusion).toBe('success');
    expect(run.jobs.find((j) => j.name === 'Signed AAB')!.conclusion).toBe('failure');
    expect(run.jobs.find((j) => j.name === 'Sign AAB')!.conclusion).toBe('skipped');
    // test-results was saved before the failure; the AAB never was.
    expect(await fs.readdir(join(artifactsDir, 'test-results')).catch(() => null)).not.toBeNull();
    expect(await fs.readdir(join(artifactsDir, 'app-release-aab')).catch(() => null)).toBeNull();
  }, 30000);

  it('cancels the run on GitHub and records it cancelled once GitHub agrees', async () => {
    const h = await harness();
    const app = await githubApp(h.apps, h.d.apps, { repo: 'acme/app' });
    await h.github.setDefaultToken(h.fake.token);
    h.fake.addRepo('acme/app', { files: { [WORKFLOW_PATH]: (await h.github.workflow()).yaml } });
    h.fake.holdRuns = true;
    const run = await dispatched(h, app, 'build');

    const logsDir = join(h.d.apps, 'logs-cancel');
    const artifactsDir = join(h.d.apps, 'artifacts-cancel');
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(artifactsDir, { recursive: true });
    const abort = new AbortController();
    const done = h.github.follow(run, { logsDir, artifactsDir, save: async () => undefined, signal: abort.signal, log: () => undefined });
    await new Promise((r) => setTimeout(r, 40));
    abort.abort();
    h.fake.holdRuns = false; // the fake's own cancel path takes over from here
    await done;

    expect(run.conclusion).toBe('cancelled');
    expect(h.fake.runs.get((run.remote as GithubRemote).runId!)!.cancelRequested).toBe(true);
  }, 30000);

  it('cancel() treats an already-finished run as nothing to do', async () => {
    const h = await harness();
    const app = await githubApp(h.apps, h.d.apps, { repo: 'acme/app' });
    await h.github.setDefaultToken(h.fake.token);
    h.fake.addRepo('acme/app', { files: { [WORKFLOW_PATH]: (await h.github.workflow()).yaml } });
    const run = await dispatched(h, app, 'build');
    const fakeRun = h.fake.runs.get((run.remote as GithubRemote).runId!)!;
    fakeRun.status = 'completed';
    fakeRun.conclusion = 'success';
    await expect(h.github.cancel(app, (run.remote as GithubRemote).runId!)).resolves.toBeUndefined();
  });
});
