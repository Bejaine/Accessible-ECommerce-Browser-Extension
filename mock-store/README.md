# mock-store/ (Track B) — "MockMart"

A small fake shop for the backup demo and for tests. Full checkout, cancel and return flows
are only ever demonstrated here, never on a real account (docs/safety.md). All products,
prices and orders are synthetic; state lives in the browser's localStorage.

## Run it

    python3 -m http.server 8080 -d mock-store

Open http://localhost:8080/ with the extension loaded. `?reset=1` on any page restores the
seed state (empty cart, one delivered and one shipped order).

## Pages (`<body data-page>`)

| Page | What it has |
|---|---|
| `index.html?q=` | search results (all products when empty) |
| `product.html?id=` | JSON-LD Product, price/MRP, stock, delivery, seller, colour swatches, quantity, Add to Cart, Buy Now, specs table, reviews |
| `cart.html` | quantity selects, delete, subtotal, Proceed to checkout |
| `checkout.html` | address with PIN code, payment (UPI / COD / card — card fields are a secure zone), order review, **Place your order** |
| `orders.html` | order list with Track / Cancel / Return |
| `order.html?id=` | order detail, tracking, cancel flow (`&do=cancel`), return flow (`&do=return`); both need a reason |

Products: `zx-buds-air` (3 colours), `zx-pulse-5g`, `kk-cooker-5l` (low stock), `zx-fit-band-2`
(out of stock), `nx-charger-33w`. Seed orders: `MS-1001` delivered (returnable), `MS-1002`
shipped (cancellable); new orders get `MS-1003`, `MS-1004`…

The extension recognises the store by `<meta name="asl-mock-store">` on localhost
(`extension/src/extract/adapters/mockstore.ts`). `extension/tests/mockstore.test.ts` runs every
page and the add-to-cart → checkout → place-order, cancel and return flows end to end.
