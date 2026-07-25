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
const LIMITS = { point: 30, tiles: 4000 };
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

    return json({ error: 'not found' }, 404);
  },
};
