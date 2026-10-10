# Architecture (short)

```
 Shop tab (Amazon.in / Flipkart / any product page)
   content script ── extract (B) ─▶ PageContext ─┐
     overlay (D, shadow DOM, one live region)    │ bus (core)
     audio/player (A) ◀── render (D) ◀── AccessibleOutput
     actuate (B) ◀── ClientAction (after Confirmation)
   background ── backend client (core) ──HTTP──▶ FastAPI
                                                  routes (C) → brain (C)
                                                  services: bhashini (A), serpapi (C), masking/numbers/cache (A)
```

- Contracts live in `shared/schemas/`; both sides use generated types.
- The backend never talks to the shop and never sees cookies; it returns ClientActions.
- Profile and inference stay on the device; only active prefs travel per turn.
- MOCK=1 / VITE_BACKEND=mock let every track work against `fixtures/mocks/`.
