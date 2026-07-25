# Security Policy — SkyDog GPS

SkyDog GPS is a single-file, no-account app: your tracks, spots and
settings live only on your device. The few networked features (Buddy
Trips, Property Lines, unlock codes) are designed so that money can't be
stolen, quotas can't be drained, and nobody can see anyone's location
without a shared trip code. No client-side app can hide logic from its
own user, and we don't claim otherwise — tampering with your own device
only ever affects your own device.

## Reporting a vulnerability

Email **skydog8426@gmail.com** with subject line `SECURITY`. Please
include steps to reproduce. You'll get a reply within a few days; please
give us a reasonable window to fix before public disclosure. Thank you —
reports are genuinely appreciated.

## In scope

- Anything that lets one user see another user's location without their
  trip code (Buddy Trips / Firebase rules)
- Forging or replaying paid unlock codes
- Extracting or abusing paid API credentials (Regrid proxy, Stripe flow)
- The Cloudflare Worker endpoints under api.skydoggps.com
- XSS or content injection in skydoggps.com

## Out of scope

- Unlocking packs on your own device by editing your own local storage
  or console — that's your device; no server or other user trusts it
- The public Firebase web config in source (normal and safe with locked
  database rules)
- The Regrid sandbox/trial token while it appears in source (demo
  counties only, expires; paid tokens live server-side only)
- Denial of service by simple volume
