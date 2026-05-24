(function () {
  "use strict";
  // Rec.709 luminance
  function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
  function hex(c) { return "#" + c.map(function (v) { return ("0" + Math.round(v).toString(16)).slice(-2); }).join(""); }
  // scale chroma around luminance (amt > 1 boosts saturation, < 1 mutes), keeps brightness
  function saturate(rgb, amt) {
    var L = lum(rgb[0], rgb[1], rgb[2]);
    return rgb.map(function (v) { return Math.max(0, Math.min(255, L + (v - L) * amt)); });
  }

  var els = {
    drop: document.getElementById("drop"),
    file: document.getElementById("file"),
    controls: document.getElementById("controls"),
    result: document.getElementById("result"),
    ncolors: document.getElementById("ncolors"),
    nval: document.getElementById("nval"),
    blend: document.getElementById("blend"),
    bval: document.getElementById("bval"),
    accent: document.getElementById("accent"),
    aval: document.getElementById("aval"),
    sat: document.getElementById("sat"),
    sval: document.getElementById("sval"),
    cOrig: document.getElementById("cOrig"),
    cGraded: document.getElementById("cGraded"),
    gradbar: document.getElementById("gradbar"),
    swatches: document.getElementById("swatches"),
    work: document.getElementById("work"),
    dlCube: document.getElementById("dlCube"),
    dlPng: document.getElementById("dlPng"),
    copyHex: document.getElementById("copyHex")
  };

  var state = { img: null, stops: [], ramp: null, name: "gradient-map" };

  // ---- remember slider settings + image across reloads ----
  function loadSettings() {
    var n = localStorage.getItem("gm_ncolors");
    var b = localStorage.getItem("gm_blend");
    var ac = localStorage.getItem("gm_accent");
    var sa = localStorage.getItem("gm_sat");
    if (n !== null) { els.ncolors.value = n; els.nval.textContent = n; }
    if (b !== null) { els.blend.value = b; els.bval.textContent = b; }
    if (ac !== null) { els.accent.value = ac; els.aval.textContent = ac; }
    if (sa !== null) { els.sat.value = sa; els.sval.textContent = sa; }
  }

  // Store a downscaled copy of the image so it survives reloads (keeps localStorage small).
  function persistImage(im) {
    try {
      var max = 1280, scale = Math.min(1, max / Math.max(im.width, im.height));
      var w = Math.round(im.width * scale), h = Math.round(im.height * scale);
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(im, 0, 0, w, h);
      localStorage.setItem("gm_image", c.toDataURL("image/jpeg", 0.85));
      localStorage.setItem("gm_name", state.name);
    } catch (e) {
      // quota exceeded or tainted canvas — just skip persistence
      try { localStorage.removeItem("gm_image"); } catch (e2) {}
    }
  }

  function restoreImage() {
    var d = localStorage.getItem("gm_image");
    if (!d) return;
    state.name = localStorage.getItem("gm_name") || "gradient-map";
    var im = new Image();
    im.onload = function () { state.img = im; recompute(); };
    im.src = d;
  }

  loadSettings();
  restoreImage();

  // ---- load image ----
  function loadFile(f) {
    if (!f || !/^image\//.test(f.type)) return;
    state.name = (f.name || "gradient-map").replace(/\.[^.]+$/, "") || "gradient-map";
    var url = URL.createObjectURL(f);
    var im = new Image();
    im.onload = function () { URL.revokeObjectURL(url); state.img = im; persistImage(im); recompute(); };
    im.src = url;
  }

  els.drop.addEventListener("click", function () { els.file.click(); });
  els.file.addEventListener("change", function (e) { loadFile(e.target.files[0]); });
  ["dragenter", "dragover"].forEach(function (ev) {
    els.drop.addEventListener(ev, function (e) { e.preventDefault(); els.drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    els.drop.addEventListener(ev, function (e) { e.preventDefault(); els.drop.classList.remove("over"); });
  });
  els.drop.addEventListener("drop", function (e) { loadFile(e.dataTransfer.files[0]); });
  window.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") === 0) { loadFile(items[i].getAsFile()); break; }
    }
  });

  els.ncolors.addEventListener("input", function () {
    els.nval.textContent = els.ncolors.value;
    localStorage.setItem("gm_ncolors", els.ncolors.value);
    recompute();
  });
  els.blend.addEventListener("input", function () {
    els.bval.textContent = els.blend.value;
    localStorage.setItem("gm_blend", els.blend.value);
    renderGraded();
  });
  els.accent.addEventListener("input", function () {
    els.aval.textContent = els.accent.value;
    localStorage.setItem("gm_accent", els.accent.value);
    recompute();
  });
  els.sat.addEventListener("input", function () {
    els.sval.textContent = els.sat.value;
    localStorage.setItem("gm_sat", els.sat.value);
    recompute();
  });

  // ---- analysis: bin image by luminance, sample color per band ----
  function analyze(N, accentMix) {
    var im = state.img;
    var maxDim = 500, scale = Math.min(1, maxDim / Math.max(im.width, im.height));
    var w = Math.max(1, Math.round(im.width * scale)), h = Math.max(1, Math.round(im.height * scale));
    els.work.width = w; els.work.height = h;
    var wctx = els.work.getContext("2d");
    wctx.drawImage(im, 0, 0, w, h);
    var data = wctx.getImageData(0, 0, w, h).data;

    // fine 256-bin luminance histogram. For each brightness we keep two
    // accumulators: a plain mean (stable tone) and a saturation-weighted mean
    // (the dominant *colored* pixels at that brightness, since greys weigh ~0).
    // The Color slider blends between them so vivid accents can beat the greys.
    // Slot layout: [sumR, sumG, sumB, satR, satG, satB, satW, count].
    var fine = new Array(256);
    for (var i = 0; i < 256; i++) fine[i] = [0, 0, 0, 0, 0, 0, 0, 0];
    for (var p = 0; p < data.length; p += 4) {
      if (data[p + 3] < 8) continue;
      var r = data[p], g = data[p + 1], b = data[p + 2];
      var L = Math.round(lum(r, g, b));
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      var sat = mx > 0 ? (mx - mn) / 255 : 0;     // chroma 0..1
      var f = fine[L];
      f[0] += r; f[1] += g; f[2] += b;
      f[3] += r * sat; f[4] += g * sat; f[5] += b * sat; f[6] += sat; f[7] += 1;
    }
    // plain per-bin mean (used only for empty-bin fallback)
    var avg = fine.map(function (f) { return f[7] ? [f[0] / f[7], f[1] / f[7], f[2] / f[7]] : null; });
    function nearest(idx) {
      for (var d = 0; d < 256; d++) {
        if (idx - d >= 0 && avg[idx - d]) return avg[idx - d];
        if (idx + d < 256 && avg[idx + d]) return avg[idx + d];
      }
      return [idx, idx, idx];
    }
    // robust luminance range of the image (ignore ~0.5% outliers at each end)
    // so the brightest/darkest stops land on tones the image actually contains
    var total = 0;
    for (var t = 0; t < 256; t++) total += fine[t][7];
    var Lmin = 0, Lmax = 255;
    if (total > 0) {
      var cut = total * 0.005, cum = 0;
      for (var lo = 0; lo < 256; lo++) { cum += fine[lo][7]; if (cum >= cut) { Lmin = lo; break; } }
      cum = 0;
      for (var hi = 255; hi >= 0; hi--) { cum += fine[hi][7]; if (cum >= cut) { Lmax = hi; break; } }
      if (Lmax <= Lmin) { Lmin = 0; Lmax = 255; }
    }
    // N stops spread across that range, color = windowed average, mapped to 0..1
    var stops = [];
    var half = Math.max(1, Math.round((Lmax - Lmin) / (2 * (N - 1))));
    for (var s = 0; s < N; s++) {
      var pos = s / (N - 1);                 // gradient position 0..1
      var center = Math.round(Lmin + pos * (Lmax - Lmin));
      var mR = 0, mG = 0, mB = 0, mN = 0;    // plain-mean accumulators
      var aR = 0, aG = 0, aB = 0, aW = 0;    // saturation-weighted accumulators
      for (var k = center - half; k <= center + half; k++) {
        if (k >= 0 && k < 256 && fine[k][7]) {
          var fk = fine[k];
          mR += fk[0]; mG += fk[1]; mB += fk[2]; mN += fk[7];
          aR += fk[3]; aG += fk[4]; aB += fk[5]; aW += fk[6];
        }
      }
      var meanCol = mN ? [mR / mN, mG / mN, mB / mN] : nearest(center);
      var accentCol = aW > 0.001 ? [aR / aW, aG / aW, aB / aW] : meanCol;
      var col = [
        meanCol[0] + (accentCol[0] - meanCol[0]) * accentMix,
        meanCol[1] + (accentCol[1] - meanCol[1]) * accentMix,
        meanCol[2] + (accentCol[2] - meanCol[2]) * accentMix
      ];
      stops.push({ pos: pos, col: col });
    }
    return stops;
  }

  // build a 256-entry smooth ramp from stops
  function buildRamp(stops) {
    var ramp = new Array(256);
    for (var i = 0; i < 256; i++) {
      var t = i / 255;
      // find bracketing stops
      var lo = stops[0], hi = stops[stops.length - 1];
      for (var s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s].pos && t <= stops[s + 1].pos) { lo = stops[s]; hi = stops[s + 1]; break; }
      }
      var span = hi.pos - lo.pos;
      var f = span > 0 ? (t - lo.pos) / span : 0;
      ramp[i] = [
        lo.col[0] + (hi.col[0] - lo.col[0]) * f,
        lo.col[1] + (hi.col[1] - lo.col[1]) * f,
        lo.col[2] + (hi.col[2] - lo.col[2]) * f
      ];
    }
    return ramp;
  }

  function recompute() {
    if (!state.img) return;
    els.controls.hidden = false;
    els.result.hidden = false;
    state.stops = analyze(parseInt(els.ncolors.value, 10), parseInt(els.accent.value, 10) / 100);
    var satAmt = parseInt(els.sat.value, 10) / 100;
    if (satAmt !== 1) {
      state.stops = state.stops.map(function (s) { return { pos: s.pos, col: saturate(s.col, satAmt) }; });
    }
    state.ramp = buildRamp(state.stops);
    drawOriginal();
    drawGradbar();
    drawSwatches();
    renderGraded();
  }

  function fitCanvas(canvas, iw, ih, maxW) {
    var scale = Math.min(1, maxW / iw);
    canvas.width = Math.round(iw * scale);
    canvas.height = Math.round(ih * scale);
    return scale;
  }

  function drawOriginal() {
    var im = state.img;
    fitCanvas(els.cOrig, im.width, im.height, 900);
    els.cOrig.getContext("2d").drawImage(im, 0, 0, els.cOrig.width, els.cOrig.height);
  }

  function renderGraded() {
    if (!state.ramp) return;
    var src = els.cOrig.getContext("2d").getImageData(0, 0, els.cOrig.width, els.cOrig.height);
    els.cGraded.width = els.cOrig.width; els.cGraded.height = els.cOrig.height;
    var out = els.cGraded.getContext("2d").createImageData(els.cGraded.width, els.cGraded.height);
    var blend = parseInt(els.blend.value, 10) / 100;
    var d = src.data, o = out.data;
    for (var p = 0; p < d.length; p += 4) {
      var L = Math.round(lum(d[p], d[p + 1], d[p + 2]));
      var c = state.ramp[L];
      o[p]     = c[0] * blend + d[p]     * (1 - blend);
      o[p + 1] = c[1] * blend + d[p + 1] * (1 - blend);
      o[p + 2] = c[2] * blend + d[p + 2] * (1 - blend);
      o[p + 3] = 255;
    }
    els.cGraded.getContext("2d").putImageData(out, 0, 0);
  }

  function drawGradbar() {
    var c = els.gradbar, ctx = c.getContext("2d");
    for (var x = 0; x < c.width; x++) {
      var col = state.ramp[Math.floor(x / c.width * 256)];
      ctx.fillStyle = "rgb(" + Math.round(col[0]) + "," + Math.round(col[1]) + "," + Math.round(col[2]) + ")";
      ctx.fillRect(x, 0, 1, c.height);
    }
  }

  function drawSwatches() {
    els.swatches.innerHTML = "";
    state.stops.forEach(function (st) {
      var c = st.col.map(Math.round);
      var div = document.createElement("div");
      div.className = "sw";
      div.innerHTML = '<div class="chip" style="background:rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')"></div><code>' + hex(c) + '</code>';
      els.swatches.appendChild(div);
    });
  }

  // ---- exports ----
  function download(filename, blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function buildCube(size) {
    var blend = parseInt(els.blend.value, 10) / 100;
    var lines = [
      "# Generated by gradient-map tool",
      'TITLE "' + state.name + '"',
      "LUT_3D_SIZE " + size,
      "DOMAIN_MIN 0.0 0.0 0.0",
      "DOMAIN_MAX 1.0 1.0 1.0"
    ];
    var n = size - 1;
    // .cube order: red varies fastest, then green, then blue
    for (var b = 0; b < size; b++) {
      for (var g = 0; g < size; g++) {
        for (var r = 0; r < size; r++) {
          var ri = r / n, gi = g / n, bi = b / n;
          var L = Math.round(lum(ri * 255, gi * 255, bi * 255));
          var c = state.ramp[L]; // 0..255
          var or_ = (c[0] / 255) * blend + ri * (1 - blend);
          var og = (c[1] / 255) * blend + gi * (1 - blend);
          var ob = (c[2] / 255) * blend + bi * (1 - blend);
          lines.push(or_.toFixed(6) + " " + og.toFixed(6) + " " + ob.toFixed(6));
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  els.dlCube.addEventListener("click", function () {
    if (!state.ramp) return;
    download(state.name + ".cube", new Blob([buildCube(33)], { type: "text/plain" }));
  });

  els.dlPng.addEventListener("click", function () {
    if (!state.ramp) return;
    var c = document.createElement("canvas");
    c.width = 1024; c.height = 128;
    var ctx = c.getContext("2d");
    for (var x = 0; x < c.width; x++) {
      var col = state.ramp[Math.floor(x / c.width * 256)];
      ctx.fillStyle = "rgb(" + Math.round(col[0]) + "," + Math.round(col[1]) + "," + Math.round(col[2]) + ")";
      ctx.fillRect(x, 0, 1, c.height);
    }
    c.toBlob(function (blob) { download(state.name + "-gradient.png", blob); });
  });

  els.copyHex.addEventListener("click", function () {
    if (!state.stops.length) return;
    var txt = state.stops.map(function (s) { return hex(s.col.map(Math.round)); }).join(", ");
    navigator.clipboard.writeText(txt).then(function () {
      els.copyHex.textContent = "Copied!";
      setTimeout(function () { els.copyHex.textContent = "Copy hex list"; }, 1200);
    });
  });
})();
