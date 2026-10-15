# iOS on a Mac runner: setup and first release

_Updated Oct 14, 2026._

## How it fits together

You start every iOS build on this machine (the parent, the Release Console at **http://10.193.206.192:7080**); a Mac on the same network does the work. The Mac runs one Docker container, the **Mac runner**, which connects out to the console, takes the iOS run, and builds it with the Mac's own Xcode.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ THIS MACHINE · 10.193.206.192 · Release Console on port 7080         │
│                                                                      │
│ You start every run here. It plans the run (bundle ID, signing, a    │
│ build number above Apple's highest), packs the source, seals the     │
│ keys for that one Mac, and shows the stages, the live log, the IPA   │
│ and Apple's answer.                                                  │
└──────────────────────────────────────────────────────────────────────┘
          ▲  the Mac dials out: it connects, reports the log, sends the IPA
          │
          ▼  the console hands it the run, the source, the sealed keys
┌────────────────────────────── THE MAC ───────────────────────────────┐
│ ┌──────────────────────────┐        ┌──────────────────────────────┐ │
│ │ Runner container         │        │ macOS, as your user          │ │
│ │ in Docker Desktop        │  SSH   │ Xcode, Flutter, CocoaPods,   │ │
│ │ one iOS run at a time    │ ─────► │ Fastlane, a keychain per run │ │
│ │ only dials out           │        │ builds and signs the IPA     │ │
│ └──────────────────────────┘        └───────────────┬──────────────┘ │
└─────────────────────────────────────────────────────┼────────────────┘
                                                      │ Fastlane uploads the IPA
                                                      ▼
                                      ┌──────────────────────────────┐
                                      │ APPLE                        │
                                      │ App Store Connect            │
                                      │ TestFlight, App Store review │
                                      └──────────────────────────────┘
```

The Mac only dials out to this machine. Its runner container runs each step on macOS over SSH (Remote Login), and Fastlane on the Mac uploads the IPA to Apple.

- **The console (this machine)** plans each run: it checks the bundle ID and the signing, picks a build number above App Store Connect's highest, packs the source and hands it to the Mac. It shows the stages, the live log and the outputs (IPA, dSYMs, App Store Connect's answer).
- **The Mac runner (on the Mac)** is the image `rajaguru2004/release-console-mac-runner` from Docker Hub. It only dials out to the console; nothing on the Mac listens for the console.
- **Why SSH:** Docker on macOS runs Linux containers, and Xcode cannot run in one. So the container runs every build step on the Mac itself over SSH (Remote Login), as your Mac user, with the Mac's Xcode, Flutter, CocoaPods and Fastlane.
- **Apple** receives the signed IPA: TestFlight, or App Store review.

What you need before you start:

- A Mac (Apple silicon or Intel) on the same network as this machine, with about 40 GB free (Xcode plus builds).
- An Apple Developer Program team where you are **Admin** or **Account Holder** (to make the certificate, the profile and the API key).
- Fusion HRM's Flutter project with its `ios/` folder committed.
- Time: 1 to 2 hours the first time (the Xcode download is most of it). After that a build takes about 10 to 20 minutes, and a TestFlight release adds 5 to 30 minutes of Apple processing.

Do the parts in order: 1 this machine, 2 the Mac, 3 Apple, 4 connect the Mac, 5 the app's iOS settings, 6 the project, 7 the build-to-release cycle.

## Part 1 — Check this machine (the parent)

The console must be running and reachable from the Mac at **http://10.193.206.192:7080**.

1. On this machine, check the console is up:

   ```bash
   cd ~/StudioProjects/ci_cd_app
   ./scripts/deploy.sh check
   ```

   You should see `console up on http://127.0.0.1:7080` and a `builder:` line. If it is not running, start it with `BUILDX_BUILDER=default ./scripts/deploy.sh up`.
2. This machine's address on your network is **10.193.206.192** (Wi-Fi `done`). The Mac must join the same Wi-Fi. If the network gives this machine a new address later, find it with `ip -4 addr show wlp45s0` and use the new address everywhere below. Reserving the address on the router avoids this.
3. On the Mac, open **http://10.193.206.192:7080** in Safari. The sign-in page should appear. If it does not, check both machines are on the same network (this machine's firewall already allows port 7080).
4. Sign in on the Mac with the console password (`CONSOLE_PASSWORD` in `.env` on this machine).

Do the console steps below from the Mac's browser at that address, never at `localhost`: the Runners page builds the Mac's setup command from the address in the browser bar.

## Part 2 — Prepare the Mac

The Mac needs Xcode, Flutter, CocoaPods, Ruby (for Fastlane), Docker Desktop and Remote Login. The runner installs nothing on the Mac itself, so these come first. Open **Terminal** for the commands.

1. **Xcode.** Install it from the App Store (about 15 GB). Open it once and let it install its components; if it offers the iOS platform, download it. Then run:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   sudo xcodebuild -license accept
   sudo xcodebuild -runFirstLaunch
   xcodebuild -version
   xcrun --sdk iphoneos --show-sdk-version
   ```

   The last two must print an Xcode version and an iOS SDK version.
2. **Homebrew** (skip if `brew --version` works). Install it from [brew.sh](https://brew.sh) with the one line shown there, then run the "Next steps" lines it prints (they add Homebrew to `~/.zprofile`).
3. **CocoaPods:** `brew install cocoapods`, then `pod --version`.
4. **Ruby 3 for Fastlane.** macOS's own Ruby is too old. Run `brew install ruby`, then put it on your PATH:

   ```bash
   # Apple silicon (M1/M2/M3/M4):
   echo 'export PATH="/opt/homebrew/opt/ruby/bin:$PATH"' >> ~/.zprofile
   # Intel Mac instead:
   # echo 'export PATH="/usr/local/opt/ruby/bin:$PATH"' >> ~/.zprofile
   ```

   Open a **new** Terminal window and check `ruby -v` (3.x) and `bundle -v`. The first iOS release installs the console's own Fastlane (2.240.1) into the runner's folder once, which takes a few minutes. (Instead of Ruby you may `brew install fastlane`.)
5. **Flutter, the same version the project uses (3.47.5).** From the [Flutter archive](https://docs.flutter.dev/release/archive), download the macOS **3.47.5 stable** zip for your chip (arm64 for Apple silicon). Then:

   ```bash
   mkdir -p ~/development
   unzip ~/Downloads/flutter_macos_*3.47.5-stable.zip -d ~/development
   echo 'export PATH="$HOME/development/flutter/bin:$PATH"' >> ~/.zprofile
   ```

   In a new Terminal: `flutter --version` (3.47.5) and `flutter doctor`. The **Xcode** and **CocoaPods** lines must be green; the Android lines may stay red.
6. **Docker Desktop.** Download it from [docker.com](https://www.docker.com/products/docker-desktop/) (Apple silicon or Intel), install, start it, and turn on Settings → General → *Start Docker Desktop when you sign in*. Check `docker compose version`.
7. **Remote Login.** System Settings → General → Sharing → **Remote Login: on**. Click the (i) beside it and make sure your user is allowed. Check it with `ssh localhost echo ok` (answer *yes* to the host question and give your Mac password; it should print `ok`). The runner later signs in with its own key, not your password.
8. **Keep the Mac awake** during builds: System Settings → Energy (or Battery → Options on a laptop) → *Prevent automatic sleeping when the display is off*. A Mac that sleeps mid-run stops reporting, and the console fails the run after 3 minutes.

Check everything at once; every line must print a version:

```bash
xcodebuild -version; xcrun --sdk iphoneos --show-sdk-version; flutter --version; pod --version; ruby -v; bundle -v; docker compose version
```

Optional but recommended: use a macOS account kept for builds. While an IPA builds, the runner briefly makes its own keychain the only one macOS searches (and puts yours back after), so you may see keychain prompts if you work in that account at the same time.

## Part 3 — Get what Apple gives you

You come out of this part with three files and two IDs: a `.p12` (the signing certificate) and its password, a `.mobileprovision` (the profile), and a `.p8` (the API key) with its Key ID and Issuer ID. Do it on the Mac.

1. **Find the app's bundle ID.** In the Flutter project, open `ios/Runner.xcworkspace` in Xcode → *Runner* target → *Signing & Capabilities* → *Bundle Identifier*. Or search `ios/Runner.xcodeproj/project.pbxproj` for `PRODUCT_BUNDLE_IDENTIFIER` (take the Runner one, not `RunnerTests`). Write it down, e.g. `com.fusionapps.fusionhrm`.
2. **Register the App ID** (skip if it exists). [developer.apple.com/account](https://developer.apple.com/account) → *Certificates, IDs & Profiles* → *Identifiers* → **+** → *App IDs* → *App* → a description, **Explicit** bundle ID = the one from step 1, the capabilities the app uses (push notifications and so on) → *Register*.
3. **Create the app in App Store Connect** (skip if it exists). [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → *Apps* → **+** → *New App* → iOS, the name, the language, the bundle ID from the list, any SKU (e.g. `fusionhrm-ios`) → *Create*. The console finds the app by its bundle ID, so this record must exist.
4. **Export the Apple Distribution certificate as a `.p12`.**
   - Open *Keychain Access* → *login* → *My Certificates*. Find **Apple Distribution: \<your team> (\<TEAM ID>)**; its triangle must show a private key under it.
   - None there? Xcode → *Settings* → *Accounts* → add your Apple ID → select the team → *Manage Certificates* → **+** → *Apple Distribution*. It lands in this keychain. (If the team already has one on another Mac, export it from that Mac instead: a team may hold only a few.)
   - Right-click the certificate → *Export* → format **Personal Information Exchange (.p12)** → save as `FusionHRM-dist.p12` → set a password and keep it.
5. **Make the App Store provisioning profile.** developer.apple.com → *Profiles* → **+** → *Distribution* → **App Store Connect** → your App ID → the Apple Distribution certificate from step 4 (match its expiry date) → name it `FusionHRM App Store` → *Generate* → *Download*. You get a `.mobileprovision` file. An app extension (a notification service, a widget) needs its own App ID and App Store profile too.
6. **Make the App Store Connect API key.** App Store Connect → *Users and Access* → *Integrations* → *App Store Connect API* → *Team Keys* → **+** (the first time, the Account Holder may have to click *Request Access*). Name it `Release Console`, access **App Manager** → *Generate* → **Download API Key**. Apple lets you download the `.p8` only once. Note the **Key ID** (in the key's row) and the **Issuer ID** (the UUID above the table).
7. **TestFlight testers.** App Store Connect → your app → *TestFlight* → *Internal Testing* → **+** → make a group and add yourself (testers must be users of your App Store Connect team). Install the *TestFlight* app on your iPhone and sign in with that Apple ID.

| What | File or value | Where it came from | Secret |
| --- | --- | --- | --- |
| Signing certificate | `FusionHRM-dist.p12` + its password | Keychain Access, step 4 | yes |
| Provisioning profile | `FusionHRM_App_Store.mobileprovision` | developer.apple.com, step 5 | no |
| API key | `AuthKey_XXXXXXXXXX.p8` | App Store Connect, step 6 | yes |
| Key ID | 10 characters, e.g. `AB12CD34EF` | the key's row | no |
| Issuer ID | a UUID | above the key table | no |

Keep these files on the Mac: you upload them from the Mac's browser in Part 5, and the console keeps them encrypted.

## Part 4 — Connect the Mac to this machine

One command on the Mac sets the runner up and connects it; the console then shows the Mac as **Ready**.

1. In the console (the Mac's browser, at http://10.193.206.192:7080): top bar → **Runners** → **Add a Mac** → name it (e.g. `Studio Mac`) → **Add and make its token**.
2. The panel *Set up Studio Mac* shows the token **once**, inside two commands. Click **Copy the commands**. They look like this:

   ```bash
   curl -fsSL http://10.193.206.192:7080/api/runner/v1/files/setup-mac.sh -o setup-mac.sh
   SERVER_URL=http://10.193.206.192:7080 RUNNER_TOKEN=rcr_xxxxxxxx_… bash setup-mac.sh
   ```
3. Paste them into Terminal on the Mac (Docker Desktop running). The script:
   - checks Xcode, Flutter, CocoaPods, Ruby or Fastlane, Docker and Remote Login, with ✓ or ✗ and the fix for each;
   - writes `~/release-console-runner/docker-compose.yml` and `~/release-console-runner/.env`;
   - pulls the image and adds the runner's SSH key to `~/.ssh/authorized_keys` (a `restrict` line: it cannot forward ports or open a terminal);
   - starts the runner and runs its check.
4. A good check ends like this (your versions will differ):

   ```text
   Mac (you@host.docker.internal:22, ssh):
     ✓ macOS 15.5 (24F74) · arm64 · Studio Mac · 210 GB free
     ✓ Xcode: Xcode 16.4 (16F6), iOS 18.5
     ✓ Flutter: 3.47.5 (stable)
     ✓ CocoaPods: 1.16.2
     ✓ Fastlane: bundler, Ruby 3.4.7
   Console (http://10.193.206.192:7080):
     ✓ connected as "Studio Mac" (runner 1a2b3c4d)
     ✓ the console hands this Mac iOS runs
   Done: this Mac takes the console's iOS runs.
   ```
5. Back in the console click **Done, the token is on the Mac**. The Runners page shows *Studio Mac* **Ready**, with its macOS, Xcode, Flutter, CocoaPods and Fastlane. *Needs attention* lists what to fix; fix it on the Mac and the runner checks again within 30 seconds.

Lost the token, or want a new one? Runners → the Mac → **New token** (the old one stops at once), put it in `~/release-console-runner/.env` as `RUNNER_TOKEN=…`, then `docker compose up -d` in that folder.

### The compose file and the .env, by hand

The script writes these (the downloaded file also starts with a comment header). To do it yourself, make the folder and download the file:

```bash
mkdir -p ~/release-console-runner && cd ~/release-console-runner
curl -fsSL http://10.193.206.192:7080/api/runner/v1/files/docker-compose.yml -o docker-compose.yml
```

`docker-compose.yml`:

```yaml
name: release-console-runner

services:
  runner:
    image: ${RUNNER_IMAGE:-rajaguru2004/release-console-mac-runner:latest}
    container_name: release_console_runner
    restart: unless-stopped
    init: true
    env_file: .env
    extra_hosts:
      # Docker Desktop and OrbStack resolve this name already; Colima (and Linux) need the mapping.
      - "host.docker.internal:host-gateway"
    volumes:
      # The runner's own keys: the one the console seals each run's secrets to, the SSH key it
      # signs in to the Mac with, and the Mac's SSH host key as first seen.
      - runner-data:/data
    # A stop lets a run in progress remove its signing (keychain, profiles) from the Mac first.
    stop_grace_period: 2m
    healthcheck:
      test: ["CMD", "node", "dist/cli.js", "health"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  runner-data: {}
```

`.env` next to it (`chmod 600 .env`; `MAC_USER` is what `whoami` prints on the Mac):

```bash
SERVER_URL=http://10.193.206.192:7080
RUNNER_TOKEN=rcr_xxxxxxxx_…
MAC_USER=yourname
# Optional:
# MAC_PATH_PREFIX=/Users/yourname/development/flutter/bin
# KEEP_WORK=1
```

Then authorize the runner's key, start it and check it:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
docker compose pull
docker compose run --rm runner pubkey >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
docker compose up -d
docker compose exec runner node dist/cli.js check
```

## Part 5 — Connect App Store Connect and the signing to the app

In the console, Fusion HRM gets its iOS side: the bundle ID, the certificate, the profile and the API key. Each is checked as you store it. Go to **Apps → Fusion HRM → Settings** (the gear) and scroll to the **iOS** panel.

1. **Bundle ID.** Type the bundle ID from Part 3 (e.g. `com.fusionapps.fusionhrm`) → **Build for iOS**. The panel opens up and lists, in amber, what is still missing.
2. **Distribution certificate.** Choose `FusionHRM-dist.p12`, type its password → **Check and store**. Good answer: *Stored: Apple Distribution: … (TEAM ID)*, with the team, SHA-1 and expiry shown.
3. **Provisioning profiles** (after the certificate, so the console can check the profile carries it) → **Add a profile** → choose the `.mobileprovision`. Good answer: the profile listed with a green check, `com.fusionapps.fusionhrm · app-store · until <date>`. Add one per extension, if the app has any.
4. **App Store Connect API key.** Type the **Key ID** and the **Issuer ID**, choose the `AuthKey_….p8` → **Check and store**. The console asks App Store Connect for the app by its bundle ID. Good answer: *Stored. App Store Connect knows the app as Fusion HRM.* **Check again** later also shows the app's highest build number.
5. When nothing amber is left, the iOS side is ready. The release sheet now offers **Platform: Android / iOS**.

| The panel says | Do |
| --- | --- |
| The .p12 password is wrong. | export again and use that password |
| … is a development certificate | export the **Apple Distribution** one |
| The .p12 holds no private key | export the certificate with its key (expand it in Keychain Access, select both) |
| … is an ad hoc profile / a development profile | make an **App Store Connect** distribution profile (Part 3, step 5) |
| … does not include Apple Distribution: … | edit the profile on developer.apple.com to include that certificate, download it again |
| App Store Connect has no app with the bundle ID … | create the app in App Store Connect (Part 3, step 3), or fix the bundle ID |
| App Store Connect refused key … | wrong issuer ID, or the key was revoked: make a new key |
| … give the key the App Manager or Admin role | change the key's access in App Store Connect, or make a new one |

The console stores these encrypted. A run sends them to the Mac sealed for that runner alone, and the Mac deletes them when the run ends.

## Part 6 — Check the Flutter project and how the console gets it

The console reads the project before each iOS run and stops early, with the reason, when something below is off.

1. **The `ios/` folder is committed**, with `ios/Runner.xcodeproj/project.pbxproj`. If the project has none, run `flutter create --platforms ios .` in it and commit the result.
2. **The bundle ID in the project matches** the one in the console's iOS settings. Otherwise the run stops with *This project builds X …, but Fusion HRM releases Y on iOS*.
3. **No signing changes needed.** For each run, the runner switches its own copy of the project to manual signing with your certificate and profile. Your repository is not changed.
4. **Version.** The version name comes from `pubspec.yaml` (`version: 1.0.1+9` gives `1.0.1`), or from the release sheet's *More options*. The console picks the build number itself: above App Store Connect's highest.
5. **Export compliance (recommended).** If the app uses no encryption beyond HTTPS and Apple's own, add this to `ios/Runner/Info.plist` and commit it:

   ```xml
   <key>ITSAppUsesNonExemptEncryption</key>
   <false/>
   ```

   This is your legal answer to give; the console never gives it for you. Without it, TestFlight still takes the build, but App Store Connect asks you the question before testers can install, and App Store review refuses to start.
6. **How the console gets the source.** Today the console cannot pull Fusion HRM from GitHub: GitHub refused its key for rajaguru20042@gmail.com (last checked 10 Oct). Pick one:
   - **Fix it once (recommended):** console → **Git keys** → copy the public key → on GitHub, signed in as the account that can open `the-reciprocal-solutions/human-resource-management-mobile-ess` → *Settings* → *SSH and GPG keys* → *New SSH key* → paste. Then Fusion HRM → Settings → Repository → **Check again**. Runs can then build *Latest on main* or any commit.
   - **Or upload a ZIP for each run:** GitHub → the repository → *Code* → *Download ZIP*, then in the release sheet choose **Upload a source ZIP**.

## Part 7 — Run the build-to-release cycle from this machine

Test in three runs, each one step further: an iOS **build**, a **rehearsal** that Apple validates, then a real **TestFlight** release. Start them from the console in any browser (this machine included) at http://10.193.206.192:7080.

### Run A — an iOS build (nothing goes to Apple)

1. **Apps → Fusion HRM → Build** (top right of the app's page). The sheet opens.
2. **Platform: iOS** → **What to run: Build and test** → **Source:** *Latest on main* (or *Upload a source ZIP*, Part 6) → **Build for iOS**.
3. Watch the run:
   - **Plan**, on this machine (about a minute). Its log says, for example, *App Store Connect (key AB12CD34EF): Fusion HRM, highest build 12* and *Version: 1.0.1 (build 13)*, then packs the source.
   - The headline turns *Waiting for a Mac runner*, then **Running on Studio Mac**; the Plan log says *Studio Mac took the run*. The top bar shows *Fusion HRM #n on Studio Mac*.
   - **Tests**, on the Mac: the source downloaded and unpacked, `flutter pub get`, analysis, unit and widget tests.
   - **Signed IPA**, on the Mac: Xcode checked, Fastlane set up (a few minutes the first time only), the signing installed, **Build IPA** (`pod install` and the archive, the longest step, 5 to 15 minutes), the IPA saved, its signature verified, the signing removed.
4. Success: **Passed · IPA ready**. Outputs → *Signed IPA* shows the version and build, size, signer, profile and team, with **Download IPA** and **dSYMs**.

On the Mac you can follow the runner too: `cd ~/release-console-runner && docker compose logs -f runner`.

### Run B — a rehearsal (Apple checks it, nothing is uploaded)

1. **Release** → **Platform: iOS** → **App Store Connect: TestFlight** → type a line in **What to Test** → tick **Rehearsal only** → **Rehearse release to TestFlight**.
2. After Signed IPA, a fourth job runs on the Mac: **App Store Connect** → *Validate with App Store Connect*. Apple checks the signature, profile, bundle ID, version and build number, and keeps nothing.
3. Success: **Rehearsal passed · App Store Connect validated it, nothing uploaded**.

### Run C — the real TestFlight release

1. **Release** → **Platform: iOS** → **TestFlight** → **What to Test** → Rehearsal **off** → **Release to TestFlight**.
2. The App Store Connect job runs *Upload to App Store Connect*: Fastlane uploads the IPA, waits for Apple to process it (5 to 30 minutes, the log shows it waiting), then sets *What to Test*.
3. Success: **On TestFlight**. Outputs → *App Store Connect* says *1.0.1 (13) is on TestFlight*, with a link to App Store Connect.
4. Check it at Apple: App Store Connect → Fusion HRM → **TestFlight** → the build `1.0.1 (13)`. If it says **Missing Compliance**, click *Manage* and answer (or add the Info.plist key, Part 6). Add the build to your internal group if it is not there.
5. On the iPhone: the **TestFlight** app → Fusion HRM → **Install**. That closes the cycle.

### Optional — App Store review

Only once the App Store page is ready in App Store Connect (screenshots, description, privacy, pricing; *What's New* for an update). **Release** → iOS → **App Store review** → *Release automatically* or *Release by hand* once approved. The run uploads to TestFlight as in Run C, then submits that build for review. It needs `ITSAppUsesNonExemptEncryption` declared (Part 6).

A run can be stopped with **Cancel run**: the Mac stops the step, and still removes the run's keychain and profiles. **Run again** repeats a run with a fresh build number.

## Troubleshooting

Every problem is reported as a sentence on the Runners page, in the run's log, or in the runner's log on the Mac (`docker compose logs runner`). Find the sentence here.

| It says | Where | Do |
| --- | --- | --- |
| Never connected | Runners | the setup command has not run, or the Mac cannot reach the console: on the Mac, `curl http://10.193.206.192:7080/api/runner/v1/files/env.example` must print text |
| The console at … did not answer | runner log | this machine is off, the console is down, or its address changed (Part 1) |
| The console does not know this runner token | runner log | the token was replaced or the Mac removed: Runners → **New token**, put it in `.env`, `docker compose up -d` |
| A runner with this token offered another key | Runners | the runner's volume was recreated: **Reset the key**, then add its new `pubkey` line on the Mac |
| Cannot reach the Mac over SSH: nothing answers SSH | Runners, check | turn on **Remote Login** for your user (Part 2, step 7) |
| … refused this runner's SSH key | Runners, check | `docker compose run --rm runner pubkey >> ~/.ssh/authorized_keys` |
| The Mac's SSH host key changed | Runners, check | only if the Mac was reinstalled: `docker compose exec runner rm /data/ssh/host_key`, then `docker compose restart` |
| Xcode is not installed or not selected; Xcode's license is not accepted | Runners | Part 2, step 1 |
| Flutter is not on the PATH of … | Runners | add Flutter to `~/.zprofile`, or set `MAC_PATH_PREFIX` in `.env` and `docker compose up -d` |
| Neither Ruby 3 with bundler nor fastlane … | Runners | Part 2, step 4 |
| No Mac runner is set up yet | release sheet | Part 4 |
| Waiting for a Mac runner (for long) | run | open Runners: the Mac is offline, needs attention, or busy with another run |
| … stopped reporting during the run | run | the Mac slept, lost the network, or the runner stopped: keep the Mac awake, check `docker compose logs runner`, run again |
| This project builds X …, but Fusion HRM releases Y on iOS | Plan | correct the bundle ID in Settings → iOS, or build the right repository |
| No App Store profile covers … (target …) | Signed IPA | that target (an extension) needs its own App Store profile in Settings → iOS |
| … is not a valid signing identity on this Mac | Signed IPA | the `.p12` lacks its private key (export it again with the key), or the Mac could not download Apple's intermediate certificate (check its internet) |
| App Store Connect already has build N | App Store Connect | something uploaded in between: **Run again** (it takes the next number) |
| Missing Compliance | TestFlight | App Store Connect → the build → *Manage* → answer, or add the Info.plist key (Part 6) |
| Submitting for App Store review needs the export-compliance answer | App Store Connect | add `ITSAppUsesNonExemptEncryption` to Info.plist (Part 6) |

To look at a failed run's files on the Mac, add `KEEP_WORK=1` to `.env`, run `docker compose up -d`, and run it again: its folder stays in `~/release-console-runner/work/runs/<run id>`.

## Everyday commands on the Mac

Run these in `~/release-console-runner`. The runner starts by itself after a reboot, as long as Docker Desktop starts at sign-in.

| To | Run |
| --- | --- |
| Follow the runner's log | `docker compose logs -f runner` |
| Check the Mac and the connection | `docker compose exec runner node dist/cli.js check` |
| Update to the newest runner | `docker compose pull && docker compose up -d` |
| Stop it (a run in progress is cancelled and cleaned up first) | `docker compose down` |
| Start it again | `docker compose up -d` |
| Keep failed runs' folders | `KEEP_WORK=1` in `.env`, then `docker compose up -d` |
| Remove it for good | console → Runners → the Mac → trash icon; then `docker compose down -v`, and delete the `release-console-runner` line from `~/.ssh/authorized_keys` |
