"use strict";

/**
 * tools/sync-linkedin.js — local, owner-run LinkedIn mirror sync (read-only)
 * -------------------------------------------------------------------------
 * Runs on the owner's PC only. It drives a dedicated Chrome/Edge profile
 * that the owner signs into ONCE (no passwords are stored anywhere), reads
 * the owner's own profile + activity pages, and writes them into
 * data/linkedin.json and data/posts.json. It never creates, edits, or
 * deletes anything on LinkedIn.
 *
 * WARNING — read before using:
 *   LinkedIn's User Agreement prohibits automated scraping. Running this
 *   tool can trigger LinkedIn checkpoints and, in the worst case, account
 *   restrictions. Use it only on your own account, at your own risk.
 *
 * Usage:
 *   node tools/sync-linkedin.js --login     one-time: open Chrome, sign in,
 *                                           save a dump of all pages
 *   node tools/sync-linkedin.js             sync now (headless)
 *   node tools/sync-linkedin.js --push      sync, then git commit + push
 *   node tools/sync-linkedin.js --dump      also save raw HTML (debugging)
 *   node tools/sync-linkedin.js --headed    run visibly (if LinkedIn blocks
 *                                           headless sessions)
 *   node tools/sync-linkedin.js --parse DIR extract from dumped HTML offline
 *   node tools/sync-linkedin.js --all       also publish posts that could not
 *                                           be confirmed public (off by default)
 *
 * Everything stateful lives OUTSIDE the repo (browser session, logs,
 * dumps):  %LOCALAPPDATA%\zjacko-linkedin-sync\
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright-core");
const dom = require("./linkedin-dom");

/* ---------- paths & args ---------- */

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const IMAGE_DIR = path.join(ROOT, "assets", "linkedin");
const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "zjacko-linkedin-sync");
const PROFILE_DIR = path.join(STATE_DIR, "chrome-profile");
const LOG_FILE = path.join(STATE_DIR, "sync.log");
const DUMP_DIR = path.join(STATE_DIR, "dumps");

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

/* ---------- logging ---------- */

function log(message) {
  const line = "[" + new Date().toISOString() + "] " + message;
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {
    /* Logging must never break the sync. */
  }
}

/* ---------- small utilities ---------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temp, file);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function profileUrl() {
  const data = readJson(path.join(DATA_DIR, "linkedin.json"), null);
  const url = data && data.profile && data.profile.linkedin_url;
  if (url && /^https:\/\/www\.linkedin\.com\/in\//.test(url)) {
    return url.replace(/\/+$/, "") + "/";
  }
  return "https://www.linkedin.com/in/zjacko/";
}

function chromeExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH to your browser executable.");
  }
  return found;
}

function imageExtension(url, contentType) {
  const type = (contentType || "").toLowerCase();
  if (type.includes("image/png")) return "png";
  if (type.includes("image/webp")) return "webp";
  if (type.includes("image/gif")) return "gif";
  if (type.includes("image/jpeg") || type.includes("image/jpg")) return "jpg";
  const match = /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.exec(url || "");
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

/* ---------- browser drivers ---------- */

function launchContext(headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    executablePath: chromeExecutable(),
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

async function loginFormVisible(page) {
  let form = false;
  try {
    form = await page.evaluate(() => {
      return Boolean(
        document.querySelector(
          "input#username, form.login__form, form[action*='/login'], [data-test-id='login-form']"
        )
      );
    });
  } catch (_) {
    form = true; /* mid-navigation — treat as not ready */
  }
  const url = page.url() || "";
  return form || /\/(login|authwall|checkpoint|uas\/login)/i.test(url);
}

async function ensureLoggedIn(context, url, allowInteractive) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);

  if (!(await loginFormVisible(page))) {
    return page;
  }

  if (!allowInteractive) {
    throw new Error(
      "LinkedIn session is missing or expired. Run: node tools/sync-linkedin.js --login"
    );
  }

  log("The Chrome window is open. Sign in to LinkedIn there — this runs automatically once you are in (waiting up to 15 minutes).");
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    try {
      if (!(await loginFormVisible(page))) {
        log("Signed in.");
        return page;
      }
    } catch (_) {
      /* still navigating */
    }
  }
  throw new Error("Timed out waiting for LinkedIn sign-in.");
}

async function expandSeeMore(page) {
  for (let pass = 0; pass < 3; pass += 1) {
    const clicked = await page.evaluate(() => {
      const targets = Array.from(
        document.querySelectorAll("button, a, span[role='button'], div[role='button']")
      );
      let count = 0;
      for (const el of targets) {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (
          (text.endsWith("see more") || text === "…see more" || text === "...see more") &&
          !text.includes("show all")
        ) {
          try {
            el.click();
            count += 1;
          } catch (_) {
            /* detached node — ignore */
          }
        }
      }
      return count;
    });
    if (!clicked) {
      break;
    }
    await page.waitForTimeout(700);
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = Math.max(window.innerHeight, 600);
    for (let i = 0; i < 8; i += 1) {
      window.scrollBy(0, step);
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
}

async function collectPages(context, urls, dump) {
  const pages = {};
  for (const [key, url] of Object.entries(urls)) {
    log("Reading " + key + ": " + url);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    if (await loginFormVisible(page)) {
      await page.close();
      throw new Error("LinkedIn showed a login/checkpoint wall. Run: node tools/sync-linkedin.js --login");
    }

    await expandSeeMore(page);
    await autoScroll(page);
    pages[key] = await page.content();
    await page.close();

    if (dump) {
      fs.mkdirSync(DUMP_DIR, { recursive: true });
      fs.writeFileSync(path.join(DUMP_DIR, key + ".html"), pages[key]);
      log("Dumped " + key + ".html (" + Math.round(pages[key].length / 1024) + " KB)");
    }
  }
  return pages;
}

/* ---------- writing the site data ---------- */

/* A mirrored image should look sharp, but a single huge asset would make
   the page slow on GitHub Pages. Prefer the largest variant at or below
   this size, and only fall back to an oversized one if that is all there is. */
const MAX_MEDIA_BYTES = 3 * 1024 * 1024;

async function fetchImage(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: "https://www.linkedin.com/",
      },
    });
    if (!response.ok) {
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 64) {
      return null;
    }
    return { buffer, contentType: response.headers.get("content-type") };
  } catch (_) {
    return null;
  }
}

function saveImage(url, buffer, contentType, nameOverride) {
  const extension = imageExtension(url, contentType);
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
  const name = nameOverride
    ? nameOverride + "." + extension
    : "sync-" + hash + "." + extension;
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGE_DIR, name), buffer);
  /* Relative on purpose: the site runs both at a domain root and under a
     GitHub Pages project path (/zjacko.com/), so absolute /assets paths
     would break there. */
  return { type: "IMAGE", url: "assets/linkedin/" + name, alt: "" };
}

/* Download the best usable variant. `alternates` are the other srcset
   candidates, largest first; each is tried until one fits MAX_MEDIA_BYTES. */
async function downloadImage(url, nameOverride, alternates) {
  const candidates = [url, ...(alternates || []).filter((item) => item && item !== url)];
  let chosen = null;
  for (const candidate of candidates) {
    const fetched = await fetchImage(candidate);
    if (!fetched) {
      continue;
    }
    if (!chosen) {
      chosen = { url: candidate, ...fetched };
    }
    if (fetched.buffer.length <= MAX_MEDIA_BYTES) {
      chosen = { url: candidate, ...fetched };
      break;
    }
  }
  if (!chosen) {
    return null;
  }
  return saveImage(chosen.url, chosen.buffer, chosen.contentType, nameOverride);
}

function ownerPathFrom(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") + "/";
  } catch (_) {
    return "/in/zjacko/";
  }
}

/* Verify that a post is publicly readable by opening its permalink in a
   clean, signed-out browser context. LinkedIn does not expose an audience
   flag on the activity page; this probe is the reliable signal, and the
   result is cached per post in data/posts.json so each post is only
   checked once. */
async function probeVisibility(context, permalink) {
  if (!permalink || !context || !context.browser) {
    return "UNKNOWN";
  }
  const browser = context.browser();
  if (!browser) {
    return "UNKNOWN";
  }
  let clean = null;
  try {
    clean = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await clean.newPage();
    await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1200);
    const body = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    if (/authwall|\/login/i.test(page.url())) {
      return "CONNECTIONS";
    }
    if (/Sign in to see|Join LinkedIn to see|This post is unavailable|Page not found/i.test(body)) {
      return "CONNECTIONS";
    }
    if (/[’']s Post\b/i.test(body) || /Like\s+Comment\s+Share/i.test(body)) {
      return "PUBLIC";
    }
    return "UNKNOWN";
  } catch (_) {
    return "UNKNOWN";
  } finally {
    if (clean) {
      await clean.close().catch(() => {});
    }
  }
}

async function sync(pages, options) {
  const profileHtml = pages.profile || "";
  const skillsHtml = pages.skills || "";
  const postsHtml = pages.posts || "";
  const ownerPath = options.ownerPath || "/";

  const scraped = dom.extractProfile(profileHtml);
  const experience = dom.extractExperience(profileHtml);
  const experienceFound = dom.hasProfileSection(profileHtml, "Experience");
  const aboutFound = dom.hasProfileSection(profileHtml, "About");
  const skills = dom.extractSkills(skillsHtml);
  const foundPosts = dom.extractPosts(postsHtml, { ownerPath, now: Date.now() });

  if (
    !scraped.name &&
    !scraped.headline &&
    !scraped.summary &&
    !skills.length &&
    !experience.length &&
    !foundPosts.length
  ) {
    throw new Error(
      "Extraction returned nothing — LinkedIn's layout may have changed. Nothing was written. Run with --dump and inspect the saved HTML."
    );
  }

  /* --- profile card data --- */
  const current = readJson(path.join(DATA_DIR, "linkedin.json"), {
    profile: {},
    skills: [],
    experience: [],
  });
  const currentProfile = current.profile || {};

  let avatar = currentProfile.avatar || "";
  if (scraped.avatarUrl) {
    const saved = await downloadImage(scraped.avatarUrl, "avatar");
    if (saved) {
      avatar = saved.url;
    }
  }

  const nextProfile = {
    name: scraped.name || currentProfile.name || "",
    headline: scraped.headline || currentProfile.headline || "",
    location: scraped.location || currentProfile.location || "",
    avatar,
    linkedin_url: currentProfile.linkedin_url || profileUrl().replace(/\/+$/, ""),
    summary: aboutFound ? scraped.summary : currentProfile.summary || "",
    company: scraped.company || "",
  };

  const nextLinkedin = {
    profile: nextProfile,
    skills: skills.length ? skills : current.skills || [],
    /* No Experience section on LinkedIn means no experience entries on the
       site either — old hand-written entries must not survive the sync. */
    experience: experience,
  };

  if (experienceFound && !experience.length) {
    log("Experience section found but no entries could be read — check the markup.");
  }

  const profileChanged = !sameJson(nextLinkedin, current);
  if (profileChanged) {
    writeJsonAtomic(path.join(DATA_DIR, "linkedin.json"), nextLinkedin);
    log("Updated data/linkedin.json");
  } else {
    log("data/linkedin.json unchanged");
  }

  /* --- posts --- */
  const includeAll = hasFlag("--all");
  const currentPosts = readJson(path.join(DATA_DIR, "posts.json"), {
    ok: true,
    source: "file",
    fetchedAt: "",
    author: { name: "", picture: "" },
    count: 0,
    posts: [],
  });
  const previousByPermalink = new Map(
    (currentPosts.posts || []).map((post) => [post.permalink, post])
  );

  /* Only publish posts that are readable while signed out. A post already
     in the file keeps its cached verdict; new posts are checked once. */
  const publishable = [];
  const skipped = [];
  for (const post of foundPosts) {
    const previous = post.permalink ? previousByPermalink.get(post.permalink) : null;
    let visibility = previous && previous.visibility ? previous.visibility : "UNKNOWN";

    if (!includeAll && visibility === "UNKNOWN") {
      visibility = await probeVisibility(options.context, post.permalink);
      log(
        (visibility === "PUBLIC"
          ? "Public post: "
          : visibility === "CONNECTIONS"
          ? "Not public (skipping): "
          : "Could not confirm public (skipping): ") + (post.permalink || post.id)
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
    }

    post.visibility = visibility;
    if (includeAll || visibility === "PUBLIC") {
      publishable.push(post);
    } else {
      skipped.push(post);
    }
  }
  if (skipped.length) {
    log(
      "Skipped " +
        skipped.length +
        " post(s) that could not be confirmed public — they stay off the website. " +
        "(--all publishes them anyway; only use it if you mean to make them public.)"
    );
  }

  /* Union merge: scraped posts override their previous versions, and
     posts that this page load didn't show (older pages, importer-added)
     are kept rather than wiped. */
  const mergedByKey = new Map();
  for (const post of publishable) {
    const previous = post.permalink ? previousByPermalink.get(post.permalink) : null;

    /* Stable per-post filename so a re-sync replaces the image instead of
       piling up new hashes. The id is an activity URN; the digits are
       unique and sortable. */
    const mediaDigits = String(post.id).replace(/\D/g, "");
    const mediaName = mediaDigits ? "post-" + mediaDigits : "";
    const previousMediaPath =
      previous && previous.media && previous.media.url
        ? path.join(ROOT, String(previous.media.url))
        : "";
    let media =
      mediaName &&
      previousMediaPath &&
      String(previous.media.url).startsWith("assets/linkedin/" + mediaName + ".") &&
      fs.existsSync(previousMediaPath)
        ? previous.media
        : null;

    if (!media && post.imageUrl) {
      media = await downloadImage(post.imageUrl, mediaName || undefined, post.imageUrls);
      if (media) {
        log("Downloaded image for " + post.permalink);
      }
    }

    mergedByKey.set(post.permalink || post.id, {
      id: post.id,
      text: post.text,
      createdAtMs: post.createdAtMs,
      createdAt: post.createdAt,
      visibility: post.visibility,
      permalink: post.permalink,
      media: media || null,
    });
  }
  for (const previous of currentPosts.posts || []) {
    const key = previous.permalink || previous.id;
    if (key && !mergedByKey.has(key)) {
      mergedByKey.set(key, previous);
    }
  }

  const merged = [...mergedByKey.values()];
  merged.sort((a, b) => b.createdAtMs - a.createdAtMs);
  const unique = [];
  const seen = new Set();
  for (const post of merged) {
    const key = post.permalink || post.id;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(post);
  }
  const posts = unique.slice(0, options.limit || 50);

  if (!posts.length && (currentPosts.posts || []).length > 0) {
    log("No public posts found this run — keeping the existing feed untouched.");
  } else {
    const nextPosts = {
      ok: true,
      source: "file",
      fetchedAt: currentPosts.fetchedAt || "",
      author: { name: nextProfile.name, picture: avatar },
      count: posts.length,
      posts,
    };

    const contentChanged =
      !sameJson(nextPosts.posts, currentPosts.posts) ||
      !sameJson(nextPosts.author, currentPosts.author);

    if (contentChanged) {
      nextPosts.fetchedAt = new Date().toISOString();
      writeJsonAtomic(path.join(DATA_DIR, "posts.json"), nextPosts);
      log("Updated data/posts.json (" + posts.length + " posts)");
    } else {
      log("data/posts.json unchanged (" + posts.length + " posts)");
    }
  }

  log(
    "Summary: " +
      (profileChanged ? "card updated, " : "card unchanged, ") +
      publishable.length +
      " public post(s) written" +
      (skipped.length ? ", " + skipped.length + " not public" : "")
  );
}

/* ---------- git ---------- */

function gitPush() {
  try {
    const run = (...gitArgs) =>
      execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" });
    run("add", "--", "data", "assets/linkedin");
    const status = run("status", "--porcelain", "--", "data", "assets/linkedin");
    if (!status.trim()) {
      log("No file changes — nothing to commit.");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    run("commit", "-m", "LinkedIn sync: " + stamp);
    log("Committed: LinkedIn sync: " + stamp);
    run("push", "origin", "main");
    log("Pushed to origin/main.");
  } catch (error) {
    log("Git error: " + (error.stderr || error.message || String(error)).toString().trim());
    throw error;
  }
}

/* ---------- offline parse mode ---------- */

function parseOffline(directory) {
  const read = (name) => {
    const file = path.join(directory, name + ".html");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };
  const url = profileUrl();
  const result = {
    profile: dom.extractProfile(read("profile")),
    experience: dom.extractExperience(read("profile")),
    skills: dom.extractSkills(read("skills")),
    posts: dom.extractPosts(read("posts"), {
      ownerPath: ownerPathFrom(url),
      now: Date.now(),
    }),
  };
  console.log(JSON.stringify(result, null, 2));
}

/* ---------- main ---------- */

async function main() {
  const parseDir = flagValue("--parse");
  if (parseDir) {
    parseOffline(parseDir);
    return;
  }

  const login = hasFlag("--login");
  const dump = hasFlag("--dump") || login;
  const push = hasFlag("--push");
  const headed = hasFlag("--headed");
  const url = profileUrl();

  fs.mkdirSync(STATE_DIR, { recursive: true });
  log("Starting " + (login ? "login/dump" : "sync") + " for " + url);

  const context = await launchContext(!(login || headed));
  try {
    await ensureLoggedIn(context, url, login);

    const pages = await collectPages(
      context,
      {
        profile: url,
        skills: url + "details/skills/",
        posts: url + "recent-activity/all/",
      },
      dump
    );

    if (login) {
      log("Dump complete. Inspect files in " + DUMP_DIR);
      return;
    }

    await sync(pages, { limit: 50, context, ownerPath: ownerPathFrom(url) });

    if (push) {
      gitPush();
    } else {
      log("Done (not pushed — add --push to commit and push).");
    }
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  log("Something went wrong: " + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
});
