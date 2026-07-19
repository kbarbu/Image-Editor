# Image Bench

A personal image workbench. Remove backgrounds and convert formats without opening five
different websites. Everything runs in the browser — your images are never uploaded anywhere.

Three files, no build step, no dependencies to install.

---

## Run it locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

**Don't double-click `index.html`.** Opening it as `file://` blocks ES module imports and
WASM, and the background remover will fail. It needs to be served over HTTP.

## Deploy to GitHub Pages

1. Push these files to a repo (they can sit in the root).
2. **Settings → Pages → Source: Deploy from a branch**, pick `main` and `/ (root)`.
3. Wait a minute, then visit `https://<you>.github.io/<repo>/`.

That's it. The model weights are fetched from imgly's CDN at runtime, so the repo stays a
few kilobytes.

### One caveat about Pages

GitHub Pages can't set the `COOP`/`COEP` response headers, which means `SharedArrayBuffer`
is unavailable and the model runs single-threaded. It works fine — just expect roughly
3–8 seconds per image instead of 1–3. If that ever bothers you, Netlify or Cloudflare
Pages let you set those headers via a `_headers` file and you'll get the threaded path.

---

## Tools

### Remove background

Uses [`@imgly/background-removal`](https://github.com/imgly/background-removal-js) (the
ISNet model, same lineage as what remove.bg and PhotoRoom use). First run downloads the
weights and the browser caches them; every run after that is instant to start.

- **Backdrop** — transparent by default. White, black, or a custom color for formats and
  tools that won't take an alpha channel.
- **Model** — full / half-precision / quantized, trading edge quality against download
  size and speed. Half-precision is the default and is usually the right call.
- **Compute** — GPU via WebGPU where available, CPU otherwise.

Picking JPEG with a transparent backdrop flattens onto white automatically, since JPEG has
no alpha channel to write to.

### Convert format

| Target | Alpha | Notes |
|---|---|---|
| PNG | yes | Lossless. The safe default. |
| WEBP | yes | Noticeably smaller than PNG at similar quality. |
| AVIF | yes | Smallest files. Chrome and Edge can write it; Safari and Firefox can't, so the option disables itself automatically. |
| JPEG | no | Lossy. Photographs. |
| BMP | no | Uncompressed 24-bit, hand-rolled encoder since browsers won't write BMP. |
| SVG | partial | Real vector tracing. |

Input accepts PNG, JPEG, WEBP, AVIF, GIF, BMP, and SVG. SVG inputs are rasterized at a
minimum of 1400px on the long edge, so **SVG → PNG** upscales cleanly rather than giving
you a 24px icon.

### About PNG → SVG

This is tracing, not converting — there's no vector data hiding in a PNG to recover. It
uses [ImageTracer.js](https://github.com/jankovicsandras/imagetracerjs) and it's genuinely
good on logos, icons, and flat art. On photographs it produces thousands of useless blobby
paths and a file larger than the original. That's inherent to the technique, not a bug.

Start at 2–8 colors and **Balanced** detail. Trace input is capped at 1600px because cost
scales hard with pixel count.

---

## Adding a third tool

The tab system is generic. To add one:

1. Add a `<button class="tab" data-tab="yourtool">` to the `.tabs` nav in `index.html`.
2. Add a `<div class="panel__body" id="panel-yourtool" hidden>` with your controls.
3. Write an `async function runYourTool()` returning `{ blob, w, h, ext }`.
4. Register it in the dispatch inside `run()`.

Everything else — the viewer, the split slider, the readout, the download button — is
already wired to whatever that function returns.

---

## Notes

- `[hidden] { display: none !important }` in the CSS is load-bearing. Several elements use
  `display: grid/flex`, which outranks the browser's built-in `[hidden]` rule and would
  otherwise refuse to hide.
- The background remover retries on the main thread if its web worker fails to spawn,
  which is the usual failure mode on static hosts.
