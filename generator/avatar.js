/* Twin Avatar — generative Twin avatars that read like dotted photos.
 *
 * Each avatar is a set of traits, one option per part (head, skin, hair,
 * pose, light, …). The traits paint a synthetic grayscale "photo": a softly
 * lit head with soft features, hair texture and clothes on a plain light
 * wall. That photo then goes through the photo tool's exact dot
 * pipeline (hex grid, area sampling, duotone, darker = bigger), so a
 * generated avatar sits next to an uploaded one.
 *
 * Standalone and DOM-free:
 *   const t = TwinAvatar.fromSeed("twin_8c1f");   // same seed, same avatar
 *   TwinAvatar.svg(t);  TwinAvatar.draw(ctx, 512, t);
 *   TwinAvatar.encode(t) -> "0K3P9Q0A", decode() turns it back into traits
 */

(function (root) {
"use strict";

// ---------------------------------------------------------------------------
// Look — identical to the photo tool's fixed Twins state
// ---------------------------------------------------------------------------

const SIZE = 1000;                     // avatar is SIZE x SIZE units
const SPACING = 52;                    // hex grid spacing
const DOT_SIZE = 50;                   // base dot diameter
const SIZE_RANGE = 0.65;               // share of the size darkness controls
const BG = "#F9F4EB";
const RES = 250;                       // portrait raster, px per side
const PX = SIZE / RES;                 // units per raster px

const DARK = "#0021CC", LIGHT = "#E2E4F4";    // duotone ends

// ---------------------------------------------------------------------------
// Parts catalog. Order is the digit order of the avatar code: add new
// options at the end of a list so existing codes keep their meaning.
// `w` weights random picks.
// ---------------------------------------------------------------------------

const opt = (id, label, w = 1) => ({ id, label, w });

// Visible parts are the ones you'd use to describe someone. Hidden parts
// vary the "photo" (bone structure, pose, light) and are only ever
// picked from the seed, so no two Twins look alike.
const PARTS = [
  { key: "length", label: "Hair length", options: [
    opt("bald", "Bald", 0.5), opt("short", "Short", 3), opt("medium", "Medium", 2),
    opt("long", "Long", 2) ] },
  { key: "texture", label: "Hair texture", options: [
    opt("straight", "Straight", 2), opt("wavy", "Wavy"), opt("curly", "Curly") ] },
  { key: "hairTone", label: "Hair color", options: [
    opt("black", "Black", 2), opt("dark", "Dark brown", 2), opt("brown", "Brown"),
    opt("blonde", "Blonde"), opt("grey", "Grey", 0.6) ] },
  { key: "skin", label: "Skin tone", options: [
    opt("1", "Very light"), opt("2", "Light"), opt("3", "Medium"),
    opt("4", "Tan"), opt("5", "Deep") ] },
  { key: "mouth", label: "Expression", options: [
    opt("neutral", "Neutral"), opt("soft", "Slight smile", 2), opt("smile", "Smile", 2),
    opt("grin", "Big smile") ] },
  { key: "facial", label: "Facial hair", options: [
    opt("none", "None", 6), opt("stubble", "Stubble"), opt("mustache", "Mustache", 0.5),
    opt("goatee", "Goatee", 0.6), opt("beard", "Beard") ] },
  { key: "extra", label: "Accessory", options: [
    opt("none", "None", 5), opt("glasses", "Glasses"), opt("bold", "Bold glasses"),
    opt("shades", "Sunglasses", 0.4), opt("earrings", "Earrings"),
    opt("headphones", "Headphones", 0.5), opt("beanie", "Beanie", 0.6), opt("cap", "Cap", 0.5) ] },
  { key: "top", label: "Top", options: [
    opt("crew", "T-shirt", 2), opt("vneck", "V neck"), opt("collar", "Collared shirt"),
    opt("hoodie", "Hoodie"), opt("turtle", "Turtleneck"), opt("blazer", "Blazer") ] },

  // hidden: picked from the seed only
  { key: "cut", hidden: true, options: ["a", "b", "c"].map(id => opt(id, id)) },
  { key: "head", hidden: true, options: ["round", "oval", "soft", "wide", "long"].map(id => opt(id, id)) },
  { key: "eyes", hidden: true, options: [opt("avg", "", 2), opt("deep", ""), opt("wide", ""), opt("close", "")] },
  { key: "brows", hidden: true, options: [opt("thin", ""), opt("natural", "", 2), opt("thick", "")] },
  { key: "nose", hidden: true, options: [opt("narrow", ""), opt("avg", "", 2), opt("broad", "")] },
  { key: "topTone", hidden: true, options: [opt("white", ""), opt("light", ""), opt("mid", ""), opt("dark", "", 1.5), opt("black", "")] },
  { key: "pose", hidden: true, options: [opt("l2", "", 0.6), opt("l1", ""), opt("front", "", 1.4), opt("r1", ""), opt("r2", "", 0.6)] },
  { key: "light", hidden: true, options: ["left", "right", "top", "soft"].map(id => opt(id, "")) },
];

// Hair shape from length + texture; the hidden `cut` picks among them
const STYLES = {
  short:  { straight: ["crop", "part", "quiff", "buzz"], wavy: ["part", "quiff", "crop"], curly: ["curly", "hightop", "buzz"] },
  medium: { straight: ["bob", "bun", "bob"], wavy: ["bob", "bun", "wavyBob"], curly: ["afro", "puffs", "curly"] },
  long:   { straight: ["long", "pony", "long"], wavy: ["wavy", "pony", "wavy"], curly: ["wavy", "afro", "pony"] },
};
function hairStyle(t) {
  if (t.length === "bald") return "none";
  const list = (STYLES[t.length] || STYLES.short)[t.texture] || STYLES.short.straight;
  return list["abc".indexOf(t.cut) % list.length] || list[0];
}

const PART = Object.fromEntries(PARTS.map(p => [p.key, p]));

// ---------------------------------------------------------------------------
// Seeds, picking, codes
// ---------------------------------------------------------------------------

function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick(options, rnd) {
  let total = 0;
  for (const o of options) total += o.w;
  let x = rnd() * total;
  for (const o of options) { if ((x -= o.w) < 0) return o.id; }
  return options[options.length - 1].id;
}

// Traits from a seed (string or number). `locks` pins parts to an option id.
function fromSeed(seed, { locks = {} } = {}) {
  const rnd = mulberry32(typeof seed === "number" ? seed : hashString(String(seed)));
  const t = {};
  for (const p of PARTS) {
    const picked = weightedPick(p.options, rnd); // always draw, so locks don't shift other parts
    t[p.key] = locks[p.key] || picked;
  }
  return t;
}

const CODE_LEN = 8;

function encode(t) {
  let n = 0;
  for (const p of PARTS) {
    const i = Math.max(0, p.options.findIndex(o => o.id === t[p.key]));
    n = n * p.options.length + i;
  }
  return n.toString(36).toUpperCase().padStart(CODE_LEN, "0");
}

function decode(code) {
  let n = parseInt(String(code).replace(/^#/, ""), 36);
  if (!Number.isFinite(n) || n < 0 || n >= comboCount()) return null;
  const t = {};
  for (let k = PARTS.length - 1; k >= 0; k--) {
    const p = PARTS[k];
    t[p.key] = p.options[n % p.options.length].id;
    n = Math.floor(n / p.options.length);
  }
  return t;
}

function comboCount() {
  return PARTS.reduce((n, p) => n * p.options.length, 1);
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

const hyp = Math.hypot;
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const mix = (a, b, k) => a + (b - a) * k;
const sstep = (a, b, v) => { const k = clamp01((v - a) / (b - a)); return k * k * (3 - 2 * k); };
// soft coverage of a signed distance with a feather in units
const cover = (d, f) => sstep(f, -f, d);
const gauss = (dx, dy, sx, sy) => Math.exp(-0.5 * ((dx * dx) / (sx * sx) + (dy * dy) / (sy * sy)));

function hash2(i, j, s) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Shapes as signed distances (negative inside), in units
const circle = (cx, cy, r) => (x, y) => hyp(x - cx, y - cy) - r;
const above = yy => (x, y) => y - yy;
const below = yy => (x, y) => yy - y;
function blob(cx, cy, rx, ry, n = 2) {
  const m = Math.min(rx, ry);
  return (x, y) => {
    const u = Math.abs(x - cx) / rx, v = Math.abs(y - cy) / ry;
    const k = n === 2 ? hyp(u, v) : Math.pow(Math.pow(u, n) + Math.pow(v, n), 1 / n);
    return (k - 1) * m;
  };
}
function capsule(ax, ay, bx, by, r) {
  const dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy || 1;
  return (x, y) => {
    const h = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / dd));
    return hyp(x - ax - dx * h, y - ay - dy * h) - r;
  };
}
function poly(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  const s = area > 0 ? 1 : -1;
  const edges = pts.map(([x0, y0], i) => {
    const [x1, y1] = pts[(i + 1) % pts.length];
    const l = hyp(x1 - x0, y1 - y0);
    return [x0, y0, (y1 - y0) / l * s, -(x1 - x0) / l * s];
  });
  return (x, y) => {
    let d = -Infinity;
    for (const [x0, y0, nx, ny] of edges) d = Math.max(d, (x - x0) * nx + (y - y0) * ny);
    return d;
  };
}
const union = (...fs) => (x, y) => { let d = Infinity; for (const f of fs) d = Math.min(d, f(x, y)); return d; };
const inter = (...fs) => (x, y) => { let d = -Infinity; for (const f of fs) d = Math.max(d, f(x, y)); return d; };
const minus = (a, b) => (x, y) => Math.max(a(x, y), -b(x, y));
const grow = (f, g) => (x, y) => f(x, y) - g;

// Lambert shading of an ellipsoid bump at (x, y)
function shadeEllipsoid(x, y, cx, cy, rx, ry, L, amb) {
  const u = (x - cx) / rx, v = (y - cy) / ry;
  const k = Math.min(0.98, u * u + v * v);
  const nz = Math.sqrt(1 - k);
  const dot = (u * L[0] + v * L[1] + nz * L[2]);
  return amb + (1 - amb) * Math.max(0, dot);
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const HEADS = {
  round: { rx: 150, ry: 168, n: 2 },
  oval:  { rx: 138, ry: 178, n: 2 },
  soft:  { rx: 148, ry: 170, n: 3 },
  wide:  { rx: 162, ry: 162, n: 2.3 },
  long:  { rx: 134, ry: 186, n: 2.4 },
};
const SKIN = { 1: 0.94, 2: 0.84, 3: 0.7, 4: 0.56, 5: 0.4 };
const HAIR_LUM = { black: 0.05, dark: 0.12, brown: 0.26, blonde: 0.56, grey: 0.62 };
const TOP_LUM = { white: 0.95, light: 0.78, mid: 0.52, dark: 0.26, black: 0.1 };
const YAW = { l2: -0.32, l1: -0.15, front: 0, r1: 0.15, r2: 0.32 };
const LIGHTS = {
  left:  [-0.62, -0.38, 0.69],
  right: [0.62, -0.38, 0.69],
  top:   [0.12, -0.72, 0.68],
  soft:  [-0.2, -0.25, 0.95],
};
const HEAD_SCALE = 1.38;   // same head size in every avatar
const HEAD_AREA = 25000;   // face shapes are normalized to this rx * ry
const WALL = 0.88;
const AMB = { left: 0.42, right: 0.42, top: 0.45, soft: 0.62 };

// ---------------------------------------------------------------------------
// Portrait: a grayscale "photo" built from traits
// ---------------------------------------------------------------------------
//
// Each op reads and writes a pixel record p = { x, y, hx, hy, lum, back }:
// x,y in image units, hx,hy in the head's own (tilted) frame, lum 0 dark to
// 1 light, back = how much of the pixel is backdrop.

function scene(t) {
  const rnd = mulberry32(hashString(encode(t)));
  const j = (amt) => (rnd() - 0.5) * 2 * amt;    // jitter in [-amt, amt]

  const L = LIGHTS[t.light] || LIGHTS.left;
  const amb = AMB[t.light] ?? 0.45;
  const ln = hyp(...L);
  const LV = [L[0] / ln, L[1] / ln, L[2] / ln];
  const lightSide = Math.sign(LV[0]) || -1;
  const yaw = (YAW[t.pose] ?? 0) + j(0.04);
  const scale = HEAD_SCALE;
  const H = HEADS[t.head] || HEADS.round;
  // shapes differ in proportion only, never in size
  const norm = Math.sqrt(HEAD_AREA / (H.rx * H.ry));
  const rx = H.rx * norm * scale, ry = H.ry * norm * scale;
  const cx = 500 + j(6) - yaw * 20;
  const cy = 470 + j(5);
  const tilt = j(0.035) + yaw * 0.05;
  const exposure = 1 + j(0.06);

  const skin = SKIN[t.skin] ?? 0.84;
  const hairLum = HAIR_LUM[t.hairTone] ?? 0.1;
  const browLum = Math.min(hairLum, 0.32) * (skin < 0.5 ? 0.6 : 1);
  const topLum = TOP_LUM[t.topTone] ?? 0.26;
  const seed = hashString(encode(t));

  // features, in the head frame; yaw slides them toward the turned side and
  // foreshortens the far half of the face
  const fx = cx + yaw * rx * 0.55;
  const sepBase = { wide: 0.43, close: 0.33 }[t.eyes] ?? 0.38;
  const near = 1 + Math.abs(yaw) * 0.25, far = 1 - Math.abs(yaw) * 0.9;
  const eL = fx - sepBase * rx * (yaw > 0 ? near : far);
  const eR = fx + sepBase * rx * (yaw > 0 ? far : near);
  const ey = cy + ry * 0.02 + j(6);
  const by = ey - ry * 0.2;
  const noseY = ey + ry * 0.36;
  const my = ey + ry * 0.6;
  const mw = rx * 0.3;
  const noseW = { narrow: 0.75, broad: 1.3 }[t.nose] ?? 1;

  const head = blob(cx, cy, rx, ry, H.n);
  const neckTop = cy + ry * 0.5, chin = cy + ry;
  const bodyTop = cy + ry + 38 * scale;
  const body = blob(500, bodyTop + 360 * scale, 400 * scale, 360 * scale, 2.6);
  const neckR = rx * 0.48;

  const cap = (g, c, dip) => inter(grow(head, g),
    (x, y) => y - (cy - ry * c + dip * ry * ((x - cx) / rx) ** 2));
  const style = hairStyle(t);
  const hairDef = HAIR[style] ? HAIR[style]({ hx: cx, hy: cy, rx, ry, head, cap, side: yaw >= 0 ? 1 : -1 }) : {};
  const curly = t.texture === "curly";

  const ops = [];

  // --- backdrop: the same plain light wall for every avatar --------------
  ops.push(p => { p.lum = WALL; p.back = 1; });

  // paint helper: blend toward `lumFn` by a soft mask
  const layer = (sdf, feather, lumFn, frame = "head") => ops.push(p => {
    const x = frame === "head" ? p.hx : p.x, y = frame === "head" ? p.hy : p.y;
    const d = sdf(x, y);
    if (d > feather) return;
    const a = cover(d, feather);
    if (a <= 0) return;
    p.lum = mix(p.lum, lumFn(x, y, d), a);
    p.back *= 1 - a;
  });

  const hairShade = (x, y) => {
    const s = shadeEllipsoid(x, y, cx, cy - ry * 0.15, rx * 1.3, ry * 1.25, LV, amb * 0.9);
    const grain = curly
      ? vnoise(x / 18, y / 18, seed) - 0.5
      : vnoise(x / 40, y / 9, seed) - 0.5;
    const sheen = curly || hairLum > 0.5 ? 0 :
      0.14 * gauss(x - (cx + lightSide * rx * 0.45), y - (cy - ry * 0.7), rx * 0.35, ry * 0.18);
    return clamp01(hairLum * (0.45 + 0.6 * s) + 0.1 * grain + sheen);
  };

  // --- behind the head -----------------------------------------------------
  if (t.top === "hoodie") {
    layer(inter(blob(cx, cy + 40, rx * 1.42, ry * 1.3), above(bodyTop + 80)), 8,
      (x, y) => topLum * (0.5 + 0.5 * shadeEllipsoid(x, y, cx, cy, rx * 1.42, ry * 1.3, LV, amb)));
  }
  if (hairDef.back) layer(hairDef.back, 6, (x, y) => hairShade(x, y) * 0.82);

  // neck with shadow under the chin
  layer(capsule(cx, neckTop, cx, bodyTop + 60, neckR), 4, (x, y) => {
    const u = clamp01(Math.abs(x - cx) / neckR);
    const s = amb + (1 - amb) * Math.max(0, (x - cx) / neckR * LV[0] + Math.sqrt(1 - u * u) * LV[2]);
    return skin * s * (0.5 + 0.5 * sstep(chin - 10, chin + ry * 0.45, y)) * 0.92;
  }, "img");

  // --- top -------------------------------------------------------------
  const folds = (x, y) => 0.06 * (vnoise(x / 70, y / 50, seed + 3) - 0.5);
  const bodyShade = (x, y, lum) =>
    clamp01(lum * (0.35 + 0.75 * shadeEllipsoid(x, y, 500, bodyTop + 360 * scale, 420 * scale, 380 * scale, LV, amb)) + folds(x, y));
  const neckline = {
    crew: circle(cx, bodyTop + 4, neckR * 1.05),
    vneck: poly([[cx - neckR * 1.05, bodyTop - 30], [cx + neckR * 1.05, bodyTop - 30], [cx, bodyTop + neckR * 2.4]]),
    collar: poly([[cx - neckR, bodyTop - 30], [cx + neckR, bodyTop - 30], [cx, bodyTop + neckR * 1.4]]),
    blazer: poly([[cx - neckR * 1.2, bodyTop - 30], [cx + neckR * 1.2, bodyTop - 30], [cx, bodyTop + neckR * 3.6]]),
  }[t.top];
  layer(neckline ? minus(body, neckline) : body, 4, (x, y) => bodyShade(x, y, topLum), "img");
  if (t.top === "blazer") {
    // shirt in the V, darker lapel edges
    const shirt = topLum > 0.6 ? 0.2 : 0.92;
    layer(inter(neckline, body), 4, (x, y) => bodyShade(x, y, shirt), "img");
    layer(minus(inter(grow(neckline, 22), body), neckline), 5, (x, y) => bodyShade(x, y, topLum * 0.7), "img");
  }
  if (t.top === "collar") {
    const flap = s => poly([[cx + s * 4, bodyTop + neckR * 1.3], [cx + s * neckR * 1.15, bodyTop - 26], [cx + s * neckR * 1.5, bodyTop + neckR * 0.9]]);
    layer(union(flap(-1), flap(1)), 3, (x, y) => bodyShade(x, y, Math.min(1, topLum * 1.08 + 0.04)), "img");
    layer(union(capsule(cx - neckR * 1.15, bodyTop - 20, cx - 4, bodyTop + neckR * 1.3, 4),
                capsule(cx + neckR * 1.15, bodyTop - 20, cx + 4, bodyTop + neckR * 1.3, 4)), 4,
      () => topLum * 0.55, "img");
  }
  if (t.top === "turtle") {
    layer(capsule(cx, chin - 10, cx, bodyTop + 40, neckR * 1.08), 4, (x, y) =>
      bodyShade(x, y, topLum) * (0.75 + 0.25 * sstep(chin, chin + 60, y)), "img");
  }
  if (t.top === "hoodie") {
    const s = topLum > 0.5 ? 0.3 : 0.85;
    layer(union(capsule(cx - neckR * 0.7, bodyTop + 30, cx - neckR * 0.75, bodyTop + 170, 6),
                capsule(cx + neckR * 0.7, bodyTop + 30, cx + neckR * 0.75, bodyTop + 150, 6)), 4, () => s, "img");
  }

  // --- head ------------------------------------------------------------
  const faceShade = (x, y) => shadeEllipsoid(x, y, cx + yaw * rx * 0.25, cy, rx * 1.05, ry * 1.05, LV, amb);
  const ears = union(blob(cx - rx * 0.97 + Math.max(0, yaw) * rx * 0.25, ey + ry * 0.1, rx * 0.16, ry * 0.2),
                     blob(cx + rx * 0.97 + Math.min(0, yaw) * rx * 0.25, ey + ry * 0.1, rx * 0.16, ry * 0.2));
  layer(ears, 4, (x, y) => skin * faceShade(x, y) * 0.88);
  layer(head, 4, (x, y) => skin * faceShade(x, y));

  // facial features darken / lighten the skin in place
  // `feature` ops (eyes, brows, nose, mouth) are diffused after rendering
  const face = (fn, feature = false) => {
    const op = p => {
      if (head(p.hx, p.hy) > 0) return;
      p.lum = fn(p.hx, p.hy, p.lum);
    };
    op.feature = feature;
    ops.push(op);
  };

  const deep = t.eyes === "deep" ? 0.55 : 0.4;
  face((x, y, lum) => {
    let k = 1;
    for (const ex of [eL, eR]) {
      const nearLight = Math.sign(ex - fx) === lightSide ? 0.8 : 1.1;
      k *= 1 - deep * nearLight * gauss(x - ex, y - ey + 4, rx * 0.22, ry * 0.13);  // socket
      k *= 1 - 0.85 * gauss(x - ex, y - ey, rx * 0.1, ry * 0.05);                // iris + lashes
    }
    // cheekbone light, temple shade
    k *= 1 + 0.05 * gauss(x - (fx + lightSide * rx * 0.45), y - (ey + ry * 0.28), rx * 0.2, ry * 0.12);
    return lum * k;
  }, true);

  // brows
  const browW = { thin: 0.03, natural: 0.04, thick: 0.055 }[t.brows] ?? 0.04;
  face((x, y, lum) => {
    let a = 0;
    for (const ex of [eL, eR]) {
      const out = Math.sign(ex - fx);
      const dy = y - (by - 0.08 * (x - ex) * -out * 0.3 + (out * (x - ex) > 0 ? 0.06 * Math.abs(x - ex) : 0));
      a = Math.max(a, gauss(x - ex, dy, rx * 0.17, ry * browW));
    }
    return mix(lum, browLum, 0.92 * a);
  }, true);

  // nose: shadow on the side away from the light, base shadow, tip highlight
  face((x, y, lum) => {
    const shadowX = fx - lightSide * rx * 0.08 * noseW + yaw * rx * 0.08;
    let k = 1 - 0.2 * gauss(x - shadowX, y - (noseY - ry * 0.14), rx * 0.05 * noseW, ry * 0.15);
    k *= 1 - 0.38 * gauss(x - fx - yaw * rx * 0.08, y - noseY - ry * 0.02, rx * 0.11 * noseW, ry * 0.035);
    k *= 1 + 0.07 * gauss(x - fx - yaw * rx * 0.1 - lightSide * rx * 0.03, y - noseY + ry * 0.05, rx * 0.05, ry * 0.05);
    return lum * k;
  }, true);

  // facial hair before the mouth so the lips still read
  const jaw = minus(inter(grow(head, 4), below(ey + ry * 0.38)), blob(fx, my - ry * 0.02, mw * 1.05, ry * 0.08));
  if (t.facial === "stubble") {
    face((x, y, lum) => lum * (1 - 0.24 * cover(jaw(x, y), 14) * (0.8 + 0.4 * vnoise(x / 8, y / 8, seed))));
  }
  if (t.facial === "beard") {
    layer(union(jaw, blob(fx, chin + 6, rx * 0.5, ry * 0.18)), 14, (x, y) =>
      clamp01(hairShade(x, y) * 0.9 + 0.1 * (vnoise(x / 10, y / 10, seed) - 0.5)));
  }
  if (t.facial === "goatee") {
    layer(blob(fx, my + ry * 0.22, rx * 0.2, ry * 0.18), 14, (x, y) => hairShade(x, y) * 0.95);
  }
  if (t.facial === "mustache" || t.facial === "goatee" || t.facial === "beard") {
    layer(blob(fx, my - ry * 0.075, mw * 0.95, ry * 0.045), 10, (x, y) => hairShade(x, y));
  }

  // mouth: lip line curve, lower lip shadow, teeth for a grin
  const curve = { neutral: 0, soft: 0.035, smile: 0.06, grin: 0.07 }[t.mouth] ?? 0.035;
  const mwide = { neutral: 0.9, soft: 1, smile: 1.1, grin: 1.15 }[t.mouth] ?? 1;
  face((x, y, lum) => {
    const dx = (x - fx) / (mw * mwide);
    if (Math.abs(dx) > 1.6) return lum;
    const env = Math.exp(-(dx ** 4));
    const lineY = my + curve * ry * (1 - dx * dx) * 0.6 - curve * ry * 0.3;
    let k = 1 - 0.65 * env * gauss(0, y - lineY, 1, ry * 0.03);
    k *= 1 - 0.18 * env * gauss(0, y - (my + ry * 0.09), 1, ry * 0.03);         // under lower lip
    k *= 1 - 0.12 * env * gauss(0, y - (my - ry * 0.03), 1, ry * 0.035);        // upper lip tone
    if (t.mouth === "grin") {
      const open = gauss(0, y - (lineY + ry * 0.012), 1, ry * 0.024) * Math.exp(-((dx * 1.25) ** 4));
      return mix(lum * k, 0.9, 0.85 * open);
    }
    return lum * k;
  }, true);

  // smile lines
  if (t.mouth === "smile" || t.mouth === "grin") {
    face((x, y, lum) => {
      let k = 1;
      for (const s of [-1, 1]) k *= 1 - 0.1 * gauss(x - (fx + s * mw * 1.25), y - (my - ry * 0.08), rx * 0.035, ry * 0.08);
      return lum * k;
    }, true);
  }

  // hair in front
  if (hairDef.front) layer(hairDef.front, 5, (x, y) => hairShade(x, y) * (style === "buzz" ? 1.25 : 1));

  // --- accessories -----------------------------------------------------
  const frameLum = 0.1;
  if (t.extra === "glasses" || t.extra === "bold" || t.extra === "shades") {
    const w = t.extra === "glasses" ? 4 : 8;
    const lens = ex => blob(ex, ey + 4, rx * 0.21, ry * 0.12, t.extra === "bold" ? 3.2 : 2.4);
    const lenses = union(lens(eL), lens(eR));
    if (t.extra === "shades") {
      layer(lenses, 4, (x, y) => 0.08 + 0.12 * gauss(x - (eL + lightSide * rx * 0.08), y - ey + 10, rx * 0.06, ry * 0.04));
    }
    const rim = (x, y) => Math.abs(lenses(x, y)) - w;
    const bridge = capsule(eL + rx * 0.2, ey, eR - rx * 0.2, ey, w * 0.8);
    layer(union(rim, bridge), 3, () => frameLum);
  }
  if (t.extra === "earrings") {
    layer(union(circle(cx - rx * 0.98, ey + ry * 0.36, 10), circle(cx + rx * 0.98, ey + ry * 0.36, 10)), 3, () => 0.95);
  }
  if (t.extra === "headphones") {
    const band = (x, y) => Math.abs(blob(cx, cy, rx + 26, ry + 26)(x, y)) - 12;
    layer(inter(band, above(cy - ry * 0.1)), 3, (x, y) => 0.12 + 0.18 * faceShade(x, y));
    const cups = union(blob(cx - rx - 12, ey + 14, 34, 58), blob(cx + rx + 12, ey + 14, 34, 58));
    layer(cups, 4, (x, y) => 0.08 + 0.16 * shadeEllipsoid(x, y, x < cx ? cx - rx : cx + rx, ey, 40, 60, LV, amb));
  }
  if (t.extra === "beanie") {
    const knit = topLum > 0.5 ? 0.22 : 0.72;
    const hat = inter(grow(head, 22), above(cy - ry * 0.42));
    layer(union(hat, blob(cx, cy - ry - 4, rx * 0.6, ry * 0.18)), 5, (x, y) =>
      clamp01(knit * (0.5 + 0.6 * shadeEllipsoid(x, y, cx, cy - ry * 0.4, rx * 1.15, ry * 0.9, LV, amb)) + 0.05 * Math.sin(x / 7)));
    layer(inter(grow(head, 26), above(cy - ry * 0.42), below(cy - ry * 0.6)), 4, (x, y) =>
      knit * 0.8 * (0.5 + 0.6 * faceShade(x, y)));
  }
  if (t.extra === "cap") {
    const capLum = topLum > 0.5 ? 0.18 : 0.8;
    face((x, y, lum) => lum * (1 - 0.35 * sstep(cy - ry * 0.15, cy - ry * 0.45, y)));  // brim shadow
    layer(inter(grow(head, 18), above(cy - ry * 0.48)), 4, (x, y) =>
      capLum * (0.55 + 0.55 * shadeEllipsoid(x, y, cx, cy - ry * 0.5, rx * 1.1, ry * 0.75, LV, amb)));
    layer(blob(cx + yaw * rx * 0.5, cy - ry * 0.47, rx * 1.05, ry * 0.07), 4, () => capLum * 0.75);
  }

  // camera: exposure and a soft vignette
  ops.push(p => {
    const r = hyp(p.x - 500, p.y - 500) / 707;
    p.lum = clamp01(p.lum * exposure * (1 - 0.1 * r * r));
  });

  return { ops, pivot: [cx, chin], tilt };
}

const HAIR = {
  buzz: ({ cap }) => ({ front: cap(4, 0.38, 0.4) }),
  crop: ({ cap }) => ({ front: cap(18, 0.38, 0.5) }),
  part: ({ hx, hy, rx, ry, cap, side }) => ({
    front: union(cap(20, 0.38, 0.5),
      inter(blob(hx + side * rx * 0.35, hy - ry * 0.68, rx * 0.88, ry * 0.4), above(hy - ry * 0.2))),
  }),
  quiff: ({ hx, hy, rx, ry, cap, side }) => ({
    front: union(cap(18, 0.4, 0.5), blob(hx - side * rx * 0.15, hy - ry * 0.98, rx * 0.78, ry * 0.3)),
  }),
  curly: ({ hx, hy, rx, ry, cap }) => {
    const bumps = [];
    for (let k = 0; k <= 8; k++) {
      const a = Math.PI * (1.08 + k * 0.105);
      bumps.push(circle(hx + Math.cos(a) * rx * 0.98, hy - ry * 0.1 + Math.sin(a) * ry * 0.92, rx * 0.3));
    }
    return { back: union(...bumps), front: union(cap(18, 0.32, 0.4), ...bumps.slice(2, 7)) };
  },
  afro: ({ hx, hy, rx, ry, cap }) => ({
    back: circle(hx, hy - ry * 0.3, Math.max(rx, ry) * 1.18),
    front: cap(14, 0.4, 0.3),
  }),
  hightop: ({ hx, hy, rx, ry, cap }) => ({
    back: blob(hx, hy - ry * 0.95, rx * 0.98, ry * 0.6, 4),
    front: cap(12, 0.36, 0.4),
  }),
  bun: ({ hx, hy, rx, ry, cap }) => ({
    back: circle(hx, hy - ry - rx * 0.22, rx * 0.4),
    front: cap(14, 0.4, 0.45),
  }),
  puffs: ({ hx, hy, rx, ry, cap }) => ({
    back: union(circle(hx - rx * 0.92, hy - ry * 0.74, rx * 0.44), circle(hx + rx * 0.92, hy - ry * 0.74, rx * 0.44)),
    front: cap(14, 0.38, 0.45),
  }),
  bob: ({ hx, hy, rx, ry, head }) => ({
    back: inter(blob(hx, hy - ry * 0.08, rx * 1.3, ry * 1.12, 2.4), above(hy + ry * 0.62)),
    front: inter(grow(head, 22), above(hy - ry * 0.3)),
  }),
  long: ({ hx, hy, rx, ry, head }) => ({
    back: union(blob(hx, hy - ry * 0.08, rx * 1.28, ry * 1.12),
      inter(blob(hx, hy + ry * 0.9, rx * 1.26, ry * 1.4, 4), above(hy + ry * 2.1))),
    front: inter(minus(grow(head, 20), blob(hx, hy + ry * 0.2, rx * 0.8, ry * 0.92)), above(hy + ry * 0.25)),
  }),
  wavy: ({ hx, hy, rx, ry, head }) => {
    const longBack = union(blob(hx, hy - ry * 0.08, rx * 1.34, ry * 1.12),
      inter(blob(hx, hy + ry * 0.9, rx * 1.34, ry * 1.4, 4), above(hy + ry * 1.8)));
    return {
      back: (x, y) => longBack(x, y) - 16 * Math.sin(y / 30),
      front: inter(minus(grow(head, 20), blob(hx, hy + ry * 0.18, rx * 0.84, ry * 0.9)), above(hy + ry * 0.1)),
    };
  },
  wavyBob: (g) => {
    const b = HAIR.bob(g);
    return { back: (x, y) => b.back(x, y) - 12 * Math.sin(y / 26), front: b.front };
  },
  pony: ({ hx, hy, rx, ry, cap, side }) => ({
    back: union(circle(hx - side * rx * 1.02, hy - ry * 0.42, rx * 0.32),
      capsule(hx - side * rx * 1.1, hy - ry * 0.3, hx - side * rx * 1.18, hy + ry * 0.6, rx * 0.2)),
    front: cap(16, 0.4, 0.45),
  }),
};

// Box blur in place, three passes approximate a gaussian
function blur(buf, r) {
  const tmp = new Float32Array(buf.length), n = RES, w = 2 * r + 1;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += buf[y * n + Math.min(n - 1, Math.max(0, x + k))];
        tmp[y * n + x] = sum / w;
      }
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[Math.min(n - 1, Math.max(0, y + k)) * n + x];
        buf[y * n + x] = sum / w;
      }
    }
  }
}

const FEATURE_BLUR = 4;   // raster px; features spread over several dots

// Grayscale portrait: { lum, back } as RES x RES Float32Arrays, 1 = light.
// Rendered with and without the facial features; the difference is blurred
// and added back, so eyes and mouth read as soft shading, never single dots.
function portrait(t) {
  const { ops, pivot, tilt } = scene(t);
  const lum = new Float32Array(RES * RES), back = new Float32Array(RES * RES);
  const delta = new Float32Array(RES * RES);
  const cos = Math.cos(-tilt), sin = Math.sin(-tilt);
  const p = { x: 0, y: 0, hx: 0, hy: 0, lum: 0, back: 0 };
  const run = (px, py, withFeatures) => {
    p.x = (px + 0.5) * PX; p.y = (py + 0.5) * PX;
    const dx = p.x - pivot[0], dy = p.y - pivot[1];
    p.hx = pivot[0] + dx * cos - dy * sin;
    p.hy = pivot[1] + dx * sin + dy * cos;
    for (const op of ops) if (withFeatures || !op.feature) op(p);
    return p.lum;
  };
  for (let py = 0; py < RES; py++) {
    for (let px = 0; px < RES; px++) {
      const i = py * RES + px;
      const full = run(px, py, true);
      back[i] = p.back;
      lum[i] = run(px, py, false);
      delta[i] = full - lum[i];
    }
  }
  blur(delta, FEATURE_BLUR);
  for (let i = 0; i < lum.length; i++) lum[i] = clamp01(lum[i] + delta[i] * 1.3);
  return { lum, back, size: RES };
}

// ---------------------------------------------------------------------------
// Dots — the photo tool's pipeline: hex layout, area-average sampling,
// duotone dark -> light, darker dots bigger
// ---------------------------------------------------------------------------

const GRID = [];
{
  const rowH = SPACING * Math.sqrt(3) / 2;
  let row = 0;
  for (let y = rowH / 2; y < SIZE; y += rowH, row++) {
    const off = row % 2 === 1 ? SPACING / 2 : 0;
    for (let x = SPACING / 2 + off; x < SIZE; x += SPACING) GRID.push([x, y]);
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  return "#" + rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
}
const lerpRgb = (a, b, k) => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];

// mean over the dot's footprint, at most ~5x5 samples, like sampleArea()
function sampleArea(buf, ux, uy, ur) {
  const s = RES / SIZE;
  const cxp = ux * s, cyp = uy * s, rp = Math.max(0.5, ur * s);
  const step = Math.max(1, Math.floor((rp * 2) / 5));
  const x0 = Math.max(0, Math.round(cxp - rp)), x1 = Math.min(RES - 1, Math.round(cxp + rp));
  const y0 = Math.max(0, Math.round(cyp - rp)), y1 = Math.min(RES - 1, Math.round(cyp + rp));
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) { sum += buf[y * RES + x]; n++; }
  }
  return n ? sum / n : buf[Math.min(RES - 1, Math.round(cyp)) * RES + Math.min(RES - 1, Math.round(cxp))];
}

// [{ x, y, r, fill }] in units
function dots(t, pic = portrait(t)) {
  const dark = hexToRgb(DARK), light = hexToRgb(LIGHT);
  const rBase = DOT_SIZE / 2;
  return GRID.map(([x, y]) => {
    const lum = clamp01(sampleArea(pic.lum, x, y, rBase));
    const rgb = lerpRgb(dark, light, lum);
    const r = rBase * (1 - SIZE_RANGE + SIZE_RANGE * (1 - lum));
    return { x, y, r, fill: rgbToHex(rgb) };
  });
}

// Square SVG on cream, like the photo avatar; platforms crop the circle
function svg(t, { size = SIZE } = {}) {
  const f = n => Math.round(n * 10) / 10;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${size}" height="${size}">`,
    `<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`];
  for (const d of dots(t)) parts.push(`<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.r)}" fill="${d.fill}"/>`);
  parts.push(`</svg>`);
  return parts.join("");
}

// Draw onto a 2D canvas context at px x px
function draw(ctx, px, t, list = dots(t)) {
  const s = px / SIZE;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, px, px);
  for (const d of list) {
    ctx.fillStyle = d.fill;
    ctx.beginPath();
    ctx.arc(d.x * s, d.y * s, d.r * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

const TwinAvatar = {
  PARTS, PART, SIZE, BG,
  fromSeed, encode, decode, comboCount, hashString,
  portrait, dots, svg, draw,
};

if (typeof module === "object" && module.exports) module.exports = TwinAvatar;
else root.TwinAvatar = TwinAvatar;

})(typeof self !== "undefined" ? self : this);
