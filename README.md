# zjacko.com — LinkedIn posts feed server

A small, self-hosted Node.js / Express backend that **pulls your LinkedIn
posts** and shows them on `linkedin.html` — read-only by design. There is
no endpoint (and no code path) that can create, edit, or delete anything
on LinkedIn.

It also serves the static site itself, so the site and the API share one
origin — that's what keeps the site's strict CSP (`connect-src 'self'`)
intact.

```
zjacko/                      ← site root (static files, unchanged)
├── server.js                ← Express backend (this server)
├── package.json             ← deps: express, cors, dotenv
├── .env.example             ← template for secrets
├── .env                     ← your real secrets (never commit/upload)
├── linkedin.html            ← page with the profile card + posts feed
├── connect.html             ← owner-only page: one-click LinkedIn Connect
├── data/linkedin.json       ← profile data for the card (fallback)
├── private/                 ← OAuth token from Connect (created on demand,
│                               never served, gitignored)
├── tools/mock-linkedin.js   ← mock LinkedIn server for offline testing
├── assets/js/linkedin-card.js    ← profile card component
├── assets/js/linkedin-posts.js  ← posts feed component (read-only)
├── assets/js/connect.js          ← drives the Connect page
├── assets/css/linkedin-card.css ← shared LinkedIn component styles
└── assets/css/linkedin-posts.css← feed-specific styles
```

## Quick start

```powershell
# 1. Requires Node.js 18+
npm install

# 2. Create your config
copy .env.example .env

# 3. Fill in LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET and
#    LINKEDIN_ADMIN_KEY (one-time LinkedIn app setup — see the next
#    section)

# 4. Start the server
npm start

# 5. Open http://localhost:3000/connect.html once and click
#    "Connect LinkedIn" (log in as yourself, click Allow)

# 6. Open the site it serves:
#    http://localhost:3000/linkedin.html
#    → profile card + "Recent posts" feed pulled from LinkedIn
```

While the server runs, it serves the whole website at `http://localhost:3000`
exactly like your host does, plus the API endpoints below. Stop it with
`Ctrl+C`. For auto-restart during development: `npm run dev`.

## How it works

1. The browser loads `linkedin.html` (served by this server, same origin).
2. `<linkedin-posts>` fetches `/api/linkedin/posts` — a relative path, so
   the page CSP's `connect-src 'self'` stays valid.
3. The server checks its in-memory cache. On a miss it calls LinkedIn's
   Posts API:
   `GET https://api.linkedin.com/rest/posts?q=author&author={your URN}&count=10&sortBy=LAST_MODIFIED`
   with your token from `.env`, maps the response down to plain text +
   timestamps + permalinks + proxied image URLs, caches it for
   `FEED_CACHE_SECONDS` (default 15 minutes), and returns it.
4. In the same refresh it calls LinkedIn's userinfo endpoint
   (`/v2/userinfo`, OpenID Connect) for your live name and profile
   picture — the feed shows an avatar + name + relative time on every
   post, just like LinkedIn does. (If userinfo fails, posts still
   render without the author header.)
5. Images (post photos, article thumbnails, your profile picture) are
   **never loaded from LinkedIn directly** — the CSP's `img-src 'self'`
   would block that by design. Instead the server returns
   `/api/linkedin/media?src=…` URLs, which proxy the bytes from
   LinkedIn's CDN (media.licdn.com) through this origin.
6. The component renders each post using `textContent` only — post text
   can never inject HTML into the page. `https://` links inside post
   text become real links; everything else stays plain text. Each post
   links back to LinkedIn via its permalink. Images that fail to load
   are dropped instead of showing a broken-image icon.

## Connecting your LinkedIn (one click)

Everything except the LinkedIn app itself is automated — no manual
token minting, no hunting for your member URN. You do the app setup
once; connecting and renewing is a button.

> **Heads-up: reading your own posts needs LinkedIn's approval.**
> The `r_member_social` scope (it reads your posts) is **restricted** —
> LinkedIn reviews and must approve your app for it (it is part of the
> Community Management API program). Your live name and photo
> (`openid`, `profile`) are self-serve and work instantly. So: connect
> today for the profile card, request post access in the portal, and
> the feed lights up once LinkedIn approves it.

1. **Create an app** at <https://www.linkedin.com/developers/apps>.
   LinkedIn requires apps to be attached to a Page you administer
   (a company/creator page).
2. **Products tab** → add **"Sign In with LinkedIn using OpenID
   Connect"** — granted instantly; carries the `openid` and `profile`
   scopes (live name + profile picture).
3. **Products tab** → also request **"Community Management API"** —
   carries `r_member_social` (read your own posts). This one requires
   LinkedIn's review; expect a wait and possible follow-up.
4. **Auth tab** → add a Redirect URL: `https://zjacko.com/api/linkedin/callback`
   (LinkedIn requires absolute **HTTPS** URLs; query parameters are
   ignored).
5. **Auth tab** → copy the **Client ID** and **Client Secret** into
   `.env`, pick a long random `LINKEDIN_ADMIN_KEY`, and — if the API
   answers on a different origin than the site — set
   `LINKEDIN_REDIRECT_URI` to the exact URL you registered.
6. `npm start`, open <http://localhost:3000/connect.html>, enter the
   owner key, click **Connect LinkedIn**, log in as yourself, click
   **Allow**. Done: the server stores the token in `private/`, the
   member URN is discovered automatically, and `linkedin.html` shows
   your live data.

Member tokens last **60 days** (LinkedIn's policy; programmatic refresh
tokens exist only for select partners). Renewing is just opening
`connect.html` again and clicking Connect — while you are still logged
in to LinkedIn there is no consent screen, it's one click. The page
shows how many days are left and when the token expires.

If your app is still waiting for Community Management approval, you can
connect profile-only meanwhile: set `LINKEDIN_SCOPES=openid profile` in
`.env`, connect, and switch it back to the default after approval.

### Manual fallback (optional)

If you'd rather mint tokens by hand — e.g. with the [token
generator](https://www.linkedin.com/developers/tools/oauth/token-generator) —
set these in `.env` instead; a token stored by the Connect flow takes
precedence over them:

```env
LINKEDIN_ACCESS_TOKEN=your_oauth_2_access_token
LINKEDIN_AUTHOR_URN=urn:li:person:YOUR_MEMBER_ID
```

Find your member id in the `sub` field of:

```powershell
curl.exe -H "Authorization: Bearer YOUR_TOKEN" https://api.linkedin.com/v2/userinfo
```

## API reference

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/health` | GET | `{ ok, feed, connected, oauthReady, cacheReady }` |
| `/api/linkedin/posts` | GET | The site owner's posts (text, images, permalinks, author) |
| `/api/linkedin/profile` | GET | Live name + profile picture (via OpenID userinfo) |
| `/api/linkedin/media?src=…` | GET | Proxies one image from LinkedIn's CDN (strict allowlist) |
| `/api/linkedin/auth?key=…` | GET | Owner-only: starts the OAuth Connect flow (302 to LinkedIn) |
| `/api/linkedin/callback` | GET | OAuth redirect target — validates the single-use state, exchanges the code server-side |
| `/api/linkedin/status` | GET | Connection status for `connect.html` (no secrets in the answer) |
| `/api/linkedin/disconnect` | POST | Deletes the locally stored token (needs the owner key; never talks to LinkedIn) |

`GET /api/linkedin/posts` accepts no parameters — the author, post count,
visibility filtering, and caching are all server-side configuration, so a
client can never steer the query. A `POST` to it gets a `405 read-only`
answer.

`GET /api/linkedin/media` only fetches URLs on LinkedIn's media CDN
(`media.licdn.com` and friends, https only), refuses anything that is not
an image, caps the size at 8 MB, never follows redirects, and serves the
result with `Cache-Control: public, max-age=86400` so browsers cache each
image for a day.

**Success:**
```json
{
  "ok": true,
  "source": "linkedin",
  "fetchedAt": "2026-11-10T12:00:00.000Z",
  "author": {
    "name": "Zach Jacko",
    "picture": "/api/linkedin/media?src=https%3A%2F%2Fmedia.licdn.com%2F…"
  },
  "count": 2,
  "posts": [
    {
      "id": "urn:li:share:7000000000000000001",
      "text": "Just shipped a read-only LinkedIn feed…",
      "createdAtMs": 1762700000000,
      "createdAt": "2026-11-09T14:26:40.000Z",
      "visibility": "PUBLIC",
      "permalink": "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7000000000000000001/",
      "media": {
        "type": "IMAGE",
        "url": "/api/linkedin/media?src=https%3A%2F%2Fmedia.licdn.com%2F…",
        "alt": "Alt text LinkedIn has for the image"
      }
    }
  ]
}
```

**Errors** return clean JSON:
```json
{ "ok": false, "error": "LinkedIn is not connected yet — open /connect.html to run the one-click Connect flow, or set LINKEDIN_ACCESS_TOKEN / LINKEDIN_AUTHOR_URN in .env." }
```

The `X-Cache: hit|miss` response header shows whether the answer came
from the in-memory cache.

## Caching

- The server caches LinkedIn's mapped response for `FEED_CACHE_SECONDS`
  (default 900 = 15 minutes), so page views never hammer LinkedIn.
- Your name + profile picture are cached separately for
  `PROFILE_CACHE_SECONDS` (default 3600 = 1 hour).
- Concurrent cache misses share a single upstream request.
- The rate limiter (30 requests / 10 minutes / IP) only counts requests
  that would trigger an upstream call — normal browsing is never limited.
  Media proxy requests get a higher bucket (120 / 10 minutes) and are
  cached by the browser for a day.
- Set `FEED_CACHE_SECONDS=0` to disable caching (e.g. while testing).

## Local testing without real credentials

A mock LinkedIn server (Posts API + userinfo + generated PNG images +
OAuth authorize/token endpoints) ships with the repo at
`tools/mock-linkedin.js`. Run it, then start the site server with test
overrides:

```powershell
node tools/mock-linkedin.js                   # mock on http://127.0.0.1:4545

$env:LINKEDIN_CLIENT_ID="mock-client-id"      # must match mock-linkedin.js
$env:LINKEDIN_CLIENT_SECRET="mock-client-secret"
$env:LINKEDIN_ADMIN_KEY="pick-any-key-for-local-testing"
$env:LINKEDIN_AUTHORIZE_URL="http://127.0.0.1:4545/oauth/authorization"
$env:LINKEDIN_TOKEN_URL="http://127.0.0.1:4545/oauth/accessToken"
$env:LINKEDIN_API_URL="http://127.0.0.1:4545/rest/posts"
$env:LINKEDIN_USERINFO_URL="http://127.0.0.1:4545/v2/userinfo"
$env:LINKEDIN_MEDIA_HOSTS="127.0.0.1"         # allow the mock as media host
npm start
```

Then open <http://localhost:3000/connect.html>, enter the admin key you
picked, and click **Connect LinkedIn** — the mock plays LinkedIn: it
bounces through its own OAuth endpoints and hands back a mock token, so
you can test the whole round trip (including `private/` token storage
and the auto-discovered author URN) without a real LinkedIn app.
`linkedin.html` then shows mock posts with generated images.

The `LINKEDIN_*_URL` / `LINKEDIN_MEDIA_HOSTS` overrides exist only for
this kind of local mock testing — leave them unset in production.

## Testing the real Connect flow without deploying

LinkedIn only accepts **HTTPS** redirect URLs, so plain
`http://localhost:3000` can't be registered on the app. To run the
*real* round trip from your own machine first, put a temporary HTTPS
tunnel in front of the local server, register its callback URL on your
LinkedIn app, and Connect through it:

1. Start the tunnel (options below) and note its URL, e.g.
   `https://random-characters.example.net`.
2. In your LinkedIn app's **Auth** tab, add
   `https://random-characters.example.net/api/linkedin/callback` as a
   Redirect URL (it must match exactly).
3. Set `LINKEDIN_REDIRECT_URI` in `.env` to that same callback URL and
   restart the server (`npm start`, real `.env` values in place).
4. Open `https://random-characters.example.net/connect.html`, enter
   your owner key, click **Connect LinkedIn**, log in as yourself,
   click **Allow** — you're connected for real: live profile photo
   immediately, real posts once the Community Management API is
   approved.
5. When finished, remove the Redirect URL from the LinkedIn app.

Tunnel options:

- **ngrok** (free account required) — `ngrok http 3000`. The URL stays
  stable for the whole session.
- **localhost.run** (no account) —
  `ssh -R 80:localhost:3000 nokey@localhost.run`. Anonymous domains
  rotate to a new random name every few minutes — fine for one quick
  round trip, or open a free localhost.run account and add your SSH
  key for a stable subdomain.
- **cloudflared quick tunnels** (no account) —
  `cloudflared.exe tunnel --url http://localhost:3000` from
  <https://github.com/cloudflare/cloudflared/releases/latest>.

Caveat — some networks (school/office filters, some security software)
block public tunnel services outright while allowing normal hosts:
observed on one such network — `*.lhr.life` and VS Code's
`devtunnels.ms` connections time out, `api.trycloudflare.com` is
refused mid-TLS-handshake, while `*.ngrok.app` and regular hosting
providers stay reachable. If every tunnel fails on your network, either
switch networks (a phone hotspot is the usual fix) or skip the tunnel:
push this repo to a free Node host (Render, Railway, Fly.io), register
that host's callback URL in the LinkedIn app instead, and test there —
that's a truer dress rehearsal for production anyway.

For production, register the permanent callback
(`https://zjacko.com/api/linkedin/callback`) on whatever host runs this
server instead.

## Security model

Your site's CSP (`connect-src 'self'`) stays untouched — that's why this
server serves the site itself. The component fetches the relative path
`/api/linkedin/posts`, so browser and API share one origin. Additional
layers:

- **Read-only.** There is no write endpoint of any kind — nothing on this
  site, and no HTTP call to this server, can post to LinkedIn.
- **Secrets never reach the browser.** The LinkedIn token lives only on
  the server: either in `.env`, or (preferred) in
  `private/linkedin-token.json` after the Connect flow — a directory the
  static middleware refuses to serve and `.gitignore` excludes.
- **Owner-only Connect flow.** `/api/linkedin/auth` requires the
  `LINKEDIN_ADMIN_KEY` owner password (compared timing-safely), so a
  stranger can never point your feed at their own LinkedIn account. The
  OAuth callback validates a single-use, 10-minute random `state`
  (CSRF), and the client secret is only ever POSTed to LinkedIn's token
  endpoint. `connect.html` is `noindex`ed and unlinked from the nav.
- **Client can't steer the query.** The feed endpoint takes no parameters;
  author, count, and visibility filtering are fixed server-side.
- **Text-only rendering.** Post text is rendered with `textContent` (no
  innerHTML anywhere), only `https://` URLs inside posts become links,
  and generated links always carry `rel="noopener noreferrer"`. The
  Connect page likewise renders everything with `textContent` — error
  messages are fixed server-agreed codes, never raw URL text.
- **Media proxy, not direct loading.** LinkedIn's CDN is blocked by the
  site CSP's `img-src 'self'` by design; images flow through
  `/api/linkedin/media`, which allowlists LinkedIn's CDN hosts (https
  only — no SSRF to arbitrary hosts), refuses non-image content types,
  caps size at 8 MB, never follows redirects, and never sends your token
  to non-LinkedIn hosts. Images that fail to load are dropped from the
  page rather than showing broken-image icons.
- **Live profile picture is an enhancement, never a requirement.** If
  userinfo fails (static host, server down, missing `openid`/`profile`
  scopes), the card keeps rendering from `data/linkedin.json` with the
  initials avatar.
- **Public posts only** by default (`FEED_PUBLIC_ONLY=1`) — the website is
  public, so connection-only posts stay private.
- **CORS closed by default.** No cross-origin browser calls are allowed
  unless you set `CORS_ORIGIN` (only needed for split-origin setups).
- **No file leaks.** `.env`, `server.js`, `package.json`, `node_modules`,
  `private/` and all dotfiles are never served by the static middleware.
  (Your existing `.htaccess` blocks dotfiles on Apache, and now 404s
  `/private/`, as a second layer.)
- **Time-boxed upstream calls** (15 s timeout), `x-powered-by` disabled,
  `Cache-Control: no-store` on API responses (caching happens server-side,
  where it's controlled).

## Deployment notes

- **Local-only (simplest):** run `npm start` whenever you want the feed
  live, stop it when done. Nothing is exposed to the network.
- **Always-on:** host this server on a small VPS/container behind nginx,
  reverse-proxying `zjacko.com` (static + `/api/*`) to it. Set
  `TRUST_PROXY=1` (correct client IPs for rate limiting) and keep HTTPS.
- **Static hosts (Apache/LiteSpeed, Netlify):** a Node server cannot run
  there, so on the static deployment the feed will show its
  "Posts unavailable" state unless you host this server somewhere and
  proxy `/api/*` to it. Everything else on the site keeps working.
- **Do NOT upload** `.env`, `node_modules/`, `server.js`, or
  `package.json` to your static host — they belong to this server only.
  (`.gitignore` already excludes them from git.)

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Posts unavailable — LinkedIn denied access (403)" | `r_member_social` is a restricted scope; LinkedIn hasn't approved your app yet (or the token lacks it). |
| Connect ends on "LinkedIn refused the token exchange" | `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` in `.env` don't match the app, or the Redirect URL registered in the app doesn't exactly match the one used (`LINKEDIN_REDIRECT_URI`). |
| Connect ends on "permission prompt was cancelled" | You closed or denied LinkedIn's consent screen — click Connect again. |
| "LinkedIn rejected the access token" | Token expired (they last 60 days) — open `connect.html` and click Connect again (one click while logged in to LinkedIn). |
| Posts show but without your avatar/name | Token lacks the `openid`/`profile` scopes (userinfo failed) — reconnect with them included. |
| 503 "LinkedIn is not connected yet" | No stored token and no `.env` token — open `connect.html`, or fill `LINKEDIN_ACCESS_TOKEN` / `LINKEDIN_AUTHOR_URN`. |
| "Could not reach the feed server" | Server not running, or the page isn't served by it — open the site via `http://localhost:3000`. On a static host, the Node server isn't running there. |
| Feed shows "No public posts yet" | You have no posts, or all were filtered out (drafts, or connection-only posts when `FEED_PUBLIC_ONLY=1`). |
| Images missing from posts | The media proxy failed for that image (it's dropped rather than shown broken) — check the server log; LinkedIn CDN URLs can expire. |
| 429 "Too many requests" | Rate limit hit — wait a few minutes. |
