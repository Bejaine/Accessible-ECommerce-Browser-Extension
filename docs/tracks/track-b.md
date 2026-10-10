# Track B — Page understanding and actions

Owns: `extension/src/extract/`, `extension/src/actuate/`, `mock-store/`, `fixtures/pages/`.

Deliver, in order:
1. Hour 2: save HTML fixtures — 5 product, 2 search, cart, orders pages from Amazon.in and Flipkart.
2. Hour 8: extractor = JSON-LD → site adapter → LLM-fallback request, producing valid `ProductJSON`
   from every fixture; page map of interactive targets `{id, kind, label}`.
3. Hour 12: actuator for click / fill (React-safe events) / select / navigate, with result checks
   (e.g. cart count changed); secure-zone detection that pauses mic and extraction.
4. Hour 20: order list + order detail extraction (`OrderJSON`), mock store with full checkout and
   returns for the backup demo; learned adapters saved from LLM fallback.

Done means: `make check` validates every fixture's extraction against the schema.


Also yours: secure-zone detection, extraction tiers and learned adapters (docs/product.md).
