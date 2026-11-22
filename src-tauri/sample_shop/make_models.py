#!/usr/bin/env python3
"""Builds the built-in sample shop's models and pictures from scratch.

Every shape here is simple geometry written for FarmPrint (no downloaded models), released
under CC0 1.0 (see SOURCES.md). Run from this folder with `python3 make_models.py`
(needs `pip install manifold3d numpy pillow`). Output per product:
  <product_id>/parts/<stem>.stl        the part, flat on the bed, ready for Print!
  <product_id>/parts/<stem>.png        part tile picture (256 px, part centred)
  <product_id>/parts/layer_<stem>.png  composite layer (512 px, shared product frame)
  <product_id>/parts/layers.json       layer order for the product picture
Pictures are neutral grey; FarmPrint tints them with each part's filament color.
"""
import json
import math
import os
import struct
import sys

import numpy as np
from manifold3d import CrossSection, Manifold, OpType
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else HERE
FRAME, ICON, SS = 512, 256, 3

# ---------- shape helpers -------------------------------------------------------------------

def rrect(w, d, r, seg=24):
    """Rounded rectangle centred on the origin."""
    r = min(r, w / 2 - 0.01, d / 2 - 0.01)
    return CrossSection.hull(CrossSection.compose([
            CrossSection.circle(r, seg).translate((sx * (w / 2 - r), sy * (d / 2 - r)))
            for sx in (-1, 1) for sy in (-1, 1)]))


def ccw(pts):
    """Counter-clockwise copy of a polygon (CrossSection treats clockwise loops as holes)."""
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))
    return pts if area > 0 else pts[::-1]


def poly(pts):
    return CrossSection([ccw(list(pts))])


def tray(w, d, h, r, wall, floor):
    outer = rrect(w, d, r).extrude(h)
    inner = rrect(w - 2 * wall, d - 2 * wall, max(0.5, r - wall)).extrude(h).translate((0, 0, floor))
    return outer - inner


def revolve(profile, seg=96):
    """profile: [(r, z), ...] closed, r >= 0. Revolved around Z."""
    return poly(profile).revolve(seg)


# ---------- the products --------------------------------------------------------------------
# Each part: (stem, name, part id, Manifold placed where it sits in the assembled product).

def flexi_dragon():
    # Print-in-place style segmented body (each link is its own plate with a hinge web), a
    # snap-on head and a pair of wings. Wings print flat and are shown raised.
    path = lambda t: (34 - 118 * t, 9 * math.sin(t * math.pi * 1.6))
    links = []
    n = 12
    for i in range(n):
        t = i / (n - 1)
        x, y = path(t)
        w = 34 - 24 * t
        h = 11 - 5.5 * t
        plate = CrossSection.hull(CrossSection.compose([
            CrossSection.circle(w / 2, 40).scale((0.5, 1)),
        ])).extrude(h).translate((x, y, 0))
        crest = Manifold.cylinder(5.5 - 3 * t, 3.2 - 1.6 * t, 0.3, 4).translate((x, y, h - 0.3))
        links += [plate, crest]
        if i < n - 1:
            x2, y2 = path((i + 1) / (n - 1))
            links.append(Manifold.hull(Manifold.compose([
                Manifold.cylinder(h * 0.5, 2.2, 2.2, 16).translate((x, y, 0)),
                Manifold.cylinder(h * 0.5, 2.2, 2.2, 16).translate((x2, y2, 0))])))
    tx, ty = path(1.0)
    links.append(poly(ccw([(4, -6), (-12, 0), (4, 6)])).extrude(4).translate((tx, ty, 0)))
    for (t, s) in ((0.08, 1), (0.08, -1), (0.42, 1), (0.42, -1)):
        x, y = path(t)
        links.append(Manifold.hull(Manifold.compose([
            Manifold.cylinder(4, 3, 3, 16).translate((x, y, 0)),
            Manifold.cylinder(4, 3.6, 3.6, 16).translate((x + 4, y + s * 20, 0))])))
        for k in (-1, 0, 1):
            links.append(Manifold.cylinder(4, 1.6, 1.6, 12).translate((x + 8, y + s * 20 + k * 3, 0)))
    body = Manifold.batch_boolean(links, OpType.Add)
    head = Manifold.batch_boolean([
        Manifold.hull(Manifold.compose([
            Manifold.sphere(1, 32).scale((13, 12, 8)).translate((0, 0, 7)),
            Manifold.sphere(1, 32).scale((8, 7, 5)).translate((18, 0, 6))])),
        Manifold.cylinder(11, 2.4, 0.3, 16).rotate((0, -60, 0)).translate((-3, 5, 9)),
        Manifold.cylinder(11, 2.4, 0.3, 16).rotate((0, -60, 0)).translate((-3, -5, 9)),
    ], OpType.Add).trim_by_plane((0, 0, 1), 0)
    head = head - Manifold.sphere(2.2, 16).translate((8, 8.4, 10)) - Manifold.sphere(2.2, 16).translate((8, -8.4, 10))
    head = head.translate((44, 0, 0))
    pts = [(0, 0), (6, 14), (3, 34), (-5, 29), (-10, 37), (-17, 27), (-25, 31), (-28, 19), (-36, 20), (-28, 5)]
    def wing(sign, lift):
        w = poly(ccw([(x, sign * y) for x, y in pts])).extrude(2.2)
        return w.rotate((sign * lift, 0, 0)).translate((22, sign * 8, 9.5))
    wings_print = wing(1, 0) + wing(-1, 0)
    wings_show = wing(1, 34) + wing(-1, 34)
    turn = lambda m: m.rotate((0, 0, 200))   # head toward the camera
    return [
        ("body", "Body", "sample-part-dragon-body", turn(body)),
        ("wings", "Wings", "sample-part-dragon-wings", turn(wings_show), wings_print),
        ("head", "Head", "sample-part-dragon-head", turn(head)),
    ]


def planter():
    # Ribbed pot: revolved shell with vertical ribs cut in, and a drain hole.
    H, rb, rt, wall = 92, 38, 52, 2.4
    outer = revolve([(0, 0), (rb, 0), (rt, H), (0, H)], 120)
    shell = outer - revolve([(0, 3), (rb - wall, 3), (rt - wall, H + 1), (0, H + 1)], 120)
    tilt = math.degrees(math.atan2(rt - rb, H))
    flutes = [Manifold.cube((3.2, 4.2, H - 14)).translate((-1.6, -2.1, 0))
              .rotate((0, tilt, 0)).translate((rb + 0.6 + 0.5 * (rt - rb) * 0.12, 0, 9)).rotate((0, 0, k * 12))
              for k in range(30)]
    shell = shell - Manifold.compose(flutes) - Manifold.cylinder(10, 5, 5, 24).translate((0, 0, -1))
    pot = shell.translate((0, 0, 8))
    saucer = revolve([(0, 0), (54, 0), (60, 9), (57, 9), (51, 2.5), (0, 2.5)], 120)
    feet = Manifold.compose([rrect(6, 3, 1).extrude(5.5).translate((32, 0, 2.5)).rotate((0, 0, a)) for a in (0, 120, 240)])
    return [
        ("drip_tray", "Drip Tray", "sample-part-planter-tray", saucer + feet),
        ("pot", "Pot", "sample-part-planter-pot", pot),
    ]


def cable_organizer():
    L, D, H = 110, 34, 22
    base = rrect(L, D, 8).extrude(H)
    for i in range(5):
        x = -44 + i * 22
        base = base - Manifold.cylinder(D + 2, 4.2, 4.2, 32).rotate((90, 0, 0)).translate((x, D / 2 + 1, 14))
        base = base - Manifold.cube((5.6, D + 2, 10)).translate((x - 2.8, -D / 2 - 1, 15))
    # Non-slip sole (printed in TPU), a little wider than the base so its edge shows.
    pad = rrect(L + 4, D + 4, 10).extrude(3).translate((0, 0, -3))
    return [
        ("grip_pad", "Grip Pad", "sample-part-cable-pad", pad),
        ("base", "Base", "sample-part-cable-base", base),
    ]


def headphone_stand():
    base = revolve([(0, 0), (48, 0), (50, 2), (50, 6), (44, 10), (0, 10)], 120)
    post = (Manifold.cylinder(150, 11, 8, 64).translate((0, 0, 10))
            - Manifold.cylinder(152, 7, 4.5, 48).translate((0, 0, 9)))
    # Hanger: a curved saddle (arc of a ring) on a short neck.
    ring = CrossSection.circle(46, 128) - CrossSection.circle(36, 128)
    clip = poly([(-60, 0), (60, 0), (60, 60), (-60, 60)])
    saddle = (ring ^ clip).extrude(26)
    saddle = saddle.translate((0, 0, -13)).rotate((90, 0, 0)).translate((0, 0, 160 - 46 + 2))
    neck = Manifold.cylinder(14, 8.5, 8.5, 48).translate((0, 0, 140))
    hanger = saddle.rotate((0, 0, 90)) + neck
    return [
        ("base", "Base", "sample-part-hp-base", base),
        ("post", "Post", "sample-part-hp-post", post),
        ("hanger", "Hanger", "sample-part-hp-hanger", hanger),
    ]


def desk_tray():
    W, D, H = 170, 110, 32
    t = tray(W, D, H, 12, 2.6, 2.4)
    div = rrect(2.4, D - 6, 1).extrude(H - 6).translate((-20, 0, 2.4))
    cross = rrect(62, 2.4, 1).extrude(H - 10).translate((-52, 0, 2.4))
    return [
        ("tray", "Tray", "sample-part-desk-tray", t),
        ("dividers", "Dividers", "sample-part-desk-dividers", div + cross),
    ]


def keychain():
    hexa = CrossSection.circle(24, 6).rotate(30)
    tag = hexa.extrude(3.4) - Manifold.cylinder(6, 3.4, 3.4, 32).translate((0, 17.5, -1))
    tag = tag - CrossSection.circle(17, 6).rotate(30).extrude(2).translate((0, 0, 2.2))
    # Inlay: mountain range with a sun, sits in the recess.
    mtn = poly([(-14, -8), (-6, 4), (-2, -1), (5, 9), (14, -8)])
    sun = CrossSection.circle(3.4, 32).translate((-8, 9))
    inlay = (mtn + sun).extrude(1.6).translate((0, -2, 2.2))
    ring = (CrossSection.circle(9, 48) - CrossSection.circle(7, 48)).extrude(1.6)
    ring = ring.translate((0, 25, 0))
    return [
        ("tag", "Tag", "sample-part-key-tag", tag),
        ("inlay", "Inlay", "sample-part-key-inlay", inlay),
        ("ring", "Split Ring", "sample-part-key-ring", ring),
    ]


PRODUCTS = {
    "sample-flexi-dragon": flexi_dragon,
    "sample-planter": planter,
    "sample-cable-organizer": cable_organizer,
    "sample-headphone-stand": headphone_stand,
    "sample-desk-tray": desk_tray,
    "sample-keychain": keychain,
}

# ---------- rendering -----------------------------------------------------------------------

AZ, EL = math.radians(-35), math.radians(32)
FWD = np.array([math.cos(EL) * math.cos(AZ), math.cos(EL) * math.sin(AZ), -math.sin(EL)])  # view dir
RIGHT = np.cross(FWD, [0, 0, 1]); RIGHT /= np.linalg.norm(RIGHT)
UP = np.cross(RIGHT, FWD)
LIGHT = np.array([-0.45, 0.35, 0.82]); LIGHT /= np.linalg.norm(LIGHT)
FILL = np.array([0.6, -0.5, 0.3]); FILL /= np.linalg.norm(FILL)


def mesh_arrays(man):
    mg = man.to_mesh()
    return np.asarray(mg.vert_properties, dtype=np.float64)[:, :3], np.asarray(mg.tri_verts, dtype=np.int64)


def project(v):
    return np.stack([v @ RIGHT, -(v @ UP), v @ FWD], axis=1)


def raster(parts, size, center, scale):
    """Z-buffer render; returns (shade, part index) images at size*SS."""
    N = size * SS
    zbuf = np.full((N, N), np.inf); shade = np.zeros((N, N)); owner = np.full((N, N), -1)
    for pi, (v, f) in enumerate(parts):
        p = project(v)
        sx = (p[:, 0] - center[0]) * scale * SS + N / 2
        sy = (p[:, 1] - center[1]) * scale * SS + N / 2
        a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
        n = np.cross(b - a, c - a); ln = np.linalg.norm(n, axis=1); ok = ln > 1e-12
        n[ok] /= ln[ok, None]
        facing = n @ FWD < 0
        lum = 0.18 + 0.70 * np.clip(n @ LIGHT, 0, 1) + 0.14 * np.clip(n @ FILL, 0, 1)
        for t in np.nonzero(ok & facing)[0]:
            i0, i1, i2 = f[t]
            xs = np.array([sx[i0], sx[i1], sx[i2]]); ys = np.array([sy[i0], sy[i1], sy[i2]]); zs = p[[i0, i1, i2], 2]
            x0, x1 = max(int(xs.min()), 0), min(int(math.ceil(xs.max())), N - 1)
            y0, y1 = max(int(ys.min()), 0), min(int(math.ceil(ys.max())), N - 1)
            if x1 < x0 or y1 < y0:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            d = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
            if abs(d) < 1e-9:
                continue
            w0 = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / d
            w1 = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / d
            w2 = 1 - w0 - w1
            inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
            if not inside.any():
                continue
            z = w0 * zs[0] + w1 * zs[1] + w2 * zs[2]
            zb = zbuf[y0:y1 + 1, x0:x1 + 1]
            win = inside & (z < zb)
            zb[win] = z[win]
            shade[y0:y1 + 1, x0:x1 + 1][win] = lum[t]
            owner[y0:y1 + 1, x0:x1 + 1][win] = pi
    return shade, owner


def to_image(shade, mask, size):
    g = np.clip(70 + 185 * shade, 0, 255)
    rgba = np.zeros(shade.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = g.astype(np.uint8)
    rgba[..., 3] = np.where(mask, 255, 0)
    img = Image.fromarray(rgba, "RGBA")
    return img.resize((size, size), Image.LANCZOS)


def bounds2d(arrs):
    pts = np.concatenate([project(v)[:, :2] for v, _ in arrs])
    lo, hi = pts.min(0), pts.max(0)
    return (lo + hi) / 2, (hi - lo).max()


def write_stl(path, v, f):
    v = v - [ (v[:, 0].min() + v[:, 0].max()) / 2, (v[:, 1].min() + v[:, 1].max()) / 2, v[:, 2].min()]
    with open(path, "wb") as fh:
        fh.write(b"FarmPrint sample part (CC0)".ljust(80, b" "))
        fh.write(struct.pack("<I", len(f)))
        for i0, i1, i2 in f:
            a, b, c = v[i0], v[i1], v[i2]
            n = np.cross(b - a, c - a); l = np.linalg.norm(n); n = n / l if l else n
            fh.write(struct.pack("<12fH", *n, *a, *b, *c, 0))


def main():
    only = set(sys.argv[2:])
    for pid, fn in PRODUCTS.items():
        if only and pid not in only:
            continue
        parts = fn()
        out = os.path.join(OUT, pid, "parts"); os.makedirs(out, exist_ok=True)
        arrs = [mesh_arrays(p[3]) for p in parts]
        center, span = bounds2d(arrs)
        scale = FRAME * 0.84 / span
        shade, owner = raster(arrs, FRAME, center, scale)
        layers = []
        for z, (part, (v, f)) in enumerate(zip(parts, arrs)):
            stem, name, part_id = part[:3]
            # Every part must show in the composite, or the app treats the picture as missing.
            assert (owner == z).any(), f"{pid}/{stem} is hidden behind other parts"
            to_image(shade, owner == z, FRAME).save(os.path.join(out, f"layer_{stem}.png"), optimize=True)
            c1, s1 = bounds2d([(v, f)])
            sh1, ow1 = raster([(v, f)], ICON, c1, ICON * 0.80 / s1)
            to_image(sh1, ow1 == 0, ICON).save(os.path.join(out, f"{stem}.png"), optimize=True)
            # The STL is the part as printed (an optional 5th entry when it is shown posed).
            write_stl(os.path.join(out, f"{stem}.stl"), *(mesh_arrays(part[4]) if len(part) > 4 else (v, f)))
            layers.append({"imageStem": f"layer_{stem}", "iconStem": stem, "name": name, "partId": part_id, "compositeZ": z})
        with open(os.path.join(out, "layers.json"), "w") as fh:
            json.dump({"layers": layers}, fh, indent=2); fh.write("\n")
        print(pid, [(p[0], len(a[1])) for p, a in zip(parts, arrs)])


if __name__ == "__main__":
    main()
