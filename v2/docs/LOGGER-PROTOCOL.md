# StreetSweep logger protocol

How a StreetSweep GPS logger (ESP32 + GPS + e-ink, see `docs/LOGGER-HARDWARE.md`) gets set
up through the app and talks to the server.

Status: **v2 draft (2026-10-04).** This replaces the v1 draft, which used a shared HMAC
secret copied from the web. The server still runs v1 today. "Server changes" at the end
lists what moves. No firmware exists yet, so nothing needs migrating.

## Identity

On its very first boot the logger makes two things and keeps them in NVS:

| What | Lifetime |
|---|---|
| **Device ID**: a random UUIDv4 | Permanent. Survives deregistering and factory reset. It names the physical unit. |
| **Key pair**: ECDSA P-256 | Replaced on every deregister or factory reset. The private key never leaves the device. |

The server keeps only the **public key**. Nothing secret is stored on the server or the phone.

The **fingerprint** of a key is the first 16 hex characters of
`SHA-256(raw public key)`, where the raw key is the 65-byte uncompressed point (`04‖X‖Y`).

## States

```
 first boot ──► PAIRING ──claim + Wi-Fi──► ACTIVE ──deregister / 410──► (wipe) ──► PAIRING
                   ▲                         │
                   └──── short press ────────┘   (maintenance: stays claimed, no wipe)
```

- **Pairing**: BLE advertises, and the e-ink shows the QR code and pairing code.
- **Active**: logs, uploads over Wi-Fi, checks in. BLE is off.
- **Maintenance**: a short button press while active. It's the same BLE session as pairing,
  but the logger keeps its claim. Use it to change Wi-Fi or force a settings refresh.
  It times out after 5 minutes.
- **Factory reset**: hold the button for 10 s. It wipes the key, Wi-Fi and stored fixes,
  keeps the device ID, and goes to pairing. The old claim on the server still blocks a
  new one until it's released (see "Claiming").

## Pairing over BLE

This uses ESP-IDF's **`wifi_provisioning` manager over BLE with security scheme 2**
(SRP6a + AES-GCM). The app uses Espressif's `esp-idf-provisioning-android` library.

- **BLE name**: `SS-` + the first 8 hex characters of the device ID, e.g. `SS-3f9a1c07`.
- **SRP username**: `streetsweep`. **SRP password**: the pairing code.
- **Pairing code**: 8 characters from Crockford base32 (no I, L, O or U), made fresh for
  every pairing session. The salt and verifier are generated on the device at the same time.
  SRP stops anyone listening to the BLE link from guessing the code offline.
- **QR code** on the e-ink, also usable by the phone camera to open the app:

  ```
  streetsweep://logger?d=<device id>&c=<pairing code>&k=<key fingerprint>
  ```

  The pairing code is also printed as text under the QR code, for typing in by hand.

### Custom endpoints

These run inside the same encrypted session, beside the library's own `prov-scan` and
`prov-config` (Wi-Fi). The payloads are UTF-8 JSON.

| Endpoint | Direction | Body |
|---|---|---|
| `ss-info` | app → device: `{}` · device → app | `{"device_id", "public_key": "<base64 raw 65 bytes>", "firmware", "hardware": "<Wi-Fi MAC>", "state": "pairing"\|"maintenance", "pending_batches"}` |
| `ss-setup` | app → device | `{"server": "https://streetsweep.net", "name": "Van 1 logger"}` → `{"ok": true}` |
| `ss-ctrl` | app → device | `{"cmd": "refresh"\|"upload"\|"wipe"}` → `{"ok": true}` |

**The app must check that the fingerprint of `ss-info.public_key` matches `k` from the QR
code before it goes any further.** That makes sure the phone is talking to the board in
front of it.

Wi-Fi uses the library's normal scan-and-configure flow. The logger stores up to 5
networks. Adding another one in maintenance mode appends to the list. **Wi-Fi passwords
go to the device only, never to the server.**

## Setup walkthrough (app)

1. **Scan** the QR code and connect over BLE. Call `ss-info` and check the fingerprint.
2. **Wi-Fi**: pick from the networks the device scanned and enter the password. You can add
   more than one.
3. **Name** the logger.
4. **Binding**:
   - **Vehicle**: the logger stays in one car. Pick a vehicle the user may drive, or create
     one. When creating one, ask **"Who uses this car?"**:
     - *Just me*: the car goes under the user's personal team, with them as its permanent
       driver. That's a private car.
     - *Shared with [team]*: the car goes under that team, and its drives go to whoever has
       it checked out. That's a shared car.

     For an existing vehicle, show which of the two it already is. There's no separate
     private/shared flag. It's always the team that manages the car.
   - **Me**: the logger follows the user from car to car.
5. **Settings**: logging interval, auto upload, default drive type. Each one starts with a
   default value.
6. **Claim**: `POST /api/loggers/claim`, as the signed-in user (see below).
7. **Hand over**: `ss-setup` with the server address and name, then the Wi-Fi settings.
   The logger leaves pairing mode, joins Wi-Fi and calls `GET /api/logger/config`.
8. **Confirm**: the app polls `GET /api/loggers/:id` until `last_seen_at` is set and shows
   "Connected ✓". If 60 s pass with nothing, it shows the Wi-Fi as the likely problem and
   offers to go back to step 2.

## Claiming

`POST /api/loggers/claim` (session or phone token)

```json
{
  "device_id": "3f9a1c07-…",
  "public_key": "BHk3…",
  "name": "Van 1 logger",
  "binding": "vehicle",
  "vehicle_id": "…",
  "settings": { "interval_seconds": 1, "auto_upload": true, "default_drive_type": "delivery" }
}
```

`binding` is `"vehicle"` (with `vehicle_id`) or `"user"` (it binds to the caller).

| Reply | Meaning |
|---|---|
| `201` | Claimed. Returns the logger, including its `id`. |
| `409` | **This device is already claimed** by someone. The owner has to release it first, from the app or the web (**Deregister**), or a site admin can force a release. The message names no one. |
| `403` | The vehicle isn't one the caller may drive. |
| `400` | The public key isn't a valid P-256 point. |

A claim is blocked while any active claim exists for the device ID, **even when the
public key is new** (for example after a factory reset). That stops a used or found
logger from being taken over quietly.

## Signing requests

Every request from the logger carries:

| Header | Value |
|---|---|
| `X-Logger-Id` | The device ID |
| `X-Logger-Signature` | ECDSA P-256 / SHA-256 signature over `canonical`, as raw `r‖s` (64 bytes) in lowercase hex (128 characters). **Not DER.** |

`canonical` is the same three lines as before, joined by `\n` with no trailing newline:

```
POST
/api/logger/batches
<hex SHA-256 of the body>
```

The server verifies with Node `crypto.verify("sha256", canonical, key, sig)`, using
`dsaEncoding: "ieee-p1363"`. mbedtls produces DER by default, so the firmware converts it
to `r‖s`, or uses `mbedtls_ecdsa_sign` and writes out `r` and `s` itself.

There's still no timestamp in the signature on purpose. A logger may not know the time
yet, and a batch relayed over BLE may be signed hours before it arrives. Batches are
idempotent on `(logger, seq)`, so a replay changes nothing.

### Optional status headers (not signed)

| Header | Example | Meaning |
|---|---|---|
| `X-Logger-Firmware` | `0.1.0` | Firmware version |
| `X-Logger-Battery` | `3980` | LiPo voltage in millivolts |
| `X-Logger-Hardware` | `24:6F:28:AA:BB:CC` | Wi-Fi MAC |
| `X-Logger-Via` | `ble` | Set by a relaying phone |

## `GET /api/logger/config`

The logger calls it after joining Wi-Fi, then every `check_in_seconds`, and when it gets
`ss-ctrl refresh`.

```json
{
  "logger_id": "…",
  "name": "Van 1 logger",
  "server_time": "2026-10-04T19:40:00.000Z",
  "server_epoch": 1791142800,
  "binding": "vehicle",
  "vehicle": { "id": "…", "name": "Van 1" },
  "user": null,
  "settings": {
    "version": 3,
    "interval_seconds": 1,
    "auto_upload": true,
    "check_in_seconds": 3600,
    "default_drive_type": "delivery"
  }
}
```

- **Settings live on the server**, which is the golden record. The app edits them with
  `PATCH /api/loggers/:id`. The logger applies them when `settings.version` changes. In
  maintenance mode the app can send `ss-ctrl refresh` so they apply right away. Anyone
  who manages the logger can change settings from their own phone without BLE.
- `interval_seconds` is how often a fix is recorded (1–30). The server does all
  filtering, so even a short interval isn't wasted.
- `auto_upload: false` keeps batches on flash until the app asks (`ss-ctrl upload`) or
  the setting changes.
- For a vehicle binding, `vehicle` is the car and `user` is `null`. For a user binding,
  `user` is `{id, name}` and `vehicle` is `null`.

## `POST /api/logger/batches`

The format is unchanged from stage 4:

```json
{"seq": 17, "points": [[epoch_s, lat, lon, accuracy_m, speed_ms], ...]}
```

- `seq` counts up per **claim**. It restarts at 0 after a deregister or factory reset,
  because the new claim is a new logger on the server.
- Up to 20,000 points per batch. `201` means accepted, `200` with `duplicate: true` means
  it had already arrived. **Delete a batch from flash only after a 201 or 200.**
- The logger doesn't cut drives. The server's `logger-assemble` job does that from the
  stream of points.

## Status codes the logger must handle

| Code | Logger does |
|---|---|
| `2xx` | Carry on. |
| `401` | Bad signature, or an unknown ID. It might be transient (a server restore, a clock problem on the server). Back off up to 1 h, keep logging, and show "Auth error" on the e-ink after 3 failures in a row. |
| `410 Gone` | **Deregistered.** Stop uploading, wipe the key, Wi-Fi and stored fixes, keep the device ID, and go to pairing. |
| `5xx` / no network | Back off and retry. Keep everything. |

## Drive attribution

A history table of bindings (`logger_bindings`) records what the logger was bound to at each
moment. A drive is resolved from **the binding at the time of the drive** (see PLAN.md,
"Late data is normal").

- **Vehicle binding**: the vehicle is that car. The driver is whoever had it checked out
  then, otherwise its only permanent assignee, otherwise "unknown driver".
- **User binding**: the driver is that user. The vehicle follows the **phone rule**: their
  open checkout at that time, otherwise their only permanent car, otherwise no vehicle.

Either way, the drive type is the logger's `default_drive_type` at that time. You can fix
it on the web.

## Deregistering

From the app or the web, by the logger's owner or a site admin:

1. **If the phone is connected over BLE** (the app puts the logger in maintenance mode
   first): the app sends `ss-ctrl upload` and waits for `pending_batches` to reach 0, or
   for the user to skip. Then it calls the server, and then sends `ss-ctrl wipe`.
2. **Otherwise**: the app warns that fixes not yet uploaded will be lost, then calls the
   server. The logger gets `410` at its next request and wipes itself.

`DELETE /api/loggers/:id` closes the logger's open binding, sets `deregistered_at` and
drops the public key. Past drives keep pointing at that logger row. The device ID can
then be claimed again, and the new claim gets a **new** logger row.

## BLE relay (later)

The phone takes signed batches from the logger over BLE and forwards them **unchanged**,
with the same method, path, body and headers. It adds `X-Logger-Via: ble` and its own
`Authorization: Bearer`. Because the logger signs with its private key, the phone can
carry batches but can't forge them.

## Server changes from v1

| v1 (today) | v2 |
|---|---|
| Register on the web, which shows a secret once | Claimed from the app with the device's public key. The web's **Register** button goes away. |
| `loggers.secret`, HMAC-SHA256 | `loggers.public_key`, ECDSA P-256 (`ieee-p1363`) |
| `loggers.id` is the ID the logger sends | `loggers.device_id` is the ID the logger sends. `loggers.id` stays per claim. A partial unique index on `device_id WHERE deregistered_at IS NULL` enforces the block. |
| `logger_installs (logger_id, vehicle_id, during)` | `logger_bindings (logger_id, vehicle_id NULL, user_id NULL, during)`. Exactly one of the two is set, with the same EXCLUDE per logger. |
| `revoked_at`, 401 | `deregistered_at`, **410** |
| Config without settings | `binding`, `user` and a versioned `settings` block |
| none | `POST /api/loggers/claim`, `PATCH /api/loggers/:id`, `DELETE /api/loggers/:id`, admin force-release |
