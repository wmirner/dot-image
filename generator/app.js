/* Twin Avatars — UI around avatar.js */

"use strict";

const A = window.TwinAvatar;
const GALLERY_SIZE = 40;
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
    c.classList.add("ready");
  }
  const code = "#" + A.encode(state.current);
  $("codeLabel").textContent = code;
  $("codeLabel").setAttribute("aria-label", "Copy avatar code " + code);
  syncPartLabels();
  for (const [i, b] of [...$("gallery").children].entries()) {
    b.classList.toggle("active", A.encode(state.gallery[i]) === A.encode(state.current));
  }
}

const FLIP_MS = 380;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let galleryRun = 0;

// Coin flip: turn edge-on, swap in the new face, turn back
function flipTile(b, next) {
  if (reduceMotion.matches) { b.replaceChildren(next); return; }
  const half = FLIP_MS / 2;
  const out = b.animate([
    { transform: "perspective(320px) rotateY(0deg) scale(1)" },
    { transform: "perspective(320px) rotateY(90deg) scale(1.08)" },
  ], { duration: half, easing: "cubic-bezier(.55, 0, 1, .45)", fill: "forwards" });
  out.onfinish = () => {
    b.replaceChildren(next);
    out.cancel();
    b.animate([
      { transform: "perspective(320px) rotateY(-90deg) scale(1.08)" },
      { transform: "perspective(320px) rotateY(0deg) scale(1)" },
    ], { duration: half, easing: "cubic-bezier(0, .55, .45, 1)" });
  };
}

// Tiles render in a random order with small random gaps, so they flip over
// one by one as if each avatar finishes generating at its own pace
function renderGallery() {
  const g = $("gallery");
  const run = ++galleryRun;
  const flip = g.children.length === state.gallery.length;
  if (!flip) {
    g.replaceChildren();
    state.gallery.forEach((_, i) => {
      const b = document.createElement("button");
      b.addEventListener("click", () => {
        const t = state.gallery[i];
        state.current = { ...t };
        state.seed = "#" + A.encode(t);
        $("seedInput").value = state.seed;
        renderHero();
      });
      g.appendChild(b);
    });
  }
  const order = state.gallery.map((_, i) => i).sort(() => Math.random() - 0.5);
  let at = 0;
  for (const i of order) {
    at += 8 + Math.random() * 30;
    setTimeout(() => {
      if (run !== galleryRun) return;
      const t = state.gallery[i], b = g.children[i];
      const c = document.createElement("canvas");
      drawScaled(c, b.clientWidth || 80, A.dots(t, A.portrait(t, { res: 125 })));
      c.style.width = c.style.height = "";   // let the grid size it
      b.classList.add("ready");
      b.title = "#" + A.encode(t);
      if (flip) flipTile(b, c);
      else b.replaceChildren(c);
    }, at);
  }
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;

function traitsForSeed(seed) {
  return A.fromSeed(seed === "" ? randomSeed() : seed, { locks: state.locks });
}

function applyLocks(t) {
  const out = { ...t, ...state.locks };
  // same rule as fromSeed: facial hair locked on its own steers presentation
  // away from Feminine
  if (out.facial !== "none" && out.presentation === "fem" && !state.locks.presentation) out.presentation = "andro";
  return out;
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
    sel.appendChild(new Option("Random", ""));
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

// "Random" shows what the seed picked for the current avatar
function syncPartLabels() {
  for (const p of A.PARTS.filter(p => !p.hidden)) {
    const sel = selects[p.key];
    const o = p.options.find(o => o.id === state.current[p.key]);
    sel.options[0].textContent = "Random · " + (o ? o.label : "–");
  }
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

// Brief note under the code after copying
let copiedTimer = 0;
function showNote(msg) {
  const note = $("copiedNote");
  note.textContent = msg;
  note.classList.add("show");
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => note.classList.remove("show"), 1600);
}

// When the cursor bubble is up, it confirms the copy in place; otherwise
// (sidebar button, keyboard) the note under the code does
let tipTimer = 0;
async function copyText(text, done) {
  let msg = done;
  try { await navigator.clipboard.writeText(text); }
  catch { msg = "Couldn't copy"; }
  const tip = $("cursorTip");
  if (tip.classList.contains("show")) {
    tip.textContent = msg;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tip.textContent = tip.dataset.label; }, 1400);
  } else {
    showNote(msg);
  }
}

const copyCode = () => copyText("#" + A.encode(state.current), "Avatar code copied");
// SVG as text pastes straight into Figma and code as vectors, at the size
// of the preview that was clicked (160, 80 or 40)
const copySvg = e => {
  const size = parseInt(e.target.closest("canvas")?.dataset.size) || 160;
  copyText(A.svg(state.current, { size }), `SVG copied at ${size}px`);
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  buildParts();
  $("dotReadout").textContent = A.comboCount().toLocaleString() + " combinations";

  $("seedInput").addEventListener("input", e => {
    state.seed = e.target.value.trim();
    updateCurrent();
  });
  $("randomBtn").addEventListener("click", () => {
    state.seed = "";
    $("seedInput").value = "";
    updateCurrent();
  });
  $("copyCode").addEventListener("click", copyCode);
  $("codeLabel").addEventListener("click", copyCode);
  $("copySvg").addEventListener("click", copySvg);
  // a bubble rides along with the cursor over the top avatars and the code
  const tip = $("cursorTip");
  const follow = (el, label) => {
    el.addEventListener("pointerenter", () => {
      clearTimeout(tipTimer);
      tip.textContent = tip.dataset.label = label;
    });
    el.addEventListener("pointermove", e => {
      tip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 18}px)`;
      tip.classList.add("show");
    });
    el.addEventListener("pointerleave", () => tip.classList.remove("show"));
  };
  for (const c of document.querySelectorAll(".hero .avatar")) follow(c, "Copy SVG");
  follow($("codeLabel"), "Copy code");
  $("unlockAll").addEventListener("click", () => {
    state.locks = {};
    for (const sel of Object.values(selects)) { sel.value = ""; sel.classList.remove("locked"); }
    updateCurrent();
    shuffleGallery();
  });
  $("shuffleBtn").addEventListener("click", shuffleGallery);
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
