# StreetSweep logger hardware

A small box that runs on car power and records GPS fixes. You set it up from the
StreetSweep app over BLE, and it uploads over Wi-Fi. How it talks to the app and the
server is in `docs/LOGGER-PROTOCOL.md`.

Status: **design (2026-10-04)**, not built yet.

## Goals

- Plug it into car power, stick it on the dash (or anywhere with a view of the sky), and
  forget it.
- Set it up entirely from the app. There's nothing to flash per unit and no keys to copy.
- **Car power is the drive signal.** A small LiPo carries it through engine-off, so it
  can save its work, upload, and update the screen before it sleeps.
- The e-ink always shows the latest state, even with no power.

## Parts

| Part | Pick | Notes |
|---|---|---|
| MCU | **ESP32-S3**, 8 MB flash or more | It has BLE 5 for setup and the later relay, native USB, and room for LittleFS. Option A: Seeed **XIAO ESP32-S3** (tiny, LiPo charger on board). Option B: an all-in-one ESP32-S3 + 2.13" e-ink board such as the Heltec Vision Master E213, which saves the display wiring (its LoRa radio goes unused). |
| Display | **Waveshare 2.13" e-Paper, black/white, 250×122**, SPI | Get the version that supports partial refresh. Check the version sticker (V3/V4), because the GxEPD2 driver class differs between them. Rated for about **0–50 °C** operating. |
| GPS | **u-blox M10** module (MAX-M10S, or a BN-220-style board with an M10 chip) | Multi-constellation and low power. Powered from **car 5 V**, so it turns off with the car (see "Power and shutdown"). **Choose one with its own backup cell or supercap**, so it still hot-starts. Its UART output must be 3.3 V, because the ESP32's pins aren't 5 V tolerant. |
| Antenna | Ceramic patch, often on the module | Face it toward the sky. Under a metal-coated windshield (some have heat-reflective film), use an external active antenna on a lead. |
| Battery | 1S LiPo, **500–1000 mAh**, with a protection circuit | Only covers shutdown and the upload after parking. Bigger isn't better in a hot car. |
| Power in | 12 V → USB-C car adapter (or a fuse-tap USB module) | Most 12 V sockets switch off with the ignition. See "Always-on sockets". |
| Button | One tactile switch | Short press: maintenance mode. Hold 10 s: factory reset. |
| Resistors | 2× 100 k (car power sense), 2× 1 M (battery sense) | Voltage dividers into the ADC. |
| Case | 3D-printed in **ASA or PETG**, with a vent slot | Not PLA, which softens at 55–60 °C. The GPS side faces up. Mount with VHB tape or a magnet. |

## Bill of materials

One unit, XIAO build (option A). Prices are rough street prices (AliExpress, Amazon,
Seeed) as of 2026-10. Check them before ordering.

### Core electronics

| # | Part | Pick | Qty | ~Price |
|---|---|---|---|---|
| 1 | MCU | **Seeed XIAO ESP32-S3** (8 MB flash / 8 MB PSRAM, with LiPo charger) | 1 | $7.50 |
| 2 | Display | **Waveshare 2.13" e-Paper module, B/W 250×122, V4**. Get the version with the **driver board** (SPI header), not the bare panel. | 1 | $13 |
| 3 | GPS | Small u-blox **M10** module with a ceramic patch and a **backup supercap or battery** (e.g. Matek M10Q, HGLRC M100 Mini, Beitian BE-122 class). 5 V supply, 3.3 V UART. | 1 | $15–25 |
| 4 | Battery | 1S LiPo **500 mAh with a protection circuit**, JST-PH 2.0 lead | 1 | $6 |
| 5 | Button | 6 mm tactile switch | 1 | $0.10 |
| 6 | Resistors | 100 kΩ ×2 (car power sense), 1 MΩ ×2 (battery sense), ¼ W or 0805 | 4 | $0.20 |
| 7 | Capacitor | 100 nF ceramic (battery sense filter) | 1 | $0.05 |
| 8 | Wiring | 28–30 AWG silicone wire, small protoboard, JST-PH socket | – | $3 |

### Power in

| # | Part | Pick | Qty | ~Price |
|---|---|---|---|---|
| 9a | Socket adapter | 12 V → USB-C car charger, a plain 5 V one is fine (no fast-charge needed) | 1 | $8 |
| 9b | *or* hardwired | Fuse-tap + 12→5 V buck with a USB-C lead, on an **ignition-switched** fuse | 1 | $12 |
| 10 | Cable | Short right-angle USB-C cable | 1 | $5 |

### Enclosure and mounting

| # | Part | Pick | Qty | ~Price |
|---|---|---|---|---|
| 11 | Case | 3D-printed in **ASA or PETG, not PLA**. ASA also handles UV. | 1 | ~$1 filament |
| 12 | Fasteners | M2 heat-set inserts and M2×6 screws | 4 | $1 |
| 13 | Mount | 3M VHB pad, or a magnetic dash mount | 1 | $3–5 |

### Optional

| Part | When |
|---|---|
| External active GPS antenna (u.FL/SMA, matched to the module's connector) | Metal-film windshields, or mounting it out of sight |
| LiPo with a 10 k NTC lead | Only matters on a board whose charger reads one. The XIAO's doesn't. |

### Totals

- **XIAO build: about $55–70** per unit, with a 12 V socket adapter.
- **All-in-one (option B):** a Heltec Vision Master E213 (about $25–30) replaces items 1
  and 2 and the display wiring. That's **about $50–65**.
- In bulk (5+ units, AliExpress), it drops to roughly $35–45.

## Wiring (option A: XIAO ESP32-S3)

The pin choice is a suggestion. Any pin works except the wake pin, which must be an RTC
GPIO (0–21 on the S3).

| XIAO pin | GPIO | Goes to |
|---|---|---|
| D8 | 7 | e-ink SCK (CLK) |
| D10 | 9 | e-ink MOSI (DIN) |
| D3 | 4 | e-ink CS |
| D4 | 5 | e-ink DC |
| D5 | 6 | e-ink RST |
| D9 | 8 | e-ink BUSY |
| D7 (RX) | 44 | GPS TX |
| D6 (TX) | 43 | GPS RX |
| D0 | 1 | **Car power sense**: 5 V → 100 k → pin → 100 k → GND. Also the wake pin. |
| D1 | 2 | **Battery sense**: BAT+ → 1 M → pin → 1 M → GND, plus 100 nF to GND |
| D2 | 3 | Button to GND (internal pull-up). Also a wake pin. |
| 3V3 / GND | | e-ink power |
| 5V / GND | | GPS power (car 5 V only, off when parked) |
| BAT+ / BAT− | | LiPo (pads on the back) |

That uses all 11 GPIOs. The GPS needs no power switch, because it runs from the XIAO's
5V pin, which is live only while car power is present.

## Power and shutdown

```
 car on ──5 V──► USB-C ──┬─► charger ──► LiPo
                         │                 │
                         ├─ sense (GPIO1)   └─► 3V3 regulator ──► ESP32-S3, e-ink
                         └─► GPS (5V pin: off when the car is off; supercap keeps its memory)
```

1. **Car power appears** (it wakes the board through GPIO1): boot, start the GPS, draw
   the driving screen, start logging.
2. **Car power drops for longer than 3 s** (that ignores dips during cranking):
   1. Close the current batch and write it to flash.
   2. If `auto_upload` is on and a known Wi-Fi network is in range, upload, for up to
      **5 minutes** while the battery allows.
   3. Check in (`GET /api/logger/config`) while online.
   4. Draw the parked screen and enter deep sleep. Wake on car power or the button.
      The GPS already lost power with the car. Its backup supercap keeps its memory, so
      it hot-starts next drive.
3. **Battery guard**: below 3.5 V, skip the upload and go straight to sleep. Below
   3.3 V, sleep without drawing the screen.
4. If uploads are still waiting, **wake once after 30 minutes** to retry. Garage Wi-Fi
   often appears only after a car is parked inside. After that, wait for the next drive.

### Always-on sockets

Some cars keep the 12 V socket live with the engine off. Then car power never drops. If
the GPS shows less than 50 m of movement for **10 minutes**, treat the car as parked and
run the same steps, but keep watching. Movement starts a new session. A fuse-tap on an
ignition-switched fuse avoids this.

### Heat and cold

A dashboard in summer reaches 70–80 °C, which is past what the LiPo and the e-ink are
rated for.
- Keep it out of direct sun if you can: low on the dash, a vent mount, or under the
  dash with an external GPS antenna.
- LiPos shouldn't charge above 45 °C, and the XIAO's charger has no temperature sensor,
  so firmware can't stop it. The firmware reads the ESP32's internal temperature. When it's
  hot, it skips the post-parking upload and shows "Too hot" on the screen. If the
  car gets that hot often, use a board whose charger takes an NTC thermistor.
- Below 0 °C e-ink refreshes are slow and leave ghosting. Skip partial refreshes and do
  one full refresh when the car warms up.

## Storage

- **LittleFS** on internal flash, about 5 MB of an 8 MB chip.
- Each fix is a **20-byte binary record**: `u32 epoch`, `i32 lat×1e7`, `i32 lon×1e7`,
  `u16 accuracy (dm)`, `u16 speed (cm/s)`, `u8 satellites`, `u8 flags`, `u16 reserved`.
  That's about 72 KB per driving hour at 1 Hz, so 5 MB holds about **70 hours** of driving.
- **One file per batch**: closed at 3,600 fixes, after 10 minutes, or at shutdown, with
  `seq` in the file name. It's converted to the JSON body only while uploading. Two
  passes: first the SHA-256 for the signature, then the streamed body.
- **While stopped** (speed under 0.5 m/s), store one fix every 30 s instead of every
  interval. The server filters anyway. This just saves flash at long lights and
  delivery stops.
- **When flash is full**, drop the oldest batch and show "Storage full" on the screen.
- A batch file is deleted only after the server answers 201 or 200.

## Display (250×122)

Partial refresh when something changes, **no more than once every 30 s** while driving.
A full refresh every 10 partials, and on every change of screen, to clear ghosting.

| Screen | Shows |
|---|---|
| **Pairing** | QR code on the left (`streetsweep://logger?d=…&c=…&k=…`). On the right: "Set up in the StreetSweep app", the pairing code in large text, and `SS-3f9a1c07`. |
| **Maintenance** | Same layout, plus "Maintenance · 4:59" counting down. |
| **Driving** | Recording dot, satellite count and fix quality, miles this session, vehicle (or user) name, drive type. |
| **Parked** | "Parked", last upload time, batches waiting, battery %, the logger's name. It stays on the screen while asleep. |
| **Problem** | "No GPS fix", "Auth error", "Storage full", "Wi-Fi not found". One line, under the parked layout. |

## Firmware stack

- **PlatformIO with `framework = arduino, espidf`.** That gives the full ESP-IDF
  `wifi_provisioning` manager (security 2 isn't exposed by the Arduino `WiFiProv` wrapper)
  plus Arduino libraries:
  - **GxEPD2** + Adafruit GFX for the e-ink, and a small QR code library (`ricmoo/QRCode`).
  - **TinyGPSPlus**, or u-blox UBX binary for speed and accuracy fields straight from the chip.
  - **mbedtls** (in IDF) for P-256 key generation, ECDSA signing and SHA-256.
  - **esp_http_client** with the IDF certificate bundle for HTTPS.
  - **LittleFS** for batches, **NVS** for the device ID, key, Wi-Fi list, server address,
    settings and the next `seq`.
- **GPS setup on boot**: 1 Hz (or `interval_seconds`), automotive dynamic model, GPS +
  Galileo + GLONASS + BeiDou, only the NMEA/UBX messages that are needed.
- **Later hardening**: NVS encryption and flash encryption, so the private key can't be
  read off a stolen board.

## Bench checklist

1. On first boot it shows the pairing screen. The device ID and key survive a reboot.
2. Claim it with the app, then deregister. The device ID stays the same and the key changes.
3. Unplug USB while it's logging. The batch is on flash and the parked screen is drawn.
4. Upload with Wi-Fi off, then turn Wi-Fi on. The batch arrives once. Sending it again
   gets `duplicate: true`.
5. Deregister while it's offline. On its next check-in it gets `410`, wipes and shows
   pairing.
6. Factory reset, then try to claim from a second account. That gets `409` until the
   first account releases it.
