# StreetSweep v2 — plan

Status: **agreed 2026-10-03**. Stages 0–5 done. Stage 6 (apps) next, with its own go-ahead.

v2 is a ground-up, multi-user rebuild. v1 (`tools/`) keeps running untouched beside it
until v2 replaces it. v2 starts with an empty database — no v1 import.

## Principles

1. **The server is the master.** Only the server talks to OpenStreetMap (extracts,
   Overpass), Valhalla and tile sources. It builds areas, street segments, coverage and
   map packages, and distributes them to the apps. Apps and loggers upload raw drives
   and pull results — they never compute an authoritative figure.
2. **Multi-user from the first table.** Every row knows who owns it and which team it
   counts for. There is no "the user".
3. **Late data is normal.** A Wi-Fi logger may upload a drive hours later. Who drove,
   in which car, is resolved from *history at the time of the drive*, never from the
   current state.
4. **Docker for everything.** One `docker compose up` brings up the whole stack.
5. **Keep the login page.** v1's `login.html` design and art carry over as-is.
6. **Graphics come from ChatGPT.** Every image is a named slot in an asset brief
   (`docs/ASSETS.md`); the code ships placeholders until the real art lands.

## People, cars and loggers

| Concept | What it is |
|---|---|
| **User** | A person with a login. Sign-up is open to anyone. Can join any number of teams. |
| **Team** | A household, a delivery crew, or just "me" (every user gets a personal team on sign-up). Coverage is pooled per team. Roles: owner, admin, driver, viewer. A user **requests to join** and the team's admins approve or decline. |
| **Drive type** | Personal, Delivery, Commute… The app asks for it when a drive starts. Each team toggles which drive types count toward its coverage. |
| **Vehicle** | Owned by no person. It is **managed by a team**, which decides who edits it and who may drive it. A personal car sits under your personal team (you become its permanent driver automatically), a shared family car under a household team, and a van under the company team. A car can move between teams you run. Archiving it hands it back from everyone and takes its loggers out. |
| **Assignment** | Links a vehicle to a user. Either **permanent** (my car — several people can hold this, e.g. husband and wife) or **checkout** (van taken out, then returned; only one open checkout per vehicle at a time). Full history is kept. |
| **Device** | A signed-in phone (per-device token, revocable). |
| **Logger** | An ESP32 + GPS a user builds and registers. Has its own secret key, which signs every request with HMAC-SHA256. The server stores the secret itself, because HMAC needs it (see `docs/LOGGER-PROTOCOL.md`). It can be **installed** in any vehicle its builder may drive, with history kept, and has a default drive type. It uploads over Wi-Fi, with a BLE relay through the phone later that forwards the same signed requests. |

**Drive attribution.** Phone drive: the user is the signed-in person, and the vehicle is
the one picked on the phone (defaulting to their open checkout, otherwise their only
permanent car). Logger drive: the vehicle is the one the logger was installed in at that
time, and the driver is whoever had that vehicle checked out at that time, otherwise
its only permanent assignee, otherwise "unknown driver" (fixable on the web).

**Coverage.** A drive counts for a team when the driver belonged to that team at the
time **and** the team counts that drive's type. Example: a driver in "Household" and
"Acme Deliveries" marks a drive *Delivery*. Acme counts Delivery. Household has Delivery
switched off, so the drive counts for Acme only. Every pass is stored with its user and
vehicle, so you can filter by person or car. Changing a team's toggles re-rolls its
coverage, because the passes are kept.

## Architecture (Docker Compose)

```
                 ┌────────────┐
 browser ───────►│    api     │  Node 22 + TypeScript (Fastify). REST, sessions, uploads.
 phone   ───────►│  :8430     │  Also serves the built web app.
 logger  ───────►└─────┬──────┘
                       │ jobs (pg-boss queue in Postgres)
                 ┌─────▼──────┐        ┌────────────┐
                 │   worker   │───────►│  valhalla  │  map matching
                 │ same image │        └────────────┘
                 │            │───────► Geofabrik / Overpass / tile sources
                 └─────┬──────┘
                 ┌─────▼──────┐
                 │     db     │  Postgres 16 + PostGIS
                 └────────────┘
```

- **mailpit**: development mail catcher. The api sends sign-up and reset codes over SMTP.
- **db**: `postgis/postgis:16-3.5`. All geometry work (area ⟂ street clipping,
  lengths, buffers) moves into SQL instead of hand-written JS.
- **api**: stateless. Long work goes to a job. The one outside call it makes is the basemap
  tile relay: tiles have to arrive while you look at the map, so the api fetches each tile
  once (OSM no more than 2 at a time, with a contact User-Agent) and keeps it on disk for
  `TILE_TTL_DAYS`.
- **worker**: OSM extract import (osmium), segmenting, area builds, drive matching,
  coverage roll-ups, tile/package builds. Retries and backoff in one place.
- **web**: Svelte 5 + TypeScript + Vite + MapLibre (building on what `tools/web` started),
  compiled in the Docker build and served by api.
- **valhalla**: as in v1.
- Host port **8430**, so it runs alongside v1 on 8420.
- Migrations: numbered plain-SQL files in `v2/db/migrations`, applied on api start-up.

## Draft schema

Conventions: `uuid` primary keys (client-generatable, so uploads are idempotent),
`timestamptz` everywhere, soft delete via `deleted_at` (which also gives the apps their
tombstones for sync), `updated_at` on anything an app syncs, geometry in SRID 4326.

### Identity
```sql
users           (id, email citext UNIQUE, display_name, password_hash, avatar_path,
                 is_site_admin bool, created_at, disabled_at)
sessions        (id, user_id, token_hash, user_agent, created_at, last_seen_at, expires_at)
email_codes     (id, user_id, purpose 'verify'|'reset', code_hash, attempts,
                 created_at, expires_at, used_at)            -- users.email_verified_at too
teams           (id, name, kind 'personal'|'shared', created_by, created_at, deleted_at)
team_members    (team_id, user_id, role 'owner'|'admin'|'driver'|'viewer',
                 joined_at, left_at)                       -- history, not just current
team_join_requests
                (id, team_id, user_id, message, status 'pending'|'approved'|'declined'|'withdrawn',
                 requested_at, decided_by, decided_at)
drive_types     (key PK, label, icon, sort, archived_at)     -- site-wide list, site admin edits
team_drive_types(team_id, drive_type_key, counts bool)       -- each team's toggles
devices         (id, user_id, name, platform, app_version, token_hash,
                 last_seen_at, revoked_at)
```

### Fleet
```sql
vehicles        (id, managed_by_team_id NULL, name, make, model, year, color, plate,
                 photo_path, checkout_policy 'open'|'admin_only',
                 created_by, created_at, archived_at)
vehicle_assignments
                (id, vehicle_id, user_id, kind 'permanent'|'checkout',
                 during tstzrange,                          -- [start, end) ; open end = active
                 assigned_by, note)
  -- EXCLUDE USING gist (vehicle_id WITH =, during WITH &&) WHERE kind='checkout'
  --   → a van can't be checked out to two people at once
loggers         (id, owner_user_id, name, secret, default_drive_type_key, hardware_id,
                 firmware_version, last_seen_at, last_battery_mv,
                 created_at, revoked_at)
logger_installs (id, logger_id, vehicle_id, during tstzrange)   -- same EXCLUDE per logger
```

### Map data (server-built)
```sql
osm_imports     (id, source_url, region, osm_timestamp, started_at, finished_at, status)
street_ways     (way_id bigint PK, name, highway, oneway, tags jsonb,
                 geom LineString, import_id)
street_segments (id bigint PK, way_id, seq, geom LineString, length_m,
                 from_node, to_node)                        -- split at intersections
                 -- the unit of coverage; ids stable across imports where geometry unchanged
areas           (id, team_id NULL,                          -- NULL = public boundary
                 parent_id, name, level 'country'|'state'|'county'|'city'|'neighborhood'|'custom',
                 source 'drawn'|'osm_boundary', osm_relation_id,
                 geom MultiPolygon, color, notes, created_by,
                 created_at, updated_at, deleted_at, version int)
area_segments   (area_id, segment_id, clipped_length_m)     -- built by worker
area_segments   (area_id, segment_id, inside_m)              -- built by the worker
team_areas      (team_id, area_id, added_by, added_at)       -- public areas a team follows
area_packages   (id, area_id, version, kind 'streets'|'tiles',
                 path, bytes, sha256, built_at)              -- stage 6: what apps download
jobs            -- managed by pg-boss
```

### Driving and coverage
```sql
drives          (id uuid PK,                                -- generated on the phone/logger
                 source 'phone'|'logger', device_id NULL, logger_id NULL,
                 user_id NULL, vehicle_id NULL,             -- resolved, editable on the web
                 drive_type_key,                            -- asked at start; loggers use a default
                 attribution 'explicit'|'inferred'|'unknown',
                 started_at, ended_at, distance_m,
                 track geometry(LineStringM),               -- raw, M = epoch seconds
                 raw_path,                                  -- original upload kept on disk
                 status 'received'|'matching'|'matched'|'failed', error,
                 created_at, updated_at, deleted_at)
logger_batches  (logger_id, seq, received_at, via 'wifi'|'ble', drive_id)
                 PK (logger_id, seq)                         -- idempotent re-uploads
segment_passes  (segment_id, drive_id, user_id, vehicle_id, driven_at, direction)
team_coverage   (team_id, segment_id, first_driven_at, first_drive_id,
                 first_user_id, pass_count)                  -- rolled up by worker
segment_marks   (team_id, segment_id, kind 'complete'|'excluded',
                 user_id, note, created_at, deleted_at)
area_progress   (area_id, team_id, total_m, driven_m, marked_m, updated_at)  -- cache
```

### Places, achievements, audit
```sql
places          (id, team_id, user_id, drive_id NULL, kind, geom Point, note,
                 created_at, updated_at, deleted_at)
place_photos    (id, place_id, path, width, height, created_at)
achievements    (user_id, key, earned_at, drive_id)          -- definitions live in code
audit_log       (id, at, user_id, team_id, action, entity, entity_id, data jsonb)
```

## APIs at a glance

- **Web/app (session or device token):** `/api/auth/*`, `/api/me`, `/api/teams/*`,
  `/api/vehicles/*` (incl. `POST …/checkout`, `POST …/return`), `/api/loggers/*`,
  `/api/areas/*`, `/api/drives/*`, `/api/coverage`, `/api/places/*`.
- **App sync:** `GET /api/sync?since=<cursor>` returns changed areas, marks, vehicles,
  assignments and tombstones. `GET /api/areas/:id/package` downloads a prebuilt
  street and tile pack.
- **Upload:** `POST /api/drives` (phone, gzip NDJSON of fixes, idempotent on drive id).
- **Logger:** `POST /api/logger/batches`, with header `X-Logger-Id`, a body of fixes, and
  an HMAC-SHA256 signature over the body using the logger key. Idempotent on (logger, seq).
  A phone relaying over BLE forwards the same signed blob unchanged, so the phone never
  holds the logger's key.
- **Logger provisioning:** register on the web, which shows the key once with a QR code
  and a `curl` line to flash. The logger pulls its time and settings from `GET /api/logger/config`.

## Build stages

0. ✅ **Scaffold.** `v2/` folder, compose (db, api, worker, valhalla), migration runner,
   login page ported and served, health checks. *Done when* `docker compose up` shows
   the login page on :8430.
1. ✅ **Identity.** Open sign-up/sign-in, sessions, personal team on sign-up, teams,
   join requests approved by team admins, roles, drive types + team toggles,
   account modal, site-admin page.
2. ✅ **Fleet.** Vehicles, permanent assignments, checkout/return with history, devices,
   logger registration and keys.
3. ✅ **Map data.**
   - 3a, streets: osmium → segments → PostGIS vector tiles at `/api/tiles/streets/{z}/{x}/{y}`
     (zoom 12+), a Map page, and Admin → Map data.
   - 3b, areas: state, county and city boundaries from the same extract (boundary lines
     tiled at `/api/tiles/areas`); team-drawn areas; teams following public areas. Each
     area's street list is built by the worker. Geofabrik import, segmenting, public boundaries, drawn areas, area
   builds as jobs, cached tiles, area packages.
4. ✅ **Drives.** Phone + logger upload, attribution, Valhalla matching, passes, team
   coverage, marks, drive editing (fix driver/vehicle).
5. ✅ **Insights.** Progress, drives list, places/photos, achievements, leaderboard
   (per team).
6. **Apps.** Sync API hardened, then the Android app moved onto v2 (separate go-ahead).
7. **Logger firmware.** Reference ESP32 sketch for Wi-Fi upload, and BLE after that.

## Decisions (2026-10-03)

1. **Multi-team drivers.** Each drive has a type, which the app asks for at the start.
   Each team chooses which types count for it.
2. **Sign-up** is open. Joining a team needs approval from that team's admins.
3. **Map tiles.** Start with cached raster tiles. Vector tiles (PMTiles) come later,
   together with the Android app moving to MapLibre.
4. **Location.** `v2/` sits inside the repo, beside `tools/`. Builds happen inside Docker,
   so there is no `node_modules` in the synced folder. `DATA_DIR` (Postgres, photos,
   tiles, OSM) defaults to `~/streetsweep-v2-data`, outside Synology.

5. **Look.** The web app is light only, with no automatic dark mode. Brand navy is used
   only as an accent and on the sign-in page.
6. **First site admin.** Set `ADMIN_EMAIL` (and optionally `ADMIN_PASSWORD`) before first
   boot, or promote any account with
   `docker compose exec api node dist/cli.js make-admin <email>`. There's no
   "first sign-up becomes admin" rule, because sign-up is open.
7. **Email codes.** A new account can't be used until a 6-digit code emailed to it has
   been entered. "Forgot password?" emails a one-time code, which is entered together with
   a new password. Both codes:
   - last **15 minutes**, allow 5 wrong tries, and work once;
   - are limited to one email a minute and five an hour per account.

   Signing up again with an address that was never confirmed replaces the old attempt.
   The forgot-password form answers the same whether or not an account exists.
   Development mail goes to **Mailpit** (http://localhost:8025). Production sets `SMTP_*`.
   A site admin can still hand out a password from the Admin page.

8. **Holding a car ends with the team.** Leaving a team, being removed, or becoming a
   viewer ends that person's permanent assignments and check-outs on the team's vehicles.
   A team that still manages active vehicles can't be deleted.
9. **Phones** sign in with `POST /api/auth/device` and get a bearer token, which can be
   revoked under Fleet → Phones.

10. **Streets.** These road types count: primary, secondary, tertiary, unclassified,
    residential and living_street, plus their `_link` ramps (the same set as v1). A way is
    cut at every node it shares with another street. Each segment's identity is
    `(way, from node, to node, dup)`, so a re-import keeps unchanged pieces' ids; that was
    checked on Texas with 0 changes. Pieces that disappear are retired, never deleted.
    Texas has 1.2 M streets, 2.46 M segments and about 436 k miles, and imports in about
    2 minutes. It refreshes monthly on the 3rd.

11. **Areas.**
    - Public boundaries are OSM `boundary=administrative` relations at admin levels 4, 6
      and 8 (state, county, city), clipped to the state. Texas has 1 state, 254 counties
      and 1,224 cities. Each boundary's parent is the smallest boundary containing a
      point inside it.
    - Teams *follow* public areas. A street list is shared by every team that follows it.
    - Teams draw their own areas: neighbourhood or custom, several pieces allowed, at
      most 5,000 km². Only owners and admins can draw, edit, follow or unfollow.
    - An area's street list (`area_segments`) records how many metres of each segment
      lie inside it, so edge streets count only for their inside part.
    - Builds run in the worker: Travis County takes about 5 s, the whole state about 32 s.
      Outlines are versioned, and a build only lands if the outline didn't change
      meanwhile.
    - After every street import, all areas in use are rebuilt.
    - Area *packages* for the apps move to stage 6, where the apps need them.

12. **Insights (stage 5), decided 2026-10-03.**
    - **Achievements:** v1's set (ladders plus named badges), earned per person from the
      drives credited to them, *plus team achievements* earned by a team as a whole.
    - **Leaderboards:** several boards per team (new streets swept, total miles,
      drives), each for this week, this month or all time.
    - **Places:** private to the person who marks them, and shareable with any of
      their teams. Added from the web map now, and from the phone in stage 6.
    - **Home:** a new Home page (stats, area progress, recent drives, achievements,
      with a team switcher) replaces Teams as the landing page.

13. **Apps (stage 6), decided 2026-10-03.** The Android app moves onto v2 entirely. The
    server does all OSM, Overpass and Valhalla work; the phone stops calling them.
    - **Live coverage:** while driving, the phone marks streets near its raw track as
      *provisionally driven* from its downloaded segments (works offline). The
      server's match replaces that once the drive uploads.
    - **Old phone drives:** a one-time upload of every v1 drive's raw points as v2
      drives, so the server matches them. Old exclusions and completions become marks
      for the personal team.
    - **Vehicle and drive type:** smart defaults. A Bluetooth car can be linked to a
      vehicle; otherwise the open checkout, else the only permanent car. The type
      defaults to the last used. Both can be changed from the drive notification, the
      app or the car screen, or fixed later on the web.
    - **Server address:** the app defaults to `https://streetsweep.net` (editable in
      Settings). Development uses the local stack.
    - **Personal teams count all of their person's drives,** whenever driven. Other
      teams count only drives from while the driver was a member.

## Still open

- **Changing your email** in the account window doesn't ask for a code yet. It should
  send one to the new address before switching to it.

- **Finding teams.** Draft: teams are searchable by name, and a team can be made unlisted,
  in which case people join through a link with a code.
