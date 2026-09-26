#!/usr/bin/env bash
# Brings an existing StreetSweep install over to this checkout and its data folder.
#
# Run by install.sh before the stack starts; safe to run again, and does nothing once the
# data is here. It handles two things, either or both:
#
#   * An install running from another directory (such as /opt/streetsweep): its .env is
#     copied here and its containers are stopped, so these can take their names.
#   * Data kept in Docker's named volumes (tools_areas-data and the rest), from before the
#     data moved to plain folders under DATA_DIR: each volume is copied into its folder.
#
# Nothing old is deleted. The old directory and volumes stay until you remove them, so the
# move can be checked, and undone, first.
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
DIR="$(dirname "$TOOLS")"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

label() { docker inspect -f "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null || true; }

# The install that is running now, if any, and where it runs from.
OLD_WD="$(label streetsweep-area-builder com.docker.compose.project.working_dir)"
[ -n "$OLD_WD" ] || OLD_WD="$(label streetsweep-db com.docker.compose.project.working_dir)"
PROJECT="$(label streetsweep-db com.docker.compose.project)"
[ -n "$PROJECT" ] || PROJECT="$(label streetsweep-area-builder com.docker.compose.project)"
[ -n "$PROJECT" ] || PROJECT="tools"

if [ -n "$OLD_WD" ] && [ "$OLD_WD" != "$TOOLS" ]; then
  say "Found StreetSweep running from $OLD_WD; moving it to $DIR"
  if [ ! -f "$TOOLS/.env" ] && [ -f "$OLD_WD/.env" ]; then
    cp -p "$OLD_WD/.env" "$TOOLS/.env"
    echo "  Settings (.env) copied."
  fi
fi

# Where the data goes: DATA_DIR from .env, relative to this folder like Compose reads it.
DATA_DIR="$(sed -n 's/^DATA_DIR=//p' "$TOOLS/.env" 2>/dev/null | tail -1)"
DATA_DIR="${DATA_DIR:-../data}"
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$(cd "$TOOLS" && mkdir -p "$DATA_DIR" && cd "$DATA_DIR" && pwd)" ;; esac

# Docker volume -> folder under DATA_DIR.
PAIRS="areas-data:postgres photo-files:photos tile-cache:tiles osm-extract:osm valhalla-data:valhalla"

empty() { [ -z "$(ls -A "$1" 2>/dev/null)" ]; }

todo=""
for pair in $PAIRS; do
  vol="${PROJECT}_${pair%%:*}"; dest="$DATA_DIR/${pair##*:}"
  if docker volume inspect "$vol" >/dev/null 2>&1 && empty "$dest"; then todo="$todo $pair"; fi
done

# The old containers go before anything is copied: the database must not be writing
# while it is copied, and the new ones need these names.
if [ -n "$todo" ] || { [ -n "$OLD_WD" ] && [ "$OLD_WD" != "$TOOLS" ]; }; then
  for c in streetsweep-area-builder streetsweep-valhalla streetsweep-db; do
    if docker inspect "$c" >/dev/null 2>&1; then
      docker stop "$c" >/dev/null 2>&1 || true
      docker rm "$c" >/dev/null 2>&1 || true
    fi
  done
fi

if [ -n "$todo" ]; then
  say "Copying the data out of Docker volumes into $DATA_DIR"
  for pair in $todo; do
    vol="${PROJECT}_${pair%%:*}"; dest="$DATA_DIR/${pair##*:}"
    mkdir -p "$dest"
    # cp -a keeps owners and permissions: Postgres checks its folder is its own.
    docker run --rm -v "$vol":/from:ro -v "$dest":/to alpine sh -c 'cp -a /from/. /to/'
    printf '  %-22s -> %s (%s)\n' "$vol" "$dest" "$(du -sh "$dest" 2>/dev/null | cut -f1)"
  done
  echo "  The old volumes are still there. Once everything checks out:"
  for pair in $todo; do echo "    docker volume rm ${PROJECT}_${pair%%:*}"; done
fi

for sub in postgres photos tiles osm valhalla; do mkdir -p "$DATA_DIR/$sub"; done
if [ -n "$OLD_WD" ] && [ "$OLD_WD" != "$TOOLS" ]; then
  echo "  The old install at $(dirname "$OLD_WD") is untouched; remove it once this one checks out."
fi
