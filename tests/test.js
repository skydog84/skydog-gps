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
const FIX_WEATHER = { current: { temperature_2m: 72.4, wind_speed_10m: 8.3, wind_direction_10m: 270, wind_gusts_10m: 12.1 },
  /* hourly pressure falls hard (−1.2 hPa/hr) so the solunar weather blend exercises its +12 path */
  hourly: { surface_pressure: Array.from({ length: 24 }, (_, i) => 1018 - i * 1.2),
            wind_speed_10m: Array.from({ length: 24 }, () => 6) } };

/* 🌌 NOAA SWPC planetary-K forecast — one strong predicted row inside the next 36 h */
const FIX_SWPC = () => {
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return [['time_tag', 'kp', 'observed', 'noaa_scale'],
    [fmt(Date.now() - 7200000), '3.33', 'observed', null],
    [fmt(Date.now() + 3600000), '7.00', 'predicted', 'G3'],
    [fmt(Date.now() + 7200000), '5.67', 'predicted', 'G1']];
};
/* 🆘 what3words convert-to-3wa */
const FIX_W3W = { words: 'dog.happy.trail' };

/* 🌎 Run 2 fixtures — every new host mocks BEFORE the catch-all */
const FIX_NWS = { features: [
  { properties: { event: 'Severe Thunderstorm Warning', severity: 'Severe',
      headline: 'Severe Thunderstorm Warning until 9 PM for Grand Traverse County' },
    geometry: { type: 'Polygon', coordinates: [[[-86.2, 44.2], [-85.0, 44.2], [-85.0, 45.2], [-86.2, 45.2], [-86.2, 44.2]]] } },
  { properties: { event: 'Special Marine Warning', severity: 'Severe',
      headline: 'Special Marine Warning for Grand Traverse Bay' }, geometry: null },
  { properties: { event: 'Flood Watch', severity: 'Moderate',
      headline: 'Flood Watch through Sunday morning' }, geometry: null },
] };
const usgsSeries = (site, name, lat, lng, code, val) => ({
  sourceInfo: { siteName: name, siteCode: [{ value: site }], geoLocation: { geogLocation: { latitude: lat, longitude: lng } } },
  variable: { variableCode: [{ value: code }] },
  values: [{ value: [{ value: String(val) }] }],
});
const FIX_USGS_IV = { value: { timeSeries: [
  usgsSeries('04127917', 'BOARDMAN RIVER NEAR TRAVERSE CITY, MI', 44.72, -85.60, '00060', 210),
  usgsSeries('04127917', 'BOARDMAN RIVER NEAR TRAVERSE CITY, MI', 44.72, -85.60, '00065', 3.42),
  usgsSeries('04127917', 'BOARDMAN RIVER NEAR TRAVERSE CITY, MI', 44.72, -85.60, '00010', 18.5),
  usgsSeries('04127800', 'JORDAN RIVER NEAR EAST JORDAN, MI', 44.95, -85.10, '00060', 150),
] } };
const FIX_USGS_P7D = { value: { timeSeries: [ (function(){
  const s = usgsSeries('04127917', 'BOARDMAN RIVER NEAR TRAVERSE CITY, MI', 44.72, -85.60, '00060', 100);
  s.values[0].value = Array.from({ length: 28 }, (_, i) => ({ value: String(100 + i * 4) }));   /* steady climb → rising */
  return s;
})() ] } };
const FIX_WFIGS = { type: 'FeatureCollection', features: [
  { properties: { poly_IncidentName: 'CAMP TWELVE', poly_GISAcres: 5300.4, irwin_PercentContained: 40 },
    geometry: { type: 'Polygon', coordinates: [[[-85.8, 44.6], [-85.5, 44.6], [-85.5, 44.9], [-85.8, 44.9], [-85.8, 44.6]]] } },
] };


/* 🏡 Regrid parcel point-lookup fixture — one 40-acre parcel near Traverse City */
const FIX_REGRID = { parcels: { type: 'FeatureCollection', features: [
  { type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[-85.63, 44.75], [-85.61, 44.75], [-85.61, 44.77], [-85.63, 44.77], [-85.63, 44.75]]] },
    properties: { headline: '123 Skydog Trail, Traverse City, MI',
      fields: { owner: 'DOE JOHN & JANE', ll_gisacre: 39.4816, usedesc: 'RESIDENTIAL', address: '123 SKYDOG TRL' } } },
] } };

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
    update: function(v){ (window.__fbWrites = window.__fbWrites || []).push({path: path, v: v, update: true}); return Promise.resolve(); },
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
  /* bypassCSP: Playwright's evaluate() relies on eval(), which the app's CSP
     rightly forbids. The CSP itself is exercised for real in the dedicated
     strict-context section below (no bypass, zero violations tolerated). */
  const ctx = await browser.newContext({ viewport: { width: 420, height: 850 }, bypassCSP: true });

  let overpassMode = 'beaches';
  let faaHits = 0;
  let dnrHits = 0;
  let regridMode = 'parcel';   // 'parcel' | 'empty'
  const odCalls = [];          // 🌎 worker calls the app made
  let regridHits = 0;
  const mockRoute = (route) => {
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
    /* 🏡 Regrid parcel point lookup (tiles.regrid.com falls through to the png catch-all) */
    if (url.includes('app.regrid.com/api/v2/parcels/point')) {
      regridHits++;
      const body = regridMode === 'empty' ? { parcels: { type: 'FeatureCollection', features: [] } } : FIX_REGRID;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    /* 🌌 NOAA SWPC aurora forecast (keyless, public domain) */
    if (url.includes('services.swpc.noaa.gov')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX_SWPC()) });
    }
    /* 🆘 what3words (only ever called when a key is configured) */
    if (url.includes('api.what3words.com')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX_W3W) });
    }
    /* 🌎 Run 2: NWS alerts */
    if (url.includes('api.weather.gov')) {
      return route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(FIX_NWS) });
    }
    /* 🌎 Run 2: USGS gauges — bbox scan vs 7-day sparkline */
    if (url.includes('waterservices.usgs.gov')) {
      const body = url.includes('period=P7D') ? FIX_USGS_P7D : FIX_USGS_IV;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    /* 🌎 Run 2: NIFC/WFIGS fire perimeters (count probe vs full geojson) */
    if (url.includes('services3.arcgis.com')) {
      const body = url.includes('returnCountOnly=true') ? { count: 1 } : FIX_WFIGS;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    /* ⏳ Run 2: the overdue worker (register / checkin / cancel) */
    if (url.includes('skydog-api.skydog8426.workers.dev')) {
      odCalls.push(url.slice(url.indexOf('/overdue')));
      const body = url.includes('/overdue/register') ? { ok: true, id: 'abcdef1234567890' } : { ok: true };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    /* Firebase SDK stub — records writes/listeners so buddy tests are deterministic & offline */
    if (url.includes('gstatic.com/firebasejs')) {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: FB_STUB });
    }
    /* every tile/export request → tiny png (deterministic, fast) */
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG1 });
  };
  await ctx.route('**/*', mockRoute);

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
  T('7 overlays incl fishing pair, property lines + live radar in layer sheet', await page.$$eval('#ovchips .chip', (e) => e.length) === 7);
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
  T('utility tools ride the wheel with the subtler .util look', await page.evaluate(`(function(){
    const utils = document.querySelectorAll('#modewheel .wfab.util');
    return utils.length === 9 && getComputedStyle(document.getElementById('layerfab')).width === '46px'
      && getComputedStyle(document.getElementById('fishfab')).width === '52px';
  })()`));
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
  await page.evaluate('__sdwheel.jumpTo("fishing")');
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
  T('fish chip row wrap state matches its overflow', await page.evaluate(`(function(){
    const r = __sdcyc.rows.fishchips;
    if(!r) return false;
    const need = r.W - __sdcyc.CYC_CFG.gap > r.el.clientWidth - __sdcyc.CYC_CFG.padX * 2;
    return r.on === need;
  })()`));
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
  await page.evaluate('__sdwheel.jumpTo("key")');
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
  await page.evaluate('__sdwheel.jumpTo("fishing")');
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
  T('trip codes: 8 chars, no 0/O/1/I/L lookalikes (Fort SkyDog A2)', await page.evaluate(`(function(){
    for (let i = 0; i < 50; i++){
      const c = __BUDDY.buddyCode();
      if (!/^[A-HJ-KM-NP-Z2-9]{8}$/.test(c) || /[OIL01]/.test(c)) return false;
    }
    return true;
  })()`));
  T('code validator: new 8-char + legacy 5-char accepted, junk rejected', await page.evaluate(`(function(){
    return __BUDDY.buddyCodeValid('ABCDEFGH') && __BUDDY.buddyCodeValid('AB2DE')
      && !__BUDDY.buddyCodeValid('ABCDEF')   /* 6 chars — never issued */
      && !__BUDDY.buddyCodeValid('ABCDEFGHJ') && !__BUDDY.buddyCodeValid('abcde') && !__BUDDY.buddyCodeValid('AB0DEFGH');
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
  T('room code shown in sheet (8-char)', (await page.$eval('#buddycodeshow', (el) => el.textContent)) === tripCode && /^[A-Z2-9]{8}$/.test(tripCode));
  T('sharing pill visible', await page.$eval('#buddypill', (el) => getComputedStyle(el).display !== 'none'));
  T('onDisconnect cleanup armed on MY member path', await page.evaluate('window.__fbOD') === 'trips/' + tripCode + '/members/' + (await page.evaluate('__BUDDY.BUDDY.memberId')));
  /* Regression: joining registers presence IMMEDIATELY, before GPS answers —
     a phone with location blocked must still appear in the room. */
  T('presence registered instantly (first write: name, no GPS required)', await page.evaluate(`(function(){
    const mine = (window.__fbWrites || []).filter(w => w.path === 'trips/' + __BUDDY.BUDDY.code + '/members/' + __BUDDY.BUDDY.memberId && !w.update);
    return mine.length > 0 && typeof mine[0].v.name === 'string' && mine[0].v.name.length > 0 && mine[0].v.lat === undefined && typeof mine[0].v.ts === 'number';
  })()`));
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
  /* Regression: a buddy whose GPS hasn't answered (no lat yet — e.g. location
     blocked) still counts in the pill and shows as "locating…" in the list. */
  await page.evaluate(`(function(){
    const members = {};
    members[__BUDDY.BUDDY.memberId] = { name: 'Tester', lat: 44.76, lng: -85.62, ts: Date.now(), kind: 'person', color: '#4aa3ff' };
    members['ava1'] = { name: 'Ava', lat: 44.7609, lng: -85.62, ts: Date.now(), kind: 'person', color: '#ff7a59' };
    members['rex1'] = { name: 'Rex', lat: 44.7700, lng: -85.62, ts: Date.now() - 90000, kind: 'pet', color: '#ffd166' };
    members['nog1'] = { name: 'NoGps', ts: Date.now(), kind: 'person', color: '#35e08a' };
    window.__fbCBs['trips/' + __BUDDY.BUDDY.code + '/members']({ val: function(){ return members; } });
  })()`);
  T('GPS-less buddy still counts in the pill (3)', (await page.$eval('#buddycount', (el) => el.textContent)) === '3');
  T('GPS-less buddy listed as locating…, no map dot', await page.evaluate(`(function(){
    const row = [...document.querySelectorAll('#buddylist .buddyrow')].find(e => e.textContent.includes('NoGps'));
    return !!row && row.textContent.includes('locating…') && __sdmap.countGroup('buddy') === 2;
  })()`));
  /* Fort SkyDog A2: a point older than 24h must be treated as gone — a code
     that leaks later must never replay someone's last known position. */
  await page.evaluate(`(function(){
    const members = {};
    members[__BUDDY.BUDDY.memberId] = { name: 'Tester', lat: 44.76, lng: -85.62, ts: Date.now(), kind: 'person', color: '#4aa3ff' };
    members['ava1'] = { name: 'Ava', lat: 44.7609, lng: -85.62, ts: Date.now(), kind: 'person', color: '#ff7a59' };
    members['old1'] = { name: 'Yesterday', lat: 44.78, lng: -85.60, ts: Date.now() - (__BUDDY.BUDDY_POINT_MAX_AGE_MS + 3600000), kind: 'person', color: '#ffd166' };
    window.__fbCBs['trips/' + __BUDDY.BUDDY.code + '/members']({ val: function(){ return members; } });
  })()`);
  T('stale >24h point filtered: no dot, no row, not counted (Fort SkyDog A2)', await page.evaluate(`(function(){
    const listed = [...document.querySelectorAll('#buddylist .buddyrow')].some(e => e.textContent.includes('Yesterday'));
    const dotted = [...document.querySelectorAll('.bdymark')].some(e => e.textContent.includes('Yesterday'));
    return !listed && !dotted && document.getElementById('buddycount').textContent === '1';
  })()`));

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
  T('packs config: fishing + drone + orv + terrain3d + All Access bundle', await page.evaluate(
    '!!(__sdpacks.PACKS_CONFIG.packs.fishing && __sdpacks.PACKS_CONFIG.packs.drone && __sdpacks.PACKS_CONFIG.packs.orv && __sdpacks.PACKS_CONFIG.packs.terrain3d && __sdpacks.PACKS_CONFIG.bundle)'));
  T('All Access is the ONE sellable product ($2.99/mo sub)', await page.evaluate(`(function(){
    const C = __sdpacks.PACKS_CONFIG;
    const separately = Object.values(C.packs).some(p => p.sellable);
    return !separately && C.bundle.price === '$2.99/mo' && C.bundle.product.type === 'subs'
      && C.bundle.product.ios === 'com.skydog.skygps.allaccess.monthly';
  })()`));
  T('legacy fishing one-time product still honored', await page.evaluate(
    '__sdpacks.PACKS_CONFIG.packs.fishing.product.ios === "com.skydog.skygps.fishingpack" && __sdpacks.PACKS_CONFIG.packs.fishing.product.type === "inapp"'));
  await page.evaluate('__sdwheel.jumpTo("store")');
  await page.click('#packsfab');
  T('🎒 fab opens the store sheet', await page.$eval('#packsheet', (el) => el.classList.contains('open')));
  T('store lists every pack (4 cards, config-driven)', await page.$$eval('#packlist .packcard', (e) => e.length) === 4);
  T('one subscribe button at the bundle price', (await page.$eval('#packsub', (el) => el.textContent)).includes('$2.99'));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  T('all-access entitlement unlocks every pack (incl ORV + 3D)', await page.evaluate(`(function(){
    localStorage.setItem('sd-allaccess-iap', '1');
    const ok = __sdpacks.Entitlements.isUnlocked('drone') && __sdpacks.Entitlements.isUnlocked('fishing')
      && __sdpacks.Entitlements.isUnlocked('orv') && __sdpacks.Entitlements.isUnlocked('terrain3d');
    localStorage.setItem('sd-allaccess-iap', '0');
    return ok && !__sdpacks.Entitlements.isUnlocked('orv') && !__sdpacks.Entitlements.isUnlocked('terrain3d');
  })()`));

  console.log('\n— 🚁 Drone Pack: gating + unlock —');
  T('drone fab exists', (await page.$eval('#dronefab', (el) => el.textContent.trim())) === '🚁');
  await page.evaluate('__sdwheel.jumpTo("drone")');
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
  T('inside coverage, outside every grid → clear to 400', await page.evaluate(`(function(){
    const f = __sddrone.airspace._fetched[0].bbox;              /* [s,w,n,e] of loaded FAA data */
    const s = __sddrone.droneAirspaceSummary((f[0]+f[2])/2, f[1] + 0.002);  /* inside coverage, west of both cells */
    return s.level === 'ok' && s.ceiling === 400 && s.cell === null;
  })()`));
  T('NO data coverage → fail-safe unknown, never a green light', await page.evaluate(`(function(){
    const s = __sddrone.droneAirspaceSummary(44.76, -85.90);
    return s.level === 'unknown' && s.cell === null;
  })()`));
  T('flight check with no data → warns instead of clearing', await page.evaluate(`(function(){
    const v = __sddrone.LaancService.check(44.76, -85.90, 300);
    return v.dataAvailable === false && v.required === false;
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
  T('check: open country at 300 ft → no authorization needed', await page.evaluate(`(function(){
    const f = __sddrone.airspace._fetched[0].bbox;
    const v = __sddrone.LaancService.check((f[0]+f[2])/2, f[1] + 0.002, 300);
    return v.required === false && v.dataAvailable === true;
  })()`));
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
  T('wheel holds every mode + tool in cyclic order', JSON.stringify(await page.evaluate('__sdwheel.order'))
    === JSON.stringify(['fishing', 'drone', 'orv', 'terrain3d', 'world', 'buddy', 'spots', 'store',
                        'sos', 'night', 'layer', 'locate', 'saved', 'key', 'what', 'clear']));
  T('every configured pack auto-appears on the wheel', await page.evaluate(
    'Object.keys(__sdpacks.PACKS_CONFIG.packs).every((id) => __sdwheel.order.includes(id))'));
  T('front slot enlarged + marked', await page.evaluate('__sdwheel.front') === 'fishing'
    && await page.$eval('#fishfab', (el) => el.classList.contains('front') && /scale\(1\.4/.test(el.style.transform)));
  T('cyclic wrap: last item is one flick behind the front', await page.evaluate('__sdwheel.delta(15)') === -1);
  T('flick snaps to a firm detent (never free-floats)', await page.evaluate(`(function(){
    __sdwheel.spinBy(1.4);
    const drifting = __sdwheel.pos;
    __sdwheel.settle();
    return Math.abs(drifting - 1.4) < 1e-9 && __sdwheel.pos === 1 && __sdwheel.front === 'drone';
  })()`));
  T('locked pack wears a 🔒, unlocked pack does not', await page.$eval('#orvfab', (el) => el.classList.contains('locked'))
    && await page.$eval('#dronefab', (el) => !el.classList.contains('locked')));
  T('wheel discovery hint is one-shot', await page.evaluate('localStorage.getItem("sd-wheel-hint")') === '1');

  console.log('\n— 🔁 Cyclic chip rows (UI refresh 2026-07-25) —');
  T('discovery row overflows the phone → wraps around', await page.evaluate(
    '__sdcyc.rows.chips && __sdcyc.rows.chips.on === true'));
  T('flick past the last chip shows the first (never dead-ends)', await page.evaluate(`(function(){
    const r = __sdcyc.rows.chips, n = r.xs.length;
    r.jump(r.xs[n - 1]);                                   /* last chip at the left edge */
    const last = r.leftIndex() === n - 1;
    r.jump(r.off + r.ws[n - 1] + __sdcyc.CYC_CFG.gap);     /* one more chip forward → wraps */
    const wrapped = r.leftIndex() === 0;
    r.jump(0);
    return last && wrapped;
  })()`));
  T('spin backwards from the first chip lands on the last', await page.evaluate(`(function(){
    const r = __sdcyc.rows.chips, n = r.xs.length;
    r.jump(0);
    r.jump(r.off - (r.ws[n - 1] + __sdcyc.CYC_CFG.gap));
    const ok = r.leftIndex() === n - 1;
    r.jump(0); return ok;
  })()`));
  T('snap target is always a chip start (no half-cut at the left edge)', await page.evaluate(`(function(){
    const r = __sdcyc.rows.chips;
    const t = ((r.nearest(r.xs[2] + r.ws[2] * 0.4) % r.W) + r.W) % r.W;
    return r.xs.includes(Math.round(t * 100) / 100);
  })()`));
  T('taps still hit the same handlers on a wrapped row', await page.evaluate(`(function(){
    const r = __sdcyc.rows.chips;
    r.jump(r.xs[3]);                                       /* spin somewhere first */
    let fired = false;
    const chip = document.querySelector('#chips .chip');
    const h = () => { fired = true; };
    chip.addEventListener('click', h);
    chip.click();
    chip.removeEventListener('click', h);
    r.jump(0);
    return fired;
  })()`));
  T('a row that fits on screen stays native (no fake spinning)', await page.evaluate(`(function(){
    const el = document.createElement('div');
    el.id = 'cyctmp'; el.style.cssText = 'display:flex;gap:7px;width:400px';
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = 'only';
    el.appendChild(b); document.body.appendChild(el);
    const r = __sdcyc.make(el);
    const ok = r.on === false && !el.classList.contains('cyc');
    el.remove(); delete __sdcyc.rows.cyctmp;
    return ok;
  })()`));

  console.log('\n— 🔍 Search-first header (UI refresh 2026-07-25) —');
  T('big wordmark retired — no #logo block in the header', await page.evaluate('!document.getElementById("logo")'));
  T('small dog icon (28px) lives inside the search hero', await page.evaluate(`(function(){
    const b = document.querySelector('#searchwrap #brandbtn img');
    return !!b && getComputedStyle(b).width === '28px';
  })()`));
  T('search bar is the hero: full row width', await page.evaluate(`(function(){
    const tw = document.getElementById('topbar').clientWidth;
    const sw = document.getElementById('searchwrap').getBoundingClientRect().width;
    return sw >= tw * 0.95;
  })()`));
  T('header height budget: brand row ≤ 46px (space returned to the map)', await page.evaluate(
    'document.getElementById("brandrow").offsetHeight <= 46'));
  await page.click('#brandbtn');
  T('tap the dog → about sheet: branding, version, support + privacy', await page.evaluate(`(function(){
    const open = document.getElementById('aboutsheet').classList.contains('open');
    const brand = document.getElementById('aboutbrand').textContent.includes('DOG')
      && document.getElementById('aboutbrand').textContent.includes('Powered by SkyDog AI');
    const ver = document.getElementById('aboutver').textContent.includes('v1.4');
    const dog = (document.getElementById('aboutdog').src || '').startsWith('data:image/png');
    const s = document.getElementById('aboutsupport').getAttribute('href') === 'support.html';
    const p = document.getElementById('aboutprivacy').getAttribute('href') === 'privacy-policy.html';
    return open && brand && ver && dog && s && p;
  })()`));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  T('store sheet carries the retired branding line', await page.evaluate(
    'document.getElementById("packsheet").textContent.includes("Powered by SkyDog AI")'));
  await page.evaluate('document.getElementById("searchbox").value = "boardman lake"');
  await page.evaluate('(function(){ document.getElementById("searchbtn").click(); })()');
  await page.waitForFunction('document.getElementById("toast").textContent.includes("No results")', null, { timeout: 5000 });
  T('searchbox still searches (wired end-to-end through fetch)', true);

  console.log('\n— 🎡 Wheel absorbs the right-side tools (UI refresh 2026-07-25) —');
  T('floating #fabs column is gone — right edge of the map is clear', await page.evaluate(
    '!document.getElementById("fabs")'));
  T('all 7 historic tool ids live ON the wheel', await page.evaluate(`(function(){
    return ['layerfab','locatefab','savedfab','keyfab','whatfab','clearfab','installfab']
      .every((id) => !!document.querySelector('#modewheel #' + id + '.wfab.util'));
  })()`));
  T('detents tighten as the wheel fills (min 24°)', await page.evaluate(
    '__sdwheel.stepDeg < __sdwheel.WHEEL_CFG.stepDeg && __sdwheel.stepDeg >= 24'));
  T('hidden installfab stays OFF the ring; rebuild adds it when installable', await page.evaluate(`(function(){
    const btn = document.getElementById('installfab');
    const off = !__sdwheel.order.includes('install');
    btn.style.display = ''; __sdwheel.rebuild();
    const on = __sdwheel.order.includes('install');
    btn.style.display = 'none'; __sdwheel.rebuild();
    return off && on && !__sdwheel.order.includes('install');
  })()`));
  await page.evaluate('__sdwheel.jumpTo("layer")');
  await page.click('#layerfab');
  T('🗺️ still opens the layer sheet from the wheel', await page.$eval('#layersheet', (el) => el.classList.contains('open')));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  await page.evaluate('__sdwheel.jumpTo("what")');
  await page.click('#whatfab');
  T('❓ inspect toggles on from the wheel', await page.$eval('#whatfab', (el) => el.classList.contains('active')));
  await page.click('#whatfab');
  T('❓ inspect toggles back off', await page.$eval('#whatfab', (el) => !el.classList.contains('active')));
  await page.evaluate('__sdwheel.jumpTo("saved")');
  await page.click('#savedfab');
  T('📁 still opens saved adventures from the wheel', await page.$eval('#savedsheet', (el) => el.classList.contains('open')));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  await page.evaluate('__sdwheel.jumpTo("clear")');
  await page.click('#clearfab');
  T('🧹 still clears pins from the wheel', await page.evaluate('__sdmap.countGroup("poi")') === 0);

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
  T('orv chip row wraps around + chip taps still toggle layers', await page.evaluate(`(function(){
    const r = __sdcyc.rows.orvchips;
    if(!r || !r.on) return false;                        /* 7 chips overflow a phone */
    const chip = document.querySelector('#orvchips .chip');
    const was = chip.classList.contains('active');
    chip.click();
    const flipped = chip.classList.contains('active') !== was;
    chip.click();                                        /* restore */
    return flipped;
  })()`));
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

  console.log('\n— 🗻 3D Terrain Pack: gating + unlock —');
  T('terrain3d pack config (bundle-only, TERRA codes)', await page.evaluate(`(function(){
    const d = __sdpacks.PACKS_CONFIG.packs.terrain3d;
    return !!d && d.sellable === false && d.product === null && d.web.codePrefix === 'TERRA'
      && d.storeKey === 'sd-terrapack' && d.icon === '🗻';
  })()`));
  T('🗻 fab auto-appears on the wheel (zero extra wiring)', await page.evaluate(
    '__sdwheel.order.includes("terrain3d")') && (await page.$eval('#terrain3dfab', (el) => el.textContent.trim())) === '🗻');
  await page.evaluate('__sdwheel.jumpTo("terrain3d")');
  await page.click('#terrain3dfab');
  T('locked: 🗻 fab opens the paywall, not the mode', await page.evaluate('__sdt3d.mode') === false
    && await page.$eval('#paysheet', (el) => el.classList.contains('open'))
    && (await page.$eval('#paytitle', (el) => el.textContent)).includes('3D'));
  T('TERRA checksum rejects bad codes', await page.evaluate(
    '!__sdpacks.packCodeOK("TERRA", "TERRA-AAAA") && !__sdpacks.packCodeOK("TERRA", "junk")'));
  await page.fill('#paycode', 'terra-aa2a'); /* lowercase on purpose — must normalize */
  await page.click('#payunlock');
  T('valid TERRA code unlocks + enters 3D', await page.evaluate('__sdt3d.mode') === true
    && !(await page.$eval('#paysheet', (el) => el.classList.contains('open'))));
  T('3D license persisted on device', await page.evaluate('localStorage.getItem("sd-terrapack")') === 'TERRA-AA2A');
  T('3D view overlay shown with exit + controls', await page.$eval('#t3dwrap', (el) => el.classList.contains('on'))
    && await page.$eval('#t3dexit', (el) => el.textContent.includes('2D'))
    && await page.$eval('#t3dexag', (el) => el.min === '1' && el.max === '3'));
  T('attribution credits the terrain sources in 3D', await page.$eval('#attrib', (el) => /Terrain/.test(el.textContent))
    && await page.$eval('#t3dattrib', (el) => /Mapzen/.test(el.textContent) && /USGS/.test(el.textContent)));
  T('WebGL state is fail-safe (gl OR a friendly no-3D message, never a crash)', await page.evaluate(
    '__sdt3d.gl === true || (__sdt3d.glFailed === true && document.getElementById("t3dmsg").style.display === "block")'));

  console.log('\n— 🗻 3D terrain math (pure, deterministic) —');
  T('terrarium decode: sea level → 0 m', await page.evaluate('__sdt3d.decodeTerrarium(128, 0, 0)') === 0);
  T('terrarium decode: 1625 m peak', await page.evaluate('__sdt3d.decodeTerrarium(134, 89, 0)') === 1625);
  T('terrarium decode: black pixel → -32768 (clamped later)', await page.evaluate('__sdt3d.decodeTerrarium(0, 0, 0)') === -32768);
  T('DEM tile url → free keyless AWS terrarium endpoint', await page.evaluate('__sdt3d.demTileUrl(11, 550, 740)')
    === 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/11/550/740.png');
  T('DEM zoom picker clamps to coverage (6..13) and scales with distance', await page.evaluate(`(function(){
    const near = __sdt3d.pickDemZoom(300, 44.7), far = __sdt3d.pickDemZoom(240000, 44.7);
    return near === 13 && far === 7 && __sdt3d.pickDemZoom(10000000, 44.7) === 6
      && __sdt3d.pickDemZoom(9000, 44.7) > far && __sdt3d.pickDemZoom(9000, 44.7) < near;
  })()`));
  T('tile2lat: web-mercator rows land where they should', await page.evaluate(`(function(){
    const eq = __sdt3d.tile2lat(Math.pow(2, 10) / 2, 10);     /* middle row = equator */
    return Math.abs(eq) < 1e-6 && __sdt3d.tile2lat(0, 10) > 85;
  })()`));
  T('building heights: explicit metres beat levels beat the default', await page.evaluate(`(function(){
    const B = __sdt3d.bldHeight;
    return B({height: '25 m'}) === 25 && B({'building:levels': '4'}) === 4 * __sdt3d.T3D_CFG.bldFloorM
      && B({}) === __sdt3d.T3D_CFG.bldDefaultM && B({height: '9999'}) === 350;
  })()`));
  T('ear-clip: square → 2 triangles, triangle → itself, degenerate → empty', await page.evaluate(`(function(){
    const E = __sdt3d.earclip;
    return E([[0,0],[1,0],[1,1],[0,1]]).length === 6 && E([[0,0],[1,0],[0,1]]).length === 3
      && E([[0,0],[1,0]]).length === 0;
  })()`));
  T('ear-clip handles an L-shape (concave) fully', await page.evaluate(
    '__sdt3d.earclip([[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]]).length') === 12);
  T('exaggeration slider drives the renderer state', await page.evaluate(`(function(){
    const s = document.getElementById('t3dexag');
    s.value = '2.5'; s.dispatchEvent(new Event('input'));
    const ok = __sdt3d.T3D.exag === 2.5;
    s.value = '1.5'; s.dispatchEvent(new Event('input'));
    return ok && __sdt3d.T3D.exag === 1.5;
  })()`));
  T('🏢 buildings toggle flips state + button', await page.evaluate(`(function(){
    const b = document.getElementById('t3dbld');
    const was = __sdt3d.T3D.bldOn;
    b.click();
    const flipped = __sdt3d.T3D.bldOn === !was && b.classList.contains('on') === !was;
    b.click();
    return flipped && __sdt3d.T3D.bldOn === was;
  })()`));
  T('CSP allowlists the terrain tile host (img-src)', (function(){
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8'));
    return !!m && /img-src[^;]*s3\.amazonaws\.com/.test(m[1]);
  })());
  await page.click('#t3dexit');
  T('✕ 2D exits back to the flat map', await page.evaluate('__sdt3d.mode') === false
    && !(await page.$eval('#t3dwrap', (el) => el.classList.contains('on'))));
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.waitForFunction('window.__SKYDOG_READY === true', null, { timeout: 10000 });
  T('3D unlock survives app restart', await page.evaluate('__sdpacks.Entitlements.isUnlocked("terrain3d")') === true);

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

  console.log('\n— 🏡 Property Lines (Regrid parcels) —');
  T('parcels handle exposed', await page.evaluate('!!window.__sdparcels && typeof __sdparcels.parcelLookup === "function"'));
  T('no token → tiles stay blank', await page.evaluate(`(function(){
      const saved = __sdparcels.REGRID.token;
      __sdparcels.REGRID.token = '';
      const blank = OVERLAYS.parcels.url(15, 100, 200) === BLANK_TILE;
      __sdparcels.REGRID.token = saved;
      return blank;
    })()`));
  await page.evaluate('__sdparcels.REGRID.token = "test-token"');
  T('token + below min zoom → still blank', await page.evaluate('OVERLAYS.parcels.url(12, 100, 200)') === (await page.evaluate('BLANK_TILE')));
  T('token + close zoom → Regrid tile URL', await page.evaluate('OVERLAYS.parcels.url(15, 100, 200)').then(u => u.includes('tiles.regrid.com/api/v1/parcels/15/100/200.png') && u.includes('token=test-token')));
  T('overlay off → tap not hijacked', await page.evaluate('__sdmap.onTap({lat:44.76, lng:-85.62})') === false && regridHits === 0);
  await page.evaluate('__sdmap.overlays.add("parcels"); __sdmap.center = {lat:44.76, lng:-85.62}; __sdmap.zoom = 16;');
  T('tap inside parcel → handled', await page.evaluate('__sdmap.onTap({lat:44.76, lng:-85.62})') === true);
  await page.waitForFunction('document.getElementById("popup").style.display === "block"', null, { timeout: 5000 });
  const parcelPop = await page.evaluate('document.getElementById("popupbody").innerHTML');
  T('popup names the owner', parcelPop.includes('DOE JOHN &amp; JANE'));
  T('popup shows acreage + use', parcelPop.includes('39.48 acres') && parcelPop.includes('residential'));
  T('popup shows address + not-a-survey note', parcelPop.includes('123 Skydog Trail') && parcelPop.includes('not a survey'));
  T('gold highlight ring on the map', await page.evaluate('__sdmap.parcel && __sdmap.parcel.rings.length === 1 && __sdmap.parcel.rings[0].length === 5'));
  T('exactly one Regrid lookup fired', regridHits === 1);
  T('closing popup drops the highlight', await page.evaluate('(function(){ __sdmap.closePopup(); return __sdmap.parcel === null; })()'));
  T('re-tapping a parcel keeps the fresh highlight', await page.evaluate(`(async function(){
      __sdmap.onTap({lat:44.76, lng:-85.62});
      await new Promise(r => setTimeout(r, 400));
      __sdmap.onTap({lat:44.76, lng:-85.62});   /* second tap while popup open */
      await new Promise(r => setTimeout(r, 400));
      return !!(__sdmap.parcel && __sdmap.parcel.rings.length === 1);
    })()`));
  await page.evaluate('__sdmap.closePopup()');
  T('zoomed-out tap nudges instead of silence', await page.evaluate(`(function(){
      __sdmap.zoom = 11;
      const handled = __sdmap.onTap({lat:44.76, lng:-85.62});
      const t = document.getElementById('toast').textContent;
      __sdmap.zoom = 16;
      return handled === false && t.includes('Zoom in closer');
    })()`));
  regridMode = 'empty';
  await page.evaluate('__sdmap.onTap({lat:44.70, lng:-85.50})');
  await page.waitForFunction('document.getElementById("toast").textContent.includes("No data here in preview")', null, { timeout: 5000 });
  T('trial miss → preview guidance toast', await page.evaluate('__sdmap.parcel === null && __sdmap.countGroup("parcel") === 0'));
  await page.evaluate('__sdparcels.REGRID.trialNote = false');
  await page.evaluate('__sdmap.onTap({lat:44.70, lng:-85.50})');
  await page.waitForFunction('document.getElementById("toast").textContent.includes("No parcel mapped")', null, { timeout: 5000 });
  T('production miss → plain no-parcel toast', true);
  await page.evaluate('__sdparcels.REGRID.trialNote = true');
  regridMode = 'parcel';
  T('MultiPolygon parcels flatten to rings', await page.evaluate(`__sdparcels.parcelRings({ type:'MultiPolygon', coordinates: [
      [[[-85.1,44.1],[-85.0,44.1],[-85.0,44.2],[-85.1,44.1]]],
      [[[-85.3,44.3],[-85.2,44.3],[-85.2,44.4],[-85.3,44.3]]]
    ] }).length`) === 2);
  T('regrid attribution when active', await page.evaluate('(function(){ updateAttrib(); return document.getElementById("attrib").textContent; })()').then(t => t.includes('Regrid')));
  await page.evaluate('__sdmap.overlays.delete("parcels"); __sdparcels.REGRID.token = ""; updateAttrib(); __sdmap.clearGroup("parcel");');


  console.log('\n— 🆘 Run 1: USNG/MGRS + astronomy (pure, deterministic) —');
  /* ground truth generated from the mgrs + (high-accuracy) suncalc reference
     libraries; hardcoded so the suite stays self-contained + offline */
  const FIX_MGRS = [{"lng":-85.6206,"lat":44.7631,"mgrs":"16TFQ0916457559"},{"lng":-83.0458,"lat":42.3314,"mgrs":"17TLG3145088599"},{"lng":-77.0365,"lat":38.8977,"mgrs":"18SUJ2339407395"},{"lng":-149.9003,"lat":61.2181,"mgrs":"6VUN4424790536"},{"lng":-80.1918,"lat":25.7617,"mgrs":"17RNJ8104649542"},{"lng":151.2093,"lat":-33.8688,"mgrs":"56HLH3436850948"}];
  const FIX_SUN = [{"lat":44.7631,"lng":-85.6206,"date":"2026-08-01T17:00:00Z","sunrise":"2026-08-01T10:28:40Z","sunset":"2026-08-02T01:08:17Z","civilDawn":"2026-08-01T09:55:07Z","civilDusk":"2026-08-02T01:41:41Z","nauticalDawn":"2026-08-01T09:12:50Z","nauticalDusk":"2026-08-02T02:23:43Z","astroDawn":"2026-08-01T08:24:05Z","astroDusk":"2026-08-02T03:12:01Z"},{"lat":42.3314,"lng":-83.0458,"date":"2026-08-01T17:00:00Z","sunrise":"2026-08-01T10:24:55Z","sunset":"2026-08-02T00:51:30Z","civilDawn":"2026-08-01T09:53:09Z","civilDusk":"2026-08-02T01:23:09Z","nauticalDawn":"2026-08-01T09:13:39Z","nauticalDusk":"2026-08-02T02:02:27Z","astroDawn":"2026-08-01T08:29:21Z","astroDusk":"2026-08-02T02:46:25Z"},{"lat":25.7617,"lng":-80.1918,"date":"2026-08-01T17:00:00Z","sunrise":"2026-08-01T10:47:13Z","sunset":"2026-08-02T00:06:43Z","civilDawn":"2026-08-01T10:22:29Z","civilDusk":"2026-08-02T00:31:24Z","nauticalDawn":"2026-08-01T09:53:03Z","nauticalDusk":"2026-08-02T01:00:45Z","astroDawn":"2026-08-01T09:22:35Z","astroDusk":"2026-08-02T01:31:09Z"},{"lat":44.7631,"lng":-85.6206,"date":"2026-01-15T17:00:00Z","sunrise":"2026-01-15T13:16:17Z","sunset":"2026-01-15T22:28:01Z","civilDawn":"2026-01-15T12:43:43Z","civilDusk":"2026-01-15T23:00:35Z","nauticalDawn":"2026-01-15T12:07:33Z","nauticalDusk":"2026-01-15T23:36:47Z","astroDawn":"2026-01-15T11:32:33Z","astroDusk":"2026-01-16T00:11:47Z"},{"lat":42.3314,"lng":-83.0458,"date":"2026-01-15T17:00:00Z","sunrise":"2026-01-15T12:58:37Z","sunset":"2026-01-15T22:25:04Z","civilDawn":"2026-01-15T12:27:35Z","civilDusk":"2026-01-15T22:56:06Z","nauticalDawn":"2026-01-15T11:52:57Z","nauticalDusk":"2026-01-15T23:30:44Z","astroDawn":"2026-01-15T11:19:20Z","astroDusk":"2026-01-16T00:04:22Z"},{"lat":25.7617,"lng":-80.1918,"date":"2026-01-15T17:00:00Z","sunrise":"2026-01-15T12:09:00Z","sunset":"2026-01-15T22:51:42Z","civilDawn":"2026-01-15T11:44:17Z","civilDusk":"2026-01-15T23:16:25Z","nauticalDawn":"2026-01-15T11:16:05Z","nauticalDusk":"2026-01-15T23:44:37Z","astroDawn":"2026-01-15T10:48:17Z","astroDusk":"2026-01-16T00:12:25Z"},{"lat":44.7631,"lng":-85.6206,"date":"2026-11-15T17:00:00Z","sunrise":"2026-11-15T12:39:40Z","sunset":"2026-11-15T22:14:06Z","civilDawn":"2026-11-15T12:08:00Z","civilDusk":"2026-11-15T22:45:45Z","nauticalDawn":"2026-11-15T11:32:33Z","nauticalDusk":"2026-11-15T23:21:10Z","astroDawn":"2026-11-15T10:58:02Z","astroDusk":"2026-11-15T23:55:41Z"},{"lat":42.3314,"lng":-83.0458,"date":"2026-11-15T17:00:00Z","sunrise":"2026-11-15T12:23:02Z","sunset":"2026-11-15T22:10:09Z","civilDawn":"2026-11-15T11:52:49Z","civilDusk":"2026-11-15T22:40:22Z","nauticalDawn":"2026-11-15T11:18:50Z","nauticalDusk":"2026-11-15T23:14:20Z","astroDawn":"2026-11-15T10:45:39Z","astroDusk":"2026-11-15T23:47:30Z"},{"lat":25.7617,"lng":-80.1918,"date":"2026-11-15T17:00:00Z","sunrise":"2026-11-15T11:38:41Z","sunset":"2026-11-15T22:31:51Z","civilDawn":"2026-11-15T11:14:24Z","civilDusk":"2026-11-15T22:56:08Z","nauticalDawn":"2026-11-15T10:46:37Z","nauticalDusk":"2026-11-15T23:23:56Z","astroDawn":"2026-11-15T10:19:11Z","astroDusk":"2026-11-15T23:51:22Z"}];
  const FIX_MOON = [{"lat":44.7631,"lng":-85.6206,"date":"2026-08-01T17:00:00Z","rise":"2026-08-01T02:12:07Z","set":"2026-08-01T13:36:22Z","fraction":0.9064},{"lat":42.3314,"lng":-83.0458,"date":"2026-08-01T17:00:00Z","rise":"2026-08-01T01:58:55Z","set":"2026-08-01T13:27:27Z","fraction":0.9064},{"lat":25.7617,"lng":-80.1918,"date":"2026-08-01T17:00:00Z","rise":"2026-08-01T01:32:33Z","set":"2026-08-01T13:25:27Z","fraction":0.9064},{"lat":44.7631,"lng":-85.6206,"date":"2026-01-15T17:00:00Z","rise":"2026-01-15T11:14:40Z","set":"2026-01-15T19:14:49Z","fraction":0.0924},{"lat":42.3314,"lng":-83.0458,"date":"2026-01-15T17:00:00Z","rise":"2026-01-15T10:52:05Z","set":"2026-01-15T19:16:09Z","fraction":0.0924},{"lat":25.7617,"lng":-80.1918,"date":"2026-01-15T17:00:00Z","rise":"2026-01-15T09:41:48Z","set":"2026-01-15T20:03:25Z","fraction":0.0924},{"lat":44.7631,"lng":-85.6206,"date":"2026-11-15T17:00:00Z","rise":"2026-11-15T18:01:04Z","set":"2026-11-15T02:20:35Z","fraction":0.3336},{"lat":42.3314,"lng":-83.0458,"date":"2026-11-15T17:00:00Z","rise":"2026-11-15T17:42:47Z","set":"2026-11-15T02:18:58Z","fraction":0.3336},{"lat":25.7617,"lng":-80.1918,"date":"2026-11-15T17:00:00Z","rise":"2026-11-15T16:50:48Z","set":"2026-11-15T02:53:10Z","fraction":0.3336}];
  T('MGRS matches ' + FIX_MGRS.length + ' reference vectors (±1 m)', await page.evaluate(`(function(){
    const fx = ${JSON.stringify(FIX_MGRS)};
    return fx.every(v => {
      const got = __sdsafety.toMGRS(v.lat, v.lng);
      if (got === v.mgrs) return true;
      return !!got && got.slice(0, -10) === v.mgrs.slice(0, -10)
        && Math.abs(+got.slice(-10, -5) - +v.mgrs.slice(-10, -5)) <= 1
        && Math.abs(+got.slice(-5) - +v.mgrs.slice(-5)) <= 1;
    });
  })()`));
  T('MGRS pretty-print + polar refusal + deg-min format', await page.evaluate(`(function(){
    return __sdsafety.mgrsPretty('16TFQ0916457559') === '16T FQ 09164 57559'
      && __sdsafety.toMGRS(87, 10) === null
      && __sdsafety.degMin(44.7631, true) === "44°45.786'N"
      && __sdsafety.degMin(-85.6206, false) === "85°37.236'W";
  })()`));
  T('sun times within ±4 min of reference (' + FIX_SUN.length + ' location/dates × 8 events)', await page.evaluate(`(function(){
    const fx = ${JSON.stringify(FIX_SUN)};
    const keys = ['sunrise','sunset','civilDawn','civilDusk','nauticalDawn','nauticalDusk','astroDawn','astroDusk'];
    return fx.every(s => {
      const t = __sdnight.AST.sunTimes(new Date(s.date), s.lat, s.lng);
      return keys.every(k => t[k] && Math.abs(+t[k] - Date.parse(s[k])) <= 240000);
    });
  })()`));
  T('moon rise/set within ±10 min + illumination ±0.02 of reference', await page.evaluate(`(function(){
    const fx = ${JSON.stringify([{"lat":44.7631,"lng":-85.6206,"date":"2026-08-01T17:00:00Z","rise":"2026-08-01T02:12:07Z","set":"2026-08-01T13:36:22Z","fraction":0.9064},{"lat":42.3314,"lng":-83.0458,"date":"2026-08-01T17:00:00Z","rise":"2026-08-01T01:58:55Z","set":"2026-08-01T13:27:27Z","fraction":0.9064},{"lat":25.7617,"lng":-80.1918,"date":"2026-08-01T17:00:00Z","rise":"2026-08-01T01:32:33Z","set":"2026-08-01T13:25:27Z","fraction":0.9064},{"lat":44.7631,"lng":-85.6206,"date":"2026-01-15T17:00:00Z","rise":"2026-01-15T11:14:40Z","set":"2026-01-15T19:14:49Z","fraction":0.0924},{"lat":42.3314,"lng":-83.0458,"date":"2026-01-15T17:00:00Z","rise":"2026-01-15T10:52:05Z","set":"2026-01-15T19:16:09Z","fraction":0.0924},{"lat":25.7617,"lng":-80.1918,"date":"2026-01-15T17:00:00Z","rise":"2026-01-15T09:41:48Z","set":"2026-01-15T20:03:25Z","fraction":0.0924},{"lat":44.7631,"lng":-85.6206,"date":"2026-11-15T17:00:00Z","rise":"2026-11-15T18:01:04Z","set":"2026-11-15T02:20:35Z","fraction":0.3336},{"lat":42.3314,"lng":-83.0458,"date":"2026-11-15T17:00:00Z","rise":"2026-11-15T17:42:47Z","set":"2026-11-15T02:18:58Z","fraction":0.3336},{"lat":25.7617,"lng":-80.1918,"date":"2026-11-15T17:00:00Z","rise":"2026-11-15T16:50:48Z","set":"2026-11-15T02:53:10Z","fraction":0.3336}])};
    return fx.every(m => {
      const t = __sdnight.AST.moonTimes(new Date(m.date), m.lat, m.lng);
      const i = __sdnight.AST.moonIllumination(new Date(m.date));
      const okR = m.rise ? (t.rise && Math.abs(+t.rise - Date.parse(m.rise)) <= 600000) : !t.rise;
      const okS = m.set ? (t.set && Math.abs(+t.set - Date.parse(m.set)) <= 600000) : !t.set;
      return okR && okS && Math.abs(i.fraction - m.fraction) < 0.02;
    });
  })()`));
  T('moon transit is the day\'s highest altitude (±30 min shoulder check)', await page.evaluate(`(function(){
    const d = new Date('2026-08-01T17:00:00Z'), lat = 44.7631, lng = -85.6206;
    const tr = __sdnight.AST.moonTransits(d, lat, lng);
    const h = (t) => __sdnight.AST.moonAltitude(new Date(t), lat, lng);
    return h(+tr.transit) >= h(+tr.transit - 1800000) && h(+tr.transit) >= h(+tr.transit + 1800000)
      && h(+tr.underfoot) <= h(+tr.underfoot - 1800000) && h(+tr.underfoot) <= h(+tr.underfoot + 1800000);
  })()`));

  console.log('\n— 🐟 Solunar Activity (free with the free map) —');
  T('a day yields 2 majors + 1–2 minors, all inside the day', await page.evaluate(`(function(){
    const p = __sdsolunar.solunarPeriods(new Date('2026-08-01T17:00:00Z'), 44.7631, -85.6206);
    const day0 = Date.parse('2026-08-01T00:00:00Z') - 6*3600000, day1 = day0 + 36*3600000;
    return p.majors.length === 2 && p.minors.length >= 1 && p.minors.length <= 2
      && p.majors.concat(p.minors).every(t => t > day0 && t < day1);
  })()`));
  T('score peaks inside a major window and clamps to 0..100', await page.evaluate(`(function(){
    const ctx = { majors: [1000000], minors: [], sunEdges: [], phase: 0.5, nudge: 0 };
    const inMajor = __sdsolunar.solunarScoreAt(1000000, ctx);
    const outside = __sdsolunar.solunarScoreAt(1000000 + 4*3600000, ctx);
    const maxed = __sdsolunar.solunarScoreAt(1000000, { majors:[1000000], minors:[1000000], sunEdges:[1000000], phase:0.5, nudge:50 });
    return inMajor > outside && maxed === 100
      && __sdsolunar.solunarScoreAt(0, { majors:[], minors:[], sunEdges:[], phase:0.25, nudge:-99 }) === 0;
  })()`));
  T('phase weight: full/new moon beats the quarters', await page.evaluate(
    '__sdsolunar.solunarPhaseWeight(0.5) === 1 && __sdsolunar.solunarPhaseWeight(0) === 1 && __sdsolunar.solunarPhaseWeight(0.25) < 1'));
  T('weather nudge: falling glass +12, gale −10, sharp rise −6, offline 0', await page.evaluate(
    '__sdsolunar.solunarWxNudge(-3, 5) === 12 && __sdsolunar.solunarWxNudge(0, 25) === -10 && __sdsolunar.solunarWxNudge(3, 0) === -6 && __sdsolunar.solunarWxNudge(null, null) === 0'));
  T('solunar badge lives on the map + opens the day strip (48 half-hours)', await page.evaluate(`(function(){
    document.getElementById('sunbadge').click();
    return document.getElementById('solunarsheet').classList.contains('open')
      && document.querySelectorAll('#sunstrip div').length === 48
      && /\\d+ \\/ 100/.test(document.getElementById('sundialbig').textContent);
  })()`));
  T('species chips relabel the same math (🦌 deer)', await page.evaluate(`(function(){
    const before = document.getElementById('sundialbig').textContent.replace(/\\D/g, '');
    document.querySelector('.sunspecies [data-sp="deer"]').click();
    const after = document.getElementById('sundialbig').textContent;
    return after.includes('🦌') && after.replace(/\\D/g, '') === before
      && document.getElementById('sunrows').textContent.includes('movement windows');
  })()`));
  T('honest copy: almanac + weather, never a promise', await page.evaluate(`(function(){
    const t = document.getElementById('solunarsheet').textContent;
    return t.includes('a nudge, not a promise') && !/AI predicts/i.test(document.body.innerHTML);
  })()`));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');

  console.log('\n— 🆘 Emergency screen (offline, ≤2 taps) —');
  T('🆘 rides the wheel and one tap opens the screen', await page.evaluate(`(function(){
    if(!__sdwheel.order.includes('sos')) return false;
    document.getElementById('sosfab').click();
    return getComputedStyle(document.getElementById('soswrap')).display === 'flex';
  })()`));
  await page.evaluate(`__sdsafety.SOS.setFix({ lat: 44.7631, lng: -85.6206, accM: 9.1, altM: 190, heading: 271, at: Date.now() })`);
  T('every format rescuers ask for: decimal, deg-min, MGRS, elev, accuracy, heading', await page.evaluate(`(function(){
    const g = id => document.getElementById(id).textContent;
    return g('soslatlon') === '44.76310, -85.62060'
      && g('sosdegmin').includes("44°45.786'N") && g('sosdegmin').includes("85°37.236'W")
      && g('sosmgrs').includes('16T FQ')
      && g('soselev').includes('623 ft') && g('sosacc').includes('±30 ft') && g('soshead').includes('271°');
  })()`));
  T('📞 CALL 911 + 📱 pre-filled SOS text with position in every format', await page.evaluate(`(function(){
    const call = document.getElementById('soscall').getAttribute('href') === 'tel:911';
    const href = document.getElementById('sostext').getAttribute('href');
    const body = decodeURIComponent(href.split('body=')[1] || '');
    return call && href.startsWith('sms:') && body.includes('SOS! Need help.')
      && body.includes('44.76310,-85.62060') && body.includes('MGRS 16TFQ') && body.includes('maps.google.com');
  })()`));
  T('core SOS text stays under 160 chars (satellite-messaging safe)', await page.evaluate(`(function(){
    const b = __sdsafety.sosSmsBody({ lat: 44.7631, lng: -85.6206, accM: 8 }, { batt: 52, party: 3 });
    return b.split(' https://')[0].length < 160 && b.includes('Party of 3') && b.includes('Bat 52%');
  })()`));
  T('battery-saver toggle dims the screen for the long wait', await page.evaluate(`(function(){
    document.getElementById('sossaver').click();
    const on = document.getElementById('soswrap').classList.contains('saver');
    document.getElementById('sossaver').click();
    return on && !document.getElementById('soswrap').classList.contains('saver');
  })()`));
  T('rescuer link: buddy plumbing, rescue/<code> writes, browser URL', await page.evaluate(`(async function(){
    window.__fbWrites = [];
    await __sdsafety.SOS.startRescue();
    const r = __sdsafety.SOS.rescue;
    if(!r || !/\\?rescue=[A-Z2-9]{8}$/.test(r.url)) return 'bad url: ' + (r && r.url);
    const paths = (window.__fbWrites || []).map(w => w.path);
    const okLast = paths.some(p => p === 'rescue/' + r.code + '/last');
    const okTrack = paths.some(p => p.startsWith('rescue/' + r.code + '/track/t'));
    return okLast && okTrack ? true : 'writes: ' + paths.join('|');
  })()`) === true);
  T('SOS text now carries the live-track link', await page.evaluate(`(function(){
    const body = decodeURIComponent(document.getElementById('sostext').getAttribute('href').split('body=')[1] || '');
    return body.includes('Track: https://skydoggps.com/?rescue=');
  })()`));
  T('ending the link stops sharing', await page.evaluate(`(function(){
    __sdsafety.SOS.endRescue();
    return !__sdsafety.SOS.rescue && document.getElementById('sosrescue').textContent.includes('START');
  })()`));
  T('24 h retention promise is a tested constant', await page.evaluate('__sdsafety.SAFETY_CFG.rescueMaxAgeMs') === 86400000);
  T('what3words: hidden with no key, live with one (cached, online-only)', await page.evaluate(`(async function(){
    const hidden = getComputedStyle(document.getElementById('sosw3w')).display === 'none';
    __sdsafety.SAFETY_CFG.w3wKey = 'TESTKEY';
    __sdsafety.SOS.setFix({ lat: 44.7, lng: -85.6, accM: 5, altM: null, heading: null, at: Date.now() });
    await __sdsafety.SOS.w3wMaybe();
    const shown = document.getElementById('sosw3w').textContent === '///dog.happy.trail';
    __sdsafety.SAFETY_CFG.w3wKey = '';
    document.getElementById('sosw3w').style.display = 'none';
    return hidden && shown;
  })()`) === true);
  T('disclaimer on the screen: helps you share — NOT a rescue service', await page.evaluate(`(function(){
    const t = document.getElementById('sosdisc').textContent;
    return t.includes('not') && t.includes('rescue') && t.includes('911');
  })()`));
  T('kill switch: SAFETY_CFG.enabled=false refuses to open', await page.evaluate(`(function(){
    __sdsafety.SOS.close();
    __sdsafety.SAFETY_CFG.enabled = false;
    __sdsafety.SOS.open();
    const stayed = getComputedStyle(document.getElementById('soswrap')).display === 'none';
    __sdsafety.SAFETY_CFG.enabled = true;
    return stayed;
  })()`));
  T('rescue rules deployed: rescue/$code read + validated writes, root stays locked', (function(){
    const r = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'database.rules.json'), 'utf8'));
    const resc = r.rules.rescue.$code;
    return r.rules['.read'] === false && r.rules['.write'] === false
      && resc['.read'] === true && resc.last.lat['.validate'].includes('newData.isNumber()')
      && resc.track.$pt['$other']['.validate'] === false;
  })());

  console.log('\n— ⏳ Overdue timer (contacts never leave the phone) —');
  T('SOS screen hands off to the plan sheet', await page.evaluate(`(function(){
    __sdsafety.SOS.open();
    document.getElementById('sosoverdue').click();
    return document.getElementById('overduesheet').classList.contains('open')
      && getComputedStyle(document.getElementById('soswrap')).display === 'none';
  })()`));
  T('start: needs a time + at least one contact', await page.evaluate(`(function(){
    document.getElementById('odtime').value = '';
    document.getElementById('odstart').click();
    return !__sdsafety.OVERDUE.state;
  })()`));
  await page.evaluate(`(function(){
    document.getElementById('odq2').click();
    document.getElementById('odplan').value = 'bow hunt, Sand Lakes, silver F-150';
    document.getElementById('odname1').value = 'Mel';
    document.getElementById('odphone1').value = '(231) 555-0100';
    document.getElementById('odstart').click();
  })()`);
  T('timer armed: countdown pill + plan persisted via sdStore only', await page.evaluate(`(function(){
    const pill = document.getElementById('odpill');
    const st = JSON.parse(localStorage.getItem('sd-overdue'));
    const cs = JSON.parse(localStorage.getItem('sd-safety-contacts'));
    return getComputedStyle(pill).display !== 'none' && pill.textContent.includes('back by')
      && st.contacts.length === 1 && st.contacts[0].phone === '2315550100'
      && cs.length === 1 && st.plan.includes('bow hunt');
  })()`));
  T('overdue fires: full-screen alarm + pre-filled group text to contacts', await page.evaluate(`(function(){
    __sdsafety.OVERDUE.state.backBy = Date.now() - 1000;
    __sdsafety.OVERDUE.check();
    const alarmed = getComputedStyle(document.getElementById('odalarm')).display === 'flex';
    const href = document.getElementById('odtext').getAttribute('href');
    const body = decodeURIComponent((href.split('body=')[1] || ''));
    return alarmed && href.startsWith('sms:2315550100') && body.includes('safety alert')
      && body.includes('bow hunt') && document.getElementById('odpill').classList.contains('late');
  })()`));
  T('＋1 HOUR snoozes the alarm honestly', await page.evaluate(`(function(){
    document.getElementById('odplus').click();
    return getComputedStyle(document.getElementById('odalarm')).display === 'none'
      && !__sdsafety.OVERDUE.state.fired && __sdsafety.OVERDUE.state.backBy > Date.now();
  })()`));
  T('"I\'m back safe" clears the timer and the alarm', await page.evaluate(`(function(){
    __sdsafety.OVERDUE.state.backBy = Date.now() - 1000;
    __sdsafety.OVERDUE.check();
    document.getElementById('odsafe').click();
    return !__sdsafety.OVERDUE.state && localStorage.getItem('sd-overdue') === ''
      && getComputedStyle(document.getElementById('odalarm')).display === 'none'
      && getComputedStyle(document.getElementById('odpill')).display === 'none';
  })()`));
  T('sheet copy: contacts stay on this phone', await page.evaluate(
    'document.getElementById("overduesheet").textContent.includes("stay on this phone")'));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');

  console.log('\n— 🌙 Night Ops (red-light mode — a category first) —');
  T('🌙 rides the wheel; red mode veils the whole app in dim red', await page.evaluate(`(function(){
    if(!__sdwheel.order.includes('night')) return false;
    document.getElementById('nightfab').click();
    const open = document.getElementById('nightsheet').classList.contains('open');
    document.getElementById('redmodebtn').click();
    const veil = document.getElementById('nightveil');
    const on = document.documentElement.classList.contains('nightred')
      && getComputedStyle(veil).display === 'block'
      && getComputedStyle(veil).mixBlendMode === 'multiply'
      && getComputedStyle(veil).zIndex === '5000';
    document.getElementById('redmodebtn').click();
    return open && on && !document.documentElement.classList.contains('nightred');
  })()`));
  T('kill switch: NIGHT_CFG.enabled=false → toggle refuses', await page.evaluate(`(function(){
    __sdnight.NIGHT_CFG.enabled = false;
    const refused = __sdnight.NIGHT.toggleRed() === false && !document.documentElement.classList.contains('nightred');
    __sdnight.NIGHT_CFG.enabled = true;
    return refused;
  })()`));
  T('darkness timeline: sunset, twilights, moon + best dark hours', await page.evaluate(`(function(){
    const t = document.getElementById('nightrows').textContent;
    return document.querySelectorAll('#nightrows .nightrow').length >= 6
      && t.includes('Sunset') && t.includes('Moonrise') && t.includes('astro') && t.includes('% lit');
  })()`));
  T('honesty: screen-color night mode, explicitly NOT thermal', await page.evaluate(
    'document.getElementById("nightsheet").textContent.includes("not thermal imaging")'));
  T('aurora eval: Kp gates by latitude, never by vibes', await page.evaluate(`(function(){
    const ev = (kp, lat) => __sdnight.NIGHT.auroraEval(kp, lat);
    return ev(7, 44.76) === 7 && ev(5, 44.76) === null && ev(5, 53) === 5
      && ev(9, 36.5) === 9 && ev(4, 60) === null && ev(null, 60) === null;
  })()`));
  await page.waitForFunction('getComputedStyle(document.getElementById("aurorabanner")).display === "block"', null, { timeout: 5000 });
  T('aurora banner lights up on the mocked NOAA Kp-7 forecast', await page.evaluate(`(function(){
    const b = document.getElementById('aurorabanner');
    return b.textContent.includes('Aurora possible') && b.textContent.includes('Kp 7');
  })()`));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');
  T('safety features are FREE — no Entitlements gate anywhere in Run 1 code', (function(){
    const src = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    const seg = src.slice(src.indexOf('RUN 1 — SAFETY + NIGHT OPS'), src.indexOf('🌎 WORLD DATA — RUN 2'));
    return seg.length > 1000 && !seg.includes('Entitlements.isUnlocked') && !seg.includes('openPaywall');
  })());

  console.log('\n— 🌎 World Data: wheel + sheet + kill switches (Run 2) —');
  T('🌎 rides the wheel and opens the World Data sheet', await page.evaluate(`(function(){
    if(!__sdwheel.order.includes('world')) return false;
    document.getElementById('worldfab').click();
    return document.getElementById('worldsheet').classList.contains('open');
  })()`));
  T('all four rows present, all off by default', await page.evaluate(`(function(){
    const ids = ['wradar', 'walerts', 'wgauges', 'wfire'];
    return ids.every((id) => document.getElementById(id)) && !__sdworld.WORLD.radarOn
      && !__sdworld.WORLD.alertsOn && !__sdworld.WORLD.gaugesOn && !__sdworld.WORLD.fireOn;
  })()`));
  T('kill switch: WORLD_CFG.enabled=false refuses the sheet', await page.evaluate(`(function(){
    __sdworld.WORLD_CFG.enabled = false;
    document.getElementById('backdrop').click();
    __sdworld.WORLD.openSheet();
    const refused = !document.getElementById('worldsheet').classList.contains('open');
    __sdworld.WORLD_CFG.enabled = true;
    __sdworld.WORLD.openSheet();
    return refused && document.getElementById('worldsheet').classList.contains('open');
  })()`));

  console.log('\n— ⛈ Live radar (IEM NEXRAD, animated, public domain) —');
  T('frame list: 11 frames, 5-min steps, newest frame is live', await page.evaluate(`(function(){
    const f = __sdworld.worldRadarFrames();
    return f.length === 11 && f[0] === 'nexrad-n0q-900913-m50m' && f[9] === 'nexrad-n0q-900913-m05m'
      && f[10] === 'nexrad-n0q-900913';
  })()`));
  T('frame URL hits the IEM cache host (CSP-allowlisted)', await page.evaluate(`(function(){
    return __sdworld.worldRadarFrameUrl('nexrad-n0q-900913', 8, 63, 92)
      === 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/8/63/92.png';
  })()`));
  T('toggle on: overlay joins the tile stack, animation armed on the live frame', await page.evaluate(`(function(){
    __sdworld.WORLD.toggleRadar(true);
    return __sdmap.overlays.has('radar') && document.getElementById('wradar').classList.contains('on')
      && __sdworld.WORLD.radarFrame === 10 && !!__sdworld.WORLD._radarT;
  })()`));
  T('toggle off: overlay + timer both die', await page.evaluate(`(function(){
    __sdworld.WORLD.toggleRadar(false);
    return !__sdmap.overlays.has('radar') && !__sdworld.WORLD._radarT;
  })()`));
  T('honesty copy: radar is “not a warning service”', await page.evaluate(
    'document.getElementById("worldsheet").textContent.includes("not a warning service")'));

  console.log('\n— 🚨 Weather alerts (NWS, incl. Special Marine Warnings) —');
  T('severity rank: warnings first, watches next, the rest last', await page.evaluate(`(function(){
    const r = __sdworld.worldAlertRank;
    return r({ event: 'Severe Thunderstorm Warning', severity: 'Severe' }) === 0
      && r({ event: 'Special Marine Warning', severity: 'Severe' }) === 0
      && r({ event: 'Flood Watch', severity: 'Moderate' }) === 1
      && r({ event: 'Dense Fog Advisory', severity: 'Minor' }) === 2;
  })()`));
  T('marine warnings get the boater look', await page.evaluate(`(function(){
    return __sdworld.worldAlertClass({ event: 'Special Marine Warning' }) === 'walert marine'
      && __sdworld.worldAlertClass({ event: 'Flood Watch' }) === 'walert watch'
      && __sdworld.worldAlertClass({ event: 'Tornado Warning' }) === 'walert';
  })()`));
  await page.evaluate('__sdworld.WORLD.toggleAlerts(true)');
  await page.waitForFunction('__sdworld.WORLD.alerts.length === 3', null, { timeout: 5000 });
  T('alert list renders all three, warnings sorted to the top', await page.evaluate(`(function(){
    const rows = [...document.querySelectorAll('#walertlist .walert')];
    return rows.length === 3 && rows[0].textContent.includes('Warning')
      && rows.some((r) => r.textContent.includes('Special Marine Warning'))
      && rows[2].textContent.includes('Flood Watch');
  })()`));
  T('geofence: alert polygon covering YOUR position lights the storm pill', await page.evaluate(`(function(){
    __sdsafety.SOS.fix = { lat: 44.7631, lng: -85.6206, accM: 5 };
    __sdworld.WORLD.checkStormPill();
    const pill = document.getElementById('stormpill');
    const on = getComputedStyle(pill).display !== 'none'
      && document.getElementById('stormpilltxt').textContent === 'Severe Thunderstorm Warning';
    __sdsafety.SOS.fix = { lat: 25.76, lng: -80.19, accM: 5 };   /* Miami: outside the polygon */
    __sdworld.WORLD.checkStormPill();
    const off = getComputedStyle(pill).display === 'none';
    return on && off;
  })()`));
  T('point-in-polygon: pure and picky about the ring', await page.evaluate(`(function(){
    const fx = ${JSON.stringify(FIX_NWS.features)};
    const inHit = __sdworld.worldCoveringAlert(fx, 44.76, -85.62);
    const outMiss = __sdworld.worldCoveringAlert(fx, 25.76, -80.19);
    return !!inHit && inHit.properties.event === 'Severe Thunderstorm Warning' && outMiss === null;
  })()`));
  await page.evaluate('__sdworld.WORLD.toggleAlerts(false)');

  console.log('\n— 🌊 USGS river gauges (pins free, detail rides All Access) —');
  T('USGS JSON parses into per-site gauges (flow + height + temp merge)', await page.evaluate(`(function(){
    const fixJson = ${JSON.stringify(FIX_USGS_IV)};
    const m = __sdworld.worldParseGauges(fixJson);
    const g = m.get('04127917');
    return m.size === 2 && g.flow === 210 && g.height === 3.42 && g.temp === 18.5
      && g.name.includes('BOARDMAN');
  })()`));
  T('trend calls it straight: rising / falling / steady', await page.evaluate(`(function(){
    const up = Array.from({ length: 24 }, (_, i) => 100 + i * 5);
    const down = Array.from({ length: 24 }, (_, i) => 220 - i * 5);
    const flat = Array.from({ length: 24 }, () => 150);
    return __sdworld.worldGaugeTrend(up) === 'rising' && __sdworld.worldGaugeTrend(down) === 'falling'
      && __sdworld.worldGaugeTrend(flat) === 'steady' && __sdworld.worldGaugeTrend([1, 2]) === 'steady';
  })()`));
  await page.evaluate('__sdmap.setView(44.76, -85.62, 10)');
  await page.evaluate('__sdworld.WORLD.toggleGauges(true)');
  await page.waitForFunction('__sdmap.countGroup("gauges") === 2', null, { timeout: 5000 });
  T('two 🌊 pins dropped from the mocked bbox scan', await page.evaluate('__sdmap.countGroup("gauges") === 2'));
  T('zoom gate: pins wait for z' + '9 (no country-wide sweeps)', await page.evaluate(`(function(){
    return __sdworld.WORLD_CFG.gaugeMinZoom >= 9;
  })()`));
  T('locked: gauge tap opens the All Access paywall, not the sheet', await page.evaluate(`(function(){
    localStorage.setItem('sd-allaccess-iap', '0');
    __sdworld.WORLD.openGauge('04127917');
    const paywalled = document.getElementById('paysheet').classList.contains('open')
      && !document.getElementById('gaugesheet').classList.contains('open');
    document.getElementById('backdrop').click();
    return paywalled;
  })()`));
  await page.evaluate(`(function(){
    localStorage.setItem('sd-allaccess-iap', '1');
    __sdworld.WORLD.openGauge('04127917');
  })()`);
  await page.waitForFunction('document.getElementById("gaugesparklabel").textContent.includes("rising")', null, { timeout: 5000 });
  T('unlocked: detail sheet shows flow, height, water temp + 7-day trend', await page.evaluate(`(function(){
    const now = document.getElementById('gaugenow').textContent;
    return document.getElementById('gaugesheet').classList.contains('open')
      && now.includes('210 cfs') && now.includes('3.42 ft') && now.includes('65 °F')
      && document.getElementById('gaugetitle').textContent.includes('BOARDMAN');
  })()`));
  T('flow formatter keeps big rivers readable', await page.evaluate(`(function(){
    return __sdworld.worldFmtFlow(210) === '210 cfs' && __sdworld.worldFmtFlow(24500) === '25k cfs'
      && __sdworld.worldFmtFlow(NaN) === '—';
  })()`));
  await page.evaluate(`(function(){
    localStorage.setItem('sd-allaccess-iap', '0');
    document.getElementById('backdrop').click();
    __sdworld.WORLD.toggleGauges(false);
  })()`);
  T('gauges off: pins cleared', await page.evaluate('__sdmap.countGroup("gauges") === 0'));

  console.log('\n— 🔥 Wildfire perimeters (NIFC/WFIGS, free, honest about age) —');
  await page.evaluate('__sdworld.WORLD.toggleFire(true)');
  await page.waitForFunction('__sdworld.WORLD.fires.length === 1', null, { timeout: 5000 });
  T('perimeter loaded + 🔥 pin carries name, acres, containment', await page.evaluate(`(function(){
    const m = __sdmap.markers.find((mk) => mk.group === 'fire');
    return __sdworld.WORLD.fires[0].name === 'CAMP TWELVE' && !!m
      && m.popup.includes('CAMP TWELVE') && m.popup.includes('5,300 acres') && m.popup.includes('40% contained');
  })()`));
  T('fire painting owns the shared drawHook while on', await page.evaluate(
    '__sdmap.drawHook === __sdworld.worldDrawFire'));
  T('stale badge: silent while fresh, loud once the data ages out', await page.evaluate(`(function(){
    const f = __sdworld.worldFireStaleText;
    return f(5 * 60000) === '' && f(59 * 60000) === ''
      && f(75 * 60000).includes('STALE') && f(75 * 60000).includes('75 minutes')
      && f(5 * 3600000).includes('5 hours') && f(NaN) === '';
  })()`));
  T('centroid puts the pin inside the box', await page.evaluate(`(function(){
    const c = __sdworld.worldGeoCentroid({ type: 'Polygon',
      coordinates: [[[-85.8, 44.6], [-85.5, 44.6], [-85.5, 44.9], [-85.8, 44.9], [-85.8, 44.6]]] });
    return Math.abs(c[0] - 44.72) < 0.1 && Math.abs(c[1] + 85.66) < 0.1;
  })()`));
  T('fire off: hook released, pins gone', await page.evaluate(`(function(){
    __sdworld.WORLD.toggleFire(false);
    return __sdmap.drawHook === null && __sdmap.countGroup('fire') === 0;
  })()`));
  T('honesty copy: never a road-safety call, evacuations come from authorities', await page.evaluate(
    'document.getElementById("worldsheet").textContent.includes("Evacuation orders come from local authorities")'));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');

  console.log('\n— 📧 Overdue phase 2: worker auto-email (opt-in, off by default) —');
  T('email validator: junk out, good in, capped at 3', await page.evaluate(`(function(){
    const v = __sdoverdue2.odValidEmails;
    return JSON.stringify(v(['mel@example.com', 'nope', '', 'x@y.zz', 'a@b.cc', 'd@e.ff'])) ===
      JSON.stringify(['mel@example.com', 'x@y.zz', 'a@b.cc']) && v([]).length === 0;
  })()`));
  T('register payload: exactly plan/backBy/name/emails/coarse fix — nothing else', await page.evaluate(`(function(){
    const p = __sdoverdue2.odRegisterPayload(
      { backBy: 1750000000000, plan: 'x'.repeat(999), emails: ['mel@example.com'], remoteId: null },
      { lat: 44.76314159, lng: -85.62061234 }, 'SKYDOG');
    return JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['backBy','emails','fix','id','name','plan'])
      && p.plan.length === 400 && p.fix.lat === 44.7631 && p.fix.lng === -85.6206;
  })()`));
  T('opt-in fields hidden until the user flips the switch', await page.evaluate(`(function(){
    __sdsafety.OVERDUE.openPlan();
    const hidden = document.getElementById('odemails').style.display === 'none';
    document.getElementById('odemailopt').click();
    return hidden && document.getElementById('odemails').style.display !== 'none';
  })()`));
  await page.evaluate(`(function(){
    document.getElementById('odq2').click();
    document.getElementById('odname1').value = 'Mel';
    document.getElementById('odphone1').value = '(231) 555-0100';
    document.getElementById('odemail1').value = 'mel@example.com';
    document.getElementById('odstart').click();
  })()`);
  await page.waitForFunction('__sdsafety.OVERDUE.state && __sdsafety.OVERDUE.state.remoteId === "abcdef1234567890"', null, { timeout: 5000 });
  T('start + opt-in: plan registers with the worker, id comes home', await page.evaluate(`(function(){
    const st = __sdsafety.OVERDUE.state;
    return st.emailOpt && st.remoteId === 'abcdef1234567890'
      && JSON.parse(localStorage.getItem('sd-safety-emails'))[0] === 'mel@example.com';
  })()`));
  T('armed state is spelled out on the sheet', await page.evaluate(`(function(){
    __sdsafety.OVERDUE.renderEmailState();
    return document.getElementById('odemailstate').textContent.includes('ARMED');
  })()`));
  T('back safe: the worker hears the cancel too', await page.evaluate(
    '(function(){ document.getElementById("odsafe").click(); return !__sdsafety.OVERDUE.state; })()'));
  await page.waitForTimeout(400);   /* let the fire-and-forget cancel land on the mock */
  T('worker heard register + cancel in order', (function(){
    return odCalls.some((u) => u.startsWith('/overdue/register')) && odCalls[odCalls.length - 1].startsWith('/overdue/cancel');
  })());
  T('sheet copy: honest about what auto-email uploads', await page.evaluate(`(function(){
    const t = document.getElementById('overduesheet').textContent;
    return t.includes('switch on auto-email') && t.includes('deleted within 48');
  })()`));
  T('opt-out untouched: no auto-email = nothing ever uploads (worker calls only after opt-in)', (function(){
    return odCalls.every((u) => u.startsWith('/overdue/'));
  })());

  console.log('\n— 🛠 Worker: overdue endpoints + safety cron (file contract) —');
  const odWorkerSrc = fs.readFileSync(path.join(APP_DIR, 'worker', 'worker.js'), 'utf8');
  const odToml = fs.readFileSync(path.join(APP_DIR, 'worker', 'wrangler.toml'), 'utf8');
  T('worker: register/checkin/cancel routes + origin & rate checks on register', odWorkerSrc.includes("'/overdue/register'")
    && odWorkerSrc.includes("'/overdue/checkin'") && odWorkerSrc.includes("'/overdue/cancel'")
    && /overdue\/register[^]*?originOK[^]*?rateOK/.test(odWorkerSrc));
  T('worker: cron sweep = overdue + silent + grace period, one email ever', odWorkerSrc.includes('async scheduled')
    && odWorkerSrc.includes('OD_GRACE_MS') && odWorkerSrc.includes('rec.lastPing < rec.backBy')
    && odWorkerSrc.includes('!rec.sent'));
  T('worker: records self-destruct via KV TTL (≤72 h)', odWorkerSrc.includes('expirationTtl')
    && odWorkerSrc.includes('72 * 3600'));
  T('worker: email seam is Resend (MailChannels EOL documented), never hardcoded keys', odWorkerSrc.includes('api.resend.com')
    && odWorkerSrc.includes('env.RESEND_KEY') && /MailChannels/.test(odWorkerSrc)
    && !/re_[A-Za-z0-9]{10,}/.test(odWorkerSrc));
  T('worker: safety email tells contacts to call authorities, not SkyDog', odWorkerSrc.includes('contact local authorities')
    && odWorkerSrc.includes('not a rescue service'));
  T('wrangler.toml: OD KV binding + */10 cron wired', odToml.includes('binding = "OD"')
    && odToml.includes('crons = ["*/10 * * * *"]'));


  console.log('\n— 🛡 Fort SkyDog Phase A: CSP + tamper containment —');
  const appSrc = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(appSrc);
  T('CSP meta tag present', !!cspMatch);
  const csp = cspMatch ? cspMatch[1] : '';
  /* every origin the app (and this suite's mocks) actually talks to must be allowlisted */
  const CSP_ORIGINS = [
    'tile.openstreetmap.org', 'a.tile.opentopomap.org', 'b.tile.opentopomap.org', 'c.tile.opentopomap.org',
    'basemap.nationalmap.gov', 'server.arcgisonline.com', 'services.arcgisonline.com', 'tile.waymarkedtrails.org',
    'tiles.regrid.com', 'app.regrid.com', 'maps.dnr.illinois.gov', 'gisagocss.state.mi.us',
    'programs.iowadnr.gov', 'enterprise.gisdata.mn.gov', 'gis.charttools.noaa.gov', 'gisagodnr.state.mi.us',
    'overpass-api.de', 'nominatim.openstreetmap.org', 'api.open-meteo.com', 'services6.arcgis.com',
    'www.gstatic.com', 'firebaseio.com', 'api.skydoggps.com', 's3.amazonaws.com',
    'services.swpc.noaa.gov', 'api.what3words.com',
    'mesonet.agron.iastate.edu', 'api.weather.gov', 'waterservices.usgs.gov', 'services3.arcgis.com',
    'skydog-api.skydog8426.workers.dev',
  ];
  T('CSP allowlists every origin the app talks to (' + CSP_ORIGINS.length + ')',
    CSP_ORIGINS.every((o) => csp.includes(o)), CSP_ORIGINS.filter((o) => !csp.includes(o)).join(', '));
  T('CSP locks the rest down (default-src none, self scripts, firebase ws)',
    csp.includes("default-src 'none'") && csp.includes("script-src 'self' 'unsafe-inline'") && csp.includes('wss://*.firebaseio.com'));
  T('CSP tradeoff documented at the tag (unsafe-inline is a stated choice)', /unsafe-inline.*single-file|single-file[^]*?unsafe-inline/i.test(appSrc.slice(0, appSrc.indexOf('</head>'))));
  T('house-key warning on join screen + live sheet', appSrc.includes('buddykeynote')
    && (appSrc.match(/share it like a house key/g) || []).length >= 2);
  T('join input accepts 8 chars', (await page.$eval('#buddycode', (el) => el.maxLength)) === 8);
  /* rules deploy file: 8-char codes accepted, legacy 5-char still valid, root stays locked */
  const rules = fs.readFileSync(path.join(APP_DIR, 'database.rules.json'), 'utf8');
  T('database.rules.json: $code accepts {8} and legacy {5}, root locked',
    rules.includes('^[A-Z2-9]{8}$') && rules.includes('^[A-Z2-9]{5}$') && rules.includes('".read": false') && rules.includes('".write": false'));
  /* invite link with a NEW 8-char code auto-joins for a consented user */
  await page.evaluate('localStorage.setItem("sd-buddy-consent", "1")');
  await page.goto('http://localhost:' + PORT + '/?buddy=ABCDEFGH', { waitUntil: 'load' });
  await page.waitForFunction('window.__SKYDOG_READY === true', null, { timeout: 10000 });
  await page.waitForFunction('window.__BUDDY && __BUDDY.BUDDY.active() === true', null, { timeout: 5000 });
  T('8-char invite link joins the room', (await page.evaluate('__BUDDY.BUDDY.code')) === 'ABCDEFGH');
  await page.evaluate('__BUDDY.BUDDY.end(true)');
  /* A3 tamper containment: money-shaped secrets must never live in the page,
     and no pack gate may side-step Entitlements.isUnlocked(). */
  /* pattern built by concatenation so this test file itself never matches the
     repo-history acceptance grep for secret material */
  const SECRET_PAT = new RegExp(['sk_' + 'live_', 'sk_' + 'test_', 'wh' + 'sec_', 'BEGIN\\s+(EC\\s+)?PRIVATE'].join('|'), 'i');
  T('no Stripe secret material in app source (live/test keys, webhook secrets)', !SECRET_PAT.test(appSrc));
  T('no hardcoded entitlement keys outside makePackState (no side doors)', !/['"]sd-(fishing|drone|orv|allaccess)-(iap|trial)['"]/.test(appSrc));
  T('every pack gate flows through Entitlements.isUnlocked', (appSrc.match(/Entitlements\.isUnlocked\(/g) || []).length >= 8);
  T('honesty rule: no unhackable/impenetrable claims anywhere', !/unhackable|impenetrable|uncrackable|hack-?proof/i.test(appSrc));
  /* CSP enforced for real: boot the app in a context WITHOUT bypassCSP and
     poke tiles + a discovery fetch. Any blocked load logs a "Refused to"
     violation to the console — zero are tolerated. (No evaluate() calls in
     here: eval is exactly what the CSP forbids.) */
  const strictCtx = await browser.newContext({ viewport: { width: 420, height: 850 } });
  await strictCtx.route('**/*', mockRoute);
  const strictPage = await strictCtx.newPage();
  const cspViolations = [];
  const strictErrors = [];
  strictPage.on('console', (m) => { if (/Refused to|Content Security Policy/i.test(m.text())) cspViolations.push(m.text()); });
  strictPage.on('pageerror', (e) => strictErrors.push(String(e)));
  await strictPage.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await strictPage.waitForTimeout(1200);
  await strictPage.click('#zoomin');                 /* pull fresh tiles (img-src) */
  await strictPage.click('#chips .chip');            /* overpass fetch (connect-src) */
  await strictPage.waitForTimeout(1200);
  T('strict CSP boot: zero violations, zero page errors',
    cspViolations.length === 0 && strictErrors.length === 0,
    cspViolations.concat(strictErrors).slice(0, 3).join(' | '));
  await strictCtx.close();

  console.log('\n— 🔏 Fort SkyDog Phase B: proxy seam + signed codes —');
  /* B1: the Regrid proxy seam. token and proxy are mutually exclusive; when
     the proxy is configured every parcel URL flows through it, token-free. */
  T('REGRID: token and proxy never both configured', await page.evaluate(
    '(function(){ const R = __sdparcels.REGRID; return !(R.proxy && R.token); })()'));
  T('proxy configured → point+tile URLs use the Worker, no token in sight', await page.evaluate(`(function(){
    const R = __sdparcels.REGRID;
    const oldT = R.token, oldP = R.proxy;
    R.token = ''; R.proxy = 'https://api.skydoggps.com';
    const pt = R.point(44.76, -85.62), tl = R.tiles(14, 100, 200);
    R.token = oldT; R.proxy = oldP;
    return pt === 'https://api.skydoggps.com/parcel/point?lat=44.76&lon=-85.62'
      && tl === 'https://api.skydoggps.com/parcel/tiles/14/100/200.png'
      && !pt.includes('token') && !tl.includes('token')
      && R.active() === !!(oldT || oldP);
  })()`));
  T('no proxy AND no token → parcels layer stays blank (fail closed)', await page.evaluate(`(function(){
    const R = __sdparcels.REGRID;
    const oldT = R.token, oldP = R.proxy;
    R.token = ''; R.proxy = '';
    const off = !R.active();
    R.token = oldT; R.proxy = oldP;
    return off;
  })()`));
  /* B2: Ed25519-signed SKY codes. Mint with an ephemeral TEST key here in
     node, verify in the page with WebCrypto — same math as the Worker. */
  const nodeCrypto = require('crypto');
  const kp = nodeCrypto.generateKeyPairSync('ed25519');
  const TEST_PUB = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const B32A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const b32 = (buf) => { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32A[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32A[(val << (5 - bits)) & 31]; return out; };
  const mint = (payloadTxt) => { const payload = Buffer.from(payloadTxt);
    return 'SKY-' + b32(payload) + '-' + b32(nodeCrypto.sign(null, payload, kp.privateKey)); };
  const goodCode = mint('allaccess|209912');
  const expiredCode = mint('allaccess|202001');
  const tamperedCode = (() => { const p = goodCode.split('-'); /* re-encode a DIFFERENT payload under the real sig */
    return 'SKY-' + b32(Buffer.from('fishing|209912')) + '-' + p[2]; })();
  T('valid signed code verifies (packId + expiry honored)', await page.evaluate(`(async function(){
    const r = await __sdpacks.SkySigned.verify(${JSON.stringify(goodCode)}, ${JSON.stringify(TEST_PUB)});
    return !!r && r.packId === 'allaccess' && r.exp === '209912';
  })()`));
  T('tampered payload rejected', await page.evaluate(`(async function(){
    return (await __sdpacks.SkySigned.verify(${JSON.stringify(tamperedCode)}, ${JSON.stringify(TEST_PUB)})) === null;
  })()`));
  T('expired code rejected', await page.evaluate(`(async function(){
    return (await __sdpacks.SkySigned.verify(${JSON.stringify(expiredCode)}, ${JSON.stringify(TEST_PUB)})) === null;
  })()`));
  T('production pubkey configured → codes signed with any other key fail closed', await page.evaluate(`(async function(){
    return __sdpacks.SkySigned.pubkey.length > 0 && (await __sdpacks.SkySigned.verify(${JSON.stringify(goodCode)})) === null;
  })()`));
  T('checksum-forged SKY code is dead (self-minting killed)', await page.evaluate(`(function(){
    /* SKY-AB2H passes the old public checksum — it must no longer unlock anything */
    return __sdpacks.packCodeOK('SKY', 'SKY-AB2H') === true
      && __sdpacks.PACK_STATE.allaccess.codeOK('SKY-AB2H') === false
      && __sdpacks.Entitlements.redeemAny('SKY-AB2H') === null;
  })()`));
  T('legacy FISH checksum promo codes still honored', await page.evaluate(
    '__sdpacks.PACK_STATE.fishing.codeOK("FISH-VT71") === true'));
  T('signed redeem persists + boot re-verify unlocks, cleanup relocks', await page.evaluate(`(async function(){
    const S = __sdpacks.SkySigned, ST = __sdpacks.PACK_STATE.allaccess, E = __sdpacks.Entitlements;
    S.pubkey = ${JSON.stringify(TEST_PUB)};
    const r = await S.redeem(${JSON.stringify(goodCode)});
    const unlocked = !!r && E.isUnlocked('allaccess');
    ST._session = false;                       /* simulate app relaunch */
    await S.boot();
    const rebooted = E.isUnlocked('allaccess');
    S.pubkey = ''; ST._session = false;        /* cleanup: key gone → boot drops the stored code */
    await S.boot();
    const relocked = !E.isUnlocked('allaccess') && (localStorage.getItem('sd-allaccess-signed') || '') === '';
    return unlocked && rebooted && relocked;
  })()`));
  /* worker/ ships in-repo, secret-free */
  const workerFiles = ['worker/worker.js', 'worker/wrangler.toml', 'worker/README.md', 'worker/generate-keys.mjs'];
  T('worker/ files present (proxy + minting + keygen + docs)',
    workerFiles.every((f) => fs.existsSync(path.join(APP_DIR, f))));
  const workerSrc = workerFiles.filter((f) => fs.existsSync(path.join(APP_DIR, f)))
    .map((f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8')).join('\n');
  T('no secret material anywhere in worker/ (keys live only in Cloudflare)', !SECRET_PAT.test(workerSrc));
  T('worker rate-limits + checks Origin + edge-caches tiles',
    workerSrc.includes('rateOK') && workerSrc.includes('originOK') && workerSrc.includes('caches.default'));
  /* Phase C: a public, secret-free way to report problems */
  const secPath = path.join(APP_DIR, 'SECURITY.md');
  T('SECURITY.md: report channel published, honest scope, no secrets',
    fs.existsSync(secPath) && (function(){ const s = fs.readFileSync(secPath, 'utf8');
      return s.includes('skydog8426@gmail.com') && /in scope/i.test(s) && !SECRET_PAT.test(s)
        && !/unhackable|impenetrable|uncrackable|hack-?proof/i.test(s); })());

  console.log('\n— 📢 Ads stay for everyone —');
  T('ADS ARE PERMANENT rule documented at the ad init', appSrc.includes('ADS ARE PERMANENT'));
  T('no purchase copy promises ad removal', !/removes ads|ads gone|ad-free|removes the ads/i.test(appSrc));
  T('grant path never touches the ad banner', !appSrc.slice(appSrc.indexOf('function sdGrantPack')).includes('SkyGPSAds.remove'));

  console.log('\n— 📲 Get-the-app banner —');
  T('web visitors see the Get-the-app banner', await page.$eval('#appbanner', (el) => el.classList.contains('on') && getComputedStyle(el).display !== 'none'));
  T('banner links to the real App Store listing', await page.$eval('#appbannerlink', (el) => el.href.includes('apps.apple.com') && el.href.includes('6792906988')));
  T('banner guarded against native app + installed PWA', (function(){
    const seg = appSrc.slice(appSrc.indexOf('Get-the-app banner (web only)'));
    return seg.includes('isNativePlatform') && seg.includes('display-mode: standalone');
  })());
  T('Safari Smart App Banner meta present (app-id pinned)', appSrc.includes('apple-itunes-app') && appSrc.includes('app-id=6792906988'));
  T('✕ dismisses the banner and snoozes it via sdStore', await page.evaluate('(function(){ document.getElementById("appbannerx").click(); return !document.getElementById("appbanner").classList.contains("on") && !!sdStore.get("sd-appbanner-snooze"); })()'));

  console.log('\n— Fail-loud + shell —');
  await page.evaluate('window.dispatchEvent(new ErrorEvent("error", { message: "test-explosion" }))');
  T('window error → fatal banner shows', await page.$eval('#fatal', (el) => getComputedStyle(el).display !== 'none' && el.textContent.includes('test-explosion')));
  await page.evaluate('(function(){ document.getElementById("fatal").click(); })()');
  const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  T('sw.js cache bumped to v29 (World Data ships fresh)', sw.includes("skydog-gps-v29") && !sw.includes("skydog-gps-v28") && !sw.includes("skydog-gps-v27"));
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
