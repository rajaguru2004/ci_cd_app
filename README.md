# FusionHRM mobile pipeline console

An internal, Bitrise-style console for the FusionHRM Android app (`com.fusionapps.fusionhrm`):
start builds, watch them stage by stage, read logs and test results, download the signed AAB,
and release it to Google Play.

One pipeline (Plan → Tests → Signed AAB → Fastlane → Google Play), two places it runs:

- **GitHub Actions**: `release.yml` in the mobile repo, started from the console, by a
  `release:` commit on `main`, or by a `v*` tag. The console stores nothing for these runs; it
  reads runs, jobs, steps, logs and artifacts back from GitHub.
- **This server**: upload the source ZIP (GitHub → Code → Download ZIP) in the console. The
  `builder` container unpacks it and runs the same jobs and steps with the same toolchain
  (Flutter 3.47.5, Android SDK 36, Fastlane), one run at a time. It works without a GitHub
  token. Runs, logs and AABs live in the `builds` volume.

Both kinds of run look the same in the console. A ZIP run carries its commit (GitHub writes the
SHA into the ZIP), so it sits on that commit in the stream.

```
  engineer ──► console (this repo, Docker)
                 │  web  Next.js :7080 ──/api──► api  NestJS ──────────────► builder (ZIP runs)
                 │                                 │ GITHUB_TOKEN   │ Play key   │ Flutter, SDK, Fastlane
                 ▼                                 ▼                ▼            ▼
  mobile repo ── .github/workflows/release.yml ── GitHub Actions ──────────► Google Play
  (release: commit / v-tag / console)   Plan → Tests → Signed AAB → Fastlane → track
```

## What is verified (2026-09-30)

| Check | Result |
|---|---|
| Play service-account key, live against Google Play | reads `com.fusionapps.fusionhrm`: production "Second Release" [9]; alpha/beta/internal empty |
| Signed AAB from mobile `main` (committed upload keystore) | built, 64.7 MB, signer `CN=PrithiyaC, OU=SkillHive`, SHA-1 `67:D7:42:…:3D:E0` |
| That AAB uploaded to Google Play, **validate-only** (nothing published) | accepted: key permissions, upload key, versionCode 1001, internal track |
| The pipeline's own `deploy` lane (changelog, R8 mapping, version pre-check, report), validate-only | accepted; `release-info.json` written |
| The pipeline's `play_status` lane | read all tracks; `play-status.json` written |
| `feat/crm-project-attendance` keystore | same upload key as `main` (safe to merge) |
| `release-plan.sh` scenarios (console / `release:` commit / tags / rehearsal / version-code override / refusals) | 68 checks pass |
| `release.yml`, `release-plan.sh` | actionlint and shellcheck clean |
| Console API tests: units (stages, artifacts, sessions, sign-in lockout, sealed box, GitHub and Play clients over HTTP, retries, setup diagnosis) and end-to-end against GitHub- and builder-shaped servers (uploads, local runs, logs, AAB) | 88 pass |
| Builder tests: ZIP extraction (zip-slip, symlinks, size caps, GitHub commit comment), plan, runner semantics (skip after failure, `always` steps, cancel, restart recovery), HTTP API | 31 pass |
| Console in Docker (`./scripts/deploy.sh up`) | api, web and builder healthy; sign-in, Play, Setup and uploads through the web container |
| Source ZIP of mobile `main` (`c8a98f9`) uploaded through the console UI and run on this server | ran for real; **failed at Tests**, correctly (see below) |
| The same, on a ZIP of `main` plus the two fixes below (ZIP run #4, through the UI) | **every stage passed**: 323 tests and both checks; signed AAB 1.0.1 (1004), 80.2 MB, upload key SHA-1 `67:D7:42:…:3D:E0`; Google Play accepted the internal release, validate-only (nothing published). The AAB and R8 mapping download through the console; the AAB's SHA-256 matches build-info. First build 16.5 min: Gradle, the NDK and SDK packages download once |
| Console reads of Google Play while that upload ran | none opened; the last snapshot was served (a read would have ended Fastlane's edit) |
| Re-run and cancel from the UI | "Re-run this ZIP" started ZIP run #5 (same settings, version code 1005) and opened it; warm caches built the AAB in about 2 min (first build: 14.5). Cancel stopped a queued run before it started, and a running one inside Fastlane, leaving no process behind |
| **Real release to the internal track** (ZIP run #7, `fix/main-test-gates` at `a2d8a3f`, through the UI) | Google Play has internal → "1.0.1" [1007], completed; production untouched (9). 4 min 22 s end to end on warm caches |
| Upload limits through the web container | a 34 MB GitHub ZIP streams through; a 520 MB file gets 413 and leaves nothing on disk; a non-ZIP gets 400; signed out gets 401 |

**Mobile `main` does not pass its own gates today (2026-09-30), on any machine** (reproduced
on this server's Flutter 3.47.5 and a laptop's 3.38.4):

1. `lib/app/modules/dashboard/views/widgets/week_section.dart:134`: the week row's day cell is
   52 px wide, and today's row ("Wed 30" in bold) needs 52.25 px, so a RenderFlex overflows and
   32 tests in `test/e2e/smoke_headless_test.dart` fail. It depends on the date. Fix: `width: 56`
   (the strip next to it is `Expanded`).
2. `tool/check_keys.dart` fails: unkeyed interactive widgets are down to 26, below the stored
   baseline of 27. Fix: `dart run tool/check_keys.dart --update-baseline` and commit
   `tool/keys_baseline.txt`.

With both fixes all 323 tests and both checks pass. They are on the local branch
`fix/main-test-gates` of the mobile clone (commits `0b0af6e`, `a2d8a3f`; **not pushed**).

Not yet exercised: a real run on GitHub Actions. It needs the steps in "Go live" below.

## Go live (once)

1. **Land the pipeline on the mobile repo's `main`.** It is committed locally on branch
   `ci/release-pipeline` of the mobile repo (commit `b909d28`, CI files only):

   ```bash
   cd ~/StudioProjects/CRM/human-resource-management/human-resource-management-mobile-ess
   git push origin ci/release-pipeline:main
   ```

   GitHub only runs a dispatched workflow that exists on the default branch. The push itself
   starts nothing (its message is not `release:`).

2. **Give the console a GitHub token.** github.com → Settings → Developer settings →
   Fine-grained tokens → Generate: resource owner `the-reciprocal-solutions`, repository
   access *only* `human-resource-management-mobile-ess`, permissions **Actions: read and
   write**, **Contents: read**, **Secrets: read and write**, **Variables: read**. Put it in
   `.env` as `GITHUB_TOKEN=…`, then `./scripts/deploy.sh up`. The resource owner must be the
   organization: a token owned by a personal account gets a 404 for the repo (Setup says so
   and names the account). An organization owner may have to approve the token.

3. In the console: **Setup → Copy the console key to GitHub** (stores the Play key as the
   `PLAY_SERVICE_ACCOUNT_JSON` Actions secret, encrypted for GitHub), then **Start build →
   Check Play access**, then a **Build and test**, then a **Release → internal** with
   **Rehearsal only** ticked (Google Play validates everything, nothing is published), and
   finally the real **Release → internal**.

## Run it on this machine

```bash
cp .env.example .env            # set CONSOLE_PASSWORD, SESSION_SECRET and BUILDER_TOKEN
                                # (each: openssl rand -hex 32)
mkdir -p secrets && chmod 700 secrets
cp <play-key>.json secrets/play-service-account.json && chmod 600 secrets/play-service-account.json
./scripts/deploy.sh up          # builds the three images, starts them, runs the checks
```

The first `up` builds the builder image: it downloads the Android SDK and Flutter (an ~8 GB
image, 15–30 minutes). The first ZIP build then fills the Gradle and pub caches (volumes), so
later builds are faster.

Open http://127.0.0.1:7080 and sign in with `CONSOLE_PASSWORD`.

## Deploy on a server

The console is three containers (`web`, `api`, `builder`), two secrets (`.env`, the Play key)
and four volumes: `builds` (ZIP runs: records, logs, AABs; the last `BUILDER_KEEP_RUNS` are
kept), and the `pub-cache`, `gradle-cache` and `android-sdk` caches. No database. Size the
server for Android builds: 4+ CPUs, 12+ GB RAM (the builder is capped by `BUILDER_CPUS` and
`BUILDER_MEMORY`, 8 GB by default), 40+ GB free disk.

**Option A — build on the server** (simplest): copy this folder (without `node_modules`,
`.work/`), add `.env` and `secrets/play-service-account.json`, then `./scripts/deploy.sh up`.

**Option B — build here, pull there:**

```bash
docker login                               # the registry account in IMAGE_PREFIX
./scripts/deploy.sh push                   # builds, tags :<git sha> and :latest, pushes
# on the server, next to docker-compose.yml, .env and secrets/:
./scripts/deploy.sh server                 # pull :latest and restart
./scripts/deploy.sh server <sha>           # roll back to an earlier build
```

The builder image is about 8 GB, most of it the Android SDK and Flutter, and those layers
rarely change. On a slow uplink, build that one on the server instead:
`docker compose build builder`.

Behind a TLS reverse proxy (nginx-proxy-manager, Caddy, nginx): set `CONSOLE_BIND=127.0.0.1`
so only the proxy reaches the console, proxy to `CONSOLE_PORT`, and set `COOKIE_SECURE=true`.
The proxy must pass long responses through unbuffered for AAB downloads (≈65 MB) and accept
uploads up to `MAX_UPLOAD_MB` (nginx: `client_max_body_size 500m;`).

The Play key file must be readable by uid 1000 (the containers' `node` user):
`sudo chown 1000:1000 secrets/play-service-account.json && chmod 600 …`. `deploy.sh`
refuses to start otherwise, and also without a password or a 32-character session secret.

Operations: `./scripts/deploy.sh check` (health + live Play read), `logs`, `down`. Logs rotate
at 10 MB × 5 per container.

## Using the pipeline

Every run is `release.yml` in the mobile repo, started one of three ways:

| Start | How | Track |
|---|---|---|
| Console | Start build → Build and test / Release / Check Play access | chosen in the sheet |
| Release commit on `main` | last commit of the push is `release: <notes>` or `release(<track>): <notes>` | `<track>`, else `PLAY_DEFAULT_TRACK` (default `internal`) |
| Tag on a `main` commit | `git tag -a v1.0.2 -m "<notes>" && git push origin v1.0.2`; `v1.0.2-production` picks the track | suffix, else default |
| Source ZIP, on this server | GitHub → Code → Download ZIP, then Start build → **Upload a source ZIP** → Build and test / Release | chosen in the sheet |

Stages: **Plan** (what this run does; refusals say what to fix) → **Tests** (analysis,
unit/widget tests, i18n and widget-key checks; emulator smoke suite optional) → **Signed AAB**
(debug-signed bundles are refused) → **Google Play** (Fastlane). Runs the console starts (on
GitHub or on this server) get the next version code from Google Play: the highest on any track
+ 1, never one the console handed out before. A `release:` commit or a tag uses run number +
`VERSION_CODE_OFFSET` (repository variable, default 1000). Releases queue behind one another;
on GitHub, build-only runs never wait; on this server, one run at a time. "What's new" is
en-US, 500 characters max.

GitHub publishes a job's full log when the job ends; while it runs, the console shows live
step states and links to GitHub's live log. A ZIP run's log streams live in the console.

A ZIP run: **Re-run this ZIP** runs the same upload with the same settings and a fresh version
code; **Cancel run** stops the whole build (the process group). Uploaded ZIPs are kept for
re-runs until they fall out of the last `BUILDER_KEEP_RUNS` runs.

## Configuration

| `.env` key | Meaning |
|---|---|
| `CONSOLE_PASSWORD` | shared sign-in password (required) |
| `SESSION_SECRET` | ≥32 chars, signs the 12-hour session cookie (required) |
| `COOKIE_SECURE` | `true` behind https |
| `GITHUB_TOKEN` | fine-grained token, mobile repo only (see Go live); optional for ZIP runs |
| `BUILDER_TOKEN` | ≥32 chars, shared by api and builder (required) |
| `MAX_UPLOAD_MB` | largest source ZIP accepted (500) |
| `BUILDER_CPUS`, `BUILDER_MEMORY`, `BUILDER_GRADLE_HEAP` | one build's resources (6, 8g, 4g) |
| `BUILDER_KEEP_RUNS` | finished ZIP runs kept on disk (30) |
| `GITHUB_REPO`, `WORKFLOW_FILE` | defaults: the mobile repo, `release.yml` |
| `ANDROID_PACKAGE_NAME` | `com.fusionapps.fusionhrm` |
| `PLAY_KEY_FILE` | host path of the Play key (default `./secrets/play-service-account.json`) |
| `CONSOLE_PORT`, `CONSOLE_BIND` | published port and address (7080, 0.0.0.0) |
| `IMAGE_PREFIX`, `IMAGE_TAG` | image names for push/server |

Repository variables on the mobile repo (optional): `PLAY_DEFAULT_TRACK`, `VERSION_CODE_OFFSET`,
`FLUTTER_VERSION` (3.47.5). Secret: `PLAY_SERVICE_ACCOUNT_JSON`.

## Security

- The Play key and `.env` never enter git (`.gitignore`) or an image; the key is a read-only
  compose secret. The console sends it to GitHub only as a libsodium sealed box, which only
  GitHub can open. Its Play access is read-only (it opens an edit, reads, deletes it);
  publishing happens only in the pipeline.
- **Rotate the Play key** once the pipeline is live: it was shared through a chat session.
  Google Cloud → IAM → Service accounts → keys → add a new JSON key, replace
  `secrets/play-service-account.json`, press "Copy the console key to GitHub", delete the old key.
- The Android **upload keystore and its passwords are committed** in the mobile repo (existing
  setup). Anyone who can read that repo can sign builds as you; moving them into Actions
  secrets is a recommended follow-up.
- ZIP runs: the builder unpacks a ZIP with checks for size, entry count and paths that climb
  out of the folder (zip-slip), and skips symlinks. The build runs as an unprivileged user
  (uid 1001) that cannot read the Play key; only the Fastlane step reads it, as root, and only
  for a release. The builder is not published on the host; only the api reaches it, with
  `BUILDER_TOKEN`. It never sees the GitHub token. Builds do reach the internet (pub.dev,
  Maven).
- One shared console password. Every wrong password costs 0.8 s, and 10 wrong passwords from
  one address lock that address out for 15 minutes. Keep the console behind the VPN or the TLS
  proxy all the same.

## Troubleshooting

| The console says | Do |
|---|---|
| "No GitHub token is configured" | Go live step 2 (ZIP uploads work meanwhile) |
| "The token of @… works, but GitHub hides … from it (404)" | the token's resource owner must be the organization (Go live step 2) |
| "That ZIP is larger than the console accepts" | raise `MAX_UPLOAD_MB` (and the proxy's body limit) |
| "The builder is not answering" | `docker compose ps builder`, `docker compose logs builder` |
| A ZIP run fails at Tests | the app's own tests or checks failed: the log opens on the failing step |
| "release.yml is not on the default branch" | Go live step 1 |
| "GitHub refused the token (401)" | token expired or revoked: generate a new one |
| "The token needs Actions read/write …" (403) | fix the token's permissions |
| Plan fails "Release notes are required" | releases need "What's new" text |
| Google Play: "Google Play already has versionCode N" | raise `VERSION_CODE_OFFSET` above N |
| Google Play refused `…gserviceaccount.com` | invite it in Play Console → Users and permissions |
| "The Google Play Android Developer API is off" | enable it for the key's Cloud project (link in the message) |

## Layout

```
apps/api/            NestJS API: GitHub client (ETag cache), pipeline, Play client, setup, auth,
                     uploads and ZIP runs (local/)
apps/builder/        the builder: toolchain image, ZIP extraction, the pipeline's jobs and steps
apps/web/            Next.js UI: commit stream, builds on this server, run view, setup, sign-in
mobile-pipeline/     the files that live in the mobile repo (release.yml, plan script, fastlane/)
  tests/             release-plan.sh scenario suite
scripts/deploy.sh    up / push / server / check / logs / down
scripts/capture.mjs  screenshots for design review
PRODUCT.md, DESIGN.md, TRACKER.md
```

Development: `cd apps/api && npm test` · `cd apps/builder && npm test` ·
`npm run typecheck` (api, web, builder) · `bash mobile-pipeline/tests/release-plan.test.sh`.
