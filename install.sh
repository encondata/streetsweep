#!/usr/bin/env bash
# StreetSweep server installer.
#
#   curl -fsSL https://raw.githubusercontent.com/encondata/streetsweep/main/install.sh | bash
#
# Clones or updates the repository, makes an access token on first run, pulls the images and
# brings the stack up. Safe to run again: it never overwrites an existing token.
#
# The app serves plain HTTP on port 8420 and expects a reverse proxy in front of it for TLS.
set -euo pipefail

REPO="${STREETSWEEP_REPO:-https://github.com/encondata/streetsweep.git}"
DIR="${STREETSWEEP_DIR:-$HOME/streetsweep}"
BRANCH="${STREETSWEEP_BRANCH:-main}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is not installed."
command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "This needs Docker Compose v2 (the 'docker compose' subcommand)."
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it and try again."

# The compose file lives in the repository, so the code has to come first.
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" reset --hard "origin/$BRANCH"
else
  say "Cloning into $DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR/tools"

if [ ! -f .env ]; then
  say "Generating an access token"
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 32)"
  else
    TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  printf '# Shared secret for every /api call. Keep this off the internet.\nSYNC_TOKEN=%s\n' "$TOKEN" > .env
  chmod 600 .env
fi

say "Pulling images"
docker compose pull db

say "Building and starting"
docker compose up -d --build

TOKEN="$(sed -n 's/^SYNC_TOKEN=//p' .env)"
say "StreetSweep server is up."
cat <<SUMMARY

  Direct           http://localhost:8420   (plain HTTP, for your reverse proxy)
  Behind the proxy https://streetsweep.hackspacelabs.com

  Access token     $TOKEN

Put that address and token into the phone under
Settings -> Area builder server, and into the web page when it asks.

  Logs    docker compose -f $DIR/tools/docker-compose.yml logs -f
  Stop    docker compose -f $DIR/tools/docker-compose.yml down
SUMMARY
