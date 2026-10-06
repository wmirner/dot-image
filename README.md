# Dot Image

A browser-based image treatment tool that turns any image into dots. Everything
runs client-side — no server, no upload, no dependencies.

**Try it:** open `index.html` in a browser, or serve the folder statically
(`npx serve .`).

## Features

### Layout
- **Square grid**, **hex grid**, and classic **halftone** (rotated grid with an
  angle control)
- **Freeform scatter** with a target dot count, minimum-spacing constraint, and
  optional importance sampling ("density follows image" — more dots land in
  dark areas)
- Seeded randomness: freeform layouts are reproducible; "Shuffle" tries a new seed

### Dots
- Dot size, spacing / total count (mode-dependent — spacing drives grids,
  count drives freeform)
- Size modulation: uniform, dark-is-big (halftone style), or light-is-big,
  with a variation-strength slider
- Circle or square dot shapes
- **Goo** (optional) — dots closer than the *reach* gap melt together with
  smooth circular fillets, like droplets joining. Dots stay perfectly round
  until they're close enough; small enclosed holes fill in. In palette, mono
  and custom modes only same-colored dots merge; in original, duotone and
  tritone modes everything merges and each dot keeps its color

### Color
- **Original** — each dot averages the image colors under its footprint
- **Limited palette** — k-means quantization of the image down to 2–16 colors
- **Duotone / Tritone** — luminance mapped onto your chosen 2–3 colors
- **Custom palette** — every dot snaps to the nearest of up to 6 hand-picked colors
- **Monochrome** — one dot color; size modulation carries the image
- Background color or full transparency

### Export
- **SVG** — resolution-independent vector, editable in Illustrator/Figma
- **PNG** at 1000/2000/4000 px, with transparent background support
- **Copy to clipboard** as an image
- **Animation (WebM)** — dots grow in with a seeded stagger, recorded at 60 fps

### Other
- Drag & drop, paste, or upload images (EXIF orientation handled)
- Hold-to-compare against the original
- Presets: Halftone, Stipple, Brand duotone, Pointillist, Goo
- Two bundled sample portraits (`samples/`) plus a procedural sample, so the
  tool demos itself (opened from `file://`, it falls back to the procedural one)
- Dot layouts are stored in resolution-independent units (image = 1000 units
  wide), so exports at any size are exact
- Hard cap of 60k dots keeps the UI responsive on any input

## Architecture

Single static page: `index.html` + `styles.css` + `app.js`.

Pipeline: source image → downscaled sample buffer → dot layout → per-dot color
sampling (area average) → color mapping → styling → goo (optional) → canvas
render. Exports re-render the same dot data to SVG text or an offscreen canvas.

Goo builds a signed distance field on a grid — circle edges plus rolling-ball
fillets between each merging pair (squares use a round union instead) — and
contours it with marching squares into vector paths, so SVG exports stay true
vectors. In the continuous color modes the merged outline becomes a
`clipPath` filled with slightly grown dots, with the exact dots on top.

## Ideas / roadmap

- Error-diffusion dithering between dots for small palettes
- Weighted Voronoi stippling (Lloyd's relaxation) for premium freeform quality
- More dot shapes (lines, rings, custom glyphs) and per-dot rotation
- WebGL renderer to push past 100k dots
- GIF export alongside WebM
