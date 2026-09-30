# FusionHRM mobile pipeline console

An internal, Bitrise-style console for the FusionHRM Android app (`com.fusionapps.fusionhrm`):
start builds, watch them stage by stage, read logs and test results, download the signed AAB,
and release it to Google Play.

The console runs nothing itself and stores no build state. **GitHub Actions** runs the
pipeline and **Fastlane** publishes to Google Play; everything the console shows is read back
from GitHub (runs, jobs, steps, logs, artifacts) or from Google Play (tracks) for real.

```
  engineer ──► console (this repo, Docker)
                 │  web  Next.js :7080 ──/api──► api  NestJS
                 │                                 │  GITHUB_TOKEN        │ Play key (mounted)
                 ▼                                 ▼                      ▼
  mobile repo ── .github/workflows/release.yml ── GitHub Actions ──────► Google Play
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
| `release-plan.sh` scenarios (console / `release:` commit / tags / refusals) | 54 checks pass |
| `release.yml` | actionlint clean |
| Console API unit tests (stages, artifacts, sessions, sign-in lockout, GitHub client over HTTP, Play client over HTTP, sealed box) | 67 pass |
| Console in Docker (`./scripts/deploy.sh up`) | both containers healthy; sign-in, session, Play and Setup work through the proxy |

Not yet exercised: a real run on GitHub Actions. It needs the two steps in "Go live" below.

## Go live (once)

1. **Land the pipeline on the mobile repo's `main`.** It is committed locally on branch
   `ci/release-pipeline` of the mobile repo (commit `dc3b225`, CI files only):

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
   `.env` as `GITHUB_TOKEN=…`, then `./scripts/deploy.sh up`.

3. In the console: **Setup → Copy the console key to GitHub** (stores the Play key as the
   `PLAY_SERVICE_ACCOUNT_JSON` Actions secret, encrypted for GitHub), then **Start build →
   Check Play access**, then a **Build and test**, then a **Release → internal**.

## Run it on this machine

```bash
cp .env.example .env            # set CONSOLE_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
mkdir -p secrets && chmod 700 secrets
cp <play-key>.json secrets/play-service-account.json && chmod 600 secrets/play-service-account.json
./scripts/deploy.sh up          # builds both images, starts them, runs the checks
```

Open http://127.0.0.1:7080 and sign in with `CONSOLE_PASSWORD`.

## Deploy on a server

The console is two containers and two secrets (`.env`, the Play key). No database, no volume.

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

Behind a TLS reverse proxy (nginx-proxy-manager, Caddy, nginx): set `CONSOLE_BIND=127.0.0.1`
so only the proxy reaches the console, proxy to `CONSOLE_PORT`, and set `COOKIE_SECURE=true`.
The proxy must pass long responses through unbuffered for AAB downloads (≈65 MB).

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

Stages: **Plan** (what this run does; refusals say what to fix) → **Tests** (analysis,
unit/widget tests, i18n and widget-key checks; emulator smoke suite optional) → **Signed AAB**
(debug-signed bundles are refused) → **Google Play** (Fastlane). Version code = run number +
`VERSION_CODE_OFFSET` (repository variable, default 1000). Releases queue behind one another;
build-only runs never wait. "What's new" is en-US, 500 characters max.

GitHub publishes a job's full log when the job ends; while it runs, the console shows live
step states and links to GitHub's live log.

## Configuration

| `.env` key | Meaning |
|---|---|
| `CONSOLE_PASSWORD` | shared sign-in password (required) |
| `SESSION_SECRET` | ≥32 chars, signs the 12-hour session cookie (required) |
| `COOKIE_SECURE` | `true` behind https |
| `GITHUB_TOKEN` | fine-grained token, mobile repo only (see Go live) |
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
- One shared console password. Every wrong password costs 0.8 s, and 10 wrong passwords from
  one address lock that address out for 15 minutes. Keep the console behind the VPN or the TLS
  proxy all the same.

## Troubleshooting

| The console says | Do |
|---|---|
| "No GitHub token is configured" | Go live step 2 |
| "release.yml is not on the default branch" | Go live step 1 |
| "GitHub refused the token (401)" | token expired or revoked: generate a new one |
| "The token needs Actions read/write …" (403) | fix the token's permissions |
| Plan fails "Release notes are required" | releases need "What's new" text |
| Google Play: "Google Play already has versionCode N" | raise `VERSION_CODE_OFFSET` above N |
| Google Play refused `…gserviceaccount.com` | invite it in Play Console → Users and permissions |
| "The Google Play Android Developer API is off" | enable it for the key's Cloud project (link in the message) |

## Layout

```
apps/api/            NestJS API: GitHub client (ETag cache), pipeline, Play client, setup, auth
apps/web/            Next.js UI: commit stream, run view, setup, sign-in
mobile-pipeline/     the files that live in the mobile repo (release.yml, plan script, fastlane/)
  tests/             release-plan.sh scenario suite
scripts/deploy.sh    up / push / server / check / logs / down
scripts/capture.mjs  screenshots for design review
PRODUCT.md, DESIGN.md, TRACKER.md
```

Development: `cd apps/api && npm test` · `npm run typecheck` (api, web) ·
`bash mobile-pipeline/tests/release-plan.test.sh`.
