# 🏔 ORV TRAILS + 🎡 MODE WHEEL + 📍 MY SPOTS — Owner Notes (2026-07-22)

Web v1.3. Plain English: what shipped, how to turn it on, and exactly where
YOU add trails, pit stops, loading zones and landing zones. Keep in the repo.

## What shipped in this build

1. **🏔 ORV Trails pack** (gated by All Access, like Fishing & Drone) —
   "Trail Mode." Turn it on and the map paints Michigan's live DNR trail
   network: **magenta = snowmobile** (season Dec 1 – Mar 31), **orange =
   ORV/ATV**, **blue = motorcycle**. Closed trails go **gray & dashed**;
   DNR temporary closures paint **red & dashed on top**. Your own rider
   intel shows as pins: ⛽ pit stops, 🛻 loading zones, 🅿️ landing zones.
   Every layer has its own on/off chip at the top of the screen. Tap any
   trail or pin for a popup (name, type, open/closed, notes).
   Data is FREE and keyless (Michigan DNR public map servers), fetched only
   when the map sits still, cached 24 h, and never below zoom 9 — $0 to run.
2. **🎡 Mode Wheel** (free for everyone) — all the mode buttons now live on
   a wheel in the bottom-right thumb corner: flick to spin (it snaps firmly
   between buttons, roulette-style, endless loop), the front button is
   enlarged and glove-friendly, tap to enter/exit. Locked packs wear a 🔒
   and tap through to the paysheet. Future packs added to `PACKS_CONFIG`
   appear on the wheel automatically. Utility buttons (map style, locate,
   saved, key, ❓, 🧹) stay outside the wheel — always one tap.
3. **📍 My Spots** (free for everyone) — the ➕ button on the wheel. Pin
   your current GPS spot or tap the map to place; name it, pick an icon,
   add notes. Spots live ONLY on the phone (no account, no cloud), show as
   their own toggleable layer, and tap-to-edit/delete.
4. Tests **182/182** (was 139). sw cache → **v13**. Privacy policy gained
   the Michigan DNR + My Spots disclosures.

## How to turn ORV Trails on (as a user)

Spin the wheel to 🏔 and tap it. If All Access isn't active you'll see the
paywall — subscribe, redeem an `ORV-XXXX` code (same checksum family as
FISH/SKY/DRONE codes), or take the one-day free trial. Zoom to at least
level 9 (roughly county scale) and the trails stream in as you pan.

## WHERE YOU EDIT YOUR DATA (the important part)

Open **`index.html`** and search for **`OWNER-EDITED DATA — ORV_POINTS`**.
You'll find a block like this:

    const ORV_POINTS = [
      { cat:'pit',  name:'EXAMPLE — replace me: Gas & Grub', lat:44.7631, lng:-85.6206, notes:'…' },
      ...
    ];

**One line per stop.** Fields:

| field | what it is |
|-------|------------|
| `cat` | `'pit'` (⛽ gas/food/rest) · `'load'` (🛻 trailer load/unload) · `'land'` (🅿️ staging/parking/trailhead) |
| `name` | what riders see on the pin popup |
| `lat`, `lng` | decimal coordinates — long-press in Google Maps to copy them, or use the ❓ tool in the app |
| `notes` | optional one-liner shown in the popup |

The three entries shipped are **EXAMPLES near Traverse City — replace them**.
Delete a line to remove a stop. Commit + push and GitHub Pages redeploys.

### Adding a whole new point category (warming huts, overlooks…)

Two one-line edits in `index.html`, right above `ORV_POINTS`:

1. In `ORV_POINT_CATS` add: `hut: { icon:'🛖', label:'Warming hut' },`
2. In `ORV_LAYERS` add: `hut: { label:'🛖 Warming huts', on:true, kind:'point' },`

Then use `cat:'hut'` in `ORV_POINTS` entries. That's it — the toggle chip,
pins and popups all appear automatically.

### Trails themselves

You never hand-edit trails — they stream live from the Michigan DNR
(service: `gisagodnr.state.mi.us … DNRTrailsOPENDATA`, layers 11 ORV
Routes · 12 ORV Trails · 13 Motorcycle · 15 Snowmobile · 0 Closures,
verified live 2026-07-22). When another state publishes a similar service,
a second `TrailSource` implementation drops in behind the same seam
(`MichiganDnrTrails` is the pattern) with zero UI changes.

## Money notes (unchanged model)

App free forever + ads permanent for everyone. ONE paywall: All Access
$2.99/mo unlocks Fishing + Drone + ORV Trails + every future pack. ORV is
`sellable:false` (bundle-only). Unlock codes: `ORV-XXXX` (mint them with the
same char-sum×7 %36 checksum as FISH/SKY/DRONE). Mode Wheel and My Spots are
FREE — they're core navigation, not pack content.

## Still on YOUR to-do list (carry-forwards)

1. **Firebase RTDB rules** — publish `database.rules.json` in the Firebase
   console if not yet done (test mode expires ~Aug 19).
2. **ASC subscription** — create `com.skydog.skygps.allaccess.monthly`
   ($2.99/mo) after the v1.0 verdict; see DRONE_SECTION_NOTES.md §1.
3. **Stripe** — one $2.99/mo payment link → paste into
   `PACKS_CONFIG.bundle.web.stripeUrl`.
4. **Fishing IAP copy** — after the verdict, drop the "removes ads" promise
   from the legacy $4.99 fishing IAP in ASC (DRONE_SECTION_NOTES.md §2).
