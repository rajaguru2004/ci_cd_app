import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CONSOLE_CONFIG, ConsoleConfig } from '../config';
import { GithubClient } from '../github/github.client';
import type { GhJobList, GhRunList } from '../github/github.types';
import { BuilderClient } from '../local/builder.client';
import { PlayClient } from './play.client';

/** Jobs whose Fastlane lanes open a Google Play edit (release.yml and the builder alike). */
export const PLAY_EDIT_JOBS = new Set(['Google Play', 'Google Play access']);

/**
 * Google Play keeps one open edit per app, and a new edit ends the one before it. The console
 * reads Play through edits too, so a read that lands while Fastlane uploads would end the
 * pipeline's edit and fail the release. This names the run that may hold an edit right now —
 * a ZIP run on this server, or a run on GitHub Actions — so PlayClient reads nothing new
 * until it is done.
 */
@Injectable()
export class PlayEditGuard implements OnModuleInit {
  private readonly logger = new Logger(PlayEditGuard.name);

  constructor(
    private readonly play: PlayClient,
    private readonly builder: BuilderClient,
    private readonly gh: GithubClient,
    @Inject(CONSOLE_CONFIG) private readonly config: ConsoleConfig,
  ) {}

  onModuleInit(): void {
    this.play.setEditHolderProbe(() => this.holder());
  }

  /** A sentence naming the run that may hold a Play edit, or null when none does. */
  async holder(): Promise<string | null> {
    return (await this.onBuilder()) ?? (await this.onGithub());
  }

  private async onBuilder(): Promise<string | null> {
    if (!this.builder.configured) return null;
    try {
      const run = (await this.builder.list()).find(
        (r) => r.status === 'in_progress' && r.jobs.some((j) => PLAY_EDIT_JOBS.has(j.name) && j.status === 'in_progress'),
      );
      return run ? `ZIP run #${run.id} is uploading to Google Play.` : null;
    } catch (e) {
      this.logger.warn(`builder not readable for the Play edit check: ${(e as Error).message}`);
      return null;
    }
  }

  private async onGithub(): Promise<string | null> {
    if (!this.gh.configured) return null;
    try {
      const path = this.gh.repoPath(`/actions/workflows/${encodeURIComponent(this.config.workflowFile)}/runs`);
      const runs = await this.gh.get<GhRunList>(path, { status: 'in_progress', per_page: 10 });
      for (const run of runs.workflow_runs) {
        const jobs = await this.gh.get<GhJobList>(this.gh.repoPath(`/actions/runs/${run.id}/jobs`), { per_page: 100, filter: 'latest' });
        if (jobs.jobs.some((j) => PLAY_EDIT_JOBS.has(j.name) && j.status === 'in_progress')) {
          return `GitHub run #${run.run_number} is working on Google Play.`;
        }
      }
      return null;
    } catch {
      // No token that can see the repo, or GitHub down: nothing known to be uploading there.
      return null;
    }
  }
}
