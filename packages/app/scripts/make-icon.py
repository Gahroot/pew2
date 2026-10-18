#!/usr/bin/env python3
"""
The pew2 mark: Pew, the LED globe, turned a little toward the light with a
glowing face, on the Stage canvas. One painter feeds every place the mark
appears, so the icon, the launch splash and the README can never drift apart
again (the splash sat on the old coral `P2` long after the icon moved on).

    npm run icon                                         # write every asset
    python3 packages/app/scripts/make-icon.py --preview /tmp   # squircle sheet only

What it writes:
  assets/icon.png                     iOS/store: full-bleed opaque square (iOS cuts the squircle)
  assets/splash-icon.png              the mark lifted off the canvas, transparent, for expo-splash-screen
  assets/favicon.png                  web
  assets/widget-pew.png               the home/Lock Screen widget's Pew, transparent, small
  assets/android-icon-*.png           adaptive layers: canvas, Pew inside the 66% safe zone, silhouette
  docs/icon.png                       README

Not drawn by the live engine on purpose: the engine's LED face only exists at
a size where the icon is a smudge on a home screen, and its drawn face only
exists on a body too coarse to read as a globe. The icon takes the engine's
geometry (rows of dots, alternate rows offset, the key light from the upper
left, the drawn face's proportions) and paints it at icon scale.

Needs numpy, scipy and Pillow. Outputs are committed: an app icon must not
depend on a step that could fail on someone else's machine.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.special import erf

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(APP, "..", ".."))
ASSETS = os.path.join(APP, "assets")
SS = 2  # supersampling
N = 1024

rgb = lambda *c: np.array(c, dtype=float) / 255.0

BG = rgb(10, 10, 12)  # theme.color.bg
# pew2's own Pew (`src/pew/palette.ts` PEW2_PEW): no agent has been picked.
BASE = rgb(224, 122, 90)
LIGHT = rgb(255, 202, 182)
OFF = rgb(48, 35, 31)
EYE = rgb(255, 246, 241)
GLOW = rgb(255, 211, 193)
BLUSH = rgb(255, 143, 170)
KEY = np.array([-0.5, 0.6, 0.62])
KEY /= np.linalg.norm(KEY)


class Canvas:
    def __init__(self, n: int, bg=BG):
        self.n = n
        self.rgb = np.ones((n, n, 3)) * np.asarray(bg, dtype=float)
        yy, xx = np.mgrid[0:n, 0:n]
        self.xx = xx + 0.5
        self.yy = yy + 0.5

    def _box(self, x, y, r):
        x0, x1 = max(0, int(x - r - 2)), min(self.n, int(x + r + 3))
        y0, y1 = max(0, int(y - r - 2)), min(self.n, int(y + r + 3))
        return slice(y0, y1), slice(x0, x1)

    def over(self, sl, cov, c, a):
        k = (cov * a)[..., None]
        self.rgb[sl] = self.rgb[sl] * (1 - k) + np.asarray(c) * k

    def add(self, sl, val, c):
        self.rgb[sl] = self.rgb[sl] + val[..., None] * np.asarray(c)

    def disc(self, x, y, r, c, a):
        sl = self._box(x, y, r)
        d = np.hypot(self.xx[sl] - x, self.yy[sl] - y)
        self.over(sl, np.clip(r - d + 0.5, 0, 1), c, a)

    def halo(self, x, y, R, sigma, c, a):
        """A disc of radius R blurred by sigma, added (Skia's Plus blend)."""
        sl = self._box(x, y, R + 3 * sigma)
        d = np.hypot(self.xx[sl] - x, self.yy[sl] - y)
        s = max(sigma, 0.5) * np.sqrt(2)
        val = 0.25 * (erf((R - d) / s) + erf((R + d) / s))
        self.add(sl, np.clip(val, 0, 1) * a, c)

    def mask(self, draw_fn, c, a, blur=0.0, additive=False):
        m = Image.new("L", (self.n, self.n), 0)
        draw_fn(ImageDraw.Draw(m))
        if blur > 0:
            m = m.filter(ImageFilter.GaussianBlur(blur))
        cov = np.asarray(m, dtype=float) / 255.0
        sl = (slice(0, self.n), slice(0, self.n))
        (self.add(sl, cov * a, c) if additive else self.over(sl, cov, c, a))

    def radial(self, cx, cy, R, c, a):
        d = np.hypot(self.xx - cx, self.yy - cy)
        self.add((slice(0, self.n), slice(0, self.n)), a * np.exp(-((d / R) ** 2) * 2.2), c)

    def dot_grid(self, pitch, r, a, centre, spread):
        """The Stage canvas's LED grid, fading out toward the edges."""
        off = (self.n % pitch) / 2 + pitch / 2
        fx, fy = centre
        for y in np.arange(off, self.n, pitch):
            for x in np.arange(off, self.n, pitch):
                k = a * (0.35 + 0.65 * np.exp(-((x - fx) ** 2 + (y - fy) ** 2) / (2 * spread * spread)))
                self.disc(x, y, r, (1, 1, 1), k)


def turn(v, yaw, pitch):
    x, y, z = v
    x1 = x * np.cos(yaw) + z * np.sin(yaw)
    z1 = -x * np.sin(yaw) + z * np.cos(yaw)
    return np.array([x1, y * np.cos(pitch) - z1 * np.sin(pitch), y * np.sin(pitch) + z1 * np.cos(pitch)])


def star(x, y, r):
    """The engine's four-point sparkle (`enginePaint.ts` star)."""
    return [(x + np.cos(i * np.pi / 4) * (r * 0.28 if i % 2 else r), y + np.sin(i * np.pi / 4) * (r * 0.28 if i % 2 else r)) for i in range(8)]


def pew(cv: Canvas, cx: float, cy: float, Rs: float, *, rows=19, yaw=-0.22, pitch=0.12, sparkles=True, glow=True):
    """Pew at (cx, cy), radius Rs, glancing up and to the right of the viewer."""
    on_face = lambda u, w: turn(np.array([u, w, np.sqrt(max(0.0, 1 - u * u - w * w))]), yaw, pitch)
    P = lambda v: (cx + v[0] * Rs, cy - v[1] * Rs)
    r0 = np.pi * Rs / rows * 0.38

    # The body: rows of LEDs round a sphere, back to front.
    dots = []
    for i in range(rows):
        lat = -np.pi / 2 + (i + 0.5) / rows * np.pi
        cols = max(4, round(rows * 2 * np.cos(lat)))
        for c in range(cols):
            lon = (c + 0.5 * (i % 2)) / cols * 2 * np.pi
            home = np.array([np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)])
            v = turn(home, yaw, pitch)
            if v[2] > 0:
                dots.append((v[2], v, home))
    dots.sort(key=lambda d: d[0])
    for z, v, home in dots:
        lam = max(0.0, float(v @ KEY))
        col = (OFF + (BASE - OFF) * 0.8) * (0.42 + 0.78 * lam)
        # Specular: the dots facing the key light catch it.
        col = col + (LIGHT - col) * min(1.0, (max(0.0, lam - 0.75) / 0.25) ** 1.5 * 0.7)
        # Cheeks: a warm flush under each eye.
        for s in (-1, 1):
            d = np.hypot(home[0] - s * 0.47, home[1] + 0.05)
            if d < 0.13:
                col = col + (BLUSH - col) * 0.55 * (1 - d / 0.13)
        sx, sy = P(v)
        cv.disc(sx, sy, r0 * (0.4 + 0.6 * z ** 0.6), np.minimum(1, col), 0.5 + 0.5 * z)

    # Rim: the canvas glow wrapping the edge, so the globe lifts off the dark.
    cv.mask(lambda d: d.ellipse([cx - Rs * 1.01, cy - Rs * 1.01, cx + Rs * 1.01, cy + Rs * 1.01], outline=255, width=int(Rs * 0.05)), BASE, 0.18, blur=Rs * 0.05, additive=True)

    # The face, on the sphere: the drawn face's proportions (`enginePaint.ts` drawFace).
    lw = 0.062 * Rs

    def eyes(d, grow=0.0):
        for s in (-1, 1):
            c = on_face(s * 0.3, 0.16)
            ex, ey = P(c)
            w, h = 0.1 * Rs * max(0.35, c[2]) + grow, 0.15 * Rs + grow
            d.ellipse([ex - w, ey - h, ex + w, ey + h], fill=255)

    def mouth(d, width):
        pts = [P(on_face(0.24 * np.cos(a), -0.04 - 0.24 * np.sin(a))) for a in np.linspace(np.radians(50), np.radians(130), 24)]
        d.line(pts, fill=255, width=int(width), joint="curve")
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=255)

    cv.mask(lambda d: (eyes(d, Rs * 0.05), mouth(d, lw * 2.2)), BASE, 0.75, blur=Rs * 0.08, additive=True)
    cv.mask(lambda d: (eyes(d), mouth(d, lw)), EYE, 1, blur=1.2 * SS)
    # Catchlights, on the key light's side.
    for s in (-1, 1):
        ex, ey = P(on_face(s * 0.3, 0.16))
        cv.disc(ex - 0.03 * Rs, ey - 0.065 * Rs, 0.03 * Rs, (1, 1, 1), 1)

    if sparkles:
        for dx, dy, r, c in [(-0.98, -0.62, 0.11, (1.0, 1.0, 1.0)), (1.02, -0.88, 0.075, GLOW), (0.96, 0.78, 0.055, GLOW)]:
            x, y = cx + dx * Rs, cy + dy * Rs
            if glow:
                cv.halo(x, y, r * Rs * 0.35, r * Rs * 0.5, BASE, 0.45)
            cv.mask(lambda d, pts=star(x, y, r * Rs): d.polygon(pts, fill=255), np.asarray(c, dtype=float), 1, blur=0.6 * SS)


def icon(grid=True) -> Image.Image:
    """The full icon: canvas, glow, grid, Pew filling the squircle's safe circle."""
    n = N * SS
    cv = Canvas(n)
    cv.radial(n / 2, n / 2, n * 0.52, BASE, 0.26)
    if grid:
        cv.dot_grid(64 * SS, 2.2 * SS, 0.06, (n / 2, n / 2), n * 0.35)
    pew(cv, n / 2, n / 2, n * 0.36)
    return finish(cv)


def lifted(fill: float, sparkles=True) -> Image.Image:
    """Pew alone, transparent: painted on the canvas colour, then lifted off it.

    Each pixel's alpha is how far it is from the canvas, so over a canvas-coloured
    background (the splash colour, Android's background layer) it composes back
    to exactly what was painted, glows included.
    """
    n = N * SS
    cv = Canvas(n)
    # Reaches zero before the canvas edge: the splash is drawn over a much
    # larger screen, and a glow cut off by its own square shows as a faint box.
    cv.radial(n / 2, n / 2, n * min(fill * 1.45, 0.3), BASE, 0.26)
    pew(cv, n / 2, n / 2, n * fill, sparkles=sparkles)
    rgb_ = np.clip(cv.rgb, 0, 1)
    bg = BG[None, None, :]
    up = np.max((rgb_ - bg) / (1 - bg), axis=2)
    down = np.max((bg - rgb_) / bg, axis=2)
    a = np.clip(np.maximum(up, down), 0, 1)
    safe = np.maximum(a, 1e-4)[..., None]
    col = np.where((up >= down)[..., None], (rgb_ - bg * (1 - safe)) / safe, 0)
    out = np.dstack([np.clip(col, 0, 1) * 255, a * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA").resize((N, N), Image.LANCZOS)


def finish(cv: Canvas) -> Image.Image:
    rgb_ = np.clip(cv.rgb, 0, 1)
    return Image.fromarray((rgb_ * 255 + 0.5).astype(np.uint8), "RGB").resize((N, N), Image.LANCZOS)


def squircle_mask(n: int, power: float = 5.0) -> Image.Image:
    """iOS's continuous-corner shape, close enough for a preview (superellipse)."""
    m = n * 4
    yy, xx = np.mgrid[0:m, 0:m]
    u = np.abs((xx + 0.5) / m * 2 - 1)
    v = np.abs((yy + 0.5) / m * 2 - 1)
    return Image.fromarray((((u ** power + v ** power) <= 1) * 255).astype(np.uint8), "L").resize((n, n), Image.LANCZOS)


def squircled(im: Image.Image, n: int) -> Image.Image:
    out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    out.paste(im.resize((n, n), Image.LANCZOS).convert("RGBA"), (0, 0), squircle_mask(n))
    return out


def preview(im: Image.Image, path: str) -> None:
    """Big, and at home-screen sizes, on a wallpaper-ish blue."""
    sheet = Image.new("RGB", (900, 560), (36, 40, 52))
    x = 40
    for sz in (420, 180, 120, 60):
        tile = squircled(im, sz)
        sheet.paste(tile, (x, 70 + (420 - sz) // 2), tile)
        x += sz + 30
    sheet.save(path)


def save(im: Image.Image, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, optimize=True)
    print(f"  {os.path.relpath(path, REPO)}  {os.path.getsize(path) // 1024}KB")


def write_all() -> None:
    print("Drawing the mark:")
    full = icon()
    # App Store rejects alpha on the icon; `icon()` is opaque RGB.
    save(full, os.path.join(ASSETS, "icon.png"))
    save(squircled(full, 1024), os.path.join(REPO, "docs", "icon.png"))
    save(squircled(full, 512), os.path.join(ASSETS, "favicon.png"))
    # Splash: the mark with room round it, over app.json's splash colour (the
    # canvas). The plugin draws it at `imageWidth`, so the canvas is mostly air.
    save(lifted(0.3), os.path.join(ASSETS, "splash-icon.png"))
    # Android adaptive: the canvas as background, Pew inside the 66% safe zone.
    # No sparkles: a launcher mask can crop them to stray specks.
    n = N * SS
    bg = Canvas(n)
    bg.radial(n / 2, n / 2, n * 0.42, BASE, 0.16)
    bg.dot_grid(64 * SS, 2.2 * SS, 0.07, (n / 2, n / 2), n * 0.35)
    save(finish(bg), os.path.join(ASSETS, "android-icon-background.png"))
    fg = lifted(0.27, sparkles=False)
    save(fg, os.path.join(ASSETS, "android-icon-foreground.png"))
    # Monochrome (themed icons): the silhouette, tinted by the system.
    mono = fg.split()[3].point(lambda v: 255 if v > 60 else 0)
    save(Image.merge("RGBA", (mono, mono, mono, mono)), os.path.join(ASSETS, "android-icon-monochrome.png"))
    # Widget: drawn at most ~60pt (180px at 3x), over the same canvas colour the
    # widget paints, so the lifted glow composes back exactly. Small, because a
    # widget extension is held to a tight memory ceiling.
    save(lifted(0.4, sparkles=False).resize((192, 192), Image.LANCZOS), os.path.join(ASSETS, "widget-pew.png"))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--preview":
        out = sys.argv[2] if len(sys.argv) > 2 else "."
        preview(icon(), os.path.join(out, "icon-preview.png"))
        print("wrote", os.path.join(out, "icon-preview.png"))
    else:
        write_all()
