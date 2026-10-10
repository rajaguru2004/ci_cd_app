'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { ArrowLeft, ExternalLink, GitCommitHorizontal, Hammer, Rocket, Settings2, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { ago, repoLine, short } from '@/lib/format';
import type { AppView, KeyRecord, Mode, PlayResponse, RunSummary, StreamCommit, StreamResponse } from '@/lib/types';
import { useNow, usePoll } from '@/lib/usePoll';
import { CommitRail } from '@/components/CommitRail';
import { CopyButton } from '@/components/KeyBlock';
import { PlayTracks } from '@/components/PlayTracks';
import { ReleaseSheet, type PickedCommit } from '@/components/ReleaseSheet';
import { RunPanel } from '@/components/RunPanel';
import { RunsRail } from '@/components/RunsRail';
import { TopBar } from '@/components/TopBar';

export default function AppPage() {
  return (
    <Suspense fallback={<div className="h-svh bg-page" />}>
      <AppConsole />
    </Suspense>
  );
}

const live = (r: RunSummary) => r.state === 'running' || r.state === 'queued' || r.state === 'waiting';

function AppConsole() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const branchParam = params.get('branch');
  const commitParam = params.get('commit');
  const runParam = params.get('run');

  const [sheet, setSheet] = useState<{ mode: Mode; commit: PickedCommit | null } | null>(null);
  const [detailOnPhone, setDetailOnPhone] = useState(Boolean(runParam || commitParam));
  const [busyStream, setBusyStream] = useState(false);
  const [anyActive, setAnyActive] = useState(false);

  const stream = usePoll<StreamResponse>(
    () => api<StreamResponse>(`/apps/${id}/stream${branchParam ? `?branch=${encodeURIComponent(branchParam)}` : ''}`),
    anyActive ? 4000 : 15000,
    [id, branchParam],
  );
  const play = usePoll<PlayResponse>(() => api<PlayResponse>(`/apps/${id}/play`), 120_000, [id]);
  const now = useNow(true, anyActive ? 1000 : 30_000);
  const data = stream.data;
  const app = data?.app ?? null;

  useEffect(() => {
    if (!data) return;
    const runs = [...data.commits.flatMap((c) => c.runs), ...data.otherRuns];
    setAnyActive(runs.some(live) || data.fetching);
  }, [data]);

  const commits = useMemo(() => data?.commits ?? [], [data]);
  const allRuns = useMemo(() => [...commits.flatMap((c) => c.runs), ...(data?.otherRuns ?? [])], [commits, data]);
  const runFromParam = runParam ? Number(runParam) : null;
  const listMode = Boolean(data && (!data.connected || (!commits.length && !data.fetching)));
  const playRefused = play.error && /refused|has no app/i.test(play.error.message) ? play.error.message : null;
  const githubIssue = app?.runner.kind === 'github' ? (app.runner.github?.check?.message ?? null) : null;
  const blocked = Boolean(app && (data?.error || playRefused || githubIssue));

  const selectedCommit: StreamCommit | null =
    commits.find((c) => c.sha === commitParam) ??
    (runFromParam ? commits.find((c) => c.runs.some((r) => r.id === runFromParam)) : undefined) ??
    (commitParam || runFromParam || listMode ? undefined : (commits.find((c) => c.runs.length) ?? commits[0])) ??
    null;
  const selectedRunId = runFromParam ?? selectedCommit?.runs[0]?.id ?? (listMode ? (allRuns[0]?.id ?? null) : null);
  const selectedRun = allRuns.find((r) => r.id === selectedRunId) ?? null;
  const siblings = selectedCommit?.runs ?? (selectedRun ? [selectedRun] : []);

  function setQuery(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    router.replace(qs ? `/apps/${id}?${qs}` : `/apps/${id}`, { scroll: false });
  }

  function selectCommit(c: StreamCommit) {
    setQuery({ commit: c.sha, run: c.runs[0] ? String(c.runs[0].id) : null });
    setDetailOnPhone(true);
  }
  function selectRun(r: RunSummary) {
    setQuery({ run: String(r.id), commit: r.source.sha ?? null });
    setDetailOnPhone(true);
  }
  async function refresh() {
    setBusyStream(true);
    try {
      stream.setData(await api<StreamResponse>(`/apps/${id}/stream?refresh=1${branchParam ? `&branch=${encodeURIComponent(branchParam)}` : ''}`));
    } catch {
      await stream.refresh();
    } finally {
      setBusyStream(false);
    }
  }

  if (stream.error && !data) {
    return (
      <div className="min-h-svh">
        <TopBar />
        <main className="mx-auto max-w-3xl px-4 pt-8 md:px-6">
          <Link href="/" className="btn btn-quiet -ms-2.5 mb-3">
            <ArrowLeft size={16} aria-hidden />
            Apps
          </Link>
          <p role="alert" className="rounded-[var(--radius-card)] bg-fail-wash px-4 py-3 text-fail-ink">
            {stream.error.message}
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-svh flex-col">
      <TopBar app={app ? { id: app.id, name: app.name } : { id, name: '…' }} />

      {/* The app: what it is, where it comes from, and its two actions. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2.5 border-b border-line bg-card px-4 py-3 md:flex-nowrap md:px-6">
        <div className="min-w-0 basis-full md:flex-1 md:basis-auto">
          <h1 className="sr-only">{app?.name ?? 'App'}</h1>
          <p className="flex min-w-0 items-center gap-x-2 text-[13px] text-muted">
            <span className="min-w-0 truncate font-mono text-body">{app?.packageName ?? ''}</span>
            {app?.repo ? (
              <>
                <span aria-hidden>·</span>
                {app.repo.webUrl ? (
                  <a href={app.repo.webUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate hover:text-brand hover:underline">
                    {repoLine(app.repo)}
                    <ExternalLink size={12} aria-hidden className="shrink-0" />
                  </a>
                ) : (
                  <span className="truncate font-mono">{app.repo.url}</span>
                )}
              </>
            ) : app ? (
              <>
                <span aria-hidden>·</span>
                <span>builds from uploaded ZIPs</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 md:w-auto">
          <Link href={`/apps/${id}/settings`} className="btn btn-quiet h-10 w-10 shrink-0 p-0 sm:w-auto sm:px-2.5" aria-label="Settings">
            <Settings2 size={16} aria-hidden />
            <span className="hidden sm:inline">Settings</span>
          </Link>
          <button type="button" className="btn btn-secondary flex-1 md:flex-none" disabled={!app} onClick={() => setSheet({ mode: 'build', commit: null })}>
            <Hammer size={15} aria-hidden />
            Build
          </button>
          <button type="button" className="btn btn-primary flex-1 md:flex-none" disabled={!app} onClick={() => setSheet({ mode: 'release', commit: null })}>
            <Rocket size={15} aria-hidden />
            Release
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        <aside aria-label="Commits and runs" className={clsx('min-h-0 flex-col border-e border-line bg-card', detailOnPhone ? 'hidden lg:flex' : 'flex')}>
          {blocked && app && (
            <div className="border-b border-line bg-page p-4 lg:hidden">
              <Blockers app={app} repoError={data?.error ?? null} playError={playRefused} githubError={githubIssue} />
            </div>
          )}
          <section aria-labelledby="play-now" className="border-b border-line px-4 pb-3 pt-3.5">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 id="play-now" className="text-[13px] font-semibold text-ink">
                On Google Play
              </h2>
              {play.data?.configured && <span className="truncate text-[11px] text-muted">checked {ago(play.data.checkedAt, now)}</span>}
            </div>
            {play.data?.configured ? (
              <PlayTracks tracks={play.data.tracks} compact />
            ) : play.data && !play.data.configured ? (
              <p className="text-[12px] text-muted">
                {play.data.reason}{' '}
                <Link href={`/apps/${id}/settings`} className="font-medium text-brand underline">
                  Settings
                </Link>
              </p>
            ) : play.error ? (
              <Pointer>{playRefused ? <>Google Play refuses the key<span className="hidden lg:inline">: see why on the right</span>.</> : 'Google Play did not answer just now.'}</Pointer>
            ) : (
              <div className="h-[52px] animate-pulse rounded-[var(--radius-card)] bg-line-soft" />
            )}
          </section>
          {listMode ? (
            <RunsRail
              runs={data ? allRuns : null}
              loading={stream.loading}
              selectedRunId={selectedRunId}
              onSelectRun={selectRun}
              now={now}
              note={
                data?.connected ? (
                  data.error ? (
                    <Pointer>
                      The repository refuses the key<span className="hidden lg:inline">: see why on the right</span>.
                    </Pointer>
                  ) : (
                    'No commits on this branch yet.'
                  )
                ) : (
                  <>
                    No repository connected: every run builds an uploaded ZIP.{' '}
                    <Link href={`/apps/${id}/settings`} className="font-medium text-brand underline">
                      Connect one
                    </Link>
                  </>
                )
              }
            />
          ) : (
            <CommitRail
              stream={data}
              error={null}
              loading={stream.loading || busyStream}
              selectedSha={selectedCommit?.sha ?? null}
              selectedRunId={selectedRunId}
              onBranch={(b) => setQuery({ branch: b === app?.repo?.branch ? null : b, commit: null, run: null })}
              onSelectCommit={selectCommit}
              onSelectRun={selectRun}
              onRefresh={refresh}
              now={now}
            />
          )}
        </aside>

        <main className={clsx('min-h-0 overflow-y-auto', detailOnPhone ? 'block' : 'hidden lg:block')}>
          <div className="mx-auto max-w-[1440px] p-4 pb-16 md:p-6">
            <button type="button" className="btn btn-quiet -ms-2 mb-3 lg:hidden" onClick={() => setDetailOnPhone(false)}>
              <ArrowLeft size={16} aria-hidden />
              {listMode ? 'Runs' : 'Commits'}
            </button>

            {blocked && app && (
              <div className="hidden lg:block">
                <Blockers app={app} repoError={data?.error ?? null} playError={playRefused} githubError={githubIssue} />
              </div>
            )}

            {selectedRunId ? (
              <RunPanel
                key={selectedRunId}
                runId={selectedRunId}
                siblings={siblings}
                onSelectRun={(rid) => setQuery({ run: String(rid) })}
                now={now}
                onChanged={() => void stream.refresh()}
              />
            ) : selectedCommit ? (
              <NoRun
                commit={selectedCommit}
                isTip={selectedCommit.sha === commits[0]?.sha}
                branch={data?.branch ?? 'main'}
                onRun={(mode) => setSheet({ mode, commit: { sha: selectedCommit.sha, subject: selectedCommit.subject } })}
                now={now}
              />
            ) : stream.loading ? (
              <div className="panel h-64 animate-pulse" aria-hidden />
            ) : listMode && (data?.error || play.error) ? null : (
              <div className="panel px-6 py-10 text-center text-muted">{listMode ? 'No runs yet: Build or Release starts the first one.' : 'Pick a commit on the left.'}</div>
            )}
          </div>
        </main>
      </div>

      <ReleaseSheet
        open={Boolean(sheet)}
        onClose={() => setSheet(null)}
        app={app}
        initialMode={sheet?.mode ?? 'release'}
        commit={sheet?.commit ?? null}
        branch={data?.branch ?? null}
        onStarted={(run) => {
          setQuery({ run: String(run.runId), commit: null });
          setDetailOnPhone(true);
          window.setTimeout(() => void stream.refresh(), 800);
        }}
      />
    </div>
  );
}

/** One amber line in the rail that points at the blockers panel. */
function Pointer({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-[12px] text-ink">
      <TriangleAlert size={14} aria-hidden className="mt-px shrink-0" color="var(--color-warn)" />
      <span className="line-clamp-2">{children}</span>
    </p>
  );
}

/**
 * What stands between this app and a release, said first and once: the repository refusing
 * its key, Google Play refusing its key. Each with the way out.
 */
function Blockers({ app, repoError, playError, githubError }: { app: AppView; repoError: string | null; playError: string | null; githubError: string | null }) {
  const keys = usePoll<KeyRecord[]>(() => api<KeyRecord[]>('/keys'), null, []);
  const key = keys.data?.find((k) => k.id === app.repo?.keyId) ?? null;
  return (
    <section aria-label={`Before ${app.name} can release`} className="panel mb-5 overflow-hidden lg:mb-5">
      <h2 className="border-b border-line px-5 py-4 text-[16px] font-bold text-ink md:px-6">
        Before {app.name} can release
      </h2>
      <ul className="divide-y divide-line">
        {repoError && (
          <li className="flex gap-3 px-5 py-4 md:px-6">
            <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <div className="min-w-0">
              <p className="font-semibold text-ink">The repository refuses the console’s key</p>
              <p className="mt-0.5 max-w-[72ch] text-[13px] text-body">{repoError}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {key && <CopyButton text={key.publicKey} label="Copy the public key" />}
                <Link href={`/apps/${app.id}/settings`} className="btn btn-quiet h-10">
                  Repository settings
                </Link>
              </div>
            </div>
          </li>
        )}
        {playError && (
          <li className="flex gap-3 px-5 py-4 md:px-6">
            <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <div className="min-w-0">
              <p className="font-semibold text-ink">Google Play refuses the key</p>
              <p className="mt-0.5 line-clamp-3 max-w-[72ch] break-words text-[13px] text-body">{playError}</p>
              <Link href={`/apps/${app.id}/settings`} className="btn btn-quiet -ms-2.5 mt-2 h-10">
                Google Play settings
              </Link>
            </div>
          </li>
        )}
        {githubError && (
          <li className="flex gap-3 px-5 py-4 md:px-6">
            <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <div className="min-w-0">
              <p className="font-semibold text-ink">GitHub Actions is not ready</p>
              <p className="mt-0.5 max-w-[72ch] text-[13px] text-body">{githubError}</p>
              <Link href={`/apps/${app.id}/settings`} className="btn btn-quiet -ms-2.5 mt-2 h-10">
                Where builds run
              </Link>
            </div>
          </li>
        )}
      </ul>
    </section>
  );
}

/** A commit nothing has built yet: any commit can be built or released from here. */
function NoRun({ commit, isTip, branch, onRun, now }: { commit: StreamCommit; isTip: boolean; branch: string; onRun: (mode: Mode) => void; now: number }) {
  return (
    <article className="panel px-5 py-6 md:px-6" aria-labelledby="commit-title">
      <h2 id="commit-title" className="text-[20px] font-bold leading-snug text-ink [text-wrap:balance]">
        {commit.subject}
      </h2>
      <p className="mt-1.5 flex flex-wrap gap-x-2 text-[13px] text-muted">
        {commit.url ? (
          <a href={commit.url} target="_blank" rel="noreferrer" className="font-mono hover:text-brand hover:underline">
            {short(commit.sha)}
          </a>
        ) : (
          <span className="font-mono">{short(commit.sha)}</span>
        )}
        <span aria-hidden>·</span>
        <span>{commit.author.name}</span>
        <span aria-hidden>·</span>
        <time dateTime={commit.date}>{ago(commit.date, now)}</time>
      </p>
      {commit.body && <p className="mt-4 max-w-[70ch] whitespace-pre-wrap text-body">{commit.body}</p>}

      <div className="mt-6 flex flex-col gap-4 rounded-[var(--radius-card)] bg-page px-5 py-5 md:flex-row md:items-center">
        <GitCommitHorizontal size={22} aria-hidden className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">No run for this commit yet.</p>
          <p className="mt-1 max-w-[68ch] text-[13px] text-muted">
            {isTip
              ? `This is the tip of ${branch}: Build and Release on the bar above build exactly this code.`
              : `An older commit of ${branch}. The console can build it as it was: tests, a signed AAB, and Google Play for a release.`}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => onRun('build')}>
            <Hammer size={15} aria-hidden />
            Build this commit
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => onRun('release')}>
            <Rocket size={15} aria-hidden />
            Release it
          </button>
        </div>
      </div>
    </article>
  );
}
