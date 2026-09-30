# Mobile CI/CD POC — task tracker

Status: **Phase 3 (UI) in progress.** Opened 2026-09-29 19:33 IST. Last update 20:08.
Estimated completion: **~23:45 IST** for everything, including the live end-to-end run
(ahead of the first estimate of 00:30); the live run also waits on three steps only you can
take (§4).

Progress: 3 of 7 phases done (Phase 1 all but the commit) · 26 of 45 tasks done · about
3 h 30 min of work left.

Times are estimates of working time; each phase line is updated with the real finish time
when it lands. Nothing is deleted from this file: a finished task flips to `[x]`, a changed
plan is struck through with the reason.

---

## 1. The request

> Build a complete POC for our own mobile CI/CD pipeline management system for the FusionHRM
> Android application: an internal Bitrise-like system to trigger builds, monitor them, view
> logs/results, generate the Android AAB, and release it to Google Play. GitHub Actions →
> Android build/test → Fastlane → Google Play Console. No mocked build or release states:
> real builds, real tests. Android + Google Play only. A quick UI to manage it visually,
> deployed via Docker on our machine.

## 2. Decisions (2026-09-29)

| Question | Decision |
|---|---|
| Where it lives | Standalone service in `ci_cd_app`, HRM stack (NestJS API + Next.js UI), own Docker Compose; HRM code untouched |
| Who uses it | Mobile engineers only |
| What starts a run | Console (`workflow_dispatch`), a `release:` commit on `main`, a `v*` tag on a `main` commit — all run one `release.yml` |
| Credentials | GitHub fine-grained token + Play service-account JSON, both ready; you put them in `.env` / the Setup page |
| Pushing to the mobile repo | Prepared and validated locally; **pushed only after you confirm** |
| UI structure | "Commit stream" (chosen on the decision page, seed `c05418e1`), Fusion HRM look |

## 3. Phases

| # | Phase | Estimate | Status | Finished |
|---|---|---|---|---|
| 0 | Discovery and decisions | 20 min | done | 19:53 |
| 1 | Mobile pipeline: `release.yml`, plan script, Fastlane | 40 min | done (commit prepared at push time) | 20:00 |
| 2 | Console API (NestJS) | 60 min | done | 20:08 |
| 3 | Console UI (Next.js, commit stream) | 80 min | in progress | |
| 4 | Docker deploy on this machine | 25 min | | |
| 5 | Live end-to-end run on GitHub + Google Play | 40 min | waits on §4 | |
| 6 | Design finish: review, fixes, DESIGN.md | 35 min | | |

### Phase 0 — Discovery and decisions (done)

- [x] Map the HRM platform: NestJS 11 backend, Next.js 16 frontend, Docker Compose deploy.
- [x] Map the mobile repo: `ci.yml` (tests) only on `feat/crm-project-attendance`, none on
      `main`; upload keystore and `key.properties` committed; package `com.fusionapps.fusionhrm`.
- [x] Read the existing HRM `POST /mobile-release` module (Bitrise trigger, out of credits).
- [x] Confirm Flutter 3.47.5 (the version `ci.yml` pins) is a real stable release.
- [x] Decision round: placement, users, credentials, triggers.
- [x] PRODUCT.md written.
- [x] Design round: "Commit stream" chosen; direction contract in `.impeccable/surfaces/`.

### Phase 1 — Mobile pipeline (`mobile-pipeline/`, mirrors the mobile repo)

- [x] `.github/scripts/release-plan.sh` — decides mode/track/notes/version for each trigger.
- [x] `.github/workflows/release.yml` — Plan → Tests (+ optional emulator suite) → Signed AAB →
      Google Play (Fastlane); Play-access check mode.
- [x] `fastlane/Fastfile` + `Appfile`: `deploy` and `play_status` lanes.
- [x] `Gemfile` + `Gemfile.lock` — fastlane 2.240.1, resolved in a `ruby:3.3` container.
- [x] Plan-script checks — `tests/release-plan.test.sh`: **54 passed** (dispatch, `release:` and
      `release(<track>):` commits, file-notes / annotated / bare tags, tag off main, bad tag,
      blank and 501-character notes, bad version, bad offset). shellcheck clean.
- [x] `actionlint` clean on `release.yml`.
- [x] `bundle exec fastlane lanes` lists `deploy` and `play_status`.
- [x] Local signed AAB from `main` (Flutter 3.38.4): 64.7 MB, signed by
      `CN=PrithiyaC, OU=SkillHive` (SHA-256 `ED:6C:00:56:…:E8:02:D3`), R8 mapping present.
      **Note:** `feat/crm-project-attendance` replaced the keystore today (`3dc8033`); only the
      key registered in Play Console > App integrity > Upload key will be accepted.
- [ ] Commit prepared in a separate worktree on `origin/main` (+ store README section).

### Phase 2 — Console API (`apps/api`)

- [x] GitHub client: ETag cache (304s cost no rate limit), redirects, readable errors.
- [x] Stream: branch commits + their runs, release commits and tags flagged.
- [x] Run detail: jobs, steps, six-stage mapping, artifacts, first failure with its `##[error]` lines.
- [x] Artifacts: plan, test results (Flutter JSON reporter), build info, Play release info.
- [x] Logs: per-job text; honest "available when the job finishes" while it runs.
- [x] AAB download (unzipped from the artifact), R8 mapping download.
- [x] Start run (`workflow_dispatch` with run id back), cancel, re-run failed, re-run all.
- [x] Setup: token, repo, workflow on main, Fastlane, signing files, Play secret, Play status.
- [x] Play key upload → sealed-box encrypted → GitHub Actions secret (never stored here).
- [x] Login: one shared password from `.env`, signed httpOnly session cookie.
- [x] Unit tests: **55 passed** — stage mapping (11 scenarios), run states, release markers,
      test-report parsing, error lines, artifact zips, sessions, ETag/redirect/401 over real
      HTTP, sealed-box round trip. `tsc` clean.

### Phase 3 — Console UI (`apps/web`)

- [ ] Tokens and shell from the Fusion HRM default preset; Montserrat + Geist Mono.
- [ ] Commit stream: branch switcher, rail with six-arc stage rings, release and tag flags.
- [ ] Run view: header, six-stage strip, steps, log pane, outputs (AAB, tests, Google Play).
- [ ] Start-build sheet: branch, build / release / Play check, track, notes, status.
- [ ] Setup page: checklist, Play key upload, triggers explained.
- [ ] Login page.
- [ ] Loading, empty, error and "not configured" states; phone layout.

### Phase 4 — Docker deploy

- [ ] Dockerfiles (API, web standalone), `docker-compose.yml`, `.env.example`, README.
- [ ] Build and start on this machine; health check green.

### Phase 5 — Live end-to-end run (needs you)

- [ ] **You:** GitHub token + console password in `ci_cd_app/.env`.
- [ ] **You:** confirm the push of the pipeline commit to the mobile repo's `main`.
- [ ] **You:** Play service-account JSON uploaded on the Setup page (or as a GitHub secret).
- [ ] Setup page all green.
- [ ] "Check Play access" run: key valid, version codes per track read back.
- [ ] Build run: tests pass, signed AAB downloads from the console.
- [ ] Release run to the **internal** track: Fastlane upload lands on Google Play.

### Phase 6 — Design finish

- [ ] Desktop + phone screenshots, detector pass.
- [ ] Finish review (fresh reviewer), fixes, verdict.
- [ ] DESIGN.md + `.impeccable/design.json` from the shipped build.

## 4. What only you can do

1. Put `GITHUB_TOKEN` (fine-grained, mobile repo: Actions read/write, Contents read,
   Secrets read/write) and `CONSOLE_PASSWORD` in `ci_cd_app/.env` — I never read credentials
   from elsewhere on the machine.
2. Say "push" for the pipeline commit to the mobile repo's `main` (GitHub only runs a
   dispatched workflow that exists on the default branch).
3. Upload the Play service-account JSON on the Setup page.

## 5. Known limits (POC)

- GitHub publishes a job's full log when the job ends; while it runs the console shows live
  step states and links to GitHub's live log.
- One shared console password; no per-user accounts or audit trail beyond GitHub's own.
- The upload keystore is committed in the mobile repo (existing setup, kept as is). Anyone
  with read access to that repo can sign builds as you; moving it to secrets is a follow-up.
- HRM `POST /mobile-release` still points at Bitrise; repointing or removing it is a follow-up.
