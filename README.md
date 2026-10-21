# Twins Avatar

Turns a photo into a Twins avatar: a large hex grid of dots in a smooth duotone,
from brand blue `#0021CC` in dark areas to a pale blue tint in light areas, on
cream `#F9F4EB`. Everything runs client-side — no server, no upload, no
dependencies.

**Live:** https://wmirner.github.io/dot-image/

**Run locally:** open `index.html` in a browser, or serve the folder statically
(`npx serve .`).

## Using it

1. Upload, drag & drop, or paste a photo.
2. Click **Download PNG** to get a 2000px `twins-avatar.png`.

The look is fixed on purpose so every avatar matches; there are no settings.
The output keeps the photo's aspect ratio and is square-cornered, since
platforms crop avatars to a circle themselves. "Hold to compare" shows the
original photo.

## Changing the look

All settings live in the `state` object at the top of `app.js` (spacing, dot
size, size variation, colors, background). Change them there and push to
`main`; GitHub Pages redeploys automatically.

## Architecture

Single static page: `index.html` + `styles.css` + `app.js`.

Pipeline: source image → downscaled sample buffer → dot layout → per-dot color
sampling (area average) → color mapping → styling → canvas render. Dot layouts
are stored in resolution-independent units (image = 1000 units wide), so the
export is exact at any size.

Based on Brannon's Dot Image tool, which also supports other layouts (square,
halftone, freeform), color modes, goo and SVG/WebM export; that engine code is
still in `app.js`, just not exposed in the UI.
