# -*- coding: utf-8 -*-
"""Turn the cut-out logo into every size the app and the web portal need."""
import os, numpy as np
from PIL import Image, ImageEnhance, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP  = os.path.join(ROOT, "app", "src", "main", "res")
WEB  = os.path.join(ROOT, "tools", "public")

mark      = Image.open(os.path.join(HERE, "mark.png")).convert("RGBA")
word_full = Image.open(os.path.join(HERE, "wordmark.png")).convert("RGBA")
wordL_full= Image.open(os.path.join(HERE, "wordmark-light.png")).convert("RGBA")

def name_only(im):
    """Keep the name, drop the strapline. They are parted by a near-empty band that is
    not quite empty, because the p of Sweep hangs down through it."""
    rows = np.asarray(im)[..., 3].sum(axis=1).astype(float)
    quiet = rows <= rows.max() * 0.08
    best, run = None, []
    for i, q in enumerate(quiet):
        if q and i > im.height * 0.45:
            run.append(i)
            if best is None or len(run) > len(best): best = list(run)
        else:
            run = []
    if not best or len(best) < 5:
        return im
    top = im.crop((0, 0, im.width, best[-1] + 1))
    return top.crop(top.getbbox())

word  = name_only(word_full)
wordL = name_only(wordL_full)
print("wordmark with strapline", word_full.size, "-> name only", word.size)

def fit(im, box, frac, bg=None, dy=0.0):
    """The mark, scaled to `frac` of the box height, centred on a square canvas."""
    h = int(round(box * frac))
    w = max(1, int(round(im.width * h / im.height)))
    small = im.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (box, box), bg or (0, 0, 0, 0))
    canvas.alpha_composite(small, ((box - w) // 2, int(round((box - h) / 2 + dy * box))))
    return canvas

def wide(im, height):
    w = max(1, int(round(im.width * height / im.height)))
    return im.resize((w, height), Image.LANCZOS)

def save(im, *parts):
    p = os.path.join(*parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    im.save(p)
    return p

# ---------------------------------------------------------------- Android icon
# An adaptive icon is a 108dp layer of which the launcher shows the middle 72dp.
DENSITIES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
MARK_FRAC = 64.0 / 108.0     # leaves a little air inside the 72dp window

# The themed icon is a drawn silhouette (drawable/ic_launcher_monochrome.xml); a
# flattened photograph reads as a blob at icon sizes.
for name, px in DENSITIES.items():
    save(fit(mark, px, MARK_FRAC), APP, "mipmap-" + name, "ic_launcher_foreground.png")
print("android launcher foreground:", ", ".join(DENSITIES))

# No screen in the app shows a wordmark, so none is packaged; the web header uses it.

# ------------------------------------------------------------------ splash screen
# The system splash draws its icon on a 288dp canvas and guarantees the middle 192dp,
# so the pin fills 184 of that: any smaller and it reads as a stamp in a lot of empty
# screen. The words sit in the branding slot at the foot.
SPLASH_CANVAS_DP = 288
SPLASH_PIN_DP = 184
SPLASH_WORD_DP = 230

SPLASH_DP = {"mdpi": 288, "hdpi": 432, "xhdpi": 576, "xxhdpi": 864, "xxxhdpi": 1152}
for name, px in SPLASH_DP.items():
    save(fit(mark, px, float(SPLASH_PIN_DP) / SPLASH_CANVAS_DP), APP, "drawable-" + name, "splash_icon.png")

# The lockup the app draws itself while it starts: the pin with the name directly
# beneath it, the way the logo was drawn. One nodpi copy per tone rather than five
# densities, because it is scaled to a fraction of the screen width at runtime.
def stack(top, bottom, gap_frac=0.05):
    w = max(top.width, bottom.width)
    gap = int(round(w * gap_frac))
    canvas = Image.new("RGBA", (w, top.height + gap + bottom.height), (0, 0, 0, 0))
    canvas.alpha_composite(top, ((w - top.width) // 2, 0))
    canvas.alpha_composite(bottom, ((w - bottom.width) // 2, top.height + gap))
    return canvas

LOCKUP_PX = 1500     # covers 84% of the widest phone at the highest density
for src, folder in ((word_full, "drawable-nodpi"), (wordL_full, "drawable-night-nodpi")):
    lock = stack(mark, src)
    h = max(1, int(round(lock.height * LOCKUP_PX / lock.width)))
    out = lock.resize((LOCKUP_PX, h), Image.LANCZOS)
    # A palette cuts this from 1.3 MB to about 200 KB. Checked against the full-colour
    # version at the size a phone actually draws it: no banding to see.
    out = out.quantize(colors=256, method=Image.FASTOCTREE, dither=Image.FLOYDSTEINBERG)
    path = os.path.join(APP, folder, "splash_lockup.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out.save(path, optimize=True)
    print("  lockup %-24s %dx%d  %d KB" % (folder, LOCKUP_PX, h, os.path.getsize(path) // 1024))

# No wordmark is generated for the system splash's branding slot any more: the name
# lives in the lockup above, where it has room to be read.

# ------------------------------------------------------------------- web icons
WHITE = (255, 255, 255, 255)
save(fit(mark, 512, 0.88), WEB, "icon-512.png")
save(fit(mark, 192, 0.88), WEB, "icon-192.png")
save(fit(mark, 180, 0.78, bg=WHITE), WEB, "apple-touch-icon.png")       # iOS has no alpha
save(fit(mark, 512, 0.60, bg=WHITE), WEB, "icon-maskable-512.png")      # 80% safe circle
# Below about 48 px the pin loses its edges to the resampler, so put some back.
def crisp(px):
    im = fit(mark, px, 0.96)
    im = ImageEnhance.Color(im).enhance(1.12)
    return im.filter(ImageFilter.UnsharpMask(radius=max(0.6, px / 28.0), percent=110, threshold=1))

for px in (16, 32, 48):
    save(crisp(px), WEB, "favicon-%d.png" % px)
crisp(48).save(os.path.join(WEB, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
save(wide(word,  28),  WEB, "wordmark.png")
save(wide(wordL, 28),  WEB, "wordmark-light.png")
save(wide(word,  56),  WEB, "wordmark@2x.png")
save(wide(wordL, 56),  WEB, "wordmark-light@2x.png")
save(wide(word_full,  96), WEB, "lockup-wordmark.png")
save(wide(wordL_full, 96), WEB, "lockup-wordmark-light.png")
save(fit(mark, 256, 1.0), WEB, "logo-mark.png")
print("web icons written to tools/public")

for root, _, files in sorted(os.walk(WEB)):
    for f in sorted(files):
        p = os.path.join(root, f)
        print("   %-28s %6d bytes" % (f, os.path.getsize(p)))
