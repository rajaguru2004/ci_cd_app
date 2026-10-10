'use client';

import Link from 'next/link';
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, KeyRound, Plus, Server, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago } from '@/lib/format';
import type { AppView, HostKey, KeyRecord } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';
import { KeyBlock } from '@/components/KeyBlock';
import { TopBar } from '@/components/TopBar';

/**
 * The SSH keys the console made for people's git accounts, which apps use each, and the hosts
 * whose keys it holds. The private halves stay in the vault; this page shows public lines only.
 */
export default function KeysPage() {
  const keys = usePoll<KeyRecord[]>(() => api<KeyRecord[]>('/keys'), null, []);
  const apps = usePoll<AppView[]>(() => api<AppView[]>('/apps'), null, []);
  const hosts = usePoll<HostKey[]>(() => api<HostKey[]>('/known-hosts'), null, []);
  const [making, setMaking] = useState(false);
  const [email, setEmail] = useState('');
  const [fresh, setFresh] = useState<KeyRecord | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);

  async function make(e: React.FormEvent) {
    e.preventDefault();
    setBusy('make');
    setNotice(null);
    try {
      const k = await api<KeyRecord>('/keys', { method: 'POST', json: { email: email.trim() } });
      setFresh(k);
      setOpen(k.id);
      setMaking(false);
      setEmail('');
      await keys.refresh();
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'The key was not made.' });
    } finally {
      setBusy(null);
    }
  }

  async function remove(k: KeyRecord) {
    setBusy(k.id);
    setNotice(null);
    try {
      await api(`/keys/${k.id}`, { method: 'DELETE' });
      setNotice({ tone: 'ok', text: `Deleted the key for ${k.email}. Remove it from the git account too.` });
      await keys.refresh();
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'The key was not deleted.' });
    } finally {
      setBusy(null);
    }
  }

  async function forget(h: HostKey) {
    setBusy(h.host);
    setNotice(null);
    try {
      await api(`/known-hosts/${encodeURIComponent(h.host)}`, { method: 'DELETE' });
      setNotice({ tone: 'ok', text: `Forgot ${h.host}. The next connection accepts the key it shows then.` });
      await hosts.refresh();
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'That did not go through.' });
    } finally {
      setBusy(null);
    }
  }

  const usedBy = (k: KeyRecord) => (apps.data ?? []).filter((a) => a.repo?.keyId === k.id);

  return (
    <div className="min-h-svh">
      <TopBar />
      <main className="mx-auto max-w-[920px] px-4 pb-24 pt-6 md:px-6 md:pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink">Git keys</h1>
            <p className="mt-1 max-w-[68ch] text-body">
              SSH keys this console made for people’s git accounts. Each one reaches the repositories its account can open; apps pull with the key they were set up with.
            </p>
          </div>
          {!making && (
            <button type="button" className="btn btn-primary" onClick={() => setMaking(true)}>
              <Plus size={16} aria-hidden />
              New key
            </button>
          )}
        </div>

        {notice && (
          <p role={notice.tone === 'fail' ? 'alert' : 'status'} className={clsx('mt-5 rounded-[var(--radius-card)] px-4 py-3 text-[13px]', notice.tone === 'ok' ? 'bg-ok-wash text-ok-ink' : 'bg-fail-wash text-fail-ink')}>
            {notice.text}
          </p>
        )}

        {making && (
          <form onSubmit={make} className="panel mt-6 space-y-3 px-5 py-5 md:px-6">
            <h2 className="text-[16px] font-bold text-ink">New key</h2>
            <div>
              <label className="label" htmlFor="new-email">
                Git email
              </label>
              <input id="new-email" type="email" className="field max-w-md" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" required />
              <p className="hint">The key is named after it, so its owner recognises it on GitHub, GitLab or Bitbucket.</p>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary" disabled={busy === 'make' || !email.trim()}>
                <KeyRound size={15} aria-hidden />
                {busy === 'make' ? 'Making the key…' : 'Make the key'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setMaking(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        <section aria-labelledby="keys-title" className="panel mt-6 overflow-hidden">
          <h2 id="keys-title" className="border-b border-line px-5 py-4 text-[16px] font-bold text-ink md:px-6">
            Keys
          </h2>
          {!keys.data ? (
            <div className="h-32 animate-pulse bg-line-soft/50" aria-hidden />
          ) : keys.data.length === 0 ? (
            <div className="px-6 py-8">
              <p className="font-semibold text-ink">No keys yet</p>
              <p className="mt-1 text-[13px] text-muted">Make one for your git email; then add its public line to your git account.</p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {keys.data.map((k) => {
                const users = usedBy(k);
                const expanded = open === k.id;
                return (
                  <li key={k.id} className="px-5 py-4 md:px-6">
                    <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-semibold text-ink">{k.email}</span>
                          {fresh?.id === k.id && <span className="text-[12px] text-muted">new</span>}
                        </p>
                        <p className="mt-0.5 break-all font-mono text-[12px] text-muted">{k.fingerprint}</p>
                        <p className="mt-1 text-[12px] text-muted">
                          Made {ago(k.createdAt)}
                          {k.lastUsedAt ? ` · reached a repository ${ago(k.lastUsedAt)}` : ' · not used yet'}
                          {users.length > 0 && (
                            <>
                              {' · used by '}
                              {users.map((a, i) => (
                                <span key={a.id}>
                                  {i > 0 && ', '}
                                  <Link href={`/apps/${a.id}`} className="font-medium text-brand underline">
                                    {a.name}
                                  </Link>
                                </span>
                              ))}
                            </>
                          )}
                        </p>
                      </div>
                      <div className="-ms-2.5 flex gap-1 sm:ms-0">
                        <button type="button" className="btn btn-quiet h-10" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : k.id)}>
                          Public key
                          <ChevronDown size={15} aria-hidden className={clsx('transition-transform duration-200', expanded && 'rotate-180')} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet h-10 w-10 p-0 hover:bg-fail-wash hover:text-fail-ink"
                          onClick={() => remove(k)}
                          disabled={busy === k.id || users.length > 0}
                          aria-label={`Delete the key for ${k.email}`}
                          title={users.length ? `${users.map((a) => a.name).join(', ')} still use this key` : 'Delete'}
                        >
                          <Trash2 size={16} aria-hidden />
                        </button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="mt-4">
                        <KeyBlock sshKey={k} compact={fresh?.id !== k.id} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="hosts-title" className="panel mt-6 overflow-hidden">
          <div className="border-b border-line px-5 py-4 md:px-6">
            <h2 id="hosts-title" className="text-[16px] font-bold text-ink">
              Known hosts
            </h2>
            <p className="mt-1 max-w-[70ch] text-[13px] text-body">
              The first time the console reaches a git host it keeps the host’s key, and refuses a host that later shows a different one. Forget a host only when it really changed its key.
            </p>
          </div>
          {!hosts.data ? (
            <div className="h-16 animate-pulse bg-line-soft/50" aria-hidden />
          ) : hosts.data.length === 0 ? (
            <p className="px-5 py-5 text-[13px] text-muted md:px-6">None yet: the first repository check adds its host.</p>
          ) : (
            <ul className="divide-y divide-line">
              {hosts.data.map((h) => (
                <li key={`${h.host}-${h.type}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 md:px-6">
                  <Server size={16} aria-hidden className="text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">{h.host}</span>
                    <span className="block break-all font-mono text-[12px] text-muted">
                      {h.type} {h.fingerprint}
                    </span>
                  </span>
                  <button type="button" className="btn btn-quiet h-10" onClick={() => forget(h)} disabled={busy === h.host}>
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
