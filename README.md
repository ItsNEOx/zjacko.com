# zjacko.com — site + LinkedIn feed

The zjacko.com website: static vanilla HTML/CSS/JS with a strict CSP,
plus a tiny Express server for local development. Production needs no
Node at all — any host that can serve files (Apache/LiteSpeed,
Netlify, …) runs the site exactly as committed.

**The LinkedIn page is a local, read-only clone.** `linkedin.html`
renders your profile card from `data/linkedin.json` and your posts
from `data/posts.json` — a file you sync from LinkedIn's own official
"Download your data" export, or add to one post at a time. No LinkedIn
app, no API keys, no backend, and no code path anywhere that can
create, edit, or delete anything on LinkedIn. See
[Keeping the feed in sync](#keeping-the-feed-in-sync).

> **Why a local copy instead of the LinkedIn API?** (checked November
> 2026) The `r_member_social` permission — the only one that can read
> a member's posts — is closed to new apps: LinkedIn's [API
> FAQ](https://learn.microsoft.com/en-us/linkedin/marketing/lms-faq)
> calls it "a closed permission, and we're not accepting access
> requests this time due to resource constraints", and the same FAQ
> says displaying a feed of posts on your own website is not an
> approved use of their APIs. Scraping is additionally banned by
> LinkedIn's User Agreement. LinkedIn's official data export is the
> sanctioned way to get your own posts out in bulk — that is what the
> sync tools use.

```
zjacko/                      ← site root (static files)
├── server.js                ← Express dev server (local development only)
├── package.json             ← deps: express; dev-only: cheerio, playwright-core
├── linkedin.html            ← page with the profile card, certifications, + posts
├── data/linkedin.json       ← profile data for the card + certifications tab
├── data/posts.json          ← your LinkedIn posts (the feed itself)
├── assets/linkedin/         ← post images + your avatar (local, CSP-safe)
├── tools/import-shares.js   ← sync posts from LinkedIn's data export
├── tools/add-post.js        ← add a single post
├── tools/sync-linkedin.js   ← optional 4-hour sync from your PC (read-only)
├── tools/linkedin-dom.js    ← HTML extractors used by that sync
├── tools/register-sync-task.ps1 ← registers the 4-hour Windows Task
├── assets/js/linkedin-card.js    ← profile card component
├── assets/js/linkedin-certifications.js ← certifications side tab component
├── assets/js/linkedin-posts.js  ← posts feed component (read-only)
├── assets/css/linkedin-card.css ← shared LinkedIn component styles
├── assets/css/linkedin-posts.css← feed-specific styles
└── assets/css/linkedin-certifications.css ← side tab + panel styles
```

## Quick start

```powershell
# 1. Requires Node.js 18+
npm install

# 2. Start the dev server (serves the whole site at one origin)
npm start

# 3. Open the site:
#    http://localhost:3000/linkedin.html
#    → profile card + "Recent posts" feed, both rendered from
#      local JSON files — works right now, no LinkedIn setup needed
```

Stop it with `Ctrl+C`. For auto-restart during development: `npm run dev`.
Any other static web server works too — the site is fully static; a
dev server exists only because browsers block `fetch()` on `file://`
pages and the pages' CSP expects same-origin requests.

## How it works

1. `linkedin.html` loads three Web Components, all fed by static,
   same-origin JSON files:
   - `<linkedin-card data-src="data/linkedin.json">` — the profile
     card (name, headline, summary, skills, experience). Edit that
     file to change what is shown. Set `profile.avatar` to a local
     image path (e.g. `assets/linkedin/avatar.png`) to show your
     picture; leave it empty for the initials avatar.
   - `<linkedin-certifications data-src="data/linkedin.json">` — the
     Certifications & Licenses side tab, rendered from the same file's
     `certifications` array. It is docked to the right edge on wide
     screens and becomes an inline expandable section on narrow ones;
     when the array is empty, no tab is shown at all.
   - `<linkedin-posts data-src="data/posts.json" data-limit="5" …>` —
     the posts feed. `data-limit="5"` shows only the five newest posts;
     `data-more-url` adds a **View More on LinkedIn** link to the full
     activity page whenever the feed contains more than the limit.
2. Both files are same-origin, so the strict page CSP
   (`connect-src 'self'`, `img-src 'self'`) stays intact.
3. The posts component renders each post with `textContent` only —
   post text can never inject HTML into the page. `https://` URLs
   inside post text become real links; every post links back to
   LinkedIn via its permalink. Post images are local files under
   `assets/linkedin/` (referenced by relative paths), so nothing is
   ever loaded from LinkedIn's CDN. Images that fail to load are
   dropped instead of showing a broken-image icon.
4. The certifications tab renders every field with `textContent` too.
   Credential links are `https:` only and always carry
   `rel="noopener noreferrer"`; anything else is left unlinked. The
   tab never creates, edits, or deletes anything on LinkedIn.

## Keeping the feed in sync

`data/posts.json` is the feed. It ships with the site and is committed
to git like any other content file. Three ways to maintain it:

### 1. Bulk sync from LinkedIn's official export (recommended)

LinkedIn gives every member an official copy of their own data —
including every post they've shared:

1. On LinkedIn: **Me icon → Settings & Privacy → Data Privacy →
   "How LinkedIn uses your data" → Download your data**.
2. Request **the larger download** (the full archive — it contains
   `Shares.csv`). LinkedIn emails you a download link; it can take up
   to ~24 hours and the link stays valid for 72 hours.
3. Unzip it, then run (quote paths with spaces):

   ```powershell
   node tools/import-shares.js "C:\Users\you\Downloads\LinkedInDataExport-11-10-2026\Shares.csv"
   ```

That's LinkedIn handing you your own posts in machine-readable form —
the sanctioned way to clone them. The tool:

- keeps only posts shared as **"Anyone"** by default (the website is
  public — connections-only posts are skipped; `--all` overrides),
- skips plain reshares that have no comment text of their own,
- updates posts already in `data/posts.json` instead of duplicating
  them, and preserves any image you attached by hand,
- writes the file atomically and prints a summary of what it did.

Re-run it whenever you want to re-sync — it is offline, instant, and
free. Then commit `data/posts.json` and upload with the site.

### 2. Add a single post

Right after you publish something on LinkedIn:

```powershell
node tools/add-post.js "The post text, pasted from LinkedIn" https://www.linkedin.com/posts/zjacko_ab12cd34
```

Use LinkedIn's own **⋯ → Copy link to post** for the permalink. Options:
`--date "2026-11-10 18:30"` (defaults to now), `--image` /
`--alt` to attach a local image, `--out` to target a different file.
Adding a permalink that already exists updates that post.

### 3. With an image

The site CSP (`img-src 'self'`) blocks LinkedIn's CDN by design, so
post images are local files:

1. Save the image into `assets/linkedin/` (any name, e.g.
   `2026-11-launch.png`).
2. Reference it by relative path:

   ```powershell
   node tools/add-post.js "Shipped it" https://www.linkedin.com/posts/zjacko_xyz --image assets/linkedin/2026-11-launch.png --alt "The new site"
   ```

The bulk export's `Shares.csv` has no images, so photo posts imported
that way arrive text-only — attach images by hand as above when you
want them shown.

### File shape

`data/posts.json` mirrors what `<linkedin-posts>` validates:

```json
{
  "ok": true,
  "source": "file",
  "fetchedAt": "2026-11-11T18:30:00.000Z",
  "author": { "name": "Zach Jacko", "picture": "" },
  "count": 1,
  "posts": [
    {
      "id": "urn:li:share:7000000000000000001",
      "text": "Just shipped something…",
      "createdAtMs": 1762700000000,
      "createdAt": "2026-11-09T14:26:40.000Z",
      "visibility": "PUBLIC",
      "permalink": "https://www.linkedin.com/feed/update/urn:li:share:7000000000000000001/",
      "media": null
    }
  ]
}
```

`author.picture` may be a relative path (e.g. `assets/linkedin/avatar.png`)
- the feed shows the initials fallback when it is empty. `media` is
`null` or `{ "type": "IMAGE", "url": "assets/linkedin/...", "alt": "..." }`.

`data/linkedin.json` holds the profile card fields plus the certifications
shown in the side tab:

```json
{
  "profile": { "name": "…", "headline": "…", "avatar": "…", "linkedin_url": "…" },
  "skills": ["…"],
  "experience": [],
  "certifications": [
    {
      "title": "CCNA: Introduction to Networks",
      "issuer": "Cisco Networking Academy",
      "issued": "Oct 2026",
      "expires": "",
      "credentialUrl": "https://www.credly.com/badges/…"
    }
  ]
}
```

`credentialUrl` is optional. When `certifications` is empty, the side tab
is not rendered at all.

## Automatic 4-hour sync from your PC (optional)

> **Account risk:** LinkedIn's User Agreement prohibits automated scraping.
> This tool is for your own account only; running it can trigger LinkedIn
> security checkpoints and, in the worst case, account restrictions. The
> official export above is the risk-free route.

`tools/sync-linkedin.js` keeps `data/linkedin.json` and `data/posts.json`
word-for-word in sync with your own LinkedIn pages. It reads the profile,
skills, Certifications & Licenses, and recent-activity pages, runs only on
your PC, in a dedicated browser profile you sign into once — no passwords
are stored anywhere, and nothing is ever written to LinkedIn.

1. One-time sign-in (opens a browser window; sign in normally — including
   any 2FA — and it continues by itself):

   ```powershell
   node tools/sync-linkedin.js --login
   ```

2. Sync now:

   ```powershell
   node tools/sync-linkedin.js --dump    # sync + save raw HTML (debugging)
   node tools/sync-linkedin.js --push    # sync + git commit + push
   ```

3. Update every 4 hours (Windows Scheduled Task):

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\register-sync-task.ps1
   ```

   The task runs `node tools\sync-linkedin.js --push` every 4 hours while
   you are signed in, commits only when something changed, and pushes so
   your host picks it up. Remove it with
   `schtasks /delete /tn "zjacko LinkedIn sync" /f`.

Notes:

- The browser session (cookies), logs, and HTML dumps live in
  `%LOCALAPPDATA%\zjacko-linkedin-sync\` — outside the repo and never
  uploaded. Delete that folder to sign out.
- If the session expires the task logs it and stops; run `--login` again.
- Posts marked "Anyone" (public) are synced; connections-only posts are
  skipped so they never appear on the public site. `--all` overrides
  this, but those posts become public.
- LinkedIn's markup changes over time. If extraction breaks, `--dump`
  saves the HTML and the selectors in `tools/linkedin-dom.js` need a
  touch-up. `node tools/sync-linkedin.js --parse <dump-dir>` tests the
  extractors offline.

## Security model

The site's strict CSP (`default-src 'none'; script-src 'self';
style-src 'self'; img-src 'self' data:; connect-src 'self'; …`) is the
first layer: no inline scripts or styles, no CDNs, no frameworks, and
no cross-origin fetches or images anywhere.

- **Fully static.** There is no API, no database, and no write path
  of any kind — and nothing that can create, edit, or delete anything
  on LinkedIn. The feed and the card are JSON files committed with
  the site.
- **Text-only rendering.** Both components render every field with
  `textContent` (no `innerHTML` with data anywhere), so nothing in
  the JSON can inject markup or script. Only `https://` URLs inside
  post text become links, and generated links always carry
  `rel="noopener noreferrer"`.
- **Local images only.** Avatars and post images must be same-origin
  paths (or `data:` URIs); anything with a scheme, protocol-relative
  `//`, or `..` is rejected and the initials/no-image fallback is
  used. The CSP's `img-src 'self' data:` backs this up.
- **No secrets in the repo.** There are none to leak: the site needs
  no keys, and the export tools run fully offline. The optional local
  scraper keeps its browser session in
  `%LOCALAPPDATA%\zjacko-linkedin-sync\` (outside the repo) and never
  stores a password or access token.
- **Read-only everywhere.** No code path can create, edit, or delete
  anything on LinkedIn; the local scraper only reads your own pages.
- **Dev server hardening.** `server.js` never serves repo/backend
  files (`server.js`, `package.json`, `package-lock.json`,
  `node_modules/`, `tools/`, `README`, dotfiles like `.env` and
  `.git`), sets `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  and `Referrer-Policy` on every response, and disables
  `x-powered-by`. (Your `.htaccess` blocks dotfiles on Apache hosts
  as well.)

## Deployment notes

- **Static hosts (Apache/LiteSpeed, Netlify, anything):** upload the
  site files and you are done — the feed, the card, everything works.
  `data/posts.json` is just a static file.
- **Do NOT upload** `server.js`, `package.json`, `package-lock.json`,
  `node_modules/`, or `tools/` — they are local development helpers,
  not site content.
- After syncing the feed (`tools/import-shares.js` or
  `tools/add-post.js`), commit `data/posts.json` (plus any new images
  in `assets/linkedin/`) and upload it with the site.

## View on GitHub Pages

The site is fully static, so GitHub Pages can serve it directly:

1. Make the repo **public** (Settings → General → Danger Zone) — GitHub
   Pages on a private repo requires a paid plan.
2. Settings → Pages → Source **Deploy from a branch** → `main` /
   `/ (root)` → Save.
3. It is live at <https://itsneox.github.io/zjacko.com/> a minute later.
   All site paths are relative and `.nojekyll` keeps Pages from processing
   files, so the site runs unchanged at the project URL.

GitHub Pages ignores `.htaccess` and `_headers`, so response headers
there are GitHub's defaults; the page CSP meta tag still enforces the
site's own restrictions.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| import-shares: "Could not find column(s) …" | That CSV isn't the Shares.csv from the full export — request the **larger download** (full archive) and point the tool at its Shares.csv. |
| import-shares skipped some posts | Posts shared as "Connections only" are skipped by default (the site is public), and plain reshares without your own comment are skipped too. Use `--all` to include non-public posts. |
| Feed shows "No public posts yet" | `data/posts.json` has no posts yet — run `node tools/import-shares.js …` after requesting LinkedIn's data export, or add one with `node tools/add-post.js …`. |
| Feed shows "Could not load data/posts.json (404)" | The file wasn't uploaded with the site — commit it and redeploy. |
| Feed/card show "Could not load …" with a fetch error | The page was opened straight from a folder (file://), where fetch() is blocked — serve the site over HTTP(S) instead (`npm start`, or your web host). |
| Profile picture not showing | Set `profile.avatar` in `data/linkedin.json` to a local path such as `assets/linkedin/avatar.png` (put the file there first). Post images: attach with `tools/add-post.js --image`. |
