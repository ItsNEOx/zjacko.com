/* <linkedin-card> — a lightweight Web Component that renders a profile card
   from a local JSON file.

   Usage:
     <linkedin-card data-src="data/linkedin.json"></linkedin-card>

   The card renders from data/linkedin.json — a static, same-origin
   file, so it works on any host with no backend. To show your profile
   picture, set profile.avatar in that file to a local image path
   (e.g. /assets/linkedin/avatar.png) or a data: URI; when it is empty
   the initials avatar is used instead.

   This component is read-only display only — nothing on this site can
   publish to LinkedIn.

   Security notes:
   - No innerHTML with data — every field is inserted with textContent,
     so nothing in the JSON can inject markup or script.
   - Fetches only the path given in data-src (same-origin; the site
     CSP's connect-src 'self' enforces this too). response.ok is
     checked and the JSON shape is validated before anything renders.
   - Outbound profile links must be https: and always get
     rel="noopener noreferrer".
   - Avatar images must be relative paths or data: URIs — anything with a
     scheme (http:, file:, ...) or protocol-relative // is rejected and the
     initials fallback is used instead. The site CSP's img-src 'self' data:
     backs this up.
   - AbortController cancels in-flight requests when the element is removed
     from the DOM or an attribute changes mid-flight.

   Rendering uses light DOM with .li-* scoped classes (see
   assets/css/linkedin-card.css). Shadow DOM is deliberately avoided: the
   site CSP's style-src 'self' (no unsafe-inline) would block the inline
   <style> a shadow root requires. */
(function () {
  "use strict";

  class LinkedInCard extends HTMLElement {
    static get observedAttributes() {
      return ["data-src"];
    }

    constructor() {
      super();
      this._controller = null;
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
    }

    _cancel() {
      if (this._controller) {
        this._controller.abort();
        this._controller = null;
      }
    }

    _load() {
      this._cancel();

      var src = (this.getAttribute("data-src") || "").trim();
      if (!src) {
        this._renderError(
          'Missing data-src attribute — point it at a JSON file, e.g. data-src="data/linkedin.json".'
        );
        return;
      }

      this._renderLoading();

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
          try {
            this._renderCard(json);
          } catch (error) {
            this._renderError("Profile data is malformed — check the JSON file.");
          }
        }.bind(this))
        .catch(function (error) {
          if (controller.signal.aborted) {
            return;
          }
          this._renderError('Could not load "' + src + '" — ' + error.message);
        }.bind(this));
    }

    /* ---------- Validation helpers ---------- */

    _string(value) {
      return typeof value === "string" ? value.trim() : "";
    }

    _stringArray(value) {
      if (!Array.isArray(value)) {
        return [];
      }
      return value
        .filter(function (item) { return typeof item === "string" && item.trim(); })
        .map(function (item) { return item.trim(); });
    }

    _experience(value) {
      if (!Array.isArray(value)) {
        return [];
      }
      return value
        .filter(function (entry) { return entry && typeof entry === "object"; })
        .map(function (entry) {
          return {
            role: typeof entry.role === "string" ? entry.role.trim() : "",
            company: typeof entry.company === "string" ? entry.company.trim() : "",
            period: typeof entry.period === "string" ? entry.period.trim() : "",
            description: typeof entry.description === "string" ? entry.description.trim() : ""
          };
        })
        .filter(function (entry) { return entry.role || entry.company || entry.description; });
    }

    /* Outbound links: https: only. Anything else (http:, javascript:, data:)
       is rejected so the JSON can never smuggle a dangerous href onto the page. */
    _httpsUrl(raw) {
      var value = this._string(raw);
      if (!value) {
        return null;
      }
      try {
        var url = new URL(value, "https://zjacko.com");
        if (url.protocol === "https:") {
          return url.href;
        }
      } catch (error) {}
      return null;
    }

    /* Avatars: relative site paths or data: image URIs only. */
    _avatarUrl(raw) {
      var value = this._string(raw);
      if (!value) {
        return null;
      }
      if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
        return value;
      }
      if (value.indexOf("//") === 0 || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
        return null; /* protocol-relative or any other scheme */
      }
      if (value.indexOf("..") !== -1) {
        return null; /* no path traversal */
      }
      return value;
    }

    _initials(name) {
      var parts = name.split(/\s+/).filter(Boolean);
      var first = parts.length ? parts[0].charAt(0) : "";
      var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
      return (first + last).toUpperCase() || "?";
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

    /* ---------- States ---------- */

    _renderLoading() {
      var card = this._el("div", "li-card li-card--loading");
      card.setAttribute("aria-busy", "true");
      card.setAttribute("aria-live", "polite");

      var header = this._el("div", "li-header");
      var avatar = this._el("div", "li-avatar li-avatar--skeleton");
      var id = this._el("div", "li-id");
      id.appendChild(this._el("div", "li-skeleton li-skeleton--name"));
      id.appendChild(this._el("div", "li-skeleton li-skeleton--line"));
      header.appendChild(avatar);
      header.appendChild(id);
      card.appendChild(header);

      var body = this._el("div", "li-body");
      body.appendChild(this._el("span", "li-visually-hidden", "Loading profile…"));
      for (var i = 0; i < 3; i++) {
        body.appendChild(this._el("div", "li-skeleton li-skeleton--line"));
      }
      card.appendChild(body);

      this.replaceChildren(card);
    }

    _renderError(message) {
      var card = this._el("div", "li-card li-card--error");
      card.setAttribute("role", "alert");
      card.appendChild(this._el("h2", "li-error-title", "Profile unavailable"));
      card.appendChild(this._el("p", "li-error-text", message));
      card.appendChild(
        this._el("p", "li-error-hint",
          "If you opened this page straight from a folder (file://), fetch() " +
          "is blocked by the browser — serve the site over HTTP(S) instead.")
      );
      this.replaceChildren(card);
    }

    _renderCard(data) {
      if (!data || typeof data !== "object") {
        throw new Error("not an object");
      }

      var profile = (data.profile && typeof data.profile === "object") ? data.profile : {};
      var name = this._string(profile.name) || "Unnamed";
      var headline = this._string(profile.headline);
      var company = this._string(profile.company);
      var location = this._string(profile.location);
      var summary = this._string(profile.summary);
      var skills = this._stringArray(data.skills);
      var experience = this._experience(data.experience);
      var profileUrl = this._httpsUrl(profile.linkedin_url);
      var avatarUrl = this._avatarUrl(profile.avatar);

      var card = this._el("article", "li-card");

      /* Header: avatar + identity */
      var header = this._el("header", "li-header");

      var avatarWrap = this._el("div", "li-avatar", this._initials(name));
      avatarWrap.setAttribute("role", "img");
      avatarWrap.setAttribute("aria-label", "Avatar for " + name);
      if (avatarUrl) {
        /* The picture is appended right away, layered over the initials,
           and revealed once it actually loads — a broken or blocked
           image never shows a broken-image icon. (It must be attached
           immediately: a loading="lazy" image that is not in the
           document is never fetched, so inserting it only on "load"
           would deadlock.) */
        var img = document.createElement("img");
        img.className = "li-avatar-img";
        img.alt = "";
        img.decoding = "async";
        img.addEventListener("load", function () {
          img.classList.add("li-avatar-img--loaded");
        });
        img.addEventListener("error", function () {
          if (img.parentNode) {
            img.parentNode.removeChild(img);
          }
        });
        avatarWrap.appendChild(img);
        img.src = avatarUrl;
      }
      header.appendChild(avatarWrap);

      var idBlock = this._el("div", "li-id");
      idBlock.appendChild(this._el("h2", "li-name", name));
      if (headline) {
        idBlock.appendChild(this._el("p", "li-headline", headline));
      }
      if (company) {
        idBlock.appendChild(this._el("p", "li-profile-company", company));
      }
      if (location) {
        idBlock.appendChild(this._el("p", "li-location", location));
      }
      header.appendChild(idBlock);
      card.appendChild(header);

      /* Summary */
      if (summary) {
        var about = this._el("section", "li-summary");
        about.setAttribute("aria-label", "Summary");
        about.appendChild(this._el("h3", "li-section-title", "About"));
        about.appendChild(this._el("p", "li-summary-text", summary));
        card.appendChild(about);
      }

      /* Skills */
      var skillsSection = this._el("section", "li-skills");
      skillsSection.setAttribute("aria-label", "Skills");
      skillsSection.appendChild(this._el("h3", "li-section-title", "Skills"));
      if (skills.length) {
        var list = this._el("ul", "li-skill-list");
        skills.forEach(function (skill) {
          list.appendChild(this._el("li", "li-skill", skill));
        }, this);
        skillsSection.appendChild(list);
      } else {
        skillsSection.appendChild(this._el("p", "li-empty", "No skills listed yet."));
      }
      card.appendChild(skillsSection);

      /* Experience timeline */
      var timeline = this._el("section", "li-timeline");
      timeline.setAttribute("aria-label", "Experience");
      timeline.appendChild(this._el("h3", "li-section-title", "Experience"));
      if (experience.length) {
        var entries = this._el("ol", "li-timeline-list");
        experience.forEach(function (entry) {
          var item = this._el("li", "li-timeline-item");
          if (entry.role) {
            item.appendChild(this._el("p", "li-role", entry.role));
          }
          if (entry.company) {
            item.appendChild(this._el("p", "li-company", entry.company));
          }
          if (entry.period) {
            item.appendChild(this._el("p", "li-period", entry.period));
          }
          if (entry.description) {
            item.appendChild(this._el("p", "li-desc", entry.description));
          }
          entries.appendChild(item);
        }, this);
        timeline.appendChild(entries);
      } else {
        timeline.appendChild(this._el("p", "li-empty", "No experience listed yet."));
      }
      card.appendChild(timeline);

      /* Actions: profile link (the site is read-only — no publishing here) */
      if (profileUrl) {
        var actions = this._el("footer", "li-actions");
        var btn = this._el("a", "li-btn", "View LinkedIn profile \u2197");
        btn.href = profileUrl;
        btn.target = "_blank";
        btn.rel = "noopener noreferrer";
        actions.appendChild(btn);
        card.appendChild(actions);
      }

      this.replaceChildren(card);
    }
  }

  if (window.customElements && !window.customElements.get("linkedin-card")) {
    window.customElements.define("linkedin-card", LinkedInCard);
  }
})();
