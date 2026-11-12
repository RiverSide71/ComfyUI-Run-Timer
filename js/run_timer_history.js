// ComfyUI's scripts/ folder is found whatever depth this file is placed at.
async function importComfy(file) {
  for (const base of ["../../scripts/", "../../../scripts/", "/scripts/"]) {
    try { return await import(base + file); } catch (_e) { /* try the next path */ }
  }
  throw new Error("[Run Timer History] could not load ComfyUI's scripts/" + file);
}
const { app } = await importComfy("app.js");
const { api } = await importComfy("api.js");

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  Run Timer (History): the Run Timer clock + the last 5 finished runs  ║
// ╚══════════════════════════════════════════════════════════════════════╝
//
// Same clock as the original: title-less node, dark screen, ice-blue digits with
// m/s units, status dot, scales with the node width. Five small numbered
// buttons under the clock, filled in run order: run 1 lands in slot 1, run 2 in
// slot 2, and so on. While a run is going, its slot is shown in green (pulsing)
// and the finished runs stay in their own slots. Once all 5 are full, the oldest
// drops off the left, so the live slot is always the next free one (or the last).
// Click a finished slot to show that run's time on the clock. This also works
// DURING a run: the live timer keeps counting in the background; click the lit
// button (or the green one) to return to the live clock (it also snaps to the
// new result when the run ends).
//
// The × button at the right end of the strip resets all history (asks first, in a popup next to the node).
//
// Colors: ice blue by default (DEFAULT_COLOR below). Give the node a color with
// ComfyUI's node color picker and the clock lettering follows it. 
// For Matrix Green, set DEFAULT_COLOR to "#00ff41"
//
// Storage: node.properties (saved with the workflow, so it survives reloads and
// tab switches). Only SUCCESSFUL runs enter the history. All state is per node.
//
// Classic renderer: no DOM, everything is painted on the node canvas and the
// buttons are hit-tested in onMouseDown. Nodes 2.0: a DOM widget, click-through
// except for the buttons.

// Default lettering color, used until the node gets a color from the node color
// picker. Ice blue is the default; for Matrix green use "#00ff41".
const DEFAULT_COLOR = "#9be7ff";
const NODE_NAME = "RunTimerHistory";
const HIST_PROP = "rtHistory";   // [ms, ms, ...] newest first, max HISTORY_MAX
const LAST_PROP = "rtLastMs";    // the total the clock shows when idle
const DEC_PROP = "rtDecimals";   // 0 | 2 | 3
const HISTORY_MAX = 5;
const MAX_MS = 7 * 24 * 60 * 60 * 1000;

// ── which node type is ours ─────────────────────────────────────────────────
// The JS attaches to the node by its Python class name. If you rename that class
// (or its display name) in __init__.py this still finds it: any node from THIS
// pack folder whose name mentions "timer" is taken. Pixaroma's own timer and
// timers from other packs are left alone.
const PACK = (() => {
  try {
    const m = decodeURIComponent(new URL(import.meta.url).pathname).match(/\/extensions\/([^/]+)\//);
    return m ? m[1] : "";
  } catch (_e) { return ""; }
})();
const _ourTypes = new Set();   // node type names this extension attached to
const _packTypes = [];         // every node type seen from this pack (console hint)
function fromThisPack(d) {
  const mod = String(d.python_module || "");
  return !!PACK && (mod === "custom_nodes." + PACK || mod.endsWith("." + PACK));
}
function isOurDef(d) {
  const name = String(d.name || "");
  if (name === NODE_NAME) return true;
  if (/pixaroma/i.test(name)) return false;
  const label = name + " " + String(d.display_name || "");
  if (d.python_module) return fromThisPack(d) && /timer/i.test(label);
  return /run.?timer/i.test(label);
}
function isOurNode(node) {
  return !!node && (_ourTypes.has(node.type) || _ourTypes.has(node.comfyClass));
}
console.info("[Run Timer History] script loaded (pack folder: " + (PACK || "unknown") + ")");

const MIN_W = 140;
const CLOCK_H = 50;                 // clock area height at scale 1
const BAR_H = 18;                   // button strip height at scale 1
const BASE_H = CLOCK_H + BAR_H;     // node height at scale 1
const MIN_S = 0.45;
const MAX_S = 8;

// Every hard-coded pixel of the face at scale 1 (canvas painter + CSS share it).
const M = {
  num: 30, frac: 19, unit: 13, ls: 1, gap: 5,
  unitDx: 2, unitDy: 8, padX: 26,
  dotR: 3.5, dotAt: 11, radius: 8,
  btnW: 18, resetW: 14, btnH: 12, btnGap: 5, btnFont: 9, btnR: 3,
};
const FONT = "'Consolas','DejaVu Sans Mono',ui-monospace,monospace";
// The slot of the run in progress (same green as the running status dot).
const RUN_COLOR = "#3ec371";
const RUN_RGB = "62,195,113";

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function pad(n, l) { return String(n).padStart(l, "0"); }

// ── lettering color: follows the node color picker ──────────────────────────
// The picker stores DARK shades in node.bgcolor / node.color, which would vanish
// on the dark screen, so the hue is kept and the shade is brightened. A grey or
// black pick gives soft white; no color at all gives DEFAULT_COLOR.
function parseColor(str) {
  if (typeof str !== "string") return null;
  const t = str.trim();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(t);
  if (m) return [m[1], m[2], m[3]].map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(t);
  if (m) return [m[1], m[2], m[3]].map((c) => parseInt(c, 16));
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(t);
  if (m) return [m[1], m[2], m[3]].map((c) => Math.max(0, Math.min(255, Math.round(+c))));
  return null;
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}
function toHex(rgb) { return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join(""); }
const DEFAULT_RGB = parseColor(DEFAULT_COLOR) || [155, 231, 255];
function letterRgb(src) {
  const [h, s, l] = rgbToHsl(src[0], src[1], src[2]);
  if (s < 0.12) return hslToRgb(0, 0, 0.88);
  return hslToRgb(h, Math.max(s, 0.75), Math.min(0.78, Math.max(l, 0.68)));
}
// The classic body hook paints the node dark while it draws, so it stashes the
// node's real colors first; read those during a draw.
function nodeBaseColors(node) {
  return node._rtInDraw ? [node._rtRealBg, node._rtRealCol] : [node.bgcolor, node.color];
}
function tintOf(node) {
  const [bg, col] = nodeBaseColors(node);
  const key = bg + "|" + col;
  if (node._rtTintKey === key && node._rtTint) return node._rtTint;
  const src = parseColor(bg) || parseColor(col);
  const rgb = src ? letterRgb(src) : DEFAULT_RGB;
  node._rtTintKey = key;
  node._rtTint = { rgb, hex: toHex(rgb), css: rgb.join(",") };
  return node._rtTint;
}
// Nodes 2.0: hand the color to the DOM face as CSS variables.
function applyTint(node) {
  const root = node._pixRtRoot;
  if (!root) return;
  const t = tintOf(node);
  if (node._rtTintApplied === t) return;
  node._rtTintApplied = t;
  root.style.setProperty("--rt-c", t.hex);
  root.style.setProperty("--rt-rgb", t.css);
}

// ── state (all on node.properties) ──────────────────────────────────────────
function validMs(v) { return typeof v === "number" && isFinite(v) && v >= 0 && v <= MAX_MS; }
function setProp(node, key, val) { if (!node.properties) node.properties = {}; node.properties[key] = val; }
function getHistory(node) {
  const a = node.properties && node.properties[HIST_PROP];
  return Array.isArray(a) ? a.filter(validMs).slice(0, HISTORY_MAX) : [];
}
function lastMsOf(node) {
  const v = node.properties && node.properties[LAST_PROP];
  if (validMs(v)) return v;
  const h = getHistory(node);
  return h.length ? h[0] : 0;
}
function decimalsOf(node) {
  const d = node.properties && node.properties[DEC_PROP];
  return d === 2 || d === 3 ? d : 0;
}
// The five button slots, left to right in run order. Finished runs fill slots
// 1, 2, 3...; the run in progress takes the next free slot. If all five are
// already full, a new run pushes the oldest off the left so its slot is the last.
// (Storage stays newest-first, so saved workflows keep working.)
function slotsOf(node) {
  const chron = getHistory(node).slice().reverse();   // oldest first
  const run = !!node._rtRunning;
  const done = (run && chron.length >= HISTORY_MAX) ? chron.slice(1) : chron;
  const slots = [];
  for (let i = 0; i < HISTORY_MAX; i++) {
    if (i < done.length) slots.push({ kind: "done", ms: done[i] });
    else if (run && i === done.length) slots.push({ kind: "live", ms: null });
    else slots.push({ kind: "empty", ms: null });
  }
  return slots;
}

// ── environment helpers (stand-ins for ComfyUI-version differences) ─────────
function isVueNodes() {
  try { return app.ui.settings.getSettingValue("Comfy.VueNodes.Enabled") === true; }
  catch (_e) { return false; }
}

// True while a workflow is loading (+300 ms). Serialized writes (node.size) are
// skipped then, so merely opening a workflow never marks it modified.
let _loadDepth = 0, _loadUntil = 0;
function isGraphLoading() { return _loadDepth > 0 || performance.now() < _loadUntil; }
(function installLoadTracker() {
  if (app._rtHistLoadWrapped || typeof app.loadGraphData !== "function") return;
  app._rtHistLoadWrapped = true;
  const orig = app.loadGraphData;
  app.loadGraphData = async function () {
    _loadDepth++;
    try { return await orig.apply(this, arguments); }
    finally { _loadDepth--; _loadUntil = performance.now() + 300; }
  };
})();

// A node that is really on the current canvas (not a Ctrl+C clone, and not left
// behind by a workflow switch). Only live nodes start, finish and record runs.
function isLiveNode(node) {
  const g = node && node.graph;
  if (!g) return false;
  try {
    const cg = app.canvas && app.canvas.graph;
    const root = app.graph || cg;
    if (g === root || g === cg) return true;
    if (g.rootGraph && root && g.rootGraph === (root.rootGraph || root)) return true;
  } catch (_e) {}
  return false;
}

// "Modern Node Design (Nodes 2.0)" can be flipped with no reload: poll for it.
const _rendererListeners = new Set();
let _rendererTimer = null, _lastVue = null;
function onRendererChange(cb) {
  _rendererListeners.add(cb);
  if (_lastVue === null) _lastVue = isVueNodes();
  if (!_rendererTimer) {
    _rendererTimer = setInterval(() => {
      const v = isVueNodes();
      if (v === _lastVue) return;
      _lastVue = v;
      for (const f of [..._rendererListeners]) { try { f(v); } catch (_e) {} }
    }, 300);
  }
  return () => {
    _rendererListeners.delete(cb);
    if (!_rendererListeners.size && _rendererTimer) { clearInterval(_rendererTimer); _rendererTimer = null; }
  };
}
function removeNodeWidget(node, w) {
  if (!w) return;
  try { if (typeof node.removeWidget === "function") { node.removeWidget(w); return; } } catch (_e) {}
  try { if (typeof w.onRemove === "function") w.onRemove(); } catch (_e) {}
  const i = (node.widgets || []).indexOf(w);
  if (i >= 0) node.widgets.splice(i, 1);
}

// ── time formatting ─────────────────────────────────────────────────────────
function clockParts(ms, dec) {
  if (ms >= 3600000) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return { groups: [{ num: String(h), unit: "h" }, { num: pad(m, 2), unit: "m" }, { num: pad(s, 2), unit: "s" }], frac: "" };
  }
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const groups = [{ num: pad(mm, 2), unit: "m" }, { num: pad(ss, 2), unit: "s" }];
  let frac = "";
  if (dec === 3) frac = "." + pad(Math.floor(ms % 1000), 3);
  else if (dec === 2) frac = "." + pad(Math.floor((ms % 1000) / 10), 2);
  return { groups, frac };
}
function readoutSigOf(parts) { return parts.groups.map((g) => g.num + g.unit).join(":") + parts.frac; }
function timeText(ms, dec) {   // plain text for tooltips, e.g. "02:47" or "1:02:03"
  const p = clockParts(ms, dec);
  return p.groups.map((g) => g.num).join(":") + p.frac;
}
function noteShown(node, parts) {
  node._rtShownSig = readoutSigOf(parts);
  node._rtShownSec = readoutSigOf({ groups: parts.groups, frac: "" });
  node._rtShownAt = performance.now();
}
function dotDim(node) {
  if (!node._rtRunning) return false;
  const ms = node._rtLiveMs != null ? node._rtLiveMs : (node._rtDisplayMs || 0);
  return Math.floor(ms / 1000) % 2 === 1;
}

// ── display (Nodes 2.0 DOM clock) ───────────────────────────────────────────
function paintBar(node) {
  const btns = node._rtBtns;
  if (!btns) return;
  const slots = slotsOf(node), dec = decimalsOf(node), run = !!node._rtRunning;
  const dim = dotDim(node);
  const nHist = getHistory(node).length;
  const sig = slots.map((s) => s.kind + (s.ms != null ? s.ms : "")).join(",") +
    "|" + node._rtView + "|" + dec + "|" + dim + "|" + nHist;
  if (node._rtBarSig === sig) return;
  node._rtBarSig = sig;
  if (node._rtResetBtn) {
    node._rtResetBtn.classList.toggle("empty", nHist === 0);
    node._rtResetBtn.title = nHist ? "Reset all timer history" : "No history to reset";
  }
  btns.forEach((b, i) => {
    const s = slots[i], has = s.kind === "done", live = s.kind === "live";
    const on = has && node._rtView === i;
    b.classList.toggle("empty", s.kind === "empty");
    b.classList.toggle("live", live);
    b.classList.toggle("dim", live && dim);
    b.classList.toggle("on", on);
    if (live) b.title = "Run " + (i + 1) + " in progress" + (node._rtView != null ? " (click to return to the live clock)" : "");
    else if (!has) b.title = "No run recorded yet";
    else b.title = "Run " + (i + 1) + ": " + timeText(s.ms, dec) +
      (run ? (on ? " (click to return to the live clock)" : " (live run keeps counting)") : "");
  });
}
function paint(node) {
  const wrap = node._pixRtTime;
  if (!wrap) return;
  applyTint(node);
  const parts = clockParts(node._rtDisplayMs || 0, decimalsOf(node));
  const sig = parts.groups.map((g) => g.unit).join(",") + (parts.frac ? "|f" : "");
  if (node._rtShapeSig !== sig) {
    node._rtShapeSig = sig;
    wrap.innerHTML = "";
    node._rtNumEls = [];
    node._rtFracEl = null;
    parts.groups.forEach((g, i) => {
      if (i > 0) { const c = el("span", "pix-rt-colon"); c.textContent = ":"; wrap.appendChild(c); }
      const seg = el("span", "pix-rt-cseg");
      const nw = el("span", "pix-rt-numwrap");
      const num = el("span", "pix-rt-num"); num.textContent = g.num; nw.appendChild(num);
      if (parts.frac && i === parts.groups.length - 1) {
        const fr = el("span", "pix-rt-frac"); fr.textContent = parts.frac; nw.appendChild(fr);
        node._rtFracEl = fr;
      }
      const unit = el("span", "pix-rt-unit"); unit.textContent = g.unit;
      seg.appendChild(nw); seg.appendChild(unit);
      wrap.appendChild(seg);
      node._rtNumEls.push(num);
    });
  } else {
    parts.groups.forEach((g, i) => { if (node._rtNumEls && node._rtNumEls[i]) node._rtNumEls[i].textContent = g.num; });
    if (node._rtFracEl) node._rtFracEl.textContent = parts.frac;
  }
  if (node._pixRtDot) node._pixRtDot.classList.toggle("tick", dotDim(node));
  paintBar(node);
  noteShown(node, parts);
}
function setDot(node, mode) {
  node._rtDotState = mode;
  if (node._pixRtDot) node._pixRtDot.className = "pix-rt-dot" + (mode === "run" ? " run" : mode === "done" ? " done" : "");
  if (!isVueNodes()) node.setDirtyCanvas && node.setDirtyCanvas(true, false);
}
function flashScreen(node) {
  const scr = node._pixRtScreen;
  if (!scr) return;
  scr.classList.remove("flash");
  void scr.offsetWidth;
  scr.classList.add("flash");
}
function refreshClock(node) {
  maybeFitWidth(node);
  // Foreground only: a ticking digit cannot change the grid or the groups.
  if (!isVueNodes()) { node.setDirtyCanvas && node.setDirtyCanvas(true, false); }
  else paint(node);
}

// ── layout + measurement (one function for both the width and the painter) ──
function clockFonts(s) {
  return {
    num: `600 ${M.num * s}px ${FONT}`,
    frac: `600 ${M.frac * s}px ${FONT}`,
    unit: `500 ${M.unit * s}px ${FONT}`,
  };
}
// Every digit is drawn centred in a fixed cell, so the readout never shuffles.
function digitCell(ctx, s) {
  let w = 0;
  for (let i = 0; i < 10; i++) w = Math.max(w, ctx.measureText(String(i)).width);
  return w + M.ls * s;
}
function numRunWidth(ctx, str, cell, dotW) {
  let w = 0;
  for (const ch of str) w += (ch === "." ? dotW : cell);
  return w;
}
function drawNumRun(ctx, str, x, midY, cell, dotW) {
  // One baseline for the whole run, taken from a digit, so "." sits on it.
  const dm = ctx.measureText("0");
  const haveBox = dm && dm.actualBoundingBoxAscent != null && dm.actualBoundingBoxDescent != null;
  const prevBase = ctx.textBaseline;
  const dy = haveBox ? (dm.actualBoundingBoxAscent - dm.actualBoundingBoxDescent) / 2 : 0;
  ctx.textBaseline = haveBox ? "alphabetic" : "middle";
  for (const ch of str) {
    const c = ch === "." ? dotW : cell;
    ctx.fillText(ch, x + (c - ctx.measureText(ch).width) / 2, midY + dy);
    x += c;
  }
  ctx.textBaseline = prevBase;
  return x;
}
function clockLayout(ctx, node, s) {
  const parts = clockParts(node._rtDisplayMs || 0, decimalsOf(node));
  const f = clockFonts(s);
  ctx.font = f.num;
  const numCell = digitCell(ctx, s);
  const numDot = ctx.measureText(".").width;
  const colonW = ctx.measureText(":").width;
  ctx.font = f.frac;
  const fracCell = digitCell(ctx, s);
  const fracDot = ctx.measureText(".").width;
  const segs = parts.groups.map((g, i) => {
    ctx.font = f.num;
    const numW = numRunWidth(ctx, g.num, numCell, numDot);
    let fracW = 0;
    if (parts.frac && i === parts.groups.length - 1) {
      ctx.font = f.frac;
      fracW = numRunWidth(ctx, parts.frac, fracCell, fracDot);
    }
    ctx.font = f.unit;
    return { g, numW, fracW, unitW: ctx.measureText(g.unit).width };
  });
  let total = 0;
  segs.forEach((sg, i) => {
    if (i > 0) total += M.gap * 2 * s + colonW;
    total += sg.numW + sg.fracW + M.unitDx * s + sg.unitW;
  });
  return { parts, f, segs, total, colonW, numCell, numDot, fracCell, fracDot };
}

// ── node width <-> scale ────────────────────────────────────────────────────
let _measCanvas = null;
function measureCtx() {
  if (!_measCanvas) _measCanvas = document.createElement("canvas");
  return _measCanvas.getContext("2d");
}
function shapeSig(node) {
  const parts = clockParts(node._rtDisplayMs || 0, decimalsOf(node));
  return parts.groups.map((g) => g.num.length).join(",") + "|" + (parts.frac ? parts.frac.length : 0);
}
function clockUnitWidth(node) {
  const sig = shapeSig(node);
  if (node._rtUnitSig === sig && node._rtUnitW > 0) return node._rtUnitW;
  const w = Math.max(MIN_W, Math.round(clockLayout(measureCtx(), node, 1).total + M.padX));
  node._rtUnitSig = sig;
  node._rtUnitW = w;
  return w;
}
function clockScale(node, boxW, floorAtOne) {
  const u = clockUnitWidth(node);
  if (!(u > 0) || !(boxW > 0)) return 1;
  return Math.max(floorAtOne ? 1 : MIN_S, Math.min(MAX_S, boxW / u));
}
// Scale the painter uses: fits the box, never spills outside it.
function faceScale(node) {
  return Math.min(clockScale(node, node.size[0], false), Math.max(MIN_S, node.size[1] / BASE_H));
}

function fitClockWidth(node) {
  if (isGraphLoading()) return;
  if (typeof node.setSize !== "function") return;
  const s = node._rtScale || 1;
  const w = Math.round(clockUnitWidth(node) * s);
  const h = Math.round(BASE_H * s);
  const vue = isVueNodes();
  const dw = Math.abs((node.size[0] || 0) - w);
  const dh = vue ? 0 : Math.abs((node.size[1] || 0) - h);
  if (dw > 1 || dh > 1) node.setSize([w, vue ? node.size[1] : h]);
}
function maybeFitWidth(node) {
  if (isGraphLoading()) return;   // bail BEFORE stamping, or the refit is lost
  const sig = shapeSig(node);
  if (node._rtWidthSig === sig) return;
  node._rtWidthSig = sig;
  fitClockWidth(node);
}
// Classic resize rule: the smallest clock-shaped box that contains the pointer.
// A pure function of the proposed size, no history, so dragging never jitters.
function applyResizeAspect(node) {
  const u = clockUnitWidth(node);
  const s = Math.max(1, Math.min(MAX_S, Math.max(node.size[0] / u, node.size[1] / BASE_H)));
  node._rtScale = s;
  const w = Math.round(u * s), h = Math.round(BASE_H * s);
  if (Math.abs(node.size[0] - w) > 0.5) node.size[0] = w;
  if (Math.abs(node.size[1] - h) > 0.5) node.size[1] = h;
}
function isResizingThis(node) {
  try { return app.canvas && app.canvas.resizing_node === node; } catch (_e) { return false; }
}
// Read-only (never writes node.size): safe on the load path.
function syncScaleFromSize(node) {
  if (isVueNodes()) {
    const w = (node._pixRtRoot && node._pixRtRoot.clientWidth) || node.size[0] || 0;
    node._rtScale = clockScale(node, w, false);
    return;
  }
  node._rtScale = Math.max(1, Math.min(MAX_S, (node.size[1] || BASE_H) / BASE_H));
}
function applyState(node) {
  node._rtUnitSig = null;
  refreshClock(node);
}
function refreshNodeSize(node) {
  if (isGraphLoading() || isVueNodes()) return;
  try {
    if (typeof node.setSize !== "function") return;
    syncScaleFromSize(node);
    const target = Math.round(BASE_H * (node._rtScale || 1));
    if (Math.abs((node.size[1] || 0) - target) > 1) node.setSize([node.size[0], target]);
  } catch (_e) {}
}

// ── history actions ─────────────────────────────────────────────────────────
// The view = which history slot the clock shows (0 = most recent), or null for
// a live run / an errored run's partial time (not in the history). During a
// run, null = the live clock and a number = peeking at that past run.
// _rtView is a SLOT index (0 = leftmost button), see slotsOf().
function syncViewToLatest(node) {
  const h = getHistory(node);
  // the newest finished run sits in the last filled slot
  node._rtView = (h.length && h[0] === lastMsOf(node)) ? h.length - 1 : null;
}
function pickRun(node, i) {
  const slot = slotsOf(node)[i];
  if (!slot || slot.kind === "empty") return;
  if (slot.kind === "live" || (node._rtRunning && node._rtView === i)) {
    // Back to the live clock (green slot, or the lit button clicked again).
    if (node._rtView == null) return;
    node._rtView = null;
    node._rtDisplayMs = performance.now() - node._rtStart;
    forgetLiveMarks(node);
  } else {
    // Show a finished run; mid-run the live timer keeps counting behind it.
    if (node._rtView === i) return;
    node._rtView = i;
    node._rtDisplayMs = slot.ms;
    node._rtPeekSec = -1;
  }
  refreshClock(node);
}
function pushHistory(node, ms) {
  setProp(node, HIST_PROP, [ms, ...getHistory(node)].slice(0, HISTORY_MAX));
}
function clearHistory(node) {
  setProp(node, HIST_PROP, []);
  if (node._rtRunning) { node._rtView = null; node._rtDisplayMs = performance.now() - node._rtStart; forgetLiveMarks(node); }
  else { node._rtDisplayMs = lastMsOf(node); syncViewToLatest(node); }
  refreshClock(node);
}
// The bar's reset button: wipe all 5 runs and zero the clock (asks first, in a popup next to the node).
function resetHistory(node) {
  if (!getHistory(node).length) return;
  showConfirm(node, () => { setProp(node, LAST_PROP, 0); clearHistory(node); });
}

// Small confirm popup that opens right under the reset button (the browser's
// own confirm() always shows at the top of the screen and cannot be moved).
let _confirmEl = null, _confirmOff = null;
function closeConfirm() {
  if (_confirmOff) { _confirmOff(); _confirmOff = null; }
  if (_confirmEl) { _confirmEl.remove(); _confirmEl = null; }
}
// Screen position of the reset button: the DOM button (Nodes 2.0) or the
// canvas-painted one (classic, via the canvas pan/zoom).
function resetAnchor(node) {
  try {
    if (isVueNodes() && node._rtResetBtn) {
      const r = node._rtResetBtn.getBoundingClientRect();
      if (r.width > 0) return { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom };
    }
    const cv = app.canvas, ds = cv.ds, box = cv.canvas.getBoundingClientRect();
    const rr = barRects(node.size[0], node.size[1], faceScale(node))[HISTORY_MAX];
    const sc = ds.scale;
    const top = box.top + (node.pos[1] + rr.y + ds.offset[1]) * sc;
    return {
      cx: box.left + (node.pos[0] + rr.x + rr.w / 2 + ds.offset[0]) * sc,
      top, bottom: top + rr.h * sc,
    };
  } catch (_e) {
    return { cx: window.innerWidth / 2, top: window.innerHeight / 2, bottom: window.innerHeight / 2 };
  }
}
function showConfirm(node, onYes) {
  closeConfirm();
  const T = tintOf(node);
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:100000;left:0;top:0;visibility:hidden;box-sizing:border-box;" +
    "padding:8px 10px;background:#0c0c0e;border:1px solid rgba(" + T.css + ",0.6);border-radius:8px;" +
    "box-shadow:0 4px 16px rgba(0,0,0,0.5);color:" + T.hex + ";font:12px " + FONT + ";" +
    "user-select:none;white-space:nowrap;";
  const msg = document.createElement("div");
  msg.textContent = "Reset all timer history?";
  msg.style.cssText = "margin-bottom:7px;";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
  const mk = (label, filled, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = "cursor:pointer;font:inherit;padding:2px 10px;border-radius:4px;outline:none;" +
      "border:1px solid rgba(" + T.css + ",0.6);" +
      (filled ? "background:" + T.hex + ";color:#0c0c0e;" : "background:transparent;color:" + T.hex + ";");
    b.addEventListener("click", (e) => { e.stopPropagation(); closeConfirm(); if (fn) fn(); });
    return b;
  };
  row.appendChild(mk("Cancel", false, null));
  row.appendChild(mk("Reset", true, onYes));
  box.appendChild(msg); box.appendChild(row);
  document.body.appendChild(box);
  _confirmEl = box;

  // under the button, centred on it; flips above it near the bottom edge; stays on screen
  const a = resetAnchor(node), bw = box.offsetWidth, bh = box.offsetHeight, m = 8;
  let x = a.cx - bw / 2;
  let y = a.bottom + 6;
  if (y + bh > window.innerHeight - m) y = a.top - 6 - bh;
  x = Math.max(m, Math.min(window.innerWidth - bw - m, x));
  y = Math.max(m, y);
  box.style.left = Math.round(x) + "px";
  box.style.top = Math.round(y) + "px";
  box.style.visibility = "visible";

  // dismiss: click elsewhere, Esc, or scrolling/zooming the canvas
  const onDown = (e) => { if (!box.contains(e.target)) closeConfirm(); };
  const onKey = (e) => { if (e.key === "Escape") closeConfirm(); };
  const onWheel = () => closeConfirm();
  const t = setTimeout(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("wheel", onWheel, true);
  }, 0);
  document.addEventListener("keydown", onKey, true);
  _confirmOff = () => {
    clearTimeout(t);
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("wheel", onWheel, true);
    document.removeEventListener("keydown", onKey, true);
  };
}
function cycleDecimals(node) {
  setProp(node, DEC_PROP, { 0: 2, 2: 3, 3: 0 }[decimalsOf(node)]);
  applyState(node);
}
// READ-ONLY (dirty-on-load safe): restore what the clock showed when saved.
function restoreLastRun(node) {
  if (node._rtRunning) return;
  node._rtDisplayMs = lastMsOf(node);
  syncViewToLatest(node);
}

// ── run lifecycle (drives every timer on the canvas) ────────────────────────
const _timers = new Set();
let _rafId = null;
let _runStart = null;
let _runLive = false;
const LIVE_FRAC_GAP_MS = 250;   // digits after the point repaint at most this often

function onScreen(node) {
  const vn = app.canvas && app.canvas.visible_nodes;
  return Array.isArray(vn) ? vn.includes(node) : true;
}
function warnOnce(node, where, e) {
  if (node && node._rtWarned === where) return;
  if (node) node._rtWarned = where;
  console.warn("[Run Timer History] " + where + " failed:", (e && e.message) || e);
}
function forgetLiveMarks(node) {
  node._rtShownSig = null; node._rtShownSec = null; node._rtShownAt = 0;
  node._rtAskedSig = null; node._rtAskedAt = 0;
}
// Repaint only when the readout the user can SEE changed (once a second at 0
// decimals), so the timer costs nothing while a generation is running.
function loop() {
  let anyRunning = false;
  const now = performance.now();
  for (const node of _timers) {
    if (!node._rtRunning) continue;
    anyRunning = true;
    try {
      const live = now - node._rtStart;
      node._rtLiveMs = live;
      if (node._rtView != null) {
        // Peeking at a past run: the face stays put, only the status dot ticks.
        const sec = Math.floor(live / 1000);
        if (sec !== node._rtPeekSec) {
          node._rtPeekSec = sec;
          if (isVueNodes() || onScreen(node)) refreshClock(node);
        }
        continue;
      }
      node._rtDisplayMs = live;
      const p = clockParts(node._rtDisplayMs, decimalsOf(node));
      const sig = readoutSigOf(p);
      if (sig === node._rtShownSig || sig === node._rtAskedSig) continue;
      const secMoved = readoutSigOf({ groups: p.groups, frac: "" }) !== node._rtShownSec;
      if (!secMoved && now - Math.max(node._rtShownAt || 0, node._rtAskedAt || 0) < LIVE_FRAC_GAP_MS) continue;
      node._rtAskedSig = sig;
      node._rtAskedAt = now;
      if (!isVueNodes() && !onScreen(node)) continue;
      refreshClock(node);
    } catch (e) { warnOnce(node, "live update", e); }
  }
  _rafId = anyRunning ? requestAnimationFrame(loop) : null;
}
function ensureLoop() { if (_rafId == null) _rafId = requestAnimationFrame(loop); }

// A timer rebuilt mid-run (workflow-tab switch) joins the run already in flight.
function adoptLiveRun(node) {
  if (!_runLive || _runStart == null || node._rtRunning || !isLiveNode(node)) return;
  clearTimeout(node._rtDotT);
  node._rtRunning = true;
  node._rtStart = _runStart;
  node._rtDisplayMs = performance.now() - _runStart;
  node._rtLiveMs = node._rtDisplayMs;
  node._rtPeekSec = -1;
  node._rtView = null;
  forgetLiveMarks(node);
  setDot(node, "run");
  refreshClock(node);
  ensureLoop();
}
function startAll() {
  _runLive = true;
  _runStart = performance.now();
  for (const node of _timers) {
    if (!isLiveNode(node)) continue;
    try {
      clearTimeout(node._rtDotT);
      node._rtRunning = true;
      node._rtStart = _runStart;
      node._rtDisplayMs = 0;
      node._rtLiveMs = 0;
      node._rtPeekSec = -1;
      node._rtView = null;
      forgetLiveMarks(node);
      setDot(node, "run");
      refreshClock(node);
    } catch (e) { warnOnce(node, "run start", e); }
  }
  if (_timers.size) ensureLoop();
}
function finishAll(success) {
  _runLive = false;
  for (const node of _timers) {
    if (!node._rtRunning) continue;   // idempotent: some builds fire two finish events
    if (!isLiveNode(node)) { node._rtRunning = false; continue; }
    try {
      node._rtRunning = false;
      node._rtLiveMs = null;
      node._rtPeekSec = -1;
      // floor, so the clock, the saved total and the history all read the same
      const ms = Math.floor(performance.now() - node._rtStart);
      node._rtDisplayMs = ms;
      setProp(node, LAST_PROP, ms);
      if (success) pushHistory(node, ms);   // errored / interrupted runs are partial: not kept
      syncViewToLatest(node);
      refreshClock(node);
      setDot(node, "done");
      flashScreen(node);
      clearTimeout(node._rtDotT);
      node._rtDotT = setTimeout(() => setDot(node, "idle"), 2200);
    } catch (e) { warnOnce(node, "run finish", e); }
  }
}
let _listenersInstalled = false;
function installRunListeners() {
  if (_listenersInstalled) return;
  _listenersInstalled = true;
  api.addEventListener("execution_start", () => startAll());
  api.addEventListener("executing", (e) => {   // null node = queue item finished (older builds)
    const d = e && e.detail;
    const nodeId = (d && typeof d === "object") ? d.node : d;
    if (nodeId == null) finishAll(true);
  });
  api.addEventListener("execution_success", () => finishAll(true));
  api.addEventListener("execution_error", () => finishAll(false));
  api.addEventListener("execution_interrupted", () => finishAll(false));
}

// Picking a node color fires no event of its own, so look a few times a second:
// Nodes 2.0 gets the new CSS color, the classic canvas gets a repaint.
let _tintTimer = null;
function installTintWatch() {
  if (_tintTimer) return;
  _tintTimer = setInterval(() => {
    for (const node of _timers) {
      try {
        if (!node.graph) continue;
        const [bg, col] = nodeBaseColors(node);
        const key = bg + "|" + col;
        if (node._rtWatchKey === key) continue;
        node._rtWatchKey = key;
        if (isVueNodes()) applyTint(node);
        else if (node.setDirtyCanvas) node.setDirtyCanvas(true, false);
      } catch (_e) {}
    }
  }, 250);
}

// ── CSS (Nodes 2.0 face + the rules that hide the node chrome) ──────────────
let _cssDone = false;
function injectCSS() {
  if (_cssDone || document.getElementById("pix-rt-css")) { _cssDone = true; return; }
  _cssDone = true;
  const s = document.createElement("style");
  s.id = "pix-rt-css";
  // Every size is a calc() off --rt-s (the scale the node width asks for).
  // The lettering color is --rt-c / --rt-rgb, set per node from its node color.
  const C = `var(--rt-c,${DEFAULT_COLOR})`;
  const RGB = `var(--rt-rgb,${DEFAULT_RGB.join(",")})`;
  s.textContent = `
.pix-rt-root{display:flex;padding:0;box-sizing:border-box;width:100%;height:100%;user-select:none;-webkit-user-select:none;}
.pix-rt-screen{flex:1;min-width:0;position:relative;display:flex;flex-direction:column;background:#0c0c0e;border:1px solid #1d1d20;border-radius:calc(8px * var(--rt-s,1));box-sizing:border-box;}
.pix-rt-clockrow{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:calc(6px * var(--rt-s,1));box-sizing:border-box;}
.pix-rt-time{display:flex;align-items:center;justify-content:center;gap:calc(4px * var(--rt-s,1));font-family:${FONT};font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1;white-space:nowrap;color:${C};}
.pix-rt-cseg{display:inline-flex;align-items:flex-start;}
.pix-rt-numwrap{display:inline-flex;align-items:baseline;line-height:1;}
.pix-rt-num{font-size:calc(30px * var(--rt-s,1));letter-spacing:calc(1px * var(--rt-s,1));}
.pix-rt-frac{font-size:calc(19px * var(--rt-s,1));opacity:0.85;letter-spacing:calc(0.5px * var(--rt-s,1));}
.pix-rt-colon{font-size:calc(30px * var(--rt-s,1));line-height:1;opacity:0.7;}
.pix-rt-unit{font-size:calc(13px * var(--rt-s,1));line-height:1;margin-left:calc(2px * var(--rt-s,1));margin-top:calc(2px * var(--rt-s,1));opacity:0.5;}
.pix-rt-dot{position:absolute;top:calc(6px * var(--rt-s,1));left:calc(7px * var(--rt-s,1));width:calc(7px * var(--rt-s,1));height:calc(7px * var(--rt-s,1));border-radius:50%;background:#6b6b72;}
.pix-rt-dot.run{background:#3ec371;}
.pix-rt-dot.run.tick{opacity:.35;}
.pix-rt-dot.done{background:${C};}
.pix-rt-screen.flash{animation:pixRtFlash 0.6s;}
@keyframes pixRtFlash{0%{box-shadow:0 0 0 3px ${C};}100%{box-shadow:0 0 0 0 rgba(0,0,0,0);}}
.pix-rt-bar{flex:none;display:flex;align-items:center;justify-content:center;gap:calc(5px * var(--rt-s,1));height:calc(18px * var(--rt-s,1));}
.pix-rt-btn{box-sizing:border-box;flex:none;display:flex;align-items:center;justify-content:center;width:calc(18px * var(--rt-s,1));height:calc(12px * var(--rt-s,1));margin:0;padding:0;background:transparent;color:${C};border:max(1px, calc(1px * var(--rt-s,1))) solid rgba(${RGB},0.6);border-radius:calc(3px * var(--rt-s,1));font-family:${FONT};font-weight:700;font-size:calc(9px * var(--rt-s,1));line-height:1;cursor:pointer;outline:none;}
.pix-rt-btn:hover{background:rgba(${RGB},0.18);}
.pix-rt-btn.on{background:${C};color:#0c0c0e;}
.pix-rt-btn.live{color:${RUN_COLOR};border-color:${RUN_COLOR};background:rgba(${RUN_RGB},0.22);}
.pix-rt-btn.live.dim{opacity:.45;}
.pix-rt-btn.empty{color:#555;border-color:#333;cursor:default;background:transparent;}
.pix-rt-reset{width:calc(14px * var(--rt-s,1));}
/* NODES 2.0 title-less float: hide card, frame, footer chip; make the widget
   subtree click-through so drag + right-click reach the canvas. */
.lg-node:has(.pix-rt-root){background:transparent!important;border:none!important;box-shadow:none!important;}
.lg-node:has(.pix-rt-root),.lg-node:has(.pix-rt-root) > div,.lg-node:has(.pix-rt-root) > div > div{min-width:0!important;min-height:0!important;}
.lg-node:has(.pix-rt-root) .lg-node-header{display:none!important;}
.lg-node:has(.pix-rt-root) .lg-node-widgets{grid-template-columns:minmax(0,1fr)!important;padding:0!important;row-gap:0!important;gap:0!important;}
.lg-node:has(.pix-rt-root) .lg-node-widget{gap:0!important;width:100%!important;padding:0!important;}
.lg-node:has(.pix-rt-root) .lg-node-widget > *:first-child{display:none!important;}
.lg-node:has(.pix-rt-root) .lg-node-content{padding:0!important;}
.lg-node:has(.pix-rt-root) [class*="component-node-background"]{padding:0!important;gap:0!important;background:transparent!important;}
.lg-node:has(.pix-rt-root) [class*="component-node-background"] > div.text-muted-foreground,.lg-node:has(.pix-rt-root) .bg-node-component-surface{display:none!important;}
.lg-node:has(.pix-rt-root) > div.absolute.border:not([data-testid]){display:none!important;}
.lg-node:has(.pix-rt-root) [data-testid="node-state-outline-overlay"],.lg-node:has(.pix-rt-root) > div.absolute.outline-none{inset:-2px!important;}
.lg-node:has(.pix-rt-root) .lg-node-widgets,.lg-node:has(.pix-rt-root) .lg-node-widgets *{pointer-events:none!important;}
.lg-node:has(.pix-rt-root) .lg-node-widgets .pix-rt-btn{pointer-events:auto!important;}
`;
  (document.head || document.documentElement).appendChild(s);
}

// ── classic renderer: paint the clock + buttons on the node canvas ──────────
function fillTextVC(ctx, text, x, yMid) {
  const m = ctx.measureText(text);
  if (m && m.actualBoundingBoxAscent != null && m.actualBoundingBoxDescent != null) {
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, x, yMid + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  } else {
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, yMid);
  }
}
// Button rects in node-local px. Shared by the painter and the hit test.
function barRects(w, h, s) {
  const bw = M.btnW * s, rw = M.resetW * s, bh = M.btnH * s, gap = M.btnGap * s;
  const total = HISTORY_MAX * (bw + gap) + rw;
  const x0 = (w - total) / 2;
  const y = h - BAR_H * s + (BAR_H * s - bh) / 2;
  const out = [];
  for (let i = 0; i < HISTORY_MAX; i++) out.push({ x: x0 + i * (bw + gap), y, w: bw, h: bh });
  out.push({ x: x0 + HISTORY_MAX * (bw + gap), y, w: rw, h: bh });   // last rect = reset button
  return out;
}
function hitButton(node, pos) {
  if (!pos || !node.size) return -1;
  const s = faceScale(node);
  const slop = M.btnGap * s / 2;
  const top = node.size[1] - BAR_H * s;   // the whole strip counts, not just the pill
  const rects = barRects(node.size[0], node.size[1], s);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (pos[0] >= r.x - slop && pos[0] <= r.x + r.w + slop && pos[1] >= top && pos[1] <= node.size[1]) return i;
  }
  return -1;
}
function paintLegacyBar(node, ctx, s, w, h, rr) {
  const slots = slotsOf(node);
  const T = tintOf(node);
  const rects = barRects(w, h, s);
  const a0 = ctx.globalAlpha;   // MULTIPLY (the node's mode alpha is already applied)
  const dim = dotDim(node);
  ctx.font = `700 ${M.btnFont * s}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.lineWidth = Math.max(1, s);
  rects.forEach((r, i) => {
    if (i === HISTORY_MAX) {   // reset button
      const can = getHistory(node).length > 0;
      ctx.globalAlpha = a0;
      ctx.beginPath(); rr(r.x, r.y, r.w, r.h, M.btnR * s);
      ctx.strokeStyle = can ? "rgba(" + T.css + ",0.6)" : "#333"; ctx.stroke();
      ctx.fillStyle = can ? T.hex : "#555";
      fillTextVC(ctx, "\u00d7", r.x + r.w / 2, r.y + r.h / 2);
      return;
    }
    const sl = slots[i], has = sl.kind === "done", live = sl.kind === "live";
    const on = has && node._rtView === i;
    ctx.globalAlpha = live && dim ? a0 * 0.45 : a0;
    ctx.beginPath(); rr(r.x, r.y, r.w, r.h, M.btnR * s);
    if (live) {
      ctx.fillStyle = "rgba(" + RUN_RGB + ",0.22)"; ctx.fill();
      ctx.strokeStyle = RUN_COLOR; ctx.stroke();
    } else if (on) { ctx.fillStyle = T.hex; ctx.fill(); }
    else { ctx.strokeStyle = has ? "rgba(" + T.css + ",0.6)" : "#333"; ctx.stroke(); }
    ctx.fillStyle = live ? RUN_COLOR : on ? "#0c0c0e" : has ? T.hex : "#555";
    fillTextVC(ctx, String(i + 1), r.x + r.w / 2, r.y + r.h / 2);
  });
  ctx.globalAlpha = a0;
}
function paintLegacyClock(node, ctx) {
  const w = node.size[0], h = node.size[1];
  const s = faceScale(node);
  const rr = (x, y, ww, hh, r) => { if (ctx.roundRect) ctx.roundRect(x, y, ww, hh, r); else ctx.rect(x, y, ww, hh); };
  ctx.save();
  const L = clockLayout(ctx, node, s);
  const T = tintOf(node);
  ctx.fillStyle = "#0c0c0e";
  ctx.beginPath(); rr(0, 0, w, h, M.radius * s); ctx.fill();
  // status dot (ticks once a second while running)
  const dm = node._rtDotState || "idle";
  ctx.fillStyle = dm === "run" ? "#3ec371" : dm === "done" ? T.hex : "#6b6b72";
  const a0 = ctx.globalAlpha;
  if (dm === "run" && dotDim(node)) ctx.globalAlpha = a0 * 0.35;
  ctx.beginPath(); ctx.arc(M.dotAt * s, M.dotAt * s, M.dotR * s, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = a0;
  // digits: centred in the area ABOVE the button strip
  ctx.textAlign = "left";
  let x = (w - L.total) / 2;
  const midY = (h - BAR_H * s) / 2;
  L.segs.forEach((sg, i) => {
    if (i > 0) {
      ctx.font = L.f.num; ctx.fillStyle = T.hex; ctx.globalAlpha = 0.7;
      fillTextVC(ctx, ":", x + M.gap * s, midY); ctx.globalAlpha = 1;
      x += M.gap * 2 * s + L.colonW;
    }
    ctx.font = L.f.num; ctx.fillStyle = T.hex; ctx.globalAlpha = 1;
    x = drawNumRun(ctx, sg.g.num, x, midY, L.numCell, L.numDot);
    if (sg.fracW) {
      ctx.font = L.f.frac; ctx.globalAlpha = 0.85;
      x = drawNumRun(ctx, L.parts.frac, x, midY, L.fracCell, L.fracDot);
      ctx.globalAlpha = 1;
    }
    ctx.font = L.f.unit; ctx.fillStyle = T.hex; ctx.globalAlpha = 0.5; ctx.textBaseline = "alphabetic";
    ctx.fillText(sg.g.unit, x + M.unitDx * s, midY - M.unitDy * s);
    ctx.globalAlpha = 1; x += M.unitDx * s + sg.unitW;
  });
  ctx.globalAlpha = a0;
  paintLegacyBar(node, ctx, s, w, h, rr);
  ctx.restore();
  noteShown(node, L.parts);
}
// Classic: make the node body match the clock screen and drop the shadow, so
// the body IS the clock (no frame around a title-less node).
function installBodyHook() {
  if (typeof window === "undefined" || window._pixRtHistBodyWrapped) return;
  const proto = window.LGraphCanvas && window.LGraphCanvas.prototype;
  if (!proto || typeof proto.drawNode !== "function") return;
  window._pixRtHistBodyWrapped = true;
  const orig = proto.drawNode;
  proto.drawNode = function (node, ctx) {
    if (ctx && isOurNode(node)) {
      const sBg = node.bgcolor, sCol = node.color, sShadow = ctx.shadowColor;
      node._rtRealBg = sBg; node._rtRealCol = sCol; node._rtInDraw = true;
      const LG = window.LiteGraph || {};
      const sR = LG.ROUND_RADIUS;
      node.bgcolor = "#0c0c0e"; node.color = "#0c0c0e";
      LG.ROUND_RADIUS = 8;
      ctx.shadowColor = "rgba(0,0,0,0)";
      try { return orig.apply(this, arguments); }
      finally {
        node.bgcolor = sBg; node.color = sCol; ctx.shadowColor = sShadow;
        node._rtInDraw = false;
        LG.ROUND_RADIUS = sR;
      }
    }
    return orig.apply(this, arguments);
  };
}

// ── Nodes 2.0: scale observer + the two faces ───────────────────────────────
// Writes only a CSS variable: a ResizeObserver that calls setSize fires mid-drag
// and would false-dirty the workflow on load.
function installVueScaleObserver(node, root) {
  if (typeof ResizeObserver === "undefined") return () => {};
  let last = -1;
  const apply = () => {
    const w = root.clientWidth;
    if (!(w > 0)) return;
    const s = clockScale(node, w, false);
    node._rtScale = s;
    if (Math.abs(s - last) < 0.005) return;
    last = s;
    root.style.setProperty("--rt-s", String(s));
  };
  const ro = new ResizeObserver(apply);
  ro.observe(root);
  apply();
  return () => { try { ro.disconnect(); } catch (_e) {} };
}
function buildVueFace(node) {
  if (node._pixRtRoot) return;
  const root = el("div", "pix-rt-root");
  const screen = el("div", "pix-rt-screen");
  const dot = el("span", "pix-rt-dot");
  const row = el("div", "pix-rt-clockrow");
  const time = el("div", "pix-rt-time");
  row.appendChild(time);
  const bar = el("div", "pix-rt-bar");
  node._rtBtns = [];
  for (let i = 0; i < HISTORY_MAX; i++) {
    const b = el("button", "pix-rt-btn empty");
    b.type = "button";
    b.tabIndex = -1;
    b.textContent = String(i + 1);
    b.addEventListener("click", (e) => { e.stopPropagation(); pickRun(node, i); });
    bar.appendChild(b);
    node._rtBtns.push(b);
  }
  const rb = el("button", "pix-rt-btn pix-rt-reset empty");
  rb.type = "button";
  rb.tabIndex = -1;
  rb.textContent = "\u00d7";
  rb.addEventListener("click", (e) => { e.stopPropagation(); resetHistory(node); });
  bar.appendChild(rb);
  node._rtResetBtn = rb;
  screen.appendChild(dot); screen.appendChild(row); screen.appendChild(bar);
  root.appendChild(screen);
  node._pixRtRoot = root; node._pixRtScreen = screen; node._pixRtDot = dot; node._pixRtTime = time;
  node._rtShapeSig = null; node._rtNumEls = null; node._rtFracEl = null; node._rtBarSig = null;
  node._rtTintApplied = null;
  paint(node);
  const widget = node.addDOMWidget("run_timer_ui", "run_timer_history", root, {
    getValue: () => ({}),
    setValue: () => {},
    getMinHeight: () => BASE_H,   // a constant: a measured value creeps bigger on every tab switch
    serialize: false,
  });
  node._pixRtWidget = widget;
  // 0 in classic: after a flip the torn-down face lingers for one poll and must not grow the node
  widget.computeLayoutSize = () => ({ minHeight: isVueNodes() ? BASE_H : 0, minWidth: 1 });
  node._pixRtScaleOff = installVueScaleObserver(node, root);
}
function teardownVueFace(node) {
  try { if (node._pixRtScaleOff) node._pixRtScaleOff(); } catch (_e) {}
  node._pixRtScaleOff = null;
  const w = node._pixRtWidget || (node.widgets || []).find((x) => x && x.name === "run_timer_ui");
  removeNodeWidget(node, w);
  try {
    const wrap = node._pixRtRoot && node._pixRtRoot.closest && node._pixRtRoot.closest(".dom-widget");
    if (wrap) wrap.remove();
    if (node._pixRtRoot) node._pixRtRoot.remove();
  } catch (_e) {}
  node._pixRtWidget = null; node._pixRtRoot = null; node._pixRtScreen = null;
  node._pixRtDot = null; node._pixRtTime = null;
  node._rtNumEls = null; node._rtFracEl = null; node._rtShapeSig = null;
  node._rtBtns = null; node._rtResetBtn = null; node._rtBarSig = null;
}
function useClassicFace(node) {
  // The scale-1 size is also LiteGraph's resize floor: the clock never gets
  // smaller than its original look and grows freely from there.
  node.computeSize = function () { return [clockUnitWidth(this), BASE_H]; };
}
function applyRenderer(node, vue, live) {
  vue = !!vue;
  if (node._pixRtVue === vue) return;
  node._pixRtVue = vue;
  if (vue) {
    if (Object.prototype.hasOwnProperty.call(node, "computeSize")) delete node.computeSize;
    buildVueFace(node);
  } else {
    teardownVueFace(node);
    useClassicFace(node);
  }
  if (!live) return;
  forgetLiveMarks(node);
  if (vue) {
    setDot(node, node._rtDotState || "idle");
    refreshClock(node);
  } else {
    // Nodes 2.0 left a stub height in node.size, and its WIDTH carried the scale:
    // put the node back at that scale (from node.size[0], not _rtScale).
    if (typeof node.setSize === "function") {
      const u = clockUnitWidth(node);
      const s = Math.max(1, Math.min(MAX_S, (node.size[0] || u) / u));
      const w = Math.round(u * s), h = Math.round(BASE_H * s);
      if (Math.abs((node.size[0] || 0) - w) > 0.5 || Math.abs((node.size[1] || 0) - h) > 0.5) node.setSize([w, h]);
    }
    syncScaleFromSize(node);
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, false);
  }
}

function setupNode(node) {
  injectCSS();
  node._rtDisplayMs = 0;
  node._rtRunning = false;
  node._rtView = null;
  node._rtDotState = "idle";
  node.badges = [];
  node.flags = node.flags || {};
  if (!node.flags.no_title) node.flags.no_title = true;

  node._pixRtVue = null;
  applyRenderer(node, isVueNodes(), false);
  node._pixRtRendererOff = onRendererChange((vue) => { if (node.graph) applyRenderer(node, vue, true); });

  // A FRESH node opens at scale 1. Synchronous: configure() runs after this and
  // restores the saved size for saved or duplicated nodes.
  const fresh = [clockUnitWidth(node), BASE_H];
  if (Array.isArray(node.size)) { node.size[0] = fresh[0]; node.size[1] = fresh[1]; }
  else node.size = fresh;

  _timers.add(node);
  // nodeCreated fires BEFORE configure() restores node.properties: defer.
  queueMicrotask(() => {
    adoptLiveRun(node);
    restoreLastRun(node);
    syncScaleFromSize(node);
    applyState(node);
    refreshNodeSize(node);
  });
}

app.registerExtension({
  name: "RunTimer.History",

  setup() {
    installRunListeners();
    installBodyHook();
    installTintWatch();
    setTimeout(() => {
      if (_ourTypes.size) return;
      console.warn("[Run Timer History] no node type matched, so the node will look like a plain node. "
        + "Node types seen from this pack: " + (_packTypes.join(", ") || "none")
        + ". Make sure the Python class name contains 'Timer', or set NODE_NAME at the top of this file to it.");
    }, 4000);
  },

  getNodeMenuItems(node) {
    if (!isOurNode(node)) return [];
    const dec = decimalsOf(node);
    return [
      null,
      { content: "Clear run history", callback: () => clearHistory(node) },
      { content: "Decimals: " + (dec ? dec : "Off") + " (click to change)", callback: () => cycleDecimals(node) },
    ];
  },

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (fromThisPack(nodeData)) _packTypes.push(nodeData.name);
    if (!isOurDef(nodeData)) return;
    _ourTypes.add(nodeData.name);
    console.info("[Run Timer History] attached to node type '" + nodeData.name + "'");

    // Title-less: NO_TITLE on the node TYPE, once, so both renderers never
    // reserve the title height.
    const LG = (typeof window !== "undefined" && window.LiteGraph) || {};
    nodeType.title_mode = (LG.NO_TITLE != null) ? LG.NO_TITLE : 1;
    nodeType.prototype.drawBadges = function () {};

    if (nodeType.prototype._pixRtHistPatched) return;
    nodeType.prototype._pixRtHistPatched = true;

    const _origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = _origConfigure ? _origConfigure.apply(this, arguments) : undefined;
      this.flags = this.flags || {};
      if (!this.flags.no_title) this.flags.no_title = true;
      restoreLastRun(this);
      syncScaleFromSize(this);
      applyState(this); refreshNodeSize(this);
      return r;
    };

    const _origRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      _timers.delete(this);
      clearTimeout(this._rtDotT);
      try { if (this._pixRtRendererOff) this._pixRtRendererOff(); } catch (_e) {}
      this._pixRtRendererOff = null;
      try { if (this._pixRtScaleOff) this._pixRtScaleOff(); } catch (_e) {}
      this._pixRtScaleOff = null;
      if (_origRemoved) return _origRemoved.apply(this, arguments);
    };

    // Classic: the user drags the width and the height follows. isGraphLoading is
    // NOT optional here: onResize also runs on workflow restore.
    const _origResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function () {
      if (!isVueNodes() && !isGraphLoading()) applyResizeAspect(this);
      if (_origResize) return _origResize.apply(this, arguments);
    };

    // Classic: a click on a history button. Returning true stops LiteGraph from
    // starting a node drag; everything else falls through to normal behavior.
    const _origMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos) {
      if (!isVueNodes() && !(e && e.button != null && e.button !== 0)) {
        const i = hitButton(this, pos);
        if (i >= 0) { if (i === HISTORY_MAX) resetHistory(this); else pickRun(this, i); return true; }
      }
      return _origMouseDown ? _origMouseDown.apply(this, arguments) : false;
    };

    // Nodes 2.0: never above the CURRENT size, or core grows the node on every open.
    const _origComputeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (out) {
      const s = _origComputeSize.call(this, out);
      if (isVueNodes() && this.size) {
        if (Number.isFinite(this.size[0])) s[0] = Math.min(s[0], this.size[0]);
        if (Number.isFinite(this.size[1])) s[1] = Math.min(s[1], this.size[1]);
      }
      return s;
    };

    // Classic: paint the clock and the buttons. A height that is out of range
    // (a timer saved in Nodes 2.0) is repaired from the width.
    const _origFg = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = _origFg ? _origFg.apply(this, arguments) : undefined;
      if (ctx && !isVueNodes()) {
        if (!isGraphLoading()) {
          const hOut = !(this.size[1] >= BASE_H - 0.5 && this.size[1] <= BASE_H * MAX_S + 0.5);
          if (isResizingThis(this) || hOut) applyResizeAspect(this);
          else syncScaleFromSize(this);
        }
        try { paintLegacyClock(this, ctx); } catch (_e) {}
      }
      return r;
    };
  },

  nodeCreated(node) {
    if (!isOurNode(node)) return;
    setupNode(node);
  },
});
