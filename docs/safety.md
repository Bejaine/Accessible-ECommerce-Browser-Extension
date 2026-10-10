# Safety, privacy and auth (everyone)

- Secure zone (Track B detects, Track A mutes): password, cc-number, cc-csc, cc-exp,
  one-time-code fields; labels mentioning card/CVV/OTP/PIN/UPI; payment-gateway and bank
  3-D Secure iframes. On focus: mic off, recording stopped, extraction skips the area, nothing
  sent to any LLM; announce that listening has stopped; resume when focus leaves.
- Prefer UPI (PIN entered in the UPI app), saved tokenised cards, or cash on delivery; let the
  user store a preferred method.
- Redaction before any text reaches an LLM or translation: card-like numbers (Luhn-checked),
  6-digit codes near "OTP", Aadhaar (checksum), PAN, phone, email → placeholders.
- Personal data (names, addresses, phone, order IDs) becomes placeholders (ADDR_1, ORDER_1)
  for the LLM; the extension maps them back locally and reads addresses aloud itself.
- Auth: the user logs into the shop in their own browser. The backend never receives cookies,
  session tokens or shop credentials and never talks to the shop. It returns ClientActions;
  the extension performs them in the user's tab.
- Extension → backend uses an anonymous per-install token; the backend rate-limits it.
- Read back critical numbers before acting: quantity, total, delivery PIN code.
- After every action, verify the effect (cart count, confirmation text) and tell the user
  whether it worked.
- Logging: no audio or transcripts stored beyond the demo. Note in the Responsible AI slide
  that free API tiers may use submitted data, which is why we minimise what we send.
- Demo: never place real orders or returns on a real account; use the mock store for full
  checkout and returns. Real sites: search, product, reviews, cart, order tracking (read-only).
- Allergens/medical-style claims don't apply here, but product safety claims follow rule 1:
  only what the page says.
