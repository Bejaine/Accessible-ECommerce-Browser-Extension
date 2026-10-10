# extension/ — WXT WebExtension (MV3, Chrome + Firefox for Android)

```
make ext            # opens Chrome with the extension loaded; reloads on save
make ext-firefox    # same for Firefox
make build          # production builds in .output/
npm run -w extension test
```

`VITE_BACKEND=mock` (default; see `.env.example`) serves `fixtures/mocks/` in-browser.
Set `VITE_BACKEND=http://localhost:8000` in `extension/.env` to use the backend.

If no browser opens, load `.output/chrome-mv3-dev` (Chrome: chrome://extensions → Load unpacked)
or `.output/firefox-mv3-dev/manifest.json` (Firefox: about:debugging → Load Temporary Add-on).

Firefox for Android: build with `make build`, then
`npx web-ext run -t firefox-android -s .output/firefox-mv3 --adb-device <id>`.

| Folder | Owner | What |
|---|---|---|
| `entrypoints/` | Integration lead | background (backend calls) and content script (overlay mount) |
| `src/core/` | Integration lead | message bus, backend client, session, profile store, composer |
| `src/ui/` | Track D | shadow-DOM overlay, the single live region (`announce.ts`) |
| `src/render/` | Track D | AccessibleOutput renderers |
| `src/infer/` | Track D | signal collectors, condition scores |
| `src/match/` | Track D | local command matcher |
| `src/extract/`, `src/actuate/` | Track B | page extraction, performing ClientActions |
| `src/audio/`, `src/i18n/` | Track A | mic, player.ts, build-time UI strings |

Types come from `@shared/index` (generated; run `make types`).
