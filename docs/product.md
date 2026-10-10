# Product data and outputs (Tracks B and C)

- Product source interface with providers: page extractor (primary, every site), SerpApi
  (optional Amazon enrichment), mock. The rest of the pipeline only sees ProductJSON.
- Extraction tiers, fastest first: JSON-LD/meta tags → site adapter (Amazon.in, Flipkart) →
  LLM fallback on cleaned visible main-content text (Readability, capped at ~4k tokens, small
  fast model, JSON only). When the fallback runs, also ask which elements held each field and
  save them as a learned adapter for that site.
- Start extraction at page load. Speak title and price from title/meta tags immediately while
  the rest fills in.
- Payable details (price, offers, stock, delivery, seller, selected variant) always come from
  the live page. Record the source of each field.
- Voice search navigates the real tab to the site's search URL and reads results from the page.
- On product open: one data fetch, then parallel precompute of specs, reviews, image
  descriptions and comparison candidates into cached AccessibleOutput sections. Speak a short
  overview and offer sections; translate and speak only what the user asks for.
- Reviews: use the page's "Customers say" summary, visible reviews and (if enabled) SerpApi
  review insights with mention counts. State what the summary is based on; never claim to have
  read reviews we didn't fetch.
- Comparison/recommendation: hard constraints filter, normalised features get weights from the
  user's stated preferences, code ranks, the LLM only explains. Weights never come from the
  user's disability profile unless the user asks for an accessibility feature.
- Images: describe the main image and up to two more on request; buying-relevant details
  (colour, shape, what's in the box, ports, visible text); say when something is unclear.
  Size charts: read the HTML table if there is one, use the VLM only for image charts.
  Cache descriptions by image URL.
- Workflows (place, track, return, cancel) are step machines: extract → ask → act → verify,
  with a step limit and confirmations; the LLM only fills slots.
- Declare every library, API and dataset in the README as it's added.
