# StreetSweep web, v2

The new web app, served by the same server at `/v2` while it takes over from the classic
page (`tools/area-builder.html`, at `/`). Svelte 5 + TypeScript, built with Vite; the map
is MapLibre GL, and outlines are drawn and edited with terra-draw.

It talks only to the server's API (`/api/...`) and its tile cache (`/tiles/...`), with
the same sign-in cookie as the classic page. Screens not rebuilt yet open the classic one.

## Working on it

```bash
npm install          # once; on the iCloud Desktop, keep node_modules as node_modules.nosync + symlink
npm run dev          # http://localhost:5173/v2/ — proxies /api, /tiles and /login to a running server
npm run check        # types
npm run build        # dist/, which the server image copies to public/v2
```

`STREETSWEEP_SERVER` points the dev proxy at a server other than `http://127.0.0.1:8420`.
Sign in through the dev address (`http://localhost:5173/login`) so the cookie is set for it.

The Docker image builds this itself (see `tools/Dockerfile`), so a server install needs
nothing extra.

## Layout

- `src/App.svelte` — the shell: navigation rail, account menu, routing by address.
- `src/routes/Workspace.svelte` — the map, with a panel whose contents follow the address:
  - `/map` the area list,
  - `/map/area/:id` one area's figures and street tools,
  - `/map/area/:id/edit` its details,
  - `/map/area/:id/outline` its outline,
  - `/map/new` a new area.
- `src/lib/` — the API client, shared store, map controller, outline drawing, router.
