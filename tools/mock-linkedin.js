"use strict";

/* Mock of LinkedIn's APIs for local end-to-end testing.
   GET  /oauth/authorization -> OAuth consent: 302 back to the caller's
                                redirect_uri with a single-use code+state
   POST /oauth/accessToken    -> exchanges that code for a mock token
                                (validates client id/secret/redirect_uri)
   GET  /rest/posts?...       -> realistic Posts API finder response
   GET  /v2/userinfo          -> OpenID userinfo (name + picture URL)
   GET  /media/avatar.png     -> generated PNG (profile picture)
   GET  /media/post1.png      -> generated PNG (post image)
   GET  /media/broken.png     -> 404 (tests the frontend's graceful failure)
   GET  /__last              -> the last /rest/posts, /v2/userinfo or
                                /oauth/* request seen */

const http = require("http");
const zlib = require("zlib");

const PORT = 4545;
let lastRequest = null;

/* The "app credentials" this mock expects — match them in the site
   server's env: LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET. */
const MOCK_CLIENT_ID = "mock-client-id";
const MOCK_CLIENT_SECRET = "mock-client-secret";
const issuedAuthCodes = new Map(); /* code -> { redirectUri, scope, used } */
let codeCounter = 0;
let tokenCounter = 0;

/* ---------- tiny PNG generator (RGB, no dependencies) ---------- */

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from([
    (type >> 24) & 255,
    (type >> 16) & 255,
    (type >> 8) & 255,
    type & 255
  ]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width, height, rgbFn) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; /* bit depth */
  ihdr[9] = 2; /* color type: truecolor RGB */

  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; /* filter: none */
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk(0x49484452, ihdr), /* IHDR */
    pngChunk(0x49444154, zlib.deflateSync(raw, { level: 9 })), /* IDAT */
    pngChunk(0x49454e44, Buffer.alloc(0)) /* IEND */
  ]);
}

/* Purple/blue gradient avatar, 240x240 */
const AVATAR_PNG = makePng(240, 240, (x, y) => {
  const t = (x + y) / 480;
  return [Math.round(40 + 80 * t), Math.round(30 + 60 * t), Math.round(120 + 110 * t)];
});

/* Wide gradient with diagonal stripe, 640x340 */
const POST_PNG = makePng(640, 340, (x, y) => {
  const t = x / 640;
  if (Math.abs(x - y * 1.4) < 40) {
    return [235, 240, 255];
  }
  return [Math.round(20 + 60 * t), Math.round(25 + 45 * t), Math.round(70 + 110 * t)];
});

const BASE = "http://127.0.0.1:" + PORT;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/__last")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastRequest));
    return;
  }

  /* Media: no capture, just serve bytes. */
  if (req.url.startsWith("/media/avatar.png")) {
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": AVATAR_PNG.length });
    res.end(AVATAR_PNG);
    return;
  }
  if (req.url.startsWith("/media/post1.png")) {
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": POST_PNG.length });
    res.end(POST_PNG);
    return;
  }
  if (req.url.startsWith("/media/broken.png")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no such image" }));
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    lastRequest = {
      method: req.method,
      url: req.url,
      headers: {
        authorization: req.headers["authorization"] || "",
        "linkedin-version": req.headers["linkedin-version"] || "",
        "x-restli-protocol-version": req.headers["x-restli-protocol-version"] || "",
        "x-restli-method": req.headers["x-restli-method"] || "",
        accept: req.headers["accept"] || ""
      },
      receivedAt: new Date().toISOString()
    };

    if (req.method === "GET" && req.url.startsWith("/oauth/authorization")) {
      const u = new URL(req.url, BASE);
      const qp = u.searchParams;
      const redirectUri = qp.get("redirect_uri") || "";
      if (qp.get("response_type") !== "code" || qp.get("client_id") !== MOCK_CLIENT_ID || !redirectUri) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: "bad authorize request" }));
        return;
      }
      const code = "MOCK_AUTH_CODE_" + ++codeCounter;
      issuedAuthCodes.set(code, { redirectUri: redirectUri, scope: qp.get("scope") || "", used: false });
      const sep = redirectUri.includes("?") ? "&" : "?";
      res.writeHead(302, {
        Location:
          redirectUri +
          sep +
          "code=" +
          encodeURIComponent(code) +
          "&state=" +
          encodeURIComponent(qp.get("state") || "")
      });
      res.end();
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/oauth/accessToken")) {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const code = form.get("code") || "";
      const issued = issuedAuthCodes.get(code);
      lastRequest = {
        method: req.method,
        url: req.url,
        tokenExchange: {
          grant_type: form.get("grant_type") || "",
          code: code,
          client_id: form.get("client_id") || "",
          has_client_secret: Boolean(form.get("client_secret")),
          redirect_uri: form.get("redirect_uri") || ""
        },
        receivedAt: new Date().toISOString()
      };
      if (
        form.get("grant_type") !== "authorization_code" ||
        !issued ||
        issued.used ||
        form.get("redirect_uri") !== issued.redirectUri ||
        form.get("client_id") !== MOCK_CLIENT_ID ||
        form.get("client_secret") !== MOCK_CLIENT_SECRET
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "invalid_request",
            error_description: "Unable to retrieve access token: authorization code not found"
          })
        );
        return;
      }
      issued.used = true;
      const token = "mock-access-token-" + ++tokenCounter;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: token, expires_in: 5184000, scope: issued.scope }));
      return;
    }

    if (req.url.startsWith("/v2/userinfo")) {
      const body = {
        sub: "testuser123",
        name: "Zach Jacko",
        given_name: "Zach",
        family_name: "Jacko",
        locale: { country: "US", language: "en" },
        email: "zach@example.com",
        email_verified: true,
        picture: BASE + "/media/avatar.png"
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.url.startsWith("/rest/posts")) {
      const now = Date.now();
      const body = {
        elements: [
          {
            /* text + image + URL linkify */
            id: "urn:li:share:7000000000000000001",
            commentary:
              "Just shipped a read-only LinkedIn feed for zjacko.com.\nMore details: https://zjacko.com/portfolio.html",
            content: {
              media: {
                id: "urn:li:media:/C4D22AAEtest1",
                type: "IMAGE",
                altText: "A gradient test image with a diagonal stripe",
                thumbnails: [{ url: BASE + "/media/post1.png", width: 640, height: 340 }]
              }
            },
            createdAt: now - 3 * 24 * 60 * 60 * 1000,
            lifecycleState: "PUBLISHED",
            visibility: { "com.linkedin.ugc.MemberShareVisibility": "PUBLIC" }
          },
          {
            /* text only */
            id: "urn:li:share:7000000000000000002",
            commentary: "Passed the Security+ exam today! (mock post, testing multiline text)",
            createdAt: now - 8 * 60 * 60 * 1000,
            lifecycleState: "PUBLISHED",
            visibility: { "com.linkedin.ugc.MemberShareVisibility": "PUBLIC" }
          },
          {
            /* filtered: CONNECTIONS visibility */
            id: "urn:li:share:7000000000000000003",
            commentary: "This post should be filtered out: CONNECTIONS visibility",
            createdAt: now - 2 * 60 * 60 * 1000,
            lifecycleState: "PUBLISHED",
            visibility: { "com.linkedin.ugc.MemberShareVisibility": "CONNECTIONS" }
          },
          {
            /* photo-only post, no caption — now included */
            id: "urn:li:share:7000000000000000004",
            commentary: "",
            content: {
              media: {
                id: "urn:li:media:/C4D22AAEtest4",
                type: "IMAGE",
                altText: "Photo post without a caption",
                thumbnails: [{ url: BASE + "/media/post1.png", width: 640, height: 340 }]
              }
            },
            createdAt: now - 4 * 24 * 60 * 60 * 1000,
            lifecycleState: "PUBLISHED",
            visibility: { "com.linkedin.ugc.MemberShareVisibility": "PUBLIC" }
          },
          {
            /* filtered: DRAFT */
            id: "urn:li:share:7000000000000000005",
            commentary: "DRAFT should be filtered out",
            createdAt: now,
            lifecycleState: "DRAFT",
            visibility: { "com.linkedin.ugc.MemberShareVisibility": "PUBLIC" }
          },
          {
            /* text + media that 404s — the figure must vanish in the UI */
            id: "urn:li:share:7000000000000000006",
            commentary: "This post has a broken image URL — the image should disappear.",
            content: {
              media: {
                id: "urn:li:media:/C4D22AAEtest6",
                type: "IMAGE",
                thumbnails: [{ url: BASE + "/media/broken.png" }]
              }
            },
            createdAt: now - 5 * 60 * 1000,
            lifecycleState: "PUBLISHED",
            visibility: { "com.linkedin.ugc.MemberShareVisibility": "PUBLIC" }
          }
        ],
        paging: { count: 10, start: 0 }
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("mock LinkedIn listening on " + BASE);
});
