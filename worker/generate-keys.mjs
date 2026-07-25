#!/usr/bin/env node
/* =====================================================================
   🔑 Fort SkyDog B2 — one-time Ed25519 keypair generator
   Run:  node worker/generate-keys.mjs

   Prints two values and saves NOTHING to disk:
     1. PUBLIC key  → paste into index.html  SkySigned.pubkey
     2. PRIVATE key → paste into the Cloudflare dashboard as the
        SIGNING_KEY Worker secret (or `wrangler secret put SIGNING_KEY`)

   The private key must NEVER be committed, screenshotted, or pasted
   into a chat/doc. If it ever leaks: run this again, update both
   halves, and every previously-minted code dies at its expiry month.
   ===================================================================== */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);   // raw 32-byte key for WebCrypto importKey('raw')
const privPkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });

console.log('\n=== SkyDog GPS signing keys (Ed25519) ===\n');
console.log('PUBLIC key — paste into index.html → SkySigned.pubkey:');
console.log('  ' + pubRaw.toString('base64'));
console.log('\nPRIVATE key — Cloudflare Worker secret SIGNING_KEY (dashboard only, never the repo):');
console.log('  ' + privPkcs8.toString('base64'));
console.log('\nDone. This script saved nothing to disk — close this terminal when the two values are pasted where they belong.\n');
