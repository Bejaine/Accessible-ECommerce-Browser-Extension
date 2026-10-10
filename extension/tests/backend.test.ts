import { describe, expect, it } from 'vitest';
import { createBackend } from '../src/core/backend';

describe('backend (mock)', () => {
  it('serves fixtures/mocks when VITE_BACKEND=mock', async () => {
    const backend = createBackend('mock');
    expect((await backend.health()).status).toBe('ok');
    expect((await backend.turn({} as never)).output.summary).toBeTruthy();
  });
});
