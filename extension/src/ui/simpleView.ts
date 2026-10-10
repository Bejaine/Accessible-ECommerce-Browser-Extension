// Simplified product view (simple mode / ageing): our own view built only from ProductJSON and
// the page map, without the shop's ads, sidebars or promos (we never hide the shop's content;
// this is a separate view, rule 11). Every fact comes from a ProductJSON field; a missing one
// says the page doesn't list it (rule 1). Actions go through the normal turn (confirmation).
import type { ActionTarget, ProductJSON } from '@shared/index';
import { formatMoney } from './confirmCard';
import { label, type UiKey } from './strings';

export const SIMPLE_VIEW_CSS = `
.asl-simple { display: grid; gap: 12px; font-size: 1.2em; }
.asl-simple h3 { margin: 0; font-size: 1.15em; }
.asl-simple dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.asl-simple dt { font-weight: 700; }
.asl-simple dd { margin: 0; }
.asl-simple .asl-price { font-size: 1.4em; font-weight: 800; margin: 0; }
.asl-simple .asl-big { display: grid; gap: 10px; }
.asl-simple .asl-big button { min-block-size: 56px; font: inherit; font-weight: 700; cursor: pointer;
  border-radius: 12px; color: var(--asl-accent-fg); background: var(--asl-accent); border: 2px solid var(--asl-border); }
.asl-simple .asl-back { min-block-size: 44px; font: inherit; cursor: pointer; border-radius: 8px;
  color: var(--asl-fg); background: var(--asl-bg); border: 2px solid var(--asl-fg); justify-self: start; padding: 8px 16px; }
`;

export const MAX_SPECS = 5;

const missing = (field: UiKey) => label('simple.missing').replace('{field}', label(field));

/** The few facts a simple view leads with, as one sentence (also spoken). */
export function simpleSummary(product: ProductJSON): string {
  const parts = [product.title ?? label('simple.no_title')];
  parts.push(product.price ? formatMoney(product.price) : missing('simple.price'));
  if (product.rating) {
    parts.push(
      label('simple.rating_value')
        .replace('{value}', String(product.rating.value))
        .replace('{count}', product.rating.count.toLocaleString('en-IN')),
    );
  }
  return parts.join('. ') + '.';
}

export function renderSimpleView(
  product: ProductJSON,
  targets: ActionTarget[],
  opts: { onSelect: (target: ActionTarget) => void; onBack: () => void; maxActions: number },
): HTMLElement {
  const view = document.createElement('article');
  view.className = 'asl-simple';
  view.setAttribute('aria-labelledby', 'asl-simple-title');

  const title = document.createElement('h3');
  title.id = 'asl-simple-title';
  title.textContent = product.title ?? label('simple.no_title');

  const price = document.createElement('p');
  price.className = 'asl-price';
  price.textContent = product.price ? formatMoney(product.price) : missing('simple.price');

  const facts = document.createElement('dl');
  const fact = (term: UiKey, value: string | null) => {
    const dt = document.createElement('dt');
    dt.textContent = label(term);
    const dd = document.createElement('dd');
    dd.textContent = value ?? label('simple.not_listed');
    facts.append(dt, dd);
  };
  if (product.price?.mrp && product.price.mrp > product.price.amount) {
    const mrp = { amount: product.price.mrp, currency: product.price.currency };
    const saving = {
      amount: product.price.mrp - product.price.amount,
      currency: product.price.currency,
    };
    fact(
      'simple.mrp',
      `${formatMoney(mrp)} (${label('simple.save').replace('{amount}', formatMoney(saving))})`,
    );
  }
  fact(
    'simple.rating',
    product.rating
      ? label('simple.rating_value')
          .replace('{value}', String(product.rating.value))
          .replace('{count}', product.rating.count.toLocaleString('en-IN'))
      : null,
  );
  fact('simple.availability', product.availability?.text ?? product.availability?.status ?? null);
  fact('simple.delivery', product.delivery?.text ?? null);
  fact('simple.seller', product.seller);

  const children: HTMLElement[] = [title, price, facts];

  const specs = Object.values(product.specs).slice(0, MAX_SPECS);
  if (specs.length > 0) {
    const h = document.createElement('h3');
    h.textContent = label('simple.specs');
    const list = document.createElement('ul');
    for (const s of specs) {
      const li = document.createElement('li');
      li.textContent = `${s.label}: ${s.value}${s.unit ? ` ${s.unit}` : ''}`;
      list.append(li);
    }
    children.push(h, list);
  }

  if (product.variants && product.variants.length > 0) {
    const h = document.createElement('h3');
    h.textContent = label('simple.options');
    const list = document.createElement('ul');
    for (const v of product.variants) {
      const li = document.createElement('li');
      li.textContent = `${v.name}: ${v.value}${v.selected ? ` ${label('simple.selected')}` : ''}`;
      list.append(li);
    }
    children.push(h, list);
  }

  const actions = targets
    .filter((t) => t.zone === 'product' && t.kind === 'button' && !t.state?.disabled)
    .slice(0, opts.maxActions);
  if (actions.length > 0) {
    const h = document.createElement('h3');
    h.textContent = label('simple.actions');
    const big = document.createElement('div');
    big.className = 'asl-big';
    for (const target of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = target.label;
      b.addEventListener('click', () => opts.onSelect(target));
      big.append(b);
    }
    children.push(h, big);
  }

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'asl-back';
  back.textContent = label('render.back');
  back.addEventListener('click', opts.onBack);
  children.push(back);

  view.append(...children);
  return view;
}
