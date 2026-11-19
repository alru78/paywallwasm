Put a link behind a Lightning paywall. Visitors see a title, a description and
the price, pay a Lightning invoice without needing an account, and the link is
revealed once the payment settles.

- Price in sats or in a fiat currency (paid in sats)
- The protected link is never part of the public page before payment
- Payments are verified by LNbits itself, so a copied or forged invoice
  does not unlock anything
- See the payments for each paywall
- Optionally remember the unlock for the visitor's browser session

This is a port of the Paywall extension to the sandboxed WASM extension
runtime: it only gets the permissions you approve when installing it.
File downloads and fiat payment providers from the original extension are not
supported.
