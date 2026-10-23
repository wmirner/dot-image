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
 *   TwinAvatar.encode(t) -> "BXK7RTMQ", decode() turns it back into traits
 */

(function (root) {
"use strict";

// ---------------------------------------------------------------------------
// Look — identical to the photo tool's fixed Twins state
// ---------------------------------------------------------------------------

const SIZE = 1000;                     // avatar is SIZE x SIZE units
const SPACING = 46;                    // hex grid spacing (photo tool: 52; a touch finer here)
const DOT_SIZE = 44;                   // base dot diameter, same ratio to spacing as the photo tool
const SIZE_RANGE = 0.65;               // share of the size darkness controls
const BG = "#F9F4EB";                    // optional cream fill; avatars are transparent by default
const RES = 250;                       // portrait raster, px per side

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
// `odds` swaps in per-presentation weights and `ageOdds` per-age weights
// (same order as options); `ageMul` scales them by age. So hair, facial hair,
// accessories and hair color follow presentation and age without hard rules:
// any combination can still come up, or be locked.
const PARTS = [
  { key: "presentation", label: "Presentation", options: [
    opt("fem", "Feminine"), opt("masc", "Masculine"), opt("andro", "Androgynous") ] },
  { key: "age", label: "Age", options: [
    opt("young", "20s"), opt("adult", "30s–40s"), opt("middle", "50s"), opt("senior", "65+") ] },
  { key: "length", label: "Hair length", options: [
    opt("bald", "Bald"), opt("short", "Short"), opt("medium", "Medium"), opt("long", "Long") ],
    odds: { fem: [0.05, 0.8, 3, 4.5], masc: [1.2, 6, 1, 0.25], andro: [0.3, 3, 3, 1] },
    ageMul: { young: [0.4, 1, 1, 1.15], middle: [1.6, 1, 1, 0.8], senior: [2.6, 1.2, 1, 0.5] } },
  { key: "texture", label: "Hair texture", options: [
    opt("straight", "Straight", 2), opt("wavy", "Wavy", 1.2), opt("curly", "Curly"), opt("coily", "Coily") ] },
  { key: "hairTone", label: "Hair color", options: [
    opt("black", "Black"), opt("dark", "Dark brown"), opt("brown", "Brown"),
    opt("blonde", "Blonde"), opt("grey", "Grey"), opt("white", "White") ],
    ageOdds: {
      young:  [2, 2, 1, 1, 0.03, 0],
      adult:  [2, 2, 1, 1, 0.25, 0],
      middle: [1.4, 1.4, 0.8, 0.6, 2.2, 0.3],
      senior: [0.3, 0.4, 0.3, 0.2, 3, 2.5],
    } },
  { key: "skin", label: "Skin tone", options: [
    opt("1", "Very light"), opt("2", "Light"), opt("3", "Medium"),
    opt("4", "Tan"), opt("5", "Deep") ] },
  { key: "mouth", label: "Expression", options: [
    opt("neutral", "Neutral"), opt("soft", "Slight smile", 1.6), opt("smile", "Smile", 1.6),
    opt("grin", "Big smile"), opt("laugh", "Laughing", 0.8), opt("half", "Half smile", 0.9) ] },
  { key: "facial", label: "Facial hair", options: [
    opt("none", "None"), opt("stubble", "Stubble"), opt("mustache", "Mustache"),
    opt("goatee", "Goatee"), opt("beard", "Beard") ],
    odds: { fem: [1, 0, 0, 0, 0], masc: [4, 1.5, 0.5, 0.6, 1.5], andro: [10, 1, 0, 0, 0] } },
  { key: "extra", label: "Accessory", options: [
    opt("none", "None"), opt("glasses", "Glasses"), opt("bold", "Bold glasses"),
    opt("shades", "Sunglasses"), opt("earrings", "Earrings"),
    opt("headphones", "Headphones"), opt("beanie", "Beanie"), opt("cap", "Cap") ],
    odds: {
      fem:   [4, 1, 1, 0.4, 2, 0.5, 0.6, 0.3],
      masc:  [5, 1, 1, 0.4, 0.2, 0.5, 0.6, 0.6],
      andro: [4, 1, 1.2, 0.4, 1, 0.7, 0.7, 0.4],
    },
    ageMul: {
      young:  [1, 0.7, 1, 1.2, 1.1, 1.5, 1.3, 1.3],
      middle: [1, 1.8, 1.4, 0.8, 1, 0.6, 0.7, 0.8],
      senior: [1, 3, 1.5, 0.6, 1, 0.3, 0.6, 0.7],
    } },
  { key: "top", label: "Top", options: [
    opt("crew", "T-shirt", 2), opt("vneck", "V neck"), opt("collar", "Collared shirt"),
    opt("hoodie", "Hoodie"), opt("turtle", "Turtleneck"), opt("blazer", "Blazer") ] },

  // hidden: picked from the seed only
  { key: "cut", hidden: true, options: ["a", "b", "c", "d", "e", "f", "g", "h"].map(id => opt(id, id)) },
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
  short: {
    straight: ["crop", "part", "quiff", "buzz", "undercut", "pixie"],
    wavy:     ["part", "quiff", "crop", "undercut", "pixie", "spiky"],
    curly:    ["curly", "curlyTop", "part", "crop"],
    coily:    ["hightop", "buzz", "curlyTop", "spiky"],
  },
  medium: {
    // bun is last in one list only, so it's an occasional look (~1%)
    straight: ["bob", "curtains", "bangsBob", "sideSwept", "bun"],
    wavy:     ["wavyBob", "shag", "curtains", "sideSwept", "bangsBob"],
    curly:    ["curlyBob", "shag", "sideSwept", "curtains"],
    coily:    ["afro", "puffs", "curly", "curlyBob"],
  },
  long: {
    straight: ["long", "bangsLong", "sideLong"],
    wavy:     ["wavy", "sideLong", "wavyBangs", "pony"],   // pony kept rare
    curly:    ["bigCurls", "sideLong", "curlyBob"],
    coily:    ["locs", "bigCurls", "afro"],
  },
};
const CUTS = "abcdefgh";
function hairStyle(t) {
  if (t.styleOverride) return t.styleOverride;   // testing only; not part of codes
  if (t.length === "bald") return "none";
  const list = (STYLES[t.length] || STYLES.short)[t.texture] || STYLES.short.straight;
  // spread the 8 cuts evenly over however many styles the list has
  const i = Math.max(0, CUTS.indexOf(t.cut));
  return list[Math.floor(i * list.length / CUTS.length)];
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

function weightedPick(options, rnd, weights = options.map(o => o.w)) {
  let total = 0;
  for (const w of weights) total += w;
  let x = rnd() * total;
  for (let i = 0; i < options.length; i++) { if (weights[i] > 0 && (x -= weights[i]) < 0) return options[i].id; }
  return options[weights.findIndex(w => w > 0)].id;
}

// Traits from a seed (string or number). `locks` pins parts to an option id.
// A locked part always wins, but locking facial hair alone never produces a
// feminine avatar; lock Feminine too for that combination.
function fromSeed(seed, { locks = {} } = {}) {
  const rnd = mulberry32(typeof seed === "number" ? seed : hashString(String(seed)));
  const t = {};
  for (const p of PARTS) {
    // always draw, so locks don't shift other parts
    let w = (p.odds && p.odds[t.presentation]) || (p.ageOdds && p.ageOdds[t.age]) || p.options.map(o => o.w);
    // facial hair on a feminine avatar only when both are chosen on purpose
    if (p.key === "presentation" && locks.facial && locks.facial !== "none") w = w.map((x, i) => p.options[i].id === "fem" ? 0 : x);
    const mul = p.ageMul && p.ageMul[t.age];
    if (mul) w = w.map((x, i) => x * mul[i]);
    const picked = weightedPick(p.options, rnd, w);
    t[p.key] = locks[p.key] || picked;
  }
  return t;
}

// Codes use digits and consonants only, with no vowels and no 0/1/3/4
// (which stand in for O/I/E/A), so a code can never spell a word or slur
const CODE_ALPHABET = "256789BCDFGHJKLMNPQRSTVWXZ";
const CODE_LEN = 8;

function encode(t) {
  let n = 0;
  for (const p of PARTS) {
    const i = Math.max(0, p.options.findIndex(o => o.id === t[p.key]));
    n = n * p.options.length + i;
  }
  let out = "";
  for (let k = 0; k < CODE_LEN; k++) {
    out = CODE_ALPHABET[n % CODE_ALPHABET.length] + out;
    n = Math.floor(n / CODE_ALPHABET.length);
  }
  return out;
}

function decode(code) {
  const str = String(code).replace(/^#/, "").toUpperCase();
  if (str.length !== CODE_LEN) return null;
  let n = 0;
  for (const ch of str) {
    const d = CODE_ALPHABET.indexOf(ch);
    if (d < 0) return null;
    n = n * CODE_ALPHABET.length + d;
  }
  if (n >= comboCount()) return null;
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
// capsule whose radius goes from r0 at a to r1 at b
function taper(ax, ay, bx, by, r0, r1) {
  const dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy || 1;
  return (x, y) => {
    const h = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / dd));
    return hyp(x - ax - dx * h, y - ay - dy * h) - (r0 + (r1 - r0) * h);
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
// lifted so deeper skin keeps visible shading instead of a solid silhouette
const SKIN = { 1: 0.94, 2: 0.86, 3: 0.76, 4: 0.65, 5: 0.53 };
const HAIR_LUM = { black: 0.05, dark: 0.12, brown: 0.26, blonde: 0.56, grey: 0.62, white: 0.8 };
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
// Walls: light by default. White and light tops never get the light wall
// (the shoulders would vanish); they get mid or dark, whichever keeps the
// face and hair readable. Scored on rendered tones: a lit face averages
// about 0.56 of its skin value.
const WALL_LIGHT = 0.88;
const WALLS_FOR_LIGHT_TOPS = [0.64, 0.2];
function pickWall(skin, topLum, hairLum) {
  if (topLum < 0.75) return WALL_LIGHT;
  const face = skin * 0.56;
  let best = WALLS_FOR_LIGHT_TOPS[0], score = -1;
  for (const w of WALLS_FOR_LIGHT_TOPS) {
    // the face matters most; hair that would vanish costs a little
    let s = Math.abs(w - face);
    if (hairLum !== null) s += 0.3 * Math.abs(w - hairLum * 0.6);
    if (s > score) { score = s; best = w; }
  }
  return best;
}
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

  // a jaw, not an egg: the lower half is squarer and a little shorter, so
  // the chin doesn't taper to a point and fuse with the neck into a cone
  const skull = blob(cx, cy, rx, ry, H.n);
  const jawShape = blob(cx, cy, rx, ry * 0.92, Math.max(H.n, 2.8));
  const head = (x, y) => (y < cy ? skull(x, y) : jawShape(x, y));
  const neckTop = cy + ry * 0.5, chin = cy + ry * 0.92;
  const bodyTop = cy + ry + 38 * scale;
  const body = blob(500, bodyTop + 360 * scale, 400 * scale, 360 * scale, 2.6);
  const neckR = rx * 0.6;

  // the hairline recedes a little with age for masculine presentation
  const recede = t.presentation === "masc" ? ({ middle: 0.06, senior: 0.12 }[t.age] || 0) : 0;
  const cap = (g, c, dip) => inter(grow(head, g),
    (x, y) => y - (cy - ry * (c + recede) + (dip + recede) * ry * ((x - cx) / rx) ** 2));
  const style = hairStyle(t);
  const hairDef = HAIR[style] ? HAIR[style]({ hx: cx, hy: cy, rx, ry, head, cap, side: yaw >= 0 ? 1 : -1 }) : {};
  const curly = t.texture === "curly" || t.texture === "coily";

  const ops = [];

  // --- backdrop: a plain wall chosen for contrast with face and top -------
  const wall = pickWall(skin, topLum, t.length === "bald" ? null : hairLum);
  ops.push(p => { p.lum = wall; p.back = 1; });

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
    const grain = style === "locs"
      ? 0.6 * Math.sin((x - cx) / 9) + 0.3 * (vnoise(x / 9, y / 40, seed) - 0.5)   // rope-like strands
      : curly
        ? vnoise(x / 18, y / 18, seed) - 0.5
        : vnoise(x / 40, y / 9, seed) - 0.5;
    const sheen = curly || hairLum > 0.5 ? 0 :
      0.14 * gauss(x - (cx + lightSide * rx * 0.45), y - (cy - ry * 0.7), rx * 0.35, ry * 0.18);
    return clamp01(hairLum * (0.45 + 0.6 * s) + 0.1 * grain + sheen);
  };

  // --- behind the head -----------------------------------------------------
  if (hairDef.back) layer(hairDef.back, 6, (x, y) => hairShade(x, y) * 0.82);

  // neck with shadow under the chin
  layer(capsule(cx, neckTop, cx, bodyTop + 60, neckR), 4, (x, y) => {
    const u = clamp01(Math.abs(x - cx) / neckR);
    const s = amb + (1 - amb) * Math.max(0, (x - cx) / neckR * LV[0] + Math.sqrt(1 - u * u) * LV[2]);
    return skin * s * (0.72 + 0.28 * sstep(chin - 10, chin + ry * 0.4, y)) * 0.92;
  }, "img");

  // --- top -------------------------------------------------------------
  const folds = (x, y) => 0.06 * (vnoise(x / 70, y / 50, seed + 3) - 0.5);
  const bodyShade = (x, y, lum) =>
    clamp01(lum * (0.35 + 0.75 * shadeEllipsoid(x, y, 500, bodyTop + 360 * scale, 420 * scale, 380 * scale, LV, amb)) + folds(x, y));
  const neckline = {
    crew: circle(cx, bodyTop + 4, neckR * 1.05),
    vneck: poly([[cx - neckR * 1.0, bodyTop - 30], [cx + neckR * 1.0, bodyTop - 30], [cx, bodyTop + neckR * 1.9]]),
    collar: poly([[cx - neckR, bodyTop - 30], [cx + neckR, bodyTop - 30], [cx, bodyTop + neckR * 1.4]]),
    blazer: poly([[cx - neckR * 1.1, bodyTop - 30], [cx + neckR * 1.1, bodyTop - 30], [cx, bodyTop + neckR * 2.5]]),
  }[t.top];
  layer(neckline ? minus(body, neckline) : body, 4, (x, y) => bodyShade(x, y, topLum), "img");
  if (t.top === "blazer") {
    // shirt in the V, darker lapel edges
    // never a near-black shirt: a dark V under the chin reads as an arrow
    const shirt = topLum > 0.6 ? 0.55 : 0.92;
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
    // hood down: bunched at the shoulders. Never up around the face, which
    // reads as menacing and leans on a harmful stereotype.
    layer(minus(blob(cx, bodyTop + 30, neckR * 2.3, 70 * scale), circle(cx, bodyTop + 4, neckR * 1.05)), 5,
      (x, y) => bodyShade(x, y, topLum) * 0.9, "img");
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
      k *= t.mouth === "laugh"
        ? 1 - 0.75 * gauss(x - ex, y - ey - ry * 0.01, rx * 0.12, ry * 0.022)    // squinting
        : 1 - 0.85 * gauss(x - ex, y - ey, rx * 0.1, ry * 0.05);               // iris + lashes
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
  const curve = { neutral: 0, soft: 0.035, smile: 0.06, grin: 0.07, laugh: 0.09, half: 0.05 }[t.mouth] ?? 0.035;
  const mwide = { neutral: 0.9, soft: 1, smile: 1.1, grin: 1.15, laugh: 1.2, half: 1 }[t.mouth] ?? 1;
  const halfSide = yaw >= 0 ? 1 : -1;
  const open = { grin: 0.024, laugh: 0.04 }[t.mouth];
  face((x, y, lum) => {
    const dx = (x - fx) / (mw * mwide);
    if (Math.abs(dx) > 1.6) return lum;
    const env = Math.exp(-(dx ** 4));
    // a half smile lifts one corner only
    const c = t.mouth === "half" ? (dx * halfSide > 0 ? curve : curve * 0.15) : curve;
    const lineY = my + c * ry * (1 - dx * dx) * 0.6 - c * ry * 0.3;
    let k = 1 - 0.65 * env * gauss(0, y - lineY, 1, ry * 0.03);
    k *= 1 - 0.18 * env * gauss(0, y - (my + ry * 0.09), 1, ry * 0.03);         // under lower lip
    k *= 1 - 0.12 * env * gauss(0, y - (my - ry * 0.03), 1, ry * 0.035);        // upper lip tone
    if (open) {
      const a = gauss(0, y - (lineY + open * 0.5 * ry), 1, ry * open) * Math.exp(-((dx * 1.25) ** 4));
      // teeth stay close to the skin tone: a bright mouth on a darker face
      // reads as caricature
      return mix(lum * k, Math.min(0.9, skin * 1.15 + 0.05), 0.6 * a);
    }
    return lum * k;
  }, true);

  // smile lines
  if (t.mouth === "smile" || t.mouth === "grin" || t.mouth === "laugh") {
    face((x, y, lum) => {
      let k = 1;
      for (const s of [-1, 1]) k *= 1 - 0.1 * gauss(x - (fx + s * mw * 1.25), y - (my - ry * 0.08), rx * 0.035, ry * 0.08);
      return lum * k;
    }, true);
  }

  // age: folds from nose to mouth, under-eye shadows, forehead lines and a
  // softer jaw, stronger with age. Diffused like the other features.
  const ageK = { young: 0, adult: 0.3, middle: 0.65, senior: 1 }[t.age] ?? 0.3;
  if (ageK > 0) {
    const folds = [-1, 1].map(s => capsule(fx + s * rx * 0.17 * noseW, noseY, fx + s * mw * 1.2, my + ry * 0.05, 0));
    face((x, y, lum) => {
      let k = 1;
      for (const f of folds) k *= 1 - 0.55 * ageK * Math.exp(-((f(x, y) / (rx * 0.04)) ** 2));
      for (const ex of [eL, eR]) k *= 1 - 0.38 * ageK * gauss(x - ex, y - (ey + ry * 0.12), rx * 0.16, ry * 0.045);
      for (const fy of [by - ry * 0.13, by - ry * 0.23]) {
        k *= 1 - 0.25 * ageK * gauss(x - fx, y - fy, rx * 0.42, ry * 0.018);
      }
      for (const s of [-1, 1]) k *= 1 - 0.22 * ageK * gauss(x - (fx + s * rx * 0.62), y - (my + ry * 0.14), rx * 0.16, ry * 0.14);
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

  return { ops, pivot: [cx, chin], tilt, skin };
}

const HAIR = {
  buzz: ({ cap }) => ({ front: cap(4, 0.38, 0.4) }),
  // neat and even, forehead open
  crop: ({ cap }) => ({ front: cap(16, 0.46, 0.5) }),
  // clearly lopsided: piled high on one side of the part
  part: ({ hx, hy, rx, ry, cap, side }) => ({
    front: union(cap(16, 0.44, 0.5),
      inter(blob(hx + side * rx * 0.42, hy - ry * 0.8, rx * 0.72, ry * 0.42), above(hy - ry * 0.28))),
  }),
  quiff: ({ hx, hy, rx, ry, cap, side }) => ({
    front: union(cap(16, 0.44, 0.5), blob(hx - side * rx * 0.12, hy - ry * 1.08, rx * 0.66, ry * 0.42)),
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
  bun: ({ hx, hy, rx, ry, cap, side }) => ({
    // set back and to one side: centered on top it reads as a point
    back: circle(hx - side * rx * 0.5, hy - ry * 0.82, rx * 0.46),
    front: cap(14, 0.4, 0.45),
  }),
  puffs: ({ hx, hy, rx, ry, cap }) => ({
    back: union(circle(hx - rx * 0.92, hy - ry * 0.74, rx * 0.44), circle(hx + rx * 0.92, hy - ry * 0.74, rx * 0.44)),
    front: cap(14, 0.38, 0.45),
  }),
  // side part, forehead open (bangsBob is the one with a fringe)
  bob: ({ hx, hy, rx, ry, cap, side }) => ({
    back: inter(blob(hx, hy - ry * 0.08, rx * 1.3, ry * 1.12, 2.4), above(hy + ry * 0.62)),
    front: union(cap(18, 0.52, 0.7),
      inter(blob(hx + side * rx * 0.4, hy - ry * 0.7, rx * 0.66, ry * 0.32), above(hy - ry * 0.4))),
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
  // pulled back, with a thick tapered tail falling forward over one
  // shoulder (a thin strand beside the head read as a hook)
  pony: ({ hx, hy, rx, ry, cap, side }) => {
    const s = -side;
    const tail = union(
      taper(hx + s * rx * 0.9, hy + ry * 0.1, hx + s * rx * 1.04, hy + ry * 0.75, rx * 0.3, rx * 0.26),
      taper(hx + s * rx * 1.04, hy + ry * 0.75, hx + s * rx * 0.88, hy + ry * 1.45, rx * 0.26, rx * 0.12));
    return {
      back: circle(hx + s * rx * 0.62, hy - ry * 0.45, rx * 0.42),
      front: union(cap(14, 0.4, 0.45), minus(tail, blob(hx, hy + ry * 0.08, rx * 0.94, ry * 1.0))),
    };
  },

  // --- short ---
  // tight sides, volume on top
  undercut: ({ hx, hy, rx, ry, cap }) => ({
    // near-shaved sides under a flat-topped block
    front: union(cap(2, 0.42, 0.15),
      inter(blob(hx, hy - ry * 0.9, rx * 0.74, ry * 0.4, 3.5), above(hy - ry * 0.5))),
  }),
  // short with a side-swept fringe over the forehead
  // close crop that covers the ears, fringe swept down to one brow
  pixie: ({ hx, hy, rx, ry, head, cap, side }) => ({
    front: union(cap(16, 0.36, 0.3),
      inter(blob(hx + side * rx * 0.3, hy - ry * 0.38, rx * 0.72, ry * 0.3), above(hy - ry * 0.04)),
      inter(minus(grow(head, 18), blob(hx, hy + ry * 0.12, rx * 0.84, ry * 0.95)), above(hy + ry * 0.2))),
  }),
  // textured crop with an uneven top edge
  spiky: ({ hx, hy, ry, cap }) => {
    const base = cap(30, 0.4, 0.5);
    // tufts only along the top, so the sides stay neat
    return { front: (x, y) => base(x, y) - (y < hy - ry * 0.6 ? 26 * Math.abs(Math.sin((x - hx) / 15)) : 0) };
  },
  // curls on top, faded sides
  curlyTop: ({ hx, hy, rx, ry, cap }) => {
    const bumps = [];
    for (let k = 0; k <= 6; k++) {
      const a = Math.PI * (1.15 + k * 0.117);
      bumps.push(circle(hx + Math.cos(a) * rx * 0.8, hy - ry * 0.14 + Math.sin(a) * ry * 0.92, rx * 0.27));
    }
    return { front: union(cap(5, 0.36, 0.25), ...bumps) };
  },

  // --- medium ---
  // middle part, hair falling either side of the face to the jaw
  curtains: ({ hx, hy, rx, ry, head }) => ({
    back: inter(blob(hx, hy - ry * 0.05, rx * 1.24, ry * 1.1, 2.4), above(hy + ry * 0.85)),
    front: minus(inter(grow(head, 20), above(hy + ry * 0.5)),
      union(blob(hx, hy + ry * 0.15, rx * 0.72, ry * 0.9), capsule(hx, hy - ry * 1.2, hx, hy - ry * 0.6, 8))),
  }),
  // bob with blunt bangs to the brows
  bangsBob: ({ hx, hy, rx, ry, head }) => ({
    back: inter(blob(hx, hy - ry * 0.08, rx * 1.3, ry * 1.12, 2.4), above(hy + ry * 0.62)),
    // heavy fringe right down to the brows
    front: inter(grow(head, 24), above(hy - ry * 0.04)),
  }),
  // volume swept to one side, covering one brow
  sideSwept: ({ hx, hy, rx, ry, cap, side }) => ({
    back: inter(blob(hx + side * rx * 0.12, hy - ry * 0.05, rx * 1.26, ry * 1.08, 2.4), above(hy + ry * 0.55)),
    front: union(cap(20, 0.38, 0.5),
      inter(blob(hx + side * rx * 0.3, hy - ry * 0.42, rx * 0.95, ry * 0.36), above(hy - ry * 0.02))),
  }),
  // layered and wavy, with a soft fringe
  shag: ({ hx, hy, rx, ry, head }) => ({
    back: (x, y) => inter(blob(hx, hy - ry * 0.05, rx * 1.32, ry * 1.12, 2.4), above(hy + ry * 0.75))(x, y) - 14 * Math.sin(y / 24),
    front: inter(grow(head, 22), (x, y) => y - (hy - ry * 0.2 + 10 * Math.sin((x - hx) / 22))),
  }),
  // curls framing the face down to the jaw
  curlyBob: ({ hx, hy, rx, ry, cap }) => {
    const bumps = [];
    for (let k = 0; k <= 12; k++) {
      const a = Math.PI * (0.78 + k * 0.12);
      bumps.push(circle(hx + Math.cos(a) * rx * 1.08, hy - ry * 0.05 + Math.sin(a) * ry * 1.0, rx * 0.34));
    }
    return { back: union(...bumps), front: union(cap(18, 0.32, 0.4), ...bumps.slice(3, 10)) };
  },

  // --- long ---
  // long with blunt bangs
  bangsLong: (g) => {
    const l = HAIR.long(g);
    return { back: l.back, front: union(inter(grow(g.head, 22), above(g.hy - g.ry * 0.12)), l.front) };
  },
  // long with a deep side part sweeping across
  sideLong: (g) => {
    const { hx, hy, rx, ry, cap, side } = g;
    const l = HAIR.long(g);
    // a diagonal sweep down to one brow; the other side of the forehead open
    return {
      back: l.back,
      front: union(l.front, inter(grow(g.head, 20),
        poly([[hx + side * rx * 0.45, hy - ry * 1.1], [hx + side * rx * 0.45, hy - ry * 0.72],
              [hx - side * rx * 0.15, hy - ry * 0.08], [hx - side * rx * 1.2, hy - ry * 0.08], [hx - side * rx * 1.2, hy - ry * 1.1]]))),
    };
  },
  wavyBangs: (g) => {
    const w = HAIR.wavy(g);
    return { back: w.back, front: union(w.front, inter(grow(g.head, 22), (x, y) => y - (g.hy - g.ry * 0.16 + 8 * Math.sin((x - g.hx) / 20)))) };
  },
  // big curls down past the shoulders
  bigCurls: ({ hx, hy, rx, ry, cap }) => {
    const bumps = [circle(hx, hy - ry * 0.25, Math.max(rx, ry) * 1.1)];
    for (let k = 0; k <= 4; k++) {
      for (const s of [-1, 1]) bumps.push(circle(hx + s * rx * (1.02 + 0.04 * k), hy + ry * (0.1 + k * 0.34), rx * 0.38));
    }
    return { back: union(...bumps), front: cap(16, 0.38, 0.35) };
  },
  // locs: long, with an uneven hem
  locs: ({ hx, hy, rx, ry, cap }) => {
    const longBack = union(blob(hx, hy - ry * 0.1, rx * 1.3, ry * 1.12),
      inter(blob(hx, hy + ry * 0.9, rx * 1.3, ry * 1.4, 4), above(hy + ry * 1.9)));
    return {
      back: (x, y) => Math.max(longBack(x, y), y - (hy + ry * 1.75 + 30 * Math.sin((x - hx) / 21))),
      front: union(cap(16, 0.36, 0.4),
        inter(minus(grow(blob(hx, hy, rx, ry), 20), blob(hx, hy + ry * 0.2, rx * 0.82, ry * 0.92)), above(hy + ry * 0.2))),
    };
  },
};

// Box blur in place, three passes approximate a gaussian
function blur(buf, n, r) {
  const tmp = new Float32Array(buf.length), w = 2 * r + 1;
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

const FEATURE_BLUR = 16;  // units; features spread over several dots

// Grayscale portrait: { lum, back, size } with size x size Float32Arrays,
// 1 = light. `res` trades detail for speed (half res suits small tiles).
// Rendered with and without the facial features; the difference is blurred
// and added back, so eyes and mouth read as soft shading, never single dots.
function portrait(t, { res = RES } = {}) {
  const { ops, pivot, tilt, skin } = scene(t);
  const PX = SIZE / res;
  const lum = new Float32Array(res * res), back = new Float32Array(res * res);
  const delta = new Float32Array(res * res);
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
  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const i = py * res + px;
      const full = run(px, py, true);
      back[i] = p.back;
      lum[i] = run(px, py, false);
      delta[i] = full - lum[i];
    }
  }
  blur(delta, res, Math.max(1, Math.round(FEATURE_BLUR / PX)));
  // features darken multiplicatively, so boost them on deeper skin to keep
  // every face equally readable instead of a featureless silhouette
  const gain = 1.3 * Math.sqrt(0.84 / skin);
  for (let i = 0; i < lum.length; i++) lum[i] = clamp01(lum[i] + delta[i] * gain);
  return { lum, back, size: res };
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
function sampleArea(buf, res, ux, uy, ur) {
  const s = res / SIZE;
  const cxp = ux * s, cyp = uy * s, rp = Math.max(0.5, ur * s);
  const step = Math.max(1, Math.floor((rp * 2) / 5));
  const x0 = Math.max(0, Math.round(cxp - rp)), x1 = Math.min(res - 1, Math.round(cxp + rp));
  const y0 = Math.max(0, Math.round(cyp - rp)), y1 = Math.min(res - 1, Math.round(cyp + rp));
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) { sum += buf[y * res + x]; n++; }
  }
  return n ? sum / n : buf[Math.min(res - 1, Math.round(cyp)) * res + Math.min(res - 1, Math.round(cxp))];
}

// [{ x, y, r, fill }] in units
function dots(t, pic = portrait(t)) {
  const dark = hexToRgb(DARK), light = hexToRgb(LIGHT);
  const rBase = DOT_SIZE / 2;
  return GRID.map(([x, y]) => {
    const lum = clamp01(sampleArea(pic.lum, pic.size, x, y, rBase));
    const rgb = lerpRgb(dark, light, lum);
    const r = rBase * (1 - SIZE_RANGE + SIZE_RANGE * (1 - lum));
    return { x, y, r, fill: rgbToHex(rgb) };
  });
}

// Square SVG, transparent by default; pass `background` (e.g. BG) to fill it
function svg(t, { size = SIZE, background = null } = {}) {
  const f = n => Math.round(n * 10) / 10;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${size}" height="${size}">`];
  if (background) parts.push(`<rect width="${SIZE}" height="${SIZE}" fill="${background}"/>`);
  for (const d of dots(t)) parts.push(`<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.r)}" fill="${d.fill}"/>`);
  parts.push(`</svg>`);
  return parts.join("");
}

// Draw onto a 2D canvas context at px x px; transparent unless `background`
function draw(ctx, px, t, list = dots(t), { background = null } = {}) {
  const s = px / SIZE;
  ctx.clearRect(0, 0, px, px);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, px, px);
  }
  for (const d of list) {
    ctx.fillStyle = d.fill;
    ctx.beginPath();
    ctx.arc(d.x * s, d.y * s, d.r * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

const TwinAvatar = {
  PARTS, PART, SIZE, BG,
  fromSeed, encode, decode, comboCount, hashString, hairStyle, HAIR_STYLES: () => Object.keys(HAIR),
  portrait, dots, svg, draw,
};

if (typeof module === "object" && module.exports) module.exports = TwinAvatar;
else root.TwinAvatar = TwinAvatar;

})(typeof self !== "undefined" ? self : this);
