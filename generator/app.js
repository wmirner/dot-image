/* Twin Avatars — UI around avatar.js */

"use strict";

const A = window.TwinAvatar;
const GALLERY_SIZE = 40;
const TILE = 80;
const EXPORT_PX = 2000;
const SET_PX = 1000;
const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

const state = {
  seed: "",
  locks: {},           // part key -> option id
  current: null,       // traits shown in the hero
  gallery: [],         // traits per tile
};

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Draw big and halve step by step, like a platform resizing an upload;
// drawing tiny dots directly aliases into stripes.
function drawScaled(canvas, size, list) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(size * dpr);
  canvas.style.width = canvas.style.height = size + "px";
  canvas.width = canvas.height = px;
  let side = px;
  while (side < 800) side *= 2;
  let src = document.createElement("canvas");
  src.width = src.height = side;
  A.draw(src.getContext("2d"), side, null, list);
  while (src.width / 2 >= px) {
    const half = document.createElement("canvas");
    half.width = half.height = Math.round(src.width / 2);
    const hctx = half.getContext("2d");
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(src, 0, 0, half.width, half.height);
    src = half;
  }
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, px, px);
}

function renderHero() {
  const list = A.dots(state.current);
  for (const c of document.querySelectorAll(".hero canvas[data-size]")) {
    drawScaled(c, parseInt(c.dataset.size), list);
  }
  $("codeLabel").textContent = "#" + A.encode(state.current);
  syncPartLabels();
  for (const [i, b] of [...$("gallery").children].entries()) {
    b.classList.toggle("active", A.encode(state.gallery[i]) === A.encode(state.current));
  }
}

// The synthetic grayscale photo the dots are sampled from
function drawSource(canvas, size, t) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(size * dpr);
  const { lum, size: n } = A.portrait(t);
  const img = new ImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = Math.round(lum[i] * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  const src = document.createElement("canvas");
  src.width = src.height = n;
  src.getContext("2d").putImageData(img, 0, 0);
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, px, px);
}

function renderGallery() {
  const g = $("gallery");
  g.replaceChildren();
  state.gallery.forEach((t, i) => {
    const b = document.createElement("button");
    b.title = "#" + A.encode(t);
    const c = document.createElement("canvas");
    b.appendChild(c);
    b.addEventListener("click", () => {
      state.current = { ...t };
      state.seed = "#" + A.encode(t);
      $("seedInput").value = state.seed;
      renderHero();
    });
    g.appendChild(b);
    // spread the work over frames so the page stays responsive
    requestAnimationFrame(() => drawScaled(c, TILE, A.dots(t)));
  });
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;

function traitsForSeed(seed) {
  return A.fromSeed(seed === "" ? randomSeed() : seed, { locks: state.locks });
}

function applyLocks(t) {
  return { ...t, ...state.locks };
}

// Unique variations: no two tiles look the same
function uniqueSet(n, seedFn) {
  const seen = new Set();
  const out = [];
  let tries = 0;
  while (out.length < n && tries < n * 50) {
    const t = A.fromSeed(seedFn(tries++), { locks: state.locks });
    const k = A.encode(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function shuffleGallery() {
  const base = randomSeed();
  state.gallery = uniqueSet(GALLERY_SIZE, i => (base + i * 2654435761) >>> 0);
  renderGallery();
  renderHero();
}

function updateCurrent() {
  state.current = state.seed.startsWith("#") && A.decode(state.seed)
    ? applyLocks(A.decode(state.seed))
    : traitsForSeed(state.seed);
  renderHero();
}

// ---------------------------------------------------------------------------
// Parts panel
// ---------------------------------------------------------------------------

const selects = {};

function buildParts() {
  const host = $("parts");
  for (const p of A.PARTS.filter(p => !p.hidden)) {
    const row = document.createElement("label");
    row.className = "part";
    const name = document.createElement("span");
    name.textContent = p.label;
    const sel = document.createElement("select");
    sel.appendChild(new Option("Auto", ""));
    for (const o of p.options) sel.appendChild(new Option(o.label, o.id));
    sel.addEventListener("change", () => {
      if (sel.value) state.locks[p.key] = sel.value;
      else delete state.locks[p.key];
      sel.classList.toggle("locked", !!sel.value);
      state.current = applyLocks(state.current);
      if (!sel.value) updateCurrent();
      shuffleGallery();
    });
    selects[p.key] = sel;
    row.append(name, sel);
    host.appendChild(row);
  }
}

// "Auto" shows what auto picked for the current avatar
function syncPartLabels() {
  for (const p of A.PARTS.filter(p => !p.hidden)) {
    const sel = selects[p.key];
    const o = p.options.find(o => o.id === state.current[p.key]);
    sel.options[0].textContent = "Auto · " + (o ? o.label : "–");
  }
}

function updateReadout() {
  $("dotReadout").textContent =
    A.comboCount().toLocaleString() + " combinations";
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function pngBlob(t, px) {
  return new Promise(resolve => {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    A.draw(c.getContext("2d"), px, t);
    c.toBlob(resolve, "image/png");
  });
}

const fileName = t => "twin-avatar-" + A.encode(t);

function setStatus(msg) { $("exportStatus").textContent = msg; }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load " + src));
    document.head.appendChild(s);
  });
}

async function exportSet() {
  const n = Math.max(1, Math.min(2000, parseInt($("setCount").value) || 100));
  const btn = $("exportSet");
  btn.disabled = true;
  try {
    if (!window.JSZip) { setStatus("Loading zip library…"); await loadScript(JSZIP_URL); }
    const base = randomSeed();
    const set = uniqueSet(n, i => (base + i * 2654435761) >>> 0);
    const zip = new JSZip();
    const rows = ["code," + A.PARTS.map(p => p.key).join(",")];
    for (let i = 0; i < set.length; i++) {
      const t = set[i], name = fileName(t);
      zip.file("svg/" + name + ".svg", A.svg(t));
      zip.file("png/" + name + ".png", await pngBlob(t, SET_PX));
      rows.push(A.encode(t) + "," + A.PARTS.map(p => t[p.key]).join(","));
      if (i % 10 === 0) setStatus(`Rendering ${i + 1} of ${set.length}…`);
    }
    zip.file("avatars.csv", rows.join("\n") + "\n");
    setStatus("Zipping…");
    download(await zip.generateAsync({ type: "blob" }), `twin-avatars-${set.length}.zip`);
    setStatus(set.length < n
      ? `Downloaded ${set.length}: that's every unique avatar with these locks.`
      : `Downloaded ${set.length} unique avatars.`);
  } catch (e) {
    setStatus(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  buildParts();
  updateReadout();

  $("seedInput").addEventListener("input", e => {
    state.seed = e.target.value.trim();
    updateCurrent();
  });
  $("randomBtn").addEventListener("click", () => {
    state.seed = "";
    $("seedInput").value = "";
    updateCurrent();
  });
  $("copyCode").addEventListener("click", async () => {
    const code = "#" + A.encode(state.current);
    try { await navigator.clipboard.writeText(code); setStatus("Copied " + code); }
    catch { setStatus(code); }
  });
  $("unlockAll").addEventListener("click", () => {
    state.locks = {};
    for (const sel of Object.values(selects)) { sel.value = ""; sel.classList.remove("locked"); }
    updateCurrent();
    shuffleGallery();
  });
  $("shuffleBtn").addEventListener("click", shuffleGallery);
  const showSource = on => {
    if (on) for (const c of document.querySelectorAll(".hero canvas[data-size]")) drawSource(c, parseInt(c.dataset.size), state.current);
    else renderHero();
  };
  const cmp = $("compareBtn");
  cmp.addEventListener("pointerdown", () => showSource(true));
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) cmp.addEventListener(ev, () => showSource(false));
  $("exportPng").addEventListener("click", async () => {
    download(await pngBlob(state.current, EXPORT_PX), fileName(state.current) + ".png");
  });
  $("exportSvg").addEventListener("click", () => {
    download(new Blob([A.svg(state.current)], { type: "image/svg+xml" }), fileName(state.current) + ".svg");
  });
  $("exportSet").addEventListener("click", exportSet);

  updateCurrent();
  shuffleGallery();
}

init();
