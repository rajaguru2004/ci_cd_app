'use client';

import { useRef, useState } from 'react';
import clsx from 'clsx';
import { CircleAlert, CircleCheck, FileBadge, KeyRound, RefreshCw, Smartphone, Trash2, Upload } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago, day } from '@/lib/format';
import type { AppStoreResponse, AppView } from '@/lib/types';

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

/** A file chooser in the console's dashed "drop something here" shape. */
function FilePick({ id, label, hint, accept, file, onPick, icon: Icon }: { id: string; label: string; hint: string; accept: string; file: File | null; onPick: (f: File | null) => void; icon: typeof KeyRound }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        aria-labelledby={id}
        onClick={() => input.current?.click()}
        className={clsx('flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-card)] border border-dashed px-4 py-3 text-start transition-colors', file ? 'border-line bg-card' : 'border-idle bg-page hover:border-brand')}
      >
        <Icon size={22} aria-hidden className={file ? 'text-brand' : 'text-muted'} />
        <span className="min-w-0">
          <span className="block truncate font-medium text-ink">{file ? file.name : label}</span>
          <span className="block text-[12px] text-muted">{file ? 'choose another' : hint}</span>
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
    </>
  );
}

/**
 * The app's iOS side, built and released on a Mac runner: the bundle ID, the Apple Distribution
 * certificate (.p12), the App Store provisioning profiles, and the App Store Connect API key.
 * Each is checked as it is stored (the .p12 opened, each profile matched to the certificate and
 * the team, the key proven by finding the app) and sealed in the builder's vault.
 */
export function IosPanel({ app, onChange }: { app: AppView; onChange: (app: AppView) => void }) {
  const ios = app.ios;
  const [bundleId, setBundleId] = useState(ios?.bundleId ?? '');
  const [p12, setP12] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [replaceCert, setReplaceCert] = useState(!ios?.certificate);
  const [keyId, setKeyId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [p8, setP8] = useState<File | null>(null);
  const [replaceKey, setReplaceKey] = useState(!ios?.appStore);
  const [store, setStore] = useState<AppStoreResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const profileInput = useRef<HTMLInputElement>(null);

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

  const saveBundle = (e: React.FormEvent) => {
    e.preventDefault();
    return run('bundle', async () => {
      const next = await api<AppView>(`/apps/${app.id}/ios`, { method: 'PUT', json: { bundleId: bundleId.trim() } });
      onChange(next);
      return ios ? `The bundle ID is ${next.ios?.bundleId}.` : `${next.name} now builds for iOS too. Next: the certificate, the profile and the App Store Connect key.`;
    });
  };

  const saveCert = (e: React.FormEvent) => {
    e.preventDefault();
    if (!p12) return setNotice({ tone: 'fail', text: 'Choose the certificate’s .p12 file.' });
    return run('cert', async () => {
      const next = await api<AppView>(`/apps/${app.id}/ios/certificate`, { method: 'PUT', json: { p12: await base64(p12), password, fileName: p12.name } });
      onChange(next);
      setP12(null);
      setPassword('');
      setReplaceCert(false);
      return `Stored: ${next.ios?.certificate?.name}.`;
    });
  };

  const addProfile = (file: File) =>
    run('profile', async () => {
      const next = await api<AppView>(`/apps/${app.id}/ios/profiles`, { method: 'POST', json: { data: await base64(file), fileName: file.name } });
      onChange(next);
      return `Stored ${file.name}.`;
    });

  const removeProfile = (uuid: string, name: string) =>
    run('profile', async () => {
      onChange(await api<AppView>(`/apps/${app.id}/ios/profiles/${uuid}`, { method: 'DELETE' }));
      return `Removed ${name}.`;
    });

  const saveKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!p8) return setNotice({ tone: 'fail', text: 'Choose the .p8 key file.' });
    return run('key', async () => {
      const next = await api<AppView>(`/apps/${app.id}/ios/app-store`, { method: 'PUT', json: { keyId: keyId.trim(), issuerId: issuerId.trim(), p8: await p8.text() } });
      onChange(next);
      setP8(null);
      setReplaceKey(false);
      const s = next.ios?.appStore;
      return s?.message ? null : `Stored. App Store Connect knows the app as ${s?.appName ?? next.ios?.bundleId}.`;
    });
  };

  const checkStore = () =>
    run('check', async () => {
      const res = await api<AppStoreResponse>(`/apps/${app.id}/ios/app-store?refresh=1`);
      setStore(res);
      if ('app' in res && res.app) onChange(res.app);
      return null;
    });

  const removeIos = () =>
    run('remove', async () => {
      onChange(await api<AppView>(`/apps/${app.id}/ios`, { method: 'DELETE' }));
      setBundleId('');
      return 'iOS is off for this app; its certificate, profiles and App Store Connect key are deleted.';
    });

  const cert = ios?.certificate;
  const asc = ios?.appStore;
  const problems = app.iosProblems?.release ?? [];
  const highest = store && store.configured && 'highestBuild' in store ? store.highestBuild : null;

  return (
    <section id="ios" aria-labelledby={`ios-${app.id}`} className="panel overflow-hidden">
      <div className="border-b border-line px-5 py-4 md:px-6">
        <h2 id={`ios-${app.id}`} className="flex items-center gap-2 text-[16px] font-bold text-ink">
          <Smartphone size={17} aria-hidden className="text-muted" />
          iOS
        </h2>
        <p className="mt-1 max-w-[70ch] text-[13px] text-body">
          {ios
            ? 'iOS runs are planned here and built on a Mac runner: the tests, an IPA signed with this certificate and profile, then Fastlane to TestFlight or App Store review.'
            : 'Build and release the same Flutter project for iOS on a Mac runner (Runners page). Start with the bundle ID the app has on App Store Connect.'}
        </p>
      </div>

      <div className="space-y-6 px-5 py-5 md:px-6">
        <form onSubmit={saveBundle} className="space-y-2" autoComplete="off">
          <label className="label" htmlFor={`bundle-${app.id}`}>
            Bundle ID
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`bundle-${app.id}`}
              className="field min-w-0 flex-1 font-mono"
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder={app.packageName}
              spellCheck={false}
              required
            />
            <button type="submit" className={clsx('btn', ios ? 'btn-secondary' : 'btn-primary')} disabled={Boolean(busy) || !bundleId.trim() || bundleId.trim() === ios?.bundleId}>
              {busy === 'bundle' ? 'Saving…' : ios ? 'Change' : 'Build for iOS'}
            </button>
          </div>
          <p className="hint">PRODUCT_BUNDLE_IDENTIFIER of the Runner target in ios/Runner.xcodeproj; every run checks the project still builds it.</p>
        </form>

        {ios && (
          <>
            {problems.length > 0 && (
              <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
                {problems.map((p) => (
                  <li key={p} className="flex gap-3 px-4 py-3">
                    <CircleAlert size={16} strokeWidth={2.2} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
                    <p className="text-[13px] text-ink">{p}</p>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-3 border-t border-line pt-5">
              <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                <KeyRound size={15} aria-hidden className="text-muted" />
                Distribution certificate
              </h3>
              {cert && (
                <dl className="rounded-[var(--radius-card)] border border-line px-4 py-2">
                  <Fact term="Certificate">
                    <span title={cert.name}>{cert.name}</span>
                  </Fact>
                  <Fact term="Team" mono>
                    {cert.teamId ?? '?'}
                  </Fact>
                  <Fact term="SHA-1" mono>
                    <span title={cert.sha1}>{cert.sha1.slice(0, 20)}…</span>
                  </Fact>
                  <Fact term="Valid until">{day(cert.validUntil)}</Fact>
                  <Fact term="Stored">{ago(cert.uploadedAt)}</Fact>
                </dl>
              )}
              {cert && !replaceCert ? (
                <button type="button" className="btn btn-secondary" onClick={() => setReplaceCert(true)} disabled={Boolean(busy)}>
                  <Upload size={15} aria-hidden />
                  Replace certificate
                </button>
              ) : (
                <form onSubmit={saveCert} className="space-y-3" autoComplete="off">
                  <span className="label" id={`p12-${app.id}`}>
                    Certificate (.p12)
                  </span>
                  <FilePick
                    id={`p12-${app.id}`}
                    label="Choose the Apple Distribution .p12"
                    hint="Keychain Access → the certificate with its key → Export → .p12"
                    accept=".p12,.pfx,application/x-pkcs12"
                    file={p12}
                    onPick={setP12}
                    icon={KeyRound}
                  />
                  <div>
                    <label className="label" htmlFor={`p12pw-${app.id}`}>
                      .p12 password
                    </label>
                    <input id={`p12pw-${app.id}`} type="password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" className="btn btn-primary" disabled={Boolean(busy) || !p12 || !password}>
                      {busy === 'cert' ? 'Opening it…' : 'Check and store'}
                    </button>
                    {cert && (
                      <button type="button" className="btn btn-secondary" onClick={() => setReplaceCert(false)} disabled={Boolean(busy)}>
                        Keep the stored one
                      </button>
                    )}
                  </div>
                </form>
              )}
            </div>

            <div className="space-y-3 border-t border-line pt-5">
              <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                <FileBadge size={15} aria-hidden className="text-muted" />
                Provisioning profiles
              </h3>
              {ios.profiles.length > 0 ? (
                <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
                  {ios.profiles.map((p) => {
                    const expired = Date.parse(p.expiresAt) < Date.now();
                    const fits = p.type === 'app-store' && !expired && (!cert || p.certificates.includes(cert.sha1));
                    return (
                      <li key={p.uuid} className="flex items-start gap-3 px-4 py-3">
                        {fits ? (
                          <CircleCheck size={16} strokeWidth={2.2} aria-hidden className="mt-0.5 shrink-0" color="var(--color-ok)" />
                        ) : (
                          <CircleAlert size={16} strokeWidth={2.2} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-ink">{p.name}</p>
                          <p className="truncate font-mono text-[12px] text-muted">
                            {p.appId} · {p.type} · {expired ? 'expired' : 'until'} {day(p.expiresAt)}
                          </p>
                          {cert && !p.certificates.includes(cert.sha1) && <p className="text-[12px] text-body">Does not include the stored certificate.</p>}
                        </div>
                        <button type="button" className="btn btn-quiet h-9 w-9 shrink-0 p-0 text-fail-ink hover:bg-fail-wash" onClick={() => removeProfile(p.uuid, p.name)} disabled={Boolean(busy)} aria-label={`Remove ${p.name}`}>
                          <Trash2 size={15} aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[13px] text-body">None yet. Add the App Store profile of {ios.bundleId} (and of each app extension).</p>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => profileInput.current?.click()} disabled={Boolean(busy)}>
                <Upload size={15} aria-hidden />
                {busy === 'profile' ? 'Reading it…' : 'Add a profile'}
              </button>
              <input
                ref={profileInput}
                type="file"
                accept=".mobileprovision"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void addProfile(f);
                }}
              />
              <p className="hint">developer.apple.com → Profiles → + → App Store Connect, with the distribution certificate above. A renewed profile replaces the old one.</p>
            </div>

            <div className="space-y-3 border-t border-line pt-5">
              <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                <KeyRound size={15} aria-hidden className="text-muted" />
                App Store Connect API key
              </h3>
              {asc && (
                <dl className="rounded-[var(--radius-card)] border border-line px-4 py-2">
                  <Fact term="Key ID" mono>
                    {asc.keyId}
                  </Fact>
                  <Fact term="App">{asc.appName ? `${asc.appName}` : asc.message ? 'not found' : 'not checked yet'}</Fact>
                  {highest !== null && (
                    <Fact term="Highest build" mono>
                      {highest}
                    </Fact>
                  )}
                  {asc.checkedAt && <Fact term="Checked">{ago(asc.checkedAt)}</Fact>}
                </dl>
              )}
              {store && store.configured && store.error && <Notice tone="fail">{store.error}</Notice>}
              {asc && !replaceKey ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-quiet h-10" onClick={checkStore} disabled={Boolean(busy)}>
                    <RefreshCw size={15} aria-hidden className={busy === 'check' ? 'animate-spin' : undefined} />
                    Check again
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setReplaceKey(true)} disabled={Boolean(busy)}>
                    <Upload size={15} aria-hidden />
                    Replace key
                  </button>
                </div>
              ) : (
                <form onSubmit={saveKey} className="space-y-3" autoComplete="off">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="label" htmlFor={`kid-${app.id}`}>
                        Key ID
                      </label>
                      <input id={`kid-${app.id}`} className="field font-mono" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="AB12CD34EF" spellCheck={false} required />
                    </div>
                    <div>
                      <label className="label" htmlFor={`iss-${app.id}`}>
                        Issuer ID
                      </label>
                      <input id={`iss-${app.id}`} className="field font-mono" value={issuerId} onChange={(e) => setIssuerId(e.target.value)} placeholder="69a6de70-…" spellCheck={false} required />
                    </div>
                  </div>
                  <span className="label" id={`p8-${app.id}`}>
                    Key file (.p8)
                  </span>
                  <FilePick id={`p8-${app.id}`} label="Choose the AuthKey_….p8" hint="App Store Connect → Users and Access → Integrations → Team keys" accept=".p8" file={p8} onPick={setP8} icon={KeyRound} />
                  <p className="hint">A team key with the App Manager role reads the app and uploads its builds. The console finds the app by its bundle ID before storing anything.</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" className="btn btn-primary" disabled={Boolean(busy) || !p8 || !keyId.trim() || !issuerId.trim()}>
                      {busy === 'key' ? 'Asking App Store Connect…' : 'Check and store'}
                    </button>
                    {asc && (
                      <button type="button" className="btn btn-secondary" onClick={() => setReplaceKey(false)} disabled={Boolean(busy)}>
                        Keep the stored key
                      </button>
                    )}
                  </div>
                </form>
              )}
            </div>

            <div className="border-t border-line pt-4">
              <button type="button" className="btn btn-quiet h-10 text-fail-ink hover:bg-fail-wash" onClick={removeIos} disabled={Boolean(busy)}>
                <Trash2 size={15} aria-hidden />
                Turn iOS off for this app
              </button>
            </div>
          </>
        )}
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      </div>
    </section>
  );
}
