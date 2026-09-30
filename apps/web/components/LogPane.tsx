'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight, Download, ExternalLink, Search } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { duration, since } from '@/lib/format';
import { LogLine, parseLog, splitByStep } from '@/lib/log';
import type { JobView, LogResponse, StageView, StepView } from '@/lib/types';
import { StateGlyph } from './stage';

/**
 * Finished job logs never change: keep them for the life of the page, keyed by run and job
 * (jobs of runs on this server are numbered from 1 in every run).
 */
const LOGS = new Map<string, string>();

/** How often a job running on this server has its log read again. */
const LIVE_MS = 2500;

const CHUNK = 250;

function Lines({ lines, query }: { lines: LogLine[]; query: string }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const q = query.trim().toLowerCase();
  const visible = useMemo<Array<LogLine & { fold?: number }>>(() => {
    if (q) return lines.filter((l) => l.kind !== 'endgroup' && l.text.toLowerCase().includes(q));
    // A `##[group]` line folds everything up to its `##[endgroup]` (the command echo, the
    // environment), as GitHub's own viewer does.
    const out: Array<LogLine & { fold?: number }> = [];
    let folding: number | null = null;
    for (const l of lines) {
      if (l.kind === 'group') {
        folding = l.n;
        out.push({ ...l, fold: l.n });
        continue;
      }
      if (l.kind === 'endgroup') {
        folding = null;
        continue;
      }
      if (folding !== null && !open.has(folding)) continue;
      out.push(l);
    }
    return out;
  }, [lines, q, open]);

  if (!visible.length) {
    return <p className="px-4 py-3 font-mono text-[12px] text-log-muted">{q ? 'No line matches.' : 'This step printed nothing.'}</p>;
  }
  const chunks: Array<typeof visible> = [];
  for (let i = 0; i < visible.length; i += CHUNK) chunks.push(visible.slice(i, i + CHUNK));

  return (
    <div className="py-1 font-mono text-[12.5px] leading-[1.6]">
      {chunks.map((chunk, ci) => (
        <div key={ci} className="log-chunk">
          {chunk.map((l) => {
            const fold = l.fold;
            return (
              <div
                key={l.n}
                className={clsx(
                  'grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 px-2 hover:bg-log-raised',
                  l.kind === 'error' && 'bg-[#2a1317] text-log-error',
                  l.kind === 'warning' && 'bg-[#2a2210] text-log-warn',
                  l.kind === 'command' && 'text-log-group',
                  l.kind === 'debug' && 'text-log-muted',
                  l.kind === 'plain' && 'text-log-text',
                  l.kind === 'notice' && 'text-log-group',
                  l.kind === 'group' && 'text-log-group',
                )}
              >
                <span className="select-none text-end text-log-muted tabular">{l.n}</span>
                {fold !== undefined ? (
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 text-start"
                    aria-expanded={open.has(fold)}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (next.has(fold)) next.delete(fold);
                        else next.add(fold);
                        return next;
                      })
                    }
                  >
                    <ChevronRight size={12} aria-hidden className={clsx('shrink-0 transition-transform', open.has(fold) && 'rotate-90')} />
                    <span className="whitespace-pre-wrap break-words">{l.text}</span>
                  </button>
                ) : (
                  <span className="whitespace-pre-wrap break-words">{l.kind === 'error' ? `Error: ${l.text}` : l.kind === 'warning' ? `Warning: ${l.text}` : l.text || ' '}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function LogPane({
  runId,
  stage,
  jobs,
  now,
  focusStep,
}: {
  runId: number;
  stage: StageView;
  jobs: JobView[];
  now: number;
  /** Step number to open first (the failing one), when the parent knows it. */
  focusStep: number | null;
}) {
  const stageJobs = jobs.filter((j) => stage.jobIds.includes(j.id));
  const preferred =
    stageJobs.find((j) => stage.steps.some((s) => s.jobId === j.id && s.state === 'failed')) ??
    stageJobs.find((j) => j.state === 'running') ??
    stageJobs[stageJobs.length - 1];
  const [jobId, setJobId] = useState<number | null>(preferred?.id ?? null);
  const job = stageJobs.find((j) => j.id === jobId) ?? preferred ?? null;
  // Runs of uploaded ZIPs run on this server, whose logs can be read while the job runs.
  const local = runId < 0;
  const logKey = job ? `${runId}:${job.id}` : null;
  const [text, setText] = useState<string | null>(logKey ? (LOGS.get(logKey) ?? null) : null);
  const shownKey = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [note, setNote] = useState<{ reason: string; liveUrl?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    setJobId(preferred?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.key, runId]);

  const finished = Boolean(job?.completedAt) && job?.state !== 'running' && job?.state !== 'queued';

  const started = Boolean(job?.startedAt);
  const jobUrl = job?.url ?? '';

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setNote(null);
    if (!job || !logKey) return;
    const cached = LOGS.get(logKey);
    if (cached !== undefined) {
      shownKey.current = logKey;
      setText(cached);
      return;
    }
    // Keep what is on screen while the same job's log is read again (live, or once it ends).
    if (shownKey.current !== logKey) setText(null);
    shownKey.current = logKey;
    if (!finished && !local) {
      setNote({ reason: 'GitHub publishes the full log when this job finishes. The steps update live.', liveUrl: jobUrl || undefined });
      return;
    }
    if (!finished && !started) return;
    const load = () =>
      api<LogResponse>(`/runs/${runId}/jobs/${job.id}/log`)
        .then((res) => {
          if (cancelled) return;
          if (res.available) {
            if (finished) LOGS.set(logKey, res.text);
            setText(res.text);
          } else {
            setNote({ reason: res.reason, liveUrl: res.liveUrl });
          }
        })
        .catch((e: unknown) => !cancelled && setNote({ reason: e instanceof ApiError ? e.message : 'The log could not be loaded.' }))
        .finally(() => {
          if (!cancelled && !finished) timer = window.setTimeout(load, LIVE_MS);
        });
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logKey, finished, started, local, jobUrl]);

  // Following a live log: stay at the bottom while the reader is there.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && local && !finished && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text, local, finished]);

  const lines = useMemo(() => (text ? parseLog(text) : []), [text]);
  const byStep = useMemo(
    () => (job && lines.length ? splitByStep(lines, job.steps) : new Map<number, LogLine[]>()),
    [lines, job],
  );
  const steps = stage.steps.filter((s) => s.jobId === job?.id);

  const initial = useMemo(() => {
    const failed = steps.find((s) => s.state === 'failed');
    if (focusStep && steps.some((s) => s.number === focusStep)) return focusStep;
    return (failed ?? steps.find((s) => s.state === 'running') ?? steps[steps.length - 1])?.number ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, stage.key, focusStep]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(initial ? [initial] : []));
  useEffect(() => {
    setExpanded(new Set(initial ? [initial] : []));
  }, [initial]);

  function download() {
    if (!text || !job) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${local ? `zip-run-${-runId}` : `run-${runId}`}-${job.name.replace(/\W+/g, '-').toLowerCase()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!job) {
    return (
      <div className="rounded-[var(--radius-card)] bg-log px-5 py-6 text-[13px] text-log-muted">
        {stage.state === 'skipped'
          ? `${stage.label} is not part of this run.`
          : stage.state === 'cancelled'
            ? `${stage.label} did not run: the run was cancelled first.`
            : `${stage.label} has not started; its steps appear here when ${local ? 'this server' : 'GitHub'} starts the job.`}
      </div>
    );
  }

  return (
    <section aria-label={`${stage.label} log`} className="overflow-hidden rounded-[var(--radius-card)] bg-log text-log-text shadow-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-log-line bg-log-raised px-3 py-2">
        {stageJobs.length > 1 ? (
          <div className="flex gap-1" role="tablist" aria-label="Jobs in this stage">
            {stageJobs.map((j) => (
              <button
                key={j.id}
                type="button"
                role="tab"
                aria-selected={j.id === job.id}
                onClick={() => setJobId(j.id)}
                className={clsx(
                  'flex h-9 items-center gap-2 rounded-md px-3 text-[13px] font-medium transition-colors',
                  j.id === job.id ? 'bg-log text-white' : 'text-log-muted hover:text-white',
                )}
              >
                <StateGlyph state={j.state} size={14} />
                {j.name}
              </button>
            ))}
          </div>
        ) : (
          <span className="flex h-9 items-center gap-2 px-1 text-[13px] font-semibold text-white">
            <StateGlyph state={job.state} size={14} />
            {job.name}
          </span>
        )}
        <div className="ms-auto flex items-center gap-1">
          {text && (
            <>
              <label className="relative flex items-center">
                <span className="sr-only">Filter log lines</span>
                <Search size={14} aria-hidden className="pointer-events-none absolute start-2.5 text-log-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter lines"
                  className="h-9 w-40 rounded-md border border-log-line bg-log ps-8 pe-2 text-log-text placeholder:text-log-muted focus:border-run focus:outline-none md:w-52 md:text-[13px]!"
                />
              </label>
              <button
                type="button"
                onClick={() => setRaw((r) => !r)}
                aria-pressed={raw}
                className={clsx('h-9 rounded-md px-3 text-[13px] font-medium transition-colors', raw ? 'bg-log text-white' : 'text-log-muted hover:text-white')}
              >
                Whole job
              </button>
              <button type="button" onClick={download} className="flex h-9 w-9 items-center justify-center rounded-md text-log-muted hover:text-white" aria-label="Download this job's log" title="Download log">
                <Download size={15} aria-hidden />
              </button>
            </>
          )}
          {job.url && (
            <a href={job.url} target="_blank" rel="noreferrer" className="flex h-9 items-center gap-1.5 rounded-md px-2 text-[13px] text-log-muted hover:text-white">
              GitHub
              <ExternalLink size={13} aria-hidden />
            </a>
          )}
        </div>
      </div>

      {note && (
        <p className="border-b border-log-line px-4 py-3 text-[13px] text-log-muted">
          {note.reason}{' '}
          {note.liveUrl && (
            <a href={note.liveUrl} target="_blank" rel="noreferrer" className="font-medium text-log-group underline">
              Watch it live on GitHub
            </a>
          )}
        </p>
      )}

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="log-scroll max-h-[min(70svh,720px)] overflow-y-auto"
      >
        {raw && text ? (
          <Lines lines={lines} query={query} />
        ) : (
          <ul>
            {steps.map((s: StepView) => {
              const isOpen = expanded.has(s.number) || Boolean(query.trim());
              const stepLines = byStep.get(s.number) ?? [];
              const live = s.state === 'running' ? since(s.startedAt, now) : s.durationMs;
              return (
                <li key={`${s.jobId}-${s.number}`} className="border-b border-log-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(s.number)) next.delete(s.number);
                        else next.add(s.number);
                        return next;
                      })
                    }
                    aria-expanded={isOpen}
                    className="flex min-h-11 w-full items-center gap-3 px-3 text-start hover:bg-log-raised"
                  >
                    <ChevronRight size={14} aria-hidden className={clsx('shrink-0 text-log-muted transition-transform', isOpen && 'rotate-90')} />
                    <StateGlyph state={s.state} size={15} />
                    <span className={clsx('min-w-0 flex-1 truncate text-[13px]', s.state === 'failed' ? 'font-semibold text-log-error' : 'text-log-text')}>{s.name}</span>
                    <span className="shrink-0 font-mono text-[12px] text-log-muted tabular">{duration(live)}</span>
                  </button>
                  {isOpen && text && <Lines lines={stepLines} query={query} />}
                  {isOpen && !text && !note && (finished || started) && <p className="px-4 pb-3 font-mono text-[12px] text-log-muted">Loading log…</p>}
                </li>
              );
            })}
            {steps.length === 0 && (
              <li className="px-4 py-4 text-[13px] text-log-muted">
                {local ? 'This job has not reported its steps yet.' : 'GitHub has not reported this job\'s steps yet.'}
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
