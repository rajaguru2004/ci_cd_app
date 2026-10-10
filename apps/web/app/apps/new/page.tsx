'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeft, CircleCheck, GitBranch, KeyRound, Search } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { ago, short } from '@/lib/format';
import type { AccessCheck, AppView, KeyRecord, ProjectInfo } from '@/lib/types';
import { KeyBlock } from '@/components/KeyBlock';
import { PlayPanel, SigningPanel } from '@/components/KeysPanels';
import { TopBar } from '@/components/TopBar';

type Step = 1 | 2 | 3 | 4;

const prettify = (name: string) => name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** One step of the flow, hung on the same spine as the commit rail: done, current, or ahead. */
function StepFrame({
  n,
  step,
  title,
  done,
  last = false,
  bare = false,
  onChange,
  children,
}: {
  n: Step;
  step: Step;
  title: string;
  done?: React.ReactNode;
  last?: boolean;
  /** Children are panels themselves: no frame around them. */
  bare?: boolean;
  onChange?: () => void;
  children: React.ReactNode;
}) {
  const state = step > n ? 'done' : step === n ? 'current' : 'ahead';
  return (
    <li className="relative grid grid-cols-[36px_minmax(0,1fr)] gap-x-4">
      {!last && <span aria-hidden className="absolute bottom-0 start-[17px] top-10 w-0.5 bg-line" />}
      <span className="relative flex h-9 w-9 items-center justify-center" aria-hidden>
        {state === 'done' ? (
          <CircleCheck size={26} strokeWidth={2.2} color="var(--color-ok)" className="rounded-full bg-page" />
        ) : (
          <span
            className={clsx(
              'flex h-8 w-8 items-center justify-center rounded-full border-2 bg-card text-[14px] font-bold tabular',
              state === 'current' ? 'border-brand text-brand' : 'border-idle text-muted',
            )}
          >
            {n}
          </span>
        )}
      </span>
      <section aria-labelledby={`step-${n}`} className={clsx('min-w-0 pb-8', state === 'ahead' && 'opacity-60')} aria-current={state === 'current' ? 'step' : undefined}>
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={`step-${n}`} className={clsx('text-[16px] font-bold', state === 'ahead' ? 'text-muted' : 'text-ink')}>
            {title}
          </h2>
          {state === 'done' && onChange && (
            <button type="button" className="text-[13px] font-medium text-brand underline" onClick={onChange}>
              Change
            </button>
          )}
        </div>
        {state === 'done' && done && <div className="mt-1 text-[13px] text-body">{done}</div>}
        {state === 'current' && <div className={bare ? 'mt-3' : 'panel mt-3 px-5 py-5 md:px-6'}>{children}</div>}
      </section>
    </li>
  );
}

export default function AddAppPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [keys, setKeys] = useState<KeyRecord[] | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [email, setEmail] = useState('');
  const [fresh, setFresh] = useState<KeyRecord | null>(null);
  const [url, setUrl] = useState('');
  const [access, setAccess] = useState<AccessCheck | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [noRepo, setNoRepo] = useState(false);
  const [name, setName] = useState('');
  const [packageName, setPackageName] = useState('');
  const [branch, setBranch] = useState('');
  const [path, setPath] = useState('');
  const [app, setApp] = useState<AppView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<KeyRecord[]>('/keys').then(
      (k) => {
        setKeys(k);
        setMaking(k.length === 0);
      },
      () => {
        setKeys([]);
        setMaking(true);
      },
    );
  }, []);

  const key = (keys ?? []).find((k) => k.id === keyId) ?? fresh;

  async function makeKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const k = await api<KeyRecord>('/keys', { method: 'POST', json: { email: email.trim() } });
      setFresh(k);
      setKeys((list) => [...(list ?? []), k]);
      setKeyId(k.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The key was not made.');
    } finally {
      setBusy(false);
    }
  }

  async function check(e: React.FormEvent) {
    e.preventDefault();
    if (!keyId) return;
    setBusy(true);
    setError(null);
    setAccess(null);
    setProject(null);
    try {
      const a = await api<AccessCheck>('/git/check', { method: 'POST', json: { url: url.trim(), keyId } });
      setAccess(a);
      const b = a.defaultBranch ?? a.branches[0] ?? 'main';
      setBranch(b);
      void inspect(a.url, b, '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The repository could not be checked.');
    } finally {
      setBusy(false);
    }
  }

  async function inspect(repoUrl: string, b: string, folder: string) {
    if (!keyId) return;
    setInspecting(true);
    setError(null);
    try {
      const p = await api<ProjectInfo>('/git/inspect', { method: 'POST', json: { url: repoUrl, keyId, branch: b, path: folder || undefined } });
      setProject(p);
      setName((n) => n || p.label || (p.name ? prettify(p.name) : ''));
      setPackageName((v) => v || p.applicationId || '');
      setPath(p.path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The project could not be read.');
    } finally {
      setInspecting(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<AppView>('/apps', {
        method: 'POST',
        json: {
          name: name.trim(),
          packageName: packageName.trim(),
          ...(noRepo || !access || !keyId ? {} : { repo: { url: access.url, keyId, branch, path } }),
        },
      });
      setApp(created);
      setStep(4);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The app was not created.');
    } finally {
      setBusy(false);
    }
  }

  const errorBox = error && (
    <p role="alert" className="mt-4 rounded-[var(--radius-control)] bg-fail-wash px-4 py-3 text-[13px] text-fail-ink">
      {error}
    </p>
  );

  return (
    <div className="min-h-svh">
      <TopBar />
      <main className="mx-auto max-w-[820px] px-4 pb-24 pt-6 md:px-6 md:pt-8">
        <Link href="/" className="btn btn-quiet -ms-2.5 mb-2">
          <ArrowLeft size={16} aria-hidden />
          Apps
        </Link>
        <h1 className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-ink">Add an app</h1>
        <p className="mt-1 max-w-[68ch] text-body">
          A Flutter app with its own repository. The console reaches the repository over SSH with a key it makes for you, and releases from it to Google Play.
        </p>

        <ol className="mt-8">
          <StepFrame
            n={1}
            step={step}
            title="Git access"
            onChange={() => setStep(1)}
            done={
              key && (
                <span className="flex flex-wrap items-center gap-x-2">
                  <KeyRound size={14} aria-hidden className="text-muted" />
                  <span>Key for {key.email}</span>
                  <span className="font-mono text-[12px] text-muted">{key.fingerprint.slice(0, 20)}…</span>
                </span>
              )
            }
          >
            {keys === null ? (
              <div className="h-24 animate-pulse rounded-[var(--radius-card)] bg-line-soft" aria-hidden />
            ) : (
              <div className="space-y-5">
                {keys.length > 0 && !fresh && (
                  <fieldset>
                    <legend className="label">Use a key you made before</legend>
                    <div className="space-y-2">
                      {keys.map((k) => (
                        <label
                          key={k.id}
                          className={clsx(
                            'flex min-h-14 cursor-pointer items-center gap-3 rounded-[var(--radius-card)] border px-4 py-2.5 transition-colors',
                            keyId === k.id && !making ? 'border-brand bg-brand-wash' : 'border-line hover:bg-line-soft/70',
                          )}
                        >
                          <input
                            type="radio"
                            name="key"
                            className="h-4 w-4 accent-[var(--color-brand)]"
                            checked={keyId === k.id && !making}
                            onChange={() => {
                              setKeyId(k.id);
                              setMaking(false);
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-ink">{k.email}</span>
                            <span className="block break-all font-mono text-[12px] text-muted">{k.fingerprint}</span>
                            <span className="block text-[12px] text-muted">
                              made {ago(k.createdAt)}
                              {k.lastUsedAt ? ` · last reached a repository ${ago(k.lastUsedAt)}` : ''}
                            </span>
                          </span>
                        </label>
                      ))}
                      <label
                        className={clsx(
                          'flex min-h-12 cursor-pointer items-center gap-3 rounded-[var(--radius-card)] border px-4 py-2.5 transition-colors',
                          making ? 'border-brand bg-brand-wash' : 'border-line hover:bg-line-soft/70',
                        )}
                      >
                        <input type="radio" name="key" className="h-4 w-4 accent-[var(--color-brand)]" checked={making} onChange={() => setMaking(true)} />
                        <span className="font-medium text-ink">Make a new key for my git email</span>
                      </label>
                    </div>
                  </fieldset>
                )}

                {making && !fresh && (
                  <form onSubmit={makeKey} className="space-y-3">
                    <div>
                      <label className="label" htmlFor="email">
                        Your git email
                      </label>
                      <input
                        id="email"
                        type="email"
                        className="field"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@company.com"
                        autoComplete="email"
                        required
                      />
                      <p className="hint">The email of the GitHub, GitLab or Bitbucket account that can open the repository. It becomes the key’s name, so you recognise it there.</p>
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
                      <KeyRound size={15} aria-hidden />
                      {busy ? 'Making the key…' : 'Make my SSH key'}
                    </button>
                  </form>
                )}

                {fresh && <KeyBlock sshKey={fresh} />}

                {errorBox}

                <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
                  <button type="button" className="btn btn-primary" disabled={!keyId || (making && !fresh)} onClick={() => setStep(2)}>
                    {fresh ? 'I’ve added it — next' : 'Next'}
                  </button>
                  {fresh && <span className="text-[13px] text-muted">The next step checks that it works.</span>}
                </div>
              </div>
            )}
          </StepFrame>

          <StepFrame
            n={2}
            step={step}
            title="Repository"
            onChange={() => setStep(2)}
            done={
              noRepo ? (
                'No repository: this app builds from uploaded ZIPs.'
              ) : access ? (
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className="font-mono">{access.host}/{access.slug}</span>
                  <span className="text-muted">· {access.branches.length} branches</span>
                </span>
              ) : null
            }
          >
            <form onSubmit={check} className="space-y-3">
              <div>
                <label className="label" htmlFor="url">
                  SSH URL
                </label>
                <input
                  id="url"
                  className="field font-mono"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setAccess(null);
                    setProject(null);
                  }}
                  placeholder="git@github.com:your-org/your-app.git"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <p className="hint">On GitHub: the repository → Code → SSH → copy.</p>
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>
                <Search size={15} aria-hidden />
                {busy ? 'Checking…' : 'Check access'}
              </button>
            </form>

            {access && (
              <div className="mt-5 space-y-3 border-t border-line pt-4">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink">
                  <CircleCheck size={17} strokeWidth={2.2} aria-hidden color="var(--color-ok)" />
                  <span className="font-semibold">The key reads {access.slug}</span>
                  <span className="text-[13px] text-muted">
                    on {access.hostLabel} · {access.branches.length} branches · default {access.defaultBranch ?? 'unknown'}
                  </span>
                </p>
                {access.hostKey && (
                  <p className="text-[12px] text-muted">
                    {access.hostKey.host} host key <span className="font-mono">{access.hostKey.type} {access.hostKey.fingerprint}</span>, held from now on.
                  </p>
                )}
                {inspecting && <p className="text-[13px] text-muted">Reading the app on {branch}…</p>}
                {project && (
                  <dl className="rounded-[var(--radius-card)] border border-line px-4 py-2 text-[13px]">
                    {[
                      ['Flutter project', `${project.name ?? 'unnamed'}${project.versionName ? ` ${project.versionName}${project.buildNumber ? `+${project.buildNumber}` : ''}` : ''}`],
                      ['Folder', project.path || '(repository root)'],
                      ['applicationId', project.applicationId ?? 'not found in the Gradle file'],
                      ['Shown as', project.label ?? '(from a string resource)'],
                      ['Signing', project.keyProperties ? 'android/key.properties is in the repository' : 'no key.properties: upload the keystore after this step'],
                      ['Tip of ' + branch, `${short(project.sha)} · ${project.commit.subject}`],
                    ].map(([term, value]) => (
                      <div key={term} className="flex items-baseline justify-between gap-4 py-1.5">
                        <dt className="shrink-0 text-[12px] text-muted">{term}</dt>
                        <dd className={clsx('min-w-0 truncate text-end text-ink', (term === 'applicationId' || term === 'Folder') && 'font-mono')}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}

            {errorBox}

            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!access || inspecting || !project}
                onClick={() => {
                  setNoRepo(false);
                  setError(null);
                  setStep(3);
                }}
              >
                Next
              </button>
              <button
                type="button"
                className="text-[13px] font-medium text-brand underline"
                onClick={() => {
                  setNoRepo(true);
                  setError(null);
                  setStep(3);
                }}
              >
                No SSH access? Build this app from uploaded ZIPs instead
              </button>
            </div>
          </StepFrame>

          <StepFrame
            n={3}
            step={step}
            title="The app"
            done={app && <span>{app.name} · <span className="font-mono">{app.packageName}</span></span>}
          >
            <form onSubmit={create} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="name">
                    Name
                  </label>
                  <input id="name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="FusionHRM" required maxLength={60} />
                </div>
                <div>
                  <label className="label" htmlFor="package">
                    Package (applicationId)
                  </label>
                  <input
                    id="package"
                    className="field font-mono"
                    value={packageName}
                    onChange={(e) => setPackageName(e.target.value)}
                    placeholder="com.company.app"
                    spellCheck={false}
                    required
                  />
                </div>
              </div>
              {!noRepo && access && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="branch">
                      Branch
                    </label>
                    <span className="relative flex items-center">
                      <GitBranch size={16} aria-hidden className="pointer-events-none absolute start-3 text-muted" />
                      <select
                        id="branch"
                        className="field ps-9"
                        value={branch}
                        onChange={(e) => {
                          setBranch(e.target.value);
                          void inspect(access.url, e.target.value, path);
                        }}
                      >
                        {access.branches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </span>
                    <p className="hint">Build and Release pull this branch.</p>
                  </div>
                  <div>
                    <label className="label" htmlFor="path">
                      Project folder
                    </label>
                    <input
                      id="path"
                      className="field font-mono"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      onBlur={() => void inspect(access.url, branch, path)}
                      placeholder="(repository root)"
                      spellCheck={false}
                    />
                  </div>
                </div>
              )}
              <p className="hint max-w-[70ch]">
                {noRepo
                  ? 'Without a repository, Build and Release ask for the source ZIP each time (GitHub → Code → Download ZIP). You can connect a repository later in the app’s settings.'
                  : 'Every run checks that the project still builds this package, so a release never goes to the wrong app.'}
              </p>
              {errorBox}
              <div className="border-t border-line pt-4">
                <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !packageName.trim()}>
                  {busy ? 'Creating…' : 'Create app'}
                </button>
              </div>
            </form>
          </StepFrame>

          <StepFrame n={4} step={step} title="Release keys" last bare>
            {app && (
              <div className="space-y-5">
                <p className="max-w-[70ch] text-body">
                  {app.name} is ready to build. A release needs the upload key (unless the repository signs itself) and a Google Play key; add them now or later in its
                  settings.
                </p>
                <SigningPanel app={app} onChange={setApp} />
                <PlayPanel app={app} onChange={setApp} />
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" className="btn btn-primary" onClick={() => router.push(`/apps/${app.id}`)}>
                    Open {app.name}
                  </button>
                </div>
              </div>
            )}
          </StepFrame>
        </ol>
      </main>
    </div>
  );
}
