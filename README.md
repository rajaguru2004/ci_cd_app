# Release Console

Build, test and release the organization's Android apps to Google Play from one place. Each
app is connected once — its repository over SSH, its upload key, its Google Play key — and from
then on **Release** does the whole thing, on this server by default or, per app, on the
repository's own GitHub Actions:

```
git pull (SSH) → flutter pub get → analyze + tests → AAB → signed with the upload key → Fastlane → Google Play track
```

Every run is real: the console shows only what the builder recorded for that run (its jobs,
steps, live log, test report, AAB, and Google Play's answer). No sample data, ever.

```
  engineer ──► web (Next.js :7080) ──/api──► api (NestJS: sign-in, apps, runs; holds no keys)
                                                │ BUILDER_TOKEN
                                                ▼
                         builder (root: vault, git, signing, Fastlane · build user: Flutter, Gradle)
                          │  SSH key per person          │ upload keystore per app     │ Play key per app
                          ▼                              ▼                             ▼
                 GitHub / GitLab / Bitbucket /     re-signs the finished AAB      Google Play
                 any SSH git server                (jarsigner, outside the build)
```

## Adding an app (what each person does once)

1. **Apps → Add app → Git access.** Enter your git email. The console makes an ed25519 SSH key
   named after it and shows the public line. Add that line to your git account — GitHub:
   Settings → SSH and GPG keys → New SSH key (or as a deploy key on one repository). On your
   account the key reaches every repository you can open.
2. **Repository.** Paste the repository's SSH URL (GitHub: Code → SSH, e.g.
   `git@github.com:org/app.git`). The console runs `git ls-remote` with your key and says
   exactly what is wrong if it cannot (key not added yet, repository not visible, host
   unreachable). It then reads the app off the default branch: pubspec name and version, the
   `applicationId`, the Android label, and whether `android/key.properties` is committed.
3. **The app.** Name and package come from the repository; pick the branch Release builds.
4. **Release keys.**
   - **Upload key:** upload the `.jks` / `.keystore` / `.p12`, its password, the alias and the
     key password. The console opens it and signs a test file with it before storing anything;
     you see the certificate (owner, SHA-256, validity). Or keep the repository's own signing
     (`key.properties` committed, as FusionHRM did).
   - **Google Play:** upload the app's service-account JSON, or use the console's default key.
     The panel reads every track of the app to prove the key works. Invite the service
     account's email in Play Console → Users and permissions with permission to release the
     app. Google requires an app's very first upload to be made by hand in Play Console.

No SSH access? An app can be created without a repository and built from uploaded source ZIPs
(GitHub → Code → Download ZIP); the same pipeline runs.

## Where builds run

Every app builds on this server by default. An app whose repository is on github.com can
instead build on its own **GitHub Actions** (its settings → Where builds run); the release
sheet can pick the other runner for one run.

The console plans the run itself — the commit, the version, the track — the same way either
way, then either runs it here or starts `.github/workflows/release-console.yml` with that plan
and copies back its jobs, logs, test report, AAB and Google Play's answer. The workflow is one
generic file the console writes (Settings → Where builds run → Add the workflow commits it to
the default branch, or opens a pull request when the branch takes changes only that way); it
never changes per app. The app's own code still never sees a key: Gradle signs with a
throwaway key, a separate **Sign AAB** job (none of the app's code) applies the upload key,
and **Google Play** runs none of it either. The upload key and the Google Play key are copied
into the repository's Actions secrets, sealed for GitHub on the way, and refreshed before a run
if they changed.

A GitHub token is required: the console's own default (Setup → Default GitHub token) or a
token for that one app (its settings), fine-grained with Actions, Contents, Secrets and
Workflows read and write (classic: `repo` and `workflow`). GitHub runs do not wait for this
server's one-build-at-a-time queue; a second release of the same app while one is still
uploading to Google Play is refused (Google keeps one open edit per app).

## Releasing

**Release** (on the app, or on its card): pick the track (internal, alpha, beta, production),
write "What's new" (en-US, 500 characters), roll out or keep as a draft, and optionally
**Rehearsal only** (Google Play validates the whole release and discards it; nothing is
published). The run pulls the branch, tests, builds, signs and uploads; its six-stage ring and
live log show where it is. **Build** does the same without Google Play and leaves a signed AAB
to download. Any commit in the stream can be built or released on its own ("Build this
commit").

- **Version codes** are chosen when a run starts: above Google Play's highest, above every code
  the console built for the app, never below pubspec.yaml's build number. The plan says which
  rule picked it.
- **Package check:** every run reads the project's `applicationId` and stops if it is not the
  app's package, so a release never goes to the wrong Play listing.
- **Project checks:** after the tests, every `tool/check_*.dart` the project has is run.
- **One build at a time** for all apps (the builder's queue); the top bar shows what it is doing.
- **Run again** repeats a run with the same commit (or ZIP) and settings and a fresh version code.

## Security

- **The vault.** SSH private keys, upload keystores and their passwords, and per-app Play keys
  are stored by the builder only, each sealed with AES-256-GCM under `VAULT_KEY` (in `.env`),
  in a root-only folder of the `builds` volume. The console API holds none of them; the browser
  only ever sees public keys, fingerprints and certificates. **Keep a copy of `VAULT_KEY`:**
  without it the stored keys cannot be opened (the builder refuses to start with a different
  one).
- **Builds never see a key.** The app's own code (Gradle scripts, tests) runs as an unprivileged
  user (uid 1001). Gradle signs with a throwaway key made for that build; the console then
  kills the build user's processes, takes the bundle, and re-signs it as root with the upload
  key (`jarsigner`, decrypted onto a tmpfs for those seconds). git with the SSH key and Fastlane
  with the Play key also run as root, in steps that run none of the app's code.
- **git is SSH-only.** Every git command has `GIT_ALLOW_PROTOCOL=ssh` (submodules included), a
  config-less ssh with its own `known_hosts` (first contact is trusted and remembered; a changed
  host key is refused — Git keys → Known hosts → Forget, only if the host really changed it),
  and URLs are validated before git sees them.
- **Keys sent to GitHub stay sealed in transit.** The upload key and the Google Play key are
  encrypted with GitHub's own public key for the repository (`libsodium`'s sealed box, the same
  scheme GitHub's own CLI uses) before they leave the builder; nothing but GitHub can open them,
  and the console never reads an Actions secret back.
- One shared console password (sign-in is rate-limited per address). Keep the console behind
  the VPN or a TLS proxy.

## Run it on this machine

```bash
cp .env.example .env            # CONSOLE_PASSWORD, SESSION_SECRET, BUILDER_TOKEN, VAULT_KEY
                                # (each: openssl rand -hex 32; keep VAULT_KEY safe)
mkdir -p secrets && chmod 700 secrets
cp <play-key>.json secrets/play-service-account.json   # optional default Play key
./scripts/deploy.sh up          # builds the three images, starts them, runs the checks
```

The first `up` builds the builder image (the Android SDK and Flutter: ~8 GB, 15–30 min) and the
first build of an app fills the Gradle and pub caches. Open http://127.0.0.1:7080.

If `docker compose build` re-downloads the toolchain because the active buildx builder has no
cache, build with the default one: `BUILDX_BUILDER=default docker compose build`.

## Deploy on a server

Three containers (`web`, `api`, `builder`), one `.env`, an optional `secrets/` folder, and four
volumes: `builds` (apps, the vault, repository mirrors, runs, logs, AABs), `pub-cache`,
`gradle-cache`, `android-sdk`. Size it for Android builds: 4+ CPUs, 12+ GB RAM, 40+ GB disk.

- **Build on the server:** copy this folder (without `node_modules`, `.work/`), add `.env`,
  then `./scripts/deploy.sh up`.
- **Build here, pull there:** `./scripts/deploy.sh push` (tags `:<git sha>` and `:latest`),
  then on the server `./scripts/deploy.sh server [tag]`.
- **Moving an existing console:** copy the `builds` volume and the same `VAULT_KEY`.

Behind a TLS proxy: `CONSOLE_BIND=127.0.0.1`, `COOKIE_SECURE=true`, unbuffered responses for
AAB downloads, uploads up to `MAX_UPLOAD_MB` (nginx: `client_max_body_size 500m;`). The builder
must reach the git hosts on port 22 (or the port in an app's URL), pub.dev, Maven and Google.

Operations: `./scripts/deploy.sh check | logs | down`. Runs recorded before apps existed are
given to an app with `docker compose exec builder node /opt/runner/dist/cli.js adopt-runs <app-id>`.

## Configuration

| `.env` key | Meaning |
|---|---|
| `CONSOLE_PASSWORD` | shared sign-in password (required) |
| `SESSION_SECRET` | ≥32 chars, signs the 12-hour session cookie (required) |
| `COOKIE_SECURE` | `true` behind https |
| `BUILDER_TOKEN` | ≥32 chars, shared by api and builder (required) |
| `VAULT_KEY` | ≥32 chars, encrypts every stored key (required; keep a copy) |
| `SECRETS_DIR` | folder holding the optional default `play-service-account.json` (`./secrets`) |
| `MAX_UPLOAD_MB` | largest source ZIP accepted (500) |
| `BUILDER_CPUS`, `BUILDER_MEMORY`, `BUILDER_GRADLE_HEAP` | one build's resources (6, 8g, 4g) |
| `BUILDER_KEEP_RUNS` | finished runs kept per app (30) |
| `CONSOLE_PORT`, `CONSOLE_BIND` | published port and address (7080, 0.0.0.0) |
| `IMAGE_PREFIX`, `IMAGE_TAG` | image names for push/server |

## Troubleshooting

| The console says | Do |
|---|---|
| "github.com refused the key for … (Permission denied)" | add the key's public line to that GitHub account (Git keys → Public key), or as a deploy key |
| "The key works on github.com, but … was not found" | the account behind the key cannot open that repository, or the URL is wrong |
| "That is an HTTPS address; the console connects over SSH" | use the `git@host:org/app.git` form it suggests |
| "The SSH host key of … is not the one the console saw" | only if the host really changed its key: Git keys → Known hosts → Forget |
| "This project builds X, but the app releases Y" | wrong repository or branch, or fix the package in the app's settings |
| "The bundle is signed with Android's debug key" | upload the upload keystore in the app's settings (the project has no release signing) |
| "The keystore password is wrong" / "The key password for 'upload' is wrong" | as it says; nothing was stored |
| "Google Play refused …gserviceaccount.com" | invite it in Play Console → Users and permissions, with release permission for the app |
| "Google Play has no app …" | create the app in Play Console and upload its first build by hand |
| "Google Play already has versionCode N" | something uploaded in between: run the release again |
| "VAULT_KEY is not the key this vault was written with" | put the previous `VAULT_KEY` back in `.env` |
| "The builder is not answering" | `docker compose ps builder`, `docker compose logs builder` |
| "GitHub refused the token (401)" / "…token is wrong, expired or revoked" | paste a new one (the app's settings, or Setup → Default GitHub token) |
| "GitHub hides owner/repo from it (404)" | the token's resource owner (fine-grained) or its account (classic) cannot see that repository |
| "…is not on main of owner/repo" | Where builds run → Add the workflow |
| "This repository has no RELEASE_CONSOLE_KEYSTORE secrets" | Where builds run → Copy secrets to GitHub |
| "…token needs Workflows and Contents read and write" / "…needs Secrets read and write" | the token's permissions are too narrow; widen them and paste it again |
| "…are already releasing on GitHub Actions" | wait for one of them to finish; Google Play allows one open edit per app |

## Layout

```
apps/web/        Next.js UI: apps, add app, app console (commit stream + runs), settings, git keys, setup
apps/api/        NestJS API: sign-in, apps / keys / runs over the builder, uploads, run detail
apps/builder/    the builder: vault, SSH keys, git, apps registry, Play client, pipeline, signing,
                 GitHub Actions (client, tokens, the workflow it writes, following a run)
mobile-pipeline/ Fastlane lanes and Gemfile baked into the builder (deploy, play_status)
scripts/         deploy.sh, capture.mjs (screenshots for design review)
PRODUCT.md, DESIGN.md, TRACKER.md
```

Development: `cd apps/builder && npm test` (needs `ssh-keygen`/`sshd` and a JDK with
`jarsigner`, e.g. `PATH=/opt/android-studio/jbr/bin:$PATH`) · `cd apps/api && npm test` ·
`npm run typecheck` in each app.
