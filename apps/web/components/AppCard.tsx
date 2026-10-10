'use client';

import Link from 'next/link';
import { ArrowRight, GitBranch, Hammer, Rocket, Settings2, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { ago, repoLine, runLabel, runWhat } from '@/lib/format';
import type { AppOverview, Mode, PlayResponse } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';
import { PlayTracks } from './PlayTracks';
import { RUN_INK, RUN_WORD, ringLabel, shipped, StageRing } from './stage';

/** Something an engineer must fix before this app can release, said once, in ink beside an amber mark. */
function Attention({ children, href }: { children: React.ReactNode; href: string }) {
  return (
    <div className="flex gap-2.5 rounded-[var(--radius-control)] bg-warn-wash px-3 py-2.5 text-[13px] text-ink">
      <TriangleAlert size={15} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
      <p className="min-w-0 flex-1">
        <span className="line-clamp-2">{children}</span>{' '}
        <Link href={href} className="font-semibold text-brand underline">
          Fix
        </Link>
      </p>
    </div>
  );
}

/**
 * One app: its latest run's six-stage ring as its face, what each Google Play track holds,
 * and Build / Release one press away.
 */
export function AppCard({ app, now, onRun }: { app: AppOverview; now: number; onRun: (mode: Mode) => void }) {
  const play = usePoll<PlayResponse>(() => api<PlayResponse>(`/apps/${app.id}/play`), 120_000, [app.id]);
  const run = app.activeRun ?? app.latestRun;
  const settings = `/apps/${app.id}/settings`;
  const access = app.repo?.access;

  return (
    <article className="panel flex min-w-0 flex-col" aria-labelledby={`app-${app.id}`}>
      <div className="flex flex-1 flex-col gap-4 px-5 pb-5 pt-5 md:px-6">
        <header className="flex items-start gap-3.5">
          <Link href={`/apps/${app.id}`} className="shrink-0 rounded-full" tabIndex={-1} aria-hidden>
            <StageRing
              stages={run?.stages ?? []}
              size={44}
              shippedCore={run ? shipped(run) : false}
              label={run ? ringLabel(run) : `${app.name}: no runs yet`}
            />
          </Link>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 id={`app-${app.id}`} className="truncate text-[16px] font-bold leading-snug text-ink">
              <Link href={`/apps/${app.id}`} className="hover:text-brand">
                {app.name}
              </Link>
            </h2>
            <p className="truncate font-mono text-[12px] text-muted">{app.packageName}</p>
          </div>
          <Link href={settings} className="btn btn-quiet -me-2 -mt-1 h-10 w-10 shrink-0 p-0" aria-label={`${app.name} settings`} title="Settings">
            <Settings2 size={17} aria-hidden />
          </Link>
        </header>

        <dl className="space-y-1.5 text-[13px]">
          <div className="flex min-w-0 items-center gap-2">
            <dt className="sr-only">Repository</dt>
            {app.repo ? (
              <dd className="flex min-w-0 items-center gap-1.5 text-muted">
                <GitBranch size={14} aria-hidden className="shrink-0" />
                <span className="shrink-0 font-mono text-body">{app.repo.branch}</span>
                <span aria-hidden>·</span>
                <span className="truncate" title={app.repo.url}>
                  {repoLine(app.repo)}
                </span>
              </dd>
            ) : (
              <dd className="text-muted">No repository: builds from uploaded ZIPs</dd>
            )}
          </div>
          <div className="flex min-w-0 items-baseline gap-2">
            <dt className="sr-only">Latest run</dt>
            {run ? (
              <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <Link href={`/apps/${app.id}?run=${run.id}`} className="font-medium text-body hover:text-brand">
                  {runLabel(run)} {runWhat(run)}
                </Link>
                <span className={RUN_INK[run.state]}>{RUN_WORD[run.state].toLowerCase()}</span>
                <span className="text-muted">· {ago(run.createdAt, now)}</span>
                {run.versionCode !== null && <span className="font-mono text-[12px] text-muted tabular">· {run.versionCode}</span>}
              </dd>
            ) : (
              <dd className="text-muted">No runs yet</dd>
            )}
          </div>
        </dl>

        <div>
          {play.data?.configured ? (
            <PlayTracks tracks={play.data.tracks} compact />
          ) : play.data && !play.data.configured ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-line px-3 py-2.5 text-[12px] text-muted">Google Play: {play.data.reason}</p>
          ) : play.error ? (
            // Refused or unknown to Play needs someone to act; anything else is Google being slow.
            /refused|has no app/i.test(play.error.message) ? (
              <Attention href={settings}>{/^Google Play/.test(play.error.message) ? play.error.message : `Google Play: ${play.error.message}`}</Attention>
            ) : (
              <p className="rounded-[var(--radius-card)] border border-dashed border-line px-3 py-2.5 text-[12px] text-muted" title={play.error.message}>
                Google Play did not answer just now; the tracks show on the next read.
              </p>
            )
          ) : (
            <div className="h-[52px] animate-pulse rounded-[var(--radius-card)] bg-line-soft" aria-hidden />
          )}
        </div>

        {access?.state === 'failed' && <Attention href={settings}>{access.message ?? 'The console cannot read the repository.'}</Attention>}
        {app.runner.kind === 'github' && app.runner.github?.check?.message && <Attention href={settings}>{app.runner.github.check.message}</Attention>}
        {!app.play.clientEmail && <Attention href={settings}>No Google Play key: releases cannot upload until one is added.</Attention>}
      </div>

      <footer className="flex items-center gap-2 border-t border-line px-5 py-3 md:px-6">
        <button type="button" className="btn btn-secondary h-10 px-3.5" onClick={() => onRun('build')}>
          <Hammer size={15} aria-hidden />
          Build
        </button>
        <button type="button" className="btn btn-secondary h-10 px-3.5" onClick={() => onRun('release')}>
          <Rocket size={15} aria-hidden />
          Release
        </button>
        <Link href={`/apps/${app.id}`} className="btn btn-quiet ms-auto h-10">
          Open
          <ArrowRight size={15} aria-hidden />
        </Link>
      </footer>
    </article>
  );
}
