/* <linkedin-certifications> — a small, read-only Certifications & Licenses
   side tab fed by data/linkedin.json.

   Usage:
     <linkedin-certifications data-src="data/linkedin.json"></linkedin-certifications>

   On wide screens the tab stays docked to the right edge of the viewport
   and opens a panel with the synced LinkedIn certifications. On narrow
   screens the same control becomes an inline, expandable section so it
   never covers the page content. If the data has no certifications the
   component renders nothing at all — no empty tab, no empty section.

   This component is DISPLAY ONLY. It never creates, edits, or deletes
   anything on LinkedIn, and it exposes no token or credentials.

   Security notes:
   - No innerHTML with data — every field is inserted with textContent,
     so nothing in the JSON can inject markup or script.
   - Fetches only the path given in data-src (same-origin; the site CSP's
     connect-src 'self' enforces this too). response.ok is checked and the
     JSON shape is validated before anything renders.
   - Every outbound link must be https: and gets target="_blank" with
     rel="noopener noreferrer"; anything else is left unlinked.
   - AbortController cancels in-flight requests when the element is
     removed from the DOM or data-src changes mid-flight.

   Rendering uses light DOM with .li-cert-* classes (see
   assets/css/linkedin-certifications.css). Shadow DOM is deliberately
   avoided: the site CSP's style-src 'self' (no unsafe-inline) would block
   the inline <style> a shadow root requires. */
(function () {
  "use strict";

  var instances = 0;

  class LinkedInCertifications extends HTMLElement {
    static get observedAttributes() {
      return ["data-src"];
    }

    constructor() {
      super();
      this._controller = null;
      this._open = false;
      this._tab = null;
      this._panel = null;
      this._closeBtn = null;
      this._onKeydown = this._onKeydown.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
    }

    connectedCallback() {
      this._load();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (oldValue === newValue) {
        return;
      }
      if (this.isConnected) {
        this._load();
      }
    }

    disconnectedCallback() {
      this._cancel();
      this._close(false);
    }

    _cancel() {
      if (this._controller) {
        this._controller.abort();
        this._controller = null;
      }
    }

    _load() {
      this._cancel();
      this._close(false);

      var src = (this.getAttribute("data-src") || "").trim();
      if (!src) {
        this.replaceChildren();
        return;
      }

      var controller = new AbortController();
      this._controller = controller;

      fetch(src, {
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        headers: { "Accept": "application/json" }
      })
        .then(function (response) {
          if (!response.ok) {
            throw new Error("HTTP " + response.status + " " + response.statusText);
          }
          return response.json();
        })
        .then(function (json) {
          if (controller.signal.aborted) {
            return;
          }
          this._render(json);
        }.bind(this))
        .catch(function () {
          /* The profile card already reports fetch/schema failures; the
             tab simply stays absent instead of duplicating the error. */
          if (!controller.signal.aborted) {
            this.replaceChildren();
          }
        }.bind(this));
    }

    /* ---------- Validation helpers ---------- */

    _string(value) {
      return typeof value === "string" ? value.trim() : "";
    }

    /* Outbound links: https: only. Anything else (http:, javascript:,
       data:, …) is rejected so the JSON can never smuggle a dangerous
       href onto the page. */
    _httpsUrl(raw) {
      var value = this._string(raw);
      if (!value) {
        return null;
      }
      try {
        var url = new URL(value, "https://www.linkedin.com");
        return url.protocol === "https:" ? url.href : null;
      } catch (error) {
        return null;
      }
    }

    _certifications(value) {
      if (!Array.isArray(value)) {
        return [];
      }
      return value
        .filter(function (entry) { return entry && typeof entry === "object"; })
        .map(function (entry) {
          return {
            title: typeof entry.title === "string" ? entry.title.trim() : "",
            issuer: typeof entry.issuer === "string" ? entry.issuer.trim() : "",
            issued: typeof entry.issued === "string" ? entry.issued.trim() : "",
            expires: typeof entry.expires === "string" ? entry.expires.trim() : "",
            credentialUrl: this._httpsUrl(entry.credentialUrl)
          };
        }, this)
        .filter(function (entry) { return entry.title; });
    }

    /* ---------- DOM helpers ---------- */

    _el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) {
        node.className = className;
      }
      if (text !== undefined) {
        node.textContent = text;
      }
      return node;
    }

    /* ---------- Rendering ---------- */

    _render(data) {
      var certifications = this._certifications(data && data.certifications);
      if (!certifications.length) {
        this.replaceChildren();
        return;
      }

      var profile = data && data.profile && typeof data.profile === "object" ? data.profile : {};
      var profileUrl = this._httpsUrl(profile.linkedin_url);
      var detailsUrl = profileUrl
        ? this._httpsUrl(profileUrl.replace(/\/+$/, "") + "/details/certifications/")
        : null;

      var id = "li-cert-" + (++instances);

      var tab = this._el("button", "li-cert-tab");
      tab.type = "button";
      tab.setAttribute("aria-expanded", "false");
      tab.setAttribute("aria-controls", id);
      tab.appendChild(this._el("span", "li-cert-tab-label", "Certifications"));
      tab.appendChild(
        this._el("span", "li-cert-tab-count", String(certifications.length))
      );
      tab.addEventListener("click", this._toggle.bind(this));

      var panel = this._el("aside", "li-cert-panel");
      panel.id = id;
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "false");
      panel.setAttribute("aria-labelledby", id + "-title");
      panel.setAttribute("aria-hidden", "true");

      var head = this._el("header", "li-cert-panel-head");
      var title = this._el("h2", "li-cert-panel-title", "Certifications & Licenses");
      title.id = id + "-title";
      head.appendChild(title);

      var close = this._el("button", "li-cert-close", "\u00d7");
      close.type = "button";
      close.setAttribute("aria-label", "Close certifications");
      close.addEventListener("click", this._close.bind(this, true));
      head.appendChild(close);
      panel.appendChild(head);

      var body = this._el("div", "li-cert-panel-body");
      var list = this._el("ul", "li-cert-list");
      certifications.forEach(function (entry) {
        list.appendChild(this._renderItem(entry));
      }, this);
      body.appendChild(list);
      panel.appendChild(body);

      if (detailsUrl) {
        var foot = this._el("footer", "li-cert-panel-foot");
        var all = this._el("a", "li-btn li-btn--ghost li-cert-all", "View all on LinkedIn \u2197");
        all.href = detailsUrl;
        all.target = "_blank";
        all.rel = "noopener noreferrer";
        foot.appendChild(all);
        panel.appendChild(foot);
      }

      this._tab = tab;
      this._panel = panel;
      this._closeBtn = close;
      this.replaceChildren(tab, panel);
    }

    _renderItem(entry) {
      var item = this._el("li", "li-cert-item");
      item.appendChild(this._el("p", "li-cert-name", entry.title));

      if (entry.issuer) {
        item.appendChild(this._el("p", "li-cert-issuer", entry.issuer));
      }

      var dates = [];
      if (entry.issued) {
        dates.push("Issued " + entry.issued);
      }
      if (entry.expires) {
        dates.push("Expires " + entry.expires);
      }
      if (dates.length) {
        item.appendChild(this._el("p", "li-cert-date", dates.join(" \u00b7 ")));
      }

      if (entry.credentialUrl) {
        var link = this._el("a", "li-cert-credential", "Show credential \u2197");
        link.href = entry.credentialUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.appendChild(link);
      }

      return item;
    }

    /* ---------- Open / close ---------- */

    _toggle() {
      if (this._open) {
        this._close(true);
      } else {
        this._openPanel();
      }
    }

    _openPanel() {
      if (!this._panel || !this._tab) {
        return;
      }
      this._open = true;
      this._panel.setAttribute("aria-hidden", "false");
      this._panel.setAttribute("data-open", "true");
      this._tab.setAttribute("aria-expanded", "true");
      document.addEventListener("keydown", this._onKeydown);
      document.addEventListener("pointerdown", this._onPointerDown, true);
      if (this._closeBtn) {
        /* Force the panel's new visibility to be applied before moving
           focus, so the close button is focusable right away. */
        void this._panel.offsetWidth;
        this._closeBtn.focus({ preventScroll: true });
      }
    }

    _close(returnFocus) {
      var wasOpen = this._open;
      this._open = false;
      this._removeListeners();

      if (!this._panel || !this._tab) {
        return;
      }

      this._panel.setAttribute("aria-hidden", "true");
      this._panel.removeAttribute("data-open");
      this._tab.setAttribute("aria-expanded", "false");

      if (returnFocus && wasOpen) {
        var active = document.activeElement;
        if (
          this._panel.contains(active) ||
          active === this._closeBtn ||
          active === document.body
        ) {
          this._tab.focus({ preventScroll: true });
        }
      }
    }

    _removeListeners() {
      document.removeEventListener("keydown", this._onKeydown);
      document.removeEventListener("pointerdown", this._onPointerDown, true);
    }

    _onKeydown(event) {
      if (event.key === "Escape" || event.key === "Esc") {
        event.preventDefault();
        this._close(true);
      }
    }

    _onPointerDown(event) {
      if (!this._open) {
        return;
      }
      if (
        (this._panel && this._panel.contains(event.target)) ||
        (this._tab && this._tab.contains(event.target))
      ) {
        return;
      }
      this._close(false);
    }
  }

  if (window.customElements && !window.customElements.get("linkedin-certifications")) {
    window.customElements.define("linkedin-certifications", LinkedInCertifications);
  }
})();
