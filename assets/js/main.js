(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    /* Mobile navigation toggle */
    var toggle = document.querySelector(".nav-toggle");
    var links = document.getElementById("nav-links");
    if (toggle && links) {
      toggle.addEventListener("click", function () {
        var open = links.classList.toggle("open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }

    /* Current year in footer */
    var years = document.querySelectorAll("[data-year]");
    var year = String(new Date().getFullYear());
    years.forEach(function (el) {
      el.textContent = year;
    });

    /* Keep decorative animations out of the compositor's way while their
       element is far offscreen (the effect is unchanged when visible). */
    if ("IntersectionObserver" in window) {
      var pauseObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          entry.target.classList.toggle("is-paused", !entry.isIntersecting);
        });
      }, { rootMargin: "150px 0px" });
      [".hero-title", ".site-footer"].forEach(function (selector) {
        var target = document.querySelector(selector);
        if (target) {
          pauseObserver.observe(target);
        }
      });
    }

    /* Contact form: build a mailto link safely (no server, no injection surface) */
    var form = document.getElementById("contact-form");
    if (form) {
      var status = document.getElementById("form-status");

      form.addEventListener("submit", function (event) {
        event.preventDefault();

        var name = (form.elements.namedItem("name") || {}).value || "";
        var email = (form.elements.namedItem("email") || {}).value || "";
        var message = (form.elements.namedItem("message") || {}).value || "";

        name = name.trim();
        email = email.trim();
        message = message.trim();

        if (!name || !email || !message) {
          showStatus(status, "Please fill in every field before sending.");
          return;
        }

        var to = form.getAttribute("data-contact-email") || "";
        var subject = "Website enquiry from " + name;
        var body =
          "Name: " + name + "\n" +
          "Email: " + email + "\n\n" +
          message;

        var mailto =
          "mailto:" + encodeURIComponent(to) +
          "?subject=" + encodeURIComponent(subject) +
          "&body=" + encodeURIComponent(body);

        showStatus(status, "Opening your email client…");
        window.location.href = mailto;
      });
    }
    /* Scroll reveal (progressive enhancement) */
    var revealEls = document.querySelectorAll(".hero, .section, .card, .placeholder, .terminal");
    if ("IntersectionObserver" in window && revealEls.length) {
      var revealObserver = new IntersectionObserver(
        function (entries, obs) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("in");
              obs.unobserve(entry.target);
            }
          });
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
      );

      var viewportH = window.innerHeight || document.documentElement.clientHeight;

      revealEls.forEach(function (el) {
        /* Skip elements already in view so first paint never flashes */
        if (el.getBoundingClientRect().top < viewportH * 0.9) {
          return;
        }
        el.classList.add("reveal");
        revealObserver.observe(el);
      });
    }

    /* Terminal typing effect (safe: uses textContent only) */
    var term = document.querySelector("[data-terminal]");
    if (term) {
      var out = term.querySelector("[data-term-text]");
      var lines = (term.getAttribute("data-type") || "").split("|");
      var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      typeLines(out, lines.join("\n"), reduced);
    }
  });

  function typeLines(out, text, reduced) {
    if (!out) {
      return;
    }
    if (reduced) {
      out.textContent = text;
      var cursor = document.querySelector(".type-cursor");
      if (cursor) {
        cursor.hidden = true;
      }
      return;
    }
    var i = 0;
    var speed = 24;
    (function step() {
      if (i > text.length) {
        return;
      }
      out.textContent = text.slice(0, i);
      var last = text.charAt(i - 1);
      i++;
      setTimeout(step, last === "\n" ? 220 : speed);
    })();
  }

  function showStatus(el, text) {
    if (!el) {
      return;
    }
    el.textContent = text;
    el.hidden = false;
  }
})();
