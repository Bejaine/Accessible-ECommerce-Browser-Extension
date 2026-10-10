import { describe, expect, it } from 'vitest';
import { speechSegments, splitSentences } from '../src/audio/sentences';

describe('splitSentences', () => {
  it.each([
    [
      'Battery lasts a day. The camera is average.',
      ['Battery lasts a day.', 'The camera is average.'],
    ],
    ['Is it in stock? Yes! Delivery Tuesday.', ['Is it in stock?', 'Yes!', 'Delivery Tuesday.']],
    ['कीमत ₹17,999 है। डिलीवरी मंगलवार तक।', ['कीमत ₹17,999 है।', 'डिलीवरी मंगलवार तक।']],
    ['ధర ₹17,999. మంగళవారం డెలివరీ.', ['ధర ₹17,999.', 'మంగళవారం డెలివరీ.']],
    // not sentence ends
    ['Rated 4.3 out of 5 by buyers.', ['Rated 4.3 out of 5 by buyers.']],
    ['It costs Rs. 1,299 today.', ['It costs Rs. 1,299 today.']],
    [
      'Ports, e.g. USB-C and HDMI, are on the side.',
      ['Ports, e.g. USB-C and HDMI, are on the side.'],
    ],
    ['Model No. 5 is out. Try another.', ['Model No. 5 is out.', 'Try another.']],
    ['Wait... it is fine.', ['Wait... it is fine.']],
    // whitespace and empties
    ['  One.   Two.  ', ['One.', 'Two.']],
    ['Line one\nLine two', ['Line one', 'Line two']],
    ['No punctuation at all', ['No punctuation at all']],
    ['', []],
  ])('%s', (text, expected) => {
    expect(splitSentences(text)).toEqual(expected);
  });
});

describe('speechSegments', () => {
  it('joins a very short sentence with the next, so each TTS call carries enough', () => {
    expect(speechSegments('Yes. Added to cart. Delivery by Tuesday next week.')).toEqual([
      'Yes. Added to cart.',
      'Delivery by Tuesday next week.',
    ]);
  });

  it('keeps sentences of normal length apart (each is highlighted and repeatable)', () => {
    const text = 'Customers like the battery. Some say the camera is average.';
    expect(speechSegments(text)).toEqual(splitSentences(text));
  });

  it('keeps a short last sentence on its own rather than losing it', () => {
    expect(speechSegments('The phone is in stock. Buy?')).toEqual([
      'The phone is in stock.',
      'Buy?',
    ]);
  });
});
