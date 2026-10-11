// Scan bar: our own large-text view of what the scanner highlights ("Product › Add to Cart"),
// plus Choose (the switch, for taps) and Stop. We show the highlight here rather than outlining
// elements on the shop's page (rule 11). Speech goes through the scanner's `speak`, not here.
import type { Highlight } from './scanner';
import { label } from './strings';

export const SCAN_BAR_CSS = `
.asl-controls { display: grid; gap: 12px; margin-block-start: 12px; }
.asl-scanbar { display: grid; gap: 8px; padding: 12px;
  border: 3px solid var(--asl-fg); border-radius: 12px; }
.asl-scanbar[hidden] { display: none; }
.asl-scan-path { margin: 0; color: var(--asl-muted); }
.asl-scan-item { margin: 0; font-size: 1.5em; font-weight: 700; }
.asl-scan-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.asl-scan-actions button { min-inline-size: 44px; min-block-size: 44px; padding: 8px 16px;
  font: inherit; font-weight: 600; cursor: pointer; border-radius: 8px;
  color: var(--asl-fg); background: var(--asl-bg); border: 2px solid var(--asl-fg); }
.asl-scan-actions .asl-scan-choose { color: var(--asl-accent-fg); background: var(--asl-accent); flex: 1; }
@media (forced-colors: active) {
  .asl-scan-actions button, .asl-scan-actions .asl-scan-choose { color: ButtonText; background: ButtonFace; border-color: ButtonText; }
  .asl-scanbar { border-color: CanvasText; }
}
`;

export interface ScanBar {
  readonly element: HTMLElement;
  update(h: Highlight | null, pausedText?: string): void;
}

export function createScanBar(
  opts: { onChoose: () => void; onStop: () => void; switchName?: string },
  lang?: string,
): ScanBar {
  const bar = document.createElement('div');
  bar.className = 'asl-scanbar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', label('scan.title', lang));
  bar.hidden = true;

  const path = document.createElement('p');
  path.className = 'asl-scan-path';
  const item = document.createElement('p');
  item.className = 'asl-scan-item';

  const actions = document.createElement('div');
  actions.className = 'asl-scan-actions';
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'asl-scan-choose';
  choose.textContent = opts.switchName
    ? `${label('scan.choose', lang)} (${opts.switchName})`
    : label('scan.choose', lang);
  choose.addEventListener('click', opts.onChoose);
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.textContent = label('scan.stop', lang);
  stop.addEventListener('click', opts.onStop);
  actions.append(choose, stop);
  bar.append(path, item, actions);

  return {
    element: bar,
    update(h, pausedText) {
      if (!h && !pausedText) {
        bar.hidden = true;
        return;
      }
      bar.hidden = false;
      if (!h) {
        path.textContent = '';
        item.textContent = pausedText ?? '';
        return;
      }
      path.textContent = h.item ? h.group.label : '';
      item.textContent = h.item ? h.item.label : h.group.label;
    },
  };
}
