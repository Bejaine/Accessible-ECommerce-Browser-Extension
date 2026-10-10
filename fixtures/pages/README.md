# Saved pages (Track B)

Saved HTML of real Amazon.in / Flipkart pages used for extractor tests. No personal data.

- `manifest.json` lists each file with the URL it was saved from and the page type the extractor
  must detect. Tests in `extension/tests/extract/` run the extractor on every entry and validate
  the result against `shared/schemas/` (so `make check` covers them).
- Captured logged-out with curl on 2026-10-10 (a desktop Chrome user agent), then cleaned with
  `node fixtures/pages/tools/sanitize.mjs <raw.html> <out.html> <source-url>`: page scripts are
  removed (JSON-LD is kept), reviewer names/profile links and session/CSRF tokens are redacted.
- Not here yet: cart with items, orders and order-detail pages. They need a logged-in account;
  save them from your own browser (File → Save Page As, HTML only), run the sanitiser, and
  replace names, addresses, phone numbers and order IDs before committing.
