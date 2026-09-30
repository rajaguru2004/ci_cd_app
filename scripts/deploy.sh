#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FusionHRM mobile pipeline console — deploy helper
#
#   ./scripts/deploy.sh up             build the images here and (re)start the console
#   ./scripts/deploy.sh push [tag]     build and push images to the registry (for a server);
#                                      tags :<tag> (default: git sha or date) and :latest
#   ./scripts/deploy.sh server [tag]   on the server: pull those images and restart
#   ./scripts/deploy.sh check          health, sign-in page, Google Play key, GitHub token
#   ./scripts/deploy.sh logs           follow both containers' logs
#   ./scripts/deploy.sh down           stop the console (images and config stay)
#
# Refuses to start with a missing .env, an empty password, or an unreadable Play key,
# because each of those produces a console that looks up but cannot work.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

env_value() {
  # The value of KEY in .env, without quotes; empty when absent.
  local line
  line="$(grep -E "^$1=" .env 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

preflight() {
  step "Preflight"
  [[ -f .env ]] || { red "No .env. Copy .env.example to .env and fill it in."; exit 1; }
  [[ -n "$(env_value CONSOLE_PASSWORD)" ]] || { red "CONSOLE_PASSWORD is empty in .env: nobody could sign in."; exit 1; }
  local secret
  secret="$(env_value SESSION_SECRET)"
  if [[ ${#secret} -lt 32 ]]; then
    red "SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)."
    exit 1
  fi
  local key
  key="$(env_value PLAY_KEY_FILE)"
  key="${key:-./secrets/play-service-account.json}"
  [[ -r "$key" ]] || { red "Google Play key not readable at $key."; exit 1; }
  python3 - "$key" <<'PY' || { red "The Play key at $key is not a service-account JSON."; exit 1; }
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("type") == "service_account" and d.get("client_email") and "PRIVATE KEY" in d.get("private_key", "")
PY
  # The container runs as uid 1000; a key it cannot read is a Play check that always fails.
  if [[ "$(stat -c %u "$key")" != "1000" ]] && ! [[ -r "$key" && "$(stat -c %a "$key")" =~ [4-7]$ ]]; then
    red "The Play key must be readable by uid 1000 (the container user): sudo chown 1000:1000 $key && chmod 600 $key"
    exit 1
  fi
  [[ -n "$(env_value GITHUB_TOKEN)" ]] || red "Note: GITHUB_TOKEN is empty — the console starts in setup-only mode (Google Play works, builds do not)."
  green "ok"
}

tag_default() {
  git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M
}

check() {
  step "Checks"
  local port
  port="$(env_value CONSOLE_PORT)"
  port="${port:-7080}"
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${port}/login" >/dev/null 2>&1; then break; fi
    sleep 2
    [[ $i -eq 30 ]] && { red "The console did not answer on :${port}"; docker compose ps; exit 1; }
  done
  curl -fsS "http://127.0.0.1:${port}/api/health" && echo
  green "console up on http://127.0.0.1:${port}"
  docker compose exec -T api node dist/cli/play-check.js 2>/dev/null | sed 's/^/  /' || red "Google Play check failed (see above)."
}

cmd="${1:-up}"
case "$cmd" in
  up)
    preflight
    step "Build and start"
    docker compose up -d --build
    check
    ;;
  push)
    tag="${2:-$(tag_default)}"
    step "Build and push ${IMAGE_PREFIX:-rajaguru2004/fusionhrm-mobile-ci}-{api,web}:${tag}"
    IMAGE_TAG="$tag" docker compose build
    for svc in api web; do
      img="${IMAGE_PREFIX:-rajaguru2004/fusionhrm-mobile-ci}-${svc}"
      docker tag "${img}:${tag}" "${img}:latest"
      docker push "${img}:${tag}"
      docker push "${img}:latest"
    done
    green "pushed :${tag} and :latest"
    ;;
  server)
    preflight
    tag="${2:-latest}"
    step "Pull :${tag} and restart"
    IMAGE_TAG="$tag" docker compose pull
    IMAGE_TAG="$tag" docker compose up -d --no-build
    check
    ;;
  check)
    check
    ;;
  logs)
    docker compose logs -f --tail=200
    ;;
  down)
    docker compose down
    ;;
  *)
    sed -n '2,16p' "$0"
    exit 1
    ;;
esac
