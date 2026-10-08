# Open Graph image

`og.html` is the 1200×630 source for `public/og.png`. It uses the landing
page's self-hosted Archivo Variable fonts and flat service palette.

From the repository root, install the pinned fonts and render with Chrome:

```sh
(cd apps/landing && bun install --frozen-lockfile)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=3000 \
  --screenshot="$PWD/apps/landing/public/og.png" \
  "file://$PWD/apps/landing/scripts/og/og.html"
sips -g pixelWidth -g pixelHeight apps/landing/public/og.png
ls -l apps/landing/public/og.png
```

Chrome must render Archivo before capture. If a different Chrome version
captures less than the full artwork, use `--window-size=1200,800`, then crop
the top-left 1200×630 region:

```sh
sips --cropToHeightWidth 630 1200 --cropOffset 0 0 apps/landing/public/og.png
```

Verify the PNG is exactly 1200×630 and under 300 KB. View it at full size
and at 300 px wide; check the two-line headline, `Krónan`, and `Domino’s`.
Keep important content at least 60 px from all edges.
