import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScoreEngine, type InferredCondition, type ScoreEngine } from '../src/infer/scores';
import { createSuggester, type Suggester, type SuggestionState } from '../src/infer/suggest';
import { createDebugPanel } from '../src/ui/debugPanel';
import { createSuggestionCard } from '../src/ui/suggestionCard';

describe('suggest-then-switch', () => {
  let t = 0;
  let engine: ScoreEngine;
  let active: Set<InferredCondition>;
  let announce: ReturnType<typeof vi.fn<(text: string, assertive?: boolean) => void>>;
  let states: SuggestionState[];
  let suggester: Suggester;

  const motorEvidence = () => {
    for (let i = 0; i < 10; i++) {
      engine.add('repeat_click');
      engine.add('near_miss');
    }
  };
  const lastAnnounce = () => announce.mock.calls.at(-1)?.[0] as string;

  beforeEach(() => {
    vi.useFakeTimers();
    t = 0;
    engine = createScoreEngine({ now: () => t, halfLifeMs: 10 * 60_000 });
    active = new Set();
    announce = vi.fn<(text: string, assertive?: boolean) => void>();
    states = [];
    suggester = createSuggester({
      engine,
      isActive: (c) => active.has(c),
      apply: (c) => active.add(c),
      revert: (c) => active.delete(c),
      announce,
      now: () => t,
    });
    suggester.subscribe((s) => states.push(s));
  });

  afterEach(() => {
    suggester.dispose();
    vi.useRealTimers();
  });

  it('does nothing without enough evidence', () => {
    engine.add('repeat_click');
    suggester.check();
    expect(suggester.state.kind).toBe('idle');
  });

  it('announces a 10 s countdown, mentions 5 s, then applies with undo offered', () => {
    motorEvidence();
    suggester.check();
    expect(suggester.state).toEqual({ kind: 'countdown', condition: 'motor', secondsLeft: 10 });
    expect(announce).toHaveBeenCalledWith(
      'Easy-press mode might make this easier. Turning it on in 10 seconds. Say no or press Escape to cancel.',
      true,
    );
    vi.advanceTimersByTime(5000);
    expect(lastAnnounce()).toBe('5 seconds');
    expect(active.has('motor')).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(active.has('motor')).toBe(true);
    expect(suggester.state).toEqual({ kind: 'applied', condition: 'motor' });
    expect(lastAnnounce()).toBe('Easy-press mode is on. Say undo or press Undo to turn it off.');
  });

  it('accept applies immediately', () => {
    motorEvidence();
    suggester.check();
    suggester.accept();
    expect(active.has('motor')).toBe(true);
  });

  it('cancel stops it, and a declined mode is never offered again this session', () => {
    motorEvidence();
    suggester.check();
    suggester.decline();
    expect(suggester.state.kind).toBe('idle');
    vi.advanceTimersByTime(20_000);
    expect(active.has('motor')).toBe(false);
    t += 10 * 60_000;
    motorEvidence();
    suggester.check();
    expect(suggester.state.kind).toBe('idle');
  });

  it('undo turns the mode off and it is not re-suggested', () => {
    motorEvidence();
    suggester.check();
    suggester.accept();
    suggester.undo();
    expect(active.has('motor')).toBe(false);
    expect(lastAnnounce()).toBe('Easy-press mode is off.');
    t += 10 * 60_000;
    motorEvidence();
    suggester.check();
    expect(suggester.state.kind).toBe('idle');
  });

  it('one suggestion at a time and at least 60 s apart', () => {
    motorEvidence();
    for (let i = 0; i < 10; i++) {
      engine.add('hesitation');
      engine.add('long_hover');
      engine.add('help_use');
    }
    suggester.check();
    const first = suggester.state.kind === 'countdown' ? suggester.state.condition : null;
    suggester.check();
    expect(suggester.state).toMatchObject({ kind: 'countdown', condition: first });
    suggester.decline();
    t += 30_000;
    suggester.check();
    expect(suggester.state.kind).toBe('idle');
    t += 31_000;
    for (let i = 0; i < 10; i++) {
      engine.add('hesitation');
      engine.add('long_hover');
      engine.add('help_use');
    }
    suggester.check();
    expect(suggester.state.kind).toBe('countdown');
    expect(suggester.state.kind === 'countdown' && suggester.state.condition).not.toBe(first);
  });

  it('never offers a mode that is already on', () => {
    active.add('motor');
    motorEvidence();
    suggester.check();
    expect(suggester.state.kind).toBe('idle');
  });

  it('keyboard-only use asks one question instead of guessing (no countdown)', () => {
    for (let i = 0; i < 20; i++) engine.add('click_without_pointer');
    suggester.check();
    expect(suggester.state.kind).toBe('question');
    expect(lastAnnounce()).toBe(
      'Would you like me to read things aloud, or make buttons easier to press?',
    );
    vi.advanceTimersByTime(120_000);
    expect(suggester.state.kind).toBe('question');
    suggester.answer('visual');
    expect(active.has('visual')).toBe(true);
    expect(suggester.state).toEqual({ kind: 'applied', condition: 'visual' });
  });

  it('answering "neither" declines both and the question is not asked again', () => {
    for (let i = 0; i < 20; i++) engine.add('click_without_pointer');
    suggester.check();
    suggester.answer('neither');
    t += 10 * 60_000;
    suggester.check();
    expect(suggester.state.kind).toBe('idle');
    expect(active.size).toBe(0);
  });

  it('the card shows the countdown, its buttons work, and ticks keep focus on the buttons', () => {
    const withCard = createSuggester({
      engine,
      isActive: (c) => active.has(c),
      apply: (c) => active.add(c),
      revert: (c) => active.delete(c),
      announce,
      now: () => t,
    });
    const card = createSuggestionCard(withCard);
    withCard.subscribe((s) => card.render(s));
    const view = card.element;
    document.body.append(view);
    const buttonNamed = (name: string) =>
      [...view.querySelectorAll('button')].find((b) => b.textContent === name)!;

    motorEvidence();
    withCard.check();
    expect(view.hidden).toBe(false);
    expect(view.querySelector('h3')?.textContent).toBe('Easy-press mode');
    expect(view.querySelector('.asl-countdown')?.textContent).toBe('Turning on in 10 s');

    const noThanks = buttonNamed('No thanks');
    noThanks.focus();
    vi.advanceTimersByTime(1000);
    expect(view.querySelector('.asl-countdown')?.textContent).toBe('Turning on in 9 s');
    expect(document.activeElement).toBe(noThanks);

    buttonNamed('Turn on now').click();
    expect(view.querySelector('h3')?.textContent).toBe('Easy-press mode is on');
    buttonNamed('Undo').click();
    expect(active.has('motor')).toBe(false);
    expect(view.hidden).toBe(true);
    withCard.dispose();
    view.remove();
  });

  it('the question card offers the three answers', () => {
    const withCard = createSuggester({
      engine,
      isActive: (c) => active.has(c),
      apply: (c) => active.add(c),
      revert: (c) => active.delete(c),
      announce,
      now: () => t,
    });
    const card = createSuggestionCard(withCard);
    withCard.subscribe((s) => card.render(s));
    for (let i = 0; i < 20; i++) engine.add('click_without_pointer');
    withCard.check();
    const names = [...card.element.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual(['Read things aloud', 'Easier to press', 'Neither']);
    withCard.dispose();
  });

  it('the debug panel lists every condition with score, groups and status', () => {
    motorEvidence();
    const panel = createDebugPanel(engine, (c) => active.has(c));
    const rows = [...panel.element.querySelectorAll('tbody tr')].map((r) => r.textContent);
    expect(rows).toHaveLength(4);
    const motor = rows.find((r) => r?.startsWith('Easy-press mode'))!;
    expect(motor).toContain('75%');
    expect(motor).toContain('repeat_click');
    expect(motor).toContain('ready to suggest');
    panel.dispose();
  });
});
