'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CircleAlert, CircleCheck, CircleDot, CircleMinus, Download, KeyRound, Laptop, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago } from '@/lib/format';
import type { MacRunnerView, MacsResponse, NewMacRunner } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';
import { CopyButton } from '@/components/KeyBlock';
import { TopBar } from '@/components/TopBar';

const STATE: Record<MacRunnerView['state'], { word: string; ink: string }> = {
  idle: { word: 'Ready', ink: 'text-ok-ink' },
  busy: { word: 'Building', ink: 'text-run-ink' },
  'not-ready': { word: 'Needs attention', ink: 'text-ink' },
  offline: { word: 'Offline', ink: 'text-muted' },
};

function Glyph({ state }: { state: MacRunnerView['state'] }) {
  const common = { size: 16, strokeWidth: 2.2, 'aria-hidden': true as const, className: 'shrink-0' };
  if (state === 'idle') return <CircleCheck {...common} color="var(--color-ok)" />;
  if (state === 'busy') return <CircleDot {...common} color="var(--color-run)" />;
  if (state === 'not-ready') return <CircleAlert {...common} color="var(--color-warn)" />;
  return <CircleMinus {...common} color="var(--color-faint)" />;
}

function Fact({ term, children, mono }: { term: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="shrink-0 text-[12px] text-muted">{term}</dt>
      <dd className={clsx('min-w-0 truncate text-end text-[13px] text-ink', mono && 'font-mono')}>{children}</dd>
    </div>
  );
}

/** A shell command a person pastes on the Mac: Geist Mono on the page tint, with a copy button. */
function Command({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <div className="space-y-2">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-control)] border border-line bg-page px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink">{text}</pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

/**
 * The token of a Mac that was just added (or given a new token): shown this once, inside the
 * command that sets the Mac up, because the console keeps only its hash.
 */
function TokenPanel({ created, origin, onDone }: { created: NewMacRunner; origin: string; onDone: () => void }) {
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
  const setup = `curl -fsSL ${origin}/api/runner/v1/files/setup-mac.sh -o setup-mac.sh\nSERVER_URL=${origin} RUNNER_TOKEN=${created.token} bash setup-mac.sh`;
  const env = `SERVER_URL=${origin}\nRUNNER_TOKEN=${created.token}\nMAC_USER=<the Mac account, whoami>\n# RUNNER_IMAGE=${created.image}`;
  return (
    <section aria-labelledby="token-title" className="panel mt-6 overflow-hidden">
      <div className="border-b border-line px-5 py-4 md:px-6">
        <h2 id="token-title" className="flex items-center gap-2 text-[16px] font-bold text-ink">
          <KeyRound size={17} aria-hidden className="text-muted" />
          Set up {created.runner.name}
        </h2>
        <p className="mt-1 max-w-[70ch] text-[13px] text-body">
          This token is shown once: the console keeps only its hash. It lets a machine take this console’s iOS runs, so keep it to the Mac’s .env.
        </p>
      </div>
      <div className="space-y-5 px-5 py-5 md:px-6">
        {local && (
          <div role="alert" className="flex gap-3 rounded-[var(--radius-control)] bg-warn-wash px-4 py-3 text-[13px] text-ink">
            <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <p>
              This page is open on {origin}, which the Mac cannot reach. Use this machine’s address on your network instead (open the console at it, e.g. http://192.168.0.189:7080, and these commands follow).
            </p>
          </div>
        )}
        <div>
          <p className="label">On the Mac, in Terminal (with Docker Desktop running)</p>
          <Command text={setup} label="Copy the commands" />
          <p className="hint max-w-[70ch]">
            It checks Xcode, Flutter, CocoaPods, Ruby/Fastlane and Remote Login, writes ~/release-console-runner, lets the runner’s SSH key into your account (restricted: no forwarding, no terminal), starts the runner and checks it reaches this console.
          </p>
        </div>
        <details className="group rounded-[var(--radius-card)] border border-line">
          <summary className="flex min-h-11 cursor-pointer list-none items-center px-4 text-[14px] font-medium text-ink">By hand instead</summary>
          <div className="space-y-4 border-t border-line px-4 py-4">
            <ol className="list-decimal space-y-1 ps-5 text-[13px] text-body">
              <li>System Settings → General → Sharing → Remote Login: on.</li>
              <li>
                Download{' '}
                <a className="font-medium text-brand underline" href="/api/runner/v1/files/docker-compose.yml" download>
                  docker-compose.yml
                </a>{' '}
                into a folder, with a .env beside it:
              </li>
            </ol>
            <Command text={env} label="Copy .env" />
            <Command text={'docker compose run --rm runner pubkey >> ~/.ssh/authorized_keys\ndocker compose up -d\ndocker compose exec runner node dist/cli.js check'} label="Copy the commands" />
          </div>
        </details>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          Done, the token is on the Mac
        </button>
      </div>
    </section>
  );
}

/** One Mac: whether it takes runs now, what it found on itself, and the way out of a problem. */
function RunnerRow({ r, busy, onAction }: { r: MacRunnerView; busy: boolean; onAction: (action: 'token' | 'reset' | 'remove', r: MacRunnerView) => void }) {
  const [confirm, setConfirm] = useState(false);
  const h = r.host;
  const s = STATE[r.state];
  return (
    <li className="px-5 py-4 md:px-6">
      <div className="flex flex-wrap items-start gap-3">
        <Laptop size={20} aria-hidden className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[15px] font-bold text-ink">{r.name}</span>
            <span className={clsx('flex items-center gap-1.5 text-[13px] font-medium', s.ink)}>
              <Glyph state={r.state} />
              {r.state === 'busy' && r.run ? (
                <Link href={r.run.appId ? `/apps/${r.run.appId}?run=${r.run.id}` : '/'} className="underline-offset-2 hover:underline">
                  Building {r.run.appName} #{r.run.number}
                </Link>
              ) : (
                s.word
              )}
            </span>
          </p>
          <p className="mt-0.5 text-[12px] text-muted">
            {r.lastSeenAt ? `${r.online ? 'Connected' : 'Last seen'} ${ago(r.lastSeenAt)}` : 'Never connected: run the setup command on the Mac.'}
            {r.agent ? ` · runner ${r.agent.version} · ${r.agent.executor === 'ssh' ? `SSH to ${r.agent.hostUser ?? '?'}@${r.agent.hostAddress?.split('@')[1] ?? '?'}` : 'on the Mac itself'}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          <button type="button" className="btn btn-quiet h-9" onClick={() => onAction('token', r)} disabled={busy} title="Make a new token (the old one stops working)">
            <RefreshCw size={14} aria-hidden />
            New token
          </button>
          {confirm ? (
            <>
              <button type="button" className="btn btn-danger h-9" onClick={() => onAction('remove', r)} disabled={busy}>
                Remove {r.name}
              </button>
              <button type="button" className="btn btn-secondary h-9" onClick={() => setConfirm(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-quiet h-9 w-9 p-0 text-fail-ink hover:bg-fail-wash" onClick={() => setConfirm(true)} disabled={busy} aria-label={`Remove ${r.name}`}>
              <Trash2 size={15} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {r.refusedKey && (
        <div role="alert" className="mt-3 flex flex-wrap items-start gap-3 rounded-[var(--radius-control)] bg-warn-wash px-4 py-3 text-[13px] text-ink">
          <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
          <p className="min-w-0 flex-1">
            A runner with this token offered another key ({r.refusedKey.fingerprint}, {ago(r.refusedKey.at)}) and was refused. If you reinstalled the runner on the Mac, reset the key so it can connect.
          </p>
          <button type="button" className="btn btn-secondary h-9" onClick={() => onAction('reset', r)} disabled={busy}>
            Reset the key
          </button>
        </div>
      )}

      {h && h.problems.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-[var(--radius-card)] border border-line">
          {h.problems.map((p) => (
            <li key={p} className="flex gap-3 px-4 py-2.5">
              <CircleAlert size={16} strokeWidth={2.2} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
              <p className="text-[13px] text-ink">{p}</p>
            </li>
          ))}
        </ul>
      )}

      {h?.reachable && (
        <dl className="mt-3 grid gap-x-6 rounded-[var(--radius-card)] border border-line px-4 py-2 sm:grid-cols-2">
          <Fact term="Mac">{[h.os, h.arch].filter(Boolean).join(' · ') || '?'}</Fact>
          <Fact term="Xcode">{[h.xcode, h.iosSdk].filter(Boolean).join(' · ') || 'not found'}</Fact>
          <Fact term="Flutter">{h.flutter ?? 'not found'}</Fact>
          <Fact term="CocoaPods">{h.cocoapods ?? 'not found'}</Fact>
          <Fact term="Fastlane">{h.fastlane ?? 'not found'}</Fact>
          <Fact term="Disk free">{h.diskFreeGb !== null ? `${h.diskFreeGb} GB` : '?'}</Fact>
          {h.hostname && <Fact term="Name">{h.hostname}</Fact>}
          <Fact term="Checked">{ago(h.checkedAt)}</Fact>
        </dl>
      )}
      {r.keyFingerprint && <p className="mt-2 font-mono text-[12px] text-muted">runner key {r.keyFingerprint} · token …{r.tokenHint}</p>}
    </li>
  );
}

/**
 * The Macs that build and release the apps' iOS side. A Mac's runner dials out to this console
 * (nothing listens on the Mac), takes one iOS run at a time, and runs its steps on the Mac over
 * SSH: Xcode, Flutter, CocoaPods and Fastlane are the Mac's own.
 */
export default function RunnersPage() {
  const macs = usePoll<MacsResponse>(() => api<MacsResponse>('/runners'), 5000, []);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<NewMacRunner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => setOrigin(window.location.origin), []);

  async function run(label: string, fn: () => Promise<string | null>) {
    setBusy(label);
    setNotice(null);
    try {
      const text = await fn();
      if (text) setNotice({ tone: 'ok', text });
      await macs.refresh();
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'That did not go through.' });
    } finally {
      setBusy(null);
    }
  }

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    return run('add', async () => {
      setCreated(await api<NewMacRunner>('/runners', { method: 'POST', json: { name: name.trim() } }));
      setAdding(false);
      setName('');
      return null;
    });
  };

  const action = (what: 'token' | 'reset' | 'remove', r: MacRunnerView) =>
    run(r.id, async () => {
      if (what === 'token') {
        setCreated(await api<NewMacRunner>(`/runners/${r.id}/token`, { method: 'POST' }));
        return null;
      }
      if (what === 'reset') {
        await api(`/runners/${r.id}/reset-key`, { method: 'POST' });
        return `${r.name}'s key is forgotten: the next runner that connects with its token is trusted.`;
      }
      await api(`/runners/${r.id}`, { method: 'DELETE' });
      return `Removed ${r.name}: its token no longer works. Stop the runner on the Mac (docker compose down) and remove its line from ~/.ssh/authorized_keys.`;
    });

  const list = macs.data?.runners ?? [];
  const ready = list.filter((r) => r.state === 'idle' || r.state === 'busy').length;
  const waiting = macs.data?.waiting ?? [];

  return (
    <div className="min-h-svh">
      <TopBar />
      <main className="mx-auto max-w-[920px] px-4 pb-24 pt-6 md:px-6 md:pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink">Runners</h1>
            <p className="mt-1 max-w-[68ch] text-body">
              Macs that build and release the apps’ iOS side. A Mac’s runner connects to this console, takes one iOS run at a time, and builds it with the Mac’s own Xcode,
              Flutter and Fastlane.
              {list.length > 0 && ` ${ready} of ${list.length} ready.`}
            </p>
          </div>
          {!adding && (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <Plus size={16} aria-hidden />
              Add a Mac
            </button>
          )}
        </div>

        {notice && (
          <p role={notice.tone === 'fail' ? 'alert' : 'status'} className={clsx('mt-5 rounded-[var(--radius-card)] px-4 py-3 text-[13px]', notice.tone === 'ok' ? 'bg-ok-wash text-ok-ink' : 'bg-fail-wash text-fail-ink')}>
            {notice.text}
          </p>
        )}

        {adding && (
          <form onSubmit={add} className="panel mt-6 space-y-3 px-5 py-5 md:px-6">
            <h2 className="text-[16px] font-bold text-ink">Add a Mac</h2>
            <div>
              <label className="label" htmlFor="mac-name">
                Name
              </label>
              <input id="mac-name" className="field max-w-md" value={name} onChange={(e) => setName(e.target.value)} placeholder="Studio Mac mini" autoComplete="off" required />
              <p className="hint">How the console names the Mac in runs and here. The next screen gives the one command to run on it.</p>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary" disabled={busy === 'add' || !name.trim()}>
                {busy === 'add' ? 'Adding…' : 'Add and make its token'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {created && origin && <TokenPanel created={created} origin={origin} onDone={() => setCreated(null)} />}

        {waiting.length > 0 && (
          <section aria-labelledby="waiting-title" className="mt-6 flex gap-3 rounded-[var(--radius-control)] bg-warn-wash px-4 py-3 text-[13px] text-ink">
            <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <p id="waiting-title">
              Waiting for a Mac:{' '}
              {waiting.map((w, i) => (
                <span key={w.id}>
                  {i > 0 && ', '}
                  <Link className="font-medium text-brand underline" href={w.appId ? `/apps/${w.appId}?run=${w.id}` : '/'}>
                    {w.appName} #{w.number}
                  </Link>
                  {w.queuedAt ? ` (${ago(w.queuedAt)})` : ''}
                </span>
              ))}
              . A Mac takes the oldest once it is online and ready.
            </p>
          </section>
        )}

        <section aria-labelledby="macs-title" className="panel mt-6 overflow-hidden">
          <h2 id="macs-title" className="flex items-center justify-between border-b border-line px-5 py-4 text-[16px] font-bold text-ink md:px-6">
            Macs
            {macs.data && (
              <a className="btn btn-quiet h-9 text-[13px]" href="/api/runner/v1/files/docker-compose.yml" download>
                <Download size={14} aria-hidden />
                docker-compose.yml
              </a>
            )}
          </h2>
          {!macs.data ? (
            macs.error ? (
              <p className="px-6 py-6 text-[13px] text-fail-ink">{macs.error.message}</p>
            ) : (
              <div className="h-32 animate-pulse bg-line-soft/50" aria-hidden />
            )
          ) : list.length === 0 ? (
            <div className="px-6 py-8">
              <p className="font-semibold text-ink">No Mac yet</p>
              <p className="mt-1 max-w-[64ch] text-[13px] text-muted">
                Add one: the console makes its token and the command that sets it up. The Mac needs Xcode, Flutter, CocoaPods, Ruby or Fastlane, Docker Desktop, and Remote Login on.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {list.map((r) => (
                <RunnerRow key={r.id} r={r} busy={busy === r.id} onAction={action} />
              ))}
            </ul>
          )}
        </section>
        {macs.data && <p className="mt-3 font-mono text-[12px] text-muted">image {macs.data.image}</p>}
      </main>
    </div>
  );
}
