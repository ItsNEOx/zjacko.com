/* Randomized nebula backdrop.
   Painted once per load (and on resize) into a fixed canvas, then gently
   animated with CSS. Colours, cloud shapes and star placement are random,
   so the sky is different every visit. Motion is handled by CSS and is
   disabled automatically for prefers-reduced-motion. */
(function () {
  "use strict";

  var canvas = document.createElement("canvas");
  canvas.className = "bg-nebula";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);

  var ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  var DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  var w = 0;
  var h = 0;

  var PALETTE = [
    [124, 92, 255],   /* violet */
    [255, 79, 216],   /* magenta */
    [51, 214, 255],   /* cyan */
    [79, 124, 255],   /* blue */
    [255, 107, 181],  /* pink */
    [176, 107, 255],  /* purple */
    [53, 224, 192],   /* teal */
    [255, 176, 102]   /* amber */
  ];

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function pick(arr) {
    return arr[(Math.random() * arr.length) | 0];
  }

  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }

  function rgbaShift(c, amt, a) {
    var r = Math.max(0, Math.min(255, c[0] + amt)) | 0;
    var g = Math.max(0, Math.min(255, c[1] + amt)) | 0;
    var b = Math.max(0, Math.min(255, c[2] + amt)) | 0;
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  function sizeCanvas() {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * DPR);
    canvas.height = Math.floor(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function drawBand(angle, color, alpha, thickness) {
    var cx = w * rand(0.35, 0.65);
    var cy = h * rand(0.3, 0.7);
    var len = Math.max(w, h) * rand(1.1, 1.5);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(1, thickness);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, len);
    g.addColorStop(0, rgbaShift(color, 40, alpha));
    g.addColorStop(0.35, rgba(color, alpha * 0.55));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, len, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawCloud(cx, cy, radius, color, alpha, squash) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, squash);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    g.addColorStop(0, rgbaShift(color, 55, alpha));
    g.addColorStop(0.22, rgbaShift(color, 20, alpha * 0.8));
    g.addColorStop(0.55, rgba(color, alpha * 0.35));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function makeNoise(size) {
    var n = document.createElement("canvas");
    n.width = size;
    n.height = size;
    var nctx = n.getContext("2d");
    var img = nctx.createImageData(size, size);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var v = 96 + ((Math.random() * 64) | 0);
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
    nctx.putImageData(img, 0, 0);
    return n;
  }

  function drawStars(count) {
    for (var i = 0; i < count; i++) {
      var x = Math.random() * w;
      var y = Math.random() * h;
      var r = rand(0.3, 1.1);
      var t = Math.random();
      var col = t > 0.75 ? [190, 210, 255] : (t > 0.5 ? [210, 190, 255] : [255, 255, 255]);
      ctx.fillStyle = rgba(col, rand(0.25, 0.9));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      if (Math.random() > 0.94) {
        var glow = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
        glow.addColorStop(0, rgba(col, 0.3));
        glow.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function paint() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    /* Milky-way bands */
    drawBand(rand(-0.55, -0.25), pick(PALETTE), rand(0.1, 0.16), rand(0.22, 0.34));
    drawBand(rand(-0.5, -0.2), pick(PALETTE), rand(0.07, 0.12), rand(0.18, 0.3));

    /* Nebula clouds, biased toward the edges so content stays legible */
    var count = 8 + ((Math.random() * 4) | 0);
    for (var i = 0; i < count; i++) {
      var cx;
      if (Math.random() > 0.45) {
        cx = (Math.random() > 0.5 ? rand(-0.1, 0.28) : rand(0.72, 1.1)) * w;
      } else {
        cx = rand(0.05, 0.95) * w;
      }
      var cy = Math.random() * h;
      var radius = Math.max(w, h) * rand(0.16, 0.4);
      var color = pick(PALETTE);
      var alpha = rand(0.16, 0.34);
      drawCloud(cx, cy, radius, color, alpha, rand(0.55, 1.25));

      if (Math.random() > 0.4) {
        drawCloud(
          cx + rand(-0.14, 0.14) * w,
          cy + rand(-0.14, 0.14) * h,
          radius * rand(0.45, 0.75),
          pick(PALETTE),
          alpha * rand(0.5, 0.85),
          rand(0.6, 1.2)
        );
      }
    }

    /* Dust lanes: soft dark rifts through the glow */
    ctx.globalCompositeOperation = "source-over";
    for (var d = 0; d < 4; d++) {
      var dx = Math.random() * w;
      var dy = Math.random() * h;
      var dr = Math.max(w, h) * rand(0.1, 0.28);
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(rand(-0.6, 0.6));
      ctx.scale(1, rand(0.25, 0.55));
      var dust = ctx.createRadialGradient(0, 0, 0, 0, 0, dr);
      dust.addColorStop(0, "rgba(7,4,18," + rand(0.1, 0.22) + ")");
      dust.addColorStop(1, "rgba(7,4,18,0)");
      ctx.fillStyle = dust;
      ctx.beginPath();
      ctx.arc(0, 0, dr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /* Fine grain for texture, clipped to the existing glow so it does not
       veil the whole viewport. */
    var noise = makeNoise(256);
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = rand(0.06, 0.11);
    ctx.fillStyle = ctx.createPattern(noise, "repeat");
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    /* Distant stars */
    ctx.globalCompositeOperation = "lighter";
    drawStars(Math.min(160, Math.round((w * h) / 12000)));

    ctx.globalCompositeOperation = "source-over";
  }

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(function () {
      DPR = Math.min(window.devicePixelRatio || 1, 1.5);
      sizeCanvas();
      paint();
    }, 160);
  }, { passive: true });

  sizeCanvas();
  paint();
})();
