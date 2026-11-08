# Bracket

Bracket is a finance planner that runs in the browser. Pay, tax, spending, and career tools stay on the device. This repository adds username accounts and a Stripe monthly subscription without locking those offline tools.

The original app notes are in [README.txt](README.txt).

## What is included

- The original single-file app, icons, manifest, and service worker.
- Firebase email/password remains the identity system. Usernames are claimed on the server.
- Stripe Checkout for one subscription: **USD 9.99 per month** in the United States and **CAD 9.99 per month** in Canada. The country is chosen in the account screen, and the currency is shown before checkout. There is no trial.
- Stripe Customer Portal for cancellation and payment-method updates.
- Signature-checked webhooks. A successful return from Checkout does not grant access.
- Firestore rules that let a person read and write only the encrypted plan fields, and never billing or entitlement fields.

## Product decision still open

No paid feature was specified. **Offline tools are not gated and the server rejects any attempt to list them as paid features.** The only online feature that can be gated is account sync, and it is off until you set it:

```bash
PAID_FEATURES=sync
```

Leave `PAID_FEATURES` empty to keep today's behavior: sync follows the Firebase setup and does not require a subscription. The in-app subscription screen says when nothing is gated. The browser cannot turn a subscription on for itself; Firestore rules and the webhook handler are the source of truth.

## Icon check

The three PNG files from the original bundle were not edited. Pixel samples:

- `icon-192.png` and `icon-512.png` have transparent corners (regular icons).
- `icon-maskable-512.png` is opaque to the edges (maskable).

`manifest.webmanifest` already points the maskable purpose at `icon-maskable-512.png` and the regular icons at the other two files. Nothing was swapped.

## Stripe Tax

Automatic tax is **not** enabled. No active tax registrations were supplied. Stripe would collect no tax, and would not return an error, until a registration is active. See [Collect taxes for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes.md) before turning tax on. Do not pass `automatic_tax` until that is confirmed.

## Access rules

Paid access is stored in `entitlements/{uid}` and is written only by the Admin SDK.

| Stripe state | Access |
| --- | --- |
| Checkout completed or async payment succeeded, `payment_status=paid`, subscription `active`, price on the server allowlist | Paid until the period ends, plus `PAID_BUFFER_HOURS` (default 1) so a late renewal webhook does not lock someone out |
| `past_due` | Grace for `GRACE_DAYS` (default 3) from the first failure. Later failures do not extend it |
| `cancel_at_period_end` while still `active` | Paid through the current period |
| `trialing` | No access. Trials are not offered |
| `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, `paused` | No access |
| Full refund, open dispute, or early fraud warning | Access removed until a won dispute clears it |
| Price id or amount other than the allowlisted 9.99 monthly price | No access |
| Return URL from Checkout, including `session_id` | No access. The page only polls the server |

Username documents do not store email addresses. Login and password reset use the same response for a missing username and a wrong password, so a username cannot be turned into an email. Email/password sign-in still works through Firebase for accounts created that way.

Deleting an account releases the username. If a Stripe subscription exists, the server asks Stripe to cancel at period end. Cancel in the billing portal first if you need a receipt before the login is removed.

## Local checks vs live services

Automated tests use the Firebase Auth and Firestore emulators and an in-process Stripe mock. Webhook signatures use the Stripe SDK locally. **Those tests do not call Stripe or Google, and they are not proof that live sign-in or live payments work.**

Live sign-in and live payments are blocked until the setup below is filled in. No Stripe sandbox was created here, and the Stripe connector is not authenticated.

## Set up

1. Use an [isolated Stripe sandbox](https://docs.stripe.com/sandboxes.md) for this project. Do not share the account's test mode with other work.
2. Create one Product named Bracket. Add two monthly Prices on that same product: **USD 9.99** and **CAD 9.99**. Copy the price ids.
3. Create a [restricted API key](https://docs.stripe.com/keys.md#manage-your-api-keys) (`rk_`) with Customers write, Checkout Sessions write, Customer Portal write, Prices read, Subscriptions read, and Charges read. Put it in a secrets manager. The server reads `STRIPE_SECRET_KEY` from the environment.
4. `stripe listen --forward-to localhost:8787/api/stripe/webhook` gives `STRIPE_WEBHOOK_SECRET` for local work. In the sandbox, subscribe the endpoint to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.closed`
   - `radar.early_fraud_warning.created`
5. Allowlist [Stripe's webhook IP addresses](https://docs.stripe.com/ips.md) on the deployed endpoint. Signature verification is always required. Set `ENFORCE_STRIPE_WEBHOOK_IPS=1` and `STRIPE_WEBHOOK_IPS` only when the app sees Stripe's addresses directly.
6. The public web config for project `bracket-2b961` is already in [config.js](config.js). Copy that `apiKey` into `FIREBASE_WEB_API_KEY`. Jon reports Email/Password is enabled. This repo has not called Firebase to confirm that, and it has not created any account there.
7. On Cloud Run the server uses the attached runtime service account (`K_SERVICE`). Do not download a service-account JSON for that. A local machine still needs the Auth and Firestore emulators, or `GOOGLE_APPLICATION_CREDENTIALS` / `FIREBASE_SERVICE_ACCOUNT_JSON` kept outside the repo. Publish [firestore.rules](firestore.rules) in the Firebase console. That publish is a console action and has not been done from here.
8. Copy [.env.example](.env.example) to `.env` and fill the placeholders. `.env` is gitignored.
9. In the Stripe sandbox, save a Customer Portal configuration so the manage-billing button can open.
10. `npm install` then `npm start`. The server listens on `PORT` (default 8787) and serves the app and the API on one origin.
11. Optional: `git config core.hooksPath .githooks` so commits run `scripts/check-secrets.mjs`.

`config.js` is public. It must not contain the restricted key, the webhook secret, or the Admin credential.

API version pinned in code: `2026-10-28.endive` (current Checkout reference; the Stripe skill's earlier Endive date was `2026-09-30.endive`). Node SDK: `stripe@23.1.0`. Checkout does not send `payment_method_types` or `automatic_tax`. Each Checkout Session sets `integration_identifier` to `bracket_checkout_` plus 8 random letters.

## Tests

```bash
npm test
npm run test:emulator
```

`npm test` runs the local suites. The Firebase suite skips unless `FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST` are set. `npm run test:emulator` starts the Auth and Firestore emulators and runs every test inside them. Java is required for the emulators.

## Firebase web app

[config.js](config.js) contains the public web config for `bracket-2b961`: `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, and `appId`. The Firebase snippet also included `measurementId`. It is not in `config.js`, and the app does not load Analytics.

Before sign-in or password reset will work from a browser:

- Authentication → Settings → Authorized domains must include every origin that serves Bracket. `localhost` and `bracket-2b961.firebaseapp.com` are the usual defaults. Add the real site domain before using it. This list was not read or changed from here.
- If the web API key has HTTP referrer restrictions in Google Cloud, add the same origins.
- Firestore must exist in Native mode and [firestore.rules](firestore.rules) must be published. Not done from here.
- Cloud Run initializes Firebase Admin from its runtime service account. Set `FIREBASE_WEB_API_KEY` to the public `apiKey`. A downloaded service-account JSON is not used there. The web API key must allow the Identity Toolkit API from the server, not only from browser referrers.

No live Firebase Auth account was created or modified.

## Blockers for real end-to-end validation

- Email/Password and the registered web app are reported by Jon. They were not verified by a live sign-in, token check, or Firestore read.
- No Firebase Admin credential was provided, so username reservation, account deletion, and webhook entitlement writes cannot run against `bracket-2b961`.
- Authorized domains, API key referrer restrictions, and published Firestore rules were not confirmed.
- The Stripe connector is not authenticated. No sandbox, restricted key, price ids, or webhook secret were provided, and none were minted.
- Customer Portal configuration and tax registrations are not set. Automatic tax stays off.
- The app was not deployed. Webhooks have nowhere public to land.

Until those exist, do not treat sign-in or payments as working on Stripe or Firebase.
