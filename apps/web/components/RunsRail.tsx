'use client';

import clsx from 'clsx';
import { ago, runLabel, runSource, runWhat } from '@/lib/format';
import type { RunSummary } from '@/lib/types';
import { RUN_INK, RUN_WORD, StageRing, ringLabel, shipped } from './stage';

/**
 * An app's runs as a plain list, in the rail's place when there is no commit stream to hang
 * them on (an app built from uploaded ZIPs, or a repository the console cannot read yet).
 */
export function RunsRail({
  runs,
  loading,
  note,
  selectedRunId,
  onSelectRun,
  now,
}: {
  runs: RunSummary[] | null;
  loading: boolean;
  /** Why this is a list and not the commit stream. */
  note: React.ReactNode;
  selectedRunId: number | null;
  onSelectRun: (run: RunSummary) => void;
  now: number;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink">Runs</h2>
        <div className="mt-1 text-[12px] text-muted">{note}</div>
      </div>
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
            <p className="font-semibold text-ink">No runs yet</p>
            <p className="mt-1 text-[13px] text-muted">Build or Release starts the first one.</p>
          </div>
        )}
        {runs && runs.length > 0 && (
          <ol className="py-2" aria-label="Runs">
            {runs.map((r) => {
              const active = r.id === selectedRunId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onSelectRun(r)}
                    aria-current={active ? 'true' : undefined}
                    className={clsx('grid w-full grid-cols-[36px_minmax(0,1fr)] gap-3 px-4 py-3 text-start transition-colors', active ? 'bg-brand-wash' : 'hover:bg-line-soft/70')}
                  >
                    <span className="flex justify-center pt-0.5">
                      <StageRing stages={r.stages} shippedCore={shipped(r)} label={ringLabel(r)} size={30} />
                    </span>
                    <span className="min-w-0">
                      <span className={clsx('block truncate text-[14px] text-ink', active ? 'font-semibold' : 'font-medium')}>
                        {runLabel(r)} {runWhat(r)}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[12px] text-muted">{runSource(r)}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
                        <span className={RUN_INK[r.state]}>{RUN_WORD[r.state].toLowerCase()}</span>
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
