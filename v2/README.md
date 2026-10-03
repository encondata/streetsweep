# StreetSweep v2

Ground-up multi-user rebuild. Plan and schema: [docs/PLAN.md](docs/PLAN.md).
Image brief: [docs/ASSETS.md](docs/ASSETS.md).

```
docker compose up -d --build      # http://localhost:8430
docker compose logs -f api worker
```

| Service | What it does |
|---|---|
| `db` | Postgres 16 + PostGIS. Data in `$DATA_DIR/postgres` (default `~/streetsweep-v2-data`). |
| `api` | Fastify + TypeScript. Applies `db/migrations/*.sql` on start. Serves `/api`, `/login` and the web app. |
| `worker` | pg-boss jobs: the monthly street import (Geofabrik extract → osmium → PostGIS), later drive matching. Starts an import itself on first run. |
| `mailpit` | Catches every email the app sends (sign-up and reset codes). Inbox at http://localhost:8025. Set `SMTP_*` in `.env` for real mail. |
| `valhalla` | Optional (`--profile valhalla`). |

Builds happen inside Docker, so this Synology-synced folder never gets `node_modules`.
Web dev with hot reload: `cd web && npm i && npm run dev`. That proxies to the stack on
:8430, but put `node_modules` outside the sync first if you do it.

Migrations: add `db/migrations/NNNN_name.sql`. Each one runs once, in order, inside a
transaction. Never edit one that has already shipped.

API smoke tests (create throwaway accounts, then delete them):

```
./scripts/smoke.sh            # every stage
./scripts/smoke.sh stage2     # one stage
```

The logger protocol (signing, config endpoint, an ESP32 example) is in
[docs/LOGGER-PROTOCOL.md](docs/LOGGER-PROTOCOL.md).

First site admin: set `ADMIN_EMAIL` before first boot, or promote an existing account with
`docker compose exec api node dist/cli.js make-admin you@example.com`.
