import { describe, expect, it } from 'vitest';
import type { ActionTarget, ProductJSON } from '@shared/index';
import searchPage from '../../fixtures/mocks/PageContext.search.json';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import {
  ACT_THRESHOLD,
  buildCandidates,
  createMatcher,
  matchLocal,
  normalise,
  shortName,
  type MatchDecision,
} from '../src/match';

const matcher = createMatcher(
  buildCandidates({
    targets: turnRequest.page.targets as ActionTarget[],
    products: searchPage.products as unknown as ProductJSON[],
  }),
);

const acted = (d: MatchDecision) =>
  d.action === 'act' ? `${d.best.candidate.kind}:${d.best.candidate.id}` : null;
const act = (u: string) => acted(matcher.match(u));

describe('normalise', () => {
  it('lowercases, strips punctuation and filler words', () => {
    expect(normalise('Could you PAUSE it, please?!')).toBe('pause');
  });
});

describe('local matcher: acts only on confident, unambiguous matches', () => {
  it.each([
    ['pause', 'command:pause'],
    ['Pause please!', 'command:pause'],
    ['hold on', 'command:pause'],
    ['repeat that', 'command:repeat'],
    ['slower', 'command:slower'],
    ['next', 'command:next_section'],
    ['yes', 'command:yes'],
    ['no', 'command:no'],
    ['add to cart', 'target:t-add-to-cart'],
    ['buy now', 'target:t-buy-now'],
    ['sage green', 'target:t-swatch-green'],
  ])('"%s" -> %s', (utterance, expected) => {
    expect(act(utterance)).toBe(expected);
  });

  it('tolerates a misheard word in a multi-word label ("add to card")', () => {
    expect(act('add to card')).toBe('target:t-add-to-cart');
  });

  it('prefers the label that the words cover fully ("cart" is the Cart link)', () => {
    expect(act('cart')).toBe('target:t-cart');
  });

  it('matches products by short name (brand + model), not by any word of the title', () => {
    expect(act('novix a15')).toBe('product:amazon.in:B0NVXA15G5');
    expect(act('zentra pulse')).toBe('product:amazon.in:B0ZNTRA5G1');
  });

  it('a short word inside a longer one does not count ("no" is not "Novix")', () => {
    const d = matcher.match('no');
    expect(d.alternatives.map((a) => a.candidate.id)).not.toContain('amazon.in:B0NVXA15G5');
  });

  it.each(['paws', 'slowa', 'nex', 'ad to kart', 'what is the weather', ''])(
    '"%s" is unclear: pass to the server (never act below 0.8)',
    (utterance) => {
      const d = matcher.match(utterance);
      expect(d.action).toBe('pass');
      for (const a of d.alternatives) expect(a.confidence).toBeLessThanOrEqual(1);
    },
  );

  it('passes the top two candidates as hints when it does not act', () => {
    const d = matcher.match('paws');
    expect(d.action).toBe('pass');
    expect(d.alternatives[0]?.candidate.id).toBe('pause');
    expect(d.alternatives[0]!.confidence).toBeLessThan(ACT_THRESHOLD);
  });

  it('ambiguous near-ties pass even when both are confident', () => {
    const tie = createMatcher([
      { kind: 'target', id: 'a', text: 'Add to Cart' },
      { kind: 'target', id: 'b', text: 'Add to Cart' },
    ]);
    expect(tie.match('add to cart').action).toBe('pass');
  });

  it('skips disabled targets', () => {
    const targets = (turnRequest.page.targets as ActionTarget[]).map((t) =>
      t.id === 't-buy-now'
        ? { ...t, state: { disabled: true, selected: false, expanded: false } }
        : t,
    );
    expect(buildCandidates({ targets, commands: false }).map((c) => c.id)).not.toContain(
      't-buy-now',
    );
  });
});

describe('Hindi, Telugu and Malayalam playback words (Track A)', () => {
  it.each([
    ['रुको', 'command:pause'],
    ['ఆపు', 'command:pause'],
    ['നിർത്തൂ', 'command:pause'],
    ['നിര\u0D4D\u200Dത്തൂ', 'command:pause'], // old chillu spelling, as some ASR writes it
    ['दोबारा', 'command:repeat'],
    ['మళ్లీ', 'command:repeat'],
    ['വീണ്ടും', 'command:repeat'],
    ['തുടരൂ', 'command:resume'],
  ])('"%s" -> %s', (utterance, expected) => {
    expect(act(utterance)).toBe(expected);
  });

  it('keeps vowel signs when normalising Indic text', () => {
    expect(normalise('रुको!')).toBe('रुको');
    expect(normalise('మళ్లీ.')).toBe('మళ్లీ');
  });
});

describe('helpers', () => {
  it('shortName keeps brand + model and drops the variant/specs part', () => {
    expect(shortName('Novix A15 5G (Ocean Blue, 6GB RAM, 128GB Storage)')).toBe('Novix A15 5G');
  });

  it('matchLocal (scaffold API) still does exact, case-insensitive matching', () => {
    expect(matchLocal(' Pause ', ['pause', 'stop'])).toEqual({ candidate: 'pause', score: 1 });
    expect(matchLocal('buy it', ['pause'])).toBeNull();
  });
});
