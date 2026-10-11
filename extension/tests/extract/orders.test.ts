// ORDER_n placeholders must mean the same order on every page of a tab: the backend's order task
// keeps "ORDER_2" from the orders page and looks for it again on the cancel page.
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { orderPlaceholder } from '../../src/extract/orders';
import { resolveOrderId } from '../../src/extract';

/** A new page in the same tab: a fresh document, the tab's sessionStorage carried over. */
function nextPage(prev: Window | null): Window {
  const win = new Window({ url: 'http://localhost:8080/order.html' });
  const saved = prev?.sessionStorage.getItem('asl-order-placeholders');
  if (saved) win.sessionStorage.setItem('asl-order-placeholders', saved);
  return win;
}

describe('order placeholders across pages', () => {
  it('keep their numbers on the next page of the tab', () => {
    const orders = nextPage(null);
    const doc1 = orders.document as unknown as Document;
    expect(orderPlaceholder(doc1, 'MS-1003')).toBe('ORDER_1');
    expect(orderPlaceholder(doc1, 'MS-1002')).toBe('ORDER_2');

    const detail = nextPage(orders); // only MS-1002 is on this page
    const doc2 = detail.document as unknown as Document;
    expect(orderPlaceholder(doc2, 'MS-1002')).toBe('ORDER_2');
    expect(resolveOrderId('ORDER_1', doc2)).toBe('MS-1003');
    expect(orderPlaceholder(doc2, 'MS-1004')).toBe('ORDER_3');
  });

  it('a new tab starts again from ORDER_1', () => {
    const doc = nextPage(null).document as unknown as Document;
    expect(orderPlaceholder(doc, 'MS-1002')).toBe('ORDER_1');
  });
});
