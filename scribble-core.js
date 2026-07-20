/* ============================================================
   Scribble core — turns an image into kid-crayon scribble strokes.
   Pure logic + canvas drawing. No DOM assumptions beyond 2d ctx.
   Exported as an object so the same file runs in node and browser.
   ============================================================ */

const ScribbleCore = (() => {

  const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
  const randi = (n) => Math.floor(Math.random() * n);

  /* ---------- color quantization: median cut ---------- */

  function quantize(data, w, h, k) {
    // Sample opaque pixels.
    const px = [];
    const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 24000)));
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const i = (y * w + x) * 4;
        if (data[i + 3] > 127) px.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    if (!px.length) return [[0, 0, 0]];

    let boxes = [px];
    while (boxes.length < k) {
      // Split the box with the widest channel range.
      let bi = -1, bc = 0, br = -1;
      boxes.forEach((box, idx) => {
        if (box.length < 2) return;
        for (let c = 0; c < 3; c++) {
          let mn = 255, mx = 0;
          for (const p of box) { if (p[c] < mn) mn = p[c]; if (p[c] > mx) mx = p[c]; }
          if (mx - mn > br) { br = mx - mn; bi = idx; bc = c; }
        }
      });
      if (bi < 0 || br < 6) break; // nothing meaningful left to split
      const box = boxes[bi];
      box.sort((a, b) => a[bc] - b[bc]);
      const mid = box.length >> 1;
      boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
    }

    return refine(px, boxes.map((box) => {
      let r = 0, g = 0, b = 0;
      for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
      const n = box.length;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }));
  }

  /** A couple of k-means passes tightens the palette, then extremes are
      protected: small white or black features (eyes, teeth, outlines)
      must not get averaged away into a pastel. */
  function refine(px, palette) {
    for (let pass = 0; pass < 2; pass++) {
      const sum = palette.map(() => [0, 0, 0, 0]);
      for (const p of px) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < palette.length; c++) {
          const dr = p[0] - palette[c][0], dg = p[1] - palette[c][1], db = p[2] - palette[c][2];
          const d = dr * dr * 2 + dg * dg * 3 + db * db;
          if (d < bd) { bd = d; best = c; }
        }
        const s = sum[best];
        s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
      }
      palette = palette.map((c, i) => sum[i][3]
        ? [0, 1, 2].map((k) => Math.round(sum[i][k] / sum[i][3]))
        : c);
    }

    // Count true whites / blacks in the source.
    let whites = 0, blacks = 0;
    for (const p of px) {
      if (p[0] > 225 && p[1] > 225 && p[2] > 225) whites++;
      else if (p[0] < 36 && p[1] < 36 && p[2] < 36) blacks++;
    }
    const hasNear = (test) => palette.some(test);
    const swapWorst = (color) => {
      // Sacrifice the palette entry closest to another entry (least distinct).
      let worst = 0, wd = Infinity;
      for (let i = 0; i < palette.length; i++) {
        for (let j = 0; j < palette.length; j++) {
          if (i === j) continue;
          const d = palette[i].reduce((a, v, k) => a + (v - palette[j][k]) ** 2, 0);
          if (d < wd) { wd = d; worst = i; }
        }
      }
      if (palette.length > 2) palette[worst] = color;
      else palette.push(color);
    };
    if (whites / px.length > 0.004 && !hasNear((c) => c[0] > 215 && c[1] > 215 && c[2] > 215)) {
      swapWorst([250, 250, 250]);
    }
    if (blacks / px.length > 0.004 && !hasNear((c) => c[0] < 48 && c[1] < 48 && c[2] < 48)) {
      swapWorst([18, 18, 18]);
    }
    return palette;
  }

  /** Mild crayon punch: nudge saturation and value up. */
  function punch(c) {
    const [r, g, b] = c;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const k = 1.14; // saturation boost
    return [r, g, b].map((v) => {
      let out = l + (v - l) * k;
      out = out + (255 - out) * 0.03;
      return Math.max(0, Math.min(255, Math.round(out)));
    });
  }

  /* ---------- label map ---------- */

  function labelize(data, w, h, palette) {
    const labels = new Int16Array(w * h).fill(-1);
    const counts = new Array(palette.length).fill(0);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      if (data[p + 3] < 128) continue;
      let best = 0, bd = Infinity;
      for (let c = 0; c < palette.length; c++) {
        const dr = data[p] - palette[c][0], dg = data[p + 1] - palette[c][1], db = data[p + 2] - palette[c][2];
        const d = dr * dr * 2 + dg * dg * 3 + db * db; // perceptual-ish weights
        if (d < bd) { bd = d; best = c; }
      }
      labels[i] = best;
      counts[best]++;
    }
    return { labels, counts };
  }

  /* ---------- stroke planning ---------- */

  function planColor(colorIdx, labels, w, h, opts) {
    // Collect this color's pixels once.
    const cells = [];
    for (let i = 0; i < w * h; i++) if (labels[i] === colorIdx) cells.push(i);
    if (cells.length < Math.max(4, opts.minCells)) return { strokes: [], area: cells.length };

    // Weird-shaped holes: elliptical no-start zones on larger regions.
    // Low detail carves more and bigger holes; high detail barely any.
    const holes = [];
    const areaFrac = cells.length / (w * h);
    const d = opts.detail;
    if (areaFrac > 0.012 && d < 9) {
      const n = d <= 3 ? 2 + randi(3) : d <= 6 ? 1 + randi(3) : randi(2);
      const rBase = 0.3 - d * 0.016;
      for (let i = 0; i < n; i++) {
        const c = cells[randi(cells.length)];
        holes.push({
          x: c % w, y: Math.floor(c / w),
          r: Math.sqrt(cells.length) * rand(rBase * 0.6, rBase * 1.5),
          ax: rand(0.5, 1.8), ay: rand(0.5, 1.8),   // anisotropy = weird shapes
          th: rand(Math.PI),
        });
      }
    }
    const inHole = (x, y) => holes.some((hh) => {
      const dx = x - hh.x, dy = y - hh.y;
      const rx = (dx * Math.cos(hh.th) + dy * Math.sin(hh.th)) * hh.ax;
      const ry = (-dx * Math.sin(hh.th) + dy * Math.cos(hh.th)) * hh.ay;
      return rx * rx + ry * ry < hh.r * hh.r;
    });

    const at = (x, y) => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -2;
      return labels[yi * w + xi];
    };

    // Budget: enough strokes to mostly cover, minus what the holes eat.
    const step = 1.6;
    const wA = opts.weightAnalysis; // stroke width in analysis px
    const avgLen = 26 * step;
    const budget = Math.max(2, Math.ceil((cells.length * opts.coverage * (1.35 + opts.detail * 0.17)) / (avgLen * wA)));

    const strokes = [];
    const covered = new Uint8Array(w * h);
    const covR = Math.max(1, Math.round(wA * 0.45));
    const markCovered = (pts) => {
      for (const [px, py] of pts) {
        const cx = Math.round(px), cy = Math.round(py);
        for (let dy = -covR; dy <= covR; dy++) {
          for (let dx = -covR; dx <= covR; dx++) {
            const mx = cx + dx, my = cy + dy;
            if (mx >= 0 && my >= 0 && mx < w && my < h) covered[my * w + mx] = 1;
          }
        }
      }
    };

    let tries = 0;
    while (strokes.length < budget && tries < budget * 14) {
      tries++;
      const c = cells[randi(cells.length)];
      let x = c % w, y = Math.floor(c / w);
      if (inHole(x, y)) continue;
      // Prefer virgin ground — this is what fills the region instead of
      // scribbling the same spot forever.
      if (covered[c] && Math.random() < 0.75) continue;

      let th = rand(Math.PI * 2);
      const pts = [[x, y]];
      const len = 12 + randi(46);
      let overshoot = Math.random() < 0.3 ? 2 : 0; // sometimes color outside the lines

      for (let s = 0; s < len; s++) {
        th += rand(-0.62, 0.62) + Math.sin(s * rand(0.3, 0.8)) * 0.3;
        let nx = x + Math.cos(th) * step, ny = y + Math.sin(th) * step;
        if (at(nx, ny) !== colorIdx) {
          let turned = false;
          const turns = [0.8, -0.8, 1.6, -1.6, 2.4, -2.4].sort(() => Math.random() - 0.5);
          for (const t of turns) {
            const cx2 = x + Math.cos(th + t) * step, cy2 = y + Math.sin(th + t) * step;
            if (at(cx2, cy2) === colorIdx) { th += t; nx = cx2; ny = cy2; turned = true; break; }
          }
          if (!turned) {
            if (overshoot > 0 && at(nx, ny) !== -2) { overshoot--; }
            else break;
          }
        }
        x = nx; y = ny;
        pts.push([x, y]);
      }
      if (pts.length >= 3) { strokes.push(pts); markCovered(pts); }
    }
    return { strokes, area: cells.length };
  }

  /**
   * Analyze image data and plan every stroke, ready to draw.
   * data/w/h: analysis-resolution RGBA. outW/outH: output canvas size.
   * Returns { strokes:[{pts,color,width}], palette }
   */
  function plan(data, w, h, outW, outH, { colors = 6, weight = 5, detail = 5 } = {}) {
    const palette = quantize(data, w, h, colors).map(punch);
    const { labels, counts } = labelize(data, w, h, palette);

    // Stroke width in output px, from the weight slider (1..10).
    const outMax = Math.max(outW, outH);
    const widthOut = outMax * (0.006 + weight * 0.0042);
    const scale = outW / w;
    const weightAnalysis = Math.max(1, widthOut / scale);

    // Detail: low = sparse coverage, big holes, tiny regions skipped.
    //         high = full coverage, every speck of the image drawn.
    const covMul = 0.42 + detail * 0.095;
    const minCells = detail >= 7 ? 4 : (11 - detail) * 3;

    // Big regions first, details on top.
    const order = palette.map((_, i) => i).filter((i) => counts[i] > 0)
      .sort((a, b) => counts[b] - counts[a]);

    const all = [];
    for (const ci of order) {
      const coverage = rand(0.82, 1.0) * covMul;
      const { strokes } = planColor(ci, labels, w, h, { weightAnalysis, coverage, detail, minCells });
      const [r, g, b] = palette[ci];
      for (const pts of strokes) {
        all.push({
          pts: pts.map(([x, y]) => [
            x * scale + rand(-0.6, 0.6) * scale,
            y * scale + rand(-0.6, 0.6) * scale,
          ]),
          color: `rgb(${r},${g},${b})`,
          width: widthOut * rand(0.7, 1.3),
        });
      }
    }
    return { strokes: all, palette };
  }

  /** Draw one stroke on a 2d context as a smoothed crayon line. */
  function drawStroke(ctx, s) {
    const p = s.pts;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
      ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
    }
    const last = p[p.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }

  /** 3×3 majority vote over a label map — melts speckle noise into clean
      regions so traced paths come out smooth. Used by the vectorizer. */
  function modeFilter(labels, w, h, passes = 1) {
    let src = labels;
    for (let p = 0; p < passes; p++) {
      const out = new Int16Array(src);
      const vals = new Int16Array(9);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          vals[0] = src[i - w - 1]; vals[1] = src[i - w]; vals[2] = src[i - w + 1];
          vals[3] = src[i - 1];     vals[4] = src[i];     vals[5] = src[i + 1];
          vals[6] = src[i + w - 1]; vals[7] = src[i + w]; vals[8] = src[i + w + 1];
          let best = src[i], bestN = 0;
          for (let a = 0; a < 9; a++) {
            const v = vals[a];
            let n = 0;
            for (let b = 0; b < 9; b++) if (vals[b] === v) n++;
            if (n > bestN) { bestN = n; best = v; }
          }
          if (bestN >= 5) out[i] = best;
        }
      }
      src = out;
    }
    return src;
  }

  return { plan, drawStroke, quantize, labelize, modeFilter };
})();

if (typeof module !== 'undefined') module.exports = ScribbleCore;