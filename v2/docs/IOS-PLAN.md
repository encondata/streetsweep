# StreetSweep for iPad

A native iPad app, starting with areas and the map, growing toward the full web portal.
It replaces the idea of a Pencil mode on the web Areas page, which was tried on
2026-10-04 and dropped.

## Decisions

- **Target: iPad Pro 13" (M4) with Apple Pencil Pro, landscape only.** The layout is
  designed for a 13" screen held sideways; portrait isn't supported.
- **Native SwiftUI app** for iPadOS, in `v2/ios/`. The Xcode project is generated from
  `project.yml` (XcodeGen), so the project is plain text that can be reviewed.
- **Map: MapLibre Native on OSM**, fed by the server like the website and Android:
  basemaps through `/api/tiles/{osm|sat|ref}`, streets from `/api/tiles/streets`, area
  outlines from the team areas API. The server stays the only client of tile sources.
- **Sign-in** uses the device token, as Android does (`POST /api/auth/device` with
  `platform: "ios"`), stored in the Keychain. Revocable under Fleet → Phones. The server
  address can be changed in the app (your Mac on the LAN while developing, streetsweep.net after).
- **The server is the golden record.** The app shows what the server computes and saves
  through the same API as the web. A drawing in progress is kept on the iPad until it's
  saved, so a crash or a closed app loses nothing.
- **Drawing has two equal tools:** a freehand lasso and precise corners. Both share one
  set of editing tools and one undo history.
- **Apple account:** a free Apple ID (Xcode "Personal Team") installs on your own iPad.
  Installs expire after 7 days; run it from Xcode again to renew. $99/year is only
  needed for TestFlight, the App Store or other people's iPads.

## How the Pencil and fingers split

The map sits underneath a drawing layer. The drawing layer only accepts Apple Pencil
touches; finger touches go straight through to the map. So fingers always pan, pinch and
rotate, the Pencil always draws, and a resting palm does nothing. Outlines are drawn as
map layers, so they stay pinned to the ground while you move the map.

- **Pencil double-tap or squeeze** switches between the last two tools (the iPadOS
  setting for what double-tap does is respected).
- **Pencil hover** (M2 and later iPad Pro) previews where the next corner or stroke
  lands, and whether it will snap.
- **Two-finger tap** undoes; **three-finger tap** redoes.

## Tools

| Tool | What the Pencil does |
|---|---|
| Lasso | Draw round an area in one stroke. On lift it becomes an outline with sensible corners. Where the stroke runs along a neighbouring area or a shoreline, the outline follows that line corner for corner, so neighbours share one boundary. |
| Corners | Tap each corner; tap the first one to close. Each corner snaps to nearby neighbours' corners and lines. |
| Edit | Drag a corner to move it; drag a midpoint to add one; tap a piece to select it. |
| Eraser | Scribble over corners to delete them, or over a whole piece to delete it. |

Also: several pieces per area, Trim to shoreline (the server's existing water trim),
undo/redo, and a name and kind (neighbourhood, section, custom) when saving.

## Stages

Each stage gets its own go-ahead.

**i0. Setup.** The project, MapLibre through Swift Package Manager, sign-in, server
address setting, and a team picker. Runs in the iPad simulator and on your iPad.

**i1. Map and areas.** A full-screen map with Map/Satellite/Hybrid. A sidebar of the
team's areas (the iPad's split view) with the same automatic colours as the web, so no
neighbours share one. Address search through `/api/geocode`. Tap an area to open it.

**i2. Area details.** Progress, size, notes, follow/unfollow, edit name/kind/notes, delete.

**i3. Drawing.** Everything under "Tools" above, plus drafts kept on the iPad.

**i4. Coverage map.** Built so far (2026-10-04): the Map tab with the team's streets in
your colours, finished areas shaded, and **Mark by outline**: draw round streets with the
Pencil, see the ones it would mark flashing (pieces whose middle is inside, not already
driven or marked), then Mark done, with Undo afterwards. Still to come: tapping a street
to mark it.

**i4 (as planned).** Driven and undriven streets in your personal colours, finished-area
shading, and marks, matching the web's Map page.

**Later.** The rest of the portal, one screen at a time: Home, Drives, Places, Teams,
Fleet, Achievements and your page.

## Open questions

- Minimum iPadOS version. Proposed: iPadOS 18, which covers every iPad Pro that supports
  the Pencil hover and squeeze features, plus older ones without them.
- An iPhone layout: not planned. The iPhone keeps using the website.
