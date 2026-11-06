# E53 Account types and billing

Milestone: standalone (Website). Depends on: E48 (accounts and teams), E52 (admin singleton
settings with sealed secrets), E51 (the RunovaHQ Telegram bot and the notifications hub).

## Goal

Online monitoring (E55) is paid. An Admin defines **account types** in the panel (name, price,
how many online monitors, the shortest interval, how long raw history is kept) and an account
buys one with a card through Stripe Checkout (renews by itself) or with crypto through
NOWPayments (prepaid for 1, 3 or 12 months). An Admin can also give an account a type by hand
with an end date. Every account without a paid type is on Free.

The seeded types:

| Type | Online monitors | Shortest interval | Raw history |
|---|---|---|---|
| Free | 1 | 5 minutes | 7 days |
| Go | 10 | 5 minutes | 30 days |
| Pro | 50 | 1 minute | 90 days |
| Ultra | unlimited | 30 seconds | 365 days |

The rule that shapes everything: a team's projects use the **team owner's** type. A member never
pays for a team, and a team never gets more than its owner bought.

## Design

- **Entitlements.** `Entitlements.ForUserAsync` returns the type of the account's active
  subscription, or the Free type when it has none (or it ran out). `ForScopeAsync` returns it for
  a scope: the account itself for a personal scope, the team's owner for a team scope. E55 asks
  this before it creates, resumes or speeds up an online monitor.
- **Stripe.** Subscription mode Checkout. Saving a paid type creates its Stripe product and
  prices; Stripe prices can not change, so a new price makes a new Stripe price and archives the
  old one. The webhook (`POST /stripe-events`) is checked with the endpoint secret and handles
  `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.paid` and `invoice.payment_failed`. The account manages or cancels in Stripe's portal.
- **NOWPayments.** The account picks a type and 1, 3 or 12 months; the API makes an invoice
  (`/v1/invoice`) with our own order id and the IPN URL and sends the person to the invoice page.
  The IPN (`POST /nowpayments-events`) is checked with HMAC-SHA512 over the key-sorted JSON body
  and the IPN secret (`x-nowpayments-sig`). Only `finished` credits the account, and only when the
  price and currency match our own invoice row. The same type again adds the months to the end
  date; another type starts now, and the days left on the old one are added at the price ratio.
- **Idempotent webhooks.** Every provider event id goes in `ProcessedPaymentEvents` in the same
  save as its effect, so a replay changes nothing.
- **Payment settings.** One row, edited by Admins on `/admin/payment-settings`, in the E52 shape:
  switches, write-only secrets sealed with Data Protection, If-Match, an audit entry that names
  fields and never values.
- **Expiry and reminders.** `SubscriptionExpiryJob` (hourly) ends subscriptions whose period is
  over and asks plan enforcement (E55) to bring the account's monitors within its new limits.
  `RenewalReminderJob` (daily) tells a prepaid account 7 days and 1 day before the end, in the
  app, by email and on Telegram.

## Tasks

- [x] T1 Data: `AccountTypes` (seeded), `Subscriptions`, `Payments`, `ProcessedPaymentEvents`,
  `PaymentSettings` (one row), migration `AccountTypesBilling`.
- [x] T2 `Entitlements` and the proration rule, test-first (unit).
- [x] T3 Public `GET /account-types`, account `GET /accounts/me/subscriptions/current` and
  `GET /accounts/me/payments`.
- [x] T4 Admin `/account-types` CRUD, `GET`/`PATCH /payment-settings`, `GET /payments`,
  `PUT`/`DELETE /users/{id}/subscriptions/current`, all audited.
- [x] T5 Stripe: product and price sync, `POST /accounts/me/checkout-sessions`,
  `POST /accounts/me/billing-portal-sessions`, the webhook, against `FakeStripe`.
- [x] T6 NOWPayments: `POST /accounts/me/crypto-invoices`, the IPN, against `FakeNowPayments`.
- [x] T7 Jobs: `SubscriptionExpiryJob`, `RenewalReminderJob`.
- [x] T8 Contract: `docs/website/api-contract.md` and the OpenAPI snapshot.
- [x] T9 Web admin: `/admin/account-types`, `/admin/payment-settings`, `/admin/payments`, the
  subscription panel on a user's page.
- [x] T10 Web account: `/account/plan` (current type, usage, compare, buy by card or crypto,
  manage, payments) and a public `/pricing` page.
- [x] T11 e2e: an Admin edits a type; an account buys Go through the fake Stripe.
- [ ] T12 Run against Stripe test mode and the NOWPayments sandbox.

## Acceptance criteria

- AC1 With no subscription an account is on Free, and so is one whose subscription ended.
- AC2 A team scope gets its owner's type; a change of owner changes it.
- AC3 A webhook with a bad signature changes nothing and answers 401; a replayed event changes
  nothing.
- AC4 A NOWPayments IPN only credits an account on `finished`, with the amount and currency of our
  own invoice.
- AC5 Secrets are never returned, never in the audit log, and sealed in the database.
- AC6 An Admin can give and take away a type by hand, with an end date, and it shows on the
  account's Plan page at once.
- AC7 Prepaid accounts are reminded 7 days and 1 day before the end, once each.

## Setting it up

- Stripe: in the dashboard, Developers, API keys, copy the secret key and publishable key. Add a
  webhook endpoint `https://runovahq.com/api/v1/stripe-events` with the five events above and copy
  its signing secret. Turn on the customer portal. Paste all three on `/admin/payment-settings`.
- NOWPayments: in the dashboard, Store settings, copy the API key and make an IPN secret. Paste
  both on `/admin/payment-settings`. The IPN URL is set per invoice, so nothing else is needed.

## Implementation notes

- **Paths.** The account's plan is `/accounts/me/subscriptions/current` and an Admin's grant is
  `/users/{id}/subscriptions/current`, since the contract allows only plural nouns (the same shape
  as `/telegram-links/current`).
- **Webhook answers.** A bad signature is 401 `unauthorized`, as the Telegram webhook answers, not
  400. AC3 was written with 400 and changed to match.
- **One subscription at a time.** A partial unique index on `Subscriptions.UserId` (active or past
  due) holds it. Card checkout is refused while the account is on a paid type; crypto is refused on
  top of a card subscription. An Admin's grant replaces a prepaid one and is refused over a card one.
- **Stripe API version.** Stripe.net 53 reads the period end from the subscription item (Stripe's
  2025 API), so our copy takes `items.data[0].current_period_end`. Events are read with
  `throwOnApiVersionMismatch: false`, so an account on another API version still works.
- **Stripe prices** are made the first time a type is bought at a price, not when an Admin saves it,
  so a type can be edited while Stripe is not set up. The amount a price was made with is kept, and
  a new amount makes a new price and archives the old one.
- **Seed.** `Features` is a `string[]`: a `List<string>` seed made EF see a model change on every
  build. Seeded types take ids 1 to 4 and the identity starts at 100.
- **Plan enforcement** is an `IPlanEnforcement` that does nothing yet; online monitors (E55) fill it in.
- **The e2e stack** has a fake Stripe (`Billing__StripeApiBase`) with a hosted checkout page, and
  the spec signs the webhook itself. A webhook from a context with a session cookie needs an
  antiforgery token like any cookie write, so the spec posts it without cookies, as Stripe does.
- **Buy buttons** stay disabled until the plan says how the account can pay; before, a click while
  it loaded did nothing (the e2e found it).

## Known limits

- T12 is open: nothing ran against Stripe test mode or the NOWPayments sandbox yet.
- A NOWPayments payment that arrives short (`partially_paid`) credits nothing and is shown with that
  status in the admin payments list; an Admin settles it by hand with a grant.
- Usage (how many online monitors an account has) comes with E55.
