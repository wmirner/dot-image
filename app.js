/* Dot Image — client-side image dotification tool.
 *
 * Pipeline: source image -> downscaled sample buffer -> dot layout (grid/hex/
 * halftone/scatter) -> per-dot color sampling -> color mapping -> styling ->
 * canvas render. Dot positions live in resolution-independent "units" where
 * the image is always 1000 units wide, so exports at any size are exact.
 */

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const UNITS_W = 1000;     // logical width of every image, in units
const MAX_DOTS = 60000;   // hard safety cap across all modes

// Fixed Twins avatar look: big hex dots, brand blue fading to a pale blue
// tint so every dot reads. These are deliberately not user-adjustable so
// every avatar matches.
const state = {
  layout: "hex",          // square | hex | halftone | scatter
  spacing: 52,            // grid spacing, units
  angle: 45,              // halftone grid angle, degrees
  count: 6000,            // scatter target dot count
  minDist: 6,             // scatter minimum distance, units
  importance: true,       // scatter density follows image darkness
  seed: 7,

  dotSize: 50,            // base dot diameter, units
  sizeMode: "dark",       // uniform | dark | light
  sizeRange: 65,          // % of size that luminance can take away
  shape: "circle",        // circle | square
  goo: false,             // merge nearby dots into smooth blobs
  gooReach: 30,           // gap (as % of dot size) at which dots start to merge

  colorMode: "duotone",   // original | limited | duotone | tritone | custom | mono
  paletteSize: 6,
  duoDark: "#0021CC",
  duoLight: "#E2E4F4",
  triMid: "#0021CC",
  monoColor: "#120F08",
  customCount: 3,
  customColors: ["#0021CC", "#E5A119", "#F9F4EB", "#120F08", "#14B84B", "#CF6317"],

  bgColor: "#F9F4EB",
  bgTransparent: false,
};

let sourceImage = null;   // ImageBitmap | HTMLCanvasElement of the original
let sample = null;        // { data: Uint8ClampedArray, w, h } downscaled pixels
let unitsH = 750;         // logical height, depends on image aspect

let dots = [];            // { x, y, lum, rgb: [r,g,b] } positions + sampled color
let styled = [];          // { x, y, r, fill } final render list

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return "#" + rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
}

function lerpRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function luminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Perceptually-weighted squared RGB distance — good enough for palette snapping.
function colorDist(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Image loading & sampling
// ---------------------------------------------------------------------------

async function loadImageFile(fileOrBlob) {
  let bitmap;
  try {
    // from-image applies EXIF orientation so phone photos come in upright
    bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(fileOrBlob);
  }
  setSourceImage(bitmap);
}

// Bundled sample photos. fetch fails when the page is opened from file://,
// so fall back to the procedural sample.
async function loadSampleUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    await loadImageFile(await res.blob());
  } catch {
    setSourceImage(makeSampleImage());
  }
}

function setSourceImage(img) {
  sourceImage = img;
  unitsH = Math.round(UNITS_W * img.height / img.width);

  // Downscale for sampling: we never need more source pixels than dots can show.
  const maxSide = 1000;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff"; // flatten transparency so luminance is defined
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  sample = { data: ctx.getImageData(0, 0, w, h).data, w, h };

  update("layout");
}

// Average color of the image within a dot's footprint (in units).
function sampleArea(ux, uy, ur) {
  const { data, w, h } = sample;
  const s = w / UNITS_W;
  const cx = ux * s, cy = uy * s;
  const rp = Math.max(0.5, ur * s);
  // sample at most ~5x5 points across the footprint
  const step = Math.max(1, Math.floor((rp * 2) / 5));
  let r = 0, g = 0, b = 0, n = 0;
  const x0 = Math.max(0, Math.round(cx - rp)), x1 = Math.min(w - 1, Math.round(cx + rp));
  const y0 = Math.max(0, Math.round(cy - rp)), y1 = Math.min(h - 1, Math.round(cy + rp));
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = (y * w + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  if (n === 0) {
    const x = Math.min(w - 1, Math.max(0, Math.round(cx)));
    const y = Math.min(h - 1, Math.max(0, Math.round(cy)));
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  }
  return [r / n, g / n, b / n];
}

// Fast point luminance lookup, used to weight scatter sampling.
function sampleLum(ux, uy) {
  const { data, w, h } = sample;
  const s = w / UNITS_W;
  const x = Math.min(w - 1, Math.max(0, Math.round(ux * s)));
  const y = Math.min(h - 1, Math.max(0, Math.round(uy * s)));
  const i = (y * w + x) * 4;
  return luminance(data[i], data[i + 1], data[i + 2]);
}

// ---------------------------------------------------------------------------
// Dot layouts (positions only, in units)
// ---------------------------------------------------------------------------

function buildLayout() {
  if (!sample) { dots = []; return; }
  let pts;
  switch (state.layout) {
    case "square":   pts = gridLayout(state.spacing, 1, false); break;
    case "hex":      pts = gridLayout(state.spacing, Math.sqrt(3) / 2, true); break;
    case "halftone": pts = halftoneLayout(state.spacing, state.angle); break;
    case "scatter":  pts = scatterLayout(); break;
    default:         pts = [];
  }
  dots = pts;
}

// Effective spacing after applying the dot cap, so huge images can't hang the UI.
function cappedSpacing(spacing, rowFactor) {
  const est = (UNITS_W / spacing) * (unitsH / (spacing * rowFactor));
  if (est <= MAX_DOTS) return spacing;
  return spacing * Math.sqrt(est / MAX_DOTS);
}

function gridLayout(spacing, rowFactor, offsetRows) {
  const sp = cappedSpacing(spacing, rowFactor);
  const rowH = sp * rowFactor;
  const pts = [];
  let row = 0;
  for (let y = rowH / 2; y < unitsH; y += rowH, row++) {
    const xOff = offsetRows && row % 2 === 1 ? sp / 2 : 0;
    for (let x = sp / 2 + xOff; x < UNITS_W; x += sp) {
      pts.push({ x, y });
    }
  }
  return pts;
}

function halftoneLayout(spacing, angleDeg) {
  const sp = cappedSpacing(spacing, 1);
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const cx = UNITS_W / 2, cy = unitsH / 2;
  // cover the rotated bounding box: half-diagonal in every direction
  const half = Math.sqrt(cx * cx + cy * cy) + sp;
  const pts = [];
  for (let v = -half; v <= half; v += sp) {
    for (let u = -half; u <= half; u += sp) {
      const x = cx + u * cos - v * sin;
      const y = cy + u * sin + v * cos;
      if (x >= 0 && x < UNITS_W && y >= 0 && y < unitsH) pts.push({ x, y });
    }
  }
  return pts;
}

function scatterLayout() {
  const rand = mulberry32(state.seed);
  const target = Math.min(state.count, MAX_DOTS);
  const minDist = state.minDist;
  const pts = [];

  // spatial hash for min-distance rejection
  const cell = Math.max(minDist, 1);
  const cols = Math.ceil(UNITS_W / cell);
  const rows = Math.ceil(unitsH / cell);
  const grid = new Array(cols * rows).fill(null);

  const fits = (x, y) => {
    if (minDist <= 0) return true;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let j = Math.max(0, gy - 1); j <= Math.min(rows - 1, gy + 1); j++) {
      for (let i = Math.max(0, gx - 1); i <= Math.min(cols - 1, gx + 1); i++) {
        let node = grid[j * cols + i];
        while (node) {
          const dx = node.x - x, dy = node.y - y;
          if (dx * dx + dy * dy < minDist * minDist) return false;
          node = node.next;
        }
      }
    }
    return true;
  };

  const put = (x, y) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    const idx = gy * cols + gx;
    grid[idx] = { x, y, next: grid[idx] };
    pts.push({ x, y });
  };

  const maxAttempts = target * 40;
  for (let att = 0; att < maxAttempts && pts.length < target; att++) {
    const x = rand() * UNITS_W;
    const y = rand() * unitsH;
    if (state.importance) {
      // accept with probability ~ darkness^1.5, plus a floor so light
      // areas aren't completely empty
      const darkness = 1 - sampleLum(x, y);
      const p = 0.04 + 0.96 * Math.pow(darkness, 1.5);
      if (rand() > p) continue;
    }
    if (fits(x, y)) put(x, y);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Color sampling & mapping
// ---------------------------------------------------------------------------

function sampleColors() {
  const r = state.dotSize / 2;
  for (const d of dots) {
    d.rgb = sampleArea(d.x, d.y, r);
    d.lum = luminance(d.rgb[0], d.rgb[1], d.rgb[2]);
  }
}

function kmeansPalette(k) {
  // subsample for speed; k-means over dot colors, not raw pixels
  const rand = mulberry32(state.seed + 101);
  const pool = [];
  const stride = Math.max(1, Math.floor(dots.length / 4000));
  for (let i = 0; i < dots.length; i += stride) pool.push(dots[i].rgb);
  if (pool.length === 0) return [[0, 0, 0]];
  k = Math.min(k, pool.length);

  const centroids = [];
  for (let i = 0; i < k; i++) centroids.push(pool[Math.floor(rand() * pool.length)].slice());

  const assign = new Array(pool.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (let i = 0; i < pool.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = colorDist(pool[i], centroids[c]);
        if (dd < bd) { bd = dd; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pool.length; i++) {
      const s = sums[assign[i]], p = pool[i];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
    if (!moved) break;
  }
  return centroids;
}

function nearestColor(rgb, palette) {
  let best = palette[0], bd = Infinity;
  for (const p of palette) {
    const dd = colorDist(rgb, p);
    if (dd < bd) { bd = dd; best = p; }
  }
  return best;
}

function mapColors() {
  const mode = state.colorMode;
  if (mode === "original") {
    for (const d of dots) d.fillRgb = d.rgb;
  } else if (mode === "limited") {
    const palette = kmeansPalette(state.paletteSize);
    for (const d of dots) d.fillRgb = nearestColor(d.rgb, palette);
  } else if (mode === "duotone") {
    const dark = hexToRgb(state.duoDark), light = hexToRgb(state.duoLight);
    for (const d of dots) d.fillRgb = lerpRgb(dark, light, d.lum);
  } else if (mode === "tritone") {
    const dark = hexToRgb(state.duoDark), mid = hexToRgb(state.triMid), light = hexToRgb(state.duoLight);
    for (const d of dots) {
      d.fillRgb = d.lum < 0.5
        ? lerpRgb(dark, mid, d.lum * 2)
        : lerpRgb(mid, light, (d.lum - 0.5) * 2);
    }
  } else if (mode === "custom") {
    const palette = state.customColors.slice(0, state.customCount).map(hexToRgb);
    for (const d of dots) d.fillRgb = nearestColor(d.rgb, palette);
  } else if (mode === "mono") {
    const c = hexToRgb(state.monoColor);
    for (const d of dots) d.fillRgb = c;
  }
}

// ---------------------------------------------------------------------------
// Styling (final radius + fill string per dot)
// ---------------------------------------------------------------------------

function applyStyle() {
  const rBase = state.dotSize / 2;
  const range = state.sizeMode === "uniform" ? 0 : state.sizeRange / 100;
  styled = new Array(dots.length);
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    const t = state.sizeMode === "light" ? d.lum : 1 - d.lum;
    const r = rBase * (1 - range + range * t);
    styled[i] = { x: d.x, y: d.y, r, fill: rgbToHex(d.fillRgb) };
  }
  document.getElementById("dotReadout").textContent =
    styled.length.toLocaleString() + " dots";
}

// ---------------------------------------------------------------------------
// Goo — merge nearby dots
// ---------------------------------------------------------------------------
//
// Dots within the reach gap of a same-group partner are joined; every other
// dot stays an exact primitive. Merged shapes are built as a signed field
// (negative inside) on a grid and contoured with marching squares into vector
// loops (in units), which canvas, SVG and animation all share.
//
// Circles: each merging pair gets a true rolling-ball fillet. The two circles
// of radius rho tangent to both dots (T and S, either side of the axis) bound
// the neck: neck = kite(a, T, b, S) minus disks T and S. Dots stay perfectly
// round and the neck is circular arcs. rho is chosen per pair so the neck
// opens exactly when the gap drops below the reach. Where three mutually
// merged dots enclose a hole too small for a rho-ball, the hole is filled.
//
// Squares: no closed-form fillet, so the nearest two fields (m1 <= m2) are
// joined with a round union: max(rho, m1) - hypot(max(rho-m1, 0), max(rho-m2, 0)).
//
// Color: discrete palettes (limited/custom/mono) merge only same-colored dots,
// one outline per color. Continuous modes (original/duotone/tritone) merge
// everything into one outline used as a clip: grown copies of the dots fill
// the necks inside it, and the exact dots are drawn on top.

const GOO_MAX_CELLS = 4_000_000;
const GOO_MAX_PARTNERS = 10;
const BIG = 1e9;

// { plain: dot indices drawn as primitives, shapes: [{ fill, loops }],
//   clip: null | { loops, under: dot indices, grow } }
let goo = null;

function gooIsContinuous() {
  return ["original", "duotone", "tritone"].includes(state.colorMode);
}

function buildGoo() {
  goo = state.goo ? computeGoo(styled) : null;
}

// Fillet joining circles a and b, or null if a rho-ball still fits between them.
function gooFillet(a, b, reach) {
  const dx = b.x - a.x, dy = b.y - a.y, D = Math.hypot(dx, dy);
  if (D - a.r - b.r >= reach || D <= Math.abs(a.r - b.r)) return null;
  // equal-radius closed form: the neck opens exactly at gap = reach
  const rEff = Math.max((a.r + b.r) / 2, reach / 2);
  const rho = reach / 2 + reach * reach / (8 * rEff);
  const Ra = a.r + rho, Rb = b.r + rho;
  const along = (D * D + Ra * Ra - Rb * Rb) / (2 * D);
  const hh2 = Ra * Ra - along * along;
  if (along <= 0 || along >= D || hh2 <= rho * rho) return null;
  const hh = Math.sqrt(hh2), ux = dx / D, uy = dy / D;
  const px = a.x + ux * along, py = a.y + uy * along;
  const pts = [a.x, a.y, px - uy * hh, py + ux * hh, b.x, b.y, px + uy * hh, py - ux * hh];
  return {
    rho, edges: convexEdges(pts), tx: pts[2], ty: pts[3], sx: pts[6], sy: pts[7],
    minX: Math.min(pts[0], pts[2], pts[4], pts[6]), maxX: Math.max(pts[0], pts[2], pts[4], pts[6]),
    minY: Math.min(pts[1], pts[3], pts[5], pts[7]), maxY: Math.max(pts[1], pts[3], pts[5], pts[7]),
  };
}

// Outward half-planes of a convex polygon (flat points), packed as x, y, nx, ny.
function convexEdges(pts) {
  const m = pts.length / 2;
  let cx = 0, cy = 0;
  for (let i = 0; i < m; i++) { cx += pts[i * 2] / m; cy += pts[i * 2 + 1] / m; }
  const edges = new Float64Array(m * 4);
  for (let e = 0; e < m; e++) {
    const x1 = pts[e * 2], y1 = pts[e * 2 + 1];
    const x2 = pts[((e + 1) % m) * 2], y2 = pts[((e + 1) % m) * 2 + 1];
    let nx = y2 - y1, ny = x1 - x2;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if (nx * (cx - x1) + ny * (cy - y1) > 0) { nx = -nx; ny = -ny; }
    edges.set([x1, y1, nx, ny], e * 4);
  }
  return edges;
}

function convexField(edges, x, y) {
  let v = -BIG;
  for (let e = 0; e < edges.length; e += 4) {
    const k = edges[e + 2] * (x - edges[e]) + edges[e + 3] * (y - edges[e + 1]);
    if (k > v) v = k;
  }
  return v;
}

// Hole between three mutually merged circles: filled (as the triangle of
// centers) when the largest circle fitting in it is smaller than rho.
function gooHoleFill(a, b, c, rho) {
  let px = (a.x + b.x + c.x) / 3, py = (a.y + b.y + c.y) / 3;
  let t = 0;
  // relax toward the point equidistant from all three circle edges
  for (let it = 0; it < 24; it++) {
    const la = Math.hypot(px - a.x, py - a.y) || 1;
    const lb = Math.hypot(px - b.x, py - b.y) || 1;
    const lc = Math.hypot(px - c.x, py - c.y) || 1;
    const da = la - a.r, db = lb - b.r, dc = lc - c.r;
    t = (da + db + dc) / 3;
    if (Math.abs(da - t) + Math.abs(db - t) + Math.abs(dc - t) < 0.01) break;
    const ka = 0.5 * (da - t) / la, kb = 0.5 * (db - t) / lb, kc = 0.5 * (dc - t) / lc;
    px -= ka * (px - a.x) + kb * (px - b.x) + kc * (px - c.x);
    py -= ka * (py - a.y) + kb * (py - b.y) + kc * (py - c.y);
  }
  if (t <= 0 || t >= rho) return null;
  const pts = [a.x, a.y, b.x, b.y, c.x, c.y];
  return {
    edges: convexEdges(pts),
    minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x),
    minY: Math.min(a.y, b.y, c.y), maxY: Math.max(a.y, b.y, c.y),
  };
}

function filletField(f, x, y) {
  const k = convexField(f.edges, x, y);
  if (k > 0) return k;
  const tx = x - f.tx, ty = y - f.ty, sx = x - f.sx, sy = y - f.sy;
  const dT = f.rho - Math.sqrt(tx * tx + ty * ty);
  const dS = f.rho - Math.sqrt(sx * sx + sy * sy);
  return Math.max(dT, dS, k);
}

function computeGoo(list) {
  const reach = (state.gooReach / 100) * state.dotSize; // gap below which dots merge
  const square = state.shape === "square";
  const ext = square ? Math.SQRT2 : 1;
  const rhoSq = reach / (2 - Math.SQRT2); // round-union radius bridging at gap = reach
  const margin = square ? rhoSq : reach;
  const continuous = gooIsContinuous();

  const live = [];
  let maxR = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].r > 0) { live.push(i); if (list[i].r > maxR) maxR = list[i].r; }
  }
  if (reach <= 0 || live.length === 0) return { plain: live, shapes: [], clip: null };

  // --- find merging pairs via a bucket grid
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of live) {
    const d = list[i];
    if (d.x < minX) minX = d.x; if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y; if (d.y > maxY) maxY = d.y;
  }
  const cs = 2 * maxR * ext + margin;
  const bnx = Math.floor((maxX - minX) / cs) + 1;
  const bny = Math.floor((maxY - minY) / cs) + 1;
  const head = new Int32Array(bnx * bny).fill(-1);
  const next = new Int32Array(list.length);
  for (const i of live) {
    const b = Math.floor((list[i].y - minY) / cs) * bnx + Math.floor((list[i].x - minX) / cs);
    next[i] = head[b]; head[b] = i;
  }
  // Candidate partners per dot, capped to the nearest few: in dense clumps
  // farther pairs are buried inside the mass and only cost time.
  const pairKeys = new Set(), pairs = [], cand = [];
  for (const i of live) {
    const d = list[i];
    const bx = Math.floor((d.x - minX) / cs), by = Math.floor((d.y - minY) / cs);
    cand.length = 0;
    for (let oy = -1; oy <= 1; oy++) {
      const yy = by + oy;
      if (yy < 0 || yy >= bny) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = bx + ox;
        if (xx < 0 || xx >= bnx) continue;
        for (let j = head[yy * bnx + xx]; j >= 0; j = next[j]) {
          if (j === i) continue;
          const e = list[j];
          if (!continuous && e.fill !== d.fill) continue;
          const lim = (d.r + e.r) * ext + margin;
          const dx = e.x - d.x, dy = e.y - d.y, dd = dx * dx + dy * dy;
          if (dd < lim * lim) cand.push([dd, j]);
        }
      }
    }
    if (cand.length > GOO_MAX_PARTNERS) {
      cand.sort((p, q) => p[0] - q[0]);
      cand.length = GOO_MAX_PARTNERS;
    }
    for (const [, j] of cand) {
      const lo = Math.min(i, j), hi = Math.max(i, j), key = lo * list.length + hi;
      if (!pairKeys.has(key)) { pairKeys.add(key); pairs.push(lo, hi); }
    }
  }

  const isMerged = new Uint8Array(list.length);
  const fillets = [];
  const partners = new Map(); // dot -> Map(partner -> pair rho), circles only
  for (let p = 0; p < pairs.length; p += 2) {
    const i = pairs[p], j = pairs[p + 1];
    if (!square) {
      const f = gooFillet(list[i], list[j], reach);
      if (!f) continue;
      f.fill = list[i].fill;
      f.ids = [i, j];
      fillets.push(f);
      if (!partners.has(i)) partners.set(i, new Map());
      if (!partners.has(j)) partners.set(j, new Map());
      partners.get(i).set(j, f.rho);
      partners.get(j).set(i, f.rho);
    }
    isMerged[i] = isMerged[j] = 1;
  }
  // fill small enclosed holes between mutually merged triples
  for (const [i, pi] of partners) {
    for (const [j, rij] of pi) {
      if (j <= i) continue;
      const pj = partners.get(j);
      for (const [k, rik] of pi) {
        if (k <= j || !pj.has(k)) continue;
        const f = gooHoleFill(list[i], list[j], list[k], (rij + rik + pj.get(k)) / 3);
        if (!f) continue;
        f.fill = list[i].fill;
        f.tri = true;
        f.ids = [i, j, k];
        fillets.push(f);
      }
    }
  }

  const plain = [], merged = [];
  for (const i of live) (isMerged[i] ? merged : plain).push(i);
  if (merged.length === 0) return { plain, shapes: [], clip: null };


  // --- field grid
  const pad = i => list[i].r * ext + margin + 2;
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const i of merged) {
    const d = list[i], p = pad(i);
    if (d.x - p < gx0) gx0 = d.x - p; if (d.x + p > gx1) gx1 = d.x + p;
    if (d.y - p < gy0) gy0 = d.y - p; if (d.y + p > gy1) gy1 = d.y + p;
  }
  const rs = merged.map(i => list[i].r).sort((a, b) => a - b);
  // squares need a finer grid: marching squares chamfers sharp corners by ~h
  let h = Math.min(2, Math.max(0.25, rs[rs.length >> 1] / (square ? 12 : 4)));
  h = Math.max(h, Math.sqrt((gx1 - gx0) * (gy1 - gy0) / GOO_MAX_CELLS));
  const x0 = Math.floor(gx0 / h) * h - h, y0 = Math.floor(gy0 / h) * h - h;
  const nx = Math.ceil((gx1 - x0) / h) + 2, ny = Math.ceil((gy1 - y0) / h) + 2;
  const n = nx * ny;
  const field = new Float32Array(n);
  const m1 = square ? new Float32Array(n) : field; // circles: field is just the nearest edge
  const m2 = square ? new Float32Array(n) : null;

  const sdf = square
    ? (d, x, y) => {
        const qx = Math.abs(x - d.x) - d.r, qy = Math.abs(y - d.y) - d.r;
        const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
        return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
      }
    : (d, x, y) => {
        const dx = x - d.x, dy = y - d.y;
        return Math.sqrt(dx * dx + dy * dy) - d.r;
      };

  // grid index range for a box; the outer ring of the grid is never written
  const range = (ax, bx, ay, by) => [
    Math.max(1, Math.floor((ax - x0) / h)), Math.min(nx - 2, Math.ceil((bx - x0) / h)),
    Math.max(1, Math.floor((ay - y0) / h)), Math.min(ny - 2, Math.ceil((by - y0) / h)),
  ];
  // circles only need their own edge; necks come from the fillets
  const win = i => {
    const d = list[i], p = square ? pad(i) : d.r + 2 * h;
    return range(d.x - p, d.x + p, d.y - p, d.y + p);
  };

  function splat(ids, fl) {
    m1.fill(BIG);
    if (square) m2.fill(BIG);
    for (const i of ids) {
      const d = list[i], [ax, bx, ay, by] = win(i);
      for (let iy = ay; iy <= by; iy++) {
        const y = y0 + iy * h;
        for (let ix = ax, o = iy * nx + ax; ix <= bx; ix++, o++) {
          const v = sdf(d, x0 + ix * h, y);
          if (v < m1[o]) { if (square) m2[o] = m1[o]; m1[o] = v; }
          else if (square && v < m2[o]) m2[o] = v;
        }
      }
    }
    if (square) {
      for (let o = 0; o < n; o++) {
        if (m1[o] >= BIG) { field[o] = BIG; continue; }
        const a = m1[o], u = rhoSq - a, v = rhoSq - m2[o];
        field[o] = v > 0 ? Math.max(rhoSq, a) - Math.sqrt((u > 0 ? u * u : 0) + v * v) : a;
      }
      return;
    }
    for (const f of fl) {
      const [ax, bx, ay, by] = range(f.minX, f.maxX, f.minY, f.maxY);
      for (let iy = ay; iy <= by; iy++) {
        const y = y0 + iy * h;
        for (let ix = ax, o = iy * nx + ax; ix <= bx; ix++, o++) {
          const x = x0 + ix * h;
          const v = f.tri ? convexField(f.edges, x, y) : filletField(f, x, y);
          if (v < field[o]) field[o] = v;
        }
      }
    }
  }

  const shapes = [];
  if (!continuous) {
    const groups = new Map();
    for (const i of merged) {
      const f = list[i].fill;
      if (!groups.has(f)) groups.set(f, { ids: [], fl: [] });
      groups.get(f).ids.push(i);
    }
    for (const f of fillets) groups.get(f.fill).fl.push(f);
    for (const [fill, g] of groups) {
      splat(g.ids, g.fl);
      const loops = marchingSquares(field, nx, ny, x0, y0, h);
      if (loops.length) shapes.push({ fill, loops });
    }
    return { plain, shapes, clip: null };
  }
  // One outline for everything; necks are colored by grown copies of the
  // dots drawn inside it, then the exact dots go on top.
  splat(merged, fillets);
  const loops = marchingSquares(field, nx, ny, x0, y0, h);
  return { plain: live, shapes: [], clip: { loops, under: merged, grow: margin } };
}

// Contour the zero level of a sampled field (negative = inside) into closed
// polylines. Grid edges are shared between cells, so segments are stitched
// into loops by edge id.
function marchingSquares(v, nx, ny, x0, y0, h) {
  const ptOf = new Map();
  const px = [], py = [], adjA = [], adjB = [];
  const HN = nx * ny;
  const pt = (id, x, y) => {
    let p = ptOf.get(id);
    if (p === undefined) {
      p = px.length; ptOf.set(id, p);
      px.push(x); py.push(y); adjA.push(-1); adjB.push(-1);
    }
    return p;
  };
  const link = (p, q) => {
    if (adjA[p] < 0) adjA[p] = q; else adjB[p] = q;
    if (adjA[q] < 0) adjA[q] = p; else adjB[q] = p;
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const o = j * nx + i;
      const a = v[o], b = v[o + 1], c = v[o + nx + 1], d = v[o + nx];
      const code = (a < 0 ? 8 : 0) | (b < 0 ? 4 : 0) | (c < 0 ? 2 : 0) | (d < 0 ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const x = x0 + i * h, y = y0 + j * h;
      const T = () => pt(o, x + h * a / (a - b), y);
      const R = () => pt(HN + o + 1, x + h, y + h * b / (b - c));
      const B = () => pt(o + nx, x + h * d / (d - c), y + h);
      const L = () => pt(HN + o, x, y + h * a / (a - d));
      const centerIn = a + b + c + d < 0;
      switch (code) {
        case 1: case 14: link(L(), B()); break;
        case 2: case 13: link(B(), R()); break;
        case 3: case 12: link(L(), R()); break;
        case 4: case 11: link(T(), R()); break;
        case 6: case 9: link(T(), B()); break;
        case 7: case 8: link(T(), L()); break;
        case 5:
          if (centerIn) { link(T(), L()); link(B(), R()); }
          else { link(T(), R()); link(L(), B()); }
          break;
        case 10:
          if (centerIn) { link(T(), R()); link(L(), B()); }
          else { link(T(), L()); link(B(), R()); }
          break;
      }
    }
  }

  const loops = [];
  const seen = new Uint8Array(px.length);
  for (let s = 0; s < px.length; s++) {
    if (seen[s]) continue;
    const pts = [];
    let prev = -1, cur = s;
    while (true) {
      seen[cur] = 1;
      pts.push(px[cur], py[cur]);
      let nxt = adjA[cur];
      if (nxt === prev || (nxt >= 0 && seen[nxt])) nxt = adjB[cur];
      if (nxt < 0 || seen[nxt]) break;
      prev = cur; cur = nxt;
    }
    if (pts.length >= 6) loops.push(Float32Array.from(simplifyLoop(pts, 0.04)));
  }
  return loops;
}

// Drop vertices that sit within tol of the line through their kept neighbors.
function simplifyLoop(pts, tol) {
  const n = pts.length / 2;
  if (n < 8) return pts;
  const out = [pts[0], pts[1]];
  let ax = pts[0], ay = pts[1], runStart = 1;
  for (let i = 1; i < n; i++) {
    const c = (i + 1) % n, cx = pts[c * 2], cy = pts[c * 2 + 1];
    const dx = cx - ax, dy = cy - ay, len = Math.hypot(dx, dy) || 1;
    let ok = true;
    for (let s = runStart; s <= i && ok; s++) {
      ok = Math.abs((pts[s * 2] - ax) * dy - (pts[s * 2 + 1] - ay) * dx) / len <= tol;
    }
    if (!ok) {
      ax = pts[i * 2]; ay = pts[i * 2 + 1];
      out.push(ax, ay);
      runStart = i + 1;
    }
  }
  return out;
}

function gooPath(shape) {
  if (!shape.path) {
    const p = new Path2D();
    for (const l of shape.loops) {
      p.moveTo(l[0], l[1]);
      for (let i = 2; i < l.length; i += 2) p.lineTo(l[i], l[i + 1]);
      p.closePath();
    }
    shape.path = p;
  }
  return shape.path;
}

function gooSvgD(shape, f) {
  let out = "";
  for (const l of shape.loops) {
    out += "M" + f(l[0]) + " " + f(l[1]) + "L";
    for (let i = 2; i < l.length; i += 2) out += f(l[i]) + " " + f(l[i + 1]) + " ";
    out = out.trimEnd() + "Z";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTo(ctx, pxWidth, opts = {}) {
  const pxHeight = Math.round(pxWidth * unitsH / UNITS_W);
  const s = pxWidth / UNITS_W;
  ctx.clearRect(0, 0, pxWidth, pxHeight);
  if (!state.bgTransparent) {
    ctx.fillStyle = state.bgColor;
    ctx.fillRect(0, 0, pxWidth, pxHeight);
  }
  const list = opts.list || styled;            // animation passes scaled dots
  const g = "goo" in opts ? opts.goo : goo;
  const drawDot = d => {
    const r = d.r * s;
    if (r <= 0) return;
    ctx.fillStyle = d.fill;
    if (state.shape === "square") {
      ctx.fillRect(d.x * s - r, d.y * s - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(d.x * s, d.y * s, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  if (!g) {
    for (const d of list) drawDot(d);
    return;
  }
  if (g.clip) {
    ctx.save();
    ctx.scale(s, s);
    ctx.clip(gooPath(g.clip), "evenodd");
    ctx.scale(1 / s, 1 / s);
    for (const i of g.clip.under) drawDot({ ...list[i], r: list[i].r + g.clip.grow });
    ctx.restore();
  }
  for (const i of g.plain) drawDot(list[i]);
  ctx.save();
  ctx.scale(s, s);
  for (const sh of g.shapes) {
    ctx.fillStyle = sh.fill;
    ctx.fill(gooPath(sh), "evenodd");
  }
  ctx.restore();
}

// Previews mimic how LinkedIn shows a profile photo: a center-cropped circle
// at profile (160px), post (48px) and comment (32px) sizes. The dots only
// read as a face when small, so the preview is deliberately small too.
const previews = [...document.querySelectorAll("canvas[data-size]")];

// Draw the center square of a full-image render into each preview canvas.
function drawPreviews(drawFull) {
  const aspect = unitsH / UNITS_W;
  const fit = Math.min(1, aspect); // square side as a fraction of image width
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of previews) {
    const size = parseInt(c.dataset.size);
    const px = Math.round(size * dpr);
    c.style.width = c.style.height = size + "px";
    c.width = c.height = px;
    // render big and scale down smoothly, like a platform resizing the upload;
    // drawing tiny dots directly aliases into stripes
    const k = Math.max(1, Math.floor(1000 / px));
    const side = px * k;
    const fullW = Math.round(side / fit);
    const fullH = Math.round(fullW * aspect);
    const full = document.createElement("canvas");
    full.width = fullW; full.height = fullH;
    drawFull(full.getContext("2d"), fullW, fullH);
    // crop the square, then halve step by step: one big downscale skips pixels
    let src = document.createElement("canvas");
    src.width = src.height = side;
    src.getContext("2d").drawImage(full, (fullW - side) / 2, (fullH - side) / 2, side, side, 0, 0, side, side);
    while (src.width / 2 >= px) {
      const half = document.createElement("canvas");
      half.width = half.height = Math.round(src.width / 2);
      const hctx = half.getContext("2d");
      hctx.imageSmoothingQuality = "high";
      hctx.drawImage(src, 0, 0, half.width, half.height);
      src = half;
    }
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, px, px);
  }
}

function renderPreview() {
  if (!sample) return;
  drawPreviews((ctx, w) => renderTo(ctx, w));
}

function renderOriginalPreview() {
  if (!sourceImage) return;
  drawPreviews((ctx, w, h) => ctx.drawImage(sourceImage, 0, 0, w, h));
}

// ---------------------------------------------------------------------------
// Update pipeline with rAF debounce
// ---------------------------------------------------------------------------

let pendingLevel = null;
let rafId = 0;

// level: "layout" (rebuild everything) | "color" (resample/map) | "style" | "render"
function update(level) {
  const order = ["layout", "color", "style", "render"];
  if (pendingLevel === null || order.indexOf(level) < order.indexOf(pendingLevel)) {
    pendingLevel = level;
  }
  if (!rafId) {
    rafId = requestAnimationFrame(() => {
      const lvl = pendingLevel;
      pendingLevel = null;
      rafId = 0;
      if (!sample) return;
      if (lvl === "layout") { buildLayout(); sampleColors(); mapColors(); applyStyle(); buildGoo(); }
      else if (lvl === "color") { sampleColors(); mapColors(); applyStyle(); buildGoo(); }
      else if (lvl === "style") { mapColors(); applyStyle(); buildGoo(); }
      renderPreview();
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function buildSvg() {
  const f = n => Math.round(n * 100) / 100;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNITS_W} ${unitsH}" width="${UNITS_W}" height="${unitsH}">`
  );
  if (!state.bgTransparent) {
    parts.push(`<rect width="${UNITS_W}" height="${unitsH}" fill="${state.bgColor}"/>`);
  }
  const dotEl = d => state.shape === "square"
    ? `<rect x="${f(d.x - d.r)}" y="${f(d.y - d.r)}" width="${f(d.r * 2)}" height="${f(d.r * 2)}" fill="${d.fill}"/>`
    : `<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.r)}" fill="${d.fill}"/>`;
  if (goo) {
    if (goo.clip) {
      parts.push(`<defs><clipPath id="goo"><path fill-rule="evenodd" clip-rule="evenodd" d="${gooSvgD(goo.clip, f)}"/></clipPath></defs>`);
      parts.push(`<g clip-path="url(#goo)">`);
      for (const i of goo.clip.under) parts.push(dotEl({ ...styled[i], r: styled[i].r + goo.clip.grow }));
      parts.push(`</g>`);
    }
    for (const i of goo.plain) parts.push(dotEl(styled[i]));
    for (const sh of goo.shapes) {
      parts.push(`<path fill-rule="evenodd" fill="${sh.fill}" d="${gooSvgD(sh, f)}"/>`);
    }
  } else {
    for (const d of styled) if (d.r > 0) parts.push(dotEl(d));
  }
  parts.push("</svg>");
  return parts.join("\n");
}

function renderPngBlob(pxWidth) {
  return new Promise(resolve => {
    const c = document.createElement("canvas");
    c.width = pxWidth;
    c.height = Math.round(pxWidth * unitsH / UNITS_W);
    renderTo(c.getContext("2d"), pxWidth);
    c.toBlob(resolve, "image/png");
  });
}

function setExportStatus(msg) {
  document.getElementById("exportStatus").textContent = msg;
}

// ---------------------------------------------------------------------------
// Sample image (procedural, so the tool demos itself without an upload)
// ---------------------------------------------------------------------------

function makeSampleImage() {
  const w = 900, h = 1200;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");

  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.75);
  sky.addColorStop(0, "#ffd89b");
  sky.addColorStop(0.55, "#f0716b");
  sky.addColorStop(1, "#4a3f74");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "#fff3d6";
  ctx.beginPath();
  ctx.arc(w * 0.62, h * 0.32, 110, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#2c2547";
  ctx.beginPath();
  ctx.moveTo(0, h * 0.62);
  ctx.quadraticCurveTo(w * 0.25, h * 0.46, w * 0.5, h * 0.6);
  ctx.quadraticCurveTo(w * 0.75, h * 0.72, w, h * 0.55);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.fill();

  ctx.fillStyle = "#191430";
  ctx.beginPath();
  ctx.moveTo(0, h * 0.78);
  ctx.quadraticCurveTo(w * 0.35, h * 0.66, w * 0.65, h * 0.8);
  ctx.quadraticCurveTo(w * 0.85, h * 0.88, w, h * 0.8);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.fill();

  return c;
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

function initUI() {
  // image loading
  $("uploadBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", e => {
    if (e.target.files[0]) loadImageFile(e.target.files[0]);
  });

  const wrap = $("canvasWrap");
  ["dragenter", "dragover"].forEach(ev =>
    document.addEventListener(ev, e => { e.preventDefault(); wrap.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(ev =>
    document.addEventListener(ev, e => { e.preventDefault(); wrap.classList.remove("dragover"); }));
  document.addEventListener("drop", e => {
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith("image/")) loadImageFile(f);
  });
  document.addEventListener("paste", e => {
    for (const item of e.clipboardData?.items || []) {
      if (item.type.startsWith("image/")) { loadImageFile(item.getAsFile()); break; }
    }
  });

  // compare
  const compare = $("compareBtn");
  const showOrig = e => { e.preventDefault(); renderOriginalPreview(); };
  const showDots = () => renderPreview();
  compare.addEventListener("pointerdown", showOrig);
  compare.addEventListener("pointerup", showDots);
  compare.addEventListener("pointerleave", showDots);

  // export
  $("exportPng").addEventListener("click", async () => {
    setExportStatus("Rendering PNG…");
    download(await renderPngBlob(2000), "twins-avatar.png");
    setExportStatus("PNG saved.");
  });

  window.addEventListener("resize", () => update("render"));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initUI();
loadSampleUrl("samples/portrait-blue.webp");
