import clsx from 'clsx';
import { Ban, Circle, CircleCheck, CircleDashed, CircleDot, CircleMinus, CircleX } from 'lucide-react';
import type { RunState, RunSummary, StageKey, StageState } from '@/lib/types';

export const STAGE_LABELS: Record<StageKey, string> = {
  checkout: 'Checkout',
  dependencies: 'Dependencies',
  tests: 'Tests',
  aab: 'Signed AAB',
  fastlane: 'Fastlane',
  play: 'Google Play',
};

export const STAGE_ORDER: StageKey[] = ['checkout', 'dependencies', 'tests', 'aab', 'fastlane', 'play'];

/**
 * Stage colour per state, shared by the ring and the strip so the strip reads as the ring
 * unrolled. Status hues draw; they never set words.
 */
export const ARC: Record<StageState, string> = {
  success: 'var(--color-ok)',
  failed: 'var(--color-fail)',
  running: 'var(--color-run)',
  queued: '#93c5fd',
  pending: 'var(--color-idle)',
  cancelled: 'var(--color-faint)',
  skipped: 'var(--color-line)',
};

export const STATE_WORD: Record<StageState, string> = {
  success: 'passed',
  failed: 'failed',
  running: 'running',
  queued: 'queued',
  pending: 'waiting',
  cancelled: 'cancelled',
  skipped: 'not in this run',
};

export const RUN_WORD: Record<RunState, string> = {
  success: 'Passed',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  waiting: 'Waiting for approval',
};

/** Words in a status colour use the darker ink tones (4.5:1 on white). */
export const RUN_INK: Record<RunState, string> = {
  success: 'text-ok-ink',
  failed: 'text-fail-ink',
  running: 'text-run-ink',
  queued: 'text-muted',
  cancelled: 'text-muted',
  skipped: 'text-muted',
  waiting: 'text-body',
};

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const rad = (d: number) => ((d - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startDeg));
  const y1 = cy + r * Math.sin(rad(startDeg));
  const x2 = cx + r * Math.cos(rad(endDeg));
  const y2 = cy + r * Math.sin(rad(endDeg));
  return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
}

export function ringLabel(run: RunSummary): string {
  const parts = run.stages.map((s) => `${STAGE_LABELS[s.key]} ${STATE_WORD[s.state]}`);
  return `Run ${run.number}, ${RUN_WORD[run.state].toLowerCase()}: ${parts.join(', ')}`;
}

/** True when this run put a build on a Google Play track. */
export function shipped(run: Pick<RunSummary, 'mode' | 'stages' | 'rehearsal'>): boolean {
  return run.mode === 'release' && !run.rehearsal && run.stages.find((s) => s.key === 'play')?.state === 'success';
}

/** The ring's arcs are 60° slots with this much air between them; the strip copies the gap. */
export const RING_GAP_DEG = 12;

/**
 * The rail node: six arcs, one per stage, clockwise from the top, each in its stage's state.
 * The core fills Signal Orange once the run has shipped to Google Play. The only thing on the
 * page that moves is the running arc: one highlight travelling its length.
 */
export function StageRing({
  stages,
  size = 28,
  shippedCore = false,
  label,
  className,
}: {
  stages: Array<{ key: StageKey; state: StageState }>;
  size?: number;
  shippedCore?: boolean;
  label?: string;
  className?: string;
}) {
  const stroke = size >= 40 ? 4 : 3;
  const r = (size - stroke) / 2 - 0.5;
  const c = size / 2;
  const byKey = new Map(stages.map((s) => [s.key, s.state]));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx('shrink-0', className)}
    >
      {STAGE_ORDER.map((key, i) => {
        const state = byKey.get(key) ?? 'pending';
        const d = arcPath(c, c, r, i * 60 + RING_GAP_DEG / 2, (i + 1) * 60 - RING_GAP_DEG / 2);
        return (
          <g key={key}>
            <path
              d={d}
              fill="none"
              stroke={state === 'running' ? ARC.queued : ARC[state]}
              strokeWidth={stroke}
              strokeLinecap="round"
              style={{ transition: 'stroke 200ms cubic-bezier(0.16, 1, 0.3, 1)' }}
            />
            {state === 'running' && (
              <path d={d} fill="none" stroke={ARC.running} strokeWidth={stroke} strokeLinecap="round" pathLength={100} className="arc-sweep" />
            )}
          </g>
        );
      })}
      <circle
        cx={c}
        cy={c}
        r={shippedCore ? size * 0.2 : size * 0.13}
        fill={shippedCore ? 'var(--color-ship)' : 'var(--color-ink)'}
        style={{ transition: 'r 200ms cubic-bezier(0.16, 1, 0.3, 1), fill 200ms' }}
      />
    </svg>
  );
}

/** Static state marks: nothing here moves; the running arc on the ring does that job. */
export function StateGlyph({ state, size = 16, className }: { state: StageState; size?: number; className?: string }) {
  const common = { size, strokeWidth: 2.2, 'aria-hidden': true as const, className: clsx('shrink-0', className) };
  switch (state) {
    case 'success':
      return <CircleCheck {...common} color="var(--color-ok)" />;
    case 'failed':
      return <CircleX {...common} color="var(--color-fail)" />;
    case 'running':
      return <CircleDot {...common} color="var(--color-run)" />;
    case 'queued':
      return <CircleDashed {...common} color="var(--color-run)" />;
    case 'cancelled':
      return <Ban {...common} color="var(--color-faint)" />;
    case 'skipped':
      return <CircleMinus {...common} color="var(--color-idle)" />;
    default:
      return <Circle {...common} color="var(--color-idle)" />;
  }
}

/** Run state as a stage state, for glyphs. */
export function runAsStage(state: RunState): StageState {
  switch (state) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return 'queued';
  }
}
