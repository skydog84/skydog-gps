# SkyDog GPS — World Feature Scan & Brainstorm
**Date:** August 1, 2026
**What this is:** A scan of what mapping apps in China, Japan, Korea, Russia, India, and Europe are doing — plus the newest moves from US competitors (onX, AllTrails, Gaia, Fishbrain, Navionics, CalTopo) — filtered down to features SkyDog GPS could actually build and sell.

---

## The Big Insight First

The pattern behind almost every killer feature in China and Japan is this: **they treat their users as sensors.** Amap figures out traffic light countdowns from its own users' GPS traces. YAMAP turns every hiker's phone into a rescue relay for strangers. Amap warns drivers of oncoming cars on blind mountain curves just by knowing where its other users are.

**No US outdoor GPS app has committed to this idea.** Every feature below that uses it gets stronger as SkyDog grows — that's a moat, not just a feature.

The second insight: the entire US market is furious about pricing. onX Elite is ~$100/yr, AllTrails Peak $80/yr, Navionics killed lifetime licenses and charges $80/yr, Gaia's forums are a price-revolt wall, HuntWise has BBB complaints about surprise trial charges. **SkyDog at $2.99/mo with honest billing is itself a headline feature.** Sell against "subscription stacking" — a guy who hunts, fishes, and rides currently pays $200–300/yr across 3 apps.

---

## TIER 1 — Build These First (days to weeks each, free data, big wow factor)

### 1. The Emergency Screen (inspired by Amap China + what3words)
Amap v15 in China has a full satellite-rescue mode built into the map. You can't do satellite hardware — but you can build one big red **"EMERGENCY"** button that works fully offline and shows:
- Your exact position in every format at once: lat/lon, USNG (what US search-and-rescue actually uses), and what3words (now wired into thousands of US 911 centers)
- One tap to compose a pre-filled SOS text (works with iPhone satellite Messages on 14+)
- A shareable live-track web link a rescuer or family member can open with no app and no login

**Why it sells:** "The GPS app that can save your life" is a marketing story onX doesn't tell. CalTopo just made "works over T-Mobile satellite" a checkbox — keep your Buddy Trips pings tiny so they survive satellite bandwidth and you can claim it too.

### 2. Overdue Timer / Trip Plan Filing (inspired by YAMAP Japan)
In Japan, YAMAP files your hike plan directly with the police and sells rescue insurance in-app. The US version: before a trip, set "I'll be back by 6pm" + pick emergency contacts. If you don't check in, SkyDog automatically texts/emails your contacts your trip plan, last known position, and a live map link. **A weekend of work, genuinely absent from every major US app.**

### 3. Wildfire + Smoke Layer (proven demand, 100% free data)
Watch Duty passed ChatGPT as the #1 free app during the LA fires. Fire perimeters (NIFC), satellite hotspots (NASA FIRMS), and smoke/air quality (AirNow) are all free government APIs. Days of work, seasonally viral — September elk season IS smoke season.

### 4. Cell Coverage Layer (onX paywalls it; the data is free)
onX Offroad locks its Verizon/AT&T/T-Mobile coverage layer behind Elite. It's built from the FCC National Broadband Map — **free bulk download.** "See where you lose signal before you lose it." Ship it free as a wedge.

### 5. Solunar "Activity Meter" (what HuntWise/Fishbrain charge for is mostly astronomy)
HuntCast, BiteTime, Spartan Forge's AI — all paywalled, all accused of inaccuracy anyway. The classic solunar tables are pure moon/sun math you can compute on-device for free (SunCalc library), blended with NOAA pressure trend and wind. A "Fish/Game Activity" dial on the HUD gives SkyDog the "AI feel" at zero API cost.

### 6. SkyDog Pins — shareable spot codes (inspired by Mappls India)
India gives every location a short code because addresses don't exist there — same problem as the backcountry. Short shareable codes for camps, stands, ramps, meetup points ("SD-K7Q2P") that resolve offline. Trivial to build (geohash under the hood), and once a hunting party shares pins, they're all locked into SkyDog.

### 7. Waypoint Status Comments (copy FarOut, not AllTrails)
FarOut owns thru-hiking with one feature: time-stamped comments on waypoints ("spring flowing as of 7/28"). SkyDog version: "dock in as of 6/1," "lot full by 8am," "trail groomed last night." Pure Firebase, fits your existing POI/launch-intel screens, and **snowmobile grooming status is a national wide-open niche** — no app owns it.

---

## TIER 2 — The Differentiators (more work, nobody in the US has them)

### 8. Party Mode with Voice (inspired by Amap's convoy mode, China)
Amap's team mode: everyone in the party on one map, live positions, plus a built-in push-to-talk walkie-talkie channel. You already have Buddy Trips on Firebase — add party rooms and PTT voice (WebRTC). Hunting parties split up; off-road convoys stretch out. US apps punt this to GMRS radios. onX Offroad only just added basic group location sharing in April 2026 — you're already at parity, so leapfrog them with voice.

### 9. Oncoming Rig Warning (inspired by Amap's blind-bend warning)
Amap warns drivers of oncoming vehicles at blind mountain curves purely from other users' live positions. Off-road version: "Another SkyDog party is coming toward you on this one-lane shelf road." Only needs two parties live-sharing on the same trail. Would be a first in America — think Black Bear Pass.

### 10. "Footprints" / Solitude Layer (inspired by Yamareco Japan)
Yamareco renders millions of users' GPS points as a dot layer — you see where people actually go, and where they don't. Dual-use genius: hikers use it to find the route, **hunters invert it to find solitude.** Starts accruing from your first tester's first track. Seed with OpenStreetMap public GPS traces.

### 11. Trail View — scrubbable trail photos (inspired by Komoot Europe + Yandex Russia)
Komoot AI-filters user photos to only ones showing the trail surface, pinned to the exact track point — scrub the route, see what the two-track actually looks like. "Is this trail passable in my rig?" is THE off-road question. Seed with Mapillary's free open imagery API; later let users record drive-throughs.

### 12. Poor Man's Terrain X (free USGS data vs. onX's $100/yr)
onX Elite's big sellers: slope/aspect analysis, viewshed, leaf-off imagery. USGS gives you the raw ingredients free — 3DEP elevation (slope-angle and aspect shading), NAIP aerial including leaf-off vintages, Sentinel-2 refreshed every 5 days. Also the path to 3D: MapLibre GL renders 3D terrain from free tiles — you could ship 3D cheaper than onX paywalls it.

### 13. Legal Motorized Routing (inspired by China's motorcycle modes + free USFS data)
Amap/Baidu have dedicated motorcycle routing honoring vehicle restrictions. US goldmine: USFS Motor Vehicle Use Maps (MVUM) are free, open, and chronically underused — "is this trail legal for my UTV right now" is a real pain and a ticket-avoider. Also the source for a dispersed-camping layer (onX just made this a headline feature — the data is free).

### 14. Narrated Auto-Tour Mode (inspired by Baidu's AI tour guide)
Baidu's digital tour guide narrates scenic areas as you walk — 100M+ users. SkyDog version: geofenced audio that auto-narrates a float trip, scenic byway, or ORV route ("coming up on your right..."), generated once per POI, cached offline. Fun, viral, nobody has it.

### 15. Voice Packs (huge in China, weirdly absent here)
Celebrity and custom voice packs are a retention machine in China — people share "my nav voice is my kid." Themed offline packs ("Old Timer Guide," duck-camp humor) or record-your-buddy via a TTS/cloning API. Cheap novelty, real virality, possible paid add-on.

---

## TIER 3 — Longer Plays (keep on the radar)

- **Bluetooth rescue relay (YAMAP's "Mimamori," Japan):** phones of passing hikers silently carry your last position back to cell coverage. Patented in Japan and hard on iOS backgrounds — but even a simplified "trailhead sync" version would be unique in the US. The single most impressive feature found anywhere.
- **AI Guide (Amap's Qwen agent, 400M users):** "Find me a walk-in trout stream within 45 minutes with public access and no crowds this weekend." An LLM answering over YOUR layers (regs, access, GPS density). The differentiator is your data, not the model.
- **Free Pro for Search & Rescue volunteers (Outdooractive, Europe):** costs almost nothing, buys huge credibility with exactly your audience.
- **Hunt club tools (HuntStand's niche):** shared hunt areas + stand reservations = Firebase CRUD on top of Buddy Trips.
- **USGS river gauges:** free real-time flow + water temp API that Fishbrain paywalls — cheap Fishing Pack upgrade.
- **NOAA free nautical charts:** Navionics users are in open revolt over pricing; NOAA ENC charts are public domain.
- **Point Info on tap (CalTopo style):** upgrade "What's This?" with NOAA forecast, sun/moon times, and parcel owner at any tap.
- **AR peak naming:** cheap 80% version = tap a summit, name it from free GNIS data. Skip full AR.

---

## What NOT to chase

- **Fresh commercial satellite imagery** (onX's biweekly refresh) — out of budget league; Sentinel-2 free imagery is the counter.
- **AllTrails-style camera plant ID** — their Outdoor Lens is mediocre and online-only; the bar is low but the payoff is lower.
- **True ML animal prediction** (Spartan Forge) — needs telemetry data you don't have; the solunar meter (#5) gets the perceived value free.
- **Replicating Fishbrain's 10M catch logs** — can't; go around it with free USGS/DNR data.

## One engineering warning

Across every app in the category, **offline reliability is the #1 driver of both 5-star and 1-star reviews.** onX's most-repeated praise is "offline works flawlessly"; Gaia and BaseMap's most-repeated complaint is offline failure. Before any Tier 2 feature, make "airplane mode at the trailhead" bulletproof (PMTiles/service-worker caching) — and then market it loudly.

---

## Suggested launch sequence (after v1.1 ships)

1. **v1.2 — "Safety Update":** Emergency Screen + Overdue Timer + Cell Coverage layer. One press release: "The $2.99 GPS app that can save your life."
2. **v1.3 — "Free Data Flex":** Wildfire/smoke, river gauges, solunar meter, SkyDog Pins. Everything competitors paywall, free or nearly free.
3. **v1.4 — "Party Update":** Party rooms + PTT voice + waypoint status comments. The network-effect flywheel starts here.
4. **v2.0 — "The Sensors Era":** Footprints/solitude layer, Trail View, oncoming-rig warning — the features that get better with every new user.

*Full source links for every item are in the research appendix — ask Claude in this session and it can produce the sourced appendix or a PDF version.*
