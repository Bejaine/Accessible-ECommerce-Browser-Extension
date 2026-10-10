// Phrase board: ready-made utterances for when speaking or typing is hard, or after two failed
// attempts. Each phrase has a stable id sent as TurnInput.phrase_id, so the backend doesn't
// depend on the (translated) label. Shown in pages of `max_options` with a "More phrases" button.
import type { PageType } from '@shared/index';
import { label, type UiKey } from './strings';

export type PhraseContext = PageType | 'any' | 'confirm';

export interface Phrase {
  id: string;
  contexts: PhraseContext[];
}

export const PHRASES: readonly Phrase[] = [
  { id: 'yes', contexts: ['confirm'] },
  { id: 'no', contexts: ['confirm'] },
  { id: 'repeat', contexts: ['confirm', 'any'] },
  { id: 'read_page', contexts: ['any'] },
  { id: 'price', contexts: ['product'] },
  { id: 'reviews', contexts: ['product', 'reviews'] },
  { id: 'specs', contexts: ['product'] },
  { id: 'add_to_cart', contexts: ['product'] },
  { id: 'read_results', contexts: ['search'] },
  { id: 'next_result', contexts: ['search'] },
  { id: 'checkout', contexts: ['cart'] },
  { id: 'track_order', contexts: ['orders', 'order_detail'] },
  { id: 'go_to_cart', contexts: ['any'] },
  { id: 'help', contexts: ['any'] },
];

export const phraseLabel = (id: string, lang?: string) => label(`phrase.${id}` as UiKey, lang);

/** Phrases for this context: page-specific first, then the general ones. */
export function phrasesFor(context: PageType | 'confirm'): Phrase[] {
  if (context === 'confirm') return PHRASES.filter((p) => p.contexts.includes('confirm'));
  const specific = PHRASES.filter((p) => p.contexts.includes(context));
  const general = PHRASES.filter((p) => p.contexts.includes('any') && !specific.includes(p));
  return [...specific, ...general];
}

export interface PhraseBoardOptions {
  /** ResolvedMode.max_options: phrases per page. */
  pageSize: number;
  onChoose: (phrase: { id: string; text: string }) => void;
  lang?: string;
}

export interface PhraseBoard {
  readonly element: HTMLElement;
  readonly page: number;
  show(phrases: Phrase[]): void;
}

export function createPhraseBoard(opts: PhraseBoardOptions): PhraseBoard {
  const lang = opts.lang;
  const pageSize = Math.max(1, opts.pageSize);
  const board = document.createElement('div');
  board.className = 'asl-chips asl-phrases';
  board.setAttribute('role', 'group');
  board.setAttribute('aria-label', label('phrases.title', lang));

  let phrases: Phrase[] = [];
  let page = 0;

  function render(): void {
    const start = page * pageSize;
    const buttons = phrases.slice(start, start + pageSize).map((p) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.phraseId = p.id;
      button.textContent = phraseLabel(p.id, lang);
      button.addEventListener('click', () =>
        opts.onChoose({ id: p.id, text: phraseLabel(p.id, lang) }),
      );
      return button;
    });
    if (phrases.length > pageSize) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'asl-phrases-more';
      more.textContent = label('phrases.more', lang);
      more.addEventListener('click', () => {
        page = (page + 1) % Math.ceil(phrases.length / pageSize);
        render();
        board.querySelector<HTMLButtonElement>('button')?.focus();
      });
      buttons.push(more);
    }
    board.replaceChildren(...buttons);
  }

  return {
    element: board,
    get page() {
      return page;
    },
    show(next) {
      phrases = next;
      page = 0;
      render();
    },
  };
}
