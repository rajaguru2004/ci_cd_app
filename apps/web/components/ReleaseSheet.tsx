'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { ChevronDown, FileArchive, GitCommitHorizontal, TriangleAlert } from 'lucide-react';
import { api, ApiError, uploadForm } from '@/lib/api';
import { ago, bytes, short } from '@/lib/format';
import type { AppView, IosTrack, Mode, Platform, PlayTrack, RunnerKind, StartedRun, StartRunBody, StreamResponse } from '@/lib/types';
import { Sheet } from './Sheet';

const MAX_NOTES = 500;
/** TestFlight's "What to Test" takes 4000 characters. */
const MAX_IOS_NOTES = 4000;
const IOS_TRACKS: Array<{ value: IosTrack; label: string; hint: string }> = [
  { value: 'testflight', label: 'TestFlight', hint: 'internal testers, once Apple processes it' },
  { value: 'app_store', label: 'App Store review', hint: 'submitted to Apple for release' },
];
const TRACKS: Array<{ value: PlayTrack; hint: string }> = [
  { value: 'internal', hint: 'testers, minutes' },
  { value: 'alpha', hint: 'closed test' },
  { value: 'beta', hint: 'open test' },
  { value: 'production', hint: 'everyone' },
];

const MODES: Array<{ value: Mode; label: string; hint: string }> = [
  { value: 'build', label: 'Build and test', hint: 'Tests, then a signed AAB' },
  { value: 'release', label: 'Release', hint: 'All of that, then Google Play' },
];

type Source = 'tip' | 'commit' | 'zip';

/** A commit the sheet was opened on (from the commit stream). */
export interface PickedCommit {
  sha: string;
  subject: string;
}

/**
 * Build or Release one app: git pull on its branch (or one commit), tests, a signed AAB, and
 * for a release Google Play. Or the same pipeline for a source ZIP.
 */
export function ReleaseSheet({
  open,
  onClose,
  app,
  initialMode = 'release',
  initialPlatform = 'android',
  commit = null,
  branch,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  app: AppView | null;
  initialMode?: Mode;
  /** The platform the sheet opens on (an app without iOS only ever builds Android). */
  initialPlatform?: Platform;
  commit?: PickedCommit | null;
  /** The branch being looked at; the app's own branch otherwise. */
  branch?: string | null;
  onStarted: (run: StartedRun) => void;
}) {
  const hasRepo = Boolean(app?.repo);
  const hasIos = Boolean(app?.ios);
  const [platform, setPlatform] = useState<Platform>('android');
  const ios = platform === 'ios';
  const canChooseRunner = Boolean(app?.runner.github) && !ios;
  const [source, setSource] = useState<Source>('tip');
  const [runner, setRunner] = useState<Exclude<RunnerKind, 'mac'> | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [track, setTrack] = useState<PlayTrack>('internal');
  const [iosTrack, setIosTrack] = useState<IosTrack>('testflight');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'completed' | 'draft'>('completed');
  const [versionName, setVersionName] = useState('');
  const [rehearsal, setRehearsal] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<{ sha: string; subject: string; date: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const targetBranch = branch || app?.repo?.branch || 'main';

  useEffect(() => {
    if (!open || !app) return;
    setMode(initialMode);
    setPlatform(initialPlatform === 'ios' && app.ios ? 'ios' : 'android');
    setSource(commit ? 'commit' : hasRepo ? 'tip' : 'zip');
    setRunner(app.runner.kind);
    setError(null);
    setProgress(null);
    setTip(null);
    if (!hasRepo) return;
    // What "latest" is right now (the run pulls again when it starts).
    api<StreamResponse>(`/apps/${app.id}/stream?branch=${encodeURIComponent(targetBranch)}`)
      .then((s) => setTip(s.commits[0] ? { sha: s.commits[0].sha, subject: s.commits[0].subject, date: s.commits[0].date } : null))
      .catch(() => setTip(null));
  }, [open, app, initialMode, initialPlatform, commit, hasRepo, targetBranch]);

  const notesLeft = (ios ? MAX_IOS_NOTES : MAX_NOTES) - notes.trim().length;
  const iosBlockers = ios ? (app?.iosProblems?.[mode] ?? []) : [];
  const needsNotes = mode === 'release' && notes.trim().length === 0;
  const name = app?.name ?? 'the app';
  const what = source === 'zip' ? 'The ZIP' : source === 'commit' && commit ? `Commit ${short(commit.sha)}` : `The latest ${targetBranch}`;

  const iosTarget = IOS_TRACKS.find((t) => t.value === iosTrack)!.label;
  const action = useMemo(() => {
    if (mode === 'release') return `${rehearsal ? 'Rehearse release' : 'Release'} to ${ios ? iosTarget : track}`;
    return source === 'zip' ? (ios ? 'Upload and build for iOS' : 'Upload and build') : ios ? 'Build for iOS' : 'Build';
  }, [mode, track, rehearsal, source, ios, iosTarget]);

  const onGithub = canChooseRunner && source !== 'zip' && runner === 'github';
  const where = onGithub ? ` on ${app?.runner.github?.repo}'s GitHub Actions` : '';
  const summary = ios
    ? mode === 'release'
      ? rehearsal
        ? `${what}: planned here, then a Mac runs the tests, builds and signs the IPA, and App Store Connect validates it. Nothing is uploaded.`
        : `${what}: planned here, then a Mac runs the tests, builds and signs the IPA, and Fastlane uploads it to ${iosTrack === 'app_store' ? `TestFlight and submits it for App Store review${status === 'draft' ? ' (you release it once approved)' : ' (released once approved)'}` : 'TestFlight'}.`
      : `${what}: planned here, then a Mac runs the tests and builds a signed IPA you can download. Nothing goes to App Store Connect.`
    : mode === 'release'
      ? rehearsal
        ? `${what}: tests, a signed AAB${where}, then Google Play validates the whole ${track} release. Nothing is published.`
        : `${what}: tests, a signed AAB${where}, then Fastlane uploads it to the ${track} track${status === 'draft' ? ' as a draft for review in Play Console' : ' and rolls it out'}.`
      : `${what}: tests, then a signed AAB${where} you can download. Nothing goes to Google Play.`;

  function pick(f: File | undefined | null) {
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) {
      setError(`${f.name} is not a ZIP. On GitHub use Code → Download ZIP.`);
      return;
    }
    setError(null);
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!app || needsNotes || notesLeft < 0) return;
    setBusy(true);
    setError(null);
    try {
      let res: StartedRun;
      if (source === 'zip') {
        if (!file) throw new ApiError('Choose the source ZIP first.', 400);
        const form = new FormData();
        form.append('app', app.id);
        form.append('platform', platform);
        form.append('mode', mode);
        if (mode === 'release') {
          form.append('track', ios ? iosTrack : track);
          form.append('releaseNotes', notes.trim());
          form.append('releaseStatus', status);
          if (rehearsal) form.append('rehearsal', 'true');
        }
        if (versionName.trim()) form.append('versionName', versionName.trim());
        form.append('source', file, file.name);
        setProgress(0);
        res = await uploadForm<StartedRun>('/runs/upload', form, setProgress);
        setFile(null);
      } else {
        const body: StartRunBody = {
          platform,
          mode,
          branch: targetBranch,
          ...(canChooseRunner && runner ? { runner } : {}),
          ...(source === 'commit' && commit ? { sha: commit.sha } : {}),
          ...(mode === 'release' ? { track: ios ? iosTrack : track, releaseNotes: notes.trim(), releaseStatus: status, ...(rehearsal ? { rehearsal: true } : {}) } : {}),
          ...(versionName.trim() ? { versionName: versionName.trim() } : {}),
        };
        res = await api<StartedRun>(`/apps/${app.id}/runs`, { method: 'POST', json: body });
      }
      setNotes('');
      onStarted(res);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The run did not start.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const uploading = progress !== null;
  const disabled = !app || busy || needsNotes || notesLeft < 0 || (source === 'zip' && !file) || iosBlockers.length > 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={mode === 'release' ? `Release ${name}${ios ? ' for iOS' : ''}` : `Build ${name}${ios ? ' for iOS' : ''}`}
      description={
        ios
          ? `${hasRepo ? `git pull on ${targetBranch} here` : 'An uploaded source ZIP'}, then a Mac runner: the tests, a signed IPA${mode === 'release' ? ' and App Store Connect' : ''}.`
          : hasRepo
            ? `git pull on ${targetBranch}, then the tests, a signed AAB${mode === 'release' ? ' and Google Play' : ''}, on this server.`
            : 'This app has no repository connected: upload its source ZIP and the same pipeline runs on this server.'
      }
      footer={
        <div className="flex flex-col gap-3">
          <p className="max-w-[68ch] text-[13px] text-muted">{summary}</p>
          <div className="flex gap-2 sm:justify-end">
            <button type="button" className="btn btn-secondary flex-1 sm:flex-none" onClick={onClose} disabled={uploading}>
              Cancel
            </button>
            <button type="submit" form="start-run" className="btn btn-primary h-12 flex-1 sm:h-10 sm:flex-none" disabled={disabled}>
              {uploading ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : busy ? 'Starting…' : action}
            </button>
          </div>
        </div>
      }
    >
      <form id="start-run" onSubmit={submit} className="space-y-6">
        {app?.repo?.access.state === 'failed' && source !== 'zip' && (
          <div role="alert" className="flex gap-3 rounded-[var(--radius-control)] bg-warn-wash px-4 py-3 text-[13px] text-ink">
            <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <p>
              <span className="font-semibold">The last pull failed, so this run would stop at Checkout.</span> {app.repo.access.message} Upload a ZIP instead, or fix
              the key first.
            </p>
          </div>
        )}

        {hasIos && (
          <fieldset>
            <legend className="label">Platform</legend>
            <div className="seg flex-col sm:flex-row">
              <label>
                <input type="radio" name="platform" checked={platform === 'android'} onChange={() => setPlatform('android')} />
                <span>Android</span>
                <span className="text-[12px] font-normal text-muted">AAB → Google Play</span>
              </label>
              <label>
                <input type="radio" name="platform" checked={platform === 'ios'} onChange={() => setPlatform('ios')} />
                <span>iOS</span>
                <span className="text-[12px] font-normal text-muted">IPA on a Mac → App Store Connect</span>
              </label>
            </div>
          </fieldset>
        )}

        {iosBlockers.length > 0 && (
          <div role="alert" className="flex gap-3 rounded-[var(--radius-control)] bg-warn-wash px-4 py-3 text-[13px] text-ink">
            <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <p>
              <span className="font-semibold">{iosBlockers[0]}</span>{' '}
              <Link href={`/apps/${app?.id}/settings#ios`} className="font-medium text-brand underline">
                iOS settings
              </Link>
            </p>
          </div>
        )}

        <fieldset>
          <legend className="label">What to run</legend>
          <div className="seg flex-col sm:flex-row">
            {MODES.map((m) => (
              <label key={m.value}>
                <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
                <span className="text-[14px]">{m.label}</span>
                <span className="text-[12px] font-normal text-muted">{ios ? (m.value === 'build' ? 'Tests, then a signed IPA' : 'All of that, then App Store Connect') : m.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="label">Source</legend>
          <div className="seg flex-col sm:flex-row">
            {hasRepo && (
              <label>
                <input type="radio" name="source" checked={source === 'tip'} onChange={() => setSource('tip')} />
                <span>Latest on {targetBranch}</span>
                <span className="truncate text-[12px] font-normal text-muted">{tip ? `${short(tip.sha)} · ${tip.subject}` : 'pulled when the run starts'}</span>
              </label>
            )}
            {hasRepo && commit && (
              <label>
                <input type="radio" name="source" checked={source === 'commit'} onChange={() => setSource('commit')} />
                <span className="flex items-center gap-1.5">
                  <GitCommitHorizontal size={14} aria-hidden />
                  <span className="font-mono">{short(commit.sha)}</span>
                </span>
                <span className="truncate text-[12px] font-normal text-muted">{commit.subject}</span>
              </label>
            )}
            <label>
              <input type="radio" name="source" checked={source === 'zip'} onChange={() => setSource('zip')} />
              <span>Upload a source ZIP</span>
              <span className="text-[12px] font-normal text-muted">{ios ? 'Unpacked here, built on a Mac' : 'Unpacked and built here'}</span>
            </label>
          </div>
          {source === 'tip' && tip && <p className="hint">Newest commit {ago(tip.date)}. The run pulls {targetBranch} again as it starts and builds its tip.</p>}
        </fieldset>

        {canChooseRunner && source !== 'zip' && (
          <fieldset>
            <legend className="label">Runs on</legend>
            <div className="seg flex-col sm:flex-row">
              <label>
                <input type="radio" name="runner" checked={runner === 'server'} onChange={() => setRunner('server')} />
                <span>This server</span>
                <span className="text-[12px] font-normal text-muted">The usual way</span>
              </label>
              <label>
                <input type="radio" name="runner" checked={runner === 'github'} onChange={() => setRunner('github')} />
                <span>GitHub Actions</span>
                <span className="font-mono text-[12px] font-normal text-muted">{app?.runner.github?.repo}</span>
              </label>
            </div>
          </fieldset>
        )}

        {source === 'zip' && (
          <div>
            <span className="label" id="zip-label">
              Source ZIP
            </span>
            <label
              aria-labelledby="zip-label"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pick(e.dataTransfer.files?.[0]);
              }}
              className={clsx(
                'flex min-h-24 cursor-pointer items-center gap-4 rounded-[var(--radius-card)] border border-dashed px-4 py-4 transition-colors',
                dragging ? 'border-brand bg-brand-wash' : file ? 'border-line bg-card' : 'border-idle bg-page hover:border-brand',
              )}
            >
              <FileArchive size={28} aria-hidden className={file ? 'text-brand' : 'text-muted'} />
              <span className="min-w-0 flex-1">
                {file ? (
                  <>
                    <span className="block truncate font-medium text-ink">{file.name}</span>
                    <span className="block text-[12px] text-muted">{bytes(file.size)} · choose another</span>
                  </>
                ) : (
                  <>
                    <span className="block font-medium text-ink">Drop the ZIP here, or choose it</span>
                    <span className="block text-[12px] text-muted">On GitHub: the repository → Code → Download ZIP</span>
                  </>
                )}
              </span>
              <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                className="sr-only"
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            {uploading && (
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)} aria-label="Upload progress">
                <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
              </div>
            )}
            <p className="hint">The commit GitHub writes into the ZIP puts the run on that commit.</p>
          </div>
        )}

        {mode === 'release' && ios && (
          <>
            <fieldset>
              <legend className="label">App Store Connect</legend>
              <div className="seg flex-col sm:flex-row">
                {IOS_TRACKS.map((t) => (
                  <label key={t.value}>
                    <input type="radio" name="ios-track" checked={iosTrack === t.value} onChange={() => setIosTrack(t.value)} />
                    <span className={t.value === 'app_store' ? 'text-ship-ink' : undefined}>{t.label}</span>
                    <span className="text-[12px] font-normal text-muted">{t.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label className="label" htmlFor="notes">
                What to Test
              </label>
              <textarea
                id="notes"
                className="field"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Faster check-in, and payslips now open offline."
                aria-invalid={notesLeft < 0}
                aria-describedby="notes-hint"
              />
              <p id="notes-hint" className={`hint flex justify-between gap-4 ${notesLeft < 0 ? 'text-fail-ink' : ''}`}>
                <span>Shown to testers on TestFlight (en-US).{iosTrack === 'app_store' ? ' The App Store’s “What’s New” is written in App Store Connect.' : ''}</span>
                <span className="tabular shrink-0">{notesLeft} left</span>
              </p>
            </div>

            {iosTrack === 'app_store' && (
              <fieldset>
                <legend className="label">Once Apple approves it</legend>
                <div className="seg flex-col sm:flex-row">
                  <label>
                    <input type="radio" name="status" checked={status === 'completed'} onChange={() => setStatus('completed')} />
                    <span>Release automatically</span>
                    <span className="text-[12px] font-normal text-muted">On the App Store as soon as it is approved</span>
                  </label>
                  <label>
                    <input type="radio" name="status" checked={status === 'draft'} onChange={() => setStatus('draft')} />
                    <span>Release by hand</span>
                    <span className="text-[12px] font-normal text-muted">You release it from App Store Connect</span>
                  </label>
                </div>
              </fieldset>
            )}

            <label className="flex min-h-11 items-start gap-3">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-brand)]" checked={rehearsal} onChange={(e) => setRehearsal(e.target.checked)} />
              <span>
                <span className="font-medium text-ink">Rehearsal only</span>
                <span className="block text-[12px] text-muted">
                  App Store Connect validates the signed IPA (signature, profile, bundle ID, version, build number) and keeps nothing. Nothing is uploaded.
                </span>
              </span>
            </label>
          </>
        )}

        {mode === 'release' && !ios && (
          <>
            <fieldset>
              <legend className="label">Google Play track</legend>
              <div className="seg flex-wrap">
                {TRACKS.map((t) => (
                  <label key={t.value} className="min-w-[45%] sm:min-w-0">
                    <input type="radio" name="track" value={t.value} checked={track === t.value} onChange={() => setTrack(t.value)} />
                    <span className={t.value === 'production' ? 'text-ship-ink' : undefined}>{t.value}</span>
                    <span className="text-[12px] font-normal text-muted">{t.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label className="label" htmlFor="notes">
                What&apos;s new
              </label>
              <textarea
                id="notes"
                className="field"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Faster check-in, and payslips now open offline."
                aria-invalid={notesLeft < 0}
                aria-describedby="notes-hint"
              />
              <p id="notes-hint" className={`hint flex justify-between gap-4 ${notesLeft < 0 ? 'text-fail-ink' : ''}`}>
                <span>Shown on Google Play under &quot;What&apos;s new&quot; (en-US).</span>
                <span className="tabular shrink-0">{notesLeft} left</span>
              </p>
            </div>

            <fieldset>
              <legend className="label">After the upload</legend>
              <div className="seg flex-col sm:flex-row">
                <label>
                  <input type="radio" name="status" checked={status === 'completed'} onChange={() => setStatus('completed')} />
                  <span>Roll out</span>
                  <span className="text-[12px] font-normal text-muted">Live on the track when Play finishes review</span>
                </label>
                <label>
                  <input type="radio" name="status" checked={status === 'draft'} onChange={() => setStatus('draft')} />
                  <span>Keep as draft</span>
                  <span className="text-[12px] font-normal text-muted">You publish it from Play Console</span>
                </label>
              </div>
            </fieldset>

            <label className="flex min-h-11 items-start gap-3">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-brand)]" checked={rehearsal} onChange={(e) => setRehearsal(e.target.checked)} />
              <span>
                <span className="font-medium text-ink">Rehearsal only</span>
                <span className="block text-[12px] text-muted">
                  Google Play checks the key, the signature, the version code and the notes, then discards the upload. Nothing is published.
                </span>
              </span>
            </label>
          </>
        )}

        <details className="group rounded-[var(--radius-card)] border border-line">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-[14px] font-medium text-ink">
            More options
            <ChevronDown size={16} aria-hidden className="text-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-5 border-t border-line px-4 py-4">
            <div>
              <label className="label" htmlFor="version">
                Version name
              </label>
              <input
                id="version"
                className="field font-mono"
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
                placeholder="from pubspec.yaml"
                inputMode="decimal"
                pattern="\d+\.\d+\.\d+"
              />
              <p className="hint">
                {ios
                  ? 'MAJOR.MINOR.PATCH. The build number is picked when the run starts: above everything on App Store Connect and every iOS build of this app here.'
                  : 'MAJOR.MINOR.PATCH. The version code is picked when the run starts: above everything on Google Play and every build of this app here.'}
              </p>
            </div>
          </div>
        </details>

        {error && (
          <p role="alert" className="rounded-[var(--radius-control)] bg-fail-wash px-4 py-3 text-fail-ink">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
