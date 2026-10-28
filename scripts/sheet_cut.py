#!/usr/bin/env python3
"""Cut the community character sheet into RGBA figures and emit fig0 landmarks.

Background is textured off-white paper. We median-filter it and flood-fill
inwards from the sheet border with a tight tolerance. Line art blocks the
fill, so enclosed white regions (apron, collar) stay foreground.

Usage: python3 scripts/sheet_cut.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / "refs/mature/sheet.png"
ASSETS = ROOT / "stage/assets/avatar"

FIGURE_X = {"fig0": (0, 392), "fig1": (392, 698), "fig2": (698, 1054)}

# fig0 is the front view. Face is measured from the sheet's own pixels:
# skin bbox (163,110)-(247,214), eye line slope atan2(-16, 62) = -14.5 deg.
LANDMARKS = {
    "face_box": (163, 110, 247, 198),
    "face_center": (206, 154),
    "eye_left": (173, 146),
    "eye_radius_left": (16, 11),
    "eye_right": (235, 130),
    "eye_radius_right": (19, 13),
    "eye_angle_deg": -14.5,
    # The mouth is only the small pink shape; the larger teardrop underneath
    # (y 184..205) is the collar bow and belongs to the body layer.
    "mouth_box": (196, 163, 227, 186),
    "mouth_center": (212, 174),
    "mouth_radius": (13, 10),
    "chin": (212, 194),
    "neck": (216, 224),
    "head_cut_y": 234,
}


def cut_background(img: Image.Image, tol: int = 40) -> np.ndarray:
    sm = img.filter(ImageFilter.MedianFilter(3))
    fl = sm.copy()
    w, h = img.size
    seeds = [
        (0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
        (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2),
    ]
    for seed in seeds:
        ImageDraw.floodfill(fl, seed, (255, 0, 255), thresh=tol)
    a = np.asarray(fl)
    return (a[:, :, 0] == 255) & (a[:, :, 1] == 0) & (a[:, :, 2] == 255)


def row_width(mask: np.ndarray, y: int) -> tuple[int, int] | None:
    xs = np.nonzero(mask[y])[0]
    if not len(xs):
        return None
    return int(xs.min()), int(xs.max())


def main() -> None:
    img = Image.open(SHEET).convert("RGB")
    bg = cut_background(img)
    alpha = Image.fromarray((~bg).astype(np.uint8) * 255, "L")
    alpha = alpha.filter(ImageFilter.MinFilter(5))
    alpha = alpha.filter(ImageFilter.MaxFilter(5))
    alpha = alpha.filter(ImageFilter.MedianFilter(3))
    alpha = alpha.filter(ImageFilter.MinFilter(3))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.8))
    arr = np.asarray(alpha)

    ASSETS.mkdir(parents=True, exist_ok=True)
    meta: dict[str, dict] = {}
    for name, (xa, xb) in FIGURE_X.items():
        sub = arr[:, xa:xb].copy()
        if name == "fig0":
            # fig1's arm and skirt poke left past x=392; keep them out of fig0.
            sub[440:570, 378 - xa:] = 0
            sub[640:800, 378 - xa:] = 0
        ys, xs = np.nonzero(sub > 24)
        x0, y0 = int(xs.min()) + xa, int(ys.min())
        x1, y1 = int(xs.max()) + xa + 1, int(ys.max()) + 1
        rgba = img.crop((x0, y0, x1, y1)).convert("RGBA")
        rgba.putalpha(Image.fromarray(sub[y0:y1, x0 - xa:x1 - xa], "L"))
        rgba.save(ASSETS / f"{name}.png")
        cover = float((sub[y0:y1, x0 - xa:x1 - xa] > 128).mean())
        meta[name] = {
            "bbox": [x0, y0, x1, y1],
            "size": [x1 - x0, y1 - y0],
            "coverage": round(cover, 3),
        }
        print(f"{name}: bbox={x0},{y0},{x1},{y1} size={x1 - x0}x{y1 - y0} coverage={cover:.3f}")

    # silhouette landmarks from the fig0 alpha
    b = meta["fig0"]["bbox"]
    m = arr[b[1]:b[3], b[0]:b[2]] > 128
    widths = np.array([np.count_nonzero(row) for row in m])

    def span(y: int) -> int:
        r = row_width(m, y - b[1])
        return 0 if r is None else r[1] - r[0] + 1

    def argmin_width(ya: int, yb: int) -> int:
        seg = widths[ya - b[1]:yb - b[1]]
        return int(ya + np.argmin(seg[seg > 0]) if (seg > 0).any() else ya)

    def argmax_width(ya: int, yb: int) -> int:
        seg = widths[ya - b[1]:yb - b[1]]
        return int(ya + np.argmax(seg))

    neck_y = argmin_width(190, 250)
    shoulder_y = argmax_width(240, 330)
    waist_y = argmin_width(360, 680)
    hem_y = argmax_width(700, 980)
    cut = LANDMARKS["head_cut_y"]
    cut_span = row_width(m, cut - b[1])

    ox, oy = b[0], b[1]
    lm = {
        "source": str(SHEET.relative_to(ROOT)),
        "sprite": "stage/assets/avatar/fig0.png",
        "sprite_bbox": b,
        "sprite_size": meta["fig0"]["size"],
        "offset": [ox, oy],
        "view": "front, head tilted -18deg",
        "head_cut": {"y": cut, "x0": ox + cut_span[0], "x1": ox + cut_span[1] + 1},
        "face": {
            "box": list(LANDMARKS["face_box"]),
            "center": list(LANDMARKS["face_center"]),
            "eye_angle_deg": LANDMARKS["eye_angle_deg"],
        },
        "eyes": {
            "left": {"center": list(LANDMARKS["eye_left"]), "radius": list(LANDMARKS["eye_radius_left"])},
            "right": {"center": list(LANDMARKS["eye_right"]), "radius": list(LANDMARKS["eye_radius_right"])},
        },
        "mouth": {"box": list(LANDMARKS["mouth_box"]), "center": list(LANDMARKS["mouth_center"]), "radius": list(LANDMARKS["mouth_radius"])},
        "chin": list(LANDMARKS["chin"]),
        "neck": list(LANDMARKS["neck"]),
        "neck_y": neck_y,
        "shoulder_y": shoulder_y,
        "waist_y": waist_y,
        "hem_y": hem_y,
        "body_bottom": b[3],
    }
    # also expose sprite-local coordinates for the renderer
    def local(pt: list[int] | tuple[int, int]) -> list[int]:
        return [pt[0] - ox, pt[1] - oy]

    lm["local"] = {
        "face_box": [LANDMARKS["face_box"][0] - ox, LANDMARKS["face_box"][1] - oy,
                     LANDMARKS["face_box"][2] - ox, LANDMARKS["face_box"][3] - oy],
        "eyes": {
            "left": {"center": local(LANDMARKS["eye_left"]), "radius": list(LANDMARKS["eye_radius_left"])},
            "right": {"center": local(LANDMARKS["eye_right"]), "radius": list(LANDMARKS["eye_radius_right"])},
        },
        "mouth": {"box": [LANDMARKS["mouth_box"][0] - ox, LANDMARKS["mouth_box"][1] - oy,
                          LANDMARKS["mouth_box"][2] - ox, LANDMARKS["mouth_box"][3] - oy],
                  "center": local(LANDMARKS["mouth_center"]), "radius": list(LANDMARKS["mouth_radius"])},
        "chin": local(LANDMARKS["chin"]),
        "neck": local(LANDMARKS["neck"]),
        "neck_y": neck_y - oy,
        "shoulder_y": shoulder_y - oy,
        "waist_y": waist_y - oy,
        "hem_y": hem_y - oy,
        "head_cut_y": cut - oy,
        "head_cut_x": [ox + cut_span[0] - ox, ox + cut_span[1] + 1 - ox],
    }
    (ASSETS / "landmarks.json").write_text(json.dumps(lm, indent=2) + "\n")
    print(json.dumps({k: lm[k] for k in ("sprite_bbox", "head_cut", "neck_y", "shoulder_y", "waist_y", "hem_y")}, indent=2))

    # landmark preview: 6x head crop with boxes
    crop = img.crop((115, 95, 325, 255))
    scale = 6
    prev = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS).convert("RGB")
    d = ImageDraw.Draw(prev)

    def box(xy, color, w=4):
        x0_, y0_, x1_, y1_ = xy
        d.rectangle([(x0_ - 115) * scale, (y0_ - 95) * scale, (x1_ - 115) * scale, (y1_ - 95) * scale], outline=color, width=w)

    def cross(pt, color, r=8, w=3):
        x, y = (pt[0] - 115) * scale, (pt[1] - 95) * scale
        d.line([x - r, y, x + r, y], fill=color, width=w)
        d.line([x, y - r, x, y + r], fill=color, width=w)

    box(LANDMARKS["face_box"], (40, 210, 90))
    for c, er in ((LANDMARKS["eye_left"], LANDMARKS["eye_radius_left"]),
                  (LANDMARKS["eye_right"], LANDMARKS["eye_radius_right"])):
        box((c[0] - er[0], c[1] - er[1], c[0] + er[0], c[1] + er[1]), (0, 220, 255))
        cross(c, (0, 120, 255))
    mr = LANDMARKS["mouth_radius"]
    mc = LANDMARKS["mouth_center"]
    box((mc[0] - mr[0], mc[1] - mr[1], mc[0] + mr[0], mc[1] + mr[1]), (255, 0, 200))
    cross(LANDMARKS["chin"], (255, 210, 0), r=10)
    y = LANDMARKS["head_cut_y"]
    d.line([0, (y - 95) * scale, prev.width, (y - 95) * scale], fill=(255, 140, 0), width=3)
    prev.save(ASSETS / "landmarks-preview.png")

    sheet = img.resize((img.width // 2, img.height // 2), Image.LANCZOS)
    ds = ImageDraw.Draw(sheet)
    colours = {"fig0": (230, 40, 40), "fig1": (30, 180, 60), "fig2": (40, 90, 230)}
    for name, (xa, xb) in FIGURE_X.items():
        bb = meta[name]["bbox"]
        ds.rectangle([bb[0] // 2, bb[1] // 2, bb[2] // 2, bb[3] // 2], outline=colours[name], width=3)
    bb = [1055, 17, 1428, 563]
    ds.rectangle([bb[0] // 2, bb[1] // 2, bb[2] // 2, bb[3] // 2], outline=(230, 180, 30), width=3)
    for tile in [(1058, 574, 1216, 828), (1224, 574, 1426, 828), (1058, 838, 1238, 1050), (1248, 838, 1426, 1048)]:
        ds.rectangle([tile[0] // 2, tile[1] // 2, tile[2] // 2, tile[3] // 2], outline=(150, 150, 150), width=2)
    sheet.save(ASSETS / "sheet-views.png")


if __name__ == "__main__":
    main()
