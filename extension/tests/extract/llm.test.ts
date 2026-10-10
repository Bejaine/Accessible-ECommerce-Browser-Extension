import { describe, expect, it } from 'vitest';
import { buildLlmFallbackRequest } from '../../src/extract';
import { redact } from '../../src/extract/llm';
import { fixture, loadPage } from './helpers';

describe('LLM fallback request', () => {
  it('sends cleaned, capped main-content text and the missing fields', () => {
    const f = fixture('amazon-product-cooker.html');
    const req = buildLlmFallbackRequest(loadPage(f.file), f.url, ['seller']);
    expect(req.site).toBe('amazon.in');
    expect(req.missing).toEqual(['seller']);
    expect(req.text.length).toBeGreaterThan(500);
    expect(req.text.length).toBeLessThanOrEqual(16000);
    expect(req.text).toContain('Hawkins');
  });

  it('redacts emails, phone numbers and card-like numbers', () => {
    expect(redact('mail a@b.co or call 9876543210, card 4111 1111 1111 1111')).toBe(
      'mail [EMAIL] or call [PHONE], card [NUMBER]',
    );
  });
});
