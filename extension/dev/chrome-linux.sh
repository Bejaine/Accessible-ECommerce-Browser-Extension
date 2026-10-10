#!/usr/bin/env bash
# Chrome launcher for `make ext` on Linux. web-ext always passes chrome-launcher's default flags,
# and one of them, --disable-component-extensions-with-background-pages, removes Chrome's built-in
# speech voices on Linux (they are a component extension), so the assistant could not speak.
# This wrapper starts the real Chrome with every other flag unchanged.
# Override the browser with ASL_CHROME=/path/to/chrome.
args=()
for a in "$@"; do
  [ "$a" = "--disable-component-extensions-with-background-pages" ] && continue
  args+=("$a")
done
for c in "${ASL_CHROME:-}" google-chrome-stable google-chrome chromium chromium-browser; do
  [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && exec "$c" "${args[@]}"
done
echo "chrome-linux.sh: no Chrome or Chromium found (set ASL_CHROME)" >&2
exit 1
