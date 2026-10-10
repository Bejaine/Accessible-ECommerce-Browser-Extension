import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../src/core/bus';

describe('bus', () => {
  it('delivers messages to handlers of that type and supports unsubscribe', () => {
    const bus = createBus();
    const handler = vi.fn();
    const off = bus.on('announce', handler);
    bus.emit({ type: 'announce', text: 'hello' });
    off();
    bus.emit({ type: 'announce', text: 'again' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: 'announce', text: 'hello' });
  });
});
