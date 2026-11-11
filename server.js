"use strict";

/**
 * server.js — read-only LinkedIn posts feed backend for zjacko.com
 * ----------------------------------------------------------------
 * Serves the static site (so the frontend and the API share ONE origin —
 * this keeps the site CSP's connect-src 'self' intact) and exposes:
 *
 *   GET  /api/health               — liveness + configuration check
 *   GET  /api/linkedin/posts      — the site owner's LinkedIn posts, as JSON
 *   GET  /api/linkedin/profile    — live name + picture (OpenID userinfo)
 *   GET  /api/linkedin/media      — image proxy for LinkedIn's CDN
 *   GET  /api/linkedin/auth       — starts the owner-only OAuth Connect flow
 *   GET  /api/linkedin/callback   — OAuth redirect target (state-validated)
 *   GET  /api/linkedin/status     — connection status, no secrets
 *   POST /api/linkedin/disconnect — forgets the locally stored token
 *
 * This server is READ-ONLY: it fetches posts from LinkedIn's Posts API
 * and hands them to the website. There is no endpoint that can create,
 * edit, or delete anything on LinkedIn — publishing was deliberately
 * removed. The only POST here (/disconnect) deletes a local file and
 * never talks to LinkedIn.
 *
 * Security model:
 *   - Credentials live ONLY server-side: either in .env, or (preferred)
 *     in private/linkedin-token.json after the owner clicks "Connect" on
 *     connect.html. That directory is never served and is gitignored.
 *   - The Connect flow (OAuth 2.0 Authorization Code, 3-legged) is
 *     owner-only: /api/linkedin/auth requires LINKEDIN_ADMIN_KEY, the
 *     callback validates a single-use random state (CSRF), and the
 *     client secret is only ever sent to LinkedIn's token endpoint.
 *     The browser never sees any token.
 *   - The browser cannot choose whose posts are shown — the author is
 *     fixed by the stored credentials, never by a request parameter.
 *   - Responses are cached in memory (FEED_CACHE_SECONDS, default 15
 *     minutes) so page views never hammer LinkedIn; concurrent cache
 *     misses share a single upstream request.
 *   - The rate limiter only counts requests that would trigger an
 *     upstream call (cache misses, OAuth exchanges), so normal browsing
 *     is never limited.
 *   - Cross-origin browser calls are rejected unless CORS_ORIGIN is set
 *     (same-origin requests need no CORS at all).
 *   - The payload is reduced to text + timestamps + permalinks, and the
 *     frontend renders post text with textContent only — no HTML from
 *     LinkedIn ever reaches the page. Media is proxied through
 *     /api/linkedin/media (strict LinkedIn-CDN allowlist) so the site
 *     CSP's img-src 'self' stays intact.
 *   - Backend files (.env, server.js, package.json, node_modules,
 *     private/) are never served by the static middleware.
 *   - Calls to LinkedIn time out after 15 seconds.
 *
 * Run:  npm install && npm start      (see README.md)
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

/* ---------- Small helpers ---------- */

function clampInt(raw, min, max, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

/* Errors that describe an upstream LinkedIn failure (mapped to 502). */
class FeedError extends Error {}

/* ---------- Configuration (all from environment) ---------- */

const PORT = Number(process.env.PORT) || 3000;
const SITE_ROOT = __dirname;

const LINKEDIN_TOKEN = (process.env.LINKEDIN_ACCESS_TOKEN || "").trim();
const AUTHOR_URN = (process.env.LINKEDIN_AUTHOR_URN || "").trim();

/* --- OAuth "Connect LinkedIn" flow (owner-only, one click) ----------
   The recommended way to hand this server a token: open connect.html,
   enter LINKEDIN_ADMIN_KEY, and click Connect. The server runs a
   3-legged Authorization Code flow against LinkedIn, stores the token
   in private/linkedin-token.json (never web-served, gitignored), and
   discovers the author URN by itself from LinkedIn's userinfo. The
   manual LINKEDIN_ACCESS_TOKEN / LINKEDIN_AUTHOR_URN values above stay
   as a fallback; a stored OAuth token takes precedence over them. */
const LINKEDIN_CLIENT_ID = (process.env.LINKEDIN_CLIENT_ID || "").trim();
const LINKEDIN_CLIENT_SECRET = (process.env.LINKEDIN_CLIENT_SECRET || "").trim();
/* Owner password for the connect/disconnect endpoints. Fail-closed:
   without it the Connect flow is simply unavailable, never wide open. */
const LINKEDIN_ADMIN_KEY = (process.env.LINKEDIN_ADMIN_KEY || "").trim();
/* Must exactly match a Redirect URL registered on the LinkedIn app.
   Leave unset to derive it from the request (fine for local testing);
   set it explicitly in production, e.g.
   https://zjacko.com/api/linkedin/callback */
const LINKEDIN_REDIRECT_URI = (process.env.LINKEDIN_REDIRECT_URI || "").trim();

/* Test hooks pointing at the mock server only. Leave unset in production. */
const LINKEDIN_AUTHORIZE_URL =
  (process.env.LINKEDIN_AUTHORIZE_URL || "https://www.linkedin.com/oauth/v2/authorization").trim();
const LINKEDIN_TOKEN_URL =
  (process.env.LINKEDIN_TOKEN_URL || "https://www.linkedin.com/oauth/v2/accessToken").trim();

/* Scopes requested on Connect. Defaults to everything the feed needs;
   trim to "openid profile" while the app is still waiting for
   LinkedIn's approval of r_member_social (profile-only connect). */
const LINKEDIN_SCOPES = (process.env.LINKEDIN_SCOPES || "r_member_social openid profile")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean)
  .join(" ");

const OAUTH_READY = Boolean(LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET);

/* Token file written by the Connect flow. private/ is blocked from
   static serving in isBackendPath() and listed in .gitignore. */
const TOKEN_DIR = path.join(__dirname, "private");
const TOKEN_FILE = path.join(TOKEN_DIR, "linkedin-token.json");
const STATE_TTL_MS = 10 * 60 * 1000; /* OAuth states are single-use and short-lived */

/* LinkedIn-Version header (YYYYMM) — keep reasonably current:
   https://learn.microsoft.com/linkedin/marketing/ */
const LINKEDIN_API_VERSION = (process.env.LINKEDIN_API_VERSION || "202601").trim();

/* Override for local testing against a mock server only. Leave unset. */
const LINKEDIN_API_URL = (process.env.LINKEDIN_API_URL || "https://api.linkedin.com/rest/posts").trim();
/* Same — userinfo endpoint override for mock testing. Leave unset. */
const LINKEDIN_USERINFO_URL = (process.env.LINKEDIN_USERINFO_URL || "https://api.linkedin.com/v2/userinfo").trim();

const FEED_COUNT = clampInt(process.env.FEED_COUNT, 1, 50, 10);
const FEED_CACHE_SECONDS = clampInt(process.env.FEED_CACHE_SECONDS, 0, 86400, 900);
const FEED_PUBLIC_ONLY = (process.env.FEED_PUBLIC_ONLY || "1").trim() !== "0";
const PROFILE_CACHE_SECONDS = clampInt(process.env.PROFILE_CACHE_SECONDS, 0, 86400, 3600);
const MEDIA_MAX_BYTES = clampInt(process.env.MEDIA_MAX_BYTES, 1024, 52428800, 8388608);
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "").trim();
const TRUST_PROXY = (process.env.TRUST_PROXY || "").trim() === "1";

const URN_RE = /^urn:li:person:[A-Za-z0-9_-]+$/;

/* True when either path (Connect button or manual .env token) has
   produced a usable token + author URN. */
function feedReady() {
  const creds = linkedCredentials();
  return Boolean(creds.token) && URN_RE.test(creds.authorUrn);
}

const LINKEDIN_TIMEOUT_MS = 15000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_REQUESTS = 30; /* only counted on upstream-triggering requests */
const RATE_MEDIA_MAX_REQUESTS = 120; /* images are cheap and browser-cached */

app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY ? 1 : false);

function json(res, status, payload) {
  res.status(status).json(payload);
}

/* Never serve backend/source files through the static middleware. */
function isBackendPath(p) {
  if (p === "/server.js" || p === "/package.json" || p === "/package-lock.json") {
    return true;
  }
  if (p.startsWith("/.")) {
    return true; /* .env, .git, any dotfile/dotfolder */
  }
  if (p === "/node_modules" || p.startsWith("/node_modules/")) {
    return true;
  }
  if (p === "/private" || p.startsWith("/private/")) {
    return true; /* the Connect flow stores the OAuth token here */
  }
  if (/^\/README(\.[^/]*)?$/i.test(p)) {
    return true;
  }
  return false;
}

/* In-memory per-key rate limiter (good enough for a personal server). */
const rateHits = new Map();
function rateLimited(key, max) {
  const cap = Number.isFinite(max) ? max : RATE_MAX_REQUESTS;
  const now = Date.now();
  const recent = (rateHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= cap) {
    rateHits.set(key, recent);
    return true;
  }
  recent.push(now);
  rateHits.set(key, recent);
  return false;
}

/* ---------- Stored connection (Connect flow) ----------
   private/linkedin-token.json holds the OAuth token the owner granted
   via connect.html. It is read on demand (the file is tiny), so no
   restart is needed after connecting or disconnecting. A stored token
   takes precedence over the manual LINKEDIN_ACCESS_TOKEN /
   LINKEDIN_AUTHOR_URN values from .env. */

function readStoredToken() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.accessToken === "string" && parsed.accessToken.trim()) {
      return {
        accessToken: parsed.accessToken.trim(),
        expiresAtMs: Number(parsed.expiresAtMs) || 0,
        scope: typeof parsed.scope === "string" ? parsed.scope : "",
        authorUrn: typeof parsed.authorUrn === "string" ? parsed.authorUrn.trim() : "",
        connectedAt: typeof parsed.connectedAt === "string" ? parsed.connectedAt : ""
      };
    }
  } catch (error) {
    /* absent or unreadable -> behave as not connected */
  }
  return null;
}

/* The credentials every LinkedIn call actually uses. */
function linkedCredentials() {
  const stored = readStoredToken();
  const token = stored ? stored.accessToken : LINKEDIN_TOKEN;
  return {
    token: token || "",
    authorUrn: (stored && stored.authorUrn) || AUTHOR_URN || "",
    source: stored ? "oauth" : token ? "env" : null,
    expired: Boolean(stored && stored.expiresAtMs > 0 && Date.now() > stored.expiresAtMs)
  };
}

function forgetStoredToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (error) {
    /* already gone */
  }
}

function clearFeedAndProfileCaches() {
  feedCache = null;
  profileCache = null;
}

/* Timing-safe compare for the owner key (hashed first so both sides
   are equal-length buffers). */
function keyMatches(provided) {
  if (!LINKEDIN_ADMIN_KEY || typeof provided !== "string" || !provided) {
    return false;
  }
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(LINKEDIN_ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

/* Single-use CSRF states for the OAuth flow. */
const oauthStates = new Map(); /* state -> { redirectUri, at } */
function newState(redirectUri) {
  const now = Date.now();
  for (const [key, entry] of oauthStates) {
    if (now - entry.at > STATE_TTL_MS) {
      oauthStates.delete(key);
    }
  }
  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, { redirectUri: redirectUri, at: now });
  if (oauthStates.size > 200) {
    oauthStates.delete(oauthStates.keys().next().value);
  }
  return state;
}
function takeState(state) {
  const entry = typeof state === "string" ? oauthStates.get(state) : null;
  if (typeof state === "string") {
    oauthStates.delete(state); /* single use */
  }
  if (!entry || Date.now() - entry.at > STATE_TTL_MS) {
    return null;
  }
  return entry;
}

function redirectUriFor(req) {
  if (LINKEDIN_REDIRECT_URI) {
    return LINKEDIN_REDIRECT_URI;
  }
  return req.protocol + "://" + String(req.get("host") || "localhost") + "/api/linkedin/callback";
}

/* ---------- Feed: fetch, map, cache ---------- */

let feedCache = null; /* { payload, at } */
let feedInflight = null; /* promise while an upstream fetch is running */

function cacheFresh() {
  return (
    FEED_CACHE_SECONDS > 0 &&
    feedCache !== null &&
    Date.now() - feedCache.at < FEED_CACHE_SECONDS * 1000
  );
}

/* ---------- Media proxy ----------
   Post images and profile pictures live on LinkedIn's CDN, which the
   site CSP's img-src 'self' blocks by design. The server fetches them
   and re-serves them from /api/linkedin/media so the browser only ever
   talks to this origin — and so the target is strictly allowlisted
   (https + LinkedIn's CDN hosts only), capped in size, and checked to
   actually be an image. */

const DEFAULT_MEDIA_HOSTS = [
  "media.licdn.com",
  "media-exp1.licdn.com",
  "media-exp2.licdn.com",
  "video.licdn.com"
];
/* Extra hosts for local testing against a mock server only. Leave unset. */
const EXTRA_MEDIA_HOSTS = (process.env.LINKEDIN_MEDIA_HOSTS || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function isDefaultMediaHost(hostname) {
  return DEFAULT_MEDIA_HOSTS.includes(String(hostname).toLowerCase());
}

function allowedMediaTarget(url) {
  const host = url.hostname.toLowerCase();
  if (EXTRA_MEDIA_HOSTS.includes(host)) {
    return true; /* test hook */
  }
  return url.protocol === "https:" && isDefaultMediaHost(host);
}

function mediaProxyUrl(rawUrl) {
  return "/api/linkedin/media?src=" + encodeURIComponent(String(rawUrl));
}

/* ---------- Profile (name + picture) ---------- */

let profileCache = null; /* { payload, at } */
let profileInflight = null;

function profileCacheFresh() {
  return (
    PROFILE_CACHE_SECONDS > 0 &&
    profileCache !== null &&
    Date.now() - profileCache.at < PROFILE_CACHE_SECONDS * 1000
  );
}

/* Live name + profile picture via OpenID Connect (needs the openid and
   profile scopes on the token). The picture URL is rewritten to the
   media proxy so the browser only ever sees a same-origin URL. */
async function fetchProfileFromLinkedIn() {
  const creds = linkedCredentials();
  let response;
  try {
    response = await fetch(LINKEDIN_USERINFO_URL, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + creds.token,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(LINKEDIN_TIMEOUT_MS)
    });
  } catch (error) {
    throw new FeedError("Could not reach LinkedIn: " + error.message);
  }

  if (!response.ok) {
    const detail = await linkedinErrorDetail(response);
    if (response.status === 401) {
      throw new FeedError(
        "LinkedIn rejected the access token — member tokens expire after 60 days. " +
          (creds.source === "oauth"
            ? "Reconnect once at /connect.html (a single click while logged in to LinkedIn)."
            : "Mint a fresh one and update .env.") +
          detail
      );
    }
    if (response.status === 403) {
      throw new FeedError(
        "LinkedIn denied access (403) — the live name/picture need the openid " +
          "and profile scopes on the token." + detail
      );
    }
    throw new FeedError("LinkedIn API error (HTTP " + response.status + ")." + detail);
  }

  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new FeedError("Unexpected response shape from LinkedIn userinfo.");
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const picture = typeof body.picture === "string" ? body.picture.trim() : "";
  return {
    ok: true,
    name: name,
    picture: picture ? mediaProxyUrl(picture) : ""
  };
}

function fetchProfilePayload() {
  if (profileCacheFresh()) {
    return Promise.resolve(profileCache.payload);
  }
  if (!profileInflight) {
    profileInflight = fetchProfileFromLinkedIn()
      .then(function (payload) {
        profileCache = { payload: payload, at: Date.now() };
        return payload;
      })
      .finally(function () {
        profileInflight = null;
      });
  }
  return profileInflight;
}

function readVisibility(element) {
  const visibility = element.visibility;
  if (!visibility || typeof visibility !== "object") {
    return "";
  }
  return String(
    visibility["com.linkedin.ugc.MemberShareVisibility"] ||
      visibility["com.linkedin.ugc.MemberNetworkVisibility"] ||
      ""
  );
}

/* Extracts the displayable image of a post (photo posts, article
   thumbnails, video poster frames). Returns { type, url (proxied),
   alt } or null. The URL is always rewritten to the media proxy. */
function mediaThumbnailUrl(media) {
  const thumbs = media.thumbnails;
  if (Array.isArray(thumbs)) {
    for (const thumb of thumbs) {
      if (thumb && typeof thumb === "object" && typeof thumb.url === "string" && thumb.url.trim()) {
        return thumb.url.trim();
      }
    }
  }
  return "";
}

function readPostMedia(element) {
  const content = element.content;
  if (!content || typeof content !== "object") {
    return null;
  }

  const media = content.media;
  if (media && typeof media === "object") {
    const url = mediaThumbnailUrl(media);
    if (url) {
      const type = typeof media.type === "string" ? media.type.trim() : "";
      let alt = "";
      if (typeof media.altText === "string" && media.altText.trim()) {
        alt = media.altText.trim();
      } else if (media.title && typeof media.title.text === "string" && media.title.text.trim()) {
        alt = media.title.text.trim();
      }
      return { type: type, url: mediaProxyUrl(url), alt: alt };
    }
    return null;
  }

  const article = content.article;
  if (article && typeof article === "object") {
    let url = "";
    if (typeof article.thumbnail === "string" && article.thumbnail.trim()) {
      url = article.thumbnail.trim();
    } else if (
      article.thumbnail &&
      typeof article.thumbnail === "object" &&
      typeof article.thumbnail.url === "string"
    ) {
      url = article.thumbnail.url.trim();
    }
    if (url) {
      const alt =
        article.title && typeof article.title.text === "string" ? article.title.text.trim() : "";
      return { type: "ARTICLE", url: mediaProxyUrl(url), alt: alt };
    }
  }
  return null;
}

/* Map LinkedIn's Posts API response down to the few fields the site
   needs: text, image (proxied), timestamps, permalinks. Drafts and
   non-public posts (when FEED_PUBLIC_ONLY is on) are dropped; posts
   with neither text nor an image have nothing to show and are dropped
   too. The strict site CSP could not display LinkedIn-hosted media
   directly — that's what the media proxy is for. */
function mapPosts(elements) {
  const posts = [];
  for (const element of elements) {
    if (!element || typeof element !== "object") {
      continue;
    }
    const id = typeof element.id === "string" ? element.id.trim() : "";
    if (!id) {
      continue;
    }
    const lifecycle = typeof element.lifecycleState === "string" ? element.lifecycleState : "";
    if (lifecycle && lifecycle !== "PUBLISHED") {
      continue;
    }
    const visibility = readVisibility(element);
    if (FEED_PUBLIC_ONLY && visibility && visibility !== "PUBLIC") {
      continue;
    }
    const text = typeof element.commentary === "string" ? element.commentary.trim() : "";
    const media = readPostMedia(element);
    if (!text && !media) {
      continue;
    }
    const ms = Number(element.createdAt) || Number(element.publishedAt) || 0;
    posts.push({
      id: id,
      text: text,
      createdAtMs: ms,
      createdAt: ms > 0 ? new Date(ms).toISOString() : "",
      visibility: visibility,
      permalink: "https://www.linkedin.com/feed/update/" + encodeURIComponent(id) + "/",
      media: media
    });
  }
  posts.sort(function (a, b) {
    return b.createdAtMs - a.createdAtMs;
  });
  return posts;
}

async function linkedinErrorDetail(response) {
  const bodyText = await response.text().catch(() => "");
  if (!bodyText) {
    return "";
  }
  let detail = bodyText.slice(0, 300);
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed.message === "string") {
      detail = parsed.message.slice(0, 300);
    }
  } catch (error) {}
  return detail ? " " + detail : "";
}

async function fetchFeedFromLinkedIn() {
  const creds = linkedCredentials();

  /* Posts API (finder query). The author URN must be URL-encoded in the
     query string — URLSearchParams handles that. */
  const params = new URLSearchParams({
    author: creds.authorUrn,
    q: "author",
    count: String(FEED_COUNT),
    sortBy: "LAST_MODIFIED"
  });

  let response;
  try {
    response = await fetch(LINKEDIN_API_URL + "?" + params.toString(), {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + creds.token,
        "Accept": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "X-RestLi-Method": "FINDER",
        "LinkedIn-Version": LINKEDIN_API_VERSION
      },
      signal: AbortSignal.timeout(LINKEDIN_TIMEOUT_MS)
    });
  } catch (error) {
    throw new FeedError("Could not reach LinkedIn: " + error.message);
  }

  if (!response.ok) {
    const detail = await linkedinErrorDetail(response);
    if (response.status === 401) {
      throw new FeedError(
        "LinkedIn rejected the access token — member tokens expire after 60 days. " +
          (creds.source === "oauth"
            ? "Reconnect once at /connect.html (a single click while logged in to LinkedIn)."
            : "Mint a fresh one and update .env.") +
          detail
      );
    }
    if (response.status === 403) {
      throw new FeedError(
        "LinkedIn denied access (403) — reading member posts needs the " +
          "r_member_social scope, which is RESTRICTED and requires LinkedIn's " +
          "review/approval on your app." + detail
      );
    }
    if (response.status === 429) {
      throw new FeedError("LinkedIn is throttling requests (429) — try again later." + detail);
    }
    throw new FeedError("LinkedIn API error (HTTP " + response.status + ")." + detail);
  }

  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray(body.elements)) {
    throw new FeedError("Unexpected response shape from LinkedIn — no elements array.");
  }
  return body.elements;
}

async function refreshFeed() {
  /* The feed still works if userinfo fails (e.g. missing openid scope) —
     the posts just render without the author header. */
  const [elements, profile] = await Promise.all([
    fetchFeedFromLinkedIn(),
    fetchProfilePayload().catch(function () {
      return null;
    })
  ]);
  const posts = mapPosts(elements);
  const payload = {
    ok: true,
    source: "linkedin",
    fetchedAt: new Date().toISOString(),
    author: profile || null,
    count: posts.length,
    posts: posts
  };
  feedCache = { payload: payload, at: Date.now() };
  return payload;
}

/* ---------- Middleware ---------- */

app.use(function (req, res, next) {
  if (req.path === "/connect.html") {
    res.setHeader("X-Robots-Tag", "noindex, nofollow"); /* owner-only page */
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

/* CORS is closed by default: same-origin requests need no CORS at all.
   Set CORS_ORIGIN only if the site and this API live on different origins. */
if (CORS_ORIGIN) {
  app.use("/api", cors({ origin: CORS_ORIGIN, methods: ["GET"] }));
}

/* ---------- API ---------- */

app.get("/api/health", (req, res) => {
  json(res, 200, {
    ok: true,
    feed: feedReady(),
    connected: readStoredToken() !== null,
    oauthReady: OAUTH_READY,
    cacheReady: feedCache !== null
  });
});

app.post("/api/linkedin/posts", (req, res) => {
  json(res, 405, { ok: false, error: "This endpoint is read-only — only GET is supported." });
});

app.get("/api/linkedin/profile", async (req, res) => {
  try {
    if (!feedReady()) {
      return json(res, 503, {
        ok: false,
        error:
          "LinkedIn is not connected yet — open /connect.html to run the " +
          "one-click Connect flow, or set LINKEDIN_ACCESS_TOKEN / " +
          "LINKEDIN_AUTHOR_URN in .env."
      });
    }

    if (profileCacheFresh()) {
      return json(res, 200, profileCache.payload);
    }

    if (rateLimited(req.ip)) {
      return json(res, 429, { ok: false, error: "Too many requests — try again in a few minutes." });
    }

    const payload = await fetchProfilePayload();
    return json(res, 200, payload);
  } catch (error) {
    if (error instanceof FeedError) {
      return json(res, 502, { ok: false, error: error.message });
    }
    console.error("[server]", error);
    return json(res, 500, { ok: false, error: "Internal server error." });
  }
});

/* Proxies a LinkedIn CDN image so the strict site CSP (img-src 'self')
   can still show post images and the profile picture. Strictly
   allowlisted, capped in size, verified to be an image, and cached in
   the browser for a day. */
app.get("/api/linkedin/media", async (req, res) => {
  try {
    const raw = typeof req.query.src === "string" ? req.query.src.trim() : "";
    if (!raw) {
      return json(res, 400, { ok: false, error: "Missing src parameter." });
    }

    let target;
    try {
      target = new URL(raw);
    } catch (error) {
      return json(res, 400, { ok: false, error: "Invalid src parameter." });
    }
    if (!allowedMediaTarget(target)) {
      return json(res, 403, { ok: false, error: "src must point at LinkedIn's media CDN." });
    }
    if (rateLimited("media:" + req.ip, RATE_MEDIA_MAX_REQUESTS)) {
      return json(res, 429, { ok: false, error: "Too many requests — try again in a few minutes." });
    }

    const headers = { "Accept": "image/*" };
    const creds = linkedCredentials();
    if (creds.token && isDefaultMediaHost(target.hostname)) {
      /* LinkedIn's signed CDN URLs accept the member token — harmless
         for public URLs, required for authenticated ones. Never sent
         to non-LinkedIn hosts. */
      headers["Authorization"] = "Bearer " + creds.token;
    }

    let response;
    try {
      response = await fetch(target.href, {
        method: "GET",
        headers: headers,
        redirect: "error",
        signal: AbortSignal.timeout(LINKEDIN_TIMEOUT_MS)
      });
    } catch (error) {
      return json(res, 502, { ok: false, error: "Could not fetch the image." });
    }
    if (!response.ok) {
      return json(res, 502, { ok: false, error: "Upstream image fetch failed (HTTP " + response.status + ")." });
    }

    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) {
      return json(res, 415, { ok: false, error: "Refusing to proxy non-image content." });
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) {
      return json(res, 413, { ok: false, error: "Image too large." });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MEDIA_MAX_BYTES) {
      return json(res, 413, { ok: false, error: "Image too large." });
    }

    res.status(200);
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", String(buffer.byteLength));
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.end(buffer);
  } catch (error) {
    console.error("[server]", error);
    return json(res, 500, { ok: false, error: "Internal server error." });
  }
});

app.get("/api/linkedin/posts", async (req, res) => {
  try {
    if (!feedReady()) {
      return json(res, 503, {
        ok: false,
        error:
          "LinkedIn is not connected yet — open /connect.html to run the " +
          "one-click Connect flow, or set LINKEDIN_ACCESS_TOKEN / " +
          "LINKEDIN_AUTHOR_URN in .env."
      });
    }

    /* Fast path: fresh cache — no upstream call, not rate limited. */
    if (cacheFresh()) {
      res.setHeader("X-Cache", "hit");
      return json(res, 200, feedCache.payload);
    }

    /* Slow path: an upstream call would happen — rate limit here. */
    if (rateLimited(req.ip)) {
      return json(res, 429, { ok: false, error: "Too many requests — try again in a few minutes." });
    }

    /* Concurrent misses share one upstream request. */
    if (!feedInflight) {
      feedInflight = refreshFeed().finally(function () {
        feedInflight = null;
      });
    }
    const payload = await feedInflight;
    res.setHeader("X-Cache", "miss");
    return json(res, 200, payload);
  } catch (error) {
    if (error instanceof FeedError) {
      return json(res, 502, { ok: false, error: error.message });
    }
    console.error("[server]", error);
    return json(res, 500, { ok: false, error: "Internal server error." });
  }
});

/* ---------- OAuth "Connect LinkedIn" flow (owner-only) ----------
   One page drives all of this: connect.html. The owner enters the
   LINKEDIN_ADMIN_KEY, clicks Connect, is bounced through LinkedIn's
   consent screen, and lands back here with the token stored
   server-side. Nobody else can start the flow (admin key) or complete
   it (the single-use state is only ever handed out behind the admin
   key). Read-only with respect to LinkedIn: the flow only ever asks
   LinkedIn to READ the owner's own data. */

app.post("/api/linkedin/auth", (req, res) => {
  json(res, 405, { ok: false, error: "This endpoint only supports GET (browser redirect)." });
});
app.post("/api/linkedin/callback", (req, res) => {
  json(res, 405, { ok: false, error: "This endpoint only supports GET (LinkedIn redirects the browser here)." });
});
app.post("/api/linkedin/status", (req, res) => {
  json(res, 405, { ok: false, error: "This endpoint is read-only — only GET is supported." });
});
app.get("/api/linkedin/disconnect", (req, res) => {
  json(res, 405, { ok: false, error: "This endpoint only supports POST (with the owner key)." });
});

/* Step 1: start the flow — a plain redirect to LinkedIn's consent
   screen. The client secret is not involved here. */
app.get("/api/linkedin/auth", (req, res) => {
  if (!OAUTH_READY) {
    return json(res, 503, {
      ok: false,
      error:
        "OAuth is not configured — set LINKEDIN_CLIENT_ID and " +
        "LINKEDIN_CLIENT_SECRET in .env (create them at " +
        "https://www.linkedin.com/developers/apps), plus LINKEDIN_ADMIN_KEY."
    });
  }
  if (!keyMatches(typeof req.query.key === "string" ? req.query.key : "")) {
    return json(res, 403, { ok: false, error: "Wrong or missing owner key." });
  }
  if (rateLimited("oauth:" + req.ip)) {
    return json(res, 429, { ok: false, error: "Too many attempts — try again in a few minutes." });
  }

  const redirectUri = redirectUriFor(req);
  const state = newState(redirectUri);
  const query =
    "response_type=code" +
    "&client_id=" + encodeURIComponent(LINKEDIN_CLIENT_ID) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&state=" + encodeURIComponent(state) +
    "&scope=" + encodeURIComponent(LINKEDIN_SCOPES);
  return res.redirect(LINKEDIN_AUTHORIZE_URL + "?" + query);
});

/* Step 2: LinkedIn sends the browser back here with code+state (or an
   error). The state is validated and consumed, then the code is
   exchanged for a token server-side — the client secret and the token
   never travel to the browser. */
app.get("/api/linkedin/callback", async (req, res) => {
  const fail = function (code) {
    return res.redirect("/connect.html?lierror=" + encodeURIComponent(code));
  };
  try {
    /* LinkedIn redirects here with error=… when the member cancels. */
    const linkedinError = typeof req.query.error === "string" ? req.query.error : "";
    if (linkedinError) {
      takeState(typeof req.query.state === "string" ? req.query.state : "");
      return fail("denied");
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const entry = takeState(state);
    if (!code || !entry) {
      return fail("state");
    }
    if (rateLimited("oauth:" + req.ip)) {
      return fail("busy");
    }

    /* Exchange the authorization code for an access token. */
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      client_id: LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_CLIENT_SECRET,
      redirect_uri: entry.redirectUri
    });
    let response;
    try {
      response = await fetch(LINKEDIN_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json"
        },
        body: body.toString(),
        signal: AbortSignal.timeout(LINKEDIN_TIMEOUT_MS)
      });
    } catch (error) {
      console.error("[server] token exchange unreachable:", error.message);
      return fail("exchange");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[server] token exchange failed (HTTP " + response.status + "):", text.slice(0, 300));
      return fail("exchange");
    }
    const tokenBody = await response.json().catch(() => null);
    const accessToken =
      tokenBody && typeof tokenBody.access_token === "string" ? tokenBody.access_token.trim() : "";
    if (!accessToken) {
      return fail("exchange");
    }
    const expiresIn = Number(tokenBody.expires_in) || 5184000; /* LinkedIn: 60 days */
    const scope =
      typeof tokenBody.scope === "string" && tokenBody.scope.trim() ? tokenBody.scope.trim() : LINKEDIN_SCOPES;

    /* Best effort: discover the author URN + profile via OpenID
       userinfo. If it fails (e.g. the app has no openid/profile product
       yet), the token is still stored — the feed then falls back to
       LINKEDIN_AUTHOR_URN from .env. */
    let authorUrn = "";
    let profileSeed = null;
    try {
      const infoResponse = await fetch(LINKEDIN_USERINFO_URL, {
        method: "GET",
        headers: { "Authorization": "Bearer " + accessToken, "Accept": "application/json" },
        signal: AbortSignal.timeout(LINKEDIN_TIMEOUT_MS)
      });
      if (infoResponse.ok) {
        const info = await infoResponse.json().catch(() => null);
        if (info && typeof info === "object") {
          const sub = typeof info.sub === "string" ? info.sub.trim() : "";
          if (/^[A-Za-z0-9_-]+$/.test(sub)) {
            authorUrn = "urn:li:person:" + sub;
          }
          const name = typeof info.name === "string" ? info.name.trim() : "";
          const picture = typeof info.picture === "string" ? info.picture.trim() : "";
          if (name || picture) {
            profileSeed = { ok: true, name: name, picture: picture ? mediaProxyUrl(picture) : "" };
          }
        }
      } else {
        console.error("[server] userinfo after connect: HTTP " + infoResponse.status);
      }
    } catch (error) {
      console.error("[server] userinfo after connect failed:", error.message);
    }

    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify(
        {
          accessToken: accessToken,
          scope: scope,
          authorUrn: authorUrn,
          expiresAtMs: Date.now() + expiresIn * 1000,
          connectedAt: new Date().toISOString()
        },
        null,
        2
      ) + "\n",
      { mode: 0o600 }
    );

    /* Make the new connection visible immediately: seed the profile
       cache and drop the feed cache so the next view fetches fresh. */
    if (profileSeed) {
      profileCache = { payload: profileSeed, at: Date.now() };
    }
    feedCache = null;
    return res.redirect("/connect.html?connected=1");
  } catch (error) {
    console.error("[server]", error);
    return fail("exchange");
  }
});

/* Public, secret-free connection status for connect.html. */
app.get("/api/linkedin/status", (req, res) => {
  const stored = readStoredToken();
  const creds = linkedCredentials();
  json(res, 200, {
    ok: true,
    connected: Boolean(creds.token) && URN_RE.test(creds.authorUrn),
    source: creds.source,
    expired: creds.expired,
    expiresAt: stored && stored.expiresAtMs > 0 ? new Date(stored.expiresAtMs).toISOString() : null,
    scope: stored ? stored.scope : "",
    oauthConfigured: OAUTH_READY
  });
});

/* Forgets the locally stored OAuth token. This never talks to
   LinkedIn — to fully revoke, also remove the app under
   https://www.linkedin.com/psettings/permissions. */
app.post("/api/linkedin/disconnect", (req, res) => {
  if (!keyMatches(typeof req.get("X-Admin-Key") === "string" ? req.get("X-Admin-Key") : "")) {
    return json(res, 403, { ok: false, error: "Wrong or missing owner key." });
  }
  forgetStoredToken();
  clearFeedAndProfileCaches();
  return json(res, 200, { ok: true, connected: false });
});

/* ---------- Static site (same origin as the API) ---------- */

app.use(function (req, res, next) {
  if (isBackendPath(req.path)) {
    return json(res, 404, { error: "Not found" });
  }
  next();
});

app.use(express.static(SITE_ROOT, { dotfiles: "ignore" }));

/* ---------- 404 / error handling ---------- */

app.use(function (req, res) {
  if (req.path.startsWith("/api/")) {
    return json(res, 404, { ok: false, error: "Unknown API endpoint." });
  }
  res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>404 — zjacko.com</title></head>' +
      '<body style="font-family:Consolas,monospace;background:#0b0f19;color:#c9d4ff;padding:2rem">' +
      "<h1>404</h1><p>That page does not exist.</p>" +
      '<p><a href="/" style="color:#8aa2ff">Back to zjacko.com</a></p></body></html>'
  );
});

/* eslint-disable-next-line no-unused-vars */
app.use(function (error, req, res, next) {
  console.error("[server]", error);
  return json(res, 500, { ok: false, error: "Internal server error." });
});

/* ---------- Start / graceful shutdown ---------- */

const server = app.listen(PORT, () => {
  console.log("zjacko.com LinkedIn feed server listening on http://localhost:" + PORT);
  console.log("  serving site same-origin from: " + SITE_ROOT);
  console.log("  feed: GET /api/linkedin/posts (read-only — nothing here can publish to LinkedIn)");
  console.log("  profile: GET /api/linkedin/profile · images: GET /api/linkedin/media (proxy)");
  console.log("  connect: open /connect.html to link the owner's LinkedIn in one click");
  if (feedReady()) {
    console.log(
      "  LinkedIn feed: connected (count=" +
        FEED_COUNT +
        ", cache=" +
        FEED_CACHE_SECONDS +
        "s, publicOnly=" +
        FEED_PUBLIC_ONLY +
        ")"
    );
  } else {
    console.log("  LinkedIn feed: not connected yet — open /connect.html (needs");
    console.log("           LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_ADMIN_KEY in .env),");
    console.log("           or set LINKEDIN_ACCESS_TOKEN / LINKEDIN_AUTHOR_URN in .env.");
  }
  if (!OAUTH_READY) {
    console.log("  (OAuth Connect flow disabled — LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET missing)");
  }
});

function shutdown(signal) {
  console.log("\n" + signal + " received — shutting down.");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
