'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { GitBranch, RefreshCw, Tag, TriangleAlert } from 'lucide-react';
import { ago, short } from '@/lib/format';
import type { RunSummary, StreamCommit, StreamResponse } from '@/lib/types';
import { RUN_INK, RUN_WORD, StageRing, ringLabel, shipped } from './stage';

function runName(run: RunSummary): string {
  if (run.mode === 'release') return `${run.rehearsal ? 'Rehearsal' : 'Release'}${run.track ? ` → ${run.track}` : ''}`;
  if (run.mode === 'validate') return 'Play check';
  if (run.mode === 'build') return 'Build';
  return 'Run';
}

function Flags({ commit }: { commit: StreamCommit }) {
  if (!commit.tags.length && !commit.release) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1.5">
      {commit.tags.map((t) => (
        <span
          key={t}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-ship/40 bg-ship-wash px-2 font-mono text-[11px] font-medium text-ship-ink"
        >
          <Tag size={11} aria-hidden />
          {t}
        </span>
      ))}
      {commit.release && (
        <span className="inline-flex h-5 items-center rounded-full bg-ship-wash px-2 text-[11px] font-semibold text-ship-ink">
          release{commit.release.track ? ` → ${commit.release.track}` : ''}
        </span>
      )}
    </span>
  );
}

export function CommitRail({
  stream,
  error,
  loading,
  empty,
  branches,
  selectedSha,
  selectedRunId,
  onBranch,
  onSelectCommit,
  onSelectRun,
  onRefresh,
  now,
}: {
  stream: StreamResponse | null;
  error: string | null;
  loading: boolean;
  /** Shown in place of the stream when there is nothing to list yet (e.g. no GitHub token). */
  empty?: React.ReactNode;
  branches: string[];
  selectedSha: string | null;
  selectedRunId: number | null;
  onBranch: (b: string) => void;
  onSelectCommit: (c: StreamCommit) => void;
  onSelectRun: (r: RunSummary) => void;
  onRefresh: () => void;
  now: number;
}) {
  const branch = stream?.branch ?? branches[0] ?? 'main';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <label className="relative flex min-w-0 flex-1 items-center">
          <span className="sr-only">Branch</span>
          <GitBranch size={16} aria-hidden className="pointer-events-none absolute start-3 text-muted" />
          <select
            className="field h-11 ps-9 font-medium"
            value={branch}
            onChange={(e) => onBranch(e.target.value)}
          >
            {(branches.length ? branches : [branch]).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-quiet h-11 w-11 p-0"
          onClick={onRefresh}
          aria-label="Refresh"
          title={stream ? `Updated ${ago(stream.refreshedAt, now)}` : 'Refresh'}
        >
          <RefreshCw size={16} aria-hidden className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {stream && !stream.workflow.present && (
        <div className="mx-4 mt-3 flex gap-3 rounded-[var(--radius-card)] bg-warn-wash px-4 py-3 text-[13px] text-ink">
          <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0 text-warn-ink" />
          <p>
            {stream.workflow.file} is not on {stream.repo.defaultBranch} yet, so no pipeline has run.{' '}
            <Link href="/setup" className="font-semibold text-warn-ink underline">
              Open Setup
            </Link>
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="mx-4 mt-3 rounded-[var(--radius-card)] bg-fail-wash px-4 py-3 text-[13px] text-fail-ink">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {!stream && empty}
        {!stream && !empty && loading && <RailSkeleton />}
        {stream && (
          <ol className="relative py-2" aria-label={`Commits on ${stream.branch}`}>
            {stream.commits.map((c, i) => {
              const run = c.runs[0];
              const active = c.sha === selectedSha;
              const last = i === stream.commits.length - 1;
              return (
                <li key={c.sha} className="relative">
                  {/* The rail: a hairline through every node, like git log --graph. */}
                  <span
                    aria-hidden
                    className={clsx('absolute start-[33px] w-0.5 bg-line', i === 0 ? 'top-6' : 'top-0', last ? 'h-6' : 'bottom-0')}
                  />
                  <button
                    type="button"
                    onClick={() => onSelectCommit(c)}
                    aria-current={active ? 'true' : undefined}
                    className={clsx(
                      'relative grid w-full grid-cols-[36px_minmax(0,1fr)] gap-3 px-4 py-3 text-start transition-colors duration-150',
                      active ? 'bg-brand-wash' : 'hover:bg-line-soft/70',
                    )}
                  >
                    <span className="relative flex h-9 items-start justify-center pt-0.5">
                      {run ? (
                        <span className={clsx('rounded-full', active ? 'bg-brand-wash' : 'bg-card')}>
                          <StageRing stages={run.stages} shippedCore={shipped(run)} label={ringLabel(run)} size={30} />
                        </span>
                      ) : (
                        <span
                          aria-label="No pipeline run"
                          role="img"
                          className="mt-2.5 h-3 w-3 rounded-full border-2 border-idle bg-card"
                        />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className={clsx('line-clamp-2 text-[14px] leading-snug', active ? 'font-semibold text-ink' : 'font-medium text-ink')}>
                        {c.subject}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
                        <span className="font-mono">{short(c.sha)}</span>
                        <span aria-hidden>·</span>
                        <span className="truncate">{c.author.login ?? c.author.name}</span>
                        <span aria-hidden>·</span>
                        <time dateTime={c.date}>{ago(c.date, now)}</time>
                      </span>
                      <Flags commit={c} />
                      {run && (
                        <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
                          {c.runs.slice(0, 3).map((r) => (
                            <span key={r.id} className="inline-flex items-center gap-1">
                              <span className="font-medium text-body">
                                #{r.number} {runName(r)}
                              </span>
                              <span className={RUN_INK[r.state]}>{RUN_WORD[r.state].toLowerCase()}</span>
                            </span>
                          ))}
                          {c.runs.length > 3 && <span className="text-muted">+{c.runs.length - 3} more</span>}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        {stream && stream.commits.length === 0 && (
          <p className="px-6 py-10 text-center text-muted">No commits on {stream.branch}.</p>
        )}

        {stream && stream.otherRuns.length > 0 && (
          <section aria-labelledby="elsewhere" className="mx-4 mt-4 border-t border-line pt-4">
            <h2 id="elsewhere" className="px-1 text-[13px] font-semibold text-ink">
              Runs on other branches and older commits
            </h2>
            <ul className="mt-2 space-y-1">
              {stream.otherRuns.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onSelectRun(r)}
                    aria-current={r.id === selectedRunId ? 'true' : undefined}
                    className={clsx(
                      'flex w-full items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 text-start transition-colors',
                      r.id === selectedRunId ? 'bg-brand-wash' : 'hover:bg-line-soft/70',
                    )}
                  >
                    <StageRing stages={r.stages} shippedCore={shipped(r)} label={ringLabel(r)} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">
                        #{r.number} {runName(r)}
                      </span>
                      <span className="block truncate text-[12px] text-muted">
                        {r.branch ?? 'unknown ref'} · <span className="font-mono">{short(r.sha)}</span> · {ago(r.createdAt, now)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function RailSkeleton() {
  return (
    <ol aria-hidden className="py-2">
      {Array.from({ length: 7 }).map((_, i) => (
        <li key={i} className="grid grid-cols-[36px_1fr] gap-3 px-4 py-3">
          <span className="mx-auto h-[30px] w-[30px] animate-pulse rounded-full bg-line-soft" />
          <span className="space-y-2 pt-1">
            <span className="block h-3.5 w-4/5 animate-pulse rounded bg-line-soft" />
            <span className="block h-3 w-2/5 animate-pulse rounded bg-line-soft" />
          </span>
        </li>
      ))}
    </ol>
  );
}
