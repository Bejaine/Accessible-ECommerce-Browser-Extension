// Mock store (Track B): a small fake shop for the backup demo and for tests of checkout,
// cancel and return flows (docs/safety.md: never on a real account). All products, prices
// and orders are synthetic. State lives in localStorage; nothing is sent anywhere.
// Each page sets <body data-page="…"> and this script renders it.

const CATALOG = [
  {
    id: 'zx-buds-air',
    title: 'Zentra Buds Air Wireless Earbuds',
    brand: 'Zentra',
    category: 'Electronics > Headphones > In-Ear',
    price: 1999,
    mrp: 3999,
    rating: 4.2,
    ratings: 1284,
    stock: 'in_stock',
    stockText: 'In stock',
    colours: ['White', 'Black', 'Olive'],
    specs: [
      ['Battery life', '30 h'],
      ['Bluetooth version', '5.3'],
      ['Weight', '48 g'],
      ['Water resistance', 'IPX5'],
      ['In the box', 'Earbuds, charging case, USB-C cable'],
    ],
    reviews: [
      [5, 'Great for calls', 'Mic is clear and the case is small.', '2026-09-20'],
      [3, 'Bass is light', 'Fine for podcasts, not for bass lovers.', '2026-09-28'],
    ],
  },
  {
    id: 'zx-pulse-5g',
    title: 'Zentra Pulse 5G (8 GB RAM, 128 GB)',
    brand: 'Zentra',
    category: 'Electronics > Mobiles > Smartphones',
    price: 15999,
    mrp: 19999,
    rating: 4.3,
    ratings: 2310,
    stock: 'in_stock',
    stockText: 'In stock',
    colours: ['Ocean Blue', 'Graphite Black'],
    specs: [
      ['RAM', '8 GB'],
      ['Storage', '128 GB'],
      ['Battery capacity', '5000 mAh'],
      ['Display size', '6.7 inch'],
      ['Rear camera', '50 MP'],
    ],
    reviews: [[4, 'Good value', 'Battery lasts a full day of heavy use.', '2026-10-01']],
  },
  {
    id: 'kk-cooker-5l',
    title: 'KitchenKraft Pressure Cooker 5 L',
    brand: 'KitchenKraft',
    category: 'Home & Kitchen > Cookware > Pressure Cookers',
    price: 1499,
    mrp: 2100,
    rating: 4.1,
    ratings: 860,
    stock: 'low_stock',
    stockText: 'Only 3 left in stock.',
    colours: [],
    specs: [
      ['Capacity', '5 L'],
      ['Material', 'Aluminium'],
      ['Induction compatible', 'No'],
    ],
    reviews: [[4, 'Sturdy', 'Whistles on time, handle stays cool.', '2026-08-15']],
  },
  {
    id: 'zx-fit-band-2',
    title: 'Zentra Fit Band 2',
    brand: 'Zentra',
    category: 'Electronics > Wearables',
    price: 2499,
    mrp: 2999,
    rating: 3.9,
    ratings: 412,
    stock: 'out_of_stock',
    stockText: 'Currently unavailable.',
    colours: ['Black'],
    specs: [
      ['Battery life', '10 days'],
      ['Display', '1.1 inch AMOLED'],
    ],
    reviews: [],
  },
  {
    id: 'nx-charger-33w',
    title: 'Novex 33W USB-C Fast Charger',
    brand: 'Novex',
    category: 'Electronics > Mobile Accessories > Chargers',
    price: 799,
    mrp: 1299,
    rating: 4.4,
    ratings: 3021,
    stock: 'in_stock',
    stockText: 'In stock',
    colours: [],
    specs: [
      ['Output', '33 W'],
      ['Port', 'USB-C'],
    ],
    reviews: [],
  },
];

const KEY = 'asl-mock-store-v1';
const DAY = 86400000;

function today() {
  // Fixed "today" in tests (window.MOCK_TODAY), the real date otherwise.
  return new Date(window.MOCK_TODAY ?? Date.now());
}

function isoDay(offsetDays) {
  return new Date(today().getTime() + offsetDays * DAY).toISOString().slice(0, 10);
}

function seedState() {
  return {
    cart: [],
    nextOrder: 1003,
    orders: [
      {
        id: 'MS-1001',
        items: [{ id: 'nx-charger-33w', qty: 1, price: 799 }],
        status: 'delivered',
        ordered: isoDay(-9),
        expected: isoDay(-5),
        delivered: isoDay(-5),
      },
      {
        id: 'MS-1002',
        items: [{ id: 'zx-buds-air', qty: 2, price: 1999, colour: 'Black' }],
        status: 'shipped',
        ordered: isoDay(-2),
        expected: isoDay(2),
        delivered: null,
      },
    ],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Storage blocked or corrupt: start fresh.
  }
  return seedState();
}

function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not fatal for a demo.
  }
}

let state = load();

const rupees = (n) => `₹${n.toLocaleString('en-IN')}`;
const product = (id) => CATALOG.find((p) => p.id === id);
const params = new URLSearchParams(location.search);
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

function cartCount() {
  return state.cart.reduce((n, l) => n + l.qty, 0);
}

function announce(text) {
  const live = document.getElementById('status');
  if (live) live.textContent = text;
}

function header() {
  const el = document.querySelector('header.site');
  if (!el) return;
  el.innerHTML = `
    <a class="logo" href="index.html">MockMart</a>
    <form role="search" action="index.html">
      <input type="search" id="q" name="q" placeholder="Search MockMart" aria-label="Search MockMart" value="${esc(params.get('q') ?? '')}">
      <button type="submit">Search</button>
    </form>
    <a href="orders.html">Your orders</a>
    <a href="cart.html" aria-label="Cart, ${cartCount()} items">Cart <span id="cart-count" data-cart-count="${cartCount()}">${cartCount()}</span></a>`;
}

function renderSearch() {
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const hits = CATALOG.filter(
    (p) => !q || `${p.title} ${p.brand} ${p.category}`.toLowerCase().includes(q),
  );
  const main = document.querySelector('main');
  main.innerHTML = `
    <h1>${q ? `Results for “${esc(params.get('q'))}”` : 'All products'}</h1>
    <ul class="results">${hits
      .map(
        (p) => `
      <li class="card result" data-product-id="${p.id}">
        <h2><a href="product.html?id=${p.id}">${esc(p.title)}</a></h2>
        <p><span class="price">${rupees(p.price)}</span><span class="mrp">M.R.P. ${rupees(p.mrp)}</span></p>
        <p class="rating" aria-label="${p.rating} out of 5 stars, ${p.ratings.toLocaleString('en-IN')} ratings">${p.rating} ★ (${p.ratings.toLocaleString('en-IN')})</p>
        <p class="${p.stock.replace(/_/g, '-')}">${esc(p.stockText)}</p>
      </li>`,
      )
      .join('')}</ul>
    ${hits.length ? '' : '<p>No products match.</p>'}`;
}

function jsonLd(p) {
  const s = document.createElement('script');
  s.type = 'application/ld+json';
  s.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.title,
    sku: p.id,
    brand: { '@type': 'Brand', name: p.brand },
    category: p.category,
    aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating, ratingCount: p.ratings },
    offers: {
      '@type': 'Offer',
      price: p.price,
      priceCurrency: 'INR',
      availability: {
        in_stock: 'https://schema.org/InStock',
        low_stock: 'https://schema.org/LimitedAvailability',
        out_of_stock: 'https://schema.org/OutOfStock',
      }[p.stock],
      seller: { '@type': 'Organization', name: 'MockMart Retail' },
    },
    review: p.reviews.map(([rating, name, body, date]) => ({
      '@type': 'Review',
      name,
      reviewBody: body,
      datePublished: date,
      reviewRating: { '@type': 'Rating', ratingValue: rating, bestRating: 5 },
    })),
  });
  document.head.appendChild(s);
}

function renderProduct() {
  const p = product(params.get('id')) ?? CATALOG[0];
  jsonLd(p);
  document.title = `${p.title} — MockMart`;
  const colour = p.colours[0] ?? null;
  const main = document.querySelector('main');
  main.innerHTML = `
    <nav aria-label="Breadcrumb" id="breadcrumbs">${p.category
      .split(' > ')
      .map((c) => `<a href="index.html?q=${encodeURIComponent(c)}">${esc(c)}</a>`)
      .join(' › ')}</nav>
    <h1 id="title">${esc(p.title)}</h1>
    <p>Brand: <span id="brand">${esc(p.brand)}</span></p>
    <p class="rating" aria-label="${p.rating} out of 5 stars, ${p.ratings.toLocaleString('en-IN')} ratings">${p.rating} ★ (${p.ratings.toLocaleString('en-IN')} ratings)</p>
    <p><span class="price" id="price">${rupees(p.price)}</span><span class="mrp" id="mrp">M.R.P. ${rupees(p.mrp)}</span></p>
    <p id="availability" class="${p.stock.replace(/_/g, '-')}">${esc(p.stockText)}</p>
    <p id="delivery">FREE delivery ${longDate(isoDay(3))}</p>
    <p>Sold by <span id="seller">MockMart Retail</span></p>
    ${
      p.colours.length
        ? `<fieldset class="swatches" id="colour-swatches"><legend>Colour: <span id="selected-colour">${esc(colour)}</span></legend>${p.colours
            .map(
              (c, i) =>
                `<button type="button" class="swatch secondary" data-colour="${esc(c)}" title="${esc(c)}" aria-pressed="${i === 0}">${esc(c)}</button>`,
            )
            .join('')}</fieldset>`
        : ''
    }
    <div class="row">
      <label>Quantity <select id="quantity" name="quantity">${[1, 2, 3, 4, 5]
        .map((n) => `<option value="${n}">${n}</option>`)
        .join('')}</select></label>
      <button type="button" id="add-to-cart" ${p.stock === 'out_of_stock' ? 'disabled' : ''}>Add to Cart</button>
      <button type="button" id="buy-now" class="secondary" ${p.stock === 'out_of_stock' ? 'disabled' : ''}>Buy Now</button>
    </div>
    <h2>Specifications</h2>
    <table class="specs"><tbody>${p.specs
      .map(([l, v]) => `<tr><th scope="row">${esc(l)}</th><td>${esc(v)}</td></tr>`)
      .join('')}</tbody></table>
    <h2>Customer reviews</h2>
    ${
      p.reviews.length
        ? `<ul>${p.reviews
            .map(
              ([r, t, b, d]) =>
                `<li class="review"><strong>${r} out of 5 — ${esc(t)}</strong><p>${esc(b)}</p><time datetime="${d}">${d}</time></li>`,
            )
            .join('')}</ul>`
        : '<p>No reviews yet.</p>'
    }`;

  let chosen = colour;
  for (const b of main.querySelectorAll('.swatch')) {
    b.addEventListener('click', () => {
      chosen = b.dataset.colour;
      for (const o of main.querySelectorAll('.swatch'))
        o.setAttribute('aria-pressed', String(o === b));
      document.getElementById('selected-colour').textContent = chosen;
      announce(`Colour ${chosen} selected`);
    });
  }
  const add = () => {
    const qty = Number(document.getElementById('quantity').value);
    const line = state.cart.find((l) => l.id === p.id && l.colour === chosen);
    if (line) line.qty += qty;
    else state.cart.push({ id: p.id, qty, colour: chosen });
    save(state);
    header();
  };
  document.getElementById('add-to-cart').addEventListener('click', () => {
    add();
    announce(`Added to Cart: ${p.title}`);
    main.insertAdjacentHTML(
      'afterbegin',
      `<p class="notice" id="added-notice">Added to Cart. <a href="cart.html">Go to Cart</a></p>`,
    );
  });
  document.getElementById('buy-now').addEventListener('click', () => {
    add();
    location.href = 'checkout.html';
  });
}

function cartTotal() {
  return state.cart.reduce((n, l) => n + product(l.id).price * l.qty, 0);
}

function renderCart() {
  const main = document.querySelector('main');
  if (!state.cart.length) {
    main.innerHTML = `<h1>Shopping Cart</h1><p id="empty-cart">Your cart is empty.</p><a class="button" href="index.html">Continue shopping</a>`;
    return;
  }
  main.innerHTML = `
    <h1>Shopping Cart</h1>
    <ul class="results">${state.cart
      .map((l, i) => {
        const p = product(l.id);
        return `<li class="card cart-line" data-product-id="${p.id}">
          <h2><a href="product.html?id=${p.id}">${esc(p.title)}</a></h2>
          ${l.colour ? `<p>Colour: ${esc(l.colour)}</p>` : ''}
          <p class="price">${rupees(p.price)}</p>
          <div class="row">
            <label>Quantity <select class="qty" data-line="${i}">${[1, 2, 3, 4, 5]
              .map((n) => `<option value="${n}" ${n === l.qty ? 'selected' : ''}>${n}</option>`)
              .join('')}</select></label>
            <button type="button" class="secondary remove" data-line="${i}">Delete ${esc(p.title)}</button>
          </div>
        </li>`;
      })
      .join('')}</ul>
    <p>Subtotal (<span id="item-count">${cartCount()}</span> items): <strong id="subtotal">${rupees(cartTotal())}</strong></p>
    <a class="button" id="proceed" href="checkout.html">Proceed to checkout</a>`;
  for (const s of main.querySelectorAll('select.qty')) {
    s.addEventListener('change', () => {
      state.cart[Number(s.dataset.line)].qty = Number(s.value);
      save(state);
      header();
      renderCart();
      announce(`Quantity changed. Subtotal ${rupees(cartTotal())}`);
    });
  }
  for (const b of main.querySelectorAll('button.remove')) {
    b.addEventListener('click', () => {
      state.cart.splice(Number(b.dataset.line), 1);
      save(state);
      header();
      renderCart();
      announce('Item removed from cart');
    });
  }
}

function renderCheckout() {
  const main = document.querySelector('main');
  if (!state.cart.length) {
    main.innerHTML = `<h1>Checkout</h1><p>Your cart is empty.</p><a class="button" href="index.html">Continue shopping</a>`;
    return;
  }
  const delivery = isoDay(3);
  main.innerHTML = `
    <h1>Checkout</h1>
    <section aria-labelledby="h-address"><h2 id="h-address">1. Delivery address</h2>
      <label>Full name <input id="fullname" name="fullname" autocomplete="name" value="Demo User"></label>
      <label>Address <input id="address" name="address" autocomplete="street-address" value="12 Demo Street, Hyderabad"></label>
      <label>PIN code <input id="pincode" name="pincode" inputmode="numeric" autocomplete="postal-code" value="500032"></label>
    </section>
    <section aria-labelledby="h-pay"><h2 id="h-pay">2. Payment method</h2>
      <label><input type="radio" name="payment" value="upi" checked> UPI (approve in your UPI app)</label>
      <label><input type="radio" name="payment" value="cod"> Cash on Delivery</label>
      <label><input type="radio" name="payment" value="card"> Credit or debit card</label>
      <div id="card-fields" class="secure" hidden>
        <p>Card details are typed by you. MockMart never stores them.</p>
        <label>Card number <input id="cc-number" name="cardnumber" autocomplete="cc-number" inputmode="numeric"></label>
        <label>Expiry (MM/YY) <input id="cc-exp" name="cc-exp" autocomplete="cc-exp"></label>
        <label>CVV <input id="cc-csc" name="cvv" autocomplete="cc-csc" inputmode="numeric"></label>
      </div>
    </section>
    <section aria-labelledby="h-review"><h2 id="h-review">3. Review your order</h2>
      <p id="deliver-to">Deliver to: <span class="address"></span>, PIN <span class="pin"></span></p>
      <ul class="checkout-items">${state.cart
        .map(
          (l) =>
            `<li class="checkout-line"><span class="item-title">${esc(product(l.id).title)}${l.colour ? ` (${esc(l.colour)})` : ''}</span> × <span class="item-qty">${l.qty}</span> — <span class="item-price">${rupees(product(l.id).price * l.qty)}</span></li>`,
        )
        .join('')}</ul>
      <p>Items: <span id="checkout-subtotal">${rupees(cartTotal())}</span></p>
      <p>Delivery charge: <span id="checkout-delivery-charge">FREE</span></p>
      <p>Arriving: <span id="checkout-delivery">${longDate(delivery)}</span></p>
      <p>Order total: <strong id="order-total">${rupees(cartTotal())}</strong></p>
      <button type="button" id="place-order">Place your order</button>
      <p id="checkout-error" role="alert"></p>
    </section>`;
  // The review line follows the address fields, as on real checkout pages.
  const deliverTo = () => {
    const v = (id) => document.getElementById(id).value.trim();
    main.querySelector('#deliver-to .address').textContent = [v('fullname'), v('address')]
      .filter(Boolean)
      .join(', ');
    main.querySelector('#deliver-to .pin').textContent = v('pincode');
  };
  deliverTo();
  for (const id of ['fullname', 'address', 'pincode']) {
    document.getElementById(id).addEventListener('input', deliverTo);
  }
  const cardFields = document.getElementById('card-fields');
  for (const r of main.querySelectorAll('input[name="payment"]')) {
    r.addEventListener('change', () => {
      cardFields.hidden = r.value !== 'card' || !r.checked;
    });
  }
  document.getElementById('place-order').addEventListener('click', () => {
    const method = main.querySelector('input[name="payment"]:checked')?.value;
    if (
      method === 'card' &&
      !['cc-number', 'cc-exp', 'cc-csc'].every((id) => document.getElementById(id).value.trim())
    ) {
      document.getElementById('checkout-error').textContent = 'Please enter your card details.';
      return;
    }
    const id = `MS-${state.nextOrder++}`;
    state.orders.unshift({
      id,
      items: state.cart.map((l) => ({
        id: l.id,
        qty: l.qty,
        price: product(l.id).price,
        colour: l.colour,
      })),
      status: 'placed',
      payment: method,
      ordered: isoDay(0),
      expected: delivery,
      delivered: null,
    });
    state.cart = [];
    save(state);
    location.href = `order.html?id=${id}&placed=1`;
  });
}

const STATUS_TEXT = {
  placed: 'Order placed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  return_requested: 'Return requested',
};

function actionsFor(o) {
  if (o.status === 'placed' || o.status === 'shipped') return ['track', 'cancel'];
  if (o.status === 'delivered') return ['return'];
  return [];
}

function orderHtml(o, detail) {
  const total = o.items.reduce((n, i) => n + i.price * i.qty, 0);
  const date = (cls, label, iso) =>
    iso ? `<p class="${cls}">${label}: <time datetime="${iso}">${longDate(iso)}</time></p>` : '';
  const buttons = {
    track: `<a class="button secondary" data-action="track" href="order.html?id=${o.id}#tracking">Track package</a>`,
    cancel: `<a class="button secondary" data-action="cancel" href="order.html?id=${o.id}&do=cancel">Cancel order</a>`,
    return: `<a class="button secondary" data-action="return" href="order.html?id=${o.id}&do=return">Return item</a>`,
  };
  return `
    <article class="order" data-order-id="${o.id}">
      <h2>${detail ? 'Order details' : `<a href="order.html?id=${o.id}">Order ${o.id}</a>`}</h2>
      <p class="order-status" data-status="${o.status}">${STATUS_TEXT[o.status]}</p>
      ${date('order-date', 'Ordered on', o.ordered)}
      ${o.status === 'delivered' || o.status === 'return_requested' ? '' : date('order-expected', 'Arriving', o.expected)}
      ${date('order-delivered', 'Delivered on', o.delivered)}
      <ul>${o.items
        .map(
          (i) => `<li class="order-item">
            <a class="item-title" href="product.html?id=${i.id}">${esc(product(i.id).title)}</a>
            ${i.colour ? `(${esc(i.colour)})` : ''} — Qty: <span class="item-qty">${i.qty}</span> —
            <span class="item-price">${rupees(i.price * i.qty)}</span></li>`,
        )
        .join('')}</ul>
      <p>Order total: <span class="order-total">${rupees(total)}</span></p>
      <div class="row">${actionsFor(o)
        .map((a) => buttons[a])
        .join('')}</div>
    </article>`;
}

function renderOrders() {
  document.querySelector('main').innerHTML = `
    <h1>Your Orders</h1>
    ${state.orders.length ? state.orders.map((o) => orderHtml(o, false)).join('') : '<p>No orders yet.</p>'}`;
}

function renderOrder() {
  const main = document.querySelector('main');
  const o = state.orders.find((x) => x.id === params.get('id'));
  if (!o) {
    main.innerHTML = '<h1>Order not found</h1><a href="orders.html">Your orders</a>';
    return;
  }
  const flow = params.get('do');
  main.innerHTML = `
    ${params.get('placed') ? `<p class="notice" id="order-placed">Order placed, thank you! Arriving ${longDate(o.expected)}.</p>` : ''}
    <h1>Order ${o.id}</h1>
    ${orderHtml(o, true)}
    <section id="tracking" aria-labelledby="h-track"><h2 id="h-track">Tracking</h2>
      <p>${{ placed: 'Preparing for dispatch.', shipped: 'In transit, with the courier.', delivered: 'Delivered.', cancelled: 'Cancelled, nothing will be shipped.', return_requested: 'Pickup scheduled.' }[o.status]}</p>
    </section>
    <div id="flow"></div>`;
  const box = document.getElementById('flow');
  if (flow === 'cancel' && actionsFor(o).includes('cancel')) {
    box.innerHTML = `
      <h2>Cancel this order</h2>
      <label>Reason (optional) <select id="cancel-reason"><option value="">Choose a reason</option><option>Ordered by mistake</option><option>Found a better price</option><option>Delivery is too late</option></select></label>
      <button type="button" id="confirm-cancel">Confirm cancellation</button>
      <p id="flow-error" role="alert"></p>`;
    // As on Amazon, a cancellation reason is optional.
    document.getElementById('confirm-cancel').addEventListener('click', () => {
      o.status = 'cancelled';
      save(state);
      location.href = `order.html?id=${o.id}&done=cancelled`;
    });
  } else if (flow === 'return' && actionsFor(o).includes('return')) {
    box.innerHTML = `
      <h2>Return this item</h2>
      <label>Reason <select id="return-reason"><option value="">Choose a reason</option><option>It arrived damaged</option><option>Wrong item</option><option>Not as described</option><option>No longer needed</option></select></label>
      <p>Pickup from your delivery address on ${longDate(isoDay(2))}. Refund to the original payment method after pickup.</p>
      <button type="button" id="confirm-return">Confirm return</button>
      <p id="flow-error" role="alert"></p>`;
    document.getElementById('confirm-return').addEventListener('click', () => {
      if (!document.getElementById('return-reason').value) {
        document.getElementById('flow-error').textContent = 'Please choose a reason.';
        return;
      }
      o.status = 'return_requested';
      save(state);
      location.href = `order.html?id=${o.id}&done=returned`;
    });
  }
  const done = params.get('done');
  if (done) {
    main.insertAdjacentHTML(
      'afterbegin',
      `<p class="notice" id="flow-done">${done === 'cancelled' ? 'Your order has been cancelled.' : 'Return requested. Pickup is scheduled.'}</p>`,
    );
  }
}

function render() {
  header();
  const page = document.body.dataset.page;
  ({
    search: renderSearch,
    product: renderProduct,
    cart: renderCart,
    checkout: renderCheckout,
    orders: renderOrders,
    order: renderOrder,
  })[page]?.();
  if (params.get('reset') === '1') {
    state = seedState();
    save(state);
    location.replace(location.pathname);
  }
}

render();
