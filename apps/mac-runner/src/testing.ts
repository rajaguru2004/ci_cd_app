import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * A stand-in Mac for the specs (tsconfig.build.json leaves this file out of the image): the
 * macOS commands the console's iOS steps call (sw_vers, xcodebuild, xcrun, security, codesign,
 * ditto, PlistBuddy, pod, flutter, bundle exec fastlane), as small scripts that answer the way
 * the real ones do. The steps' own bash runs unchanged; real openssl, shasum, zip and tar do
 * the parts this machine can do for real (the profile's CMS, the certificate's fingerprint).
 *
 * `state` records what was done to the "keychain search list" so a spec can check it was put back.
 */
export function fakeMac(dir: string, o: { certDer: Buffer; certSha1: string; certName: string; teamId: string; profile: Buffer }): { bin: string; state: string; plistBuddy: string } {
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'cert.der'), o.certDer);
  writeFileSync(join(state, 'profile.mobileprovision'), o.profile);
  writeFileSync(join(state, 'keychains'), '    "/Users/test/Library/Keychains/login.keychain-db"\n');
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\nSTATE=${JSON.stringify(state)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool('uname', 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) /usr/bin/uname "$@" ;; esac');
  tool('sw_vers', 'case "$1" in -productName) echo macOS ;; -productVersion) echo 15.5 ;; -buildVersion) echo 24F74 ;; esac');
  tool('scutil', 'echo "Test Mac Studio"');
  tool('sysctl', 'case "$2" in machdep.cpu.brand_string) echo "Apple M2" ;; hw.memsize) echo 17179869184 ;; esac');
  tool('xcode-select', 'echo /Applications/Xcode.app/Contents/Developer');
  tool('xcodebuild', 'printf "Xcode 16.4\\nBuild version 16F6\\n"');
  tool('xcrun', 'echo 18.5');
  tool('pod', 'echo 1.16.2');
  tool('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk3s5 970000000 400000000 104857600 80%% /System/Volumes/Data\\n"');
  tool('curl', 'exit 22');
  tool('ruby', 'case "$*" in *"print RUBY_VERSION"*) printf 3.3.5 ;; *) exit 0 ;; esac');
  tool('bundle', `case "$1" in
  --version) echo "Bundler version 2.5.22" ;;
  install) echo "Bundle complete! 1 Gemfile dependency." ;;
  exec) shift; shift; exec ${JSON.stringify(join(bin, 'fake-fastlane'))} "$@" ;;
esac`);
  tool('fake-fastlane', `set -e
case "$1 $2" in
  "--version "*) echo "fastlane installation at path: /stand-in"; echo "fastlane 2.240.1" ;;
  "ios signing")
    [ -d "$RC_PROJECT/ios/Runner.xcodeproj" ] || { echo "no Xcode project"; exit 1; }
    ls "$RC_SECRETS"/profiles/*.mobileprovision >/dev/null
    printf '<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>app-store-connect</string></dict></plist>' > "$RC_RUN/ExportOptions.plist"
    echo "Manual signing for 1 target; ExportOptions.plist (app-store-connect)." ;;
  "ios deploy")
    grep -q "PRIVATE KEY" "$ASC_KEY_PATH"
    [ -f "$IPA_PATH" ] && [ -f "$NOTES_PATH" ] && [ -f "$BUILD_INFO_PATH" ]
    mkdir -p "$RC_RUN/fastlane-home/fastlane"
    printf '{"platform":"ios","bundleId":"%s","destination":"%s","releaseStatus":"%s","versionName":"%s","versionCode":%s,"validatedOnly":false,"processing":"processed","exportCompliance":"declared in Info.plist","appStoreConnectUrl":"https://appstoreconnect.apple.com/apps/%s/testflight/ios","uploadedAt":"2026-10-14T10:00:00Z","previousHighestBuild":41}' "$BUNDLE_ID" "$IOS_DESTINATION" "$IOS_RELEASE_STATUS" "$VERSION_NAME" "$BUILD_NUMBER" "$ASC_APP_ID" > "$RC_RUN/fastlane-home/fastlane/release-info.json"
    echo "Uploaded to TestFlight; What to Test: $(cat "$NOTES_PATH")" ;;
  *) echo "fake fastlane: $*"; exit 1 ;;
esac`);
  tool('flutter', `set -e
case "$1" in
  --version) if [ "$2" = "--machine" ]; then echo '{"frameworkVersion":"3.35.1","channel":"stable","dartSdkVersion":"3.9.0"}'; else echo "Flutter 3.35.1 • channel stable"; fi ;;
  pub) echo "Got dependencies!" ;;
  analyze) echo "No issues found!" ;;
  test)
    if [ -f "$STATE/slow" ]; then echo $$ > "$STATE/slow.pid"; sleep 300; fi
    out=""; for a in "$@"; do case "$a" in json:*) out="\${a#json:}" ;; esac; done; mkdir -p "$(dirname "$out")"
    printf '%s\\n' '{"type":"testStart","test":{"id":1,"name":"widget renders","suiteID":0}}' '{"type":"testDone","testID":1,"result":"success","hidden":false,"skipped":false}' '{"type":"done","success":true,"time":1200}' > "$out"
    echo "00:01 +1: All tests passed!" ;;
  build)
    name=""; num=""; opts=""
    for a in "$@"; do case "$a" in --build-name=*) name="\${a#*=}" ;; --build-number=*) num="\${a#*=}" ;; --export-options-plist=*) opts="\${a#*=}" ;; esac; done
    [ -f "$opts" ] || { echo "no ExportOptions.plist"; exit 1; }
    app=build/ios/stage/Payload/Runner.app
    mkdir -p "$app" build/ios/ipa build/ios/archive/Runner.xcarchive/dSYMs/Runner.app.dSYM/Contents
    cat > "$app/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
<key>CFBundleShortVersionString</key><string>$name</string>
<key>CFBundleVersion</key><string>$num</string>
<key>ITSAppUsesNonExemptEncryption</key><false/>
</dict></plist>
PLIST
    cp "$STATE/profile.mobileprovision" "$app/embedded.mobileprovision"
    echo dsym > build/ios/archive/Runner.xcarchive/dSYMs/Runner.app.dSYM/Contents/Info.plist
    (cd build/ios/stage && zip -qr ../ipa/Runner.ipa Payload)
    echo "Built build/ios/ipa/Runner.ipa" ;;
esac`);
  tool('security', `case "$1" in
  create-keychain) touch "\${@: -1}" ;;
  delete-keychain) rm -f "$2" ;;
  list-keychains)
    if [ "$3" = "-s" ]; then shift 3; : > "$STATE/keychains"; for k in "$@"; do printf '    "%s"\\n' "$k" >> "$STATE/keychains"; done
    else cat "$STATE/keychains"; fi ;;
  find-identity)
    # As the real tool does: the identities, then the count in a separate write once they are judged.
    # A reader that stops at the first match (grep -q) kills it with SIGPIPE, as on a real Mac.
    printf '  1) %s "%s"\\n' "$(cat "$STATE/cert.sha1")" "$(cat "$STATE/cert.name")"
    sleep 0.3
    printf '     1 valid identities found\\n' ;;
  cms) openssl cms -verify -noverify -inform DER -in "\${@: -1}" 2>/dev/null ;;
  *) exit 0 ;;
esac`);
  writeFileSync(join(state, 'cert.sha1'), o.certSha1);
  writeFileSync(join(state, 'cert.name'), o.certName);
  tool('codesign', `case "$1" in
  --verify) exit 0 ;;
  -dvv) app="\${@: -1}"; bid="$(${JSON.stringify(join(bin, 'PlistBuddy'))} -c "Print :CFBundleIdentifier" "$app/Info.plist")"
    printf 'Identifier=%s\\nAuthority=%s\\nAuthority=Apple Worldwide Developer Relations Certification Authority\\nTeamIdentifier=%s\\n' "$bid" "$(cat "$STATE/cert.name")" ${JSON.stringify(o.teamId)} >&2 ;;
  -d) for a in "$@"; do case "$a" in --extract-certificates=*) cp "$STATE/cert.der" "\${a#*=}0" ;; esac; done ;;
esac`);
  tool('ditto', `if [ "$1" = "-x" ]; then unzip -q "$3" -d "$4"; else src="\${@: -2:1}"; out="\${@: -1}"; (cd "$(dirname "$src")" && zip -qr "$out" "$(basename "$src")"); fi`);
  // PlistBuddy -c "Print :A:B" file, for XML property lists.
  writeFileSync(
    join(bin, 'PlistBuddy'),
    `#!/usr/bin/env python3
import plistlib, sys
path = sys.argv[2].split(' ', 1)[1].lstrip(':').split(':')
with open(sys.argv[3], 'rb') as f:
    v = plistlib.load(f)
for k in path:
    if isinstance(v, dict) and k in v:
        v = v[k]
    else:
        print('Print: Entry, ":%s", Does Not Exist' % k, file=sys.stderr)
        sys.exit(1)
if isinstance(v, bool):
    print('true' if v else 'false')
elif isinstance(v, (dict, list)):
    print('Dict {' if isinstance(v, dict) else 'Array {')
    print('}')
else:
    print(v)
`,
  );
  chmodSync(join(bin, 'PlistBuddy'), 0o755);
  return { bin, state, plistBuddy: join(bin, 'PlistBuddy') };
}
