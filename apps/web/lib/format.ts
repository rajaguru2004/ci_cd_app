/** Durations and times the way an engineer reads them at a glance. */

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function since(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

export function between(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  const ms = since(iso, now);
  if (ms === null) return '';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(iso as string).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A calendar date with its year, for things that last years (a certificate). */
export function day(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : iso;
}

export function bytes(n: number | null | undefined): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const short = (sha: string) => sha.slice(0, 7);

/** "#12": a run's number within its app. */
export const runLabel = (run: { number: number }) => `#${run.number}`;

const TRACK_WORDS: Record<string, string> = { testflight: 'TestFlight', app_store: 'App Store review' };

/** A release target in words: Google Play's track names as they are, TestFlight, App Store review. */
export const trackWord = (track: string | null | undefined) => (track ? (TRACK_WORDS[track] ?? track) : '');

/** What a run does, in the console's words. */
export function runWhat(run: { mode: 'build' | 'release'; track: string | null; rehearsal: boolean; platform?: 'android' | 'ios' }): string {
  const ios = run.platform === 'ios' ? 'iOS ' : '';
  if (run.mode === 'release') return `${ios}${run.rehearsal ? 'rehearsal' : 'release'}${run.track ? ` → ${trackWord(run.track)}` : ''}`.replace(/^./, (c) => c.toUpperCase());
  return `${ios ? 'iOS build' : 'Build'} and test`;
}

/** Where a run's source came from: the branch and commit, or the ZIP. */
export function runSource(run: { source: { kind: 'git' | 'zip'; branch: string | null; fileName: string | null; sha: string | null } }): string {
  const s = run.source;
  if (s.kind === 'zip') return s.fileName ?? 'uploaded ZIP';
  return `${s.branch ?? 'branch'}${s.sha ? ` @ ${s.sha.slice(0, 7)}` : ''}`;
}

/** "github.com/org/app" from an app's repository, for one-line display. */
export const repoLine = (repo: { host: string; slug: string }) => `${repo.host}/${repo.slug}`;
