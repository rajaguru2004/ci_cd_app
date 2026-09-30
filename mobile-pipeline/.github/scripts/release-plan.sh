#!/usr/bin/env bash
# Decides what one run of release.yml does, from whatever started it.
#
#   workflow_dispatch   the pipeline console (ci_cd_app); mode, track, notes... are inputs
#   push to main        a commit whose first line is `release: <notes>` or
#                       `release(<track>): <notes>`; any other push never reaches this script
#                       (the plan job's `if:` skips the run)
#   push of a v* tag    vMAJOR.MINOR.PATCH[-<track>] on a commit that is on main
#
# Writes the plan to $GITHUB_OUTPUT and to plan.json, which is uploaded as the
# `pipeline-plan` artifact the console reads. Every refusal is one ::error:: line that says
# what to fix, because it is the first thing the console shows for a failed plan.
set -euo pipefail

TRACKS=(internal alpha beta production)
# Google Play caps "What's new" at 500 characters per language.
MAX_NOTES=500

fail() {
  echo "::error title=Release plan::$1"
  exit 1
}

in_list() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

event="${EVENT:?EVENT is required}"
default_track="${DEFAULT_TRACK:-internal}"
in_list "$default_track" "${TRACKS[@]}" ||
  fail "Repository variable PLAY_DEFAULT_TRACK is '$default_track'; use one of: ${TRACKS[*]}."

mode="" track="" notes="" status="completed" version_name="" integration="false"
rehearsal="false" trigger="" tag=""

case "$event" in
  workflow_dispatch)
    trigger="console"
    mode="${IN_MODE:-build}"
    track="${IN_TRACK:-$default_track}"
    notes="${IN_NOTES:-}"
    status="${IN_STATUS:-completed}"
    version_name="${IN_VERSION:-}"
    integration="${IN_INTEGRATION:-false}"
    rehearsal="${IN_REHEARSAL:-false}"
    ;;
  push)
    ref="${REF:?REF is required}"
    if [[ "$ref" == refs/tags/* ]]; then
      trigger="tag"
      tag="${ref#refs/tags/}"
      [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-(internal|alpha|beta|production))?$ ]] ||
        fail "Tag '$tag' is not vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-<track> (tracks: ${TRACKS[*]})."
      version_name="${BASH_REMATCH[1]}"
      track="${BASH_REMATCH[3]:-$default_track}"
      mode="release"

      # A tag is a release only when it marks a commit main already has: a tag on a feature
      # branch would publish code nobody merged.
      git fetch --quiet --no-tags origin "+refs/heads/main:refs/remotes/origin/main"
      git merge-base --is-ancestor "${SHA:?SHA is required}" origin/main ||
        fail "Tag '$tag' points at ${SHA:0:7}, which is not on main. Tag a commit that is on main."

      # actions/checkout re-creates the tag as a lightweight one; fetch the real object so an
      # annotated tag's message is readable.
      git fetch --quiet --force origin "+refs/tags/$tag:refs/tags/$tag" || true
      notes_file="store/play-store/release-notes-${version_name}.txt"
      if [[ -f "$notes_file" ]]; then
        notes="$(cat "$notes_file")"
      elif [[ "$(git cat-file -t "$tag" 2>/dev/null)" == "tag" ]]; then
        notes="$(git tag -l --format='%(contents)' "$tag" | sed '/^-----BEGIN PGP SIGNATURE-----/,$d')"
      fi
      [[ -n "$(trim "$notes")" ]] ||
        fail "No release notes for $tag: add $notes_file, or push an annotated tag (git tag -a $tag -m \"<notes>\")."
    else
      trigger="commit"
      subject="$(printf '%s\n' "${HEAD_MESSAGE:-}" | head -n 1)"
      release_re='^release(\((internal|alpha|beta|production)\))?:[[:space:]]*(.*)$'
      if [[ "$subject" =~ $release_re ]]; then
        mode="release"
        track="${BASH_REMATCH[2]:-$default_track}"
        notes="${BASH_REMATCH[3]}"
      else
        fail "Only a 'release: <notes>' or 'release(<track>): <notes>' commit on main starts this pipeline; the head commit is: $subject"
      fi
    fi
    ;;
  *)
    fail "This workflow does not handle the '$event' event."
    ;;
esac

in_list "$mode" build release validate ||
  fail "Unknown mode '$mode'; use build, release or validate."
in_list "$track" "${TRACKS[@]}" ||
  fail "Unknown Google Play track '$track'; use one of: ${TRACKS[*]}."
in_list "$status" completed draft ||
  fail "Unknown release status '$status'; use completed or draft."
[[ "$integration" == "true" ]] || integration="false"
# Only a release can be rehearsed: there is nothing to validate with Google otherwise.
[[ "$rehearsal" == "true" && "$mode" == "release" ]] || rehearsal="false"

notes="$(trim "$notes")"
if [[ "$mode" == "release" && -z "$notes" ]]; then
  fail "Release notes are required: they are the \"What's new\" text on Google Play."
fi
((${#notes} <= MAX_NOTES)) ||
  fail "Release notes are ${#notes} characters; Google Play allows $MAX_NOTES."

if [[ -z "$version_name" ]]; then
  version_name="$(sed -nE 's/^version:[[:space:]]*([^+[:space:]]+).*/\1/p' pubspec.yaml | head -n 1)"
fi
[[ "$version_name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "Version name '$version_name' is not MAJOR.MINOR.PATCH (set it in pubspec.yaml or in the tag)."

# Every run gets its own version code: run numbers only ever grow, so two runs can never
# produce the same code. The offset keeps the codes clear of everything uploaded before this
# pipeline (Play's highest was 9, on production, when it was introduced); Fastlane refuses
# before uploading if Play is ever ahead.
offset="${CODE_OFFSET:-1000}"
[[ "$offset" =~ ^[0-9]+$ ]] ||
  fail "Repository variable VERSION_CODE_OFFSET must be a whole number; it is '$offset'."
version_code=$((${RUN_NUMBER:?RUN_NUMBER is required} + offset))
# Google Play's ceiling for versionCode.
((version_code <= 2100000000)) || fail "Version code $version_code is above Google Play's limit."

publish="false"
[[ "$mode" == "release" ]] && publish="true"

{
  echo "mode=$mode"
  echo "trigger=$trigger"
  echo "track=$track"
  echo "release_status=$status"
  echo "version_name=$version_name"
  echo "version_code=$version_code"
  echo "integration_tests=$integration"
  echo "publish=$publish"
  echo "rehearsal=$rehearsal"
  delimiter="NOTES_$(date +%s%N)"
  echo "notes<<$delimiter"
  printf '%s\n' "$notes"
  echo "$delimiter"
} >>"${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

jq -n \
  --arg mode "$mode" \
  --arg trigger "$trigger" \
  --arg tag "$tag" \
  --arg track "$track" \
  --arg status "$status" \
  --arg versionName "$version_name" \
  --argjson versionCode "$version_code" \
  --argjson integration "$integration" \
  --argjson publish "$publish" \
  --argjson rehearsal "$rehearsal" \
  --arg notes "$notes" \
  --arg requestId "${REQUEST_ID:-}" \
  --arg commit "${SHA:-}" \
  --arg ref "${REF:-}" \
  'def blank_to_null: if . == "" then null else . end;
   {mode: $mode, trigger: $trigger, tag: ($tag | blank_to_null), track: $track,
    releaseStatus: $status, versionName: $versionName, versionCode: $versionCode,
    integrationTests: $integration, publish: $publish, rehearsal: $rehearsal, releaseNotes: $notes,
    requestId: ($requestId | blank_to_null), commit: $commit, ref: $ref}' >plan.json

{
  echo "### Release plan"
  echo ""
  echo "| | |"
  echo "|---|---|"
  echo "| Trigger | $trigger${tag:+ ($tag)} |"
  echo "| Mode | $mode |"
  if [[ "$publish" == "true" ]]; then
    echo "| Google Play | $track, $status$([[ "$rehearsal" == "true" ]] && echo ' — rehearsal, nothing is published') |"
  fi
  echo "| Version | $version_name ($version_code) |"
  echo "| Emulator smoke suite | $integration |"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

cat plan.json
