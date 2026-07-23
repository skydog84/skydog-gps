#!/usr/bin/env node
/* =====================================================================
   SkyDog GPS — automated Playwright suite (recreated for Fishing Mode)
   Run:  node /tmp/sdtest/test.js
   Serves ACCOS/skydog-gps over local http, mocks Overpass/Nominatim/tiles
   so every test is deterministic. Exit 0 only at 100% pass.
   ===================================================================== */
'use strict';
const { chromium } = (() => {
  for (const p of [process.env.SD_PW_PATH, 'playwright', '/home/claude/.npm-global/lib/node_modules/playwright'].filter(Boolean)) {
    try { return require(p); } catch (_) {}
  }
  throw new Error('playwright not found — npm i playwright (or set SD_PW_PATH)');
})();
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.SD_APP_DIR || '/root/work/ACCOS/skydog-gps';
const PORT = 8123;

/* tiny 1x1 png for tile mocks */
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/* ---- fixtures ---- */
const FIX_BEACHES = { elements: [
  { type:'node', id:1, lat:44.762, lon:-85.622, tags:{ natural:'beach', name:'Clinch Park Beach', surface:'sand', access:'yes', supervised:'yes' } },
  { type:'way', id:2, center:{lat:44.75, lon:-85.60}, tags:{ natural:'beach', name:'Dog Beach', surface:'pebbles', dog:'leashed' } },
]};
const FIX_RAMPS = { elements: [
  { type:'node', id:10, lat:44.760, lon:-85.620, tags:{ leisure:'slipway', name:'Elmwood Ramp', surface:'concrete', fee:'yes' } },
  { type:'node', id:11, lat:44.7605, lon:-85.6195, tags:{ amenity:'parking', name:'Elmwood Lot', surface:'asphalt' } },
  { type:'node', id:12, lat:44.700, lon:-85.500, tags:{ leisure:'slipway', name:'Lonely Ramp', surface:'gravel' } },
]};
const FIX_POI = { elements: [
  { type:'node', id:20, lat:44.761, lon:-85.621, tags:{ amenity:'toilets', name:'Marina Restrooms', fee:'no', wheelchair:'yes', changing_table:'yes' } },
  { type:'node', id:21, lat:44.763, lon:-85.618, tags:{ amenity:'ice_cream', name:'Moomers Ice Cream', opening_hours:'12:00-21:00' } },
  { type:'node', id:22, lat:44.758, lon:-85.625, tags:{ amenity:'marketplace', name:'Sara Hardy Farmers Market', opening_hours:'Sa 07:30-12:00', organic:'yes' } },
]};
const FIX_NOMINATIM_MI = {
  name: 'Boardman Lake', class: 'water', type: 'water',
  display_name: 'Boardman Lake, Grand Traverse County, Michigan, United States',
  address: { state: 'Michigan', county: 'Grand Traverse County', country: 'United States' },
};

/* FAA UASFM grid: two square cells near Traverse City — one 0-ft (no-fly), one 400-ft */
const FIX_UASFM = { features: [
  { attributes: { OBJECTID: 1, CEILING: 0, UNIT: 'FT', APT1_NAME: 'Cherry Capital', APT1_FAAID: 'TVC', APT1_LAANC: 1, AIRSPACE_1: 'D' },
    geometry: { rings: [[[-85.60, 44.74], [-85.55, 44.74], [-85.55, 44.78], [-85.60, 44.78], [-85.60, 44.74]]] } },
  { attributes: { OBJECTID: 2, CEILING: 400, UNIT: 'FT', APT1_NAME: 'Cherry Capital', APT1_FAAID: 'TVC', APT1_LAANC: 1, AIRSPACE_1: 'D' },
    geometry: { rings: [[[-85.55, 44.74], [-85.50, 44.74], [-85.50, 44.78], [-85.55, 44.78], [-85.55, 44.74]]] } },
] };
const FIX_FIXEDSITES = { features: [
  { attributes: { OBJECTID: 10, SITE_NAME: 'TC Flyers Field', CITY: 'Traverse City', STATE: 'MI', CEILING: 400, LATITUDE: 44.77, LONGITUDE: -85.60 } },
] };
const FIX_WEATHER = { current: { temperature_2m: 72.4, wind_speed_10m: 8.3, wind_direction_10m: 270, wind_gusts_10m: 12.1 } };

/* Michigan DNR trails (gisagodnr.state.mi.us) — polylines near Traverse City.
   Layer 15 = snowmobile (one open, one closed) · 11 = ORV route · 12 = ORV trail
   · 13 = motorcycle · 0 = temporary closures. */
const FIX_DNR_SNOW = { features: [
  { attributes: { OBJECTID: 1, SnowmobileName: 'Blue Bear Trail', OpenClosedStatusSnowmobile: 'Open' },
    geometry: { paths: [[[-85.61, 44.755], [-85.60, 44.76], [-85.59, 44.765]]] } },
  { attributes: { OBJECTID: 2, SnowmobileName: 'Old Logging Run', OpenClosedStatusSnowmobile: 'Closed' },
    geometry: { paths: [[[-85.62, 44.77], [-85.61, 44.775], [-85.60, 44.78]]] } },
] };
const FIX_DNR_ORVROUTE = { features: [
  { attributes: { OBJECTID: 10, NAME: 'Sand Lakes Route' },
    geometry: { paths: [[[-85.58, 44.75], [-85.57, 44.755], [-85.56, 44.75]]] } },
] };
const FIX_DNR_ORVTRAIL = { features: [
  { attributes: { OBJECTID: 20, NAME: 'Kalkaska ORV Trail' },
    geometry: { paths: [[[-85.55, 44.76], [-85.54, 44.765]]] } },
] };
const FIX_DNR_MOTO = { features: [
  { attributes: { OBJECTID: 30, NAME: 'Leetsville Cycle Loop' },
    geometry: { paths: [[[-85.53, 44.77], [-85.52, 44.775]]] } },
] };
const FIX_DNR_CLOSURES = { features: [
  { attributes: { OBJECTID: 40, NAME: 'Bridge Out — Boardman crossing' },
    geometry: { paths: [[[-85.575, 44.758], [-85.57, 44.76]]] } },
] };

/* minimal firebase compat stub (served for both firebase-app & firebase-database) */
const FB_STUB = `window.firebase = window.firebase || (function(){
  function mkRef(path){ return {
    path: path,
    child: function(p){ return mkRef(path + '/' + p); },
    on: function(ev, cb){ (window.__fbCBs = window.__fbCBs || {})[path] = cb; },
    off: function(){ window.__fbOffed = path; },
    set: function(v){ (window.__fbWrites = window.__fbWrites || []).push({path: path, v: v}); return Promise.resolve(); },
    remove: function(){ (window.__fbRemoves = window.__fbRemoves || []).push(path); return Promise.resolve(); },
    onDisconnect: function(){ return {
      remove: function(){ window.__fbOD = path; },
      cancel: function(){ window.__fbODCancel = path; } }; }
  }; }
  return { initializeApp: function(){}, database: function(){ return { ref: mkRef }; } };
})();`;

let pass = 0, fail = 0;
const failures = [];
function T(name, cond, info){
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (info ? ' — ' + info : '')); console.log('  ❌ ' + name + (info ? ' — ' + info : '')); }
}

async function main(){
  /* static server */
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(APP_DIR, p === '/' ? 'index.html' : p);
    if (!f.startsWith(APP_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nope'); }
    const ext = path.extname(f);
    res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.json' ? 'application/json' : 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  }).listen(PORT);

  /* find a chromium binary: env override → scan /opt/pw-browsers → let playwright decide */
  function findChrome(){
    if (process.env.SD_CHROME) return process.env.SD_CHROME;
    try {
      const root = '/opt/pw-browsers';
      for (const d of fs.readdirSync(root)) {
        for (const rel of ['chrome-linux/headless_shell', 'chrome-linux/chrome']) {
          const p = path.join(root, d, rel);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch (_) {}
    return undefined;
  }
  const exe = findChrome();
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 420, height: 850 } });

  let overpassMode = 'beaches';
  let faaHits = 0;
  let dnrHits = 0;
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://localhost:' + PORT)) return route.continue();
    if (url.includes('overpass-api.de')) {
      const body = overpassMode === 'beaches' ? FIX_BEACHES : overpassMode === 'poi' ? FIX_POI : FIX_RAMPS;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.includes('nominatim.openstreetmap.org/reverse')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX_NOMINATIM_MI) });
    }
    if (url.includes('nominatim')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    if (url.includes('FAA_UAS_FacilityMap_Data')) {
      faaHits++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX_UASFM) });
    }
    if (url.includes('Recreational_Flyer_Fixed_Sites')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX_FIXEDSITES) });
    }
    /* Michigan DNR trails — dispatch on the FeatureServer layer id */
    if (url.includes('gisagodnr.state.mi.us')) {
      dnrHits++;
      const lm = /FeatureServer\/(\d+)\/query/.exec(url);
      const layer = lm ? lm[1] : '';
      const body = layer === '15' ? FIX_DNR_SNOW
        : layer === '11' ? FIX_DNR_ORVROUTE
        : layer === '12' ? FIX_DNR_ORVTRAIL
        : layer === '13' ? FIX_DNR_MOTO
        : layer === '0' ? FIX_DNR_CLOSURES
        : { features: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.includes('open-meteo') && url.includes('/v1/forecast')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX_WEATHER) });
    }
    if (url.includes('open-meteo')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"elevation":[190]}' });
    }
    /* Firebase SDK stub — records writes/listeners so buddy tests are deterministic & offline */
    if (url.includes('gstatic.com/firebasejs')) {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: FB_STUB });
    }
    /* every tile/export request → tiny png (deterministic, fast) */
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG1 });
  });

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.waitForFunction('window.__SKYDOG_READY === true', null, { timeout: 10000 });

  console.log('\n— Core boot —');
  T('app boots, __SKYDOG_READY', await page.evaluate('window.__SKYDOG_READY') === true);
  T('no fatal banner on boot', await page.$eval('#fatal', (el) => getComputedStyle(el).display) === 'none');
  T('no page JS errors on boot', consoleErrors.length === 0, consoleErrors.join(' | '));
  T('map engine present', await page.evaluate('!!window.__sdmap && typeof __sdmap.project === "function"'));

  console.log('\n— Core regression —');
  T('12 discovery chips', await page.$$eval('#chips .chip', (e) => e.length) === 12);
  T('12 activity modes', await page.$$eval('#modes .modebtn', (e) => e.length) === 12);
  T('5 base maps in layer sheet', await page.evaluate('Object.keys(__sdmap.constructor ? window.BASES || {} : {}).length || (function(){ return document.querySelectorAll("#basegrid .modebtn").length; })()') !== -1 && (await page.evaluate('(function(){ document.getElementById("layerfab").click(); return document.querySelectorAll("#basegrid .modebtn").length; })()')) === 5, 'basegrid count');
  T('5 overlays incl fishing pair in layer sheet', await page.$$eval('#ovchips .chip', (e) => e.length) === 5);
  await page.evaluate('(function(){ document.getElementById("layerdone").click(); })()');
  const z0 = await page.evaluate('__sdmap.zoom');
  await page.click('#zoomin');
  T('zoom-in fab works', (await page.evaluate('__sdmap.zoom')) > z0);
  T('projection roundtrip', await page.evaluate(`(function(){
    const ws = __sdmap.worldSize(12);
    const [x, y] = __sdmap.project(44.76, -85.62, ws);
    const b = __sdmap.unproject(x, y, ws);
    return Math.abs(b.lat - 44.76) < 1e-6 && Math.abs(b.lng - -85.62) < 1e-6;
  })()`));
  T('GPX export produces valid track', await page.evaluate(`(function(){
    const g = tripGPX({ name: 'T&est', notes: '', startedAt: new Date(0).toISOString(),
      mode: { name: 'Fishing', em: '🎣' },
      points: [{ lat: 44.1, lng: -85.1, t: 0, alt: 200 }, { lat: 44.2, lng: -85.2, t: 60000, alt: 210 }] });
    return g.includes('<gpx') && g.includes('T&amp;est') && g.includes('lat="44.100000"') && g.includes('<ele>200.0</ele>');
  })()`));

  console.log('\n— 🚻🍦🥕 New free chips (2026-07-18) —');
  T('restroom / ice cream / farmers mkt chips present', await page.evaluate(`(function(){
    const t = [...document.querySelectorAll('#chips .chip')].map(c => c.textContent);
    return t.some(x => x.includes('Restrooms')) && t.some(x => x.includes('Ice Cream')) && t.some(x => x.includes('Farmers Mkt'));
  })()`));
  T('chips carry gentle glow animation', await page.$eval('#chips .chip', (el) => getComputedStyle(el).animationName) === 'chipGlow');
  T('fabs carry gentle glow animation', await page.$eval('.fab', (el) => getComputedStyle(el).animationName) === 'chipGlow');
  T('active chip glow suppressed', await page.evaluate(`(function(){
    const c = document.querySelector('#chips .chip'); c.classList.add('active');
    const ok = getComputedStyle(c).animationName === 'none'; c.classList.remove('active'); return ok;
  })()`));
  overpassMode = 'poi';
  await page.evaluate('__sdmap.clearGroup("poi")');
  await page.evaluate(`(function(){ [...document.querySelectorAll('#chips .chip')].find(c => c.textContent.includes('Restrooms')).click(); })()`);
  await page.waitForFunction('__sdmap.countGroup("poi") > 0', null, { timeout: 5000 });
  T('poi pins dropped (3)', await page.evaluate('__sdmap.countGroup("poi")') === 3);
  T('restroom card: free + accessible + changing table', await page.evaluate(`(function(){
    const m = __sdmap.markers.find(m => m.group === 'poi' && m.popup && m.popup.includes('Marina Restrooms'));
    return !!m && m.popup.includes('free') && m.popup.includes('accessible') && m.popup.includes('changing table');
  })()`));
  await page.evaluate('__sdmap.clearGroup("poi")');
  await page.evaluate(`(function(){ [...document.querySelectorAll('#chips .chip')].find(c => c.textContent.includes('Ice Cream')).click(); })()`);
  await page.waitForFunction('__sdmap.countGroup("poi") > 0', null, { timeout: 5000 });
  T('ice cream card: hours shown', await page.evaluate(`(function(){
    const m = __sdmap.markers.find(m => m.group === 'poi' && m.popup && m.popup.includes('Moomers Ice Cream'));
    return !!m && m.popup.includes('hours: 12:00-21:00');
  })()`));
  await page.evaluate('__sdmap.clearGroup("poi")');
  await page.evaluate(`(function(){ [...document.querySelectorAll('#chips .chip')].find(c => c.textContent.includes('Farmers Mkt')).click(); })()`);
  await page.waitForFunction('__sdmap.countGroup("poi") > 0', null, { timeout: 5000 });
  T('farmers market card: hours + organic', await page.evaluate(`(function(){
    const m = __sdmap.markers.find(m => m.group === 'poi' && m.popup && m.popup.includes('Sara Hardy Farmers Market'));
    return !!m && m.popup.includes('Sa 07:30-12:00') && m.popup.includes('organic');
  })()`));
  await page.evaluate('__sdmap.clearGroup("poi")');

  console.log('\n— 🎣 Fishing Mode: toggle —');
  T('fish fab exists', (await page.$eval('#fishfab', (el) => el.textContent.trim())) === '🎣');
  T('fishing off by default', await page.evaluate('__sdfish.mode') === false);
  T('fish chips hidden by default', await page.$eval('#fishchips', (el) => getComputedStyle(el).display) === 'none');

  console.log('\n— 💰 Fishing Pack paywall —');
  await page.click('#fishfab');
  T('locked: fab opens paywall, not mode', await page.evaluate('__sdfish.mode') === false
    && await page.$eval('#paysheet', (el) => el.classList.contains('open')));
  T('one paywall: subscribe sells All Access at $2.99', (await page.$eval('#paysub', (el) => el.textContent)).includes('$2.99')
    && !(await page.$eval('#paysub', (el) => el.getAttribute('href')))); /* old $4.99 fishing-only Stripe links retired */
  T('paywall spotlights the pack you tapped', (await page.$eval('#paytitle', (el) => el.textContent)).includes('Fishing'));
  T('free trial offered', await page.$eval('#paytrial', (el) => getComputedStyle(el).display !== 'none'));
  T('checksum rejects bad codes', await page.evaluate(
    '!__sdfish.FISHPACK.codeOK("FISH-AAAA") && !__sdfish.FISHPACK.codeOK("hello") && !__sdfish.FISHPACK.codeOK("")'));
  await page.fill('#paycode', 'fish-aaaa');
  await page.click('#payunlock');
  T('bad code via UI stays locked', await page.evaluate('__sdfish.mode') === false);
  await page.fill('#paycode', 'fish-vt71');   /* lowercase on purpose — must normalize */
  await page.click('#payunlock');
  T('valid code unlocks + enables mode', await page.evaluate('__sdfish.mode') === true
    && !(await page.$eval('#paysheet', (el) => el.classList.contains('open'))));
  T('license persisted on device', await page.evaluate('localStorage.getItem("sd-fishpack")') === 'FISH-VT71');
  T('storage holds ONLY license keys + wheel hint (trips stay in-memory)', await page.evaluate(
    'Object.keys(localStorage).every((k) => k.startsWith("sd-fishpack") || k === "sd-wheel-hint")'));
  T('toggle on: mode true', await page.evaluate('__sdfish.mode') === true);
  T('toggle on: fab lit', await page.$eval('#fishfab', (el) => el.classList.contains('active')));
  T('toggle on: body.fishing set', await page.evaluate('document.body.classList.contains("fishing")'));
  T('toggle on: fish chips shown (4)', await page.$eval('#fishchips', (el) => getComputedStyle(el).display) === 'flex'
    && (await page.$$eval('#fishchips .chip', (e) => e.length)) === 4);
  T('toggle on: depth overlays active', await page.evaluate('__sdmap.overlays.has("fishdepth") && __sdmap.overlays.has("fishchart")'));
  T('attribution mentions bathymetry', await page.$eval('#attrib', (el) => /bathymetry|NOAA/.test(el.textContent)));

  console.log('\n— 🎣 Depth service registry —');
  T('Michigan center → MI DNR service', await page.evaluate('(__sdfish.fishServiceFor({lat:44.76,lng:-85.62})||{}).id') === 'mi');
  T('Iowa center → IA DNR service', await page.evaluate('(__sdfish.fishServiceFor({lat:42.0,lng:-93.5})||{}).id') === 'ia');
  T('Minnesota center → MN DNR service', await page.evaluate('(__sdfish.fishServiceFor({lat:46.2,lng:-93.65})||{}).id') === 'mn');
  T('Nevada center → no local service', await page.evaluate('__sdfish.fishServiceFor({lat:36.1,lng:-115.2})') === null);
  T('export URL shape correct', await page.evaluate(`(function(){
    const u = __sdfish.arcgisTileURL('https://x/MapServer', '4', 12, 1100, 1500);
    return u.includes('/export?f=image') && u.includes('bboxSR=3857') && u.includes('layers=show:4') && u.includes('size=256,256');
  })()`));
  T('tile bbox math sane (z1 covers hemisphere)', await page.evaluate(`(function(){
    const b = __sdfish.tileMercBBox(1, 0, 0).split(',').map(Number);
    return Math.abs(b[0] + 20037508.34) < 1 && Math.abs(b[1]) < 1 && Math.abs(b[2]) < 1 && Math.abs(b[3] - 20037508.34) < 1;
  })()`));
  T('depth layer blank below minZ', await page.evaluate('OVERLAYS.fishdepth.url(8, 10, 10) === __sdfish.BLANK_TILE'));
  T('depth layer live at z12 in MI', await page.evaluate(`(function(){
    __sdmap.setView(44.76, -85.62, 12);
    return OVERLAYS.fishdepth.url(12, 100, 100).includes('gisagocss.state.mi.us');
  })()`));
  T('depth layer live at z12 in MN', await page.evaluate(`(function(){
    __sdmap.setView(46.2, -93.65, 12);
    return OVERLAYS.fishdepth.url(12, 100, 100).includes('enterprise.gisdata.mn.gov');
  })()`));
  T('NOAA chart blank below z8, live at z10', await page.evaluate(
    'OVERLAYS.fishchart.url(7,1,1) === __sdfish.BLANK_TILE && OVERLAYS.fishchart.url(10,1,1).includes("charttools.noaa.gov")'));

  console.log('\n— 🎣 Fallback behavior —');
  await page.click('#fishfab'); /* off */
  T('toggle off: overlays removed', await page.evaluate('!__sdmap.overlays.has("fishdepth") && !__sdmap.overlays.has("fishchart")'));
  T('toggle off: chips hidden again', await page.$eval('#fishchips', (el) => getComputedStyle(el).display) === 'none');
  await page.evaluate('__sdmap.setBase("street"); __sdmap.setView(36.1, -115.2, 11)'); /* Vegas */
  await page.click('#fishfab');
  T('no-coverage area → auto Esri lake base', await page.evaluate('__sdmap.base') === 'lake');
  await page.click('#fishfab');
  T('turning off restores previous base', await page.evaluate('__sdmap.base') === 'street');

  console.log('\n— 🎣 Legend integration —');
  await page.evaluate('__sdmap.setView(44.76, -85.62, 12)');
  await page.click('#fishfab'); /* on, in MI */
  await page.click('#keyfab');
  const legendHTML = await page.$eval('#legendbody', (el) => el.innerHTML);
  T('legend shows DNR depth contours', legendHTML.includes('Lake Depth Contours'));
  T('legend shows NOAA chart key', legendHTML.includes('NOAA Depth Charts'));
  T('legend explains drop-offs', /drop-off/.test(legendHTML));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');

  console.log('\n— 🎣 Discovery: beaches with detail —');
  overpassMode = 'beaches';
  await page.evaluate('__sdmap.clearGroup("poi")');
  await page.evaluate(`(function(){ [...document.querySelectorAll('#fishchips .chip')].find(c => c.textContent.includes('Beaches')).click(); })()`);
  await page.waitForFunction('__sdmap.countGroup("poi") > 0', null, { timeout: 5000 });
  T('beach pins dropped', await page.evaluate('__sdmap.countGroup("poi")') === 2);
  T('beach card has surface + lifeguard detail', await page.evaluate(`(function(){
    const m = __sdmap.markers.find(m => m.group === 'poi' && m.popup && m.popup.includes('Clinch Park Beach'));
    return !!m && m.popup.includes('surface: sand') && m.popup.includes('lifeguard');
  })()`));
  T('beach card has dog rules', await page.evaluate(`(function(){
    const m = __sdmap.markers.find(m => m.group === 'poi' && m.popup && m.popup.includes('Dog Beach'));
    return !!m && m.popup.includes('dogs on leash') && m.popup.includes('surface: pebbles');
  })()`));

  console.log('\n— 🎣 Discovery: ramps + parking —');
  overpassMode = 'ramps';
  await page.evaluate('__sdmap.clearGroup("poi")');
  await page.evaluate(`(function(){ [...document.querySelectorAll('#fishchips .chip')].find(c => c.textContent.includes('Ramps')).click(); })()`);
  await page.waitForFunction('__sdmap.countGroup("poi") > 0', null, { timeout: 5000 });
  T('ramp + its parking pinned (3 pins: 2 ramps + 1 lot)', await page.evaluate('__sdmap.countGroup("poi")') === 3);
  T('ramp card: surface + fee + parking distance', await page.evaluate(`(function(){
    const m = __sdmap.markers.find(m => m.group === 'poi' && m.popup && m.popup.includes('Elmwood Ramp'));
    return !!m && m.popup.includes('ramp: concrete') && m.popup.includes('launch fee') && /Parking/.test(m.popup) && /ft away|right at the ramp/.test(m.popup);
  })()`));
  T('lonely ramp flags no parking', await page.evaluate(`(function(){
    const m = __sdmap.markers.find(m => m.group === 'poi' && m.popup && m.popup.includes('Lonely Ramp'));
    return !!m && m.popup.includes('No mapped parking');
  })()`));

  console.log('\n— 🎣 Rules & records —');
  T('popup fish button visible in fishing mode', await page.evaluate(`(function(){
    const m = __sdmap.markers.find(m => m.group === 'poi' && m.popup);
    __sdmap.openPopup(m);
    const b = document.querySelector('#popupbody .popbtn.fish');
    return !!b && getComputedStyle(b).display !== 'none';
  })()`));
  await page.evaluate(`(function(){ [...document.querySelectorAll('#fishchips .chip')].find(c => c.textContent.includes('Rules')).click(); })()`);
  await page.waitForFunction('document.getElementById("fishsheet").classList.contains("open")', null, { timeout: 5000 });
  const fishHTML = await page.$eval('#fishbody', (el) => el.innerHTML);
  T('intel sheet opens with state resolved', fishHTML.includes('Michigan'));
  T('official MI DNR link present', fishHTML.includes('michigan.gov/dnr/things-to-do/fishing'));
  T('MI stocking database link present', fishHTML.includes('dnr.state.mi.us/fishstock'));
  T('master angler records link present', fishHTML.includes('master-angler'));
  T('lake-specific search link uses water name', fishHTML.includes('Boardman%20Lake') || fishHTML.includes('Boardman+Lake'));
  T('links open in new tab', /target="_blank"/.test(fishHTML) && /rel="noopener"/.test(fishHTML));
  T('sheet title names the lake', (await page.$eval('#fishtitle', (el) => el.textContent)).includes('Boardman Lake'));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  await page.click('#fishfab'); /* off */
  T('popup fish button hidden when mode off', await page.evaluate(`(function(){
    const b = document.querySelector('#popupbody .popbtn.fish');
    return !b || getComputedStyle(b).display === 'none';
  })()`));

  console.log('\n— 💰 Paywall: persistence + trial —');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__SKYDOG_READY === true', null, { timeout: 10000 });
  T('unlock survives app restart', await page.evaluate('__sdfish.FISHPACK.unlocked()') === true);
  await page.click('#fishfab');
  T('restart + unlocked: fab goes straight to mode', await page.evaluate('__sdfish.mode') === true);
  await page.click('#fishfab'); /* off again */
  await page.evaluate('localStorage.clear()');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__SKYDOG_READY === true', null, { timeout: 10000 });
  T('no license → locked again', await page.evaluate('__sdfish.FISHPACK.unlocked()') === false);
  await page.click('#fishfab');
  await page.click('#paytrial');
  T('free trial enables mode for the day', await page.evaluate('__sdfish.mode') === true
    && (await page.evaluate('localStorage.getItem("sd-allaccess-trial")')) === '1');
  await page.click('#fishfab'); /* off */
  await page.evaluate('__sdpacks.PACK_STATE.allaccess._session = false');
  await page.click('#fishfab'); /* paywall again */
  T('trial is one-shot: button gone on next visit', await page.$eval('#paytrial', (el) => getComputedStyle(el).display === 'none'));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');

  console.log('\n— 👥 Buddy Trip: helpers —');
  T('buddy fab exists', (await page.$eval('#buddyfab', (el) => el.textContent.trim())) === '👥');
  T('trip codes: 5 chars, no 0/O/1/I/L lookalikes', await page.evaluate(`(function(){
    for (let i = 0; i < 50; i++){
      const c = __BUDDY.buddyCode();
      if (!/^[A-HJ-KM-NP-Z2-9]{5}$/.test(c) || /[OIL01]/.test(c)) return false;
    }
    return true;
  })()`));
  T('bearing math: N / E / SW', await page.evaluate(`(function(){
    const me = { lat: 44.76, lng: -85.62 };
    return __BUDDY.buddyBearing(me, { lat: 45.0, lng: -85.62 }) === 'N'
        && __BUDDY.buddyBearing(me, { lat: 44.76, lng: -85.0 }) === 'E'
        && __BUDDY.buddyBearing(me, { lat: 44.5, lng: -86.0 }) === 'SW';
  })()`));
  T('distance text: ft close-in, mi far, compass attached', await page.evaluate(`(function(){
    const me = { lat: 44.76, lng: -85.62 };
    const near = __BUDDY.buddyDistTxt(me, { lat: 44.7609, lng: -85.62 });
    const far  = __BUDDY.buddyDistTxt(me, { lat: 45.2, lng: -85.62 });
    return /^\\d+ ft N$/.test(near) && /mi N$/.test(far);
  })()`));
  T('buddy colors deterministic per member', await page.evaluate(
    '__BUDDY.buddyColor("abc") === __BUDDY.buddyColor("abc") && /^#/.test(__BUDDY.buddyColor("abc"))'));

  console.log('\n— 👥 Buddy Trip: consent gate —');
  await page.evaluate('__sdwheel.jumpTo("buddy")');   /* spin the wheel so 👥 is tappable */
  await page.click('#buddyfab');
  T('fab opens buddy sheet', await page.$eval('#buddysheet', (el) => el.classList.contains('open')));
  await page.fill('#buddyname', 'Tester');
  await page.click('#buddystart');
  T('no consent yet → consent sheet, trip NOT started', await page.$eval('#buddyconsent', (el) => el.classList.contains('open'))
    && await page.evaluate('__BUDDY.BUDDY.active()') === false);
  await page.click('#buddynope');
  T('cancel consent → still no trip, nothing stored', await page.evaluate('__BUDDY.BUDDY.active()') === false
    && await page.evaluate('localStorage.getItem("sd-buddy-consent")') === null);
  await page.evaluate('__sdwheel.jumpTo("buddy")');
  await page.click('#buddyfab');
  await page.click('#buddystart');
  await page.click('#buddyagree');
  await page.waitForFunction('__BUDDY.BUDDY.active() === true', null, { timeout: 5000 });
  T('agree → consent persisted + trip live', await page.evaluate('localStorage.getItem("sd-buddy-consent")') === '1');

  console.log('\n— 👥 Buddy Trip: live room —');
  const tripCode = await page.evaluate('__BUDDY.BUDDY.code');
  T('room code shown in sheet', (await page.$eval('#buddycodeshow', (el) => el.textContent)) === tripCode && /^[A-Z2-9]{5}$/.test(tripCode));
  T('sharing pill visible', await page.$eval('#buddypill', (el) => getComputedStyle(el).display !== 'none'));
  T('onDisconnect cleanup armed on MY member path', await page.evaluate('window.__fbOD') === 'trips/' + tripCode + '/members/' + (await page.evaluate('__BUDDY.BUDDY.memberId')));
  T('subscribed to the room members path', await page.evaluate('!!(window.__fbCBs && window.__fbCBs["trips/' + tripCode + '/members"])'));
  /* push two fake buddies (one fresh, one stale pet) through the stub's listener */
  await page.evaluate(`(function(){
    __BUDDY.BUDDY.notePos(44.76, -85.62);
    const members = {};
    members[__BUDDY.BUDDY.memberId] = { name: 'Tester', lat: 44.76, lng: -85.62, ts: Date.now(), kind: 'person', color: '#4aa3ff' };
    members['ava1'] = { name: 'Ava', lat: 44.7609, lng: -85.62, ts: Date.now(), kind: 'person', color: '#ff7a59' };
    members['rex1'] = { name: 'Rex', lat: 44.7700, lng: -85.62, ts: Date.now() - 90000, kind: 'pet', color: '#ffd166' };
    window.__fbCBs['trips/' + __BUDDY.BUDDY.code + '/members']({ val: function(){ return members; } });
  })()`);
  T('2 buddy dots on map (self excluded)', await page.evaluate('__sdmap.countGroup("buddy")') === 2);
  T('fresh buddy label: name + distance + bearing', await page.evaluate(`(function(){
    const el = [...document.querySelectorAll('.bdymark .bname')].find(e => e.textContent.includes('Ava'));
    return !!el && /\\d+ ft N/.test(el.textContent);
  })()`));
  T('stale pet: 🐾 + last seen + dimmed', await page.evaluate(`(function(){
    const el = [...document.querySelectorAll('.bdymark')].find(e => e.textContent.includes('Rex'));
    return !!el && el.classList.contains('stale') && el.textContent.includes('🐾') && /last seen \\d+s/.test(el.textContent);
  })()`));
  T('pill counts crew (2)', (await page.$eval('#buddycount', (el) => el.textContent)) === '2');
  T('member list rows rendered (2)', await page.$$eval('#buddylist .buddyrow', (e) => e.length) === 2);

  console.log('\n— 👥 Buddy Trip: background/foreground survival —');
  /* Regression: backgrounding to send the invite must NOT tear the trip down. */
  const rmBefore = await page.evaluate('(window.__fbRemoves || []).length');
  await page.evaluate('window.dispatchEvent(new Event("pagehide"))');
  T('pagehide keeps the trip alive (no teardown on backgrounding)',
    await page.evaluate('__BUDDY.BUDDY.active()') === true
    && await page.evaluate('(window.__fbRemoves || []).length') === rmBefore);
  /* Regression: returning to the foreground re-arms presence. */
  const myMemberPath = 'trips/' + tripCode + '/members/' + (await page.evaluate('__BUDDY.BUDDY.memberId'));
  await page.evaluate('window.__fbOD = null; window.__fbOffed = null;');
  await page.evaluate(`(function(){
    try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); } catch(e){}
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  await page.waitForFunction('window.__fbOD !== null', null, { timeout: 3000 });
  T('foreground resume re-arms onDisconnect on my member',
    await page.evaluate('window.__fbOD') === myMemberPath);
  T('foreground resume re-attaches the room listener',
    await page.evaluate('window.__fbOffed') === 'trips/' + tripCode + '/members'
    && await page.evaluate('!!(window.__fbCBs && window.__fbCBs["trips/' + tripCode + '/members"])'));

  console.log('\n— 👥 Buddy Trip: end = privacy —');
  await page.click('#buddyend');
  T('end → trip inactive + pill gone', await page.evaluate('__BUDDY.BUDDY.active()') === false
    && await page.$eval('#buddypill', (el) => getComputedStyle(el).display === 'none'));
  T('end → my member removed from the room', await page.evaluate(
    '(window.__fbRemoves || []).includes("trips/' + tripCode + '/members/" + __BUDDY.BUDDY.memberIdGet())'));
  T('end → map cleared of buddy dots', await page.evaluate('__sdmap.countGroup("buddy")') === 0);
  T('end → listener detached', await page.evaluate('window.__fbOffed') === 'trips/' + tripCode + '/members');

  console.log('\n— 👥 Buddy Trip: invite link —');
  /* First-timer (no consent yet): the link prefills + opens the join sheet, and does NOT auto-join. */
  await page.evaluate('localStorage.removeItem("sd-buddy-consent")');
  await page.goto('http://localhost:' + PORT + '/?buddy=abmxz', { waitUntil: 'load' });
  await page.waitForFunction('window.__SKYDOG_READY === true', null, { timeout: 10000 });
  T('invite (no consent) opens sheet with code prefilled, no auto-join',
    await page.$eval('#buddysheet', (el) => el.classList.contains('open'))
    && (await page.$eval('#buddycode', (el) => el.value)) === 'ABMXZ'
    && await page.evaluate('__BUDDY.BUDDY.active()') === false);
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  /* Returning user (already consented): the link joins the room straight from the tap. */
  await page.evaluate('localStorage.setItem("sd-buddy-consent", "1")');
  await page.goto('http://localhost:' + PORT + '/?buddy=abqrs', { waitUntil: 'load' });
  await page.waitForFunction('window.__SKYDOG_READY === true', null, { timeout: 10000 });
  await page.waitForFunction('window.__BUDDY && __BUDDY.BUDDY.active() === true', null, { timeout: 5000 });
  T('invite (consented) auto-joins the room from the link',
    (await page.evaluate('__BUDDY.BUDDY.code')) === 'ABQRS');
  await page.evaluate('__BUDDY.BUDDY.end(true)');

  console.log('\n— 🎒 Packs system (one paywall) —');
  T('packs config: fishing + drone + orv + All Access bundle', await page.evaluate(
    '!!(__sdpacks.PACKS_CONFIG.packs.fishing && __sdpacks.PACKS_CONFIG.packs.drone && __sdpacks.PACKS_CONFIG.packs.orv && __sdpacks.PACKS_CONFIG.bundle)'));
  T('All Access is the ONE sellable product ($2.99/mo sub)', await page.evaluate(`(function(){
    const C = __sdpacks.PACKS_CONFIG;
    const separately = Object.values(C.packs).some(p => p.sellable);
    return !separately && C.bundle.price === '$2.99/mo' && C.bundle.product.type === 'subs'
      && C.bundle.product.ios === 'com.skydog.skygps.allaccess.monthly';
  })()`));
  T('legacy fishing one-time product still honored', await page.evaluate(
    '__sdpacks.PACKS_CONFIG.packs.fishing.product.ios === "com.skydog.skygps.fishingpack" && __sdpacks.PACKS_CONFIG.packs.fishing.product.type === "inapp"'));
  await page.click('#packsfab');
  T('🎒 fab opens the store sheet', await page.$eval('#packsheet', (el) => el.classList.contains('open')));
  T('store lists every pack (3 cards, config-driven)', await page.$$eval('#packlist .packcard', (e) => e.length) === 3);
  T('one subscribe button at the bundle price', (await page.$eval('#packsub', (el) => el.textContent)).includes('$2.99'));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  T('all-access entitlement unlocks every pack (incl ORV)', await page.evaluate(`(function(){
    localStorage.setItem('sd-allaccess-iap', '1');
    const ok = __sdpacks.Entitlements.isUnlocked('drone') && __sdpacks.Entitlements.isUnlocked('fishing')
      && __sdpacks.Entitlements.isUnlocked('orv');
    localStorage.setItem('sd-allaccess-iap', '0');
    return ok && !__sdpacks.Entitlements.isUnlocked('orv');
  })()`));

  console.log('\n— 🚁 Drone Pack: gating + unlock —');
  T('drone fab exists', (await page.$eval('#dronefab', (el) => el.textContent.trim())) === '🚁');
  await page.click('#dronefab');
  T('locked: drone fab opens the paywall, not the mode', await page.evaluate('__sddrone.mode') === false
    && await page.$eval('#paysheet', (el) => el.classList.contains('open'))
    && (await page.$eval('#paytitle', (el) => el.textContent)).includes('Drone'));
  T('drone checksum rejects bad codes', await page.evaluate(
    '!__sdpacks.packCodeOK("DRONE", "DRONE-AAAA") && !__sdpacks.packCodeOK("DRONE", "nope")'));
  await page.fill('#paycode', 'drone-aa2a'); /* lowercase on purpose — must normalize */
  await page.click('#payunlock');
  T('valid DRONE code unlocks + enables Drone Mode', await page.evaluate('__sddrone.mode') === true
    && !(await page.$eval('#paysheet', (el) => el.classList.contains('open'))));
  T('drone license persisted on device', await page.evaluate('localStorage.getItem("sd-dronepack")') === 'DRONE-AA2A');
  T('drone fab lit + hud shown', await page.$eval('#dronefab', (el) => el.classList.contains('active'))
    && await page.$eval('#dronehud', (el) => getComputedStyle(el).display !== 'none'));
  T('attribution credits FAA + Open-Meteo', await page.$eval('#attrib', (el) => /FAA/.test(el.textContent) && /Open-Meteo/.test(el.textContent)));

  console.log('\n— 🚁 Airspace grid + fixed sites —');
  await page.evaluate('__sdmap.setView(44.76, -85.58, 12)');
  await page.evaluate('__sddrone.refreshDrone()');
  T('UASFM grid cells cached (2)', await page.evaluate('__sddrone.airspace.cells.size') === 2);
  T('fixed site pinned with popup', await page.evaluate('__sdmap.countGroup("dronesite")') === 1
    && await page.evaluate(`(function(){
      const m = __sdmap.markers.find(m => m.group === 'dronesite');
      return !!m && m.popup.includes('TC Flyers Field') && m.popup.includes('400 ft');
    })()`));
  T('0-ft cell → danger readout at center', await page.evaluate(`(function(){
    const s = __sddrone.droneAirspaceSummary(44.76, -85.58);
    return s.level === 'danger' && s.ceiling === 0;
  })()`));
  T('hud shows the red 0-ft warning', await page.$eval('#dh-air', (el) => el.className.includes('lvl-danger') && el.textContent.includes('0 ft')));
  T('400-ft cell → caution with ceiling', await page.evaluate(`(function(){
    const s = __sddrone.droneAirspaceSummary(44.76, -85.52);
    return s.level === 'caution' && s.ceiling === 400;
  })()`));
  T('outside every grid → clear to 400', await page.evaluate(`(function(){
    const s = __sddrone.droneAirspaceSummary(44.76, -85.90);
    return s.level === 'ok' && s.ceiling === 400 && s.cell === null;
  })()`));
  T('grid colors: red at 0, green at 400 (config-driven)', await page.evaluate(
    '__sddrone.droneColor(0).fill.includes("255,90,90") && __sddrone.droneColor(400).fill.includes("53,224,138")'));
  const faa0 = faaHits;
  await page.evaluate('__sddrone.refreshDrone()');
  T('airspace cached — second refresh skips refetch', faaHits === faa0);

  console.log('\n— 💨 Conditions readout —');
  T('free temp badge visible for everyone', await page.$eval('#tempbadge', (el) => getComputedStyle(el).display !== 'none' && el.textContent.includes('72°')));
  T('hud wind row: speed + direction + gusts + temp', await page.$eval('#dh-wind',
    (el) => /\b8\b/.test(el.textContent) && /W/.test(el.textContent) && /gusts\s*12/.test(el.textContent) && /72°F/.test(el.textContent)));
  T('hud wind dot is green at 8 mph', await page.$eval('#dh-wind', (el) => el.className.includes('lvl-ok')));
  T('wind safety thresholds are config-driven + gust rule', await page.evaluate(`(function(){
    const W = __sddrone;
    return W.windLevel(8, 10) === 'ok' && W.windLevel(15, 18) === 'caution'
      && W.windLevel(25, 30) === 'danger' && W.windLevel(5, 30) === 'danger'
      && W.WX_CFG.windCautionMph === 10 && W.WX_CFG.windDangerMph === 20;
  })()`));

  console.log('\n— 🛫 LAANC seam (architected, never faked) —');
  T('check: 0-ft grid at 200 ft → required, NOT auto-approvable', await page.evaluate(`(function(){
    const v = __sddrone.LaancService.check(44.76, -85.58, 200);
    return v.required === true && v.autoApprovable === false && v.laancAvailable === true;
  })()`));
  T('check: 400-ft grid at 200 ft → auto-approvable', await page.evaluate(`(function(){
    const v = __sddrone.LaancService.check(44.76, -85.52, 200);
    return v.required === true && v.autoApprovable === true;
  })()`));
  T('check: open country at 300 ft → no authorization needed', await page.evaluate(
    '__sddrone.LaancService.check(44.76, -85.90, 300).required === false'));
  await page.evaluate('(function(){ document.getElementById("dh-check").click(); })()');
  T('flight check sheet opens with a verdict', await page.$eval('#dronesheet', (el) => el.classList.contains('open'))
    && await page.$eval('#laancverdict', (el) => el.textContent.length > 20));
  await page.click('#laancreq');
  T('request → clearly-labeled placeholder ("coming soon")', await page.$eval('#laancresult', (el) => /coming/i.test(el.textContent)));
  T('placeholder provider is marked not-live', await page.evaluate('__sddrone.laancProvider.live === false'));
  T('request resolves unavailable — no fake approvals possible', await page.evaluate(
    `__sddrone.LaancService.request({lat:44.76,lng:-85.58,altFt:200,startISO:'x',durationMin:30}).then(r => r.status === 'unavailable')`));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  await page.click('#dronefab'); /* drone off */
  T('toggle off: hud hidden + sites cleared', await page.$eval('#dronehud', (el) => getComputedStyle(el).display === 'none')
    && await page.evaluate('__sdmap.countGroup("dronesite")') === 0);

  console.log('\n— 🎡 Mode Wheel (free core navigation) —');
  await page.evaluate('__sdwheel.jumpTo("fishing")');
  T('wheel holds every mode in cyclic order', JSON.stringify(await page.evaluate('__sdwheel.order'))
    === JSON.stringify(['fishing', 'drone', 'orv', 'buddy', 'spots', 'store']));
  T('every configured pack auto-appears on the wheel', await page.evaluate(
    'Object.keys(__sdpacks.PACKS_CONFIG.packs).every((id) => __sdwheel.order.includes(id))'));
  T('front slot enlarged + marked', await page.evaluate('__sdwheel.front') === 'fishing'
    && await page.$eval('#fishfab', (el) => el.classList.contains('front') && /scale\(1\.4/.test(el.style.transform)));
  T('cyclic wrap: last item is one flick behind the front', await page.evaluate('__sdwheel.delta(5)') === -1);
  T('flick snaps to a firm detent (never free-floats)', await page.evaluate(`(function(){
    __sdwheel.spinBy(1.4);
    const drifting = __sdwheel.pos;
    __sdwheel.settle();
    return Math.abs(drifting - 1.4) < 1e-9 && __sdwheel.pos === 1 && __sdwheel.front === 'drone';
  })()`));
  T('locked pack wears a 🔒, unlocked pack does not', await page.$eval('#orvfab', (el) => el.classList.contains('locked'))
    && await page.$eval('#dronefab', (el) => !el.classList.contains('locked')));
  T('non-mode controls stay OUTSIDE the wheel (one tap)', await page.evaluate(
    'document.querySelectorAll("#fabs .fab").length === 7 && !!document.querySelector("#fabs #locatefab") && !document.querySelector("#fabs #fishfab")'));
  T('wheel discovery hint is one-shot', await page.evaluate('localStorage.getItem("sd-wheel-hint")') === '1');

  console.log('\n— 🏔 ORV Trails: gating + unlock —');
  T('orv fab exists on the wheel', (await page.$eval('#orvfab', (el) => el.textContent.trim())) === '🏔');
  T('orv pack config: bundle-only, ORV- codes, sd-orvpack', await page.evaluate(`(function(){
    const p = __sdpacks.PACKS_CONFIG.packs.orv;
    return p && p.sellable === false && p.storeKey === 'sd-orvpack' && p.web.codePrefix === 'ORV' && p.product === null;
  })()`));
  await page.evaluate('__sdwheel.jumpTo("orv")');
  await page.click('#orvfab');
  T('locked: orv fab opens the paywall spotlighting ORV', await page.evaluate('__sdorv.mode') === false
    && await page.$eval('#paysheet', (el) => el.classList.contains('open'))
    && (await page.$eval('#paytitle', (el) => el.textContent)).includes('ORV'));
  T('orv checksum rejects bad codes', await page.evaluate(
    '!__sdpacks.packCodeOK("ORV", "ORV-AAAA") && !__sdpacks.packCodeOK("ORV", "nope") && !__sdpacks.packCodeOK("ORV", "")'));
  await page.fill('#paycode', 'orv-aa2a'); /* lowercase on purpose — must normalize */
  await page.click('#payunlock');
  T('valid ORV code unlocks + enables Trail Mode', await page.evaluate('__sdorv.mode') === true
    && !(await page.$eval('#paysheet', (el) => el.classList.contains('open'))));
  T('orv license persisted on device', await page.evaluate('localStorage.getItem("sd-orvpack")') === 'ORV-AA2A');
  T('orv fab lit + layer chips shown', await page.$eval('#orvfab', (el) => el.classList.contains('active'))
    && await page.$eval('#orvchips', (el) => getComputedStyle(el).display === 'flex'));
  T('attribution credits Michigan DNR', await page.$eval('#attrib', (el) => /Michigan DNR/.test(el.textContent)));

  console.log('\n— 🏔 Trail network: fetch, cache & zoom gate —');
  await page.evaluate('__sdmap.setView(44.76, -85.58, 12)');
  await page.evaluate('__sdorv.refreshOrv()');
  T('DNR trails cached across all 5 layers (6 features)', await page.evaluate('__sdorv.trails.trails.size') === 6);
  T('snowmobile trail parsed: name + open', await page.evaluate(`(function(){
    const t = [...__sdorv.trails.trails.values()].find((x) => x.name === 'Blue Bear Trail');
    return !!t && t.key === 'snow' && t.open === true;
  })()`));
  T('closed snowmobile trail flagged closed', await page.evaluate(`(function(){
    const t = [...__sdorv.trails.trails.values()].find((x) => x.name === 'Old Logging Run');
    return !!t && t.open === false;
  })()`));
  T('temporary closure always renders closed', await page.evaluate(`(function(){
    const t = [...__sdorv.trails.trails.values()].find((x) => x.key === 'closures');
    return !!t && t.open === false && t.name.includes('Bridge Out');
  })()`));
  const dnr0 = dnrHits;
  await page.evaluate('__sdorv.refreshOrv()');
  T('trail cache — second refresh skips refetch', dnrHits === dnr0);
  await page.evaluate('__sdmap.setView(42.0, -84.0, 8)');
  await page.evaluate('__sdorv.refreshOrv()');
  T('zoom gate — no fetch below minFetchZoom', dnrHits === dnr0
    && await page.evaluate('__sdorv.ORV_CFG.minFetchZoom') === 9);
  await page.evaluate('__sdmap.setView(44.76, -85.58, 12)');
  T('trail styles: distinct high-contrast cores + dashed closed/closures', await page.evaluate(`(function(){
    const S = __sdorv.ORV_CFG.styles;
    const cores = [S.snow.core, S.orv.core, S.moto.core];
    return new Set(cores).size === 3 && !!S.closed.dash && !!S.closures.dash
      && __sdorv.orvStyleFor({key:'snow', open:false}).dash && __sdorv.orvStyleFor({key:'closures'}) === S.closures;
  })()`));
  T('trailAt finds the line under a tap', await page.evaluate(
    '(__sdorv.trailAt(44.76, -85.60, 0.002) || {}).name') === 'Blue Bear Trail');
  T('tap a trail → info popup with name + type', await page.evaluate(`(function(){
    const hit = __sdorv.tapInfo(44.76, -85.60);
    const body = document.getElementById('popupbody').innerHTML;
    return hit === true && body.includes('Blue Bear Trail') && body.includes('Snowmobile');
  })()`));
  T('layer registry data-driven: 7 toggle chips (4 trail + 3 point)', await page.$$eval('#orvchips .chip', (e) => e.length) === 7
    && await page.evaluate('Object.keys(__sdorv.ORV_LAYERS).length') === 7
    && await page.evaluate('Object.keys(__sdorv.ORV_POINT_CATS).length') === 3);
  T('owner points pinned with popups (3 seeded examples)', await page.evaluate('__sdmap.countGroup("orvpoint")') === 3
    && await page.evaluate(`(function(){
      const m = __sdmap.markers.find((x) => x.group === 'orvpoint' && x.popup && x.popup.includes('Gas'));
      return !!m && m.popup.includes('Pit stop');
    })()`));
  T('point layer toggle hides just that category', await page.evaluate(`(function(){
    __sdorv.ORV_LAYERS.pit.on = false;
    __sdorv.renderOrvPoints();
    const hidden = __sdmap.countGroup('orvpoint') === 2;
    __sdorv.ORV_LAYERS.pit.on = true;
    __sdorv.renderOrvPoints();
    return hidden && __sdmap.countGroup('orvpoint') === 3;
  })()`));
  T('trail layer toggle skips taps on that layer', await page.evaluate(`(function(){
    __sdorv.ORV_LAYERS.snow.on = false;
    const missed = __sdorv.trailAt(44.76, -85.60, 0.002) === null;
    __sdorv.ORV_LAYERS.snow.on = true;
    return missed;
  })()`));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  await page.evaluate('__sdwheel.jumpTo("orv")');
  await page.click('#orvfab'); /* trail mode off */
  T('toggle off: points + info cleared, drawHook released', await page.evaluate('__sdorv.mode') === false
    && await page.evaluate('__sdmap.countGroup("orvpoint")') === 0
    && await page.evaluate('__sdmap.drawHook === null'));
  T('drone & orv never fight over the canvas hook', await page.evaluate(`(function(){
    __sdorv.setOrvMode(true);
    __sddrone.setDroneMode(true);        /* drone kicks orv off the hook */
    const droneOwns = !__sdorv.mode && __sddrone.mode;
    __sdorv.setOrvMode(true);            /* orv kicks drone back off */
    const orvOwns = __sdorv.mode && !__sddrone.mode;
    __sdorv.setOrvMode(false);
    return droneOwns && orvOwns;
  })()`));

  console.log('\n— 📍 My Spots (free for everyone) —');
  T('spots fab on the wheel', (await page.$eval('#spotsfab', (el) => el.textContent.trim())) === '➕');
  await page.evaluate('__sdwheel.jumpTo("spots")');
  await page.click('#spotsfab');
  T('➕ opens My Spots sheet with empty state', await page.$eval('#spotsheet', (el) => el.classList.contains('open'))
    && (await page.$eval('#spotlist', (el) => el.textContent)).includes('No spots yet'));
  await page.click('#spottap');
  T('tap-to-place arms placement mode', await page.evaluate('__sdspots.placing') === true
    && !(await page.$eval('#spotsheet', (el) => el.classList.contains('open'))));
  await page.evaluate('__sdspots.placeAt(44.761, -85.615)');
  T('placement opens the save form', await page.$eval('#spoteditsheet', (el) => el.classList.contains('open'))
    && await page.evaluate('__sdspots.placing') === false);
  await page.fill('#spotname', 'Walleye Hole');
  await page.fill('#spotnotes', 'drops to 40 ft off the point');
  await page.evaluate(`(function(){ [...document.querySelectorAll('#spoticons button')].find((b) => b.textContent === '🎣').click(); })()`);
  await page.click('#spotsave');
  T('spot saved + pinned on the map', await page.evaluate('__sdspots.MYSPOTS.list.length') === 1
    && await page.evaluate('__sdmap.countGroup("myspot")') === 1);
  T('persisted via sdStore only (sd-myspots)', await page.evaluate(`(function(){
    const l = JSON.parse(localStorage.getItem('sd-myspots'));
    return l.length === 1 && l[0].name === 'Walleye Hole' && l[0].icon === '🎣' && l[0].notes.includes('40 ft');
  })()`));
  T('spot popup offers edit + drive', await page.evaluate(`(function(){
    const m = __sdmap.markers.find((x) => x.group === 'myspot');
    return !!m && m.popup.includes('Edit') && m.popup.includes('Drive') && m.popup.includes('Walleye Hole');
  })()`));
  await page.evaluate(`__sdspots.editUI(__sdspots.MYSPOTS.list[0].id)`);
  T('edit prefills the form + shows delete', (await page.$eval('#spotname', (el) => el.value)) === 'Walleye Hole'
    && await page.$eval('#spotdelete', (el) => getComputedStyle(el).display !== 'none'));
  await page.fill('#spotname', 'Walleye Hole West');
  await page.click('#spotsave');
  T('edit saves in place (no duplicate)', await page.evaluate('__sdspots.MYSPOTS.list.length') === 1
    && await page.evaluate('__sdspots.MYSPOTS.list[0].name') === 'Walleye Hole West');
  T('spots layer toggles off/on', await page.evaluate(`(function(){
    __sdspots.setShow(false);
    const off = __sdmap.countGroup('myspot') === 0;
    __sdspots.setShow(true);
    return off && __sdmap.countGroup('myspot') === 1;
  })()`));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__SKYDOG_READY === true', null, { timeout: 10000 });
  T('spots survive app restart (phone-local)', await page.evaluate('__sdspots.MYSPOTS.list.length') === 1
    && await page.evaluate('__sdmap.countGroup("myspot")') === 1);
  await page.evaluate(`__sdspots.editUI(__sdspots.MYSPOTS.list[0].id)`);
  await page.click('#spotdelete');
  T('delete removes spot, pin & storage', await page.evaluate('__sdspots.MYSPOTS.list.length') === 0
    && await page.evaluate('__sdmap.countGroup("myspot")') === 0
    && await page.evaluate('localStorage.getItem("sd-myspots")') === '[]');

  console.log('\n— 📢 Ads stay for everyone —');
  const appSrc = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  T('ADS ARE PERMANENT rule documented at the ad init', appSrc.includes('ADS ARE PERMANENT'));
  T('no purchase copy promises ad removal', !/removes ads|ads gone|ad-free|removes the ads/i.test(appSrc));
  T('grant path never touches the ad banner', !appSrc.slice(appSrc.indexOf('function sdGrantPack')).includes('SkyGPSAds.remove'));

  console.log('\n— Fail-loud + shell —');
  await page.evaluate('window.dispatchEvent(new ErrorEvent("error", { message: "test-explosion" }))');
  T('window error → fatal banner shows', await page.$eval('#fatal', (el) => getComputedStyle(el).display !== 'none' && el.textContent.includes('test-explosion')));
  await page.evaluate('(function(){ document.getElementById("fatal").click(); })()');
  const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  T('sw.js cache bumped to v16', sw.includes("skydog-gps-v16") && !sw.includes("skydog-gps-v15"));
  T('buddy system points at the ce24a database (locked rules, no expiry)', (function(){
    const src = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    return src.includes('skydog-gps-ce24a-default-rtdb.firebaseio.com') && !src.includes('https://skydog-gps-default-rtdb');
  })());
  T('still zero unexpected page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  T('single self-contained file (no CDN/script src)', !/<script[^>]+src=/.test(fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8')));
  T('localStorage touched only inside guarded sdStore (2 refs)',
    (fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8').match(/localStorage/g) || []).length === 2);

  await browser.close();
  server.close();

  console.log('\n==============================');
  console.log('  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  ❌ FAILURES:' : '  — 100% ✅'));
  failures.forEach((f) => console.log('   • ' + f));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASH:', e); process.exit(2); });
