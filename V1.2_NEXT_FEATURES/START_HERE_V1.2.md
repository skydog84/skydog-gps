# 🗻 SkyDog GPS v1.2 — "The 3D Update" · Command Center

**This folder is the home base for the next version.** Every new v1.2 feature gets
planned, tracked and handed off from here. The CODE does not live here — it lives one
level up in `~/Projects/skydog-gps-deploy` (this folder's parent), which is the ONE
true copy. Never make a second copy of the app; that's how the stale ACCOS mirror
happened.

---

## To start a new work session (copy-paste this into a new chat)

> Read `~/Projects/skydog-gps-deploy/V1.2_NEXT_FEATURES/START_HERE_V1.2.md` and
> `~/Projects/skydog-gps-deploy/HANDOFF_20260801_NIGHT_3D_TERRAIN.md`, then pick up
> from there. God mode is on.

Then say which feature from `FEATURE_LIST.md` you want built (or describe a new one).

---

## What v1.2 is

The version AFTER the one currently waiting at Apple (v1.1). Headline: **3D Terrain**
— already built, tested (290/290) and live on skydoggps.com. More features land on
top before it ships to the App Store.

| Where | Status |
|---|---|
| Web (skydoggps.com) | ✅ v1.2 live now — ships instantly on every git push |
| Apple App Store | ⏳ waits for the v1.1 verdict, then v1.2 gets built & submitted |
| Google Play | ⏳ signed AAB (with 3D) ready; blocked on identity verification |

## The rules for every new feature (non-negotiable)

1. **One paywall.** New specialist features go in as packs inside All Access
   ($2.99/mo). Free core stays free. Ads stay for everyone.
2. **Add-a-pack recipe** (5 minutes of wiring, proven 4×): definition in
   `PACKS_CONFIG` → feature module gated by `Entitlements.isUnlocked('<id>')` →
   `PACK_ACTIVATE['<id>']` hook. Wheel button, store card, paywall, codes and
   StoreKit all appear automatically. Details: `../DRONE_SECTION_NOTES.md` §5.
3. **Single file, no libraries, no keys with bills attached.** index.html only;
   free/keyless data sources; CSP updated + tested for any new host.
4. **Tests 100% before ANY push** (the suite lives in `../tests/test.js`, runs in
   the cloud container, currently 290/290). Any index.html change = bump sw.js
   version AND its pin test together (next free number: **v28** — but the AdMob
   patch also claims v28; whoever bumps first, renumber the other).
5. **Never touch the version sitting in Apple review.**

## What's in this folder

- `START_HERE_V1.2.md` — this file.
- `FEATURE_LIST.md` — the running feature board: what shipped, what's next.
  **Add ideas there** (or voice-dump them into a chat and have it update the file).

## Where everything else is (the findable map)

| Thing | Where |
|---|---|
| The app (one true copy) | `../index.html` (+ `../sw.js`, `../tests/test.js`) |
| 3D Terrain handoff (latest work) | `../HANDOFF_20260801_NIGHT_3D_TERRAIN.md` |
| Google Play launch state | `../HANDOFF_20260801_NIGHT_DEVICE_CLEARED.md` |
| Pack system / pricing decisions | `../HANDOFF_2026-07-21_FEATURE_PACKS.md`, `../DRONE_SECTION_NOTES.md` |
| Owner report PDFs | `../SkyDog_GPS_*.pdf` (latest: 3D Terrain Report 2026-08-01) |
| PDF report template (do not redesign) | `../SKYDOG_PDF_REPORT_TEMPLATE.py` |
| Feature brainstorm from earlier chat | `../SKYDOG_FEATURE_BRAINSTORM_2026-08-01.md` |
| Android release bundle | `../android/app/build/outputs/bundle/release/app-release.aab` |
| If the Mac ever dies | `../SKYDOG_RECOVERY_CARD.md` |
