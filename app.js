/* ============================================================
   Image Bench — app logic
   Everything runs client-side. Only model weights are fetched.
   ============================================================ */

const BG_LIB    = 'https://esm.sh/@imgly/background-removal@1.7.0';
const TRACE_LIB = 'https://esm.sh/imagetracerjs@1.2.6';

/* ---------- element lookup ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('fileInput'), workspace: $('workspace'),
  newImageBtn: $('newImageBtn'), acceptedFormats: $('acceptedFormats'),
  stageSplit: $('stageSplit'), stageSbs: $('stageSbs'),
  splitView: $('splitView'), afterWrap: $('afterWrap'),
  imgBeforeSplit: $('imgBeforeSplit'), imgAfterSplit: $('imgAfterSplit'),
  imgBeforeSbs: $('imgBeforeSbs'), imgAfterSbs: $('imgAfterSbs'),
  liveSplit: $('liveSplit'), liveSbs: $('liveSbs'),
  handle: $('handle'), checkerToggle: $('checkerToggle'),
  zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomReset: $('zoomReset'),
  roName: $('roName'), roSource: $('roSource'), roResult: $('roResult'), roTime: $('roTime'),
  panelBg: $('panel-bg'), panelConvert: $('panel-convert'),
  panelColorize: $('panel-colorize'), panelScribble: $('panel-scribble'),
  bgModel: $('bgModel'), bgDevice: $('bgDevice'), bgFormat: $('bgFormat'),
  bgQuality: $('bgQuality'), bgQualityField: $('bgQualityField'), bgQualityVal: $('bgQualityVal'),
  bgCustomColor: $('bgCustomColor'),
  tuField: $('tuField'), tuErase: $('tuErase'), tuRestore: $('tuRestore'),
  tuSize: $('tuSize'), tuSizeVal: $('tuSizeVal'), tuSmart: $('tuSmart'), tuReset: $('tuReset'),
  tuHint: $('tuHint'), brushCursor: $('brushCursor'),
  cvFormat: $('cvFormat'), cvFormatHint: $('cvFormatHint'),
  cvQuality: $('cvQuality'), cvQualityField: $('cvQualityField'), cvQualityVal: $('cvQualityVal'),
  cvScale: $('cvScale'), cvScaleVal: $('cvScaleVal'), cvOutDims: $('cvOutDims'),
  cvFlattenField: $('cvFlattenField'), cvCustomColor: $('cvCustomColor'),
  traceOpts: $('traceOpts'),
  tcColors: $('tcColors'), tcColorsVal: $('tcColorsVal'),
  tcDetail: $('tcDetail'), tcDetailVal: $('tcDetailVal'),
  tcKeepTransparent: $('tcKeepTransparent'),
  czColor: $('czColor'), czStrength: $('czStrength'), czStrengthVal: $('czStrengthVal'),
  czReplace: $('czReplace'), czReplaceOpts: $('czReplaceOpts'),
  czFrom: $('czFrom'), czPick: $('czPick'),
  czLikeness: $('czLikeness'), czLikenessVal: $('czLikenessVal'),
  scWeight: $('scWeight'), scWeightVal: $('scWeightVal'),
  scColors: $('scColors'), scColorsVal: $('scColorsVal'),
  scDetail: $('scDetail'), scDetailVal: $('scDetailVal'),
  scTimelapse: $('scTimelapse'),
  progress: $('progress'), progressFill: $('progressFill'), progressLabel: $('progressLabel'),
  errorBox: $('errorBox'), runBtn: $('runBtn'),
  downloadBtn: $('downloadBtn'), timelapseBtn: $('timelapseBtn'),
};

/* ---------- state ---------- */
const state = {
  tab: 'bg',
  file: null,
  srcImg: null,
  srcW: 0, srcH: 0,
  srcURL: null,
  sampCanvas: null,               // source pixels for the eyedropper
  bgBackdrop: 'transparent',
  cvBackdrop: '#FFFFFF',
  czMode: 'tint',
  results: { bg: null, convert: null, colorize: null, scribble: null },
  busy: false,
  splitF: 0.5,                    // split position, fraction of the content plane
  zoom: { z: 1, fx: 0, fy: 0 },   // scale + pan (fractions of the plane)
  pickMode: false,                // eyedropper armed
  tool: null,                     // 'erase' | 'restore' | null
  edit: null,                     // touch-up session for the bg result
};

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};
const LOSSY = new Set(['image/jpeg', 'image/webp', 'image/avif']);
const NO_ALPHA = new Set(['image/jpeg', 'image/bmp']);
const RUN_LABEL = { bg: 'Remove background', convert: 'Convert', colorize: 'Colorize', scribble: 'Scribble it' };
const DL_SUFFIX = { bg: '-cutout', convert: '', colorize: '-colorized', scribble: '-scribble' };
const PANELS = { bg: 'panelBg', convert: 'panelConvert', colorize: 'panelColorize', scribble: 'panelScribble' };

/* ============================================================
   Utilities
   ============================================================ */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const fmtBytes = (b) => {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
};

const baseName = (name) => name.replace(/\.[^.]+$/, '');

function showError(msg) {
  el.errorBox.textContent = msg;
  el.errorBox.hidden = false;
}
function clearError() { el.errorBox.hidden = true; }

function setProgress(pct, label) {
  el.progress.hidden = false;
  el.progressFill.style.width = Math.max(2, Math.min(100, pct)) + '%';
  el.progressLabel.textContent = label;
}
function hideProgress() { el.progress.hidden = true; el.progressFill.style.width = '0%'; }

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/* ---- color helpers ---- */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}

/** Detect whether this browser can actually encode a given mime. */
async function canEncode(mime) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const blob = await new Promise((r) => c.toBlob(r, mime, 0.8));
  return !!blob && blob.type === mime;
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`This browser can't write ${mime}.`))),
      mime,
      quality
    );
  });
}

/** 24-bit BMP encoder — browsers can't do this natively. */
function encodeBMP(imageData) {
  const { width: w, height: h, data } = imageData;
  const rowSize = Math.floor((24 * w + 31) / 32) * 4;
  const pixelBytes = rowSize * h;
  const buf = new ArrayBuffer(54 + pixelBytes);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setUint8(0, 0x42); dv.setUint8(1, 0x4d);          // "BM"
  dv.setUint32(2, 54 + pixelBytes, true);
  dv.setUint32(10, 54, true);                           // pixel data offset
  dv.setUint32(14, 40, true);                           // DIB header size
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);                             // positive = bottom-up
  dv.setUint16(26, 1, true);                            // planes
  dv.setUint16(28, 24, true);                           // bits per pixel
  dv.setUint32(34, pixelBytes, true);
  dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true); // 72 DPI

  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    let off = 54 + y * rowSize;
    for (let x = 0; x < w; x++) {
      const i = (srcY * w + x) * 4;
      u8[off++] = data[i + 2];  // B
      u8[off++] = data[i + 1];  // G
      u8[off++] = data[i];      // R
    }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

/** SVG files need explicit intrinsic dimensions before they'll rasterize reliably. */
async function svgToImage(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.nodeName === 'parsererror') {
    throw new Error("That SVG couldn't be parsed. Check the file for syntax errors.");
  }

  const num = (v) => (v && !v.includes('%') && parseFloat(v) > 0 ? parseFloat(v) : null);
  let w = num(svg.getAttribute('width'));
  let h = num(svg.getAttribute('height'));

  if (!w || !h) {
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
  }
  if (!w || !h) { w = 1024; h = 1024; }

  // Render vectors at a useful raster size rather than a 24px icon.
  const target = 1400;
  if (Math.max(w, h) < target) {
    const k = target / Math.max(w, h);
    w = Math.round(w * k); h = Math.round(h * k);
  }
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));

  const src = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml' }));
  const img = await loadImage(url);
  return { img, url, w, h };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file couldn't be decoded as an image."));
    img.src = url;
  });
}

/** Draw the source onto a canvas at a scale, optionally over a solid backdrop. */
function rasterize(img, w, h, backdrop) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (backdrop && backdrop !== 'transparent') {
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/* ============================================================
   Loading a file
   ============================================================ */

async function loadFile(file) {
  if (!file) return;
  const isSVG = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (!file.type.startsWith('image/') && !isSVG) {
    showError(`"${file.name}" isn't an image file.`);
    el.dropzone.classList.remove('is-over');
    return;
  }

  clearError();
  cancelScribbleAnim();
  setTool(null);
  state.edit = null;
  state.pickMode = false;
  el.czPick.classList.remove('is-on');
  releaseResults();
  if (state.srcURL) URL.revokeObjectURL(state.srcURL);

  try {
    if (isSVG) {
      const { img, url, w, h } = await svgToImage(file);
      state.srcImg = img; state.srcURL = url; state.srcW = w; state.srcH = h;
    } else {
      const url = URL.createObjectURL(file);
      const img = await loadImage(url);
      state.srcImg = img; state.srcURL = url;
      state.srcW = img.naturalWidth; state.srcH = img.naturalHeight;
    }
  } catch (err) {
    showError(err.message);
    return;
  }

  state.file = file;

  // Sampling canvas for the eyedropper (capped: color precision ≠ resolution).
  const sk = Math.min(1, 2200 / Math.max(state.srcW, state.srcH));
  state.sampCanvas = rasterize(state.srcImg, state.srcW * sk, state.srcH * sk, null);

  el.imgBeforeSplit.src = state.srcURL;
  el.imgBeforeSbs.src = state.srcURL;

  el.roName.textContent = file.name;
  el.roName.title = file.name;
  el.roSource.textContent = `${state.srcW}×${state.srcH} · ${fmtBytes(file.size)}`;
  el.roResult.textContent = '—';
  el.roTime.textContent = '—';

  el.dropzone.hidden = true;
  el.workspace.hidden = false;
  el.newImageBtn.hidden = false;
  markBlank(true);
  el.downloadBtn.disabled = true;
  el.timelapseBtn.hidden = true;
  el.tuField.hidden = true;
  resetZoom();
  state.splitF = 0.5;
  applySplit();
  updateOutDims();
  hideProgress();
}

function markBlank(blank) {
  el.stageSplit.classList.toggle('is-blank', blank);
  el.stageSbs.classList.toggle('is-blank', blank);
  updateHandle();
}

function releaseResults() {
  for (const k of Object.keys(state.results)) {
    const r = state.results[k];
    if (r?.url) URL.revokeObjectURL(r.url);
    if (r?.timelapse?.url) URL.revokeObjectURL(r.timelapse.url);
    state.results[k] = null;
  }
}

/* ============================================================
   Zoom, pan, split
   ============================================================ */

function applyZoom() {
  const { z, fx, fy } = state.zoom;
  const t = `translate(${fx * 100}%, ${fy * 100}%) scale(${z})`;
  el.splitView.style.transform = t;
  document.querySelectorAll('.pane__view').forEach((v) => { v.style.transform = t; });
  el.zoomReset.textContent = Math.round(z * 100) + '%';
  const pannable = z > 1.001 && !state.tool;
  el.stageSplit.classList.toggle('can-pan', pannable);
  el.stageSbs.classList.toggle('can-pan', pannable);
  updateHandle();
}

function clampPan() {
  const { z } = state.zoom;
  state.zoom.fx = clamp(state.zoom.fx, 1 - z, 0);
  state.zoom.fy = clamp(state.zoom.fy, 1 - z, 0);
}

function setZoom(z, cx = 0.5, cy = 0.5) {
  z = clamp(z, 1, 8);
  const o = state.zoom;
  const ux = (cx - o.fx) / o.z, uy = (cy - o.fy) / o.z;
  o.fx = cx - ux * z;
  o.fy = cy - uy * z;
  o.z = z;
  clampPan();
  applyZoom();
}

function resetZoom() {
  state.zoom = { z: 1, fx: 0, fy: 0 };
  applyZoom();
}

function applySplit() {
  el.afterWrap.style.clipPath = `inset(0 0 0 ${state.splitF * 100}%)`;
  updateHandle();
}

function updateHandle() {
  // Handle lives in stage coordinates; the split line lives on the zoomed plane.
  const s = state.zoom.fx + state.splitF * state.zoom.z;
  el.handle.style.left = s * 100 + '%';
  el.handle.style.visibility = s < -0.005 || s > 1.005 ? 'hidden' : '';
  el.handle.setAttribute('aria-valuenow', String(Math.round(state.splitF * 100)));
}

el.zoomIn.addEventListener('click', () => setZoom(state.zoom.z * 1.4));
el.zoomOut.addEventListener('click', () => setZoom(state.zoom.z / 1.4));
el.zoomReset.addEventListener('click', resetZoom);

function wireWheelZoom(stage, unitFor) {
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = unitFor(e).getBoundingClientRect();
    const cx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const cy = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    setZoom(state.zoom.z * (e.deltaY < 0 ? 1.16 : 1 / 1.16), cx, cy);
  }, { passive: false });
}
wireWheelZoom(el.stageSplit, () => el.stageSplit);
wireWheelZoom(el.stageSbs, (e) => e.target.closest('.pane') || el.stageSbs.querySelector('.pane'));

/** Map a client point to source-image pixel coordinates, given the plane box
    (the split stage, or one sbs pane). Accounts for zoom, pan, the 14px
    frame, and object-fit: contain letterboxing. Returns null outside. */
function clientToSrc(clientX, clientY, box) {
  const r = box.getBoundingClientRect();
  const xf = (clientX - r.left) / r.width;
  const yf = (clientY - r.top) / r.height;
  const u = (xf - state.zoom.fx) / state.zoom.z;
  const v = (yf - state.zoom.fy) / state.zoom.z;
  const bw = r.width - 28, bh = r.height - 28;
  const px = u * r.width - 14, py = v * r.height - 14;
  const sc = Math.min(bw / state.srcW, bh / state.srcH);
  const ox = (bw - state.srcW * sc) / 2, oy = (bh - state.srcH * sc) / 2;
  const ix = (px - ox) / sc, iy = (py - oy) / sc;
  if (ix < 0 || iy < 0 || ix >= state.srcW || iy >= state.srcH) return null;
  return { x: ix, y: iy, cssPerImagePx: sc * state.zoom.z };
}

function planeBoxFor(e, stage) {
  if (stage === el.stageSbs) return e.target.closest('.pane') || el.stageSbs.querySelector('.pane');
  return stage;
}

/* --- pointer interactions: eyedropper > brush > split line > pan --- */
let drag = null;

function setSplitFromClient(clientX, rect) {
  const xf = (clientX - rect.left) / rect.width;
  state.splitF = clamp((xf - state.zoom.fx) / state.zoom.z, 0, 1);
  applySplit();
}

function stagePointerDown(stage, e) {
  if (e.button !== 0) return;

  /* 1 — eyedropper */
  if (state.pickMode) {
    const p = clientToSrc(e.clientX, e.clientY, planeBoxFor(e, stage));
    if (p) samplePickColor(p);
    e.preventDefault();
    return;
  }

  /* 2 — touch-up brush */
  const onHandle = !!e.target.closest?.('.handle');
  if (state.tool && state.tab === 'bg' && state.edit && !onHandle) {
    e.preventDefault();
    beginPaint(stage, e);
    return;
  }

  const rect = stage.getBoundingClientRect();

  /* 3 — split line (split stage only) */
  if (stage === el.stageSplit) {
    const xf = (e.clientX - rect.left) / rect.width;
    const handleS = state.zoom.fx + state.splitF * state.zoom.z;
    const blank = stage.classList.contains('is-blank');
    const nearHandle = Math.abs(xf - handleS) * rect.width < 24;
    if (!blank && (nearHandle || (state.zoom.z <= 1.001 && !state.tool))) {
      e.preventDefault();
      drag = { mode: 'split', rect, stage };
      stage.setPointerCapture(e.pointerId);
      setSplitFromClient(e.clientX, rect);
      return;
    }
  }

  /* 4 — pan */
  if (state.zoom.z > 1.001) {
    e.preventDefault();
    const unit = stage === el.stageSbs
      ? el.stageSbs.querySelector('.pane').getBoundingClientRect()
      : rect;
    drag = {
      mode: 'pan', sx: e.clientX, sy: e.clientY,
      fx: state.zoom.fx, fy: state.zoom.fy,
      unitW: unit.width, unitH: unit.height, stage,
    };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-panning');
  }
}

el.stageSplit.addEventListener('pointerdown', (e) => stagePointerDown(el.stageSplit, e));
el.stageSbs.addEventListener('pointerdown', (e) => stagePointerDown(el.stageSbs, e));

function onDragMove(e) {
  if (state.tool) updateBrushCursor(e);
  if (paintDrag) { paintMove(e); return; }
  if (!drag) return;
  if (drag.mode === 'split') {
    setSplitFromClient(e.clientX, drag.rect);
  } else {
    state.zoom.fx = drag.fx + (e.clientX - drag.sx) / drag.unitW;
    state.zoom.fy = drag.fy + (e.clientY - drag.sy) / drag.unitH;
    clampPan();
    applyZoom();
  }
}
function onDragEnd(e) {
  if (paintDrag) { endPaint(e); return; }
  if (!drag) return;
  drag.stage.classList.remove('is-panning');
  drag = null;
}
for (const stage of [el.stageSplit, el.stageSbs]) {
  stage.addEventListener('pointermove', onDragMove);
  stage.addEventListener('pointerup', onDragEnd);
  stage.addEventListener('pointercancel', onDragEnd);
  stage.addEventListener('pointerleave', () => { el.brushCursor.hidden = true; });
}

el.handle.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  state.splitF = clamp(state.splitF + (e.key === 'ArrowRight' ? 0.02 : -0.02), 0, 1);
  applySplit();
});

/* ============================================================
   Eyedropper (colorizer "pick from image")
   ============================================================ */

function samplePickColor(p) {
  const c = state.sampCanvas;
  const kx = c.width / state.srcW;
  const d = c.getContext('2d').getImageData(
    clamp(Math.round(p.x * kx), 0, c.width - 1),
    clamp(Math.round(p.y * kx), 0, c.height - 1),
    1, 1
  ).data;
  el.czFrom.value = rgbToHex(d[0], d[1], d[2]);
  state.pickMode = false;
  el.czPick.classList.remove('is-on');
  document.body.classList.remove('is-picking');
}

el.czPick.addEventListener('click', () => {
  state.pickMode = !state.pickMode;
  el.czPick.classList.toggle('is-on', state.pickMode);
  document.body.classList.toggle('is-picking', state.pickMode);
});

/* ============================================================
   Touch-up: erase / restore the background-removal result
   ============================================================ */

let paintDrag = null;

function setTool(tool) {
  state.tool = state.tool === tool ? null : tool;   // toggle off on second click
  if (tool === null) state.tool = null;
  el.tuErase.classList.toggle('is-on', state.tool === 'erase');
  el.tuRestore.classList.toggle('is-on', state.tool === 'restore');
  el.brushCursor.hidden = true;

  if (state.tool && !state.edit) initEdit();
  if (state.tool) {
    enterEditDisplay();
  } else {
    el.brushCursor.hidden = true;
    finalizeEdit();   // re-encode + swap back to <img> display
  }
  applyZoom();  // updates the can-pan cursor state
}

function initEdit() {
  const r = state.results.bg;
  if (!r?.editCanvas) return;
  const w = r.editCanvas.width, h = r.editCanvas.height;
  const cutData = r.editCanvas.getContext('2d').getImageData(0, 0, w, h);
  const orig = rasterize(state.srcImg, w, h, null)
    .getContext('2d').getImageData(0, 0, w, h);
  const mask = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = cutData.data[i * 4 + 3];

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  state.edit = {
    w, h, orig: orig.data, mask,
    pristine: mask.slice(),
    canvas, ctx: canvas.getContext('2d'),
    dirty: false, encoding: null,
  };
  compositeEdit(0, 0, w, h);
}

/** Rebuild a region of the display canvas: original RGB × edited alpha. */
function compositeEdit(x0, y0, x1, y1) {
  const ed = state.edit;
  x0 = clamp(Math.floor(x0), 0, ed.w); y0 = clamp(Math.floor(y0), 0, ed.h);
  x1 = clamp(Math.ceil(x1), 0, ed.w);  y1 = clamp(Math.ceil(y1), 0, ed.h);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;
  const out = new ImageData(rw, rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const si = ((y + y0) * ed.w + (x + x0));
      const di = (y * rw + x) * 4;
      out.data[di] = ed.orig[si * 4];
      out.data[di + 1] = ed.orig[si * 4 + 1];
      out.data[di + 2] = ed.orig[si * 4 + 2];
      out.data[di + 3] = ed.mask[si];
    }
  }
  ed.ctx.putImageData(out, x0, y0);
}

function enterEditDisplay() {
  const ed = state.edit;
  if (!ed) return;
  for (const cv of [el.liveSplit, el.liveSbs]) {
    cv.width = ed.w; cv.height = ed.h;
    cv.hidden = false;
  }
  el.imgAfterSplit.style.visibility = 'hidden';
  el.imgAfterSbs.style.visibility = 'hidden';
  refreshEditDisplay();
}

function refreshEditDisplay() {
  const ed = state.edit;
  if (!ed) return;
  for (const cv of [el.liveSplit, el.liveSbs]) {
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, ed.w, ed.h);
    ctx.drawImage(ed.canvas, 0, 0);
  }
}

async function finalizeEdit() {
  const ed = state.edit;
  const restoreImgs = () => {
    el.liveSplit.hidden = true;
    el.liveSbs.hidden = true;
    el.imgAfterSplit.style.visibility = '';
    el.imgAfterSbs.style.visibility = '';
  };
  if (!ed || !ed.dirty) { restoreImgs(); return; }

  ed.dirty = false;
  const r = state.results.bg;
  const mime = { png: 'image/png', webp: 'image/webp' }[r.ext] || 'image/png';
  const blob = await canvasToBlob(ed.canvas, mime,
    LOSSY.has(mime) ? parseFloat(el.bgQuality.value) : undefined);

  const prevUrl = r.url;
  r.blob = blob;
  r.url = URL.createObjectURL(blob);
  r.editCanvas.getContext('2d').clearRect(0, 0, ed.w, ed.h);
  r.editCanvas.getContext('2d').drawImage(ed.canvas, 0, 0);
  setTimeout(() => URL.revokeObjectURL(prevUrl), 1500);

  restoreImgs();
  if (state.tab === 'bg') showResult('bg');
}

function beginPaint(stage, e) {
  const box = planeBoxFor(e, stage);
  const p = clientToSrc(e.clientX, e.clientY, box);
  const ed = state.edit;
  if (!ed) return;
  // brush size slider is in screen px; convert to edit-canvas px
  const editPerSrc = ed.w / state.srcW;
  const r = p
    ? (parseInt(el.tuSize.value, 10) / 2 / p.cssPerImagePx) * editPerSrc
    : 12;
  paintDrag = { box, r: Math.max(1.5, r), last: null, stage, moved: false };
  stage.setPointerCapture(e.pointerId);
  paintMove(e);
}

function paintMove(e) {
  const pd = paintDrag;
  const ed = state.edit;
  if (!pd || !ed) return;
  const p = clientToSrc(e.clientX, e.clientY, pd.box);
  if (!p) { pd.last = null; return; }
  const editPerSrc = ed.w / state.srcW;
  const pt = { x: p.x * editPerSrc, y: p.y * editPerSrc };
  if (pd.last) {
    const dist = Math.hypot(pt.x - pd.last.x, pt.y - pd.last.y);
    const steps = Math.max(1, Math.ceil(dist / (pd.r / 2.5)));
    for (let i = 1; i <= steps; i++) {
      stamp(
        pd.last.x + ((pt.x - pd.last.x) * i) / steps,
        pd.last.y + ((pt.y - pd.last.y) * i) / steps,
        pd.r
      );
    }
  } else {
    stamp(pt.x, pt.y, pd.r);
  }
  pd.last = pt;
  pd.moved = true;
  if (!pd.raf) {
    pd.raf = requestAnimationFrame(() => { pd.raf = null; refreshEditDisplay(); });
  }
}

function endPaint(e) {
  const pd = paintDrag;
  paintDrag = null;
  if (pd?.raf) cancelAnimationFrame(pd.raf);
  refreshEditDisplay();
  if (state.edit && pd?.moved) state.edit.dirty = true;
}

/** One brush dab on the alpha mask. Smart mode weights the dab by how
    similar each pixel is to the color under the brush center, so strokes
    hug edges instead of plowing through them. */
function stamp(cx, cy, r) {
  const ed = state.edit;
  const erase = state.tool === 'erase';
  const smart = el.tuSmart.checked;
  const x0 = clamp(Math.floor(cx - r), 0, ed.w - 1);
  const x1 = clamp(Math.ceil(cx + r), 0, ed.w - 1);
  const y0 = clamp(Math.floor(cy - r), 0, ed.h - 1);
  const y1 = clamp(Math.ceil(cy + r), 0, ed.h - 1);

  let c0 = null;
  if (smart) {
    const ci = (clamp(Math.round(cy), 0, ed.h - 1) * ed.w + clamp(Math.round(cx), 0, ed.w - 1)) * 4;
    c0 = [ed.orig[ci], ed.orig[ci + 1], ed.orig[ci + 2]];
  }

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const t = Math.sqrt(dx * dx + dy * dy) / r;
      if (t > 1) continue;
      let w = t < 0.62 ? 1 : 1 - (t - 0.62) / 0.38;   // soft rim
      const i = y * ed.w + x;
      if (smart) {
        const o = i * 4;
        const dr = (ed.orig[o] - c0[0]) / 255;
        const dg = (ed.orig[o + 1] - c0[1]) / 255;
        const db = (ed.orig[o + 2] - c0[2]) / 255;
        const dc = Math.sqrt(dr * dr * 2 + dg * dg * 3 + db * db) / 2.449;
        w *= dc < 0.09 ? 1 : dc > 0.24 ? 0 : 1 - (dc - 0.09) / 0.15;
        if (!w) continue;
      }
      const v = w * 255;
      ed.mask[i] = erase ? Math.max(0, ed.mask[i] - v) : Math.min(255, ed.mask[i] + v);
    }
  }
  compositeEdit(x0, y0, x1 + 1, y1 + 1);
}

function updateBrushCursor(e) {
  if (!state.tool) { el.brushCursor.hidden = true; return; }
  const size = parseInt(el.tuSize.value, 10);
  el.brushCursor.hidden = false;
  el.brushCursor.style.width = size + 'px';
  el.brushCursor.style.height = size + 'px';
  el.brushCursor.style.left = e.clientX + 'px';
  el.brushCursor.style.top = e.clientY + 'px';
  el.brushCursor.classList.toggle('is-restore', state.tool === 'restore');
}

el.tuErase.addEventListener('click', () => setTool('erase'));
el.tuRestore.addEventListener('click', () => setTool('restore'));
el.tuSize.addEventListener('input', () => { el.tuSizeVal.textContent = el.tuSize.value + ' px'; });
el.tuReset.addEventListener('click', () => {
  const ed = state.edit;
  if (!ed) return;
  ed.mask.set(ed.pristine);
  ed.dirty = true;
  compositeEdit(0, 0, ed.w, ed.h);
  if (state.tool) refreshEditDisplay();
  else finalizeEdit();
});

/* ============================================================
   Tools
   ============================================================ */

let bgLib = null;
async function getBgLib() {
  if (!bgLib) {
    setProgress(4, 'Loading the background model library');
    bgLib = await import(/* @vite-ignore */ BG_LIB);
  }
  return bgLib;
}

let tracer = null;
async function getTracer() {
  if (!tracer) {
    setProgress(10, 'Loading the vector tracer');
    const mod = await import(/* @vite-ignore */ TRACE_LIB);
    tracer = mod.default || mod;
  }
  return tracer;
}

/* ---------- Tool 1: background removal ---------- */

async function runBackgroundRemoval() {
  const lib = await getBgLib();
  const removeBackground = lib.removeBackground || lib.default;

  const input = /\.svg$/i.test(state.file.name) || state.file.type === 'image/svg+xml'
    ? await canvasToBlob(rasterize(state.srcImg, state.srcW, state.srcH, null), 'image/png')
    : state.file;

  const onProgress = (key, current, total) => {
    const pct = total ? (current / total) * 100 : 0;
    if (String(key).startsWith('fetch')) {
      setProgress(6 + pct * 0.7, `Downloading model · ${Math.round(pct)}%`);
    } else {
      setProgress(80 + pct * 0.18, 'Separating foreground');
    }
  };

  const config = {
    model: el.bgModel.value,
    device: el.bgDevice.value,
    output: { format: 'image/png', quality: 1 },
    progress: onProgress,
  };

  let cut;
  try {
    cut = await removeBackground(input, config);
  } catch (err) {
    // The worker proxy is the usual failure point on static hosts. Retry on the main thread.
    console.warn('Worker path failed, retrying on main thread:', err);
    setProgress(80, 'Retrying without the worker');
    cut = await removeBackground(input, { ...config, proxyToWorker: false });
  }

  setProgress(98, 'Encoding');

  const cutURL = URL.createObjectURL(cut);
  const cutImg = await loadImage(cutURL);

  const mime = el.bgFormat.value;
  const wantsAlpha = state.bgBackdrop === 'transparent';
  const backdrop = wantsAlpha ? (NO_ALPHA.has(mime) ? '#FFFFFF' : null) : state.bgBackdrop;

  const canvas = rasterize(cutImg, cutImg.naturalWidth, cutImg.naturalHeight, backdrop);
  URL.revokeObjectURL(cutURL);

  const quality = LOSSY.has(mime) ? parseFloat(el.bgQuality.value) : undefined;
  const blob = await canvasToBlob(canvas, mime, quality);

  // Touch-up needs a live alpha channel to paint on.
  const editable = wantsAlpha && !NO_ALPHA.has(mime);
  return { blob, w: canvas.width, h: canvas.height, ext: EXT[mime], editCanvas: editable ? canvas : null };
}

/* ---------- Tool 2: format conversion / vectorizer ---------- */

const DETAIL = [
  // tol works at the 2× supersampled scale, so display-space smoothing is tol/2.
  { label: 'Smoothest', tol: 6.5, pathomit: 52, despeckle: 3 },
  { label: 'Smooth',    tol: 4,   pathomit: 32, despeckle: 2 },
  { label: 'Balanced',  tol: 2.5, pathomit: 20, despeckle: 2 },
  { label: 'Sharp',     tol: 1.2, pathomit: 10, despeckle: 1 },
  { label: 'Sharpest',  tol: 0.6, pathomit: 4,  despeckle: 1 },
];

async function runConvert() {
  const mime = el.cvFormat.value;
  const scale = parseInt(el.cvScale.value, 10) / 100;
  const w = Math.round(state.srcW * scale);
  const h = Math.round(state.srcH * scale);

  if (mime === 'image/svg+xml') return traceToSVG();

  setProgress(40, 'Rasterizing');
  const backdrop = NO_ALPHA.has(mime) ? state.cvBackdrop : null;
  const canvas = rasterize(state.srcImg, w, h, backdrop);

  setProgress(75, 'Encoding');

  if (mime === 'image/bmp') {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return { blob: encodeBMP(data), w: canvas.width, h: canvas.height, ext: 'bmp' };
  }

  if (mime === 'image/avif' && !(await canEncode('image/avif'))) {
    throw new Error("This browser can't write AVIF. Try Chrome or Edge, or pick WEBP instead.");
  }

  const quality = LOSSY.has(mime) ? parseFloat(el.cvQuality.value) : undefined;
  const blob = await canvasToBlob(canvas, mime, quality);
  return { blob, w: canvas.width, h: canvas.height, ext: EXT[mime] };
}

/** Vectorize: supersample → quantize to a faithful palette → despeckle the
    label map → flatten to exact flat colors → trace. The cleanup before
    tracing is what turns bumpy pixel-stairs into long smooth curves. */
async function traceToSVG() {
  const ImageTracer = await getTracer();
  const d = DETAIL[parseInt(el.tcDetail.value, 10)];
  const K = parseInt(el.tcColors.value, 10);

  // Work at 2× the source (capped) — the tracer smooths in supersampled
  // units, which halves the visible wobble at display size.
  const W = Math.min(2048, Math.max(state.srcW, state.srcH) * 2);
  const k = W / Math.max(state.srcW, state.srcH);
  const w = Math.round(state.srcW * k), h = Math.round(state.srcH * k);

  setProgress(25, 'Building a faithful palette');
  await nextFrame();
  const keep = el.tcKeepTransparent.checked;
  const canvas = rasterize(state.srcImg, w, h, keep ? null : '#FFFFFF');
  const raw = canvas.getContext('2d').getImageData(0, 0, w, h);

  const palette = ScribbleCore.quantize(raw.data, w, h, K);
  const { labels } = ScribbleCore.labelize(raw.data, w, h, palette);

  setProgress(45, 'Cleaning regions');
  await nextFrame();
  const clean = ScribbleCore.modeFilter(labels, w, h, d.despeckle);

  const flat = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const L = clean[i];
    if (L < 0) {
      flat[p + 3] = 0;
    } else {
      flat[p] = palette[L][0];
      flat[p + 1] = palette[L][1];
      flat[p + 2] = palette[L][2];
      flat[p + 3] = 255;
    }
  }

  setProgress(65, 'Tracing curves — this is the slow part');
  await nextFrame();

  const svg = ImageTracer.imagedataToSVG({ width: w, height: h, data: flat }, {
    numberofcolors: K + 2,
    colorsampling: 2,          // deterministic palette
    colorquantcycles: 3,
    ltres: d.tol,
    qtres: d.tol,
    pathomit: d.pathomit,
    blurradius: 0,             // we already cleaned upstream
    rightangleenhance: false,  // pins corners; fights the smoothing
    linefilter: true,
    roundcoords: 2,
    strokewidth: 0,
    viewbox: true,
    desc: false,
    scale: 1,
  });

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  return { blob, w, h, ext: 'svg' };
}

/* ---------- Tool 3: colorizer ---------- */

async function runColorize() {
  setProgress(25, 'Mixing paint');
  await nextFrame();

  const cap = 4096;
  const k = Math.min(1, cap / Math.max(state.srcW, state.srcH));
  const w = Math.round(state.srcW * k), h = Math.round(state.srcH * k);
  const canvas = rasterize(state.srcImg, w, h, null);
  const ctx = canvas.getContext('2d');
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;

  const target = hexToRgb(el.czColor.value);
  const [th, ts] = rgbToHsl(...target);
  const strength = parseInt(el.czStrength.value, 10) / 100;
  const paint = state.czMode === 'paint';
  const replace = el.czReplace.checked;
  const from = hexToRgb(el.czFrom.value);
  // likeness 0..100 → how far from the picked color still counts
  const tol = 0.05 + (parseInt(el.czLikeness.value, 10) / 100) * 0.6;

  // Tiny LUT for the tint path: 256 luminance levels → RGB at target hue/sat.
  const lut = new Uint8ClampedArray(256 * 3);
  for (let l = 0; l < 256; l++) {
    const [r, g, b] = hslToRgb(th, ts, l / 255);
    lut[l * 3] = r; lut[l * 3 + 1] = g; lut[l * 3 + 2] = b;
  }

  const total = d.length;
  const CHUNK = 4_000_000;
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(total, start + CHUNK);
    for (let i = start; i < end; i += 4) {
      if (d[i + 3] === 0) continue;
      let wgt = 1;
      if (replace) {
        const dr = (d[i] - from[0]) / 255;
        const dg = (d[i + 1] - from[1]) / 255;
        const db = (d[i + 2] - from[2]) / 255;
        const dist = Math.sqrt(dr * dr * 2 + dg * dg * 3 + db * db) / 2.449;
        if (dist >= tol) continue;
        wgt = dist <= tol * 0.65 ? 1 : 1 - (dist - tol * 0.65) / (tol * 0.35);
      }
      const f = strength * wgt;
      let nr, ng, nb;
      if (paint) {
        nr = target[0]; ng = target[1]; nb = target[2];
      } else {
        // pinetools-style: keep the pixel's lightness, replace hue + sat
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const l = (mx + mn) >> 1;
        nr = lut[l * 3]; ng = lut[l * 3 + 1]; nb = lut[l * 3 + 2];
      }
      d[i] += (nr - d[i]) * f;
      d[i + 1] += (ng - d[i + 1]) * f;
      d[i + 2] += (nb - d[i + 2]) * f;
    }
    setProgress(25 + (end / total) * 55, 'Colorizing');
    await nextFrame();
  }

  ctx.putImageData(id, 0, 0);
  setProgress(88, 'Encoding');
  const blob = await canvasToBlob(canvas, 'image/png');
  return { blob, w, h, ext: 'png' };
}

/* ---------- Tool 4: scribble ---------- */

let animToken = 0;

/** Finish any in-flight timelapse instantly (tab switch, new image, etc). */
function cancelScribbleAnim() { animToken++; }

async function runScribble() {
  let compute = 0;
  let t = performance.now();

  const detail = parseInt(el.scDetail.value, 10);

  // Analysis size follows detail — a finer grid resolves smaller features.
  const A = 150 + detail * 18;
  const ka = Math.min(1, A / Math.max(state.srcW, state.srcH));
  const aw = Math.max(2, Math.round(state.srcW * ka));
  const ah = Math.max(2, Math.round(state.srcH * ka));
  const ac = rasterize(state.srcImg, aw, ah, null);
  const data = ac.getContext('2d').getImageData(0, 0, aw, ah).data;

  // Output size: source size, but bounded so strokes stay chunky and fast.
  const srcMax = Math.max(state.srcW, state.srcH);
  const O = clamp(srcMax, 640, 1600);
  const ko = O / srcMax;
  const ow = Math.max(2, Math.round(state.srcW * ko));
  const oh = Math.max(2, Math.round(state.srcH * ko));

  setProgress(20, 'Choosing crayons');
  await new Promise((r) => setTimeout(r, 20)); // let the bar paint

  const { strokes } = ScribbleCore.plan(data, aw, ah, ow, oh, {
    colors: parseInt(el.scColors.value, 10),
    weight: parseInt(el.scWeight.value, 10),
    detail,
  });
  if (!strokes.length) throw new Error('Nothing to scribble — the image looks fully transparent.');

  const master = document.createElement('canvas');
  master.width = ow; master.height = oh;
  const mctx = master.getContext('2d');

  compute += performance.now() - t;

  if (!el.scTimelapse.checked) {
    // Straight to the result, chunked so the progress bar moves.
    t = performance.now();
    for (let i = 0; i < strokes.length; i++) {
      ScribbleCore.drawStroke(mctx, strokes[i]);
      if (i % 400 === 399) {
        setProgress(30 + (i / strokes.length) * 60, `Scribbling · ${i + 1} of ${strokes.length} strokes`);
        await nextFrame();
      }
    }
    setProgress(95, 'Encoding');
    const blob = await canvasToBlob(master, 'image/png');
    compute += performance.now() - t;
    return { blob, w: ow, h: oh, ext: 'png', msOverride: Math.round(compute) };
  }

  /* ----- timelapse: animate in the viewer and record a video ----- */
  const targets = [mctx];

  for (const cv of [el.liveSplit, el.liveSbs]) {
    cv.width = ow; cv.height = oh;
    cv.getContext('2d').clearRect(0, 0, ow, oh);
    cv.hidden = false;
  }
  targets.push(el.liveSplit.getContext('2d'), el.liveSbs.getContext('2d'));
  el.imgAfterSplit.style.visibility = 'hidden';
  el.imgAfterSbs.style.visibility = 'hidden';
  markBlank(false);

  // Video has no alpha, so the recording gets a plain white sheet of paper.
  let recorder = null, recChunks = [], recExt = 'webm';
  const mimes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const recMime = typeof MediaRecorder !== 'undefined'
    ? mimes.find((m) => MediaRecorder.isTypeSupported(m)) : null;
  if (recMime) {
    const rc = document.createElement('canvas');
    rc.width = ow; rc.height = oh;
    const rctx = rc.getContext('2d');
    rctx.fillStyle = '#FFFFFF';
    rctx.fillRect(0, 0, ow, oh);
    targets.push(rctx);
    recExt = recMime.includes('mp4') ? 'mp4' : 'webm';
    recorder = new MediaRecorder(rc.captureStream(60), {
      mimeType: recMime, videoBitsPerSecond: 8_000_000,
    });
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.start(200);
  }

  const myToken = ++animToken;
  const secs = clamp(strokes.length / 110, 3.5, 8);

  try {
    await new Promise((resolve) => {
      const t0 = performance.now();
      let drawn = 0;
      const frame = () => {
        const cancelled = animToken !== myToken;
        const upto = cancelled
          ? strokes.length
          : Math.min(strokes.length, Math.floor(((performance.now() - t0) / 1000 / secs) * strokes.length));
        for (; drawn < upto; drawn++) {
          for (const ctx of targets) ScribbleCore.drawStroke(ctx, strokes[drawn]);
        }
        setProgress(25 + (drawn / strokes.length) * 70, `Scribbling · ${drawn} of ${strokes.length} strokes`);
        if (drawn >= strokes.length) {
          // Hold the finished frame briefly so the recording doesn't cut hard.
          setTimeout(resolve, cancelled ? 0 : 400);
        } else {
          requestAnimationFrame(frame);
        }
      };
      frame();
    });
  } finally {
    el.liveSplit.hidden = true;
    el.liveSbs.hidden = true;
    el.imgAfterSplit.style.visibility = '';
    el.imgAfterSbs.style.visibility = '';
  }

  let timelapse = null;
  if (recorder) {
    await new Promise((res) => { recorder.onstop = res; recorder.stop(); });
    if (recChunks.length) {
      timelapse = { blob: new Blob(recChunks, { type: recorder.mimeType }), ext: recExt };
    }
  }

  t = performance.now();
  setProgress(97, 'Encoding');
  const blob = await canvasToBlob(master, 'image/png');
  compute += performance.now() - t;

  return { blob, w: ow, h: oh, ext: 'png', timelapse, msOverride: Math.round(compute) };
}

/* ============================================================
   Run / download
   ============================================================ */

function showResult(tab) {
  const r = state.results[tab];
  if (r) {
    el.imgAfterSplit.src = r.url;
    el.imgAfterSbs.src = r.url;
    markBlank(false);
    el.roResult.textContent = `${r.w}×${r.h} · ${fmtBytes(r.blob.size)} · ${r.ext.toUpperCase()}`;
    el.roTime.textContent = r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(2)} s`;
    el.downloadBtn.disabled = false;
    el.timelapseBtn.hidden = !r.timelapse;
  } else {
    markBlank(true);
    el.roResult.textContent = '—';
    el.roTime.textContent = '—';
    el.downloadBtn.disabled = true;
    el.timelapseBtn.hidden = true;
  }
  el.tuField.hidden = !(tab === 'bg' && r?.editCanvas);
}

async function run() {
  if (state.busy || !state.file) return;
  const tab = state.tab;
  state.busy = true;
  clearError();
  setTool(null);
  el.runBtn.disabled = true;
  el.downloadBtn.disabled = true;
  el.timelapseBtn.hidden = true;
  setProgress(3, 'Starting');

  const t0 = performance.now();
  try {
    let out;
    if (tab === 'bg') out = await runBackgroundRemoval();
    else if (tab === 'convert') out = await runConvert();
    else if (tab === 'colorize') out = await runColorize();
    else out = await runScribble();

    const ms = out.msOverride ?? Math.round(performance.now() - t0);

    // Install the new result FIRST, then retire the old one. Revoking the
    // previous blob URL before the swap could abort the fresh render, which
    // left the stale conversion on screen.
    const prev = state.results[tab];
    const url = URL.createObjectURL(out.blob);
    const timelapse = out.timelapse
      ? { ...out.timelapse, url: URL.createObjectURL(out.timelapse.blob) }
      : null;
    state.results[tab] = {
      blob: out.blob, w: out.w, h: out.h, ext: out.ext, url, ms, timelapse,
      editCanvas: out.editCanvas || null,
    };
    if (tab === 'bg') state.edit = null;   // new cutout = fresh touch-up session

    if (prev) {
      setTimeout(() => {
        if (prev.url) URL.revokeObjectURL(prev.url);
        if (prev.timelapse?.url) URL.revokeObjectURL(prev.timelapse.url);
      }, 1500);
    }

    if (state.tab === tab) showResult(tab);

    setProgress(100, 'Done');
    setTimeout(hideProgress, 700);
  } catch (err) {
    console.error(err);
    hideProgress();
    showError(err?.message || 'Something went wrong. Check the console for details.');
  } finally {
    state.busy = false;
    el.runBtn.disabled = false;
  }
}

async function download() {
  if (state.edit?.dirty) await finalizeEdit();
  const r = state.results[state.tab];
  if (!r) return;
  const a = document.createElement('a');
  a.href = r.url;
  a.download = `${baseName(state.file.name)}${DL_SUFFIX[state.tab]}.${r.ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadTimelapse() {
  const tl = state.results[state.tab]?.timelapse;
  if (!tl) return;
  const a = document.createElement('a');
  a.href = tl.url;
  a.download = `${baseName(state.file.name)}-scribble-timelapse.${tl.ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ============================================================
   UI wiring
   ============================================================ */

/* --- dropzone --- */
el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
el.newImageBtn.addEventListener('click', () => el.fileInput.click());

['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (el.dropzone.hidden) return;
    el.dropzone.classList.add('is-over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    el.dropzone.classList.remove('is-over');
  })
);
document.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

/* --- tabs --- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    cancelScribbleAnim();
    setTool(null);
    state.tab = btn.dataset.tab;
    for (const [tab, key] of Object.entries(PANELS)) {
      el[key].hidden = state.tab !== tab;
    }
    el.runBtn.textContent = RUN_LABEL[state.tab];
    clearError();
    hideProgress();
    showResult(state.tab);   // each tab keeps its own result
  });
});

/* --- comparison view --- */
document.querySelectorAll('.seg__btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg__btn[data-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
    const split = btn.dataset.view === 'split';
    el.stageSplit.hidden = !split;
    el.stageSbs.hidden = split;
  });
});

el.checkerToggle.addEventListener('change', () => {
  const on = el.checkerToggle.checked ? 'on' : 'off';
  el.stageSplit.dataset.checker = on;
  el.stageSbs.dataset.checker = on;
});

/* --- swatches --- */
function wireSwatches(container, onPick) {
  container.querySelectorAll('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      container.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('is-active', s === sw));
      const val = sw.dataset.backdrop;
      const picker = sw.querySelector('input[type="color"]');
      onPick(val === 'custom' ? picker.value : val);
    });
    const picker = sw.querySelector('input[type="color"]');
    if (picker) {
      picker.addEventListener('input', () => {
        container.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('is-active', s === sw));
        sw.style.setProperty('--sw', picker.value);
        onPick(picker.value);
      });
    }
  });
}
wireSwatches($('backdrops'), (v) => { state.bgBackdrop = v; });
wireSwatches($('cvBackdrops'), (v) => { state.cvBackdrop = v; });

/* --- background panel --- */
el.bgFormat.addEventListener('change', () => {
  el.bgQualityField.hidden = !LOSSY.has(el.bgFormat.value);
});
el.bgQuality.addEventListener('input', () => {
  el.bgQualityVal.textContent = parseFloat(el.bgQuality.value).toFixed(2);
});

/* --- convert panel --- */
const HINTS = {
  'image/png':     'Lossless with full alpha. The safe default.',
  'image/jpeg':    'Lossy, and no alpha channel. Best for photographs.',
  'image/webp':    'Smaller than PNG at similar quality, and it keeps alpha.',
  'image/avif':    'Smallest files, keeps alpha. Chrome and Edge can write it; Safari and Firefox cannot.',
  'image/bmp':     'Uncompressed 24-bit. Large files, no alpha. Only for tools that demand it.',
  'image/svg+xml': 'Rebuilds the image as clean vector shapes — flat colors, smooth curves. Made for logos and flat art, not photographs.',
};

function updateConvertUI() {
  const mime = el.cvFormat.value;
  el.cvFormatHint.textContent = HINTS[mime] || '';
  el.cvQualityField.hidden = !LOSSY.has(mime);
  el.cvFlattenField.hidden = !NO_ALPHA.has(mime);
  el.traceOpts.hidden = mime !== 'image/svg+xml';
  updateOutDims();
}
function updateOutDims() {
  if (!state.srcW) return;
  const scale = parseInt(el.cvScale.value, 10) / 100;
  el.cvOutDims.textContent = `${Math.round(state.srcW * scale)} × ${Math.round(state.srcH * scale)} px`;
}
el.cvFormat.addEventListener('change', updateConvertUI);
el.cvQuality.addEventListener('input', () => {
  el.cvQualityVal.textContent = parseFloat(el.cvQuality.value).toFixed(2);
});
el.cvScale.addEventListener('input', () => {
  el.cvScaleVal.textContent = el.cvScale.value + '%';
  updateOutDims();
});
el.tcColors.addEventListener('input', () => { el.tcColorsVal.textContent = el.tcColors.value; });
el.tcDetail.addEventListener('input', () => {
  el.tcDetailVal.textContent = DETAIL[parseInt(el.tcDetail.value, 10)].label;
});

/* --- colorize panel --- */
document.querySelectorAll('[data-czmode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-czmode]').forEach((b) => b.classList.toggle('is-active', b === btn));
    state.czMode = btn.dataset.czmode;
  });
});
el.czStrength.addEventListener('input', () => {
  el.czStrengthVal.textContent = el.czStrength.value + '%';
});
el.czLikeness.addEventListener('input', () => {
  el.czLikenessVal.textContent = el.czLikeness.value + '%';
});
el.czReplace.addEventListener('change', () => {
  el.czReplaceOpts.hidden = !el.czReplace.checked;
  if (!el.czReplace.checked && state.pickMode) {
    state.pickMode = false;
    el.czPick.classList.remove('is-on');
    document.body.classList.remove('is-picking');
  }
});

/* --- scribble panel --- */
const WEIGHT_LABELS = [
  'Ballpoint', 'Fine pen', 'Pencil', 'Fine marker', 'Marker',
  'Chunky marker', 'Crayon', 'Chunky crayon', 'Fat crayon', 'Fistful of crayon',
];
const DETAIL_LABELS = [
  'Barely there', 'Sparse', 'Loose', 'Sketchy', 'Casual',
  'Solid', 'Attentive', 'Thorough', 'Obsessive', 'Every last bit',
];
function updateWeightLabel() {
  el.scWeightVal.textContent = WEIGHT_LABELS[parseInt(el.scWeight.value, 10) - 1];
}
function updateDetailLabel() {
  el.scDetailVal.textContent = DETAIL_LABELS[parseInt(el.scDetail.value, 10) - 1];
}
el.scWeight.addEventListener('input', updateWeightLabel);
el.scDetail.addEventListener('input', updateDetailLabel);
el.scColors.addEventListener('input', () => { el.scColorsVal.textContent = el.scColors.value; });

/* --- actions --- */
el.runBtn.addEventListener('click', run);
el.downloadBtn.addEventListener('click', download);
el.timelapseBtn.addEventListener('click', downloadTimelapse);

/* --- boot --- */
(async function boot() {
  updateConvertUI();
  updateWeightLabel();
  updateDetailLabel();
  applySplit();
  applyZoom();
  let avif = false;
  try { avif = await canEncode('image/avif'); } catch { avif = false; }
  if (!avif) {
    const opt = el.cvFormat.querySelector('option[value="image/avif"]');
    opt.textContent = 'AVIF — this browser cannot write it';
    opt.disabled = true;
  }
  // Decoding AVIF is far more widespread than encoding it, so list it either way.
  el.acceptedFormats.textContent += ' · AVIF';
})();