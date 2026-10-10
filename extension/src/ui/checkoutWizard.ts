// Step-by-step checkout (simple mode / ageing): one screen at a time from PageContext.checkout
// (Track B extracts it; Track C's place-order flow confirms it). Every value comes from the
// CheckoutSummary; a missing one says the page doesn't list it (rule 1). The last step asks to
// "place my order", which goes through Track C's high-risk confirmation with read-back:
// nothing is pressed here (rule 2). Payment details are always entered by the user.
import type { CheckoutSummary, Prefs } from '@shared/index';
import { formatMoney } from './confirmCard';
import { label, type UiKey } from './strings';

export const CHECKOUT_CSS = `
.asl-wizard { display: grid; gap: 12px; font-size: 1.15em; }
.asl-wizard h3 { margin: 0; }
.asl-wizard .asl-step { margin: 0; font-weight: 700; }
.asl-wizard ul { margin: 0; padding-inline-start: 1.2em; }
.asl-wizard dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.asl-wizard dt { font-weight: 700; }
.asl-wizard dd { margin: 0; }
.asl-wizard .asl-total { font-size: 1.4em; font-weight: 800; margin: 0; }
.asl-wizard .asl-nav { display: flex; flex-wrap: wrap; gap: 10px; }
.asl-wizard button { min-block-size: 56px; padding: 8px 18px; font: inherit; font-weight: 700; cursor: pointer;
  border-radius: 12px; color: var(--asl-fg); background: var(--asl-bg); border: 2px solid var(--asl-fg); }
.asl-wizard .asl-primary { color: var(--asl-accent-fg); background: var(--asl-accent); }
`;

export type WizardStep = 'items' | 'delivery' | 'payment' | 'review';
export const STEPS: WizardStep[] = ['items', 'delivery', 'payment', 'review'];

const PAYMENT: Record<string, UiKey> = {
  upi: 'checkout.pay.upi',
  saved_card: 'checkout.pay.saved_card',
  card: 'checkout.pay.card',
  netbanking: 'checkout.pay.netbanking',
  cod: 'checkout.pay.cod',
  other: 'checkout.pay.other',
};

export interface WizardOptions {
  /** "Place my order": goes to /turn, which reads it back and asks for confirmation. */
  onPlaceOrder: () => void;
  /** Press a page control through the turn (e.g. "Change delivery address"). */
  onTarget: (targetId: string) => void;
  onBack: () => void;
  /** Announce each step (spoken by the screen reader / the assistant's voice). */
  announce: (text: string) => void;
  prefs: Prefs;
  changeAddressTargetId?: string | null;
}

export interface CheckoutWizard {
  readonly element: HTMLElement;
  readonly step: WizardStep;
  go(step: WizardStep): void;
}

const notListed = () => label('simple.not_listed');

export function createCheckoutWizard(
  summary: CheckoutSummary,
  opts: WizardOptions,
): CheckoutWizard {
  const view = document.createElement('article');
  view.className = 'asl-wizard';
  view.setAttribute('aria-labelledby', 'asl-wizard-title');
  let step: WizardStep = 'items';

  const money = (m: CheckoutSummary['total']) => (m ? formatMoney(m) : notListed());

  function facts(rows: [UiKey, string][]): HTMLElement {
    const dl = document.createElement('dl');
    for (const [term, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label(term);
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
    return dl;
  }

  function button(key: UiKey, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label(key);
    if (primary) b.className = 'asl-primary';
    b.addEventListener('click', onClick);
    return b;
  }

  /** The step's content plus the sentence spoken for it. */
  function content(): { nodes: HTMLElement[]; spoken: string } {
    if (step === 'items') {
      const list = document.createElement('ul');
      const lines = summary.items.map(
        (i) => `${i.title}, ${label('confirm.quantity')} ${i.quantity}, ${money(i.price)}`,
      );
      for (const line of lines) {
        const li = document.createElement('li');
        li.textContent = line;
        list.append(li);
      }
      const sub = facts([['checkout.subtotal', money(summary.subtotal)]]);
      return {
        nodes: [list, sub],
        spoken: `${lines.join('. ')}. ${label('checkout.subtotal')} ${money(summary.subtotal)}.`,
      };
    }
    if (step === 'delivery') {
      const charge =
        summary.delivery_charge === null
          ? notListed()
          : summary.delivery_charge.amount === 0
            ? label('checkout.free')
            : formatMoney(summary.delivery_charge);
      const rows: [UiKey, string][] = [
        ['confirm.pin_code', summary.delivery_pin_code ?? notListed()],
        ['checkout.charge', charge],
      ];
      const nodes: HTMLElement[] = [facts(rows)];
      if (opts.changeAddressTargetId) {
        const id = opts.changeAddressTargetId;
        nodes.push(button('checkout.change_address', () => opts.onTarget(id)));
      }
      return { nodes, spoken: rows.map(([k, v]) => `${label(k)}: ${v}`).join('. ') + '.' };
    }
    if (step === 'payment') {
      const method = summary.payment_method ? label(PAYMENT[summary.payment_method]!) : notListed();
      const nodes: HTMLElement[] = [facts([['checkout.payment', method]])];
      const lines = [`${label('checkout.payment')}: ${method}.`, label('checkout.secure')];
      if (
        opts.prefs.preferred_payment &&
        summary.payment_method &&
        opts.prefs.preferred_payment !== summary.payment_method
      ) {
        lines.push(
          label('checkout.not_preferred').replace(
            '{method}',
            label(PAYMENT[opts.prefs.preferred_payment]!),
          ),
        );
      }
      for (const line of lines.slice(1)) {
        const p = document.createElement('p');
        p.textContent = line;
        nodes.push(p);
      }
      return { nodes, spoken: lines.join(' ') };
    }
    const total = document.createElement('p');
    total.className = 'asl-total';
    total.textContent = `${label('confirm.total')}: ${money(summary.total)}`;
    const nodes: HTMLElement[] = [total];
    const canPlace = summary.total !== null && summary.place_order_target_id !== null;
    const note = document.createElement('p');
    note.textContent = label(canPlace ? 'checkout.review' : 'checkout.cannot_place');
    nodes.push(note);
    return { nodes, spoken: `${total.textContent}. ${note.textContent}` };
  }

  /** `speak` false builds the step silently (before the view is attached). */
  function render(speak = true): void {
    const index = STEPS.indexOf(step);
    const title = document.createElement('h3');
    title.id = 'asl-wizard-title';
    title.tabIndex = -1;
    title.textContent = label(`checkout.step.${step}` as UiKey);
    const counter = document.createElement('p');
    counter.className = 'asl-step';
    counter.textContent = label('checkout.counter')
      .replace('{n}', String(index + 1))
      .replace('{total}', String(STEPS.length));
    const { nodes, spoken } = content();

    const nav = document.createElement('div');
    nav.className = 'asl-nav';
    if (index > 0) nav.append(button('checkout.previous', () => go(STEPS[index - 1]!)));
    if (index < STEPS.length - 1) {
      nav.append(button('checkout.next', () => go(STEPS[index + 1]!), true));
    } else if (summary.total !== null && summary.place_order_target_id !== null) {
      nav.append(button('checkout.place', opts.onPlaceOrder, true));
    }
    nav.append(button('render.back', opts.onBack));

    view.replaceChildren(title, counter, ...nodes, nav);
    if (!speak) return;
    title.focus();
    opts.announce(`${counter.textContent}. ${title.textContent}. ${spoken}`);
  }

  function go(next: WizardStep): void {
    step = next;
    render();
  }

  render(false); // the caller attaches the view, then calls go(...) to focus and speak
  return {
    element: view,
    get step() {
      return step;
    },
    go,
  };
}
