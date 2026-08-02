# 🚀 LAUNCH DAY CHECKLIST — what to do the hour Google says yes
# Written 2026-08-02. Order matters; each step unlocks the next.
# Nothing here needs a decision — the decisions are already made.

## ⛔ READ FIRST — the one thing that is NOT ready

**The $44.99/yr annual plan cannot be purchased by anyone right now.**
The app *advertises* it (paywall copy, legal pages, Play listing line 79),
but there is no code path to buy it:

- `PACKS_CONFIG.bundle.product` holds ONE product: `...allaccess.monthly`
- `SkyGPSStore.products()` therefore only ever offers the monthly
- iOS: `#paysubyr` is force-hidden (index.html ~8317) and its click handler
  is a deliberate no-op (~8332)
- Web: `stripeUrlAnnual` is `null`, so the button stays `display:none`
- The suite passes because it pins the price *strings*, not a purchase path

Consequence: creating `com.skydog.skygps.allaccess.annual` in App Store
Connect today buys you nothing — the app cannot sell it, and the product ID
is permanent once created. Either wire it first, or create it only when the
next binary that can actually sell it is ready to submit.

---

## STAGE 1 — Google approves identity (the email arrives)

1. Play Console → complete **phone verification**. Code goes to
   **+1 231-590-1998** (the number ON FILE — not the 5818 in old handoffs).
2. Confirm the developer account is fully active before touching anything else.

## STAGE 2 — Build the Android bundle

3. Apply `ADMOB_ANDROID_PATCH.md` FIRST if it hasn't been applied — the
   Android AdMob App ID must be in `AndroidManifest.xml` or the app
   **crashes on launch**. The ad *gate* is already built; do not add a second one.
4. `npm run check:sync` — must print "built copies match root index.html".
5. `npm run android:build` → the AAB lands at
   `android/app/build/outputs/bundle/release/`
6. Signing keys live in `skydog-keys/` (gitignored — never commit them).

## STAGE 3 — Create the Play listing (none exists yet)

7. Listing copy is written and current: **`SkyDog_GPS_Play_Listing.txt`**.
   It already states $4.99/mo, the annual, ad removal, and free full-crew
   Party Mode. Paste it as-is.
8. IAP products to create: `com.skydog.skygps.allaccess.monthly` — **$4.99/month**.
   Add the annual ONLY if the read-first section above has been resolved.
9. Data safety form, content rating, target audience, privacy policy URL
   (https://skydoggps.com/privacy-policy.html — already live).

## STAGE 4 — Internal testing → the 14-day clock

10. Create the **closed/internal testing** track and upload the AAB.
11. Add all 12+ tester Gmail addresses to the tester list.
12. Copy the **opt-in link** and send it out using text #5 in
    `SkyDog_Tester_Texts.txt`.
13. **Write down the date the 12th person opts in.** That is day 1 of 14.
    Put it in the tester tracker artifact.
14. Day 7: send the check-in text. It costs one message and protects
    two weeks of waiting.
15. Nobody uninstalls. Drop below 12 at any point and the clock restarts at zero.

## STAGE 5 — Production

16. After 14 unbroken days, promote to production and submit for review.
17. Send the all-clear text (#7) — those twelve people are the reason it shipped.

---

## PARALLEL TRACK — Apple (independent of everything above)

- Raise `com.skydog.skygps.allaccess.monthly` $2.99 → **$4.99**, and choose
  **preserve existing subscribers' price**. Price changes do NOT require a
  new binary or a new review.
- Free trial: **30 days if offered, never under 14.** Each customer gets ONE
  introductory offer per subscription group, ever — this setting is the one
  that can't be redone.
- Check whether v1.1 is still "Waiting for Review" before touching the
  submission; price edits are independent of the binary.
- ⚠️ Legacy one-time Fishing Pack was ALSO $4.99. Every price string must say
  "per month" or "per year" so nobody thinks a one-time purchase went recurring.
- ASC text fields reject emoji; React dropdowns ignore form_input — use the
  native setter + dispatch input/change events.

## PARALLEL TRACK — Stripe (web sales)

- Create $4.99/mo and $44.99/yr payment links.
- Paste into `PACKS_CONFIG.bundle.web.stripeUrl` / `.stripeUrlAnnual`.
  `annualLabel` is already written; the annual button un-hides itself the
  moment `stripeUrlAnnual` is non-null. **On web the annual DOES work** once
  the link exists — it's only the iOS path that needs wiring.

---

## DEFERRED BY DECISION (do not revisit unprompted)

- **Regrid property lines — activate at 1,000 subscribers.** Owner decision
  2026-08-02. At 1,000 × $4.99 the $375/mo is ~7% of revenue instead of the
  whole thing. ⚠️ Before Aug 23, confirm that letting it lapse does NOT
  auto-charge a card on file — "do nothing" must mean expire, not bill.
- **what3words** — seam is built and waiting on a key.
