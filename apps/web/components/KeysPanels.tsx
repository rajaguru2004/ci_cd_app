'use client';

import { useRef, useState } from 'react';
import clsx from 'clsx';
import { CircleCheck, KeySquare, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago, day } from '@/lib/format';
import type { AppView, PlayResponse } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';
import { PlayTracks } from './PlayTracks';
import { CopyButton } from './KeyBlock';

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function Notice({ tone, children }: { tone: 'ok' | 'fail'; children: React.ReactNode }) {
  return (
    <p role={tone === 'fail' ? 'alert' : 'status'} className={clsx('rounded-[var(--radius-control)] px-4 py-3 text-[13px]', tone === 'ok' ? 'bg-ok-wash text-ok-ink' : 'bg-fail-wash text-fail-ink')}>
      {children}
    </p>
  );
}

function Fact({ term, children, mono }: { term: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-[12px] text-muted">{term}</dt>
      <dd className={clsx('min-w-0 truncate text-end text-[13px] text-ink', mono && 'font-mono')}>{children}</dd>
    </div>
  );
}

/**
 * The app's upload key. Uploaded once, checked (passwords, alias, certificate), sealed in the
 * builder's vault; every release signs the finished bundle with it, outside the build.
 */
export function SigningPanel({ app, onChange }: { app: AppView; onChange: (app: AppView) => void }) {
  const stored = app.signing.mode === 'console' && app.signing.certificate;
  const [editing, setEditing] = useState(!stored);
  const [file, setFile] = useState<File | null>(null);
  const [storePassword, setStorePassword] = useState('');
  const [keyAlias, setKeyAlias] = useState('');
  const [samePassword, setSamePassword] = useState(true);
  const [keyPassword, setKeyPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setNotice({ tone: 'fail', text: 'Choose the keystore file (.jks, .keystore or .p12).' });
    setBusy(true);
    setNotice(null);
    try {
      const next = await api<AppView>(`/apps/${app.id}/signing`, {
        method: 'PUT',
        json: { keystore: await base64(file), fileName: file.name, storePassword, keyAlias: keyAlias.trim(), keyPassword: samePassword ? storePassword : keyPassword },
      });
      onChange(next);
      setEditing(false);
      setFile(null);
      setStorePassword('');
      setKeyPassword('');
      setNotice({ tone: 'ok', text: `Stored. Releases of ${next.name} are signed with '${next.signing.keyAlias}' (${next.signing.certificate?.owner}).` });
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'The keystore was not stored.' });
    } finally {
      setBusy(false);
    }
  }

  async function useRepository() {
    setBusy(true);
    setNotice(null);
    try {
      const next = await api<AppView>(`/apps/${app.id}/signing`, { method: 'DELETE' });
      onChange(next);
      setEditing(true);
      setNotice({ tone: 'ok', text: 'The stored keystore is deleted. Builds now sign with the project’s own android/key.properties.' });
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'That did not go through.' });
    } finally {
      setBusy(false);
    }
  }

  const cert = app.signing.certificate;
  return (
    <section aria-labelledby={`signing-${app.id}`} className="panel overflow-hidden">
      <div className="border-b border-line px-5 py-4 md:px-6">
        <h2 id={`signing-${app.id}`} className="flex items-center gap-2 text-[16px] font-bold text-ink">
          <KeySquare size={17} aria-hidden className="text-muted" />
          Upload key
        </h2>
        <p className="mt-1 max-w-[70ch] text-[13px] text-body">
          {stored
            ? 'The console signs every bundle of this app with this key, after the build, as a separate step: the app’s own code never sees it.'
            : 'Now signed by the project itself (its android/key.properties). Upload the upload keystore and the console signs instead: the key stays out of builds, and out of the repository if you remove it there.'}
        </p>
      </div>

      <div className="space-y-4 px-5 py-5 md:px-6">
        {stored && cert && (
          <dl className="rounded-[var(--radius-card)] border border-line px-4 py-2">
            <Fact term="Signed by">
              <span title={cert.owner}>{cert.owner}</span>
            </Fact>
            <Fact term="Certificate SHA-256" mono>
              <span title={cert.sha256}>{cert.sha256.slice(0, 29)}…</span>
            </Fact>
            <Fact term="Valid until">{day(cert.validUntil)}</Fact>
            <Fact term="Key" mono>
              {app.signing.keyAlias} · {app.signing.fileName}
            </Fact>
            {app.signing.updatedAt && <Fact term="Stored">{ago(app.signing.updatedAt)}</Fact>}
          </dl>
        )}
        {stored && cert && !editing && (
          <div className="flex flex-wrap gap-2">
            <CopyButton text={cert.sha256} label="Copy SHA-256" />
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)} disabled={busy}>
              <Upload size={15} aria-hidden />
              Replace keystore
            </button>
            <button type="button" className="btn btn-quiet h-10" onClick={useRepository} disabled={busy}>
              Use the project’s own signing
            </button>
          </div>
        )}

        {editing && (
          <form onSubmit={save} className="space-y-4" autoComplete="off">
            <div>
              <span className="label" id={`ks-label-${app.id}`}>
                Keystore
              </span>
              <button
                type="button"
                aria-labelledby={`ks-label-${app.id}`}
                onClick={() => input.current?.click()}
                className={clsx(
                  'flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-card)] border border-dashed px-4 py-3 text-start transition-colors',
                  file ? 'border-line bg-card' : 'border-idle bg-page hover:border-brand',
                )}
              >
                <KeySquare size={22} aria-hidden className={file ? 'text-brand' : 'text-muted'} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{file ? file.name : 'Choose the upload keystore'}</span>
                  <span className="block text-[12px] text-muted">{file ? 'choose another' : '.jks, .keystore or .p12 — the key Play Console knows as the upload key'}</span>
                </span>
              </button>
              <input
                ref={input}
                type="file"
                accept=".jks,.keystore,.p12,.pfx,application/x-java-keystore,application/x-pkcs12"
                className="sr-only"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor={`sp-${app.id}`}>
                  Keystore password
                </label>
                <input id={`sp-${app.id}`} type="password" className="field" value={storePassword} onChange={(e) => setStorePassword(e.target.value)} autoComplete="new-password" required />
              </div>
              <div>
                <label className="label" htmlFor={`alias-${app.id}`}>
                  Key alias
                </label>
                <input id={`alias-${app.id}`} className="field font-mono" value={keyAlias} onChange={(e) => setKeyAlias(e.target.value)} placeholder="found when there is one key" autoComplete="off" />
              </div>
            </div>
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={samePassword} onChange={(e) => setSamePassword(e.target.checked)} />
              <span className="text-ink">The key password is the keystore password</span>
            </label>
            {!samePassword && (
              <div>
                <label className="label" htmlFor={`kp-${app.id}`}>
                  Key password
                </label>
                <input id={`kp-${app.id}`} type="password" className="field" value={keyPassword} onChange={(e) => setKeyPassword(e.target.value)} autoComplete="new-password" />
              </div>
            )}
            <p className="hint max-w-[70ch]">
              The console opens the keystore and signs a test file with the key before storing anything. Passwords are kept encrypted with the keystore; they are never shown again.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn btn-primary" disabled={busy || !file || !storePassword}>
                <ShieldCheck size={15} aria-hidden />
                {busy ? 'Checking the key…' : 'Check and store'}
              </button>
              {stored && (
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)} disabled={busy}>
                  Keep the stored key
                </button>
              )}
            </div>
          </form>
        )}
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      </div>
    </section>
  );
}

/**
 * The Google Play key a release of this app uploads with, and what Play holds for it now: the
 * app's own service-account key, or the one mounted on the console.
 */
export function PlayPanel({ app, onChange }: { app: AppView; onChange: (app: AppView) => void }) {
  const play = usePoll<PlayResponse>(() => api<PlayResponse>(`/apps/${app.id}/play`), null, [app.id, app.play.source, app.play.clientEmail]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setNotice(null);
    try {
      const next = await api<AppView>(`/apps/${app.id}/play`, { method: 'PUT', json: { json: await file.text() } });
      onChange(next);
      setNotice({ tone: 'ok', text: `Stored. Releases of ${next.name} upload as ${next.play.clientEmail}.` });
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'The key was not stored.' });
    } finally {
      setBusy(false);
    }
  }

  async function useDefault() {
    setBusy(true);
    setNotice(null);
    try {
      onChange(await api<AppView>(`/apps/${app.id}/play`, { method: 'DELETE' }));
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'That did not go through.' });
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    try {
      play.setData(await api<PlayResponse>(`/apps/${app.id}/play?refresh=1`));
    } catch (err) {
      setNotice({ tone: 'fail', text: err instanceof ApiError ? err.message : 'Google Play did not answer.' });
    } finally {
      setBusy(false);
    }
  }

  const who =
    app.play.source === 'app'
      ? `Its own key: ${app.play.clientEmail}`
      : app.play.clientEmail
        ? `The console’s key: ${app.play.clientEmail}`
        : 'No key yet: releases cannot upload.';

  return (
    <section aria-labelledby={`play-${app.id}`} className="panel overflow-hidden">
      <div className="border-b border-line px-5 py-4 md:px-6">
        <h2 id={`play-${app.id}`} className="text-[16px] font-bold text-ink">
          Google Play
        </h2>
        <p className="mt-1 break-words text-[13px] text-body">{who}</p>
      </div>
      <div className="space-y-4 px-5 py-5 md:px-6">
        {play.data?.configured ? (
          <>
            <PlayTracks tracks={play.data.tracks} />
            <p className="text-[12px] text-muted">
              <CircleCheck size={14} aria-hidden color="var(--color-ok)" className="me-1.5 inline-block align-[-2px]" />
              The key reads <span className="break-all font-mono">{play.data.packageName}</span> · checked {ago(play.data.checkedAt)}
            </p>
          </>
        ) : play.data && !play.data.configured ? (
          <p className="text-[13px] text-muted">{play.data.reason}</p>
        ) : play.error ? (
          <Notice tone="fail">{play.error.message}</Notice>
        ) : (
          <div className="h-16 animate-pulse rounded-[var(--radius-card)] bg-line-soft" aria-hidden />
        )}

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => input.current?.click()} disabled={busy}>
            <Upload size={15} aria-hidden />
            {app.play.source === 'app' ? 'Replace the key' : 'Upload a service-account JSON'}
          </button>
          {app.play.source === 'app' && (
            <button type="button" className="btn btn-quiet h-10" onClick={useDefault} disabled={busy}>
              Use the console’s key
            </button>
          )}
          <button type="button" className="btn btn-quiet h-10" onClick={check} disabled={busy}>
            <RefreshCw size={15} aria-hidden className={busy ? 'animate-spin' : undefined} />
            Check again
          </button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </div>
        <p className="hint max-w-[70ch]">
          The key comes from Google Cloud (IAM → Service accounts → Keys → Add key → JSON). Invite its email in Play Console → Users and permissions, with
          permission to release this app. Google Play requires the app’s first upload by hand; the console releases every one after it.
        </p>
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      </div>
    </section>
  );
}
