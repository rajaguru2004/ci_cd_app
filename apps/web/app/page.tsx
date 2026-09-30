'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { ArrowLeft, GitCommitHorizontal, KeyRound, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { ago, short } from '@/lib/format';
import type { Mode, PlayResponse, RunSummary, StreamCommit, StreamResponse } from '@/lib/types';
import { useNow, usePoll } from '@/lib/usePoll';
import { CommitRail } from '@/components/CommitRail';
import { PlayTracks } from '@/components/PlayTracks';
import { RunPanel } from '@/components/RunPanel';
import { StartSheet, StartedRun } from '@/components/StartSheet';
import { TopBar } from '@/components/TopBar';

export default function Page() {
  return (
    <Suspense fallback={<div className="h-svh bg-page" />}>
      <Console />
    </Suspense>
  );
}

function Console() {
  const router = useRouter();
  const params = useSearchParams();
  const branchParam = params.get('branch');
  const commitParam = params.get('commit');
  const runParam = params.get('run');

  const [startOpen, setStartOpen] = useState(false);
  const [startMode, setStartMode] = useState<Mode>('build');
  const [detailOnPhone, setDetailOnPhone] = useState(Boolean(runParam || commitParam));
  const [branches, setBranches] = useState<string[]>([]);
  const [busyStream, setBusyStream] = useState(false);
  const [pendingStart, setPendingStart] = useState<StartedRun | null>(null);

  const loadStream = useCallback(
    () => api<StreamResponse>(`/stream${branchParam ? `?branch=${encodeURIComponent(branchParam)}` : ''}`),
    [branchParam],
  );
  const [anyActive, setAnyActive] = useState(false);
  const stream = usePoll(loadStream, anyActive || pendingStart ? 5000 : 15000, [branchParam]);
  const play = usePoll<PlayResponse>(() => api<PlayResponse>('/play'), 120_000, []);
  const now = useNow(true, anyActive ? 1000 : 30_000);

  useEffect(() => {
    api<{ defaultBranch: string; branches: string[] }>('/branches')
      .then((b) => setBranches(b.branches))
      .catch(() => setBranches([]));
  }, []);

  const data = stream.data;
  useEffect(() => {
    if (!data) return;
    const runs = [...data.commits.flatMap((c) => c.runs), ...data.otherRuns];
    setAnyActive(runs.some((r) => r.state === 'running' || r.state === 'queued' || r.state === 'waiting'));
    if (pendingStart?.runId && runs.some((r) => r.id === pendingStart.runId)) setPendingStart(null);
  }, [data, pendingStart]);

  const commits = useMemo(() => data?.commits ?? [], [data]);
  const allRuns = useMemo(() => [...commits.flatMap((c) => c.runs), ...(data?.otherRuns ?? [])], [commits, data]);
  const runFromParam = runParam ? Number(runParam) : null;

  const selectedCommit: StreamCommit | null =
    commits.find((c) => c.sha === commitParam) ??
    (runFromParam ? commits.find((c) => c.runs.some((r) => r.id === runFromParam)) : undefined) ??
    (commitParam || runFromParam ? undefined : (commits.find((c) => c.runs.length) ?? commits[0])) ??
    null;
  const selectedRunId = runFromParam ?? selectedCommit?.runs[0]?.id ?? null;
  const selectedRun = allRuns.find((r) => r.id === selectedRunId) ?? null;
  const siblings = selectedCommit?.runs ?? (selectedRun ? [selectedRun] : []);

  function setQuery(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    router.replace(qs ? `/?${qs}` : '/', { scroll: false });
  }

  function selectCommit(c: StreamCommit) {
    setQuery({ commit: c.sha, run: c.runs[0] ? String(c.runs[0].id) : null });
    setDetailOnPhone(true);
  }
  function selectRun(r: RunSummary) {
    setQuery({ run: String(r.id), commit: r.sha });
    setDetailOnPhone(true);
  }
  function openStart(mode: Mode = 'build') {
    setStartMode(mode);
    setStartOpen(true);
  }
  async function refreshStream() {
    setBusyStream(true);
    await stream.refresh();
    setBusyStream(false);
  }
  function started(run: StartedRun) {
    setPendingStart(run);
    if (run.runId) setQuery({ run: String(run.runId), commit: null, branch: run.branch === data?.repo.defaultBranch ? null : run.branch });
    setDetailOnPhone(true);
    window.setTimeout(() => void stream.refresh(), 2500);
  }

  const noToken = stream.error?.status === 503;

  return (
    <div className="flex h-svh flex-col">
      <TopBar onStart={() => openStart('build')} setupAttention={Boolean(noToken || (data && !data.workflow.present))} />

      <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        <aside
          aria-label="Commits"
          className={clsx('min-h-0 flex-col border-e border-line bg-card', detailOnPhone ? 'hidden lg:flex' : 'flex')}
        >
          <section aria-labelledby="play-now" className="border-b border-line px-4 pb-3 pt-3.5">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 id="play-now" className="text-[13px] font-semibold text-ink">
                On Google Play
              </h2>
              {play.data?.configured && (
                <span className="truncate text-[11px] text-muted">checked {ago(play.data.checkedAt, now)}</span>
              )}
            </div>
            {play.data?.configured ? (
              <PlayTracks tracks={play.data.tracks} compact />
            ) : play.data && !play.data.configured ? (
              <p className="text-[12px] text-muted">{play.data.reason}</p>
            ) : play.error ? (
              <p className="text-[12px] text-fail-ink">{play.error.message}</p>
            ) : (
              <div className="h-[52px] animate-pulse rounded-[var(--radius-card)] bg-line-soft" />
            )}
          </section>
          <CommitRail
            stream={data}
            error={noToken ? null : (stream.error?.message ?? null)}
            loading={stream.loading || busyStream}
            empty={
              noToken ? (
                <div className="px-6 py-8">
                  <p className="font-semibold text-ink">No commits to show yet</p>
                  <p className="mt-1 text-[13px] text-muted">
                    The commit stream and every run come from GitHub, and the console has no GitHub token yet.
                  </p>
                  <Link href="/setup" className="mt-3 inline-block text-[13px] font-semibold text-brand underline">
                    Connect GitHub in Setup
                  </Link>
                </div>
              ) : undefined
            }
            branches={branches}
            selectedSha={selectedCommit?.sha ?? null}
            selectedRunId={selectedRunId}
            onBranch={(b) => setQuery({ branch: b === data?.repo.defaultBranch ? null : b, commit: null, run: null })}
            onSelectCommit={selectCommit}
            onSelectRun={selectRun}
            onRefresh={refreshStream}
            now={now}
          />
        </aside>

        <main className={clsx('min-h-0 overflow-y-auto', detailOnPhone ? 'block' : 'hidden lg:block')}>
          <div className="mx-auto max-w-[1440px] p-4 pb-16 md:p-6">
            <button
              type="button"
              className="btn btn-quiet -ms-2 mb-3 lg:hidden"
              onClick={() => setDetailOnPhone(false)}
            >
              <ArrowLeft size={16} aria-hidden />
              Commits
            </button>

            {pendingStart && !pendingStart.runId && (
              <p className="mb-4 rounded-[var(--radius-card)] bg-run-wash px-4 py-3 text-[13px] text-run-ink">
                GitHub accepted the run on {pendingStart.branch}; it appears here as soon as GitHub lists it.
              </p>
            )}

            {noToken ? (
              <ConnectGithub message={stream.error?.message ?? ''} playConnected={Boolean(play.data?.configured)} />
            ) : selectedRunId ? (
              <RunPanel
                key={selectedRunId}
                runId={selectedRunId}
                siblings={siblings}
                onSelectRun={(id) => setQuery({ run: String(id) })}
                now={now}
                onChanged={() => void stream.refresh()}
              />
            ) : selectedCommit ? (
              <NoRun
                commit={selectedCommit}
                isTip={selectedCommit.sha === commits[0]?.sha}
                branch={data?.branch ?? 'main'}
                workflowPresent={Boolean(data?.workflow.present)}
                onStart={() => openStart('build')}
                now={now}
              />
            ) : stream.loading ? (
              <div className="panel h-64 animate-pulse" aria-hidden />
            ) : (
              <div className="panel px-6 py-10 text-center text-muted">Pick a commit on the left.</div>
            )}
          </div>
        </main>
      </div>

      <StartSheet
        open={startOpen}
        onClose={() => setStartOpen(false)}
        defaultBranch={data?.branch ?? branchParam ?? 'main'}
        initialMode={startMode}
        onStarted={started}
        blocked={noToken ? (stream.error?.message ?? 'The console has no GitHub token.') : null}
      />
    </div>
  );
}

function NoRun({
  commit,
  isTip,
  branch,
  workflowPresent,
  onStart,
  now,
}: {
  commit: StreamCommit;
  isTip: boolean;
  branch: string;
  workflowPresent: boolean;
  onStart: () => void;
  now: number;
}) {
  return (
    <article className="panel px-5 py-6 md:px-6" aria-labelledby="commit-title">
      <h1 id="commit-title" className="text-[20px] font-bold leading-snug text-ink [text-wrap:balance]">
        {commit.subject}
      </h1>
      <p className="mt-1.5 flex flex-wrap gap-x-2 text-[13px] text-muted">
        <span className="font-mono">{short(commit.sha)}</span>
        <span aria-hidden>·</span>
        <span>{commit.author.login ?? commit.author.name}</span>
        <span aria-hidden>·</span>
        <time dateTime={commit.date}>{ago(commit.date, now)}</time>
      </p>
      {commit.body && <p className="mt-4 max-w-[70ch] whitespace-pre-wrap text-body">{commit.body}</p>}

      <div className="mt-6 flex flex-col gap-4 rounded-[var(--radius-card)] bg-page px-5 py-5 md:flex-row md:items-center">
        <GitCommitHorizontal size={22} aria-hidden className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">No pipeline run for this commit.</p>
          <p className="mt-1 max-w-[68ch] text-[13px] text-muted">
            {workflowPresent
              ? isTip
                ? `Runs start from the tip of ${branch} (Start build), from a release: commit on main, or from a v-tag. This commit is the tip, so a build from here tests exactly this code.`
                : 'GitHub starts runs from a branch tip, a release: commit or a v-tag, so an older commit without a run cannot be built on its own. Tag it (v1.2.3) to release it.'
              : 'The pipeline is not on main yet. Once it is, every release: commit and v-tag runs it, and Start build runs it on any branch.'}
          </p>
        </div>
        {workflowPresent && isTip && (
          <button type="button" className="btn btn-primary" onClick={onStart}>
            <Play size={15} aria-hidden fill="currentColor" />
            Start build on {branch}
          </button>
        )}
      </div>
    </article>
  );
}

function ConnectGithub({ message, playConnected }: { message: string; playConnected: boolean }) {
  return (
    <article className="panel max-w-3xl px-6 py-7" aria-labelledby="connect-title">
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-wash text-brand">
          <KeyRound size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 id="connect-title" className="text-[20px] font-bold text-ink">
            Connect GitHub to see the pipeline
          </h1>
          <p className="mt-2 max-w-[68ch] text-body">{message}</p>
          <p className="mt-3 max-w-[68ch] text-[13px] text-muted">
            {playConnected ? 'Google Play is already connected (left). ' : ''}Everything about builds, tests, logs and the AAB comes
            from GitHub Actions, so the console needs a token that can read and start runs on the mobile repository.
          </p>
          <Link href="/setup" className="btn btn-primary mt-5">
            Open Setup
          </Link>
        </div>
      </div>
    </article>
  );
}
