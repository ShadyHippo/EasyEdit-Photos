"use strict";

/* ============================================================================
 * Easy Edit — a single-file image annotator / light editor.
 *
 * Reading order:
 *    1  config      constants and tunables
 *    2  dom         cached element references
 *    3  state       every mutable module variable, in one place
 *    4  util        tiny pure helpers
 *    5  history     copy-on-write undo / redo (see the note below)
 *    6  model       layer + selection bookkeeping
 *    7  render      everything that paints the view canvas
 *    8  pointer     the active-tool state machine and pointer handling
 *    9  text        text boxes, inline editing, the floating selection bar
 *   10  selection   marquee, effects, magic wand, flatten
 *   11  layers      the layers panel and its operations
 *   12  crop        interactive crop
 *   13  transform   rotate / flip / resize / bake annotations
 *   14  fun         deep fry and the distort blobs
 *   15  bg          server-side background removal
 *   16  export      composite + download / copy
 *   17  document    open, new, reset, clear
 *   18  wiring      every event listener, in one place
 *   19  boot        first paint
 * ========================================================================== */

/* -------------------------------------------------------------- 1  config */
const MAX_UNDO = 12;
// Retained pixel history is capped by bytes, not just by step count: one 4K
// canvas is ~33 MB, so twelve untouched copies would be ~400 MB. Dropping whole
// old steps once the budget is blown keeps this usable on modest hardware, and
// it only ever costs history depth, never correctness.
const MAX_HISTORY_BYTES = 384 << 20;
const HANDLE_PX = 26;            // crop / layer handle hit size, in screen px
// One source of truth for "this is a phone": narrow, or short-and-wide (landscape). The CSS
// media query mirrors this exact string.
// Which HTML shell is hosting us. The two shells (index.html / mobile.html) each provide the same
// element ids and arrange them differently, so the logic below never has to care about layout.
const SHELL = document.body.dataset.shell || 'desktop';
const IS_MOBILE = SHELL === 'mobile';
const ZOOM_MIN = 0.05, ZOOM_MAX = 16, FIT_PAD = 24;   // view zoom range and fit margin, in CSS px
const PAN_MARGIN = 48;           // keep at least this much of the image on screen when panning
const DEFAULT_FILTER = { brightness:100, contrast:100, saturate:100, grayscale:0, sepia:0 };

// Bundled faces only (see fonts/LICENSE.txt) — nothing relies on the host machine.
const FONT_CHOICES = [
  ['Anton',            'Heavy (Anton)'],
  ['Inter',            'Clean (Inter)'],
  ['Roboto',           'Plain (Roboto)'],
  ['Playfair Display', 'Serif (Playfair)'],
  ['Comic Neue',       'Comic (Comic Neue)'],
  ['Caveat',           'Handwritten (Caveat)'],
];

// [id, label, shortcut, row] — row 'top' is the global tool row, 'ann' the annotation row.
const TOOLS = [
  ['move','Move','m','top'], ['marquee','Select','s','top'],
  ['wand','Wand','w','top'], ['crop','Crop','c','top'], ['blob','Blob','b','top'],
  ['text','Text','t','ann'], ['brush','Pen','p','ann'], ['highlight','Highlight','h','ann'],
  ['line','Line','l','ann'], ['arrow','Arrow','a','ann'], ['rect','Rect','r','ann'], ['ellipse','Ellipse','e','ann'],
];
const TOOL_ROW_SEP = new Set(['wand', 'line']);    // draw a divider before these tools
const TOOL_ICONS = {
  move:'<path d="M12 3v18M3 12h18M12 3l-2.4 2.4M12 3l2.4 2.4M12 21l-2.4-2.4M12 21l2.4-2.4M3 12l2.4-2.4M3 12l2.4 2.4M21 12l-2.4-2.4M21 12l-2.4 2.4"/>',
  marquee:'<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/>',
  text:'<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  brush:'<path d="M4 20l1.2-4.2L16.4 4.6a1.6 1.6 0 012.3 0l.7.7a1.6 1.6 0 010 2.3L8.2 18.8 4 20z"/>',
  highlight:'<path d="M13 4l6 6-6.4 6.4-6-6z"/><path d="M9.6 15.4l-2 2"/><path d="M4 21h9"/>',
  line:'<path d="M5 19L19 5"/>',
  arrow:'<path d="M5 19L19 5"/><path d="M12.5 5H19v6.5"/>',
  rect:'<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  ellipse:'<ellipse cx="12" cy="12" rx="8" ry="6.4"/>',
  wand:'<path d="M5 19l9-9"/><path d="M14.5 4.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/><path d="M19.5 12.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>',
  crop:'<path d="M7 3v14h14"/><path d="M3 7h14v14"/>',
  blob:'<path d="M12 3s6 6.4 6 11a6 6 0 01-12 0c0-4.6 6-11 6-11z"/>',
};
const svgIcon = path => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
const toolIcon = id => svgIcon(TOOL_ICONS[id] || '');
// Header-action icons, revealed only in the compact mobile header (desktop keeps the words).
const ACTION_ICONS = {
  undoBtn:'<path d="M9 6L4 11l5 5"/><path d="M4 11h9.5a5.5 5.5 0 010 11H9"/>',
  redoBtn:'<path d="M15 6l5 5-5 5"/><path d="M20 11H10.5a5.5 5.5 0 000 11H15"/>',
  rotL:'<path d="M4 12a8 8 0 1 0 8-8"/><path d="M4 5v7h7"/>',
  rotR:'<path d="M20 12a8 8 0 1 1-8-8"/><path d="M20 5v7h-7"/>',
  flipH:'<path d="M12 3v18"/><path d="M9.5 8L5 12l4.5 4z"/><path d="M14.5 8L19 12l-4.5 4z"/>',
  flipV:'<path d="M3 12h18"/><path d="M8 9.5L12 5l4 4.5z"/><path d="M8 14.5L12 19l4-4.5z"/>',
  newBtn:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8.5v7M8.5 12h7"/>',
  openBtn:'<path d="M3.5 7.5a2 2 0 012-2h3.6l1.8 2h7.6a2 2 0 012 2v7a2 2 0 01-2 2H5.5a2 2 0 01-2-2z"/>',
  sheetToggle:'<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
};
// Which Tool-tab section a tool owns (undefined = no options of its own).
const TOOL_OPTS = { text:'style', brush:'style', highlight:'style', line:'style',
  arrow:'style', rect:'style', ellipse:'style', wand:'wand', crop:'crop', blob:'blob' };
// Tools whose job lives somewhere other than the Tool tab: Move edits the stack (Layers),
// Select scopes Effects/Adjust (Image).
const TOOL_TAB = { move:'layers', marquee:'image' };
const TOOL_KEYS = {};            // single-letter shortcut -> tool id, filled in by buildToolButtons()

const FRY = {
  light:  { q:72, passes:1, sat:2.2, con:1.25, nz:10, sh:0.55 },
  medium: { q:48, passes:2, sat:3.2, con:1.45, nz:16, sh:0.85 },
  deep:   { q:32, passes:3, sat:4.5, con:1.70, nz:24, sh:1.15 },
  nuked:  { q:16, passes:5, sat:6.0, con:2.10, nz:38, sh:1.55 },
};

/* ----------------------------------------------------------------- 2  dom */
const $ = s => document.querySelector(s);
const view = $('#view'), vctx = view.getContext('2d'), stage = $('#stage');
const panel = $('#panel'), backdrop = $('#backdrop');
const toolsEl = $('#tools'), annToolsEl = $('#annTools'), fontSel = $('#fontFamily'), layerList = $('#layerList');
const chromeCanvas = $('#chrome'), cctx = chromeCanvas.getContext('2d');
const zoomHud = $('#zoomHud'), zoomPct = $('#zoomPct');

/* --------------------------------------------------------------- 3  state */
// Pixel surfaces: `base` is the background, `overlay` holds shapes (always above
// every layer) and each layer owns its own canvas. §5 explains how these are
// shared with history so that undo does not copy the whole document every time.
let base = document.createElement('canvas');
let bctx = base.getContext('2d');
let overlay = document.createElement('canvas');
let octx = overlay.getContext('2d');
let hasImage = false;

let layers = [];                 // index 0 = back, last = front
let selLayer = null;             // primary (last-clicked) layer id
let selLayers = [];              // full multi-selection
let checkedLayers = new Set();   // ticked rows, for Flatten
let flattenAnnotations = false;

let texts = [];                  // live, movable text boxes
let selText = null;
let shapes = [];                 // live annotations: brush / highlight / line / arrow / rect / ellipse
let selShape = null;             // primary (last-clicked) annotation id
let selShapes = [];              // full annotation multi-selection

let blobs = [];                  // distort markers: UI only, never exported
const style = { color:'#ff3b30', width: IS_MOBILE ? 16 : 6, opacity:1, filled:false, fontSize:48, family:'Anton', bold:false, italic:false,
                bg:null, bgOpacity:0.8, pad:14, radius:10 };
const wand = { tolerance:22, global:false, transparent:true, color:'#ff3b30' };
const fx = { block:14, soft:8 };     // pixelate block size, blur radius
const blobCfg = { size:160, strength:60 };
let adjust = { ...DEFAULT_FILTER };

let clip = null;                 // internal copy/paste buffer
let clipSig = null;              // pixel fingerprint of what we mirrored to the OS clipboard
let clipMirror = Promise.resolve();  // in-flight OS clipboard write; awaitable, never raced
let pasteStamp = 0;

let tool = 'move';
let drag = null;                 // {kind:'shape'|'text'|'marquee'|'layer'|'layerResize'|'blob', ...}
let crop = null;                 // {x,y,w,h} in canvas coords
let cropDrag = null;
let selection = null;            // {x,y,w,h}; effects target this, else the whole image
let hoverId = null;              // layer under the cursor (desktop hover feedback)
let aspect = 1;                  // base.width / base.height, for the locked resize
let zoom = 1, fitZoom = 1, atFit = true;   // CSS px per image px, and whether we are fitted
const pan = { x: 0, y: 0 };                // screen offset of the image's top-left corner
let spaceDown = false, panDrag = null;     // space / middle-drag panning
const pointers = new Map();                // live touch pointers, for pinch zoom + two-finger pan
let pinch = null;

// render cache (see §7): the static stack is only re-composited when its signature changes
let cacheCanvas = null, cacheCtx = null, cacheSigVal = null;
let chromeDpr = 1;
let paintSeq = 0;                // bumped by the few in-place pixel writes so the cache notices
let frameQueued = false;

let undoStack = [], redoStack = [], gestureSnap = null;
let nudgeTimer = null, toastTimer = null;

/* ---------------------------------------------------------------- 4  util */
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hexToRgb = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexToRgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const clone = src => { const c = canvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; };
// Rounded-rect path (arcTo based, so it works regardless of ctx.roundRect support).
function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  if (r <= 0) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const textLines = t => String(t.text).split('\n');
const isImg = f => !!(f && f.type && f.type.startsWith('image/'));
// Stable per-canvas identity, used by the render cache's scene signature.
const canvasIds = new WeakMap(); let canvasIdSeq = 0;
const cid = c => { let v = canvasIds.get(c); if (v === undefined) { v = ++canvasIdSeq; canvasIds.set(c, v); } return v; };

// True when a keystroke belongs to a text field, so shortcuts must not hijack it.
// Sliders / checkboxes / colour swatches are NOT typing targets, so tool keys still work
// after touching one, while arrows and space stay with the control itself.
function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el.type || 'text').toLowerCase();
  return !['range', 'checkbox', 'radio', 'color', 'file', 'button', 'submit', 'reset'].includes(type);
}

function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

/* ------------------------------------------------------------- 5  history */
/* A snapshot keeps *references* to the pixel canvases and copies only the small
 * metadata (layer rects, texts, blobs, selection). Before a canvas is edited in
 * place it is cloned if any snapshot still points at it (copy-on-write), and
 * released once nothing needs it. So one operation costs at most one canvas copy
 * — never a copy of the whole document — while undo still restores exact pixels.
 *
 * `pinned` maps a canvas to the number of history entries holding it. Only four
 * places ever write into a canvas in place (two of them the overlay) and each
 * calls the matching own*() first; everything else builds a fresh canvas, which
 * is safe to hand to history as-is.
 */
const pinned = new Map();        // canvas -> reference count
let pinnedBytes = 0;             // total bytes currently held by history
const canvasBytes = c => c.width * c.height * 4;

function pin(c) {
  const n = pinned.get(c) || 0;
  if (!n) pinnedBytes += canvasBytes(c);
  pinned.set(c, n + 1);
}
function unpin(c) {
  const n = pinned.get(c);
  if (!n) return;
  if (n === 1) { pinned.delete(c); pinnedBytes -= canvasBytes(c); }
  else pinned.set(c, n - 1);
}
const frozen = c => pinned.has(c);

function snapshot() {
  const ls = layers.map(l => ({ ...l }));
  const s = {
    base, overlay,
    layers: ls,
    texts: texts.map(t => ({ ...t })),
    shapes: shapes.map(cloneShape),
    blobs: blobs.map(b => ({ ...b })),
    sel: selText, selShape, selShapes: [...selShapes], selLayer, selLayers: [...selLayers],
  };
  s.surfaces = [...new Set([base, overlay, ...ls.map(l => l.c)])];
  s.surfaces.forEach(pin);
  return s;
}
function drop(s) {
  if (!s || !s.surfaces) return;
  s.surfaces.forEach(unpin);
  s.surfaces = null;
}
function dropStack(stack) { for (const s of stack) drop(s); stack.length = 0; }

function trimHistory() {
  while (undoStack.length > MAX_UNDO) drop(undoStack.shift());
  while (pinnedBytes > MAX_HISTORY_BYTES && undoStack.length > 1) drop(undoStack.shift());
}
// Commit a snapshot that was taken *before* a change.
function commitPre(pre) {
  dropStack(redoStack);                  // a fresh edit invalidates the redo trail
  undoStack.push(pre);
  trimHistory();
  updateHistoryUI();
}
// Snapshot the current state now, for operations that mutate straight away.
function pushUndo() { commitPre(snapshot()); }

function beginGesture() {
  if (gestureSnap) drop(gestureSnap);    // a previous gesture that never committed
  gestureSnap = snapshot();
}
function commitGesture(changed) {
  const s = gestureSnap; gestureSnap = null;
  if (changed && s) commitPre(s); else drop(s);
}

function restore(s) {
  base = s.base; bctx = base.getContext('2d');
  overlay = s.overlay; octx = overlay.getContext('2d');
  layers = s.layers.map(l => ({ ...l }));
  texts = s.texts.map(t => ({ ...t }));
  shapes = (s.shapes || []).map(cloneShape);
  blobs = (s.blobs || []).map(b => ({ ...b }));
  selText = s.sel; selShape = s.selShape !== undefined ? s.selShape : null;
  selShapes = s.selShapes ? [...s.selShapes] : (selShape ? [selShape] : []);
  selLayer = s.selLayer; selLayers = s.selLayers ? [...s.selLayers] : [];
  resizeView(); render(); updateHistoryUI(); updateSelInfo(); updateLayerUI();
}
function undo() {
  if (!undoStack.length) return;
  const s = undoStack.pop();
  redoStack.push(snapshot());
  while (redoStack.length > MAX_UNDO) drop(redoStack.shift());
  restore(s); drop(s);
}
function redo() {
  if (!redoStack.length) return;
  const s = redoStack.pop();
  undoStack.push(snapshot());
  trimHistory();
  restore(s); drop(s);
}
function updateHistoryUI() {
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
}

// Copy-on-write: adopt a private canvas before editing one that history holds.
function ownBase()    { if (frozen(base))    { base = clone(base);       bctx = base.getContext('2d'); } }
function ownOverlay() { if (frozen(overlay)) { overlay = clone(overlay); octx = overlay.getContext('2d'); } }
function ownLayer(l)  { if (frozen(l.c))     { l.c = clone(l.c); } }

/* --------------------------------------------------------------- 6  model */
function primaryLayer() { return layers.find(l => l.id === selLayer) || null; }

function selectedLayerSet() {
  const ids = selLayers.length ? selLayers : (selLayer ? [selLayer] : []);
  return ids.map(id => layers.find(l => l.id === id)).filter(Boolean);
}
function movingIds() {
  const ids = (selLayers && selLayers.includes(selLayer)) ? selLayers : (selLayer ? [selLayer] : []);
  return ids.filter(id => layers.some(l => l.id === id));
}
function setSelection(ids) {
  const seen = [];
  for (const id of ids) if (layers.some(l => l.id === id) && !seen.includes(id)) seen.push(id);
  selLayers = seen;
  selLayer = seen.length ? seen[seen.length - 1] : null;
  if (selLayer) { selText = null; selShape = null; selShapes = []; }
  updateLayerUI();
}
// Press-time selection for a layer drag, shared by the layer body and the centre grab block.
// An additive press on something already selected is deferred: it is toggled off on pointerup,
// and only if the gesture never moved (so ctrl-drag still drags the whole group).
function selectForDrag(id, additive) {
  const inSel = selLayers.includes(id);
  if (additive) {
    if (inSel) return id;
    setSelection([...selLayers, id]);
    return null;
  }
  if (!inSel) setSelection([id]);
  else if (selLayer !== id) { selLayer = id; updateLayerUI(); }
  return null;
}

/* ------------------------------------------------- 6b  annotation model */
// Annotations are live objects (not baked pixels): they keep their defining geometry and style
// and are re-drawn every frame, exactly like text boxes. `render()` re-draws `shapes` in order.
const isStroke = s => s.type === 'brush' || s.type === 'highlight';
const touchShape = s => { s.rev = (s.rev || 0) + 1; };
// annotations are metadata only, so history copies them cheaply
const cloneShape = s => isStroke(s) ? { ...s, points: s.points.map(p => ({ ...p })) } : { ...s };
// Raw geometry bbox (no stroke padding) - what the resize handles sit on.
function shapeBox(s) {
  if (isStroke(s)) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.points) {
      if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
    }
    if (!isFinite(x0)) return { x:0, y:0, w:0, h:0 };
    return { x:x0, y:y0, w:x1 - x0, h:y1 - y0 };
  }
  return { x:Math.min(s.x1, s.x2), y:Math.min(s.y1, s.y2), w:Math.abs(s.x2 - s.x1), h:Math.abs(s.y2 - s.y1) };
}
function selectedShape() { return shapes.find(s => s.id === selShape) || null; }
function selectedShapeSet() {
  const ids = selShapes.length ? selShapes : (selShape ? [selShape] : []);
  return ids.map(id => shapes.find(s => s.id === id)).filter(Boolean);
}
function setShapeSel(ids) {
  const seen = [];
  for (const id of ids) if (shapes.some(s => s.id === id) && !seen.includes(id)) seen.push(id);
  selShapes = seen;
  selShape = seen.length ? seen[seen.length - 1] : null;
  if (selShape) { selText = null; selLayers = []; selLayer = null; }
  updateLayerUI(); updateSelBar();
}
function selectShape(s) { setShapeSel(s ? [s.id] : []); }
function clearShapeSel() { selShape = null; selShapes = []; }
// Press-time selection for an annotation drag, mirroring selectForDrag for layers. Shift = range
// from the primary; ctrl/meta = toggle. An additive press on something already selected is
// deferred and toggled off on pointerup ONLY if the gesture never moved (so drag still drags).
function selectForShapeDrag(id, additive, shift) {
  const inSel = selShapes.includes(id);
  if (shift && selShape) {
    const a = shapes.findIndex(z => z.id === selShape), b = shapes.findIndex(z => z.id === id);
    setShapeSel(shapes.slice(Math.min(a, b), Math.max(a, b) + 1).map(z => z.id));
    return null;
  }
  if (additive) {
    if (inSel) return id;
    setShapeSel([...selShapes, id]);
    return null;
  }
  if (!inSel) setShapeSel([id]);
  else if (selShape !== id) { selShape = id; updateLayerUI(); }
  return null;
}
function shapeHandlePoints(s) {
  const b = shapeBox(s);
  const c = [b.x + b.w / 2, b.y + b.h / 2];   // centre = grab-and-move grip (bbox centre is the
  if (s.type === 'line' || s.type === 'arrow') return { p1:[s.x1, s.y1], p2:[s.x2, s.y2], c };  // midpoint for a 2-point shape)
  return {
    nw:[b.x, b.y],            n:[b.x + b.w / 2, b.y],  ne:[b.x + b.w, b.y],
    w:[b.x, b.y + b.h / 2],                              e:[b.x + b.w, b.y + b.h / 2],
    sw:[b.x, b.y + b.h],      s:[b.x + b.w / 2, b.y + b.h], se:[b.x + b.w, b.y + b.h],
    c,
  };
}
const segDist2 = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
};
function hitShape(p) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    const tol = Math.max(7, s.width * (s.type === 'highlight' ? 1.5 : 0.8) + 4);
    if (isStroke(s)) {
      if (s.points.length === 1 && Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) <= tol) return s;
      for (let j = 1; j < s.points.length; j++) {
        const a = s.points[j - 1], b = s.points[j];
        if (segDist2(p.x, p.y, a.x, a.y, b.x, b.y) <= tol * tol) return s;
      }
    } else if (s.type === 'line' || s.type === 'arrow') {
      if (segDist2(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= tol * tol) return s;
    } else {
      const b = shapeBox(s);
      if (p.x >= b.x - 5 && p.x <= b.x + b.w + 5 && p.y >= b.y - 5 && p.y <= b.y + b.h + 5) return s;
    }
  }
  return null;
}
// Resize handles live on the primary annotation; EVERY selected annotation gets a centre grab
// grip which moves the whole selection - that is what makes strokes, lines and arrows easy to pick
// up (they are thin, so the body itself is a much smaller target).
function shapeOrig(s) { return isStroke(s) ? s.points.map(p => ({ ...p })) : { x1:s.x1, y1:s.y1, x2:s.x2, y2:s.y2 }; }
function moveShapeTo(s, o, dx, dy) {
  if (Array.isArray(o)) s.points = o.map(p => ({ x:p.x + dx, y:p.y + dy }));
  else { s.x1 = o.x1 + dx; s.y1 = o.y1 + dy; s.x2 = o.x2 + dx; s.y2 = o.y2 + dy; }
  touchShape(s);
}
// Drag a handle: boxes/strokes resize their bbox, lines/arrows just move the grabbed endpoint.
function resizeShapeTo(s, d, p) {
  if (s.type === 'line' || s.type === 'arrow') {
    if (d.handle === 'p1') { s.x1 = p.x; s.y1 = p.y; } else { s.x2 = p.x; s.y2 = p.y; }
    touchShape(s); return;
  }
  const ow = Math.max(1, d.ow), oh = Math.max(1, d.oh), right = d.ox + ow, bottom = d.oy + oh;
  const MIN = 6;
  let nx = d.ox, ny = d.oy, nw = ow, nh = oh;
  if (d.handle === 'e' || d.handle === 'w') {
    nw = Math.max(MIN, d.handle === 'e' ? (p.x - d.ox) : (right - p.x));
    nx = d.handle === 'e' ? d.ox : right - nw;
  } else if (d.handle === 'n' || d.handle === 's') {
    nh = Math.max(MIN, d.handle === 's' ? (p.y - d.oy) : (bottom - p.y));
    ny = d.handle === 's' ? d.oy : bottom - nh;
  } else {
    let k;
    if (d.handle === 'se')      k = Math.max((p.x - d.ox) / ow, (p.y - d.oy) / oh);
    else if (d.handle === 'nw') k = Math.max((right - p.x) / ow, (bottom - p.y) / oh);
    else if (d.handle === 'ne') k = Math.max((p.x - d.ox) / ow, (bottom - p.y) / oh);
    else                        k = Math.max((right - p.x) / ow, (p.y - d.oy) / oh);
    k = clamp(k, 0.02, 30);
    nw = ow * k; nh = oh * k;
    if (d.handle === 'nw')      { nx = right - nw; ny = bottom - nh; }
    else if (d.handle === 'ne') { nx = d.ox;       ny = bottom - nh; }
    else if (d.handle === 'sw') { nx = right - nw; ny = d.oy; }
  }
  if (isStroke(s) && d.origPoints) {
    const sx = nw / ow, sy = nh / oh;
    s.points = d.origPoints.map(q => ({ x:nx + (q.x - d.ox) * sx, y:ny + (q.y - d.oy) * sy }));
  } else {
    s.x1 = nx; s.y1 = ny; s.x2 = nx + nw; s.y2 = ny + nh;
  }
  touchShape(s);
}
function dupShape(s) {
  const c = { ...s, id: uid(), rev: 0 };
  const off = Math.max(14, (s.width || 4) * 2.5);
  if (isStroke(s)) c.points = s.points.map(p => ({ x:p.x + off, y:p.y + off }));
  else { c.x1 += off; c.y1 += off; c.x2 += off; c.y2 += off; }
  return c;
}
function translateShape(s, dx, dy) {
  if (isStroke(s)) s.points = s.points.map(p => ({ x:p.x + dx, y:p.y + dy }));
  else { s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy; }
  touchShape(s);
}
function scaleShape(s, kx, ky) {
  const kw = (kx + ky) / 2;
  if (isStroke(s)) { s.points = s.points.map(p => ({ x:p.x * kx, y:p.y * ky })); s.width *= kw; }
  else { s.x1 *= kx; s.y1 *= ky; s.x2 *= kx; s.y2 *= ky; s.width *= kw; }
  touchShape(s);
}
// Map every point of a shape through a whole-canvas rotate / flip, then keep boxes axis-aligned.
function mapShape(s, fn) {
  if (isStroke(s)) { s.points = s.points.map(fn); }
  else {
    const a = fn({ x:s.x1, y:s.y1 }), b = fn({ x:s.x2, y:s.y2 });
    s.x1 = a.x; s.y1 = a.y; s.x2 = b.x; s.y2 = b.y;
    if (s.type === 'rect' || s.type === 'ellipse') {
      if (s.x1 > s.x2) { const t = s.x1; s.x1 = s.x2; s.x2 = t; }
      if (s.y1 > s.y2) { const t = s.y1; s.y1 = s.y2; s.y2 = t; }
    }
  }
  touchShape(s);
}

/* -------------------------------------------------------------- 7  render */
const viewScale = () => {
  const r = view.getBoundingClientRect();
  return view.width ? r.width / view.width : 1;
};
function filterCSS() {
  const a = adjust, p = [];
  if (a.brightness !== 100) p.push(`brightness(${a.brightness}%)`);
  if (a.contrast   !== 100) p.push(`contrast(${a.contrast}%)`);
  if (a.saturate   !== 100) p.push(`saturate(${a.saturate}%)`);
  if (a.grayscale)          p.push(`grayscale(${a.grayscale}%)`);
  if (a.sepia)              p.push(`sepia(${a.sepia}%)`);
  return p.length ? p.join(' ') : 'none';
}
// One place that builds the font shorthand, so canvas, bbox and the editor agree.
function fontCss(t, scale = 1) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${Math.round(t.size * scale)}px "${t.family}", sans-serif`;
}
function textBBox(t) {
  vctx.save(); vctx.font = fontCss(t);
  let w = 10;
  for (const l of textLines(t)) w = Math.max(w, vctx.measureText(l).width);
  vctx.restore();
  return { w, h: Math.max(1, textLines(t).length) * t.size * 1.15 };
}
// Text legibility plate: padding only counts while a background colour is set.
function textPad(t) { return t.bg ? Math.max(0, t.pad || 0) : 0; }
// The box you actually see: the text plus its background padding.
function textRect(t) {
  const b = textBBox(t), p = textPad(t);
  return { x: t.x - p, y: t.y - p, w: b.w + p * 2, h: b.h + p * 2 };
}
function paintText(ctx, t) {
  ctx.save();
  ctx.globalAlpha = t.opacity;
  ctx.font = fontCss(t);
  ctx.textBaseline = 'top';
  if (t.bg) {                                     // legibility plate behind the whole block
    const r = textRect(t);
    ctx.globalAlpha = t.opacity * clamp(t.bgOpacity ?? 1, 0, 1);
    ctx.fillStyle = t.bg;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, t.radius || 0);
    ctx.fill();
    ctx.globalAlpha = t.opacity;
  }
  ctx.fillStyle = t.color;
  textLines(t).forEach((l, i) => ctx.fillText(l, t.x, t.y + i * t.size * 1.15));
  ctx.restore();
}
function drawSelection(t, faint = false) {
  const b = textRect(t);
  const s = viewScale();
  const x = b.x - 4 / s, y = b.y - 4 / s, w = b.w + 8 / s, h = b.h + 8 / s;
  cctx.save();
  cctx.fillStyle = faint ? 'rgba(34,197,94,.05)' : 'rgba(34,197,94,.12)';
  cctx.fillRect(x, y, w, h);
  cctx.strokeStyle = faint ? 'rgba(34,197,94,.6)' : '#22c55e';
  cctx.lineWidth = (faint ? 1.5 : 2.5) / s;
  cctx.setLineDash(faint ? [9 / s, 6 / s] : []);
  cctx.strokeRect(x, y, w, h);
  cctx.setLineDash([]);
  if (faint) {                                   // faint = unselected: show the box ends too
    const hs = (16 / s) * 0.6;
    cctx.fillStyle = 'rgba(255,255,255,.92)'; cctx.strokeStyle = 'rgba(34,197,94,.9)'; cctx.lineWidth = 1.5 / s;
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      cctx.beginPath(); cctx.rect(hx - hs / 2, hy - hs / 2, hs, hs); cctx.fill(); cctx.stroke();
    }
  }
  cctx.restore();
}
function paintShape(ctx, s) {
  ctx.save();
  ctx.globalAlpha = s.opacity;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width;
  if (s.type === 'brush' || s.type === 'highlight') {
    if (s.type === 'highlight') { ctx.globalAlpha = s.opacity * 0.4; ctx.lineWidth = s.width * 2.5; }
    ctx.beginPath();
    s.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.stroke();
  } else if (s.type === 'line' || s.type === 'arrow') {
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    if (s.type === 'arrow') {
      const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), h = Math.max(12, s.width * 3.2);
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2); ctx.lineTo(s.x2 - h * Math.cos(a - 0.4), s.y2 - h * Math.sin(a - 0.4));
      ctx.moveTo(s.x2, s.y2); ctx.lineTo(s.x2 - h * Math.cos(a + 0.4), s.y2 - h * Math.sin(a + 0.4));
      ctx.stroke();
    }
  } else if (s.type === 'rect') {
    const w = s.x2 - s.x1, h = s.y2 - s.y1;
    if (s.filled) ctx.fillRect(s.x1, s.y1, w, h); else ctx.strokeRect(s.x1, s.y1, w, h);
  } else if (s.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
    if (s.filled) ctx.fill(); else ctx.stroke();
  }
  ctx.restore();
}
function drawShapeOutline(s, isPrimary, faint = false) {
  const sc = viewScale(), t = 16 / sc, hs = faint ? t * 0.55 : t;
  const lineish = s.type === 'line' || s.type === 'arrow';
  const b = shapeBox(s);
  cctx.save();
  if (!lineish) {                                   // same green/tint language as layers
    cctx.fillStyle = faint ? 'rgba(34,197,94,.05)' : (isPrimary ? 'rgba(34,197,94,.12)' : 'rgba(34,197,94,.06)');
    cctx.fillRect(b.x - 3 / sc, b.y - 3 / sc, b.w + 6 / sc, b.h + 6 / sc);
  }
  cctx.strokeStyle = faint ? 'rgba(34,197,94,.6)' : (isPrimary ? '#22c55e' : 'rgba(34,197,94,.75)');
  cctx.lineWidth = (isPrimary ? 2.5 : 1.5) / sc;
  cctx.setLineDash(isPrimary ? [] : [9 / sc, 6 / sc]);
  if (lineish) { cctx.beginPath(); cctx.moveTo(s.x1, s.y1); cctx.lineTo(s.x2, s.y2); cctx.stroke(); }
  else cctx.strokeRect(b.x - 3 / sc, b.y - 3 / sc, b.w + 6 / sc, b.h + 6 / sc);
  cctx.setLineDash([]);
  const pts = shapeHandlePoints(s);
  // handles on the primary; small "end" markers on every unselected one under the Move tool
  if (isPrimary || faint) {
    cctx.fillStyle = faint ? 'rgba(255,255,255,.92)' : '#22c55e';
    cctx.strokeStyle = 'rgba(34,197,94,.9)';
    cctx.lineWidth = (faint ? 1.5 : 1.2) / sc;
    for (const k in pts) {
      if (k === 'c') continue;
      const [hx, hy] = pts[k];
      cctx.beginPath(); cctx.rect(hx - hs / 2, hy - hs / 2, hs, hs);
      if (faint) { cctx.fill(); cctx.stroke(); } else cctx.fill();
    }
  }
  cctx.restore();
}
function drawStack(ctx) {
  ctx.drawImage(base, 0, 0);
  for (const l of layers) ctx.drawImage(l.c, l.x, l.y, l.w, l.h);
  for (const s of shapes) paintShape(ctx, s);
  ctx.drawImage(overlay, 0, 0);
  for (const t of texts) paintText(ctx, t);
}
// The stack changes far less often than the view is redrawn (a drag moves a preview, not the
// stack), so composite it once into a reusable canvas, and only when its signature changes.
function sceneSig() {
  let s = base.width + 'x' + base.height + '\u0001' + cid(base) + '\u0001' + cid(overlay) + '\u0001' + paintSeq;
  for (const l of layers) s += '\u0002' + cid(l.c) + ',' + Math.round(l.x) + ',' + Math.round(l.y) + ',' + Math.round(l.w) + ',' + Math.round(l.h);
  s += '\u0003';
  for (const sh of shapes) {
    s += '\u0004' + sh.id + ',' + sh.type + ',' + (sh.rev || 0) + ',' + sh.color + ',' + sh.width + ',' + sh.opacity + ',' + (sh.filled ? 1 : 0);
    s += isStroke(sh) ? ',' + sh.points.length : ',' + Math.round(sh.x1) + ',' + Math.round(sh.y1) + ',' + Math.round(sh.x2) + ',' + Math.round(sh.y2);
  }
  s += '\u0005';
  for (const t of texts) s += '\u0002' + t.x.toFixed(1) + ',' + t.y.toFixed(1) + ',' + t.size + ',' + t.color + ',' + t.opacity + ',' + (t.bold ? 1 : 0) + (t.italic ? 1 : 0) + ',' + t.family + ',' + t.text + ',' + (t.bg || '-') + ',' + (t.bgOpacity ?? 1) + ',' + (t.pad || 0) + ',' + (t.radius || 0);
  return s;
}
function stackCanvas() {
  const sig = sceneSig();
  if (cacheCanvas && sig === cacheSigVal) return cacheCanvas;
  if (!cacheCanvas || cacheCanvas.width !== base.width || cacheCanvas.height !== base.height) {
    cacheCanvas = canvas(base.width, base.height);
    cacheCtx = cacheCanvas.getContext('2d');
  }
  cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
  cacheCtx.globalAlpha = 1; cacheCtx.filter = 'none';
  cacheCtx.clearRect(0, 0, cacheCanvas.width, cacheCanvas.height);
  drawStack(cacheCtx);
  cacheSigVal = sig;
  return cacheCanvas;
}
// pointermove fires at input rate (often well above 60 Hz); coalesce preview redraws to one/frame.
function scheduleRender() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; render(); });
}
/* Zoom is a CSS transform on the full-resolution canvas: panning is then just a transform update,
 * and overlay line widths already divide by viewScale() so handles stay the same size on screen. */
function stageSize() { const r = stage.getBoundingClientRect(); return { w: r.width, h: r.height }; }
function fitScale() {
  const { w, h } = stageSize();
  return clamp(Math.min((w - 2 * FIT_PAD) / view.width, (h - 2 * FIT_PAD) / view.height), 0.0005, 1);
}
function clampZoom(z) { return clamp(z, Math.min(ZOOM_MIN, fitZoom), ZOOM_MAX); }
function clampPan() {
  // Keep at least PAN_MARGIN px of the image on screen, without forcing it to the centre -
  // centring here would fight cursor-anchored wheel zoom whenever the image is small.
  const { w, h } = stageSize();
  const iw = view.width * zoom, ih = view.height * zoom;
  pan.x = clamp(pan.x, PAN_MARGIN - iw, w - PAN_MARGIN);
  pan.y = clamp(pan.y, PAN_MARGIN - ih, h - PAN_MARGIN);
}
function applyView() {
  view.style.width = view.width + 'px';
  view.style.height = view.height + 'px';
  view.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  atFit = Math.abs(zoom - fitZoom) < 1e-9;
  zoomPct.textContent = Math.round(zoom * 100) + '%';
  renderChrome();
}
function fitView(redraw = true) {
  fitZoom = fitScale(); zoom = fitZoom;
  const { w, h } = stageSize();
  pan.x = (w - view.width * zoom) / 2; pan.y = (h - view.height * zoom) / 2;
  clampPan(); applyView();
  if (redraw) render();
}
function setZoom(z, cx, cy, redraw = true) {
  const { w, h } = stageSize();
  const ax = cx === undefined ? w / 2 : cx, ay = cy === undefined ? h / 2 : cy;
  const ix = (ax - pan.x) / zoom, iy = (ay - pan.y) / zoom;   // image point under the anchor
  zoom = clampZoom(z);
  pan.x = ax - ix * zoom; pan.y = ay - iy * zoom;             // keep it under the anchor
  clampPan(); applyView();
  if (redraw) render();
}
// Centre grips. Layers use a green-ringed square, annotations and text a blue-ringed circle.
// `big` marks the selected object; unselected ones get a slightly smaller, softer grip.
function drawLayerGrip(l, big = true) {
  const sc = viewScale(), t = 16 / sc, cs = t * (big ? 1.2 : 0.9);
  const [cx, cy] = layerHandlePoints(l).c;
  cctx.save();
  cctx.fillStyle = '#ffffff';
  cctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs);
  cctx.strokeStyle = '#22c55e'; cctx.lineWidth = (big ? 2.5 : 1.8) / sc;
  cctx.strokeRect(cx - cs / 2, cy - cs / 2, cs, cs);
  cctx.restore();
}
function drawCenterGrip(cx, cy, big = true) {
  const sc = viewScale(), r = (16 / sc) * (big ? 0.8 : 0.6);
  cctx.save();
  cctx.beginPath(); cctx.arc(cx, cy, r, 0, Math.PI * 2);
  cctx.fillStyle = '#ffffff'; cctx.fill();
  cctx.strokeStyle = '#22c55e'; cctx.lineWidth = (big ? 2 : 1.5) / sc;
  cctx.stroke();
  cctx.restore();
}
function drawLayerOutline(l, isPrimary, faint = false) {
  const s = viewScale(), t = 16 / s, hs = faint ? t * 0.6 : t;
  cctx.save();
  cctx.fillStyle = faint ? 'rgba(34,197,94,.05)' : (isPrimary ? 'rgba(34,197,94,.12)' : 'rgba(34,197,94,.06)');
  cctx.fillRect(l.x, l.y, l.w, l.h);
  cctx.strokeStyle = faint ? 'rgba(34,197,94,.6)' : '#22c55e';
  cctx.lineWidth = (isPrimary ? 2.5 : 1.5) / s;
  cctx.setLineDash(isPrimary ? [] : [9 / s, 6 / s]);
  cctx.strokeRect(l.x, l.y, l.w, l.h);
  cctx.setLineDash([]);
  if (isPrimary || faint) {
    const pts = layerHandlePoints(l);
    cctx.fillStyle = faint ? 'rgba(255,255,255,.92)' : '#22c55e';
    cctx.strokeStyle = 'rgba(34,197,94,.9)';
    cctx.lineWidth = 1.5 / s;
    for (const k in pts) {
      if (k === 'c') continue;
      const [hx, hy] = pts[k];
      cctx.beginPath(); cctx.rect(hx - hs / 2, hy - hs / 2, hs, hs);
      if (faint) { cctx.fill(); cctx.stroke(); } else cctx.fill();
    }
  }
  cctx.restore();
}
function drawHoverOutline(l) {
  const s = viewScale();
  cctx.save();
  cctx.strokeStyle = 'rgba(34,197,94,.55)'; cctx.lineWidth = 1.5 / s;
  cctx.setLineDash([4 / s, 4 / s]);
  cctx.strokeRect(l.x, l.y, l.w, l.h);
  cctx.restore();
}
function drawBlob(b) {
  const s = viewScale(), t = 13 / s;
  cctx.save();
  cctx.beginPath(); cctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
  cctx.fillStyle = 'rgba(236,72,153,.13)'; cctx.fill();
  cctx.strokeStyle = '#ec4899'; cctx.lineWidth = 2 / s; cctx.setLineDash([8 / s, 6 / s]);
  cctx.stroke();
  cctx.setLineDash([]);
  cctx.fillStyle = '#ec4899';
  cctx.fillRect(b.x - t / 2, b.y - t / 2, t, t);
  cctx.restore();
}
function drawSelectionOverlay(r) {
  const s = viewScale();
  cctx.save();
  cctx.fillStyle = 'rgba(0,0,0,.14)';
  cctx.beginPath(); cctx.rect(0, 0, view.width, view.height); cctx.rect(r.x, r.y, r.w, r.h);
  cctx.fill('evenodd');
  cctx.strokeStyle = '#22c55e'; cctx.lineWidth = 1.5 / s; cctx.setLineDash([7 / s, 5 / s]);
  cctx.strokeRect(r.x, r.y, r.w, r.h);
  cctx.setLineDash([]);
  const t = 9 / s;
  cctx.fillStyle = '#22c55e';
  for (const [cx, cy] of [[r.x,r.y],[r.x+r.w,r.y],[r.x,r.y+r.h],[r.x+r.w,r.y+r.h]]) cctx.fillRect(cx - t/2, cy - t/2, t, t);
  cctx.restore();
}
function render() {
  if (!hasImage) { renderChrome(); return; }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.filter = 'none';
  vctx.clearRect(0, 0, view.width, view.height);
  const stack = stackCanvas();
  // Adjust applies to the FINAL image, or only inside the selection if there is one.
  const f = filterCSS();
  if (f === 'none') {
    vctx.drawImage(stack, 0, 0);
  } else if (selection) {
    vctx.drawImage(stack, 0, 0);
    vctx.save();
    vctx.beginPath(); vctx.rect(selection.x, selection.y, selection.w, selection.h); vctx.clip();
    vctx.filter = f;
    vctx.drawImage(stack, 0, 0);
    vctx.restore();
    vctx.filter = 'none';
  } else {
    vctx.filter = f;
    vctx.drawImage(stack, 0, 0);
    vctx.filter = 'none';
  }
  renderChrome();
  updateSelBar();
}
// All UI chrome is drawn on its own stage-sized canvas, in screen space, so it is never clipped by
// the image bounds - handles on objects dragged off the edge stay visible and grabbable.
function sizeChrome() {
  const r = stage.getBoundingClientRect();
  chromeDpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * chromeDpr)), h = Math.max(1, Math.round(r.height * chromeDpr));
  if (chromeCanvas.width !== w || chromeCanvas.height !== h) { chromeCanvas.width = w; chromeCanvas.height = h; }
  chromeCanvas.style.width = r.width + 'px';
  chromeCanvas.style.height = r.height + 'px';
}
function renderChrome() {
  sizeChrome();
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.filter = 'none';
  cctx.clearRect(0, 0, chromeCanvas.width, chromeCanvas.height);
  if (!hasImage) return;
  const d = chromeDpr * zoom;
  cctx.setTransform(d, 0, 0, d, chromeDpr * pan.x, chromeDpr * pan.y);
  cctx.lineJoin = 'round'; cctx.lineCap = 'round';
  const selL = new Set(selectedLayerSet().map(l => l.id));
  const selS = new Set(selectedShapeSet().map(s => s.id));
  // Move tool: outline EVERY object and show its ends + centre grip, so nothing is invisible or
  // unreachable - including anything dragged off the edge of the image.
  for (const l of layers) if (tool === 'move' || selL.has(l.id)) drawLayerOutline(l, selL.has(l.id), !selL.has(l.id));
  for (const s of shapes) if (tool === 'move' || selS.has(s.id)) drawShapeOutline(s, selS.has(s.id), !selS.has(s.id));
  for (const t of texts) if (tool === 'move' || t.id === selText) drawSelection(t, !(t.id === selText));
  if (tool === 'move' && hoverId && !selL.has(hoverId)) {
    const hl = layers.find(l => l.id === hoverId);
    if (hl) drawHoverOutline(hl);
  }
  if (drag && drag.shape) paintShape(cctx, drag.shape);      // live shape preview
  if (crop) drawCropOverlay();
  else if (drag && drag.kind === 'marquee') drawSelectionOverlay(marqueeRect(drag));
  else if (selection) drawSelectionOverlay(selection);
  for (const b of blobs) drawBlob(b);                        // UI only
  // Centre grips are drawn LAST and picked FIRST, so they always sit on/above every other handle.
  for (const l of layers) if (tool === 'move' || selL.has(l.id)) drawLayerGrip(l, l.id === selLayer);
  for (const s of shapes) if (tool === 'move' || selS.has(s.id)) { const c = shapeHandlePoints(s).c; drawCenterGrip(c[0], c[1], s.id === selShape); }
  for (const t of texts) if (tool === 'move' || t.id === selText) { const b = textRect(t); drawCenterGrip(b.x + b.w / 2, b.y + b.h / 2, t.id === selText); }
}

/* ------------------------------------------------------- mobile options rail */
// On a phone the active tool's quick controls live in a rail pinned above the dock:
// always reachable, and never covering the canvas, so you watch the stroke change as
// you drag. The rows below are the *same* nodes the sheet uses, moved here by id —
// one source of truth for every value, and nothing to keep in sync.
const RAIL_ROWS = {
  text:      ['colorRow', 'fontSizeRow', 'boldItalicRow'],
  brush:     ['colorRow', 'widthRow', 'opacityRow', 'fillRow'],
  highlight: ['colorRow', 'widthRow', 'opacityRow', 'fillRow'],
  line:      ['colorRow', 'widthRow', 'opacityRow', 'fillRow'],
  arrow:     ['colorRow', 'widthRow', 'opacityRow', 'fillRow'],
  rect:      ['colorRow', 'widthRow', 'opacityRow', 'fillRow'],
  ellipse:   ['colorRow', 'widthRow', 'opacityRow', 'fillRow'],
  wand:      ['wandColorRow', 'tolRow', 'wandTransRow'],
  crop:      ['cropBtns'],
  blob:      ['blobSizeRow', 'blobStrengthRow'],
  move:      ['layerOrderRow', 'layerActRow'],
  marquee:   ['selOpsRow'],
};
const railEl = IS_MOBILE ? $('#rail') : null;    // null on desktop: the sheet is the only home
const railHome = new Map();                      // node -> where it lives when not on the rail
function syncRail(id) {
  if (!railEl) return;
  const wanted = RAIL_ROWS[id] || [];
  for (const [node, home] of railHome)             // send anything not wanted back home
    if (!wanted.includes(node.id) && node.parentElement !== home) home.appendChild(node);
  for (const rid of wanted) {                      // then stack the wanted rows, in order
    const node = $('#' + rid); if (!node) continue;
    if (!railHome.has(node)) railHome.set(node, node.parentElement);
    railEl.appendChild(node);
  }
  // A drawing tool's whole Style section now lives in the rail, so the sheet's copy
  // would be a bare heading — hide it. Text keeps its Font / size / background block.
  if (id !== 'text') $('#styleSec').hidden = true;
}

/* -------------------------------------------------------------- 8  pointer */
const PANES = { tool:'#paneTool', layers:'#paneLayers', image:'#paneImage' };
function setTab(name) {
  if (!PANES[name]) name = 'tool';
  $('#tabs').querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  for (const k in PANES) $(PANES[k]).hidden = k !== name;
  if (name === 'image') syncBgSection();   // the rembg sidecar may have come up since boot
}
function syncToolButtons(id) {
  document.querySelectorAll('#tools [data-tool], #annTools [data-tool]')
    .forEach(b => b.classList.toggle('active', b.dataset.tool === id));
}
function setTool(id) {
  if (tool === 'crop' && id !== 'crop') cancelCrop();
  tool = id;
  // The marquee box only exists while Select is active, so drop the selection when leaving it.
  if (id !== 'marquee' && selection) { selection = null; updateSelInfo(); }
  syncToolButtons(id);
  applyCursor();
  // The Tool tab shows exactly one tool's options — pick the section that belongs to this tool.
  const opts = TOOL_OPTS[id] || null;
  $('#styleSec').hidden = opts !== 'style';
  $('#wandSec').hidden  = opts !== 'wand';
  $('#blobSec').hidden  = opts !== 'blob';
  $('#cropSec').hidden  = !crop;
  // Width / Opacity / Fill only affect drawn annotations — never text.
  const text = id === 'text';
  $('#fontRow').style.display = text ? '' : 'none';
  $('#widthRow').hidden = text; $('#opacityRow').hidden = text; $('#fillRow').hidden = text;
  $('#toolHint').hidden = !!(opts || crop);
  if (TOOL_TAB[id]) setTab(TOOL_TAB[id]);           // Move -> Layers, Select -> Image
  else if (opts) setTab('tool');                    // drawing / wand / crop / blob -> its options
  syncRail(id);                                     // phone: swap the rail to this tool's controls
  if (id === 'highlight' && $('#opacity').value === '1') setRange('opacity', 0.4);
  if (id !== 'move' && id !== 'text') { selText = null; clearShapeSel(); }
  else if (id === 'text') clearShapeSel();          // text tool: keep the text box, drop annotations
  updateAnnUI(); updateSelBar();
  render();
}
function toCanvas(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (view.width / r.width), y: (e.clientY - r.top) * (view.height / r.height) };
}
function hitText(p) {
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i], b = textRect(t);
    if (p.x >= b.x - 6 && p.x <= b.x + b.w + 6 && p.y >= b.y - 6 && p.y <= b.y + b.h + 6) return t;
  }
  return null;
}
function hitLayer(p) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (p.x >= l.x && p.x <= l.x + l.w && p.y >= l.y && p.y <= l.y + l.h) return l;
  }
  return null;
}
function layersAt(p) {                       // front-most first
  const out = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (p.x >= l.x && p.x <= l.x + l.w && p.y >= l.y && p.y <= l.y + l.h) out.push(l);
  }
  return out;
}
function layerHandlePoints(l) {
  return {
    nw:[l.x, l.y],            n:[l.x + l.w / 2, l.y],  ne:[l.x + l.w, l.y],
    w:[l.x, l.y + l.h / 2],                              e:[l.x + l.w, l.y + l.h / 2],
    sw:[l.x, l.y + l.h],      s:[l.x + l.w / 2, l.y + l.h], se:[l.x + l.w, l.y + l.h],
    c:[l.x + l.w / 2, l.y + l.h / 2],
  };
}
// Resize handles live on the primary layer; the centre grab block is on every
// selected layer, so any of them can be dragged to move the whole selection.
// Handle picking is Z-ORDERED, matching what is drawn (grips are drawn last, so they are on top):
//   1. every centre grip, front-to-back - a grip beats every other handle and every object body,
//      so a buried layer's grip is clickable straight through the layers above it;
//   2. the primary selection's own resize handles (beats all content);
//   3. nothing - the caller then falls through to content, front-most first.
function topHandleHit(e) {
  const r = view.getBoundingClientRect(), sc = viewScale(), R = HANDLE_PX / 2;
  const near = pts => Math.abs(e.clientX - (r.left + pts[0] * sc)) <= R && Math.abs(e.clientY - (r.top + pts[1] * sc)) <= R;
  // 1. centre grips (same z-order as content: texts over annotations over layers)
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i], b = textRect(t);
    if (near([b.x + b.w / 2, b.y + b.h / 2])) return { kind:'textGrip', id:t.id };
  }
  for (let i = shapes.length - 1; i >= 0; i--) if (near(shapeHandlePoints(shapes[i]).c)) return { kind:'shapeGrip', id:shapes[i].id };
  for (let i = layers.length - 1; i >= 0; i--) if (near(layerHandlePoints(layers[i]).c)) return { kind:'layerGrip', id:layers[i].id };
  // 2. resize handles of the primary selection
  const lprim = primaryLayer();
  if (lprim) {
    const pts = layerHandlePoints(lprim);
    for (const k of ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']) if (near(pts[k])) return { kind:'layerResize', handle:k };
  }
  const sprim = selectedShape();
  if (sprim) {
    const pts = shapeHandlePoints(sprim);
    for (const k in pts) if (k !== 'c' && near(pts[k])) return { kind:'shapeResize', handle:k };
  }
  return null;
}
function layerResizeTo(l, d, p) {
  const ow = d.ow, oh = d.oh, right = d.ox + ow, bottom = d.oy + oh;
  const MIN = 6;
  // side handles stretch on one axis only, breaking the aspect ratio on purpose
  if (d.handle === 'e' || d.handle === 'w') {
    const w = Math.max(MIN, d.handle === 'e' ? (p.x - d.ox) : (right - p.x));
    l.x = d.handle === 'e' ? d.ox : right - w;
    l.y = d.oy; l.w = w; l.h = oh;
    return;
  }
  if (d.handle === 'n' || d.handle === 's') {
    const h = Math.max(MIN, d.handle === 's' ? (p.y - d.oy) : (bottom - p.y));
    l.y = d.handle === 's' ? d.oy : bottom - h;
    l.x = d.ox; l.w = ow; l.h = h;
    return;
  }
  // corners stay uniform
  let k;
  if (d.handle === 'se')      k = Math.max((p.x - d.ox) / ow, (p.y - d.oy) / oh);
  else if (d.handle === 'nw') k = Math.max((right - p.x) / ow, (bottom - p.y) / oh);
  else if (d.handle === 'ne') k = Math.max((p.x - d.ox) / ow, (bottom - p.y) / oh);
  else                        k = Math.max((right - p.x) / ow, (p.y - d.oy) / oh);
  k = clamp(k, 0.02, 30);
  const nw = ow * k, nh = oh * k;
  if (d.handle === 'se')      { l.x = d.ox; l.y = d.oy; }
  else if (d.handle === 'nw') { l.x = right - nw; l.y = bottom - nh; }
  else if (d.handle === 'ne') { l.x = d.ox; l.y = bottom - nh; }
  else                        { l.x = right - nw; l.y = d.oy; }
  l.w = nw; l.h = nh;
}
function startTextDrag(t, p, e) {
  beginGesture();
  drag = { kind:'text', id:t.id, ox:p.x - t.x, oy:p.y - t.y, startX:p.x, startY:p.y, moved:false };
  try { stage.setPointerCapture(e.pointerId); } catch {}
  render();
}
function onPointerDown(e) {
  if (!hasImage) return;
  if (e.target && e.target.closest && e.target.closest('#zoomHud, #selbar')) return;   // panel chrome
  if (e.pointerType === 'touch') {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { e.preventDefault(); startPinch(); return; }
    if (pointers.size > 2 || pinch) { e.preventDefault(); return; }   // ignore extra fingers
  }
  e.preventDefault();                    // stop the browser's own drag/selection starting on mousedown
  const p = toCanvas(e);
  const capture = () => { try { stage.setPointerCapture(e.pointerId); } catch {} };

  if (spaceDown || e.button === 1) { beginPan(e); return; }
  if (tool === 'crop') { cropDown(e, p); capture(); return; }
  if (tool === 'wand') { doWand(p); return; }
  if (tool === 'marquee') {
    beginGesture();
    drag = { kind:'marquee', startX:p.x, startY:p.y, x2:p.x, y2:p.y };
    capture(); render(); return;
  }
  if (tool === 'text') {
    const hit = hitText(p);
    if (hit) { selectText(hit); startTextDrag(hit, p, e); return; }
    createTextBox(p); return;
  }
  if (tool === 'blob') {
    const hit = blobs.find(b => Math.hypot(p.x - b.x, p.y - b.y) <= b.r);
    if (hit) { beginGesture(); drag = { kind:'blob', id:hit.id, startX:p.x, startY:p.y, moved:false }; }
    else {
      beginGesture();
      const b = { id: uid(), x:p.x, y:p.y, r: blobCfg.size, str: blobCfg.strength / 100 };
      blobs.push(b);
      drag = { kind:'blob', id:b.id, created:true, startX:p.x, startY:p.y, moved:false };
    }
    capture(); render(); return;
  }
  if (tool === 'move') {
    // Alt-click cycles down through the stack under the cursor (for buried layers)
    if (e.altKey) {
      const stack = layersAt(p);
      if (stack.length) {
        const cur = stack.findIndex(z => z.id === selLayer);
        setSelection([stack[(cur + 1) % stack.length].id]);
        render(); return;
      }
    }
    // Handles win over content, in z-order (see topHandleHit).
    const hh = topHandleHit(e);
    if (hh) {
      if (hh.kind === 'textGrip') {
        const t = texts.find(x => x.id === hh.id);
        if (t) { selectText(t); startTextDrag(t, p, e); return; }
      } else if (hh.kind === 'shapeGrip') {
        const toggleId = selectForShapeDrag(hh.id, e.ctrlKey || e.metaKey, e.shiftKey);
        const orig = selectedShapeSet().map(t => ({ id:t.id, g: shapeOrig(t) }));
        beginGesture();
        drag = { kind:'shapeEdit', mode:'move', id:hh.id, ox:p.x, oy:p.y, orig,
                 startX:p.x, startY:p.y, moved:false, toggleId };
        capture(); render(); return;
      } else if (hh.kind === 'layerGrip') {
        const toggleId = selectForDrag(hh.id, e.ctrlKey || e.metaKey || e.shiftKey);
        beginGesture();
        drag = { kind:'layer', ox:p.x, oy:p.y, startX:p.x, startY:p.y, moved:false, toggleId,
                 orig: movingIds().map(id => { const q = layers.find(z => z.id === id); return { id, x:q.x, y:q.y }; }) };
        capture(); render(); return;
      } else if (hh.kind === 'layerResize') {
        const l = primaryLayer();
        beginGesture();
        drag = { kind:'layerResize', id:l.id, handle:hh.handle, ox:l.x, oy:l.y, ow:l.w, oh:l.h, startX:p.x, startY:p.y, moved:false };
        capture(); render(); return;
      } else {
        const cur = selectedShape();                     // shapeResize on the primary annotation
        const b = shapeBox(cur);
        beginGesture();
        drag = { kind:'shapeEdit', mode:'resize', id:cur.id, handle:hh.handle,
                 ox:b.x, oy:b.y, ow:Math.max(1, b.w), oh:Math.max(1, b.h),
                 origPoints: isStroke(cur) ? cur.points.map(q => ({ ...q })) : null,
                 startX:p.x, startY:p.y, moved:false };
        capture(); render(); return;
      }
    }
    const hit = hitText(p);
    if (hit) {
      selText = hit.id; clearShapeSel(); selLayers = []; selLayer = null; beginGesture();
      drag = { kind:'text', id:hit.id, ox:p.x - hit.x, oy:p.y - hit.y, startX:p.x, startY:p.y, moved:false };
      capture(); updateLayerUI(); render(); return;
    }
    const hs = hitShape(p);
    if (hs) {
      const toggleId = selectForShapeDrag(hs.id, e.ctrlKey || e.metaKey, e.shiftKey);
      const orig = selectedShapeSet().map(t => ({ id:t.id, g: shapeOrig(t) }));
      beginGesture();
      drag = { kind:'shapeEdit', mode:'move', id:hs.id, ox:p.x, oy:p.y, orig,
               startX:p.x, startY:p.y, moved:false, toggleId };
      capture(); updateLayerUI(); render(); return;
    }
    selText = null; clearShapeSel();
    const lh = hitLayer(p);
    if (lh) {
      if (selLayers.length && !selLayers.includes(selLayer)) selLayers = selLayer ? [selLayer] : [];
      const toggleId = selectForDrag(lh.id, e.ctrlKey || e.metaKey || e.shiftKey);
      beginGesture();
      drag = { kind:'layer', ox:p.x, oy:p.y, startX:p.x, startY:p.y, moved:false, toggleId,
               orig: movingIds().map(id => { const q = layers.find(z => z.id === id); return { id, x:q.x, y:q.y }; }) };
      capture(); render(); return;
    }
    setSelection([]);
    render(); return;
  }
  selText = null; clearShapeSel(); updateLayerUI();
  beginGesture();
  drag = { kind:'shape', shape: { id: uid(), rev: 0, type:tool, color:style.color, width:style.width,
                                  opacity:style.opacity, filled:style.filled, x1:p.x, y1:p.y, x2:p.x, y2:p.y, points:[p] } };
  capture();
  render();
}
function onPointerMove(e) {
  if (e.pointerType === 'touch' && pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { movePinch(); return; }
  }
  if (!hasImage) return;
  if (panDrag) {
    pan.x = panDrag.px + (e.clientX - panDrag.x);
    pan.y = panDrag.py + (e.clientY - panDrag.y);
    clampPan(); applyView();
    return;
  }
  const p = toCanvas(e);
  if (tool === 'move' && !drag && !cropDrag) {
    const stack = layersAt(p);
    const top = stack.length ? stack[0].id : null;
    if (top !== hoverId) { hoverId = top; scheduleRender(); }
  }
  if (cropDrag) { applyCropDrag(p); scheduleRender(); return; }
  if (!drag) return;
  // any real movement means this was a drag, not a click
  if (drag.startX !== undefined && (Math.abs(p.x - drag.startX) > 2 || Math.abs(p.y - drag.startY) > 2)) drag.moved = true;
  if (drag.kind === 'text') {
    const t = texts.find(x => x.id === drag.id); if (!t) return;
    t.x = clamp(p.x - drag.ox, -50, base.width); t.y = clamp(p.y - drag.oy, -50, base.height);
  } else if (drag.kind === 'blob') {
    const b = blobs.find(z => z.id === drag.id); if (!b) return;
    b.x = p.x; b.y = p.y;
  } else if (drag.kind === 'layer') {
    const dx = p.x - drag.ox, dy = p.y - drag.oy;
    for (const o of drag.orig) {
      const q = layers.find(z => z.id === o.id);
      if (q) { q.x = o.x + dx; q.y = o.y + dy; }
    }
  } else if (drag.kind === 'layerResize') {
    const l = layers.find(x => x.id === drag.id); if (!l) return;
    layerResizeTo(l, drag, p);
  } else if (drag.kind === 'shapeEdit') {
    if (drag.mode === 'move') {
      const dx = p.x - drag.ox, dy = p.y - drag.oy;
      for (const o of drag.orig) { const sh = shapes.find(z => z.id === o.id); if (sh) moveShapeTo(sh, o.g, dx, dy); }
    } else {
      const s = shapes.find(x => x.id === drag.id); if (!s) return;
      resizeShapeTo(s, drag, p);
    }
  } else if (drag.kind === 'marquee') {
    drag.x2 = p.x; drag.y2 = p.y;
  } else {
    const s = drag.shape;
    if (s.type === 'brush' || s.type === 'highlight') s.points.push(p);
    else { s.x2 = p.x; s.y2 = p.y; }
  }
  scheduleRender();
}
function onPointerUp(e) {
  if (e && e.pointerType === 'touch') {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  }
  if (pinch) return;
  if (panDrag) { panDrag = null; applyCursor(); return; }
  if (cropDrag) { cropDrag = null; if (crop && (crop.w < 12 || crop.h < 12)) crop = defaultCrop(); $('#cropSec').hidden = !crop; commitGesture(true); render(); return; }
  if (!drag) return;
  const d = drag; drag = null;
  if (d.kind === 'shapeEdit') {
    // additive click that never moved = toggle that annotation off the selection
    if (d.mode === 'move' && d.toggleId && !d.moved) setShapeSel(selShapes.filter(x => x !== d.toggleId));
    commitGesture(!!d.moved); render(); return;
  }
  if (d.kind === 'text') { commitGesture(!!d.moved); render(); return; }
  if (d.kind === 'blob') { commitGesture(!!d.moved || !!d.created); render(); return; }
  if (d.kind === 'layer' || d.kind === 'layerResize') {
    // additive click that never moved = toggle the layer off the selection
    if (d.kind === 'layer' && d.toggleId && !d.moved) setSelection(selLayers.filter(x => x !== d.toggleId));
    commitGesture(!!d.moved);
    updateLayerUI(); render(); return;
  }
  if (d.kind === 'marquee') {
    const r = marqueeRect(d);
    selection = (r.w < 6 || r.h < 6) ? null : r;
    updateSelInfo(); commitGesture(false); render(); return;
  }
  const s = d.shape;
  const moved = (s.points && s.points.length > 1) || Math.abs(s.x2 - s.x1) > 1 || Math.abs(s.y2 - s.y1) > 1;
  if (!moved) { commitGesture(false); render(); return; }
  shapes.push(s);
  commitGesture(true);
  selectShape(s);                  // keep it selected so it can be tweaked straight away
  render();
}
function onPointerCancel(e) {
  if (e && e.pointerType === 'touch') { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; }
  drag = null; cropDrag = null; panDrag = null; applyCursor(); render();
}
function onPointerLeave(e) {
  if (e && e.pointerType === 'touch') { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; }
  if (hoverId) { hoverId = null; scheduleRender(); }
}
function applyCursor() {
  if (panDrag || spaceDown) { stage.style.cursor = 'grab'; return; }
  stage.style.cursor = tool === 'text' ? 'text' : ((tool === 'move' || tool === 'marquee') ? 'default' : 'crosshair');
}
function beginPan(e) {
  panDrag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  try { stage.setPointerCapture(e.pointerId); } catch {}
  applyCursor();
}
// ---- touch navigation: two fingers pan + pinch-zoom, whatever tool is active ----
function pointerMid() {
  const [a, b] = [...pointers.values()];
  const r = stage.getBoundingClientRect();
  return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
           x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
}
function startPinch() {
  // the first finger may already have begun a gesture; a second finger means "navigate", so undo it
  if (gestureSnap) { restore(gestureSnap); drop(gestureSnap); gestureSnap = null; }
  drag = null; cropDrag = null; panDrag = null;
  const m = pointerMid();
  pinch = { d0: m.d, z0: zoom, ix: (m.x - pan.x) / zoom, iy: (m.y - pan.y) / zoom };
  applyCursor();
}
function movePinch() {
  const m = pointerMid();
  zoom = clampZoom(pinch.z0 * (m.d / pinch.d0));
  pan.x = m.x - pinch.ix * zoom;               // keep the image point under the fingers put
  pan.y = m.y - pinch.iy * zoom;
  clampPan(); applyView(); render();
}

/* ------------------------------------------------------------ 9  text */
function selectText(t) {
  selText = t.id; clearShapeSel(); selLayers = []; selLayer = null;
  style.family = t.family; style.bold = t.bold; style.italic = t.italic;
  style.bg = t.bg ?? null; style.bgOpacity = t.bgOpacity ?? 0.8;
  style.pad = t.pad ?? 14; style.radius = t.radius ?? 10;
  $('#fontFamily').value = t.family;
  $('#fontSize').value = Math.min(t.size, 1200);
  $('#fontSizeOut').textContent = Math.round(t.size);
  $('#fontSizeNum').value = Math.round(t.size);
  $('#textBgColor').value = style.bg || '#000000';
  $('#textBgOpacity').value = style.bgOpacity; $('#textBgOpacityOut').textContent = style.bgOpacity;
  $('#textPad').value = style.pad; $('#textPadOut').textContent = style.pad;
  $('#textRadius').value = style.radius; $('#textRadiusOut').textContent = style.radius;
  syncStyleButtons();
  syncTextBgUI();
  updateLayerUI();
  updateSelBar();
}
function createTextBox(p) {
  const pre = snapshot();
  const t = { id: uid(), x: p.x, y: p.y, text: '', color: style.color, size: style.fontSize,
              family: style.family, bold: style.bold, italic: style.italic,
              opacity: Math.max(0.35, style.opacity),
              bg: style.bg, bgOpacity: style.bgOpacity, pad: style.pad, radius: style.radius };
  texts.push(t); selText = t.id; clearShapeSel(); selLayers = []; selLayer = null;
  openTextEditor(t, pre, true);
}
function editSelected() {
  const t = texts.find(x => x.id === selText); if (!t) return;
  openTextEditor(t, snapshot(), false);
}
function openTextEditor(t, pre, isNew) {
  const r = view.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const scale = viewScale(), before = t.text;
  const ta = document.createElement('textarea');
  ta.className = 'textinput';
  ta.value = t.text;
  ta.rows = 1;
  ta.style.left = ((r.left - sr.left) + (t.x - textPad(t)) * scale) + 'px';
  ta.style.top = ((r.top - sr.top) + (t.y - textPad(t)) * scale) + 'px';
  ta.style.color = t.color;
  ta.style.font = fontCss(t, scale);
  // On a phone the fitted image can make the inline editor ~10px tall; keep it legible to type in.
  if (IS_MOBILE) ta.style.fontSize = Math.max(16, Math.round(t.size * scale)) + 'px';
  if (t.bg) {                                    // preview the plate while typing
    ta.style.background = hexToRgba(t.bg, clamp(t.bgOpacity ?? 1, 0, 1));
    ta.style.borderRadius = (t.radius || 0) * scale + 'px';
  }
  if (textPad(t)) ta.style.padding = (textPad(t) * scale) + 'px';
  stage.appendChild(ta);
  const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
                       ta.style.width = Math.max(60, ta.scrollWidth + 10) + 'px'; };
  ta.addEventListener('input', grow); grow();
  setTimeout(() => ta.focus({ preventScroll:true }), 0);
  const commit = () => {
    const v = ta.value;
    if (ta.parentNode) ta.remove();
    t.text = v;
    const emptied = !v.trim();
    if (emptied) { texts = texts.filter(x => x !== t); if (selText === t.id) selText = null; }
    if (v !== before || emptied) commitPre(pre); else drop(pre);
    render();
  };
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { ta.value = ''; ta.blur(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
    e.stopPropagation();
  });
}
function deleteSelected() {
  const t = texts.find(x => x.id === selText);
  const ss = selectedShapeSet();
  if (!t && !ss.length) return;
  const pre = snapshot();
  if (t) { texts = texts.filter(x => x !== t); selText = null; }
  if (ss.length) { const ids = new Set(ss.map(s => s.id)); shapes = shapes.filter(s => !ids.has(s.id)); clearShapeSel(); }
  commitPre(pre);
  render(); updateLayerUI();
}
// The Annotations section's Delete button deletes only annotations.
function deleteSelectedAnns() {
  const ss = selectedShapeSet();
  if (!ss.length) return;
  const pre = snapshot();
  const ids = new Set(ss.map(s => s.id));
  shapes = shapes.filter(s => !ids.has(s.id));
  clearShapeSel();
  commitPre(pre);
  render(); updateLayerUI(); updateSelBar();
}
function duplicateSelected() {
  const t = texts.find(x => x.id === selText);
  const ss = selectedShapeSet();
  if (!t && !ss.length) return;
  const pre = snapshot();
  if (t) { const c = { ...t, id: uid(), x: t.x + t.size * 0.4, y: t.y + t.size * 0.4 }; texts.push(c); selText = c.id; }
  if (ss.length) { const copies = ss.map(dupShape); for (const c of copies) shapes.push(c); setShapeSel(copies.map(c => c.id)); }
  commitPre(pre);
  render(); updateLayerUI(); updateSelBar();
}
function updateSelBar() {
  const bar = $('#selbar');
  const t = texts.find(x => x.id === selText);
  const s = selectedShape();
  if ((!t && !s) || tool === 'crop') { bar.hidden = true; return; }
  $('#selEdit').style.display = t ? '' : 'none';      // an annotation has no text to edit
  const r = view.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const scale = viewScale();
  const b = t ? textRect(t) : shapeBox(s);
  const left = (r.left - sr.left) + b.x * scale;
  const top = (r.top - sr.top) + b.y * scale - 42;
  bar.hidden = false;
  const bw = bar.offsetWidth || 190;
  bar.style.left = clamp(left, 4, Math.max(4, sr.width - bw - 4)) + 'px';
  bar.style.top = clamp(top, 4, sr.height - 40) + 'px';
}

/* ------------------------------------------------------- 10  selection/effects */
function marqueeRect(d) {
  return { x: Math.min(d.startX, d.x2), y: Math.min(d.startY, d.y2),
           w: Math.abs(d.x2 - d.startX), h: Math.abs(d.y2 - d.startY) };
}
function updateSelInfo() {
  const el = $('#selInfo'); if (!el) return;
  el.textContent = selection
    ? `${selection.w} x ${selection.h} at ${selection.x}, ${selection.y}`
    : 'Whole image';
}
function selectAll() {
  if (!hasImage) return;
  if (tool !== 'marquee') setTool('marquee');     // the box is only real under the Select tool
  selection = { x:0, y:0, w:base.width, h:base.height };
  updateSelInfo(); render(); toast('Selected whole image');
}
function clearSelection() { selection = null; updateSelInfo(); render(); }
function regionRect() {
  const r = selection || { x:0, y:0, w:base.width, h:base.height };
  const x = clamp(Math.round(r.x), 0, base.width);
  const y = clamp(Math.round(r.y), 0, base.height);
  return { x, y, w: clamp(Math.round(r.w), 1, base.width - x), h: clamp(Math.round(r.h), 1, base.height - y) };
}
// Effects work on the flattened composite inside the selection, and land as a new layer.
function applyCompositeEffect(kind) {
  if (!hasImage) return;
  const r = regionRect();
  if (r.w < 2 || r.h < 2) return;
  pushUndo();
  const src = composite(false, false);
  const patch = canvas(r.w, r.h);
  const pc = patch.getContext('2d');
  pc.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  if (kind === 'pixelate') {
    const block = Math.max(2, Math.round(fx.block));
    const tw = Math.max(1, Math.round(r.w / block)), th = Math.max(1, Math.round(r.h / block));
    const t = canvas(tw, th);
    t.getContext('2d').drawImage(patch, 0, 0, r.w, r.h, 0, 0, tw, th);
    pc.clearRect(0, 0, r.w, r.h);
    pc.imageSmoothingEnabled = false;
    pc.drawImage(t, 0, 0, tw, th, 0, 0, r.w, r.h);
  } else {
    const t = canvas(r.w, r.h), tc = t.getContext('2d');
    tc.filter = `blur(${Math.max(0.5, fx.soft)}px)`; tc.drawImage(patch, 0, 0);
    pc.clearRect(0, 0, r.w, r.h); pc.drawImage(t, 0, 0);
  }
  const l = { id: uid(), c: patch, x: r.x, y: r.y, w: r.w, h: r.h };
  layers.push(l); checkedLayers.add(l.id);
  setSelection([l.id]);
  render();
  toast((kind === 'pixelate' ? 'Pixelated' : 'Blurred') + ' selection');
}
function applyPixelate() { applyCompositeEffect('pixelate'); }
function applyBlur()     { applyCompositeEffect('blur'); }

// Bake the adjustments as a layer: the whole final image, or just the selection.
// The patch already holds the filtered pixels, so the sliders reset — otherwise
// the live filter would be applied a second time on top of it.
function applyAdjust() {
  if (!hasImage) return;
  if (filterCSS() === 'none') return toast('No adjustments to apply');
  const r = regionRect();
  pushUndo();
  const src = composite(false, true);
  const patch = canvas(r.w, r.h);
  patch.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const l = { id: uid(), c: patch, x: r.x, y: r.y, w: r.w, h: r.h };
  layers.push(l); checkedLayers.add(l.id);
  setSelection([l.id]);
  adjust = { ...DEFAULT_FILTER }; syncAdjustUI();
  render();
  toast(selection ? 'Adjusted the selection' : 'Adjusted the image');
}

// Cheap fingerprint of the decoded pixels. PNG bytes get re-encoded by the browser
// on the way through the system clipboard, but the pixels survive exactly, so this
// is how we tell "that paste is my own copy" from "that paste is a new image".
function pixelSig(src) {
  const c = canvas(32, 32), x = c.getContext('2d');
  x.clearRect(0, 0, 32, 32);
  x.drawImage(src, 0, 0, 32, 32);
  const d = x.getImageData(0, 0, 32, 32).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
}
async function copySel() {
  if (selection) {
    const r = regionRect();
    const comp = composite(true);
    const c = canvas(r.w, r.h);
    c.getContext('2d').drawImage(comp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    clip = { c, region:true, x:r.x, y:r.y, w:r.w, h:r.h };
  } else {
    const l = primaryLayer();
    if (!l) { toast('Select a layer or make a selection first'); return; }
    clip = { c: clone(l.c), region:false, x:l.x, y:l.y, w:l.w, h:l.h };
  }
  // Set this BEFORE any await: paste routing must recognise our own copy immediately,
  // even if the user hits Ctrl+V before the clipboard mirror finishes.
  clipSig = pixelSig(clip.c);
  // Tell the user now rather than after the async write - the mirror is best-effort
  // and can be slow, and the copy is already usable without it.
  toast(clip.region ? 'Copied selection' : 'Copied layer');
  // Best-effort mirror onto the OS clipboard so other apps can paste the copy. Held as a
  // promise so callers can await the write instead of guessing when it has landed.
  clipMirror = (async () => {
    try {
      const blob = await new Promise(r => clip.c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([ new ClipboardItem({ 'image/png': blob }) ]);
    } catch { /* insecure context: internal buffer only, routing still works by pixels */ }
  })();
  return clipMirror;
}
function pasteClip() {
  if (!clip) { toast('Nothing to paste'); return; }
  const pre = snapshot();
  const off = clip.region ? 0 : 24;
  const l = { id: uid(), c: clone(clip.c), x: clip.x + off, y: clip.y + off, w: clip.w, h: clip.h };
  layers.push(l); checkedLayers.add(l.id);
  commitPre(pre);
  setSelection([l.id]);
  render();
  toast(clip.region ? 'Pasted selection as a layer' : 'Duplicated layer');
}
function flattenChecked() {
  const ids = new Set([...checkedLayers].filter(id => layers.some(l => l.id === id)));
  const ann = flattenAnnotations;
  if (!ids.size && !ann) { toast('Tick at least one row to flatten'); return; }
  const pre = snapshot();
  const comp = canvas(base.width, base.height), cx = comp.getContext('2d');
  cx.filter = filterCSS(); cx.drawImage(base, 0, 0);
  for (const l of layers) if (ids.has(l.id)) cx.drawImage(l.c, l.x, l.y, l.w, l.h);
  if (ann) {
    for (const s of shapes) paintShape(cx, s);
    cx.drawImage(overlay, 0, 0);
    for (const t of texts) paintText(cx, t);
  }
  base = comp; bctx = base.getContext('2d');
  layers = layers.filter(l => !ids.has(l.id));
  if (ann) {
    overlay = canvas(base.width, base.height); octx = overlay.getContext('2d');
    texts = []; selText = null;
    shapes = []; clearShapeSel();
  }
  adjust = { ...DEFAULT_FILTER }; syncAdjustUI();
  checkedLayers = new Set(layers.map(l => l.id));   // survivors are ticked again by default
  if (ann) flattenAnnotations = false;              // annotations were just baked in
  commitPre(pre);
  setSelection(selLayers);
  render();
  toast('Flattened into the background');
}
function doWand(p) {
  const l = primaryLayer();
  const tgt = l ? l.c : base;
  const tctx = l ? tgt.getContext('2d') : bctx;
  const kx = l ? tgt.width / l.w : 1, ky = l ? tgt.height / l.h : 1;
  const x = Math.round(l ? (p.x - l.x) * kx : p.x);
  const y = Math.round(l ? (p.y - l.y) * ky : p.y);
  if (x < 0 || y < 0 || x >= tgt.width || y >= tgt.height) return;
  const b = selection
    ? (l ? { x:(selection.x - l.x) * kx, y:(selection.y - l.y) * ky, w:selection.w * kx, h:selection.h * ky }
         : selection)
    : null;
  const img = tctx.getImageData(0, 0, tgt.width, tgt.height);
  const fill = wand.transparent ? null : hexToRgb(wand.color);
  const filled = floodFill(img, tgt.width, tgt.height, x, y, wand.tolerance, wand.global, b, fill);
  if (!filled) { toast('Nothing matched — raise tolerance'); return; }
  pushUndo();
  // history may still own this canvas; take a private copy before writing pixels
  if (l) { ownLayer(l); l.c.getContext('2d').putImageData(img, 0, 0); }
  else   { ownBase();  bctx.putImageData(img, 0, 0); }
  paintSeq++;
  render();
  toast((wand.transparent ? 'Cleared ' : 'Filled ') + filled.toLocaleString() + ' px');
}
// `fill` is an [r,g,b] colour to paint the matched region, or null to clear it to transparent.
function floodFill(img, w, h, sx, sy, tolerance, globalMode, b, fill) {
  const d = img.data;
  const x0 = b ? Math.max(0, b.x) : 0, y0 = b ? Math.max(0, b.y) : 0;
  const x1 = b ? Math.min(w, b.x + b.w) : w, y1 = b ? Math.min(h, b.y + b.h) : h;
  if (sx < x0 || sx >= x1 || sy < y0 || sy >= y1) return 0;
  const i0 = (sy * w + sx) * 4;
  const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
  const max = (tolerance / 100) * 441.67;
  const th2 = max * max;
  const eq = i => {
    if (d[i + 3] === 0 && ta === 0) return true;
    const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb;
    return dr * dr + dg * dg + db * db <= th2;
  };
  const put = i => {
    if (fill) { d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = 255; }
    else d[i + 3] = 0;
  };
  if (globalMode) {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] !== 0 && eq(i)) { put(i); n++; }
    }
    return n;
  }
  const seen = new Uint8Array(w * h);
  const stack = [sx, sy];
  let n = 0;
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    let xl = x;
    while (xl >= x0 && !seen[y * w + xl] && eq((y * w + xl) * 4)) xl--;
    xl++;
    let xr = x;
    while (xr < x1 && !seen[y * w + xr] && eq((y * w + xr) * 4)) xr++;
    xr--;
    for (let xi = xl; xi <= xr; xi++) {
      const k = y * w + xi;
      seen[k] = 1; put(k * 4); n++;
      if (y > y0 && !seen[k - w] && eq((k - w) * 4)) { stack.push(xi, y - 1); }
      if (y < y1 - 1 && !seen[k + w] && eq((k + w) * 4)) { stack.push(xi, y + 1); }
    }
  }
  return n;
}

/* -------------------------------------------------------------- 11  layers */
function makeThumb(src) {
  const t = canvas(36, 27), x = t.getContext('2d');
  const k = Math.min(36 / src.width, 27 / src.height);
  const w = Math.max(1, src.width * k), h = Math.max(1, src.height * k);
  x.drawImage(src, (36 - w) / 2, (27 - h) / 2, w, h);
  return t.toDataURL();
}
function updateLayerUI() {
  if (!layerList) return;
  layerList.innerHTML = '';
  const addRow = (label, thumb, opts = {}) => {
    const row = document.createElement('div');
    const active = opts.id ? selLayers.includes(opts.id) : false;
    row.className = 'layerRow' + (active ? ' active' : '') + (opts.pinned ? ' pinned' : '');
    if (opts.tick) {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = opts.tick();
      cb.onclick = ev => { ev.stopPropagation(); opts.onTick(cb.checked); };
      row.appendChild(cb);
    } else if (thumb) {
      const im = document.createElement('img'); im.src = thumb; row.appendChild(im);
    } else {
      const sp = document.createElement('span'); sp.className = 'layerDot'; row.appendChild(sp);
    }
    const tx = document.createElement('span'); tx.className = 'lbl'; tx.textContent = label;
    row.appendChild(tx);
    if (opts.onclick) row.onclick = opts.onclick;
    layerList.appendChild(row);
  };
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    addRow('Layer ' + (i + 1), makeThumb(l.c), {
      id: l.id,
      tick: () => checkedLayers.has(l.id),
      onTick: v => { if (v) checkedLayers.add(l.id); else checkedLayers.delete(l.id); },
      onclick: e => {
        if (e && (e.ctrlKey || e.metaKey)) {
          setSelection(selLayers.includes(l.id) ? selLayers.filter(x => x !== l.id) : [...selLayers, l.id]);
        } else if (e && e.shiftKey && selLayer) {
          const order = layers.map(z => z.id).reverse();
          const a = order.indexOf(selLayer), b = order.indexOf(l.id);
          setSelection(order.slice(Math.min(a, b), Math.max(a, b) + 1));
        } else {
          setSelection([l.id]);
        }
        selText = null; clearShapeSel(); render();
      }
    });
  }
  addRow('Background', makeThumb(base), { pinned: true });

  const i = layers.findIndex(l => l.id === selLayer);
  const has = i >= 0;
  $('#layFront').disabled = !has || i === layers.length - 1;
  $('#layUp').disabled    = !has || i === layers.length - 1;
  $('#layDown').disabled  = !has || i === 0;
  $('#layBack').disabled  = !has || i === 0;
  $('#layRotL').disabled = !has; $('#layRotR').disabled = !has;
  $('#layDel').disabled = movingIds().length === 0;
  $('#annFlatten').checked = flattenAnnotations;
  $('#layFlatten').disabled = checkedLayers.size === 0;
  $('#layerCount').textContent = layers.length
    ? layers.length + (layers.length === 1 ? ' layer' : ' layers')
    : 'No layers yet';
  updateAnnUI();
}
function layerMove(dir) {
  const i = layers.findIndex(l => l.id === selLayer); if (i < 0) return;
  const pre = snapshot();
  const [l] = layers.splice(i, 1);
  let j = i;
  if (dir === 'front') j = layers.length;
  else if (dir === 'back') j = 0;
  else if (dir === 'up') j = Math.min(layers.length, i + 1);
  else j = Math.max(0, i - 1);
  layers.splice(j, 0, l);
  commitPre(pre);
  updateLayerUI(); render();
}
function layerDelete() {
  const ids = movingIds();
  if (!ids.length) return;
  const pre = snapshot();
  layers = layers.filter(l => !ids.includes(l.id));
  for (const id of ids) checkedLayers.delete(id);
  selLayers = []; selLayer = null;
  commitPre(pre);
  updateLayerUI(); render();
}
function layerRotate(deg) {
  const l = primaryLayer(); if (!l) return;
  const pre = snapshot();
  const ow = l.w, oh = l.h, cx = l.x + ow / 2, cy = l.y + oh / 2;
  const t = canvas(l.c.height, l.c.width), c = t.getContext('2d');
  c.translate(t.width / 2, t.height / 2); c.rotate(deg * Math.PI / 180);
  c.drawImage(l.c, -l.c.width / 2, -l.c.height / 2);
  l.c = t; l.w = oh; l.h = ow;
  l.x = cx - l.w / 2; l.y = cy - l.h / 2;
  commitPre(pre);
  updateLayerUI(); render();
}
function toggleLayers() {
  const body = $('#layersBody');
  body.hidden = !body.hidden;
  $('#layersToggle').textContent = body.hidden ? 'Show' : 'Hide';
}
function toggleAnn() {
  const body = $('#annBody');
  body.hidden = !body.hidden;
  $('#annToggle').textContent = body.hidden ? 'Show' : 'Hide';
}

/* ------------------------------------------------- 11b  annotations list */
const ANN_NAMES = { brush:'Pen', highlight:'Highlight', line:'Line', arrow:'Arrow', rect:'Rect', ellipse:'Ellipse' };
function updateAnnUI() {
  const list = $('#annList'); if (!list) return;
  const del = $('#annDel');
  if (del) del.disabled = !selectedShapeSet().length;
  list.innerHTML = '';
  if (!shapes.length) {
    const d = document.createElement('div'); d.className = 'note'; d.textContent = 'No annotations yet';
    list.appendChild(d);
    return;
  }
  for (let i = 0; i < shapes.length; i++) {              // left -> right = back -> front
    const s = shapes[i];
    const row = document.createElement('div');
    row.className = 'annRow' + (selShapes.includes(s.id) ? ' active' : '');
    row.dataset.id = s.id;
    row.title = (ANN_NAMES[s.type] || s.type) + ' — drag to restack';
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = s.color;
    const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = ANN_NAMES[s.type] || s.type;
    row.append(sw, lbl);
    row.addEventListener('pointerdown', ev => annRowDown(ev, s.id));
    list.appendChild(row);
  }
}
// Click selects (same modifiers as the canvas), drag restacks. Display order == array order.
function annRowDown(e, id) {
  e.preventDefault(); e.stopPropagation();
  if (!shapes.some(s => s.id === id)) return;
  let toggleId = null;
  const additive = e.ctrlKey || e.metaKey;
  const inSel = selShapes.includes(id);
  if (e.shiftKey && selShape && !additive) {
    const a = shapes.findIndex(z => z.id === selShape), b = shapes.findIndex(z => z.id === id);
    setShapeSel(shapes.slice(Math.min(a, b), Math.max(a, b) + 1).map(z => z.id));
  } else if (additive) {
    if (inSel) toggleId = id; else setShapeSel([...selShapes, id]);
  } else if (!inSel) setShapeSel([id]);
  else if (selShape !== id) { selShape = id; updateLayerUI(); }

  const pre = snapshot();
  let moved = false;
  const onMove = ev => {
    const kids = [...$('#annList').children].filter(el => el.dataset && el.dataset.id);
    let target = -1;
    for (let i = 0; i < kids.length; i++) {
      const b = kids[i].getBoundingClientRect();
      if (ev.clientX >= b.left && ev.clientX < b.right) { target = i; break; }
    }
    if (target < 0) return;
    const cur = shapes.findIndex(x => x.id === id);
    if (cur < 0 || target === cur) return;
    const [sh] = shapes.splice(cur, 1);
    shapes.splice(target, 0, sh);
    moved = true; render(); updateAnnUI();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (toggleId && !moved) setShapeSel(selShapes.filter(x => x !== toggleId));
    if (moved) commitPre(pre); else drop(pre);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ---------------------------------------------------------------- 12  crop */
function defaultCrop() {
  const w = Math.round(base.width * 0.8), h = Math.round(base.height * 0.8);
  return { x: Math.round((base.width - w) / 2), y: Math.round((base.height - h) / 2), w, h };
}
function cropHandlePoints() {
  const { x, y, w, h } = crop;
  return {
    nw:[x, y], n:[x + w / 2, y], ne:[x + w, y],
    w:[x, y + h / 2], e:[x + w, y + h / 2],
    sw:[x, y + h], s:[x + w / 2, y + h], se:[x + w, y + h],
  };
}
function cropHit(e) {
  if (!crop) return null;
  const r = view.getBoundingClientRect(), s = viewScale();
  const pts = cropHandlePoints();
  const R = HANDLE_PX / 2;
  for (const k in pts) {
    const [hx, hy] = pts[k];
    if (Math.abs(e.clientX - (r.left + hx * s)) <= R && Math.abs(e.clientY - (r.top + hy * s)) <= R) return k;
  }
  const X1 = r.left + crop.x * s, Y1 = r.top + crop.y * s;
  const X2 = X1 + crop.w * s, Y2 = Y1 + crop.h * s;
  if (e.clientX > X1 && e.clientX < X2 && e.clientY > Y1 && e.clientY < Y2) return 'move';
  return null;
}
function cropDown(e, p) {
  const mode = cropHit(e);
  if (mode && crop) { beginGesture(); cropDrag = { mode, startX:p.x, startY:p.y, orig:{ ...crop } }; }
  else {
    beginGesture();
    crop = { x:p.x, y:p.y, w:0, h:0 };
    cropDrag = { mode:'new', startX:p.x, startY:p.y, orig:null };
  }
  view.setPointerCapture(e.pointerId);
  render();
}
function applyCropDrag(p) {
  const d = cropDrag; if (!d) return;
  let l, t, r2, b;
  if (d.mode === 'new') {
    l = Math.min(d.startX, p.x); t = Math.min(d.startY, p.y);
    r2 = Math.max(d.startX, p.x); b = Math.max(d.startY, p.y);
  } else if (d.mode === 'move') {
    const o = d.orig;
    l = clamp(o.x + (p.x - d.startX), 0, base.width - o.w);
    t = clamp(o.y + (p.y - d.startY), 0, base.height - o.h);
    r2 = l + o.w; b = t + o.h;
  } else {
    const o = d.orig;
    l = o.x; t = o.y; r2 = o.x + o.w; b = o.y + o.h;
    const dx = p.x - d.startX, dy = p.y - d.startY;
    if (d.mode.includes('w')) l = clamp(l + dx, 0, r2 - 8);
    if (d.mode.includes('e')) r2 = clamp(r2 + dx, l + 8, base.width);
    if (d.mode.includes('n')) t = clamp(t + dy, 0, b - 8);
    if (d.mode.includes('s')) b = clamp(b + dy, t + 8, base.height);
  }
  l = clamp(l, 0, base.width); t = clamp(t, 0, base.height);
  r2 = clamp(r2, 0, base.width); b = clamp(b, 0, base.height);
  crop = { x:Math.min(l, r2), y:Math.min(t, b), w:Math.abs(r2 - l), h:Math.abs(b - t) };
}
function drawCropOverlay() {
  const s = viewScale();
  cctx.save();
  cctx.fillStyle = 'rgba(0,0,0,.58)';
  cctx.beginPath(); cctx.rect(0, 0, view.width, view.height); cctx.rect(crop.x, crop.y, crop.w, crop.h);
  cctx.fill('evenodd');
  cctx.strokeStyle = 'rgba(255,255,255,.4)'; cctx.lineWidth = 1 / s;
  for (let i = 1; i < 3; i++) {
    const gx = crop.x + crop.w * i / 3, gy = crop.y + crop.h * i / 3;
    cctx.beginPath(); cctx.moveTo(gx, crop.y); cctx.lineTo(gx, crop.y + crop.h); cctx.stroke();
    cctx.beginPath(); cctx.moveTo(crop.x, gy); cctx.lineTo(crop.x + crop.w, gy); cctx.stroke();
  }
  cctx.strokeStyle = '#3b82f6'; cctx.lineWidth = 2 / s;
  cctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
  const hs = 16 / s, pts = cropHandlePoints();
  cctx.fillStyle = '#fff'; cctx.lineWidth = 2 / s; cctx.strokeStyle = '#3b82f6';
  for (const k in pts) {
    const [hx, hy] = pts[k];
    cctx.beginPath(); cctx.rect(hx - hs / 2, hy - hs / 2, hs, hs); cctx.fill(); cctx.stroke();
  }
  cctx.restore();
}
function applyCrop() {
  if (!crop || crop.w < 8 || crop.h < 8) return cancelCrop();
  const x = Math.round(crop.x), y = Math.round(crop.y);
  const w = Math.round(crop.w), h = Math.round(crop.h);
  pushUndo();
  const nb = canvas(w, h);
  nb.getContext('2d').drawImage(base, x, y, w, h, 0, 0, w, h);
  const no = canvas(w, h);
  no.getContext('2d').drawImage(overlay, x, y, w, h, 0, 0, w, h);
  layers.forEach(l => { l.x -= x; l.y -= y; });
  texts = texts
    .map(tx => ({ ...tx, x: tx.x - x, y: tx.y - y }))
    .filter(tx => tx.x > -tx.size * 2 && tx.y > -tx.size * 2 && tx.x < w && tx.y < h);
  shapes.forEach(s => translateShape(s, -x, -y));
  shapes = shapes.filter(s => { const b = shapeBox(s); return b.x < w && b.y < h && b.x + b.w > 0 && b.y + b.h > 0; });
  selShapes = selShapes.filter(id => shapes.some(s => s.id === id));
  if (selShape && !shapes.some(s => s.id === selShape)) selShape = selShapes.length ? selShapes[selShapes.length - 1] : null;
  base = nb; bctx = base.getContext('2d');
  overlay = no; octx = overlay.getContext('2d');
  crop = null; $('#cropSec').hidden = true;
  selection = null; updateSelInfo();
  resizeView(); render(); updateLayerUI(); setTool('move');
  toast('Cropped');
}
function cancelCrop() { crop = null; cropDrag = null; $('#cropSec').hidden = true; render(); }

/* ----------------------------------------------------------- 13  transform */
function bakeTexts() {
  if (!texts.length) return;
  ownOverlay();                    // history may still own this exact canvas
  for (const t of texts) paintText(octx, t);
  texts = []; selText = null;
  paintSeq++;
}
function rotCanvas(src, deg) {
  const t = canvas(src.height, src.width), c = t.getContext('2d');
  c.translate(t.width / 2, t.height / 2); c.rotate(deg * Math.PI / 180);
  c.drawImage(src, -src.width / 2, -src.height / 2);
  return t;
}
function resizeAll(w, h) {
  const kx = w / base.width, ky = h / base.height;
  pushUndo();
  const nb = canvas(w, h); nb.getContext('2d').drawImage(base, 0, 0, w, h);
  const no = canvas(w, h); no.getContext('2d').drawImage(overlay, 0, 0, w, h);
  layers.forEach(l => { l.x *= kx; l.y *= ky; l.w *= kx; l.h *= ky; });
  texts.forEach(t => { t.x *= kx; t.y *= ky; t.size *= ky; });
  shapes.forEach(s => scaleShape(s, kx, ky));
  blobs.forEach(b => { b.x *= kx; b.y *= ky; b.r *= (kx + ky) / 2; });
  base = nb; bctx = base.getContext('2d');
  overlay = no; octx = overlay.getContext('2d');
  selection = null; updateSelInfo();
  resizeView(); render(); updateLayerUI(); toast('Resized');
}
// With a layer selected these act on that layer; otherwise on the whole composition.
function rotate(deg) {
  const l = primaryLayer();
  pushUndo();
  if (l) {
    const ow = l.w, oh = l.h, cx = l.x + ow / 2, cy = l.y + oh / 2;
    l.c = rotCanvas(l.c, deg); l.w = oh; l.h = ow;
    l.x = cx - l.w / 2; l.y = cy - l.h / 2;
    updateLayerUI(); render(); toast('Rotated layer'); return;
  }
  bakeTexts();
  const W = base.width, H = base.height;
  shapes.forEach(s => mapShape(s, pt => deg > 0 ? { x: H - pt.y, y: pt.x } : { x: pt.y, y: W - pt.x }));
  layers.forEach(lz => {
    const nx = deg > 0 ? H - (lz.y + lz.h) : lz.y;
    const ny = deg > 0 ? lz.x : W - (lz.x + lz.w);
    const ow = lz.w, oh = lz.h;
    lz.c = rotCanvas(lz.c, deg);
    lz.w = oh; lz.h = ow; lz.x = nx; lz.y = ny;
  });
  const no = rotCanvas(overlay, deg);
  base = rotCanvas(base, deg); bctx = base.getContext('2d');
  overlay = no; octx = overlay.getContext('2d');
  selection = null; updateSelInfo();
  resizeView(); render(); updateLayerUI(); toast('Rotated canvas');
}
function flip(axis) {
  const l = primaryLayer();
  pushUndo();
  const mirror = src => {
    const t = canvas(src.width, src.height), c = t.getContext('2d');
    c.translate(axis === 'h' ? t.width : 0, axis === 'v' ? t.height : 0);
    c.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
    c.drawImage(src, 0, 0);
    return t;
  };
  if (l) { l.c = mirror(l.c); updateLayerUI(); render(); toast('Flipped layer'); return; }
  bakeTexts();
  const W = base.width, H = base.height;
  shapes.forEach(s => mapShape(s, pt => axis === 'h' ? { x: W - pt.x, y: pt.y } : { x: pt.x, y: H - pt.y }));
  layers.forEach(lz => {
    const nx = axis === 'h' ? W - (lz.x + lz.w) : lz.x;
    const ny = axis === 'v' ? H - (lz.y + lz.h) : lz.y;
    lz.c = mirror(lz.c); lz.x = nx; lz.y = ny;
  });
  const no = mirror(overlay);
  base = mirror(base); bctx = base.getContext('2d');
  overlay = no; octx = overlay.getContext('2d');
  selection = null; updateSelInfo();
  resizeView(); render(); updateLayerUI(); toast('Flipped canvas');
}

/* ----------------------------------------------------------------- 14  fun */
// Inverse-mapped bulge / pinch. strength > 0 magnifies, < 0 pinches.
function bulge(src, cx, cy, r, strength) {
  const w = src.width, h = src.height;
  const out = canvas(w, h), oc = out.getContext('2d');
  oc.drawImage(src, 0, 0);
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const img = oc.getImageData(0, 0, w, h), od = img.data;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h, Math.ceil(cy + r));
  for (let y = y0; y < y1; y++) {
    const dy = y - cy;
    for (let x = x0; x < x1; x++) {
      const dx = x - cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= r) continue;
      const t = d / r;
      const f = 1 - strength * (1 - t * t);
      const sx = Math.round(cx + dx * f), sy = Math.round(cy + dy * f);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const si = (sy * w + sx) * 4, di = (y * w + x) * 4;
      od[di] = sd[si]; od[di + 1] = sd[si + 1]; od[di + 2] = sd[si + 2]; od[di + 3] = sd[si + 3];
    }
  }
  oc.putImageData(img, 0, 0);
  return out;
}
// Blobs live in composition space; map them onto whatever is about to be fried.
function warpedSource() {
  const l = primaryLayer();
  let c = clone(l ? l.c : base);
  if (!blobs.length) return c;
  const kx = l ? c.width / l.w : 1, ky = l ? c.height / l.h : 1;
  const ox = l ? l.x : 0, oy = l ? l.y : 0;
  for (const b of blobs) c = bulge(c, (b.x - ox) * kx, (b.y - oy) * ky, b.r * kx, b.str);
  return c;
}
function sharpen(img, w, h, k) {
  const src = new Uint8ClampedArray(img.data), d = img.data, c0 = 1 + 4 * k;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        d[i + ch] = src[i + ch] * c0 - k * (src[i - 4 + ch] + src[i + 4 + ch] + src[i - w * 4 + ch] + src[i + w * 4 + ch]);
      }
    }
  }
}
function addNoise(img, amount) {
  const d = img.data, a = amount * 0.9;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() * 2 - 1) * a;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
}
async function fryPass(src, P, i) {
  const w = src.width, h = src.height;
  const t = canvas(w, h), c = t.getContext('2d');
  c.filter = `saturate(${P.sat * 100}%) contrast(${P.con * 100}%) brightness(${100 + i * 3}%)`;
  c.drawImage(src, 0, 0);
  const img = c.getImageData(0, 0, w, h);
  if (P.sh) sharpen(img, w, h, P.sh);
  if (P.nz) addNoise(img, P.nz);
  c.putImageData(img, 0, 0);
  const blob = await new Promise(r => t.toBlob(r, 'image/jpeg', P.q / 100));
  const bmp = await createImageBitmap(blob);
  const o = canvas(w, h); o.getContext('2d').drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return o;
}
async function deepfry(level) {
  if (!hasImage) return;
  const P = FRY[level] || FRY.deep;
  pushUndo();
  toast('Frying…');
  await new Promise(r => setTimeout(r, 20));
  const l = primaryLayer();
  let c = warpedSource();                    // distort blobs are applied before frying
  for (let i = 0; i < P.passes; i++) c = await fryPass(c, P, i);
  if (l) { l.c = c; updateLayerUI(); render(); } else setBase(c);
  toast('Deep fried: ' + level);
}

/* ------------------------------------------------------------------ 15  bg */
// Same-origin path nginx proxies to the rembg container. Opened as a bare file there is no
// proxy, so fall back to the sidecar's published port. The endpoint is never shown to the user.
let bgEndpoint = location.protocol.startsWith('http') ? '/bg/api/remove' : 'http://localhost:3101/api/remove';
let bgProbeUrl = location.protocol.startsWith('http') ? '/bg/' : 'http://localhost:3101/';
// The sidecar is optional: nginx replies 502/503/504 when the rembg upstream is down, so only
// reveal the section when it actually answers. Re-checked whenever the Image tab is opened.
async function syncBgSection() {
  let up = false;
  try { const r = await fetch(bgProbeUrl, { method:'GET', cache:'no-store' }); up = r.status < 500 || r.status > 504; }
  catch { up = false; }
  $('#bgSec').hidden = !up;
  return up;
}
async function removeBgServer() {
  if (!hasImage) return;
  const l = primaryLayer();
  const src = l ? l.c : base;
  toast('Removing background…');
  try {
    const blob = await new Promise(r => src.toBlob(r, 'image/png'));
    const fd = new FormData();
    fd.append('file', blob, 'image.png');
    const res = await fetch(bgEndpoint, { method:'POST', body:fd });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const out = await res.blob();
    const bmp = await createImageBitmap(out);
    pushUndo();
    const c = canvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    if (l) { l.c = c; updateLayerUI(); render(); } else setBase(c);
    toast('Background removed' + (l ? ' from layer' : ''));
  } catch (err) {
    console.error(err);
    toast('Failed: ' + err.message);
  }
}

/* -------------------------------------------------------------- 16  export */
function composite(withAnnotations = true, withFilter = true) {
  const raw = canvas(base.width, base.height), rc = raw.getContext('2d');
  rc.drawImage(base, 0, 0);
  for (const l of layers) rc.drawImage(l.c, l.x, l.y, l.w, l.h);
  if (withAnnotations) {
    for (const s of shapes) paintShape(rc, s);
    rc.drawImage(overlay, 0, 0);
    for (const tx of texts) paintText(rc, tx);
  }
  const f = withFilter ? filterCSS() : 'none';
  if (f === 'none') return raw;
  const t = canvas(raw.width, raw.height), c = t.getContext('2d');
  c.filter = f; c.drawImage(raw, 0, 0);
  return t;
}
function flatten(format, quality) {
  const src = composite();
  const t = canvas(src.width, src.height), c = t.getContext('2d');
  if (format === 'image/jpeg') { c.fillStyle = '#fff'; c.fillRect(0, 0, t.width, t.height); }
  c.drawImage(src, 0, 0);
  return new Promise(res => t.toBlob(res, format, quality));
}
async function download() {
  const fmt = $('#fmt').value, q = parseFloat($('#quality').value);
  const blob = await flatten(fmt, q);
  const ext = { 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp' }[fmt];
  const name = (($('#fname').value || 'image').replace(/\.[^.]+$/, '')) + '.' + ext;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Downloaded ' + name);
}
async function copyToClipboard() {
  if (!navigator.clipboard || !window.ClipboardItem) return toast('Clipboard API unavailable');
  try {
    const blob = await flatten('image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png':blob })]);
    toast('Copied to clipboard');
  } catch (err) { console.error(err); toast('Clipboard blocked — needs https/localhost'); }
}

/* ------------------------------------------------------------ 17  document */
function syncOverlaySize() {
  if (overlay.width !== base.width || overlay.height !== base.height) {
    const t = canvas(base.width, base.height);
    t.getContext('2d').drawImage(overlay, 0, 0);
    overlay = t; octx = overlay.getContext('2d');
  }
}
function resizeView() {
  const changed = view.width !== base.width || view.height !== base.height;
  view.width = base.width; view.height = base.height;
  view.style.display = 'block';
  chromeCanvas.style.display = 'block';
  $('#hint').style.display = 'none';
  $('#rw').value = base.width; $('#rh').value = base.height;
  aspect = base.width / base.height;
  syncOverlaySize();
  zoomHud.hidden = false;
  if (changed) fitView(false);          // a new size starts fitted...
  else { clampPan(); applyView(); }     // ...an unchanged size keeps the user's zoom
}
function setBase(c) {
  base = c; bctx = base.getContext('2d');
  selection = null; updateSelInfo();     // geometry changed, so any marquee is stale
  resizeView(); render();
}
function resetStack(c) {
  hasImage = true;
  dropStack(undoStack); dropStack(redoStack); drop(gestureSnap); gestureSnap = null;
  texts = []; selText = null; shapes = []; clearShapeSel(); crop = null; cropDrag = null; selection = null;
  layers = []; selLayer = null; selLayers = [];
  checkedLayers = new Set(); flattenAnnotations = true; clip = null; clipSig = null;
  adjust = { ...DEFAULT_FILTER }; syncAdjustUI();
  base = c; bctx = c.getContext('2d');
  overlay = canvas(c.width, c.height); octx = overlay.getContext('2d');
  resizeView(); render();
  updateHistoryUI(); updateSelInfo(); updateLayerUI(); setTool('move');
}
function addLayer(src) {
  const pre = snapshot();
  let w = src.width, h = src.height;
  if (w > base.width || h > base.height) {
    const k = Math.min(base.width / w, base.height / h);
    w = Math.round(w * k); h = Math.round(h * k);
  }
  const c = canvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  const l = { id: uid(), c, x: Math.round((base.width - w) / 2), y: Math.round((base.height - h) / 2), w, h };
  layers.push(l); checkedLayers.add(l.id);
  commitPre(pre);
  setSelection([l.id]);
  render();
  toast('Added layer ' + layers.length);
}
function loadSource(src, w, h) {
  const c = canvas(w, h); c.getContext('2d').drawImage(src, 0, 0);
  resetStack(c);
  toast('Canvas ' + w + ' x ' + h);
}
async function blobToSource(blob) {
  try { return await createImageBitmap(blob); }
  catch {
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
}
async function loadBlob(blob) {
  try {
    const src = await blobToSource(blob);
    if (!hasImage) loadSource(src, src.width, src.height);
    else addLayer(src);
    if (src.close) src.close();
  } catch { toast('Could not decode that image'); }
}
function newCanvas() {
  const w = parseInt($('#newW').value, 10), h = parseInt($('#newH').value, 10);
  if (!w || !h || w < 1 || h < 1) return toast('Enter a valid size');
  const bg = $('#newBg').value;
  const c = canvas(w, h);
  if (bg !== 'transparent') { const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, w, h); }
  $('#dialog').hidden = true;
  loadSource(c, w, h);
}
function clearEverything() {
  hasImage = false;
  layers = []; texts = []; shapes = []; selLayer = null; selText = null; selShape = null; selShapes = []; selLayers = [];
  checkedLayers = new Set(); flattenAnnotations = true;
  dropStack(undoStack); dropStack(redoStack); drop(gestureSnap); gestureSnap = null;
  selection = null; crop = null; cropDrag = null;
  base = canvas(1, 1); bctx = base.getContext('2d');
  overlay = canvas(1, 1); octx = overlay.getContext('2d');
  view.width = 1; view.height = 1;
  view.style.display = 'none';
  chromeCanvas.style.display = 'none';
  renderChrome();
  $('#hint').style.display = '';
  $('#dialog').hidden = true;
  zoom = fitZoom = 1; pan.x = pan.y = 0; atFit = true; zoomHud.hidden = true; cacheSigVal = null;
  updateHistoryUI(); updateSelInfo(); updateLayerUI(); syncAdjustUI();
  toast('Cleared');
}

/* -------------------------------------------------------------- 18  wiring */
function syncAdjustUI() {
  for (const k of Object.keys(DEFAULT_FILTER)) $('#' + k).value = adjust[k];
  $('#qRow').style.display = $('#fmt').value === 'image/png' ? 'none' : '';
}
function setRange(id, v) {
  const el = $('#' + id); el.value = String(v);
  el.dispatchEvent(new Event('input'));
}
function bindRange(id, key, out, xform = v => v) {
  const el = $('#' + id);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (out) $('#' + out).textContent = v;
    if (key in adjust) { adjust[key] = xform(v); render(); }
    else if (key in wand) { wand[key] = v; }
    else if (key in fx) { fx[key] = v; }
    else if (key in blobCfg) { blobCfg[key] = v; }
    else { style[key] = xform(v); applyStyleToSelection(key, style[key]); }
  });
}
function syncStyleButtons() {
  $('#boldBtn').classList.toggle('active', style.bold);
  $('#italicBtn').classList.toggle('active', style.italic);
}
// Text-background controls are inert until a background colour is chosen — grey them out.
function syncTextBgUI() {
  const on = !!style.bg;
  $('#textBgOn').checked = on;
  for (const id of ['textBgColor', 'textBgOpacity', 'textPad', 'textRadius']) $('#' + id).disabled = !on;
}
function applyToSelectedText(fn) {
  const t = texts.find(x => x.id === selText);
  if (!t) return;
  const pre = snapshot(); fn(t); render(); commitPre(pre);
}
// Live style edits (colour / width / opacity / fill) can target a text box or an annotation.
// A burst of slider / colour-picker input collapses into a single undo entry.
let styleBurst = null;
function liveStyleEdit(mutate) {
  if (!styleBurst) pushUndo();
  clearTimeout(styleBurst);
  styleBurst = setTimeout(() => { styleBurst = null; }, 600);
  mutate(); render();
}
function applyStyleToSelection(key, val) {
  const targets = [texts.find(x => x.id === selText), selectedShape()].filter(o => o && key in o);
  if (!targets.length) return;
  liveStyleEdit(() => { for (const o of targets) { o[key] = val; touchShape(o); } });
}
// One font size, two inputs (slider for feel, number for 4K-sized type).
function setFontSize(v) {
  v = clamp(Math.round(v) || 1, 1, 6000);
  style.fontSize = v;
  $('#fontSize').value = Math.min(v, 1200);
  $('#fontSizeOut').textContent = v;
  $('#fontSizeNum').value = v;
  const t = texts.find(x => x.id === selText);
  if (t) { t.size = v; render(); }
}
function syncRatio(from) {
  if (!$('#lockRatio').checked) return;
  const w = parseInt($('#rw').value, 10), h = parseInt($('#rh').value, 10);
  if (from === 'w' && w > 0) $('#rh').value = Math.max(1, Math.round(w / aspect));
  else if (from === 'h' && h > 0) $('#rw').value = Math.max(1, Math.round(h * aspect));
}
function toggleSheet(open) {
  panel.classList.toggle('open', open);
  backdrop.classList.toggle('show', open);
}
function nudgeSelected(dx, dy) {
  const t = texts.find(x => x.id === selText);
  const ss = selectedShapeSet();
  const ids = movingIds();
  if (!t && !ss.length && !ids.length) return;
  if (!nudgeTimer) pushUndo();               // one undo entry per burst of arrow presses
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { nudgeTimer = null; }, 700);
  if (t) { t.x += dx; t.y += dy; }
  for (const sh of ss) translateShape(sh, dx, dy);
  for (const id of ids) {
    const l = layers.find(z => z.id === id);
    if (l) { l.x += dx; l.y += dy; }
  }
  render();
}
function onKeyDown(e) {
  const el = e.target;
  if (isTypingTarget(el)) return;                 // never hijack real text entry
  const onControl = !!(el && (el.tagName === 'INPUT' || el.tagName === 'SELECT'));
  const mod = e.ctrlKey || e.metaKey;
  // single-letter tool shortcuts (plain keys only, so Ctrl+C/V/S/A/Z are untouched)
  if (!mod && !e.altKey && !e.shiftKey) {
    const toolId = TOOL_KEYS[e.key.toLowerCase()];
    if (toolId) { e.preventDefault(); setTool(toolId); return; }
  }
  if ((e.key === ' ' || e.code === 'Space') && !onControl) { e.preventDefault(); if (!spaceDown) { spaceDown = true; applyCursor(); } return; }
  if (!mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); if (hasImage) setZoom(zoom * 1.25); return; }
  if (!mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); if (hasImage) setZoom(zoom / 1.25); return; }
  if (!mod && e.key === '0') { e.preventDefault(); if (hasImage) fitView(); return; }
  if (!mod && e.key === '1') { e.preventDefault(); if (hasImage) setZoom(1); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (hasImage) download(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
    if (hasImage && !window.getSelection().toString()) { e.preventDefault(); copyToClipboard(); }
  }
  else if (mod && e.key.toLowerCase() === 'c') {
    if (hasImage && !window.getSelection().toString()) { e.preventDefault(); copySel(); }
  }
  else if (mod && e.key.toLowerCase() === 'v') {
    // Deliberately NOT preventDefault: the real `paste` event must fire so images on the
    // system clipboard still paste. It falls back to our buffer only if there is no image,
    // and this timer covers the case where no paste event fires at all (empty clipboard).
    scheduleClipPaste();
  }
  else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
  else if (!onControl && e.key.startsWith('Arrow') && (selText || selShape || movingIds().length)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    nudgeSelected(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
                  e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
  }
  else if (!onControl && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (selText || selShape) { e.preventDefault(); deleteSelected(); }
    else if (movingIds().length) { e.preventDefault(); layerDelete(); }
  }
  else if (e.key === 'Escape') {
    if (!$('#dialog').hidden) { $('#dialog').hidden = true; return; }
    if (crop) cancelCrop();
    if (selection) clearSelection();
    selText = null; selShape = null; selShapes = []; selLayers = []; selLayer = null; drag = null;
    updateLayerUI(); render();
  }
}
function onKeyUp(e) {
  if (e.key === ' ' || e.code === 'Space') { spaceDown = false; if (!panDrag) applyCursor(); }
}
function scheduleClipPaste() {
  const t0 = Date.now();
  setTimeout(() => { if (pasteStamp < t0 && clip) pasteClip(); }, 300);
}
async function onPaste(e) {
  pasteStamp = Date.now();
  const dt = e.clipboardData; if (!dt) return;
  let file = (Array.from(dt.files || []).filter(isImg))[0] || null;
  if (!file) for (const it of dt.items || []) if (isImg(it)) { file = it.getAsFile(); break; }
  if (file) {
    e.preventDefault();
    if (clip && clipSig != null) {
      try {
        const bmp = await createImageBitmap(file);
        const mine = pixelSig(bmp) === clipSig;
        if (bmp.close) bmp.close();
        if (mine) { pasteClip(); return; }
      } catch { /* fall through and treat it as a normal image */ }
    }
    loadBlob(file);
    return;
  }
  const html = dt.getData ? dt.getData('text/html') : '';
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) { e.preventDefault(); fetch(m[1]).then(r => r.blob()).then(loadBlob).catch(() => toast('Could not load pasted image')); return; }
  if (clip) { e.preventDefault(); pasteClip(); return; }
  toast('No image found on the clipboard');
}
function onDrop(e) {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (dt.files && dt.files.length) return loadBlob(dt.files[0]);
  for (const it of (dt.items || [])) if (it.type.startsWith('image/')) return loadBlob(it.getAsFile());
}
function wire() {
  // panel controls
  bindRange('width', 'width', 'widthOut');
  bindRange('opacity', 'opacity', 'opacityOut');
  bindRange('blobSize', 'size', 'blobSizeOut');
  bindRange('blobStrength', 'strength');
  bindRange('tolerance', 'tolerance', 'toleranceOut');
  bindRange('fxPixel', 'block', 'fxPixelOut');
  bindRange('fxBlur', 'soft', 'fxBlurOut');
  ['brightness','contrast','saturate','grayscale','sepia'].forEach(k => bindRange(k, k));

  $('#color').addEventListener('input', e => {
    style.color = e.target.value;
    applyStyleToSelection('color', style.color);
  });
  $('#filled').addEventListener('change', e => {
    style.filled = e.target.checked;
    applyStyleToSelection('filled', style.filled);
  });
  $('#textBgOn').addEventListener('change', e => {
    style.bg = e.target.checked ? $('#textBgColor').value : null;
    applyStyleToSelection('bg', style.bg);
    syncTextBgUI();
  });
  $('#textBgColor').addEventListener('input', e => {
    style.bg = e.target.value;                   // picking a colour implies the plate is on
    $('#textBgOn').checked = true;
    applyStyleToSelection('bg', style.bg);
    syncTextBgUI();
  });
  bindRange('textBgOpacity', 'bgOpacity', 'textBgOpacityOut');
  bindRange('textPad', 'pad', 'textPadOut');
  bindRange('textRadius', 'radius', 'textRadiusOut');
  syncTextBgUI();
  const syncWandColor = () => { $('#wandColor').disabled = wand.transparent; };   // Colour only matters when not clearing
  $('#wandGlobal').addEventListener('change', e => wand.global = e.target.checked);
  $('#wandTransparent').addEventListener('change', e => { wand.transparent = e.target.checked; syncWandColor(); });
  $('#wandColor').addEventListener('input', e => wand.color = e.target.value);
  syncWandColor();
  $('#fmt').addEventListener('change', syncAdjustUI);

  $('#selEdit').onclick = editSelected;
  $('#selDup').onclick = duplicateSelected;
  $('#selDel').onclick = deleteSelected;
  $('#selAllBtn').onclick = selectAll;
  $('#selClearBtn').onclick = clearSelection;
  $('#fxPixelBtn').onclick = applyPixelate;
  $('#fxBlurBtn').onclick = applyBlur;
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#rotL').onclick = () => rotate(-90);
  $('#rotR').onclick = () => rotate(90);
  $('#flipH').onclick = () => flip('h');
  $('#flipV').onclick = () => flip('v');
  $('#newBtn').onclick = () => { $('#dialog').hidden = false; };
  $('#newCancel').onclick = () => { $('#dialog').hidden = true; };
  $('#newCreate').onclick = newCanvas;
  $('#newClearBtn').onclick = clearEverything;
  $('#layersToggle').onclick = toggleLayers;
  $('#annToggle').onclick = toggleAnn;
  $('#annDel').onclick = deleteSelectedAnns;
  $('#layFront').onclick = () => layerMove('front');
  $('#layUp').onclick = () => layerMove('up');
  $('#layDown').onclick = () => layerMove('down');
  $('#layBack').onclick = () => layerMove('back');
  $('#layRotL').onclick = () => layerRotate(-90);
  $('#layRotR').onclick = () => layerRotate(90);
  $('#layDel').onclick = layerDelete;
  $('#layFlatten').onclick = flattenChecked;
  $('#applyAdj').onclick = applyAdjust;
  $('#resetAdj').onclick = () => { adjust = { ...DEFAULT_FILTER }; syncAdjustUI(); render(); };
  $('#applyCropBtn').onclick = applyCrop;
  $('#cancelCropBtn').onclick = cancelCrop;
  $('#blobClear').onclick = () => {
    if (!blobs.length) return;
    const pre = snapshot(); blobs = []; commitPre(pre); render();
  };
  $('#applyResize').onclick = () => {
    const w = parseInt($('#rw').value, 10), h = parseInt($('#rh').value, 10);
    if (!w || !h) return toast('Enter width and height');
    resizeAll(w, h);
  };
  $('#fryBtn').onclick = () => deepfry($('#fryLevel').value);
  $('#bgBtn').onclick = removeBgServer;
  $('#copyBtn').onclick = copyToClipboard;
  $('#dlBtn').onclick = download;
  $('#openBtn').onclick = () => $('#file').click();
  $('#file').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadBlob(f); e.target.value = ''; });

  // font family + bold/italic + the two size inputs
  fontSel.addEventListener('change', () => {
    style.family = fontSel.value;
    applyToSelectedText(t => { t.family = style.family; });
  });
  $('#boldBtn').onclick = () => {
    style.bold = !style.bold; syncStyleButtons();
    applyToSelectedText(t => { t.bold = style.bold; });
  };
  $('#italicBtn').onclick = () => {
    style.italic = !style.italic; syncStyleButtons();
    applyToSelectedText(t => { t.italic = style.italic; });
  };
  $('#fontSize').addEventListener('input', e => setFontSize(+e.target.value));
  $('#fontSizeNum').addEventListener('input', e => setFontSize(+e.target.value));

  // linked resize dimensions
  $('#rw').addEventListener('input', () => syncRatio('w'));
  $('#rh').addEventListener('input', () => syncRatio('h'));
  $('#lockRatio').addEventListener('change', () => { if ($('#lockRatio').checked) syncRatio('w'); });

  // sidebar tabs + the annotations-tier flatten tick
  $('#tabs').querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  $('#annFlatten').addEventListener('change', () => { flattenAnnotations = $('#annFlatten').checked; updateLayerUI(); });

  // mobile sheet
  $('#sheetToggle').onclick = () => toggleSheet(!panel.classList.contains('open'));
  backdrop.onclick = () => toggleSheet(false);

  // canvas pointer
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerCancel);
  stage.addEventListener('pointerleave', onPointerLeave);

  // clipboard + drag/drop
  window.addEventListener('paste', onPaste);
  ['dragenter','dragover'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); stage.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === stage) stage.classList.remove('dragover'); }));
  stage.addEventListener('drop', onDrop);
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  // zoom + pan
  $('#zoomOut').onclick = () => setZoom(zoom / 1.25);
  $('#zoomIn').onclick  = () => setZoom(zoom * 1.25);
  $('#zoomFit').onclick = () => fitView();
  $('#zoomPct').onclick = () => setZoom(1);
  stage.addEventListener('wheel', e => {
    if (!hasImage) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const step = e.deltaMode === 1 ? e.deltaY * 0.05 : e.deltaY * 0.0015;
    setZoom(zoom * Math.exp(-step), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  window.addEventListener('resize', () => {
    if (!hasImage) return;
    if (atFit) { fitView(); return; }   // refit and re-centre for the new viewport size
    fitZoom = fitScale();
    zoom = clampZoom(zoom);
    clampPan(); applyView(); render();
  });

  // keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

/* ---------------------------------------------------------------- 19  boot */
function decorateActionButtons() {
  for (const id in ACTION_ICONS) {
    const b = $('#' + id); if (!b) continue;
    const label = b.textContent.trim();
    b.innerHTML = '<span class="ai">' + svgIcon(ACTION_ICONS[id]) + '</span><span class="tl">' + label + '</span>';
  }
}
// A phone can't fit six loose header rows, so the canvas-transform buttons move into the sheet
// and the rest of the header goes icon-only (CSS). Keep the node, just reparent it.
function buildToolButtons() {
  for (const [id, label, key, row] of TOOLS) {
    const host = row === 'ann' ? annToolsEl : toolsEl;
    if (TOOL_ROW_SEP.has(id)) {
      const sep = document.createElement('span'); sep.className = 'gsep'; host.appendChild(sep);
    }
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.tool = id;
    b.title = label + ' (' + key.toUpperCase() + ')';
    const rest = label[0].toLowerCase() === key ? label.slice(1) : label;   // every hotkey is the first letter
    b.innerHTML = toolIcon(id) + '<span class="k">' + key + '</span><span class="tl">' + rest + '</span>';
    b.addEventListener('click', () => setTool(id));
    host.appendChild(b);
    TOOL_KEYS[key] = id;
  }
}
function buildFontOptions() {
  for (const [value, label] of FONT_CHOICES) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    fontSel.appendChild(o);
  }
  fontSel.value = style.family;
}
buildToolButtons();
decorateActionButtons();
buildFontOptions();
wire();
if (IS_MOBILE) setRange('width', style.width);   // a 6px stroke is invisible under a fingertip
setTool('move');
syncAdjustUI();
updateLayerUI();
updateSelInfo();
syncStyleButtons();
// Only show the (optional) background-removal sidecar UI if it actually answers.
syncBgSection();
