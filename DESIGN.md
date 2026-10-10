---
name: Release Console
description: Internal console that builds, tests and releases Android apps to Google Play from their own repositories. Each app wears its latest run as a six-stage ring; each app console is the commit stream of a branch, on the Fusion HRM default preset.
colors:
  page: "#f4f6fc"
  card: "#ffffff"
  line: "#e2e8f0"
  line-soft: "#f1f5f9"
  ink: "#0f172a"
  body: "#334155"
  muted: "#5b6679"
  faint: "#94a3b8"
  brand: "#00358f"
  brand-dark: "#002570"
  brand-wash: "#eef3fc"
  brand-light: "#aeccff"
  ship: "#f66600"
  ship-ink: "#b34700"
  ship-wash: "#fff1e5"
  ok: "#10b981"
  ok-ink: "#047857"
  ok-wash: "#ecfdf5"
  fail: "#ef4444"
  fail-ink: "#b91c1c"
  fail-wash: "#fef2f2"
  run: "#3b82f6"
  run-ink: "#1d4ed8"
  run-wash: "#eff6ff"
  run-queued: "#93c5fd"
  warn: "#f59e0b"
  warn-ink: "#b45309"
  warn-wash: "#fffbeb"
  idle: "#cbd5e1"
  log: "#0b1220"
  log-raised: "#111a2e"
  log-line: "#1e293b"
  log-text: "#d6deeb"
  log-muted: "#8391a8"
  log-error: "#fca5a5"
  log-warn: "#fcd34d"
  log-group: "#93c5fd"
typography:
  headline:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  headline-sm:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.375
  title-sheet:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.55
  title:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.25
  state-line:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.43
  body:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.43
  body-sm:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.43
  control:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
  meta:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.43
  caption:
    fontFamily: "Montserrat Variable, Montserrat, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
  mono-figure:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.25
    fontFeature: "tnum"
  log:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  mark: "2px"
  inline: "6px"
  control: "8px"
  card: "12px"
  sheet: "16px"
  panel: "20px"
  full: "9999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.card}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.brand-dark}"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-secondary-hover:
    backgroundColor: "{colors.brand-wash}"
    textColor: "{colors.brand}"
  button-danger:
    backgroundColor: "{colors.fail-ink}"
    textColor: "{colors.card}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-quiet:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "36px"
  button-quiet-hover:
    backgroundColor: "{colors.line-soft}"
    textColor: "{colors.ink}"
  field:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "48px"
  panel:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.panel}"
    padding: "20px 24px"
  segmented-track:
    backgroundColor: "{colors.page}"
    rounded: "{rounded.card}"
    padding: "4px"
  segmented-option-selected:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
    height: "44px"
  chip-ship:
    backgroundColor: "{colors.ship-wash}"
    textColor: "{colors.ship-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  chip-neutral:
    textColor: "{colors.body}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  app-card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.panel}"
    padding: "20px 24px"
  app-strip:
    backgroundColor: "{colors.card}"
    padding: "12px 24px"
  attention-callout:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  builder-chip:
    backgroundColor: "{colors.card}"
    textColor: "{colors.run-ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    padding: "0 10px"
    height: "36px"
  app-switcher:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    padding: "6px"
    width: "320px"
  key-block:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  rail-row-selected:
    backgroundColor: "{colors.brand-wash}"
    padding: "12px 16px"
  log-pane:
    backgroundColor: "{colors.log}"
    textColor: "{colors.log-text}"
    typography: "{typography.log}"
    rounded: "{rounded.card}"
  log-toolbar:
    backgroundColor: "{colors.log-raised}"
    textColor: "{colors.log-muted}"
    padding: "8px 12px"
  top-bar:
    backgroundColor: "{colors.card}"
    height: "64px"
    padding: "0 24px"
  sheet:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.sheet}"
    padding: "20px 24px"
    width: "576px"
  check-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    padding: "14px 20px"
---

# Design System: Release Console

## Overview

**Creative North Star: "Every App's Branch Log, With Its Pipeline Attached"**

The console holds several Android apps, and each one wears its latest run. On the Apps overview an app is a card whose face is its six-stage ring; inside an app, the console is the commit history of a branch where every commit carries its run. The page reads like a ledger that happens to be live: a tinted page, white hairline panels, slate ink, one deep blue for action and selection. The world is borrowed on purpose. It is the Fusion HRM web console's default preset (`CRM/human-resource-management/apps/frontend/DESIGN.md`), carried over so the console reads as part of the same toolset; where this build departs from that preset, the departure is for contrast or for meaning and is recorded below.

Density is operational, not dashboard. Body copy sits at 14px, most meta at 13px and 12px, and the page spends its colour on state rather than decoration. Status hues draw the marks (ring arcs, strip fills, state glyphs); words stay in ink or in the darker ink tone of their status. Signal Orange appears only where something shipped: a ring whose core has gone orange, the "released → track" chip, the production track, the release callout in Outputs. Anything that needs a person to act is amber. The one dark surface is the Geist Mono log pane, because that is where the machine talks.

Motion is scarce and tied to truth. One 200ms ease-out carries state changes; the arc of a running stage carries a slow travelling highlight; when nothing is running, nothing on the page moves.

**Key Characteristics:**
- Fusion HRM default preset: tinted page, white 20px-radius hairline panels, Montserrat 14px body.
- Deep Ledger Blue only for primary action, links, focus and the active selection; one primary per view.
- The six-arc stage ring is the signature: an app's avatar, a rail node, the run header's mark; the stage strip is the same ring unrolled.
- Status colour draws glyphs and arcs; status words use the darker ink tones.
- Signal Orange is reserved for ship moments; attention and blockers use amber.
- One dark Geist Mono log pane; everything else is light.
- Only the running arc animates continuously; all state changes use one 200ms ease-out.

## Colors

A cool slate-and-white ledger with one committed blue, a held-back orange, and status hues that mark state and nothing else.

### Primary
- **Deep Ledger Blue** (`brand`): the view's one primary action (Release in the app strip, Add app on the overview, the sheet's confirm, a step's Next), links and inline actions (Fix, Change, Settings), the focus ring and field focus border, the current step node in the Add app stepper, the underline of the selected stage, the caret, the radio and checkbox accent. Hover on a primary fill steps to **Ink Blue** (`brand-dark`).
- **Selection Wash** (`brand-wash`): the selected commit or run row in the rail, the selected run tab, a chosen key row in the stepper, the secondary button's hover, the dashed "Add an app" tile's hover, the step-number discs of the first-app panel. It is how "you are here" looks.
- **Pale Sky** (`brand-light`): text selection only, plus the unfinished arcs in the brand mark.

### Secondary
- **Signal Orange** (`ship`): the fill of a ring core once the run put a build on a Google Play track, the last arc of the brand mark. Never words.
- **Ship Ink** (`ship-ink`): words that carry the ship meaning: the "released → track" chip, the production track name in Play Tracks and in the release sheet's track choice, the track name in a release callout. Departs from the HRM preset's `#CC5200` for 5.50:1 on white.
- **Ship Wash** (`ship-wash`): the fill of the ship chip and of the "versionCode n is on the track" callout in Outputs.

### Tertiary (status)
- **Pass Green / Fail Red / Run Blue / Attention Amber** (`ok`, `fail`, `run`, `warn`): the drawn marks of state: ring arcs, strip fills, Lucide state glyphs, the build-successful diamond, a done step's check, the builder chip's glyph, the warning triangle.
- **Queued Sky** (`run-queued`): the arc of a queued stage and the base under a running arc's sweep.
- **Status Ink tones** (`ok-ink`, `fail-ink`, `run-ink`, `warn-ink`): every word printed in a status colour (run state words, the state line in the run header, the builder chip, failure titles and alerts). `fail-ink` is also the fill of the danger button.
- **Status Washes** (`ok-wash`, `fail-wash`, `run-wash`, `warn-wash`): fills behind failure summaries, error and success notices, and attention callouts; their text is ink or the matching ink tone.
- **Idle Slate** (`idle`): pending arcs, the outline of a skipped or waiting strip slot, an ahead step node, the no-run node on the rail, dashed "add" and drop-zone borders, scrollbar thumbs.

### Neutral
- **Tinted Paper** (`page`): the page, the segmented-choice track, sheet footers, the public-key block, the phone blockers well, the no-run callout. Also the browser theme colour.
- **White Card** (`card`): panels, app cards, the app strip, the rail column, the top bar (at 95% with backdrop blur), fields, sheets, the app switcher.
- **Hairline Slate** (`line`, lighter `line-soft`): 1px borders and dividers; `line-soft` is also the quiet-button and nav hover fill, the current nav item and the skeleton block.
- **Ink** (`ink`), **Slate Body** (`body`), **Console Muted** (`muted`), **Faint** (`faint`): headings and primary words; running text; meta, hints and placeholders; the breadcrumb chevron and cancelled marks. Console Muted departs from the preset's `#64748B` (4.40:1 on the tinted page) to reach 5.37:1.
- **Log set** (`log`, `log-raised`, `log-line`, `log-text`, `log-muted`, `log-error`, `log-warn`, `log-group`): the dark log pane only: ground, toolbar, dividers, text, line numbers and meta, error and warning lines, folded group headers and the live-log link.

### Named Rules
**The Ship-Only Orange Rule.** Signal Orange marks only a run that reached Google Play, the production track, and the brand mark's last arc. A release that stopped short and a rehearsal wear the neutral chip and keep an ink ring core, because nothing shipped. Git tags are neutral chips: a tag starts nothing here.

**The Amber Asks Rule.** Anything a person must fix (a repository refusing the key, Google Play refusing the key, a missing Play key, a pull that failed) is an amber triangle beside ink words, on `warn-wash` or in a list row, with the way out beside it. Amber never means "shipped" and orange never means "attention".

**The Ink Words Rule.** A status hue draws; it never sets a word. Words in a status colour use the `*-ink` tone (4.5:1 or better on white), and a warning callout pairs an amber glyph with ink text.

**The Status-Means-Run-State Rule.** `ok`, `fail`, `run`, `warn` and `idle` express the state of a stage, a run, a step or a check. They are never decoration and never stand in for the brand. The danger button borrows `fail-ink` because removing something is the one failure a person chooses.

**The One Dark Pane Rule.** The log pane is the only dark surface. Everything else, including overlays and popovers, is white on tinted paper.

## Typography

**Display Font:** Montserrat Variable (with Montserrat, ui-sans-serif, system-ui)
**Body Font:** Montserrat Variable
**Label/Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo)

**Character:** Montserrat carries the HRM family voice at small operational sizes, bold only for titles; Geist Mono is the machine's voice, used for strings the machine owns.

### Hierarchy
- **Headline** (700, 24px, 1.25, -0.01em, balanced wrap): page titles (Apps, Add an app, Settings, Git keys, Setup) and the run header's commit subject.
- **Headline small** (700, 20px, 1.375): the commit title when a commit has no run, the first-app panel, the login title.
- **Title, sheet** (600, 18px): the sheet's title.
- **Title** (700, 16px): app names on cards, panel headings (Recent runs, Before *app* can release, settings and keys panels), step titles, the "Add an app" tile.
- **State line** (600, 15px): the run state sentence beside the 44px ring, in its status ink tone. The top-bar name and app switcher use 15px at 700 in ink. The failure summary title uses 15px at 700 in `fail-ink`.
- **Body** (400, 14px, 1.43): default text, commit subjects in the rail (500; 600 when selected), stage names, Recent runs rows. Running prose capped at 64-75ch.
- **Body small** (400, 13px): the most used size: run meta, rail notes, callouts, blocker detail, done-step summaries, the builder chip, log toolbar controls.
- **Label** (500, 14px): field labels and legends; 6px above the control.
- **Control** (400, 16px): every input, select and textarea, fixed in the base layer.
- **Meta** (400, 12px): hints, SHA-author-age lines, stage durations, the rail's one-line pointers, Play's empty or unreachable notes.
- **Caption** (500-600, 11px): chips, track names in Play Tracks, "checked n ago". Sentence or lower case, never tracked caps.
- **Mono** (Geist Mono, 12-13px): SHAs, branch names, package ids, tag names, version codes, SSH URLs, key fingerprints, ZIP file names; 12.5px in the public-key block.
- **Mono figure** (Geist Mono 600, 22px, tabular): the AAB version and the passed-test count in Outputs.
- **Log** (Geist Mono, 12.5px, 1.6): log lines and failure excerpts.

### Named Rules
**The Mono-Is-Machine Rule.** Geist Mono is only for strings a machine produced and a person may copy: SHAs, refs, package ids, version codes, URLs, fingerprints, keys, log lines. Headings, labels and state words stay in Montserrat.

**The Opt-In Figures Rule.** Tabular figures are off by default (`tnum` 0 on the body, a departure from the HRM preset) and switched on per element (`.tabular`) where numbers update in place: durations, elapsed time, version codes, line numbers, step numbers, characters left.

**The Sixteen-Pixel Control Rule.** Form controls never go below 16px text; phones zoom the page otherwise. (Inherited from the preset.)

## Layout

- **Shell:** sticky 64px top bar, then the page. Page gutters are 16px on phones and 24px from md; page tops are 24px (32px from md).
- **Page widths:** Apps overview 1440px; Add an app 820px; app Settings 860px; Git keys 920px; Setup 1180px (two columns from lg); Login a centred 400px column.
- **Apps overview:** title and summary line, with Add app at the end of the same row. Cards in an auto-fill grid of `minmax(min(100%, 360px), 1fr)` with 20px gaps; the dashed "Add an app" tile closes the grid. Recent runs follows 32px below as one panel of rows.
- **App console:** a fixed-height column. Under the top bar, the app strip (package · repository at the start; Settings, Build, Release at the end; actions go full width below md, Settings icon-only below sm). From lg a 400px white rail column with a hairline end border beside a tinted detail area capped at 1440px. The rail opens with "On Google Play" (Play Tracks), then the commit rail, or the runs rail when no repository is connected or the branch has no commits. Below lg the rail is the whole view and a commit or run opens the detail as its own view with a back control.
- **Blockers:** when the repository or Google Play refuses a key, the "Before *app* can release" panel leads the detail column on desks while the rail carries one-line amber pointers in their places; on phones the panel sits at the top of the rail in a `page` well.
- **Detail stack:** run header panel, failure summary when present, then the stage strip; from xl (1280px) the log pane and the outputs column sit side by side at 2fr / minmax(300px, 1fr).
- **Stage strip:** a six-column grid with 12px gaps from md; a stacked list of tappable rows below md.
- **Add app stepper:** an ordered list on a rail spine, each step a 36px node column and a content column with 16px between; a 2px `line` spine joins the nodes; each step has 32px below it.
- **Play Tracks:** a container query: two by two below a 20rem container, four across above it.
- **Sheet:** a bottom sheet on phones (max 92svh, safe-area padding on the footer), centred at 576px from sm.
- **Rhythm:** 4px inside segmented tracks; 8px and 12px gaps inside components; 16px rail row and callout padding; 20-24px panel padding; 20px between detail blocks and between cards; 24px between settings panels.
- **Direction:** logical properties throughout (`ms-`, `pe-`, `start-`, `text-start`); the strip fill's origin flips under RTL. Fieldsets reset their minimum inline size to 0 so long fingerprints and URLs wrap instead of widening the page.

## Elevation & Depth

Flat and tonal: depth comes from white panels on tinted paper and 1px hairlines, with two shadows. Nothing lifts on hover.

### Shadow Vocabulary
- **Panel rest** (`box-shadow: 0 1px 3px rgb(16 24 40 / 0.04), 0 4px 16px -4px rgb(16 24 40 / 0.05)`): every `.panel`, every app card and the log pane.
- **Overlay** (`box-shadow: 0 24px 64px -12px rgb(15 23 42 / 0.28), 0 8px 24px -8px rgb(15 23 42 / 0.12)`): the sheet, over an ink scrim at 45% with a 2px backdrop blur, and the app switcher popover (no scrim).
- **Selected segment** (`box-shadow: 0 1px 2px rgb(15 23 42 / 0.08), 0 0 0 1px var(--color-line)`): the chosen option lifting to white in a segmented track.

### Named Rules
**The Static Panels Don't Lift Rule.** Panels and cards are information, not buttons; they get no hover shadow or transform. Hover feedback is a fill or border change (`line-soft`, `brand-wash`, or a brand border on dashed tiles).

## Shapes

Three nested radii: 8px for controls, callouts and the key block, 12px for the log pane, the segmented track, Play Tracks, the app switcher, key rows and the ZIP drop zone, 20px for panels and app cards; the sheet uses 16px (top corners only on phones). Chips, the builder chip, run tabs, step nodes, the ring and its core are full circles or pills. Dashed borders mean "add or drop something here": the "Add an app" tile and the ZIP drop zone (`idle`), and Play's not-configured note (`line`). Stage marks are rounded strokes: ring arcs are 60° slots with 12° of air between them and round caps; strip fills are 6px full-round bars with the same air. The build-successful mark is the one angular form: a 10px square with 2px corners, turned 45° to sit in the gap after the AAB stage. The brand mark is an 8px-cornered 32px blue tile holding the six-arc ring.

## Components

### Buttons
Compact and confident: 40px tall, 8px corners, 14px semibold, 8px icon gap with 15-16px Lucide icons.
- **Shape:** gently curved (8px, `rounded.control`).
- **Primary:** Deep Ledger Blue fill, white text, 16px horizontal padding. One per view: Release in the app strip, Add app on the overview, Next or Make my SSH key in the current step, Save in a settings panel, the sheet's confirm (48px on phones).
- **Hover / Focus / Active:** fill steps to Ink Blue over 160ms ease-out-expo; focus is a 2px brand outline at 2px offset; press scales to 0.98; disabled drops to 55% opacity.
- **Secondary:** white fill, hairline border, body text; hover to Selection Wash with a 30% brand-tinted border and brand text. Build beside Release, Build and Release on a card's footer, Run again and Cancel run in the run header, Copy key, Cancel and Keep it in sheets. Run again is always secondary, failed run or not.
- **Danger:** Fail Ink fill, white text; hover darkens it 14% toward black. Only the confirming press of a destructive action: Disconnect, and "Delete *app*" in the delete sheet. The press that opens the confirmation is a quiet button in `fail-ink` with a `fail-wash` hover (Delete app, a key's trash icon).
- **Quiet:** 36px (40px when icon-only or in a row with 40px buttons), no fill, muted text, 500 weight; hover to `line-soft` with ink text. Settings, Open, sign-out, refresh, close, back, Repository settings, "Commit" on GitHub, and a "GitHub Actions" external-link beside Commit when the run carries a remote URL. Settings-row fix actions ("Add/Update the workflow", "Copy secrets to GitHub") use the secondary button instead, at 36px, inline under the row they fix.

### Chips
- **Ship chip:** 20px pill, Ship Wash fill, Ship Ink words at 11px semibold: "released → *track*", only once the build is on the track.
- **Neutral chip:** 20px pill, hairline border, body words at 11px: "release → *track*" for a release that stopped short, "rehearsal → *track*"; tags use it too, in Geist Mono with an 11px tag icon.
- **Run tabs:** 36px pills for the runs of one commit, a state glyph and "#n what"; the selected one has a brand border on Selection Wash with ink words, the rest hairline and muted.
- **Builder chip:** a 36px pill at the top bar's end. Building: hairline on white, a Run Blue dot glyph, "Building *app* #n" in `run-ink` and "+n" queued in muted, linking to that run. Not answering: a Fail Red x glyph and `fail-ink` words linking to Setup. Idle: plain muted "Builder idle" from lg. Below md the words drop and the glyph stays.

### Cards / Containers
- **App card:** a panel. Header: the 44px stage ring of the latest (or active) run as avatar, the app name at 16px bold over its package in 12px mono, a quiet icon button to Settings. Then two 13px lines: branch (mono, body) · repository, and the latest run ("#n what" linked, its state word in ink tone, age, version code). Then Play Tracks (compact), and amber attention callouts (repository unreachable, Google Play refused, no Google Play key, and now an app whose GitHub Actions readiness check is not `ok`) each ending in a brand "Fix" link to Settings. Footer behind a hairline: Build and Release as secondary buttons, Open as a quiet button at the end.
- **Add an app tile:** dashed `idle` border, 20px corners, at least 220px tall, centred: a 44px white disc with a brand plus, "Add an app" at 16px bold, a 13px muted line. Hover turns the border brand on Selection Wash.
- **Attention callout:** `warn-wash`, 8px corners, 10px × 12px padding, a 15px amber triangle and 13px ink words clamped to two lines.
- **Blockers panel:** a panel titled "Before *app* can release" over a divided list; each row an 18px amber triangle, a semibold ink line saying who refuses what, the reason in 13px body, and the way out (Copy the public key as secondary, a quiet link to the right settings). A GitHub Actions readiness failure (token, repository, workflow or secrets not `ok`) is one more row in this same list, linking to Settings rather than repeating the Readiness List inline.
- **Recent runs:** a panel of full-width row buttons: a 24px ring, "*App* #n what" (app name semibold) over the source in mono and the subject, the state word in its ink tone over the age at the end. Hover `line-soft` at 70%.
- **Corner Style / Background / Border:** 20px panels, white on tinted paper, 1px `line`; status callouts use their wash with ink words; the failure summary uses a 25% `fail` border on `fail-wash`.
- **Internal Padding:** 20px on phones, 24px from md; panel headings sit in a 16px × 20-24px band over a hairline.

### Inputs / Fields
- **Style:** 48px, white, 1px hairline, 8px corners, 12px side padding, ink text at 16px, Console Muted placeholder; textareas start at 112px and resize vertically. SSH URLs and version names set in mono. The rail's branch select is 44px with a leading branch icon.
- **Focus:** border turns Deep Ledger Blue with a 3px brand ring at 18%.
- **Error:** `aria-invalid` turns the border `fail`; the hint below it turns `fail-ink`.
- **Segmented choice:** a tinted 12px-radius track with 4px padding; options are at least 44px tall, a 14px name over a 12px muted hint, muted at rest; the chosen one lifts to white with ink text and the selected-segment shadow. Stacks vertically below sm. Used for mode, source ("Latest on *branch*", a commit, Upload a source ZIP), a "Runs on" choice (This server / GitHub Actions, between Source and the ZIP/track fields, only when the repository is on github.com), track and rollout in the release sheet. The same choice, without the hint line, sits in Settings as "Where builds run".
- **Choice rows:** for picking one of a list (a key in the stepper): 12px-radius bordered rows at least 48-56px, a brand-accented radio, ink name over mono fingerprint; chosen is a brand border on Selection Wash.
- **ZIP drop zone:** at least 96px, 12px corners, a dashed 1px `idle` border on `page`, a 28px archive glyph in muted, "Drop the ZIP here, or choose it" in ink over a 12px muted hint. Hover turns the border brand; dragging over it adds Selection Wash. A chosen file turns it solid on white with the glyph brand. While it uploads, a 6px Deep Ledger Blue bar fills a `line-soft` track and the confirm button counts the percentage.

### Navigation
- **Top bar:** white at 95% with backdrop blur, 64px, hairline bottom. The brand mark, "Release Console" at 15px bold; on an app page a faint chevron and the app switcher (the app's name at 15px bold with a chevron-down), with the console name hidden below lg. At the end: the builder chip, the nav, and a 40px icon sign-out.
- **Nav items:** Apps, Git keys, Setup. 40px, 8px corners, 500 weight; muted at rest, `line-soft` fill with ink when current or hovered. Below md each becomes a 40px icon button with its label as the accessible name.
- **App switcher:** a native popover, 320px, 12px corners, hairline, overlay shadow. A 12px muted "Apps" label, then 44px rows of app name over package in mono with a brand check on the current one, then behind a hairline a brand "Add an app" row with a Selection Wash hover.
- **App strip:** a white band under the top bar with a hairline bottom: package in mono and the repository line with an external-link glyph at the start; Settings (quiet), Build (secondary) and Release (primary) at the end.
- **Rails:** the commit rail (branch select, commits with their runs as 30px ring nodes on a 2px spine) and the runs rail (a "Runs" header with a one-line note, then one row per run with a 30px ring, "#n what", the source in mono, the state word and age). Run labels read "#n" everywhere.

### Add App Stepper
Steps hang on the same spine as the commit rail. Nodes are 32px circles with a 2px border and a bold tabular number: brand border and number for the current step, `idle` border and muted number for steps ahead (whose content dims to 60%); a done step shows a 26px Pass Green circle-check. The current step's content sits in a panel below its 16px bold title; a done step collapses to a 13px summary with a brand "Change" link.

### Key Block
A key's public line in Geist Mono 12.5px in a `page` block with a hairline and 8px corners (scrolls past 128px, breaks anywhere), a "Copy key" secondary button that flips to "Copied" with a check for 1.6s, the fingerprint in 12px mono, then per-host instructions as a divided 12px-radius list (host in semibold ink, the menu path in body, a brand "Open" link).

### Signing and Play Panels
Settings panels with a 16px bold heading over a hairline, current state as facts, a form to replace it, one primary to save, and the result as an `ok-wash`/`ok-ink` or `fail-wash`/`fail-ink` notice at 13px.

### Readiness List
A settings-only pattern for a per-app check with more than one yes/no: "Where builds run"'s four-row list (Token, Repository, Workflow, Secrets) when an app builds on GitHub Actions. A hairline-divided 12px-radius list of rows, each a 16px state glyph beside a semibold ink title and a 13px body detail capped at 60ch: `CircleCheck` in Pass Green when the check passed, `CircleDashed` in Run Blue for "not checked yet" (the same meaning as the ring's queued state, applied to a check instead of a stage), `CircleAlert` in Attention Amber for anything else, each following the Amber Asks Rule. A row that needs a fix carries a secondary button inline below its detail ("Add/Update the workflow", "Copy secrets to GitHub"); a "Check again" quiet button with a spinning `RefreshCw` sits below the list. Above the list, a small bordered 12px-radius fact block (not the page-tinted Key Block) states the token in use and when it was last checked as label-left/value-end rows, the same shape as a Play Tracks cell's key/value pair.

### Stage Ring (signature)
Six arcs, one per stage (checkout, dependencies, tests, signed AAB, Fastlane, Google Play), clockwise from the top, each coloured by its stage state; a core dot sits in the middle.
- **Sizes:** 24px in Recent runs and run lists, 30px on rail nodes (3px strokes), 44px as an app card's avatar and in the run header beside the state line (4px strokes).
- **Core:** an ink dot at 13% of the size; it grows to 20% and turns Signal Orange once the run shipped to Google Play (never for a rehearsal).
- **Motion:** stroke and core changes take 200ms ease-out-expo. A running arc shows Queued Sky under a Run Blue highlight 36% of its length that travels it every 2.4s; under reduced motion the running arc is solid Run Blue.
- **Rail:** nodes sit on a 2px `line` spine; a commit without a run shows a 12px hollow idle circle.

### Stage Strip
The ring unrolled: six columns, each a 6px full-round bar filling left to right in 200ms with the stage's arc colour, then a state glyph, the stage name (14px, 500; selected goes 600 ink with a 2px brand underline) and its duration or state word in 12px muted. Skipped and waiting slots keep an idle outline. The diamond sits in the gap after Signed AAB and fills green once a signed bundle exists.

### State Glyphs
Lucide circle glyphs at 14-16px, stroke 2.2, in the status hue: check (passed), x (failed), dot (running), dashed (queued), minus (skipped), ban (cancelled), plain circle (waiting). They never animate; the ring does that job.

### Log Pane
The one dark surface: `log` ground, 12px corners, panel-rest shadow. A `log-raised` toolbar holds job tabs, a 36px filter field, a raw toggle and download. Steps are 44px disclosure rows with durations in mono; a failed step's name is `log-error` and semibold. Lines are 12.5px Geist Mono at 1.6 with muted line numbers; error and warning lines carry their word prefix and a tinted row, command lines and folded group headers use `log-group`. Off-screen chunks skip layout. A live log is read again while the job runs and stays pinned to the bottom while the reader is there.

### Sheet
The one modal overlay: a native `<dialog>`, a bottom sheet on phones and a centred 576px card from sm, 200ms rise and fade over an ink scrim. Header with an 18px title and muted description over a hairline, scrolling body, `page`-tinted footer. The release sheet's footer puts a 13px muted summary of what will happen above the actions (Cancel secondary, the confirm primary). A failed last pull shows an amber alert at the top of its body. The delete sheet pairs Keep it (secondary) with the danger confirm.

### Play Tracks
A four-cell grid (production, beta, alpha, internal) of white cells divided by 1px hairlines inside a 12px-radius frame: track name at 11px (Ship Ink for production, muted otherwise), then "code" and the live version code in Geist Mono semibold, a "rolling out" note when partial, or "empty". Two by two in narrow containers, four across from a 20rem container.

## Do's and Don'ts

### Do:
- **Do** colour words by role (`ink`, `body`, `muted`) and print status words in the `*-ink` tone; let `ok`, `fail`, `run`, `warn` draw only marks.
- **Do** use the `warn` set (amber triangle, `warn-wash` fill, ink words, a way out beside it) for every blocker and missing piece of setup.
- **Do** keep one primary per view: Release in the app strip, Add app on the overview, the current step's action, the sheet's confirm.
- **Do** reuse the ring's six-slot geometry (60° slots, 12° gaps, round caps) and the shared arc colour map wherever a run's stages are drawn.
- **Do** keep every state change at 200ms ease-out-expo (`cubic-bezier(0.16, 1, 0.3, 1)`), controls and hovers at 160ms (the Tailwind transition defaults are set to both, so a bare `transition-colors` already complies), and honour reduced motion by removing the sweep, the sheet rise and the strip fill.
- **Do** put machine strings (SHA, ref, package, version code, tag, URL, fingerprint, key, log) in Geist Mono and switch on tabular figures for numbers that tick.
- **Do** keep hit targets at 40px or more (44px for segmented options, switcher rows, rail controls and log step rows).

### Don't:
- **Don't** use Signal Orange for anything but a run that reached Google Play, the production track, or the brand mark.
- **Don't** set words in the bright status hues (`ok`, `fail`, `run`, `warn`) on white or on their washes.
- **Don't** use the danger fill for anything but the confirming press of a destructive action.
- **Don't** add a second dark surface; the log pane is the only one.
- **Don't** animate anything continuously except the running arc; nothing moves when nothing is running.
- **Don't** add hover lift or shadow change to static panels or cards.
