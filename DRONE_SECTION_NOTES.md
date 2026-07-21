# DRONE SECTION + FEATURE PACKS — Owner Notes (2026-07-21)

What got built, what it costs you to run (~nothing), and the short list of
business/config steps only YOU can do. Keep this file in the repo.

## The model you chose (2026-07-21)

**One paywall.** The app is free forever — map, GPS tracking, discovery,
buddy trips, ads for everyone. **SkyDog All Access at $2.99/month** unlocks
every specialist pack: Fishing, the new Drone section, and every future pack
automatically. No per-pack purchases. Cheap on purpose — you said you'd
rather have the crowd than the margin.

**Ads are permanent.** Nobody's purchase removes the banner — free and paid
users see the same ads, forever. The code enforces this (there is a test for
it), and no store copy promises ad removal. ⚠️ Your v1.0 App Store submission
still says the $4.99 Fishing Pack "removes ads" — see step 2 below.

## What shipped in this build

1. **Feature-Pack system (the vending machine)** — packs are defined in ONE
   config block (`PACKS_CONFIG` in index.html): id, icon, name, features,
   product id, unlock-code prefix. The store sheet (🎒 fab), paywall, free
   trial, offline unlock codes, and StoreKit purchase/restore are all driven
   from that config. The system supports per-pack products AND one-time
   purchases (the legacy fishing IAP is honored this way) — bundle-only is
   just today's configuration, not a limitation.
2. **Drone section (🚁 fab, gated by All Access)** —
   - FAA UAS Facility Map grid painted on the map: red = 0 ft (no-fly
     without special coordination), orange/yellow = limited ceiling,
     green = up to 400 ft; the number in each cell is the max altitude.
   - FAA Recreational Flyer Fixed Sites as 🛩️ pins.
   - Live conditions HUD: wind speed/direction/gusts + temperature with a
     green/yellow/red launch-safety light (thresholds in `WX_CFG`:
     caution ≥10 mph, danger ≥20 mph sustained or ≥25 mph gusts — tune freely).
   - 🛫 Flight Check: pick altitude + time window → instant "authorization
     required / auto-approvable up to X ft / clear" verdict from the FAA data.
   - Everyone (free users too) gets a subtle 🌡 temperature badge; tapping it
     upsells the Drone pack.
3. **Data sources — all free, keyless, cached & debounced:**
   - FAA UDDS ArcGIS services (airspace grid + fixed sites), cached 24 h,
     fetched only when the map settles, never per-frame. US-only today, but
     isolated behind an `AirspaceSource` interface so other countries can be
     added without touching the UI.
   - Open-Meteo current weather (global), cached 10 min per ~2 km cell.
4. **LAANC seam — architected, NOT faked.** Real authorizations can only be
   issued by an FAA-approved USS (Aloft, Airspace Link…). The app ships a
   clearly-labeled "partner coming soon" placeholder behind a clean
   `LaancProvider` interface; the "is authorization required?" half already
   works from the free FAA data. Nothing is ever sent to the FAA.
5. **Tests: 139/139 passing** (was 101) — packs, drone, LAANC, weather, and
   an "ads stay for everyone" guard are all covered. sw cache → v12.
   Privacy policy updated (Open-Meteo + FAA data disclosure, new purchase
   wording).

## YOUR to-do list (in order)

### 1. App Store Connect — create the subscription
- Products → Subscriptions → create group "SkyDog All Access" → add an
  **auto-renewable subscription**:
  - Product ID: `com.skydog.skygps.allaccess.monthly` (must match exactly —
    it's in `PACKS_CONFIG.bundle.product.ios`)
  - Price: **$2.99/month** (change anytime in ASC; the app shows Apple's
    localized price automatically once loaded)
  - You'll need a subscription display name, a short description, a review
    screenshot (1242×2208 for IAP review), and the standard subscription
    disclosure text in the app description.
- Do this AFTER the v1.0 verdict if you don't want to disturb the current
  review. The new build (v1.2) that contains this code can't sell anything
  until the product exists and is approved.

### 2. Clean up the legacy $4.99 Fishing Pack IAP
- v1.0 (in review now) sells `com.skydog.skygps.fishingpack` with copy that
  says it **removes ads**. From this build onward that's no longer true.
- After v1.0 resolves: edit that IAP's description in ASC to drop the
  "removes ads" promise, and either **remove it from sale** (recommended —
  All Access replaces it) or leave it as a quirky one-time fishing-only
  option. Anyone who already bought it keeps fishing features forever —
  the app honors it on restore automatically.
- If anyone bought it in the window where it removed ads, honor the spirit:
  there will likely be zero such buyers (v1.0 wasn't released yet when this
  changed). If Apple asks, the change is: "feature unlock only, ads
  unchanged for all users."

### 3. Stripe (web version) — one new payment link
- The old links charged $4.99/mo fishing-only and are retired (unwired).
- Create ONE new Stripe payment link at **$2.99/month** named "SkyDog All
  Access", then paste its URL into `PACKS_CONFIG.bundle.web.stripeUrl` in
  index.html. Optional: a discounted annual link → `stripeUrlAnnual` +
  `annualLabel`.
- Web unlock codes now use prefix **SKY-** (e.g. hand out `SKY-AA2A` style
  codes; same checksum as the old FISH codes — old FISH codes still work
  and unlock fishing). Put the SKY code on the Stripe confirmation page.

### 4. LAANC provider partnership (later, when drone users show up)
- To make "Request Authorization" real, sign up with an FAA-approved USS
  with an API — **Aloft** (aloft.ai) and **Airspace Link** (airspacelink.com)
  are the usual suspects. Their API keys drop into a real `LaancProvider`
  implementation; UI is already done.
- **PRICE IT SEPARATELY.** Providers may charge per request or a platform
  fee. Do NOT fold unlimited authorizations into the flat $2.99 — sell
  authorization as its own capability (per-request fee or a higher tier)
  so provider costs are always covered. The entitlement system supports
  adding it as its own product when the time comes.

### 5. How to add the next pack (Hunting, Snowboard, whatever)
1. Add a definition in `PACKS_CONFIG.packs` (id, icon, name, tagline,
   features, `storeKey:'sd-<id>pack'`, `web:{codePrefix:'HUNT'}`,
   `sellable:false` while bundle-only).
2. Build the feature module gated by `Entitlements.isUnlocked('<id>')` and
   register `PACK_ACTIVATE['<id>'] = () => …switch it on…`.
3. Done — it appears in the store sheet and is covered by All Access
   automatically. (If you ever want to sell it separately: `sellable:true`,
   give it a `product:{ios:'…', type:'subs'|'inapp'}`, create that product
   in ASC.)
4. Add tests + bump the sw.js cache version, run
   `SD_APP_DIR=<app dir> node tests/test.js` → must be 100%.

## Release path for this code
This build is on top of the buddy-system work (branch `feature-packs`).
Ship order stays: v1.0 verdict → merge & verify buddy (v1.1) → then this
lands as **v1.2** with the App Store products from steps 1–2 in place.
Never patch the v1.0 build.
