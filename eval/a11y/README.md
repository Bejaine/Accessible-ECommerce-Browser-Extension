# Overlay accessibility audit (Track D)

`make a11y` builds the extension, serves MockMart, loads the extension into headless Chrome through
web-ext (the same path as `make ext`) and audits the overlay in eight states (menu, answer,
confirmation, settings + action menu, switch scanning, simple view, checkout steps), each in light,
dark and forced colours (light and dark):

- axe-core, all rules including colour contrast, on the overlay's shadow root;
- every visible button and select at least 44×44 px;
- Tab order with a visible focus ring on every stop; Escape closes and returns focus;
- every overlay control named in Chrome's accessibility tree (what screen readers read);
- on checkout, focusing the card number keeps the checkout steps and announces the mic pause.

Results: `report.md` (exit code 1 if anything fails). Real screen readers and phones are still a
manual pass (see docs/STATUS.md).
