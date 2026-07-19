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
  panelBg: $('panel-bg'), panelConvert: $('panel-convert'), panelScribble: $('panel-scribble'),
  bgModel: $('bgModel'), bgDevice: $('bgDevice'), bgFormat: $('bgFormat'),
  bgQuality: $('bgQuality'), bgQualityField: $('bgQualityField'), bgQualityVal: $('bgQualityVal'),
  bgCustomColor: $('bgCustomColor'),
  cvFormat: $('cvFormat'), cvFormatHint: $('cvFormatHint'),
  cvQuality: $('cvQuality'), cvQualityField: $('cvQualityField'), cvQualityVal: $('cvQualityVal'),
  cvScale: $('cvScale'), cvScaleVal: $('cvScaleVal'), cvOutDims: $('cvOutDims'),
  cvFlattenField: $('cvFlattenField'), cvCustomColor: $('cvCustomColor'),
  traceOpts: $('traceOpts'),
  tcColors: $('tcColors'), tcColorsVal: $('tcColorsVal'),
  tcDetail: $('tcDetail'), tcDetailVal: $('tcDetailVal'),
  tcKeepTransparent: $('tcKeepTransparent'),
  scWeight: $('scWeight'), scWeightVal: $('scWeightVal'),
  scColors: $('scColors'), scColorsVal: $('scColorsVal'),
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
  bgBackdrop: 'transparent',
  cvBackdrop: '#FFFFFF',
  results: { bg: null, convert: null, scribble: null },  // { blob, url, w, h, ms, ext, timelapse? }
  busy: false,
  splitF: 0.5,                    // split position, fraction of the content plane
  zoom: { z: 1, fx: 0, fy: 0 },   // scale + pan (fractions of the plane)
};

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};
const LOSSY = new Set(['image/jpeg', 'image/webp', 'image/avif']);
const NO_ALPHA = new Set(['image/jpeg', 'image/bmp']);
const RUN_LABEL = { bg: 'Remove background', convert: 'Convert', scribble: 'Scribble it' };
const DL_SUFFIX = { bg: '-cutout', convert: '', scribble: '-scribble' };

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
  const pannable = z > 1.001;
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

/* --- pointer interactions: drag the split line, or pan when zoomed --- */
let drag = null;

function setSplitFromClient(clientX, rect) {
  const xf = (clientX - rect.left) / rect.width;
  state.splitF = clamp((xf - state.zoom.fx) / state.zoom.z, 0, 1);
  applySplit();
}

el.stageSplit.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const rect = el.stageSplit.getBoundingClientRect();
  const xf = (e.clientX - rect.left) / rect.width;
  const handleS = state.zoom.fx + state.splitF * state.zoom.z;
  const blank = el.stageSplit.classList.contains('is-blank');
  const nearHandle = Math.abs(xf - handleS) * rect.width < 24;

  let mode = null;
  if (!blank && (nearHandle || state.zoom.z <= 1.001)) mode = 'split';
  else if (state.zoom.z > 1.001) mode = 'pan';
  if (!mode) return;

  e.preventDefault();
  drag = {
    mode, sx: e.clientX, sy: e.clientY,
    fx: state.zoom.fx, fy: state.zoom.fy,
    unitW: rect.width, unitH: rect.height, rect,
    stage: el.stageSplit,
  };
  el.stageSplit.setPointerCapture(e.pointerId);
  if (mode === 'split') setSplitFromClient(e.clientX, rect);
  else el.stageSplit.classList.add('is-panning');
});

el.stageSbs.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.zoom.z <= 1.001) return;
  e.preventDefault();
  const pane = el.stageSbs.querySelector('.pane').getBoundingClientRect();
  drag = {
    mode: 'pan', sx: e.clientX, sy: e.clientY,
    fx: state.zoom.fx, fy: state.zoom.fy,
    unitW: pane.width, unitH: pane.height,
    stage: el.stageSbs,
  };
  el.stageSbs.setPointerCapture(e.pointerId);
  el.stageSbs.classList.add('is-panning');
});

function onDragMove(e) {
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
function onDragEnd() {
  if (!drag) return;
  drag.stage.classList.remove('is-panning');
  drag = null;
}
for (const stage of [el.stageSplit, el.stageSbs]) {
  stage.addEventListener('pointermove', onDragMove);
  stage.addEventListener('pointerup', onDragEnd);
  stage.addEventListener('pointercancel', onDragEnd);
}

el.handle.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  state.splitF = clamp(state.splitF + (e.key === 'ArrowRight' ? 0.02 : -0.02), 0, 1);
  applySplit();
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

  return { blob, w: canvas.width, h: canvas.height, ext: EXT[mime] };
}

/* ---------- Tool 2: format conversion ---------- */

const DETAIL = [
  // Smooth presets lean hard on blur + high tolerance so jagged pixel
  // edges melt into long curves; right-angle enhancement is off for them
  // because it fights the smoothing by pinning corners back in place.
  { label: 'Smoothest', ltres: 10,  qtres: 10,  pathomit: 60, blurradius: 5, blurdelta: 64, rae: false },
  { label: 'Smooth',    ltres: 4,   qtres: 4,   pathomit: 28, blurradius: 3, blurdelta: 48, rae: false },
  { label: 'Balanced',  ltres: 1.5, qtres: 1.5, pathomit: 10, blurradius: 1, blurdelta: 24, rae: true },
  { label: 'Sharp',     ltres: 0.5, qtres: 0.5, pathomit: 4,  blurradius: 0, blurdelta: 20, rae: true },
  { label: 'Sharpest',  ltres: 0.1, qtres: 0.1, pathomit: 1,  blurradius: 0, blurdelta: 20, rae: true },
];

async function runConvert() {
  const mime = el.cvFormat.value;
  const scale = parseInt(el.cvScale.value, 10) / 100;
  const w = Math.round(state.srcW * scale);
  const h = Math.round(state.srcH * scale);

  if (mime === 'image/svg+xml') return traceToSVG(w, h);

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

async function traceToSVG(w, h) {
  const ImageTracer = await getTracer();

  // Tracing cost scales hard with pixel count. Cap the input.
  const MAX = 1600;
  let tw = w, th = h;
  if (Math.max(tw, th) > MAX) {
    const k = MAX / Math.max(tw, th);
    tw = Math.round(tw * k); th = Math.round(th * k);
  }

  setProgress(35, 'Rasterizing for trace');
  const backdrop = el.tcKeepTransparent.checked ? null : '#FFFFFF';
  const canvas = rasterize(state.srcImg, tw, th, backdrop);
  const data = canvas.getContext('2d').getImageData(0, 0, tw, th);

  setProgress(55, 'Tracing paths — this can take a moment');
  await new Promise((r) => setTimeout(r, 30)); // let the progress bar paint

  const d = DETAIL[parseInt(el.tcDetail.value, 10)];
  const svg = ImageTracer.imagedataToSVG(data, {
    numberofcolors: parseInt(el.tcColors.value, 10),
    colorsampling: 2,          // deterministic palette
    colorquantcycles: 5,
    ltres: d.ltres,
    qtres: d.qtres,
    pathomit: d.pathomit,
    blurradius: d.blurradius,
    blurdelta: d.blurdelta,
    rightangleenhance: d.rae,
    linefilter: true,
    roundcoords: 2,
    strokewidth: 0,
    viewbox: true,
    desc: false,
    scale: 1,
  });

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  return { blob, w: tw, h: th, ext: 'svg' };
}

/* ---------- Tool 3: scribble ---------- */

let animToken = 0;

/** Finish any in-flight timelapse instantly (tab switch, new image, etc). */
function cancelScribbleAnim() { animToken++; }

async function runScribble() {
  let compute = 0;
  let t = performance.now();

  // Analyze at a small size — the walker only needs region shapes.
  const A = 220;
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
        await new Promise((r) => requestAnimationFrame(r));
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
}

async function run() {
  if (state.busy || !state.file) return;
  const tab = state.tab;
  state.busy = true;
  clearError();
  el.runBtn.disabled = true;
  el.downloadBtn.disabled = true;
  el.timelapseBtn.hidden = true;
  setProgress(3, 'Starting');

  const t0 = performance.now();
  try {
    let out;
    if (tab === 'bg') out = await runBackgroundRemoval();
    else if (tab === 'convert') out = await runConvert();
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
    state.results[tab] = { blob: out.blob, w: out.w, h: out.h, ext: out.ext, url, ms, timelapse };

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

function download() {
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
    state.tab = btn.dataset.tab;
    el.panelBg.hidden = state.tab !== 'bg';
    el.panelConvert.hidden = state.tab !== 'convert';
    el.panelScribble.hidden = state.tab !== 'scribble';
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
  'image/svg+xml': 'Traces the image into real vector paths. Built for flat art, not photographs.',
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

/* --- scribble panel --- */
const WEIGHT_LABELS = [
  'Ballpoint', 'Fine pen', 'Pencil', 'Fine marker', 'Marker',
  'Chunky marker', 'Crayon', 'Chunky crayon', 'Fat crayon', 'Fistful of crayon',
];
function updateWeightLabel() {
  el.scWeightVal.textContent = WEIGHT_LABELS[parseInt(el.scWeight.value, 10) - 1];
}
el.scWeight.addEventListener('input', updateWeightLabel);
el.scColors.addEventListener('input', () => { el.scColorsVal.textContent = el.scColors.value; });

/* --- actions --- */
el.runBtn.addEventListener('click', run);
el.downloadBtn.addEventListener('click', download);
el.timelapseBtn.addEventListener('click', downloadTimelapse);

/* --- boot --- */
(async function boot() {
  updateConvertUI();
  updateWeightLabel();
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