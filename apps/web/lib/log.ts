/**
 * Reads a GitHub Actions job log. Each line starts with an RFC 3339 timestamp; workflow
 * commands (`##[error]`, `##[group]` …) mark errors and folds. Every step begins with a
 * `##[group]Run …` line, post steps with "Post job cleanup.", the final step with "Cleaning up
 * orphan processes" — those boundaries split the log into one section per step, and the
 * section's first timestamp says which step it belongs to.
 */
export type LineKind = 'error' | 'warning' | 'notice' | 'group' | 'endgroup' | 'command' | 'debug' | 'plain';

export interface LogLine {
  /** 1-based line number in the job log. */
  n: number;
  /** Epoch ms, or null for a line without a timestamp. */
  at: number | null;
  text: string;
  kind: LineKind;
}

const STAMP = /^﻿?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z ?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const COMMANDS: Array<[string, LineKind]> = [
  ['##[error]', 'error'],
  ['##[warning]', 'warning'],
  ['##[notice]', 'notice'],
  ['##[group]', 'group'],
  ['##[command]', 'command'],
  ['##[debug]', 'debug'],
];

export function parseLog(raw: string): LogLine[] {
  const out: LogLine[] = [];
  const rows = raw.replace(/\r\n?/g, '\n').split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  rows.forEach((row, i) => {
    let text = row;
    let at: number | null = null;
    const m = STAMP.exec(text);
    if (m) {
      const frac = (m[2] ?? '0').slice(0, 3).padEnd(3, '0');
      at = Date.parse(`${m[1]}.${frac}Z`);
      text = text.slice(m[0].length);
    }
    text = text.replace(ANSI, '');
    if (text.startsWith('##[endgroup]')) {
      out.push({ n: i + 1, at, text: '', kind: 'endgroup' });
      return;
    }
    let kind: LineKind = 'plain';
    for (const [prefix, k] of COMMANDS) {
      if (text.startsWith(prefix)) {
        kind = k;
        text = text.slice(prefix.length);
        break;
      }
    }
    out.push({ n: i + 1, at, text, kind });
  });
  return out.filter((l) => !(l.kind === 'plain' && l.text === '' && l.at === null));
}

function isBoundary(l: LogLine): boolean {
  return (
    (l.kind === 'group' && l.text.startsWith('Run ')) ||
    l.text === 'Post job cleanup.' ||
    l.text.startsWith('Cleaning up orphan processes')
  );
}

export interface StepRef {
  number: number;
  name: string;
  startedAt: string | null;
  state: string;
}

/** Lines per step number. Lines before the first step boundary belong to "Set up job". */
export function splitByStep(lines: LogLine[], steps: StepRef[]): Map<number, LogLine[]> {
  const out = new Map<number, LogLine[]>();
  const timed = steps
    .filter((s) => s.startedAt && s.state !== 'skipped')
    .map((s) => ({ number: s.number, name: s.name, at: Date.parse(s.startedAt as string) }))
    .sort((a, b) => a.at - b.at || a.number - b.number);
  if (!timed.length) return out;
  const setup = steps.find((s) => s.name === 'Set up job')?.number ?? timed[0].number;

  let current: LogLine[] = [];
  const sections: LogLine[][] = [];
  for (const l of lines) {
    if (isBoundary(l) && current.length) {
      sections.push(current);
      current = [];
    }
    current.push(l);
  }
  if (current.length) sections.push(current);

  sections.forEach((section, i) => {
    let owner = setup;
    const first = section.find((l) => l.at !== null)?.at ?? null;
    if (i > 0 || isBoundary(section[0])) {
      if (first !== null) {
        // Step times from the API are whole seconds; allow for that when matching.
        for (const s of timed) if (s.at <= first + 1500) owner = s.number;
      }
    }
    out.set(owner, [...(out.get(owner) ?? []), ...section]);
  });
  return out;
}
