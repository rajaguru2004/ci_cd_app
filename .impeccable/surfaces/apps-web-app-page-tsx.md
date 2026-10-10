---
version: 1
slug: "apps-web-app-page-tsx"
primary_target: "apps/web/app/page.tsx"
related_targets: ["apps/web/app/apps/new/page.tsx","apps/web/app/keys/page.tsx","apps/web/app/setup/page.tsx","apps/web/app/login/page.tsx"]
---

# Surface brief: Apps overview and Add app

## Scope and mode

The console's home: every app the organization ships, each with its latest run and what each
Google Play track holds, plus the Add app flow (git email → generated SSH key → the repo's SSH
URL → access check → app details → signing key and Play key). Mode: **Operate**.

## Audience, job, constraints

- Mobile engineers of the organization, any app, any of them may add one. Jobs, in frequency
  order: see which app is healthy and what is live on Play; release an app; open an app's runs;
  add an app; manage its keys.
- One builder on this server runs one build at a time for every app; the queue is shared.
- Every state shown is the builder's record of a real run or a live read of Google Play.
- Secrets are write-only from the browser: the page shows a key's fingerprint, never the key.

## Chosen direction and memorable moment

App card grid (the dealt lead of the surface roll). Memorable moment: each card wears its
app's live six-arc ring as the avatar, so the grid reads as the organization's pipeline at a
glance; Release on a card opens that app's release sheet and lands on the new run.

## Unresolved

- Per-person sign-in (the console still has one shared password); keys record the git email.

## Direction contract

THESIS: Every app the organization ships is one instrument card: its live stage ring, what
each Google Play track holds, and Build / Release one press away. It refuses the CI dashboard
default, a run table cut loose from the apps and their store state.

OWN-WORLD: The established console world (DESIGN.md): tinted page #F4F6FC, white 20px
hairline panels, slate ink, Montserrat 14px, Deep Ledger Blue only for action and selection,
Signal Orange only for production and shipped builds, status hues only for run state, Geist
Mono for machine strings; the six-arc ring as each app's avatar.

STORY: An engineer opens the console, sees every app's latest run and Play tracks at once,
releases one from its card, or adds a new app by generating a key for their git email and
pasting the repository's SSH URL.

FIRST VIEWPORT: 64px top bar (mark, "Release Console", Apps / Git keys / Setup, builder status
chip). Page header: "Apps" with a one-line summary, "Add app" primary at the end. A grid of app
cards (auto-fill, min 360px): 44px ring, name, package; branch and repository; the latest run
line; the four-cell Play strip; a footer with Build and Release. A dashed "Add an app" tile
closes the grid. Below it, recent runs across apps.

FORM: App card grid, position 6 on my ordered list (1 release ledger, 2 app rail beside the
console, 3 track matrix, 4 top-bar switcher over the console, 5 cross-app run feed, 6 app card
grid, 7 departure board); seed key fec4f208. Signature interaction: each card's ring fills
live as its run advances; Release on a card opens that app's release sheet and lands on the
new run. Motion: the 200ms state ease and the running arc's sweep, nothing else.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
