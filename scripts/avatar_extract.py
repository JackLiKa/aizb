"""Extract the four packed figures from the character sheet into RGBA sprites."""
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SHEET = Path('refs/mature/sheet.png')
OUT = Path('stage/assets/avatar')
MIN_AREA = 2000

def sheet_mask(im):
    a = np.asarray(im).astype(np.int16)
    mn = a.min(2); mx = a.max(2)
    bg = ((mn > 228) & (mx - mn < 20)).astype(np.uint8) * 255
    m = Image.fromarray(bg, 'L').copy()
    w, h = m.size
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(m, seed, 128, thresh=0)
    return a.astype(np.uint8), np.asarray(m)

def components(mask):
    ink = Image.fromarray(((mask == 0) * 255).astype(np.uint8), 'L').copy()
    w, h = ink.size
    out = []
    for gy in range(0, h, 8):
        for gx in range(0, w, 8):
            if ink.getpixel((gx, gy)) != 255:
                continue
            c = ink.copy()
            ImageDraw.floodfill(c, (gx, gy), 128, thresh=0)
            arr = np.asarray(c) == 128
            area = int(arr.sum())
            ys, xs = np.nonzero(arr)
            out.append({'area': area, 'bbox': (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1), 'mask': arr})
            ink = Image.fromarray(np.where(arr, 0, np.asarray(ink)).astype(np.uint8), 'L').copy()
    out.sort(key=lambda c: -c['area'])
    return out

def alpha_for(comp, mask):
    x0, y0, x1, y1 = comp['bbox']
    pad = 3
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(mask.shape[1], x1 + pad); y1 = min(mask.shape[0], y1 + pad)
    sub = comp['mask'][y0:y1, x0:x1]
    others = Image.fromarray(((~sub) * 255).astype(np.uint8), 'L').copy()
    h, w = sub.shape
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(others, seed, 128, thresh=0)
    alpha = (np.asarray(others) != 128).astype(np.uint8) * 255
    alpha = np.asarray(Image.fromarray(alpha, 'L').filter(ImageFilter.GaussianBlur(1.0)))
    return alpha, (x0, y0, x1, y1)

def face_stats(rgb, alpha):
    h, w = alpha.shape
    r = rgb[:, :, 0].astype(np.int16); g = rgb[:, :, 1].astype(np.int16); b = rgb[:, :, 2].astype(np.int16)
    skin = (r > 205) & (g > 150) & (b > 120) & (r - b > 18) & (alpha > 200)
    skin[: int(h * 0.08)] = False
    skin[int(h * 0.42):] = False
    ys, xs = np.nonzero(skin)
    if len(ys) < 50:
        return None
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    # eye blobs: dark and bluish inside the face box
    bx0, by0, bx1, by1 = box
    lum = (0.299 * r + 0.587 * g + 0.114 * b)
    dark = (lum < 118) & (b >= r - 6) & (alpha > 200)
    dark[:by0, :] = False; dark[by1:, :] = False
    dark[:, :bx0] = False; dark[:, bx1:] = False
    blob = Image.fromarray((dark * 255).astype(np.uint8), 'L').copy()
    blobs = []
    for yy in range(by0, by1, 2):
        for xx in range(bx0, bx1, 2):
            if blob.getpixel((xx, yy)) != 255:
                continue
            c = blob.copy(); ImageDraw.floodfill(c, (xx, yy), 128, thresh=0)
            arr = np.asarray(c) == 128
            if arr.sum() >= 12:
                ys2, xs2 = np.nonzero(arr)
                blobs.append({'area': int(arr.sum()), 'bbox': (int(xs2.min()), int(ys2.min()), int(xs2.max()) + 1, int(ys2.max()) + 1)})
            blob = Image.fromarray(np.where(arr, 0, np.asarray(blob)).astype(np.uint8), 'L').copy()
    blobs.sort(key=lambda q: -q['area'])
    return {'skinBox': box, 'skinFrac': float(skin.sum() / (alpha > 200).sum()), 'blobs': blobs[:6]}

def main():
    im = Image.open(SHEET).convert('RGB')
    rgb, mask = sheet_mask(im)
    comps = [c for c in components(mask) if c['area'] >= 50000]
    print('large components:', [(c['area'], c['bbox']) for c in comps])
    OUT.mkdir(parents=True, exist_ok=True)
    meta = []
    for i, comp in enumerate(comps[:6]):
        alpha, (x0, y0, x1, y1) = alpha_for(comp, mask)
        sub = rgb[y0:y1, x0:x1]
        rgba = np.dstack([sub, alpha])
        img = Image.fromarray(rgba, 'RGBA')
        ys, xs = np.nonzero(np.asarray(img)[:, :, 3] > 10)
        bb = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        img = img.crop(bb)
        p = OUT / f'fig{i}.png'
        img.save(p)
        arr = np.asarray(img)
        a = arr[:, :, 3] > 128
        m2 = a[:, ::-1]
        sym = float((a & m2).sum() / max(1, (a | m2).sum()))
        fs = face_stats(arr[:, :, :3], arr[:, :, 3])
        rec = {'index': i, 'bbox': [x0 + bb[0], y0 + bb[1], x0 + bb[2], y0 + bb[3]], 'size': list(img.size), 'alphaPx': int(a.sum()), 'sym': round(sym, 4), 'face': fs}
        meta.append(rec)
        print(f"fig{i} size={img.size} bbox={rec['bbox']} px={rec['alphaPx']} sym={sym:.3f} face={fs['skinBox'] if fs else None} skinFrac={fs['skinFrac'] if fs else 0:.4f}")
        if fs:
            print('   blobs', [(q['area'], q['bbox']) for q in fs['blobs'][:4]])
    (OUT / 'figures.json').write_text(json.dumps(meta, indent=2, default=int))

if __name__ == '__main__':
    main()
