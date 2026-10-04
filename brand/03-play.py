# -*- coding: utf-8 -*-
"""The Play Store listing's artwork: the 512 px app icon. (The feature graphic is
drawn as a page, play/feature.html, and the screenshots come from the app itself.)"""
import os, numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "play")
mark = Image.open(os.path.join(HERE, "mark.png")).convert("RGBA")

def card(px):
    """drawable/ic_launcher_background.xml at this size: near-white, falling off to
    blue-grey from just up and left of centre, so the icon matches the launcher's."""
    y, x = np.mgrid[0:px, 0:px] * (108.0 / px)
    t = np.clip(np.hypot(x - 46, y - 40) / 86.0, 0, 1)[..., None]
    stops = [(0.0, (255, 255, 255)), (0.62, (0xF4, 0xF7, 0xFA)), (1.0, (0xDD, 0xE5, 0xEE))]
    rgb = np.zeros((px, px, 3))
    for (o0, c0), (o1, c1) in zip(stops, stops[1:]):
        k = np.clip((t - o0) / (o1 - o0), 0, 1)
        seg = (t >= o0) & (t <= o1)
        rgb = np.where(seg, np.array(c0) + (np.array(c1) - np.array(c0)) * k, rgb)
    return Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")

# Play shows the whole square, rounded off; the launcher shows the middle 72 of 108dp,
# with the pin at 64. Same proportion of what's visible: 64/72 of the height, a touch
# less so the rounded corners don't crowd it.
px = 512
icon = card(px)
h = int(round(px * 0.80))
w = int(round(mark.width * h / mark.height))
icon.alpha_composite(mark.resize((w, h), Image.LANCZOS), ((px - w) // 2, (px - h) // 2))
os.makedirs(OUT, exist_ok=True)
icon.convert("RGB").save(os.path.join(OUT, "icon-512.png"))
print("play icon:", os.path.join(OUT, "icon-512.png"))
