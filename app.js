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

  // ---------- elements ----------
  function $(id) { return document.getElementById(id); }
  var els = {
    drop: $("drop"), file: $("file"),
    controls: $("controls"), result: $("result"),
    ncolors: $("ncolors"), nval: $("nval"),
    accent: $("accent"), aval: $("aval"),
    sat: $("sat"), sval: $("sval"),
    blend: $("blend"), bval: $("bval"),
    oklab: $("oklab"),
    cOrig: $("cOrig"), cGraded: $("cGraded"),
    gradbar: $("gradbar"), stops: $("stops"), swatches: $("swatches"),
    addStop: $("addStop"), eyedrop: $("eyedrop"), reExtract: $("reExtract"), picker: $("picker"),
    lutSize: $("lutSize"),
    dlCube: $("dlCube"), dlPng: $("dlPng"), copyHex: $("copyHex"), shareBtn: $("shareBtn"),
    dropTarget: $("dropTarget"), fileTarget: $("fileTarget"),
    targetFig: $("targetFig"), cTarget: $("cTarget"), dlTarget: $("dlTarget"),
    work: $("work")
  };

  // ---------- state ----------
  var state = { img: null, target: null, stops: [], ramp: null, name: "grappa", manual: false };
  var selIdx = null, drag = null;

  function blendAmt() { return parseInt(els.blend.value, 10) / 100; }

  // ---------- settings + image persistence ----------
  function loadSettings() {
    [["gm_ncolors", els.ncolors, els.nval], ["gm_accent", els.accent, els.aval],
     ["gm_sat", els.sat, els.sval], ["gm_blend", els.blend, els.bval]].forEach(function (s) {
      var v = localStorage.getItem(s[0]);
      if (v !== null) { s[1].value = v; s[2].textContent = v; }
    });
    var k = localStorage.getItem("gm_oklab");
    if (k !== null) els.oklab.checked = k === "1";
    var ls = localStorage.getItem("gm_lutsize");
    if (ls !== null) els.lutSize.value = ls;
  }

  function persistImage(im) {
    try {
      var max = 1280, scale = Math.min(1, max / Math.max(im.width, im.height));
      var w = Math.round(im.width * scale), h = Math.round(im.height * scale);
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(im, 0, 0, w, h);
      localStorage.setItem("gm_image", c.toDataURL("image/jpeg", 0.85));
      localStorage.setItem("gm_name", state.name);
    } catch (e) { try { localStorage.removeItem("gm_image"); } catch (e2) {} }
  }

  function restoreImage(analyzeAfter) {
    var d = localStorage.getItem("gm_image");
    if (!d) return false;
    state.name = localStorage.getItem("gm_name") || "grappa";
    var im = new Image();
    im.onload = function () {
      state.img = im;
      if (analyzeAfter) { recompute(); }
      else { els.result.hidden = false; drawOriginal(); renderGraded(); }
    };
    im.src = d;
    return true;
  }

  // ---------- source image load ----------
  function loadFile(f) {
    if (!f || !/^image\//.test(f.type)) return;
    state.name = (f.name || "grappa").replace(/\.[^.]+$/, "") || "grappa";
    var url = URL.createObjectURL(f);
    var im = new Image();
    im.onload = function () { URL.revokeObjectURL(url); state.img = im; persistImage(im); recompute(); };
    im.src = url;
  }
  function wireDrop(el, input, cb) {
    el.addEventListener("click", function () { input.click(); });
    ["dragenter", "dragover"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.remove("over"); }); });
    el.addEventListener("drop", function (e) { cb(e.dataTransfer.files[0]); });
  }
  wireDrop(els.drop, els.file, loadFile);
  els.file.addEventListener("change", function (e) { loadFile(e.target.files[0]); });
  window.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items; if (!items) return;
    for (var i = 0; i < items.length; i++) { if (items[i].type.indexOf("image") === 0) { loadFile(items[i].getAsFile()); break; } }
  });

  // ---------- target image load ----------
  function loadTarget(f) {
    if (!f || !/^image\//.test(f.type)) return;
    var url = URL.createObjectURL(f);
    var im = new Image();
    im.onload = function () { URL.revokeObjectURL(url); state.target = im; renderTarget(); };
    im.src = url;
  }
  wireDrop(els.dropTarget, els.fileTarget, loadTarget);
  els.fileTarget.addEventListener("change", function (e) { loadTarget(e.target.files[0]); });

  // ---------- slider / toggle listeners ----------
  function bindExtract(el, label, key) {
    el.addEventListener("input", function () { label.textContent = el.value; localStorage.setItem(key, el.value); recompute(); });
  }
  bindExtract(els.ncolors, els.nval, "gm_ncolors");
  bindExtract(els.accent, els.aval, "gm_accent");
  bindExtract(els.sat, els.sval, "gm_sat");
  els.blend.addEventListener("input", function () {
    els.bval.textContent = els.blend.value; localStorage.setItem("gm_blend", els.blend.value);
    renderGraded(); renderTarget();
  });
  els.oklab.addEventListener("change", function () {
    localStorage.setItem("gm_oklab", els.oklab.checked ? "1" : "0"); rebuildAndRender();
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
  function analyze(N, accentMix) {
    var im = state.img;
    var maxDim = 500, scale = Math.min(1, maxDim / Math.max(im.width, im.height));
    var w = Math.max(1, Math.round(im.width * scale)), h = Math.max(1, Math.round(im.height * scale));
    els.work.width = w; els.work.height = h;
    var wctx = els.work.getContext("2d");
    wctx.drawImage(im, 0, 0, w, h);
    var data = wctx.getImageData(0, 0, w, h).data;

    var chromaPow = 1 + accentMix * 3;   // 1 (plain) .. 4 (very selective)
    var HB = 24;                          // hue bins (15° each) — enough to separate blue from orange
    // tot[L]  = [sumR, sumG, sumB, count]  — plain tone average
    // hist[L] = HB groups of [wR, wG, wB, w], colors weighted by saturation^chromaPow
    var tot = new Array(256), hist = new Array(256);
    for (var i = 0; i < 256; i++) { tot[i] = [0, 0, 0, 0]; hist[i] = new Float64Array(HB * 4); }

    for (var p = 0; p < data.length; p += 4) {
      if (data[p + 3] < 8) continue;
      var r = data[p], g = data[p + 1], b = data[p + 2];
      var L = Math.round(lum(r, g, b));
      var t = tot[L]; t[0] += r; t[1] += g; t[2] += b; t[3] += 1;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d === 0) continue;             // achromatic: no hue to bin
      var hh;                            // hue in [0,1)
      if (mx === r) hh = ((g - b) / d) % 6;
      else if (mx === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh /= 6; if (hh < 0) hh += 1;
      var wc = Math.pow(d / 255, chromaPow);
      var o = (Math.floor(hh * HB) % HB) * 4, ha = hist[L];
      ha[o] += r * wc; ha[o + 1] += g * wc; ha[o + 2] += b * wc; ha[o + 3] += wc;
    }

    var avg = tot.map(function (f) { return f[3] ? [f[0] / f[3], f[1] / f[3], f[2] / f[3]] : null; });
    function nearest(idx) {
      for (var d = 0; d < 256; d++) {
        if (idx - d >= 0 && avg[idx - d]) return avg[idx - d];
        if (idx + d < 256 && avg[idx + d]) return avg[idx + d];
      }
      return [idx, idx, idx];
    }
    // robust luminance range (ignore ~0.5% outliers at each end)
    var total = 0;
    for (var ti = 0; ti < 256; ti++) total += tot[ti][3];
    var Lmin = 0, Lmax = 255;
    if (total > 0) {
      var cut = total * 0.005, cum = 0;
      for (var lo = 0; lo < 256; lo++) { cum += tot[lo][3]; if (cum >= cut) { Lmin = lo; break; } }
      cum = 0;
      for (var hi = 255; hi >= 0; hi--) { cum += tot[hi][3]; if (cum >= cut) { Lmax = hi; break; } }
      if (Lmax <= Lmin) { Lmin = 0; Lmax = 255; }
    }
    var stops = [];
    var half = Math.max(1, Math.round((Lmax - Lmin) / (2 * (N - 1))));
    for (var s = 0; s < N; s++) {
      var pos = s / (N - 1);
      var center = Math.round(Lmin + pos * (Lmax - Lmin));
      var mR = 0, mG = 0, mB = 0, mN = 0, acc = new Float64Array(HB * 4);
      for (var k = center - half; k <= center + half; k++) {
        if (k < 0 || k >= 256) continue;
        var fk = tot[k]; mR += fk[0]; mG += fk[1]; mB += fk[2]; mN += fk[3];
        var hk = hist[k]; for (var q = 0; q < HB * 4; q++) acc[q] += hk[q];
      }
      var meanCol = mN ? [mR / mN, mG / mN, mB / mN] : nearest(center);
      // dominant hue, pooled with neighbors so a cluster split across a bin edge isn't penalized
      var best = -1, bestW = 0;
      for (var hb = 0; hb < HB; hb++) {
        var score = acc[hb * 4 + 3]
          + 0.5 * (acc[((hb - 1 + HB) % HB) * 4 + 3] + acc[((hb + 1) % HB) * 4 + 3]);
        if (score > bestW) { bestW = score; best = hb; }
      }
      var accentCol = meanCol;
      if (best >= 0) {
        var R = 0, G = 0, B = 0, W = 0;
        [(best - 1 + HB) % HB, best, (best + 1) % HB].forEach(function (bin) {
          var bo = bin * 4; R += acc[bo]; G += acc[bo + 1]; B += acc[bo + 2]; W += acc[bo + 3];
        });
        if (W > 0.001) accentCol = [R / W, G / W, B / W];
      }
      stops.push({ pos: pos, col: [
        meanCol[0] + (accentCol[0] - meanCol[0]) * accentMix,
        meanCol[1] + (accentCol[1] - meanCol[1]) * accentMix,
        meanCol[2] + (accentCol[2] - meanCol[2]) * accentMix
      ] });
    }
    return stops;
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
  function recompute() {
    if (!state.img) return;
    els.controls.hidden = false; els.result.hidden = false;
    state.stops = analyze(parseInt(els.ncolors.value, 10), parseInt(els.accent.value, 10) / 100);
    var satAmt = parseInt(els.sat.value, 10) / 100;
    if (satAmt !== 1) state.stops = state.stops.map(function (s) { return { pos: s.pos, col: saturate(s.col, satAmt) }; });
    state.manual = false; selIdx = null;
    rebuildAndRender();
  }
  function rebuildAndRender() {
    state.ramp = buildRamp(state.stops, els.oklab.checked);
    drawGradbar(); drawStops(); drawSwatches(); drawOriginal(); renderGraded(); renderTarget();
  }

  // ---------- rendering ----------
  function fitCanvas(canvas, iw, ih, maxW) {
    var scale = Math.min(1, maxW / iw);
    canvas.width = Math.round(iw * scale); canvas.height = Math.round(ih * scale);
  }
  function applyRamp(img, blend) {
    var d = img.data;
    for (var p = 0; p < d.length; p += 4) {
      var c = state.ramp[Math.round(lum(d[p], d[p + 1], d[p + 2]))];
      d[p] = c[0] * blend + d[p] * (1 - blend);
      d[p + 1] = c[1] * blend + d[p + 1] * (1 - blend);
      d[p + 2] = c[2] * blend + d[p + 2] * (1 - blend);
    }
  }
  function drawOriginal() {
    if (!state.img) return;
    fitCanvas(els.cOrig, state.img.width, state.img.height, 900);
    els.cOrig.getContext("2d").drawImage(state.img, 0, 0, els.cOrig.width, els.cOrig.height);
  }
  function renderGraded() {
    if (!state.ramp || !state.img || !els.cOrig.width) return;
    var src = els.cOrig.getContext("2d").getImageData(0, 0, els.cOrig.width, els.cOrig.height);
    applyRamp(src, blendAmt());
    els.cGraded.width = els.cOrig.width; els.cGraded.height = els.cOrig.height;
    els.cGraded.getContext("2d").putImageData(src, 0, 0);
  }
  function renderTarget() {
    if (!state.target || !state.ramp) return;
    els.targetFig.hidden = false;
    fitCanvas(els.cTarget, state.target.width, state.target.height, 900);
    var ctx = els.cTarget.getContext("2d");
    ctx.drawImage(state.target, 0, 0, els.cTarget.width, els.cTarget.height);
    var img = ctx.getImageData(0, 0, els.cTarget.width, els.cTarget.height);
    applyRamp(img, blendAmt());
    ctx.putImageData(img, 0, 0);
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
    state.ramp = buildRamp(state.stops, els.oklab.checked);
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
  }
  var eyedropArmed = false;
  function setArmed(on) {
    eyedropArmed = on;
    els.eyedrop.classList.toggle("on", on);
    els.cOrig.classList.toggle("eyedrop", on);
  }
  els.eyedrop.addEventListener("click", function () {
    if (!state.img) return;
    if (window.EyeDropper) {
      new EyeDropper().open()
        .then(function (res) { addColorStop(hexToRgb(res.sRGBHex)); })
        .catch(function () {}); // user pressed Esc
    } else {
      setArmed(!eyedropArmed); // fallback: click the original canvas to sample
    }
  });
  els.cOrig.addEventListener("click", function (e) {
    if (!eyedropArmed || !els.cOrig.width) return;
    var rect = els.cOrig.getBoundingClientRect();
    var x = Math.floor((e.clientX - rect.left) / rect.width * els.cOrig.width);
    var y = Math.floor((e.clientY - rect.top) / rect.height * els.cOrig.height);
    var px = els.cOrig.getContext("2d").getImageData(x, y, 1, 1).data;
    addColorStop([px[0], px[1], px[2]]);
    setArmed(false);
  });
  function openPicker(i) {
    selIdx = i; markSel();
    els.picker.value = hex(state.stops[i].col.map(Math.round));
    els.picker.oninput = function () {
      state.stops[i].col = hexToRgb(els.picker.value); state.manual = true;
      state.ramp = buildRamp(state.stops, els.oklab.checked);
      drawGradbar(); drawStops(); drawSwatches(); renderGraded(); renderTarget();
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
  function buildCube(size) {
    var blend = blendAmt();
    var lines = ["# Generated by Grappa", 'TITLE "' + state.name + '"', "LUT_3D_SIZE " + size, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
    var n = size - 1;
    for (var b = 0; b < size; b++) for (var g = 0; g < size; g++) for (var r = 0; r < size; r++) {
      var ri = r / n, gi = g / n, bi = b / n;
      var c = state.ramp[Math.round(lum(ri * 255, gi * 255, bi * 255))];
      lines.push(
        ((c[0] / 255) * blend + ri * (1 - blend)).toFixed(6) + " " +
        ((c[1] / 255) * blend + gi * (1 - blend)).toFixed(6) + " " +
        ((c[2] / 255) * blend + bi * (1 - blend)).toFixed(6));
    }
    return lines.join("\n") + "\n";
  }
  els.dlCube.addEventListener("click", function () { if (state.ramp) download(state.name + ".cube", new Blob([buildCube(parseInt(els.lutSize.value, 10))], { type: "text/plain" })); });
  els.dlPng.addEventListener("click", function () {
    if (!state.ramp) return;
    var c = document.createElement("canvas"); c.width = 1024; c.height = 128;
    var ctx = c.getContext("2d");
    for (var x = 0; x < c.width; x++) { ctx.fillStyle = rgbCss(state.ramp[Math.floor(x / c.width * 256)]); ctx.fillRect(x, 0, 1, c.height); }
    c.toBlob(function (blob) { download(state.name + "-gradient.png", blob); });
  });
  els.copyHex.addEventListener("click", function () {
    if (!state.stops.length) return;
    var txt = state.stops.slice().sort(function (a, b) { return a.pos - b.pos; }).map(function (s) { return hex(s.col.map(Math.round)); }).join(", ");
    navigator.clipboard.writeText(txt).then(function () { flash(els.copyHex, "Copied!", "Copy hex list"); });
  });
  els.dlTarget.addEventListener("click", function () {
    if (!state.target || !state.ramp) return;
    var c = document.createElement("canvas"); c.width = state.target.width; c.height = state.target.height;
    var ctx = c.getContext("2d"); ctx.drawImage(state.target, 0, 0);
    var img = ctx.getImageData(0, 0, c.width, c.height); applyRamp(img, blendAmt()); ctx.putImageData(img, 0, 0);
    c.toBlob(function (blob) { download(state.name + "-graded.png", blob); });
  });
  function flash(btn, on, off) { btn.textContent = on; setTimeout(function () { btn.textContent = off; }, 1200); }

  // ---------- share link ----------
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64d(s) { return decodeURIComponent(escape(atob(s))); }
  function serialize() {
    return {
      s: state.stops.map(function (st) { return [Math.round(st.pos * 1000), Math.round(st.col[0]), Math.round(st.col[1]), Math.round(st.col[2])]; }),
      b: parseInt(els.blend.value, 10), k: els.oklab.checked ? 1 : 0, n: state.name
    };
  }
  function applyGradient(obj) {
    if (obj.s && obj.s.length) { state.stops = obj.s.map(function (a) { return { pos: a[0] / 1000, col: [a[1], a[2], a[3]] }; }); state.manual = true; }
    if (obj.b != null) { els.blend.value = obj.b; els.bval.textContent = obj.b; }
    if (obj.k != null) els.oklab.checked = !!obj.k;
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
      restoreImage(false); // load source image for preview only, no re-analyze
      applyGradient(obj);
      return true;
    } catch (e) { return false; }
  }
  // ---------- init ----------
  loadSettings();
  if (!loadFromHash()) restoreImage(true);
})();
