# Release Console — Mac runner

The Mac's worker for iOS. It connects to the console, takes the iOS runs the console hands it
(one at a time), and builds and releases them on the Mac: the tests, an IPA signed with the
app's distribution certificate, then Fastlane to TestFlight or App Store review. Logs, the IPA,
its dSYMs and App Store Connect's answer go back to the console as the run goes.

```
 console (this server, :7080)                         the Mac
 ┌──────────────────────────────┐   HTTPS/HTTP    ┌───────────────────────────────────────────────┐
 │ web → api → builder          │ ◄────────────── │ runner container (this image)                 │
 │  plans the run (bundle ID,   │  long poll,     │   │ SSH to host.docker.internal (Remote Login) │
 │  signing, build number),     │  reports, IPA   │   ▼                                            │
 │  packs the source, seals the │                 │ macOS: Xcode, Flutter, CocoaPods, Fastlane     │
 │  run's secrets to the runner │                 │   flutter build ipa · keychain per run · pilot │
 └──────────────────────────────┘                 └───────────────────────────────────────────────┘
```

Why SSH: Docker on macOS runs Linux containers in a VM, and Xcode cannot run there. The
container is the agent (the connection, the queue, the logs, the uploads); every build step runs
on the Mac itself, over SSH to `host.docker.internal`, as the account in `MAC_USER`. The runner
only ever dials out: nothing on the Mac listens for the console.

## What the Mac needs

- macOS with **Xcode** (opened once; `sudo xcodebuild -license accept`), its iOS platform.
- **Flutter** on the PATH of the account's login shell (`~/.zprofile`), or `MAC_PATH_PREFIX`.
- **CocoaPods** (`brew install cocoapods`).
- **Ruby 3 with bundler** (`brew install ruby`, its bin folder on PATH) so runs use the console's
  pinned Fastlane, or **fastlane** itself (`brew install fastlane`).
- **Docker Desktop** (or OrbStack, Colima) running.
- **Remote Login** on for that account: System Settings → General → Sharing → Remote Login.
- ~10 GB free disk.

Best on a Mac account used for builds only: during a run's signing the distribution certificate
is in a keychain of the run's own, and the keychain search list holds only that keychain while
the IPA builds (both are put back when the run ends, after a failure or a cancel too).

## Set it up

The first time, end to end (the Mac's tools, Apple's certificate, profile and API key, then a
build, a rehearsal and a TestFlight release): [the step-by-step guide](../../IOS_MAC_RUNNER_GUIDE.md).

1. In the console: **Runners → Add a Mac**, name it. The console shows the token (once) and
   the command.
2. On the Mac, in Terminal:

   ```bash
   curl -fsSL http://<console>:7080/api/runner/v1/files/setup-mac.sh -o setup-mac.sh
   SERVER_URL=http://<console>:7080 RUNNER_TOKEN=rcr_… bash setup-mac.sh
   ```

   It checks the list above, writes `~/release-console-runner/{docker-compose.yml,.env}`, adds
   the runner's SSH key to `~/.ssh/authorized_keys` (as a `restrict` line: no forwarding, no
   terminal), starts the runner and runs its check.
3. The console's Runners page shows the Mac: **Ready** with its macOS, Xcode, Flutter,
   CocoaPods and Fastlane, or each thing to fix.

By hand: put `docker-compose.yml` and a `.env` (from `.env.example`) in a folder, then

```bash
docker compose run --rm runner pubkey >> ~/.ssh/authorized_keys
docker compose up -d
docker compose exec runner node dist/cli.js check
```

## Every day

| | |
|---|---|
| Logs | `docker compose logs -f runner` (in `~/release-console-runner`) |
| Check | `docker compose exec runner node dist/cli.js check` |
| Update | `docker compose pull && docker compose up -d` |
| Stop | `docker compose down` (a run in progress is cancelled and cleaned up first) |
| Keep a failed run's folder | `KEEP_WORK=1` in `.env`, then look in `~/release-console-runner/work/runs/<id>` |

## Settings (`.env`)

| Key | Meaning |
|---|---|
| `SERVER_URL` | the console as this Mac reaches it (`http://10.193.206.192:7080`, or `https://…`) |
| `RUNNER_TOKEN` | from Runners → Add a Mac (or New token); secret |
| `MAC_USER` | the macOS account builds run as |
| `MAC_HOST`, `MAC_PORT` | the Mac's SSH from the container (`host.docker.internal`, `22`) |
| `MAC_WORK_DIR` | the runner's folder on the Mac (`~/release-console-runner/work`) |
| `MAC_PATH_PREFIX` | folders put first on PATH for builds (e.g. Flutter's bin) |
| `KEEP_WORK` | `1` keeps a run's folder after it ends |
| `RUNNER_IMAGE` | the image (`rajaguru2004/release-console-mac-runner:latest`) |

The runner keeps its own keys in the `runner-data` volume: the key the console pins (and seals
each run's secrets to), the SSH key, and the Mac's SSH host key as first seen. A new volume means
new keys: then Runners → the Mac → Reset the key, and add the new `pubkey` line on the Mac.

## When the Runners page says

| It says | Do |
|---|---|
| Never connected | the setup command has not run, or `SERVER_URL` is not reachable from the Mac (try `curl $SERVER_URL/api/runner/v1/files/env.example`) |
| refused this runner's SSH key | `docker compose run --rm runner pubkey >> ~/.ssh/authorized_keys` |
| nothing answers SSH | turn on Remote Login for `MAC_USER` |
| Xcode is not installed or not selected | install Xcode, open it once, `sudo xcode-select -s /Applications/Xcode.app` |
| Flutter is not on the PATH | add it to `~/.zprofile`, or `MAC_PATH_PREFIX=/path/to/flutter/bin` in `.env` |
| A runner with this token offered another key | the runner was reinstalled: Reset the key |
| The console does not know this runner token | the token was rotated or the Mac removed: put the current token in `.env`, `docker compose up -d` |

## Development

`npm test` runs, among others, an iOS release end to end: the console's real builder, the real
agent, and the real build steps against a stand-in Mac (`src/testing.ts`), plus the SSH path
against a real `sshd`. `npm run build` compiles to `dist/`. The image:

```bash
docker buildx build --platform linux/arm64,linux/amd64 --build-arg VERSION=1.0.0 \
  -t rajaguru2004/release-console-mac-runner:1.0.0 -t rajaguru2004/release-console-mac-runner:latest --push .
```
