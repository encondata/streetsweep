# StreetSweep logger protocol

How a home-built GPS logger (ESP32 + GPS module) talks to the StreetSweep server.
Status: **v1 draft**. `GET /api/logger/config` works now. Drive uploads arrive in
stage 4, together with the batch format.

## Getting a logger its key

1. On the web, go to **Fleet → Loggers → Register a logger**.
2. The server shows the logger's **ID** (a UUID) and its **secret** (64 hex characters,
   meaning 32 bytes) **once**. Flash both onto the board, along with the server address.
3. If the secret is lost or leaked, use **New key** on the logger's page. The old key
   stops working immediately.
4. **Retire** stops the logger for good. Its past drives keep pointing at it.

Install the logger in a vehicle on the web. Its drives are then credited to that vehicle,
and to whoever had the vehicle at the time (see PLAN.md, "Drive attribution").

## Signing requests

Every request carries two headers:

| Header | Value |
|---|---|
| `X-Logger-Id` | The logger's UUID |
| `X-Logger-Signature` | `hex(HMAC-SHA256(secret_bytes, canonical))`, in lowercase |

where `canonical` is three lines joined by `\n` (no trailing newline):

```
GET
/api/logger/config
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

1. The HTTP method, in upper case.
2. The path **exactly as sent**, including any query string.
3. `hex(SHA-256(body))`. An empty body gives the value shown above.

`secret_bytes` is the 32 raw bytes decoded from the hex secret, **not** the hex text.

There's no timestamp in the signature on purpose. Loggers may not know the time yet, and a
batch relayed by a phone over BLE may be signed hours before it reaches the server. Uploads
will be idempotent on `(logger, batch sequence number)`, so replaying a request
changes nothing.

### Optional status headers (not signed)

| Header | Example | Meaning |
|---|---|---|
| `X-Logger-Firmware` | `0.1.0` | Your firmware version |
| `X-Logger-Battery` | `3980` | Battery voltage in millivolts |
| `X-Logger-Hardware` | `24:6F:28:AA:BB:CC` | A hardware ID, e.g. the Wi-Fi MAC |

They're shown on the logger's page and are informational only.

## `GET /api/logger/config`

Call it on boot after joining Wi-Fi, then every `check_in_seconds`. It returns:

```json
{
  "logger_id": "…",
  "name": "Board A",
  "server_time": "2026-10-03T19:40:00.000Z",
  "server_epoch": 1791056400,
  "default_drive_type": "delivery",
  "vehicle": { "id": "…", "name": "Van 1" },
  "check_in_seconds": 3600,
  "upload": null
}
```

- `server_epoch` sets the clock when there's no GPS fix or NTP yet.
- `vehicle` is `null` when the logger isn't installed anywhere. Keep logging anyway: the
  drive can be credited later on the web.
- `upload` stays `null` until stage 4. Until then, keep points on flash or SD.

`401` means a bad ID or signature, or a retired logger. Stop retrying after a few
attempts, and blink something.

## Checking a signature by hand

```bash
ID=...; SECRET=...; SERVER=http://localhost:8430
SIG=$(printf 'GET\n/api/logger/config\n%s' "$(printf '' | shasum -a 256 | cut -d' ' -f1)" \
  | openssl dgst -sha256 -mac HMAC -macopt hexkey:$SECRET | awk '{print $NF}')
curl -s "$SERVER/api/logger/config" -H "X-Logger-Id: $ID" -H "X-Logger-Signature: $SIG"
```

## ESP32 (Arduino) sketch of the signing

```cpp
#include <mbedtls/md.h>
#include <HTTPClient.h>

const char* LOGGER_ID = "…";
const char* SECRET_HEX = "…";          // 64 hex chars from the web
const char* SERVER = "https://streetsweep.example.com";

static void hexToBytes(const char* hex, uint8_t* out, size_t n) {
  for (size_t i = 0; i < n; i++) sscanf(hex + 2 * i, "%2hhx", &out[i]);
}

static String toHex(const uint8_t* b, size_t n) {
  static const char* d = "0123456789abcdef";
  String s; s.reserve(n * 2);
  for (size_t i = 0; i < n; i++) { s += d[b[i] >> 4]; s += d[b[i] & 15]; }
  return s;
}

String sign(const String& method, const String& path, const uint8_t* body, size_t len) {
  uint8_t bodyHash[32];
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), body, len, bodyHash);
  String canonical = method + "\n" + path + "\n" + toHex(bodyHash, 32);

  uint8_t key[32], mac[32];
  hexToBytes(SECRET_HEX, key, 32);
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, 32,
                  (const uint8_t*)canonical.c_str(), canonical.length(), mac);
  return toHex(mac, 32);
}

bool fetchConfig() {
  HTTPClient http;
  http.begin(String(SERVER) + "/api/logger/config");
  http.addHeader("X-Logger-Id", LOGGER_ID);
  http.addHeader("X-Logger-Signature", sign("GET", "/api/logger/config", nullptr, 0));
  http.addHeader("X-Logger-Firmware", "0.1.0");
  http.addHeader("X-Logger-Hardware", WiFi.macAddress());
  int code = http.GET();
  // 200: parse JSON (ArduinoJson), set clock from server_epoch, note vehicle.
  http.end();
  return code == 200;
}
```

## BLE relay (later)

The phone app will receive signed requests from the logger over BLE and forward them
**unchanged**, with the same method, path, body and both headers. It adds its own
`Authorization: Bearer` so the server knows which phone carried them. The phone never
holds the logger's secret.
