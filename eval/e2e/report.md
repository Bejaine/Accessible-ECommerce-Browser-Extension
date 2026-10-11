# Persona runs (end to end on MockMart)

Generated 2026-10-11T02:40:05.907Z by `make e2e`. MockMart pages + Track B's extractor and actuator +
Track D's app + Track C's backend (MOCK=1, local). Voice output recorded, not played.
Latency = one /turn round trip to the local backend (no LLM on these paths; real LLM/ASR/TTS add more).

| Persona | Input | Result | Steps | /turn calls | Median /turn (ms) | Detail |
|---|---|---|---|---|---|---|
| Blind, hand tremor (visual + motor) | Single switch (Space), every highlight spoken | completed | 6 | 1 | 4 | cart 1 item; 9 highlights spoken; scan 2500 ms |
| Blind, unclear speech (visual + speech) | Keyboard: "add to card", then "yes" | completed | 2 | 1 | 3 | typo matched locally; confirmation by "yes"; cart 1 item |
| Unclear speech, tremor (speech + motor) | Phrase chips by single switch | completed | 6 | 1 | 2 | chip sent as Track C's 'add to cart' (no LLM); cart 1 item |
| Older, blind, hand tremor (ageing + visual + motor) | Opens by itself in simple mode, large buttons | completed | 3 | 1 | 3 | opened by itself in the simplified view; text 1.25x; speech 0.75x; 3 options/step; cart 1 item |
| Older user at checkout (ageing) | Checkout steps, "place my order" | completed | 2 | 1 | 2 | summary extracted; backend: "Place this order? Total ₹15,999. Delivery PIN 500032." |
| Any user at payment | Focus the card number field | completed | 1 | 0 | - | mic muted; said "Listening is paused while you're in a payment or password field." |
