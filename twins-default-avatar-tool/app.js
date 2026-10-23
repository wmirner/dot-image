/* Twin Avatars — UI around avatar.js: a grid of avatars, parts as filters */

"use strict";

const A = window.TwinAvatar;
const GRID_SIZE = 48;
const SET_PX = 1000;
const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

const state = {
  size: 120,           // tile size in px; copies are made at this size too
  locks: {},           // part key -> option id
  grid: [],            // traits per tile
  pinned: null,        // avatar restored from a code, shown on its own
  selecting: false,    // selection mode: clicking a tile selects it
  selected: new Set(), // indices of selected tiles, used by export
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

const FLIP_MS = 380;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let gridRun = 0;

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
// `keep`: indices to leave untouched (selected avatars during a shuffle)
function renderGrid(keep = new Set()) {
  const g = $("grid");
  const run = ++gridRun;
  const flip = g.children.length === state.grid.length;
  if (!flip) {
    g.replaceChildren();
    // each tile: the avatar (click to copy its SVG) and its code below
    // (click to copy the code, to bring the avatar back later)
    state.grid.forEach((_, i) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      const b = document.createElement("button");
      b.setAttribute("aria-label", "Copy avatar SVG");
      b.addEventListener("click", e => {
        if (state.selecting) toggleSelected(i);
        else copy(A.svg(state.grid[i], { size: state.size }), `SVG copied at ${state.size}px`, b, e.detail === 0);
      });
      followTip(b, () => !state.selecting ? "Copy SVG" : state.selected.has(i) ? "Deselect" : "Select");
      const code = document.createElement("button");
      code.className = "code";
      code.addEventListener("click", e =>
        copy("#" + A.encode(state.grid[i]), "Code copied", code, e.detail === 0));
      followTip(code, "Copy code");
      tile.append(b, code);
      g.appendChild(tile);
    });
  }
  const order = state.grid.map((_, i) => i).filter(i => !keep.has(i)).sort(() => Math.random() - 0.5);
  let at = 0;
  for (const i of order) {
    at += 8 + Math.random() * 24;
    setTimeout(() => {
      if (run !== gridRun) return;
      const t = state.grid[i], tile = g.children[i], b = tile.firstChild, code = tile.lastChild;
      code.textContent = "#" + A.encode(t);
      code.setAttribute("aria-label", "Copy code " + code.textContent);
      const c = document.createElement("canvas");
      drawScaled(c, state.size, A.dots(t, A.portrait(t, { res: state.size > 120 ? 250 : 125 })));
      b.classList.add("ready");
      if (flip) flipTile(b, c);
      else b.replaceChildren(c);
    }, at);
  }
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;

// Unique avatars for the current filters: no two alike
function uniqueSet(n, seedFn, exclude = []) {
  const seen = new Set([...(state.pinned ? [state.pinned] : []), ...exclude].map(A.encode));
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

// A fresh grid for the current filters, or just the avatar a code names
function generate() {
  clearSelection();   // new avatars, so the old selection no longer applies
  const base = randomSeed();
  state.grid = state.pinned ? [state.pinned] : uniqueSet(GRID_SIZE, i => (base + i * 2654435761) >>> 0);
  renderGrid();
}

function clearCode() {
  state.pinned = null;
  state.gridBeforeCode = null;
  $("seedInput").value = "";
  $("seedInput").classList.remove("invalid");
}

// Switch tile size: every avatar stays in its cell and scales in place,
// then redraws sharply at the new size once the transition ends
const RESIZE_MS = 220;
let resizeTimer = 0;

function showSize(size) {
  state.size = size;
  for (const b of $("sizes").children) b.setAttribute("aria-checked", String(+b.dataset.size === size));
  $("grid").style.setProperty("--tile", size + "px");
}

function setSize(size) {
  showSize(size);
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const run = ++gridRun;
    [...$("grid").children].forEach((tile, i) => setTimeout(() => {
      if (run !== gridRun) return;
      const c = document.createElement("canvas");
      const t = state.grid[i];
      drawScaled(c, size, A.dots(t, A.portrait(t, { res: size > 120 ? 250 : 125 })));
      tile.firstChild.replaceChildren(c);
    }, i * 4));
  }, RESIZE_MS);
}

// In select mode, Shuffle replaces everything except the selected avatars,
// which keep their place (and stay selected)
function shuffleUnselected() {
  const keep = state.selected;
  const base = randomSeed();
  const kept = state.grid.filter((_, i) => keep.has(i));
  const fresh = uniqueSet(state.grid.length - keep.size, i => (base + i * 2654435761) >>> 0, kept);
  let k = 0;
  state.grid = state.grid.map((t, i) => keep.has(i) ? t : fresh[k++] || t);
  renderGrid(keep);
}

// ---------------------------------------------------------------------------
// Parts panel: filters for the whole grid
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
    sel.appendChild(new Option("All", ""));
    for (const o of p.options) sel.appendChild(new Option(o.label, o.id));
    sel.addEventListener("change", () => {
      if (sel.value) state.locks[p.key] = sel.value;
      else delete state.locks[p.key];
      sel.classList.toggle("locked", !!sel.value);
      syncFilterLabel();
      clearCode();
      generate();
    });
    selects[p.key] = sel;
    row.append(name, sel);
    host.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Phones: filters live in a bottom sheet
// ---------------------------------------------------------------------------

function syncFilterLabel() {
  const n = Object.keys(state.locks).length;
  $("filterBtn").textContent = n ? `Filter · ${n}` : "Filter";
}

function setSheet(open) {
  $("sheet").classList.toggle("open", open);
  $("sheetBackdrop").hidden = !open;
  if (open) $("closeSheet").focus();
  else $("filterBtn").focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

// Bubble that follows the cursor over the tiles; it also confirms copies
const tip = () => $("cursorTip");
let tipTimer = 0;

// `label` is a string or a function, so it can follow the current mode
function followTip(el, label) {
  const text = () => (typeof label === "function" ? label() : label);
  el.addEventListener("pointerenter", () => {
    clearTimeout(tipTimer);
    tip().textContent = tip().dataset.label = text();
  });
  el.addEventListener("click", () => {
    if (state.selecting) tip().textContent = tip().dataset.label = text();
  });
  el.addEventListener("pointermove", e => {
    tip().style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 18}px)`;
    tip().classList.add("show");
  });
  el.addEventListener("pointerleave", () => tip().classList.remove("show"));
}

// Copy and confirm in the bubble. SVG as text pastes straight into Figma
// and code as vectors.
async function copy(text, done, el, fromKeyboard) {
  let msg = done;
  try { await navigator.clipboard.writeText(text); }
  catch { msg = "Couldn't copy"; }
  const t = tip();
  if (fromKeyboard) {
    // no cursor: show the bubble under the element instead
    const r = el.getBoundingClientRect();
    t.style.transform = `translate(${r.left + r.width / 2 - 34}px, ${r.bottom + 6}px)`;
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    t.textContent = t.dataset.label || "Copy SVG";
    if (fromKeyboard) t.classList.remove("show");
  }, 1400);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function toggleSelected(i) {
  if (state.selected.has(i)) state.selected.delete(i);
  else state.selected.add(i);
  syncSelection();
}

function setSelecting(on) {
  state.selecting = on;
  $("selectToggle").setAttribute("aria-pressed", String(on));
  $("selectToggle").textContent = on ? "Done" : "Select";
  $("selectTools").hidden = !on;
  // while selecting, export is about the selection, so hide the new-set pill
  document.querySelector(".set-pill").hidden = on;
  // leaving select mode drops the selection, so nothing stays marked
  if (!on) clearSelection();
}

function clearSelection() {
  state.selected.clear();
  syncSelection();
}

// tile marks, the count, and the export button all follow the selection
function syncSelection() {
  const n = state.selected.size;
  [...$("grid").children].forEach((tile, i) => tile.classList.toggle("selected", state.selected.has(i)));
  $("selCount").textContent = `${n} selected`;
  $("exportGrid").textContent = n ? `Download ${n} selected` : "Download grid";
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

// the status line shows only while there's something to say
let statusTimer = 0;
function setStatus(msg, clearAfter = 0) {
  clearTimeout(statusTimer);
  $("exportStatus").textContent = msg;
  $("exportStatus").parentElement.hidden = !msg;
  if (clearAfter) statusTimer = setTimeout(() => setStatus(""), clearAfter);
}

// set by the X while a download renders; checked between avatars
let exportCanceled = false;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load " + src));
    document.head.appendChild(s);
  });
}

// Zip of SVGs and PNGs plus a CSV of codes and traits
async function exportZip(set, btn, name) {
  btn.disabled = true;
  exportCanceled = false;
  $("cancelExport").hidden = false;
  try {
    if (!window.JSZip) { setStatus("Loading zip library…"); await loadScript(JSZIP_URL); }
    const zip = new JSZip();
    const rows = ["code," + A.PARTS.map(p => p.key).join(",")];
    for (let i = 0; i < set.length; i++) {
      if (exportCanceled) { setStatus("Download canceled.", 3000); return; }
      const t = set[i], file = fileName(t);
      zip.file("svg/" + file + ".svg", A.svg(t));
      zip.file("png/" + file + ".png", await pngBlob(t, SET_PX));
      rows.push(A.encode(t) + "," + A.PARTS.map(p => t[p.key]).join(","));
      if (i % 10 === 0) setStatus(`Rendering ${i + 1} of ${set.length}…`);
    }
    zip.file("avatars.csv", rows.join("\n") + "\n");
    setStatus("Zipping…");
    const blob = await zip.generateAsync({ type: "blob" });
    if (exportCanceled) { setStatus("Download canceled.", 3000); return; }
    download(blob, name(set.length));
    setStatus(`Downloaded ${set.length} avatars.`, 4000);
  } catch (e) {
    setStatus(e.message, 6000);
  } finally {
    btn.disabled = false;
    $("cancelExport").hidden = true;
  }
}

function exportSet() {
  const n = Math.max(1, Math.min(2000, parseInt($("setCount").value) || 100));
  const base = randomSeed();
  const set = uniqueSet(n, i => (base + i * 2654435761) >>> 0);
  exportZip(set, $("exportSet"), k => `twin-avatars-${k}.zip`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  buildParts();

  for (const b of $("sizes").children) b.addEventListener("click", () => setSize(+b.dataset.size));

  $("generateBtn").addEventListener("click", () => {
    if (state.selected.size && !state.pinned) shuffleUnselected();
    else { clearCode(); generate(); }
  });

  // paste an avatar code (with or without #): that exact avatar leads the grid
  $("seedInput").addEventListener("input", e => {
    const v = e.target.value.trim();
    const t = v ? A.decode(v) : null;
    e.target.classList.toggle("invalid", !!v && !t);
    if (t) {
      if (!state.pinned) state.gridBeforeCode = state.grid;
      state.pinned = t;
      generate();
    } else if (state.pinned) {
      // code removed or no longer valid: back to the grid from before
      state.pinned = null;
      state.grid = state.gridBeforeCode || [];
      state.gridBeforeCode = null;
      if (state.grid.length) renderGrid(); else generate();
    }
  });

  $("unlockAll").addEventListener("click", () => {
    if (!Object.keys(state.locks).length) return;   // nothing set: leave the grid alone
    state.locks = {};
    for (const sel of Object.values(selects)) { sel.value = ""; sel.classList.remove("locked"); }
    syncFilterLabel();
    clearCode();
    generate();
  });

  // selected avatars when there are any, otherwise the whole grid
  $("exportGrid").addEventListener("click", () => {
    const picked = state.grid.filter((_, i) => state.selected.has(i));
    exportZip(picked.length ? picked : state.grid, $("exportGrid"),
      k => picked.length ? `twin-avatars-selected-${k}.zip` : `twin-avatars-grid-${k}.zip`);
  });

  $("selectToggle").addEventListener("click", () => setSelecting(!state.selecting));

  $("filterBtn").addEventListener("click", () => setSheet(true));
  $("closeSheet").addEventListener("click", () => setSheet(false));
  $("sheetBackdrop").addEventListener("click", () => setSheet(false));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && $("sheet").classList.contains("open")) setSheet(false);
  });
  $("shuffleMobile").addEventListener("click", () => $("generateBtn").click());
  $("selectAll").addEventListener("click", () => {
    state.grid.forEach((_, i) => state.selected.add(i));
    syncSelection();
  });
  $("deselectAll").addEventListener("click", clearSelection);
  $("exportSet").addEventListener("click", exportSet);
  $("cancelExport").addEventListener("click", () => { exportCanceled = true; });

  showSize(state.size);
  generate();
}

init();
