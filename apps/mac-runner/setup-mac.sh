#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Release Console — set this Mac up as a runner for iOS builds and releases.
#
#   curl -fsSL http://<console>/api/runner/v1/files/setup-mac.sh -o setup-mac.sh
#   SERVER_URL=http://<console> RUNNER_TOKEN=rcr_… bash setup-mac.sh
#
# (The console's Runners page shows this command with the address and the token filled in.)
#
# It checks what an iOS build needs on this Mac (Xcode, Flutter, CocoaPods, Ruby/Fastlane,
# Docker, Remote Login), writes ~/release-console-runner/{docker-compose.yml,.env}, lets the
# runner's SSH key into this account (restricted: no forwarding, no terminal), starts the
# runner and checks that it reaches the console and this Mac. It installs nothing on the Mac
# itself: what is missing is listed with the command that installs it.
#
# Safe to run again: it keeps an existing .env's other settings and the runner's keys.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="${RUNNER_DIR:-$HOME/release-console-runner}"
SERVER_URL="${SERVER_URL:-}"
RUNNER_TOKEN="${RUNNER_TOKEN:-}"
MAC_USER="${MAC_USER:-$(id -un)}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
miss() { printf '  \033[33m✗\033[0m %s\n' "$*"; MISSING=$((MISSING + 1)); }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
MISSING=0

[ "$(uname -s)" = "Darwin" ] || die "This script sets up a Mac; this machine runs $(uname -s)."
[ -n "$SERVER_URL" ] || die "Set SERVER_URL to the console's address as this Mac reaches it, e.g. SERVER_URL=http://192.168.0.189:7080"
[ -n "$RUNNER_TOKEN" ] || die "Set RUNNER_TOKEN to the token the console showed when this Mac was added (Runners → Add a Mac)."
SERVER_URL="${SERVER_URL%/}"

bold "Checking this Mac for iOS builds"
if xcodebuild -version >/dev/null 2>&1; then
  ok "$(xcodebuild -version | head -n 1) ($(xcode-select -p))"
elif xcodebuild -version 2>&1 | grep -qi license; then
  miss "Xcode's license is not accepted: sudo xcodebuild -license accept"
else
  miss "Xcode: install it from the App Store, open it once, then: sudo xcode-select -s /Applications/Xcode.app"
fi
if command -v flutter >/dev/null 2>&1; then ok "Flutter $(flutter --version 2>/dev/null | head -n 1 | awk '{print $2}')"; else miss "Flutter: install it and put its bin folder on PATH in ~/.zprofile (https://docs.flutter.dev/get-started/install/macos)"; fi
if command -v pod >/dev/null 2>&1; then ok "CocoaPods $(pod --version 2>/dev/null)"; else miss "CocoaPods: brew install cocoapods"; fi
if command -v ruby >/dev/null 2>&1 && ruby -e 'exit(Gem::Version.new(RUBY_VERSION) >= Gem::Version.new("3.0") ? 0 : 1)' 2>/dev/null && command -v bundle >/dev/null 2>&1; then
  ok "Ruby $(ruby -e 'print RUBY_VERSION') with bundler (Fastlane is installed per run, then cached)"
elif command -v fastlane >/dev/null 2>&1; then
  ok "fastlane at $(command -v fastlane)"
else
  miss "Ruby 3 or fastlane: brew install ruby (and add $(brew --prefix 2>/dev/null || echo /opt/homebrew)/opt/ruby/bin to PATH in ~/.zprofile), or brew install fastlane"
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"; else die "Docker is not running: start Docker Desktop (or OrbStack / Colima), then run this again."; fi
docker compose version >/dev/null 2>&1 || die "This Docker has no 'docker compose': update Docker Desktop."
if nc -z -G 3 127.0.0.1 22 >/dev/null 2>&1; then
  ok "Remote Login (SSH) is on"
else
  miss "Remote Login is off: System Settings → General → Sharing → Remote Login: on, and allow $MAC_USER (the runner runs build steps through it)"
fi
echo "  The runner checks all of this again itself and shows it on the console's Runners page."

bold "Writing $DIR"
mkdir -p "$DIR"
cd "$DIR"
curl -fsSL "$SERVER_URL/api/runner/v1/files/docker-compose.yml" -o docker-compose.yml.new || die "Could not download docker-compose.yml from $SERVER_URL: is the console reachable from this Mac?"
mv docker-compose.yml.new docker-compose.yml
ok "docker-compose.yml"
touch .env
chmod 600 .env
set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" .env; then
    grep -v "^$key=" .env > .env.new || true
    mv .env.new .env
  fi
  printf '%s=%s\n' "$key" "$value" >> .env
}
set_env SERVER_URL "$SERVER_URL"
set_env RUNNER_TOKEN "$RUNNER_TOKEN"
set_env MAC_USER "$MAC_USER"
if [ -n "${RUNNER_IMAGE:-}" ]; then set_env RUNNER_IMAGE "$RUNNER_IMAGE"; fi
chmod 600 .env
ok ".env (SERVER_URL, RUNNER_TOKEN, MAC_USER=$MAC_USER)"

bold "Starting the runner"
docker compose pull --quiet
line="$(docker compose run --rm --no-deps -T runner pubkey | tail -n 1)"
case "$line" in
  "restrict ssh-ed25519 "*) ;;
  *) die "The runner did not give its SSH key: $line" ;;
esac
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
key="$(printf '%s' "$line" | awk '{print $3}')"
if grep -qF "$key" "$HOME/.ssh/authorized_keys"; then
  ok "The runner's SSH key is already in ~/.ssh/authorized_keys"
else
  printf '%s\n' "$line" >> "$HOME/.ssh/authorized_keys"
  ok "Added the runner's SSH key to ~/.ssh/authorized_keys (restricted: no forwarding, no terminal)"
fi
docker compose up -d
ok "The runner is running (docker compose logs -f runner in $DIR)"

bold "Checking the runner"
sleep 3
if docker compose exec -T runner node dist/cli.js check; then
  bold "Done: this Mac takes the console's iOS runs."
else
  echo
  echo "The runner is up, but something above needs fixing; it checks again every 30 seconds."
  [ "$MISSING" -eq 0 ] || echo "($MISSING thing(s) missing on this Mac, listed at the top.)"
  exit 1
fi
