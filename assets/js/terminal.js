/* Floating interactive shell (available on every page).
   A bottom-right help button toggles a terminal panel.
   Security: no eval, no network, no HTML injection — every line is written
   with textContent. Input length and output line count are capped. */
(function () {
  "use strict";

  var PROMPT = "user@zjacko.com:~$";
  var MAX_LINES = 250;
  var TYPE_SPEED = 6;
  var CHARS_PER_TICK = 2;
  var STORE_KEY = "zjacko.shell.v1";
  var CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var history = [];
  var histIndex = 0;
  var outputQueue = [];
  var typing = false;
  var gen = 0;
  var lines = [];
  var panelRef = null;
  var panelPos = null;
  var suppressFocus = false;
  var ignoreClick = false;
  var openLauncher = function () {};
  var closeLauncher = function () {};
  var placeLauncher = function () {};
  var savedState = loadState();

  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) {
        return null;
      }
      var data = JSON.parse(raw);
      if (!data || typeof data !== "object") {
        return null;
      }
      if (typeof data.ts === "number" && Date.now() - data.ts > CACHE_TTL_MS) {
        try { window.localStorage.removeItem(STORE_KEY); } catch (e) {}
        return null;
      }
      return data;
    } catch (error) {
      return null;
    }
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        open: !!(panelRef && panelRef.classList.contains("is-open")),
        lines: lines.slice(-MAX_LINES),
        history: history.slice(-50),
        pos: panelPos,
        ts: Date.now()
      }));
    } catch (error) {}
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function buildLauncher() {
    var panel = el("section", "shell-panel");
    panel.id = "shell-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Interactive terminal");
    panel.setAttribute("aria-hidden", "true");
    panel.inert = true;

    var bar = el("div", "terminal-bar");
    bar.title = "Drag to move";
    bar.appendChild(el("span"));
    bar.appendChild(el("span"));
    bar.appendChild(el("span"));
    bar.appendChild(el("em", null, PROMPT));

    var closeBtn = el("button", "shell-close", "\u00d7");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close terminal");
    bar.appendChild(closeBtn);

    var body = el("div", "shell-log");
    body.setAttribute("data-shell-log", "");
    body.setAttribute("role", "log");
    body.setAttribute("aria-live", "polite");
    body.setAttribute("aria-label", "Terminal output");

    var formEl = el("form", "shell-input-row");
    formEl.setAttribute("data-shell-form", "");

    var label = el("label", "shell-prompt", PROMPT);
    label.setAttribute("for", "shell-input");

    var inputEl = el("input", "shell-input");
    inputEl.id = "shell-input";
    inputEl.type = "text";
    inputEl.name = "cmd";
    inputEl.autocomplete = "off";
    inputEl.setAttribute("autocapitalize", "off");
    inputEl.setAttribute("autocorrect", "off");
    inputEl.setAttribute("spellcheck", "false");
    inputEl.setAttribute("maxlength", "200");
    inputEl.setAttribute("aria-label", "Terminal command input");

    formEl.appendChild(label);
    formEl.appendChild(inputEl);

    panel.appendChild(bar);
    panel.appendChild(body);
    panel.appendChild(formEl);

    var fab = el("button", "shell-fab", "?");
    fab.type = "button";
    fab.title = "Terminal help";
    fab.setAttribute("aria-expanded", "false");
    fab.setAttribute("aria-controls", "shell-panel");
    fab.setAttribute("aria-label", "Open terminal help");

    document.body.appendChild(panel);
    document.body.appendChild(fab);
    panelRef = panel;

    function setOpen(open, opts) {
      panel.classList.toggle("is-open", open);
      panel.setAttribute("aria-hidden", String(!open));
      panel.inert = !open;
      fab.classList.toggle("is-active", open);
      fab.textContent = open ? "\u00d7" : "?";
      fab.setAttribute("aria-expanded", String(open));
      fab.setAttribute("aria-label", open ? "Close terminal" : "Open terminal help");
      suppressFocus = !!(open && opts && opts.focus === false);

      if (open) {
        body.scrollTop = body.scrollHeight;
        if (!suppressFocus) {
          focusInput();
          window.setTimeout(focusInput, 260);
        }
      } else {
        fab.focus({ preventScroll: true });
      }
      saveState();
    }

    function focusInput() {
      if (!panel.classList.contains("is-open")) {
        return;
      }
      var active = document.activeElement;
      if (active && active !== document.body && active !== fab) {
        return;
      }
      inputEl.focus({ preventScroll: true });
    }

    var DRAG_MARGIN = 8;
    var drag = null;
    var resizeTimer = 0;

    function placePanel(x, y, width) {
      var maxWidth = Math.max(0, window.innerWidth - DRAG_MARGIN * 2);
      var w = Math.min(width || panel.offsetWidth, maxWidth);
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.width = w + "px";
      var h = panel.offsetHeight || 260;
      var minHeight = Math.min(260, Math.max(0, window.innerHeight - DRAG_MARGIN * 2));
      var maxLeft = Math.max(DRAG_MARGIN, window.innerWidth - w - DRAG_MARGIN);
      var maxTop = Math.max(DRAG_MARGIN, window.innerHeight - Math.max(h, minHeight) - DRAG_MARGIN);
      var left = Math.min(Math.max(x, DRAG_MARGIN), maxLeft);
      var top = Math.min(Math.max(y, DRAG_MARGIN), maxTop);
      var maxHeight = Math.min(560, window.innerHeight * 0.7, window.innerHeight - top - DRAG_MARGIN);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.maxHeight = Math.max(160, maxHeight) + "px";
      panelPos = { x: Math.round(left), y: Math.round(top), w: Math.round(w) };
      return panelPos;
    }

    placeLauncher = function (pos) {
      if (!pos) {
        return;
      }
      var x = Number(pos.x);
      var y = Number(pos.y);
      var w = Number(pos.w);
      if (!isFinite(x) || !isFinite(y)) {
        return;
      }
      placePanel(x, y, isFinite(w) ? w : undefined);
    };

    function endDrag(event) {
      if (!drag || (event && event.pointerId !== drag.id)) {
        return;
      }
      try {
        bar.releasePointerCapture(drag.id);
      } catch (error) {}
      if (drag.moved) {
        ignoreClick = true;
        window.setTimeout(function () {
          ignoreClick = false;
        }, 350);
      }
      drag = null;
      panel.classList.remove("is-dragging");
      document.body.classList.remove("shell-dragging");
      saveState();
    }

    bar.addEventListener("pointerdown", function (event) {
      if (!event.isPrimary || event.button !== 0) {
        return;
      }
      if (event.target && event.target.closest && event.target.closest(".shell-close")) {
        return;
      }
      var rect = panel.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        moved: false
      };
      panel.classList.add("is-dragging");
      document.body.classList.add("shell-dragging");
      try {
        bar.setPointerCapture(event.pointerId);
      } catch (error) {}
      event.preventDefault();
    });

    bar.addEventListener("pointermove", function (event) {
      if (!drag || event.pointerId !== drag.id) {
        return;
      }
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) {
        return;
      }
      drag.moved = true;
      placePanel(drag.left + dx, drag.top + dy, drag.width);
      event.preventDefault();
    });

    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", function () {
      if (drag) {
        endDrag();
      }
    });

    window.addEventListener("resize", function () {
      if (!panelPos) {
        return;
      }
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        if (panelPos) {
          placePanel(panelPos.x, panelPos.y, panelPos.w);
        }
      }, 80);
    });

    panel.addEventListener("transitionend", function (event) {
      if (event.target === panel && !suppressFocus) {
        focusInput();
      }
    });

    fab.addEventListener("click", function () {
      setOpen(!panel.classList.contains("is-open"));
    });

    closeBtn.addEventListener("click", function () {
      setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && panel.classList.contains("is-open")) {
        setOpen(false);
      }
    });

    openLauncher = function (options) {
      setOpen(true, options);
    };

    closeLauncher = function () {
      setOpen(false);
    };

    return panel;
  }

  var shell = document.querySelector("[data-shell]");
  if (!shell) {
    shell = buildLauncher();
  }
  if (!shell) {
    return;
  }

  var log = shell.querySelector("[data-shell-log]");
  var form = shell.querySelector("[data-shell-form]");
  var input = shell.querySelector(".shell-input");
  if (!log || !form || !input) {
    return;
  }

  var BANNER = [
    "zjacko.com // interactive shell",
    "Type -help to see available commands.",
    "Tip: Tab completes, Up/Down cycles history.",
    ""
  ];

  function normalizeCls(cls) {
    return cls === "cmd" || cls === "err" || cls === "muted" ? cls : null;
  }

  function append(text, cls) {
    var value = String(text);
    var kind = normalizeCls(cls);
    var line = document.createElement("span");
    line.className = "shell-line" + (kind ? " shell-line--" + kind : "");
    line.textContent = value;
    log.appendChild(line);
    lines.push({ text: value, cls: kind });
    trimLog();
    log.scrollTop = log.scrollHeight;
    saveState();
  }

  function trimLog() {
    while (log.childElementCount > MAX_LINES) {
      log.removeChild(log.firstChild);
      lines.shift();
    }
  }

  function enqueue(task) {
    task.gen = gen;
    outputQueue.push(task);
    pump();
  }

  function enqueueLines(out, cls) {
    if (out === null || out === undefined) {
      return;
    }
    var lines = Array.isArray(out) ? out : String(out).split("\n");
    lines.forEach(function (line) {
      enqueue({ text: String(line), cls: cls, instant: reduced });
    });
  }

  function pump() {
    if (typing || !outputQueue.length) {
      return;
    }
    var task = outputQueue.shift();
    if (task.gen !== gen) {
      pump();
      return;
    }
    if (task.instant) {
      append(task.text, task.cls);
      pump();
      return;
    }
    typing = true;
    typeLine(task.text, task.cls, function () {
      typing = false;
      pump();
    });
  }

  function typeLine(text, cls, done) {
    var myGen = gen;
    var value = String(text);
    var kind = normalizeCls(cls);
    var line = document.createElement("span");
    line.className = "shell-line" + (kind ? " shell-line--" + kind : "");
    line.textContent = "";
    log.appendChild(line);
    lines.push({ text: value, cls: kind });
    trimLog();
    log.scrollTop = log.scrollHeight;
    saveState();

    var i = 0;
    (function step() {
      if (myGen !== gen) {
        return;
      }
      i = Math.min(i + CHARS_PER_TICK, value.length);
      line.textContent = value.slice(0, i);
      log.scrollTop = log.scrollHeight;
      if (i < value.length) {
        window.setTimeout(step, TYPE_SPEED);
      } else {
        done();
      }
    })();
  }

  var commands = {};

  commands["-help"] = function () {
    return [
      "Available commands:",
      "  -help         show this list",
      "  whoami        who am I?",
      "  about         a little about Zach",
      "  skills        skills & tools",
      "  projects      where to find the work",
      "  contact       how to get in touch",
      "  security      security focus",
      "  web           web development focus",
      "  ls            list files",
      "  date          current date and time",
      "  echo <text>   print text back",
      "  history       recent commands",
      "  banner        show the banner",
      "  clear         clear the screen",
      "  coffee        you look like you need one",
      "  exit          close the terminal"
    ];
  };

  commands.help = commands["-help"];
  commands["--list"] = commands["-help"];

  commands.whoami = function () {
    return "user@zjacko.com — curious by default.";
  };

  commands.about = function () {
    return [
      "about.txt",
      "----------",
      "This is a placeholder for your background. Edit the",
      "commands.about handler in assets/js/terminal.js with your own text."
    ];
  };

  commands.skills = function () {
    return [
      "skills.txt",
      "----------",
      "Placeholder skills list. Replace this in assets/js/terminal.js",
      "with your languages, frameworks, and security tooling."
    ];
  };

  commands.projects = function () {
    return [
      "Selected work lives on the Projects page.",
      "  /projects.html  — in-depth writeups",
      "  /portfolio.html — quick overview"
    ];
  };

  commands.contact = function () {
    return [
      "Email: you@zjacko.com   (placeholder — update it)",
      "Or use the form:  /contact.html"
    ];
  };

  commands.security = function () {
    return [
      "security",
      "--------",
      "Placeholder: describe your security focus here.",
      "Edit commands.security in assets/js/terminal.js."
    ];
  };

  commands.web = function () {
    return [
      "web development",
      "---------------",
      "Placeholder: describe the sites and apps you build.",
      "Edit commands.web in assets/js/terminal.js."
    ];
  };

  commands.ls = function () {
    return [
      "about.txt   skills.txt   projects/   contact.txt   secret.txt",
      "Try:  cat secret.txt"
    ];
  };

  commands.cat = function (arg) {
    var file = arg.toLowerCase();
    if (file === "secret.txt") {
      return "Nice try. It wouldn't be a secret if it was readable.";
    }
    if (file === "about.txt") {
      return commands.about();
    }
    if (file === "skills.txt") {
      return commands.skills();
    }
    if (file === "contact.txt") {
      return commands.contact();
    }
    return "cat: " + (arg || "?") + ": no such file";
  };

  commands.date = function () {
    return new Date().toString();
  };

  commands.echo = function (arg) {
    return arg ? arg : "(nothing to echo)";
  };

  commands.history = function () {
    if (!history.length) {
      return "(no history yet)";
    }
    return history.map(function (cmd, i) {
      return "  " + (i + 1) + "  " + cmd;
    });
  };

  commands.banner = function () {
    return BANNER;
  };

  commands.clear = function () {
    gen++;
    outputQueue.length = 0;
    typing = false;
    log.textContent = "";
    lines.length = 0;
    saveState();
    return null;
  };

  commands.sudo = function () {
    return "Permission denied: only Zach has sudo here. Nice try, though.";
  };

  commands.coffee = function () {
    return [
      "      ( (",
      "       ) )",
      "    ........",
      "    |      |]",
      "    \\      /",
      "     `----'",
      "Brewing... done. Enjoy your fresh hot coffee!"
    ];
  };

  commands.exit = function () {
    closeLauncher();
    return "Closing terminal. Come back any time.";
  };

  function matchKeyword(text) {
    var map = [
      [/\b(who|name|identity)\b/, commands.whoami],
      [/\b(skill|stack|tech|language|tool|framework)\b/, commands.skills],
      [/\b(project|portfolio|built|build|work)\b/, commands.projects],
      [/\b(contact|email|reach|hire|available)\b/, commands.contact],
      [/\b(security|secure|cyber|hack|pentest|vuln)\b/, commands.security],
      [/\b(web|develop|frontend|backend|site|website)\b/, commands.web],
      [/\b(about|background|experience|you)\b/, commands.about]
    ];
    for (var i = 0; i < map.length; i++) {
      if (map[i][0].test(text)) {
        return map[i][1];
      }
    }
    return null;
  }

  function run(raw) {
    var trimmed = raw.trim();
    if (!trimmed) {
      return;
    }

    enqueue({ text: PROMPT + " " + trimmed, cls: "cmd", instant: true });
    history.push(trimmed);
    histIndex = history.length;
    saveState();

    var lower = trimmed.toLowerCase();
    var space = lower.indexOf(" ");
    var name = space === -1 ? lower : lower.slice(0, space);
    var arg = space === -1 ? "" : trimmed.slice(space + 1).trim();

    var handler = commands[name];
    if (!handler) {
      handler = matchKeyword(lower);
    }

    if (handler) {
      enqueueLines(handler(arg, trimmed));
    } else {
      enqueue({ text: "command not found: " + name, cls: "err", instant: reduced });
      enqueue({ text: "Type -help to see available commands.", cls: "muted", instant: reduced });
    }
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var value = input.value;
    input.value = "";
    run(value);
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!history.length) {
        return;
      }
      histIndex = Math.max(0, histIndex - 1);
      input.value = history[histIndex];
      moveCaretEnd();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!history.length) {
        return;
      }
      histIndex = Math.min(history.length, histIndex + 1);
      input.value = histIndex >= history.length ? "" : history[histIndex];
      moveCaretEnd();
    } else if (event.key === "Tab") {
      complete(event);
    }
  });

  function moveCaretEnd() {
    setTimeout(function () {
      var len = input.value.length;
      input.setSelectionRange(len, len);
    }, 0);
  }

  function complete(event) {
    var value = input.value.toLowerCase();
    if (!value) {
      return;
    }
    var keys = Object.keys(commands);
    var matches = keys.filter(function (key) {
      return key.indexOf(value) === 0;
    });
    if (matches.length === 1) {
      event.preventDefault();
      input.value = matches[0] + " ";
    } else if (matches.length > 1) {
      event.preventDefault();
      append(matches.join("   "), "muted");
    }
  }

  shell.addEventListener("click", function () {
    if (ignoreClick) {
      return;
    }
    if (String(window.getSelection()) === "") {
      input.focus();
    }
  });

  if (savedState && Array.isArray(savedState.history)) {
    history = savedState.history.filter(function (item) {
      return typeof item === "string";
    }).slice(-50);
    histIndex = history.length;
  }

  if (savedState && Array.isArray(savedState.lines)) {
    savedState.lines.slice(-MAX_LINES).forEach(function (entry) {
      if (!entry || typeof entry.text !== "string") {
        return;
      }
      var kind = normalizeCls(entry.cls);
      var restored = document.createElement("span");
      restored.className = "shell-line" + (kind ? " shell-line--" + kind : "");
      restored.textContent = entry.text;
      log.appendChild(restored);
      lines.push({ text: entry.text, cls: kind });
    });
    trimLog();
    log.scrollTop = log.scrollHeight;
  } else {
    BANNER.forEach(function (line) {
      append(line);
    });
  }

  if (savedState && savedState.pos) {
    placeLauncher(savedState.pos);
  }

  if (savedState && savedState.open) {
    openLauncher({ focus: false });
  }

  window.addEventListener("pagehide", saveState);
})();
