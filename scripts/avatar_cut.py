"""Cut the reference sheet into per-view RGBA sprites and report landmarks."""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SHEET = Path('refs/mature/sheet.png')
OUT = Path('stage/assets/avatar')
VIEW_W = 362

def cut_view(im, x0, x1):
    a = np.asarray(im).astype(np.int16)
    sub = a[:, x0:x1]
    r, g, b = sub[:, :, 0], sub[:, :, 1], sub[:, :, 2]
    mx = sub.max(2); mn = sub.min(2)
    bg = ((mn > 228) & (mx - mn < 20)).astype(np.uint8) * 255
    m = Image.fromarray(bg, 'L').copy()
    w, h = m.size
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(m, seed, 128, thresh=0)
    fg = (np.asarray(m) != 128)
    # drop components smaller than 0.05% (specks / frame corners)
    ys, xs = np.nonzero(fg)
    y0, y1, x0_, x1_ = ys.min(), ys.max(), xs.min(), xs.max()
    small = np.zeros_like(fg)
    small[y0:y1 + 1, x0_:x1_ + 1] = True
    fg &= small
    # feather edge, keep interior opaque
    alpha = Image.fromarray((fg * 255).astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(1.1))
    alpha = np.asarray(alpha).astype(np.float32)
    alpha = np.clip((alpha - 40) * 255 / 170, 0, 255).astype(np.uint8)
    alpha[fg & (alpha < 255)] = 255
    rgba = np.dstack([sub.astype(np.uint8), alpha])
    ys, xs = np.nonzero(alpha > 8)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    # skin pixels in the head zone = face orientation cue
    r_, g_, b_ = sub[:, :, 0], sub[:, :, 1], sub[:, :, 2]
    skin = (r_ > 205) & (g_ > 150) & (b_ > 120) & (r_ - b_ > 18) & (fg)
    top = bbox[3] - bbox[1]
    head = skin[bbox[1]:bbox[1] + top // 4]
    sym = None
    msk = fg[:, bbox[0]:bbox[2]]
    if msk.size:
        msk = msk.astype(np.float32)
        sym = float(1 - np.abs(msk - msk[:, ::-1]).mean())
    return rgba, bbox, float(skin[bbox[1]:bbox[1] + top // 4].mean()), sym

def main():
    im = Image.open(SHEET).convert('RGB')
    W, H = im.size
    OUT.mkdir(parents=True, exist_ok=True)
    meta = []
    for i in range(4):
        x0 = i * VIEW_W
        x1 = min(W, x0 + VIEW_W)
        rgba, bbox, face, sym = cut_view(im, x0, x1)
        img = Image.fromarray(rgba, 'RGBA')
        crop = img.crop(bbox)
        p = OUT / f'view{i}.png'
        crop.save(p)
        meta.append({'view': i, 'bbox': bbox, 'size': list(crop.size), 'face': round(face, 4), 'sym': round(sym, 4)})
        print(f'view{i} bbox={bbox} size={crop.size} faceFrac={face:.4f} sym={sym:.4f}')
    (OUT / 'views.json').write_text(json.dumps(meta, indent=2))

if __name__ == '__main__':
    main()
