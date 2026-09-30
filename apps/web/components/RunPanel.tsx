'use client';

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ExternalLink, OctagonX, RotateCcw, RotateCw, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago, between, duration, short, since } from '@/lib/format';
import type { RunDetail, RunSummary, StageKey } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';
import { LogPane } from './LogPane';
import { Outputs } from './Outputs';
import { StageStrip } from './StageStrip';
import { RUN_INK, RUN_WORD, StageRing, StateGlyph, runAsStage, STAGE_LABELS } from './stage';

function triggerText(run: RunSummary): string {
  const who = run.actor?.login;
  if (run.trigger === 'console') return who ? `started from the console by ${who}` : 'started from the console';
  if (run.trigger === 'tag') return `started by tag ${run.tag}`;
  if (run.trigger === 'commit') return 'started by a release: commit';
  return `started by ${run.event}`;
}

function runTitle(run: RunSummary): string {
  if (run.mode === 'release') return `${run.rehearsal ? 'Rehearsal' : 'Release'}${run.track ? ` → ${run.track}` : ''}`;
  if (run.mode === 'validate') return 'Check Play access';
  if (run.mode === 'build') return 'Build and test';
  return run.title;
}

export function RunPanel({
  runId,
  siblings,
  onSelectRun,
  now,
  onChanged,
}: {
  runId: number;
  /** Other runs of the same commit, newest first, for the switcher. */
  siblings: RunSummary[];
  onSelectRun: (id: number) => void;
  now: number;
  onChanged: () => void;
}) {
  const [active, setActive] = useState(true);
  const poll = usePoll<RunDetail>(() => api<RunDetail>(`/runs/${runId}`), active ? 4000 : 30000, [runId]);
  const detail = poll.data;

  useEffect(() => {
    if (detail) setActive(detail.run.state === 'running' || detail.run.state === 'queued' || detail.run.state === 'waiting');
  }, [detail]);

  const [stage, setStage] = useState<StageKey | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Open on the stage that matters: the failure, else what is running, else the last one reached.
  const defaultStage = useMemo<StageKey | null>(() => {
    if (!detail) return null;
    const failed = detail.stages.find((s) => s.state === 'failed');
    const running = detail.stages.find((s) => s.state === 'running' || s.state === 'queued');
    const reached = [...detail.stages].reverse().find((s) => s.state !== 'skipped' && s.state !== 'pending');
    return (failed ?? running ?? reached ?? detail.stages[0])?.key ?? null;
  }, [detail]);

  useEffect(() => {
    setStage(null);
    setActionError(null);
  }, [runId]);

  const shownStage = stage ?? defaultStage;
  const stageView = detail?.stages.find((s) => s.key === shownStage) ?? null;

  async function act(path: string, label: string) {
    setBusy(label);
    setActionError(null);
    try {
      await api(`/runs/${runId}/${path}`, { method: 'POST' });
      setActive(true);
      await poll.refresh();
      onChanged();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : `${label} did not go through.`);
    } finally {
      setBusy(null);
    }
  }

  if (poll.error && !detail) {
    return (
      <div className="panel px-6 py-8">
        <p role="alert" className="text-fail-ink">
          {poll.error.message}
        </p>
      </div>
    );
  }
  if (!detail) return <PanelSkeleton />;

  const run = detail.run;
  const running = run.state === 'running' || run.state === 'queued' || run.state === 'waiting';
  const elapsed = running ? since(run.startedAt ?? run.createdAt, now) : between(run.startedAt ?? run.createdAt, run.updatedAt);
  const failedStage = detail.stages.find((s) => s.state === 'failed');
  const focusStep =
    detail.failure && detail.failure.stage === shownStage
      ? (stageView?.steps.find((s) => s.jobId === detail.failure?.jobId && s.state === 'failed')?.number ?? null)
      : null;

  let headline = `${RUN_WORD[run.state]}`;
  if (run.state === 'failed' && failedStage) headline = `Failed at ${failedStage.label}`;
  const rehearsal = Boolean(detail.plan?.rehearsal ?? run.rehearsal);
  if (run.state === 'success' && detail.release) {
    headline = rehearsal || detail.release.validatedOnly
      ? `Rehearsal passed · Google Play accepted it, nothing published`
      : `On Google Play · ${detail.release.track}`;
  }
  if (run.state === 'success' && !detail.release && (detail.plan?.mode ?? run.mode) === 'build') headline = 'Passed · AAB ready';

  return (
    <article className="space-y-5" aria-labelledby="run-title">
      <header className="panel px-5 pb-5 pt-5 md:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <h1 id="run-title" className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink [text-wrap:balance]">
              {detail.commit.subject || run.title}
            </h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
              <span className="font-mono">{short(detail.commit.sha)}</span>
              {detail.commit.author && (
                <>
                  <span aria-hidden>·</span>
                  <span>{detail.commit.author}</span>
                </>
              )}
              {detail.commit.date && (
                <>
                  <span aria-hidden>·</span>
                  <time dateTime={detail.commit.date}>{ago(detail.commit.date, now)}</time>
                </>
              )}
              {run.branch && (
                <>
                  <span aria-hidden>·</span>
                  <span className="font-mono">{run.branch}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            {running && (
              <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => act('cancel', 'Cancel')}>
                <OctagonX size={15} aria-hidden />
                {busy === 'Cancel' ? 'Cancelling…' : 'Cancel run'}
              </button>
            )}
            {run.state === 'failed' && (
              <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => act('rerun-failed', 'Re-run')}>
                <RotateCcw size={15} aria-hidden />
                {busy === 'Re-run' ? 'Starting…' : 'Re-run failed jobs'}
              </button>
            )}
            {!running && (
              <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => act('rerun', 'Re-run all')}>
                <RotateCw size={15} aria-hidden />
                {busy === 'Re-run all' ? 'Starting…' : 'Re-run all'}
              </button>
            )}
            <a className="btn btn-quiet h-10" href={run.url} target="_blank" rel="noreferrer">
              GitHub
              <ExternalLink size={14} aria-hidden />
            </a>
          </div>
        </div>

        {siblings.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Runs of this commit">
            {siblings.map((r) => (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={r.id === run.id}
                onClick={() => onSelectRun(r.id)}
                className={clsx(
                  'flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors',
                  r.id === run.id ? 'border-brand bg-brand-wash text-ink' : 'border-line text-muted hover:text-ink',
                )}
              >
                <StateGlyph state={runAsStage(r.state)} size={14} />#{r.number} {runTitle(r)}
              </button>
            ))}
          </div>
        )}

        <div className="mt-5 flex items-center gap-4">
          {/* The rail's ring for this run, at size: the strip below is the same six stages unrolled. */}
          <StageRing stages={detail.stages} size={44} shippedCore={Boolean(detail.release) && !detail.release?.validatedOnly && !rehearsal} label={`Stages of run ${run.number}`} />
          <div className="min-w-0">
            <p className={clsx('text-[15px] font-semibold', RUN_INK[run.state])}>{headline}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted">
              <span className="font-medium text-body">
                #{run.number} {runTitle(run)}
              </span>
              {run.attempt > 1 && <span>· attempt {run.attempt}</span>}
              <span>
                · <span className="tabular">{duration(elapsed)}</span> · {triggerText(run)}
              </span>
              {run.tag && (
                <span className="inline-flex h-5 items-center rounded-full border border-ship/40 bg-ship-wash px-2 font-mono text-[11px] font-medium text-ship-ink">
                  {run.tag}
                </span>
              )}
              {(detail.plan?.mode ?? run.mode) === 'release' &&
                (rehearsal ? (
                  <span className="inline-flex h-5 items-center rounded-full border border-line px-2 text-[11px] font-semibold text-body">
                    rehearsal → {detail.plan?.track ?? run.track ?? 'default track'}
                  </span>
                ) : (
                  <span className="inline-flex h-5 items-center rounded-full bg-ship-wash px-2 text-[11px] font-semibold text-ship-ink">
                    release → {detail.plan?.track ?? run.track ?? 'default track'}
                  </span>
                ))}
            </p>
          </div>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <StageStrip stages={detail.stages} selected={shownStage} onSelect={setStage} now={now} />
        </div>

        {actionError && (
          <p role="alert" className="mt-3 rounded-[var(--radius-control)] bg-fail-wash px-4 py-3 text-[13px] text-fail-ink">
            {actionError}
          </p>
        )}
        {poll.error && (
          <p className="mt-3 text-[12px] text-muted">Showing the last update: {poll.error.message}</p>
        )}
      </header>

      {detail.failure && (
        <section aria-labelledby="failure-title" className="rounded-[var(--radius-panel)] border border-fail/25 bg-fail-wash px-5 py-4 md:px-6">
          <h2 id="failure-title" className="flex items-center gap-2 text-[15px] font-bold text-fail-ink">
            <TriangleAlert size={16} aria-hidden />
            {detail.failure.stage ? STAGE_LABELS[detail.failure.stage] : detail.failure.jobName}
            {detail.failure.step ? ` › ${detail.failure.step}` : ''}
          </h2>
          {detail.failure.messages.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {detail.failure.messages.map((m, i) => (
                <li key={i} className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-ink">
                  {m}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13px] text-ink">The step exited with an error; its log is open below.</p>
          )}
          {detail.failure.stage && detail.failure.stage !== shownStage && (
            <button type="button" className="mt-3 text-[13px] font-semibold text-fail-ink underline" onClick={() => setStage(detail.failure?.stage ?? null)}>
              Open the failing step&apos;s log
            </button>
          )}
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <div className="min-w-0">
          {stageView && <LogPane key={`${runId}-${stageView.key}`} runId={runId} stage={stageView} jobs={detail.jobs} now={now} focusStep={focusStep} />}
        </div>
        <Outputs detail={detail} />
      </div>
    </article>
  );
}

function PanelSkeleton() {
  return (
    <div aria-hidden className="space-y-5">
      <div className="panel space-y-4 px-6 py-6">
        <div className="h-5 w-3/5 animate-pulse rounded bg-line-soft" />
        <div className="h-3.5 w-2/5 animate-pulse rounded bg-line-soft" />
        <div className="grid grid-cols-6 gap-2 pt-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-line-soft" />
          ))}
        </div>
      </div>
      <div className="h-72 animate-pulse rounded-[var(--radius-card)] bg-[#1e293b]" />
    </div>
  );
}
