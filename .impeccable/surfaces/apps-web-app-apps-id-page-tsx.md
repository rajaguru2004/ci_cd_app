---
version: 1
slug: "apps-web-app-apps-id-page-tsx"
primary_target: "apps/web/app/apps/[id]/page.tsx"
related_targets: ["apps/web/app/apps/[id]/settings/page.tsx"]
---

# Surface brief: app console (commit stream) and app settings

## Scope and mode

One app's console: the commit stream of its branch, pulled over SSH, each commit carrying its
runs, with the selected run's stages, log and outputs; the release sheet; and the app's
settings (repository, upload key, Google Play key). Mode: **Operate**.

## Audience, job, constraints

- Engineers of the organization. Jobs, in frequency order: see what the branch's recent commits
  did; Release (git pull → tests → signed AAB → Google Play); open a failed run and read the
  failing step; download the AAB; build any commit; fix the app's keys.
- Every state is the builder's record of a real run; a run's log is readable live.
- The repository may be unreachable (key not added yet): the stream says why and the runs stay
  listed. An app without a repository lists its ZIP runs instead of commits.
- Phone width must work (stream first, detail as its own view), but the desk is the scene.

## Chosen direction and memorable moment

Commit stream, carried from the single-app console (seed c05418e1). The memorable moment is
unchanged: each commit node is a six-arc stage ring that fills live; selecting it opens the
same six stages as the strip, with the ring at 44px beside the state line.

## Decisions recorded (2026-10-10)

- The top bar names the console and the app (an app switcher); the strip under it carries the
  package, the repository and the app's actions: Settings, Build, Release (the one primary).
- Tags show as neutral chips: a tag starts nothing now; Signal Orange stays for what shipped.
- Any commit can be built or released ("Build this commit"), not only a branch tip.

## Direction contract

THESIS: The app's console is the log of its branch with the pipeline attached: every commit
carries its runs as six-stage rings, and Release is one press from any of them. It refuses a
run table cut loose from the code.

OWN-WORLD: The established console world (DESIGN.md): tinted page, white hairline panels, slate
ink, Montserrat 14px, Deep Ledger Blue for action and selection, Signal Orange for shipped
builds and the production track, status hues for run state only, one dark Geist Mono log pane.

STORY: An engineer opens an app, sees which commits are tested, built and shipped, picks one,
reads its run stage by stage, downloads the AAB or opens the failing log, and releases the
branch tip or that commit from the bar.

FIRST VIEWPORT: 64px top bar (console, app switcher, builder status). A 64px app strip:
package and repository, Settings, Build, Release. Left 400px: On Google Play strip, branch
select and refresh, the commit rail. Right: the run header (subject, commit, author, actions,
run switcher, 44px ring and state line, six-stage strip), then the log pane beside outputs.

FORM: Commit stream, #3 on the original ordered list; seed key c05418e1. Signature
interaction: the ring fills arc by arc as the builder reports each stage; selecting a commit
carries its stages into the strip. Motion: one 200ms ease-out for state, the running arc's
sweep only.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
