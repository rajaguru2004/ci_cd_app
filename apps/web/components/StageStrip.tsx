'use client';

import clsx from 'clsx';
import { duration, since } from '@/lib/format';
import type { StageKey, StageView } from '@/lib/types';
import { ARC, STATE_WORD, StateGlyph } from './stage';

/**
 * The run's six stages, left to right: the rail's ring unrolled, same colours, same rounded
 * segments with air between them. The diamond in the gap after the AAB is the "build
 * successful" moment: it fills once a signed bundle exists.
 */
export function StageStrip({
  stages,
  selected,
  onSelect,
  now,
}: {
  stages: StageView[];
  selected: StageKey | null;
  onSelect: (key: StageKey) => void;
  now: number;
}) {
  const built = stages.find((s) => s.key === 'aab')?.state === 'success';
  return (
    <ol className="grid grid-cols-1 gap-1 md:grid-cols-6 md:gap-3" aria-label="Pipeline stages">
      {stages.map((s) => {
        const live = s.state === 'running' ? since(s.startedAt, now) : s.durationMs;
        const active = selected === s.key;
        const off = s.state === 'skipped' || s.state === 'pending';
        return (
          <li key={s.key} className="relative">
            <button
              type="button"
              onClick={() => onSelect(s.key)}
              aria-pressed={active}
              className={clsx(
                'group flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-start transition-colors md:flex-col md:items-stretch md:gap-2 md:rounded-none md:px-0 md:py-0 md:pb-3',
                active ? 'bg-brand-wash md:bg-transparent' : 'hover:bg-line-soft md:hover:bg-transparent',
              )}
            >
              <span className="hidden h-1.5 overflow-hidden rounded-full md:block" style={{ background: 'var(--color-line-soft)' }}>
                <span
                  key={s.state}
                  className={clsx('block h-full rounded-full', !off && 'fill-in')}
                  style={{
                    background: ARC[s.state],
                    // A skipped or waiting stage keeps a visible outline of its slot.
                    boxShadow: off ? 'inset 0 0 0 1px var(--color-idle)' : undefined,
                  }}
                />
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <StateGlyph state={s.state} />
                <span className="min-w-0">
                  <span
                    className={clsx(
                      'block truncate text-[14px]',
                      active
                        ? 'font-semibold text-ink underline decoration-brand decoration-2 underline-offset-[6px]'
                        : off
                          ? 'font-medium text-muted'
                          : 'font-medium text-ink',
                    )}
                  >
                    {s.label}
                  </span>
                  <span className="block truncate text-[12px] text-muted">
                    {s.state === 'success' || s.state === 'failed' || s.state === 'running' ? (
                      <span className="tabular">{duration(live) || STATE_WORD[s.state]}</span>
                    ) : (
                      STATE_WORD[s.state]
                    )}
                  </span>
                </span>
              </span>
            </button>
            {s.key === 'aab' && (
              <span
                aria-label={built ? 'Build successful: a signed AAB exists' : 'No signed AAB yet'}
                role="img"
                className={clsx(
                  'absolute -end-[11px] -top-[2px] z-10 hidden h-2.5 w-2.5 rotate-45 rounded-[2px] border-2 md:block',
                  built ? 'border-ok bg-ok' : 'border-idle bg-card',
                )}
                style={{ transition: 'background-color 200ms, border-color 200ms' }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
