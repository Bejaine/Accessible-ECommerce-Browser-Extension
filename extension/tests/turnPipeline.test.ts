// The turn pipeline on its own (no overlay): what the extension does with each part of a
// TurnResponse (docs/backend-api.md §4–6). Track C's backend contract, Track B's actuator results.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AccessibleOutput,
  ClientAction,
  Confirmation,
  PageContext,
  Profile,
  TurnRequest,
  TurnResponse,
} from '@shared/index';
import profileFixture from '../../fixtures/mocks/Profile.json';
import { createMockBackend, type BackendClient } from '../src/core/backend';
import type { TaskContinuity } from '../src/core/continuity';
import { createSession } from '../src/core/session';
import { createTurnPipeline, type PerformFn, type TurnDeps } from '../src/core/turn';

const output = (summary: string, extra: Partial<AccessibleOutput> = {}): AccessibleOutput => ({
  schema_version: '1.0',
  lang: 'en',
  summary,
  sections: [],
  simpler: null,
  followups: [],
  grounding: [],
  warnings: [],
  ...extra,
});

const action = (id: string, kind: 'url_change' | 'none' = 'none'): ClientAction => ({
  schema_version: '1.0',
  id,
  type: 'click',
  target_id: `t-${id}`,
  value: null,
  expected_effect: { kind, detail: null },
});

function response(extra: Partial<TurnResponse> = {}): TurnResponse {
  return {
    schema_version: '1.0',
    intent: { name: 'x', confidence: 0.95, alternatives: [] },
    actions: [],
    confirmation: null,
    workflow: null,
    output: output('OK.'),
    ...extra,
  };
}

const page = (extra: Partial<PageContext> = {}): PageContext => ({
  schema_version: '1.0',
  page_type: 'orders',
  url: 'http://localhost:8080/orders.html',
  site: 'localhost',
  products: [],
  orders: [],
  targets: [],
  secure_zone_active: false,
  ...extra,
});

describe('turn pipeline', () => {
  let replies: (TurnResponse | Error | object)[];
  let requests: TurnRequest[];
  let perform: ReturnType<typeof vi.fn<PerformFn>>;
  let log: string[];
  let shown: AccessibleOutput[];
  let confirmations: (Confirmation | null)[];
  let currentPage: PageContext;
  let profile: Profile;

  const continuity: TaskContinuity = {
    mark: async () => void log.push('mark'),
    clear: async () => void log.push('clear'),
  };

  function pipeline(extra: Partial<TurnDeps> = {}) {
    const backend: BackendClient = {
      ...createMockBackend(),
      turn: async (req) => {
        requests.push(structuredClone(req));
        const next = replies.shift();
        if (!next || next instanceof Error) throw next ?? new Error('no reply');
        if (!('intent' in next)) throw next; // an ErrorResponse
        return next as TurnResponse;
      },
    };
    return createTurnPipeline({
      backend,
      session: createSession('s-1'),
      getProfile: () => profile,
      getPage: () => currentPage,
      perform,
      showOutput: (o) => shown.push(o),
      showConfirmation: (c) => confirmations.push(c),
      announce: (text) => log.push(`say:${text}`),
      confirmEveryAction: () => false,
      continuity,
      ...extra,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    requests = [];
    log = [];
    shown = [];
    confirmations = [];
    currentPage = page();
    profile = structuredClone(profileFixture) as Profile;
    profile.prefs.lang = 'en';
    perform = vi.fn<PerformFn>(async (a) => {
      log.push(`do:${a.id}`);
      return { ok: true };
    });
  });
  afterEach(() => vi.useRealTimers());

  it('sends nothing while the user is in a secure zone', async () => {
    currentPage = page({ secure_zone_active: true });
    const turn = pipeline();
    await turn.send({ kind: 'text', text: 'what is the price' });
    expect(requests).toHaveLength(0);
    expect(shown).toHaveLength(0);
  });

  it('a 423 secure_zone reply stays quiet', async () => {
    replies = [{ error: 'Secure zone.', code: 'secure_zone', retryable: false }];
    const turn = pipeline();
    await turn.send({ kind: 'text', text: 'hi' });
    expect(shown).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it('errors become calm messages by code, never the raw text; retryable ones can be retried', async () => {
    replies = [
      { error: 'Groq 503: model overloaded', code: 'upstream_unavailable', retryable: true },
      response({ output: output('Price is ₹999.') }),
    ];
    const turn = pipeline();
    await turn.send({ kind: 'phrase', text: 'Price', phrase_id: 'price' });
    expect(shown[0]?.summary).toBe(
      "I couldn't do that right now. You can try again, or use the phrase buttons.",
    );
    expect(JSON.stringify(shown)).not.toContain('Groq');
    expect(turn.canRetry).toBe(true);
    await turn.retry();
    expect(requests[1]?.input).toMatchObject({ kind: 'phrase', phrase_id: 'price' });
    expect(shown[1]?.summary).toBe('Price is ₹999.');
    expect(turn.canRetry).toBe(false);
  });

  it('a network failure (no ErrorResponse) is retryable', async () => {
    replies = [new Error('ECONNREFUSED')];
    const turn = pipeline();
    await turn.send({ kind: 'text', text: 'x' });
    expect(turn.canRetry).toBe(true);
  });

  it('a validation error is not offered for retry', async () => {
    replies = [{ error: 'bad', code: 'validation', retryable: false }];
    const turn = pipeline();
    await turn.send({ kind: 'text', text: 'x' });
    expect(shown[0]?.summary).toBe(
      "Sorry, I couldn't get an answer just now. Please try again in a moment.",
    );
    expect(turn.canRetry).toBe(false);
  });

  it('"Did you mean X or Y?": picking an option runs its actions, or sends its label', async () => {
    const alt = (label: string, actions: ClientAction[] = []) => ({ label, intent: 'x', actions });
    const ask = response({
      intent: {
        name: 'unclear',
        confidence: 0.6,
        alternatives: [alt('Choose Black', [action('black')]), alt('Read the reviews')],
      },
      output: output('Did you mean choose Black, or read the reviews?'),
    });
    replies = [ask, ask, response({ output: output('Reviews…') })];
    const turn = pipeline();
    await turn.send({ kind: 'voice', text: 'blek' });
    expect(turn.alternatives.map((a) => a.label)).toEqual(['Choose Black', 'Read the reviews']);
    await turn.chooseAlternative(0);
    expect(log).toContain('do:black');
    expect(requests).toHaveLength(1); // no extra turn for an option with actions

    await turn.send({ kind: 'voice', text: 'blek' });
    await turn.chooseAlternative(1);
    expect(requests[2]?.input).toMatchObject({ kind: 'phrase', text: 'Read the reviews' });
    expect(turn.alternatives).toEqual([]);
  });

  it('ORDER_n / ADDR_n are restored for the user, but history keeps the placeholders', async () => {
    replies = [
      response({
        output: output('ORDER_1 is on its way to ADDR_1.', { followups: ['Track ORDER_1'] }),
        confirmation: {
          schema_version: '1.0',
          id: 'c1',
          prompt: 'Cancel ORDER_1?',
          risk: 'high',
          pending_actions: [action('cancel-1')],
          read_back: null,
        },
      }),
    ];
    const restore = (t: string) =>
      t.replace('ORDER_1', 'MS-1002').replace('ADDR_1', '12 Demo Street');
    const turn = pipeline({ restore });
    await turn.send({ kind: 'text', text: 'where is my order' });
    expect(shown[0]?.summary).toBe('MS-1002 is on its way to 12 Demo Street.');
    expect(shown[0]?.followups).toEqual(['Track MS-1002']);
    expect(confirmations[0]?.prompt).toBe('Cancel MS-1002?');
    expect(turn.pending?.prompt).toBe('Cancel ORDER_1?');
    replies = [response()];
    await turn.send({ kind: 'text', text: 'ok' });
    expect(JSON.stringify(requests[1]?.history)).toContain('ORDER_1 is on its way to ADDR_1.');
    expect(JSON.stringify(requests[1]?.history)).not.toContain('MS-1002');
  });

  it('history is English only (contract), so Hindi turns are not kept', async () => {
    profile.prefs.lang = 'hi';
    replies = [response({ output: output('ठीक है।', { lang: 'hi' }) }), response()];
    const turn = pipeline();
    await turn.send({ kind: 'text', text: 'कीमत' });
    await turn.send({ kind: 'text', text: 'और' });
    expect(requests[1]?.history).toEqual([]);
  });

  describe('order tasks across pages (workflow)', () => {
    const place = response({
      workflow: { name: 'place_order', step: 1, total_steps: 2 },
      output: output('Place this order? Total ₹1,999.'),
      confirmation: {
        schema_version: '1.0',
        id: 'c1',
        prompt: 'Place this order? Total ₹1,999.',
        risk: 'high',
        pending_actions: [action('place-order', 'url_change')],
        read_back: null,
      },
    });

    it('marks "continue on the next page" before a confirmed step, so a navigation keeps the task', async () => {
      replies = [place];
      const turn = pipeline();
      await turn.send({ kind: 'phrase', text: 'Place my order', phrase_id: 'place my order' });
      expect(perform).not.toHaveBeenCalled(); // nothing before yes
      perform.mockImplementationOnce(async (a) => {
        log.push(`do:${a.id}`);
        return { ok: false, reason: 'effect_not_seen' }; // the page is still loading
      });
      await turn.confirm();
      expect(perform).toHaveBeenCalledWith(expect.objectContaining({ id: 'place-order' }), {
        confirmed: true,
      });
      // Marked first; not cleared, because the navigation may still arrive.
      expect(log.filter((l) => !l.startsWith('say:'))).toEqual(['mark', 'do:place-order']);
    });

    it('when the page is still here after the step, it continues the task itself', async () => {
      replies = [
        place,
        response({
          workflow: { name: 'place_order', step: 2, total_steps: 2 },
          output: output('Your order is placed.'),
        }),
      ];
      const turn = pipeline();
      await turn.send({ kind: 'phrase', text: 'Place my order', phrase_id: 'place my order' });
      await turn.confirm();
      await vi.advanceTimersByTimeAsync(500);
      expect(log.filter((l) => !l.startsWith('say:'))).toEqual(['mark', 'do:place-order', 'clear']);
      expect(requests[1]?.input).toMatchObject({ kind: 'phrase', phrase_id: 'continue' });
      expect(requests[1]?.session_id).toBe('s-1');
    });

    it('a failed step clears the marker; the task ending clears it too', async () => {
      replies = [place, response()];
      perform.mockResolvedValueOnce({ ok: false, reason: 'target_not_found' });
      const turn = pipeline();
      await turn.send({ kind: 'phrase', text: 'Place my order', phrase_id: 'place my order' });
      await turn.confirm();
      expect(log.filter((l) => !l.startsWith('say:'))).toEqual(['mark', 'clear']);
      log = [];
      await turn.send({ kind: 'phrase', text: 'Stop', phrase_id: 'stop' });
      expect(log).toContain('clear'); // workflow went from active to null
    });

    it('a new page continues the task (continueTask), at most 3 times in a row', async () => {
      const step = response({
        workflow: { name: 'track_order', step: 1, total_steps: 2 },
        actions: [
          {
            ...action('orders', 'url_change'),
            type: 'navigate',
            target_id: null,
            value: '/orders.html',
          },
        ],
        output: output('Opening your orders.'),
      });
      replies = Array.from({ length: 9 }, () => step);
      const turn = pipeline();
      await turn.continueTask();
      await vi.advanceTimersByTimeAsync(5000);
      expect(requests.map((r) => r.input.phrase_id)).toEqual(['continue', 'continue', 'continue']);
      await turn.send({ kind: 'text', text: 'track my order' }); // the user acts: counter resets
      await vi.advanceTimersByTimeAsync(5000);
      // 3 automatic + the user's turn + at most 3 automatic again
      expect(requests.map((r) => r.input.phrase_id ?? r.input.text)).toEqual([
        'continue',
        'continue',
        'continue',
        'track my order',
        'continue',
        'continue',
        'continue',
      ]);
    });

    it('safe actions outside an order task never touch the marker', async () => {
      replies = [response({ actions: [action('black')] })];
      const turn = pipeline();
      await turn.send({ kind: 'text', text: 'show me the black one' });
      expect(log.filter((l) => !l.startsWith('say:'))).toEqual(['do:black']);
    });
  });
});
