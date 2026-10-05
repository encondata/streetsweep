# Future plans

Ideas that are not scheduled yet. Each entry is self-contained so it can be picked up later.

---

## Road-class filters and achievements

**Idea:** Use each street segment's OSM `highway` tag (road class) to filter coverage and to award achievements.

### Background: road classes
OSM `highway=*`, roughly from major to minor:
`motorway` → `trunk` → `primary` → `secondary` → `tertiary` → `unclassified` → `residential` → `service`
(plus `_link` variants for ramps).

These line up roughly with the FHWA functional classes (Interstate / Freeway / Principal Arterial / Minor Arterial / Collector / Local). A class reflects how continuous a road is and what it connects, not how many lanes it has. Preston Rd (SH 289) is a principal arterial (likely OSM `primary`). Spring Creek Pkwy is likely a minor arterial (OSM `secondary`). TxDOT publishes the official functional classification as a GIS layer if we ever need something more authoritative than OSM.

### Features
- **Per-class coverage:** "Secondary: 42 of 61 mi driven (69%)" for an area. Highlight undriven segments of one class on the map.
- **Navigate a class:** "drive all secondary roads in this area".
  - Simple version: guide the driver to the nearest undriven segment of that class, repeat.
  - Optimal version: plan an efficient loop over every segment (the rural postman problem). Valhalla routes between points but does not choose the visiting order.
- **Achievements:** "Every primary road in Frisco", "All trunks in Collin County", tiers at 25/50/75/100%, team versions built on shared team coverage.
- **Variant:** group by road name instead of class ("Drove all of Preston Rd").

### Prerequisites
- v2 segments must keep the OSM `highway` tag (and `name` for the by-road variant).

### Open questions and gotchas
- **Divided roads** are two OSM ways, one per direction. Does "driven" need both sides? If yes, 100% means driving those roads twice.
- **Ramps** (`*_link`): probably leave them out of class totals.
- **Tagging is inconsistent** between local mappers (`secondary` vs `tertiary`). Fine for fun badges, not for official reporting.
- **Empty classes:** hide badges for classes an area doesn't have (no "0 of 0").
- **OSM edits** can change the set of segments under a badge. Decide whether a badge stays earned once awarded or recalculates.
- **Golden record:** compute these figures on the server, not on the phone.

---

## Statewide highway achievements

**Idea:** Achievements for driving a whole numbered highway across the state, with no area setup. For example, "All ~880 miles of I-10 in Texas".

### Data source: OSM route relations
OSM groups every way belonging to a numbered highway into a route relation (`type=route`, `route=road`):
- Interstates: `network=US:I`, `ref=10`
- US highways: `network=US:US`, `ref=75`
- Texas state highways: `network=US:TX`, `ref=289` (would allow Preston Rd / SH 289 too)

Relations are usually split by state, and often by direction. So "I-10 in Texas" is one query, and the relation's ways define the full set of segments needed for 100%.

### Starter list (Texas)
- Interstates: 10, 20, 27, 30, 35 (incl. 35E/35W), 37, 44, 45, 69 (+69E/69C/69W), 410, 610, 635, 820, …
- US highways: 59, 75, 287, 290, 281, 83, …

### Design notes
- This is a separate layer from areas. Each route is a fixed, curated "challenge" that every user's drives are matched against.
- Fetch the route geometry once, then cache it on the server. Don't load whole-state street data into the normal segment tables.
- Show progress as miles: "I-45: 212 of 285 mi". It's more motivating than a percentage.
- Possible later expansion: whole-country versions (I-10 coast to coast, ~2,460 mi).

### Open questions and gotchas
- **Directions:** count one direction or require both? Separate badges ("I-10 Eastbound", "I-10 complete")?
- **Shared stretches:** where two routes run on the same road (e.g. I-10/I-35 in San Antonio), the same miles should count toward both.
- **Dual numbering and renumbering:** US 59 is being converted to I-69, and OSM may tag `ref=I 69;US 59`. Changes over time can shift which segments belong to a route.
- **Construction and closures:** exact 100% can be impossible for a while. Allow a tolerance (e.g. 98%, or ignore gaps under X ft).
- **Matching at highway speed:** frontage roads run right next to the mainlanes. GPS matching must not credit the interstate for driving the frontage road, or the reverse.
- **Business routes and spurs** (Business 20, loops): leave them out of the main badge, or give them their own.

---

## Neighborhood search with outlines

**Idea:** Search for a neighborhood by name (like Google Maps) and get its outline, then use that outline as an area.

### What OSM has
- **Point only (most common):** `place=neighbourhood` / `place=suburb` is usually a single named point with no outline.
- **Boundary (sometimes):** `boundary=administrative` + `admin_level=10`, or `place=neighbourhood` drawn as an area. More common in Dallas proper, rare in Plano and Frisco.
- **Subdivision shape (hit or miss):** some subdivisions are drawn as `landuse=residential` areas with a `name`.
- Nominatim returns the outline when one exists (`polygon_geojson=1`). When it doesn't, you only get the point.

Google's outlines come from licensed and in-house data, so OSM alone won't match Google's coverage.

### Other open sources
- **County appraisal district (CAD) parcel data:** Collin, Denton and Dallas CAD list each parcel's subdivision name. Merging all parcels with the same subdivision name gives a real neighborhood outline. Probably the best free option for DFW suburbs. Check each county's terms of use.
- **City open-data portals:** Dallas and some other cities publish neighborhood or neighborhood-association boundaries.
- **Who's On First:** open gazetteer (originally from Mapzen) with neighborhood polygons for many US cities. Coverage is uneven and some polygons are approximate.

### Proposed approach (fall through in order)
1. Use the OSM polygon if one exists.
2. Otherwise use a subdivision shape built from county parcel data, prepared ahead of time and stored on the server.
3. Otherwise drop a pin at the OSM point and let the user draw or adjust the area with the existing area tools.

### Open questions
- Combining parcels: small gaps (streets, common areas) between parcels need to be filled so the outline is one clean shape.
- Subdivisions are often split into phases ("Phase 1", "Phase 2"). Group them into one neighborhood, or offer each phase separately?
- How often to refresh the CAD data (yearly is probably enough).
- Search ranking when OSM and CAD both return a match with similar names.

---

## Logger extras

**Idea:** Things the logger could do beyond the first build (`docs/LOGGER-HARDWARE.md`).

- **Drive-type button.** Switch Personal ↔ Delivery on the device, with the type shown on
  the e-ink. Needs a protocol addition: a `drive_type` per batch or a marker event in the
  points stream, which `logger-assemble` would honour when it cuts drives.
- **Place pin.** A long press drops a place ("missed street", pothole) at the current fix.
  It would map onto `places`.
- **OTA firmware updates.** `GET /api/logger/config` advertises a firmware version and a
  signed image URL. The logger updates while parked on Wi-Fi.
- **Always-on BLE relay.** Keep BLE advertising while driving so the phone can carry
  batches when there's no Wi-Fi.

## Tidy outline and Snap on the web

The iPad app already has both (2026-10-04). The server side is built and shared, so
the website only needs the buttons. Add them to the drawing panel on the Areas page
(`web/src/components/AreaPanel.svelte`, drawing in `web/src/lib/draw.svelte.ts`).

**Tidy round the streets.** It takes a rough outline and returns a clean one.
- Call `POST /api/areas/tidy` with `{ geometry }` (GeoJSON Polygon or MultiPolygon). It
  answers `{ geometry (MultiPolygon), pieces }`, or a 400 with a message to show as is.
- What the server does: it takes the street pieces whose middle is inside the outline.
  It wraps the ground they span (a concave hull, plus a 10 m band round every street) and
  limits each edge to 10 m beyond the outer streets, or halfway to the nearest street
  outside where that's closer. The halfway line is a Voronoi split, so two neighbourhoods
  tidied side by side meet on one line. Every inside street stays fully inside. Limits:
  50 km² and 5,000 pieces.
- Web: a "Tidy round the streets" button beside "Trim to shoreline". Put the result in
  with `OutlineDraw.replaceAll(ringsOf(geometry))`, so it's one undoable change. Then nudge
  corners within a few pixels of a neighbouring area onto it; `OutlineDraw.snap` already
  does that per point.

**Snap.** A toggle in the drawing panel, remembered per browser.
- Snap targets:
  - Boundary lines: `GET /api/areas/lines?bbox=w,s,e,n` (state, county and city outlines
    clipped to the box; empty past 0.4°).
  - Streets: `GET /api/segments?bbox=…` (gzip, packed: the last item of each row is a
    polyline6). Load them only when zoomed in (0.2° at most each way). Only a street's
    two ends count as corners to snap onto, since those are the intersections.
- With Snap on:
  - Clicked corners snap to intersections, streets and boundary lines, as well as to
    neighbours and shores as now.
  - Show the boundary lines dashed while drawing.
- The iPad also straightens a freehand lasso before snapping its corners (see
  `ios/StreetSweep/Drawing/Geometry.swift`, `snappedLasso`). The web draws by clicking
  corners, so it doesn't need that step.
