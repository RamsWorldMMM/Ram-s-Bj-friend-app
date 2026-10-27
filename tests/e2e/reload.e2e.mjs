// End-to-end: Ram's phone, reloading onto the current build.
//
// THE MOMENT THAT LOST 145 ROUNDS. On 26 October Ram's phone storage was full,
// frozen at R1609, while play went on to R1754 in the open tab; a refresh brought
// back R1609. This seeds a phone in exactly that state — near-full, engine save at
// R1609, round log at 1608 — while the server holds the newer game, then loads the
// real app in Chrome and checks that the newer game is picked up, storage frees,
// syncs carry only new rounds, and the save warning says the right thing.
//
// Not part of `npm test`: it needs a browser and a running local Worker.
//
//   npm i --no-save playwright-core@1.48.2
//   export BJF_E2E_STATE=$(mktemp -d)
//   npx wrangler d1 execute rams-bj-friend --local --persist-to "$BJF_E2E_STATE" \
//     --file=tests/fixtures/schema-before-chunking.sql      # production's old shape
//   npx wrangler dev --local --persist-to "$BJF_E2E_STATE" --port 8787 &
//   node tests/e2e/reload.e2e.mjs
//
// It creates its own 'ram' test account in that throwaway database. Use a fresh
// BJF_E2E_STATE for each run: the session it seeds must start below R1650.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { console.error('playwright-core is not installed: npm i --no-save playwright-core@1.48.2'); process.exit(2); }

const BASE = process.env.BJF_E2E_BASE || 'http://127.0.0.1:8787';
const STATE = process.env.BJF_E2E_STATE;
const SHOTS = process.env.BJF_E2E_SHOTS || tmpdir();
const CHROME = process.env.BJF_E2E_CHROME || '/usr/bin/google-chrome';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (!STATE) { console.error('Set BJF_E2E_STATE to the --persist-to directory the local Worker is using.'); process.exit(2); }
const S = 'sess-ram-e2e';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${cond ? '' : extra}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'rams-bj-friend',
  '--local', '--persist-to', STATE, '--json', '--command', sql],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;

/* ------------------------------------------------------------- fixtures --
 * Shaped like the real thing: rounds as history.js snapshots them (padded to
 * ~2,140 chars, Ram's real size is ~2,279), state as the engine keeps it. */
const round = (n) => ({
  round: n, shoeNumber: Math.ceil(n / 52), engineShoeNumber: 1, shoeRound: ((n - 1) % 52) + 1,
  ts: 1792000000000 + n * 60000, mode: 'practice',
  dealer: ['9♣', '7♦'], dealerTotal: 16, dealerSoft: false, dealerBlackjack: false, dealerDrew: true,
  boxes: [{
    number: 1, wager: { main: 700, pairs: 100, trilux: 100, super: 100 },
    hands: [{ cards: ['10♠', '8♥'], total: 18, soft: false, bust: false, bet: 700, isSplit: false, result: 'Won', net: 700 }],
    decisions: [{ hand: ['10♠', '8♥'], dealerFirst: '9♣', chosen: 'Stand', recommended: 'Stand', correct: true }],
    side: {
      pairs: { name: 'No pair', net: -100, stake: 100, mult: 0 },
      trilux: { name: 'No qualifying hand', net: -100, stake: 100, mult: 0 },
      super: { name: 'No qualifying hand', net: -100, stake: 100, mult: 0 },
    },
    mainNet: 700, sideNet: -300, totalNet: 400,
  }],
  bankrollBefore: 10000 + (n - 1) * 400, bankrollAfter: 10000 + n * 400, net: 400, cardsRemaining: 200,
  pad: 'x'.repeat(1280),
});
const state = (n, events = 5) => ({
  start: 10000, bankroll: 10000 + n * 400, rounds: n, phase: 'ready', dealer: [], boxes: [],
  activeBox: 0, activeHand: 0, shoeEnded: false, roundStart: 10000 + n * 400,
  decisions: n, correct: n, mistakes: [], mainPL: n * 700, pairsPL: -n * 100, triluxPL: -n * 100, superPL: -n * 100,
  high: 10000 + n * 400, low: 10000, decisionMix: { hard: n, soft: 0, pair: 0, double: 0, split: 0, hit: 0, stand: n },
  boxStats: { 1: { decisions: n, correct: n, mainPL: n * 700 } },
  roundHistory: Array.from({ length: n }, (_, i) => ({ round: i + 1, boxes: 1, mainNet: 700, sideNet: -300, totalNet: 400, bankroll: 10000 + (i + 1) * 400 })),
  currentWinStreak: 1, currentLossStreak: 0, longestWinStreak: 9, longestLossStreak: 4,
  largestMainBet: 700, totalMainStaked: n * 700, totalSideStaked: n * 300, peakBankroll: 10000 + n * 400,
  maxDrawdown: 0, shoeNumber: 1,
  eventLog: Array.from({ length: n * events }, (_, i) => ({ type: 'decision', round: Math.floor(i / events) + 1, box: 1,
    hand: ['10♠', '8♥'], dealerFirst: '9♣', chosen: 'Stand', recommended: 'Stand', correct: true, cardsRemaining: 200 })),
});
const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const shoe = () => Array.from({ length: 6 }, () => RANKS.flatMap((r) => SUITS.map((s) => ({ r, s })))).flat();

/* --------------------------------------------------------------- browser */
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 412, height: 860 }, baseURL: BASE });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const syncs = [];
page.on('request', (r) => {
  if (r.url().endsWith('/api/sessions/sync') && r.method() === 'POST') {
    const body = r.postData() || '';
    let parsed = null; try { parsed = JSON.parse(body); } catch { /* */ }
    syncs.push({ bytes: body.length, newRounds: parsed && Array.isArray(parsed.newRounds) ? parsed.newRounds.map((x) => x.round) : null,
                 roundLog: parsed && Array.isArray(parsed.roundLog), rounds: parsed && parsed.state && parsed.state.rounds });
  }
});

// A test account in the throwaway database, hashed the way src/auth.js expects.
{
  const pw = 'e2e-pass-123', salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const b64 = (x) => Buffer.from(x).toString('base64');
  d1(`INSERT INTO users (id, username, password_hash, password_salt, iterations)
      VALUES ('u-e2e', 'ram', '${b64(bits)}', '${b64(salt)}', 100000)
      ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash,
        password_salt = excluded.password_salt, iterations = excluded.iterations`);
}

// Sign in through the context, so the page shares the cookie.
let r = await context.request.post('/api/login', { data: { username: 'ram', password: 'e2e-pass-123' } });
ok('signs in', r.ok(), String(r.status()));

/* ----------------------------------------- the server: Ram's game at R1650 --
 * Seeded the way his OLD build sends: the whole roundLog every time. */
console.log('\nSERVER — an old-build phone syncs the way Ram\'s did');
r = await context.request.post('/api/sessions/sync', { data: {
  sessionId: S, deviceId: 'ram-phone', appVersion: 'old', mode: 'practice',
  state: state(1635), shoe: shoe(), lastBets: [], roundLog: Array.from({ length: 1635 }, (_, i) => round(i + 1)),
} });
let body = await r.json();
ok('old-format sync of 1,635 rounds is accepted', r.ok() && body.logThrough === 1635, JSON.stringify(body).slice(0, 200));
r = await context.request.post('/api/sessions/sync', { data: {
  sessionId: S, deviceId: 'ram-phone', appVersion: 'old', mode: 'practice',
  state: state(1650), shoe: shoe(), lastBets: [], roundLog: Array.from({ length: 1650 }, (_, i) => round(i + 1)),
} });
body = await r.json();
ok('…and 15 more: only the new 15 are appended', body.appended === 15 && body.logThrough === 1650, JSON.stringify(body).slice(0, 200));

/* ------------------------------------------- the phone: frozen at R1609 ---- */
console.log('\nPHONE — storage as Ram\'s was: near full, frozen at R1609');
await page.goto('/api/health');
const seeded = await page.evaluate(({ st, log, sh, S }) => {
  localStorage.clear();
  const put = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const out = {};
  out.fresh = put('bjfFreshStart-2026-09-12', '1');   // his phone ran the one-time reset in September
  out.seen = put('bjfWhatsNewSeen', '1.4.9');         // keep the popup off the table for this test
  out.meta = put('bjfCloudMeta', JSON.stringify({ deviceId: 'ram-phone', sessionId: S }));
  out.engine = put('ramsBjFriendBetaV14', JSON.stringify({ state: st, lastBets: [], shoe: sh }));
  out.log = put('bjfRoundLog', JSON.stringify({ sessionId: S, rounds: log, truncated: false }));
  let total = 0; for (let i = 0; i < localStorage.length; i++) total += (localStorage.getItem(localStorage.key(i)) || '').length;
  out.totalChars = total;
  return out;
}, { st: state(1609), log: Array.from({ length: 1608 }, (_, i) => round(i + 1)), sh: shoe().slice(0, 250), S });
ok('seed fits, just under the quota (engine R1609, log 1608)', seeded.engine && seeded.log, JSON.stringify(seeded));
console.log(`        storage in use: ${(seeded.totalChars / 1e6).toFixed(2)} M chars`);

/* ------------------------------------------------------------- the reload */
console.log('\nRELOAD — the moment that lost 145 rounds on 26 October');
syncs.length = 0;
await page.goto('/');
let rounds = 0;
for (let i = 0; i < 60; i++) {
  rounds = await page.evaluate(() => (typeof state !== 'undefined' && state ? state.rounds : -1));
  if (rounds === 1650) break;
  await sleep(250);
}
ok('the newer saved game is picked up: R1650, not the stale R1609', rounds === 1650, `state.rounds = ${rounds}`);
await sleep(400);
const notice = await page.evaluate(() => {
  const b = document.getElementById('bjfSaveWarn');
  return b ? { cls: b.className, text: b.textContent } : null;
});
ok('he is told, in words, what just happened', Boolean(notice && /Picked up your latest saved game — round 1650/.test(notice.text)),
   JSON.stringify(notice));
await page.screenshot({ path: join(SHOTS, 'bjf-e2e-1-reload.png') });

await sleep(1500);
const after = await page.evaluate(() => {
  const len = (k) => (localStorage.getItem(k) || '').length;
  const log = JSON.parse(localStorage.getItem('bjfRoundLog') || 'null');
  return { engine: len('ramsBjFriendBetaV14'), log: len('bjfRoundLog'),
           logRounds: log ? log.rounds.length : null, ack: log ? log.ackThrough : null,
           first: log && log.rounds.length ? log.rounds[0].round : null,
           last: log && log.rounds.length ? log.rounds.at(-1).round : null,
           events: state.eventLog.length };
});
ok('engine save shrinks from ~1.6 M to under 0.6 M chars', after.engine < 600000, JSON.stringify(after));
ok('round log keeps the newest 300, all confirmed by the server', after.logRounds === 300 && after.ack === 1650 && after.last === 1650,
   JSON.stringify(after));
ok('…so storage is nowhere near full any more', after.engine + after.log < 1500000, `${after.engine + after.log} chars`);
ok('first sync after the reload carries no rounds and no full log',
   syncs.length > 0 && syncs[0].newRounds && syncs[0].newRounds.length === 0 && !syncs[0].roundLog,
   JSON.stringify(syncs.slice(0, 3)));
ok('…and is small', syncs.length > 0 && syncs[0].bytes < 500000, syncs.length ? `${syncs[0].bytes} bytes` : 'none');

/* --------------------------------------------------------------- play on */
async function dismissPopup() {
  // The "Application updated" card covers the deal buttons until answered.
  const later = await page.$('.bjf-wn-pop .later');
  if (later && await later.isVisible()) { try { await later.click({ timeout: 1000 }); } catch { /* gone */ } await sleep(400); }
}
async function playRound() {
  // Bets are remembered; deal, then Stand on every hand until it settles.
  await dismissPopup();
  await page.waitForSelector('#dealBtn', { state: 'visible', timeout: 10000 });
  const before = await page.evaluate(() => state.rounds);
  await page.click('#dealBtn');
  for (let i = 0; i < 80; i++) {
    const phase = await page.evaluate(() => state.phase);
    if (phase === 'complete' || phase === 'ready') break;
    const stand = await page.$('[data-action="S"]:not([disabled])');
    if (stand) { try { await stand.click({ timeout: 500 }); } catch { /* re-rendered */ } }
    await sleep(250);
  }
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => state.rounds)) > before) break;
    await sleep(150);
  }
  // Back to the betting screen. The dock's "Next round" appears only once the
  // round has settled — after reveal.js's pause — so wait for it, not a guess.
  const back = await page.waitForSelector('#returnToBettingBtn', { state: 'visible', timeout: 8000 }).catch(() => null);
  if (back) { try { await back.click({ timeout: 2000 }); } catch { /* re-rendered */ } }
  await page.waitForSelector('#dealBtn', { state: 'visible', timeout: 8000 }).catch(() => null);
  await sleep(700);   // the save, then the 400 ms sync debounce
  return page.evaluate(() => state.rounds);
}

console.log('\nPLAY — rounds after the reload sync one at a time');
syncs.length = 0;
rounds = await playRound();
ok('a round is played on the restored game', rounds === 1651, `state.rounds = ${rounds}`);
for (let i = 0; i < 20 && !syncs.some((s) => s.newRounds && s.newRounds.includes(1651)); i++) await sleep(250);
const s1651 = syncs.find((s) => s.newRounds && s.newRounds.includes(1651));
ok('its sync sends exactly that one round', Boolean(s1651) && s1651.newRounds.length === 1, JSON.stringify(syncs));
ok('…in a request a fraction of the old 5.5 MB', Boolean(s1651) && s1651.bytes < 500000, s1651 ? `${s1651.bytes} bytes` : '');
await sleep(800);
let srv = d1(`SELECT rounds, log_through, fork_of FROM sessions WHERE id = '${S}'`)[0];
ok('server holds R1651, no fork', srv.rounds === 1651 && srv.log_through === 1651 && srv.fork_of === null, JSON.stringify(srv));
ok('no fork row was created anywhere', d1(`SELECT COUNT(*) AS n FROM sessions WHERE fork_of IS NOT NULL`)[0].n === 0, '');

/* ------------------------------------------------- when saving does fail */
console.log('\nWARNING — when saving does fail');
/* Junk alone does not make OUR save fail — replacing a value frees its old space
   first, and the save barely grows a round now that the event list is capped.
   So make the quota error happen exactly as it did on 26 October: our two writes
   throw QuotaExceededError. */
const failSaves = () => page.evaluate(() => {
  const real = Storage.prototype.setItem;
  window.__realSetItem = real;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'ramsBjFriendBetaV14' || k === 'bjfRoundLog') {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    return real.call(this, k, v);
  };
});
const restoreSaves = () => page.evaluate(() => { Storage.prototype.setItem = window.__realSetItem; });
const readBar = () => page.evaluate(() => {
  const b = document.getElementById('bjfSaveWarn');
  return b ? { cls: b.className, text: b.textContent } : null;
});

// 1. Cloud failing, phone fine: amber after a few rounds.
await page.route('**/api/sessions/sync', (route) => route.abort());
for (let i = 0; i < 3; i++) rounds = await playRound();
await sleep(800);
let bar = await readBar();
ok('account unreachable, phone fine: amber, "not backed up for N rounds"',
   Boolean(bar && /warn show/.test(bar.cls) && /Not backed up to your account for 3 rounds/.test(bar.text)), JSON.stringify(bar));
await page.unroute('**/api/sessions/sync');
rounds = await playRound();
await sleep(1500);
bar = await readBar();
ok('…clears once the account answers again', Boolean(bar && !/show/.test(bar.cls)), JSON.stringify(bar));

// 2. Phone storage failing, account fine.
await failSaves();
rounds = await playRound();
await sleep(1200);
bar = await readBar();
ok('phone full but account fine: a calm note, not an alarm', Boolean(bar && /info show/.test(bar.cls) && /safe in your account/.test(bar.text)),
   JSON.stringify(bar));

// 3. Both failing — the 26 October situation.
await page.route('**/api/sessions/sync', (route) => route.abort());
rounds = await playRound();
await sleep(1500);
bar = await readBar();
ok('phone full AND account unreachable: red, says the rounds are saved nowhere',
   Boolean(bar && /critical show/.test(bar.cls) && /not saved anywhere/.test(bar.text) && /refresh/.test(bar.text)),
   JSON.stringify(bar));
// Measured where it matters: scrolled down, mid-session, where the sticky header
// pins itself to the top of the screen. Padding the page does not move it.
await page.evaluate(() => window.scrollTo(0, 700));
await sleep(300);
await page.screenshot({ path: join(SHOTS, 'bjf-e2e-2-critical.png') });
const covered = await page.evaluate(() => {
  const b = document.getElementById('bjfSaveWarn').getBoundingClientRect();
  const h = document.querySelector('.app-header').getBoundingClientRect();
  return { barBottom: Math.round(b.bottom), headerTop: Math.round(h.top), scrolled: Math.round(window.scrollY) };
});
ok('…and, scrolled mid-session, the bankroll header sits BELOW it, not under it',
   covered.scrolled > 0 && covered.headerTop >= covered.barBottom - 1, JSON.stringify(covered));
await page.evaluate(() => window.scrollTo(0, 0));

// 4. Everything recovers.
await page.unroute('**/api/sessions/sync');
await restoreSaves();
rounds = await playRound();
for (let i = 0; i < 30; i++) {
  bar = await page.evaluate(() => { const b = document.getElementById('bjfSaveWarn'); return b ? b.className : ''; });
  if (!/show/.test(bar)) break;
  await sleep(300);
}
ok('once saving works again, the warning clears itself', !/show/.test(bar), bar);
srv = d1(`SELECT rounds, log_through FROM sessions WHERE id = '${S}'`)[0];
ok('…and the rounds played while it was failing reached the server', srv.rounds === rounds && srv.log_through === rounds,
   `${JSON.stringify(srv)} vs page ${rounds}`);

ok('no JavaScript errors on the page', errors.length === 0, errors.join(' | ').slice(0, 300));

await browser.close();
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
