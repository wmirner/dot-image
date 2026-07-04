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

const state = {
  layout: "hex",          // square | hex | halftone | scatter
  spacing: 16,            // grid spacing, units
  angle: 45,              // halftone grid angle, degrees
  count: 6000,            // scatter target dot count
  minDist: 6,             // scatter minimum distance, units
  importance: true,       // scatter density follows image darkness
  seed: 7,

  dotSize: 14,            // base dot diameter, units
  sizeMode: "dark",       // uniform | dark | light
  sizeRange: 80,          // % of size that luminance can take away
  shape: "circle",        // circle | square

  colorMode: "original",  // original | limited | duotone | tritone | custom | mono
  paletteSize: 6,
  duoDark: "#16213e",
  duoLight: "#f5f1e8",
  triMid: "#e94560",
  monoColor: "#111111",
  customCount: 3,
  customColors: ["#0f3460", "#e94560", "#f5f1e8", "#53bf9d", "#f9c74f", "#1a1a2e"],

  bgColor: "#ffffff",
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
  const progress = opts.progressFn || null; // per-dot 0..1 for animation
  for (let i = 0; i < styled.length; i++) {
    const d = styled[i];
    let r = d.r * s;
    if (progress) {
      const p = progress(i);
      if (p <= 0) continue;
      r *= p;
    }
    if (r <= 0) continue;
    ctx.fillStyle = d.fill;
    if (state.shape === "square") {
      ctx.fillRect(d.x * s - r, d.y * s - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(d.x * s, d.y * s, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const canvas = document.getElementById("canvas");

function renderPreview() {
  if (!sample) return;
  const wrap = document.getElementById("canvasWrap");
  const availW = wrap.clientWidth - 48;
  const availH = wrap.clientHeight - 48;
  const aspect = unitsH / UNITS_W;
  let cssW = Math.min(availW, availH / aspect);
  cssW = Math.max(100, cssW);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssW * aspect + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssW * aspect * dpr);
  renderTo(canvas.getContext("2d"), canvas.width);
}

function renderOriginalPreview() {
  if (!sourceImage) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
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
      if (lvl === "layout") { buildLayout(); sampleColors(); mapColors(); applyStyle(); }
      else if (lvl === "color") { sampleColors(); mapColors(); applyStyle(); }
      else if (lvl === "style") { mapColors(); applyStyle(); }
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
  for (const d of styled) {
    if (d.r <= 0) continue;
    if (state.shape === "square") {
      parts.push(`<rect x="${f(d.x - d.r)}" y="${f(d.y - d.r)}" width="${f(d.r * 2)}" height="${f(d.r * 2)}" fill="${d.fill}"/>`);
    } else {
      parts.push(`<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.r)}" fill="${d.fill}"/>`);
    }
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

async function exportWebm() {
  const btn = document.getElementById("exportWebm");
  btn.disabled = true;
  setExportStatus("Recording animation…");

  const c = document.createElement("canvas");
  const pxWidth = Math.min(1600, UNITS_W * 2);
  c.width = pxWidth;
  c.height = Math.round(pxWidth * unitsH / UNITS_W);
  const ctx = c.getContext("2d");

  const stream = c.captureStream(60);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9" : "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = res; });
  rec.start();

  // per-dot stagger from a seeded hash so the reveal order is stable
  const rand = mulberry32(state.seed + 555);
  const stagger = new Float32Array(styled.length);
  for (let i = 0; i < styled.length; i++) stagger[i] = rand();
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const DURATION = 3000, HOLD = 800;

  const t0 = performance.now();
  await new Promise(resolve => {
    function frame(now) {
      const t = Math.min(1, (now - t0) / DURATION);
      renderTo(ctx, pxWidth, {
        progressFn: i => {
          const local = (t - stagger[i] * 0.6) / 0.4;
          return local <= 0 ? 0 : easeOutCubic(Math.min(1, local));
        },
      });
      if (now - t0 < DURATION + HOLD) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });

  rec.stop();
  await done;
  download(new Blob(chunks, { type: "video/webm" }), "dot-image.webm");
  setExportStatus("Animation saved.");
  btn.disabled = false;
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

function bindRange(id, key, level, fmt = v => v) {
  const el = $(id);
  const out = $(id + "Out");
  el.value = state[key];
  if (out) out.textContent = fmt(state[key]);
  el.addEventListener("input", () => {
    state[key] = parseFloat(el.value);
    if (out) out.textContent = fmt(state[key]);
    update(level);
  });
}

function syncControlsFromState() {
  for (const [id, key] of [
    ["spacing", "spacing"], ["angle", "angle"], ["count", "count"],
    ["minDist", "minDist"], ["dotSize", "dotSize"], ["sizeRange", "sizeRange"],
    ["paletteSize", "paletteSize"], ["customCount", "customCount"],
  ]) {
    $(id).value = state[key];
    const out = $(id + "Out");
    if (out) out.textContent = state[key].toLocaleString ? state[key].toLocaleString() : state[key];
  }
  $("importance").checked = state.importance;
  $("seed").value = state.seed;
  $("sizeMode").value = state.sizeMode;
  $("shape").value = state.shape;
  $("colorMode").value = state.colorMode;
  $("duoDark").value = state.duoDark;
  $("duoLight").value = state.duoLight;
  $("triMid").value = state.triMid;
  $("monoColor").value = state.monoColor;
  $("bgColor").value = state.bgColor;
  $("bgTransparent").checked = state.bgTransparent;
  document.querySelectorAll("#layoutSeg button").forEach(b =>
    b.classList.toggle("active", b.dataset.layout === state.layout));
  updateVisibility();
}

function updateVisibility() {
  document.querySelectorAll("[data-show]").forEach(el => {
    el.style.display = el.dataset.show.split(" ").includes(state.layout) ? "" : "none";
  });
  document.querySelectorAll("[data-color]").forEach(el => {
    el.style.display = el.dataset.color.split(" ").includes(state.colorMode) ? "" : "none";
  });
  $("sizeRangeWrap").style.display = state.sizeMode === "uniform" ? "none" : "";
  const swatches = $("customSwatches").querySelectorAll("input");
  swatches.forEach((inp, i) => {
    inp.style.display = i < state.customCount ? "" : "none";
  });
}

function initUI() {
  // image loading
  $("uploadBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", e => {
    if (e.target.files[0]) loadImageFile(e.target.files[0]);
  });
  $("sampleBtn").addEventListener("click", () => setSourceImage(makeSampleImage()));

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

  // layout
  document.querySelectorAll("#layoutSeg button").forEach(btn => {
    btn.addEventListener("click", () => {
      state.layout = btn.dataset.layout;
      document.querySelectorAll("#layoutSeg button").forEach(b =>
        b.classList.toggle("active", b === btn));
      updateVisibility();
      update("layout");
    });
  });
  bindRange("spacing", "spacing", "layout");
  bindRange("angle", "angle", "layout", v => v + "°");
  bindRange("count", "count", "layout", v => v.toLocaleString());
  bindRange("minDist", "minDist", "layout");
  $("importance").addEventListener("change", e => {
    state.importance = e.target.checked;
    update("layout");
  });
  $("seed").addEventListener("change", e => {
    state.seed = Math.max(1, parseInt(e.target.value) || 1);
    update("layout");
  });
  $("shuffleBtn").addEventListener("click", () => {
    state.seed = 1 + Math.floor(Math.random() * 99999);
    $("seed").value = state.seed;
    update("layout");
  });

  // dots
  bindRange("dotSize", "dotSize", "color"); // dot size affects area sampling
  $("sizeMode").addEventListener("change", e => {
    state.sizeMode = e.target.value;
    updateVisibility();
    update("style");
  });
  bindRange("sizeRange", "sizeRange", "style", v => v + "%");
  $("shape").addEventListener("change", e => {
    state.shape = e.target.value;
    update("render");
  });

  // color
  $("colorMode").addEventListener("change", e => {
    state.colorMode = e.target.value;
    updateVisibility();
    update("style");
  });
  bindRange("paletteSize", "paletteSize", "style");
  for (const [id, key] of [["duoDark", "duoDark"], ["duoLight", "duoLight"],
                           ["triMid", "triMid"], ["monoColor", "monoColor"]]) {
    $(id).addEventListener("input", e => { state[key] = e.target.value; update("style"); });
  }
  bindRange("customCount", "customCount", "style", v => { updateVisibility(); return v; });
  $("customSwatches").querySelectorAll("input").forEach((inp, i) => {
    inp.addEventListener("input", () => { state.customColors[i] = inp.value; update("style"); });
  });
  $("bgColor").addEventListener("input", e => { state.bgColor = e.target.value; update("render"); });
  $("bgTransparent").addEventListener("change", e => {
    state.bgTransparent = e.target.checked;
    update("render");
  });

  // presets
  document.querySelectorAll("[data-preset]").forEach(btn => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });

  // compare
  const compare = $("compareBtn");
  const showOrig = e => { e.preventDefault(); renderOriginalPreview(); };
  const showDots = () => renderPreview();
  compare.addEventListener("pointerdown", showOrig);
  compare.addEventListener("pointerup", showDots);
  compare.addEventListener("pointerleave", showDots);

  // exports
  $("exportSvg").addEventListener("click", () => {
    download(new Blob([buildSvg()], { type: "image/svg+xml" }), "dot-image.svg");
    setExportStatus("SVG saved.");
  });
  $("exportPng").addEventListener("click", async () => {
    const px = parseInt($("pngScale").value);
    setExportStatus("Rendering PNG…");
    download(await renderPngBlob(px), `dot-image-${px}px.png`);
    setExportStatus("PNG saved.");
  });
  $("copyBtn").addEventListener("click", async () => {
    try {
      setExportStatus("Copying…");
      const blob = await renderPngBlob(2000);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setExportStatus("Copied to clipboard.");
    } catch (err) {
      setExportStatus("Copy failed — your browser may not allow image clipboard access.");
    }
  });
  $("exportWebm").addEventListener("click", exportWebm);

  window.addEventListener("resize", () => update("render"));
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function applyPreset(name) {
  if (name === "halftone") {
    Object.assign(state, {
      layout: "halftone", spacing: 14, angle: 45,
      dotSize: 15, sizeMode: "dark", sizeRange: 100, shape: "circle",
      colorMode: "mono", monoColor: "#111111",
      bgColor: "#f7f4ec", bgTransparent: false,
    });
  } else if (name === "stipple") {
    Object.assign(state, {
      layout: "scatter", count: 30000, minDist: 2.5, importance: true,
      dotSize: 4, sizeMode: "uniform", shape: "circle",
      colorMode: "mono", monoColor: "#1a1a1a",
      bgColor: "#ffffff", bgTransparent: false,
    });
  } else if (name === "duotone") {
    Object.assign(state, {
      layout: "hex", spacing: 16,
      dotSize: 15, sizeMode: "dark", sizeRange: 70, shape: "circle",
      colorMode: "duotone", duoDark: "#16213e", duoLight: "#ff7096",
      bgColor: "#0d1021", bgTransparent: false,
    });
  } else if (name === "pointillist") {
    Object.assign(state, {
      layout: "scatter", count: 22000, minDist: 3, importance: false,
      dotSize: 8, sizeMode: "dark", sizeRange: 40, shape: "circle",
      colorMode: "original",
      bgColor: "#f5f1e8", bgTransparent: false,
    });
  }
  syncControlsFromState();
  update("layout");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initUI();
syncControlsFromState();
setSourceImage(makeSampleImage());
