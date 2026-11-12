#!/usr/bin/env node
"use strict";

/**
 * tools/add-post.js — add one of your LinkedIn posts to data/posts.json
 * ---------------------------------------------------------------------
 * The quick way to put a new post on the site without requesting a full
 * LinkedIn data export. Run it right after you publish something on
 * LinkedIn:
 *
 *   node tools/add-post.js "The post text" https://www.linkedin.com/posts/zjacko_ab12cd34 [options]
 *
 * Options:
 *   --image assets/linkedin/photo.png    attach an image (save the file
 *                                         into assets/linkedin/ first)
 *   --alt "what the image shows"         alt text for the image
 *   --date "2026-11-10 18:30"            post date (default: now)
 *   --out PATH                           target JSON (default: data/posts.json)
 *   --help                               show usage
 *
 * Copy the post text from LinkedIn itself (your words, your post), and
 * use LinkedIn's own "Copy link to post" for the permalink.
 *
 * Security notes:
 *   - Runs entirely offline: reads and writes one JSON file. Nothing
 *     touches LinkedIn, and there is no way to publish anything.
 *   - Only https://...linkedin.com/ permalinks are accepted.
 *   - Images must be local files under the site root (they are checked
 *     to exist on disk) — the site CSP allows same-origin images only.
 *   - Adding a permalink that is already in the file updates that post
 *     instead of duplicating it.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "data", "posts.json");

const USAGE =
  'Usage: node tools/add-post.js "<post text>" <https://www.linkedin.com/posts/... permalink> [options]\n' +
  "  --image assets/linkedin/photo.png    attach an image (file must exist)\n" +
  '  --alt "description"                  alt text for the image\n' +
  '  --date "2026-11-10 18:30"            post date (default: now)\n' +
  "  --out PATH                           target JSON (default: data/posts.json)";

function fail(message) {
  process.stderr.write("add-post: " + message + "\n" + USAGE + "\n");
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = { text: "", permalink: "", image: "", alt: "", date: "", out: DEFAULT_OUT, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg.startsWith("--image=")) {
      out.image = arg.slice("--image=".length);
    } else if (arg === "--image") {
      out.image = argv[++i] || "";
    } else if (arg.startsWith("--alt=")) {
      out.alt = arg.slice("--alt=".length);
    } else if (arg === "--alt") {
      out.alt = argv[++i] || "";
    } else if (arg.startsWith("--date=")) {
      out.date = arg.slice("--date=".length);
    } else if (arg === "--date") {
      out.date = argv[++i] || "";
    } else if (arg.startsWith("--out=")) {
      out.out = arg.slice("--out=".length);
    } else if (arg === "--out") {
      out.out = argv[++i] || "";
    } else if (arg.startsWith("--")) {
      fail("Unknown option: " + arg);
    } else {
      positional.push(arg);
    }
  }
  out.text = positional[0] || "";
  out.permalink = positional[1] || "";
  return out;
}

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

function loadExisting(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.posts)) {
      return parsed;
    }
  } catch (error) {}
  return null;
}

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const text = args.text.trim();
  if (!text) {
    fail("Missing the post text (quote it if it contains spaces).");
    return;
  }
  const permalink = validPermalink(args.permalink);
  if (!permalink) {
    fail("Missing or invalid permalink — it must be an https://www.linkedin.com/... post URL.");
    return;
  }

  let media = null;
  if (args.image) {
    const image = String(args.image).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(image) || image.startsWith("//") || image.includes("..") || image.includes("\\") || /[?#]/.test(image)) {
      fail('The --image path must be a local site path like assets/linkedin/photo.png or /assets/linkedin/photo.png (no "..", query, or scheme).');
      return;
    }
    /* Relative on purpose: the site is also served from a GitHub Pages
       project subpath (/zjacko.com/), where a leading slash would break.
       A leading slash is accepted for old commands and normalized away. */
    const relative = image.replace(/^\/+/, "");
    const onDisk = path.join(ROOT, relative);
    if (!fs.existsSync(onDisk)) {
      fail("Image not found at " + onDisk + " — save the file there first (assets/linkedin/ is the usual place).");
      return;
    }
    media = {
      type: "IMAGE",
      url: relative,
      alt: String(args.alt || "").trim()
    };
  }

  let ms = Date.now();
  if (args.date) {
    ms = parseDateMs(args.date);
    if (!ms) {
      fail('Could not read --date "' + args.date + '" — try "2026-11-10 18:30" or "11/10/2026 6:30 PM".');
      return;
    }
  }

  const existing = loadExisting(args.out);
  const posts = existing && Array.isArray(existing.posts) ? existing.posts.slice() : [];
  const author =
    existing && existing.author && typeof existing.author === "object"
      ? existing.author
      : defaultAuthor();
  const source =
    existing && typeof existing.source === "string" && existing.source ? existing.source : "file";

  const id = postIdFrom(permalink);
  const entry = {
    id: id,
    text: text,
    createdAtMs: ms,
    createdAt: new Date(ms).toISOString(),
    visibility: "PUBLIC",
    permalink: permalink,
    media: media
  };

  const targetIndex = posts.findIndex(
    (p) => p && typeof p === "object" && (p.permalink === permalink || p.id === id)
  );
  let action;
  if (targetIndex !== -1) {
    posts[targetIndex] = Object.assign({}, posts[targetIndex], entry); /* update in place, keep extras */
    action = "updated";
  } else {
    posts.push(entry);
    action = "added";
  }
  posts.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

  const payload = {
    ok: true,
    source: source,
    fetchedAt: new Date().toISOString(),
    author: author,
    count: posts.length,
    posts: posts
  };
  atomicWrite(args.out, JSON.stringify(payload, null, 2) + "\n");

  console.log(action.charAt(0).toUpperCase() + action.slice(1) + " post in " + args.out + " (" + posts.length + " total).");
  console.log("Next: commit data/posts.json (and the image, if any) and upload.");
}

main();
