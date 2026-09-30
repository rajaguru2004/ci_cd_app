---
version: 1
slug: "apps-web-app-page-tsx"
primary_target: "apps/web/app/page.tsx"
related_targets: ["apps/web/app/setup/page.tsx","apps/web/app/login/page.tsx"]
---

# Surface brief: pipeline console (commit stream)

## Scope and mode

The console's main surface: the commit stream of a branch with the selected commit's pipeline
run, plus its satellites (start-build sheet, setup page, login). Mode: **Operate**.

## Audience, job, constraints

- Mobile engineers only. Jobs, in frequency order: see what main's recent commits did in CI;
  open a failed run and read the failing step's log; download the signed AAB; start a build or a
  Play release; check setup (token, workflow on main, Play key).
- Every state is GitHub's real state for the run. While a job runs, only step states and
  durations exist (GitHub publishes the job log when the job ends) — say so, link the live log.
- Runs start three ways (console, `release:` commit on main, `v*` tag); all run `release.yml`.
- Phone width must work (stream first, detail as its own view), but the desk is the scene.

## Chosen direction and memorable moment

Commit stream. The memorable moment: the rail. Each commit node is a six-arc stage ring
(checkout, dependencies, tests, AAB, Fastlane, Google Play) that fills live; selecting the
commit opens the same six stages as the full strip on the right, and the run header carries the
ring itself at 44px beside the state line.

## Decisions recorded after the build (2026-09-30)

- "On Google Play" strip above the rail: the console reads every track live with its own
  service-account key (added after the key was supplied), so what is on each track is known
  without a pipeline run. Cells show the track and the live release's version code; production
  keeps Signal Orange because it is the release that reached everyone.
- Attention states (missing setup, workflow not on main, the Setup nav dot) use the warn
  tokens; Signal Orange is only release flags, tags and Play tracks.
- A release can run as a rehearsal: Google Play validates it and nothing is published; the ring
  core stays ink for a rehearsal because nothing shipped.

## Unresolved

- Runs on branches other than the one being viewed: shown under the stream as "runs elsewhere".
- The run surfaces (rings with real stages, run header, strip, log pane, outputs) were reviewed
  from source only until the console has a GitHub token; capture them on the first real run.

## Direction contract

THESIS: The console is the log of the branch with its pipeline attached: every commit carries
its run as a six-stage ring on the rail, and `release:` commits and v-tags are flagged as the
moments that ship. It refuses the category default, a run table cut loose from the code.

OWN-WORLD: The Fusion HRM default preset: tinted page #F4F6FC, white hairline panels
(#E2E8F0), slate ink #0F172A/#334155/#64748B, Montserrat with a 14px body, Deep Ledger Blue
#00358F only for action and the active selection, Signal Orange #F66600 held back for ship
moments (release flags, tags, Play track), status colours only for run state, one dark Geist
Mono log pane.

STORY: An engineer sees which commits on main are tested, built and shipped, picks one, reads
its run stage by stage, downloads the AAB or opens the failing log, and starts a build or a
release from the header without leaving the page.

FIRST VIEWPORT: 64px top bar: app identity (FusionHRM Android, package, repo) at the start,
Setup link and the primary Start build button at the end. Left column ~400px: branch switcher,
then the commit rail (ring node, subject, short SHA, author, age, release/tag flags). Right:
the selected commit's header (subject at headline size, trigger, run number, state, duration,
actions), the six-stage strip full width, then the log pane (two thirds) beside the outputs
column (AAB, tests, Google Play).

FORM: Commit stream, #3 on my ordered list (1 split console, 2 station rail, 3 commit stream,
4 log-first, 5 track ledger, 6 timing strips, 7 KPI dashboard); seed key c05418e1. Signature
interaction: the stage ring fills arc by arc as GitHub reports each stage; selecting a commit
carries the ring's six stages into the strip. Motion grammar: one 200ms ease-out for state
changes, a slow sweep on the running arc only, nothing moves when nothing is running.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the
verdict, DESIGN.md, and every shipping raster carrying its provenance
