/* Live background: particle network on a fixed canvas.
   Guardrails: particle count + devicePixelRatio are capped, the loop pauses
   when the tab is hidden, and motion is disabled for prefers-reduced-motion. */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var canvas = document.createElement("canvas");
  canvas.className = "bg-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);

  var ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  var COLOR = "138, 122, 232";
  var MAX_LINK = 132;
  var MOUSE_RADIUS = 175;

  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = 0;
  var h = 0;
  var particles = [];
  var mouse = { x: -9999, y: -9999, active: false };
  var rafId = null;
  var running = false;

  function sizeCanvas() {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeParticles() {
    var target = Math.round((w * h) / 22000);
    target = Math.max(36, Math.min(target, 120));
    particles = [];
    for (var i = 0; i < target; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.4 + 0.6
      });
    }
  }

  function render() {
    ctx.clearRect(0, 0, w, h);

    var i, j, a, b, dx, dy, d2, alpha;

    for (i = 0; i < particles.length; i++) {
      a = particles[i];
      a.x += a.vx;
      a.y += a.vy;

      if (a.x < 0) { a.x = 0; a.vx *= -1; }
      else if (a.x > w) { a.x = w; a.vx *= -1; }
      if (a.y < 0) { a.y = 0; a.vy *= -1; }
      else if (a.y > h) { a.y = h; a.vy *= -1; }

      if (mouse.active) {
        var mdx = mouse.x - a.x;
        var mdy = mouse.y - a.y;
        var md = Math.sqrt(mdx * mdx + mdy * mdy);
        if (md < MOUSE_RADIUS && md > 0.001) {
          var force = (1 - md / MOUSE_RADIUS) * 0.06;
          a.x += (mdx / md) * force;
          a.y += (mdy / md) * force;
        }
      }
    }

    for (i = 0; i < particles.length; i++) {
      a = particles[i];
      for (j = i + 1; j < particles.length; j++) {
        b = particles[j];
        dx = a.x - b.x;
        dy = a.y - b.y;
        d2 = dx * dx + dy * dy;
        if (d2 < MAX_LINK * MAX_LINK) {
          alpha = (1 - Math.sqrt(d2) / MAX_LINK) * 0.45;
          ctx.strokeStyle = "rgba(" + COLOR + "," + alpha.toFixed(3) + ")";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    for (i = 0; i < particles.length; i++) {
      a = particles[i];
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(" + COLOR + ",0.75)";
      ctx.fill();
    }

    if (mouse.active) {
      /* Faint rainbow strands: each strand gets its own hue, slowly rotating. */
      var hueBase = (performance.now() / 40) % 360;
      for (i = 0; i < particles.length; i++) {
        a = particles[i];
        var cx = a.x - mouse.x;
        var cy = a.y - mouse.y;
        var cd = Math.sqrt(cx * cx + cy * cy);
        if (cd < MOUSE_RADIUS) {
          alpha = (1 - cd / MOUSE_RADIUS) * 0.55;
          var hue = (hueBase + (i / particles.length) * 360) % 360;
          ctx.strokeStyle = "hsla(" + hue.toFixed(0) + ",85%,68%," + alpha.toFixed(3) + ")";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + hueBase.toFixed(0) + ",85%,80%,0.9)";
      ctx.fill();
    }
  }

  function loop() {
    render();
    rafId = window.requestAnimationFrame(loop);
  }

  function start() {
    if (running || reduced) {
      return;
    }
    running = true;
    rafId = window.requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  var resizeTimer = null;
  function onResize() {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(function () {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeCanvas();
      makeParticles();
      render();
    }, 150);
  }

  if (!reduced) {
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    });

    /* Cursor interaction only for real pointers (mouse/trackpad).
       Touch devices never get a "mouse" position, so skip it there. */
    var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (finePointer) {
      window.addEventListener("pointermove", function (e) {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouse.active = true;
      }, { passive: true });

      document.addEventListener("pointerleave", function () {
        mouse.active = false;
      });
    }
  }

  window.addEventListener("resize", onResize, { passive: true });

  sizeCanvas();
  makeParticles();
  render();
  start();
})();
