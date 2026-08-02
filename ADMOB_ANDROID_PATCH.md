# ADMOB ANDROID SWAP — ready-to-apply patch
# Prepared 2026-08-01. Apply ONLY after the Android AdMob app + banner unit exist.
# Do NOT commit until tests read 505/505.

## 0. What you need first

Log into AdMob as **mathewdereere@gmail.com** → publisher **pub-5768994898556694**
(the REAL account — skydog8426@ and mathewdear5353@ are empty decoys).

Apps → Add app → **Android** → "Is the app listed on a supported app store?"
→ **No** (it isn't published yet) → app name `SkyDog GPS`.

Then Ad units → Add ad unit → **Banner** → name `SkyDog GPS Android Banner`.

Write down the two values:

    ANDROID APP ID     ca-app-pub-5768994898556694~__________
    ANDROID BANNER ID  ca-app-pub-5768994898556694/__________

Note the separators: the **app** id uses a tilde `~`, the **banner** id uses a slash `/`.
Mixing them up produces ads that silently never load.

---

## 1. index.html — make ADMOB_IDS platform-aware

Around line 3992. Replace this block:

```js
/* SkyDog GPS AdMob IDs — REAL production IDs (AdMob app "SKYDOG GPS"). */
const ADMOB_IDS = {
  appId:  "ca-app-pub-5768994898556694~5508912318",
  banner: "ca-app-pub-5768994898556694/6215489322"
};
```

with this:

```js
/* SkyDog GPS AdMob IDs — REAL production IDs, resolved per platform.
   iOS     → AdMob app "SKYDOG GPS"
   Android → AdMob app "SkyDog GPS" (Android entry)
   Both live under publisher pub-5768994898556694. */
const SD_PLATFORM = (window.Capacitor && window.Capacitor.getPlatform)
  ? window.Capacitor.getPlatform()
  : 'web';

const ADMOB_IDS_BY_PLATFORM = {
  ios: {
    appId:  "ca-app-pub-5768994898556694~5508912318",
    banner: "ca-app-pub-5768994898556694/6215489322"
  },
  android: {
    appId:  "PASTE_ANDROID_APP_ID_HERE",
    banner: "PASTE_ANDROID_BANNER_ID_HERE"
  }
};

/* Falls back to the iOS pair on 'web', where the native AdMob plugin
   is absent anyway and SkyGPSAds.init() bails before using these. */
const ADMOB_IDS = ADMOB_IDS_BY_PLATFORM[SD_PLATFORM] || ADMOB_IDS_BY_PLATFORM.ios;
```

Leave `const ADMOB_TESTING = false;` exactly as it is on the next line.
Nothing else in `SkyGPSAds` changes — it already reads `ADMOB_IDS.banner`.

**✅ The entitlement gate is ALREADY BUILT (v2.0, 2026-08-02).** `SkyGPSAds.init()`
returns early when `adsOff()` is true, and `SkyGPSAds.sync()` (called from
`sdGrantPack`, `_syncOwned`, the code-redeem handler and the trial handler) pulls
the banner and zeroes `--adh` the moment All Access turns on. Android inherits all
of it for free — this patch only swaps the ad **ids**, so there is nothing extra to
wire. Do NOT add a second gate; one is enough and two will fight.

**Guards this must not trip:**
- `localStorage` must still appear EXACTLY 2× in index.html (this patch adds none).
- No CDN or `script src` added (this patch adds none).
- Ad-removal copy is now allowed **only** for an active All Access subscription —
  never for the legacy one-time Fishing Pack (this patch adds no copy either way).

---

## 2. android/app/src/main/AndroidManifest.xml — real app id

Replace the TODO block:

```xml
<!-- TODO SWAP: replace with the REAL Android AdMob app id once created
     in the mathewdereere AdMob account. This is Google's public TEST id. -->
<meta-data
    android:name="com.google.android.gms.ads.APPLICATION_ID"
    android:value="ca-app-pub-3940256099942544~3347511713" />
```

with:

```xml
<!-- SkyDog GPS Android — REAL AdMob app id (pub-5768994898556694). -->
<meta-data
    android:name="com.google.android.gms.ads.APPLICATION_ID"
    android:value="PASTE_ANDROID_APP_ID_HERE" />
```

This is a hand edit that survives `npx cap sync android` — but re-check it after
any sync, because Capacitor has been known to rewrite the manifest on plugin changes.

---

## 3. sw.js — bump the cache version (now v36 → v37 after the ad-gate race fix)

index.html changed, so the service worker version MUST move in the same commit.

    line 3:  const CACHE = 'skydog-gps-v36';
      →      const CACHE = 'skydog-gps-v37';

---

## 4. tests/test.js — move the pin test with it

Search test.js for "sw.js cache bumped" (the line number moves every run). The pin test and sw.js are a matched pair — bumping one without the
other is an instant red suite.

```js
T('sw.js cache bumped to v34 (Activity Engine ships fresh)', sw.includes("skydog-gps-v34") && !sw.includes("skydog-gps-v33") && !sw.includes("skydog-gps-v32"));
```

becomes:

```js
T('sw.js cache bumped to v35 (platform-aware AdMob ids ship fresh)', sw.includes("skydog-gps-v35") && !sw.includes("skydog-gps-v34") && !sw.includes("skydog-gps-v33"));
```

---

## 5. Verify, then ship

```bash
cd ~/Projects/skydog-gps-deploy

# 1. tests must be 505/505 — no push before this reads 100%
SD_APP_DIR=$PWD node tests/test.js

# 2. push the web change (skydoggps.com is GitHub Pages off main — this goes live)
git -c user.name="SkyDog" -c user.email="skydog8426@gmail.com" \
    commit -am "Android AdMob: platform-aware ad ids, sw v35"
git push

# 3. rebuild the Android bundle with the real ids
npm run android:sync
cd android && ./gradlew bundleRelease
ls -l app/build/outputs/bundle/release/app-release.aab
```

Then re-stage the new .aab before uploading — `claude-in-chrome`'s `file_upload`
only accepts `/mnt/user-data/uploads` paths.

---

## 6. Sanity checks after the swap

- [ ] `grep -c "ca-app-pub-3940256099942544" index.html android/app/src/main/AndroidManifest.xml` → **0**. No test ids left anywhere.
- [ ] The Android app id uses `~`, the banner id uses `/`.
- [ ] versionCode bumped if you already uploaded build 1 to any track.
- [ ] Tests 505/505 BEFORE the push, not after.
- [ ] **Never tap your own ads.** Not once, not to "check it works." AdMob
      termination for self-clicks is usually permanent and it would take the
      iOS revenue down with it — same publisher account.

---

## 7. Timing — don't do this too early

While SkyDog GPS is in **closed testing**, Google's test ad ids are the *correct*
and *safe* thing to ship: 12 testers poking at a new app is exactly the traffic
pattern that gets a fresh AdMob account flagged for invalid activity.

Apply this patch **after** the 14-day closed test completes and **before** you
submit for production access. That is the window.

> ⚠️ Updated 2026-08-02 (Run 7): Run 6 took v33 and the Run 7 Activity Engine build took v34, so this patch now bumps v34 → v35. Numbers above already reflect that.
