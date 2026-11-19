#!/usr/bin/env python3
"""Regenerates the neutral (grey) pictures for the built-in sample shop.

FarmPrint tints these with each part's filament color, like any catalog picture. Run from
this folder: `python3 make_pictures.py` (needs Pillow). Output per product:
  <product_id>/parts/<stem>.png        part tile picture (256 px, part centred)
  <product_id>/parts/layer_<stem>.png  composite layer (512 px, shared product frame)
  <product_id>/parts/layers.json       layer order for the product picture
The shapes are simple made-up geometry; nothing here is a real product.
"""
import json
import math
import os
from PIL import Image, ImageDraw

SS = 4            # supersampling
FRAME = 512       # composite frame (px)
ICON = 256
C30, S30 = math.cos(math.radians(30)), math.sin(math.radians(30))
HERE = os.path.dirname(os.path.abspath(__file__))


def iso(x, y, z, ox, oy):
    """World (x right-back, y left-back, z up) to frame pixels."""
    return ((ox + (x - y) * C30) * SS, (oy + (x + y) * S30 - z) * SS)


def g(v):
    v = max(0, min(255, int(v)))
    return (v, v, v, 255)


class Canvas:
    def __init__(self):
        self.img = Image.new("RGBA", (FRAME * SS, FRAME * SS), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    def poly(self, pts, shade):
        self.d.polygon(pts, fill=g(shade))

    def ellipse(self, cx, cy, rx, ry, shade):
        self.d.ellipse([(cx - rx) * SS, (cy - ry) * SS, (cx + rx) * SS, (cy + ry) * SS], fill=g(shade))

    def done(self):
        return self.img.resize((FRAME, FRAME), Image.LANCZOS)


def box(c, ox, oy, x0, y0, z0, w, d, h, top=246, left=196, right=158):
    P = lambda x, y, z: iso(x, y, z, ox, oy)
    x1, y1, z1 = x0 + w, y0 + d, z0 + h
    c.poly([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], left)    # front-left face
    c.poly([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], right)   # front-right face
    c.poly([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], top)


def cylinder(c, ox, oy, x, y, z, r, h, r_top=None, hollow=False, inner=118):
    """Upright (optionally tapered) cylinder; screen-space ellipses in iso view."""
    r_top = r if r_top is None else r_top
    cx, cy = iso(x, y, z, ox, oy)
    cx, cy = cx / SS, cy / SS
    ty = cy - h
    # Body: vertical strips shaded by angle (light from the left).
    steps = 90
    for i in range(steps):
        a0 = math.pi * i / steps
        a1 = math.pi * (i + 1) / steps
        shade = 150 + 92 * max(0.0, math.cos(a0 - math.pi * 0.62)) ** 1.4
        pts = []
        for (a, rr, yy) in ((a0, r, cy), (a1, r, cy), (a1, r_top, ty), (a0, r_top, ty)):
            pts.append(((cx - rr * math.cos(a)) * SS, (yy + rr * 0.5 * math.sin(a)) * SS))
        c.poly(pts, shade)
    c.ellipse(cx, ty, r_top, r_top * 0.5, 240)
    if hollow:
        c.ellipse(cx, ty, r_top * 0.86, r_top * 0.43, inner)


def ring_clip(c, ox, oy, x, y, z, r, thick, depth):
    """An upright open ring (a cable clip), drawn as extruded arc segments."""
    cx, cy = iso(x, y, z, ox, oy)
    cx, cy = cx / SS, cy / SS - r
    gap = math.radians(70)  # opening at the top
    steps = 120
    segs = []
    for i in range(steps):
        a0 = -math.pi / 2 + gap / 2 + (2 * math.pi - gap) * i / steps
        a1 = -math.pi / 2 + gap / 2 + (2 * math.pi - gap) * (i + 1) / steps
        segs.append((a0, a1))
    dx, dy = -depth * C30, depth * S30  # extrusion toward the viewer-left
    for (a0, a1) in segs:  # outer band (extruded surface)
        p = lambda a, rr, off: ((cx + rr * math.sin(a) + off[0]) * SS, (cy - rr * math.cos(a) + off[1]) * SS)
        shade = 150 + 80 * max(0.0, -math.cos(a0 + 0.6))
        c.poly([p(a0, r, (0, 0)), p(a1, r, (0, 0)), p(a1, r, (dx, dy)), p(a0, r, (dx, dy))], shade)
    for (a0, a1) in segs:  # front face
        p = lambda a, rr: ((cx + rr * math.sin(a) + dx) * SS, (cy - rr * math.cos(a) + dy) * SS)
        c.poly([p(a0, r), p(a1, r), p(a1, r - thick), p(a0, r - thick)], 232)


def wedge_stand(c, ox, oy, x0, y0, z0, depth):
    """Phone stand: an L-shaped profile with a leaning back, extruded along y."""
    prof = [(0, 0), (150, 0), (150, 14), (40, 14), (40, 30), (24, 30), (110, 150), (92, 158), (0, 18)]
    P = lambda u, yy, v: iso(x0 + u, y0 + yy, z0 + v, ox, oy)
    quads = []
    n = len(prof)
    for i in range(n):
        (u0, v0), (u1, v1) = prof[i], prof[(i + 1) % n]
        nx, nz = (v1 - v0), -(u1 - u0)           # outward normal in profile plane (clockwise)
        ln = math.hypot(nx, nz) or 1
        shade = 165 + 80 * max(0.0, (nz / ln) * 0.8 + (nx / ln) * 0.35)
        depth_key = (u0 + u1) / 2 - (v0 + v1) / 2
        quads.append((depth_key, [P(u0, 0, v0), P(u1, 0, v1), P(u1, depth, v1), P(u0, depth, v0)], shade))
    for _, q, s in sorted(quads, key=lambda t: t[0]):
        c.poly(q, s)
    c.poly([P(u, depth, v) for (u, v) in prof], 188)


def layer(fn):
    c = Canvas()
    fn(c)
    return c.done()


def icon_from(img):
    bbox = img.getchannel("A").point(lambda a: 255 if a > 10 else 0).getbbox()
    crop = img.crop(bbox)
    side = int(max(crop.size) * 1.18)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(crop, ((side - crop.size[0]) // 2, (side - crop.size[1]) // 2), crop)
    return sq.resize((ICON, ICON), Image.LANCZOS)


OX, OY = 256, 250
PRODUCTS = {
    "sample-desk-organizer": [
        ("tray", "Tray", "sample-part-org-tray", lambda c: box(c, OX, OY, -130, -80, 0, 260, 160, 34)),
        ("divider", "Divider", "sample-part-org-divider", lambda c: box(c, OX, OY, -40, -74, 34, 10, 148, 70)),
        ("pen_cup", "Pen Cup", "sample-part-org-cup", lambda c: cylinder(c, OX, OY, 70, -10, 34, 46, 120, hollow=True)),
    ],
    "sample-cable-clip": [
        ("base", "Base", "sample-part-clip-base", lambda c: box(c, OX, OY + 40, -80, -60, 0, 160, 120, 22)),
        ("clip", "Clip", "sample-part-clip-clip", lambda c: ring_clip(c, OX, OY + 40, 30, 30, 22, 78, 24, 46)),
    ],
    "sample-plant-pot": [
        ("saucer", "Saucer", "sample-part-pot-saucer", lambda c: cylinder(c, OX, OY + 60, 0, 0, 0, 136, 18, r_top=140)),
        ("pot", "Pot", "sample-part-pot-pot", lambda c: cylinder(c, OX, OY + 60, 0, 0, 18, 88, 176, r_top=118, hollow=True, inner=96)),
    ],
    "sample-phone-stand": [
        ("stand", "Stand", "sample-part-stand-stand", lambda c: wedge_stand(c, OX - 20, OY + 60, -70, -60, 0, 120)),
        ("pad", "Pad", "sample-part-stand-pad", lambda c: box(c, OX - 20, OY + 60, -70 + 4, -60 + 6, 14, 32, 108, 5)),
    ],
}

for pid, parts in PRODUCTS.items():
    out = os.path.join(HERE, pid, "parts")
    os.makedirs(out, exist_ok=True)
    layers = []
    for z, (stem, name, part_id, fn) in enumerate(parts):
        img = layer(fn)
        img.save(os.path.join(out, f"layer_{stem}.png"), optimize=True)
        icon_from(img).save(os.path.join(out, f"{stem}.png"), optimize=True)
        layers.append({"imageStem": f"layer_{stem}", "iconStem": stem, "name": name, "partId": part_id, "compositeZ": z})
    with open(os.path.join(out, "layers.json"), "w") as f:
        json.dump({"layers": layers}, f, indent=2)
        f.write("\n")
print("ok")
