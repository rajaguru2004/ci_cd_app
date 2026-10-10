'use client';

import clsx from 'clsx';
import { Copy, Download, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { bytes, clock, duration } from '@/lib/format';
import type { RunDetail, StageState } from '@/lib/types';
import { StateGlyph } from './stage';

function stateOf(detail: RunDetail, key: string): StageState {
  return detail.stages.find((s) => s.key === key)?.state ?? 'pending';
}

function Section({ title, state, children }: { title: string; state: StageState; children: React.ReactNode }) {
  return (
    <section className="px-5 py-5">
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-ink">
        <StateGlyph state={state} size={16} />
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Fact({ term, children, mono }: { term: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="shrink-0 text-[12px] text-muted">{term}</dt>
      <dd className={clsx('min-w-0 truncate text-end text-[13px] text-ink', mono && 'font-mono')}>{children}</dd>
    </div>
  );
}

function CopyValue({ value, shown }: { value: string; shown: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1.5 truncate rounded px-1 font-mono text-[13px] text-ink hover:bg-line-soft"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
      title={done ? 'Copied' : `Copy ${value}`}
    >
      <span className="truncate">{done ? 'copied' : shown}</span>
      <Copy size={12} aria-hidden className="shrink-0 text-muted" />
    </button>
  );
}

const waiting = (what: string) => <p className="text-[13px] text-muted">{what}</p>;

export function Outputs({ detail }: { detail: RunDetail }) {
  const mode = detail.plan?.mode ?? detail.run.mode;
  const aabState = stateOf(detail, 'aab');
  const testsState = stateOf(detail, 'tests');
  const playState = stateOf(detail, 'play');
  const stopped = detail.run.state === 'failed' || detail.run.state === 'cancelled';
  const track = detail.plan?.track ?? detail.run.track ?? 'default';

  return (
    <div className="panel divide-y divide-line overflow-hidden">
      <Section title="Signed AAB" state={aabState}>
          {detail.build ? (
            <>
              <p className="font-mono text-[22px] font-semibold leading-tight text-ink tabular">
                {detail.build.versionName}
                <span className="ms-2 text-[15px] font-medium text-muted">({detail.build.versionCode})</span>
              </p>
              {detail.plan?.versionCodeFrom && <p className="mt-1 text-[12px] text-muted">Version code: {detail.plan.versionCodeFrom}.</p>}
              <dl className="mt-3">
                <Fact term="Size">{bytes(detail.build.sizeBytes)}</Fact>
                <Fact term="Signed by">{detail.build.signedBy === 'console' ? 'the console (upload key)' : 'the project (key.properties)'}</Fact>
                <Fact term="SHA-256">
                  <CopyValue value={detail.build.sha256} shown={`${detail.build.sha256.slice(0, 12)}…`} />
                </Fact>
                <Fact term="Key SHA-256">
                  <CopyValue value={detail.build.certSha256} shown={`${detail.build.certSha256.slice(0, 14)}…`} />
                </Fact>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                <a className="btn btn-primary" href={`/api/runs/${detail.run.id}/aab`} download>
                  <Download size={15} aria-hidden />
                  Download AAB
                </a>
                <a className="btn btn-secondary" href={`/api/runs/${detail.run.id}/aab?file=mapping`} download>
                  R8 mapping
                </a>
              </div>
            </>
          ) : aabState === 'running' ? (
            waiting('Gradle is building the bundle; the console signs it next.')
          ) : stopped || aabState === 'skipped' || aabState === 'cancelled' ? (
            waiting('No bundle: the run stopped before this stage.')
          ) : aabState === 'failed' ? (
            waiting('The build failed; its log is in the Signed AAB stage.')
          ) : (
            waiting('The bundle appears here once the tests pass and it is built and signed.')
          )}
        </Section>

      <Section title="Tests" state={testsState}>
          {detail.tests ? (
            <>
              <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular">
                <span className="font-mono text-[22px] font-semibold leading-tight text-ink">{detail.tests.passed}</span>
                <span className="text-[13px] text-ok-ink">passed</span>
                <span className={clsx('text-[13px]', detail.tests.failed ? 'font-semibold text-fail-ink' : 'text-muted')}>
                  {detail.tests.failed} failed
                </span>
                <span className="text-[13px] text-muted">{detail.tests.skipped} skipped</span>
              </p>
              {detail.tests.durationMs !== null && (
                <p className="mt-1 text-[12px] text-muted">flutter test ran for {duration(detail.tests.durationMs)}</p>
              )}
              {detail.tests.failures.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {detail.tests.failures.slice(0, 6).map((f, i) => (
                    <li key={i} className="rounded-[var(--radius-control)] bg-fail-wash px-3 py-2">
                      <p className="text-[13px] font-semibold text-fail-ink">{f.name}</p>
                      {f.suite && <p className="font-mono text-[11px] text-muted">{f.suite}</p>}
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-[12px] text-ink">{f.error}</p>
                    </li>
                  ))}
                  {detail.tests.failures.length + detail.tests.truncatedFailures > 6 && (
                    <li className="text-[12px] text-muted">
                      {detail.tests.failures.length + detail.tests.truncatedFailures - 6} more in the Tests log.
                    </li>
                  )}
                </ul>
              )}
            </>
          ) : testsState === 'running' ? (
            waiting('flutter test is running; results land when the step ends.')
          ) : testsState === 'failed' ? (
            waiting('The stage failed before test results were written; see its log.')
          ) : stopped || testsState === 'skipped' ? (
            waiting('No test results for this run.')
          ) : (
            waiting('Analysis and unit and widget tests run first.')
          )}
        </Section>

      <Section title="Google Play" state={mode === 'build' ? 'skipped' : playState}>
        {mode === 'build' ? (
          waiting('Not part of this run: a build stops at the AAB. Start a release to publish it.')
        ) : (
          <>
            <dl>
              <Fact term="Track">
                <span className={clsx('font-semibold', track === 'production' ? 'text-ship-ink' : 'text-ink')}>{track}</span>
              </Fact>
              {detail.plan && (
                <Fact term="After upload">
                  {detail.plan.rehearsal ? 'Rehearsal: validate only' : detail.plan.releaseStatus === 'draft' ? 'Draft in Play Console' : 'Roll out'}
                </Fact>
              )}
              {detail.plan && (
                <Fact term="Version" mono>
                  {detail.plan.versionName} ({detail.plan.versionCode})
                </Fact>
              )}
            </dl>
            {detail.release?.validatedOnly || (detail.release && detail.plan?.rehearsal) ? (
              <p className="mt-3 text-[13px] text-ink">
                Rehearsal: Google Play validated versionCode {detail.release.versionCode} for the {detail.release.track} track (key, signature,
                version code, notes). Nothing was published.
              </p>
            ) : detail.release ? (
              <p className="mt-3 rounded-[var(--radius-control)] bg-ship-wash px-3 py-2 text-[13px] text-ink">
                versionCode {detail.release.versionCode} is on the <strong className="text-ship-ink">{detail.release.track}</strong> track
                {detail.release.releaseStatus === 'draft' ? ' as a draft' : ''} since {clock(detail.release.uploadedAt)}.
              </p>
            ) : playState === 'running' ? (
              <p className="mt-3 text-[13px] text-muted">Fastlane is uploading the bundle to Google Play.</p>
            ) : playState === 'failed' ? (
              <p className="mt-3 text-[13px] text-fail-ink">The upload failed; the reason is above and in the Google Play log.</p>
            ) : stopped ? (
              <p className="mt-3 text-[13px] text-muted">Nothing was uploaded: the run stopped before this stage.</p>
            ) : (
              <p className="mt-3 text-[13px] text-muted">Uploads once the signed AAB exists.</p>
            )}
            {detail.plan?.releaseNotes && (
              <figure className="mt-3">
                <figcaption className="text-[12px] text-muted">What&apos;s new</figcaption>
                <blockquote className="mt-1 whitespace-pre-wrap text-[13px] text-body">{detail.plan.releaseNotes}</blockquote>
              </figure>
            )}
            {detail.release && detail.release.track === 'production' && (
              <a href={detail.release.storeUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-brand underline">
                Store listing <ExternalLink size={12} aria-hidden />
              </a>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
