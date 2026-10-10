import { describe, expect, it, vi } from 'vitest';
import type { TurnRequest } from '@shared/index';
import prepared from '../../fixtures/mocks/ProductPrepareResponse.json';
import turnRequest from '../../fixtures/mocks/TurnRequest.json';
import {
  createBackend,
  createMockBackend,
  createRuntimeBackend,
  handleBackendMessage,
  MOCK_WARNING,
  type BackendRequestMessage,
} from '../src/core/backend';

const request = (input: Partial<TurnRequest['input']>): TurnRequest => {
  const base = turnRequest as unknown as TurnRequest;
  return { ...base, input: { ...base.input, ...input } };
};

describe('mock backend', () => {
  const backend = createMockBackend();

  it('serves fixtures/mocks when VITE_BACKEND=mock', async () => {
    expect((await createBackend('mock').health()).status).toBe('ok');
  });

  it('answers a turn with the fixture section that fits the request', async () => {
    const reviews = await backend.turn(request({ phrase_id: 'reviews', text: null }));
    expect(reviews.output.summary).toBe(prepared.sections.reviews!.summary);
    const specs = await backend.turn(request({ phrase_id: null, text: 'tell me the specs' }));
    expect(specs.output.summary).toBe(prepared.sections.specs!.summary);
  });

  it('add to cart comes back as a confirmation with read-back, never as an action to run now', async () => {
    const res = await backend.turn(request({ phrase_id: 'add to cart' }));
    expect(res.actions).toEqual([]);
    expect(res.confirmation?.pending_actions[0]?.target_id).toBe('t-add-to-cart');
    expect(res.confirmation?.read_back?.total).toEqual({ amount: 17999, currency: 'INR' });
  });

  it('every mock answer is labelled as demo data, and unknown requests say so', async () => {
    const unknown = await backend.turn(request({ phrase_id: null, text: 'what is the weather' }));
    expect(unknown.output.summary).toBe('Demo mode has no answer for that yet.');
    expect(unknown.output.warnings).toContain(MOCK_WARNING);
    const prepared = await backend.prepareProduct({} as never);
    expect(prepared.sections.reviews?.warnings).toContain(MOCK_WARNING);
    expect((await backend.summarizeReviews({} as never)).warnings).toContain(MOCK_WARNING);
  });
});

describe('extract fallback (for Track B)', () => {
  it('mock serves the recorded fallback response', async () => {
    const res = await createMockBackend().extractFallback({} as never);
    expect(res.schema_version).toBe('1.0');
    expect(res).toHaveProperty('found');
  });
});

describe('background relay', () => {
  it('relays calls through the background script and returns their results', async () => {
    const mock = createMockBackend();
    const send = vi.fn((m: BackendRequestMessage) => handleBackendMessage(mock, m));
    const relayed = createRuntimeBackend(send);
    expect((await relayed.health()).status).toBe('ok');
    expect(send).toHaveBeenCalledWith({ type: 'backend', method: 'health', request: undefined });
  });

  it('turns failures into the calm {error, code, retryable} shape', async () => {
    const failing = { ...createMockBackend(), turn: () => Promise.reject(new Error('boom')) };
    const relayed = createRuntimeBackend((m) => handleBackendMessage(failing, m));
    await expect(relayed.turn(request({}))).rejects.toEqual({
      error: 'The assistant could not be reached.',
      code: 'upstream_unavailable',
      retryable: true,
    });
  });

  it('rejects unknown methods', async () => {
    const reply = await handleBackendMessage(createMockBackend(), {
      type: 'backend',
      method: 'deleteEverything' as never,
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'validation' } });
  });
});
