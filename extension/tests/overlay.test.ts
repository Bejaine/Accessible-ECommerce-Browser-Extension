import { afterEach, describe, expect, it } from 'vitest';
import { resetAnnouncer } from '../src/ui/announce';
import { mountOverlay } from '../src/ui/overlay';

describe('overlay', () => {
  afterEach(() => resetAnnouncer());

  it('mounts a labelled region with a heading and one live region', () => {
    const container = document.createElement('div');
    container.attachShadow({ mode: 'open' });
    const host = document.createElement('div');
    container.shadowRoot!.appendChild(host);
    document.body.appendChild(container);
    const region = mountOverlay(host);
    expect(region.getAttribute('role')).toBe('region');
    expect(host.querySelector('h2')?.textContent).toBe('Shopping assistant');
    expect(host.querySelectorAll('[aria-live]')).toHaveLength(1);
  });
});
