// Playback bar (docs/conditions.md "Audio playback controls"): floating, shown while the
// assistant is speaking or paused, even with the panel closed. The current sentence is shown
// large and highlighted (helps low vision and ageing); a big Pause / Resume button doubles as the
// phone's floating play button (TalkBack: double-tap). The single-key mini-menu highlights its
// items here too.
import type { PlaybackState } from '../render/speaker';
import { label, type UiKey } from './strings';

export const PLAYBACK_CSS = `
.asl-playback { position: fixed; inset-block-end: 16px; inset-inline-start: 16px; z-index: 2147483647;
  display: grid; gap: 8px; max-inline-size: min(560px, calc(100vw - 32px)); padding: 12px;
  background: var(--asl-bg); color: var(--asl-fg); border: 3px solid var(--asl-fg); border-radius: 12px;
  box-shadow: 0 4px 24px rgb(0 0 0 / 0.3); }
.asl-playback[hidden] { display: none; }
.asl-now { margin: 0; font-size: 1.25em; font-weight: 700; padding: 4px 10px;
  border-inline-start: 6px solid var(--asl-accent); background: color-mix(in srgb, var(--asl-accent) 15%, var(--asl-bg)); }
.asl-playback .asl-row { display: flex; flex-wrap: wrap; gap: 8px; }
.asl-playback button { min-inline-size: 44px; min-block-size: 44px; padding: 8px 14px; font: inherit;
  cursor: pointer; border-radius: 10px; color: var(--asl-fg); background: var(--asl-bg); border: 2px solid var(--asl-fg); }
.asl-playback .asl-play { min-inline-size: 64px; min-block-size: 56px; font-weight: 800;
  color: var(--asl-accent-fg); background: var(--asl-accent); }
.asl-playback .asl-highlight { outline: 4px dashed var(--asl-fg); outline-offset: 3px; }
.asl-playback [hidden] { display: none; }
@media (max-width: 480px) { .asl-playback { inset-inline: 8px; inset-block-end: 8px; } }
@media (forced-colors: active) {
  .asl-now { border-color: Highlight; background: Canvas; }
  .asl-playback .asl-play { background: ButtonFace; color: ButtonText; }
  .asl-playback .asl-highlight { outline-color: Highlight; }
}
`;

export type PlaybackAction =
  'toggle' | 'repeat' | 'repeat_all' | 'back' | 'previous' | 'next' | 'slower' | 'faster' | 'stop';

export interface PlaybackBar {
  readonly element: HTMLElement;
  update(state: PlaybackState, sentence: string | null): void;
  /** Highlight a mini-menu item (single-key scanning); null clears. */
  highlight(action: PlaybackAction | null): void;
}

const LABELS: Record<Exclude<PlaybackAction, 'toggle'>, UiKey> = {
  repeat: 'playback.repeat',
  repeat_all: 'playback.repeat_all',
  back: 'playback.back',
  previous: 'playback.previous',
  next: 'playback.next',
  slower: 'speed.slower',
  faster: 'speed.faster',
  stop: 'playback.stop',
};

export function createPlaybackBar(onAction: (action: PlaybackAction) => void): PlaybackBar {
  const bar = document.createElement('section');
  bar.className = 'asl-playback';
  bar.setAttribute('aria-label', label('playback.title'));
  bar.hidden = true;

  const now = document.createElement('p');
  now.className = 'asl-now';

  const buttons = new Map<PlaybackAction, HTMLButtonElement>();
  const make = (action: PlaybackAction, text: string, cls?: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', () => onAction(action));
    buttons.set(action, b);
    return b;
  };

  const main = document.createElement('div');
  main.className = 'asl-row';
  const play = make('toggle', label('playback.pause'), 'asl-play');
  main.append(
    play,
    make('repeat', label(LABELS.repeat)),
    make('next', label(LABELS.next)),
    make('stop', label(LABELS.stop)),
  );

  const moreId = `asl-playback-more-${Math.random().toString(36).slice(2, 8)}`;
  const moreToggle = document.createElement('button');
  moreToggle.type = 'button';
  moreToggle.textContent = label('playback.more');
  moreToggle.setAttribute('aria-expanded', 'false');
  moreToggle.setAttribute('aria-controls', moreId);
  const more = document.createElement('div');
  more.id = moreId;
  more.className = 'asl-row';
  more.hidden = true;
  more.append(
    make('back', label(LABELS.back)),
    make('previous', label(LABELS.previous)),
    make('repeat_all', label(LABELS.repeat_all)),
    make('slower', label(LABELS.slower)),
    make('faster', label(LABELS.faster)),
  );
  moreToggle.addEventListener('click', () => {
    more.hidden = !more.hidden;
    moreToggle.setAttribute('aria-expanded', String(!more.hidden));
  });
  main.append(moreToggle);
  bar.append(now, main, more);

  return {
    element: bar,
    update(state, sentence) {
      bar.hidden = state === 'idle';
      now.textContent = sentence ?? '';
      now.hidden = !sentence;
      play.textContent = label(state === 'paused' ? 'playback.resume' : 'playback.pause');
      play.setAttribute('aria-pressed', String(state === 'paused'));
    },
    highlight(action) {
      buttons.forEach((b) => b.classList.remove('asl-highlight'));
      if (!action) return;
      const b = buttons.get(action);
      if (b?.parentElement === more) {
        more.hidden = false;
        moreToggle.setAttribute('aria-expanded', 'true');
      }
      b?.classList.add('asl-highlight');
    },
  };
}

/** The single-key mini-menu, in order (docs/conditions.md). */
export const MINI_MENU: PlaybackAction[] = [
  'toggle',
  'repeat',
  'repeat_all',
  'slower',
  'faster',
  'next',
  'stop',
];

export function miniMenuLabel(action: PlaybackAction): string {
  return action === 'toggle' ? label('playback.resume') : label(LABELS[action]);
}
