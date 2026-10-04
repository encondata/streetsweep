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
