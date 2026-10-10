// Speak button with a level meter. listen() must start from a user gesture (this click).
// The meter is visual only; state changes are announced by the app through the live region.
import { label } from './strings';

export const MIC_CSS = `
.asl-voice { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.asl-mic { min-inline-size: 44px; min-block-size: 44px; padding: 8px 16px; font: inherit;
  font-weight: 700; cursor: pointer; border-radius: 22px; color: var(--asl-accent-fg);
  background: var(--asl-accent); border: 2px solid var(--asl-border); }
.asl-mic[aria-pressed='true'] { background: var(--asl-fg); color: var(--asl-bg); }
.asl-meter { inline-size: 96px; block-size: 12px; border: 2px solid var(--asl-fg); border-radius: 6px;
  overflow: hidden; }
.asl-meter[hidden] { display: none; }
.asl-meter > span { display: block; block-size: 100%; inline-size: 0; background: var(--asl-fg); }
@media (forced-colors: active) {
  .asl-mic { background: ButtonFace; color: ButtonText; border-color: ButtonText; }
  .asl-meter > span { background: Highlight; }
}
`;

export interface MicButton {
  readonly element: HTMLElement;
  setListening(listening: boolean): void;
  level(value: number): void;
}

export function createMicButton(onPress: () => void, lang?: string): MicButton {
  const row = document.createElement('div');
  row.className = 'asl-voice';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'asl-mic';
  button.addEventListener('click', onPress);
  const meter = document.createElement('div');
  meter.className = 'asl-meter';
  meter.setAttribute('aria-hidden', 'true');
  meter.hidden = true;
  const bar = document.createElement('span');
  meter.append(bar);
  row.append(button, meter);

  const set = (listening: boolean) => {
    button.textContent = label(listening ? 'mic.stop' : 'mic.speak', lang);
    button.setAttribute('aria-pressed', String(listening));
    meter.hidden = !listening;
    if (!listening) bar.style.inlineSize = '0';
  };
  set(false);

  return {
    element: row,
    setListening: set,
    level(value) {
      bar.style.inlineSize = `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
    },
  };
}
