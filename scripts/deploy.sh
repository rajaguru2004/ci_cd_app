#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Release Console — deploy helper
#
#   ./scripts/deploy.sh up             build the images here and (re)start the console
#   ./scripts/deploy.sh push [tag]     build and push images to the registry (for a server);
#                                      tags :<tag> (default: git sha or date) and :latest
#   ./scripts/deploy.sh server [tag]   on the server: pull those images and restart
#   ./scripts/deploy.sh check          health, sign-in page, the builder
#   ./scripts/deploy.sh logs           follow the containers' logs
#   ./scripts/deploy.sh down           stop the console (images and config stay)
#
# Refuses to start with a missing .env, an empty password, or a missing builder token or
# vault key, because each of those produces a console that looks up but cannot work.
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
  local token
  token="$(env_value BUILDER_TOKEN)"
  if [[ ${#token} -lt 32 ]]; then
    red "BUILDER_TOKEN must be at least 32 characters (openssl rand -hex 32); the api uses it to reach the builder."
    exit 1
  fi
  local vault
  vault="$(env_value VAULT_KEY)"
  if [[ ${#vault} -lt 32 ]]; then
    red "VAULT_KEY must be at least 32 characters (openssl rand -hex 32); it encrypts every stored key. Keep a copy of it."
    exit 1
  fi
  # The default Google Play key is optional: apps can bring their own.
  local secrets key
  secrets="$(env_value SECRETS_DIR)"
  secrets="${secrets:-./secrets}"
  key="${secrets}/play-service-account.json"
  if [[ -f "$key" ]]; then
    python3 - "$key" <<'PY' || { red "The default Play key at $key is not a service-account JSON."; exit 1; }
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("type") == "service_account" and d.get("client_email") and "PRIVATE KEY" in d.get("private_key", "")
PY
  else
    mkdir -p "$secrets" && chmod 700 "$secrets"
    red "Note: no default Google Play key at $key; each app then needs its own (its settings → Google Play)."
  fi
  local free_gb
  free_gb="$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2 {print int($4/1048576)}')"
  if [[ -n "$free_gb" && "$free_gb" -lt 20 ]]; then
    red "Note: only ${free_gb} GB free for Docker; the builder image is ~8 GB and its caches grow to several GB."
  fi
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
  local builder
  if builder="$(docker compose exec -T builder node -e "fetch('http://127.0.0.1:4000/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null)"; then
    echo "  builder: ${builder}"
  else
    red "The builder is not answering; nothing can be built or released (docker compose logs builder)."
  fi
}

cmd="${1:-up}"
case "$cmd" in
  up)
    preflight
    step "Build and start (the first build downloads the Android toolchain: ~8 GB, 15–30 min)"
    docker compose up -d --build
    check
    ;;
  push)
    tag="${2:-$(tag_default)}"
    step "Build and push ${IMAGE_PREFIX:-rajaguru2004/release-console}-{api,web,builder}:${tag}"
    IMAGE_TAG="$tag" docker compose build
    for svc in api web builder; do
      img="${IMAGE_PREFIX:-rajaguru2004/release-console}-${svc}"
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
