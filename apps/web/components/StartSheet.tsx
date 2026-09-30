'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
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

export interface StartedRun {
  runId: number | null;
  requestId: string;
  url: string | null;
  branch: string;
}

export function StartSheet({
  open,
  onClose,
  defaultBranch,
  onStarted,
  initialMode = 'build',
  blocked = null,
}: {
  open: boolean;
  onClose: () => void;
  defaultBranch: string;
  onStarted: (run: StartedRun) => void;
  initialMode?: Mode;
  /** Why nothing can start right now (e.g. no GitHub token); shown first, and the submit is off. */
  blocked?: string | null;
}) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(defaultBranch);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [track, setTrack] = useState<PlayTrack>('internal');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'completed' | 'draft'>('completed');
  const [versionName, setVersionName] = useState('');
  const [integration, setIntegration] = useState(false);
  const [rehearsal, setRehearsal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBranch(defaultBranch);
    setMode(initialMode);
    setError(null);
    if (blocked) return;
    api<{ defaultBranch: string; branches: string[] }>('/branches')
      .then((b) => setBranches(b.branches))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not list branches.'));
  }, [open, defaultBranch, initialMode, blocked]);

  const notesLeft = MAX_NOTES - notes.trim().length;
  const needsNotes = mode === 'release' && notes.trim().length === 0;

  const action = useMemo(() => {
    if (mode === 'validate') return 'Check Play access';
    if (mode === 'release') return `${rehearsal ? 'Rehearse release' : 'Release'} to ${track}`;
    return 'Start build';
  }, [mode, track, rehearsal]);

  const summary =
    mode === 'validate'
      ? `Runs Fastlane against Google Play with the stored key and reads every track's version codes. Nothing is built or uploaded.`
      : mode === 'release'
        ? rehearsal
          ? `${branch}: analysis and tests, a signed AAB, then Google Play validates the whole ${track} release. Nothing is published.`
          : `${branch}: analysis and tests, a signed AAB, then Fastlane uploads it to the ${track} track${status === 'draft' ? ' as a draft for review in Play Console' : ' and rolls it out'}.`
        : `${branch}: analysis and tests, then a signed AAB you can download. Nothing goes to Google Play.`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (needsNotes || notesLeft < 0) return;
    setBusy(true);
    setError(null);
    const body: StartRunBody = {
      branch,
      mode,
      ...(mode === 'release' ? { track, releaseNotes: notes.trim(), releaseStatus: status, ...(rehearsal ? { rehearsal: true } : {}) } : {}),
      ...(versionName.trim() ? { versionName: versionName.trim() } : {}),
      ...(mode !== 'validate' && integration ? { integrationTests: true } : {}),
    };
    try {
      const res = await api<{ runId: number | null; requestId: string; url: string | null }>('/runs', {
        method: 'POST',
        json: body,
      });
      onStarted({ ...res, branch });
      setNotes('');
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The run did not start.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Start a pipeline run"
      description="Runs release.yml on GitHub Actions, the same pipeline a release commit or a v-tag starts."
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-[13px] text-muted">{summary}</p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary flex-1 sm:flex-none" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              form="start-run"
              className="btn btn-primary h-12 flex-1 sm:h-10 sm:flex-none"
              disabled={Boolean(blocked) || busy || needsNotes || notesLeft < 0 || !branch}
            >
              {busy ? 'Starting…' : action}
            </button>
          </div>
        </div>
      }
    >
      <form id="start-run" onSubmit={submit} className="space-y-6">
        {blocked && (
          <div role="alert" className="flex gap-3 rounded-[var(--radius-control)] bg-warn-wash px-4 py-3 text-[13px] text-ink">
            <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" color="var(--color-warn)" />
            <div>
              <p className="font-semibold text-ink">Nothing can start yet</p>
              <p className="mt-1">{blocked}</p>
              <a href="/setup" className="mt-2 inline-block font-semibold text-brand underline">
                Open Setup
              </a>
            </div>
          </div>
        )}
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
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[var(--color-brand)]"
                checked={rehearsal}
                onChange={(e) => setRehearsal(e.target.checked)}
              />
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
                <p className="hint">MAJOR.MINOR.PATCH. The version code is always the run number plus the offset.</p>
              </div>
              <label className="flex min-h-11 items-start gap-3">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-brand)]" checked={integration} onChange={(e) => setIntegration(e.target.checked)} />
                <span>
                  <span className="font-medium text-ink">Run the emulator smoke suite too</span>
                  <span className="block text-[12px] text-muted">The Tier 0 flows on an Android 14 emulator; adds 15–30 minutes.</span>
                </span>
              </label>
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
