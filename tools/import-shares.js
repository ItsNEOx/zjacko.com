#!/usr/bin/env node
"use strict";

/**
 * tools/import-shares.js — clone your LinkedIn posts into data/posts.json
 * -----------------------------------------------------------------------
 * Reads the Shares.csv from LinkedIn's official "Download your data"
 * export and merges it into data/posts.json — the file the website's
 * <linkedin-posts> feed renders on linkedin.html. This is LinkedIn's
 * sanctioned way to get your own posts out in bulk:
 *
 *   1. LinkedIn -> Me icon -> Settings & Privacy -> Data Privacy
 *      -> "How LinkedIn uses your data" -> Download your data
 *   2. Request the larger download (the full archive — it contains
 *      Shares.csv). LinkedIn emails you a download link (up to ~24 h,
 *      the link stays valid for 72 h).
 *   3. Unzip it, then run:
 *
 *        node tools/import-shares.js "C:\path\to\Shares.csv"
 *
 * Re-run it whenever you want to re-sync. Posts already in
 * data/posts.json are updated (text/date), posts you deleted on
 * LinkedIn are kept (remove them by hand if you want), and any image
 * you attached manually is preserved.
 *
 * Options:
 *   --out PATH   write to a different JSON file (default: data/posts.json)
 *   --limit N    keep only the N newest posts (default: 50)
 *   --all        also import posts whose visibility is not "Anyone"
 *                (the website is public, so connections-only posts are
 *                skipped by default)
 *   --help       show usage
 *
 * Security notes:
 *   - Runs entirely offline: reads one CSV file, writes one JSON file.
 *     No network access, no credentials, nothing touches LinkedIn.
 *   - Only https://...linkedin.com/ permalinks are accepted.
 *   - The JSON it writes keeps the shape <linkedin-posts> validates,
 *     and the page renders post text with textContent only — nothing
 *     here can inject HTML into the site.
 *   - data/posts.json is meant to be committed with the site: it IS
 *     the feed.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "data", "posts.json");
const DEFAULT_LIMIT = 50;

const USAGE =
  'Usage: node tools/import-shares.js <path-to-Shares.csv> [--out <file>] [--limit N] [--all]\n' +
  "  --out    target JSON file (default: data/posts.json)\n" +
  "  --limit  keep only the N newest posts (default: 50)\n" +
  '  --all    also import non-public posts (default: only "Anyone" posts —\n' +
  "           the website is public, so connections-only posts are skipped)";

/* "Anyone" / "Anyone on or off LinkedIn" / "Public" count as public. */
const PUBLIC_RE = /anyone|public/i;

function fail(message) {
  process.stderr.write("import-shares: " + message + "\n" + USAGE + "\n");
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = { csv: "", out: DEFAULT_OUT, all: false, limit: DEFAULT_LIMIT, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--all") {
      out.all = true;
    } else if (arg.startsWith("--out=")) {
      out.out = arg.slice("--out=".length);
    } else if (arg === "--out") {
      out.out = argv[++i] || "";
    } else if (arg.startsWith("--limit=")) {
      out.limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--limit") {
      out.limit = Number(argv[++i]);
    } else if (arg.startsWith("--")) {
      fail("Unknown option: " + arg);
    } else {
      positional.push(arg);
    }
  }
  out.csv = positional[0] || "";
  return out;
}

/* ---------- CSV (quoted fields, embedded commas/newlines, BOM, CRLF) ---------- */

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1); /* strip UTF-8 BOM */
  }
  text = text.replace(/\r\n/g, "\n");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; /* escaped quote */
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch !== "\r") {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") {
        rows.push(row); /* skip blank lines */
      }
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") {
      rows.push(row);
    }
  }
  return rows;
}

/* Find a column by (case-insensitive) header name, with synonyms. */
function findColumn(headers, names) {
  const norm = headers.map((h) => String(h || "").trim().toLowerCase());
  for (const want of names) {
    const idx = norm.indexOf(want);
    if (idx !== -1) {
      return idx;
    }
  }
  return -1;
}

/* ---------- Field parsing ---------- */

/* Accepts "2026-11-09 14:26[:44][ UTC]" and "11/09/2026 2:26 PM".
   Times without a zone are treated as UTC (LinkedIn exports are UTC). */
function parseDateMs(raw) {
  const s = String(raw || "").trim();
  if (!s) {
    return 0;
  }
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|GMT)?$/i);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i);
  if (m) {
    let hour = m[4] ? +m[4] : 12;
    if (m[7]) {
      const ap = m[7].toUpperCase();
      if (ap === "PM" && hour < 12) hour += 12;
      if (ap === "AM" && hour === 12) hour = 0;
    }
    return Date.UTC(+m[3], +m[1] - 1, +m[2], hour, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/* Only https LinkedIn permalinks. */
function validPermalink(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host === "linkedin.com" || host === "www.linkedin.com" || host.endsWith(".linkedin.com")) {
      return url.href;
    }
  } catch (error) {}
  return null;
}

/* Stable-ish id derived from the permalink. */
function postIdFrom(permalink) {
  let m = permalink.match(/urn:li:(?:activity|share|ugcPost):\d+/i);
  if (m) {
    return m[0];
  }
  m = permalink.match(/\/posts\/([^\/?#]+)/i);
  if (m) {
    return "posts-" + m[1];
  }
  return "share-" + crypto.createHash("sha1").update(permalink).digest("hex").slice(0, 16);
}

/* ---------- Existing data ---------- */

function loadExisting(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.posts)) {
      return parsed;
    }
  } catch (error) {
    /* absent or malformed — start fresh */
  }
  return null;
}

/* Seed the feed author from the profile card file when posts.json is new. */
function defaultAuthor() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "linkedin.json"), "utf8"));
    const name =
      parsed && parsed.profile && typeof parsed.profile.name === "string"
        ? parsed.profile.name.trim()
        : "";
    if (name) {
      return { name: name, picture: "" };
    }
  } catch (error) {}
  return { name: "", picture: "" };
}

function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

/* ---------- Main ---------- */

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.csv) {
    fail("Missing the path to Shares.csv.");
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(args.csv, "utf8");
  } catch (error) {
    fail("Could not read " + args.csv + " — " + error.message);
    return;
  }

  const rows = parseCsv(raw);
  if (rows.length < 2) {
    fail("That file has no data rows — is it really the Shares.csv from a LinkedIn data export?");
    return;
  }

  const headers = rows[0];
  const col = {
    date: findColumn(headers, ["date", "share date"]),
    url: findColumn(headers, ["url", "post url", "link", "permalink"]),
    visibility: findColumn(headers, ["visibility status", "visibility"]),
    text: findColumn(headers, ["shared comment", "share commentary", "commentary", "comment", "text"])
  };
  const missing = Object.keys(col).filter((key) => col[key] === -1);
  if (missing.length) {
    fail(
      "Could not find column(s): " +
        missing.join(", ") +
        ". The header row was: " +
        headers.join(" | ") +
        " — make sure this is the Shares.csv from the full LinkedIn data export."
    );
    return;
  }
  const hasDateColumn = col.date !== -1;
  const hasVisibilityColumn = col.visibility !== -1;
  if (!hasDateColumn || !hasVisibilityColumn) {
    console.log(
      "Warning: the CSV is missing the " +
        (!hasDateColumn ? "Date" : "Visibility") +
        " column — importing anyway, double-check the result."
    );
  }

  const existing = loadExisting(args.out);
  const merged = existing && Array.isArray(existing.posts) ? existing.posts.slice() : [];
  const author =
    existing && existing.author && typeof existing.author === "object"
      ? existing.author
      : defaultAuthor();
  const source =
    existing && typeof existing.source === "string" && existing.source ? existing.source : "file";

  let added = 0;
  let updated = 0;
  let skippedPrivate = 0;
  let skippedNoText = 0;
  let skippedNoUrl = 0;
  let badDates = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const text = String(row[col.text] || "").trim();
    const permalink = validPermalink(row[col.url]);
    if (!permalink) {
      skippedNoUrl++;
      continue;
    }
    if (!text) {
      skippedNoText++; /* plain reshares have no comment of their own */
      continue;
    }
    const visibilityRaw = hasVisibilityColumn ? String(row[col.visibility] || "").trim() : "";
    const isPublic = hasVisibilityColumn ? PUBLIC_RE.test(visibilityRaw) : true;
    if (!args.all && !isPublic) {
      skippedPrivate++;
      continue;
    }
    const ms = hasDateColumn ? parseDateMs(row[col.date]) : 0;
    if (hasDateColumn && !ms) {
      badDates++;
    }
    const id = postIdFrom(permalink);
    const entry = {
      id: id,
      text: text,
      createdAtMs: ms,
      createdAt: ms ? new Date(ms).toISOString() : "",
      visibility: isPublic ? "PUBLIC" : (visibilityRaw || "UNKNOWN").toUpperCase(),
      permalink: permalink,
      media: null
    };

    const targetIndex = merged.findIndex(
      (p) => p && typeof p === "object" && (p.permalink === permalink || p.id === id)
    );
    if (targetIndex !== -1) {
      const target = merged[targetIndex];
      /* Update what the export knows; keep the id and any manually
         attached image (media) — those belong to the site, not the CSV. */
      target.text = entry.text;
      target.createdAtMs = entry.createdAtMs;
      target.createdAt = entry.createdAt;
      target.visibility = entry.visibility;
      target.permalink = entry.permalink;
      updated++;
    } else {
      merged.push(entry);
      added++;
    }
  }

  merged.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  const limited = args.limit > 0 ? merged.slice(0, args.limit) : merged;

  const payload = {
    ok: true,
    source: source,
    fetchedAt: new Date().toISOString(),
    author: author,
    count: limited.length,
    posts: limited
  };
  atomicWrite(args.out, JSON.stringify(payload, null, 2) + "\n");

  console.log(
    "Imported " + (added + updated) + " post(s) from " + path.basename(args.csv) +
      " — " + added + " new, " + updated + " updated."
  );
  if (skippedPrivate) {
    console.log("  skipped " + skippedPrivate + " non-public post(s) — use --all to include them");
  }
  if (skippedNoText) {
    console.log("  skipped " + skippedNoText + " row(s) without text (plain reshares)");
  }
  if (skippedNoUrl) {
    console.log("  skipped " + skippedNoUrl + " row(s) with a missing or invalid permalink");
  }
  if (badDates) {
    console.log(
      "  warning: " + badDates + " post(s) had an unreadable date — they render without a timestamp"
    );
  }
  if (limited.length < merged.length) {
    console.log("  kept the " + limited.length + " newest of " + merged.length + " posts (--limit)");
  }
  console.log("Wrote " + args.out + " — " + limited.length + " post(s) total.");
  console.log("Next: commit data/posts.json (plus any images in assets/linkedin/) and upload.");
}

main();
