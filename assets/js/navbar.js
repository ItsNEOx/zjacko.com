/* Quantum navbar glider: slides the glowing active pill behind nav
   links — hover/focus moves it, it springs back to the current page's
   link. Progressive enhancement: with JS off (or before it runs) the
   current link keeps its static highlight, see styles.css. */
(function () {
  "use strict";

  var nav = document.querySelector(".nav");
  var glider = document.querySelector(".nav-glider");
  var list = document.querySelector(".nav-links");

  if (!nav || !glider || !list) {
    return;
  }

  var links = list.querySelectorAll("a");
  var current = null;

  function place(link) {
    var base = nav.getBoundingClientRect();
    var rect = link.getBoundingClientRect();
    glider.style.width = rect.width + "px";
    glider.style.height = rect.height + "px";
    /* The glider is absolutely positioned from the nav's padding box,
       so subtract the border width to land exactly under the link. */
    var x = rect.left - base.left - nav.clientLeft;
    var y = rect.top - base.top - nav.clientTop;
    glider.style.transform = "translate(" + x + "px, " + y + "px)";
    glider.classList.add("ready");
  }

  function reset() {
    if (current) {
      place(current);
    } else {
      glider.classList.remove("ready");
    }
  }

  Array.prototype.forEach.call(links, function (link) {
    if (link.getAttribute("aria-current") === "page") {
      current = link;
    }
    link.addEventListener("mouseenter", function () {
      place(link);
    });
    link.addEventListener("focus", function () {
      place(link);
    });
  });

  nav.addEventListener("mouseleave", reset);
  window.addEventListener("resize", reset);
  window.addEventListener("load", reset);

  reset();
})();
