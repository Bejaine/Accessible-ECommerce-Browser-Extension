// Suggestion card in the overlay: countdown with Turn on now / No thanks, Undo after a mode is
// applied, or the visual-or-motor question. Speech is announced by the suggester; the visible
// countdown is not a live region (it would be read every second).
import type { QuestionAnswer, Suggester, SuggestionState } from '../infer/suggest';
import { modeName } from '../infer/suggest';
import { label, type UiKey } from './strings';

export const SUGGESTION_CSS = `
.asl-suggestion { display: grid; gap: 8px; padding: 12px; border: 3px solid var(--asl-accent);
  border-radius: 12px; }
.asl-suggestion[hidden] { display: none; }
.asl-suggestion h3 { margin: 0; font-size: 1.05em; }
.asl-suggestion p { margin: 0; }
.asl-suggestion .asl-countdown { font-weight: 700; font-variant-numeric: tabular-nums; }
.asl-suggestion .asl-primary { color: var(--asl-accent-fg); background: var(--asl-accent); }
@media (forced-colors: active) { .asl-suggestion { border-color: Highlight; } }
`;

export interface SuggestionCard {
  readonly element: HTMLElement;
  render(state: SuggestionState): void;
}

export function createSuggestionCard(suggester: Suggester, lang?: string): SuggestionCard {
  const card = document.createElement('section');
  card.className = 'asl-suggestion';
  card.setAttribute('aria-labelledby', 'asl-suggestion-title');
  card.hidden = true;

  const button = (key: UiKey, onClick: () => void, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label(key, lang);
    if (primary) b.className = 'asl-primary';
    b.addEventListener('click', onClick);
    return b;
  };
  const text = (tag: 'h3' | 'p', value: string, cls?: string) => {
    const el = document.createElement(tag);
    el.textContent = value;
    if (cls) el.className = cls;
    if (tag === 'h3') el.id = 'asl-suggestion-title';
    return el;
  };
  const actions = (...buttons: HTMLButtonElement[]) => {
    const row = document.createElement('div');
    row.className = 'asl-chips';
    row.append(...buttons);
    return row;
  };

  let shownKind: SuggestionState['kind'] = 'idle';

  return {
    element: card,
    render(state) {
      card.hidden = state.kind === 'idle';
      if (state.kind === 'idle') {
        card.replaceChildren();
        shownKind = 'idle';
        return;
      }
      // Countdown ticks only update the number, so focus stays on the buttons.
      const countdown = card.querySelector('.asl-countdown');
      if (state.kind === 'countdown' && shownKind === 'countdown' && countdown) {
        countdown.textContent = label('suggest.countdown', lang).replace(
          '{seconds}',
          String(state.secondsLeft),
        );
        return;
      }
      shownKind = state.kind;
      if (state.kind === 'countdown') {
        card.replaceChildren(
          text('h3', modeName(state.condition, lang)),
          text('p', label(`mode.${state.condition}.desc` as UiKey, lang)),
          text(
            'p',
            label('suggest.countdown', lang).replace('{seconds}', String(state.secondsLeft)),
            'asl-countdown',
          ),
          actions(
            button('suggest.accept', () => suggester.accept(), true),
            button('suggest.decline', () => suggester.decline()),
          ),
        );
      } else if (state.kind === 'applied') {
        card.replaceChildren(
          text(
            'h3',
            label('suggest.on_title', lang).replace('{mode}', modeName(state.condition, lang)),
          ),
          actions(
            button('suggest.undo', () => suggester.undo(), true),
            button('suggest.dismiss', () => suggester.decline()),
          ),
        );
      } else {
        const answer = (choice: QuestionAnswer) => () => suggester.answer(choice);
        card.replaceChildren(
          text('h3', label('suggest.title', lang)),
          text('p', label('suggest.question', lang)),
          actions(
            button('suggest.answer_visual', answer('visual')),
            button('suggest.answer_motor', answer('motor')),
            button('suggest.answer_neither', answer('neither')),
          ),
        );
      }
    },
  };
}
