# SkyDog GPS API Worker — Fort SkyDog Phase B

One small Cloudflare Worker (free tier is plenty to start) that holds the
secrets a client-side app can never hold: the paid Regrid token and the
private key that mints unlock codes. The app itself stays a single free
offline-friendly file — this Worker only comes into play for Property
Lines (paid plan) and paid All Access codes.

Nothing in this folder contains a secret. All four secrets are pasted
into Cloudflare only.

## One-time setup (you, in a browser — ~15 minutes)

1. Create a free account at dash.cloudflare.com (use skydog8426@gmail.com).
2. On your Mac: `cd worker && npx wrangler login && npx wrangler deploy`.
3. In the dashboard (Workers → skydog-api → Settings → Variables) add the
   four **secrets**:
   - `REGRID_TOKEN` — the paid Regrid API token (from app.regrid.com → API)
   - `STRIPE_SECRET` — your Stripe secret API key (Stripe dashboard → Developers → API keys)
   - `STRIPE_WEBHOOK_SECRET` — the webhook signing secret (created in step 6)
   - `SIGNING_KEY` — run `node worker/generate-keys.mjs` on your Mac; it
     prints a PRIVATE key (this secret) and a PUBLIC key (paste into
     index.html → `SkySigned.pubkey`). The script saves nothing to disk.
4. Add the custom domain: Workers → skydog-api → Settings → Domains &
   Routes → add `api.skydoggps.com` (the app's CSP already allows it).
5. Stripe: create the $2.99/mo All Access payment link and set its
   confirmation page to
   `https://api.skydoggps.com/code/claim?session_id={CHECKOUT_SESSION_ID}`
   — the buyer lands on a page showing their signed unlock code. Paste
   the payment link into index.html → `PACKS_CONFIG.bundle.web.stripeUrl`.
6. Stripe → Developers → Webhooks → add endpoint
   `https://api.skydoggps.com/stripe/webhook` (event: checkout.session.completed),
   copy its signing secret into the `STRIPE_WEBHOOK_SECRET` Worker secret.

## Flipping on the Regrid proxy (when the paid plan activates)

In index.html set `REGRID.proxy = 'https://api.skydoggps.com'` and DELETE
the `token:` line. The test suite enforces that token and proxy are never
both set. Tiles are edge-cached by the Worker for 24h, so repeat map
views cost zero Regrid quota.

## What each route does

| Route | Job | Protection |
|---|---|---|
| `/parcel/point?lat&lon` | owner/acreage lookup | Origin check, 30/hr per IP |
| `/parcel/tiles/z/x/y.png` | boundary tiles | Origin/Referer check, 4000/hr per IP, 24h edge cache |
| `/code/claim?session_id=` | mints a signed All Access code after paid checkout; reopening the link re-mints while the subscription is active | Stripe session verified server-side, 30/hr per IP |
| `/stripe/webhook` | green checks in Stripe's dashboard | HMAC signature verified |
| `/health` | uptime ping | — |

## Phase B3 — once the Worker exists

- Firebase console → App Check → enable reCAPTCHA v3 for the web app and
  DeviceCheck for iOS, then enforce on Realtime Database (buddy trips).
- Firebase console → Usage and billing → set budget alerts.
- Stripe Radar stays on its defaults (it's on automatically).

## Monitoring habit (weekly, 5 minutes — Phase C)

- Regrid dashboard: quota used vs. plan.
- Cloudflare Worker analytics: request counts, 429 rate (spikes = someone
  probing; the rate limit is doing its job).
- Firebase usage graphs vs. its budget alert.
- App Store Connect: sales vs. any "I paid and it's locked" complaints.

## If a secret ever leaks

- Regrid token: revoke + reissue at app.regrid.com, update the Worker secret.
- Stripe keys: roll them in the Stripe dashboard, update the Worker secret.
- SIGNING_KEY: run generate-keys.mjs again, update the Worker secret AND
  `SkySigned.pubkey` in index.html; old codes die at their expiry month.

## ⏳ Overdue auto-email (Run 2, 2026-08-01)

The Worker now also runs the Back-by timer's phase-2 safety net:

- `POST /overdue/register` — the app registers {plan, back-by, contact
  emails, coarse fix} ONLY after the user flips the auto-email switch.
- `POST /overdue/checkin` — a live phone pings near its deadline.
- `POST /overdue/cancel` — "I'm back safe" deletes the record.
- cron `*/10 * * * *` — overdue + silent (+10-min grace) → email the
  contacts once. Records self-destruct via KV TTL (≤72 h).

KV namespace: binding `OD` (created 2026-08-01). Email ships via
**Resend** (MailChannels killed their free Workers API mid-2024):

1. Create a free Resend account (resend.com — 100 emails/day free).
2. Verify the domain `skydogai.com` (it's already on this Cloudflare
   account — Resend shows the DNS records to add; add them in the
   Cloudflare DNS dashboard for skydogai.com).
3. `npx wrangler secret put RESEND_KEY` — paste the API key.
4. Optional: `npx wrangler secret put MAIL_FROM` to override the default
   `SkyDog GPS Safety <alerts@skydogai.com>`.

Until RESEND_KEY is set the endpoints all work (register/checkin/cancel)
but the cron quietly skips sending — the phone-side alarm + SMS flow is
untouched either way.
