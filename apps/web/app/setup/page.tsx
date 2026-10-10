'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CircleAlert, CircleCheck, CircleDot, CircleX, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago } from '@/lib/format';
import type { GithubTokenView, SetupResponse } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';
import { STAGE_LABELS } from '@/components/stage';
import { TopBar } from '@/components/TopBar';

function Row({ state, title, children }: { state: 'ok' | 'warn' | 'fail' | 'run'; title: string; children: React.ReactNode }) {
  const common = { size: 18, strokeWidth: 2.2, 'aria-hidden': true as const, className: 'mt-0.5 shrink-0' };
  return (
    <li className="flex gap-3 px-5 py-4 md:px-6">
      {state === 'ok' ? (
        <CircleCheck {...common} color="var(--color-ok)" />
      ) : state === 'fail' ? (
        <CircleX {...common} color="var(--color-fail)" />
      ) : state === 'run' ? (
        <CircleDot {...common} color="var(--color-run)" />
      ) : (
        <CircleAlert {...common} color="var(--color-warn)" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">{title}</p>
        <div className="mt-0.5 break-words text-[13px] text-body">{children}</div>
      </div>
    </li>
  );
}

/** The console's default GitHub token: what an app uses to build on GitHub Actions unless it has its own. */
function GithubTokenPanel({ token, onChange }: { token: GithubTokenView | null; onChange: (t: GithubTokenView | null) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const res = await api<{ token: GithubTokenView }>('/github/token', { method: 'PUT', json: { token: value.trim() } });
      onChange(res.token);
      setValue('');
      setNotice({ tone: 'ok', text: `Stored. Builds act as ${res.token.login} on GitHub unless an app has its own token.` });
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'The token was not stored.' });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setNotice(null);
    try {
      await api('/github/token', { method: 'DELETE' });
      onChange(null);
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'That did not go through.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row state={token ? 'ok' : 'warn'} title="Default GitHub token">
      {token ? (
        <>
          {token.login} ({token.kind === 'fine-grained' ? 'fine-grained' : token.kind === 'classic' ? 'classic' : 'token'}), stored {ago(token.savedAt)}. Used by any app building on GitHub Actions that has no token of its own.
        </>
      ) : (
        'None: an app building on GitHub Actions needs its own token (its settings → Where builds run) until one is set here.'
      )}
      <form onSubmit={save} className="mt-3 flex flex-wrap gap-2">
        <input
          className="field min-w-0 flex-1 font-mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="github_pat_…"
          aria-label="GitHub token"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-secondary" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : token ? 'Replace' : 'Save'}
        </button>
        {token && (
          <button type="button" className="btn btn-quiet h-10" onClick={clear} disabled={busy}>
            Remove
          </button>
        )}
      </form>
      {notice && (
        <p role={notice.tone === 'fail' ? 'alert' : 'status'} className={`mt-2 rounded-[var(--radius-control)] px-3 py-2 text-[13px] ${notice.tone === 'ok' ? 'bg-ok-wash text-ok-ink' : 'bg-fail-wash text-fail-ink'}`}>
          {notice.text}
        </p>
      )}
    </Row>
  );
}

const STAGE_TEXT: Record<keyof typeof STAGE_LABELS, string> = {
  checkout: 'git pull: the builder fetches the app’s repository over SSH with the app’s key and checks out the commit (or unpacks the ZIP), then reads the project: its package must be the app’s.',
  dependencies: 'flutter pub get, as an unprivileged user that can read no key.',
  tests: 'flutter analyze (errors fail it) and flutter test; then every tool/check_*.dart the project has.',
  aab: 'flutter build appbundle. With an uploaded upload key, Gradle signs with a throwaway key and the console then signs the finished bundle itself, outside the build.',
  fastlane: 'Releases only: the console’s Fastlane lanes, with the app’s package and Google Play key for this one step.',
  play: 'Fastlane uploads the bundle, the R8 mapping and “What’s new” to the track. A rehearsal is validated by Google and discarded.',
};

export default function SetupPage() {
  const setup = usePoll<SetupResponse>(() => api<SetupResponse>('/setup'), 30_000, []);
  const ghDefault = usePoll<{ token: GithubTokenView | null }>(() => api('/github'), null, []);
  const data = setup.data;
  const b = data?.builder;
  const githubIssue = (a: SetupResponse['apps'][number]) => {
    const c = a.runner.github?.check;
    if (!c) return false;
    return c.token !== 'ok' || c.repo !== 'ok' || c.workflow !== 'ok' || c.secrets === 'missing';
  };

  return (
    <div className="min-h-svh">
      <TopBar />
      <main className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 md:px-6 md:pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink">Setup</h1>
            <p className="mt-1 max-w-[70ch] text-body">The console itself: the builder every app runs on, the keys it holds, and what a release does.</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => void setup.refresh()} disabled={setup.loading}>
            <RefreshCw size={15} aria-hidden className={setup.loading ? 'animate-spin' : undefined} />
            Check again
          </button>
        </div>

        {setup.error && !data && (
          <p role="alert" className="mt-6 rounded-[var(--radius-card)] bg-fail-wash px-4 py-3 text-fail-ink">
            {setup.error.message}
          </p>
        )}

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section aria-labelledby="console" className="panel overflow-hidden">
            <h2 id="console" className="border-b border-line px-5 py-4 text-[16px] font-bold text-ink md:px-6">
              This console
            </h2>
            {!data ? (
              <div className="h-56 animate-pulse bg-line-soft/50" aria-hidden />
            ) : (
              <ul className="divide-y divide-line">
                {data.error || !b ? (
                  <Row state="fail" title="Builder">
                    {data.error} Every build, release and key lives there.
                  </Row>
                ) : (
                  <Row state={b.busy || b.onGithub.length > 0 ? 'run' : 'ok'} title="Builder">
                    {b.busy && b.current ? (
                      <>
                        Building{' '}
                        <Link href={b.current.appId ? `/apps/${b.current.appId}?run=${b.current.id}` : '/'} className="font-medium text-brand underline">
                          {b.current.appName} #{b.current.number}
                        </Link>
                        {b.current.job ? ` (${b.current.job})` : ''}
                        {b.queued ? `, ${b.queued} queued` : ''}. One build at a time, for every app.
                      </>
                    ) : (
                      'Ready and idle. One build at a time, for every app.'
                    )}{' '}
                    {b.onGithub.length > 0 && (
                      <>
                        On GitHub Actions now:{' '}
                        {b.onGithub.map((r, i) => (
                          <span key={r.id}>
                            {i > 0 && ', '}
                            <Link href={r.appId ? `/apps/${r.appId}?run=${r.id}` : '/'} className="font-medium text-brand underline">
                              {r.appName} #{r.number}
                            </Link>
                          </span>
                        ))}
                        .{' '}
                      </>
                    )}
                    Flutter {b.toolchain.flutter ?? '?'}, {b.toolchain.java ? `Java ${b.toolchain.java.replace(/^jdk-?/, '')}` : 'Java 17'}, Android SDK and Fastlane.
                  </Row>
                )}
                {b && (
                  <Row state={b.defaultPlayKey ? 'ok' : 'warn'} title="Default Google Play key">
                    {b.defaultPlayKey ? (
                      <>
                        <span className="break-all">{b.defaultPlayKey}</span>: used by every app without a key of its own. Invite it in Play Console for each app it releases.
                      </>
                    ) : (
                      'None mounted. Each app then needs its own service-account key (its settings → Google Play), or mount one at secrets/play-service-account.json.'
                    )}
                  </Row>
                )}
                <GithubTokenPanel token={ghDefault.data?.token ?? null} onChange={(token) => ghDefault.setData({ token })} />
                <Row state="ok" title="Vault">
                  SSH keys, upload keystores, their passwords and app Play keys are stored encrypted with VAULT_KEY (in .env), readable only by the builder. Keep a copy of
                  VAULT_KEY: without it the stored keys cannot be opened.
                </Row>
                <Row state={data.keys.length ? 'ok' : 'warn'} title="Git keys">
                  {data.keys.length ? `${data.keys.length} key${data.keys.length === 1 ? '' : 's'}` : 'None yet'} · {data.knownHosts.length} known host
                  {data.knownHosts.length === 1 ? '' : 's'}.{' '}
                  <Link href="/keys" className="font-medium text-brand underline">
                    Git keys
                  </Link>
                </Row>
                <Row state={data.apps.some((a) => a.repo?.access.state === 'failed' || githubIssue(a)) ? 'warn' : 'ok'} title="Apps">
                  {data.apps.length === 0
                    ? 'None yet.'
                    : data.apps.map((a, i) => (
                        <span key={a.id}>
                          {i > 0 && ' · '}
                          <Link href={`/apps/${a.id}/settings`} className="font-medium text-brand underline">
                            {a.name}
                          </Link>
                          {a.repo?.access.state === 'failed' ? ' (repository unreachable)' : !a.repo ? ' (ZIP builds)' : githubIssue(a) ? ' (GitHub Actions needs a fix)' : ''}
                        </span>
                      ))}
                </Row>
              </ul>
            )}
          </section>

          <section aria-labelledby="how" className="panel overflow-hidden">
            <div className="border-b border-line px-5 py-4 md:px-6">
              <h2 id="how" className="text-[16px] font-bold text-ink">
                What Release does
              </h2>
              <p className="mt-1 text-[13px] text-body">The six stages every run shows, in order; a build stops after the signed AAB.</p>
            </div>
            <ol className="divide-y divide-line">
              {(Object.keys(STAGE_LABELS) as Array<keyof typeof STAGE_LABELS>).map((key, i) => (
                <li key={key} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 px-5 py-3.5 md:px-6">
                  <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-page text-[12px] font-bold text-muted ring-1 ring-line tabular">{i + 1}</span>
                  <span>
                    <span className="block text-[14px] font-semibold text-ink">{STAGE_LABELS[key]}</span>
                    <span className="block text-[13px] text-body">{STAGE_TEXT[key]}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="border-t border-line px-5 py-3.5 text-[12px] text-muted md:px-6">
              Version codes: each run builds above Google Play’s highest, above every code this console built for the app, and not below pubspec.yaml’s build number.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
