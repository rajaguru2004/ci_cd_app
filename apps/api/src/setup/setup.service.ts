import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';
import { GithubClient, GithubError, RateLimit } from '../github/github.client';
import type { GhArtifactList, GhRepo, GhWorkflow, GhWorkflowRun } from '../github/github.types';
import { sealForGithub } from '../github/sealed-box';
import { ARTIFACTS, BuildInfo, PlayStatus, readJson, unzip } from '../pipeline/artifacts';
import { PipelineService } from '../pipeline/pipeline.service';
import { describeRun, runState, RunState } from '../pipeline/stages';
import { PlayClient, PlaySnapshot } from '../play/play.client';
import { BuilderClient } from '../local/builder.client';
import { LocalRunsService } from '../local/local-runs.service';
import { VersionCodes } from '../local/version-codes';

export const PLAY_SECRET = 'PLAY_SERVICE_ACCOUNT_JSON';

export type CheckState = 'ok' | 'missing' | 'error' | 'unknown' | 'pending';

export interface SetupCheck {
  key: 'token' | 'repo' | 'workflow' | 'fastlane' | 'signing' | 'play-console' | 'play-secret' | 'play-access' | 'builder';
  label: string;
  state: CheckState;
  detail: string;
  fix?: string;
  url?: string;
}

export interface PlaySetup {
  configured: boolean;
  clientEmail: string | null;
  projectId: string | null;
  snapshot: PlaySnapshot | null;
  error: string | null;
}

export interface SetupResponse {
  configured: boolean;
  repo: { fullName: string; url: string; defaultBranch: string; private: boolean } | null;
  workflowFile: string;
  checks: SetupCheck[];
  /** Google Play as the console's own key sees it, independent of GitHub. */
  play: PlaySetup;
  playCheck: {
    runId: number;
    number: number;
    state: RunState;
    at: string;
    url: string;
    status: PlayStatus | null;
    messages: string[];
  } | null;
  signing: { signer: string; certSha256: string; runNumber: number } | null;
  variables: { readable: boolean; defaultTrack: string; versionCodeOffset: number; fromVariables: string[] };
  nextRunNumber: number | null;
  /** The code the next run the console starts gets (Play's highest + 1, never reused). */
  nextVersionCode: number | null;
  rate: RateLimit | null;
}

interface GhTree {
  tree: Array<{ path: string; type: string }>;
  truncated: boolean;
}

/**
 * What the pipeline needs, checked against the repository as it is now. Every line answers
 * "is it there, and if not, what do I do", so the first run does not fail on a missing piece.
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly gh: GithubClient,
    private readonly pipeline: PipelineService,
    private readonly playClient: PlayClient,
    private readonly builder: BuilderClient,
    @Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig,
    private readonly versions: VersionCodes,
    private readonly local: LocalRunsService,
  ) {}

  async status(): Promise<SetupResponse> {
    const play = await this.playSetup();
    const empty: SetupResponse = {
      configured: this.gh.configured,
      repo: null,
      workflowFile: this.config.workflowFile,
      checks: [],
      play,
      playCheck: null,
      signing: null,
      variables: { readable: false, defaultTrack: 'internal', versionCodeOffset: 1000, fromVariables: [] },
      nextRunNumber: null,
      nextVersionCode: play.snapshot
        ? this.versions.peek(play.snapshot.highestVersionCode ?? 0, await this.local.knownCodes())
        : null,
      rate: this.gh.rateLimit,
    };

    if (!this.gh.configured) {
      empty.checks.push({
        key: 'token',
        label: 'GitHub token',
        state: 'missing',
        detail: 'The console has no GitHub token, so it cannot see or start the pipeline.',
        fix: 'Put GITHUB_TOKEN in ci_cd_app/.env (fine-grained, on the mobile repo: Actions read/write, Contents read, Secrets read/write, Variables read), then run docker compose up -d.',
      });
      empty.checks.push(this.playConsoleCheck(play));
      empty.checks.push(await this.builderCheck());
      return empty;
    }

    let repo: GhRepo;
    try {
      repo = await this.pipeline.repo();
    } catch (e) {
      empty.checks.push(await this.tokenProblem(e));
      empty.checks.push(this.playConsoleCheck(play));
      empty.checks.push(await this.builderCheck());
      return empty;
    }
    const out: SetupResponse = {
      ...empty,
      repo: { fullName: repo.full_name, url: repo.html_url, defaultBranch: repo.default_branch, private: repo.private },
    };
    out.checks.push({ key: 'token', label: 'GitHub token', state: 'ok', detail: `Reads ${repo.full_name}.` });
    out.checks.push({
      key: 'repo',
      label: 'Mobile repository',
      state: 'ok',
      detail: `${repo.private ? 'Private' : 'Public'} · default branch ${repo.default_branch}.`,
      url: repo.html_url,
    });

    const [workflow, tree, secret, variables, runs] = await Promise.all([
      this.gh.getOrNotFound<GhWorkflow>(this.gh.repoPath(`/actions/workflows/${encodeURIComponent(this.config.workflowFile)}`)),
      this.gh.getOrNotFound<GhTree>(this.gh.repoPath(`/git/trees/${encodeURIComponent(repo.default_branch)}`), { recursive: 1 }),
      this.secret(),
      this.variables(),
      this.pipeline.listRuns().catch(() => null),
    ]);

    const workflowOk = !('notFound' in workflow);
    out.checks.push(
      workflowOk
        ? {
            key: 'workflow',
            label: 'Pipeline workflow',
            state: workflow.state === 'active' ? 'ok' : 'error',
            detail:
              workflow.state === 'active'
                ? `.github/workflows/${this.config.workflowFile} is on ${repo.default_branch} and enabled.`
                : `The workflow is ${workflow.state.replace(/_/g, ' ')} on GitHub.`,
            fix: workflow.state === 'active' ? undefined : 'Enable it under the repository\'s Actions tab.',
            url: workflow.html_url,
          }
        : {
            key: 'workflow',
            label: 'Pipeline workflow',
            state: 'missing',
            detail: `.github/workflows/${this.config.workflowFile} is not on ${repo.default_branch}; GitHub only runs dispatched workflows from the default branch.`,
            fix: 'Push the pipeline commit (release.yml, the plan script, fastlane/, Gemfile) to main.',
          },
    );

    const paths = new Set(('notFound' in tree ? [] : tree.tree).map((t) => t.path));
    const has = (...files: string[]) => files.every((f) => paths.has(f));
    out.checks.push(
      has('fastlane/Fastfile', 'fastlane/Appfile', 'Gemfile', 'Gemfile.lock')
        ? { key: 'fastlane', label: 'Fastlane', state: 'ok', detail: `fastlane/Fastfile, Appfile and Gemfile.lock are on ${repo.default_branch}.` }
        : {
            key: 'fastlane',
            label: 'Fastlane',
            state: 'missing',
            detail: `Fastlane configuration is missing on ${repo.default_branch}.`,
            fix: 'It ships in the same pipeline commit as the workflow.',
          },
    );

    const signing = await this.latestSigner(runs ?? []);
    out.signing = signing;
    out.checks.push(
      has('android/key.properties', 'android/app/upload-keystore.jks')
        ? {
            key: 'signing',
            label: 'Upload key',
            state: 'ok',
            detail: signing
              ? `Signed as ${signing.signer} · SHA-256 ${signing.certSha256} (run #${signing.runNumber}). It must match the upload key in Play Console > App integrity.`
              : `android/key.properties and upload-keystore.jks are on ${repo.default_branch}; the first build prints the key's fingerprint.`,
          }
        : {
            key: 'signing',
            label: 'Upload key',
            state: 'missing',
            detail: `android/key.properties or android/app/upload-keystore.jks is missing on ${repo.default_branch}: builds would be debug-signed and the pipeline stops them.`,
          },
    );

    out.checks.push(this.playConsoleCheck(play));
    if (secret.state === 'missing' && play.configured) {
      secret.fix = 'Copy the console’s Play key into the secret with the button below; it is encrypted for GitHub on the way.';
    }
    out.checks.push(secret);
    out.variables = variables;
    out.nextRunNumber = runs && runs.length ? Math.max(...runs.map((r) => r.run_number)) + 1 : workflowOk ? 1 : null;

    const check = await this.lastPlayCheck(runs ?? []);
    out.playCheck = check;
    out.checks.push(
      !check
        ? {
            key: 'play-access',
            label: 'Google Play access',
            state: 'pending',
            detail: 'Not checked yet. "Check Play access" runs Fastlane against Google Play without uploading anything.',
          }
        : check.state === 'success'
          ? {
              key: 'play-access',
              label: 'Google Play access',
              state: 'ok',
              detail: check.status?.highestVersionCode
                ? `Key works for com.fusionapps.fusionhrm; highest versionCode on Play: ${check.status.highestVersionCode}.`
                : 'Key works for com.fusionapps.fusionhrm.',
              url: check.url,
            }
          : check.state === 'running' || check.state === 'queued'
            ? { key: 'play-access', label: 'Google Play access', state: 'pending', detail: `Check #${check.number} is running.`, url: check.url }
            : {
                key: 'play-access',
                label: 'Google Play access',
                state: 'error',
                detail: check.messages[0] ?? `Check #${check.number} failed; open it for the log.`,
                url: check.url,
              },
    );

    out.checks.push(await this.builderCheck());
    out.rate = this.gh.rateLimit;
    return out;
  }

  /**
   * Why a working token cannot read the repository. The usual cause is a fine-grained token
   * owned by the engineer's own account: it only ever sees that account's repositories.
   */
  private async tokenProblem(e: unknown): Promise<SetupCheck> {
    const check: SetupCheck = { key: 'token', label: 'GitHub token', state: 'error', detail: (e as Error).message };
    if (!(e instanceof GithubError) || e.status !== 404) return check;
    const repo = this.config.githubRepo;
    const owner = repo.split('/')[0];
    const login = await this.gh
      .get<{ login: string }>('/user')
      .then((u) => u.login)
      .catch(() => null);
    check.detail = `${login ? `The token of @${login}` : 'The token'} works, but GitHub hides ${repo} from it (404).`;
    check.fix =
      `A fine-grained token sees only its resource owner's repositories: create it with Resource owner "${owner}" ` +
      `(an organization owner may have to approve it) and Repository access "${repo.split('/')[1]}", with Actions read/write, ` +
      `Contents read, Secrets read/write and Variables read. A classic token needs the repo and workflow scopes, ` +
      `and SSO authorization if ${owner} uses SAML.`;
    return check;
  }

  /** The builder that runs the pipeline for uploaded ZIPs; it needs no GitHub token. */
  private async builderCheck(): Promise<SetupCheck> {
    const base = { key: 'builder' as const, label: 'Builds from uploaded ZIPs' };
    if (!this.builder.configured) {
      return { ...base, state: 'missing', detail: 'Off: BUILDER_URL and BUILDER_TOKEN are not set for the console API.', fix: 'Start the builder service (docker compose up -d builder) with BUILDER_TOKEN in .env.' };
    }
    const health = await this.builder.health();
    if (!health?.ok) {
      return { ...base, state: 'error', detail: 'The builder is not answering.', fix: 'Check it with: docker compose ps builder' };
    }
    return {
      ...base,
      state: 'ok',
      detail: health.busy
        ? `Ready; building now${health.queued ? `, ${health.queued} queued` : ''}. Flutter 3.47.5, Android SDK and Fastlane on this server.`
        : 'Ready and idle. Flutter 3.47.5, Android SDK and Fastlane on this server; upload a ZIP from Start build.',
    };
  }

  /** Copies the key mounted on the console into the repository's Actions secret. */
  async syncPlayKey(): Promise<{ clientEmail: string; projectId: string | null }> {
    const json = this.playClient.keyJson();
    if (!json) {
      throw new BadRequestException(
        `The console has no Google Play key to copy. Mount it at ${this.config.playKeyFile}, or upload the JSON instead.`,
      );
    }
    return this.storePlayKey(json);
  }

  private async playSetup(): Promise<PlaySetup> {
    const key = this.playClient.keyState();
    if (key.kind !== 'ready') {
      return { configured: false, clientEmail: null, projectId: null, snapshot: null, error: key.reason };
    }
    const base = { configured: true, clientEmail: key.key.client_email, projectId: key.key.project_id ?? null };
    try {
      return { ...base, snapshot: await this.playClient.snapshot(), error: null };
    } catch (e) {
      return { ...base, snapshot: null, error: (e as Error).message };
    }
  }

  private playConsoleCheck(play: PlaySetup): SetupCheck {
    const base = { key: 'play-console' as const, label: 'Google Play (console key)' };
    if (!play.configured) {
      return { ...base, state: 'missing', detail: play.error ?? 'No Google Play key on the console.', fix: 'Mount the service-account JSON (see docker-compose.yml, secrets/).' };
    }
    if (play.error || !play.snapshot) {
      return { ...base, state: 'error', detail: play.error ?? 'Google Play did not answer.' };
    }
    const live = play.snapshot.tracks
      .filter((t) => t.releases.length)
      .map((t) => `${t.track} ${t.releases.map((r) => r.versionCodes.join('/')).join(', ')}`)
      .join(' · ');
    return {
      ...base,
      state: 'ok',
      detail: `${play.clientEmail} reads ${play.snapshot.packageName}${live ? ` — ${live}` : ' — no releases yet'}.`,
    };
  }

  /** Stores the Play service-account key as the repository's Actions secret. */
  async storePlayKey(json: string): Promise<{ clientEmail: string; projectId: string | null }> {
    let key: { type?: unknown; client_email?: unknown; private_key?: unknown; project_id?: unknown };
    try {
      key = JSON.parse(json) as typeof key;
    } catch {
      throw new BadRequestException('That file is not JSON. Choose the key file Google Cloud downloaded for the service account.');
    }
    if (key.type !== 'service_account' || typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
      throw new BadRequestException(
        'That JSON is not a service-account key: it needs "type": "service_account", a client_email and a private_key.',
      );
    }
    if (!key.private_key.includes('PRIVATE KEY')) {
      throw new BadRequestException('The private_key in that file is not a PEM private key.');
    }
    const publicKey = await this.gh.get<{ key_id: string; key: string }>(this.gh.repoPath('/actions/secrets/public-key'));
    const encrypted = await sealForGithub(json, publicKey.key);
    await this.gh.put(this.gh.repoPath(`/actions/secrets/${PLAY_SECRET}`), {
      encrypted_value: encrypted,
      key_id: publicKey.key_id,
    });
    this.logger.log(`Stored ${PLAY_SECRET} for ${key.client_email}.`);
    return { clientEmail: key.client_email, projectId: typeof key.project_id === 'string' ? key.project_id : null };
  }

  private async secret(): Promise<SetupCheck> {
    const base = { key: 'play-secret' as const, label: 'Play service-account key' };
    try {
      const res = await this.gh.getOrNotFound<{ name: string; updated_at: string }>(
        this.gh.repoPath(`/actions/secrets/${PLAY_SECRET}`),
      );
      if ('notFound' in res) {
        return {
          ...base,
          state: 'missing',
          detail: `The ${PLAY_SECRET} secret is not set, so Fastlane cannot reach Google Play.`,
          fix: 'Upload the key below; it is encrypted straight into the GitHub secret.',
        };
      }
      return { ...base, state: 'ok', detail: `${PLAY_SECRET} is set (updated ${res.updated_at.slice(0, 10)}).` };
    } catch (e) {
      if (e instanceof GithubError && e.upstreamStatus === 403) {
        return {
          ...base,
          state: 'unknown',
          detail: 'The token cannot read repository secrets, so the console cannot tell whether the key is set.',
          fix: 'Give the token Secrets read/write, or check GitHub > Settings > Secrets and variables > Actions.',
        };
      }
      return { ...base, state: 'error', detail: (e as Error).message };
    }
  }

  private async variables(): Promise<SetupResponse['variables']> {
    const fallback = { readable: false, defaultTrack: 'internal', versionCodeOffset: 1000, fromVariables: [] as string[] };
    try {
      const res = await this.gh.get<{ variables: Array<{ name: string; value: string }> }>(
        this.gh.repoPath('/actions/variables'),
        { per_page: 30 },
      );
      const byName = new Map(res.variables.map((v) => [v.name, v.value]));
      const offset = Number(byName.get('VERSION_CODE_OFFSET'));
      return {
        readable: true,
        defaultTrack: byName.get('PLAY_DEFAULT_TRACK') || 'internal',
        versionCodeOffset: Number.isInteger(offset) ? offset : 1000,
        fromVariables: ['PLAY_DEFAULT_TRACK', 'VERSION_CODE_OFFSET'].filter((n) => byName.has(n)),
      };
    } catch {
      // Needs the Variables permission, which the console does not ask for; defaults apply.
      return fallback;
    }
  }

  private async lastPlayCheck(runs: GhWorkflowRun[]): Promise<SetupResponse['playCheck']> {
    const run = runs.find((r) => describeRun(r).mode === 'validate');
    if (!run) return null;
    const state = runState(run);
    let status: PlayStatus | null = null;
    let messages: string[] = [];
    if (run.status === 'completed') {
      try {
        const detail = await this.pipeline.run(run.id);
        status = detail.playStatus;
        messages = detail.failure?.messages ?? [];
      } catch (e) {
        this.logger.warn(`play check ${run.id}: ${(e as Error).message}`);
      }
    }
    return { runId: run.id, number: run.run_number, state, at: run.updated_at, url: run.html_url, status, messages };
  }

  private async latestSigner(runs: GhWorkflowRun[]): Promise<SetupResponse['signing']> {
    const built = runs.filter((r) => r.conclusion === 'success' && describeRun(r).mode !== 'validate').slice(0, 5);
    for (const run of built) {
      try {
        const list = await this.gh.get<GhArtifactList>(this.gh.repoPath(`/actions/runs/${run.id}/artifacts`));
        const artifact = list.artifacts.find((a) => a.name === ARTIFACTS.buildInfo && !a.expired);
        if (!artifact) continue;
        const info = readJson<BuildInfo>(
          unzip(await this.gh.download(this.gh.repoPath(`/actions/artifacts/${artifact.id}/zip`))),
          'build-info.json',
        );
        if (info) return { signer: info.signer, certSha256: info.certSha256, runNumber: run.run_number };
      } catch (e) {
        this.logger.warn(`build info for run ${run.id}: ${(e as Error).message}`);
      }
    }
    return null;
  }
}
