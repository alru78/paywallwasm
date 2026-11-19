# Paywall (WASM)

An LNbits WASM extension that unlocks a link after a Lightning payment. It is a
port of the [Paywall](https://github.com/lnbits/paywall) extension to the LNbits
WASM extension runtime.

## What it does

- You create a paywall: a title, a description, a price in sats or a fiat
  currency, the wallet that receives payments, and the link to unlock.
- Visitors open the public page, see the title, description and price, and pay
  a Lightning invoice. They do not need an LNbits account.
- Once the payment settles, the page reveals the link. The link is never part of
  the public page or of any response before the payment.
- You can see the payments for each paywall.

## Developer support (optional, off by default)

Each paywall has a "Support the developer" option. It is off unless you tick it.
When it is on:

- 1% of each payment to that paywall is collected for the wallet that received it.
- Once at least 21 sats have built up, they are sent from that wallet to
  `alru@ruxit.tech` in one Lightning payment (at most 1000 sats per payout).
  Batching keeps routing fees from eating single-sat payments.
- Payouts need your approval: LNbits asks you to allow background payments
  from that wallet (up to 1000 sats each, external destinations allowed).
  Without that approval nothing is sent; the amount stays collected and the
  management page shows why the payout failed.
- The management page shows, per wallet, what has been collected, what has been
  sent and the last error. Untick the option to stop collecting for a paywall.

## Differences from the Python Paywall extension

| Python Paywall | This extension |
| --- | --- |
| URL paywalls | Supported |
| File download paywalls (streams a file with secret headers) | Not supported: WASM extensions return JSON only, without streaming or response headers |
| Fiat payments through a fiat provider (Stripe) | Not supported by the WASM invoice API; fiat prices are converted and paid in sats |
| "Remember" stores the unlock in the browser | Remembers the unlock for the visitor's browser session only (the sandboxed page has no persistent storage) |
| Pay-to-install `pay_link` endpoint | Not provided |

## How payments are verified

- Invoices are created with `wallet.create_invoice_public` for the paywall row,
  so the visitor cannot choose the wallet or the price. Amounts below the price
  are rejected.
- The paywall is unlocked only by the `onInvoicePaid` event. LNbits dispatches it
  only for invoices this extension created for that paywall and owner, so an
  ordinary invoice that copies the extension's metadata does not unlock anything.
- The unlock record is keyed by the payment hash, so repeated events are
  recorded once. A payment for one paywall does not unlock another.
- The visitor proves the purchase with the payment hash of the paid invoice.
  Anyone who learns that hash can also see the link, as with the original
  extension.

## Permissions

| Permission | Why |
| --- | --- |
| `ext.storage.read`, `ext.storage.write` | Store paywalls and paid unlocks |
| `ext.storage.read_public` | Show title, description and price on the public page (not the link or wallet) |
| `wallet.create_invoice_public` | Create invoices into the wallet chosen for the paywall |
| `wallet.list` | Let you pick the receiving wallet |
| `utils.basic` | List currencies and convert fiat prices |
| `wallet.pay_invoice_background` | Only for the optional developer support payouts; also needs your per-wallet approval |

## Development

Requirements: Node.js 20 or newer.

```sh
cd dev
npm test            # unit tests against an in-memory LNbits host
npm run build:wasm  # rebuild wasm/module.wasm with jco
./scripts/package.sh  # build dist/paywallwasm.zip for installation
```

Rebuild `wasm/module.wasm` after every change in `dev/src/`. Browser code lives in
`static/` and `ui/` and needs no build step.

Requires LNbits 1.7.1 or newer.

## License

MIT, like the original Paywall extension.

The icon (`static/assets/icon.png`, source `assets/icon.svg`) uses lettering
converted from the Rubik Wet Paint font, licensed under the SIL Open Font
License 1.1 (`assets/OFL-RubikWetPaint.txt`).
