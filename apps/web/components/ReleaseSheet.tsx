'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, FileArchive, GitCommitHorizontal, TriangleAlert } from 'lucide-react';
import { api, ApiError, uploadForm } from '@/lib/api';
import { ago, bytes, short } from '@/lib/format';
import type { AppView, Mode, PlayTrack, RunnerKind, StartedRun, StartRunBody, StreamResponse } from '@/lib/types';
import { Sheet } from './Sheet';

const MAX_NOTES = 500;
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
  commit = null,
  branch,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  app: AppView | null;
  initialMode?: Mode;
  commit?: PickedCommit | null;
  /** The branch being looked at; the app's own branch otherwise. */
  branch?: string | null;
  onStarted: (run: StartedRun) => void;
}) {
  const hasRepo = Boolean(app?.repo);
  const canChooseRunner = Boolean(app?.runner.github);
  const [source, setSource] = useState<Source>('tip');
  const [runner, setRunner] = useState<RunnerKind | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [track, setTrack] = useState<PlayTrack>('internal');
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
  }, [open, app, initialMode, commit, hasRepo, targetBranch]);

  const notesLeft = MAX_NOTES - notes.trim().length;
  const needsNotes = mode === 'release' && notes.trim().length === 0;
  const name = app?.name ?? 'the app';
  const what = source === 'zip' ? 'The ZIP' : source === 'commit' && commit ? `Commit ${short(commit.sha)}` : `The latest ${targetBranch}`;

  const action = useMemo(() => {
    if (mode === 'release') return `${rehearsal ? 'Rehearse release' : 'Release'} to ${track}`;
    return source === 'zip' ? 'Upload and build' : 'Build';
  }, [mode, track, rehearsal, source]);

  const onGithub = canChooseRunner && source !== 'zip' && runner === 'github';
  const where = onGithub ? ` on ${app?.runner.github?.repo}'s GitHub Actions` : '';
  const summary =
    mode === 'release'
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
        form.append('mode', mode);
        if (mode === 'release') {
          form.append('track', track);
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
          mode,
          branch: targetBranch,
          ...(canChooseRunner && runner ? { runner } : {}),
          ...(source === 'commit' && commit ? { sha: commit.sha } : {}),
          ...(mode === 'release' ? { track, releaseNotes: notes.trim(), releaseStatus: status, ...(rehearsal ? { rehearsal: true } : {}) } : {}),
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
  const disabled = !app || busy || needsNotes || notesLeft < 0 || (source === 'zip' && !file);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={mode === 'release' ? `Release ${name}` : `Build ${name}`}
      description={
        hasRepo
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

        <fieldset>
          <legend className="label">What to run</legend>
          <div className="seg flex-col sm:flex-row">
            {MODES.map((m) => (
              <label key={m.value}>
                <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
                <span className="text-[14px]">{m.label}</span>
                <span className="text-[12px] font-normal text-muted">{m.hint}</span>
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
              <span className="text-[12px] font-normal text-muted">Unpacked and built here</span>
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

        {mode === 'release' && (
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
              <p className="hint">MAJOR.MINOR.PATCH. The version code is picked when the run starts: above everything on Google Play and every build of this app here.</p>
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
