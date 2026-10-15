# Mobile CI/CD POC — task tracker

Status (2026-10-15 20:17 IST): **Phase 10 done and proven on a real Mac — FusionEco FieldOps
1.1.0 (10) released to TestFlight from this console (run 17: tests, signed IPA and Apple's
processing in about 18 minutes; §10, "first real Mac").** Phase 9 done: Build and Release run on this server by default, or, per app, on
the app's own GitHub Actions (Settings → Where builds run). Waiting on you: the console's
public key on GitHub (§8), and a GitHub token (§9, "What only you can do") before GitHub Actions
can run anything for real. Opened 2026-09-29 19:33 IST; Phase 8 opened 2026-10-10 13:25 IST,
finished 14:45; Phase 9 opened 16:05, finished 17:11 (≈1 h 6 min against the 4 h 10 min
estimate); Phase 10 opened 2026-10-13 15:13 IST.

Before Phase 8: built, deployed on this machine, verified end to end on this server (a source
ZIP ran tests, built and signed the AAB, passed Google Play's validation; real releases put
1.0.1 (1007) and later (1009) on the internal track).

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
- [x] Real release to the internal track, on your go-ahead: 1.0.1 (1007), built from
      `fix/main-test-gates` (`a2d8a3f`); Google Play lists it as completed.
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

1. **Push the two fixes for mobile `main`.** `main` fails its own gates today: 32 smoke tests
   (a 0.25 px overflow in the dashboard's week row on dates like "Wed 30") and the widget-key
   ratchet (26, below the baseline of 27). Both fixes are on the local branch
   `fix/main-test-gates` of the mobile clone (`0b0af6e`, `a2d8a3f`), verified on this server.
   The internal release of 2026-09-30 was built from `a2d8a3f`.
2. **Push the pipeline** (the permission guard stopped me pushing to the org repo's `main`):
   `git -C ~/StudioProjects/CRM/human-resource-management/human-resource-management-mobile-ess push origin ci/release-pipeline:main`
   (commit `b909d28`), or tell me to, explicitly.
3. **A GitHub token that can see the org repo.** The one in `.env` belongs to @rajaguru2004,
   and GitHub hides the repo from it (404). Fine-grained, Resource owner
   `the-reciprocal-solutions` (an org owner may have to approve it), repository
   `human-resource-management-mobile-ess` only: Actions read/write, Contents read, Secrets
   read/write, Variables read. ZIP builds work without it.
4. Confirm `internal` as the default track for `release:` commits (Bitrise used production).
5. Where the console's own repository should live (it is a local git repo now), and which
   server and hostname it goes on.
6. Internal testers: Play Console → Testing → Internal testing → Testers (an email list), then
   share the opt-in link.

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

---

## 8. Universal console: many apps, SSH access, keys in a vault (opened 2026-10-10 13:25 IST)

> "our cicd pipeline app looks like it is made for our hrm app alone … it has to be universal
> where we should able to manage multiple apps … for any other user using our service too get
> their git email id, generate a ssh key from our side, then while pasting ask them for the ssh
> url … whenever they click release in our web app, run the git pull test build then release …
> also provide provision to upload jks key file and other required key file for proper
> successful release"

Decisions taken without stopping (your standing preference: questions batched at the end):

| Question | Decision |
|---|---|
| Where runs execute | On this server's builder, for every app: git pull over SSH → tests → signed AAB → Fastlane → Google Play. The GitHub Actions path (token, `workflow_dispatch`, `release.yml`) leaves the console: it never ran (token could not see the org repo) and SSH replaces the token. ZIP upload stays as a second source. |
| Repository access | Per person: their git email → the console generates an ed25519 key (comment = the email) → they add the public key to their GitHub/GitLab/Bitbucket account (or as a deploy key) → they paste the repo's SSH URL → the console checks it with `git ls-remote`. Any git host that speaks SSH works. |
| Where secrets live | Only in the builder's vault, encrypted (AES-256-GCM, `VAULT_KEY` in `.env`): SSH private keys, keystores and their passwords, per-app Play keys. The console API holds none; build steps (the app's own code) never see the upload key. |
| Signing | Per app: "upload a keystore" (the console signs the finished bundle itself, as root, with `jarsigner`; Gradle signs with a throwaway key so a project's own signing config never blocks the build) or "the repository's signing" (key.properties committed, as FusionHRM does today). |
| Google Play key | Per app: its own service-account JSON, or the console's default key (the one mounted today). |
| Version codes | Per app, at the start of each run: max(Play's highest + 1, the highest this console used + 1, pubspec build number). |
| App types | Flutter apps (every app in the org's folders is Flutter). Native Android projects are refused with a sentence. |
| Overview layout | Concept roll `fec4f208` dealt "app card grid" as the lead (unattended run: the dealt lead is built). |

| # | Task | Estimate | Status |
|---|---|---|---|
| 8.1 | Prove the signing approach on a real build (injected throwaway key, re-sign with jarsigner) | 20 min | done 13:30 — FusionHRM `a2d8a3f` built with `-P android.injected.signing.*` → signer `CN=Release Console throwaway` (the project's own key.properties overridden); re-signed as root with the real upload key → `CN=PrithiyaC`, `67:D7:42:…`, nested `base/root/META-INF` kept |
| 8.2 | Builder: vault, SSH keys, git mirror/ls-remote/inspect/commits, apps registry, Play client + edit guard + version codes, git checkout + project checks + re-sign in the pipeline, per-app run numbers, HTTP API, tests | 5 h | done 13:49 · 95 tests, including git over a real sshd with a console-made key and signing with real keytool/jarsigner |
| 8.3 | Fastlane lanes take the package from the run (no FusionHRM constant) | 15 min | done; `release.yml`, `release-plan.sh` and their tests retired (git history keeps them) |
| 8.4 | API: drop GitHub; apps, keys, runs, uploads (ZIP, keystore, Play JSON), commit stream, setup; tests | 3 h | done · 49 tests (end to end against a builder-shaped server) |
| 8.5 | UI: Apps overview, Add app (email → key → SSH URL → check → app → keys), app console, app settings, Git keys, Setup, Release sheet, top bar with app switcher and builder status | 5 h | done; detector clean; finish review: fix (8 items) → fixed, verdict pending |
| 8.6 | Compose, `.env`, deploy script (VAULT_KEY, openssh in the builder as a top layer) | 30 min | done; `VAULT_KEY` generated into `.env`; deployed here |
| 8.7 | End to end on this server: a local SSH git server holding the FusionHRM repo → key → URL → check → app → uploaded keystore → build → rehearsal release (validate-only) | 1.5 h | **done** — through the real UI: key made for rajaguru20042@gmail.com, added to the SSH server's authorized_keys (as on GitHub), access check read `Fusion HRM` / `com.fusionapps.fusionhrm`, keystore checked and stored; run #10 pulled `a2d8a3f` over SSH, 323 tests + both project checks passed, AAB re-signed by the console with the upload key (`ED:6C:00:56:…:D3`), **Google Play validated 1.0.1 (1010) on internal** (nothing published). The 9 earlier runs were adopted as Fusion HRM #1–#9. Real GitHub answered the not-yet-added key with "github.com refused the key for rajaguru20042@gmail.com (Permission denied)…" |
| 8.8 | Design finish: screenshots, finish review, fixes, DESIGN.md; README, PRODUCT.md | 1.5 h | done 14:45 — README and PRODUCT.md rewritten for the Release Console; DESIGN.md and `.impeccable/design.json` recorded from the shipped build; the documenter's three flags fixed and checked on the live console (a non-production Track fact is ink, not orange; every transition eases out-expo, hovers 160 ms; the passed-test count is the mono figure); its fourth (mono falling back) checked and false: Geist Mono loads |

Estimate ≈ 17 h of work; ETA 2026-10-11 ~07:00 IST if worked straight through.

### Phase 8 — results (2026-10-10)

Verified on this machine, with the console's own images:

- **Add app through the UI** (Playwright on the live console): git email → ed25519 key made by the
  console → its public line added to an SSH git server standing in for GitHub → an HTTPS URL
  refused with the SSH form to use → `git ls-remote` with the key (6 branches) → the project read
  off the branch (`ess_portal 1.0.1+9`, `com.fusionapps.fusionhrm`, label "Fusion HRM",
  key.properties committed) → app created → the upload keystore checked (signs a probe JAR) and
  sealed in the vault.
- **Release rehearsal from the release sheet** (run #10): pulled `a2d8a3f` over SSH, 323 tests and
  both `tool/check_*.dart` passed, Gradle signed with a throwaway key, the console re-signed the AAB
  with the stored upload key (`CN=PrithiyaC`, SHA-256 `ED:6C:00:56:…:D3`), **Google Play validated
  1.0.1 (1010) for internal** — nothing published. 4 min 9 s end to end on warm caches.
- **Real GitHub** answered the console's key with "github.com refused the key for
  rajaguru20042@gmail.com (Permission denied)…" until it is added (expected); its host key was
  pinned as `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` (GitHub's published ED25519).
- **History kept:** the nine earlier ZIP runs (incl. the internal releases 1007 and 1009) belong to
  Fusion HRM as #1–#9; #10 is the rehearsal above; #11 a build started and cancelled to check the
  running view.
- **Isolation checked in the container:** the build user cannot list the vault or the mirrors,
  cannot read any run's artifacts or logs (root:1000 0750), cannot write uploads; after each run
  the checkout, the throwaway key and the Fastlane folder are gone and `/dev/shm` is empty.
- Tests: builder 96 (incl. git over a real sshd and signing with keytool/jarsigner), API 49;
  web, API and builder typecheck clean; design detector clean.
- Design: finish review → fix (8 items) → verdict: 1, 2, 4, 7 resolved; 3, 5, 6 partial → fixed
  after the verdict (phone blockers panel, Settings action rows, running header now shows the
  commit) and checked on captures, not re-scored (the review budget was two rounds); DESIGN.md
  rewritten by the documenter, whose three flagged slips were fixed and checked on the live build.

Final state: one app, **Fusion HRM**, pointed at
`git@github.com:the-reciprocal-solutions/human-resource-management-mobile-ess.git` (branch `main`),
signed by the console with the upload keystore from the repository, released with the console's
default Play key. It cannot pull until the key below is on GitHub.

### What only you can do (Phase 8)

1. **Add the console's key to GitHub** (your account `rajaguru2004`, which can open the org
   repo): GitHub → Settings → SSH and GPG keys → New SSH key, title "Release Console", paste
   (also on the console: Git keys → Public key, or the app's "Copy the public key"):
   `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJs9zjQRj0nA0pp4oH7Rvci0Fp5LTCuuCSTBIGMKEYUR rajaguru20042@gmail.com`
   Then Fusion HRM → Settings → Check access. (For one repository only, add it as a deploy key.)
2. **Fusion HRM's `main` still fails its own tests** unless the two fixes from
   `fix/main-test-gates` were pushed since 09-30: a Release of `main` would stop at Tests.
3. **Keep a copy of `VAULT_KEY`** from `.env` somewhere safe: every stored key is sealed with it.
4. Rotate the Play service-account key (it passed through a chat session on 09-29/30), then put
   the new JSON in `secrets/play-service-account.json` or upload it per app.

### Known limits (Phase 8)

- One shared console password; keys record whose git email they were made for, runs record
  "console" as who started them.
- Flutter apps only, one Flutter version (3.47.5) for all apps; flavors other than a single
  `bundle/<flavor>Release` output are not handled.
- One build at a time for every app on this builder.
- Builds of different apps share the Gradle and pub caches (same organization's code).
- A key added to a person's account reaches everything that account can open; use deploy keys
  for narrower access.
- Google Play requires each app's first upload by hand in Play Console.

---

## 9. GitHub Actions back, as a per-app choice (opened 2026-10-10 16:05 IST)

> "why github actions code deleted?? it also has to be a option, why removing option, giving as
> many option would actually elevate the user experience right?"

Phase 8 retired the GitHub Actions path instead of making it work for every app; that was the
console's call, not yours, and it is reversed here. Decisions taken without stopping:

| Question | Decision |
|---|---|
| The choice | Per app, "Builds run on": **This server** (default; any git host) or **GitHub Actions** (repositories on github.com). The release sheet can override it for one run. |
| What runs where | The console plans every run itself (git pull of its mirror, project checks, Google Play's highest version code, the commit), then starts the app's workflow with that plan and follows it: the same six stages, logs, test report, AAB and Play answer as a server run, copied back to the console when each job ends. |
| Keys on GitHub | The app's code never meets a key there either: Gradle signs with a throwaway key in **Signed AAB**; a separate **Sign AAB** job, which runs none of the app's code, applies the upload key; **Google Play** runs no app code. The console copies the keystore, its passwords and the Play key into the repository's Actions secrets (sealed for GitHub), and refreshes them before a run when they changed. |
| The workflow | One generic file the console writes: `.github/workflows/release-console.yml` (Fastlane lanes inside it). "Add it for me" commits it to the default branch with the app's GitHub token, or opens a pull request when the branch is protected; "Copy" gives the YAML to commit by hand. The console says when the file in the repository differs from its own. |
| GitHub token | The console's default (Setup) or the app's own, sealed in the vault. Fine-grained: Actions, Contents, Secrets and Workflows read/write on the app's repositories. Classic: `repo` + `workflow`. |
| Concurrency | GitHub runs do not wait for the server's one-at-a-time queue. Google Play uploads of one app take turns (job concurrency per package); the console refuses a third release of an app while two are in flight. |

| # | Task | Estimate | Status |
|---|---|---|---|
| 9.1 | Builder: GitHub client (ETag, rate limit, downloads), sealed secrets, tokens (default and per app), checks, workflow install (commit or PR), secret sync | 40 min | done — `github.ts`, `sealed.ts`, `actions.ts`; 13 tests against a stand-in GitHub server (tokens, hidden repo, missing/outdated/disabled workflow, commit vs PR install, a token without write access, secrets sealed and kept in step) |
| 9.2 | Builder: the workflow template (generic; Fastlane inside), linted with actionlint; its signing script tested against real keytool/jarsigner | 30 min | done — `workflow.ts` (`release-console.yml`); actionlint + shellcheck clean (a planted mistake confirmed caught); 6 tests, including a real re-sign and verify with keytool/jarsigner/zip/jq |
| 9.3 | Builder: GitHub runs — plan and dispatch on the console, follow jobs/steps/logs/artifacts, cancel, re-run, resume after a restart; tests against a stand-in GitHub API | 60 min | done — `pipeline.ts`'s `githubPipeline`, `runner.ts`'s remote path; 3 end-to-end tests over a real sshd + the stand-in GitHub server (success with logs/artifacts copied, resume after a simulated restart, cancel); found and fixed a real bug in `merge()` (a build's skipped Google Play job was tracked when it should not be) |
| 9.4 | API: runner and GitHub routes, run summaries with where they ran, live-log note | 20 min | done — `apps.controller.ts` (runner, github/token, github/check, github/workflow, github/secrets), new `github.controller.ts` (the console's default token), `runs.dto.ts`/`runs.controller.ts` (runner choice on a run), `runs.service.ts` (`runner`, `remoteUrl` on every run summary), `stages.ts` (the `Sign AAB` job, the `Install Fastlane` step); logs needed no change (the builder writes the same log files either way) |
| 9.5 | UI: Settings → Where builds run, Setup → GitHub token, release sheet choice, run header link, logs while GitHub runs, blockers | 50 min | done — new `RunnerPanel.tsx` (segmented choice, token fact, 4-row readiness checklist with inline Add/Update workflow and Copy secrets fixes), new `GithubTokenPanel` on Setup (default token), `ReleaseSheet.tsx` (per-run "Runs on" choice + summary sentence), `RunPanel.tsx` (GitHub Actions link, trigger text), `LogPane.tsx` ("Running on GitHub Actions…" note in place of "Loading log…" while a step hasn't finished there), `AppCard.tsx` and the app console's Blockers panel (a GitHub-not-ready amber line); `apps.ts` also fixed to give an app already on github.com the option on its next read, not only on its next save (a real gap, caught live against Fusion HRM, which predates this feature) — covered by a new apps.spec.ts test; `tsc`, `next build` and the builder suite (119 tests) all clean |
| 9.6 | Deploy; end to end through the UI against a stand-in GitHub API (real GitHub needs your go-ahead) | 30 min | done — all three images rebuilt and redeployed, all healthy; the heavy end-to-end run (plan → dispatch → GitHub mirrors the jobs → logs and artifacts copied back → success; a restart between dispatch and recording the run's id, resumed; a cancel) is the Jest suite in 9.3, over a real sshd and the stand-in GitHub API, not re-driven through Playwright a second time. Through the real UI on the live console (read-only, no token configured so no real GitHub was reached): Fusion HRM's Settings shows "Where builds run" with its real `the-reciprocal-solutions/…` slug (the self-heal fix above, confirmed live), Check again correctly reports no token and leaves repository/workflow/secrets unchecked, Setup shows the new Default GitHub token row; checked on both viewports |
| 9.7 | Screens (desktop + phone), DESIGN.md, PRODUCT.md, README, this tracker | 20 min | done 17:11 — Settings and Setup screenshotted on desktop and phone against the live console (one real bug found and fixed from this: the Token readiness row said "No token" before any check had run; now says "Not checked yet" like the other three rows); PRODUCT.md (Positioning, Capabilities) and README.md ("Where builds run", Security, troubleshooting rows) rewritten; DESIGN.md and `.impeccable/design.json` updated incrementally by the documenter (new Readiness List component, the Segmented choice's new "Runs on" instance, the Blockers/App-card GitHub row) — nothing removed or renumbered, no defect in the new work, two pre-existing/out-of-scope documentation gaps flagged and left alone |

Estimate ≈ 4 h 10 min of work; ETA 2026-10-10 ~20:15 IST.

### Phase 9 — results (2026-10-10)

Verified on this machine, with the console's own images:

- **The builder:** a GitHub client with ETag caching and rate-limit tracking; tokens (the
  console's default and an app's own) verified against GitHub before they are stored; the
  readiness check (token, repository, workflow, secrets) and the workflow install (a commit, or
  a pull request on a protected branch) tested against a stand-in GitHub server — 13 tests.
- **The workflow the console writes** (`release-console.yml`, generic, Fastlane inside) is
  clean under `actionlint` and `shellcheck` (a planted mistake was confirmed caught), and its
  signing script re-signs a throwaway-signed bundle with a real upload key and verifies it with
  real `keytool`/`jarsigner`/`zip`/`jq` — 6 tests.
- **A run on GitHub Actions, through the real `Runner` and pipeline** (not a stand-in of them):
  a real `sshd` serving a Flutter-shaped repository, pulled by the Plan job on this server, its
  commit and version planned, dispatched to the stand-in GitHub server, and followed to success
  with every job's log and the test report, AAB and build info copied back; a second run
  resumed correctly after a simulated restart between dispatching it and recording its id; a
  third was cancelled mid-flight. Following this work found and fixed a real bug: `merge()` was
  tracking GitHub's own skipped "Google Play" job even on a build-only run, which the console's
  own plan never includes — 3 tests, on top of the 119 in the builder's full suite.
- **The API:** 50 tests, including a new one for the `Sign AAB` job and the `Install Fastlane`
  step mapping onto the right stage.
- **The console rebuilt and redeployed**, all three containers healthy. Checked on the live
  console (read-only; no GitHub token is configured, so nothing reached real GitHub): Fusion
  HRM's repository is already on github.com, so Settings → Where builds run already offers
  GitHub Actions with its real slug — not because anyone asked it to, but because a fix made
  during this work gives that option to an app recorded before Phase 9 existed, the first time
  it is read, not only after it is next saved. Check again correctly reported no token and left
  Repository, Workflow and Secrets at "Not checked yet" (no call to GitHub was made). Checked on
  both desktop and phone widths.
- `tsc` and `next build` clean for the API and the web app throughout.

### What only you can do (Phase 9)

1. **To actually build an app on GitHub Actions:** give the console a GitHub token — a
   fine-grained one scoped to the app's repository with Actions, Contents, Secrets and
   Workflows read/write (classic: `repo` + `workflow`), pasted either as the console's default
   (Setup → Default GitHub token) or for one app (its settings → Where builds run). None was
   pasted during this work, and the repository's existing `GITHUB_TOKEN`/`GITHUB_REPO` in
   `.env` were not reused for it — those were the retired path's, their write access to the org
   repo was never confirmed, and using them would reach the real `the-reciprocal-solutions`
   repository. Once a token is in, Settings → Where builds run → Check again, then Add the
   workflow.
2. Fusion HRM's repository is already on github.com, so it already shows the GitHub Actions
   option (see Phase 9 results below) — it still builds on this server until you switch it or
   give it a token and add the workflow.
3. The old `GITHUB_TOKEN`, `GITHUB_REPO` and `WORKFLOW_FILE` lines in `.env` are unused now
   (nothing reads them); remove them whenever you like, or keep `GITHUB_TOKEN`'s value to paste
   in as the new per-app or default token if its scopes turn out wide enough.
4. Everything from Phase 8's list still applies (the console's key on GitHub, `main`'s own
   tests, `VAULT_KEY`, the Play key rotation).

### Known limits (Phase 9)

- A GitHub Actions run does not share this server's one-build-at-a-time queue; only two
  uploads of one app to Google Play at a time are refused (a third would collide with Google's
  one-open-edit-per-app rule).
- The console writes one workflow file, the same for every app; an app with its own
  requirements inside `.github/workflows/` would need to fold them into this one by hand (the
  console only ever writes its own content, and says when the file differs).
- `Settings → Where builds run → Add the workflow` needs a GitHub token with Contents (and,
  on a protected default branch, pull-request) rights beyond what reading needs.
- A GitHub Actions run's log is copied back only once a step finishes; while it runs, the
  console points at GitHub's own page rather than tailing it live.

---

## 10. iOS on a Mac runner (opened 2026-10-13 15:13 IST)

> "create the docker runner for the mac, so that mac should be able to get connected with our
> server where we have deployed this solution; for any ios build triggered via our cicd app, it
> will send to that mac runner connected to our server, that mac acts as the worker, create the
> app and release via mac in the fastlane there in mac runner; we need that as the docker image
> pushed to docker, so that with the compose file i can setup in the mac and verify it
> successfully connect with the parent server; for testing alone this machine will act as the
> parent and mac will act as the worker"

Decisions taken without stopping (each one is yours to overrule):

| Question | Decision |
|---|---|
| What the Docker image is | The Mac's **worker agent**. Xcode cannot run inside a Linux container (Docker on macOS runs Linux in a VM), so the agent runs each build step **on the Mac itself over SSH** (`host.docker.internal`; Remote Login on; the agent's own ed25519 key in `~/.ssh/authorized_keys`, `restrict`ed). The same agent also runs without Docker (`EXECUTOR=local`). |
| How the Mac reaches the console | Outbound only: HTTP(S) to the console's own address (`http://10.193.206.192:7080` for the test; it was `192.168.0.189` until the office Wi-Fi's client isolation blocked the Mac), long-polling for work, so no port opens on the Mac. It goes `web → api → builder` like the browser does: one port, one TLS proxy for both. |
| Who may connect | A token per Mac, made in the console (Runners → Add a Mac), shown once, stored hashed in the vault. The agent's own X25519 key is pinned on its first connect; a changed key is refused until someone resets it in the console. |
| Secrets on the Mac | The distribution certificate and its password, the provisioning profiles and the App Store Connect key travel **sealed to the agent's pinned key** (X25519 + HKDF-SHA256 + AES-256-GCM: neither the web/api hop nor the network can read them), live in a per-run 0700 folder and a per-run keychain on the Mac, and are deleted when the run ends (cleanup steps run after a failure or a cancel too). |
| What runs where | **Plan** on this server (git pull of the mirror or the ZIP, the bundle ID check, the signing check, App Store Connect's highest build + 1, the source packed for the Mac), then **Tests**, **Signed IPA** and **App Store Connect** on the Mac in that order: the same six stages (labels read "Signed IPA" and "App Store Connect"). One run per Mac at a time; iOS runs queue for the first free Mac and do not wait for this server's Android queue. |
| Fastlane on the Mac | The console's own lanes, sent with each run (`mobile-pipeline/fastlane/Fastfile`, new `platform :ios`): `signing` (per-run keychain, certificate, profiles, the project switched to manual signing for every app/extension target, ExportOptions.plist), `deploy` (TestFlight, or App Review), `validate` (rehearsal), `unsign`. `flutter build ipa` builds. The Gemfile.lock pins Fastlane (`bundle exec`, gems cached on the Mac); a Homebrew `fastlane` is the fallback. |
| iOS release targets | **TestFlight** (upload, wait for Apple's processing, set "What to Test"; internal testers get it) or **App Store review** (the same upload, then submitted for review; "Roll out" releases automatically once approved, "Keep as draft" waits for someone to release it). **Rehearsal** asks App Store Connect to validate the IPA and uploads nothing. Export-compliance answers are never given on your behalf. |
| Build numbers | CFBundleVersion above App Store Connect's highest build of the app, above every iOS build this console made, never below pubspec's; CFBundleShortVersionString is the version name. Independent of Android's version codes. |
| Signing | Manual signing (an Apple Distribution .p12 + App Store profiles), checked when uploaded: the password opens the .p12, each profile is an App Store profile of the same team, unexpired, carrying that certificate. Automatic (cloud) signing and `match` are not in this phase. |
| The image | `rajaguru2004/release-console-mac-runner`, multi-arch (Apple silicon `linux/arm64` and Intel `linux/amd64`), pushed to Docker Hub as `:<version>` and `:latest`. |

| # | Task | Estimate | Status |
|---|---|---|---|
| 10.1 | Design, decisions, this tracker | 20 min | done 15:25 |
| 10.2 | Builder: Mac runners — tokens (hashed, shown once), pinned agent key, sealed run secrets, presence, the iOS run queue, the agent's routes (connect, poll, source, events, artifacts, complete), liveness, cancel, restart recovery | 2 h 30 min | done — `macs.ts` (pool, tokens hashed, key pinned, long poll, offer/accept/report/complete, lease 3 min, offer 60 s, wait 12 h, cancel, restart reconcile), `seal.ts`, agent routes in `main.ts` |
| 10.3 | Builder: iOS per app — bundle ID, distribution certificate (.p12 opened and read), provisioning profiles (parsed, matched to the certificate and bundle ID), App Store Connect API key (ES256 JWT; reads the app and its builds) | 2 h | done — `ios.ts` (plist/CMS profile reader, .p12 via keytool, readiness), `appstore.ts` (ES256 JWT, app by bundle ID, builds); 21 tests with real openssl-made certs/.p12s/profiles and a JWT-checking stand-in App Store Connect |
| 10.4 | Builder: the iOS pipeline — Plan here, the Mac jobs and their scripts, Fastlane iOS lanes, IPA/dSYM/build/release artifacts | 2 h 30 min | done — `pipeline.ts` `iosPipeline` (Plan here, source packed), `mac-jobs.ts` (Tests, Signed IPA, App Store Connect; bash 3.2, shellcheck clean), Fastfile `ios signing` / `ios deploy` (loads under fastlane 2.240.1) |
| 10.5 | The Mac agent (`apps/mac-runner`): connect, long-poll, jobs with the console's step semantics, live logs, artifacts, cancel, SSH or local executor, host check (macOS, Xcode, Flutter, CocoaPods, Ruby/Fastlane), `check` and `pubkey` commands | 3 h | done — `apps/mac-runner/src` (agent, SSH and local executors, host probe, reporter, CLI check/pubkey/health) |
| 10.6 | Agent image (multi-arch without emulation), `docker-compose.yml`, `.env.example`, `setup-mac.sh`, the Mac README | 1 h | done — image `rajaguru2004/release-console-mac-runner:1.0.0` + `:latest`, linux/arm64 + linux/amd64, pushed; compose, .env.example, setup-mac.sh, README |
| 10.7 | API: the runner gateway (streamed), Runners, iOS settings, runs with a platform, IPA downloads, stage labels per platform | 1 h 30 min | done — `runners/` (console routes + streamed gateway), iOS routes, runs with platform, IPA download, stage labels; 51 tests incl. a 3 MB upload and a download through the gateway |
| 10.8 | UI: Runners page (add a Mac: token and one command; status and host facts), iOS settings panel, release sheet platform choice, run view (Signed IPA, App Store Connect, IPA card), top bar | 3 h | done — Runners page, iOS settings panel, release sheet Platform, iOS outputs and headlines, Runners nav and Mac chip, streamed `/api/runner/v1` route |
| 10.9 | Tests: builder units; the real agent against the real builder end to end (local executor and SSH over a real sshd); API | 2 h | done — builder 148, api 51, agent 9: an iOS release end to end (real builder + real agent + real Mac step scripts on a stand-in macOS toolbox: build, sign check against a real CMS profile and certificate, IPA/dSYMs/build-info/release-info back, no secret in any log, the Mac left clean) and a cancel that kills the step's process group; SSH executor against a real sshd |
| 10.10 | Deploy here, push the image to Docker Hub, an agent container connecting to this console, screenshots | 1 h | done — console rebuilt and redeployed (healthy); the Docker Hub image pulled and run here with the console's own compose file against http://192.168.0.189:7080: connected, online, reported its one gap (no SSH host here); Runners and iOS settings screenshotted; the test runner removed again |
| 10.11 | README, DESIGN.md, PRODUCT.md, this tracker, memory | 40 min | done — README (iOS section), apps/mac-runner/README.md, this tracker, memory |

Estimate ≈ 19 h 50 min of work; at Phase 9's pace (a quarter of the estimate) ETA 2026-10-13
~22:30 IST.

### Phase 10 — results (2026-10-14)

- **The image:** `rajaguru2004/release-console-mac-runner:1.0.0` (and `:latest`) on Docker Hub,
  for Apple silicon and Intel, 243 MB, built without emulation (no RUN in the final stage).
- **Verified here, for real:** the pushed image, started with the compose file the console
  serves, reached `http://192.168.0.189:7080`, registered, showed online on the Runners page
  and in `check`, and named its one gap (this Linux box has no SSH for it to build on, as a Mac
  with Remote Login will). The console's public setup files answer at
  `/api/runner/v1/files/{docker-compose.yml,setup-mac.sh,env.example}`.
- **Verified end to end with stand-ins** (Jest, `apps/mac-runner/src/e2e.spec.ts`): an iOS
  release from a source ZIP through the real builder, its gateway hop and the real agent,
  running the real Mac step scripts against a stand-in macOS toolbox: build number 42 above
  App Store Connect's 41, the IPA's signer checked against the real certificate's SHA-1 and a
  real CMS profile, IPA/dSYMs/build-info/test report/release info back on the console, no
  secret in any log, the run folder, keychain and profiles gone afterwards; and a cancel that
  stops the step's whole process group while cleanup still runs. The SSH path against a real
  `sshd` with the `restrict` key line, files both ways, a remote cancel and the host-key pin.
- **Not verifiable here:** anything only a Mac does (Xcode, `security`, `codesign`, CocoaPods)
  and anything only Apple does (App Store Connect processing, TestFlight, review). Those run for
  the first time on your Mac; the scripts follow Apple's and fastlane's documented behaviour, and
  fastlane's own source (2.240.1) was read for the TestFlight options used.

### Phase 10 — first real Mac (2026-10-15)

- **The Mac:** "Macmini" (an Intel MacBook Pro, macOS 26.3, Xcode 26.5, Flutter 3.47.6, Ruby
  4.0.1), on the same Wi-Fi as this machine (`done`; the office Wi-Fi isolates its clients).
  The pinned fastlane 2.240.1 installs and runs on Ruby 4.0.1 (bundler switches itself to the
  lockfile's 2.5.22).
- **First iOS app: FusionEco FieldOps** (`com.fusionapps.fieldops`, team 82QNNH4KJZ). Its `main`
  failed its own tests (a scanned-link test pinned an old host; a widget test hung 10 minutes
  without the SharedPreferences mock): fixed and pushed to its repo at your request (`ff16d5d`),
  1318 tests passing.
- **Run 16, Release → TestFlight with Rehearsal on: passed.** Tests on the Mac, a signed IPA
  1.1.0 (9) back on the console with its dSYMs, and "Successfully verified package on App Store
  Connect". A rehearsal uploads nothing, so App Store Connect shows no new build.
- **Run 17, the real Release → TestFlight: 1.1.0 (10) is on TestFlight** (19:58 → 20:17 IST):
  tests 3 min, signed IPA 8.5 min, upload 2 min, Apple's processing 3.5 min, then "What to Test"
  set. Build number 10 = this console's last (9) + 1, above App Store Connect's 7.
- **Three console bugs the real Mac found, fixed with a test that fails without each fix:**
  1. Install signing called a valid identity invalid: `security find-identity | grep -q` under
     `pipefail`, where `grep -q` stopping at the match kills `security` with SIGPIPE while it
     writes its count line (`mac-jobs.ts`; the stand-in `security` now writes as the real one).
  2. Every Mac request went through Next.js's buffering `/api` rewrite, not the streaming
     runner route, so the 52 MB IPA was cut at 10 MB: a plain-list rewrite is checked before
     dynamic routes; it is now a fallback rewrite (`apps/web/next.config.ts`).
  3. Every idle long poll failed after 4 s and the agent waited 30 s, so a run could take up to
     ~30 s to reach the Mac: the runner gateway reused global-pool sockets on which axios
     (follow-redirects) leaves `timeout → destroy`, idle-timed at the builder's keep-alive hint
     less a second. The gateway now opens its own connection (`runner-gateway.controller.ts`).
- Tests: builder 148, API 52, agent 9; the Mac scripts shellcheck-clean.

### What only you can do (Phase 10)

1. **On the Mac:** Xcode (opened once, license accepted), Flutter on the login shell's PATH,
   CocoaPods, Ruby 3 + bundler (or `brew install fastlane`), Docker Desktop, and System
   Settings → General → Sharing → **Remote Login** on.
2. **In the console** (open it at `http://10.193.206.192:7080`, not localhost): Runners → Add a
   Mac → run the command it shows in the Mac's Terminal. The Mac should turn **Ready**.
3. **Fusion HRM → Settings → iOS:** its bundle ID, the Apple Distribution **.p12** and password,
   its **App Store provisioning profile(s)**, and an **App Store Connect API key** (Users and
   Access → Integrations → Team keys, App Manager role): key ID, issuer ID, `.p8`.
4. Then **Build** (Platform iOS) first; then **Release → TestFlight** with Rehearsal on; then a
   real TestFlight release.
5. Decide on export compliance: add `ITSAppUsesNonExemptEncryption` to `ios/Runner/Info.plist`
   (App Store review requires it declared), or answer it in App Store Connect per build.
6. The Mac test reuses this machine as the console; for a server, serve the console over HTTPS
   and give Macs that address (`SERVER_URL`).

### Known limits (Phase 10)

- Manual signing only (a .p12 + App Store profiles); Xcode-managed (cloud) signing and `match`
  are not in. Flavors (`--flavor`) are not in: the Runner target's Release configuration is
  signed.
- App Store review submits the processed build with `skip_metadata`: the App Store's "What's
  New" is written in App Store Connect (the release notes become TestFlight's "What to Test").
- One run per Mac, one runner per Mac account (two runners on one account would clean up each
  other's run folders). The build and the signing run as the same macOS user: use an account
  for builds only.
- The Runners page does not show a Mac's network address (the web hop does not pass it on).
