// Confirmation card: the prompt, the critical numbers read back (quantity, total, PIN code) and
// large Yes / No buttons. Yes is also a spoken "yes" or one switch press; No is "no" or Escape
// (handled by the app). Nothing consequential happens until Yes (rules 2 and 3).
import type { Confirmation, Money } from '@shared/index';
import { getUiLang, label } from './strings';

export const CONFIRM_CSS = `
.asl-confirm { display: grid; gap: 8px; padding: 12px; border: 3px solid var(--asl-fg);
  border-radius: 12px; }
.asl-confirm[hidden] { display: none; }
.asl-confirm h3, .asl-confirm p { margin: 0; }
.asl-confirm dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
.asl-confirm dt { font-weight: 700; }
.asl-confirm dd { margin: 0; }
.asl-confirm .asl-chips button { min-inline-size: 96px; font-weight: 700; }
.asl-confirm .asl-primary { color: var(--asl-accent-fg); background: var(--asl-accent); }
`;

export function formatMoney(money: Money, lang: string = getUiLang()): string {
  return new Intl.NumberFormat(`${lang}-IN`, {
    style: 'currency',
    currency: money.currency,
    maximumFractionDigits: Number.isInteger(money.amount) ? 0 : 2,
  }).format(money.amount);
}

export interface ConfirmCard {
  readonly element: HTMLElement;
  show(confirmation: Confirmation | null, focus?: boolean): void;
}

export function createConfirmCard(
  handlers: { onYes: () => void; onNo: () => void },
  lang?: string,
): ConfirmCard {
  const card = document.createElement('section');
  card.className = 'asl-confirm';
  card.setAttribute('aria-labelledby', 'asl-confirm-title');
  card.hidden = true;

  return {
    element: card,
    show(confirmation, focus = false) {
      card.hidden = confirmation === null;
      if (!confirmation) {
        card.replaceChildren();
        return;
      }
      const title = document.createElement('h3');
      title.id = 'asl-confirm-title';
      title.textContent = label('confirm.title', lang);
      const prompt = document.createElement('p');
      prompt.textContent = confirmation.prompt;
      card.replaceChildren(title, prompt);

      const rb = confirmation.read_back;
      const rows: [string, string][] = [];
      if (rb?.quantity != null) rows.push([label('confirm.quantity', lang), String(rb.quantity)]);
      if (rb?.total) rows.push([label('confirm.total', lang), formatMoney(rb.total, lang)]);
      if (rb?.pin_code) rows.push([label('confirm.pin_code', lang), rb.pin_code]);
      if (rows.length > 0) {
        const dl = document.createElement('dl');
        for (const [k, v] of rows) {
          const dt = document.createElement('dt');
          dt.textContent = k;
          const dd = document.createElement('dd');
          dd.textContent = v;
          dl.append(dt, dd);
        }
        card.append(dl);
      }

      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'asl-primary';
      yes.textContent = label('confirm.yes', lang);
      yes.addEventListener('click', handlers.onYes);
      const no = document.createElement('button');
      no.type = 'button';
      no.textContent = label('confirm.no', lang);
      no.addEventListener('click', handlers.onNo);
      const row = document.createElement('div');
      row.className = 'asl-chips';
      row.append(yes, no);
      card.append(row);
      if (focus) yes.focus();
    },
  };
}
