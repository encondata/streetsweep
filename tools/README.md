# StreetSweep Area Builder

Draw coverage areas with a mouse instead of a fingertip, keep them in Postgres, and hand them
to the phone as GeoJSON under **Settings → Import areas from GeoJSON**.

## Install it

On the machine that will host it:

```bash
curl -fsSL https://raw.githubusercontent.com/encondata/streetsweep/main/install.sh | bash
```

That clones the repository to `/mnt/user/streetsweep` on Unraid (`~/streetsweep` elsewhere;
set `STREETSWEEP_DIR` to choose), generates an access token, pulls the images and starts
everything. Run it again any time to update: it pulls the latest code and leaves your token and
database alone.

Everything the server keeps is in plain folders under `data/` beside the code — `postgres`,
`photos`, `tiles`, `osm` and `valhalla` — or wherever `DATA_DIR` in `tools/.env` points. An
install from before, running from another directory (such as `/opt/streetsweep`) or keeping its
data in Docker volumes, is moved on the next run by `tools/relocate.sh`: settings copied, data
copied out of the volumes, old containers stopped. The old directory and volumes are left for you
to remove once the new install checks out.

To work from a checkout instead, copy `.env.example` to `.env`, put a token in it, then
`docker compose up -d --build`.

Three containers: `web` is a small Node server serving the page and the API, `db` is Postgres,
and `valhalla` matches drives to streets. The schema is created on startup, so there is nothing to run
by hand. Stop it with `docker compose down`; add `-v` to throw the database away as well.

## Getting to it

The app speaks plain HTTP on port 8420 and expects a reverse proxy in front of it to handle
TLS and the public hostname.

| Where | Address |
|---|---|
| Behind the proxy | <https://streetsweep.hackspacelabs.com> |
| Straight at the container | `http://<host>:8420` |

Point your proxy at `http://<host>:8420`. If it runs on this same machine, set
`BIND_ADDRESS=127.0.0.1` in `.env` so nothing else can reach the port; leave it at `0.0.0.0`
when the proxy is elsewhere. `HOST_PORT` moves the port if 8420 is taken.

## The token

Every `/api` call needs the token from `.env`, sent as `Authorization: Bearer <token>`. Without
it the server answers 401 and nothing is readable. This matters more than it looks: the
coverage data is a record of where you drive, which is to say where you live and work.

The web page asks for the token once and remembers it in that browser. The phone takes it under
*Settings → Area builder server*. `GET /api/config` is the one endpoint that answers without a
token, and it only says whether one is needed.

You can also open `area-builder.html` straight from disk with nothing running. It then says
**Offline** and keeps areas in that browser only, so export before clearing its data.

## Two tabs

**Draw** is the area editor described below. **Coverage** shows what the phone has sent back:
every street segment it has driven, each area's completion, and the drive log. The phone pushes
this from *Settings → Area builder server*, either on demand or after every drive.

All figures are in US units: feet and miles, acres and square miles.

## What it does

- **Search** for a place to jump the map there.
- **New area**, then click to drop corners. Drag a corner to move it, click the small dot
  between two corners to add one, right-click a corner to remove it. Finish closes the shape.
- **Name it**, set neighbourhood, city or metro, and optionally say which area it sits inside.
  Nesting is matched by name, including when the phone imports it.
- It shows the size in km² and how many 0.1° map cells the phone would have to download,
  warning past 120 and refusing past 400, which is the app's own limit.
- **Export GeoJSON** writes a file; `GET /api/areas.geojson` gives the same thing straight
  from the server, which is handy for pulling it onto the phone over the network.
- **Import** reads that back, and also accepts the app's own coverage export, drawing the
  streets you have already driven underneath so you can see where an area should stop.

## API

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/areas` | All areas, largest place first |
| `POST` | `/api/areas` | Create one |
| `PUT` | `/api/areas/{id}` | Replace one |
| `DELETE` | `/api/areas/{id}` | Remove one |
| `GET` | `/api/areas.geojson` | Everything as a GeoJSON download |
| `POST` | `/api/areas/import` | Store every polygon in a posted GeoJSON document |
| `GET` | `/api/health` | Checks the database answers |
| `POST` | `/api/sync` | What the phone pushes: `areas`, `edges`, `drives`, `pois`, any subset |
| `GET` | `/api/coverage` | Everything the Coverage tab draws and counts |

Bodies use `{ "name", "level", "parentName", "polygon": [[lat, lng], …] }`. Names, levels and
coordinates are validated, and a bad request comes back with a plain sentence saying why.

`/api/sync` replaces areas, drives and marked spots outright, and upserts street segments by
the phone's own key, so pushing the same drive twice changes nothing. Pass `"resetEdges": true`
to clear the segments first, which is what the phone's "Send everything again" does.

Distances travel in metres because that is what both sides store; every figure shown to a
person is converted to feet and miles.

Every endpoint except `/api/config` requires the token.

## The file format

```json
{
  "type": "FeatureCollection",
  "features": [{
    "type": "Feature",
    "properties": { "kind": "area", "name": "April Sound", "level": "NEIGHBORHOOD", "parent": "Conroe" },
    "geometry": { "type": "Polygon", "coordinates": [[[-95.63, 30.37], "…"]] }
  }]
}
```

`level` is `NEIGHBORHOOD`, `CITY` or `METRO`. `parent` is another area's name and is optional.
The app also accepts a plain polygon from any editor, treating it as a neighbourhood.

## Internet

The page pulls Leaflet and its fonts from a CDN and map tiles from OpenStreetMap, so the
machine running the browser needs a connection. Tile use here is ordinary interactive
browsing, which the OpenStreetMap tile policy allows; do not point it at a bulk downloader.
