Post images live here.

The site CSP allows same-origin images only (img-src 'self'), so LinkedIn
CDN links can never be used directly. Save the image for a post into this
folder, then reference it from its site-root path:

  node tools/add-post.js "Post text" https://www.linkedin.com/posts/... --image /assets/linkedin/photo.png --alt "what it shows"

Tip: keep filenames short and unique (e.g. 2026-11-launch.png) — they are
committed with the site.
