# -*- coding: utf-8 -*-
"""Lift the StreetSweep logo off its white card, and split the mark from the wordmark."""
import os
import numpy as np
from collections import deque
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "logo-source.webp")
WHITE_TOL = 78          # how far from white still counts as "the card" or its shadow
EDGE_BAND = 3           # how deep to soften the cut

img = Image.open(SRC).convert("RGBA")
flat = Image.new("RGB", img.size, (255, 255, 255))
flat.paste(img, mask=img.split()[3])
P = np.asarray(flat).astype(np.int16)
H, W, _ = P.shape
print("source", W, "x", H)

# --- everything connected to the border and close to white is the card ---------
whiteish = (P.min(axis=2) >= 255 - WHITE_TOL)
ext = np.zeros((H, W), bool)
q = deque()
for x in range(W):
    for y in (0, H - 1):
        if whiteish[y, x] and not ext[y, x]: ext[y, x] = True; q.append((y, x))
for y in range(H):
    for x in (0, W - 1):
        if whiteish[y, x] and not ext[y, x]: ext[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < H and 0 <= nx < W and whiteish[ny, nx] and not ext[ny, nx]:
            ext[ny, nx] = True; q.append((ny, nx))
print("card pixels removed: %.1f%%" % (100.0 * ext.mean()))

# --- soften the cut, then undo the white the edge pixels are blended with ------
alpha = np.where(ext, 0, 255).astype(np.float32)
near = ext.copy()
for _ in range(EDGE_BAND):
    g = near.copy()
    g[1:, :] |= near[:-1, :]; g[:-1, :] |= near[1:, :]
    g[:, 1:] |= near[:, :-1]; g[:, :-1] |= near[:, 1:]
    near = g
band = near & ~ext
est = np.clip((255 - P.min(axis=2)) * 1.6, 0, 255).astype(np.float32)
alpha[band] = est[band]

a = (alpha / 255.0)[..., None]
rgb = np.where(a > 0.004, (P - 255.0 * (1 - a)) / np.maximum(a, 0.004), 255.0)
out = np.dstack([np.clip(rgb, 0, 255), alpha]).astype(np.uint8)
cut = Image.fromarray(out, "RGBA")

# --- the blank row between the pin and the words tells us where to split -------
rows = alpha.sum(axis=1)
solid = rows > 0
mid = np.where(~solid)[0]
gaps, run = [], []
for r in mid:
    if run and r == run[-1] + 1: run.append(r)
    else:
        if run: gaps.append(run)
        run = [r]
if run: gaps.append(run)
inner = [g for g in gaps if 0 < g[0] and g[-1] < H - 1]
split = max(inner, key=len)
cut_y = (split[0] + split[-1]) // 2
print("mark/wordmark split at y =", cut_y, "(blank band %d px)" % len(split))

def trim(im):
    b = im.getbbox()
    return im.crop(b), b

mark, mb = trim(cut.crop((0, 0, W, cut_y)))
lock, lb = trim(cut)
word, wb = trim(cut.crop((0, cut_y, W, H)))
print("mark    ", mark.size)
print("wordmark", word.size)
print("lockup  ", lock.size)

# Letter counters are enclosed, so the flood never reaches them. Nothing inside the
# wordmark is legitimately white, so clear whatever is left.
wa = np.asarray(word).astype(np.int16).copy()
hole = (wa[..., :3].min(axis=2) >= 238) & (wa[..., 3] > 0)
wa[hole, 3] = 0
word = Image.fromarray(wa.astype(np.uint8), "RGBA")
print("letter counters cleared:", int(hole.sum()), "px")

# A version of the words for dark backgrounds: the navy goes light, the green stays.
la = np.asarray(word).astype(np.int16).copy()
r, g, b = la[..., 0], la[..., 1], la[..., 2]
navy = (la[..., 3] > 0) & ((g.astype(int) - np.maximum(r, b)) < 40)
la[navy, 0], la[navy, 1], la[navy, 2] = 233, 238, 244
word_light = Image.fromarray(la.astype(np.uint8), "RGBA")

for im, name in ((mark, "mark"), (word, "wordmark"), (lock, "lockup"), (word_light, "wordmark-light")):
    im.save(os.path.join(HERE, name + ".png"))

# The lockup for dark backgrounds, rebuilt from the two cleaned pieces.
pad = 40
lw = max(mark.width, word_light.width)
dark = Image.new("RGBA", (lw, mark.height + pad + word_light.height), (0, 0, 0, 0))
dark.alpha_composite(mark, ((lw - mark.width) // 2, 0))
dark.alpha_composite(word_light, ((lw - word_light.width) // 2, mark.height + pad))
dark.save(os.path.join(HERE, "lockup-light.png"))
print("wrote light variants")
