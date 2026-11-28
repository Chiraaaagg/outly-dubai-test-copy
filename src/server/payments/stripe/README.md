# Stripe adapter

`StripeGateway` implements the `PaymentGateway` port (`../contracts.ts`) with
Stripe hosted Checkout, card only, manual capture. One Stripe account (UAE)
and one webhook endpoint serve every configured rail (doc 22 §32.11).

## Configuration

Stripe is off unless `PAYMENTS_STRIPE` is set. Variables (names only; never
commit values):

| Variable | Meaning |
|---|---|
| `PAYMENTS_STRIPE` | `off` (default), `test` or `live` |
| `STRIPE_SECRET_KEY` | `sk_test_`/`rk_test_` for `test`; `sk_live_`/`rk_live_` for `live` (and only with `APP_ENV=production`) |
| `STRIPE_WEBHOOK_SECRET` | the endpoint's `whsec_` signing secret |
| `STRIPE_ACCOUNT_ID` | the `acct_` id the key must answer for |
| `STRIPE_RAILS` | comma list of `aed_card`, `inr_pacb`; default `aed_card` |

Any problem (see `stripe.config.ts`) means no Stripe gateway at all, and
`assertBootEnv` lists it. A `NEXT_PUBLIC_*STRIPE*SECRET*` variable refuses
Stripe. Hosted Checkout needs no publishable key, so none is declared.

Local test-mode keys go in `.env.stripe.test.local` at the repository root.
It is ignored by git through `.env*.local`. Do not create or commit it from
code, and never paste its contents into chat, logs or docs.

A restricted key (`rk_`) needs read access to the account (`GET /v1/account`,
used once per process to check `STRIPE_ACCOUNT_ID`) and write access to
Checkout Sessions, PaymentIntents and Refunds.

## Webhook endpoint

`/api/webhooks/payments/stripe`, subscribed to:

- `checkout.session.completed`, `checkout.session.expired`
- `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`,
  `payment_intent.canceled`, `payment_intent.payment_failed`
- `charge.refund.updated`, `refund.created`, `refund.updated`, `refund.failed`
- `charge.dispute.*` (reported to the saga as `dispute.*`)

Events only name the payment; the saga re-reads it with `getPayment`.

## Session expiry

Stripe Checkout sessions live 30 minutes to 24 hours; a quote lives 10
minutes. `createSession` asks for at least 31 minutes and reports Stripe's
real expiry; once the quote lapses the saga calls `expireSession`
(`POST /v1/checkout/sessions/:id/expire`). A payment that still lands is
late: a held card is voided, captured money refunded.
