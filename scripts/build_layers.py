#!/usr/bin/env python3
"""Split the front-view sprite into animation layers.

The sheet is a flat illustration, so layers are invented:
  head.png  top band (soft 16px cut at the neck) rotated around the neck
  body.png  everything else; the band above the cut is erased where head is opaque
  eye-*-closed.png  skin+lash patch used to blink over the painted eye
  mouth-open.png   the painted mouth, stretched while talking
  mouth-closed.png  the same crop with the opening filled in and a lip line
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "stage/assets/avatar"

SS = 4  # supersample factor for the eye patches


def smoothstep(x: np.ndarray | float) -> np.ndarray | float:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def rotated_ellipse(cx, cy, rx, ry, theta, w, h, x0=0.0, y0=0.0):
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    dx = xs + x0 - cx
    dy = ys + y0 - cy
    u = dx * np.cos(theta) + dy * np.sin(theta)
    v = -dx * np.sin(theta) + dy * np.cos(theta)
    return (u / rx) ** 2 + (v / ry) ** 2


def main() -> None:
    sprite = Image.open(ASSETS / "fig0.png").convert("RGBA")
    lm = json.loads((ASSETS / "landmarks.json").read_text())
    ox, oy = lm["offset"]
    W, H = sprite.size
    A = np.asarray(sprite)[:, :, 3].astype(np.float32) / 255.0

    # --- head / body split ------------------------------------------------
    yy = np.arange(H, dtype=np.float32)[:, None]
    head_h = 1.0 - smoothstep((yy - 230.0) / 16.0)  # 1 above y=230, 0 below y=246
    head_a = A * head_h
    erase = smoothstep((head_h - 0.90) / 0.10)
    body_a = A * (1.0 - erase)
    union = head_a + body_a * (1.0 - head_a)
    ok = A > 0.99
    print(f"seam composite: min={union[ok].min():.3f} mean={union[ok].mean():.4f}")

    rgb = np.asarray(sprite)[:, :, :3]
    head = np.dstack([rgb, (np.clip(head_a, 0, 1) * 255).round().astype(np.uint8)])
    body = np.dstack([rgb, (np.clip(body_a, 0, 1) * 255).round().astype(np.uint8)])
    Image.fromarray(head, "RGBA").crop((0, 0, W, 250)).save(ASSETS / "head.png")
    Image.fromarray(body, "RGBA").save(ASSETS / "body.png")

    # --- eye patches ------------------------------------------------------
    theta = np.deg2rad(lm["face"]["eye_angle_deg"])
    src = np.asarray(sprite).astype(np.float32)
    skin = src[:, :, :3]
    skin_a = src[:, :, 3]

    def skin_color(cx, cy, rx, ry):
        ys, xs = np.mgrid[0:H, 0:W]
        dx, dy = xs - cx, ys - cy
        u = dx * np.cos(theta) + dy * np.sin(theta)
        v = -dx * np.sin(theta) + dy * np.cos(theta)
        e = (u / rx) ** 2 + (v / ry) ** 2
        ring = (e > 1.6) & (e < 4.0) & (skin_a > 200)
        warm = ring & (skin[:, :, 0] > 200) & (skin[:, :, 0] - skin[:, :, 2] > 8)
        pick = warm if warm.sum() > 120 else ring
        return np.median(skin[pick], axis=0)

    def lash_color(cx, cy, rx, ry):
        ys, xs = np.mgrid[0:H, 0:W]
        dx, dy = xs - cx, ys - cy
        u = dx * np.cos(theta) + dy * np.sin(theta)
        v = -dx * np.sin(theta) + dy * np.cos(theta)
        e = (u / rx) ** 2 + (v / ry) ** 2
        inside = (e <= 1.0) & (skin_a > 200)
        px = skin[inside]
        lum = px @ np.array([0.299, 0.587, 0.114])
        dark = px[lum <= np.percentile(lum, 12)]
        return np.median(dark, axis=0)

    eyes_meta = {}
    for side in ("left", "right"):
        e = lm["local"]["eyes"][side]
        cx, cy = e["center"]
        rx0, ry0 = e["radius"]
        rx, ry = rx0 + 3.0, ry0 + 3.0
        sc = skin_color(cx, cy, rx, ry)
        lc = lash_color(cx, cy, rx, ry)
        ca, sa = np.cos(theta), np.sin(theta)
        ex = (rx * ca) ** 2 + (ry * sa) ** 2
        ey = (rx * sa) ** 2 + (ry * ca) ** 2
        ex, ey = float(np.sqrt(ex)), float(np.sqrt(ey))
        pad = 2.0
        x0 = int(np.floor(cx - ex - pad))
        y0 = int(np.floor(cy - ey - pad))
        x1 = int(np.ceil(cx + ex + pad))
        y1 = int(np.ceil(cy + ey + pad))
        w, h = x1 - x0, y1 - y0

        Wp, Hp = w * SS, h * SS
        patch = np.zeros((Hp, Wp, 4), dtype=np.uint8)
        patch[:, :, :3] = np.round(sc).astype(np.uint8)
        E = rotated_ellipse((cx - x0) * SS, (cy - y0) * SS, rx * SS, ry * SS,
                            theta, Wp, Hp)
        cover = np.clip((1.0 - E) / 0.10, 0.0, 1.0)  # 10% feather ring
        inside = E <= 1.0
        patch[inside, 3] = 255

        img = Image.fromarray(patch, "RGBA")
        d = ImageDraw.Draw(img)
        # eyelid line: shallow downward bow, drawn rotated
        pts = []
        for t in np.linspace(0, 1, 48):
            px = (cx - x0 - rx * 0.90 + 1.80 * rx * t) * SS
            py = (cy - y0 + ry * 0.10 + ry * 0.22 * np.sin(np.pi * t)) * SS
            dxp = px - (cx - x0) * SS
            dyp = py - (cy - y0) * SS
            pts.append(((cx - x0) * SS + dxp * ca - dyp * sa,
                        (cy - y0) * SS + dxp * sa + dyp * ca))
        width = max(2, int(round(ry * 0.24 * SS)))
        d.line(pts, fill=tuple(int(v) for v in lc) + (255,), width=width, joint="curve")
        # soften the ends so the lid does not end abruptly
        d.line(pts[:6], fill=tuple(int(v) for v in lc) + (120,), width=width)
        d.line(pts[-6:], fill=tuple(int(v) for v in lc) + (120,), width=width)

        small = img.resize((w, h), Image.LANCZOS)
        arr = np.asarray(small).copy()
        cover_small = np.asarray(Image.fromarray((cover * 255).astype(np.uint8), "L")
                                 .resize((w, h), Image.LANCZOS)).astype(np.float32) / 255.0
        arr[:, :, 3] = (arr[:, :, 3].astype(np.float32) * cover_small).round().astype(np.uint8)
        out = ASSETS / f"eye-{side}-closed.png"
        Image.fromarray(arr, "RGBA").save(out)
        eyes_meta[side] = {
            "file": out.name,
            "box": [x0, y0, x1, y1],
            "center": [round(cx, 1), round(cy, 1)],
            "radius": [round(rx, 1), round(ry, 1)],
        }
        print(f"eye {side}: box={x0},{y0},{x1},{y1} skin={tuple(int(v) for v in sc)} "
              f"lash={tuple(int(v) for v in lc)}")

        # ascii sanity check of the lid
        lum = arr[:, :, :3] @ np.array([0.299, 0.587, 0.114])
        for row in lum[:: max(1, h // 12)]:
            print("   " + "".join("#" if v < 160 else "+" if v < 215 else "." for v in row))

    # --- mouth patches ----------------------------------------------------
    # Keep the crop tight: the painted mouth sits right above the collar bow,
    # so a wide crop would stretch the bow along with the lips.
    mb = lm["local"]["mouth"]["box"]
    mx0, my0, mx1, my1 = mb
    pad = 3
    crop = sprite.crop((mx0 - pad, my0 - pad, mx1 + pad, my1 + pad))
    ch, cw = crop.height, crop.width
    ys, xs = np.mgrid[0:ch, 0:cw]
    edge = np.minimum.reduce([
        xs + 0.5, cw - 1 - xs + 0.5,
        ys + 0.5, ch - 1 - ys + 0.5,
    ])
    m_alpha = smoothstep(edge / 2.5)
    carr = np.asarray(crop).copy()
    carr[:, :, 3] = (carr[:, :, 3].astype(np.float32) * m_alpha).round().astype(np.uint8)
    Image.fromarray(carr, "RGBA").save(ASSETS / "mouth-open.png")

    # closed mouth: fill the painted opening with neighbouring skin, then a lip line
    open_rgba = np.asarray(crop).astype(np.float32)
    rgb0 = open_rgba[:, :, :3]
    alpha0 = open_rgba[:, :, 3]
    cx, cy = lm["local"]["mouth"]["center"]
    lx, ly = cx - (mx0 - pad), cy - (my0 - pad)
    pink = ((rgb0[:, :, 0] - rgb0[:, :, 1] > 28) & (rgb0[:, :, 0] - rgb0[:, :, 2] > 18)
            & (rgb0[:, :, 0] > 120) & (alpha0 > 200))
    # only the blob containing the marked mouth centre counts; soft pink
    # shadows elsewhere in the crop (bow, blush) must not inflate the hole
    sy, sx = int(round(ly)), int(round(lx))
    if not pink[sy, sx]:
        yy, xx = np.nonzero(pink)
        assert len(yy), "no pink pixels in the mouth crop"
        k = np.argmin((yy - sy) ** 2 + (xx - sx) ** 2)
        sy, sx = int(yy[k]), int(xx[k])
    blob = np.zeros_like(pink)
    blob[sy, sx] = True
    for _ in range(cw + ch):
        grow = blob.copy()
        grow[1:] |= blob[:-1]
        grow[:-1] |= blob[1:]
        grow[:, 1:] |= blob[:, :-1]
        grow[:, :-1] |= blob[:, 1:]
        grow &= pink
        if (grow == blob).all():
            break
        blob = grow
    py, px = np.nonzero(blob)
    inner = (int(px.min()), int(py.min()), int(px.max()), int(py.max()))
    # rounded box covering the painted mouth plus a 3px margin, clamped so a
    # ring of known skin always remains to anchor the fill
    hx0 = max(2.0, float(px.min()) - 3.0)
    hx1 = min(cw - 3.0, float(px.max()) + 3.0)
    hy0 = max(2.0, float(py.min()) - 3.0)
    hy1 = min(ch - 3.0, float(py.max()) + 3.0)
    rad = 5.0
    dx = np.maximum(np.maximum(hx0 + rad - xs, xs - (hx1 - rad)), 0.0)
    dy = np.maximum(np.maximum(hy0 + rad - ys, ys - (hy1 - rad)), 0.0)
    dist = np.sqrt(dx * dx + dy * dy) - rad
    hole = dist <= 0.0
    known = (~hole) & (alpha0 > 200)
    mouth_px = rgb0[blob]
    lip = (np.median(mouth_px, axis=0) * np.array([0.62, 0.44, 0.50])).astype(np.float32) \
        if len(mouth_px) else np.array([150, 85, 95], dtype=np.float32)

    # seed each row with its own skin colour, then relax a harmonic fill so the
    # patch meets the surrounding skin without a luminance step
    fill = rgb0.copy()
    for yy in range(ch):
        rk = known[yy]
        if rk.any() and hole[yy].any():
            fill[yy, hole[yy]] = np.median(rgb0[yy, rk], axis=0)
    for _ in range(1200):
        nb = np.zeros_like(fill)
        nb[1:] += fill[:-1]
        nb[:-1] += fill[1:]
        nb[:, 1:] += fill[:, :-1]
        nb[:, :-1] += fill[:, 1:]
        fill[hole] = (nb / 4.0)[hole]

    blend = smoothstep(np.clip(-dist / 2.0 + 0.5, 0.0, 1.0))[..., None]
    closed = rgb0 * (1.0 - blend) + fill * blend

    line = Image.new("L", (cw * SS, ch * SS), 0)
    dl = ImageDraw.Draw(line)
    pts = []
    for t in np.linspace(0.0, 1.0, 40):
        lpx = (lx - 9.0 + 18.0 * t) * SS
        lpy = (ly + 1.4 + 2.2 * np.sin(np.pi * t)) * SS
        pts.append((lpx, lpy))
    dl.line(pts, fill=255, width=2 * SS, joint="curve")
    dl.line(pts[:6], fill=90, width=2 * SS)
    dl.line(pts[-6:], fill=90, width=2 * SS)
    line_small = np.asarray(line.resize((cw, ch), Image.LANCZOS)).astype(np.float32)[..., None] / 255.0
    closed = closed * (1.0 - line_small) + lip * line_small
    cimg = np.dstack([np.clip(closed, 0, 255), carr[:, :, 3]]).round().astype(np.uint8)
    Image.fromarray(cimg, "RGBA").save(ASSETS / "mouth-closed.png")
    print(f"mouth: box={mb} crop={cw}x{ch} lip={tuple(int(v) for v in lip)} "
          f"lip_px={len(mouth_px)}")

    # --- manifest ---------------------------------------------------------
    manifest = {
        "sprite": {"w": W, "h": H, "offset": [ox, oy]},
        "head": {"file": "head.png", "pivot": [204, 238], "seam_y": 230},
        "body": {"file": "body.png"},
        # 760 行以下裙摆结束，只剩垂下的鲸尾与尾鳍；摆动只作用于这一段
        "tail": {"y": 760, "amp": 13, "pivot": 180},

        "eyes": eyes_meta,
        "mouth": {
            "open": "mouth-open.png",
            "closed": "mouth-closed.png",
            "box": mb,
            "pad": pad,
            "center": lm["local"]["mouth"]["center"],
            "inner": list(inner),
            "stretch": 0.33,
        },
        "skin": [round(float(v), 1) for v in skin_color(*lm["local"]["mouth"]["center"], 30, 26)],
    }
    (ASSETS / "layers.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
