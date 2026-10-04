# Brand assets

`logo-source.webp` is the logo as it was drawn: the map pin, the wordmark and the
strapline, all on a white card. Everything the app and the portal use is generated
from it, so change that file and re-run these two scripts rather than editing any
PNG by hand.

```bash
python3 brand/01-cutout.py    # lift the art off the white card, split mark from words
python3 brand/02-sizes.py     # write every size the app and the portal need
```

`01-cutout.py` flood-fills inward from the border, so white *inside* the pin (the car,
the tick, the ring) survives while the card and its drop shadow do not. The letter
counters are enclosed, so the flood never reaches them and they are cleared separately.
It also writes a light-on-dark wordmark for the portal's dark theme.

`02-sizes.py` writes:

- `app/src/main/res/mipmap-*/ic_launcher_foreground.png` — the pin at 64 of the 108dp
  adaptive-icon layer, which leaves a little air inside the 72dp a launcher shows.
- `tools/public/` — favicons (sharpened, because below about 48 px the resampler eats
  the pin's edges), the iOS home-screen icon, the maskable icon, and the wordmark.

Two things are drawn rather than generated. `drawable/ic_launcher_background.xml` is the
near-white card the logo was designed to sit on, and `drawable/ic_launcher_monochrome.xml`
is a plain pin-and-tick outline: the themed icon is flattened to one colour by the system,
and the full mark becomes a blob when that happens.

Requires Pillow and NumPy.

## Play Store listing

`brand/play/` holds what the Play Console asks for:

- `icon-512.png`: written by `python3 brand/03-play.py`, the launcher icon's card and pin at 512 px.
- `feature-1024x500.png`: `feature.html` rendered by headless Chrome:

  ```bash
  cd brand/play && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
    --hide-scrollbars --force-device-scale-factor=1 --window-size=1024,500 --allow-file-access-from-files \
    --screenshot="$PWD/feature-1024x500.png" "file://$PWD/feature.html"
  ```
- `screenshots/`: 1080 x 1920 (9:16) captures from the emulator (`adb shell wm size 1080x1920`), signed in
  to a local stack seeded with `v2/scripts/seed-demo.mjs` then `seed-showcase.mjs`, with the status bar
  in demo mode. All 24-bit PNG, no alpha, as Play requires.
