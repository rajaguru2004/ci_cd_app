'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { CircleAlert, CircleCheck, CircleDashed, GitBranch, KeyRound, RefreshCw, Server, Upload } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago } from '@/lib/format';
import type { AppView, GithubCheck } from '@/lib/types';

function Notice({ tone, children }: { tone: 'ok' | 'fail'; children: React.ReactNode }) {
  return (
    <p role={tone === 'fail' ? 'alert' : 'status'} className={clsx('rounded-[var(--radius-control)] px-4 py-3 text-[13px]', tone === 'ok' ? 'bg-ok-wash text-ok-ink' : 'bg-fail-wash text-fail-ink')}>
      {children}
    </p>
  );
}

const READY: Record<string, boolean> = { ok: true };

/** One line of the readiness check: state glyph, what it found, and the way out when it is not ok. */
function CheckRow({ title, state, detail, fix }: { title: string; state: string; detail: string; fix?: React.ReactNode }) {
  const ok = READY[state] === true;
  const common = { size: 16, strokeWidth: 2.2, 'aria-hidden': true as const, className: 'mt-0.5 shrink-0' };
  return (
    <li className="flex gap-3 px-5 py-3.5 md:px-6">
      {ok ? <CircleCheck {...common} color="var(--color-ok)" /> : state === 'unknown' ? <CircleDashed {...common} color="var(--color-run)" /> : <CircleAlert {...common} color="var(--color-warn)" />}
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">{title}</p>
        <p className="mt-0.5 max-w-[60ch] text-[13px] text-body">{detail}</p>
        {fix && <div className="mt-2">{fix}</div>}
      </div>
    </li>
  );
}

const TOKEN_TEXT: Record<GithubCheck['token'] | 'unknown', string> = {
  ok: 'Reads the repository.',
  missing: 'No token: add one below, or the console’s default on the Setup page.',
  refused: 'GitHub refused it: expired or revoked.',
  unknown: 'Not checked yet.',
};
const REPO_TEXT: Record<GithubCheck['repo'], string> = { ok: 'Found.', hidden: 'Hidden from the token.', unknown: 'Not checked yet.' };
const WORKFLOW_TEXT: Record<GithubCheck['workflow'], string> = {
  ok: 'On the default branch, matching the console’s.',
  outdated: 'On the default branch, but not the console’s current one.',
  missing: 'Not on the default branch yet.',
  disabled: 'Turned off in the repository’s Actions tab.',
  unknown: 'Not checked yet.',
};
const SECRETS_TEXT: Record<GithubCheck['secrets'], string> = {
  ok: 'The upload key and Google Play key are copied in.',
  stale: 'A key changed since they were copied; the next run copies them again.',
  missing: 'Not copied yet.',
  unknown: 'Not checked yet.',
};

/**
 * Where Build and Release run for this app: this server, or the app's own GitHub Actions. Only
 * offered when the repository is on github.com; everything else builds here.
 */
export function RunnerPanel({ app, onChange }: { app: AppView; onChange: (app: AppView) => void }) {
  const gh = app.runner.github;
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const [token, setToken] = useState('');

  async function run(label: string, fn: () => Promise<string | null>) {
    setBusy(label);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ tone: 'ok', text });
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : `${label} did not go through.` });
    } finally {
      setBusy(null);
    }
  }

  const setKind = (kind: 'server' | 'github') =>
    run(kind, async () => {
      onChange(await api<AppView>(`/apps/${app.id}/runner`, { method: 'PUT', json: { kind } }));
      return null;
    });

  const check = () =>
    run('check', async () => {
      onChange(await api<AppView>(`/apps/${app.id}/github/check`, { method: 'POST' }));
      return null;
    });

  const saveToken = () =>
    run('token', async () => {
      const next = await api<AppView>(`/apps/${app.id}/github/token`, { method: 'PUT', json: { token: token.trim() } });
      onChange(next);
      setToken('');
      return `Stored. ${next.runner.github?.tokenLogin ? `Builds act as ${next.runner.github.tokenLogin} on GitHub.` : ''}`;
    });

  const useDefaultToken = () =>
    run('default-token', async () => {
      onChange(await api<AppView>(`/apps/${app.id}/github/token`, { method: 'DELETE' }));
      return 'Back to the console’s default token.';
    });

  const install = () =>
    run('workflow', async () => {
      const res = await api<{ app: AppView; result: { kind: string; url: string | null; message: string } }>(`/apps/${app.id}/github/workflow`, { method: 'POST' });
      onChange(res.app);
      return res.result.url ? `${res.result.message} ${res.result.url}` : res.result.message;
    });

  const syncSecrets = () =>
    run('secrets', async () => {
      const res = await api<{ app: AppView; synced: string[]; removed: string[] }>(`/apps/${app.id}/github/secrets`, { method: 'POST' });
      onChange(res.app);
      return res.synced.length ? `Copied ${res.synced.length} secret${res.synced.length === 1 ? '' : 's'}, sealed for GitHub.` : 'Nothing to copy: this app signs with the project’s own key and has no Google Play key of its own.';
    });

  return (
    <section aria-labelledby={`runner-${app.id}`} className="panel overflow-hidden">
      <div className="border-b border-line px-5 py-4 md:px-6">
        <h2 id={`runner-${app.id}`} className="flex items-center gap-2 text-[16px] font-bold text-ink">
          <Server size={17} aria-hidden className="text-muted" />
          Where builds run
        </h2>
        <p className="mt-1 max-w-[70ch] text-[13px] text-body">
          {app.runner.kind === 'github'
            ? 'Build and Release run the app’s own GitHub Actions. The console plans each run (the commit, the version, the track) and copies back its logs, test report, AAB and Google Play’s answer.'
            : 'Build and Release run on this server: git pull over SSH, the tests, the signed AAB, Fastlane.'}
        </p>
      </div>
      <div className="space-y-4 px-5 py-5 md:px-6">
        {!gh ? (
          <p className="text-[13px] text-body">Only a repository on github.com can build on GitHub Actions. {app.repo ? 'This one is elsewhere, so it builds here.' : 'This app has no repository connected, so it builds uploaded ZIPs here.'}</p>
        ) : (
          <>
            <div className="seg flex-col sm:flex-row">
              <label>
                <input type="radio" name={`runner-${app.id}`} checked={app.runner.kind === 'server'} onChange={() => setKind('server')} disabled={Boolean(busy)} />
                <span className="flex items-center gap-1.5">
                  <Server size={14} aria-hidden />
                  This server
                </span>
                <span className="text-[12px] font-normal text-muted">git pull over SSH, build here</span>
              </label>
              <label>
                <input type="radio" name={`runner-${app.id}`} checked={app.runner.kind === 'github'} onChange={() => setKind('github')} disabled={Boolean(busy)} />
                <span className="flex items-center gap-1.5">
                  <GitBranch size={14} aria-hidden />
                  GitHub Actions
                </span>
                <span className="font-mono text-[12px] font-normal text-muted">{gh.repo}</span>
              </label>
            </div>

            <div className="rounded-[var(--radius-card)] border border-line px-4 py-2">
              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className="shrink-0 text-[12px] text-muted">Token</span>
                <span className="min-w-0 truncate text-end text-[13px] text-ink">
                  {gh.token === 'app' ? `This app’s own${gh.tokenLogin ? ` (${gh.tokenLogin})` : ''}` : 'The console’s default (Setup)'}
                </span>
              </div>
              {gh.check?.checkedAt && (
                <div className="flex items-center justify-between gap-3 py-1.5">
                  <span className="shrink-0 text-[12px] text-muted">Checked</span>
                  <span className="text-[13px] text-ink">{ago(gh.check.checkedAt)}</span>
                </div>
              )}
            </div>

            <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
              <CheckRow title="Token" state={gh.check?.token ?? 'unknown'} detail={TOKEN_TEXT[gh.check?.token ?? 'unknown']} />
              <CheckRow title="Repository" state={gh.check?.repo ?? 'unknown'} detail={REPO_TEXT[gh.check?.repo ?? 'unknown']} />
              <CheckRow
                title="Workflow"
                state={gh.check?.workflow ?? 'unknown'}
                detail={WORKFLOW_TEXT[gh.check?.workflow ?? 'unknown']}
                fix={
                  gh.check && (gh.check.workflow === 'missing' || gh.check.workflow === 'outdated') ? (
                    <button type="button" className="btn btn-secondary h-9" onClick={install} disabled={Boolean(busy)}>
                      <Upload size={14} aria-hidden />
                      {busy === 'workflow' ? 'Writing…' : gh.check.workflow === 'missing' ? 'Add the workflow' : 'Update the workflow'}
                    </button>
                  ) : undefined
                }
              />
              <CheckRow
                title="Secrets"
                state={gh.check?.secrets ?? 'unknown'}
                detail={SECRETS_TEXT[gh.check?.secrets ?? 'unknown']}
                fix={
                  gh.check && (gh.check.secrets === 'missing' || gh.check.secrets === 'stale') ? (
                    <button type="button" className="btn btn-secondary h-9" onClick={syncSecrets} disabled={Boolean(busy)}>
                      <KeyRound size={14} aria-hidden />
                      {busy === 'secrets' ? 'Copying…' : 'Copy secrets to GitHub'}
                    </button>
                  ) : undefined
                }
              />
            </ul>

            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-quiet h-10" onClick={check} disabled={Boolean(busy)}>
                <RefreshCw size={15} aria-hidden className={busy === 'check' ? 'animate-spin' : undefined} />
                Check again
              </button>
            </div>

            <div className="border-t border-line pt-4">
              <label className="label" htmlFor={`gh-token-${app.id}`}>
                GitHub token for this app
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id={`gh-token-${app.id}`}
                  className="field min-w-0 flex-1 font-mono"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={gh.token === 'app' ? 'Paste a new token to replace it' : 'github_pat_… (optional: uses the console’s default otherwise)'}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="btn btn-secondary" onClick={saveToken} disabled={Boolean(busy) || !token.trim()}>
                  {busy === 'token' ? 'Checking…' : 'Save'}
                </button>
                {gh.token === 'app' && (
                  <button type="button" className="btn btn-quiet h-10" onClick={useDefaultToken} disabled={Boolean(busy)}>
                    Use the default
                  </button>
                )}
              </div>
              <p className="hint">Fine-grained: Actions, Contents, Secrets and Workflows read and write. Classic: repo and workflow.</p>
            </div>
          </>
        )}
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      </div>
    </section>
  );
}
