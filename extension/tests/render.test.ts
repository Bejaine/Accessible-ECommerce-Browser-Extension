import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessibleOutput, TurnResponse } from '@shared/index';
import reviewsFixture from '../../fixtures/mocks/AccessibleOutput.json';
import turnFixture from '../../fixtures/mocks/TurnResponse.json';
import { canSimplify, flattenSpoken, renderOutput, toSpokenSections } from '../src/render';
import { initAnnouncer, resetAnnouncer } from '../src/ui/announce';

const reviews = reviewsFixture as AccessibleOutput;
const hindi = (turnFixture as unknown as TurnResponse).output;
const withWarning: AccessibleOutput = {
  ...reviews,
  warnings: ['Delivery costs ₹99 extra at checkout.'],
};

describe('spoken renderer', () => {
  it('speaks the summary first, then warnings, then one unit per section', () => {
    const spoken = toSpokenSections(withWarning);
    expect(spoken[0]).toEqual({
      id: 'summary',
      heading: null,
      lines: [reviews.summary, 'Delivery costs ₹99 extra at checkout.'],
    });
    expect(spoken.map((s) => s.heading)).toEqual([null, ...reviews.sections.map((s) => s.heading)]);
  });

  it('reads tables through their spoken version', () => {
    const table = toSpokenSections(reviews).at(-1)!;
    expect(table.lines).toEqual([reviews.sections[2]!.table!.spoken]);
  });

  it('short verbosity keeps only summary and warnings', () => {
    expect(toSpokenSections(withWarning, { verbosity: 'short' })).toHaveLength(1);
  });

  it('simpler mode uses plain-language text where provided, and nothing invented', () => {
    const spoken = toSpokenSections(reviews, { simpler: true });
    expect(spoken[0]!.lines[0]).toBe(reviews.simpler);
    expect(spoken.at(-1)!.lines).toEqual([reviews.sections[2]!.simpler]);
    // Pros has no simpler text: falls back to its items.
    expect(spoken[1]!.lines).toEqual(reviews.sections[0]!.items.map((i) => i.text));
  });

  it('flattens with headings for section-unaware players', () => {
    expect(flattenSpoken(toSpokenSections(reviews))).toContain(reviews.sections[0]!.heading);
  });

  it('only offers "explain simpler" when the backend sent simpler text', () => {
    expect(canSimplify(reviews)).toBe(true);
    expect(canSimplify(hindi)).toBe(false);
  });
});

describe('visual renderer', () => {
  let container: HTMLElement;
  const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
  const qa = (sel: string) => [...container.querySelectorAll(sel)];

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    initAnnouncer(document.body);
  });

  afterEach(() => {
    resetAnnouncer();
    container.remove();
    vi.useRealTimers();
  });

  it('renders summary, sections with headings, labelled pros/cons and a real table', () => {
    renderOutput(container, reviews);
    expect(q('article')?.getAttribute('lang')).toBe('en');
    expect(q('.asl-summary')?.textContent).toBe(reviews.summary);
    expect(qa('h3').map((h) => h.textContent)).toEqual(reviews.sections.map((s) => s.heading));
    expect(qa('section li')[0]?.textContent).toBe(`Pro: ${reviews.sections[0]!.items[0]!.text}`);
    expect(qa('section li')[2]?.textContent?.startsWith('Con: ')).toBe(true);
    expect(qa('thead th').map((th) => th.getAttribute('scope'))).toEqual(['col', 'col', 'col']);
    expect(qa('tbody th').map((th) => th.textContent)).toEqual(['Price', 'Rating', 'RAM']);
  });

  it('shows warnings as labelled text', () => {
    renderOutput(container, withWarning);
    const list = q('.asl-warnings');
    expect(list?.getAttribute('aria-label')).toBe('Warnings');
    expect(list?.textContent).toBe('Warning: Delivery costs ₹99 extra at checkout.');
  });

  it('caps suggestion chips at max_options and reports the chosen one', () => {
    const onFollowup = vi.fn();
    renderOutput(container, reviews, { maxOptions: 2, onFollowup });
    const chips = qa('.asl-chips button') as HTMLButtonElement[];
    expect(chips.map((c) => c.textContent)).toEqual(reviews.followups.slice(0, 2));
    chips[1]!.click();
    expect(onFollowup).toHaveBeenCalledWith(reviews.followups[1]);
  });

  it('"Explain simpler" toggles in place, keeps focus, and announces the new summary', () => {
    const view = renderOutput(container, reviews);
    const toggle = q<HTMLButtonElement>('.asl-simpler')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.focus();
    toggle.click();
    expect(view.simpler).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(q('.asl-summary')?.textContent).toBe(reviews.simpler);
    expect(document.activeElement).toBe(toggle);
    vi.advanceTimersByTime(100);
    expect(document.getElementById('asl-live')?.textContent).toBe(reviews.simpler);
  });

  it('has no "Explain simpler" when there is nothing simpler, and keeps the output language', () => {
    renderOutput(container, hindi);
    expect(q('.asl-simpler')).toBeNull();
    expect(q('article')?.getAttribute('lang')).toBe('hi');
    expect(q('.asl-summary')?.textContent).toBe(hindi.summary);
  });

  it('never interprets output text as HTML', () => {
    renderOutput(container, { ...reviews, summary: '<img src=x onerror=alert(1)>' });
    expect(q('img')).toBeNull();
    expect(q('.asl-summary')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
