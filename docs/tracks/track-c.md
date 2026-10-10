# Track C — Brain (backend)

Owns: `backend/app/brain/`, `backend/app/routes/`, `backend/app/services/serpapi.py`.

Deliver, in order:
1. Hour 2: FastAPI skeleton, `/health`, MOCK mode serving `fixtures/mocks/`.
2. Hour 8: `/turn` orchestrator — one LLM call with function calling over PageContext; tools:
   summarise_specs, summarise_reviews, compare, recommend, describe_image, cart/checkout actions.
   Output is always `AccessibleOutput` with `grounding`; confirmations for consequential actions.
3. Hour 12: parallel precompute on product open (asyncio.gather), cached per product id;
   deterministic recommender (hard filters + normalised weighted score); LLM only explains.
4. Hour 20: workflows (place / track / return) as step machines; grounding check that drops
   claims without a matching field; optional SerpApi enrichment with ASIN cache.

Done means: every tool has a test using fixtures, and no route returns un-grounded claims.


Also yours: LLM intent repair for unclear speech (confidence < 0.8 → yes/no confirmation,
never act), and the placeholder/redaction layer before any LLM call (docs/safety.md).
Also yours: top-two alternatives from intent repair (for "Did you mean X or Y?"), and streaming
free-form answers sentence by sentence with a per-sentence grounding check.
