/* Double-click nebula burst.
   Click empty space and a colourful cloud of stars, rings and dust blooms
   from the pointer. Reduced-motion users get a brief, still bloom instead
   of the full particle burst. */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var canvas = document.createElement("canvas");
  canvas.className = "bg-burst";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);

  var ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  var w = 0;
  var h = 0;
  var bursts = [];
  var rafId = null;
  var lastTime = 0;

  var HUES = [188, 206, 228, 262, 292, 322, 348, 24];

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function pick(arr) {
    return arr[(Math.random() * arr.length) | 0];
  }

  function hsla(hue, sat, light, alpha) {
    return "hsla(" + hue.toFixed(0) + "," + sat + "%," + light + "%," + alpha.toFixed(3) + ")";
  }

  function sizeCanvas() {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(x, y) {
    var now = performance.now();
    var baseHue = pick(HUES);
    var palette = [
      baseHue,
      (baseHue + 28) % 360,
      (baseHue + 62) % 360,
      (baseHue + 142) % 360,
      (baseHue + 208) % 360,
      (baseHue + 300) % 360
    ];
    var duration = reduced ? 850 : 1900;
    var particles = [];
    var puffs = [];
    var rings = [];
    var i;

    if (!reduced) {
      var count = 70 + ((Math.random() * 40) | 0);
      for (i = 0; i < count; i++) {
        var angle = Math.random() * Math.PI * 2;
        var speed = 80 + Math.pow(Math.random(), 0.55) * 340;
        particles.push({
          x: 0,
          y: 0,
          px: 0,
          py: 0,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          hue: pick(palette) + rand(-10, 10),
          size: rand(0.8, 2.6),
          drag: rand(0.88, 0.95),
          life: rand(700, 1500)
        });
      }
    }

    var puffCount = reduced ? 3 : 8;
    for (i = 0; i < puffCount; i++) {
      var puffAngle = Math.random() * Math.PI * 2;
      var puffSpeed = reduced ? 0 : rand(18, 110);
      puffs.push({
        x: 0,
        y: 0,
        vx: Math.cos(puffAngle) * puffSpeed,
        vy: Math.sin(puffAngle) * puffSpeed,
        hue: pick(palette),
        size: rand(70, 170),
        squash: rand(0.55, 1.15),
        spin: rand(-0.6, 0.6),
        delay: reduced ? 0 : rand(0, 130),
        life: reduced ? 850 : rand(1000, 1750)
      });
    }

    if (!reduced) {
      for (i = 0; i < 3; i++) {
        rings.push({
          hue: pick(palette),
          delay: i * 70,
          life: rand(700, 1100),
          size: rand(150, 280)
        });
      }
    }

    bursts.push({
      x: x,
      y: y,
      start: now,
      duration: duration,
      baseHue: baseHue,
      palette: palette,
      particles: particles,
      puffs: puffs,
      rings: rings
    });
  }

  function drawCore(burst, t) {
    var fade = Math.max(0, 1 - t);
    var radius = 26 + t * 120;
    var g = ctx.createRadialGradient(burst.x, burst.y, 0, burst.x, burst.y, radius);
    g.addColorStop(0, hsla(burst.baseHue, 100, 92, fade * 0.55));
    g.addColorStop(0.25, hsla(burst.palette[2], 95, 70, fade * 0.3));
    g.addColorStop(1, hsla(burst.palette[1], 95, 65, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(burst.x, burst.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPuffs(burst, age, dt) {
    for (var i = 0; i < burst.puffs.length; i++) {
      var p = burst.puffs[i];
      var local = (age - p.delay) / p.life;
      if (local < 0 || local > 1) {
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;

      var x = burst.x + p.x;
      var y = burst.y + p.y;
      var radius = p.size * (0.45 + local * 1.35);
      var alpha = Math.sin(local * Math.PI) * 0.2;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.spin * local);
      ctx.scale(1, p.squash);
      var g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      g.addColorStop(0, hsla(p.hue, 95, 74, alpha));
      g.addColorStop(0.35, hsla(p.hue, 90, 62, alpha * 0.55));
      g.addColorStop(1, hsla(p.hue, 90, 55, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawParticles(burst, age, dt) {
    for (var i = 0; i < burst.particles.length; i++) {
      var p = burst.particles[i];
      if (age > p.life) {
        continue;
      }

      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= p.drag;
      p.vy *= p.drag;

      var alpha = Math.max(0, 1 - age / p.life);
      var x = burst.x + p.x;
      var y = burst.y + p.y;
      var px = burst.x + p.px;
      var py = burst.y + p.py;

      ctx.strokeStyle = hsla(p.hue, 95, 72, alpha * 0.7);
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = hsla(p.hue, 100, 85, alpha);
      ctx.beginPath();
      ctx.arc(x, y, p.size * 0.75, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawRings(burst, age) {
    for (var i = 0; i < burst.rings.length; i++) {
      var r = burst.rings[i];
      var local = (age - r.delay) / r.life;
      if (local < 0 || local > 1) {
        continue;
      }

      var eased = 1 - Math.pow(1 - local, 3);
      var alpha = Math.max(0, 1 - local) * 0.55;
      ctx.strokeStyle = hsla(r.hue, 95, 72, alpha);
      ctx.lineWidth = Math.max(0.4, 2.2 * (1 - local));
      ctx.beginPath();
      ctx.arc(burst.x, burst.y, 12 + r.size * eased, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function render(now) {
    var dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    for (var i = bursts.length - 1; i >= 0; i--) {
      var burst = bursts[i];
      var age = now - burst.start;
      var t = age / burst.duration;

      if (t >= 1) {
        bursts.splice(i, 1);
        continue;
      }

      drawCore(burst, t);
      drawPuffs(burst, age, dt);
      drawParticles(burst, age, dt);
      drawRings(burst, age);
    }

    ctx.globalCompositeOperation = "source-over";

    if (bursts.length) {
      rafId = window.requestAnimationFrame(render);
    } else {
      rafId = null;
      ctx.clearRect(0, 0, w, h);
    }
  }

  function start() {
    if (rafId !== null) {
      return;
    }
    lastTime = performance.now();
    rafId = window.requestAnimationFrame(render);
  }

  function stop() {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    bursts.length = 0;
    ctx.clearRect(0, 0, w, h);
  }

  function isInteractive(target) {
    var el = target instanceof Element ? target : target && target.parentElement;
    if (!el) {
      return true;
    }
    return !!el.closest(
      "a, button, input, textarea, select, label, summary, pre, code, p, h1, h2, h3, li, img, .terminal, .card, .btn, .shell-panel, .shell-fab"
    );
  }

  document.addEventListener(
    "dblclick",
    function (event) {
      if (event.defaultPrevented || event.button !== 0) {
        return;
      }
      if (isInteractive(event.target)) {
        return;
      }
      spawn(event.clientX, event.clientY);
      start();
    },
    { passive: true }
  );

  window.addEventListener("resize", function () {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    sizeCanvas();
  }, { passive: true });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stop();
    }
  });

  sizeCanvas();
})();
