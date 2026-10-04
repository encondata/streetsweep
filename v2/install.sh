#!/usr/bin/env bash
# StreetSweep v2 server installer (and updater: run it again to update).
#
#   curl -fsSL https://raw.githubusercontent.com/encondata/streetsweep/v2/v2/install.sh | bash
#
# Installs beside v1 rather than over it: its own folder, its own data, port 8430 (v1 is
# 8420), so v1 keeps running until the reverse proxy is pointed at v2. Clones or updates
# the repository, writes .env on first run (database password, first site admin), and
# brings the stack up. Safe to run again: .env is never overwritten.
#
# The app serves plain HTTP and expects a reverse proxy in front of it for TLS.
set -euo pipefail

REPO="${STREETSWEEP_REPO:-https://github.com/encondata/streetsweep.git}"
BRANCH="${STREETSWEEP_BRANCH:-v2}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
ask() { # ask "question" default → the answer, from the terminal even under curl | bash
  local answer=""
  if { exec 3</dev/tty; } 2>/dev/null; then
    printf '%s [%s] ' "$1" "$2" > /dev/tty
    read -r answer <&3 || answer=""
    exec 3<&-
  fi
  printf '%s' "${answer:-$2}"
}

command -v git >/dev/null 2>&1 || die "git is not installed."
command -v curl >/dev/null 2>&1 || die "curl is not installed."
command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "This needs Docker Compose v2 (the 'docker compose' subcommand)."
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it and try again."

# Where: wherever v2 already runs, so an update is just Enter; else beside v1's usual place.
RUNNING_WD="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
  streetsweep2-api 2>/dev/null || true)"
if [ -n "$RUNNING_WD" ]; then DEFAULT_DIR="$(dirname "$RUNNING_WD")"
elif [ -d /mnt/user ]; then DEFAULT_DIR=/mnt/user/streetsweep-v2
else DEFAULT_DIR="$HOME/streetsweep-v2"; fi
DIR="${STREETSWEEP_DIR:-$(ask 'Install StreetSweep v2 where?' "$DEFAULT_DIR")}"
case "$DIR" in "~"*) DIR="$HOME${DIR#\~}" ;; esac
DIR="${DIR%/}"
case "$DIR" in /*) ;; *) die "Please give a full path, starting with /." ;; esac
if [ -d "$DIR" ] && [ ! -d "$DIR/.git" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR already has other files in it. Choose an empty or new folder."
fi

# The compose file lives in the repository, so the code comes first.
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR to $BRANCH"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
  git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  say "Cloning $BRANCH into $DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR/v2"

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

if [ ! -f .env ]; then
  ADMIN_EMAIL="${STREETSWEEP_ADMIN_EMAIL:-$(ask 'Email address for the first site admin?' 'admin@streetsweep.local')}"
  DATA_DIR="${STREETSWEEP_DATA_DIR:-$DIR-data}"
  say "Writing $DIR/v2/.env"
  {
    printf '# StreetSweep v2 settings. Every option, with notes, is in .env.example.\n\n'
    printf '# Database, photos, map tiles and street data. Outside the repository.\n'
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'HOST_PORT=8430\n'
    printf 'POSTGRES_PASSWORD=%s\n\n' "$(rand_hex 16)"
    printf '# The first site admin, created (already confirmed) on first start. Change the\n'
    printf '# password after signing in; this stays only as a record of what was set.\n'
    printf 'ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL"
    printf 'ADMIN_PASSWORD=%s\n' "$(rand_hex 12)"
    printf 'CONTACT_EMAIL=%s\n\n' "$ADMIN_EMAIL"
    printf '# Valhalla (drive matching) downloads its own copy of the street data to build from.\n'
    printf 'VALHALLA_PBF_URL=https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf\n'
    printf '# v1 has Valhalla on 8002; the worker reaches this one inside Docker, so any free port.\n'
    printf 'VALHALLA_PORT=8012\n\n'
    printf '# Sign-up and password-reset codes go by email. Until these are set they land in\n'
    printf '# Mailpit (port 8025) instead of anyone'"'"'s inbox:\n'
    printf '# SMTP_HOST=smtp.example.com\n# SMTP_PORT=587\n# SMTP_SECURE=false\n# SMTP_USER=\n# SMTP_PASS=\n'
    printf '# MAIL_FROM=StreetSweep <no-reply@streetsweep.net>\n'
  } > .env
  chmod 600 .env
fi

env_get() { sed -n "s/^$1=//p" .env | tail -1; }
DATA_DIR="$(env_get DATA_DIR)"; DATA_DIR="${DATA_DIR:-$HOME/streetsweep-v2-data}"
PORT="$(env_get HOST_PORT)"; PORT="${PORT:-8430}"
mkdir -p "$DATA_DIR/postgres" "$DATA_DIR/files" "$DATA_DIR/valhalla"

report() {
  printf '\n\033[1mContainers:\033[0m\n' >&2
  docker compose ps -a >&2 || true
  for svc in db api worker; do
    printf '\n\033[1mLast lines from %s:\033[0m\n' "$svc" >&2
    docker compose logs --no-color --tail 25 "$svc" >&2 2>&1 || true
  done
}

say "Pulling images"
docker compose pull db mailpit valhalla

say "Building and starting"
# Valhalla on its own afterwards: its first start builds routing tiles for a while, and
# that shouldn't hold up the web app. Drives wait in a queue until it answers.
if ! docker compose up -d --build db mailpit api worker; then
  report
  die "StreetSweep could not be started; the reason is above. Fix it and run this again: data is kept."
fi
if ! docker compose up -d valhalla; then
  printf '\n\033[33m%s\033[0m\n' "Valhalla (drive matching) could not be started; the web app runs without it and drives wait to be matched. If its port is taken, set VALHALLA_PORT in $DIR/v2/.env and run this again." >&2
fi

BASE="http://127.0.0.1:$PORT"
printf '\nWaiting for the server'
UP=no
for _ in $(seq 1 90); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then UP=yes; break; fi
  printf '.'; sleep 2
done
printf '\n'
[ "$UP" = yes ] || { report; die "The server did not answer on $BASE within three minutes; the reason is above."; }

# Try the admin account rather than assume it was made with this password.
ADMIN_EMAIL="$(env_get ADMIN_EMAIL)"
ADMIN_PASSWORD="$(env_get ADMIN_PASSWORD)"
ADMIN_WORKS=no
if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    --data "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$BASE/api/auth/login" || true)"
  [ "$CODE" = "200" ] && ADMIN_WORKS=yes
fi
HELD="$(docker compose exec -T db psql -U streetsweep -d streetsweep -Atc \
  "SELECT (SELECT count(*) FROM users) || ' accounts, ' || (SELECT count(*) FROM drives) || ' drives, ' ||
          (SELECT count(*) FROM street_segments) || ' street segments'" 2>/dev/null || true)"

say "StreetSweep v2 is up."
cat <<SUMMARY

  Direct        $BASE   (plain HTTP: point the reverse proxy for streetsweep.net here)
  Installed in  $DIR
  Data in       $DATA_DIR
  Holding       ${HELD:-(could not read the database)}
  Mail catcher  http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):8025   (sign-up codes land here until SMTP_* is set in .env)
SUMMARY
if [ "$ADMIN_WORKS" = yes ]; then
cat <<ADMIN

  Sign in with
    Email     $ADMIN_EMAIL
    Password  $ADMIN_PASSWORD
  (also kept in $DIR/v2/.env; change it once you're in)
ADMIN
else
cat <<ADMIN

  A site admin already exists. To make another account an admin:
    docker compose -f $DIR/v2/compose.yaml exec api node dist/cli.js make-admin you@example.com
ADMIN
fi
cat <<TAIL

  First start: the worker imports the Texas streets (a few minutes), and Valhalla
  builds its routing tiles (longer). Follow them with
    docker compose -f $DIR/v2/compose.yaml logs -f worker valhalla

  v1 is untouched and still answers on port 8420 until the proxy moves.

TAIL
