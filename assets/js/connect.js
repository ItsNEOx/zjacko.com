"use strict";

/* connect.js — drives the owner-only LinkedIn OAuth flow on connect.html.
 *
 * The page is intentionally plain: it fetches /api/linkedin/status (public,
 * secret-free), and the two owner actions both require LINKEDIN_ADMIN_KEY:
 *   - Connect    → navigates to /api/linkedin/auth?key=… (server redirects
 *                  to LinkedIn's consent screen and back)
 *   - Disconnect → POST /api/linkedin/disconnect with the key in a header
 *
 * Everything renders with textContent only; nothing from the URL or the
 * server is ever inserted as HTML. */

(function () {
  const flashEl = document.getElementById("connect-flash");
  const statusEl = document.getElementById("connect-status");
  const keyInput = document.getElementById("admin-key");
  const connectBtn = document.getElementById("connect-btn");
  const disconnectBtn = document.getElementById("disconnect-btn");
  const KEY_STORAGE = "liAdminKey";

  /* Fixed, server-agreed error codes — never raw text from a query param. */
  const LINKEDIN_ERRORS = {
    denied:
      "LinkedIn reported the login or permission prompt was cancelled — nothing was connected.",
    state: "That connect session was invalid or expired — click Connect again.",
    busy: "Too many attempts — wait a few minutes and try again.",
    exchange:
      "LinkedIn refused the token exchange. Check that LINKEDIN_CLIENT_ID / " +
      "LINKEDIN_CLIENT_SECRET and the Redirect URL in .env exactly match your LinkedIn app."
  };

  function say(el, text) {
    el.textContent = text;
    el.hidden = false;
  }

  function adminKey() {
    return keyInput.value.trim();
  }

  function rememberKey() {
    const key = adminKey();
    if (key) {
      sessionStorage.setItem(KEY_STORAGE, key);
    }
    return key;
  }

  function needKey() {
    say(flashEl, "Enter the owner key (LINKEDIN_ADMIN_KEY from .env) first.");
    keyInput.focus();
  }

  function describeStatus(data) {
    if (data.connected && data.expired) {
      say(
        statusEl,
        "Connected, but the token has expired — click Connect to renew it " +
          "(a single click while logged in to LinkedIn)."
      );
      disconnectBtn.hidden = data.source !== "oauth";
      return;
    }
    if (data.connected) {
      const days = data.expiresAt
        ? Math.max(0, Math.ceil((Date.parse(data.expiresAt) - Date.now()) / 86400000))
        : null;
      const until = data.expiresAt ? new Date(data.expiresAt).toLocaleDateString() : "unknown";
      say(
        statusEl,
        "Connected" +
          (data.source === "oauth" ? " via the Connect button" : " via .env") +
          (days === null ? "" : " — token valid for about " + days + " more days (until " + until + ").") +
          (data.scope ? " Scopes: " + data.scope + "." : "")
      );
      disconnectBtn.hidden = data.source !== "oauth";
      return;
    }
    if (data.oauthConfigured === false) {
      say(
        statusEl,
        "Not connected, and the Connect flow is not set up on the server — fill in " +
          "LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET and LINKEDIN_ADMIN_KEY in .env first."
      );
    } else {
      say(statusEl, "Not connected yet — enter the owner key and click Connect LinkedIn.");
    }
    disconnectBtn.hidden = true;
  }

  function loadStatus() {
    fetch("/api/linkedin/status", { headers: { "Accept": "application/json" } })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      })
      .then(describeStatus)
      .catch(function () {
        say(
          statusEl,
          "Could not reach the feed server — is it running? Open this page via http://localhost:3000."
        );
        disconnectBtn.hidden = true;
      });
  }

  connectBtn.addEventListener("click", function () {
    const key = rememberKey();
    if (!key) {
      needKey();
      return;
    }
    window.location.href = "/api/linkedin/auth?key=" + encodeURIComponent(key);
  });

  disconnectBtn.addEventListener("click", function () {
    const key = rememberKey();
    if (!key) {
      needKey();
      return;
    }
    fetch("/api/linkedin/disconnect", {
      method: "POST",
      headers: { "X-Admin-Key": key }
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        say(flashEl, "Disconnected — the stored token was deleted from the server.");
        loadStatus();
      })
      .catch(function () {
        say(flashEl, "Disconnect failed — wrong owner key, or the server is unreachable.");
      });
  });

  /* Prefill from this tab's session. */
  keyInput.value = sessionStorage.getItem(KEY_STORAGE) || "";

  /* One-time flash messages from the OAuth round trip, then clean the URL. */
  const params = new URLSearchParams(window.location.search);
  let flashed = false;
  if (params.get("connected") === "1") {
    say(
      flashEl,
      "Connected — your LinkedIn page will now show your live profile and posts."
    );
    flashed = true;
  }
  const linkedinError = params.get("lierror");
  if (linkedinError && LINKEDIN_ERRORS[linkedinError]) {
    say(flashEl, LINKEDIN_ERRORS[linkedinError]);
    flashed = true;
  }
  if (flashed) {
    history.replaceState(null, "", "/connect.html");
  }

  loadStatus();
})();
