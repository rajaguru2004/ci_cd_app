'use client';

import clsx from 'clsx';
import type { PlayTrackState } from '@/lib/types';

const ORDER = ['production', 'beta', 'alpha', 'internal'];

/**
 * What is on Google Play right now, one cell per track, read live with the console's key:
 * the track, then the version code of its live (or newest) release. Production carries Signal
 * Orange: it is the release that reached everyone.
 */
export function PlayTracks({ tracks, compact = false }: { tracks: PlayTrackState[]; compact?: boolean }) {
  const byName = new Map(tracks.map((t) => [t.track, t]));
  // Four cells across where they fit (the rail, a wide card), two by two where they do not.
  return (
    <div className="@container">
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line @xs:grid-cols-4">
      {ORDER.map((name) => {
        const track = byName.get(name);
        const release = track?.releases.find((r) => r.status === 'completed' || r.status === 'inProgress') ?? track?.releases[0];
        const code = release?.versionCodes.length ? Math.max(...release.versionCodes) : null;
        return (
          <div key={name} className={clsx('min-w-0 bg-card', compact ? 'px-2.5 py-2' : 'px-3 py-2.5')}>
            <dt className={clsx('truncate text-[11px] font-medium', name === 'production' ? 'text-ship-ink' : 'text-muted')}>{name}</dt>
            <dd className="mt-0.5 truncate text-[13px] text-ink" title={release ? `${release.name ?? 'Release'} · versionCode ${code} · ${release.status}` : 'No release on this track'}>
              {code !== null ? (
                <>
                  <span className="text-[11px] text-muted">code </span>
                  <span className="font-mono font-semibold tabular">{code}</span>
                  {release && release.status !== 'completed' && (
                    <span className="ms-1 text-[11px] text-muted">{release.status === 'inProgress' ? 'rolling out' : release.status}</span>
                  )}
                </>
              ) : (
                <span className="text-[12px] text-muted">empty</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
    </div>
  );
}
