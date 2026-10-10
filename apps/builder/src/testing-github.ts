import { createHash } from 'crypto';
import { strToU8, zipSync } from 'fflate';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import sodium from 'libsodium-wrappers';
import { REMOTE_STEPS } from './pipeline';
import { REMOTE_JOBS, WORKFLOW_PATH } from './workflow';

/**
 * A stand-in for GitHub's REST API, as much of it as the console uses: tokens, repositories,
 * files, branches and pull requests, Actions secrets (sealed with a real libsodium key pair it
 * can open), workflow dispatches, and workflow runs that advance one step each time the console
 * reads their jobs, with logs and artifacts behind storage redirects. Specs only (excluded from
 * the image).
 */

interface FakeRepo {
  defaultBranch: string;
  /** branch → path → content */
  branches: Map<string, Map<string, string>>;
  protectedDefault: boolean;
  workflowState: string;
  secrets: Map<string, { value: string; updatedAt: string }>;
}

interface FakeStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface FakeJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  steps: FakeStep[];
}

export interface FakeRun {
  id: number;
  repo: string;
  status: string;
  conclusion: string | null;
  display_title: string;
  html_url: string;
  plan: Record<string, unknown>;
  jobs: FakeJob[];
  artifacts: Array<{ id: number; name: string; data: Buffer; job: string }>;
  /** Jobs that run, in order (Google Play only for a release). */
  order: string[];
  cursor: number;
  /** Set by a cancel; the next read of the jobs ends the run. */
  cancelRequested: boolean;
  /** The run waits here (for cancel specs) instead of advancing. */
  hold: boolean;
  /** The job that fails, if any. */
  fail: string | null;
}

const iso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

export class FakeGithub {
  url = '';
  token = `github_pat_${'A1'.repeat(30)}`;
  login = 'octo-dev';
  /** Tokens GitHub accepts, with their login. */
  readonly tokens = new Map<string, string>();
  readonly repos = new Map<string, FakeRepo>();
  readonly runs = new Map<number, FakeRun>();
  readonly dispatches: Array<{ repo: string; workflow: string; ref: string; plan: Record<string, unknown>; returnRunDetails: boolean }> = [];
  readonly calls: Array<{ method: string; path: string }> = [];
  readonly pulls: Array<{ number: number; head: string; base: string; title: string }> = [];
  notModified = 0;
  authOnStorage = 0;
  /** Tokens the fake treats as lacking Contents/Workflows write (a 403, as GitHub answers). */
  readonly readOnlyTokens = new Set<string>();
  /** GitHub's newer dispatch answer (200 with the run) or the older one (204, find it by title). */
  returnRunDetails = true;
  failJob: string | null = null;
  holdRuns = false;
  private server: Server | null = null;
  private nextId = 9000;
  private keys!: { publicKey: Uint8Array; privateKey: Uint8Array };

  async start(): Promise<this> {
    await sodium.ready;
    this.keys = sodium.crypto_box_keypair();
    this.tokens.set(this.token, this.login);
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => this.send(res, 500, { message: (e as Error).message }));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  addRepo(slug: string, o: { files?: Record<string, string>; protectedDefault?: boolean } = {}): FakeRepo {
    const repo: FakeRepo = {
      defaultBranch: 'main',
      branches: new Map([['main', new Map(Object.entries(o.files ?? {}))]]),
      protectedDefault: o.protectedDefault ?? false,
      workflowState: 'active',
      secrets: new Map(),
    };
    this.repos.set(slug, repo);
    return repo;
  }

  workflowOn(slug: string, branch = 'main'): string | undefined {
    return this.repos.get(slug)?.branches.get(branch)?.get(WORKFLOW_PATH);
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────────────────

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    const text = body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'application/zip' : typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
    res.end(text);
  }

  /** A JSON answer with an ETag; an unchanged resource asked with If-None-Match gets a 304. */
  private json(req: IncomingMessage, res: ServerResponse, body: unknown) {
    const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      this.notModified += 1;
      return this.send(res, 304, undefined, { etag });
    }
    return this.send(res, 200, body, { etag, 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    this.calls.push({ method, path });

    // Storage: signed URLs, fetched without the token.
    if (path.startsWith('/storage/')) {
      if (req.headers.authorization) {
        this.authOnStorage += 1;
        return this.send(res, 400, { message: 'storage takes no Authorization header' });
      }
      const [, , kind, id] = path.split('/');
      if (kind === 'logs') {
        const job = [...this.runs.values()].flatMap((r) => r.jobs).find((j) => j.id === Number(id));
        return job ? this.send(res, 200, this.logOf(job)) : this.send(res, 404, 'no such log');
      }
      const art = [...this.runs.values()].flatMap((r) => r.artifacts).find((a) => a.id === Number(id));
      return art ? this.send(res, 200, art.data) : this.send(res, 404, 'no such artifact');
    }

    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    const login = this.tokens.get(auth);
    if (!login) return this.send(res, 401, { message: 'Bad credentials' });

    if (method === 'GET' && path === '/user') {
      return this.send(res, 200, { login }, { 'github-authentication-token-expiration': '2026-10-30 11:30:17 UTC' });
    }

    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (!m) return this.send(res, 404, { message: 'Not Found' });
    const slug = m[1];
    const rest = m[2] ?? '';
    const repo = this.repos.get(slug);
    if (!repo) return this.send(res, 404, { message: 'Not Found' });
    const files = (branch: string) => repo.branches.get(branch);

    if (method === 'GET' && rest === '') return this.json(req, res, { full_name: slug, default_branch: repo.defaultBranch, private: true });

    let r: RegExpExecArray | null;
    if (method === 'GET' && (r = /^\/actions\/workflows\/([^/]+)$/.exec(rest))) {
      return files(repo.defaultBranch)?.has(`.github/workflows/${r[1]}`) ? this.json(req, res, { id: 1, state: repo.workflowState, path: `.github/workflows/${r[1]}` }) : this.send(res, 404, { message: 'Not Found' });
    }
    if ((r = /^\/contents\/(.+)$/.exec(rest))) {
      const file = decodeURIComponent(r[1]);
      if (method === 'GET') {
        const content = files(url.searchParams.get('ref') ?? repo.defaultBranch)?.get(file);
        if (content === undefined) return this.send(res, 404, { message: 'Not Found' });
        return this.json(req, res, { sha: createHash('sha1').update(content).digest('hex'), content: Buffer.from(content).toString('base64') });
      }
      if (method === 'PUT') {
        if (this.readOnlyTokens.has(auth)) {
          return this.send(res, 403, { message: 'Resource not accessible by integration' });
        }
        const b = await this.body(req);
        const branch = String(b.branch ?? repo.defaultBranch);
        if (repo.protectedDefault && branch === repo.defaultBranch) return this.send(res, 409, { message: 'Changes must be made through a pull request.' });
        const target = files(branch);
        if (!target) return this.send(res, 404, { message: 'Branch not found' });
        const existing = target.get(file);
        if (existing !== undefined && b.sha !== createHash('sha1').update(existing).digest('hex')) return this.send(res, 409, { message: 'sha does not match' });
        target.set(file, Buffer.from(String(b.content), 'base64').toString('utf8'));
        const sha = createHash('sha1').update(`${branch}${Date.now()}`).digest('hex');
        return this.send(res, existing === undefined ? 201 : 200, { commit: { sha, html_url: `https://github.com/${slug}/commit/${sha}` } });
      }
    }
    if (method === 'GET' && (r = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      return files(decodeURIComponent(r[1])) ? this.json(req, res, { object: { sha: 'c'.repeat(40) } }) : this.send(res, 404, { message: 'Not Found' });
    }
    if (method === 'POST' && rest === '/git/refs') {
      const b = await this.body(req);
      const name = String(b.ref).replace(/^refs\/heads\//, '');
      repo.branches.set(name, new Map(files(repo.defaultBranch)));
      return this.send(res, 201, { ref: b.ref });
    }
    if (method === 'POST' && rest === '/pulls') {
      const b = await this.body(req);
      const pr = { number: this.pulls.length + 7, head: String(b.head), base: String(b.base), title: String(b.title) };
      this.pulls.push(pr);
      return this.send(res, 201, { number: pr.number, html_url: `https://github.com/${slug}/pull/${pr.number}` });
    }

    if (method === 'GET' && rest === '/actions/secrets/public-key') {
      return this.json(req, res, { key_id: 'k1', key: Buffer.from(this.keys.publicKey).toString('base64') });
    }
    if (method === 'GET' && rest === '/actions/secrets') {
      return this.json(req, res, { total_count: repo.secrets.size, secrets: [...repo.secrets.entries()].map(([name, s]) => ({ name, updated_at: s.updatedAt })) });
    }
    if ((r = /^\/actions\/secrets\/([A-Z0-9_]+)$/.exec(rest))) {
      if (method === 'PUT') {
        const b = await this.body(req);
        if (b.key_id !== 'k1') return this.send(res, 422, { message: 'Bad key_id' });
        const opened = sodium.crypto_box_seal_open(Buffer.from(String(b.encrypted_value), 'base64'), this.keys.publicKey, this.keys.privateKey);
        const had = repo.secrets.has(r[1]);
        repo.secrets.set(r[1], { value: Buffer.from(opened).toString('utf8'), updatedAt: iso() });
        return this.send(res, had ? 204 : 201);
      }
      if (method === 'DELETE') return repo.secrets.delete(r[1]) ? this.send(res, 204) : this.send(res, 404, { message: 'Not Found' });
    }

    if (method === 'POST' && (r = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest))) {
      const b = await this.body(req);
      const ref = String(b.ref);
      if (!files(ref)?.has(`.github/workflows/${r[1]}`)) return this.send(res, 404, { message: 'Not Found' });
      const plan = JSON.parse(String((b.inputs as Record<string, string>).plan)) as Record<string, unknown>;
      this.dispatches.push({ repo: slug, workflow: r[1], ref, plan, returnRunDetails: b.return_run_details === true });
      const run = this.newRun(slug, plan);
      if (this.returnRunDetails && b.return_run_details === true) {
        return this.send(res, 200, { workflow_run_id: run.id, run_url: `${this.url}/repos/${slug}/actions/runs/${run.id}`, html_url: run.html_url });
      }
      return this.send(res, 204);
    }
    if (method === 'GET' && /^\/actions\/workflows\/[^/]+\/runs$/.test(rest)) {
      const list = [...this.runs.values()].filter((x) => x.repo === slug).reverse();
      return this.json(req, res, { total_count: list.length, workflow_runs: list.map((x) => this.runView(x)) });
    }
    if ((r = /^\/actions\/runs\/(\d+)(\/[a-z]+)?$/.exec(rest))) {
      const run = this.runs.get(Number(r[1]));
      if (!run) return this.send(res, 404, { message: 'Not Found' });
      if (method === 'GET' && !r[2]) return this.json(req, res, this.runView(run));
      if (method === 'GET' && r[2] === '/jobs') {
        this.advance(run);
        return this.json(req, res, { total_count: run.jobs.length, jobs: run.jobs });
      }
      if (method === 'GET' && r[2] === '/artifacts') {
        return this.json(req, res, { total_count: run.artifacts.length, artifacts: run.artifacts.map((a) => ({ id: a.id, name: a.name, size_in_bytes: a.data.length, expired: false })) });
      }
      if (method === 'POST' && r[2] === '/cancel') {
        if (run.status === 'completed') return this.send(res, 409, { message: 'Cannot cancel a workflow run that is completed.' });
        run.cancelRequested = true;
        return this.send(res, 202, {});
      }
    }
    if (method === 'GET' && (r = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest))) {
      const job = [...this.runs.values()].flatMap((x) => x.jobs).find((j) => j.id === Number(r![1]));
      if (!job || job.status !== 'completed') return this.send(res, 404, { message: 'Not Found' });
      return this.send(res, 302, undefined, { location: `${this.url}/storage/logs/${job.id}` });
    }
    if (method === 'GET' && (r = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(rest))) {
      return this.send(res, 302, undefined, { location: `${this.url}/storage/artifacts/${r[1]}` });
    }
    return this.send(res, 404, { message: `Not Found: ${method} ${path}` });
  }

  // ─── Workflow runs ───────────────────────────────────────────────────────────────────

  private newRun(slug: string, plan: Record<string, unknown>): FakeRun {
    const id = (this.nextId += 1);
    const order = REMOTE_JOBS.filter((n) => n !== 'Google Play' || plan.mode === 'release');
    const run: FakeRun = {
      id,
      repo: slug,
      status: 'queued',
      conclusion: null,
      display_title: String(plan.title),
      html_url: `https://github.com/${slug}/actions/runs/${id}`,
      plan,
      jobs: REMOTE_JOBS.map((name) => ({
        id: (this.nextId += 1),
        name,
        status: 'queued',
        conclusion: null,
        started_at: null,
        completed_at: null,
        html_url: `https://github.com/${slug}/actions/runs/${id}/job/${this.nextId}`,
        steps: [],
      })),
      artifacts: [],
      order,
      cursor: 0,
      cancelRequested: false,
      hold: this.holdRuns,
      fail: this.failJob,
    };
    this.runs.set(id, run);
    return run;
  }

  private runView(run: FakeRun) {
    return { id: run.id, status: run.status, conclusion: run.conclusion, html_url: run.html_url, display_title: run.display_title, run_attempt: 1, event: 'workflow_dispatch' };
  }

  private steps(name: string, state: 'running' | 'success' | 'failure' | 'cancelled'): FakeStep[] {
    const names = REMOTE_STEPS[name as keyof typeof REMOTE_STEPS];
    return names.map((n, i) => {
      const first = i === 0;
      const last = i === names.length - 1;
      if (state === 'running') {
        const done = first;
        return { name: n, number: i + 1, status: done ? 'completed' : i === 1 ? 'in_progress' : 'queued', conclusion: done ? 'success' : null, started_at: done || i === 1 ? iso(-5) : null, completed_at: done ? iso(-4) : null };
      }
      const bad = !first && !last && i === names.length - 2;
      const conclusion = state === 'success' ? 'success' : bad ? state : last ? 'success' : i > names.length - 2 ? 'skipped' : 'success';
      return { name: n, number: i + 1, status: 'completed', conclusion, started_at: iso(-10 + i), completed_at: iso(-9 + i) };
    });
  }

  /** One step forward each time the console reads the jobs: start a job, then finish it. */
  private advance(run: FakeRun): void {
    if (run.status === 'completed') return;
    if (run.cancelRequested) {
      for (const job of run.jobs) {
        if (job.status === 'completed') continue;
        const was = job.status;
        job.status = 'completed';
        job.conclusion = was === 'in_progress' ? 'cancelled' : 'skipped';
        job.completed_at = iso();
        if (was === 'in_progress') job.steps = this.steps(job.name, 'cancelled');
      }
      run.status = 'completed';
      run.conclusion = 'cancelled';
      return;
    }
    if (run.hold) {
      const first = run.jobs.find((j) => j.name === run.order[0])!;
      if (first.status === 'queued') {
        run.status = 'in_progress';
        first.status = 'in_progress';
        first.started_at = iso(-5);
        first.steps = this.steps(first.name, 'running');
      }
      return;
    }
    run.status = 'in_progress';
    const name = run.order[run.cursor];
    const job = run.jobs.find((j) => j.name === name);
    if (!job) return this.finish(run);
    if (job.status === 'queued') {
      job.status = 'in_progress';
      job.started_at = iso(-5);
      job.steps = this.steps(name, 'running');
      return;
    }
    const failed = run.fail === name;
    job.status = 'completed';
    job.conclusion = failed ? 'failure' : 'success';
    job.completed_at = iso();
    job.steps = this.steps(name, failed ? 'failure' : 'success');
    this.saveArtifacts(run, name);
    run.cursor += 1;
    if (failed || run.cursor >= run.order.length) this.finish(run, failed);
  }

  private finish(run: FakeRun, failed = false): void {
    for (const job of run.jobs) {
      if (job.status === 'completed') continue;
      job.status = 'completed';
      job.conclusion = 'skipped';
      job.completed_at = iso();
    }
    run.status = 'completed';
    run.conclusion = failed ? 'failure' : 'success';
  }

  private saveArtifacts(run: FakeRun, job: string): void {
    const add = (name: string, files: Record<string, string>) =>
      run.artifacts.push({ id: (this.nextId += 1), name, job, data: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))) });
    const plan = run.plan;
    if (job === 'Tests') {
      add('test-results', {
        'flutter-test.json': [
          JSON.stringify({ type: 'start', time: 0 }),
          JSON.stringify({ type: 'testStart', test: { id: 1, name: 'loads', suiteID: 0 }, time: 1 }),
          JSON.stringify({ type: 'testDone', testID: 1, result: 'success', hidden: false, skipped: false, time: 2 }),
          JSON.stringify({ type: 'done', success: true, time: 3 }),
        ].join('\n'),
      });
    }
    if (job === 'Signed AAB') add('rc-built-aab', { 'bundle/release/app-release.aab': 'throwaway-signed' });
    if (job === 'Sign AAB') {
      add('app-release-aab', { 'bundle/release/app-release.aab': 'signed bundle bytes', 'mapping/release/mapping.txt': 'mapping' });
      add('build-info', {
        'build-info.json': JSON.stringify({ versionName: plan.versionName, versionCode: plan.versionCode, sizeBytes: 19, sha256: 'f'.repeat(64), signer: 'CN=Real Upload Key', certSha256: plan.certSha256 || 'AB:CD', commit: plan.sha, ref: plan.ref, packageName: plan.packageName, signedBy: plan.signing, builtAt: iso() }),
      });
    }
    if (job === 'Google Play') {
      add('play-release', {
        'release-info.json': JSON.stringify({ packageName: plan.packageName, track: plan.track, releaseStatus: plan.releaseStatus, versionName: plan.versionName, versionCode: plan.versionCode, previousHighestVersionCode: 1010, validatedOnly: plan.rehearsal, uploadedAt: iso(), storeUrl: '' }),
      });
    }
  }

  private logOf(job: FakeJob): string {
    const t = job.started_at ?? iso();
    return [
      `${t.replace('Z', '.0000000Z')} Current runner version: '2.329.0'`,
      ...job.steps.flatMap((s) => [`${(s.started_at ?? t).replace('Z', '.1000000Z')} ##[group]Run ${s.name}`, `${(s.started_at ?? t).replace('Z', '.2000000Z')} ##[endgroup]`, `${(s.started_at ?? t).replace('Z', '.3000000Z')} ${job.name}: ${s.name} done`]),
    ].join('\n');
  }
}
