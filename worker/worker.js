/* =====================================================================
   🛡 SkyDog GPS API Worker — Fort SkyDog Phase B
   One small Cloudflare Worker (free tier) that does the two jobs a
   client-side app can never do safely:

     B1  /parcel/*        Regrid proxy — the paid Regrid token lives HERE
                          as a Worker secret, never in index.html. Origin
                          check + per-IP rate limit + edge caching so one
                          scraper can't burn the $375/mo plan's quota.
     B2  /code/claim      Signed unlock codes — Ed25519-signs
                          "packid|YYYYMM" with a private key only this
                          Worker holds. The app verifies with the public
                          key. Checksum forging is dead for paid codes.
         /stripe/webhook  Receipt acknowledgment for Stripe (monitoring).

   SECRETS (set in the Cloudflare dashboard or `wrangler secret put` —
   never, ever in this repo):
     REGRID_TOKEN            paid Regrid API token
     STRIPE_SECRET           Stripe secret API key (server-side only)
     STRIPE_WEBHOOK_SECRET   Stripe webhook signing secret
     SIGNING_KEY             base64 PKCS8 Ed25519 private key
                             (from generate-keys.mjs — public half goes
                             in index.html SkySigned.pubkey)

   Honesty note: none of this makes the app "unhackable" — it makes the
   money-shaped things (tokens, code minting) live where users can't
   reach them. That's the whole, honest goal.
   ===================================================================== */
'use strict';

const ALLOWED_ORIGINS = [
  'https://skydoggps.com',
  'https://www.skydoggps.com',
  'capacitor://localhost',        /* iOS Capacitor WebView */
  'ionic://localhost',
];

/* per-IP sliding-hour rate limits. In-memory = per-isolate best effort,
   which is plenty to stop casual quota-burning; upgrade to Durable
   Objects / KV counters only if the Regrid dashboard ever shows abuse. */
const LIMITS = { point: 30, tiles: 4000, overdue: 20, camreg: 10, camlist: 240, camphoto: 2000 };
const hits = new Map();     /* ip:kind -> [timestamps] */

function rateOK(ip, kind){
  const key = ip + ':' + kind, now = Date.now(), hour = 3600000;
  const arr = (hits.get(key) || []).filter((t) => now - t < hour);
  if(arr.length >= LIMITS[kind]) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr);
  if(hits.size > 10000) hits.clear();          /* crude memory guard */
  return true;
}

function originOK(req){
  const o = req.headers.get('Origin');
  if(o) return ALLOWED_ORIGINS.includes(o);
  const r = req.headers.get('Referer');
  if(r) return ALLOWED_ORIGINS.some((a) => r.startsWith(a + '/') || r === a);
  /* <img> tile loads and some native fetches send neither header —
     allow, and let the rate limit be the backstop */
  return true;
}

function cors(req, res){
  const o = req.headers.get('Origin');
  if(o && ALLOWED_ORIGINS.includes(o)){
    res.headers.set('Access-Control-Allow-Origin', o);
    res.headers.set('Vary', 'Origin');
  }
  return res;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/* ---- base32 (RFC4648, no padding) — mirrors SkySigned._b32 in the app ---- */
const B32A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(bytes){
  let bits = 0, val = 0, out = '';
  for(const b of bytes){
    val = (val << 8) | b; bits += 8;
    while(bits >= 5){ out += B32A[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if(bits) out += B32A[(val << (5 - bits)) & 31];
  return out;
}

const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

/* ---- mint one signed unlock code: SKY-<b32 payload>-<b32 sig> ---- */
async function mintCode(env, packId, expYM){
  const payload = new TextEncoder().encode(packId + '|' + expYM);
  const key = await crypto.subtle.importKey('pkcs8', b64ToBytes(env.SIGNING_KEY), { name: 'Ed25519' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, payload));
  return 'SKY-' + b32encode(payload) + '-' + b32encode(sig);
}

/* expiry month (UTC), n months out — subscription codes get a grace month
   so a renewal never strands a paying user over a month boundary */
function ymPlus(n){
  const d = new Date();
  const m = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  return String(Math.floor(m / 12)) + String(m % 12 + 1).padStart(2, '0');
}

/* ---- Stripe webhook signature check (HMAC-SHA256 over "t.body") ---- */
async function stripeSigOK(req, body, secret){
  const header = req.headers.get('Stripe-Signature') || '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if(!parts.t || !parts.v1) return false;
  if(Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;   /* 5-min replay window */
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.t + '.' + body)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === parts.v1;
}

async function stripeGET(env, path){
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET },
  });
  if(!res.ok) return null;
  return res.json();
}

const CLAIM_PAGE = (inner) => new Response(
  '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>SkyDog GPS — Unlock Code</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0f14;color:#e8eef7;'
  + 'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}'
  + 'code{display:block;background:#0d131c;border:1px dashed #2a3648;border-radius:12px;padding:14px;margin:14px 0;'
  + 'font-size:13px;word-break:break-all;color:#4aa3ff}</style></head><body><div>' + inner + '</div></body></html>',
  { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });


/* ---- the safety cron: overdue + silent = email the contacts ----
   Grace period keeps "walked to the truck 5 minutes late" from paging
   anyone. Email ships via Resend (free tier, RESEND_KEY secret) from
   MAIL_FROM — MailChannels' free Workers API died mid-2024, documented. */
const OD_GRACE_MS = 10 * 60000;

async function odSendEmail(env, rec){
  if(!env.RESEND_KEY) return false;                 /* seam not armed yet — cron just logs */
  const who = rec.name ? rec.name : 'A SkyDog GPS user you know';
  const when = new Date(rec.backBy).toUTCString();
  let text = who + ' set a safety timer in SkyDog GPS and has NOT checked in.\n\n'
    + 'Trip plan: ' + (rec.plan || '(none given)') + '\n'
    + 'Due back: ' + when + '\n'
    + (rec.fix ? 'Last known position: https://maps.google.com/?q=' + rec.fix.lat + ',' + rec.fix.lng + '\n' : '')
    + '\nTheir phone may be dead or out of signal. Try calling or texting them first. '
    + 'If you cannot reach them and you believe they are in danger, contact local authorities '
    + '(in the US, call the county sheriff for backcountry emergencies) and share this email.\n\n'
    + 'This is an automated safety message the user set up themselves in SkyDog GPS (skydoggps.com). '
    + 'SkyDog is not a rescue service.';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'SkyDog GPS Safety <alerts@skydogai.com>',
      to: rec.emails,
      subject: '🚨 Safety alert: ' + who + ' is overdue (SkyDog GPS)',
      text }),
  });
  return r.ok;
}

async function odSweep(env){
  if(!env.OD) return { checked: 0, sent: 0 };
  const now = Date.now();
  let checked = 0, sent = 0, cursor;
  do{
    const page = await env.OD.list({ prefix: 'od:', cursor, limit: 1000 });
    cursor = page.list_complete ? null : page.cursor;
    for(const k of page.keys){
      const raw = await env.OD.get(k.name);
      if(!raw) continue;
      const rec = JSON.parse(raw); checked++;
      const overdue = now > rec.backBy + OD_GRACE_MS;
      const silent = rec.lastPing < rec.backBy;      /* no sign of life since the deadline */
      if(!rec.sent && overdue && silent){
        const ok = await odSendEmail(env, rec);
        if(ok){
          rec.sent = true; sent++;
          await env.OD.put(k.name, JSON.stringify(rec), { expirationTtl: 24 * 3600 });
        }
      }
    }
  } while(cursor);
  return { checked, sent };
}

/* =====================================================================
   📸 TRAIL CAM HUB — RUN 4 (feature ⑧)
   Every camera. Every brand. One map. No per-camera fees.

   The killer move: each user gets a PRIVATE ingest email address
   (u_<id>@skydogai.com). They set their cam app (Tactacam Reveal,
   SpyPoint, Moultrie, Stealth Cam…) or Gmail to forward photo emails
   there. Cloudflare Email Routing hands the message to this worker,
   which pulls the image attachments into R2 and (when the AI binding
   is live) runs a triage tag: animal / person / vehicle.

   HONESTY + PRIVACY:
   - Photos are PRIVATE per user: every read needs the id+token pair
     minted at registration (stored only on the user's phone).
   - Triage is animal/person/vehicle, NOT species ID — COCO-class models
     call a whitetail a "horse" often enough that promising species
     would be a lie. Copy in the app says "triage", not "species".
   - NO camera blood-detection AI anywhere (patent trap — Run 3 note).
   - EXIF is not exposed anywhere; photos stream back only to the
     authenticated owner. Any future sharing path must strip EXIF first.

   COST DISCIPLINE ($2.99 sub carries this — quotas are the feature):
   - R2 free tier: 10 GB storage / 1M writes / 10M reads per month.
   - Quotas below: 8 MB/photo, 8 photos/email, 400 photos/user,
     60-day retention (pruned on list). At full quota a user holds
     ~1–2 GB worst-case, realistically ~200 MB of cam JPEGs.
   - Workers AI free allocation covers the triage volume at launch;
     tagging degrades to "untagged" (never errors) without the binding.
   ===================================================================== */
const CAMS_CFG = {
  maxPhotoBytes: 8 * 1024 * 1024,   /* per attachment                     */
  maxRawBytes: 30 * 1024 * 1024,    /* whole email cap before we bail     */
  maxPerMsg: 8,                     /* attachments stored per email       */
  maxPerUser: 400,                  /* photo cap per ingest id            */
  retentionDays: 60                 /* pruned during /cams/list           */
};

const hexId = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function camsAuth(env, id, token){
  if(!env.CAMS || !/^[0-9a-f]{8,20}$/.test(id || '') || !/^[0-9a-f]{16,48}$/.test(token || '')) return null;
  const raw = await env.CAMS.get('cam:' + id);
  if(!raw) return null;
  const rec = JSON.parse(raw);
  return rec.token === token ? rec : null;
}

/* ---- minimal MIME multipart walk — enough for cam emails ----
   Trail cams and forwarders send bog-standard multipart/mixed with
   base64 image parts. This walks boundaries recursively (mixed inside
   alternative), collects image/* parts, and ignores everything else.
   It is deliberately conservative: anything malformed = no attachment,
   never a throw. */
function camsExtractImages(rawText){
  const out = [];
  const walk = (text, depth) => {
    if(depth > 4 || out.length >= CAMS_CFG.maxPerMsg) return;
    const bm = /content-type:[^\n]*boundary="?([^";\r\n]+)"?/i.exec(text.slice(0, 8192));
    if(!bm) return;
    const parts = text.split('--' + bm[1]);
    for(const part of parts.slice(1, -1)){
      if(out.length >= CAMS_CFG.maxPerMsg) return;
      const hEnd = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
      if(hEnd < 0) continue;
      const head = part.slice(0, hEnd).toLowerCase();
      const body = part.slice(hEnd).trim();
      if(/content-type:\s*multipart\//.test(head)){ walk(part, depth + 1); continue; }
      const ct = /content-type:\s*(image\/[a-z0-9.+-]+)/.exec(head);
      if(!ct) continue;
      if(!/content-transfer-encoding:\s*base64/.test(head)) continue;
      try{
        const b64 = body.replace(/[\r\n\s]/g, '');
        if(b64.length * 0.75 > CAMS_CFG.maxPhotoBytes) continue;
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        if(bytes.length > 100) out.push({ type: ct[1], bytes });
      }catch(e){ /* malformed part = skipped part, never a bounce loop */ }
    }
  };
  walk(rawText, 0);
  return out;
}

/* ---- triage tag via Workers AI (optional binding) ----
   detr-resnet-50 speaks COCO. COCO has no "deer", so every four-legged
   label collapses to "animal" — honest triage, not species ID. */
const CAMS_ANIMALS = ['bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe'];
function camsTagFromDetections(dets){
  const tags = new Set();
  for(const d of (dets || [])){
    if(!d || (d.score || 0) < 0.35) continue;
    const l = String(d.label || '').toLowerCase();
    if(l === 'person') tags.add('person');
    else if(['car','truck','bus','motorcycle','bicycle','boat'].includes(l)) tags.add('vehicle');
    else if(CAMS_ANIMALS.includes(l)) tags.add('animal');
  }
  return tags.size ? [...tags].sort().join(',') : 'untagged';
}
async function camsTag(env, bytes){
  if(!env.AI) return 'untagged';
  try{
    const res = await env.AI.run('@cf/facebook/detr-resnet-50', { image: [...bytes] });
    return camsTagFromDetections(Array.isArray(res) ? res : res && res.output);
  }catch(e){ return 'untagged'; }
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';

    /* CORS preflight */
    if(req.method === 'OPTIONS'){
      return cors(req, new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type' } }));
    }

    if(url.pathname === '/health') return json({ ok: true });

    /* ---------- B1: Regrid proxy ---------- */
    if(url.pathname === '/parcel/point'){
      if(!originOK(req)) return json({ error: 'origin' }, 403);
      if(!rateOK(ip, 'point')) return json({ error: 'rate' }, 429);
      const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
      if(!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'bad point' }, 400);
      const r = await fetch('https://app.regrid.com/api/v2/parcels/point?lat=' + lat + '&lon=' + lon
        + '&token=' + encodeURIComponent(env.REGRID_TOKEN));
      return cors(req, new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } }));
    }

    const tile = /^\/parcel\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
    if(tile){
      if(!originOK(req)) return new Response('forbidden', { status: 403 });
      if(!rateOK(ip, 'tiles')) return new Response('rate limited', { status: 429 });
      const [, z, x, y] = tile;
      if(+z > 21) return new Response('bad tile', { status: 400 });
      /* edge-cache tiles (keyed WITHOUT the token) — repeat views cost zero quota */
      const cacheKey = new Request(url.origin + url.pathname);
      const cache = caches.default;
      let res = await cache.match(cacheKey);
      if(!res){
        const r = await fetch('https://tiles.regrid.com/api/v1/parcels/' + z + '/' + x + '/' + y
          + '.png?token=' + encodeURIComponent(env.REGRID_TOKEN));
        res = new Response(r.body, { status: r.status, headers: {
          'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
        if(r.ok) await cache.put(cacheKey, res.clone());
      }
      return res;
    }

    /* ---------- B2: claim a signed unlock code after Stripe checkout ----------
       Stripe payment link / checkout success_url points here:
         https://api.skydoggps.com/code/claim?session_id={CHECKOUT_SESSION_ID}
       Re-visiting the same link while the subscription is active re-mints a
       fresh code (each code carries an expiry month), so "my code expired"
       support = "open your receipt link again". */
    if(url.pathname === '/code/claim'){
      if(!rateOK(ip, 'point')) return CLAIM_PAGE('<h2>⏳ Too many tries — give it an hour.</h2>');
      const sid = url.searchParams.get('session_id') || '';
      if(!/^cs_[A-Za-z0-9_]+$/.test(sid)) return CLAIM_PAGE('<h2>🤔 That link is missing its checkout session.</h2>');
      const session = await stripeGET(env, 'checkout/sessions/' + sid);
      if(!session || session.payment_status !== 'paid')
        return CLAIM_PAGE('<h2>🕐 Payment not confirmed yet — try again in a minute.</h2>');
      let months = 2;                                     /* monthly sub: this month + a grace month */
      if(session.mode === 'subscription' && session.subscription){
        const sub = await stripeGET(env, 'subscriptions/' + session.subscription);
        if(!sub || !['active', 'trialing', 'past_due'].includes(sub.status))
          return CLAIM_PAGE('<h2>💤 This subscription isn’t active anymore.</h2>'
            + '<p>Resubscribe at skydoggps.com and a fresh code is yours.</p>');
        if(sub.plan && sub.plan.interval === 'year') months = 13;
      }
      const code = await mintCode(env, 'allaccess', ymPlus(months));
      return CLAIM_PAGE('<h2>🎒 All Access unlocked — thank you!</h2>'
        + '<p>Copy this code, then in SkyDog GPS open the 🎒 store sheet and paste it under "Have an unlock code?":</p>'
        + '<code>' + code + '</code>'
        + '<p>Keep this page’s link — reopening it always mints you a fresh code while you’re subscribed.</p>');
    }

    /* ---------- Stripe webhook: acknowledge + basic sanity (monitoring) ---------- */
    if(url.pathname === '/stripe/webhook' && req.method === 'POST'){
      const body = await req.text();
      if(!(await stripeSigOK(req, body, env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'sig' }, 400);
      /* delivery happens on /code/claim; the webhook exists so Stripe's
         dashboard shows green checks and disputes/cancellations are visible */
      return json({ received: true });
    }


    /* ---------- ⏳ OVERDUE AUTO-EMAIL (Run 2 phase 2) ----------
       Opt-in only: the app registers {plan, back-by, contact emails} when
       the USER flips the auto-email switch. A live phone checks in; the
       cron below emails the contacts if the phone goes silent past
       back-by. Records self-destruct via KV TTL (<=72 h) — same honesty
       window as everything else SkyDog stores. */
    if(url.pathname === '/overdue/register' && req.method === 'POST'){
      if(!originOK(req)) return cors(req, json({ error: 'origin' }, 403));
      if(!rateOK(ip, 'overdue')) return cors(req, json({ error: 'rate' }, 429));
      if(!env.OD) return cors(req, json({ error: 'kv not bound' }, 503));
      let b; try{ b = await req.json(); }catch(e){ return cors(req, json({ error: 'bad json' }, 400)); }
      const now = Date.now();
      const backBy = +b.backBy;
      if(!isFinite(backBy) || backBy < now - 3600000 || backBy > now + 48 * 3600000)
        return cors(req, json({ error: 'bad backBy' }, 400));
      const emails = (Array.isArray(b.emails) ? b.emails : []).map(String)
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)).slice(0, 3);
      if(!emails.length) return cors(req, json({ error: 'no emails' }, 400));
      const id = (typeof b.id === 'string' && /^[a-f0-9-]{8,40}$/.test(b.id)) ? b.id : crypto.randomUUID();
      const fix = b.fix && isFinite(+b.fix.lat) && isFinite(+b.fix.lng)
        ? { lat: +(+b.fix.lat).toFixed(4), lng: +(+b.fix.lng).toFixed(4) } : null;
      const rec = { backBy, plan: String(b.plan || '').slice(0, 400), name: String(b.name || '').slice(0, 60),
        emails, fix, created: now, lastPing: now, sent: false };
      const ttl = Math.min(72 * 3600, Math.max(3600, Math.ceil((backBy - now) / 1000) + 24 * 3600));
      await env.OD.put('od:' + id, JSON.stringify(rec), { expirationTtl: ttl });
      return cors(req, json({ ok: true, id }));
    }

    if(url.pathname === '/overdue/checkin' && req.method === 'POST'){
      if(!originOK(req)) return cors(req, json({ error: 'origin' }, 403));
      if(!env.OD) return cors(req, json({ error: 'kv not bound' }, 503));
      let b; try{ b = await req.json(); }catch(e){ return cors(req, json({ error: 'bad json' }, 400)); }
      const id = String(b.id || '');
      const raw = /^[a-f0-9-]{8,40}$/.test(id) ? await env.OD.get('od:' + id) : null;
      if(!raw) return cors(req, json({ error: 'unknown id' }, 404));
      const rec = JSON.parse(raw);
      rec.lastPing = Date.now();
      if(isFinite(+b.backBy) && +b.backBy > Date.now() - 3600000 && +b.backBy < Date.now() + 48 * 3600000)
        rec.backBy = +b.backBy;                       /* +1 hour button pushes the new time */
      const ttl = Math.min(72 * 3600, Math.max(3600, Math.ceil((rec.backBy - Date.now()) / 1000) + 24 * 3600));
      await env.OD.put('od:' + id, JSON.stringify(rec), { expirationTtl: ttl });
      return cors(req, json({ ok: true }));
    }

    if(url.pathname === '/overdue/cancel' && req.method === 'POST'){
      if(!originOK(req)) return cors(req, json({ error: 'origin' }, 403));
      if(!env.OD) return cors(req, json({ error: 'kv not bound' }, 503));
      let b; try{ b = await req.json(); }catch(e){ return cors(req, json({ error: 'bad json' }, 400)); }
      const id = String(b.id || '');
      if(/^[a-f0-9-]{8,40}$/.test(id)) await env.OD.delete('od:' + id);
      return cors(req, json({ ok: true }));
    }

    /* ---------- 📸 TRAIL CAM HUB (Run 4) ---------- */
    if(url.pathname === '/cams/register' && req.method === 'POST'){
      if(!originOK(req)) return cors(req, json({ error: 'origin' }, 403));
      if(!rateOK(ip, 'camreg')) return cors(req, json({ error: 'rate' }, 429));
      if(!env.CAMS) return cors(req, json({ error: 'kv not bound' }, 503));
      const id = hexId(6), token = hexId(16);
      await env.CAMS.put('cam:' + id, JSON.stringify({ token, created: Date.now(), n: 0 }));
      return cors(req, json({ ok: true, id, token, addr: 'u_' + id + '@skydogai.com' }));
    }

    if(url.pathname === '/cams/list'){
      if(!originOK(req)) return cors(req, json({ error: 'origin' }, 403));
      if(!rateOK(ip, 'camlist')) return cors(req, json({ error: 'rate' }, 429));
      const id = url.searchParams.get('id'), rec = await camsAuth(env, id, url.searchParams.get('token'));
      if(!rec) return cors(req, json({ error: 'auth' }, 403));
      if(!env.CAM_PHOTOS) return cors(req, json({ error: 'r2 not bound' }, 503));
      const cutoff = Date.now() - CAMS_CFG.retentionDays * 86400000;
      const photos = []; let cursor, pruned = 0;
      do{
        const page = await env.CAM_PHOTOS.list({ prefix: 'cams/' + id + '/', cursor, include: ['customMetadata'] });
        cursor = page.truncated ? page.cursor : null;
        for(const o of page.objects){
          const ts = +((o.customMetadata || {}).ts || 0) || +o.uploaded;
          if(ts < cutoff){ await env.CAM_PHOTOS.delete(o.key); pruned++; continue; }   /* retention, enforced honestly */
          photos.push({ k: o.key.split('/').pop(), ts, size: o.size,
            tags: (o.customMetadata || {}).tags || 'untagged',
            from: (o.customMetadata || {}).from || '', subj: (o.customMetadata || {}).subj || '' });
        }
      } while(cursor);
      photos.sort((a, b) => b.ts - a.ts);
      if(pruned && env.CAMS){ rec.n = photos.length; await env.CAMS.put('cam:' + id, JSON.stringify(rec)); }
      return cors(req, json({ ok: true, photos: photos.slice(0, CAMS_CFG.maxPerUser),
        quota: { used: photos.length, max: CAMS_CFG.maxPerUser, days: CAMS_CFG.retentionDays } }));
    }

    if(url.pathname === '/cams/photo'){
      if(!rateOK(ip, 'camphoto')) return new Response('rate limited', { status: 429 });
      const id = url.searchParams.get('id'), rec = await camsAuth(env, id, url.searchParams.get('token'));
      if(!rec) return new Response('forbidden', { status: 403 });
      const k = url.searchParams.get('k') || '';
      if(!/^[\w.-]{1,80}$/.test(k) || !env.CAM_PHOTOS) return new Response('bad key', { status: 400 });
      const obj = await env.CAM_PHOTOS.get('cams/' + id + '/' + k);
      if(!obj) return new Response('not found', { status: 404 });
      return cors(req, new Response(obj.body, { headers: {
        'Content-Type': (obj.customMetadata || {}).type || 'image/jpeg',
        'Cache-Control': 'private, max-age=3600' } }));
    }

    if(url.pathname === '/cams/delete' && req.method === 'POST'){
      if(!originOK(req)) return cors(req, json({ error: 'origin' }, 403));
      let b; try{ b = await req.json(); }catch(e){ return cors(req, json({ error: 'bad json' }, 400)); }
      const rec = await camsAuth(env, b.id, b.token);
      if(!rec) return cors(req, json({ error: 'auth' }, 403));
      const k = String(b.k || '');
      if(/^[\w.-]{1,80}$/.test(k) && env.CAM_PHOTOS) await env.CAM_PHOTOS.delete('cams/' + b.id + '/' + k);
      return cors(req, json({ ok: true }));
    }

    return json({ error: 'not found' }, 404);
  },

  /* 📸 Email Routing hands every u_<id>@skydogai.com message here.
     Unknown address = reject (sender sees a bounce, no storage burned).
     Known address = pull image attachments into R2 + triage-tag. */
  async email(message, env, ctx){
    const m = /^u_([0-9a-f]{8,20})@/i.exec(String(message.to || '').toLowerCase());
    const kvRaw = m && env.CAMS ? await env.CAMS.get('cam:' + m[1]) : null;
    const rec = kvRaw ? JSON.parse(kvRaw) : null;      /* the private address IS the credential here */
    if(!rec){ message.setReject('no such SkyDog cam address'); return; }
    const id = m[1];
    if(message.rawSize > CAMS_CFG.maxRawBytes){ message.setReject('message too large'); return; }
    if((rec.n || 0) >= CAMS_CFG.maxPerUser){ message.setReject('photo quota full — open SkyDog GPS to prune'); return; }
    const raw = await new Response(message.raw).text();
    const images = camsExtractImages(raw);
    if(!images.length) return;                       /* text-only mail: accept quietly, store nothing */
    const from = String(message.from || '').slice(0, 120);
    const subj = String((message.headers && message.headers.get && message.headers.get('subject')) || '').slice(0, 140);
    const now = Date.now();
    let stored = 0;
    for(let i = 0; i < images.length && (rec.n || 0) + stored < CAMS_CFG.maxPerUser; i++){
      const img = images[i];
      const tags = await camsTag(env, img.bytes);
      const ext = img.type === 'image/png' ? 'png' : 'jpg';
      await env.CAM_PHOTOS.put('cams/' + id + '/' + now + '-' + i + '.' + ext, img.bytes,
        { customMetadata: { ts: String(now), from, subj, tags, type: img.type } });
      stored++;
    }
    if(stored){ rec.n = (rec.n || 0) + stored; ctx.waitUntil(env.CAMS.put('cam:' + id, JSON.stringify(rec))); }
  },

  /* cron (wrangler.toml [triggers]) — the whole point of phase 2: a DEAD
     phone can still get its owner looked for */
  async scheduled(event, env, ctx){
    ctx.waitUntil(odSweep(env));
  },
};
