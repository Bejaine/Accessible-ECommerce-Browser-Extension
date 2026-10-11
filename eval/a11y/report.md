# Overlay accessibility audit (real Chrome)

Generated 2026-10-11T01:45:37.998Z by `make a11y` (eval/a11y/run.mjs): Chrome/149.0.7827.102, headless,
extension loaded through web-ext, MockMart pages, in-browser mock backend. axe-core 4.14.0
with all rules (incl. colour contrast) on the overlay's shadow root.

| State | Theme | axe violations | Controls under 44×44 px |
|---|---|---|---|
| Menu | light | none | all ≥ 44 px |
| Menu | dark | none | all ≥ 44 px |
| Menu | light + forced colours | none | all ≥ 44 px |
| Menu | dark + forced colours | none | all ≥ 44 px |
| Answer | light | none | all ≥ 44 px |
| Answer | dark | none | all ≥ 44 px |
| Answer | light + forced colours | none | all ≥ 44 px |
| Answer | dark + forced colours | none | all ≥ 44 px |
| Confirmation | light | none | all ≥ 44 px |
| Confirmation | dark | none | all ≥ 44 px |
| Confirmation | light + forced colours | none | all ≥ 44 px |
| Confirmation | dark + forced colours | none | all ≥ 44 px |
| Settings + action menu | light | none | all ≥ 44 px |
| Settings + action menu | dark | none | all ≥ 44 px |
| Settings + action menu | light + forced colours | none | all ≥ 44 px |
| Settings + action menu | dark + forced colours | none | all ≥ 44 px |
| Switch scanning | light | none | all ≥ 44 px |
| Switch scanning | dark | none | all ≥ 44 px |
| Switch scanning | light + forced colours | none | all ≥ 44 px |
| Switch scanning | dark + forced colours | none | all ≥ 44 px |
| Simple view | light | none | all ≥ 44 px |
| Simple view | dark | none | all ≥ 44 px |
| Simple view | light + forced colours | none | all ≥ 44 px |
| Simple view | dark + forced colours | none | all ≥ 44 px |
| Checkout steps | light | none | all ≥ 44 px |
| Checkout steps | dark | none | all ≥ 44 px |
| Checkout steps | light + forced colours | none | all ≥ 44 px |
| Checkout steps | dark + forced colours | none | all ≥ 44 px |

## Keyboard and screen-reader view

- Opening with Enter on the toggle moves focus to: **Shopping assistant**
- Tab order (16 stops): Close shopping assistant → Speak → Type a request → Send → What's the price? → What do reviews say? → Tell me the specs → Add to cart → Repeat that → More phrases → Simple view → Actions on this page (14) → Slower → Faster → Settings → (left the panel: <body data-page="product">
    <header class="site">
    <a class="logo" href="i)
- Stops without a visible focus ring (≥ 2 px outline): none
- Overlay controls without a name in Chrome's accessibility tree: 0
- Escape closes the panel and returns focus to the toggle: yes
- Card number field focused on checkout: steps still shown: yes; announced: "Listening is paused while you're in a payment or password field."

## Not covered here

- Real screen readers (NVDA, ChromeVox, TalkBack) and phones: listen-through still to do by hand.
- Colour contrast where axe could not compute a background (the panel floats over the page): the
  colour tokens are checked by ratio instead (docs/decisions.md, "Menu layout and colour tokens").
