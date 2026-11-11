"use strict";

/**
 * server.js — local development server for zjacko.com
 * ----------------------------------------------------------------
 * Serves the static site over HTTP so it can be developed exactly the
 * way it is deployed. The site itself is fully static: the LinkedIn
 * feed on linkedin.html renders data/posts.json (synced offline with
 * tools/import-shares.js / tools/add-post.js), and the profile card
 * reads data/linkedin.json. Production hosts (Apache/LiteSpeed,
 * Netlify, anything that serves files) need no Node at all.
 *
 * Why a dev server exists: browsers block fetch() on file:// pages,
 * and the pages' strict CSP (connect-src 'self') expects same-origin
 * requests — so the JSON files have to come from an HTTP origin.
 *
 * Security model:
 *   - Pure static file serving: no API, no writes, no secrets, and no
 *     code path that can create, edit, or delete anything anywhere.
 *   - Backend/repo files (server.js, package.json, package-lock.json,
 *     node_modules/, tools/, README, dotfiles like .env and .git) are
 *     never served.
 *   - Baseline security headers on every response; x-powered-by off.
 *
 * Run:  npm install && npm start      (see README.md)
 */

const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SITE_ROOT = __dirname;

function json(res, status, payload) {
  res.status(status).json(payload);
}

/* Never serve backend/repo files through the static middleware. */
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
  if (p === "/tools" || p.startsWith("/tools/")) {
    return true; /* offline sync scripts, not site content */
  }
  if (/^\/README(\.[^/]*)?$/i.test(p)) {
    return true;
  }
  return false;
}

app.disable("x-powered-by");

/* ---------- Middleware: baseline headers ---------- */

app.use(function (req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

/* ---------- Static site ---------- */

app.use(function (req, res, next) {
  if (isBackendPath(req.path)) {
    return json(res, 404, { error: "Not found" });
  }
  next();
});

app.use(express.static(SITE_ROOT, { dotfiles: "ignore" }));

/* ---------- 404 / error handling ---------- */

app.use(function (req, res) {
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
  console.log("zjacko.com dev server listening on http://localhost:" + PORT);
  console.log("  serving the static site from: " + SITE_ROOT);
  console.log("  the site is fully static — production hosts need no Node server");
});

function shutdown(signal) {
  console.log("\n" + signal + " received — shutting down.");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
