---
name: FusionHRM Android Pipeline
description: Internal pipeline console for the FusionHRM Android app. The commit stream of a branch, each commit carrying its run as a six-stage ring, on the Fusion HRM default preset.
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
---

# Design System: FusionHRM Android Pipeline

## Overview

**Creative North Star: "The Branch Log With Its Pipeline Attached"**

The console is the commit history of a branch, and every commit wears its run. The page reads like a ledger that happens to be live: a tinted page, white hairline panels, slate ink, one deep blue for action and selection. The world is borrowed on purpose. It is the Fusion HRM web console's default preset (`CRM/human-resource-management/apps/frontend/DESIGN.md`), carried over so the pipeline reads as part of the same toolset; where this build departs from that preset, the departure is for contrast or for meaning and is recorded below.

Density is operational, not dashboard. Body copy sits at 14px, most meta at 13px and 12px, and the page spends its colour on state rather than decoration. Status hues draw the marks (ring arcs, strip fills, state glyphs); words stay in ink or in the darker ink tone of their status. Signal Orange appears only where something shipped: `release:` commits, v-tags, the production track, a ring whose core has gone orange. The one dark surface is the Geist Mono log pane, because that is where the machine talks.

Motion is scarce and tied to truth. One 200ms ease-out carries state changes; the arc of a running stage carries a slow travelling highlight; when nothing is running, nothing on the page moves.

**Key Characteristics:**
- Fusion HRM default preset: tinted page, white 20px-radius hairline panels, Montserrat 14px body.
- Deep Ledger Blue only for primary action, links, focus and the active selection.
- The six-arc stage ring is the signature; the stage strip is the same ring unrolled.
- Status colour draws glyphs and arcs; status words use the darker ink tones.
- Signal Orange is reserved for ship moments; attention states use amber.
- One dark Geist Mono log pane; everything else is light.
- Only the running arc animates continuously; all state changes use one 200ms ease-out.

## Colors

A cool slate-and-white ledger with one committed blue, a held-back orange, and status hues that mark state and nothing else.

### Primary
- **Deep Ledger Blue** (`brand`): the Start build button and every primary action, links, the focus ring and field focus border, the underline of the selected stage in the strip, the caret. Hover on a primary fill steps to **Ink Blue** (`brand-dark`).
- **Selection Wash** (`brand-wash`): the selected commit row in the rail, the selected run tab, the selected stage on phones, the secondary button's hover, the icon well on the connect panel. It is how "you are here" looks.
- **Pale Sky** (`brand-light`): text selection only, plus the unfinished arcs in the brand mark.

### Secondary
- **Signal Orange** (`ship`): the fill of a ring core once the run put a build on a Google Play track, the 40% border of the tag chip, the last arc of the brand mark. Never words.
- **Ship Ink** (`ship-ink`): words that carry the ship meaning: release and tag chips, the "production" track name in the Play strip and the start sheet. Departs from the HRM preset's `#CC5200` for 5.50:1 on white.
- **Ship Wash** (`ship-wash`): the fill of release and tag chips and the release-notes callout in Outputs.

### Tertiary (status)
- **Pass Green / Fail Red / Run Blue / Attention Amber** (`ok`, `fail`, `run`, `warn`): the drawn marks of state: ring arcs, strip fills, Lucide state glyphs, the build-successful diamond, the Setup nav dot, the warning triangle.
- **Queued Sky** (`run-queued`): the arc of a queued stage and the base under a running arc's sweep.
- **Status Ink tones** (`ok-ink`, `fail-ink`, `run-ink`, `warn-ink`): every word printed in a status colour (run state words, the state line in the run header, failure titles and alerts).
- **Status Washes** (`ok-wash`, `fail-wash`, `run-wash`, `warn-wash`): fills behind failure summaries, error alerts and the missing-setup callout; their text is ink or the matching ink tone.
- **Idle Slate** (`idle`): pending arcs, the outline of a skipped or waiting strip slot, the no-run node on the rail, scrollbar thumbs.

### Neutral
- **Tinted Paper** (`page`): the page, the segmented-choice track, sheet footers. Also the browser theme colour.
- **White Card** (`card`): panels, the rail column, the top bar (at 95% with backdrop blur), fields, sheets.
- **Hairline Slate** (`line`, lighter `line-soft`): 1px borders and dividers; `line-soft` is also the quiet-button and nav hover fill and the skeleton block.
- **Ink** (`ink`), **Slate Body** (`body`), **Console Muted** (`muted`), **Faint** (`faint`): headings and primary words; running text; meta, hints and placeholders; cancelled marks. Console Muted departs from the preset's `#64748B` (4.40:1 on the tinted page) to reach 5.37:1.
- **Log set** (`log`, `log-raised`, `log-line`, `log-text`, `log-muted`, `log-error`, `log-warn`, `log-group`): the dark log pane only: ground, toolbar, dividers, text, line numbers and meta, error and warning lines, folded group headers and the live-log link.

### Named Rules
**The Ship-Only Orange Rule.** Signal Orange marks only a release commit, a v-tag, the production track, or a run that reached Google Play. Warnings, missing setup and every other call for attention use the amber `warn` set. A rehearsal release keeps an ink ring core, because nothing shipped.

**The Ink Words Rule.** A status hue draws; it never sets a word. Words in a status colour use the `*-ink` tone (4.5:1 or better on white), and a warning callout pairs an amber glyph with ink text.

**The Status-Means-Run-State Rule.** `ok`, `fail`, `run`, `warn` and `idle` express GitHub's state for a stage, a run or a setup check. They are never decoration and never stand in for the brand.

**The One Dark Pane Rule.** The log pane is the only dark surface. Everything else, including overlays, is white on tinted paper.

## Typography

**Display Font:** Montserrat Variable (with Montserrat, ui-sans-serif, system-ui)
**Body Font:** Montserrat Variable
**Label/Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo)

**Character:** Montserrat carries the HRM family voice at small operational sizes, bold only for titles; Geist Mono is the machine's voice, used for strings the machine owns.

### Hierarchy
- **Headline** (700, 24px, 1.25, -0.01em, balanced wrap): the run header's commit subject and the Setup page title.
- **Headline small** (700, 20px, 1.375): the commit title when a commit has no run, the connect panel, the login title.
- **Title, sheet** (600, 18px): the sheet's title.
- **Title** (700, 16px): section titles inside Setup panels.
- **State line** (600, 15px): the run state sentence beside the 44px ring, in its status ink tone. The failure summary title uses the same 15px at 700 in `fail-ink`.
- **Body** (400, 14px, 1.43): default text, commit subjects in the rail (500; 600 when selected), stage names. Running prose capped at 68-75ch.
- **Body small** (400, 13px): the most used size: run meta, rail notes, callouts, log toolbar controls.
- **Label** (500, 14px): field labels; 6px above the control.
- **Control** (400, 16px): every input, select and textarea, fixed in the base layer.
- **Meta** (400, 12px): hints, SHA-author-age lines, stage durations, the Play strip's empty state.
- **Caption** (500-600, 11px): chips, track names in the Play strip. Sentence or lower case, never tracked caps.
- **Mono** (Geist Mono, 12-13px): SHAs, branch names, the package id, tag names, version codes, step durations in the log.
- **Mono figure** (Geist Mono 600, 22px, tabular): the AAB version and the test count in Outputs.
- **Log** (Geist Mono, 12.5px, 1.6): log lines and failure excerpts.

### Named Rules
**The Mono-Is-Machine Rule.** Geist Mono is only for strings a machine produced and a person may copy: SHAs, refs, package ids, version codes, log lines. Headings, labels and state words stay in Montserrat.

**The Opt-In Figures Rule.** Tabular figures are off by default (`tnum` 0 on the body, a departure from the HRM preset) and switched on per element (`.tabular`) where numbers update in place: durations, elapsed time, version codes, line numbers.

**The Sixteen-Pixel Control Rule.** Form controls never go below 16px text; phones zoom the page otherwise. (Inherited from the preset.)

## Layout

- **Shell:** a fixed-height column. Sticky 64px top bar (identity at the start; nav, Start build and sign-out at the end), then the console body.
- **Console:** from lg (1024px) a two-column grid, a 400px white rail column with a hairline end border beside a tinted detail area capped at 1440px with 16px (phone) / 24px (md+) gutters. Below lg the stream is the whole view and a commit opens the detail as its own view with a back control.
- **Detail stack:** run header panel, failure summary when present, then the stage strip; from xl (1280px) the log pane and the outputs column sit side by side at 2fr / minmax(300px, 1fr).
- **Stage strip:** a six-column grid with 12px gaps from md; a stacked list of tappable rows below md.
- **Setup:** centred, max 1180px, two columns from lg (1.35fr / 1fr). **Login:** a single centred 400px column.
- **Sheet:** a bottom sheet on phones (max 92svh, safe-area padding on the footer), centred at 576px from sm.
- **Rhythm:** 4px inside segmented tracks; 8px and 12px gaps inside components; 16px rail row and callout padding; 20-24px panel padding; 20px between detail blocks.
- **Direction:** logical properties throughout (`ms-`, `pe-`, `start-`, `text-start`); the strip fill's origin flips under RTL.

## Elevation & Depth

Flat and tonal: depth comes from white panels on tinted paper and 1px hairlines, with two shadows. Nothing lifts on hover.

### Shadow Vocabulary
- **Panel rest** (`box-shadow: 0 1px 3px rgb(16 24 40 / 0.04), 0 4px 16px -4px rgb(16 24 40 / 0.05)`): every `.panel` and the log pane.
- **Overlay** (`box-shadow: 0 24px 64px -12px rgb(15 23 42 / 0.28), 0 8px 24px -8px rgb(15 23 42 / 0.12)`): the sheet, over an ink scrim at 45% with a 2px backdrop blur.
- **Selected segment** (`box-shadow: 0 1px 2px rgb(15 23 42 / 0.08), 0 0 0 1px var(--color-line)`): the chosen option lifting to white in a segmented track.

### Named Rules
**The Static Panels Don't Lift Rule.** Panels are information, not buttons; they get no hover shadow or transform. Hover feedback is a fill change (`line-soft` or `brand-wash`).

## Shapes

Three nested radii: 8px for controls and callouts, 12px for cards, the log pane, the segmented track and the Play strip, 20px for panels; the sheet uses 16px (top corners only on phones). Chips, the Setup dot and the ring are full circles. Stage marks are rounded strokes: ring arcs are 60° slots with 12° of air between them and round caps; strip fills are 6px full-round bars with the same air. The build-successful mark is the one angular form: a 10px square with 2px corners, turned 45° to sit in the gap after the AAB stage.

## Components

### Buttons
Compact and confident: 40px tall, 8px corners, 14px semibold.
- **Shape:** gently curved (8px, `rounded.control`).
- **Primary:** Deep Ledger Blue fill, white text, 16px horizontal padding, 8px icon gap. One per view: Start build in the top bar, Re-run failed in a failed run's header, the sheet's confirm.
- **Hover / Focus / Active:** fill steps to Ink Blue over 160ms ease-out-expo; focus is a 2px brand outline at 2px offset; press scales to 0.98; disabled drops to 55% opacity.
- **Secondary:** white fill, hairline border, body text; hover to Selection Wash with a 30% brand-tinted border and brand text. Used for Cancel and Re-run all.
- **Quiet:** 36px (40-44px when icon-only), no fill, muted text, 500 weight; hover to `line-soft` with ink text. Sign-out, refresh, close, back, "open on GitHub".

### Chips
- **Ship chip:** 20px full-round, Ship Wash fill, Ship Ink words at 11px; the tag variant adds a 40% Signal Orange border and sets the tag in Geist Mono.
- **Neutral chip:** 20px full-round, hairline border, body words (for example the rehearsal flag).

### Cards / Containers
- **Corner Style:** 20px for panels; 12px for callouts inside the rail and the Play strip.
- **Background:** white on tinted paper; status callouts use their wash with ink words.
- **Shadow Strategy:** panel rest only (see Elevation).
- **Border:** 1px `line`; the failure summary uses a 25% `fail` border on `fail-wash`.
- **Internal Padding:** 20px on phones, 24px from md.

### Inputs / Fields
- **Style:** 48px, white, 1px hairline, 8px corners, 12px side padding, ink text at 16px, Console Muted placeholder; textareas start at 112px and resize vertically. The rail's branch select is 44px with a leading branch icon.
- **Focus:** border turns Deep Ledger Blue with a 3px brand ring at 18%.
- **Error:** `aria-invalid` turns the border `fail`; the hint below it turns `fail-ink`.
- **Segmented choice:** a tinted 12px-radius track with 4px padding; options are at least 44px tall, muted at rest, and the chosen one lifts to white with ink text and the selected-segment shadow. Used for mode, track and rollout in the start sheet.

### Navigation
- **Top bar:** white at 95% with backdrop blur, 64px, hairline bottom. The brand mark (a 32px blue tile holding the six-arc ring) and "FusionHRM Android" (15px bold) over the package and repo in 12px Geist Mono.
- **Nav items:** 40px, 8px corners, 500 weight; muted at rest, `line-soft` fill with ink when current or hovered. Setup carries an 8px amber dot when setup needs attention.

### Stage Ring (signature)
Six arcs, one per stage (checkout, dependencies, tests, signed AAB, Fastlane, Google Play), clockwise from the top, each coloured by its stage state; a core dot sits in the middle.
- **Sizes:** 30px on rail nodes (3px strokes), 44px in the run header beside the state line (4px strokes).
- **Core:** an ink dot at 13% of the size; it grows to 20% and turns Signal Orange once the run shipped to Google Play (never for a rehearsal).
- **Motion:** stroke and core changes take 200ms ease-out-expo. A running arc shows Queued Sky under a Run Blue highlight 36% of its length that travels it every 2.4s; under reduced motion the running arc is solid Run Blue.
- **Rail:** nodes sit on a 2px `line` spine; a commit without a run shows a 12px hollow idle circle.

### Stage Strip
The ring unrolled: six columns, each a 6px full-round bar filling left to right in 200ms with the stage's arc colour, then a state glyph, the stage name (14px, 500; selected goes 600 ink with a 2px brand underline) and its duration or state word in 12px muted. Skipped and waiting slots keep an idle outline. The diamond sits in the gap after Signed AAB and fills green once a signed bundle exists.

### State Glyphs
Lucide circle glyphs at 16px, stroke 2.2, in the status hue: check (passed), x (failed), dot (running), dashed (queued), minus (skipped), ban (cancelled), plain circle (waiting). They never animate; the ring does that job.

### Log Pane
The one dark surface: `log` ground, 12px corners, panel-rest shadow. A `log-raised` toolbar holds job tabs, a 36px filter field, a raw toggle, download and the live-log link. Steps are 44px disclosure rows with durations in mono; a failed step's name is `log-error` and semibold. Lines are 12.5px Geist Mono at 1.6 with muted line numbers; error and warning lines carry their word prefix and a tinted row, command lines and folded group headers use `log-group`. Off-screen chunks skip layout (`content-visibility: auto`).

### Sheet
The one overlay: a native `<dialog>`, a bottom sheet on phones and a centred 576px card from sm, 200ms rise and fade over an ink scrim. Header with an 18px title and muted description over a hairline, scrolling body, `page`-tinted footer for the actions.

### Play Tracks
A four-cell strip (production, beta, alpha, internal) of white cells divided by 1px hairlines inside a 12px-radius frame: track name at 11px (Ship Ink for production, muted otherwise), then the live version code in Geist Mono semibold, or "empty".

## Do's and Don'ts

### Do:
- **Do** colour words by role (`ink`, `body`, `muted`) and print status words in the `*-ink` tone; let `ok`, `fail`, `run`, `warn` draw only marks.
- **Do** use the `warn` set (amber glyph, `warn-wash` fill, ink words) for missing setup, a workflow not on main and the Setup dot.
- **Do** reuse the ring's six-slot geometry (60° slots, 12° gaps, round caps) and the shared arc colour map wherever a run's stages are drawn.
- **Do** keep every state change at 200ms ease-out-expo (`cubic-bezier(0.16, 1, 0.3, 1)`) and honour reduced motion by removing the sweep, the sheet rise and the strip fill.
- **Do** put machine strings (SHA, ref, version code, tag, log) in Geist Mono and switch on tabular figures for numbers that tick.
- **Do** keep hit targets at 40px or more (44px for segmented options, rail controls and log step rows).

### Don't:
- **Don't** use Signal Orange for anything but a shipped build, a release commit, a v-tag or the production track.
- **Don't** set words in the bright status hues (`ok`, `fail`, `run`, `warn`) on white or on their washes.
- **Don't** add a second dark surface; the log pane is the only one.
- **Don't** animate anything continuously except the running arc; nothing moves when nothing is running.
- **Don't** add hover lift or shadow change to static panels.
