'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleX, ExternalLink, RefreshCw, Upload } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago, clock } from '@/lib/format';
import type { CheckState, SetupResponse } from '@/lib/types';
import { useNow, usePoll } from '@/lib/usePoll';
import { PlayTracks } from '@/components/PlayTracks';
import { StartSheet } from '@/components/StartSheet';
import { TopBar } from '@/components/TopBar';

/** Missing is amber, not Signal Orange: orange is kept for what ships. */
function CheckGlyph({ state }: { state: CheckState }) {
  const common = { size: 18, strokeWidth: 2.2, 'aria-hidden': true as const, className: 'mt-0.5 shrink-0' };
  if (state === 'ok') return <CircleCheck {...common} color="var(--color-ok)" />;
  if (state === 'error') return <CircleX {...common} color="var(--color-fail)" />;
  if (state === 'missing') return <CircleAlert {...common} color="var(--color-warn)" />;
  if (state === 'pending') return <CircleDashed {...common} color="var(--color-run)" />;
  return <CircleHelp {...common} color="var(--color-faint)" />;
}

const STATE_WORD: Record<CheckState, string> = {
  ok: 'ready',
  missing: 'missing',
  error: 'failing',
  unknown: 'unknown',
  pending: 'not checked yet',
};

function Snippet({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-[var(--radius-control)] border border-line bg-page px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
      {children}
    </pre>
  );
}

export default function SetupPage() {
  const setup = usePoll<SetupResponse>(() => api<SetupResponse>('/setup'), 60_000, []);
  const now = useNow(true, 30_000);
  const [startOpen, setStartOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const data = setup.data;

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setNotice(null);
    try {
      setNotice({ tone: 'ok', text: await fn() });
      await setup.refresh();
    } catch (e) {
      setNotice({ tone: 'fail', text: e instanceof ApiError ? e.message : `${label} failed.` });
    } finally {
      setBusy(null);
    }
  }

  const syncKey = () =>
    run('Copy key', async () => {
      const r = await api<{ clientEmail: string }>('/setup/play-key/sync', { method: 'POST' });
      return `Stored ${r.clientEmail} as the PLAY_SERVICE_ACCOUNT_JSON secret on GitHub. Only GitHub can read it back.`;
    });

  const uploadKey = (file: File) =>
    run('Upload key', async () => {
      const json = await file.text();
      const r = await api<{ clientEmail: string }>('/setup/play-key', { method: 'PUT', json: { json } });
      return `Stored ${r.clientEmail} as the PLAY_SERVICE_ACCOUNT_JSON secret on GitHub.`;
    });

  const attention = data ? data.checks.some((c) => c.state !== 'ok') : false;
  const blocked = data && !data.configured ? (data.checks.find((c) => c.key === 'token')?.detail ?? 'The console has no GitHub token.') : null;
  const releases = data?.play.snapshot?.tracks.flatMap((t) => t.releases.map((r) => ({ track: t.track, ...r }))) ?? [];

  return (
    <div className="min-h-svh">
      <TopBar onStart={() => setStartOpen(true)} setupAttention={attention} />
      <main className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 md:px-6 md:pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold text-ink">Setup</h1>
            <p className="mt-1 max-w-[70ch] text-body">
              What the pipeline needs, checked live against GitHub and Google Play. Every line says what is missing and what to do.
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => void setup.refresh()} disabled={setup.loading}>
            <RefreshCw size={15} aria-hidden className={setup.loading ? 'animate-spin' : undefined} />
            Check again
          </button>
        </div>

        {notice && (
          <p
            role={notice.tone === 'fail' ? 'alert' : 'status'}
            className={`mt-5 rounded-[var(--radius-card)] px-4 py-3 text-[13px] ${notice.tone === 'ok' ? 'bg-ok-wash text-ok-ink' : 'bg-fail-wash text-fail-ink'}`}
          >
            {notice.text}
          </p>
        )}

        {setup.error && !data && (
          <p role="alert" className="mt-6 rounded-[var(--radius-card)] bg-fail-wash px-4 py-3 text-fail-ink">
            {setup.error.message}
          </p>
        )}

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className="space-y-6">
            <section aria-labelledby="checklist" className="panel overflow-hidden">
              <h2 id="checklist" className="border-b border-line px-5 py-4 text-[16px] font-bold text-ink">
                Checklist
              </h2>
              {!data ? (
                <ul aria-hidden className="divide-y divide-line">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <li key={i} className="flex gap-3 px-5 py-4">
                      <span className="h-[18px] w-[18px] animate-pulse rounded-full bg-line-soft" />
                      <span className="flex-1 space-y-2">
                        <span className="block h-3.5 w-1/3 animate-pulse rounded bg-line-soft" />
                        <span className="block h-3 w-3/4 animate-pulse rounded bg-line-soft" />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="divide-y divide-line">
                  {data.checks.map((c) => (
                    <li key={c.key} className="flex gap-3 px-5 py-4">
                      <CheckGlyph state={c.state} />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-semibold text-ink">{c.label}</span>
                          <span className="text-[12px] text-muted">{STATE_WORD[c.state]}</span>
                        </p>
                        <p className="mt-0.5 break-words text-[13px] text-body">{c.detail}</p>
                        {c.fix && <p className="mt-1 text-[13px] font-medium text-ink">{c.fix}</p>}
                        {c.key === 'play-secret' && (c.state === 'missing' || c.state === 'ok') && data.configured && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {data.play.configured && (
                              <button type="button" className="btn btn-primary" onClick={syncKey} disabled={Boolean(busy)}>
                                {busy === 'Copy key' ? 'Copying…' : c.state === 'ok' ? 'Replace with the console key' : 'Copy the console key to GitHub'}
                              </button>
                            )}
                            <button type="button" className="btn btn-secondary" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
                              <Upload size={15} aria-hidden />
                              {busy === 'Upload key' ? 'Uploading…' : 'Upload a JSON key'}
                            </button>
                            <input
                              ref={fileRef}
                              type="file"
                              accept="application/json,.json"
                              className="sr-only"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) void uploadKey(f);
                                e.target.value = '';
                              }}
                            />
                          </div>
                        )}
                        {c.key === 'play-access' && c.state !== 'ok' && data.configured && (
                          <button type="button" className="btn btn-secondary mt-3" onClick={() => setStartOpen(true)}>
                            Check Play access from GitHub Actions
                          </button>
                        )}
                        {c.url && (
                          <a href={c.url} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-brand underline">
                            Open on GitHub <ExternalLink size={12} aria-hidden />
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="triggers" className="panel overflow-hidden">
              <div className="border-b border-line px-5 py-4">
                <h2 id="triggers" className="text-[16px] font-bold text-ink">
                  Three ways a run starts
                </h2>
                <p className="mt-1 max-w-[75ch] text-[13px] text-body">
                  All three run the same {data?.workflowFile ?? 'release.yml'}: checkout, dependencies, tests, signed AAB, then Fastlane to Google
                  Play for releases.
                </p>
              </div>
              <ol className="divide-y divide-line">
                <li className="px-5 py-4">
                  <h3 className="font-semibold text-ink">From this console</h3>
                  <p className="mt-1 text-[13px] text-body">
                    Start build on any branch that has the pipeline: build and test, a release to a track, or a Play access check.
                  </p>
                </li>
                <li className="px-5 py-4">
                  <h3 className="font-semibold text-ink">A release commit on main</h3>
                  <p className="mt-1 text-[13px] text-body">The last commit of the push; the text after the colon becomes &quot;What&apos;s new&quot;.</p>
                  <Snippet>{'git commit -m "release: Faster check-in"\ngit commit -m "release(beta): Arabic fixes"'}</Snippet>
                </li>
                <li className="px-5 py-4">
                  <h3 className="font-semibold text-ink">A v-tag on a main commit</h3>
                  <p className="mt-1 text-[13px] text-body">
                    Notes come from store/play-store/release-notes-1.0.2.txt, else the tag message; v1.0.2-beta picks the track.
                  </p>
                  <Snippet>{'git tag -a v1.0.2 -m "What\'s new…"\ngit push origin v1.0.2'}</Snippet>
                </li>
              </ol>
            </section>
          </div>

          <div className="space-y-6">
            <section aria-labelledby="play" className="panel overflow-hidden">
              <div className="px-5 pb-4 pt-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 id="play" className="text-[16px] font-bold text-ink">
                    Google Play
                  </h2>
                  {data?.play.snapshot && <span className="text-[12px] text-muted">checked {ago(data.play.snapshot.checkedAt, now)}</span>}
                </div>
                {data?.play.snapshot ? (
                  <>
                    <p className="mt-1 text-[13px] text-body">
                      <span className="font-mono">{data.play.snapshot.packageName}</span> as{' '}
                      <span className="break-all">{data.play.clientEmail}</span>
                    </p>
                    <div className="mt-4">
                      <PlayTracks tracks={data.play.snapshot.tracks} />
                    </div>
                  </>
                ) : data?.play.error ? (
                  <p className="mt-2 text-[13px] text-fail-ink">{data.play.error}</p>
                ) : (
                  <div className="mt-3 h-24 animate-pulse rounded-[var(--radius-card)] bg-line-soft" />
                )}
              </div>
              {releases.length > 0 && (
                <ul className="divide-y divide-line border-t border-line">
                  {releases.map((r, i) => (
                    <li key={`${r.track}-${i}`} className="px-5 py-3">
                      <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                        <span className={`font-semibold ${r.track === 'production' ? 'text-ship-ink' : 'text-ink'}`}>{r.track}</span>
                        <span className="font-medium text-ink">{r.name ?? 'unnamed release'}</span>
                        <span className="text-muted">
                          code <span className="font-mono">{r.versionCodes.join(', ')}</span> · {r.status}
                        </span>
                      </p>
                      {r.releaseNotes[0] && <p className="mt-1 line-clamp-3 text-[12px] text-body">{r.releaseNotes[0].text}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="versions" className="panel overflow-hidden">
              <div className="px-5 pb-3 pt-5">
                <h2 id="versions" className="text-[16px] font-bold text-ink">
                  Version codes
                </h2>
                <p className="mt-2 text-[13px] text-body">
                  Every run gets <span className="font-mono">run number + {data?.variables.versionCodeOffset ?? 1000}</span>, so codes only
                  grow and two runs never collide. Fastlane refuses before uploading if Google Play is already ahead.
                </p>
              </div>
              <dl className="divide-y divide-line border-t border-line text-[13px]">
                <div className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                  <dt className="text-muted">Highest on Google Play</dt>
                  <dd className="font-mono font-semibold text-ink tabular">{data?.play.snapshot?.highestVersionCode ?? '—'}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                  <dt className="text-muted">Next run builds</dt>
                  {data?.nextRunNumber ? (
                    <dd className="font-mono font-semibold text-ink tabular">{data.nextRunNumber + data.variables.versionCodeOffset}</dd>
                  ) : (
                    <dd className="text-muted">once GitHub is connected</dd>
                  )}
                </div>
                <div className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                  <dt className="text-muted">Release commits go to</dt>
                  <dd className="font-semibold text-ship-ink">{data?.variables.defaultTrack ?? 'internal'}</dd>
                </div>
              </dl>
              {data && !data.variables.readable && (
                <p className="border-t border-line px-5 py-2.5 text-[12px] text-muted">Repository variables are not readable with this token; defaults shown.</p>
              )}
            </section>
          </div>
        </div>

        {data?.playCheck && (
          <p className="mt-4 text-[12px] text-muted">
            Last Play check from GitHub Actions: run #{data.playCheck.number}, {data.playCheck.state}, {clock(data.playCheck.at)} ·{' '}
            <Link href={`/?run=${data.playCheck.runId}`} className="font-medium text-brand underline">
              open
            </Link>
          </p>
        )}
      </main>

      <StartSheet
        open={startOpen}
        onClose={() => setStartOpen(false)}
        defaultBranch={data?.repo?.defaultBranch ?? 'main'}
        initialMode="validate"
        blocked={blocked}
        onStarted={(r) => {
          if (r.runId) window.location.assign(`/?run=${r.runId}`);
        }}
      />
    </div>
  );
}
