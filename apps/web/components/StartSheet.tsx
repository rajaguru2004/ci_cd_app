'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, FileArchive, TriangleAlert } from 'lucide-react';
import { api, ApiError, uploadForm } from '@/lib/api';
import { bytes } from '@/lib/format';
import type { Mode, PlayTrack, StartRunBody } from '@/lib/types';
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
  { value: 'validate', label: 'Check Play access', hint: 'Fastlane reads Play; nothing is built' },
];

export type Source = 'github' | 'upload';

export interface StartedRun {
  runId: number | null;
  requestId: string;
  url: string | null;
  /** The branch, or the ZIP's file name for an upload. */
  branch: string;
}

export function StartSheet({
  open,
  onClose,
  defaultBranch,
  onStarted,
  initialMode = 'build',
  blocked = null,
  uploadsEnabled = true,
}: {
  open: boolean;
  onClose: () => void;
  defaultBranch: string;
  onStarted: (run: StartedRun) => void;
  initialMode?: Mode;
  /** Why GitHub runs cannot start right now (e.g. no token); uploads still can. */
  blocked?: string | null;
  /** Whether this console has a builder for uploaded ZIPs. */
  uploadsEnabled?: boolean;
}) {
  const [source, setSource] = useState<Source>('github');
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(defaultBranch);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [track, setTrack] = useState<PlayTrack>('internal');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'completed' | 'draft'>('completed');
  const [versionName, setVersionName] = useState('');
  const [integration, setIntegration] = useState(false);
  const [rehearsal, setRehearsal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setBranch(defaultBranch);
    // Without a GitHub token the upload is the only way in; start there.
    setSource(blocked && uploadsEnabled ? 'upload' : 'github');
    setMode(initialMode);
    setError(null);
    setProgress(null);
    if (blocked) return;
    api<{ defaultBranch: string; branches: string[] }>('/branches')
      .then((b) => setBranches(b.branches))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not list branches.'));
  }, [open, defaultBranch, initialMode, blocked, uploadsEnabled]);

  // A ZIP build has no Play access check: that one needs no build, so it stays on GitHub.
  const modes = source === 'upload' ? MODES.filter((m) => m.value !== 'validate') : MODES;
  useEffect(() => {
    if (source === 'upload' && mode === 'validate') setMode('build');
  }, [source, mode]);

  const notesLeft = MAX_NOTES - notes.trim().length;
  const needsNotes = mode === 'release' && notes.trim().length === 0;
  const githubBlocked = source === 'github' && Boolean(blocked);
  // The file name is already on the drop zone; a long one would crowd the summary.
  const what = source === 'upload' ? 'The ZIP' : branch;
  const where = source === 'upload' ? 'on this server' : 'on GitHub Actions';

  const action = useMemo(() => {
    if (mode === 'validate') return 'Check Play access';
    if (mode === 'release') return `${rehearsal ? 'Rehearse release' : 'Release'} to ${track}`;
    return source === 'upload' ? 'Upload and build' : 'Start build';
  }, [mode, track, rehearsal, source]);

  const summary =
    mode === 'validate'
      ? `Runs Fastlane against Google Play with the stored key and reads every track's version codes. Nothing is built or uploaded.`
      : mode === 'release'
        ? rehearsal
          ? `${what}, ${where}: analysis and tests, a signed AAB, then Google Play validates the whole ${track} release. Nothing is published.`
          : `${what}, ${where}: analysis and tests, a signed AAB, then Fastlane uploads it to the ${track} track${status === 'draft' ? ' as a draft for review in Play Console' : ' and rolls it out'}.`
        : `${what}, ${where}: analysis and tests, then a signed AAB you can download. Nothing goes to Google Play.`;

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
    if (needsNotes || notesLeft < 0) return;
    setBusy(true);
    setError(null);
    try {
      if (source === 'upload') {
        if (!file) throw new ApiError('Choose the source ZIP first.', 400);
        const form = new FormData();
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
        const res = await uploadForm<{ runId: number; requestId: string; url: null }>('/runs/upload', form, setProgress);
        onStarted({ ...res, branch: file.name });
        setFile(null);
      } else {
        const body: StartRunBody = {
          branch,
          mode,
          ...(mode === 'release' ? { track, releaseNotes: notes.trim(), releaseStatus: status, ...(rehearsal ? { rehearsal: true } : {}) } : {}),
          ...(versionName.trim() ? { versionName: versionName.trim() } : {}),
          ...(mode !== 'validate' && integration ? { integrationTests: true } : {}),
        };
        const res = await api<{ runId: number | null; requestId: string; url: string | null }>('/runs', { method: 'POST', json: body });
        onStarted({ ...res, branch });
      }
      setNotes('');
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The run did not start.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const uploading = progress !== null;
  const disabled = githubBlocked || busy || needsNotes || notesLeft < 0 || (source === 'github' ? !branch : !file);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Start a pipeline run"
      description="The same pipeline either way: on GitHub Actions from a branch, or on this server from a source ZIP."
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-[13px] text-muted">{summary}</p>
          <div className="flex gap-2">
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
        {uploadsEnabled && (
          <fieldset>
            <legend className="label">Source</legend>
            <div className="seg flex-col sm:flex-row">
              <label>
                <input type="radio" name="source" checked={source === 'github'} onChange={() => setSource('github')} />
                <span>GitHub branch</span>
                <span className="text-[12px] font-normal text-muted">Runs on GitHub Actions</span>
              </label>
              <label>
                <input type="radio" name="source" checked={source === 'upload'} onChange={() => setSource('upload')} />
                <span>Upload a source ZIP</span>
                <span className="text-[12px] font-normal text-muted">Unpacked and built on this server</span>
              </label>
            </div>
          </fieldset>
        )}

        {githubBlocked && (
          <div role="alert" className="flex gap-3 rounded-[var(--radius-control)] bg-warn-wash px-4 py-3 text-[13px] text-ink">
            <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <div>
              <p className="font-semibold text-ink">GitHub runs cannot start yet</p>
              <p className="mt-1">{blocked}</p>
              {uploadsEnabled && <p className="mt-1">Uploading a source ZIP works without it.</p>}
              <a href="/setup" className="mt-2 inline-block font-semibold text-brand underline">
                Open Setup
              </a>
            </div>
          </div>
        )}

        {source === 'github' ? (
          <div>
            <label className="label" htmlFor="branch">
              Branch
            </label>
            <select id="branch" className="field" value={branch} onChange={(e) => setBranch(e.target.value)}>
              {(branches ?? [defaultBranch]).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <p className="hint">The branch must contain .github/workflows/release.yml; main does once the pipeline is pushed.</p>
          </div>
        ) : (
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
                'flex min-h-24 cursor-pointer items-center gap-4 rounded-[var(--radius-card)] border border-dashed px-4 py-4 transition-colors duration-200',
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
                    <span className="block text-[12px] text-muted">On GitHub: the mobile repository → Code → Download ZIP</span>
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
            <p className="hint">The console unpacks it on this server and runs the same stages as release.yml. The commit GitHub names inside the ZIP puts the run on that commit.</p>
          </div>
        )}

        <fieldset>
          <legend className="label">What to run</legend>
          <div className="seg flex-col sm:flex-row">
            {modes.map((m) => (
              <label key={m.value}>
                <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
                <span className="text-[14px]">{m.label}</span>
                <span className="text-[12px] font-normal text-muted">{m.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

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
                  Google Play checks the key, the signature, the version code and the notes, then discards the upload. Nothing is
                  published.
                </span>
              </span>
            </label>
          </>
        )}

        {mode !== 'validate' && (
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
                <p className="hint">MAJOR.MINOR.PATCH. The console picks the version code: above everything on Google Play.</p>
              </div>
              {source === 'github' && (
                <label className="flex min-h-11 items-start gap-3">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-brand)]" checked={integration} onChange={(e) => setIntegration(e.target.checked)} />
                  <span>
                    <span className="font-medium text-ink">Run the emulator smoke suite too</span>
                    <span className="block text-[12px] text-muted">The Tier 0 flows on an Android 14 emulator; adds 15–30 minutes.</span>
                  </span>
                </label>
              )}
            </div>
          </details>
        )}

        {error && (
          <p role="alert" className="rounded-[var(--radius-control)] bg-fail-wash px-4 py-3 text-fail-ink">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
