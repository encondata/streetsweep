# StreetSweep

Android app that records where you have driven and draws it, snapped to the street
centreline, on a Google map, so you can see which streets in a neighbourhood or city
are done and which are left.

| Setting      | Value                     |
|--------------|---------------------------|
| compileSdk   | 36 (Android 16)           |
| targetSdk    | 36 (Android 16)           |
| minSdk       | 26 (Android 8.0)          |
| Gradle / AGP | 8.13 / 8.13.2             |
| Kotlin       | 2.0.21                    |
| UI           | Jetpack Compose, Material 3 |
| Maps         | OpenStreetMap via osmdroid  |

## What it does

- **Recording.** A foreground service asks Google's fused location provider for a fix
  every 15 s. A fix is stored only if it is at least **50 ft** from the last stored point,
  so sitting at a red light adds one point, not one every 15 s. Fixes with accuracy worse
  than 50 m, or timestamped before the session started (cached last-known location), are
  discarded. See `domain/PointFilter.kt` and `tracking/TrackingService.kt`.
- **Drawing areas on a computer.** `tools/` holds a small static web page, run with
  `docker compose up -d --build` and opened at <http://localhost:8420>, for outlining areas
  with a mouse instead of a fingertip. Areas are kept in Postgres, so they follow you between
  browsers and machines. It exports GeoJSON, which the phone reads under *Settings → Import
  areas from GeoJSON*; nesting is matched by name. It also loads the app's own coverage export,
  so you can see the streets you have already driven while deciding where an area should stop.
  Opened straight from disk with nothing running, it falls back to browser storage and says so.
  A second tab shows coverage pushed up from the phone: driven streets on a map, each area's
  completion and the drive log. The phone sends it from *Settings → Area builder server*, on
  demand or after every drive, and can pull areas straight from the server instead of a file.
- **Coverage areas, nested.** Frame a place on the map and tap *Add area*, choosing
  neighbourhood, city or metro and, optionally, which larger area it belongs to. Streets are
  stored once, globally, with a spatial index; an area's figures are computed by containment,
  so a city's percent includes its neighbourhoods without double counting. The Areas tab
  shows the tree with a percent, streets done and miles for every level; the map's status
  card reports on the smallest area around the map centre.
- **Chunked downloads.** An area is split into a 0.1° grid (about 11 × 9 km cells) and each
  cell is one Overpass request, with pauses and retries, run as a background job with a
  progress notification. Cells fetched for one area are reused by another for 30 days.
  A metro of 1° × 1° is ~120 cells and 10–20 minutes; the limit is 400 cells per area.
- **Only what's on screen.** The map and the car screen query streets and driven segments
  by viewport: streets from zoom 14, driven segments from zoom 12, area outlines with their
  percent at any zoom. Years of driving across many cities stay smooth.
- **Excluding streets.** Gated communities, private lanes and roads you have no intention of
  sweeping would otherwise cap an area below 100%. Tap any street on the map to exclude it, or
  choose *Exclude a gated area* and outline the whole subdivision to drop every street inside
  it at once. Excluded streets stay on the map in dashed grey and leave every total, both the
  count and the mileage denominator, so 100% becomes reachable. The Areas tab's street list
  filters by undriven, partly driven, done or excluded, searches by name, and can exclude
  everything currently listed in one action.
- **"Everything past here is gated".** Pull up to a gate and tap **Gate** on the car screen.
  It finds the roads leaving that spot and turns the buttons into **← Left / ↑ Ahead / → Right**,
  naming each road in the status panel and highlighting the three candidates on the map, so you
  just point at the one the gate is on. StreetSweep then walks the OpenStreetMap network forward
  along it, blocked from slipping back out past you, and proposes everything it reaches: those
  streets turn red and the buttons become *Exclude N* and cancel, with **Undo** for 30 seconds
  afterwards. If the road simply carries on it refuses rather than guessing, capped at 300
  streets or 30 km, so a public through-road can never be swallowed by accident.
- **Guidance to what's left.** The map and the car screen both show the nearest street that
  still needs driving: its name, distance, compass bearing, a rotating arrow, and the street
  itself highlighted in orange with a dashed pointer from your position. It is restricted to
  the area you are in, so it never sends you out of the neighbourhood you are sweeping, and it
  recomputes as you drive and as streets get completed.
- **Backup, restore and export.** *Back up now* writes the whole database — drives, areas,
  exclusions, marked spots — wherever you choose, and *Restore* puts it back after checking the
  file really is a StreetSweep backup before overwriting anything. Point it at a folder that
  syncs to Drive and it will write one automatically each day or week, keeping the eight most
  recent. Drives also export as GPX (tracks plus waypoints) and coverage as GeoJSON (area
  outlines and every driven segment) for use in other tools.
- **Nothing lost to a dead signal.** If a drive ends somewhere with no data, matching is queued
  and retried as soon as there is a network, and swept again daily.
- **Drive summaries.** When a drive ends you get a notification saying how far you went, how much
  of it was street you had never driven, and where that leaves the area you were in.
- **Progress over time.** The chart icon on the Drives tab opens a screen with lifetime totals, a
  sixteen-week bar chart of miles, and each area's percentage with a plain-language estimate of
  how long it will take at the pace of the last month.
- **Home screen widget.** Shows the area you are actively sweeping, its percentage and how many
  streets are left. Taps through to the app.
- **Colour by age.** Optionally shade driven streets by how long ago you covered them, for
  sweeping that repeats rather than finishes.
- **Auto-stop when idle.** Ends a drive that has not moved for 15, 30 or 60 minutes, so a session
  you forgot about stops draining the battery. Off by default.
- **A word when you drive outside your areas.** The drive is still recorded and matched, but a
  notification points out that it will not count toward any coverage figure until you add an area.
- **Per-drive and lifetime numbers.** Each drive records the segments and miles it covered
  for the first time. The Drives tab has an all-time header: drives, miles, hours and
  first-time street miles.
- **Road matching.** Each drive is matched to OpenStreetMap roads with Valhalla
  (`trace_attributes`, map-snap mode). Every matched road segment between intersections is
  stored as "driven" with its OSM way id, so a street turns amber when partly driven and
  teal once at least 80 % of its length has been covered. Both directions of a two-way
  street count once. Matching runs every 20 stored points while driving, when a drive
  ends, and on demand from a drive's detail screen.
- **Map.** OpenStreetMap raster tiles (osmdroid) with a desaturated, lightened filter so
  the coverage colours dominate. The active drive shows as a dashed raw breadcrumb plus an
  amber matched track.
- **Manual mode.** Start/Stop on the map screen and on the ongoing notification.
- **Automatic mode.** Two triggers, either or both:
  - *Bluetooth device* — pick a paired device (your car). Recording starts when it
    connects and stops 90 s after it disconnects. Uses the system `ACL_CONNECTED`
    broadcast, which Android allows to start a foreground service from the background.
  - *In a vehicle* — Google Play services' activity recognition, as a fallback for cars with
    neither Bluetooth pairing nor Android Auto. Slower to react, by a minute or so.
  - *Android Auto* — detected through the Car App Library connection provider. Wireless
    Android Auto rides on the Bluetooth event above. Wired Android Auto is detected from
    the USB power event; Android 12+ does not let that event start a foreground service in
    the background, so in that case a one-tap "Start recording" notification is posted.
  - A manual stop always wins. An automatic session keeps recording as long as any
    enabled trigger is still connected.
- **Android Auto.** A navigation-category car app (`car/`) paints its own map surface on the
  head unit: OSM tiles in the same subdued style, the area's streets coloured by status,
  driven segments, the car's position and heading, plus Record/Stop, recenter and zoom
  buttons. Pan and pinch work through the head unit's map controls.

## No API keys

Everything comes from OpenStreetMap and free community services, so there is nothing to
sign up for:

| Need            | Service                                         | Default                                   |
|-----------------|-------------------------------------------------|-------------------------------------------|
| Map tiles       | OSM standard tile layer                         | `tile.openstreetmap.org`                  |
| Street network  | Overpass API                                    | `overpass-api.de/api/interpreter`         |
| Road matching   | Valhalla (FOSSGIS community instance)           | `valhalla1.openstreetmap.de`              |

These are fair-use services for personal volumes; the app identifies itself with a User-Agent
and caches tiles (up to 200 MB), so anywhere you have already looked at stays available offline.
StreetSweep deliberately does **not** bulk-download tiles for an area: the OpenStreetMap tile
usage policy prohibits it, and a single neighbourhood at street zoom runs to thousands of tiles.
If you want guaranteed offline maps, point osmdroid at your own tile server or a local MBTiles
file instead. The Valhalla and Overpass URLs can be changed in Settings if you ever
run your own instances. Location still comes from Google Play services' fused provider,
which needs no key.

## The server

The area builder and coverage portal run as two containers behind your own reverse proxy. On
the host:

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/streetsweep/main/install.sh | bash
```

It clones the repository, generates an access token, pulls the images and starts everything,
and is safe to re-run to update. The app listens on port 8420 over plain HTTP for a reverse
proxy to forward to; behind that it answers on <https://streetsweep.hackspacelabs.com>. Every
API call needs the token, which the installer prints; see `tools/README.md`.

## Setup

Open the folder in Android Studio 2025.2+ or build from the terminal (Gradle 8.13
needs JDK 17–23; use Android Studio's bundled JDK if your default is newer):

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug testDebugUnitTest
```

## Android Auto (personal use, no Play Store)

The car app is only offered to the head unit for sideloaded builds if Android Auto's developer
settings allow it:

1. On the phone open **Android Auto** settings (Settings → Connected devices → Android Auto).
2. Scroll to **Version** and tap it about ten times until "Developer settings" unlocks.
3. Open the ⋮ menu → **Developer settings** → enable **Unknown sources**.
4. Connect to the car. StreetSweep appears in the head unit's app launcher under navigation.

To test without a car, use Google's **Desktop Head Unit** (Android Studio → SDK Manager →
SDK Tools → "Android Auto Desktop Head Unit emulator"). In the phone's Android Auto
developer settings choose **Start head unit server**, then on the Mac:

```bash
adb forward tcp:5277 tcp:5277 && "$HOME/Library/Android/sdk/extras/google/auto/desktop-head-unit"
```

The debug build accepts any Android Auto host; release builds use Google's host allowlist.

## Permissions the app asks for

Precise location (always), location "Allow all the time" (automatic mode), notifications,
and Nearby devices / Bluetooth (to list paired devices and match the car). Google Play
requires a declaration for background location use.

## Notes

- Build output goes to `~/Library/Caches/StreetSweep-build` instead of `build/` because
  this folder is iCloud-synced and iCloud's "name 2.ext" conflict copies break
  incremental builds.
- The package name and `applicationId` are `com.example.streetsweep`; change them before
  publishing.
- Room schema is exported to `app/schemas/` for future migrations. While the app is
  pre-release, schema changes wipe local data instead of migrating.
