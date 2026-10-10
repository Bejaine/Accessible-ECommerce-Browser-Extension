import { describe, expect, it } from 'vitest';
import type { AccessibleOutput } from '@shared/index';
import output from '../../fixtures/mocks/AccessibleOutput.json';
import { toSpeechQueue } from '../src/render';

describe('render (stub)', () => {
  it('speaks the summary first', () => {
    expect(toSpeechQueue(output as AccessibleOutput)[0]).toBe(output.summary);
  });
});
