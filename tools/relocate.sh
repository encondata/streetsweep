#!/usr/bin/env bash
# Brings an existing StreetSweep install over to this checkout and its data folder.
#
# Run by install.sh before the stack starts; safe to run again, and does nothing once the
# data is here. It copies the data from wherever the install that is running now keeps
# it — Docker named volumes (older installs) or plain folders (such as
# /mnt/user/streetsweep/data) — into the folders under this install's DATA_DIR. With no
# install running, data left in the old named volumes (tools_areas-data and the rest) is
# copied instead. With no data anywhere, nothing is copied: a fresh install.
#
# Nothing old is deleted. The old directory, folders and volumes stay until you remove
# them, so the move can be checked, and undone, first.
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
DIR="$(dirname "$TOOLS")"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
label() { docker inspect -f "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null || true; }
empty() { [ -z "$(ls -A "$1" 2>/dev/null)" ]; }

# Each piece of data: the container holding it, where it sits inside, and its folder here.
PIECES="streetsweep-db:/var/lib/postgresql/data:postgres
streetsweep-area-builder:/data/photos:photos
streetsweep-area-builder:/data/tiles:tiles
streetsweep-area-builder:/data/osm:osm
streetsweep-valhalla:/custom_files:valhalla"

# The install running now, if any, and where it runs from.
OLD_WD="$(label streetsweep-area-builder com.docker.compose.project.working_dir)"
[ -n "$OLD_WD" ] || OLD_WD="$(label streetsweep-db com.docker.compose.project.working_dir)"
PROJECT="$(label streetsweep-db com.docker.compose.project)"
[ -n "$PROJECT" ] || PROJECT="tools"
MOVING=no
if [ -n "$OLD_WD" ] && [ "$OLD_WD" != "$TOOLS" ]; then MOVING=yes; fi

if [ "$MOVING" = yes ]; then
  say "Found StreetSweep running from $(dirname "$OLD_WD"); moving it to $DIR"
  if [ ! -f "$TOOLS/.env" ] && [ -f "$OLD_WD/.env" ]; then
    # Its settings come along — token, administrator, map file and the rest — except
    # where its data was kept: the data moves to this install's own folder.
    grep -v '^DATA_DIR=' "$OLD_WD/.env" > "$TOOLS/.env" || true
    chmod 600 "$TOOLS/.env"
    echo "  Settings (.env) copied."
  fi
fi

# Where the data goes: DATA_DIR from .env, relative to this folder as Compose reads it.
DATA_DIR="$(sed -n 's/^DATA_DIR=//p' "$TOOLS/.env" 2>/dev/null | tail -1)"
DATA_DIR="${DATA_DIR:-../data}"
case "$DATA_DIR" in /*) mkdir -p "$DATA_DIR" ;; *) DATA_DIR="$(cd "$TOOLS" && mkdir -p "$DATA_DIR" && cd "$DATA_DIR" && pwd)" ;; esac

# Where each piece is now: read from the running containers before they are stopped.
# "volume:<name>" or "bind:<path>", one per piece, or nothing.
sources=""
while IFS=: read -r container inside sub; do
  src="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$inside\"}}{{.Type}}:{{if eq .Type \"volume\"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}" "$container" 2>/dev/null || true)"
  # Nothing running: the named volumes an older install left behind.
  if [ -z "$src" ]; then
    case "$sub" in
      postgres) vol=areas-data ;; photos) vol=photo-files ;; tiles) vol=tile-cache ;;
      osm) vol=osm-extract ;; valhalla) vol=valhalla-data ;;
    esac
    docker volume inspect "${PROJECT}_$vol" >/dev/null 2>&1 && src="volume:${PROJECT}_$vol"
  fi
  sources="$sources$sub=$src
"
done <<< "$PIECES"

# Only pieces that exist somewhere else and have nothing here yet. A piece with data both
# there and here is left alone — this install's own data is never overwritten — and said so.
todo=""; kept=""
while IFS='=' read -r sub src; do
  [ -n "$sub" ] && [ -n "$src" ] || continue
  dest="$DATA_DIR/$sub"
  [ "$src" = "bind:$dest" ] && continue                       # already here
  if [ "${src%%:*}" = bind ] && empty "${src#bind:}"; then continue; fi   # nothing there
  if ! empty "$dest"; then kept="$kept $sub"; continue; fi     # something here already
  todo="$todo$sub=$src
"
done <<< "$sources"

# The old containers go before anything is copied: the database must not be writing while
# it is copied, and the new ones need these names.
if [ -n "$todo" ] || [ "$MOVING" = yes ]; then
  for c in streetsweep-area-builder streetsweep-valhalla streetsweep-db; do
    if docker inspect "$c" >/dev/null 2>&1; then
      docker stop "$c" >/dev/null 2>&1 || true
      docker rm "$c" >/dev/null 2>&1 || true
    fi
  done
fi

if [ -n "$todo" ]; then
  say "Copying the data into $DATA_DIR"
  while IFS='=' read -r sub src; do
    [ -n "$sub" ] || continue
    dest="$DATA_DIR/$sub"; mkdir -p "$dest"
    case "$src" in
      volume:*) from="${src#volume:}" ;;
      bind:*)   from="${src#bind:}" ;;
    esac
    # cp -a keeps owners and permissions: Postgres checks its folder is its own.
    docker run --rm -v "$from":/from:ro -v "$dest":/to alpine sh -c 'cp -a /from/. /to/'
    printf '  %-9s %s -> %s (%s)\n' "$sub" "$from" "$dest" "$(du -sh "$dest" 2>/dev/null | cut -f1)"
  done <<< "$todo"
  echo "  The old copies are still there. Once everything checks out, remove them:"
  while IFS='=' read -r sub src; do
    [ -n "$sub" ] || continue
    case "$src" in
      volume:*) echo "    docker volume rm ${src#volume:}" ;;
      bind:*)   echo "    rm -rf ${src#bind:}" ;;
    esac
  done <<< "$todo"
elif [ "$MOVING" = yes ] && [ -z "$kept" ]; then
  echo "  The old install had no data to bring over; this is a fresh install."
fi
if [ -n "$kept" ]; then
  echo "  Already here, so not copied (this install's own data is kept):$kept"
  echo "  To bring the old install's data over instead, empty those folders under $DATA_DIR and run this again."
fi

for sub in postgres photos tiles osm valhalla; do mkdir -p "$DATA_DIR/$sub"; done
if [ "$MOVING" = yes ]; then
  echo "  The old install at $(dirname "$OLD_WD") is untouched; remove it once this one checks out."
fi
