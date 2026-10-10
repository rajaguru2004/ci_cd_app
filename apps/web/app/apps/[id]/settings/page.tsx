'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, CircleCheck, CircleDashed, GitBranch, Search, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago } from '@/lib/format';
import type { AccessCheck, AppView, KeyRecord } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';
import { PlayPanel, SigningPanel } from '@/components/KeysPanels';
import { RunnerPanel } from '@/components/RunnerPanel';
import { Sheet } from '@/components/Sheet';
import { TopBar } from '@/components/TopBar';

function Notice({ tone, children }: { tone: 'ok' | 'fail'; children: React.ReactNode }) {
  return (
    <p role={tone === 'fail' ? 'alert' : 'status'} className={`rounded-[var(--radius-control)] px-4 py-3 text-[13px] ${tone === 'ok' ? 'bg-ok-wash text-ok-ink' : 'bg-fail-wash text-fail-ink'}`}>
      {children}
    </p>
  );
}

/** Where the app's code comes from: the SSH URL, the key that reads it, the branch Release builds. */
function RepositoryPanel({ app, keys, onChange }: { app: AppView; keys: KeyRecord[]; onChange: (a: AppView) => void }) {
  const [url, setUrl] = useState(app.repo?.url ?? '');
  const [keyId, setKeyId] = useState(app.repo?.keyId ?? keys[0]?.id ?? '');
  const [branch, setBranch] = useState(app.repo?.branch ?? '');
  const [path, setPath] = useState(app.repo?.path ?? '');
  const [branches, setBranches] = useState<string[]>(app.repo ? [app.repo.branch] : []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (!keyId && keys[0]) setKeyId(keys[0].id);
  }, [keys, keyId]);

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

  const check = () =>
    run('Check', async () => {
      const a = await api<AccessCheck>('/git/check', { method: 'POST', json: { url: url.trim(), keyId } });
      setBranches(a.branches);
      if (!branch || !a.branches.includes(branch)) setBranch(a.defaultBranch ?? a.branches[0] ?? 'main');
      return `The key reads ${a.slug} on ${a.hostLabel}: ${a.branches.length} branches.`;
    });

  const save = () =>
    run('Save', async () => {
      const next = await api<AppView>(`/apps/${app.id}`, { method: 'PATCH', json: { repo: { url: url.trim(), keyId, branch: branch.trim(), path: path.trim() } } });
      onChange(next);
      return next.repo?.access.state === 'ok' ? 'Saved; the repository answers.' : `Saved, but the repository does not answer yet: ${next.repo?.access.message ?? ''}`;
    });

  const recheck = () =>
    run('Recheck', async () => {
      const next = await api<AppView>(`/apps/${app.id}/access`, { method: 'POST' });
      onChange(next);
      return next.repo?.access.state === 'ok' ? 'The repository answers.' : null;
    });

  const disconnect = () =>
    run('Disconnect', async () => {
      const next = await api<AppView>(`/apps/${app.id}`, { method: 'PATCH', json: { repo: null } });
      onChange(next);
      setConfirmDisconnect(false);
      setUrl('');
      return 'Disconnected. Build and Release now take an uploaded ZIP.';
    });

  const access = app.repo?.access;
  const key = keys.find((k) => k.id === keyId);
  const dirty = !app.repo || url.trim() !== app.repo.url || keyId !== app.repo.keyId || branch.trim() !== app.repo.branch || path.trim() !== app.repo.path;

  return (
    <section aria-labelledby="repo-title" className="panel overflow-hidden">
      <div className="border-b border-line px-5 py-4 md:px-6">
        <h2 id="repo-title" className="text-[16px] font-bold text-ink">
          Repository
        </h2>
        {access ? (
          <p className="mt-1.5 flex items-start gap-2 text-[13px]">
            {access.state === 'ok' ? (
              <CircleCheck size={16} strokeWidth={2.2} aria-hidden color="var(--color-ok)" className="mt-0.5 shrink-0" />
            ) : access.state === 'failed' ? (
              <CircleAlert size={16} strokeWidth={2.2} aria-hidden color="var(--color-warn)" className="mt-0.5 shrink-0" />
            ) : (
              <CircleDashed size={16} strokeWidth={2.2} aria-hidden color="var(--color-run)" className="mt-0.5 shrink-0" />
            )}
            <span className="min-w-0 text-ink">
              {access.state === 'ok' ? 'The key reads the repository' : access.state === 'failed' ? access.message : 'Not checked yet'}
              {access.checkedAt && <span className="text-muted"> · checked {ago(access.checkedAt)}</span>}
            </span>
          </p>
        ) : (
          <p className="mt-1 text-[13px] text-body">None: Build and Release take an uploaded source ZIP. Connect the repository and they pull it instead.</p>
        )}
      </div>
      <div className="space-y-4 px-5 py-5 md:px-6">
        {keys.length === 0 ? (
          <p className="text-[13px] text-body">
            The console needs an SSH key first.{' '}
            <Link href="/keys" className="font-semibold text-brand underline">
              Make one for your git email
            </Link>
          </p>
        ) : (
          <>
            <div>
              <label className="label" htmlFor="repo-url">
                SSH URL
              </label>
              <input id="repo-url" className="field font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:your-org/your-app.git" spellCheck={false} />
            </div>
            <div>
              <label className="label" htmlFor="repo-key">
                SSH key
              </label>
              <select id="repo-key" className="field" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.email} · {k.fingerprint.slice(0, 18)}…
                  </option>
                ))}
              </select>
              <p className="hint">
                {key ? `Made for ${key.email}. ` : ''}A key reaches what its git account (or deploy key) can open.{' '}
                <Link href="/keys" className="font-medium text-brand underline">
                  Git keys
                </Link>
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="repo-branch">
                  Branch
                </label>
                <span className="relative flex items-center">
                  <GitBranch size={16} aria-hidden className="pointer-events-none absolute start-3 text-muted" />
                  <input id="repo-branch" className="field ps-9 font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} list="repo-branches" spellCheck={false} />
                </span>
                <datalist id="repo-branches">
                  {branches.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
                <p className="hint">Build and Release pull this branch.</p>
              </div>
              <div>
                <label className="label" htmlFor="repo-path">
                  Project folder
                </label>
                <input id="repo-path" className="field font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="(found automatically)" spellCheck={false} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={save} disabled={Boolean(busy) || !url.trim() || !keyId || !dirty}>
                {busy === 'Save' ? 'Saving…' : app.repo ? 'Save' : 'Connect'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={app.repo && !dirty ? recheck : check}
                disabled={Boolean(busy) || !url.trim() || !keyId}
              >
                <Search size={15} aria-hidden />
                {busy === 'Check' || busy === 'Recheck' ? 'Checking…' : 'Check access'}
              </button>
            </div>
            {app.repo && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                {confirmDisconnect ? (
                  <>
                    <p className="basis-full text-[13px] text-ink sm:basis-auto sm:flex-1">Build and Release will take an uploaded ZIP instead. The repository is not touched.</p>
                    <button type="button" className="btn btn-danger" onClick={disconnect} disabled={Boolean(busy)}>
                      Disconnect
                    </button>
                    <button type="button" className="btn btn-quiet h-10" onClick={() => setConfirmDisconnect(false)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-quiet -ms-2.5 h-10" onClick={() => setConfirmDisconnect(true)} disabled={Boolean(busy)}>
                    Disconnect the repository
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      </div>
    </section>
  );
}

function DetailsPanel({ app, onChange, onDelete }: { app: AppView; onChange: (a: AppView) => void; onDelete: () => void }) {
  const [name, setName] = useState(app.name);
  const [packageName, setPackageName] = useState(app.packageName);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      onChange(await api<AppView>(`/apps/${app.id}`, { method: 'PATCH', json: { name: name.trim(), packageName: packageName.trim() } }));
      setNotice({ tone: 'ok', text: 'Saved.' });
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'Not saved.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="details-title" className="panel overflow-hidden">
      <h2 id="details-title" className="border-b border-line px-5 py-4 text-[16px] font-bold text-ink md:px-6">
        The app
      </h2>
      <form onSubmit={save} className="space-y-4 px-5 py-5 md:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="app-name">
              Name
            </label>
            <input id="app-name" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          </div>
          <div>
            <label className="label" htmlFor="app-package">
              Package (applicationId)
            </label>
            <input id="app-package" className="field font-mono" value={packageName} onChange={(e) => setPackageName(e.target.value)} spellCheck={false} required />
          </div>
        </div>
        <p className="hint">Each run checks that the project builds this package before anything is uploaded.</p>
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <button type="submit" className="btn btn-primary" disabled={busy || (name.trim() === app.name && packageName.trim() === app.packageName)}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn-quiet ms-auto h-10 text-fail-ink hover:bg-fail-wash hover:text-fail-ink" onClick={onDelete}>
            <Trash2 size={15} aria-hidden />
            Delete app
          </button>
        </div>
      </form>
    </section>
  );
}

export default function AppSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const loaded = usePoll<AppView>(() => api<AppView>(`/apps/${id}`), null, [id]);
  const keys = usePoll<KeyRecord[]>(() => api<KeyRecord[]>('/keys'), null, []);
  const [app, setApp] = useState<AppView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loaded.data) setApp(loaded.data);
  }, [loaded.data]);

  async function remove() {
    if (!app) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api(`/apps/${app.id}`, { method: 'DELETE' });
      router.push('/');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'The app was not deleted.');
      setBusy(false);
    }
  }

  return (
    <div className="min-h-svh">
      <TopBar app={app ? { id: app.id, name: app.name } : { id, name: '…' }} />
      <main className="mx-auto max-w-[860px] px-4 pb-24 pt-6 md:px-6 md:pt-8">
        <Link href={`/apps/${id}`} className="btn btn-quiet -ms-2.5 mb-2">
          <ArrowLeft size={16} aria-hidden />
          {app?.name ?? 'App'}
        </Link>
        <h1 className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink">Settings</h1>
        <p className="mt-1 max-w-[68ch] text-body">Where the code comes from, where it builds, the key that signs it, and the Google Play key it is released with.</p>

        {loaded.error && !app && (
          <p role="alert" className="mt-6 rounded-[var(--radius-card)] bg-fail-wash px-4 py-3 text-fail-ink">
            {loaded.error.message}
          </p>
        )}
        {!app && !loaded.error && <div className="panel mt-6 h-72 animate-pulse" aria-hidden />}

        {app && (
          <div className="mt-6 space-y-6">
            <RepositoryPanel key={`${app.id}-${app.repo?.url ?? 'none'}`} app={app} keys={keys.data ?? []} onChange={setApp} />
            <RunnerPanel app={app} onChange={setApp} />
            <SigningPanel app={app} onChange={setApp} />
            <PlayPanel app={app} onChange={setApp} />
            <DetailsPanel app={app} onChange={setApp} onDelete={() => setDeleting(true)} />
          </div>
        )}
      </main>

      <Sheet
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${app?.name ?? 'the app'}?`}
        description="Its runs, logs and AABs on this server go, with its stored upload key and Google Play key. The repository and Google Play are not touched."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn btn-secondary" onClick={() => setDeleting(false)} disabled={busy}>
              Keep it
            </button>
            <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
              <Trash2 size={15} aria-hidden />
              {busy ? 'Deleting…' : `Delete ${app?.name ?? ''}`}
            </button>
          </div>
        }
      >
        <p className="text-body">This cannot be undone. A release in progress must be cancelled first.</p>
        {deleteError && (
          <p role="alert" className="mt-4 rounded-[var(--radius-control)] bg-fail-wash px-4 py-3 text-fail-ink">
            {deleteError}
          </p>
        )}
      </Sheet>
    </div>
  );
}
