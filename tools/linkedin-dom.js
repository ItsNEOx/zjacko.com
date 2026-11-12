"use strict";

/**
 * tools/linkedin-dom.js — HTML extractors for the local LinkedIn sync
 * -------------------------------------------------------------------
 * Pure functions: (html, options) -> plain objects. They read the saved DOM
 * of the owner's own signed-in LinkedIn pages. Nothing here reads or writes
 * remote state.
 *
 * This targets LinkedIn's redesigned profile UI (2026), which has:
 *   - no <h1> and no .pvs-list / data-urn wrappers;
 *   - the name in an <h2>, headline/company/location in <p> lines;
 *   - About and post text in [data-testid="expandable-text-box"] with
 *     real line breaks encoded as <br> and a "... more" <button> appended;
 *   - relative timestamps ("1w", "2mo") instead of <time datetime>;
 *   - per-post activity URNs in /analytics/post-summary/ links.
 *
 * LinkedIn's markup is not a stable API: when the site changes its layout,
 * update the selectors below. Use `node tools/sync-linkedin.js --dump` to
 * save the live HTML for debugging, and `--parse <dir>` to test these
 * extractors offline against those dumps.
 */

const cheerio = require("cheerio");

/* ---------- helpers ---------- */

function normalize(value) {
  return String(value == null ? "" : value)
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function oneLine(value) {
  return normalize(value).replace(/\s+/g, " ");
}

/* The "…see more" toggle lives inside the text containers on LinkedIn.
   Whatever is left of it after the sync clicks is stripped here. Line
   breaks are preserved (LinkedIn renders post and About text pre-wrap). */
function stripSeeMore(value) {
  let out = normalize(value);
  out = out.replace(/\s*(?:…|\.\.\.)?\s*see (?:more|less)\s*$/i, "");
  out = out.replace(/^(?:…|\.\.\.)?\s*see (?:more|less)\s*/i, "");
  return out.trim();
}

/* Plain text of an element with LinkedIn's <br> line breaks kept as \n.
   The expandable-text button (and any other buttons) is removed first, so
   UI chrome never leaks into the copied text. */
function blockText($, element) {
  if (!element || !element.length) {
    return "";
  }
  const clone = element.clone();
  clone.find("button, [data-testid='expandable-text-button']").remove();
  clone.find("br").replaceWith("\n");
  return stripSeeMore(clone.text());
}

function decodeAttr(value) {
  if (!value) {
    return "";
  }
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/* Find a profile <section> by its visible h2/h3 heading ("About",
   "Experience", "Skills", …). */
function sectionByHeading($, names) {
  const wanted = names.map((n) => n.trim().toLowerCase());
  let found = null;
  $("section").each((i, el) => {
    if (found) {
      return;
    }
    const heading = oneLine($(el).find("h2, h3").first().text()).toLowerCase();
    if (wanted.includes(heading)) {
      found = $(el);
    }
  });
  return found;
}

function hasProfileSection(html, name) {
  const $ = cheerio.load(html);
  return Boolean(sectionByHeading($, [name]));
}

/* ---------- profile ---------- */

const PRONOUNS = /^(he|she|they)\/[a-z]+$/i;

function extractProfile(html) {
  const $ = cheerio.load(html);

  /* The top card is the section that carries the "Contact info" link. */
  let top = null;
  $("section").each((i, el) => {
    if (top) {
      return;
    }
    const section = $(el);
    if (section.find("h2").length && /Contact info/.test(oneLine(section.text()))) {
      top = section;
    }
  });

  const name = top ? oneLine(top.find("h2").first().text()) : "";

  /* The card lines, in order: [pronouns], headline, company, location,
     then "Contact info". Anything after "Contact info" is the activity
     feed and must not be treated as card text. */
  const cardLines = [];
  if (top) {
    top.find("p").each((i, el) => {
      const value = oneLine($(el).text());
      if (!value) {
        return;
      }
      if (value === "Contact info") {
        return false; /* stop before the rest of the page */
      }
      cardLines.push(value);
    });
  }

  let index = 0;
  while (index < cardLines.length && (PRONOUNS.test(cardLines[index]) || cardLines[index] === "·")) {
    index += 1;
  }
  const headline = cardLines[index] || "";
  const company = cardLines[index + 1] || "";
  const location = cardLines[index + 2] || "";

  /* About */
  let summary = "";
  const about = sectionByHeading($, ["About"]);
  if (about) {
    const box = about.find("[data-testid='expandable-text-box']").first();
    summary = blockText($, box);
  }

  /* Profile photo (only when the sync may download it) */
  let avatarUrl = "";
  if (top) {
    const img = top.find("img[src*='profile-displayphoto']").first();
    avatarUrl = img.length ? avatarImageSrc($, img, 400) : "";
  }

  return { name, headline, company, location, summary, avatarUrl };
}

/* ---------- experience ---------- */

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";

/* LinkedIn's new UI does not currently render an Experience section for
   this profile. This parser is a best-effort for the redesigned markup:
   each top-level list item is one role, with its text lines as paragraphs.
   It returns [] when no Experience section exists, which is the correct
   answer for a profile that lists none. */
function extractExperience(html) {
  const $ = cheerio.load(html);
  const section = sectionByHeading($, ["Experience"]);
  if (!section) {
    return [];
  }

  const items = [];
  section.find("li").each((i, el) => {
    const li = $(el);
    if (li.parents("li").length > 0) {
      return; /* top-level positions only */
    }

    const lines = li
      .find("p")
      .map((j, p) => oneLine($(p).text()))
      .get()
      .filter((value) => value && value !== "·");
    if (!lines.length) {
      return;
    }

    const role = lines[0] || "";
    const company = lines[1] || "";
    let period = oneLine(li.find(".pvs-entity__caption-wrapper, span[class*='caption']").first().text());
    if (!period) {
      const match = oneLine(li.text()).match(
        new RegExp(MONTH + "\\s+\\d{4}\\s*[-–]\\s*(?:Present|" + MONTH + "\\s+\\d{4})", "i")
      );
      period = match ? match[0] : lines.find((line) => /\b(19|20)\d{2}\b/.test(line)) || "";
    }

    let description = "";
    const box = li.find("[data-testid='expandable-text-box']").first();
    if (box.length) {
      description = blockText($, box);
    }

    items.push({ role, company, period, description });
  });

  const seen = new Set();
  return items.filter((item) => {
    const key = item.role + "|" + item.company;
    if (!item.role || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/* ---------- skills ---------- */

function extractSkills(html) {
  const $ = cheerio.load(html);

  /* The skills detail page exposes the whole list in one region. */
  let root = $("[data-testid^='profile_SkillDetails']").first();
  if (!root.length) {
    const section = sectionByHeading($, ["Skills"]);
    root = section && section.length ? section : $("main").length ? $("main") : $.root();
  }

  let values = root
    .find("p")
    .map((i, el) => oneLine($(el).text()))
    .get()
    .filter(Boolean);

  if (!values.length) {
    /* Older markup fallback. */
    values = root
      .find("span[aria-hidden='true']")
      .map((i, el) => oneLine($(el).text()))
      .get()
      .filter(Boolean);
  }

  /* Each skill is followed by its issuer ("Wilkes Community College"), so
     any line that repeats belongs to the chrome, not the skill list. */
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  const skills = [];
  const seen = new Set();
  for (const value of values) {
    if ((counts.get(value) || 0) > 1) {
      continue;
    }
    if (seen.has(value) || value.length > 80) {
      continue;
    }
    if (/^(all|industry knowledge|tools & technologies|add a skill|endorsed by\b)/i.test(value)) {
      continue;
    }
    seen.add(value);
    skills.push(value);
  }
  return skills;
}

/* ---------- posts ---------- */

function urnFromLink(href, type) {
  const pattern = new RegExp("urn:li:(?:" + type + "):\\d+");
  const match = pattern.exec(href || "");
  return match ? match[0] : "";
}

/* LinkedIn activity IDs are snowflake-like: the top 41 bits are the Unix
   epoch in milliseconds, so the exact publish time is recoverable. */
function snowflakeMs(id) {
  if (!/^\d{15,}$/.test(id)) {
    return NaN;
  }
  try {
    return Number(BigInt(id) >> 22n);
  } catch (_) {
    return NaN;
  }
}

function relativeAgeMs(label) {
  const match = /^(\d+)\s*(s|m|h|d|w|mo|y)\b/i.exec(oneLine(label));
  if (!match) {
    return NaN;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const units = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };
  return amount * units[unit];
}

function isMediaImage(src) {
  if (!src || !/media\.licdn\.com/.test(src)) {
    return false;
  }
  if (/profile-displayphoto|profile-framedphoto|profile-display|company-logo|ghost/i.test(src)) {
    return false;
  }
  return /(feedshare|articleshare|videocover|image-shrink|article-cover)/i.test(src);
}

/* All variants an <img> offers, largest first. Each srcset entry has its
   own signature, so a bigger version must be picked from this list, not
   created by rewriting the URL. */
function imageCandidates($, img) {
  const node = $(img);
  const seen = new Set();
  const sources = [];
  for (const part of decodeAttr(node.attr("srcset") || "").split(",")) {
    const pieces = part.trim().split(/\s+/);
    const url = pieces[0] || "";
    if (!/^https?:/i.test(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const descriptor = /^(\d+(?:\.\d+)?)(?:w|x)$/i.exec(pieces[1] || "");
    sources.push({ url, width: descriptor ? Number(descriptor[1]) : 0 });
  }
  const src = decodeAttr(node.attr("src") || "");
  if (src && !seen.has(src)) {
    sources.push({ url: src, width: 0 });
  }
  sources.sort((a, b) => b.width - a.width);
  return sources;
}

function imageSources($, img) {
  return imageCandidates($, img).map((source) => source.url);
}

function bestImageSrc($, img) {
  return imageSources($, img)[0] || "";
}

/* Avatars render small, so the largest variant would be a waste of bytes.
   Take the biggest one up to `maxWidth`, or the smallest offered. */
function avatarImageSrc($, img, maxWidth) {
  const sources = imageCandidates($, img);
  const within = sources.find((source) => source.width > 0 && source.width <= maxWidth);
  if (within) {
    return within.url;
  }
  const smallest = [...sources]
    .filter((source) => source.width > 0)
    .sort((a, b) => a.width - b.width)[0];
  return (smallest || sources[0] || { url: "" }).url;
}

/**
 * Extract the owner's own posts from their recent-activity page.
 *
 * options.ownerPath  e.g. "/in/zjacko/" — used to (a) only keep activity
 *                    that belongs to the owner and (b) take the owner's
 *                    commentary (first text box) on reposts, never the
 *                    original author's words.
 * options.now        scrape time (ms) used only when a timestamp cannot be
 *                    recovered from the activity URN.
 */
function extractPosts(html, options) {
  const $ = cheerio.load(html);
  const base = "https://www.linkedin.com";
  const settings = options || {};
  const now = Number.isFinite(settings.now) ? settings.now : Date.now();
  const ownerPath = String(settings.ownerPath || "")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  let scope = $("[data-testid^='ProfileRecentActivityAll-']").first();
  if (!scope.length) {
    scope = $("main").length ? $("main") : $.root();
  }

  const byKey = new Map();

  scope.find("[role='listitem']").each((i, el) => {
    const item = $(el);
    const boxes = item.find("[data-testid='expandable-text-box']");
    const firstBox = boxes.first()[0] || null;

    /* Which author owns the item? A post's header author is the first
       profile link in the list item. For a repost with commentary that is
       the owner; for someone else's post the owner merely shared, it is the
       original author — whose words must never be copied onto this site. */
    const firstActor = item.find("a[href*='/in/']").first().attr("href") || "";
    const ownerLink = ownerPath
      ? decodeAttr(firstActor)
          .toLowerCase()
          .replace(/\/+$/, "")
          .endsWith(ownerPath)
      : Boolean(firstActor);
    if (!ownerLink) {
      return;
    }

    const text = blockText($, boxes.first());

    const analyticsHref =
      item.find("a[href*='/analytics/post-summary/']").first().attr("href") || "";
    const activityUrn = urnFromLink(analyticsHref, "activity");
    const feedHref = item.find("a[href*='/feed/update/']").first().attr("href") || "";

    let permalink = "";
    if (activityUrn) {
      permalink = base + "/feed/update/" + activityUrn + "/";
    } else if (feedHref) {
      permalink = feedHref.startsWith("http") ? feedHref : base + feedHref;
    }

    const idFromUrn = activityUrn || urnFromLink(feedHref, "(?:activity|share|ugcPost)");
    let createdAtMs = snowflakeMs((/(\d+)$/.exec(idFromUrn) || [])[1] || "");

    if (!Number.isFinite(createdAtMs)) {
      const relative = item
        .find("p")
        .map((j, p) => oneLine($(p).text()))
        .get()
        .filter((value) => value.length < 24)
        .map(relativeAgeMs)
        .find((value) => Number.isFinite(value));
      createdAtMs = Number.isFinite(relative) ? now - relative : NaN;
    }

    if (!permalink && !activityUrn) {
      return; /* not an actual post (no self-link) — e.g. a composer card */
    }
    if (!Number.isFinite(createdAtMs)) {
      createdAtMs = now;
    }

    const id = activityUrn || idFromUrn || permalink;

    const mediaImg = item
      .find("img")
      .filter((j, img) => isMediaImage(bestImageSrc($, img)))
      .first();
    const imageUrls = mediaImg.length ? imageSources($, mediaImg) : [];
    const imageUrl = imageUrls[0] || "";

    const key = permalink || id;
    if (byKey.has(key)) {
      const existing = byKey.get(key);
      if (text.length > existing.text.length) {
        existing.text = text;
      }
      return;
    }

    byKey.set(key, {
      id,
      text,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : now,
      createdAt: new Date(Number.isFinite(createdAtMs) ? createdAtMs : now).toISOString(),
      permalink,
      imageUrl,
      imageUrls,
    });
  });

  return [...byKey.values()];
}

module.exports = {
  extractProfile,
  extractExperience,
  extractSkills,
  extractPosts,
  hasProfileSection,
};
