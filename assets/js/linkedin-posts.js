/* <linkedin-posts> — a lightweight Web Component that renders a read-only
   feed of the site owner's LinkedIn posts on the page, styled like a
   LinkedIn feed: author avatar + name + relative time, post text,
   attached images, and a permalink to the original post.

   Usage:
     <linkedin-posts data-src="/api/linkedin/posts"></linkedin-posts>

   data-src SHOULD be the same-origin endpoint served by the companion
   Express server (server.js): GET /api/linkedin/posts. The server fetches
   the owner's posts (plus their name and profile picture via LinkedIn's
   userinfo endpoint), reduces them to text + timestamps + permalinks +
   proxied image URLs, and caches the result. Running the site through
   that server keeps the page's CSP connect-src 'self' valid — absolute
   cross-origin URLs would be blocked by the CSP by design.

   This component is DISPLAY ONLY — it can never create, edit, or delete
   anything on LinkedIn, and it exposes no token or credentials.

   Security notes:
   - No innerHTML with data — post text is inserted as text nodes, so
     nothing from LinkedIn (or the API response) can inject markup or
     script into the page.
   - Only https:// URLs inside post text become links; everything else
     stays plain text. Every generated link gets target="_blank" and
     rel="noopener noreferrer", and hrefs are re-validated through the
     URL parser before use (so javascript:, data:, and garbage are
     impossible).
   - Image and avatar URLs must be same-origin paths (they point at the
     server's media proxy) — anything with a scheme, protocol-relative
     "//", "..", or backslashes is rejected, so the JSON can never
     smuggle an external or dangerous src past the site CSP's img-src.
   - Images that fail to load are removed from the page (the feed never
     shows broken-image icons); the avatar falls back to initials.
   - The response shape is validated before anything renders; malformed
     data shows the error state instead of a half-built feed.
   - AbortController cancels in-flight requests when the element is
     removed from the DOM or the attribute changes mid-flight.
   - Timestamps are rendered as <time> elements with a machine-readable
     datetime attribute.

   Rendering uses light DOM with .li-* scoped classes (see
   assets/css/linkedin-posts.css, which reuses shared .li-card / .li-btn /
   .li-skeleton styles from assets/css/linkedin-card.css). Shadow DOM is
   deliberately avoided: the site CSP's style-src 'self' (no unsafe-inline)
   would block the inline <style> a shadow root requires. */
(function () {
  "use strict";

  /* Only https URLs, terminated by whitespace or characters that never
     appear in a valid URL. Curly quotes are treated as terminators too. */
  var URL_PATTERN = /\bhttps:\/\/[^\s<>"'\u2018\u2019\u201C\u201D]+/g;
  var TRAILING_PUNCTUATION = /[.,;:!?\u2026)\]}'"\u2019\u201D]+$/;

  class LinkedInPosts extends HTMLElement {
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
          'Missing data-src attribute — point it at the feed endpoint, e.g. data-src="/api/linkedin/posts".'
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
            /* Prefer the server's clean JSON error message. */
            return response
              .json()
              .catch(function () { return {}; })
              .then(function (body) {
                var detail = body && typeof body.error === "string" && body.error;
                throw new Error(detail || ("HTTP " + response.status + " " + response.statusText));
              });
          }
          return response.json();
        })
        .then(function (json) {
          if (controller.signal.aborted) {
            return;
          }
          try {
            this._renderFeed(json);
          } catch (error) {
            this._renderError("Feed data is malformed — the server sent an unexpected response.");
          }
        }.bind(this))
        .catch(function (error) {
          if (controller.signal.aborted) {
            return;
          }
          this._renderError(this._fetchMessage(src, error));
        }.bind(this));
    }

    /* Turns low-level fetch failures into a message that explains the
       most common cause: viewing the static site without the companion
       Node server running. */
    _fetchMessage(src, error) {
      var message = error && error.message ? String(error.message) : "Unknown error.";
      if (/^HTTP 40[04]/.test(message)) {
        return (
          'The feed endpoint "' + src + '" did not answer (404) — it is served by the ' +
          "companion Node server. Run npm start and open this page through it " +
          "(http://localhost:3000), see README.md."
        );
      }
      if (/failed to fetch|networkerror|load failed/i.test(message)) {
        return (
          'Could not reach the feed server at "' + src + '". If this is the static site ' +
          "without the companion Node server running, start it with npm start and view " +
          "the page through it (see README.md)."
        );
      }
      return message;
    }

    /* ---------- Helpers ---------- */

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

    /* https: only — same rule as the card component. */
    _httpsUrl(raw) {
      var value = typeof raw === "string" ? raw.trim() : "";
      if (!value) {
        return null;
      }
      try {
        var url = new URL(value);
        if (url.protocol === "https:") {
          return url.href;
        }
      } catch (error) {}
      return null;
    }

    /* Same-origin paths only (for the server's media proxy). Rejects
       absolute URLs, protocol-relative //, schemes, ".." and "\" so the
       API response can never point an <img> outside this origin. */
    _sameOriginPath(raw) {
      var value = typeof raw === "string" ? raw.trim() : "";
      if (!value || value.charAt(0) !== "/") {
        return null;
      }
      if (value.indexOf("//") === 0 || value.indexOf("..") !== -1 || value.indexOf("\\") !== -1) {
        return null;
      }
      return value;
    }

    _initials(name) {
      var parts = String(name || "").split(/\s+/).filter(Boolean);
      var first = parts.length ? parts[0].charAt(0) : "";
      var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
      return (first + last).toUpperCase() || "?";
    }

    /* Relative, human-friendly age: "just now", "3 hours ago", "2 weeks ago". */
    _relativeTime(ms) {
      var seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (seconds < 60) {
        return "just now";
      }
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) {
        return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
      }
      var hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return hours + (hours === 1 ? " hour ago" : " hours ago");
      }
      var days = Math.floor(hours / 24);
      if (days < 7) {
        return days + (days === 1 ? " day ago" : " days ago");
      }
      var weeks = Math.floor(days / 7);
      if (weeks < 5) {
        return weeks + (weeks === 1 ? " week ago" : " weeks ago");
      }
      var months = Math.floor(days / 30);
      if (months < 12) {
        return months + (months === 1 ? " month ago" : " months ago");
      }
      var years = Math.floor(days / 365);
      return years + (years === 1 ? " year ago" : " years ago");
    }

    /* Short, layout-safe label for a long URL (middle truncation). */
    _displayUrl(url) {
      var shown = url.replace(/^https:\/\//, "");
      if (shown.length <= 56) {
        return shown;
      }
      return shown.slice(0, 38) + "\u2026" + shown.slice(-16);
    }

    /* Appends post text to a node as text nodes + https-only anchors.
       Everything that is not a validated https URL stays plain text. */
    _linkify(parent, text) {
      URL_PATTERN.lastIndex = 0;
      var match;
      var last = 0;
      while ((match = URL_PATTERN.exec(text)) !== null) {
        var raw = match[0];
        var trimmed = raw.replace(TRAILING_PUNCTUATION, "");
        var trailing = raw.slice(trimmed.length);
        if (match.index > last) {
          parent.appendChild(document.createTextNode(text.slice(last, match.index)));
        }
        var url = this._httpsUrl(trimmed);
        if (url) {
          var link = document.createElement("a");
          link.className = "li-feed-link";
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = this._displayUrl(url);
          parent.appendChild(link);
        } else {
          parent.appendChild(document.createTextNode(trimmed));
        }
        if (trailing) {
          parent.appendChild(document.createTextNode(trailing));
        }
        last = match.index + raw.length;
      }
      if (last < text.length) {
        parent.appendChild(document.createTextNode(text.slice(last)));
      }
    }

    /* ---------- States ---------- */

    _renderLoading() {
      var card = this._el("article", "li-card li-feed-card li-card--loading");
      card.setAttribute("aria-busy", "true");
      card.setAttribute("aria-live", "polite");
      card.appendChild(this._el("h2", "li-section-title", "Recent posts"));

      var body = this._el("div", "li-body");
      body.appendChild(this._el("span", "li-visually-hidden", "Loading posts\u2026"));
      for (var i = 0; i < 3; i++) {
        body.appendChild(this._el("div", "li-skeleton li-skeleton--line"));
      }
      card.appendChild(body);

      this.replaceChildren(card);
    }

    _renderError(message) {
      var card = this._el("article", "li-card li-feed-card li-card--error");
      card.setAttribute("role", "alert");
      card.appendChild(this._el("h2", "li-error-title", "Posts unavailable"));
      card.appendChild(this._el("p", "li-error-text", message));

      var retry = this._el("button", "li-btn li-btn--ghost", "Try again");
      retry.type = "button";
      retry.addEventListener("click", this._load.bind(this));
      card.appendChild(retry);

      this.replaceChildren(card);
    }

    _renderFeed(data) {
      if (!data || typeof data !== "object" || !Array.isArray(data.posts)) {
        throw new Error("not a feed payload");
      }

      var author =
        data.author && typeof data.author === "object" && typeof data.author.name === "string"
          ? data.author
          : null;

      var card = this._el("article", "li-card li-feed-card");
      card.appendChild(this._el("h2", "li-section-title", "Recent posts"));

      if (!data.posts.length) {
        card.appendChild(
          this._el("p", "li-empty", "No public posts yet — new posts appear here automatically.")
        );
        this.replaceChildren(card);
        return;
      }

      var list = this._el("ol", "li-feed-list");
      data.posts.forEach(function (post) {
        list.appendChild(this._renderPost(post, author));
      }, this);
      card.appendChild(list);

      this.replaceChildren(card);
    }

    _renderPost(post, author) {
      var item = this._el("li", "li-feed-item");

      var ms = Number(post.createdAtMs);
      var hasTime = Number.isFinite(ms) && ms > 0;
      var name = author ? author.name.trim() : "";

      /* Head: avatar + name + relative time — like a LinkedIn post. */
      if (author && name) {
        var head = this._el("div", "li-feed-head");

        var avatarWrap = this._el("div", "li-feed-avatar", this._initials(name));
        avatarWrap.setAttribute("role", "img");
        avatarWrap.setAttribute("aria-label", "Avatar of " + name);
        var avatarSrc = this._sameOriginPath(author.picture);
        if (avatarSrc) {
          /* The picture is appended right away, layered over the
             initials, and revealed once it actually loads; a failed load
             just leaves the initials. It must be attached immediately:
             browsers never fetch a loading="lazy" image that is not in
             the document, so waiting for "load" before inserting it
             would deadlock. (Every post shares the author's one avatar
             URL, so there is exactly one fetch either way.) */
          var avatarImg = document.createElement("img");
          avatarImg.className = "li-feed-avatar-img";
          avatarImg.alt = "";
          avatarImg.decoding = "async";
          avatarImg.addEventListener("load", function () {
            avatarImg.classList.add("li-feed-avatar-img--loaded");
          });
          avatarImg.addEventListener("error", function () {
            if (avatarImg.parentNode) {
              avatarImg.parentNode.removeChild(avatarImg);
            }
          });
          avatarWrap.appendChild(avatarImg);
          avatarImg.src = avatarSrc;
        }
        head.appendChild(avatarWrap);

        var headId = this._el("div", "li-feed-id");
        headId.appendChild(this._el("span", "li-feed-author", name));
        if (hasTime) {
          headId.appendChild(this._renderTime(post, ms));
        }
        head.appendChild(headId);

        item.appendChild(head);
      } else if (hasTime) {
        /* No author info available (userinfo failed) — time only. */
        var meta = this._el("p", "li-feed-meta");
        meta.appendChild(this._renderTime(post, ms));
        item.appendChild(meta);
      }

      /* Post text (kept when the post is a photo without a caption). */
      var text = typeof post.text === "string" ? post.text.trim() : "";
      if (text) {
        var paragraph = this._el("p", "li-feed-text");
        this._linkify(paragraph, text);
        item.appendChild(paragraph);
      }

      /* Attached image, served through the server's media proxy. */
      var media = post.media && typeof post.media === "object" ? post.media : null;
      var mediaSrc = media ? this._sameOriginPath(media.url) : null;
      if (mediaSrc) {
        var figure = this._el("figure", "li-feed-figure");
        var img = document.createElement("img");
        img.className = "li-feed-media";
        img.alt = typeof media.alt === "string" ? media.alt : "";
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("error", function () {
          /* Never show a broken-image icon — drop the frame. */
          if (figure.parentNode) {
            figure.parentNode.removeChild(figure);
          }
        });
        figure.appendChild(img);
        item.appendChild(figure);
        img.src = mediaSrc;
      }

      var permalink = this._httpsUrl(post.permalink);
      if (permalink) {
        var link = this._el("a", "li-feed-permalink", "View on LinkedIn \u2197");
        link.href = permalink;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.appendChild(link);
      }

      return item;
    }

    _renderTime(post, ms) {
      var time = this._el("time", "li-feed-time", this._relativeTime(ms));
      time.setAttribute(
        "datetime",
        typeof post.createdAt === "string" && post.createdAt ? post.createdAt : new Date(ms).toISOString()
      );
      return time;
    }
  }

  if (window.customElements && !window.customElements.get("linkedin-posts")) {
    window.customElements.define("linkedin-posts", LinkedInPosts);
  }
})();
