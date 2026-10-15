import { promises as fs } from 'fs';
import { join } from 'path';
import type { AppRecord, Plan, RunParams, RunRecord } from './types';
import { PROTOCOL, type Assignment, type JobSpec, type StepSpec } from './mac-protocol';
import { profileFor } from './ios';
import { seal } from './seal';
import { PROJECT_CHECKS_SCRIPT, TESTS_SCRIPT } from './workflow';

/**
 * The jobs an iOS run hands to a Mac, and the work order (Assignment) a Mac receives: Tests,
 * Signed IPA and, for a release, App Store Connect. Their job and step names are the console's
 * contract (apps/api maps them onto the six stages), the same names the run lists from the
 * moment it is created.
 *
 * Every script runs on the Mac with macOS's own /bin/bash (3.2) and `-eo pipefail`, in the run's
 * folder there. The agent exports, for every step:
 *   RC_RUN      the run's folder         RC_SRC      the source            RC_PROJECT  the Flutter project
 *   RC_OUT      outputs (IPA, dSYMs)     RC_SECRETS  secrets (0700)        RC_HOME     the agent's folder (caches)
 * plus the run's environment below (version, build number, bundle ID, team, …). Nothing secret is
 * in a command line: secret files and variables reach the Mac through the agent's own writes.
 *
 * The app's own code (its pods, its build scripts) runs in Tests and Signed IPA; the distribution
 * certificate is in a keychain of the run's own while Signed IPA builds (codesign needs it), and
 * gone when the job ends, whatever happened. App Store Connect runs only Fastlane.
 */

export const MAC_JOB_NAMES = ['Tests', 'Signed IPA', 'App Store Connect'] as const;

export interface FastlaneFiles {
  fastfile: string;
  appfile: string;
  gemfile: string;
  gemfileLock: string;
}

export const MAC_SCRIPTS = {
  setUpXcode: `echo "Developer directory: $(xcode-select -p)"
xcodebuild -version
echo "iOS SDK: $(xcrun --sdk iphoneos --show-sdk-version)"`,

  setUpFastlane: `cd "$RC_RUN/fastlane-home"
if command -v ruby >/dev/null 2>&1 && command -v bundle >/dev/null 2>&1 && ruby -e 'exit(Gem::Version.new(RUBY_VERSION) >= Gem::Version.new("3.0") ? 0 : 1)'; then
  echo "Ruby $(ruby -e 'print RUBY_VERSION') with $(bundle --version); gems cached in $RC_HOME/gems"
  export BUNDLE_PATH="$RC_HOME/gems" BUNDLE_GEMFILE="$RC_RUN/fastlane-home/Gemfile"
  bundle install --jobs 4 --retry 2
  cat > "$RC_RUN/fastlane.sh" <<'WRAPPER'
#!/bin/bash
export BUNDLE_PATH="$RC_HOME/gems" BUNDLE_GEMFILE="$RC_RUN/fastlane-home/Gemfile"
cd "$RC_RUN/fastlane-home" && exec bundle exec fastlane "$@"
WRAPPER
elif command -v fastlane >/dev/null 2>&1; then
  echo "No Ruby 3 with bundler on this Mac's PATH: using $(command -v fastlane), not the console's pinned Fastlane."
  cat > "$RC_RUN/fastlane.sh" <<'WRAPPER'
#!/bin/bash
cd "$RC_RUN/fastlane-home" && exec fastlane "$@"
WRAPPER
else
  echo "##[error]This Mac has neither Ruby 3 with bundler nor fastlane on its PATH. Install one: brew install ruby (then put its bin folder on PATH in ~/.zprofile), or brew install fastlane."
  exit 1
fi
chmod 700 "$RC_RUN/fastlane.sh"
"$RC_RUN/fastlane.sh" --version | tail -n 1`,

  installSigning: `umask 077
kc="$RC_RUN/signing.keychain-db"
kcpass="$(openssl rand -hex 24)"
security create-keychain -p "$kcpass" "$kc"
security set-keychain-settings -lut 21600 "$kc"
security unlock-keychain -p "$kcpass" "$kc"
security import "$RC_SECRETS/certificate.p12" -k "$kc" -f pkcs12 -P "$RC_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild >/dev/null
echo "Imported the distribution certificate into a keychain of this run's own."
# Apple's intermediate certificates, so the identity is trusted on a Mac that never signed in to Xcode.
mkdir -p "$RC_HOME/wwdr"
for g in G3 G4 G5 G6; do
  cer="$RC_HOME/wwdr/AppleWWDRCA$g.cer"
  [ -s "$cer" ] || curl -fsSL --retry 2 -o "$cer" "https://www.apple.com/certificateauthority/AppleWWDRCA$g.cer" || rm -f "$cer"
  if [ -s "$cer" ]; then security import "$cer" -k "$kc" >/dev/null 2>&1 || true; fi
done
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kcpass" "$kc" >/dev/null
# While the IPA builds only this keychain is searched, so another copy of the same certificate in
# the login keychain cannot make the identity ambiguous. Remove signing puts the list back.
security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' > "$RC_RUN/keychains-before.txt"
security list-keychains -d user -s "$kc"
# Read whole, not piped to grep -q: grep stopping at the match kills security with SIGPIPE while it
# writes its "valid identities found" line, and pipefail turns that into a failed check.
identities="$(security find-identity -v -p codesigning "$kc" || true)"
case "$identities" in
  *"$CERT_SHA1"*) ;;
  *)
    security find-identity -p codesigning "$kc" || true
    echo "##[error]$CERT_NAME is not a valid signing identity on this Mac: the .p12 lacks its private key, or Apple's intermediate certificate could not be installed."
    exit 1 ;;
esac
echo "Signing identity: $CERT_NAME ($CERT_SHA1)"
for p in "$RC_SECRETS"/profiles/*.mobileprovision; do
  [ -f "$p" ] || continue
  name="$(basename "$p")"
  for d in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    mkdir -p "$d"
    if [ ! -f "$d/$name" ]; then
      cp "$p" "$d/$name"
      printf '%s\\n' "$d/$name" >> "$RC_RUN/installed-profiles.txt"
    fi
  done
  echo "Profile \${name%.mobileprovision} installed."
done
"$RC_RUN/fastlane.sh" ios signing`,

  buildIpa: `flutter build ipa --release --build-name="$VERSION_NAME" --build-number="$BUILD_NUMBER" --export-options-plist="$RC_RUN/ExportOptions.plist"`,

  saveIpa: `mkdir -p "$RC_OUT"
shopt -s nullglob
ipas=(build/ios/ipa/*.ipa)
if [ \${#ipas[@]} -ne 1 ]; then
  echo "##[error]flutter build ipa left \${#ipas[@]} IPA files in build/ios/ipa/; the console expects exactly one."
  exit 1
fi
cp "\${ipas[0]}" "$RC_OUT/app-release.ipa"
echo "Saved $(basename "\${ipas[0]}") as app-release.ipa ($(du -h "$RC_OUT/app-release.ipa" | cut -f1 | tr -d ' '))."
if [ -d build/ios/archive/Runner.xcarchive/dSYMs ]; then
  ditto -c -k --keepParent build/ios/archive/Runner.xcarchive/dSYMs "$RC_OUT/dSYMs.zip"
  echo "Saved the dSYMs (crash symbols) as dSYMs.zip."
else
  echo "No dSYMs in the archive."
fi`,

  verify: `v="$RC_RUN/verify"
rm -rf "$v"
mkdir -p "$v"
ditto -x -k "$RC_OUT/app-release.ipa" "$v"
app=""
for a in "$v"/Payload/*.app; do app="$a"; done
if [ -z "$app" ] || [ ! -d "$app" ]; then
  echo "##[error]The IPA has no Payload/*.app."
  exit 1
fi
codesign --verify --deep --strict "$app"
echo "codesign --verify --deep --strict: the signature is intact."
details="$(codesign -dvv "$app" 2>&1)"
printf '%s\\n' "$details" | grep -E '^(Identifier|Authority|TeamIdentifier)=' || true
team="$(printf '%s\\n' "$details" | sed -n 's/^TeamIdentifier=//p' | sed -n 1p)"
codesign -d --extract-certificates="$v/cert" "$app" >/dev/null 2>&1
sha1="$(openssl x509 -inform DER -in "$v/cert0" -noout -fingerprint -sha1 | sed -e 's/.*=//' -e 's/://g' | tr '[:lower:]' '[:upper:]')"
signer="$(printf '%s\\n' "$details" | sed -n 's/^Authority=//p' | sed -n 1p)"
# RC_PLISTBUDDY lets the console's own tests stand in for macOS's PlistBuddy.
pl() { "\${RC_PLISTBUDDY:-/usr/libexec/PlistBuddy}" -c "Print :$1" "$2" 2>/dev/null || true; }
bid="$(pl CFBundleIdentifier "$app/Info.plist")"
ver="$(pl CFBundleShortVersionString "$app/Info.plist")"
build="$(pl CFBundleVersion "$app/Info.plist")"
enc="$(pl ITSAppUsesNonExemptEncryption "$app/Info.plist")"
security cms -D -i "$app/embedded.mobileprovision" > "$v/profile.plist" 2>/dev/null
pname="$(pl Name "$v/profile.plist")"
puuid="$(pl UUID "$v/profile.plist")"
gta="$(pl Entitlements:get-task-allow "$v/profile.plist")"
devices="$(pl ProvisionedDevices "$v/profile.plist")"
echo "Bundle $bid, version $ver ($build), team $team"
echo "Profile: $pname ($puuid)"
problem=""
if [ "$bid" != "$BUNDLE_ID" ]; then problem="The IPA is $bid, but the app releases $BUNDLE_ID."
elif [ "$ver" != "$VERSION_NAME" ] || [ "$build" != "$BUILD_NUMBER" ]; then problem="The IPA is version $ver ($build), but the run planned $VERSION_NAME ($BUILD_NUMBER)."
elif [ "$sha1" != "$CERT_SHA1" ]; then problem="The IPA is signed by $signer ($sha1), not by the certificate stored for the app ($CERT_SHA1)."
elif [ "$team" != "$TEAM_ID" ]; then problem="The IPA is signed for team $team, not $TEAM_ID."
elif [ "$gta" = "true" ] || [ -n "$devices" ]; then problem="The IPA carries a development or ad hoc profile ($pname); App Store Connect takes App Store profiles only."
fi
if [ -n "$problem" ]; then
  echo "##[error]$problem"
  exit 1
fi
case "$enc" in
  true|false) encj="$enc" ;;
  *) encj=null; echo "Info.plist does not say whether the app uses non-exempt encryption (ITSAppUsesNonExemptEncryption): App Store Connect asks for that answer before testers can install it." ;;
esac
# A JSON string of a value (none of these carries a quote or a backslash; any that did would lose it).
js() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\\\\"' | tr '\\n' ' ')"; }
mkdir -p "$RC_RUN/info"
cat > "$RC_RUN/info/build-info.json" <<JSON
{
  "platform": "ios",
  "versionName": $(js "$ver"),
  "versionCode": $build,
  "sizeBytes": $(wc -c < "$RC_OUT/app-release.ipa" | tr -d ' '),
  "sha256": "$(shasum -a 256 "$RC_OUT/app-release.ipa" | cut -d' ' -f1)",
  "signer": $(js "$signer"),
  "certSha1": "$sha1",
  "teamId": $(js "$team"),
  "bundleId": $(js "$bid"),
  "packageName": $(js "$bid"),
  "profile": { "name": $(js "$pname"), "uuid": $(js "$puuid") },
  "usesNonExemptEncryption": $encj,
  "commit": $(js "$RC_COMMIT"),
  "ref": $(js "$RC_REF"),
  "signedBy": "console",
  "xcode": $(js "$(xcodebuild -version | sed -n 1p)"),
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
cat "$RC_RUN/info/build-info.json"`,

  removeSigning: `if [ -f "$RC_RUN/keychains-before.txt" ]; then
  before=()
  while IFS= read -r k; do
    if [ -n "$k" ]; then before+=("$k"); fi
  done < "$RC_RUN/keychains-before.txt"
  if [ \${#before[@]} -gt 0 ]; then security list-keychains -d user -s "\${before[@]}"; fi
  rm -f "$RC_RUN/keychains-before.txt"
  echo "Restored the keychain search list."
fi
if [ -f "$RC_RUN/signing.keychain-db" ]; then
  security delete-keychain "$RC_RUN/signing.keychain-db" 2>/dev/null || rm -f "$RC_RUN/signing.keychain-db"
  echo "Deleted the run's keychain."
fi
if [ -f "$RC_RUN/installed-profiles.txt" ]; then
  while IFS= read -r p; do rm -f "$p"; done < "$RC_RUN/installed-profiles.txt"
  rm -f "$RC_RUN/installed-profiles.txt"
  echo "Removed the provisioning profiles this run installed."
fi
rm -rf "$RC_SECRETS/certificate.p12" "$RC_SECRETS/profiles"`,

  notes: `cat "$RC_RUN/notes.txt"`,

  deploy: `export ASC_KEY_PATH="$RC_SECRETS/AuthKey_$ASC_KEY_ID.p8" IPA_PATH="$RC_OUT/app-release.ipa" NOTES_PATH="$RC_RUN/notes.txt" BUILD_INFO_PATH="$RC_RUN/info/build-info.json"
"$RC_RUN/fastlane.sh" ios deploy`,

  forgetKey: 'rm -f "$RC_SECRETS"/AuthKey_*.p8',
};

const setUp: StepSpec = { name: 'Set up job', uses: 'setup' };
const complete = (run?: string): StepSpec => ({ name: 'Complete job', uses: 'complete', cleanup: true, ...(run ? { run, cwd: 'run' as const } : {}) });

function prepareFastlane(files: FastlaneFiles | null): StepSpec {
  return {
    name: 'Prepare Fastlane',
    write: files
      ? [
          { path: 'fastlane-home/fastlane/Fastfile', text: files.fastfile },
          { path: 'fastlane-home/fastlane/Appfile', text: files.appfile },
          { path: 'fastlane-home/Gemfile', text: files.gemfile },
          { path: 'fastlane-home/Gemfile.lock', text: files.gemfileLock },
        ]
      : [],
    run: 'echo "The console\'s own Fastlane lanes, as sent with this run."',
    cwd: 'run',
  };
}

/**
 * The Mac's jobs for a run. Their names depend only on the run's parameters, so the run lists
 * them (queued) from the start; the rest (the project folder, the profiles, the lanes, the notes)
 * fills in the work order when a Mac takes the run.
 */
export function macJobs(
  params: Pick<RunParams, 'mode' | 'rehearsal'>,
  o: { root: string; profiles: string[]; files: FastlaneFiles | null; notes: string; ascKeyId: string | null } = { root: '', profiles: [], files: null, notes: '', ascKeyId: null },
): JobSpec[] {
  const project = (rel: string) => ['src', o.root, rel].filter(Boolean).join('/');
  const jobs: JobSpec[] = [
    {
      key: 'tests',
      name: 'Tests',
      needs: [],
      timeoutMin: 40,
      steps: [
        setUp,
        { name: 'Checkout code', uses: 'checkout' },
        { name: 'Set up Flutter', run: 'flutter --version' },
        { name: 'Install dependencies', run: 'flutter pub get' },
        // Errors only: infos and warnings do not fail a release.
        { name: 'Static analysis', run: 'flutter analyze --no-fatal-infos --no-fatal-warnings' },
        { name: 'Unit and widget tests', run: TESTS_SCRIPT },
        { name: 'Project checks', run: PROJECT_CHECKS_SCRIPT },
        {
          name: 'Save test results',
          always: true,
          run: 'if [ -f build/test-results/flutter-test.json ]; then echo "Saving test-results/flutter-test.json"; else echo "No test report was written."; fi',
          upload: { artifact: 'test-results', files: [{ path: project('build/test-results/flutter-test.json'), as: 'flutter-test.json', optional: true }] },
        },
        complete(),
      ],
    },
    {
      key: 'ipa',
      name: 'Signed IPA',
      needs: ['tests'],
      timeoutMin: 60,
      steps: [
        setUp,
        { name: 'Set up Xcode', run: MAC_SCRIPTS.setUpXcode },
        prepareFastlane(o.files),
        { name: 'Set up Ruby and Fastlane', run: MAC_SCRIPTS.setUpFastlane, cwd: 'run' },
        {
          name: 'Install signing',
          write: [
            { path: 'secrets/certificate.p12', secret: 'certificate.p12' },
            ...o.profiles.map((uuid) => ({ path: `secrets/profiles/${uuid}.mobileprovision`, secret: `profile:${uuid}` })),
          ],
          secretEnv: { RC_P12_PASSWORD: 'certificate.password' },
          run: MAC_SCRIPTS.installSigning,
          cwd: 'run',
        },
        { name: 'Build IPA', run: MAC_SCRIPTS.buildIpa },
        {
          name: 'Save IPA',
          run: MAC_SCRIPTS.saveIpa,
          upload: {
            artifact: 'app-release-ipa',
            files: [
              { path: 'out/app-release.ipa', as: 'app-release.ipa' },
              { path: 'out/dSYMs.zip', as: 'dSYMs.zip', optional: true },
            ],
          },
        },
        {
          name: 'Verify signature',
          run: MAC_SCRIPTS.verify,
          cwd: 'run',
          upload: { artifact: 'build-info', files: [{ path: 'info/build-info.json', as: 'build-info.json' }] },
        },
        { name: 'Remove signing', cleanup: true, run: MAC_SCRIPTS.removeSigning, cwd: 'run' },
        complete(),
      ],
    },
  ];
  if (params.mode === 'release') {
    jobs.push({
      key: 'store',
      name: 'App Store Connect',
      needs: ['ipa'],
      // Waiting for Apple to process the upload takes most of it.
      timeoutMin: 90,
      steps: [
        setUp,
        prepareFastlane(o.files),
        { name: 'Set up Ruby and Fastlane', run: MAC_SCRIPTS.setUpFastlane, cwd: 'run' },
        { name: 'Write release notes', write: [{ path: 'notes.txt', text: `${o.notes}\n` }], run: MAC_SCRIPTS.notes, cwd: 'run' },
        {
          name: params.rehearsal ? 'Validate with App Store Connect' : 'Upload to App Store Connect',
          write: o.ascKeyId ? [{ path: `secrets/AuthKey_${o.ascKeyId}.p8`, secret: 'appstore.p8' }] : [],
          run: MAC_SCRIPTS.deploy,
          cwd: 'run',
        },
        {
          name: 'Save release info',
          always: true,
          run: 'if [ -f fastlane-home/fastlane/release-info.json ]; then cat fastlane-home/fastlane/release-info.json; else echo "Fastlane wrote no release info."; fi',
          cwd: 'run',
          upload: { artifact: 'store-release', files: [{ path: 'fastlane-home/fastlane/release-info.json', as: 'release-info.json', optional: true }] },
        },
        complete(MAC_SCRIPTS.forgetKey),
      ],
    });
  }
  return jobs;
}

export async function loadFastlaneFiles(pipelineDir: string): Promise<FastlaneFiles> {
  const [fastfile, appfile, gemfile, gemfileLock] = await Promise.all([
    fs.readFile(join(pipelineDir, 'fastlane', 'Fastfile'), 'utf8'),
    fs.readFile(join(pipelineDir, 'fastlane', 'Appfile'), 'utf8'),
    fs.readFile(join(pipelineDir, 'Gemfile'), 'utf8'),
    fs.readFile(join(pipelineDir, 'Gemfile.lock'), 'utf8'),
  ]);
  return { fastfile, appfile, gemfile, gemfileLock };
}

/**
 * The work order for the Mac that takes a run: its jobs with every script and file, the run's
 * environment, and its secrets (the certificate and its password, the profiles, the App Store
 * Connect key) sealed to that Mac's pinned key for this run alone.
 */
export async function macAssignment(o: {
  run: RunRecord;
  plan: Plan;
  app: AppRecord;
  publicKey: string;
  signing: { p12: Buffer; password: string; profiles: Array<{ uuid: string; data: Buffer }> };
  appStore: { keyId: string; issuerId: string; p8: string } | null;
  source: { sizeBytes: number; sha256: string };
  files: FastlaneFiles;
}): Promise<Assignment> {
  const { run, plan, app } = o;
  const ios = app.ios;
  const cert = ios?.certificate;
  if (!ios || !cert) throw new Error(`${app.name} no longer has its iOS certificate; upload it again in the app’s settings → iOS.`);
  const profile = profileFor(ios, ios.bundleId);
  if (!profile) throw new Error(`${app.name} no longer has an App Store profile for ${ios.bundleId}.`);
  if (plan.mode === 'release' && !o.appStore) throw new Error(`${app.name} no longer has its App Store Connect key.`);
  const secrets: Record<string, string> = {
    'certificate.p12': o.signing.p12.toString('base64'),
    'certificate.password': Buffer.from(o.signing.password).toString('base64'),
  };
  for (const p of o.signing.profiles) secrets[`profile:${p.uuid}`] = p.data.toString('base64');
  if (o.appStore && plan.mode === 'release') secrets['appstore.p8'] = Buffer.from(o.appStore.p8).toString('base64');
  const root = run.source.root ?? '';
  const what = plan.mode === 'release' ? `${plan.rehearsal ? 'Rehearsal' : 'Release'} → ${plan.track === 'app_store' ? 'App Store review' : 'TestFlight'}` : 'Build and test';
  return {
    protocol: PROTOCOL,
    runId: run.id,
    title: `${app.name} #${run.number} · ${what}`,
    app: { id: app.id, name: app.name, bundleId: ios.bundleId },
    source: { path: `/runner/v1/runs/${run.id}/source`, sizeBytes: o.source.sizeBytes, sha256: o.source.sha256, root, sha: run.source.sha, ref: plan.ref },
    env: {
      CI: 'true',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      FLUTTER_SUPPRESS_ANALYTICS: 'true',
      COCOAPODS_DISABLE_STATS: 'true',
      FASTLANE_SKIP_UPDATE_CHECK: '1',
      FASTLANE_HIDE_CHANGELOG: '1',
      FASTLANE_OPT_OUT_USAGE: '1',
      FASTLANE_DISABLE_COLORS: '1',
      NSUnbufferedIO: 'YES',
      RC_APP_NAME: app.name,
      RC_RUN_NUMBER: String(run.number),
      RC_COMMIT: run.source.sha ?? '',
      RC_REF: plan.ref,
      VERSION_NAME: plan.versionName,
      BUILD_NUMBER: String(plan.versionCode),
      BUNDLE_ID: ios.bundleId,
      TEAM_ID: cert.teamId ?? profile.teamId,
      CERT_NAME: cert.name,
      CERT_SHA1: cert.sha1,
      IOS_DESTINATION: String(plan.track),
      IOS_RELEASE_STATUS: plan.releaseStatus,
      REHEARSAL: plan.rehearsal ? 'true' : 'false',
      ASC_KEY_ID: o.appStore?.keyId ?? '',
      ASC_ISSUER_ID: o.appStore?.issuerId ?? '',
      ASC_APP_ID: ios.appStore?.appId ?? '',
    },
    jobs: macJobs(plan, { root, profiles: o.signing.profiles.map((p) => p.uuid), files: o.files, notes: plan.releaseNotes, ascKeyId: o.appStore?.keyId ?? null }),
    secrets: seal(Buffer.from(JSON.stringify(secrets)), o.publicKey, `run:${run.id}`),
  };
}
