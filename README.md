# Image Bench

A personal image workbench.

## Tools

### Remove background

Uses [`@imgly/background-removal`](https://github.com/imgly/background-removal-js) (the
ISNet model, same lineage as what remove.bg and PhotoRoom use). First run downloads the
weights and the browser caches them; every run after that is instant to start.

- **Backdrop**: transparent by default. White, black, or a custom color for formats and
  tools that won't take an alpha channel.
- **Model**: full / half-precision / quantized, trading edge quality against download
  size and speed. Half-precision is the default and is usually the right call.
- **Compute**: GPU via WebGPU where available, CPU otherwise.

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

---
