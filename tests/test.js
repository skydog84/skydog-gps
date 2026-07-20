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

let pass = 0, fail = 0;
const failures = [];
function T(name, cond, info){
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (info ? ' — ' + info : '')); console.log('  ❌ ' + name + (info ? ' — ' + info : '')); }
}

async function main(){
  /* static server */
  const server = http.createServer((req, res) => {
    const f = path.join(APP_DIR, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
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
    if (url.includes('open-meteo')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"elevation":[190]}' });
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
  T('subscribe btn wired to live Stripe link', await page.$eval('#paysub', (el) => (el.getAttribute('href') || '').startsWith('https://buy.stripe.com/')));
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
  T('storage holds ONLY license keys (trips stay in-memory)', await page.evaluate(
    'Object.keys(localStorage).every((k) => k.startsWith("sd-fishpack"))'));
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
    && (await page.evaluate('localStorage.getItem("sd-fishpack-trial")')) === '1');
  await page.click('#fishfab'); /* off */
  await page.evaluate('__sdfish.FISHPACK._session = false');
  await page.click('#fishfab'); /* paywall again */
  T('trial is one-shot: button gone on next visit', await page.$eval('#paytrial', (el) => getComputedStyle(el).display === 'none'));
  await page.evaluate('(function(){ document.getElementById("backdrop").click(); })()');

  console.log('\n— Fail-loud + shell —');
  await page.evaluate('window.dispatchEvent(new ErrorEvent("error", { message: "test-explosion" }))');
  T('window error → fatal banner shows', await page.$eval('#fatal', (el) => getComputedStyle(el).display !== 'none' && el.textContent.includes('test-explosion')));
  await page.evaluate('(function(){ document.getElementById("fatal").click(); })()');
  const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  T('sw.js cache bumped to v10', sw.includes("skydog-gps-v10") && !sw.includes("skydog-gps-v9"));
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
