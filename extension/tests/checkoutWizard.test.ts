import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutSummary, Prefs } from '@shared/index';
import checkoutPage from '../../fixtures/mocks/PageContext.checkout.json';
import { defaultProfile } from '../src/core/profile';
import { createCheckoutWizard, STEPS } from '../src/ui/checkoutWizard';

const summary = checkoutPage.checkout as unknown as CheckoutSummary;

describe('step-by-step checkout', () => {
  let opts: Parameters<typeof createCheckoutWizard>[1];
  let prefs: Prefs;

  beforeEach(() => {
    prefs = { ...defaultProfile().prefs };
    opts = {
      onPlaceOrder: vi.fn(),
      onTarget: vi.fn(),
      onBack: vi.fn(),
      announce: vi.fn(),
      prefs,
      changeAddressTargetId: 't-change-address',
    };
  });

  const mount = (s = summary) => {
    const w = createCheckoutWizard(s, opts);
    document.body.replaceChildren(w.element);
    w.go('items');
    return w;
  };
  const buttons = (w: ReturnType<typeof mount>) =>
    [...w.element.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent);
  const press = (w: ReturnType<typeof mount>, name: string) =>
    [...w.element.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === name)!
      .click();

  it('walks four steps, one at a time, saying where you are', () => {
    const w = mount();
    expect(w.element.querySelector('.asl-step')?.textContent).toBe('Step 1 of 4');
    expect(w.element.querySelector('h3')?.textContent).toBe('Your items');
    expect(document.activeElement).toBe(w.element.querySelector('h3'));
    expect(w.element.textContent).toContain(`${summary.items[0]!.title}, Quantity 1, ₹17,999`);
    expect(opts.announce).toHaveBeenCalledOnce(); // only once, after attaching
    expect(vi.mocked(opts.announce).mock.lastCall![0]).toMatch(/^Step 1 of 4\. Your items\./);
    for (const step of STEPS.slice(1)) {
      press(w, 'Next step');
      expect(w.step).toBe(step);
    }
    press(w, 'Previous step');
    expect(w.step).toBe('payment');
  });

  it('shows delivery facts from the summary and changes the address through the turn', () => {
    const w = mount();
    w.go('delivery');
    expect(w.element.textContent).toContain('Delivery PIN code500032');
    expect(w.element.textContent).toContain('Delivery chargeFree');
    press(w, 'Change delivery address');
    expect(opts.onTarget).toHaveBeenCalledWith('t-change-address');
  });

  it('payment: user enters secrets; warns when it is not the usual method', () => {
    prefs.preferred_payment = 'upi';
    const w = mount();
    w.go('payment');
    expect(w.element.textContent).toContain('Cash on delivery');
    expect(w.element.textContent).toContain(
      "You'll type any card number, UPI PIN or OTP yourself.",
    );
    expect(w.element.textContent).toContain('This is not your usual payment method (UPI).');
  });

  it('the last step asks to place the order through the confirmation flow; nothing pressed here', () => {
    const w = mount();
    w.go('review');
    expect(w.element.querySelector('.asl-total')?.textContent).toBe('Total: ₹18,597');
    expect(buttons(w)).toContain('Place order');
    press(w, 'Place order');
    expect(opts.onPlaceOrder).toHaveBeenCalledOnce();
  });

  it('without a total there is no Place order button, and it says why', () => {
    const w = mount({ ...summary, total: null });
    w.go('review');
    expect(buttons(w)).not.toContain('Place order');
    expect(w.element.textContent).toContain(
      "The page doesn't show the total or the Place order button",
    );
  });
});
