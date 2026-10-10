import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * The GitHub Actions workflow the console writes into a repository whose app builds on GitHub.
 * One generic file for every app: everything particular to a run (the commit, the version, the
 * track, the package) arrives as the `plan` input the console dispatches it with, so the file
 * only changes when the console's pipeline changes, and the console can tell when the copy in
 * a repository differs from its own.
 *
 * Its jobs and steps carry the names the server pipeline uses (apps/builder/src/pipeline.ts),
 * so a run on GitHub maps onto the same six stages. The app's own code runs in Tests and Signed
 * AAB, and neither can read a secret: Gradle signs with a throwaway key; Sign AAB, which runs
 * none of the app's code, applies the upload key; Google Play runs none either.
 */

export const WORKFLOW_FILE = 'release-console.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;

/** The Actions secrets a run reads; the console keeps them in step with its vault. */
export const SECRETS = {
  keystore: 'RELEASE_CONSOLE_KEYSTORE',
  storePassword: 'RELEASE_CONSOLE_KEYSTORE_PASSWORD',
  keyAlias: 'RELEASE_CONSOLE_KEY_ALIAS',
  keyPassword: 'RELEASE_CONSOLE_KEY_PASSWORD',
  play: 'RELEASE_CONSOLE_PLAY_JSON',
} as const;

/** The jobs as GitHub names them, in order; the console mirrors them into a run's record. */
export const REMOTE_JOBS = ['Tests', 'Signed AAB', 'Sign AAB', 'Google Play'] as const;

/** The artifacts a run saves that the console copies back (the same names its own builder writes). */
export const COPIED_ARTIFACTS = ['test-results', 'app-release-aab', 'build-info', 'play-release'] as const;

/** The same unit and widget tests the server pipeline runs (it imports these two). */
export const TESTS_SCRIPT = [
  'if [ ! -d test ]; then echo "No test/ folder: this project has no unit or widget tests to run."; exit 0; fi',
  'mkdir -p build/test-results',
  'flutter test --exclude-tags live --file-reporter json:build/test-results/flutter-test.json',
].join('\n');

export const PROJECT_CHECKS_SCRIPT = [
  'shopt -s nullglob',
  'checks=(tool/check_*.dart)',
  'if [ ${#checks[@]} -eq 0 ]; then echo "No tool/check_*.dart scripts in this project."; exit 0; fi',
  'status=0',
  'for f in "${checks[@]}"; do echo "dart run $f"; dart run "$f" || status=1; done',
  'exit $status',
].join('\n');

/**
 * The bash each step of the workflow runs, kept here as plain text so specs can run it (GitHub
 * runs `run:` steps with `bash -eo pipefail`). None reads an input directly: what a step
 * needs arrives in its environment, so no text from a plan can become shell.
 */
export const SCRIPTS = {
  prepareSigning: `pass="$(openssl rand -hex 24)"
echo "::add-mask::$pass"
keytool -genkeypair -noprompt -keystore "$RUNNER_TEMP/throwaway.p12" -storetype PKCS12 \\
  -storepass "$pass" -keypass "$pass" -alias throwaway -keyalg RSA -keysize 2048 \\
  -validity 2 -dname "CN=Release Console throwaway"
{
  echo "RC_THROWAWAY_FILE=$RUNNER_TEMP/throwaway.p12"
  echo "RC_THROWAWAY_PASS=$pass"
} >> "$GITHUB_ENV"
echo "Gradle signs with a throwaway key; Sign AAB applies the upload key, away from the app's code."`,

  buildAab: `args=(--release --build-name="$VERSION_NAME" --build-number="$VERSION_CODE")
if [ "$RC_SIGNING" = console ]; then
  args+=(
    -Pandroid.injected.signing.store.file="$RC_THROWAWAY_FILE"
    -Pandroid.injected.signing.store.password="$RC_THROWAWAY_PASS"
    -Pandroid.injected.signing.key.alias=throwaway
    -Pandroid.injected.signing.key.password="$RC_THROWAWAY_PASS"
  )
fi
flutter build appbundle "\${args[@]}"`,

  saveBuiltAab: `out="$RUNNER_TEMP/rc-built"
mkdir -p "$out/bundle/release" "$out/mapping/release"
aab=build/app/outputs/bundle/release/app-release.aab
if [ ! -f "$aab" ]; then
  shopt -s nullglob
  found=(build/app/outputs/bundle/*/*.aab)
  if [ \${#found[@]} -ne 1 ]; then
    echo "::error title=AAB::Gradle wrote no bundle under build/app/outputs/bundle/."
    exit 1
  fi
  aab="\${found[0]}"
fi
cp "$aab" "$out/bundle/release/app-release.aab"
if [ -f build/app/outputs/mapping/release/mapping.txt ]; then
  cp build/app/outputs/mapping/release/mapping.txt "$out/mapping/release/mapping.txt"
else
  echo "No R8 mapping: minification is off."
fi`,

  sign: `if [ -z "$RC_KEYSTORE" ] || [ -z "$RC_STOREPASS" ] || [ -z "$RC_KEY_ALIAS" ]; then
  echo "::error title=Upload key::This repository has no ${SECRETS.keystore} secrets. Copy them from the console: the app's settings, Where builds run."
  exit 1
fi
umask 077
ks="$RUNNER_TEMP/upload.keystore"
trap 'rm -f "$ks"' EXIT
printf '%s' "$RC_KEYSTORE" | base64 -d > "$ks"
aab=dist/bundle/release/app-release.aab
# The throwaway signature at the top of META-INF goes; the modules' own META-INF stay.
status=0
zip -q -d "$aab" 'META-INF/MANIFEST.MF' 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' || status=$?
if [ "$status" -ne 0 ] && [ "$status" -ne 12 ]; then
  echo "::error title=Signing::Could not remove the build's signature (zip exit $status)."
  exit 1
fi
echo "Removed the signature Gradle applied (the throwaway key)."
if [ -z "$RC_KEYPASS" ]; then export RC_KEYPASS="$RC_STOREPASS"; fi
jarsigner -keystore "$ks" -storepass:env RC_STOREPASS -keypass:env RC_KEYPASS -digestalg SHA-256 "$aab" "$RC_KEY_ALIAS"
jarsigner -verify "$aab" | tee "$RUNNER_TEMP/verify.txt"
grep -qi 'jar verified' "$RUNNER_TEMP/verify.txt"
echo "Signed with '$RC_KEY_ALIAS' and verified."`,

  verify: `aab=dist/bundle/release/app-release.aab
cert="$(keytool -printcert -jarfile "$aab")"
sed -n '1,14p' <<<"$cert"
if grep -q 'CN=Android Debug' <<<"$cert"; then
  echo "::error title=Signing::The bundle is signed with Android's debug key: the project has no release signing. Upload the app's upload keystore in its settings on the console; Google Play refuses debug-signed bundles."
  exit 1
fi
owner="$(sed -n '/^Owner: /{s/^Owner: //p;q}' <<<"$cert")"
sha="$(sed -nE '/^[[:space:]]*SHA256: /{s/^[[:space:]]*SHA256: //p;q}' <<<"$cert")"
if [ -z "$owner" ]; then
  echo "::error title=Signing::The bundle carries no signature."
  exit 1
fi
norm() { tr -d ': \\n' | tr '[:lower:]' '[:upper:]'; }
if [ -n "$RC_EXPECTED" ] && [ "$(printf '%s' "$sha" | norm)" != "$(printf '%s' "$RC_EXPECTED" | norm)" ]; then
  echo "::error title=Signing::The bundle is signed by $owner, not by the upload key stored for the app."
  exit 1
fi
signed_by=repository
if [ "$RC_SIGNING" = console ]; then signed_by=console; fi
mkdir -p "$RUNNER_TEMP/rc-info"
jq -n \\
  --arg versionName "$VERSION_NAME" \\
  --argjson versionCode "$VERSION_CODE" \\
  --argjson sizeBytes "$(stat -c %s "$aab")" \\
  --arg sha256 "$(sha256sum "$aab" | cut -d' ' -f1)" \\
  --arg signer "$owner" \\
  --arg certSha256 "$sha" \\
  --arg commit "$RC_COMMIT" \\
  --arg ref "$RC_REF" \\
  --arg packageName "$RC_PACKAGE" \\
  --arg signedBy "$signed_by" \\
  --arg builtAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
  '{versionName: $versionName, versionCode: $versionCode, sizeBytes: $sizeBytes, sha256: $sha256,
    signer: $signer, certSha256: $certSha256, commit: $commit, ref: $ref,
    packageName: $packageName, signedBy: $signedBy, builtAt: $builtAt}' > "$RUNNER_TEMP/rc-info/build-info.json"
cat "$RUNNER_TEMP/rc-info/build-info.json"`,

  notes: `dir=fastlane/metadata/android/en-US/changelogs
mkdir -p "$dir"
printf '%s\\n' "$NOTES" > "$dir/$VERSION_CODE.txt"
cat "$dir/$VERSION_CODE.txt"`,
};

/** What the console hands the workflow for one run (the `plan` input, as JSON). */
export interface WorkflowPlan {
  /** The run's title on GitHub; ends with [requestId] so the console can find the run it started. */
  title: string;
  requestId: string;
  app: string;
  run: number;
  mode: 'build' | 'release';
  sha: string;
  ref: string;
  /** The folder holding pubspec.yaml, '.' at the top. */
  projectDir: string;
  submodules: 'false' | 'recursive';
  flutterVersion: string;
  packageName: string;
  signing: 'console' | 'repository';
  /** The upload certificate the signed bundle must carry ('' when the project signs). */
  certSha256: string;
  versionName: string;
  versionCode: number;
  track: string;
  releaseStatus: string;
  rehearsal: boolean;
  notes: string;
}

/** Puts `text` into a YAML block at `indent` spaces, as the body of a quoted heredoc. */
function block(text: string, indent: number): string {
  const pad = ' '.repeat(indent);
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((l) => (l ? pad + l : ''))
    .join('\n');
}

export function workflowYaml(o: { fastfile: string; appfile: string; fastlaneVersion: string }): string {
  for (const [name, text] of Object.entries({ Fastfile: o.fastfile, Appfile: o.appfile })) {
    // Inside the YAML, `${{` would be read as a GitHub expression and a tab as indentation.
    if (text.includes('${{') || /^\t/m.test(text)) throw new Error(`The ${name} cannot be embedded in the workflow as it is.`);
  }
  const plan = (field: string) => `\${{ fromJSON(inputs.plan).${field} }}`;
  return `# Release Console: the release pipeline for this repository (written by the Release Console;
# keep it as the console wrote it, or the console reports it as changed).
#
# The console starts this workflow with a plan it made: the commit, the version and its code,
# the Google Play track. It follows the run and copies the logs, the test report, the signed
# AAB and Google Play's answer back. Start runs from the console, not from here.
#
#   Tests -> Signed AAB -> Sign AAB -> Google Play (releases only)
#
# The app's own code runs in Tests and Signed AAB, and neither job can read a secret: Gradle
# signs with a throwaway key. Sign AAB, which runs none of the app's code, applies the upload
# key; Google Play runs none of it either.
#
# Secrets the console keeps up to date in this repository:
#   ${SECRETS.keystore}           the upload keystore, base64 (when the console signs)
#   ${SECRETS.storePassword}  its password
#   ${SECRETS.keyAlias}          the upload key's alias
#   ${SECRETS.keyPassword}       the key's password
#   ${SECRETS.play}          the Google Play service-account key (releases)
name: Release Console

run-name: ${plan('title')}

on:
  workflow_dispatch:
    inputs:
      plan:
        description: Written by the Release Console (JSON). Start runs from the console.
        required: true
        type: string

permissions:
  contents: read

jobs:
  tests:
    name: Tests
    runs-on: ubuntu-latest
    timeout-minutes: 40
    defaults:
      run:
        shell: bash
        working-directory: ${plan('projectDir')}
    steps:
      - name: Checkout code
        uses: actions/checkout@v5
        with:
          ref: ${plan('sha')}
          submodules: ${plan('submodules')}
          persist-credentials: false
      - name: Set up Flutter
        uses: subosito/flutter-action@v2
        with:
          flutter-version: ${plan('flutterVersion')}
          channel: stable
          cache: true
      - name: Install dependencies
        run: flutter pub get
      # Errors fail it; infos and warnings do not, as on the console's own builder.
      - name: Static analysis
        run: flutter analyze --no-fatal-infos --no-fatal-warnings
      - name: Unit and widget tests
        run: |
${block(TESTS_SCRIPT, 10)}
      - name: Project checks
        run: |
${block(PROJECT_CHECKS_SCRIPT, 10)}
      # Saved after a failure too: the failing tests are what the console shows first.
      - name: Save test results
        if: \${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: ${plan('projectDir')}/build/test-results/flutter-test.json
          if-no-files-found: ignore
          retention-days: 7

  aab:
    name: Signed AAB
    needs: tests
    runs-on: ubuntu-latest
    timeout-minutes: 45
    defaults:
      run:
        shell: bash
        working-directory: ${plan('projectDir')}
    steps:
      - name: Checkout code
        uses: actions/checkout@v5
        with:
          ref: ${plan('sha')}
          submodules: ${plan('submodules')}
          persist-credentials: false
      - name: Set up Java
        uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '17'
      - name: Set up Flutter
        uses: subosito/flutter-action@v2
        with:
          flutter-version: ${plan('flutterVersion')}
          channel: stable
          cache: true
      - name: Install dependencies
        run: flutter pub get
      # A key made for this job alone: Gradle signs with it, so neither the project's own
      # signing config nor the upload key takes part in the build.
      - name: Prepare signing
        if: \${{ fromJSON(inputs.plan).signing == 'console' }}
        run: |
${block(SCRIPTS.prepareSigning, 10)}
      - name: Build AAB
        env:
          RC_SIGNING: ${plan('signing')}
          VERSION_NAME: ${plan('versionName')}
          VERSION_CODE: ${plan('versionCode')}
        run: |
${block(SCRIPTS.buildAab, 10)}
      - name: Save AAB
        run: |
${block(SCRIPTS.saveBuiltAab, 10)}
      - name: Upload the built AAB
        uses: actions/upload-artifact@v4
        with:
          name: rc-built-aab
          path: \${{ runner.temp }}/rc-built
          compression-level: 0
          retention-days: 1

  sign:
    name: Sign AAB
    needs: aab
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults:
      run:
        shell: bash
    steps:
      - name: Download AAB
        uses: actions/download-artifact@v4
        with:
          name: rc-built-aab
          path: dist
      - name: Set up Java
        uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '17'
      - name: Sign with the upload key
        if: \${{ fromJSON(inputs.plan).signing == 'console' }}
        env:
          RC_KEYSTORE: \${{ secrets.${SECRETS.keystore} }}
          RC_STOREPASS: \${{ secrets.${SECRETS.storePassword} }}
          RC_KEY_ALIAS: \${{ secrets.${SECRETS.keyAlias} }}
          RC_KEYPASS: \${{ secrets.${SECRETS.keyPassword} }}
        run: |
${block(SCRIPTS.sign, 10)}
      - name: Verify signature
        env:
          RC_SIGNING: ${plan('signing')}
          RC_EXPECTED: ${plan('certSha256')}
          RC_COMMIT: ${plan('sha')}
          RC_REF: ${plan('ref')}
          RC_PACKAGE: ${plan('packageName')}
          VERSION_NAME: ${plan('versionName')}
          VERSION_CODE: ${plan('versionCode')}
        run: |
${block(SCRIPTS.verify, 10)}
      - name: Save AAB
        uses: actions/upload-artifact@v4
        with:
          name: app-release-aab
          path: dist
          compression-level: 0
          retention-days: 7
      - name: Save build info
        uses: actions/upload-artifact@v4
        with:
          name: build-info
          path: \${{ runner.temp }}/rc-info/build-info.json
          retention-days: 7

  play:
    name: Google Play
    needs: sign
    if: \${{ fromJSON(inputs.plan).mode == 'release' }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # One upload of an app at a time: Google Play keeps one open edit per app.
    concurrency:
      group: release-console-play-${plan('packageName')}
      cancel-in-progress: false
    defaults:
      run:
        shell: bash
    steps:
      - name: Prepare Fastlane
        run: |
          mkdir -p fastlane
          cat > fastlane/Fastfile <<'RELEASE_CONSOLE_FASTFILE'
${block(o.fastfile, 10)}
          RELEASE_CONSOLE_FASTFILE
          cat > fastlane/Appfile <<'RELEASE_CONSOLE_APPFILE'
${block(o.appfile, 10)}
          RELEASE_CONSOLE_APPFILE
          echo "The console's own Fastlane lanes, as its builder runs them."
      - name: Set up Ruby and Fastlane
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.3'
      - name: Install Fastlane
        run: gem install fastlane --no-document -v '${o.fastlaneVersion}'
      - name: Download AAB
        uses: actions/download-artifact@v4
        with:
          name: app-release-aab
          path: dist
      - name: Write release notes
        env:
          NOTES: ${plan('notes')}
          VERSION_CODE: ${plan('versionCode')}
        run: |
${block(SCRIPTS.notes, 10)}
      - name: Upload to Google Play
        env:
          PLAY_SERVICE_ACCOUNT_JSON: \${{ secrets.${SECRETS.play} }}
          PLAY_PACKAGE_NAME: ${plan('packageName')}
          PLAY_TRACK: ${plan('track')}
          PLAY_RELEASE_STATUS: ${plan('releaseStatus')}
          VERSION_NAME: ${plan('versionName')}
          VERSION_CODE: ${plan('versionCode')}
          AAB_PATH: dist/bundle/release/app-release.aab
          MAPPING_PATH: dist/mapping/release/mapping.txt
          PLAY_VALIDATE_ONLY: \${{ fromJSON(inputs.plan).rehearsal && 'true' || 'false' }}
          FASTLANE_SKIP_UPDATE_CHECK: '1'
          FASTLANE_HIDE_CHANGELOG: '1'
          FASTLANE_OPT_OUT_USAGE: '1'
        run: fastlane android deploy
      - name: Save release info
        if: \${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with:
          name: play-release
          path: fastlane/release-info.json
          if-no-files-found: ignore
          retention-days: 7
`;
}

let cached: { dir: string; yaml: string } | null = null;

/** The workflow for the Fastlane lanes baked into this builder (mobile-pipeline/ in the repo). */
export async function loadWorkflow(pipelineDir: string): Promise<string> {
  if (cached?.dir === pipelineDir) return cached.yaml;
  const [fastfile, appfile, lock] = await Promise.all([
    fs.readFile(join(pipelineDir, 'fastlane', 'Fastfile'), 'utf8'),
    fs.readFile(join(pipelineDir, 'fastlane', 'Appfile'), 'utf8'),
    fs.readFile(join(pipelineDir, 'Gemfile.lock'), 'utf8').catch(() => ''),
  ]);
  // The Fastlane the builder's own Gemfile.lock pins, so both runners upload alike.
  const fastlaneVersion = /^ {4}fastlane \((\d+\.\d+\.\d+)\)$/m.exec(lock)?.[1] ?? '2.240.1';
  const yaml = workflowYaml({ fastfile, appfile, fastlaneVersion });
  cached = { dir: pipelineDir, yaml };
  return yaml;
}
