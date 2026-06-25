(function () {
  "use strict";

  // ---------- color helpers ----------
  function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
  function hex(c) { return "#" + c.map(function (v) { return ("0" + Math.round(v).toString(16)).slice(-2); }).join(""); }
  function rgbCss(c) { return "rgb(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + ")"; }
  function hexToRgb(h) { h = h.replace("#", ""); return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; }
  function clamp255(v) { return Math.max(0, Math.min(255, v)); }
  // scale chroma around luminance (amt > 1 boosts saturation), keeps brightness
  function saturate(rgb, amt) {
    var L = lum(rgb[0], rgb[1], rgb[2]);
    return rgb.map(function (v) { return clamp255(L + (v - L) * amt); });
  }

  // ---------- OKLab (Björn Ottosson) for perceptual interpolation ----------
  function sToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linToS(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return clamp255(c * 255); }
  function rgbToOklab(rgb) {
    var r = sToLin(rgb[0]), g = sToLin(rgb[1]), b = sToLin(rgb[2]);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    ];
  }
  function oklabToRgb(lab) {
    var L = lab[0], a = lab[1], bb = lab[2];
    var l = L + 0.3963377774 * a + 0.2158037573 * bb;
    var m = L - 0.1055613458 * a - 0.0638541728 * bb;
    var s = L - 0.0894841775 * a - 1.2914855480 * bb;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return [
      linToS(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linToS(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linToS(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    ];
  }
  // Unit vector pointing at "warm" (orange) in the OKLab a/b plane, so warmth is
  // a smooth projection: orange ≈ +1, its opposite (blue) ≈ -1, and green (−a)
  // also reads cool — fixing the old hue-bin scheme where green barely counted.
  var WARM_DIR = (function () { var o = rgbToOklab([235, 150, 60]); var n = Math.hypot(o[1], o[2]) || 1; return [o[1] / n, o[2] / n]; })();
  // small deterministic PRNG so k-means seeding is stable across re-extracts
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---------- elements ----------
  function $(id) { return document.getElementById(id); }
  var els = {
    drop: $("drop"), file: $("file"),
    controls: $("controls"), result: $("result"),
    ncolors: $("ncolors"), nval: $("nval"),
    accent: $("accent"), aval: $("aval"),
    temp: $("temp"), tval: $("tval"),
    sat: $("sat"), sval: $("sval"),
    blend: $("blend"), bval: $("bval"),
    carry: $("carry"), cval: $("cval"),
    oklab: $("oklab"), mirror: $("mirror"), keepbw: $("keepbw"),
    cOrig: $("cOrig"), cGraded: $("cGraded"),
    cFogWarm: $("cFogWarm"), cFogBal: $("cFogBal"), cFogCool: $("cFogCool"),
    gradbar: $("gradbar"), stops: $("stops"), swatches: $("swatches"),
    addStop: $("addStop"), eyedrop: $("eyedrop"), reExtract: $("reExtract"), picker: $("picker"),
    lutSize: $("lutSize"),
    dlCube: $("dlCube"), dlPng: $("dlPng"), exportVars: $("exportVars"), copyHex: $("copyHex"), shareBtn: $("shareBtn"),
    work: $("work")
  };

  // ---------- state ----------
  var state = { img: null, samples: null, stops: [], ramp: null, varRamps: null, name: "grappa", manual: false };
  function activeImg() { return state.img; }
  var selIdx = null, drag = null;

  function blendAmt() { return parseInt(els.blend.value, 10) / 100; }

  // ---------- settings + image persistence ----------
  function loadSettings() {
    [["gm_ncolors", els.ncolors, els.nval], ["gm_accent", els.accent, els.aval],
     ["gm_temp", els.temp, els.tval], ["gm_sat", els.sat, els.sval], ["gm_blend", els.blend, els.bval],
     ["gm_carry", els.carry, els.cval]].forEach(function (s) {
      var v = localStorage.getItem(s[0]);
      if (v !== null) { s[1].value = v; s[2].textContent = v; }
    });
    var k = localStorage.getItem("gm_oklab");
    if (k !== null) els.oklab.checked = k === "1";
    var mr = localStorage.getItem("gm_mirror");
    if (mr !== null) els.mirror.checked = mr === "1";
    var bw = localStorage.getItem("gm_keepbw");
    if (bw !== null) els.keepbw.checked = bw === "1";
    var ls = localStorage.getItem("gm_lutsize");
    if (ls !== null) els.lutSize.value = ls;
  }

  function imgToDataURL(im) {
    var max = 1280, scale = Math.min(1, max / Math.max(im.width, im.height));
    var w = Math.round(im.width * scale), h = Math.round(im.height * scale);
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(im, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.85);
  }
  function persistImages() {
    try {
      if (state.img) localStorage.setItem("gm_image", imgToDataURL(state.img));
      else localStorage.removeItem("gm_image");
      localStorage.setItem("gm_name", state.name);
      localStorage.removeItem("gm_images"); // retire old multi-image key
    } catch (e) { try { localStorage.removeItem("gm_image"); } catch (e2) {} }
  }

  // decode a list of data-URLs / object-URLs into Image objects, calling cb once
  // all have settled (preserving order, skipping any that failed to load)
  function loadImages(srcs, cb) {
    var loaded = [], remaining = srcs.length;
    if (!remaining) { cb([]); return; }
    srcs.forEach(function (d, i) {
      var im = new Image();
      im.onload = function () { loaded[i] = im; if (--remaining === 0) cb(loaded.filter(Boolean)); };
      im.onerror = function () { if (--remaining === 0) cb(loaded.filter(Boolean)); };
      im.src = d;
    });
  }

  function restoreImages(analyzeAfter) {
    var single = localStorage.getItem("gm_image");
    if (!single) { var raw = localStorage.getItem("gm_images"); if (raw) { try { var a = JSON.parse(raw); single = a && a[0]; } catch (e) {} } }
    if (!single) return false;
    state.name = localStorage.getItem("gm_name") || "grappa";
    loadImages([single], function (imgs) {
      if (!imgs.length) return;
      state.img = imgs[0]; state.samples = null;
      if (analyzeAfter) { recompute(); }
      else { els.result.hidden = false; ensureSamples(); updateVariations(); drawOriginal(); renderGraded(); renderFog(); }
    });
    return true;
  }

  // ---------- source image load ----------
  // load one dropped/chosen/pasted image (replacing any current one) and re-extract
  function loadFiles(files) {
    var imgFiles = Array.prototype.filter.call(files || [], function (f) { return f && /^image\//.test(f.type); });
    if (!imgFiles.length) return;
    var url = URL.createObjectURL(imgFiles[0]);
    loadImages([url], function (imgs) {
      URL.revokeObjectURL(url);
      if (!imgs.length) return;
      state.img = imgs[0]; state.samples = null;
      state.name = (imgFiles[0].name || "grappa").replace(/\.[^.]+$/, "") || "grappa";
      persistImages(); recompute();
    });
  }
  function wireDrop(el, input, cb) {
    el.addEventListener("click", function () { input.click(); });
    ["dragenter", "dragover"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.remove("over"); }); });
    el.addEventListener("drop", function (e) { cb(e.dataTransfer.files); });
  }
  wireDrop(els.drop, els.file, loadFiles);
  els.file.addEventListener("change", function (e) { loadFiles(e.target.files); });
  window.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items; if (!items) return;
    for (var i = 0; i < items.length; i++) { if (items[i].type.indexOf("image") === 0) { loadFiles([items[i].getAsFile()]); break; } }
  });

  // ---------- slider / toggle listeners ----------
  function bindExtract(el, label, key) {
    el.addEventListener("input", function () { label.textContent = el.value; localStorage.setItem(key, el.value); recompute(); });
  }
  bindExtract(els.ncolors, els.nval, "gm_ncolors");
  bindExtract(els.accent, els.aval, "gm_accent");
  bindExtract(els.temp, els.tval, "gm_temp");
  bindExtract(els.sat, els.sval, "gm_sat");
  els.blend.addEventListener("input", function () {
    els.bval.textContent = els.blend.value; localStorage.setItem("gm_blend", els.blend.value);
    renderGraded(); renderFog();
  });
  els.carry.addEventListener("input", function () {
    els.cval.textContent = els.carry.value; localStorage.setItem("gm_carry", els.carry.value);
    renderGraded();
  });
  els.oklab.addEventListener("change", function () {
    localStorage.setItem("gm_oklab", els.oklab.checked ? "1" : "0"); updateVariations(); rebuildAndRender();
  });
  els.mirror.addEventListener("change", function () {
    localStorage.setItem("gm_mirror", els.mirror.checked ? "1" : "0"); updateVariations(); rebuildAndRender();
  });
  els.keepbw.addEventListener("change", function () {
    localStorage.setItem("gm_keepbw", els.keepbw.checked ? "1" : "0"); recompute();
  });
  els.lutSize.addEventListener("change", function () { localStorage.setItem("gm_lutsize", els.lutSize.value); });
  els.reExtract.addEventListener("click", function () { recompute(); });

  // ---------- analysis (luminance bins + dominant-hue accent) ----------
  // A gradient map keys output color on input luminance, so each stop is the
  // representative color of one brightness band. Two things matter per band:
  //   1. the dominant *tone* — the plain mean of every pixel, and
  //   2. the dominant *vivid hue* — which must NOT be a chroma average, or an
  //      orange glow and a blue sky at the same brightness cancel into mud.
  // So we histogram each band by hue (weighted by saturation^chromaPow) and let
  // the single most-saturated hue cluster define the accent. A vivid minority
  // hue beats a majority of greys (greys carry ~no weight) but still yields to a
  // larger, equally-vivid cluster — the best a one-color-per-brightness LUT can do.
  // ---------- palette extraction (OKLab weighted k-means) ----------
  // Cache per-image OKLab samples so slider drags don't recompute cbrt's. Each
  // pixel keeps its chroma (for the Color/vividness weight) and a warmth value
  // (projection onto the OKLab warm axis, so blue AND green read cool) for the
  // Temperature weight. Weights are applied later — only the geometry is cached.
  function buildSamples(im) {
    var maxDim = 500, scale = Math.min(1, maxDim / Math.max(im.width, im.height));
    var w = Math.max(1, Math.round(im.width * scale)), h = Math.max(1, Math.round(im.height * scale));
    els.work.width = w; els.work.height = h;
    var ctx = els.work.getContext("2d");
    ctx.drawImage(im, 0, 0, w, h);
    var data;
    try { data = ctx.getImageData(0, 0, w, h).data; }
    catch (e) { state.samples = null; return; }
    var cap = w * h, La = new Float32Array(cap), aa = new Float32Array(cap), bb = new Float32Array(cap), ch = new Float32Array(cap), wm = new Float32Array(cap), m = 0;
    for (var p = 0; p < data.length; p += 4) {
      if (data[p + 3] < 8) continue;
      var lab = rgbToOklab([data[p], data[p + 1], data[p + 2]]);
      var c = Math.hypot(lab[1], lab[2]);
      La[m] = lab[0]; aa[m] = lab[1]; bb[m] = lab[2]; ch[m] = c;
      wm[m] = c > 1e-4 ? (lab[1] * WARM_DIR[0] + lab[2] * WARM_DIR[1]) / c : 0;
      m++;
    }
    state.samples = { L: La, a: aa, b: bb, chroma: ch, warmth: wm, n: m };
  }
  function ensureSamples() { if (state.img && !state.samples) buildSamples(state.img); }

  // Weighted k-means over OKLab. The per-pixel weight favours vivid colors
  // (Color slider) and a warm/cool direction (Temperature), so a small but
  // distinct blue/green region earns its OWN cluster centroid instead of being
  // averaged into the warm bulk — which is what makes minority hues finally
  // appear as real palette stops. Pixels are first collapsed into a coarse OKLab
  // grid (a few hundred weighted points) so the clustering stays fast.
  var CHROMA_REF = 0.13, VIVID_BOOST = 16;
  function extractPalette(N, accentMix, tempBias) {
    var S = state.samples; if (!S || !S.n) return [];
    var GL = 18, GAB = 20, ABMIN = -0.33, ABSPAN = 0.66, cells = {};
    for (var i = 0; i < S.n; i++) {
      var cn = Math.min(1, S.chroma[i] / CHROMA_REF);
      var wt = (1 + accentMix * VIVID_BOOST * cn * cn) * (tempBias ? Math.exp(tempBias * S.warmth[i]) : 1);
      var li = Math.min(GL - 1, Math.max(0, Math.floor(S.L[i] * GL)));
      var ai = Math.min(GAB - 1, Math.max(0, Math.floor((S.a[i] - ABMIN) / ABSPAN * GAB)));
      var bi = Math.min(GAB - 1, Math.max(0, Math.floor((S.b[i] - ABMIN) / ABSPAN * GAB)));
      var key = (li * GAB + ai) * GAB + bi, cell = cells[key];
      if (!cell) cell = cells[key] = [0, 0, 0, 0];
      cell[0] += S.L[i] * wt; cell[1] += S.a[i] * wt; cell[2] += S.b[i] * wt; cell[3] += wt;
    }
    var pts = [];
    for (var k in cells) { var cl = cells[k]; if (cl[3] > 0) pts.push([cl[0] / cl[3], cl[1] / cl[3], cl[2] / cl[3], cl[3]]); }
    if (!pts.length) return [];
    var K = Math.min(N, pts.length), rand = mulberry32(0x9e3779b9);
    function d2(p, c) { var dl = p[0] - c[0], da = p[1] - c[1], db = p[2] - c[2]; return dl * dl + da * da + db * db; }
    // k-means++ seeding (chroma/weight-aware, deterministic)
    var cents = [pts[Math.floor(rand() * pts.length)].slice(0, 3)];
    while (cents.length < K) {
      var dsum = 0, ds = pts.map(function (p) {
        var best = Infinity; for (var c = 0; c < cents.length; c++) best = Math.min(best, d2(p, cents[c]));
        var v = best * p[3]; dsum += v; return v;
      });
      var r = rand() * dsum, acc2 = 0, pick = pts.length - 1;
      for (var j = 0; j < pts.length; j++) { acc2 += ds[j]; if (acc2 >= r) { pick = j; break; } }
      cents.push(pts[pick].slice(0, 3));
    }
    // Lloyd's iterations
    for (var it = 0; it < 16; it++) {
      var sums = []; for (var s0 = 0; s0 < K; s0++) sums.push([0, 0, 0, 0]);
      for (var pi = 0; pi < pts.length; pi++) {
        var pp = pts[pi], bc = 0, bd = Infinity;
        for (var c3 = 0; c3 < K; c3++) { var dd = d2(pp, cents[c3]); if (dd < bd) { bd = dd; bc = c3; } }
        var sm = sums[bc]; sm[0] += pp[0] * pp[3]; sm[1] += pp[1] * pp[3]; sm[2] += pp[2] * pp[3]; sm[3] += pp[3];
      }
      for (var c4 = 0; c4 < K; c4++) if (sums[c4][3] > 0) cents[c4] = [sums[c4][0] / sums[c4][3], sums[c4][1] / sums[c4][3], sums[c4][2] / sums[c4][3]];
    }
    // centroids -> stops, positioned by their luminance
    var stops = cents.map(function (c) { var rgb = oklabToRgb(c); return { pos: lum(rgb[0], rgb[1], rgb[2]) / 255, col: rgb }; });
    stops.sort(function (a, b) { return a.pos - b.pos; });
    return stops;
  }

  function analyze(N, accentMix, hueBias) {
    ensureSamples();
    return extractPalette(N, accentMix, hueBias);
  }

  // ---------- ramp (linear or OKLab interpolation) ----------
  function buildRamp(stops, useOklab) {
    var sorted = stops.slice().sort(function (a, b) { return a.pos - b.pos; });
    var labs = useOklab ? sorted.map(function (s) { return rgbToOklab(s.col); }) : null;
    var ramp = new Array(256);
    for (var i = 0; i < 256; i++) {
      var t = i / 255, loI = 0, hiI = sorted.length - 1, f = 0;
      if (t <= sorted[0].pos) { loI = hiI = 0; }
      else if (t >= sorted[sorted.length - 1].pos) { loI = hiI = sorted.length - 1; }
      else {
        for (var s = 0; s < sorted.length - 1; s++) {
          if (t >= sorted[s].pos && t <= sorted[s + 1].pos) {
            loI = s; hiI = s + 1;
            var span = sorted[s + 1].pos - sorted[s].pos;
            f = span > 0 ? (t - sorted[s].pos) / span : 0;
            break;
          }
        }
      }
      if (useOklab) {
        var A = labs[loI], B = labs[hiI];
        ramp[i] = oklabToRgb([A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f]);
      } else {
        var a = sorted[loI].col, b = sorted[hiI].col;
        ramp[i] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      }
    }
    return ramp;
  }

  // ---------- pipeline ----------
  // Squeeze the palette into the middle and add true black at pos 0 / white at
  // pos 1 as real (editable) stops. Without this, the extracted stops always
  // span pos 0..1, so anything brighter than the lightest color clamps to it —
  // a near-white fog floods to e.g. pink. With it, highlights stay white and
  // shadows stay black; the painting colors live in the mids. BW_HEADROOM is
  // how much of each end is reserved for the black/white shoulder.
  var BW_HEADROOM = 0.08;
  function withBW(stops) {
    var m = BW_HEADROOM, span = 1 - 2 * m;
    var inner = stops.map(function (s) { return { pos: m + s.pos * span, col: s.col }; });
    return [{ pos: 0, col: [0, 0, 0] }].concat(inner, [{ pos: 1, col: [255, 255, 255] }]);
  }
  // Extract stops at a given warm/cool hueBias using the current Colors,
  // Saturation and Preserve-B&W settings. hueBias 0 is the live look; ±values
  // feed the warm/cool export variations.
  function extractStops(hueBias) {
    var stops = analyze(parseInt(els.ncolors.value, 10), parseInt(els.accent.value, 10) / 100, hueBias);
    var satAmt = parseInt(els.sat.value, 10) / 100;
    if (satAmt !== 1) stops = stops.map(function (s) { return { pos: s.pos, col: saturate(s.col, satAmt) }; });
    if (els.keepbw.checked) stops = withBW(stops);
    return stops;
  }
  // Build a finished ramp (with OKLab/Mirror applied) from a fresh extraction at
  // the given bias — used by the fog variation panels and the variations export
  // without disturbing the live edited gradient.
  function rampForBias(hueBias) {
    var r = buildRamp(extractStops(hueBias), els.oklab.checked);
    return els.mirror.checked ? applyMirror(r) : r;
  }
  // The three warm/balanced/cool variation ramps, cached so the fog panels and
  // export don't re-extract on every blend tick or stop drag. Recomputed only
  // when an extraction input changes (Colors/Color/Saturation/B&W/OKLab/Mirror).
  var BIASES = { warm: 3, balanced: 0, cool: -3 };
  function updateVariations() {
    if (!state.img) { state.varRamps = null; return; }
    state.varRamps = { warm: rampForBias(BIASES.warm), balanced: rampForBias(BIASES.balanced), cool: rampForBias(BIASES.cool) };
  }
  // Temperature slider (-100 cool … 0 … +100 warm) → hue bias for live extraction.
  function tempBias() { return parseInt(els.temp.value, 10) / 100 * BIASES.warm; }
  function recompute() {
    if (!state.img) return;
    els.controls.hidden = false; els.result.hidden = false;
    state.stops = extractStops(tempBias());
    updateVariations();
    state.manual = false; selIdx = null;
    rebuildAndRender();
  }
  // Fold a ramp so it reflects at the midpoint: index 0..255 maps to 0..255..0,
  // so shadows and highlights share the first stop's color and mids peak at the
  // last. Applied to the finished ramp, so every consumer (preview, bar, .cube)
  // sees the mirrored result.
  function applyMirror(ramp) {
    var out = new Array(256);
    for (var i = 0; i < 256; i++) out[i] = ramp[255 - Math.abs(2 * i - 255)];
    return out;
  }
  function buildRampNow() {
    var r = buildRamp(state.stops, els.oklab.checked);
    return els.mirror.checked ? applyMirror(r) : r;
  }
  function rebuildAndRender() {
    state.ramp = buildRampNow();
    drawGradbar(); drawStops(); drawSwatches(); drawOriginal(); renderGraded(); renderFog();
  }

  // ---------- fog reference ----------
  // A built-in neutral test surface: smooth grayscale value-noise that looks
  // like wispy fog and spans pure black to pure white, so you can see how the
  // grade colors real foggy texture (and that black/white stay clean). It is
  // reference-only — never analyzed, never part of the palette.
  var fogBase = null;
  function genFog(w, h) {
    // value noise: each octave is a coarse random grid, smoothstep-interpolated
    function octave(cell) {
      var gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2, g = new Float32Array(gw * gh);
      for (var i = 0; i < g.length; i++) g[i] = Math.random();
      return function (x, y) {
        var fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy);
        var tx = fx - ix, ty = fy - iy;
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        var a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
        return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      };
    }
    var o1 = octave(Math.max(8, w / 6)), o2 = octave(Math.max(6, w / 16)), o3 = octave(Math.max(4, w / 40));
    var base = new Float32Array(w * h), mn = Infinity, mx = -Infinity;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var v = o1(x, y) * 0.6 + o2(x, y) * 0.3 + o3(x, y) * 0.1;
      base[y * w + x] = v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    var out = new Uint8Array(w * h), rng = (mx - mn) || 1;          // stretch to full 0..255
    for (var p = 0; p < base.length; p++) out[p] = Math.round((base[p] - mn) / rng * 255);
    return out;
  }
  function renderFogInto(canvas, ramp) {
    if (!canvas || !ramp) return;
    var w = canvas.width, h = canvas.height;
    if (!fogBase || fogBase.length !== w * h) fogBase = genFog(w, h);
    var ctx = canvas.getContext("2d"), img = ctx.createImageData(w, h), d = img.data, blend = blendAmt();
    for (var p = 0, q = 0; p < fogBase.length; p++, q += 4) {
      var L = fogBase[p], col = ramp[L];
      d[q] = col[0] * blend + L * (1 - blend);
      d[q + 1] = col[1] * blend + L * (1 - blend);
      d[q + 2] = col[2] * blend + L * (1 - blend);
      d[q + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  // Same fog texture graded by each variation, so the only difference you see is
  // the warm/balanced/cool bias.
  function renderFog() {
    if (!state.varRamps) return;
    renderFogInto(els.cFogWarm, state.varRamps.warm);
    renderFogInto(els.cFogBal, state.varRamps.balanced);
    renderFogInto(els.cFogCool, state.varRamps.cool);
  }

  // ---------- rendering ----------
  function fitCanvas(canvas, iw, ih, maxW) {
    var scale = Math.min(1, maxW / iw);
    canvas.width = Math.round(iw * scale); canvas.height = Math.round(ih * scale);
  }
  function carryAmt() { return parseInt(els.carry.value, 10) / 100; }
  // Map an input pixel to the painting's TONE for its brightness, then optionally
  // carry the pixel's OWN hue/chroma (OKLab a/b) back in by 'carry'. carry=0 is a
  // pure gradient-map (painting color). carry>0 keeps the footage's own color
  // separation — so a near-white fog with a faint blue cast keeps that blue, and
  // a colored shot no longer collapses to one color per brightness. This is what
  // turns the .cube into a real 3D transform instead of the luminance diagonal.
  function gradeColor(r, g, b, ramp) {
    var tone = ramp[Math.round(lum(r, g, b))], carry = carryAmt();
    if (carry <= 0) return tone;
    var lt = rgbToOklab(tone), ls = rgbToOklab([r, g, b]);
    return oklabToRgb([lt[0], lt[1] + (ls[1] - lt[1]) * carry, lt[2] + (ls[2] - lt[2]) * carry]);
  }
  function applyRamp(img, blend) {
    var d = img.data;
    for (var p = 0; p < d.length; p += 4) {
      var c = gradeColor(d[p], d[p + 1], d[p + 2], state.ramp);
      d[p] = c[0] * blend + d[p] * (1 - blend);
      d[p + 1] = c[1] * blend + d[p + 1] * (1 - blend);
      d[p + 2] = c[2] * blend + d[p + 2] * (1 - blend);
    }
  }
  function drawOriginal() {
    var im = activeImg(); if (!im) return;
    fitCanvas(els.cOrig, im.width, im.height, 900);
    els.cOrig.getContext("2d").drawImage(im, 0, 0, els.cOrig.width, els.cOrig.height);
  }
  function renderGraded() {
    if (!state.ramp || !activeImg() || !els.cOrig.width) return;
    var src = els.cOrig.getContext("2d").getImageData(0, 0, els.cOrig.width, els.cOrig.height);
    applyRamp(src, blendAmt());
    els.cGraded.width = els.cOrig.width; els.cGraded.height = els.cOrig.height;
    els.cGraded.getContext("2d").putImageData(src, 0, 0);
  }
  function drawGradbar() {
    var c = els.gradbar, ctx = c.getContext("2d");
    for (var x = 0; x < c.width; x++) {
      ctx.fillStyle = rgbCss(state.ramp[Math.floor(x / c.width * 256)]);
      ctx.fillRect(x, 0, 1, c.height);
    }
  }
  function drawSwatches() {
    els.swatches.innerHTML = "";
    state.stops.slice().sort(function (a, b) { return a.pos - b.pos; }).forEach(function (st) {
      var c = st.col.map(Math.round), div = document.createElement("div");
      div.className = "sw";
      div.innerHTML = '<div class="chip" style="background:' + rgbCss(c) + '"></div><code>' + hex(c) + "</code>";
      els.swatches.appendChild(div);
    });
  }

  // ---------- editable stops ----------
  function drawStops() {
    els.stops.innerHTML = "";
    state.stops.forEach(function (st, i) {
      var h = document.createElement("div");
      h.className = "stop" + (i === selIdx ? " sel" : "");
      h.style.left = (st.pos * 100) + "%";
      h.style.background = rgbCss(st.col);
      h.addEventListener("pointerdown", function (e) {
        e.stopPropagation(); e.preventDefault();
        selIdx = i; markSel();
        drag = { idx: i, moved: false };
      });
      h.addEventListener("dblclick", function (e) { e.preventDefault(); openPicker(i); });
      els.stops.appendChild(h);
    });
  }
  function markSel() {
    var nodes = els.stops.children;
    for (var k = 0; k < nodes.length; k++) nodes[k].classList.toggle("sel", k === selIdx);
  }
  // add a stop by clicking the empty track
  els.stops.addEventListener("pointerdown", function (e) {
    if (e.target !== els.stops || !state.ramp) return;
    var rect = els.stops.getBoundingClientRect();
    var pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    state.stops.push({ pos: pos, col: state.ramp[Math.round(pos * 255)].slice() });
    state.manual = true; selIdx = state.stops.length - 1; rebuildAndRender();
  });
  document.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var rect = els.stops.getBoundingClientRect();
    var pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    state.stops[drag.idx].pos = pos; drag.moved = true;
    if (els.stops.children[drag.idx]) els.stops.children[drag.idx].style.left = (pos * 100) + "%";
    state.ramp = buildRampNow();
    drawGradbar();
  });
  document.addEventListener("pointerup", function () {
    if (!drag) return;
    var moved = drag.moved; drag = null;
    if (moved) { state.manual = true; rebuildAndRender(); }
  });
  document.addEventListener("keydown", function (e) {
    if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selIdx != null && state.stops.length > 2) {
      state.stops.splice(selIdx, 1); selIdx = null; state.manual = true; rebuildAndRender();
      e.preventDefault(); return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && selIdx != null) {
      var step = (e.shiftKey ? 0.02 : 0.005) * (e.key === "ArrowRight" ? 1 : -1);
      state.stops[selIdx].pos = Math.max(0, Math.min(1, state.stops[selIdx].pos + step));
      state.manual = true; rebuildAndRender();
      e.preventDefault();
    }
  });
  els.addStop.addEventListener("click", function () {
    state.stops.push({ pos: 0.5, col: state.ramp ? state.ramp[128].slice() : [128, 128, 128] });
    state.manual = true; selIdx = state.stops.length - 1; rebuildAndRender();
  });

  // ---------- eyedropper: sample a color and add it at its matching brightness ----------
  // The gradient map is keyed on luminance, so a sampled color belongs at the
  // position equal to its own brightness — that's where it will actually appear.
  function addColorStop(rgb) {
    state.stops.push({ pos: lum(rgb[0], rgb[1], rgb[2]) / 255, col: rgb.slice() });
    state.manual = true; selIdx = state.stops.length - 1; rebuildAndRender();
    flash(els.eyedrop, "Added " + hex(rgb), "Eyedrop");
  }
  var eyedropArmed = false;
  function setArmed(on) {
    eyedropArmed = on;
    els.eyedrop.classList.toggle("on", on);
    els.cOrig.classList.toggle("eyedrop", on);
  }
  els.eyedrop.addEventListener("click", function () {
    if (!activeImg()) return;
    if (window.EyeDropper) {
      new EyeDropper().open()
        .then(function (res) { addColorStop(hexToRgb(res.sRGBHex)); })
        .catch(function () {}); // user pressed Esc
    } else {
      setArmed(!eyedropArmed); // fallback: click the original canvas to sample
    }
  });
  els.cOrig.addEventListener("click", function (e) {
    var im = activeImg();
    if (!eyedropArmed || !im) return;
    // sample the FULL-RES original at the click, not the downscaled preview — so
    // a thin misty detail gives its true hue/brightness, not a blurred average
    var rect = els.cOrig.getBoundingClientRect();
    var x = Math.min(im.width - 1, Math.max(0, Math.floor((e.clientX - rect.left) / rect.width * im.width)));
    var y = Math.min(im.height - 1, Math.max(0, Math.floor((e.clientY - rect.top) / rect.height * im.height)));
    var c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    var cx = c.getContext("2d"); cx.drawImage(im, 0, 0);
    try {
      var px = cx.getImageData(x, y, 1, 1).data;
      addColorStop([px[0], px[1], px[2]]);
    } catch (err) {}
    setArmed(false);
  });
  function openPicker(i) {
    selIdx = i; markSel();
    els.picker.value = hex(state.stops[i].col.map(Math.round));
    els.picker.oninput = function () {
      state.stops[i].col = hexToRgb(els.picker.value); state.manual = true;
      state.ramp = buildRampNow();
      drawGradbar(); drawStops(); drawSwatches(); renderGraded();
    };
    els.picker.click();
  }

  // ---------- exports ----------
  function download(filename, blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function buildCube(size, ramp) {
    ramp = ramp || state.ramp;
    var blend = blendAmt();
    var lines = ["# Generated by Grappa", 'TITLE "' + state.name + '"', "LUT_3D_SIZE " + size, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
    var n = size - 1;
    for (var b = 0; b < size; b++) for (var g = 0; g < size; g++) for (var r = 0; r < size; r++) {
      var ri = r / n, gi = g / n, bi = b / n;
      var c = gradeColor(ri * 255, gi * 255, bi * 255, ramp);
      lines.push(
        ((c[0] / 255) * blend + ri * (1 - blend)).toFixed(6) + " " +
        ((c[1] / 255) * blend + gi * (1 - blend)).toFixed(6) + " " +
        ((c[2] / 255) * blend + bi * (1 - blend)).toFixed(6));
    }
    return lines.join("\n") + "\n";
  }
  els.dlCube.addEventListener("click", function () { if (state.ramp) download(state.name + ".cube", new Blob([buildCube(parseInt(els.lutSize.value, 10))], { type: "text/plain" })); });
  // Render a ramp as a 1024×128 gradient strip PNG.
  function gradientPngBlob(ramp, cb) {
    var c = document.createElement("canvas"); c.width = 1024; c.height = 128;
    var ctx = c.getContext("2d");
    for (var x = 0; x < c.width; x++) { ctx.fillStyle = rgbCss(ramp[Math.floor(x / c.width * 256)]); ctx.fillRect(x, 0, 1, c.height); }
    c.toBlob(cb);
  }
  els.dlPng.addEventListener("click", function () {
    if (state.ramp) gradientPngBlob(state.ramp, function (blob) { download(state.name + "-gradient.png", blob); });
  });
  // --- minimal store-only (uncompressed) zip, so we can bundle files with no deps ---
  function crc32(u8) {
    var t = crc32.t;
    if (!t) { t = crc32.t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ t[(crc ^ u8[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function strToU8(s) { return new TextEncoder().encode(s); }
  function zipStore(files) {
    var enc = new TextEncoder(), chunks = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data);
      var lh = new Uint8Array(30 + name.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true); lh.set(name, 30);
      chunks.push(lh, data);
      var cd = new Uint8Array(46 + name.length), cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); cd.set(name, 46);
      central.push(cd);
      offset += lh.length + data.length;
    });
    var cdSize = central.reduce(function (a, c) { return a + c.length; }, 0);
    central.forEach(function (c) { chunks.push(c); });
    var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    chunks.push(eocd);
    return new Blob(chunks, { type: "application/zip" });
  }
  // Re-extract warm / balanced / cool takes and bundle all three as .cube + .png
  // into one zip. Freshly extracted, so manual stop edits aren't included — that's
  // why this is separate from the single-file Download buttons above.
  els.exportVars.addEventListener("click", function () {
    if (!state.img) return;
    var size = parseInt(els.lutSize.value, 10);
    var variants = [{ n: "warm", ramp: rampForBias(BIASES.warm) }, { n: "balanced", ramp: rampForBias(BIASES.balanced) }, { n: "cool", ramp: rampForBias(BIASES.cool) }];
    // if the user has hand-edited / eyedropped the gradient, include it too so
    // those exact colors aren't silently dropped from the shipped files
    if (state.manual) variants.push({ n: "edited", ramp: state.ramp });
    var files = [], pending = variants.length;
    variants.forEach(function (v) {
      files.push({ name: state.name + "-" + v.n + ".cube", data: strToU8(buildCube(size, v.ramp)) });
      gradientPngBlob(v.ramp, function (blob) {
        blob.arrayBuffer().then(function (buf) {
          files.push({ name: state.name + "-" + v.n + ".png", data: new Uint8Array(buf) });
          if (--pending === 0) { download(state.name + "-variations.zip", zipStore(files)); flash(els.exportVars, "Exported zip", "Export 3 variations (zip)"); }
        });
      });
    });
  });
  els.copyHex.addEventListener("click", function () {
    if (!state.stops.length) return;
    var txt = state.stops.slice().sort(function (a, b) { return a.pos - b.pos; }).map(function (s) { return hex(s.col.map(Math.round)); }).join(", ");
    navigator.clipboard.writeText(txt).then(function () { flash(els.copyHex, "Copied!", "Copy hex list"); });
  });
  function flash(btn, on, off) { btn.textContent = on; setTimeout(function () { btn.textContent = off; }, 1200); }

  // ---------- share link ----------
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64d(s) { return decodeURIComponent(escape(atob(s))); }
  function serialize() {
    return {
      s: state.stops.map(function (st) { return [Math.round(st.pos * 1000), Math.round(st.col[0]), Math.round(st.col[1]), Math.round(st.col[2])]; }),
      b: parseInt(els.blend.value, 10), k: els.oklab.checked ? 1 : 0, m: els.mirror.checked ? 1 : 0, w: els.keepbw.checked ? 1 : 0, c: parseInt(els.carry.value, 10), n: state.name
    };
  }
  function applyGradient(obj) {
    if (obj.s && obj.s.length) { state.stops = obj.s.map(function (a) { return { pos: a[0] / 1000, col: [a[1], a[2], a[3]] }; }); state.manual = true; }
    if (obj.b != null) { els.blend.value = obj.b; els.bval.textContent = obj.b; }
    if (obj.c != null) { els.carry.value = obj.c; els.cval.textContent = obj.c; }
    if (obj.k != null) els.oklab.checked = !!obj.k;
    if (obj.m != null) els.mirror.checked = !!obj.m;
    if (obj.w != null) els.keepbw.checked = !!obj.w;
    if (obj.n) state.name = obj.n;
    els.controls.hidden = false; els.result.hidden = false; selIdx = null;
    rebuildAndRender();
  }
  els.shareBtn.addEventListener("click", function () {
    if (!state.stops.length) return;
    var url = location.origin + location.pathname + "#g=" + encodeURIComponent(b64e(JSON.stringify(serialize())));
    navigator.clipboard.writeText(url).then(function () { flash(els.shareBtn, "Link copied!", "Copy share link"); });
  });
  function loadFromHash() {
    var m = location.hash.match(/g=([^&]+)/); if (!m) return false;
    try {
      var obj = JSON.parse(b64d(decodeURIComponent(m[1])));
      restoreImages(false); // load source images for preview only, no re-analyze
      applyGradient(obj);
      return true;
    } catch (e) { return false; }
  }
  // ---------- init ----------
  loadSettings();
  if (!loadFromHash()) restoreImages(true);
})();
