// Accessibility audit of the overlay in a real (headless) Chrome: `make a11y`.
// Builds nothing itself: run after `wxt build` (the Makefile target does both). Serves MockMart,
// loads extension/.output/chrome-mv3 through web-ext (the same path as `make ext`), then for each
// state runs axe-core (incl. colour contrast), checks every control is at least 44×44 px, walks
// the Tab order, lists unnamed controls in Chrome's accessibility tree, and repeats the states
// under forced colours. Writes eval/a11y/report.md with what was measured, nothing else.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 9334;
const SHOP = 8091;
const AXE = readFileSync(resolve(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore', detached: true, ...opts });
  children.push(child);
  return child;
}
function stopAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid);
    } catch {
      // already gone
    }
  }
}
process.on('exit', stopAll);

async function waitFor(url, what) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${what} did not start`);
}

/** One page target over the DevTools protocol. */
async function openPage(url) {
  const res = await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const { webSocketDebuggerUrl } = await res.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) waiting.get(msg.id)?.(msg);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const n = ++id;
      waiting.set(n, r);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const key = async (k) => {
    const vk = { Tab: 9, Enter: 13, Escape: 27 }[k];
    const text = k === 'Enter' ? '\r' : undefined;
    const base = { key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await send('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(text && { text, unmodifiedText: text }),
    });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(3500);
  return { send, ev, key, close: () => ws.close() };
}

const R = 'document.querySelector("asl-overlay").shadowRoot';

async function audit(page) {
  await page.ev(`${AXE};0`);
  const violations = await page.ev(
    `axe.run({ fromShadowDom: ['asl-overlay', '.asl-root'] }).then((r) => r.violations.map((v) => v.id + ' (' + v.impact + ', ' + v.nodes.length + '): ' + v.nodes[0].target.flat().join(' ')))`,
  );
  const small = await page.ev(
    `[...${R}.querySelectorAll('button, select')].filter((e) => e.getClientRects().length).map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.w < 44 || x.h < 44).map((x) => x.t + ' ' + x.w + 'x' + x.h)`,
  );
  return { violations, small };
}

async function tap(page, re) {
  const ok = await page.ev(
    `(() => { const b = [...${R}.querySelectorAll('button')].find((b) => ${re}.test(b.textContent.trim()) && b.getClientRects().length); if (!b) return false; b.click(); return true; })()`,
  );
  await sleep(1200);
  if (!ok) throw new Error(`no visible button ${re}`);
}

async function media(page, scheme, forced) {
  await page.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: scheme },
      { name: 'forced-colors', value: forced ? 'active' : 'none' },
    ],
  });
  await sleep(300);
}

async function main() {
  start('python3', ['-m', 'http.server', String(SHOP), '-d', 'mock-store']);
  await waitFor(`http://localhost:${SHOP}/`, 'MockMart');
  start('npx', [
    'web-ext',
    'run',
    '-t',
    'chromium',
    '--source-dir',
    'extension/.output/chrome-mv3',
    '--no-reload',
    ...(process.platform === 'linux'
      ? ['--chromium-binary', resolve(ROOT, 'extension/dev/chrome-linux.sh')]
      : []),
    '--args=--headless=new',
    `--args=--remote-debugging-port=${PORT}`,
    '--args=--test-type',
  ]);
  await waitFor(`http://localhost:${PORT}/json/version`, 'Chrome');

  const rows = [];
  const record = (state, theme, result) =>
    rows.push(
      `| ${state} | ${theme} | ${result.violations.length ? result.violations.join('<br>') : 'none'} | ${result.small.length ? result.small.join(', ') : 'all ≥ 44 px'} |`,
    );
  const themes = [
    ['light', false],
    ['dark', false],
    ['light', true],
    ['dark', true],
  ];
  const themeName = (s, f) => `${s}${f ? ' + forced colours' : ''}`;
  const allThemes = async (page, state) => {
    for (const [s, f] of themes) {
      await media(page, s, f);
      record(state, themeName(s, f), await audit(page));
    }
    await media(page, 'light', false);
  };

  // Product page: menu, answer, confirmation, settings + action menu, switch scanning, simple view.
  const product = await openPage(`http://localhost:${SHOP}/product.html?id=zx-pulse-5g&reset=1`);
  await product.ev(`${R}.querySelector('.asl-toggle').focus()`);
  await product.key('Enter');
  await sleep(600);
  const focusOnOpen = await product.ev(`${R}.activeElement?.textContent?.trim()`);
  await allThemes(product, 'Menu');

  // Tab order and focus rings.
  const order = [];
  const noRing = [];
  for (let i = 0; i < 60; i++) {
    await product.key('Tab');
    const f = await product.ev(
      `(() => { const a = ${R}.activeElement; if (!a) return null; const s = getComputedStyle(a); return { name: (a.getAttribute('aria-label') || (a.labels && a.labels[0]?.textContent) || a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40), ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 }; })()`,
    );
    if (!f) {
      order.push(
        `(left the panel: ${await product.ev('document.activeElement?.outerHTML.slice(0, 80)')})`,
      );
      break;
    }
    order.push(f.name);
    if (!f.ring) noRing.push(f.name);
  }
  // Each overlay control's name as Chrome's accessibility tree computes it (what screen readers read).
  await product.send('Accessibility.enable');
  const list = await product.send('Runtime.evaluate', {
    expression: `[...${R}.querySelectorAll('button, input, select')].filter((e) => e.getClientRects().length)`,
  });
  const props = await product.send('Runtime.getProperties', {
    objectId: list.result.result.objectId,
    ownProperties: true,
  });
  const unnamedList = [];
  for (const prop of props.result.result.filter((p) => /^\d+$/.test(p.name))) {
    const ax = await product.send('Accessibility.getPartialAXTree', {
      objectId: prop.value.objectId,
      fetchRelatives: false,
    });
    const node = ax.result.nodes.find((n) => !n.ignored);
    if (node && !(node.name?.value ?? '').trim()) unnamedList.push(node.role?.value ?? '?');
  }
  const unnamed = unnamedList.length;
  await product.ev(`${R}.querySelector('.asl-mic').focus()`);
  await product.key('Escape');
  await sleep(300);
  const escape = await product.ev(
    `${R}.querySelector('.asl-panel').hidden && ${R}.activeElement?.classList.contains('asl-toggle')`,
  );
  await product.ev(`${R}.querySelector('.asl-toggle').click()`);
  await sleep(500);

  await tap(product, "/What's the price/");
  await allThemes(product, 'Answer');
  await tap(product, '/^Back to menu/');
  await tap(product, '/^Add to cart$/');
  await allThemes(product, 'Confirmation');
  await tap(product, '/^No$/');
  await tap(product, '/^Back to menu/');
  await product.ev(`${R}.querySelector('.asl-settings-toggle').click()`);
  await tap(product, '/^Actions on this page/');
  await allThemes(product, 'Settings + action menu');
  await tap(product, '/^Start switch scanning/');
  await allThemes(product, 'Switch scanning');
  await tap(product, '/^Stop scanning/');
  await tap(product, '/^Simple view/');
  await allThemes(product, 'Simple view');
  await product.ev(`document.querySelector('#add-to-cart').click()`);
  await sleep(500);
  product.close();

  // Checkout page (cart has one item): the step-by-step checkout, and the card field.
  const checkout = await openPage(`http://localhost:${SHOP}/checkout.html`);
  await checkout.ev(`${R}.querySelector('.asl-toggle').click()`);
  await sleep(600);
  await tap(checkout, '/^Checkout step by step/');
  await allThemes(checkout, 'Checkout steps');
  await checkout.ev(
    `[...document.querySelectorAll('input[type=radio]')].find((i) => /card/i.test(i.value + i.id))?.click()`,
  );
  await sleep(400);
  await checkout.ev(`document.querySelector('input[autocomplete=cc-number]')?.focus()`);
  await sleep(800);
  const cardField = {
    steps: await checkout.ev(`!!${R}.querySelector('.asl-wizard')`),
    said: await checkout.ev(`${R}.getElementById('asl-live').textContent`),
  };
  checkout.close();

  const version = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const report = `# Overlay accessibility audit (real Chrome)

Generated ${new Date().toISOString()} by \`make a11y\` (eval/a11y/run.mjs): ${version.Browser}, headless,
extension loaded through web-ext, MockMart pages, in-browser mock backend. axe-core ${JSON.parse(readFileSync(resolve(ROOT, 'node_modules/axe-core/package.json'), 'utf8')).version}
with all rules (incl. colour contrast) on the overlay's shadow root.

| State | Theme | axe violations | Controls under 44×44 px |
|---|---|---|---|
${rows.join('\n')}

## Keyboard and screen-reader view

- Opening with Enter on the toggle moves focus to: **${focusOnOpen}**
- Tab order (${order.length} stops): ${order.join(' → ')}
- Stops without a visible focus ring (≥ 2 px outline): ${noRing.length ? noRing.join(', ') : 'none'}
- Overlay controls without a name in Chrome's accessibility tree: ${unnamed}${unnamed ? ' (' + unnamedList.join(', ') + ')' : ''}
- Escape closes the panel and returns focus to the toggle: ${escape ? 'yes' : 'no'}
- Card number field focused on checkout: steps still shown: ${cardField.steps ? 'yes' : 'no'}; announced: "${cardField.said.trim()}"

## Not covered here

- Real screen readers (NVDA, ChromeVox, TalkBack) and phones: listen-through still to do by hand.
- Colour contrast where axe could not compute a background (the panel floats over the page): the
  colour tokens are checked by ratio instead (docs/decisions.md, "Menu layout and colour tokens").
`;
  writeFileSync(resolve(ROOT, 'eval/a11y/report.md'), report);
  const failing = rows.filter((r) => !r.includes('| none | all ≥ 44 px |')).length;
  console.log(report);
  stopAll();
  process.exit(failing || noRing.length || unnamed || !escape ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  stopAll();
  process.exit(1);
});
