import { currencyExponent } from '../lib/ids.js';
import type { CheckoutSessionRow, LineItem } from './service.js';

/**
 * The hosted Checkout page.
 *
 * Constraints this file exists to satisfy, all of them checkable by reading:
 *
 *   * self-contained. No scripts, no fonts, no analytics, no third-party
 *     origin of any kind — which is also what makes "the hosted page sends no
 *     referrer containing intent IDs" true by construction: there is nothing
 *     to send a referrer to, and the document declares `no-referrer` anyway
 *     so even the merchant's own cancel link cannot carry one.
 *   * usable without JavaScript. The payment form is a plain POST; the
 *     browser's back button, password managers and page reloads all behave.
 *   * narrow-first. One column, fluid to 320 px, no horizontal scrolling.
 *   * every field labelled, errors announced, because a payment form a
 *     screen reader cannot drive is a payment form that excludes people.
 *
 * Merchant-supplied strings (line item names, descriptions) are cardholder-
 * facing, so they are escaped: a cart named `<img onerror=...>` must render
 * as text, not as markup in a page that asks for a card number.
 */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.5rem 1rem; background: #f6f7f9; color: #1a1f2b;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { width: 100%; max-width: 30rem; margin: 0 auto; }
  header { margin-bottom: 1.25rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .amount-due { font-size: 1rem; color: #5b6472; margin: 0; }
  .panel {
    background: #fff; border: 1px solid #dfe3ea; border-radius: 12px;
    padding: 1.25rem; margin-bottom: 1rem;
  }
  ul.items { list-style: none; margin: 0 0 1rem; padding: 0; }
  ul.items li {
    display: flex; justify-content: space-between; gap: 1rem;
    padding: .5rem 0; border-bottom: 1px solid #eef1f5;
  }
  ul.items li:last-child { border-bottom: 0; }
  .item-desc { display: block; font-size: .875rem; color: #5b6472; }
  .line-amount { white-space: nowrap; }
  .total {
    display: flex; justify-content: space-between; gap: 1rem;
    margin: 0; padding-top: .75rem; border-top: 2px solid #dfe3ea; font-weight: 600;
  }
  .field { margin-bottom: .9rem; }
  .row { display: flex; gap: .75rem; }
  .row .field { flex: 1 1 0; min-width: 0; }
  label { display: block; font-size: .875rem; font-weight: 600; margin-bottom: .3rem; }
  input {
    width: 100%; padding: .65rem .7rem; font-size: 1rem; font-family: inherit;
    border: 1px solid #b6bdc9; border-radius: 8px; background: #fff; color: inherit;
  }
  input:focus-visible, button:focus-visible, a:focus-visible {
    outline: 3px solid #2f6fed; outline-offset: 2px;
  }
  button {
    width: 100%; padding: .8rem 1rem; font-size: 1rem; font-weight: 600;
    color: #fff; background: #1a56db; border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { background: #1746b5; }
  .error {
    background: #fdecec; border: 1px solid #f3b7b7; color: #8a1c1c;
    padding: .7rem .8rem; border-radius: 8px; margin-bottom: 1rem; font-size: .9375rem;
  }
  .cancel { text-align: center; font-size: .9375rem; margin-top: 1rem; }
  .hint { font-size: .8125rem; color: #5b6472; margin-top: .75rem; }
  .test-badge {
    display: inline-block; font-size: .75rem; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: #8a5a00; background: #fff5e0;
    border: 1px solid #f0d9a5; border-radius: 999px; padding: .1rem .55rem; margin-bottom: .5rem;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #12151b; color: #e7eaf0; }
    .panel { background: #1a1f28; border-color: #2b323d; }
    ul.items li, .total { border-color: #2b323d; }
    input { background: #12151b; border-color: #3b4453; }
    .error { background: #3a1a1a; border-color: #6e2c2c; color: #ffc9c9; }
    .test-badge { background: #3a2f14; border-color: #6b5622; color: #ffd98a; }
    .item-desc, .amount-due, .hint { color: #98a2b3; }
  }
`;

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Minor units to a currency amount. The exponent is data (JPY is 0, KWD is 3),
 * so this never assumes "divide by 100" and never invents a decimal place.
 * Locale is fixed for now: per-locale labels and formatting are the
 * localization work tracked in 0002, and a server locale leaking into prices
 * would make rendered totals depend on where the app was deployed.
 */
export function formatAmount(minor: number, currency: string): string {
  const major = minor / 10 ** currencyExponent(currency);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(major);
}

function renderLineItems(items: LineItem[], amount: number, currency: string): string {
  const rows = items
    .map((item) => {
      const desc = item.description
        ? `<span class="item-desc">${esc(item.description)}</span>`
        : '';
      const total = item.quantity * item.unit_amount;
      return `<li>
        <span>${esc(item.name)}${item.quantity > 1 ? ` × ${item.quantity}` : ''}${desc}</span>
        <span class="line-amount">${esc(formatAmount(total, currency))}</span>
      </li>`;
    })
    .join('\n');
  return `<ul class="items">
        ${rows}
      </ul>
      <p class="total"><span>Total</span><span>${esc(formatAmount(amount, currency))}</span></p>`;
}

export type CheckoutPageOptions = {
  session: CheckoutSessionRow;
  merchantName: string;
  /** Customer-facing failure from the previous submission, if any. */
  error?: string;
  /** The intent is awaiting an issuer challenge rather than card details. */
  challenge?: boolean;
  /** True while the account is in test mode, so test cards can be documented. */
  testMode?: boolean;
};

export function renderCheckoutPage(opts: CheckoutPageOptions): string {
  const { session, merchantName } = opts;
  const amount = Number(session.amount);
  const currency = session.currency;
  const payLabel = `Pay ${formatAmount(amount, currency)}`;
  const action = `/checkout/${session.id}/pay`;

  const error = opts.error
    ? `<div class="error" role="alert">${esc(opts.error)}</div>`
    : '';

  let form: string;
  if (opts.challenge) {
    form = `
      <form method="post" action="${esc(action)}">
        <input type="hidden" name="challenge" value="passed">
        <p>Your bank needs to verify this payment before it can be completed.</p>
        <button type="submit">Complete verification</button>
      </form>`;
  } else {
    form = `
      <form method="post" action="${esc(action)}" novalidate>
        <div class="field">
          <label for="card_number">Card number</label>
          <input id="card_number" name="card_number" type="text" inputmode="numeric"
                 autocomplete="cc-number" placeholder="4242 4242 4242 4242"
                 maxlength="19" required>
        </div>
        <div class="row">
          <div class="field">
            <label for="expiry">Expiry (MM/YY)</label>
            <input id="expiry" name="expiry" type="text" inputmode="numeric"
                   autocomplete="cc-exp" placeholder="12/31" maxlength="5" required>
          </div>
          <div class="field">
            <label for="cvc">CVC</label>
            <input id="cvc" name="cvc" type="text" inputmode="numeric"
                   autocomplete="cc-csc" placeholder="123" maxlength="4" required>
          </div>
        </div>
        <button type="submit">${esc(payLabel)}</button>
      </form>`;
  }

  const testBadge = opts.testMode
    ? `<p class="test-badge">Test mode</p>
       <p class="hint">Test cards: 4242 pays, 0002 is declined, 9995 asks for verification.</p>`
    : `<p class="hint">Your card details go to your bank, never to the merchant's site.</p>`;

  const cancel = session.cancel_url
    ? `<p class="cancel"><a href="${esc(session.cancel_url)}">Cancel and return to ${esc(merchantName)}</a></p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pay ${esc(merchantName)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>${esc(merchantName)}</h1>
    <p class="amount-due">${esc(formatAmount(amount, currency))} due</p>
  </header>
  <div class="panel">
    ${renderLineItems(session.line_items, amount, currency)}
    ${error}
    ${form}
    ${testBadge}
  </div>
  ${cancel}
</main>
</body>
</html>`;
}

/**
 * A page for a session that cannot be paid: unknown, expired or canceled.
 * Deliberately carries no cart and no form — an expired session that still
 * rendered card fields would invite a submission we are going to refuse.
 */
export function renderUnavailablePage(opts: { title: string; message: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(opts.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="panel">
    <h1>${esc(opts.title)}</h1>
    <p>${esc(opts.message)}</p>
  </div>
</main>
</body>
</html>`;
}
