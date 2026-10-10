import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { AppError, type AppStore } from './apps';
import { unpackZip } from './extract';
import { checkToken, GithubClient, GithubError, type TokenInfo } from './github';
import type { JobLog } from './log';
import { sealForGithub } from './sealed';
import type { AppRecord, Conclusion, GithubCheck, JobRecord, RunRecord, Status, StepRecord } from './types';
import type { Vault } from './vault';
import { COPIED_ARTIFACTS, loadWorkflow, SECRETS, WORKFLOW_PATH, type WorkflowPlan } from './workflow';

/**
 * Everything the console does on GitHub for an app that builds on GitHub Actions: the token it
 * acts with, the checks behind "is it ready", the workflow file, the Actions secrets, starting
 * a run, and following it until every job's log and every artifact is back on the console.
 */

/** GitHub keeps an Actions secret up to 48 KB. */
const MAX_SECRET = 48 * 1024;
/** How long the console follows one workflow run before it gives up on it. */
const MAX_FOLLOW_MS = 12 * 60 * 60 * 1000;

export interface StoredToken {
  token: string;
  login: string;
  kind: TokenInfo['kind'];
  scopes: string[] | null;
  expiresAt: string | null;
  savedAt: string;
}

export type TokenView = Omit<StoredToken, 'token'>;

export interface GhRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  run_attempt?: number;
  display_title?: string;
  created_at?: string;
}

interface GhStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url: string;
  steps?: GhStep[];
}

interface GhArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

const view = (t: StoredToken | null): TokenView | null => (t ? { login: t.login, kind: t.kind, scopes: t.scopes, expiresAt: t.expiresAt, savedAt: t.savedAt } : null);

const STATUS = (s: string | null | undefined): Status => (s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'queued');

function conclusion(status: string | null | undefined, c: string | null | undefined): Conclusion {
  if (status !== 'completed') return null;
  if (c === 'success' || c === 'neutral') return 'success';
  if (c === 'skipped') return 'skipped';
  if (c === 'cancelled') return 'cancelled';
  return 'failure';
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      done();
    }, { once: true });
  });

export class GithubActions {
  /** How often a followed run is read again; null = GitHub's pace (specs make it fast). */
  pollMs: number | null = null;

  constructor(
    readonly client: GithubClient,
    private readonly vault: Vault,
    private readonly apps: AppStore,
    private readonly pipelineDir: string,
  ) {}

  // ─── Tokens ──────────────────────────────────────────────────────────────────────────

  async defaultToken(): Promise<TokenView | null> {
    return view(await this.readToken('github/default.json'));
  }

  async setDefaultToken(input: unknown): Promise<TokenView> {
    const stored = await this.verify(input);
    await this.vault.put('github/default.json', Buffer.from(JSON.stringify(stored)));
    return view(stored)!;
  }

  async clearDefaultToken(): Promise<void> {
    await this.vault.remove('github/default.json');
  }

  async setAppToken(appId: string, input: unknown): Promise<AppRecord> {
    const app = await this.apps.require(appId);
    this.setupOf(app);
    const stored = await this.verify(input);
    await this.vault.put(`apps/${app.id}/github.json`, Buffer.from(JSON.stringify(stored)));
    return this.apps.noteGithub(app.id, { token: 'app', tokenLogin: stored.login, check: null });
  }

  async clearAppToken(appId: string): Promise<AppRecord> {
    const app = await this.apps.require(appId);
    await this.vault.remove(`apps/${app.id}/github.json`);
    return this.apps.noteGithub(app.id, { token: 'default', tokenLogin: null, check: null });
  }

  /** The token an app acts with on GitHub: its own, else the console's default. */
  async tokenFor(app: AppRecord): Promise<{ token: string; login: string; source: 'app' | 'default' } | null> {
    if (app.runner.github?.token === 'app') {
      const own = await this.readToken(`apps/${app.id}/github.json`);
      if (own) return { token: own.token, login: own.login, source: 'app' };
    }
    const fallback = await this.readToken('github/default.json');
    return fallback ? { token: fallback.token, login: fallback.login, source: 'default' } : null;
  }

  // ─── Checks ──────────────────────────────────────────────────────────────────────────

  /** What GitHub says about the app now, recorded on the app. */
  async check(appId: string): Promise<AppRecord> {
    const app = await this.apps.require(appId);
    const result = await this.inspect(app);
    return this.apps.noteGithub(app.id, { check: result });
  }

  async inspect(app: AppRecord): Promise<GithubCheck> {
    const setup = this.setupOf(app);
    const base: GithubCheck = {
      checkedAt: new Date().toISOString(),
      login: null,
      token: 'missing',
      repo: 'unknown',
      workflow: 'unknown',
      secrets: 'unknown',
      defaultBranch: null,
      message: null,
    };
    const tok = await this.tokenFor(app);
    if (!tok) {
      return { ...base, message: 'There is no GitHub token: add one for this app, or the console’s default token on the Setup page.' };
    }
    const out: GithubCheck = { ...base, login: tok.login, token: 'ok' };
    let repo: { default_branch: string };
    try {
      repo = await this.client.get(tok.token, `/repos/${setup.repo}`);
    } catch (e) {
      if (e instanceof GithubError && e.upstream === 401) return { ...out, token: 'refused', message: `GitHub refused ${tok.login}’s token: it is expired or revoked. Paste a new one.` };
      if (e instanceof GithubError && e.upstream === 404) return { ...out, repo: 'hidden', message: this.hidden(setup.repo, tok.login) };
      throw e;
    }
    out.repo = 'ok';
    out.defaultBranch = repo.default_branch;

    const wf = await this.client.getOrNull<{ state: string }>(tok.token, `/repos/${setup.repo}/actions/workflows/${setup.workflow}`).catch((e: unknown) => {
      if (e instanceof GithubError && e.upstream === 403) return undefined;
      throw e;
    });
    if (wf === null) out.workflow = 'missing';
    else if (wf && wf.state !== 'active') out.workflow = 'disabled';
    else {
      const file = await this.client
        .getOrNull<{ content?: string }>(tok.token, `/repos/${setup.repo}/contents/${WORKFLOW_PATH}`, { ref: repo.default_branch })
        .catch(() => undefined);
      if (file === null) out.workflow = 'missing';
      else if (file?.content !== undefined) {
        const text = Buffer.from(file.content, 'base64').toString('utf8');
        out.workflow = text === (await loadWorkflow(this.pipelineDir)) ? 'ok' : 'outdated';
      } else out.workflow = wf ? 'ok' : 'unknown';
    }

    const material = await this.material(app).catch(() => null);
    const names = await this.secretNames(tok.token, setup.repo);
    if (material && names) {
      const missing = Object.keys(material.values).filter((n) => !names.includes(n));
      out.secrets = missing.length ? 'missing' : setup.secrets.hash === material.hash ? 'ok' : 'stale';
    } else if (material) {
      out.secrets = setup.secrets.hash === material.hash ? 'ok' : setup.secrets.hash ? 'stale' : 'unknown';
    }

    out.message =
      out.workflow === 'missing'
        ? `${WORKFLOW_PATH} is not on ${repo.default_branch} yet: add it, and GitHub can run the app’s builds.`
        : out.workflow === 'disabled'
          ? `The Release Console workflow is turned off in ${setup.repo} (Actions tab): enable it there.`
          : out.workflow === 'outdated'
            ? `${WORKFLOW_PATH} on ${repo.default_branch} is not the console’s current one: update it.`
            : out.secrets === 'missing'
              ? 'The repository is missing the secrets a run reads: copy them from the console.'
              : out.secrets === 'stale'
                ? 'The upload key or Google Play key changed since the secrets were copied: they are copied again before the next run.'
                : null;
    return out;
  }

  // ─── The workflow file ───────────────────────────────────────────────────────────────

  async workflow(): Promise<{ path: string; yaml: string }> {
    return { path: WORKFLOW_PATH, yaml: await loadWorkflow(this.pipelineDir) };
  }

  /**
   * Commits the workflow to the default branch; when the branch only takes pull requests,
   * opens one instead.
   */
  async install(appId: string): Promise<{ app: AppRecord; result: { kind: 'commit' | 'pull-request' | 'unchanged'; url: string | null; message: string } }> {
    const app = await this.apps.require(appId);
    const setup = this.setupOf(app);
    const tok = await this.requireToken(app);
    const yaml = await loadWorkflow(this.pipelineDir);
    const content = Buffer.from(yaml).toString('base64');
    const repo = await this.client.get<{ default_branch: string }>(tok.token, `/repos/${setup.repo}`).catch((e: unknown) => {
      throw this.explain(e, setup.repo, tok.login);
    });
    const base = repo.default_branch;
    const existing = await this.client.getOrNull<{ sha: string; content?: string }>(tok.token, `/repos/${setup.repo}/contents/${WORKFLOW_PATH}`, { ref: base });
    if (existing?.content !== undefined && Buffer.from(existing.content, 'base64').toString('utf8') === yaml) {
      return { app: await this.check(app.id), result: { kind: 'unchanged', url: null, message: `${WORKFLOW_PATH} on ${base} is already the console’s.` } };
    }
    const message = existing ? 'ci: update the Release Console workflow' : 'ci: add the Release Console workflow';
    let result: { kind: 'commit' | 'pull-request'; url: string | null; message: string };
    try {
      const res = await this.client.put<{ commit?: { html_url?: string; sha?: string } }>(tok.token, `/repos/${setup.repo}/contents/${WORKFLOW_PATH}`, {
        message,
        content,
        branch: base,
        ...(existing ? { sha: existing.sha } : {}),
      });
      result = { kind: 'commit', url: res.data.commit?.html_url ?? null, message: `Committed ${WORKFLOW_PATH} to ${base}${res.data.commit?.sha ? ` (${res.data.commit.sha.slice(0, 7)})` : ''}.` };
    } catch (e) {
      if (!(e instanceof GithubError)) throw e;
      if (/workflow|Resource not accessible/i.test(e.detail) && (e.upstream === 403 || e.upstream === 404)) {
        throw new AppError(
          `GitHub refused to write ${WORKFLOW_PATH}: ${tok.login}’s token needs Workflows and Contents read and write (fine-grained), or the repo and workflow scopes (classic).`,
          422,
        );
      }
      if (!/protected|pull request|review|status check|rule/i.test(e.detail)) throw this.explain(e, setup.repo, tok.login);
      // The branch takes changes only through pull requests: open one.
      const head = await this.client.get<{ object: { sha: string } }>(tok.token, `/repos/${setup.repo}/git/ref/heads/${encodeURIComponent(base)}`);
      const branch = `release-console/workflow-${Date.now().toString(36)}`;
      await this.client.post(tok.token, `/repos/${setup.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.object.sha });
      await this.client.put(tok.token, `/repos/${setup.repo}/contents/${WORKFLOW_PATH}`, { message, content, branch, ...(existing ? { sha: existing.sha } : {}) });
      const pr = await this.client.post<{ number: number; html_url: string }>(tok.token, `/repos/${setup.repo}/pulls`, {
        title: existing ? 'Update the Release Console workflow' : 'Add the Release Console workflow',
        head: branch,
        base,
        body:
          'The Release Console runs this app’s builds and releases on GitHub Actions with this workflow. ' +
          `${base} takes changes only through pull requests, so the console opened this one: merge it, then check again in the console.`,
      });
      result = { kind: 'pull-request', url: pr.data.html_url, message: `${base} is protected, so the console opened pull request #${pr.data.number}: merge it, then check again.` };
    }
    return { app: await this.check(app.id), result };
  }

  // ─── Secrets ─────────────────────────────────────────────────────────────────────────

  /** What a run of this app reads from the repository's secrets, and a hash of it. */
  async material(app: AppRecord): Promise<{ values: Record<string, string>; hash: string }> {
    const values: Record<string, string> = {};
    if (app.signing.mode === 'console') {
      const key = await this.apps.uploadKey(app.id);
      if (!key) throw new AppError(`${app.name} is set to be signed by the console, but it holds no upload key: upload the keystore in its settings.`, 409);
      values[SECRETS.keystore] = key.keystore.toString('base64');
      values[SECRETS.storePassword] = key.storePassword;
      values[SECRETS.keyAlias] = key.keyAlias;
      values[SECRETS.keyPassword] = key.keyPassword || key.storePassword;
    }
    const play = await this.apps.playKey(app).catch(() => null);
    if (play) values[SECRETS.play] = play.json;
    for (const [name, value] of Object.entries(values)) {
      if (Buffer.byteLength(value) > MAX_SECRET) {
        throw new AppError(`${name === SECRETS.keystore ? 'The keystore' : name} is ${Math.round(Buffer.byteLength(value) / 1024)} KB as a secret; GitHub keeps secrets up to 48 KB.`, 422);
      }
    }
    const hash = createHash('sha256')
      .update(this.setupOf(app).repo)
      .update(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex');
    return { values, hash };
  }

  /** Copies the app's keys into the repository's Actions secrets, sealed for GitHub. */
  async syncSecrets(appId: string, log?: JobLog): Promise<{ app: AppRecord; synced: string[]; removed: string[] }> {
    const app = await this.apps.require(appId);
    const setup = this.setupOf(app);
    const tok = await this.requireToken(app);
    const { values, hash } = await this.material(app);
    let publicKey: { key_id: string; key: string };
    try {
      publicKey = await this.client.get(tok.token, `/repos/${setup.repo}/actions/secrets/public-key`);
    } catch (e) {
      throw this.secretsRefused(e, setup.repo, tok.login);
    }
    const synced: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      try {
        await this.client.put(tok.token, `/repos/${setup.repo}/actions/secrets/${name}`, { encrypted_value: await sealForGithub(value, publicKey.key), key_id: publicKey.key_id });
      } catch (e) {
        throw this.secretsRefused(e, setup.repo, tok.login);
      }
      synced.push(name);
      log?.line(`Stored ${name} in ${setup.repo}`);
    }
    // A key the app no longer uses (signing went back to the project, no Play key) leaves GitHub too.
    const removed: string[] = [];
    for (const name of Object.values(SECRETS)) {
      if (name in values) continue;
      await this.client.delete(tok.token, `/repos/${setup.repo}/actions/secrets/${name}`).then(
        () => removed.push(name),
        () => undefined,
      );
    }
    const updated = await this.apps.noteGithub(app.id, { secrets: { syncedAt: new Date().toISOString(), hash } });
    return { app: updated, synced, removed };
  }

  /** Before a run: copies the secrets again when the keys changed or GitHub lost one. */
  async ensureSecrets(app: AppRecord, log: JobLog): Promise<void> {
    const setup = this.setupOf(app);
    const tok = await this.requireToken(app);
    const { values, hash } = await this.material(app);
    const names = await this.secretNames(tok.token, setup.repo);
    const missing = names ? Object.keys(values).filter((n) => !names.includes(n)) : [];
    if (setup.secrets.hash === hash && !missing.length) {
      log.line(`The secrets in ${setup.repo} match the app's keys (copied ${setup.secrets.syncedAt ?? 'before'}).`);
      return;
    }
    log.line(missing.length ? `Missing in ${setup.repo}: ${missing.join(', ')}.` : 'The app’s keys changed since they were last copied.');
    const res = await this.syncSecrets(app.id, log);
    log.line(`Copied ${res.synced.length} secret${res.synced.length === 1 ? '' : 's'}, sealed for GitHub${res.removed.length ? `; removed ${res.removed.join(', ')}` : ''}.`);
  }

  // ─── Runs ────────────────────────────────────────────────────────────────────────────

  /** Starts the workflow on the default branch (the commit to build travels in the plan). */
  async dispatch(app: AppRecord, plan: WorkflowPlan, log: JobLog): Promise<{ runId: number | null; url: string | null }> {
    const setup = this.setupOf(app);
    const tok = await this.requireToken(app);
    const repo = await this.client.get<{ default_branch: string }>(tok.token, `/repos/${setup.repo}`).catch((e: unknown) => {
      throw this.explain(e, setup.repo, tok.login);
    });
    const path = `/repos/${setup.repo}/actions/workflows/${setup.workflow}/dispatches`;
    const body = { ref: repo.default_branch, inputs: { plan: JSON.stringify(plan) } };
    log.line(`POST ${path} (ref ${repo.default_branch}) as ${tok.login}`);
    let res: { status: number; data: unknown };
    try {
      res = await this.client.post(tok.token, path, { ...body, return_run_details: true });
    } catch (e) {
      if (e instanceof GithubError && e.upstream === 422 && /return_run_details/i.test(e.detail)) {
        res = await this.client.post(tok.token, path, body).catch((e2: unknown) => {
          throw this.dispatchRefused(e2, setup.repo, repo.default_branch, tok.login);
        });
      } else throw this.dispatchRefused(e, setup.repo, repo.default_branch, tok.login);
    }
    const data = (res.data && typeof res.data === 'object' ? res.data : {}) as { workflow_run_id?: number; html_url?: string };
    if (data.workflow_run_id) return { runId: data.workflow_run_id, url: data.html_url ?? null };
    log.line('GitHub did not name the run; finding it by its title.');
    const found = await this.find(app, plan.requestId);
    return { runId: found?.id ?? null, url: found?.html_url ?? null };
  }

  /** A run this console dispatched, found by the request id at the end of its title. */
  async find(app: AppRecord, requestId: string, attempts = 10): Promise<GhRun | null> {
    const pause = this.pollMs ?? 2000;
    const setup = this.setupOf(app);
    const tok = await this.requireToken(app);
    for (let i = 0; i < attempts; i += 1) {
      const list = await this.client
        .get<{ workflow_runs: GhRun[] }>(tok.token, `/repos/${setup.repo}/actions/workflows/${setup.workflow}/runs`, { event: 'workflow_dispatch', per_page: 30 })
        .catch(() => ({ workflow_runs: [] as GhRun[] }));
      const hit = list.workflow_runs.find((r) => (r.display_title ?? '').endsWith(`[${requestId}]`));
      if (hit) return hit;
      await sleep(pause);
    }
    return null;
  }

  async cancel(app: AppRecord, runId: number): Promise<void> {
    const setup = this.setupOf(app);
    const tok = await this.requireToken(app);
    try {
      await this.client.post(tok.token, `/repos/${setup.repo}/actions/runs/${runId}/cancel`);
    } catch (e) {
      // 409: it already finished, which is what a cancel wants anyway.
      if (!(e instanceof GithubError && e.upstream === 409)) throw e;
    }
  }

  /**
   * Mirrors a dispatched workflow run into the console's record until it ends: job and step
   * states as GitHub reports them, each job's log once the job is done, and the artifacts the
   * console shows (test report, AAB, build and release info).
   */
  async follow(
    run: RunRecord,
    o: { logsDir: string; artifactsDir: string; save: () => Promise<void>; signal: AbortSignal; log: (text: string) => void; pollMs?: number },
  ): Promise<void> {
    const remote = run.remote;
    if (!remote?.runId) throw new AppError('This run was never started on GitHub.', 409);
    const runId = remote.runId;
    const started = Date.parse(remote.dispatchedAt ?? run.createdAt);
    const copiedLogs = new Set<number>();
    let cancelSentAt = 0;
    let failures = 0;
    let finishedPolls = 0;
    for (;;) {
      if (o.signal.aborted && !cancelSentAt) {
        cancelSentAt = Date.now();
        const app = await this.apps.get(run.app?.id ?? '');
        if (app) await this.cancel(app, runId).catch((e: unknown) => o.log(`Cancel on GitHub failed: ${(e as Error).message}`));
      }
      // GitHub normally reports a cancelled run within seconds; past two minutes the console
      // stops waiting and records the cancel itself.
      if (cancelSentAt && Date.now() - cancelSentAt > 120_000) {
        run.status = 'completed';
        run.conclusion = 'cancelled';
        return;
      }
      try {
        const app = await this.apps.require(run.app?.id ?? '');
        const tok = await this.requireToken(app);
        const base = `/repos/${remote.repo}/actions/runs/${runId}`;
        const [gr, jobs] = await Promise.all([
          this.client.get<GhRun>(tok.token, base),
          this.client.get<{ jobs: GhJob[] }>(tok.token, `${base}/jobs`, { filter: 'latest', per_page: 100 }),
        ]);
        remote.url = gr.html_url ?? remote.url;
        const changed = this.merge(run, jobs.jobs);
        if (gr.status === 'completed') finishedPolls += 1;
        // Logs of jobs that ended (GitHub publishes one a few seconds after its job), and the
        // artifacts once a job that saves them has ended.
        let anyEnded = false;
        for (const job of run.jobs) {
          if (!job.remote || job.status !== 'completed' || copiedLogs.has(job.id)) continue;
          anyEnded = true;
          if (job.conclusion === 'skipped' && !job.steps.some((s) => s.started_at)) {
            copiedLogs.add(job.id);
            continue;
          }
          if (await this.copyLog(tok.token, remote.repo, job, o.logsDir, finishedPolls >= 4)) copiedLogs.add(job.id);
        }
        if (anyEnded || finishedPolls) await this.copyArtifacts(tok.token, run, o.artifactsDir, o.log);
        if (changed || anyEnded) await o.save();
        failures = 0;
        const logsPending = run.jobs.some((j) => j.remote && j.status === 'completed' && !copiedLogs.has(j.id));
        if (finishedPolls && (!logsPending || finishedPolls >= 5)) {
          run.status = 'completed';
          run.conclusion = conclusion('completed', gr.conclusion);
          if (run.conclusion === 'failure' && !run.jobs.some((j) => j.conclusion === 'failure')) {
            run.error ??= `The workflow run ended as ${gr.conclusion ?? 'failed'} on GitHub; its page says why.`;
          }
          return;
        }
      } catch (e) {
        failures += 1;
        o.log(`Following the run on GitHub: ${(e as Error).message}`);
        if (e instanceof AppError && e.status === 404) {
          run.error = 'The app was deleted while this run was on GitHub; the run carries on there.';
          run.status = 'completed';
          run.conclusion = 'failure';
          return;
        }
        if (failures >= 3) run.error = `The console cannot read this run from GitHub right now: ${(e as Error).message}`;
      }
      if (Date.now() - started > MAX_FOLLOW_MS) {
        run.error = 'The console stopped following this run after 12 hours; GitHub has the rest.';
        run.status = 'completed';
        run.conclusion = 'failure';
        return;
      }
      const anyRunning = run.jobs.some((j) => j.remote && j.status === 'in_progress');
      const wait = failures ? Math.min(60_000, 5_000 * 2 ** failures) : finishedPolls ? 3_000 : anyRunning ? 4_000 : 8_000;
      const fast = this.pollMs ?? o.pollMs;
      await sleep(fast !== undefined && fast !== null && !failures ? fast : wait, cancelSentAt ? undefined : o.signal);
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────

  /** GitHub's jobs into the run's records (matched by name: the workflow's jobs are unique). */
  merge(run: RunRecord, jobs: GhJob[]): boolean {
    let changed = false;
    for (const gj of jobs) {
      // Only a job this run's own plan already listed (githubPipeline gates Google Play on
      // the mode the same way the workflow's `if:` does): a job GitHub lists outside that,
      // such as Google Play skipped on a build, is not tracked, whatever state it is in.
      const job = run.jobs.find((j) => j.name === gj.name);
      if (!job) continue;
      const before = JSON.stringify(job);
      job.remote = { id: gj.id, url: gj.html_url };
      job.status = STATUS(gj.status);
      job.conclusion = conclusion(gj.status, gj.conclusion);
      job.started_at = gj.started_at ?? null;
      job.completed_at = job.status === 'completed' ? (gj.completed_at ?? null) : null;
      if (gj.steps?.length) {
        job.steps = gj.steps.map(
          (s): StepRecord => ({
            name: s.name,
            number: s.number,
            status: STATUS(s.status),
            conclusion: conclusion(s.status, s.conclusion),
            started_at: s.started_at ?? null,
            completed_at: s.status === 'completed' ? (s.completed_at ?? null) : null,
          }),
        );
      } else if (job.status === 'completed') {
        // A job GitHub ended before it ran a step (skipped, cancelled while queued).
        for (const s of job.steps) {
          if (s.status === 'completed') continue;
          s.status = 'completed';
          s.conclusion = job.conclusion === 'cancelled' ? 'cancelled' : 'skipped';
        }
      }
      if (JSON.stringify(job) !== before) changed = true;
    }
    return changed;
  }

  private async copyLog(token: string, repo: string, job: JobRecord, logsDir: string, last: boolean): Promise<boolean> {
    const file = join(logsDir, `${job.id}.log`);
    try {
      const text = await this.client.download(token, `/repos/${repo}/actions/jobs/${job.remote!.id}/logs`, 64 * 1024 * 1024);
      await fs.writeFile(file, text);
      return true;
    } catch (e) {
      // GitHub publishes a job's log a few seconds after the job ends: try again on the next read.
      if (!last) return false;
      const stamp = new Date().toISOString();
      await fs.writeFile(
        file,
        `${stamp} ##[error]The log of this job could not be copied from GitHub (${(e as Error).message})\n${stamp} Open it on GitHub: ${job.remote!.url}\n`,
      );
      return true;
    }
  }

  private async copyArtifacts(token: string, run: RunRecord, artifactsDir: string, log: (text: string) => void): Promise<void> {
    const remote = run.remote!;
    const want = COPIED_ARTIFACTS.filter((n) => !remote.fetched.includes(n));
    if (!want.length) return;
    const list = await this.client.get<{ artifacts: GhArtifact[] }>(token, `/repos/${remote.repo}/actions/runs/${remote.runId}/artifacts`, { per_page: 100 });
    for (const a of list.artifacts) {
      if (!want.includes(a.name as (typeof COPIED_ARTIFACTS)[number]) || a.expired) continue;
      const zip = await this.client.download(token, `/repos/${remote.repo}/actions/artifacts/${a.id}/zip`);
      const tmp = join(artifactsDir, `.${a.name}.zip`);
      await fs.writeFile(tmp, zip);
      try {
        const dest = join(artifactsDir, a.name);
        await fs.rm(dest, { recursive: true, force: true });
        await unpackZip(tmp, dest, { maxBytes: 1024 * 1024 * 1024, maxEntries: 1000 });
      } finally {
        await fs.rm(tmp, { force: true });
      }
      remote.fetched.push(a.name);
      log(`Copied ${a.name} from GitHub (${(a.size_in_bytes / 1024 / 1024).toFixed(1)} MB).`);
    }
  }

  private async secretNames(token: string, repo: string): Promise<string[] | null> {
    try {
      const res = await this.client.get<{ secrets: Array<{ name: string }> }>(token, `/repos/${repo}/actions/secrets`, { per_page: 100 });
      return res.secrets.map((s) => s.name);
    } catch {
      // A token without Secrets read cannot list them; the hash decides alone.
      return null;
    }
  }

  private setupOf(app: AppRecord) {
    const setup = app.runner.github;
    if (!setup) throw new AppError(`${app.name} does not build on GitHub Actions: its repository is not on github.com.`, 409);
    return setup;
  }

  private async requireToken(app: AppRecord) {
    const tok = await this.tokenFor(app);
    if (!tok) throw new AppError('There is no GitHub token: add one in the app’s settings, or the console’s default token on the Setup page.', 409);
    return tok;
  }

  private async readToken(name: string): Promise<StoredToken | null> {
    const blob = await this.vault.get(name);
    return blob ? (JSON.parse(blob.toString('utf8')) as StoredToken) : null;
  }

  private async verify(input: unknown): Promise<StoredToken> {
    let token: string;
    let info: TokenInfo;
    try {
      token = checkToken(input);
      info = await this.client.whoami(token);
    } catch (e) {
      if (e instanceof GithubError) throw new AppError(e.upstream === 401 ? 'GitHub refused that token: it is wrong, expired or revoked.' : e.message, e.upstream === 401 ? 422 : e.status);
      throw e;
    }
    return { token, login: info.login, kind: info.kind, scopes: info.scopes, expiresAt: info.expiresAt, savedAt: new Date().toISOString() };
  }

  private hidden(repo: string, login: string): string {
    const owner = repo.split('/')[0];
    return (
      `${login}’s token works, but GitHub hides ${repo} from it (404). A fine-grained token sees only the repositories it was made for: ` +
      `make it with resource owner “${owner}” (an organization owner may have to approve it) and access to ${repo.split('/')[1]}. ` +
      `A classic token needs the repo and workflow scopes${owner !== login ? `, and SSO authorization if ${owner} uses SAML` : ''}.`
    );
  }

  private explain(e: unknown, repo: string, login: string): unknown {
    if (e instanceof GithubError && e.upstream === 404) return new AppError(this.hidden(repo, login), 422);
    if (e instanceof GithubError && e.upstream === 401) return new AppError(`GitHub refused ${login}’s token: it is expired or revoked. Paste a new one.`, 422);
    if (e instanceof GithubError) return new AppError(e.message, e.status >= 500 ? 502 : e.status);
    return e;
  }

  private secretsRefused(e: unknown, repo: string, login: string): unknown {
    if (e instanceof GithubError && (e.upstream === 403 || e.upstream === 404)) {
      return new AppError(`GitHub refused ${login}’s token on the secrets of ${repo}: give it Secrets read and write (fine-grained), or the repo scope (classic).`, 422);
    }
    return this.explain(e, repo, login);
  }

  private dispatchRefused(e: unknown, repo: string, branch: string, login: string): unknown {
    if (e instanceof GithubError && e.upstream === 404) {
      return new AppError(`${WORKFLOW_PATH} is not on ${branch} of ${repo}, or ${login}’s token cannot see it: add it in the app’s settings → Where builds run.`, 422);
    }
    if (e instanceof GithubError && e.upstream === 403) {
      return new AppError(`GitHub refused to start the workflow: ${login}’s token needs Actions read and write on ${repo}.`, 422);
    }
    if (e instanceof GithubError && e.upstream === 422) {
      return new AppError(`GitHub refused to start the workflow (${e.detail}). The workflow in ${repo} may not be the console’s: update it in the app’s settings.`, 422);
    }
    return this.explain(e, repo, login);
  }
}

export { view as tokenView };
