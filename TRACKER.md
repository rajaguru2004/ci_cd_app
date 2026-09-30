# Mobile CI/CD POC — task tracker

Status: **Built, deployed on this machine, verified end to end on this server: a source ZIP
uploaded in the console ran tests, built and signed the AAB, and passed Google Play's
validation (rehearsal, nothing published).** The same run on GitHub Actions waits on your
steps in §4. Opened 2026-09-29 19:33 IST; resumed 2026-09-30 12:07; last update 2026-09-30
18:35.

Progress: 7 of 8 phases done (Phase 5's GitHub half waits on §4). Remaining after your
steps: about 40 minutes (a Play-access check, a build, a rehearsal and a real internal
release on GitHub Actions).

Nothing is deleted from this file: a finished task flips to `[x]`, a changed plan is struck
through with the reason.

---

## 1. The request

> Build a complete POC for our own mobile CI/CD pipeline management system for the FusionHRM
> Android application: an internal Bitrise-like system to trigger builds, monitor them, view
> logs/results, generate the Android AAB, and release it to Google Play. GitHub Actions →
> Android build/test → Fastlane → Google Play Console. No mocked build or release states:
> real builds, real tests. Android + Google Play only. A quick UI to manage it visually,
> deployed via Docker on our machine.

2026-09-30: "connect the Play Console key and verify; implement end to end, verify, deliver a
solid working stable output which will be deployed on one of the servers."

## 2. Decisions

| Question | Decision |
|---|---|
| Where it lives | Standalone service in `ci_cd_app`, HRM stack (NestJS API + Next.js UI), own Docker Compose; HRM code untouched |
| Who uses it | Mobile engineers only |
| What starts a run | Console (`workflow_dispatch`), a `release:` commit on `main`, a `v*` tag on a `main` commit — all run one `release.yml` |
| Default track for `release:` commits | `internal` (was production under Bitrise); `release(production): …` or the repo variable `PLAY_DEFAULT_TRACK` changes it — **confirm (§4)** |
| Version codes | run number + 1000; Play's highest is 9 |
| UI structure | "Commit stream" (decision page, seed `c05418e1`), Fusion HRM look |
| Pushing to the mobile repo | Prepared as a local commit; the push to `main` was blocked by the permission guard — **yours (§4)** |

## 3. Phases

| # | Phase | Estimate | Status | Finished |
|---|---|---|---|---|
| 0 | Discovery and decisions | 20 min | done | 09-29 19:53 |
| 1 | Mobile pipeline: `release.yml`, plan script, Fastlane | 40 min | done (push pending, §4) | 09-30 12:31 |
| 2 | Console API (NestJS) | 60 min | done | 09-30 12:36 |
| 3 | Console UI (Next.js, commit stream) | 80 min | done | 09-30 12:34 |
| 4 | Docker deploy on this machine | 25 min | done | 09-30 12:36 |
| 5 | Live end-to-end run on GitHub + Google Play | 40 min | Google Play half done; GitHub half waits on §4 | |
| 6 | Design finish: review, fixes, DESIGN.md | 35 min | done (run screens to capture on the first real run) | 09-30 12:52 |
| 7 | Upload a source ZIP → the console runs the pipeline itself | 4 h | done, verified end to end | 09-30 18:31 |

### Phase 7 — Source ZIP upload, pipeline run on this server (requested 09-30 17:15)

> "there will be option in git to download the source code as the zip, so that i will download
> and i will upload in our platform, so our platform will extract the code and run the pipeline"

Flow: GitHub → Code → Download ZIP → console → Start build → Source: Upload ZIP → the console
extracts it and runs the same stages as `release.yml` on this server (dependencies, analysis
and tests, signed AAB, Fastlane → Google Play), shown in the same run view. Needs no GitHub
token. The commit SHA GitHub writes into the ZIP ties the run to its commit on the rail.

| Task | Estimate | Status |
|---|---|---|
| Builder service: safe ZIP extraction, the pipeline's jobs and steps, live logs in GitHub's format, queue, cancel, re-run; build steps run unprivileged, only Fastlane sees the Play key | 70 min | done · 31 tests |
| Builder image: JDK 17, Android SDK, Flutter 3.47.5, Ruby + Fastlane, Node | 15 min + build | done · 8 GB; Kotlin compiles inside Gradle's capped heap; tini reaps leftovers |
| API: upload endpoint, builder client, local runs in the run view and the commit stream, version codes from Google Play | 45 min | done |
| UI: source choice and upload with progress in the start sheet, builds on this server without GitHub, live logs | 45 min | done |
| Compose, deploy script, README | 20 min | done |
| Real run: a ZIP of `main` → tests → signed AAB → rehearsal to Google Play | 40 min | done: `main` itself fails its own tests today (§4); `main` + the two fixes passed every stage (ZIP run #4: 323 tests, AAB 1.0.1 (1004) signed with the upload key, Google Play validation passed) |
| Run screens captured with real data; design check | 25 min | done: upload sheet, live build, failed tests, finished run with AAB, Setup; DESIGN.md records the new parts |

Found on the way (all fixed, with tests):

- The web container's `/api/*` rewrite buffers request bodies and cuts them at 10 MB, so a
  34 MB GitHub ZIP never reached the API. Uploads now stream through their own route.
- The rail fell back to "builds on this server" only without a token; a token that cannot see
  the repo (404) left an empty page. Any unreadable GitHub now shows the ZIP builds.
- Setup names the token's account and the fix when GitHub hides the repo (404).
- **Google Play keeps one open edit per app; a new edit ends the one before it.** Two console
  reads at once failed each other ("This Edit has been deleted"), and a console read during a
  Fastlane upload would have failed the release. Reads are now one at a time, and none is
  opened while a run's Google Play job holds an edit (the last read is shown instead).
- Setup's version-code card still described run number + 1000 for every run; it now shows the
  next code a console run gets (Play's highest + 1).

### Phase 0 — Discovery and decisions (done)

- [x] Map the HRM platform: NestJS 11 backend, Next.js 16 frontend, Docker Compose deploy.
- [x] Map the mobile repo: `ci.yml` only on `feat/crm-project-attendance`, none on `main`;
      upload keystore and `key.properties` committed; package `com.fusionapps.fusionhrm`.
- [x] Read the existing HRM `POST /mobile-release` module (Bitrise trigger, out of credits).
- [x] Confirm Flutter 3.47.5 (the version `ci.yml` pins) is a real stable release.
- [x] Decision round; PRODUCT.md; design round ("Commit stream"); direction contract.

### Phase 1 — Mobile pipeline (`mobile-pipeline/`, mirrors the mobile repo)

- [x] `.github/scripts/release-plan.sh` — decides mode/track/notes/version for each trigger.
- [x] `.github/workflows/release.yml` — Plan → Tests (+ optional emulator suite) → Signed AAB →
      Google Play (Fastlane); Play-access check mode; rehearsal mode.
- [x] `fastlane/Fastfile` + `Appfile`: `deploy` (with `PLAY_VALIDATE_ONLY`) and `play_status`.
- [x] `Gemfile` + `Gemfile.lock` — fastlane 2.240.1, resolved in a `ruby:3.3` container.
- [x] Plan-script suite `tests/release-plan.test.sh`: **63 passed** (dispatch, rehearsal,
      `release:` and `release(<track>):` commits, file-notes / annotated / bare tags, tag off
      main, bad tag, blank and 501-character notes, bad version, bad offset). shellcheck clean.
- [x] `actionlint` clean on `release.yml`.
- [x] Local signed AAB from `main`: 64.7 MB, signer `CN=PrithiyaC, OU=SkillHive`, SHA-1
      `67:D7:42:A7:E1:36:2A:F4:47:B5:E7:0E:27:11:B0:28:CA:10:3D:E0`, R8 mapping present.
- [x] `feat/crm-project-attendance` AAB signs with the **same** upload key (safe to merge).
- [x] **Google Play accepted the `main` AAB** in a validate-only upload to internal
      (versionCode 1001; nothing published) — the committed keystore is the registered key.
- [x] **Rehearsal of the CI release job** (`deploy` lane, validate-only, real Play): bundle,
      R8 mapping and en-US changelog uploaded into an edit and validated; `release-info.json`
      written. `play_status` lane read all tracks; `play-status.json` written.
- [x] Store README "Releasing to Google Play" rewritten for the new pipeline.
- [x] Commit prepared on branch `ci/release-pipeline` of the mobile repo: `dc3b225`
      (CI files only).
- [ ] **Push to the mobile repo's `main`** — blocked by the session's permission guard; yours
      (§4). ~~Push it from this session~~ (not allowed without your explicit go-ahead).

### Phase 2 — Console API (`apps/api`)

- [x] GitHub client: ETag cache (304s cost no rate limit), redirects without the token, one
      retry for reads that fail in transit, readable errors.
- [x] Stream, run detail (jobs, steps, six-stage mapping, first failure with its `##[error]`
      lines), artifacts (plan, Flutter test report, build info, Play release info).
- [x] Logs (honest "available when the job finishes" while running), AAB + R8 mapping download.
- [x] Start run (`workflow_dispatch`, run id back; build / release / rehearsal / Play check),
      cancel, re-run failed, re-run all.
- [x] Google Play client: service-account JWT → OAuth token → read-only edit of every track;
      explains a missing invite, a disabled API, a revoked key; retries a transient failure.
- [x] Setup: token, repo, workflow on main, Fastlane, signing files, console Play key (live),
      Play secret, Play-access run; "copy the console key into the GitHub secret" (sealed box).
- [x] Sign-in: shared password, signed httpOnly cookie, 10 failures per address → 15-minute
      lockout; real client address through the proxies.
- [x] Tests: **79 passed** — including 10 end-to-end against a GitHub-shaped HTTP server
      (sign-in, stream, run detail, logs, AAB, dispatch with rehearsal, refusals, cancel,
      re-run) and the Play client over HTTP. `tsc` clean.

### Phase 3 — Console UI (`apps/web`)

- [x] Tokens and shell from the Fusion HRM default preset; Montserrat + Geist Mono;
      contrast-checked muted (#5B6679, 5.37:1) and orange text (#B34700, 5.50:1).
- [x] Commit stream with six-arc stage rings, release/tag flags, "runs elsewhere".
- [x] Run view: header with the ring, six-stage strip, failure callout, per-step log pane
      (folds, filter, download), outputs (AAB, tests, Google Play).
- [x] Start sheet (build / release / rehearsal / Play check), Setup page, sign-in page.
- [x] Live "On Google Play" strip read with the console's key.
- [x] Loading, empty, error, not-configured states; phone layout.
- [x] Detector: no findings.

### Phase 4 — Docker deploy

- [x] Non-root images with health checks; Play key as a read-only compose secret; logs rotated.
- [x] `.env.example`, `scripts/deploy.sh` (up / push / server / check / logs / down, with a
      preflight), README runbook for a server.
- [x] Running here: http://127.0.0.1:7080 — both containers healthy; sign-in, session, live
      Play read and Setup verified through the proxy.
- [x] `ci_cd_app` is a git repository with one commit (`90d1221`); secrets, `.env` and
      `.work/` are ignored (staged files scanned before committing).

### Phase 5 — Live end-to-end run

- [x] Google Play key verified live (tracks read; production "Second Release", code 9).
- [x] Upload key and release path verified against Google Play (validate-only, above).
- [x] The whole pipeline on this server from an uploaded ZIP (Phase 7): tests, signed AAB,
      Google Play validation.
- [ ] **You:** push `ci/release-pipeline` to the mobile repo's `main` (§4).
- [ ] **You:** `GITHUB_TOKEN` in `ci_cd_app/.env`, then `./scripts/deploy.sh up` (§4).
- [ ] Setup → copy the console key into the GitHub secret; Setup all green.
- [ ] "Check Play access" run on GitHub Actions.
- [ ] Build run: tests pass, signed AAB downloads from the console.
- [ ] Rehearsal release to internal, then a real release to internal.

### Phase 6 — Design finish

- [x] Desktop + phone screenshots of every state that renders without GitHub data.
- [x] Finish review (fresh reviewer): disposition **fix**, 8 material fixes — all applied in one
      batch, plus both "ceiling" raises (the ring in the run header, ship flags in the header).
- [x] Second fix batch (warning words in ink, neutral rehearsal pill, sans sentence); reviewer's
      verdict: **ship** — scoped to the fixes; run surfaces reviewed from source.
- [x] DESIGN.md + `.impeccable/design.json` written from the shipped build by the documenter.
- [x] Provenance scan: the UI ships no raster images (SVG only).
- [x] Run surfaces captured on real ZIP runs (upload sheet, live build, failed tests, Setup).
- [ ] Capture a finished run with its AAB and Play rehearsal (on the real run).

## 4. What only you can do

0. **The GitHub token in `.env` belongs to @rajaguru2004 and cannot see the org repo** (GitHub
   answers 404). Make a fine-grained token with Resource owner `the-reciprocal-solutions` (an
   org owner may have to approve it), repository `human-resource-management-mobile-ess`, and
   the permissions below. ZIP builds work without it.
0. **Mobile `main` fails its own gates today**: 32 smoke tests (a 0.25 px overflow in the
   dashboard's week row on dates like "Wed 30") and the widget-key ratchet (26 < baseline 27).
   Both fixes are on the local branch `fix/main-test-gates` of the mobile clone (`0b0af6e`,
   `a2d8a3f`), verified on this server; push or cherry-pick them.

1. **Push the pipeline** (the permission guard stopped me pushing to the org repo's `main`):
   `git -C ~/StudioProjects/CRM/human-resource-management/human-resource-management-mobile-ess push origin ci/release-pipeline:main`
   — or tell me to, explicitly.
2. **GitHub token** into `ci_cd_app/.env` as `GITHUB_TOKEN` (fine-grained, mobile repo only:
   Actions read/write, Contents read, Secrets read/write, Variables read). The SSH key you gave
   works for git but cannot call the GitHub API.
3. Confirm `internal` as the default track for `release:` commits (Bitrise used production).
4. Where the console's own repository should live (it is a local git repo now), and which
   server and hostname it goes on.

## 5. Known limits (POC)

- GitHub publishes a job's full log when the job ends; while it runs the console shows live
  step states and links to GitHub's live log.
- One shared console password; no per-user accounts. GitHub records every run under the
  token's owner.
- The upload keystore is committed in the mobile repo (existing setup, kept as is). Anyone
  with read access to that repo can sign builds as you; moving it to secrets is a follow-up.
- HRM `POST /mobile-release` still points at Bitrise; repointing or removing it is a follow-up.
- The Play service-account key passed through a chat session: rotate it once live (README).
- Google Play keeps one open edit per app. The console never opens one while a run's Google
  Play job is running, but a GitHub release and a ZIP release uploading at the same moment
  would still end each other's edit: release from one place at a time.
- ZIP runs run one at a time on this server; the first build on a new server downloads the
  Gradle distribution, the NDK (about 1 GB) and the Maven dependencies (tens of minutes). Later
  builds use the caches.
