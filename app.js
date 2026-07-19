/* ============================================================
   Image Bench — app logic
   Everything runs client-side. Only model weights are fetched.
   ============================================================ */

const BG_LIB     = 'https://esm.sh/@imgly/background-removal@1.7.0';
const TRACE_LIB  = 'https://esm.sh/imagetracerjs@1.2.6';
const GIFENC_LIB = 'https://esm.sh/gifenc@1.0.3';

/* ---------- element lookup ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('fileInput'), workspace: $('workspace'),
  newImageBtn: $('newImageBtn'), acceptedFormats: $('acceptedFormats'),
  stageSplit: $('stageSplit'), stageSbs: $('stageSbs'),
  splitView: $('splitView'), paneViews: document.querySelectorAll('#stageSbs .pane__view'),
  handle: $('handle'),
  imgBeforeSplit: $('imgBeforeSplit'), imgAfterSplit: $('imgAfterSplit'),
  imgBeforeSbs: $('imgBeforeSbs'), imgAfterSbs: $('imgAfterSbs'),
  liveSbs: $('liveSbs'), liveSplit: $('liveSplit'),
  zoomOut: $('zoomOut'), zoomIn: $('zoomIn'), zoomReset: $('zoomReset'),
  checkerToggle: $('checkerToggle'),
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
  errorBox: $('errorBox'), runBtn: $('runBtn'), downloadBtn: $('downloadBtn'),
  timelapseWebmBtn: $('timelapseWebmBtn'), timelapseGifBtn: $('timelapseGifBtn'),
};

/* ---------- state ---------- */
const state = {
  tab: 'bg',
  activeView: 'sbs',
  file: null,
  srcImg: null,
  srcW: 0, srcH: 0,
  srcURL: null,
  bgBackdrop: 'transparent',
  cvBackdrop: '#FFFFFF',
  results: { bg: null, convert: null, scribble: null }, // { blob, url, w, h, ms, ext, video?, gif? }
  busy: false,
};

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};
const LOSSY = new Set(['image/jpeg', 'image/webp', 'image/avif']);
const NO_ALPHA = new Set(['image/jpeg', 'image/bmp']);

const TAB_LABELS = { bg: 'Remove background', convert: 'Convert', scribble: 'Scribble it' };

/* ============================================================
   Utilities
   ============================================================ */

const fmtBytes = (b) => {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
};

const baseName = (name) => name.replace(/\.[^.]+$/, '');
const tick = () => new Promise((r) => setTimeout(r, 0));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Scale w/h down (never up) so the longer side is at most `max`. */
function capDims(w, h, max) {
  if (Math.max(w, h) <= max) return { w, h };
  const k = max / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

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
  syncTimelapseButtons();
  resetZoom();
  updateOutDims();
  hideProgress();
}

function markBlank(blank) {
  el.stageSplit.classList.toggle('is-blank', blank);
  el.imgAfterSbs.style.visibility = blank ? 'hidden' : 'visible';
}

function releaseResults() {
  for (const k of Object.keys(state.results)) {
    const r = state.results[k];
    if (r?.url) URL.revokeObjectURL(r.url);
    if (r?.video?.url) URL.revokeObjectURL(r.video.url);
    if (r?.gif?.url) URL.revokeObjectURL(r.gif.url);
    state.results[k] = null;
  }
}

function syncTimelapseButtons() {
  const r = state.tab === 'scribble' ? state.results.scribble : null;
  el.timelapseWebmBtn.hidden = !r?.video;
  el.timelapseGifBtn.hidden = !r?.gif;
}

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

let gifenc = null;
async function getGifenc() {
  if (!gifenc) gifenc = await import(/* @vite-ignore */ GIFENC_LIB);
  return gifenc;
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
  { label: 'Smoothest', ltres: 3.5,  qtres: 3.5,  pathomit: 20, blurradius: 3, rightangle: false, preBlur: 1.6 },
  { label: 'Smooth',    ltres: 1.8,  qtres: 1.8,  pathomit: 10, blurradius: 2, rightangle: false, preBlur: 0.8 },
  { label: 'Balanced',  ltres: 1,    qtres: 1,    pathomit: 6,  blurradius: 1, rightangle: false, preBlur: 0.3 },
  { label: 'Sharp',     ltres: 0.4,  qtres: 0.4,  pathomit: 3,  blurradius: 0, rightangle: true,  preBlur: 0   },
  { label: 'Sharpest',  ltres: 0.05, qtres: 0.05, pathomit: 1,  blurradius: 0, rightangle: true,  preBlur: 0   },
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
  const { w: tw, h: th } = capDims(w, h, 1600);

  setProgress(35, 'Rasterizing for trace');
  const backdrop = el.tcKeepTransparent.checked ? null : '#FFFFFF';
  let canvas = rasterize(state.srcImg, tw, th, backdrop);

  const d = DETAIL[parseInt(el.tcDetail.value, 10)];

  // A light pre-blur ahead of the tracer's own smoothing keeps curved edges
  // from reading as jagged staircases — the tracer alone tends to hug noise.
  if (d.preBlur > 0) {
    const blurred = document.createElement('canvas');
    blurred.width = tw; blurred.height = th;
    const bctx = blurred.getContext('2d');
    if ('filter' in bctx) {
      bctx.filter = `blur(${d.preBlur}px)`;
      bctx.drawImage(canvas, 0, 0);
      canvas = blurred;
    }
  }

  const data = canvas.getContext('2d').getImageData(0, 0, tw, th);

  setProgress(55, 'Tracing paths — this can take a moment');
  await tick();

  const svg = ImageTracer.imagedataToSVG(data, {
    numberofcolors: parseInt(el.tcColors.value, 10),
    colorsampling: 2,          // deterministic palette
    colorquantcycles: 6,
    ltres: d.ltres,
    qtres: d.qtres,
    pathomit: d.pathomit,
    blurradius: d.blurradius,
    blurdelta: 24,
    rightangleenhance: d.rightangle,   // only useful for crisp logo corners
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

const SCRIBBLE_ANALYSIS_MAX = 560;  // stroke planning grid — kept small on purpose, for speed
const SCRIBBLE_OUTPUT_MAX   = 2000; // final PNG canvas cap
const SCRIBBLE_GIF_MAX      = 420;  // GIF frames are much smaller than the PNG
const SC_WEIGHT_WORDS = [
  'Ballpoint', 'Ballpoint', 'Fine liner', 'Felt tip', 'Felt tip',
  'Marker', 'Marker', 'Bold marker', 'Fat crayon', 'Crayon in a fist',
];

function scribbleControlsEnabled() {
  return !!(document.createElement('canvas').captureStream && window.MediaRecorder);
}

async function runScribble() {
  if (typeof ScribbleCore === 'undefined' || !ScribbleCore.plan) {
    throw new Error('The scribble engine failed to load. Reload the page and try again.');
  }

  const weight = parseInt(el.scWeight.value, 10);
  const colors = parseInt(el.scColors.value, 10);
  const wantsTimelapse = el.scTimelapse.checked && !el.scTimelapse.disabled;

  setProgress(6, 'Reading the image');
  const a = capDims(state.srcW, state.srcH, SCRIBBLE_ANALYSIS_MAX);
  const aCanvas = rasterize(state.srcImg, a.w, a.h, null);
  const aData = aCanvas.getContext('2d').getImageData(0, 0, a.w, a.h);

  const o = capDims(state.srcW, state.srcH, SCRIBBLE_OUTPUT_MAX);

  setProgress(16, 'Planning strokes');
  await tick();
  const { strokes } = ScribbleCore.plan(aData.data, a.w, a.h, o.w, o.h, { colors, weight });
  if (!strokes.length) {
    throw new Error("Couldn't find enough shape in this image to scribble — try a different image or fewer colors.");
  }

  const workCanvas = document.createElement('canvas');
  workCanvas.width = o.w; workCanvas.height = o.h;
  const wctx = workCanvas.getContext('2d');

  let recording = null;
  let gifBlob = null;

  if (wantsTimelapse) {
    setProgress(28, 'Setting up the timelapse');
    showLiveCanvases(o.w, o.h);

    try {
      recording = startRecording(workCanvas);
    } catch (err) {
      console.warn('Timelapse recording unavailable:', err);
      recording = null;
    }

    const gifDims = capDims(o.w, o.h, SCRIBBLE_GIF_MAX);
    const gifScale = gifDims.w / o.w;
    const gifCanvas = document.createElement('canvas');
    gifCanvas.width = gifDims.w; gifCanvas.height = gifDims.h;
    const gctx = gifCanvas.getContext('2d');
    const gifFrames = [];
    const gifEvery = Math.max(1, Math.round(strokes.length / 90));

    await drawProgressively(strokes, wctx, gctx, gifScale, gifEvery, gifFrames, (frac) => {
      setProgress(30 + frac * 50, 'Scribbling');
    });

    if (recording) {
      setProgress(84, 'Finishing the recording');
      try { recording.blob = await recording.stop(); }
      catch (err) { console.warn('Recording failed:', err); recording = null; }
    }

    if (gifFrames.length) {
      setProgress(88, 'Building the GIF');
      await tick();
      try {
        gifBlob = await buildGIF(gifFrames, gifDims.w, gifDims.h);
      } catch (err) {
        console.warn('GIF build failed:', err);
        gifBlob = null;
      }
    }

    hideLiveCanvases();
  } else {
    await drawAllChunked(strokes, wctx, (frac) => setProgress(20 + frac * 65, 'Scribbling'));
  }

  setProgress(97, 'Encoding PNG');
  const blob = await canvasToBlob(workCanvas, 'image/png');

  return {
    blob, w: o.w, h: o.h, ext: 'png',
    video: recording?.blob ? { blob: recording.blob, url: URL.createObjectURL(recording.blob) } : null,
    gif: gifBlob ? { blob: gifBlob, url: URL.createObjectURL(gifBlob) } : null,
  };
}

function showLiveCanvases(w, h) {
  for (const c of [el.liveSbs, el.liveSplit]) {
    c.width = w; c.height = h;
    c.getContext('2d').clearRect(0, 0, w, h);
    c.hidden = false;
  }
  el.imgAfterSbs.style.visibility = 'hidden';
  el.imgAfterSplit.style.visibility = 'hidden';
  markBlank(false);
}
function hideLiveCanvases() {
  el.liveSbs.hidden = true;
  el.liveSplit.hidden = true;
  el.imgAfterSbs.style.visibility = '';
  el.imgAfterSplit.style.visibility = '';
}
function blitLive(sourceCanvas) {
  for (const c of [el.liveSbs, el.liveSplit]) {
    if (c.hidden) continue;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(sourceCanvas, 0, 0);
  }
}

function scaleStroke(s, k) {
  return {
    pts: s.pts.map(([x, y]) => [x * k, y * k]),
    color: s.color,
    width: Math.max(0.75, s.width * k),
  };
}

/** Draw strokes a chunk at a time (time-boxed per frame) so the tab stays responsive,
    mirroring progress onto the live canvases and sampling GIF frames along the way. */
function drawProgressively(strokes, wctx, gctx, gifScale, gifEvery, gifFrames, onProgress) {
  return new Promise((resolve) => {
    const total = strokes.length;
    let i = 0;
    function step() {
      const start = performance.now();
      while (i < total && performance.now() - start < 16) {
        const s = strokes[i];
        ScribbleCore.drawStroke(wctx, s);
        ScribbleCore.drawStroke(gctx, scaleStroke(s, gifScale));
        i++;
        if (i % gifEvery === 0 || i === total) {
          gifFrames.push(gctx.getImageData(0, 0, gctx.canvas.width, gctx.canvas.height));
        }
      }
      blitLive(wctx.canvas);
      onProgress(i / total);
      if (i < total) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

function drawAllChunked(strokes, wctx, onProgress) {
  return new Promise((resolve) => {
    const total = strokes.length;
    let i = 0;
    function step() {
      const start = performance.now();
      while (i < total && performance.now() - start < 16) {
        ScribbleCore.drawStroke(wctx, strokes[i]);
        i++;
      }
      onProgress(i / total);
      if (i < total) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

function startRecording(canvas) {
  if (!canvas.captureStream || !window.MediaRecorder) throw new Error('MediaRecorder not supported');
  const stream = canvas.captureStream(30);
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
  });
  recorder.start();
  return {
    stop: async () => {
      // Hold on the finished drawing for a beat so the clip doesn't end mid-stroke.
      await new Promise((r) => setTimeout(r, 500));
      recorder.stop();
      return done;
    },
  };
}

async function buildGIF(frames, w, h) {
  const { GIFEncoder, quantize, applyPalette } = await getGifenc();
  const gif = GIFEncoder();
  const frameDelay = 45;
  frames.forEach((imgData, idx) => {
    const data = imgData.data;
    const palette = quantize(data, 96, { format: 'rgba4444' });
    const index = applyPalette(data, palette, 'rgba4444');
    const isLast = idx === frames.length - 1;
    gif.writeFrame(index, w, h, {
      palette,
      delay: isLast ? frameDelay * 8 : frameDelay,
      transparent: true,
    });
  });
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

/* ============================================================
   Run / download
   ============================================================ */

async function run() {
  if (state.busy || !state.file) return;
  state.busy = true;
  clearError();
  el.runBtn.disabled = true;
  el.downloadBtn.disabled = true;
  el.timelapseWebmBtn.hidden = true;
  el.timelapseGifBtn.hidden = true;
  setProgress(3, 'Starting');

  const t0 = performance.now();
  try {
    const out = state.tab === 'bg' ? await runBackgroundRemoval()
      : state.tab === 'convert' ? await runConvert()
      : await runScribble();
    const ms = Math.round(performance.now() - t0);

    const prev = state.results[state.tab];
    if (prev?.url) URL.revokeObjectURL(prev.url);
    if (prev?.video?.url) URL.revokeObjectURL(prev.video.url);
    if (prev?.gif?.url) URL.revokeObjectURL(prev.gif.url);

    const url = URL.createObjectURL(out.blob);
    state.results[state.tab] = { ...out, url, ms };

    el.imgAfterSplit.src = url;
    el.imgAfterSbs.src = url;
    markBlank(false);

    el.roResult.textContent = `${out.w}×${out.h} · ${fmtBytes(out.blob.size)} · ${out.ext.toUpperCase()}`;
    el.roTime.textContent = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;

    el.downloadBtn.disabled = false;
    syncTimelapseButtons();
    setProgress(100, 'Done');
    setTimeout(hideProgress, 700);
  } catch (err) {
    console.error(err);
    hideProgress();
    hideLiveCanvases();
    showError(err?.message || 'Something went wrong. Check the console for details.');
  } finally {
    state.busy = false;
    el.runBtn.disabled = false;
  }
}

function download() {
  const r = state.results[state.tab];
  if (!r) return;
  const suffix = state.tab === 'bg' ? '-cutout' : state.tab === 'scribble' ? '-scribble' : '';
  const a = document.createElement('a');
  a.href = r.url;
  a.download = `${baseName(state.file.name)}${suffix}.${r.ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadTimelapse(kind) {
  const r = state.results.scribble;
  const item = kind === 'gif' ? r?.gif : r?.video;
  if (!item) return;
  const a = document.createElement('a');
  a.href = item.url;
  a.download = `${baseName(state.file.name)}-scribble-timelapse.${kind === 'gif' ? 'gif' : 'webm'}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ============================================================
   Zoom & pan
   ============================================================ */

const zoom = { scale: 1, x: 0, y: 0 };
const ZOOM_MIN = 1, ZOOM_MAX = 6;

function applyZoomTransform() {
  const t = zoom.scale <= 1.001 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  el.splitView.style.transform = t;
  el.paneViews.forEach((pv) => { pv.style.transform = t; });
  el.zoomReset.textContent = Math.round(zoom.scale * 100) + '%';
  const zoomed = zoom.scale > 1.001;
  el.stageSbs.classList.toggle('can-pan', zoomed);
  el.stageSplit.classList.toggle('can-pan', zoomed);
}

function clampPan(paneW, paneH) {
  zoom.x = clamp(zoom.x, -(paneW * (zoom.scale - 1)), 0);
  zoom.y = clamp(zoom.y, -(paneH * (zoom.scale - 1)), 0);
}

function resetZoom() {
  zoom.scale = 1; zoom.x = 0; zoom.y = 0;
  applyZoomTransform();
}

function zoomAt(factor, localX, localY, paneW, paneH) {
  const newScale = clamp(zoom.scale * factor, ZOOM_MIN, ZOOM_MAX);
  if (newScale === zoom.scale) return;
  const originX = (localX - zoom.x) / zoom.scale;
  const originY = (localY - zoom.y) / zoom.scale;
  zoom.scale = newScale;
  if (zoom.scale <= 1.001) {
    zoom.scale = 1; zoom.x = 0; zoom.y = 0;
  } else {
    zoom.x = localX - originX * zoom.scale;
    zoom.y = localY - originY * zoom.scale;
    clampPan(paneW, paneH);
  }
  applyZoomTransform();
}

/** SBS has two equal-width panes side by side; map a client point into
    "local pane space" so the same transform can drive both panes at once. */
function localPointFor(name, clientX, clientY) {
  if (name === 'split') {
    const r = el.stageSplit.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top, w: r.width, h: r.height };
  }
  const r = el.stageSbs.getBoundingClientRect();
  const paneW = r.width / 2;
  let lx = (clientX - r.left) % paneW;
  if (lx < 0) lx += paneW;
  return { x: lx, y: clientY - r.top, w: paneW, h: r.height };
}

function isBlank() {
  return el.stageSplit.classList.contains('is-blank');
}

function buttonZoom(factor) {
  if (isBlank()) return;
  const name = state.activeView;
  const stage = name === 'split' ? el.stageSplit : el.stageSbs;
  const r = stage.getBoundingClientRect();
  const w = name === 'split' ? r.width : r.width / 2;
  zoomAt(factor, w / 2, r.height / 2, w, r.height);
}

el.zoomIn.addEventListener('click', () => buttonZoom(1.35));
el.zoomOut.addEventListener('click', () => buttonZoom(1 / 1.35));
el.zoomReset.addEventListener('click', resetZoom);

function wireWheelZoom(stageEl, name) {
  stageEl.addEventListener('wheel', (e) => {
    if (isBlank()) return;
    e.preventDefault();
    const p = localPointFor(name, e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0016);
    zoomAt(factor, p.x, p.y, p.w, p.h);
  }, { passive: false });
}
wireWheelZoom(el.stageSbs, 'sbs');
wireWheelZoom(el.stageSplit, 'split');

function wireDragPan(stageEl, name) {
  let dragging = false, lastX = 0, lastY = 0;
  stageEl.addEventListener('pointerdown', (e) => {
    if (zoom.scale <= 1 || e.target.closest('.handle')) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    stageEl.classList.add('is-panning');
    stageEl.setPointerCapture(e.pointerId);
  });
  stageEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    zoom.x += dx; zoom.y += dy;
    const r = stageEl.getBoundingClientRect();
    clampPan(name === 'split' ? r.width : r.width / 2, r.height);
    applyZoomTransform();
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    stageEl.classList.remove('is-panning');
    try { stageEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  stageEl.addEventListener('pointerup', end);
  stageEl.addEventListener('pointercancel', end);
}
wireDragPan(el.stageSbs, 'sbs');
wireDragPan(el.stageSplit, 'split');

/* ============================================================
   Split handle
   ============================================================ */

let splitPct = 50;
function setSplit(pct) {
  splitPct = clamp(pct, 4, 96);
  el.stageSplit.style.setProperty('--split', splitPct + '%');
  el.handle.setAttribute('aria-valuenow', String(Math.round(splitPct)));
}
setSplit(50);

(function wireHandle() {
  let dragging = false;
  const pctFromClientX = (clientX) => {
    const r = el.stageSplit.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * 100;
  };
  el.handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    e.stopPropagation();
    el.handle.setPointerCapture(e.pointerId);
  });
  el.handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setSplit(pctFromClientX(e.clientX));
  });
  const stop = (e) => {
    dragging = false;
    try { el.handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  el.handle.addEventListener('pointerup', stop);
  el.handle.addEventListener('pointercancel', stop);
  el.handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { setSplit(splitPct - 3); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setSplit(splitPct + 3); e.preventDefault(); }
    else if (e.key === 'Home') { setSplit(4); e.preventDefault(); }
    else if (e.key === 'End') { setSplit(96); e.preventDefault(); }
  });
})();

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
    state.tab = btn.dataset.tab;
    el.panelBg.hidden = state.tab !== 'bg';
    el.panelConvert.hidden = state.tab !== 'convert';
    el.panelScribble.hidden = state.tab !== 'scribble';
    el.runBtn.textContent = TAB_LABELS[state.tab] || 'Run';
    clearError();
    hideProgress();

    // Each tab keeps its own result.
    const r = state.results[state.tab];
    if (r) {
      el.imgAfterSplit.src = r.url;
      el.imgAfterSbs.src = r.url;
      markBlank(false);
      el.roResult.textContent = `${r.w}×${r.h} · ${fmtBytes(r.blob.size)} · ${r.ext.toUpperCase()}`;
      el.roTime.textContent = r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(2)} s`;
      el.downloadBtn.disabled = false;
    } else {
      markBlank(true);
      el.roResult.textContent = '—';
      el.roTime.textContent = '—';
      el.downloadBtn.disabled = true;
    }
    syncTimelapseButtons();
  });
});

/* --- comparison view (only the two data-view segmented buttons — not the zoom group) --- */
document.querySelectorAll('.seg__btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg__btn[data-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
    const split = btn.dataset.view === 'split';
    el.stageSplit.hidden = !split;
    el.stageSbs.hidden = split;
    state.activeView = split ? 'split' : 'sbs';
    resetZoom();
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
  'image/svg+xml': 'Traces the image into real vector paths, with a smoothing pass first. Built for flat art, not photographs.',
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
el.scWeight.addEventListener('input', () => {
  el.scWeightVal.textContent = SC_WEIGHT_WORDS[parseInt(el.scWeight.value, 10) - 1];
});
el.scColors.addEventListener('input', () => {
  el.scColorsVal.textContent = el.scColors.value;
});

/* --- actions --- */
el.runBtn.addEventListener('click', run);
el.downloadBtn.addEventListener('click', download);
el.timelapseWebmBtn.addEventListener('click', () => downloadTimelapse('webm'));
el.timelapseGifBtn.addEventListener('click', () => downloadTimelapse('gif'));

/* --- boot --- */
(async function boot() {
  updateConvertUI();
  let avif = false;
  try { avif = await canEncode('image/avif'); } catch { avif = false; }
  if (!avif) {
    const opt = el.cvFormat.querySelector('option[value="image/avif"]');
    opt.textContent = 'AVIF — this browser cannot write it';
    opt.disabled = true;
  }
  // Decoding AVIF is far more widespread than encoding it, so list it either way.
  el.acceptedFormats.textContent += ' · AVIF';

  if (!scribbleControlsEnabled()) {
    el.scTimelapse.checked = false;
    el.scTimelapse.disabled = true;
    const hint = el.scTimelapse.closest('.field')?.querySelector('.field__hint');
    if (hint) hint.textContent = "This browser can't record canvas video, so the timelapse recording is unavailable here — the scribble itself still works fine.";
  }
})();