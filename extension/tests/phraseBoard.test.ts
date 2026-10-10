import { describe, expect, it, vi } from 'vitest';
import type { ResolvedMode } from '@shared/index';
import { resolveMode } from '../src/core/composer';
import { createInputFallback } from '../src/core/fallback';
import { defaultProfile } from '../src/core/profile';
import { createPhraseBoard, PHRASES, phraseLabel, phrasesFor } from '../src/ui/phrases';

describe('phrases', () => {
  it('every phrase has an English label', () => {
    for (const p of PHRASES) expect(phraseLabel(p.id)).not.toBe(`phrase.${p.id}`);
  });

  it('puts page-specific phrases first, then general ones', () => {
    const ids = phrasesFor('product').map((p) => p.id);
    expect(ids.slice(0, 4)).toEqual(['price', 'reviews', 'specs', 'add_to_cart']);
    expect(ids).toContain('help');
    expect(ids).not.toContain('read_results');
  });

  it('confirmation context offers only yes / no / repeat', () => {
    expect(phrasesFor('confirm').map((p) => p.id)).toEqual(['yes', 'no', 'repeat']);
  });
});

describe('phrase board', () => {
  it('shows max_options phrases per page with "More phrases", and reports id + text', () => {
    const onChoose = vi.fn();
    const board = createPhraseBoard({ pageSize: 3, onChoose });
    board.show(phrasesFor('product'));
    const buttons = () => [...board.element.querySelectorAll('button')];
    expect(board.element.getAttribute('role')).toBe('group');
    expect(board.element.getAttribute('aria-label')).toBe('Phrases');
    expect(buttons()).toHaveLength(4);
    expect(buttons().at(-1)?.textContent).toBe('More phrases');

    buttons()[0]!.click();
    expect(onChoose).toHaveBeenCalledWith({ id: 'price', text: "What's the price?" });

    buttons().at(-1)!.click();
    expect(board.page).toBe(1);
    expect(buttons()[0]?.dataset.phraseId).not.toBe('price');
  });

  it('has no More button when everything fits', () => {
    const board = createPhraseBoard({ pageSize: 5, onChoose: vi.fn() });
    board.show(phrasesFor('confirm'));
    expect(board.element.querySelector('.asl-phrases-more')).toBeNull();
  });
});

describe('two failures -> phrase board', () => {
  const mode = (): ResolvedMode => resolveMode(defaultProfile());

  it('first failure retries; second offers phrases and drops one rung', () => {
    const fb = createInputFallback(mode());
    expect(fb.recordFailure()).toEqual({ rung: 'voice', offerPhrases: false });
    expect(fb.recordFailure()).toEqual({ rung: 'keyboard', offerPhrases: true });
  });

  it('a success in between resets the count', () => {
    const fb = createInputFallback(mode());
    fb.recordFailure();
    fb.recordSuccess();
    expect(fb.recordFailure().offerPhrases).toBe(false);
  });

  it('keeps falling back but never below the switch', () => {
    const fb = createInputFallback(mode());
    for (let i = 0; i < 20; i++) fb.recordFailure();
    expect(fb.rung).toBe('switch');
  });
});

describe("phrase chips use Track C's chip keys", () => {
  it('every mapped chip is one /turn answers without the LLM (backend/app/brain/tools.py CHIPS)', async () => {
    const { readFileSync } = await import('node:fs');
    const { BACKEND_CHIPS } = await import('../src/ui/phrases');
    const { join } = await import('node:path');
    const tools = readFileSync(join(__dirname, '../../backend/app/brain/tools.py'), 'utf8');
    const start = tools.indexOf('CHIPS:');
    const chips = tools.slice(start, tools.indexOf('\n}', start));
    for (const [ours, theirs] of Object.entries(BACKEND_CHIPS)) {
      expect(chips, `${ours} -> "${theirs}"`).toContain(`"${theirs}":`);
    }
  });
});
