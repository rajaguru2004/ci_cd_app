#!/usr/bin/env bash
# Scenario tests for .github/scripts/release-plan.sh, run against a throwaway git repository
# with a bare "origin", the way the workflow's checkout leaves things.
#   bash mobile-pipeline/tests/release-plan.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../.github/scripts/release-plan.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
failures=0

git init -q --bare -b main "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/work" 2>/dev/null
cd "$tmp/work" || exit 1
git config user.email ci@example.test
git config user.name ci
printf 'name: ess_portal\nversion: 1.0.1+9\n' >pubspec.yaml
mkdir -p store/play-store
printf 'Tagged release notes from the file.\n' >store/play-store/release-notes-1.0.2.txt
git add . && git commit -qm "chore: base" && git push -q origin main
main_sha="$(git rev-parse HEAD)"
git tag v1.0.2 && git tag -a v1.0.3-production -m "Annotated notes for 1.0.3" && git tag v9.9.9
git checkout -qb feature && git commit -q --allow-empty -m "feat: unmerged" && git tag v1.0.4
feature_sha="$(git rev-parse HEAD)"
git push -q origin feature --tags 2>/dev/null
git checkout -q main

# run <expect ok|fail> <name> [VAR=value ...] -- prints nothing on success
run() {
  local expect="$1" name="$2"
  shift 2
  rm -f "$tmp/out" plan.json
  touch "$tmp/out"
  local output status
  output="$(env -i PATH="$PATH" HOME="$HOME" GITHUB_OUTPUT="$tmp/out" RUN_NUMBER=7 "$@" bash "$script" 2>&1)"
  status=$?
  if [[ "$expect" == ok && $status -ne 0 ]] || [[ "$expect" == fail && $status -eq 0 ]]; then
    echo "FAIL  $name (exit $status)"
    echo "$output" | sed 's/^/      /' | head -n 8
    failures=$((failures + 1))
    return 1
  fi
  last_output="$output"
  pass=$((pass + 1))
  return 0
}

out() { grep -E "^$1=" "$tmp/out" | head -n 1 | cut -d= -f2-; }
check() {
  if [[ "$2" != "$3" ]]; then
    echo "FAIL  $1: expected '$3', got '$2'"
    failures=$((failures + 1))
  else
    pass=$((pass + 1))
  fi
}
contains() {
  if [[ "$2" != *"$3"* ]]; then
    echo "FAIL  $1: '$3' not in output"
    echo "$2" | sed 's/^/      /' | head -n 5
    failures=$((failures + 1))
  else
    pass=$((pass + 1))
  fi
}

# Console: build only.
run ok "dispatch build" EVENT=workflow_dispatch REF=refs/heads/main SHA="$main_sha" IN_MODE=build IN_TRACK=internal
check "build mode" "$(out mode)" build
check "build publish" "$(out publish)" false
check "version name from pubspec" "$(out version_name)" 1.0.1
check "version code = run + 1000" "$(out version_code)" 1007
check "plan.json mode" "$(jq -r .mode plan.json)" build

# Console: release needs notes, capped at 500.
run fail "dispatch release without notes" EVENT=workflow_dispatch IN_MODE=release IN_TRACK=internal IN_NOTES="   "
contains "notes refusal text" "$last_output" "Release notes are required"
run fail "dispatch release with 501 characters" EVENT=workflow_dispatch IN_MODE=release IN_NOTES="$(printf 'a%.0s' $(seq 1 501))"
run ok "dispatch release with 500 characters" EVENT=workflow_dispatch IN_MODE=release IN_NOTES="$(printf 'a%.0s' $(seq 1 500))"

notes=$'Faster check-in.\nArabic fixes: $HOME stays `literal` & "quoted".'
run ok "dispatch release internal" EVENT=workflow_dispatch IN_MODE=release IN_TRACK=beta IN_STATUS=draft IN_NOTES="$notes" REQUEST_ID=abc123 IN_INTEGRATION=true
check "release publish" "$(out publish)" true
check "release track" "$(out track)" beta
check "release status" "$(out release_status)" draft
check "integration" "$(out integration_tests)" true
check "notes survive verbatim in plan.json" "$(jq -r .releaseNotes plan.json)" "$notes"
check "request id in plan.json" "$(jq -r .requestId plan.json)" abc123

check "not a rehearsal by default" "$(out rehearsal)" false
run ok "dispatch rehearsal" EVENT=workflow_dispatch IN_MODE=release IN_TRACK=internal IN_NOTES=x IN_REHEARSAL=true
check "rehearsal output" "$(out rehearsal)" true
check "rehearsal still publishes through Fastlane" "$(out publish)" true
check "rehearsal in plan.json" "$(jq -r .rehearsal plan.json)" true
run ok "rehearsal ignored for a build" EVENT=workflow_dispatch IN_MODE=build IN_REHEARSAL=true
check "no rehearsal for builds" "$(out rehearsal)" false
run ok "release commit is never a rehearsal" EVENT=push REF=refs/heads/main SHA="$main_sha" HEAD_MESSAGE="release: x" IN_REHEARSAL=true
check "commit rehearsal" "$(out rehearsal)" false
run fail "dispatch unknown track" EVENT=workflow_dispatch IN_MODE=release IN_TRACK=staging IN_NOTES=x
run fail "dispatch unknown status" EVENT=workflow_dispatch IN_MODE=release IN_STATUS=halted IN_NOTES=x
run fail "dispatch bad version override" EVENT=workflow_dispatch IN_MODE=build IN_VERSION=1.2
run ok "dispatch version override" EVENT=workflow_dispatch IN_MODE=build IN_VERSION=2.3.4
check "override wins" "$(out version_name)" 2.3.4
run ok "dispatch validate" EVENT=workflow_dispatch IN_MODE=validate
check "validate publish" "$(out publish)" false
run fail "bad default track variable" EVENT=workflow_dispatch IN_MODE=build DEFAULT_TRACK=bogus
run fail "bad version code offset" EVENT=workflow_dispatch IN_MODE=build CODE_OFFSET=1e3
run ok "custom offset" EVENT=workflow_dispatch IN_MODE=build CODE_OFFSET=500
check "custom offset code" "$(out version_code)" 507

# Commits on main.
run ok "release: commit" EVENT=push REF=refs/heads/main SHA="$main_sha" HEAD_MESSAGE=$'release: Faster check-in and Arabic fixes.\n\nBody line.'
check "commit mode" "$(out mode)" release
check "commit default track" "$(out track)" internal
check "commit trigger" "$(out trigger)" commit
check "commit notes = rest of first line" "$(jq -r .releaseNotes plan.json)" "Faster check-in and Arabic fixes."
run ok "release(production): commit" EVENT=push REF=refs/heads/main SHA="$main_sha" HEAD_MESSAGE="release(production): Payslips load faster."
check "commit scoped track" "$(out track)" production
run ok "release: commit honours PLAY_DEFAULT_TRACK" EVENT=push REF=refs/heads/main SHA="$main_sha" HEAD_MESSAGE="release: x" DEFAULT_TRACK=alpha
check "default track variable" "$(out track)" alpha
run fail "release: commit without notes" EVENT=push REF=refs/heads/main SHA="$main_sha" HEAD_MESSAGE="release:"
run fail "non-release commit" EVENT=push REF=refs/heads/main SHA="$main_sha" HEAD_MESSAGE="feat: something"
run fail "release(staging) commit" EVENT=push REF=refs/heads/main SHA="$main_sha" HEAD_MESSAGE="release(staging): x"

# Tags.
run ok "tag with notes file" EVENT=push REF=refs/tags/v1.0.2 SHA="$main_sha"
check "tag version" "$(out version_name)" 1.0.2
check "tag trigger" "$(out trigger)" tag
check "tag notes from file" "$(jq -r .releaseNotes plan.json)" "Tagged release notes from the file."
check "tag name in plan" "$(jq -r .tag plan.json)" v1.0.2
run ok "annotated tag with track suffix" EVENT=push REF=refs/tags/v1.0.3-production SHA="$main_sha"
check "tag track suffix" "$(out track)" production
check "annotated tag notes" "$(jq -r .releaseNotes plan.json)" "Annotated notes for 1.0.3"
run fail "lightweight tag without notes" EVENT=push REF=refs/tags/v9.9.9 SHA="$main_sha"
contains "missing tag notes text" "$last_output" "release-notes-9.9.9.txt"
run fail "tag not on main" EVENT=push REF=refs/tags/v1.0.4 SHA="$feature_sha"
contains "not-on-main text" "$last_output" "is not on main"
run fail "malformed tag" EVENT=push REF=refs/tags/release-1 SHA="$main_sha"

run fail "unsupported event" EVENT=schedule

echo "release-plan.sh: $pass checks passed, $failures failed"
[[ $failures -eq 0 ]]
