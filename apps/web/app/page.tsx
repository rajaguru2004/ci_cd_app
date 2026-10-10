'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { ago, runLabel, runSource, runWhat } from '@/lib/format';
import type { AppOverview, Mode, OverviewResponse, RunSummary } from '@/lib/types';
import { useNow, usePoll } from '@/lib/usePoll';
import { AppCard } from '@/components/AppCard';
import { ReleaseSheet } from '@/components/ReleaseSheet';
import { RUN_INK, RUN_WORD, ringLabel, shipped, StageRing } from '@/components/stage';
import { TopBar } from '@/components/TopBar';

const live = (r: RunSummary | null) => r?.state === 'running' || r?.state === 'queued';

export default function AppsPage() {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const overview = usePoll<OverviewResponse>(() => api<OverviewResponse>('/overview'), active ? 5000 : 20_000, []);
  const now = useNow(true, active ? 1000 : 30_000);
  const [sheet, setSheet] = useState<{ app: AppOverview; mode: Mode } | null>(null);
  const data = overview.data;

  useEffect(() => {
    setActive(Boolean(data?.recent.some((r) => live(r))));
  }, [data]);

  const summary = useMemo(() => {
    if (!data) return '';
    const n = data.apps.length;
    const building = data.recent.find((r) => r.state === 'running');
    const lastRelease = data.recent.find((r) => r.mode === 'release' && r.state === 'success' && !r.rehearsal);
    return [
      `${n} ${n === 1 ? 'app' : 'apps'}`,
      building ? `${building.app?.name} ${runLabel(building)} building` : null,
      lastRelease ? `last release ${ago(lastRelease.completedAt ?? lastRelease.updatedAt, now)} (${lastRelease.app?.name} → ${lastRelease.track})` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }, [data, now]);

  return (
    <div className="min-h-svh">
      <TopBar />
      <main className="mx-auto max-w-[1440px] px-4 pb-20 pt-6 md:px-6 md:pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink">Apps</h1>
            <p className="mt-1 text-body">{summary || 'Every app this console builds, tests and releases to Google Play.'}</p>
          </div>
          {data && data.apps.length > 0 && (
            <Link href="/apps/new" className="btn btn-primary">
              <Plus size={16} aria-hidden />
              Add app
            </Link>
          )}
        </div>

        {overview.error && !data && (
          <p role="alert" className="mt-6 rounded-[var(--radius-card)] bg-fail-wash px-4 py-3 text-fail-ink">
            {overview.error.message}
          </p>
        )}

        {!data && !overview.error && (
          <div className="mt-6 grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))]" aria-hidden>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="panel h-[300px] animate-pulse" />
            ))}
          </div>
        )}

        {data && data.apps.length === 0 && <FirstApp />}

        {data && data.apps.length > 0 && (
          <>
            <div className="mt-6 grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))]">
              {data.apps.map((app) => (
                <AppCard key={app.id} app={app} now={now} onRun={(mode) => setSheet({ app, mode })} />
              ))}
              <Link
                href="/apps/new"
                className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-[var(--radius-panel)] border border-dashed border-idle px-6 py-8 text-center transition-colors hover:border-brand hover:bg-brand-wash"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-card text-brand ring-1 ring-line">
                  <Plus size={20} aria-hidden />
                </span>
                <span className="text-[16px] font-bold text-ink">Add an app</span>
                <span className="max-w-[34ch] text-[13px] text-muted">Connect its repository over SSH, then add its upload key and Google Play key.</span>
              </Link>
            </div>

            {data.recent.length > 0 && (
              <section aria-labelledby="recent" className="panel mt-8 overflow-hidden">
                <h2 id="recent" className="border-b border-line px-5 py-4 text-[16px] font-bold text-ink md:px-6">
                  Recent runs
                </h2>
                <ol>
                  {data.recent.map((r) => (
                    <li key={r.id} className="border-b border-line-soft last:border-b-0">
                      <button
                        type="button"
                        onClick={() => r.app && router.push(`/apps/${r.app.id}?run=${r.id}`)}
                        className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 text-start transition-colors hover:bg-line-soft/70 md:px-6"
                      >
                        <StageRing stages={r.stages} size={24} shippedCore={shipped(r)} label={ringLabel(r)} />
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] text-ink">
                            <span className="font-semibold">{r.app?.name ?? 'Unassigned'}</span> {runLabel(r)} {runWhat(r)}
                          </span>
                          <span className="block truncate text-[12px] text-muted">
                            <span className="font-mono">{runSource(r)}</span>
                            {r.source.subject && <> · {r.source.subject}</>}
                          </span>
                        </span>
                        <span className="text-end text-[12px]">
                          <span className={`block ${RUN_INK[r.state]}`}>{RUN_WORD[r.state].toLowerCase()}</span>
                          <time className="block text-muted" dateTime={r.createdAt}>
                            {ago(r.createdAt, now)}
                          </time>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </main>

      <ReleaseSheet
        open={Boolean(sheet)}
        onClose={() => setSheet(null)}
        app={sheet?.app ?? null}
        initialMode={sheet?.mode ?? 'release'}
        onStarted={(run) => {
          if (sheet) router.push(`/apps/${sheet.app.id}?run=${run.runId}`);
        }}
      />
    </div>
  );
}

/** The console with no app yet: what adding one takes, in the order it happens. */
function FirstApp() {
  const steps = [
    ['Your git email', 'The console makes an SSH key for you. You add its public half to your GitHub, GitLab or Bitbucket account.'],
    ["The repository's SSH URL", 'The console checks it can read the repository, and reads the app’s name and package from it.'],
    ['The upload key and the Google Play key', 'Kept encrypted on this server. Every release signs and uploads with them; builds never see them.'],
  ];
  return (
    <section aria-labelledby="first-app" className="panel mt-6 max-w-3xl px-6 py-7 md:px-8">
      <h2 id="first-app" className="text-[20px] font-bold text-ink">
        Add your first app
      </h2>
      <p className="mt-1.5 max-w-[64ch] text-body">
        The console builds, tests and releases Flutter apps to Google Play from their own repositories, on this server. Adding one takes three things:
      </p>
      <ol className="mt-5 space-y-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-wash text-[14px] font-bold text-brand tabular">{i + 1}</span>
            <span>
              <span className="block font-semibold text-ink">{title}</span>
              <span className="block max-w-[64ch] text-[13px] text-body">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <Link href="/apps/new" className="btn btn-primary mt-7">
        <Plus size={16} aria-hidden />
        Add an app
      </Link>
    </section>
  );
}
