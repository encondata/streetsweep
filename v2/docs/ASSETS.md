# StreetSweep v2 — image brief for ChatGPT

All graphics are generated with ChatGPT. Each slot below has a file name, a size and a
prompt. Drop the results in `v2/design/incoming/`. They get trimmed, resized and converted
to WebP and PNG, then land in `public/`. Until a slot is filled, the app shows a plain
placeholder.

## House style (paste this before every prompt)

> Clean modern flat vector illustration with soft gradients and subtle depth, for a
> map-and-driving app called StreetSweep. Palette: deep navy #02142a, mid navy #0b2340,
> bright green #45bd23, green #1e8a28, white. Rounded shapes, no text, no letters, no
> logos, no watermarks. Transparent background. Centered subject with even padding.

Ask for **PNG with transparent background** at the size given (or larger, square unless
noted).

## Carried over from v1 (no action needed)

`login-art.webp` (sign-in photo), `login-mark.png`, `login-lockup*.png`, `wordmark*.png`,
favicons and app icons, `use_track/progress/complete.png` (sign-in page bullets), and the
40-odd achievement badges (`ach-*.webp`), which come back in stage 5.

## Stage 1 — people and teams

| File | Size | Prompt (after the house style) |
|---|---|---|
| `avatar-default.png` | 512² | A friendly generic person silhouette in a circle, navy with a green ring. |
| `team-default.png` | 512² | Three overlapping simple person silhouettes in a rounded square, the front one green. |
| `empty-teams.png` | 800×600 | Two small cars meeting at a map pin on a stylized street grid, a welcoming "join up" feel. |
| `empty-requests.png` | 800×600 | An empty inbox tray beside a green check mark, calm and tidy. |
| `signup-art.webp` | 1600×1200 | *Optional:* a companion to the sign-in photo for the create-account screen. Aerial dusk view of a suburban street grid with glowing green driven streets. Photographic, not vector. |

## Stage 2 — fleet and loggers

| File | Size | Prompt |
|---|---|---|
| `vehicle-car.png` | 512² | Side view of a generic compact car, no brand, navy body, green accent stripe. |
| `vehicle-suv.png` | 512² | Same style: a generic SUV. |
| `vehicle-van.png` | 512² | Same style: a generic delivery van, with a blank panel where a logo would go. |
| `vehicle-truck.png` | 512² | Same style: a generic pickup truck. |
| `vehicle-motorcycle.png` | 512² | Same style: a generic motorcycle. |
| `logger.png` | 512² | A small DIY GPS tracker: a dark green circuit board with a GPS antenna square and a tiny Wi-Fi symbol, in a translucent rounded case. |
| `empty-vehicles.png` | 800×600 | An empty parking space with a green outline and a key tag hanging on a hook. |
| `empty-loggers.png` | 800×600 | The logger device on a workbench with a soldering iron and a little satellite overhead. |
| `checkout-key.png` | 256² | A car key with a green tag, for the "checked out" badge. |

## Drive types (the app asks for one when each drive starts)

All 256², icon-like, simple enough to read at 24 px:

| File | Prompt |
|---|---|
| `drive-personal.png` | A house roof shape with a small car in front of it. |
| `drive-commute.png` | A briefcase on top of a small car. |
| `drive-delivery.png` | A cardboard parcel with a green arrow. |
| `drive-work.png` | A hard hat or toolbox beside a road. |
| `drive-exploring.png` | A compass rose over a winding road. |

(The list itself is a draft. Site admins will be able to edit it.)

## Stage 3–5 — map and insights (later)

| File | Size | Prompt |
|---|---|---|
| `empty-areas.png` | 800×600 | A blank map with a dashed green outline being drawn by a pencil. |
| `empty-drives.png` | 800×600 | An open road toward the horizon with a green dotted route line. |
| `empty-places.png` | 800×600 | A map pin with a small camera beside it. |
| `marker-place.png` | 128² | A map pin, navy with a green center dot. |
| `marker-car.png` | 128² | A top-down car arrow for live position, green with a white outline. |
