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
import math
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



def hair_mask(mask: np.ndarray, outside: np.ndarray) -> np.ndarray:
    """Connected blue-dark regions that reach outside the eye ellipse: bangs and lashes."""
    lab = np.zeros(mask.shape, np.int32)
    n = 0
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys, xs):
        if lab[y, x]:
            continue
        n += 1
        lab[y, x] = n
        stack = [(y, x)]
        while stack:
            cy, cx = stack.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if (0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1]
                            and mask[ny, nx] and not lab[ny, nx]):
                        lab[ny, nx] = n
                        stack.append((ny, nx))
    out = np.zeros(mask.shape, bool)
    for k in range(1, n + 1):
        m = lab == k
        if (m & outside).any():
            out |= m
    return out


def eye_closed_patch(src: np.ndarray, cx: float, cy: float, rx0: float, ry0: float,
                     theta: float, ss: int = 4):
    """闭眼贴片：眼睛开口内整片换成皮肤 + 一条按原画睫毛色画的眼睑线。

    刘海像素完全不参与重绘（alpha=0），所以贴片可以整块不透明地盖上去，
    不会有半透明边缘透出虹膜，也不会把头发刷成皮肤。
    """
    H, W = src.shape[:2]
    rx, ry = rx0 + 3.0, ry0 + 3.0
    ca, sa = math.cos(theta), math.sin(theta)
    ex = float(np.hypot(rx * ca, ry * sa))
    ey = float(np.hypot(rx * sa, ry * ca))
    pad = 3
    x0 = max(0, int(np.floor(cx - ex - pad)))
    x1 = min(W, int(np.ceil(cx + ex + pad)) + 1)
    y0 = max(0, int(np.floor(cy - ey - pad)))
    y1 = min(250, int(np.ceil(cy + ey + pad)) + 1)
    crop = src[y0:y1, x0:x1].astype(np.float32)
    h, w = crop.shape[:2]
    R, B, A = crop[:, :, 0], crop[:, :, 2], crop[:, :, 3]
    lum = crop[:, :, :3] @ np.array([0.299, 0.587, 0.114])
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    du, dv = xs - cx, ys - cy
    E = ((du * ca + dv * sa) / rx) ** 2 + ((-du * sa + dv * ca) / ry) ** 2

    # 刘海/睫毛：从椭圆外连进来的深蓝色连通域。只处理眼睛附近，避免误伤另一侧头发。
    near = (np.abs(du) < rx * 2.2) & (np.abs(dv) < ry * 5.0)
    hair = hair_mask((B - R > 25) & (lum < 200) & (A > 200) & near, E > 1.0)
    skin = (R > 170) & ((R - B) > 0) & (lum > 140) & (A > 200) & ~hair
    # 略微超出椭圆 1.07 倍，把原画睫毛的抗锯齿边一起覆盖掉，否则会留下半截旧睫毛
    paint = (E <= 1.07) & (A > 200) & ~hair

    # 每列取眼睛上方/下方最近的皮肤色，沿列线性插值：保留脸颊的明暗过渡
    col_top = np.full(w, -1, np.int32)
    col_bot = np.full(w, -1, np.int32)
    top_col = np.zeros((w, 3), np.float32)
    bot_col = np.zeros((w, 3), np.float32)
    for c in range(w):
        rows = np.nonzero(E[:, c] <= 1.0)[0]
        if not rows.size:
            continue
        yA, yB = rows.min(), rows.max()
        above = np.nonzero(skin[:yA, c])[0]
        below = np.nonzero(skin[yB + 1:, c])[0]
        if above.size:
            y = above.max()
            col_top[c] = y
            top_col[c] = np.median(crop[max(0, y - 2):y + 1, c, :3], axis=0)
        if below.size:
            y = yB + 1 + below.min()
            col_bot[c] = y
            bot_col[c] = np.median(crop[y:min(h, y + 3), c, :3], axis=0)
    valid = np.array([c for c in range(w) if col_top[c] >= 0 and col_bot[c] >= 0])
    if not valid.size:
        raise SystemExit("eye patch: no skin anchors around eye")
    for c in range(w):
        if col_top[c] < 0 or col_bot[c] < 0:
            cv = valid[np.argmin(np.abs(valid - c))]
            col_top[c], col_bot[c] = col_top[cv], col_bot[cv]
            top_col[c], bot_col[c] = top_col[cv], bot_col[cv]
    # 锚点贴着刘海时颜色会跳，逐列插值会留下竖条纹 → 先横向取中值
    for arr in (top_col, bot_col):
        raw = arr.copy()
        for c in range(w):
            lo, hi = max(0, c - 9), min(w, c + 10)
            arr[c] = np.median(raw[lo:hi], axis=0)

    fill = crop[:, :, :3].copy()
    for c in range(w):
        rows = np.nonzero(paint[:, c])[0]
        if not rows.size:
            continue
        t = np.clip((rows - col_top[c]) / max(1, col_bot[c] - col_top[c]), 0, 1)[:, None]
        fill[rows, c] = top_col[c][None, :] * (1 - t) + bot_col[c][None, :] * t
    for _ in range(24):  # 少量扩散，抹掉残余接缝
        p5 = np.pad(fill, ((1, 1), (1, 1), (0, 0)), mode="edge")
        nb = (p5[:-2, 1:-1] + p5[2:, 1:-1] + p5[1:-1, :-2] + p5[1:-1, 2:]) / 4.0
        fill[paint] = fill[paint] * 0.55 + nb[paint] * 0.45
    base = np.where(paint[..., None], fill, crop[:, :, :3])

    # 睫毛色直接取原画上眼睑的深色（不是头发的蓝）
    lash_px = crop[:, :, :3][(E <= 1.0) & (A > 200) & (lum < 110)]
    lc = np.median(lash_px, axis=0) if lash_px.shape[0] > 20 else np.array([62, 53, 94], np.float32)

    u0, u1 = -0.70 * rx, 0.74 * rx
    pts = []
    for t in np.linspace(0, 1, 96):
        u = u0 + (u1 - u0) * t
        v = 0.02 * ry + 0.08 * ry * t + 0.30 * ry * math.sin(math.pi * t)
        pts.append(((cx - x0 + u * ca - v * sa) * ss,
                    (cy - y0 + u * sa + v * ca) * ss))
    lid = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(lid)
    lw = max(2, int(round(1.7 * ss)))
    d.line(pts, fill=255, width=lw, joint="curve")
    for i in range(6):  # 两端收尖
        a = int(255 * (i / 6.0) ** 1.2)
        for p in (pts[i], pts[-1 - i]):
            d.ellipse([p[0] - lw / 2, p[1] - lw / 2, p[0] + lw / 2, p[1] + lw / 2], fill=a)
    la = np.asarray(lid.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255.0
    la *= paint.astype(np.float32)

    sh = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(sh).line([(px, py + 1.6 * ss) for px, py in pts],
                            fill=255, width=max(2, int(2.6 * ss)), joint="curve")
    sha = np.asarray(sh.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255.0
    sha *= paint.astype(np.float32) * (1 - la) * 0.10

    rgb = base * (1 - sha[..., None]) + np.array([150, 120, 150], np.float32) * sha[..., None]
    rgb = rgb * (1 - la[..., None]) + lc * 0.92 * la[..., None]

    out = np.dstack([np.clip(rgb, 0, 255), A * paint.astype(np.float32)])
    meta = {
        "box": [x0, y0, x1, y1],
        "center": [round(cx, 1), round(cy, 1)],
        "radius": [round(rx0, 1), round(ry0, 1)],
    }
    return np.round(out).astype(np.uint8), meta, int(paint.sum())


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

    eyes_meta = {}
    for side in ("left", "right"):
        e = lm["local"]["eyes"][side]
        arr, meta, npaint = eye_closed_patch(src, e["center"][0], e["center"][1],
                                             e["radius"][0], e["radius"][1], theta)
        name = f"eye-{side}-closed.png"
        Image.fromarray(arr, "RGBA").save(ASSETS / name)
        eyes_meta[side] = {"file": name, **meta}
        print(f"eye {side}: box={meta['box']} paint={npaint}")

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
