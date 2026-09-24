#!/usr/bin/env bash
# StreetSweep server installer.
#
#   curl -fsSL https://raw.githubusercontent.com/encondata/streetsweep/main/install.sh | bash
#
# Clones or updates the repository, makes an access token and an administrator account on
# first run, pulls the images and brings the stack up. Safe to run again: it never
# overwrites an existing token, and it never invents a second administrator.
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

# A little randomness, from openssl when it is there and /dev/urandom when it is not.
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

if [ ! -f .env ]; then
  say "Generating an access token and an administrator password"
  {
    printf '# Shared secret for every /api call. Keep this off the internet.\n'
    printf 'SYNC_TOKEN=%s\n\n' "$(rand_hex 32)"
    printf '# The first administrator. Used only when the database has no accounts yet;\n'
    printf '# after that it is ignored, and the password here is just a record of what\n'
    printf '# was set. Change the password once you have signed in.\n'
    printf 'ADMIN_EMAIL=%s\n' "${STREETSWEEP_ADMIN_EMAIL:-admin@streetsweep.local}"
    printf 'ADMIN_PASSWORD=%s\n' "$(rand_hex 12)"
  } > .env
  chmod 600 .env
elif ! grep -q '^ADMIN_PASSWORD=' .env; then
  # Upgrading an install from before accounts existed. The server only uses these when
  # the database has no accounts, so writing them is safe either way.
  say "Adding an administrator to .env"
  {
    printf '\n# Added on upgrade. Used only if the database has no accounts yet.\n'
    printf 'ADMIN_EMAIL=%s\n' "${STREETSWEEP_ADMIN_EMAIL:-admin@streetsweep.local}"
    printf 'ADMIN_PASSWORD=%s\n' "$(rand_hex 12)"
  } >> .env
  chmod 600 .env
fi

say "Pulling images"
docker compose pull db

say "Building and starting"
docker compose up -d --build

TOKEN="$(sed -n 's/^SYNC_TOKEN=//p' .env)"
ADMIN_EMAIL="$(sed -n 's/^ADMIN_EMAIL=//p' .env)"
ADMIN_PASSWORD="$(sed -n 's/^ADMIN_PASSWORD=//p' .env)"
PORT="$(sed -n 's/^HOST_PORT=//p' .env)"; PORT="${PORT:-8420}"
BASE="http://127.0.0.1:$PORT"

printf '\nWaiting for the server'
UP=no
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then UP=yes; break; fi
  printf '.'; sleep 2
done
printf '\n'
[ "$UP" = yes ] || die "The server did not come up. Check: docker compose -f $DIR/tools/docker-compose.yml logs"

# Rather than assume the account was created, try it. A 200 means these credentials are
# live and worth printing; anything else means an administrator already existed with a
# different password, and printing this one would be a lie.
ADMIN_WORKS=no
if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    --data "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    "$BASE/api/auth/login" 2>/dev/null || true)"
  [ "$CODE" = "200" ] && ADMIN_WORKS=yes
fi

say "StreetSweep server is up."
cat <<SUMMARY

  Direct           $BASE   (plain HTTP, for your reverse proxy)
  Behind the proxy https://streetsweep.hackspacelabs.com

  Access token     $TOKEN
SUMMARY

if [ "$ADMIN_WORKS" = yes ]; then
cat <<ADMIN

  Sign in at /login with

    Email     $ADMIN_EMAIL
    Password  $ADMIN_PASSWORD

  This is also kept in $DIR/tools/.env. To change it, run the reset above
  with a password of your own as the second argument.
ADMIN
else
cat <<ADMIN

  An administrator account already exists, so no new one was made and the
  password in .env is not it. If nobody knows it any more:

    docker compose -f $DIR/tools/docker-compose.yml exec web \
      node reset-password.js you@example.com --make-admin

  which prints a fresh password for that address.
ADMIN
fi

cat <<TAIL

Phones sign in from Settings -> Area builder server with their own account.
The access token above is only for the older phones that have not been
updated yet.

  Logs    docker compose -f $DIR/tools/docker-compose.yml logs -f
  Stop    docker compose -f $DIR/tools/docker-compose.yml down
TAIL
