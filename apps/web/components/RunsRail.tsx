'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { Upload } from 'lucide-react';
import { ago, runLabel, short } from '@/lib/format';
import type { RunSummary } from '@/lib/types';
import { RUN_INK, RUN_WORD, StageRing, ringLabel, shipped } from './stage';

function what(run: RunSummary): string {
  if (run.mode === 'release') return `${run.rehearsal ? 'Rehearsal' : 'Release'}${run.track ? ` → ${run.track}` : ''}`;
  return 'Build and test';
}

/**
 * Builds of uploaded source ZIPs on this server, shown in the rail's place when there is no
 * GitHub token (with one, they sit on their commits in the commit stream instead).
 */
export function LocalRunsRail({
  runs,
  loading,
  error,
  selectedRunId,
  onSelectRun,
  onUpload,
  now,
}: {
  runs: RunSummary[] | null;
  loading: boolean;
  error: string | null;
  selectedRunId: number | null;
  onSelectRun: (run: RunSummary) => void;
  onUpload: () => void;
  now: number;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">Builds on this server</h2>
        <button type="button" className="btn btn-secondary h-10" onClick={onUpload}>
          <Upload size={15} aria-hidden />
          Upload ZIP
        </button>
      </div>
      <p className="border-b border-line px-4 py-3 text-[12px] text-muted">
        GitHub is not connected, so this lists builds of uploaded source ZIPs.{' '}
        <Link href="/setup" className="font-medium text-brand underline">
          Connect GitHub
        </Link>{' '}
        to see every commit.
      </p>
      {error && <p role="alert" className="mx-4 mt-3 rounded-[var(--radius-card)] bg-fail-wash px-4 py-3 text-[13px] text-fail-ink">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {!runs && loading && (
          <ul aria-hidden className="space-y-1 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="flex gap-3 px-2 py-3">
                <span className="h-[30px] w-[30px] animate-pulse rounded-full bg-line-soft" />
                <span className="flex-1 space-y-2 pt-1">
                  <span className="block h-3.5 w-3/5 animate-pulse rounded bg-line-soft" />
                  <span className="block h-3 w-2/5 animate-pulse rounded bg-line-soft" />
                </span>
              </li>
            ))}
          </ul>
        )}
        {runs && runs.length === 0 && (
          <div className="px-6 py-10">
            <p className="font-semibold text-ink">No builds yet</p>
            <p className="mt-1 text-[13px] text-muted">Upload the mobile app&apos;s source ZIP (GitHub → Code → Download ZIP) to run the pipeline here.</p>
          </div>
        )}
        {runs && runs.length > 0 && (
          <ol className="py-2" aria-label="Builds on this server">
            {runs.map((r) => {
              const active = r.id === selectedRunId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onSelectRun(r)}
                    aria-current={active ? 'true' : undefined}
                    className={clsx(
                      'grid w-full grid-cols-[36px_minmax(0,1fr)] gap-3 px-4 py-3 text-start transition-colors duration-150',
                      active ? 'bg-brand-wash' : 'hover:bg-line-soft/70',
                    )}
                  >
                    <span className="flex justify-center pt-0.5">
                      <StageRing stages={r.stages} shippedCore={shipped(r)} label={ringLabel(r)} size={30} />
                    </span>
                    <span className="min-w-0">
                      <span className={clsx('block truncate text-[14px] text-ink', active ? 'font-semibold' : 'font-medium')}>
                        {runLabel(r)} {what(r)}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[12px] text-muted">{r.title.replace(/^Upload /, '')}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
                        <span className={RUN_INK[r.state]}>{RUN_WORD[r.state].toLowerCase()}</span>
                        {r.sha && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-mono">{short(r.sha)}</span>
                          </>
                        )}
                        <span aria-hidden>·</span>
                        <time dateTime={r.createdAt}>{ago(r.createdAt, now)}</time>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
