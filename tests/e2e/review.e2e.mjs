// End-to-end: the phone-side findings from the pre-ship review, each in a real
// browser against a local Worker. Run the same way as reload.e2e.mjs (see its
// header); it creates its own test account and its own sessions.
//
//   3  a phone with rounds of its own the server never got is NOT silently
//      overwritten by a reload — its rounds go up beside the saved game first;
//   2  a phone kept beside the saved game can get back to it (the bar used to
//      say "Reload", which could never work);
//   6  nothing is sent while a hand is in progress;
//   -  nothing is sent until the server has said what it holds, and the bar
//      says so if that takes a while;
//   4  a reply that does not move the starting point cannot loop.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { console.error('playwright-core is not installed: npm i --no-save playwright-core@1.48.2'); process.exit(2); }

const BASE = process.env.BJF_E2E_BASE || 'http://127.0.0.1:8787';
const STATE = process.env.BJF_E2E_STATE;
const CHROME = process.env.BJF_E2E_CHROME || '/usr/bin/google-chrome';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (!STATE) { console.error('Set BJF_E2E_STATE to the --persist-to directory the local Worker is using.'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${cond ? '' : extra}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'rams-bj-friend',
  '--local', '--persist-to', STATE, '--json', '--command', sql],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;

/* ------------------------------------------------------------- fixtures --
 * Two lines of play, a and b, sharing rounds 1..50: money differs per line
 * from round 51, as two replays of the same shoe would. `net` equals the
 * engine's own totalNet for that round, exactly as history.js writes it. */
const money = (n, line) => (line === 'b' && n > 50 ? n * 400 + 7 : n * 400);
const round = (n, line = 'a') => ({
  round: n, shoeNumber: 1, shoeRound: n, ts: 1792000000000 + n * 60000, mode: 'practice',
  dealer: ['9♣', '7♦'], dealerTotal: 16, dealerSoft: false, dealerBlackjack: false, dealerDrew: true,
  boxes: [{ number: 1, wager: { main: 700, pairs: 0, trilux: 0, super: 0 },
    hands: [{ cards: ['10♠', '8♥'], total: 18, soft: false, bust: false, bet: 700, isSplit: false, result: 'Won', net: 400 }],
    decisions: [{ hand: ['10♠', '8♥'], dealerFirst: '9♣', chosen: 'Stand', recommended: 'Stand', correct: true }],
    side: { pairs: { name: 'Not played' }, trilux: { name: 'Not played' }, super: { name: 'Not played' } },
    mainNet: 400, sideNet: 0, totalNet: 400 }],
  bankrollBefore: 10000 + money(n - 1, line), bankrollAfter: 10000 + money(n, line),
  net: money(n, line) - money(n - 1, line), cardsRemaining: 300 - n,
});
const history = (n, line = 'a') => Array.from({ length: n }, (_, i) => ({
  round: i + 1, boxes: 1, mainNet: 400, sideNet: 0,
  totalNet: money(i + 1, line) - money(i, line), bankroll: 10000 + money(i + 1, line),
}));
const state = (n, line = 'a') => ({
  start: 10000, bankroll: 10000 + money(n, line), rounds: n, phase: 'ready', dealer: [], boxes: [],
  activeBox: 0, activeHand: 0, shoeEnded: false, roundStart: 10000 + money(n, line),
  decisions: n, correct: n, mistakes: [], mainPL: money(n, line), pairsPL: 0, triluxPL: 0, superPL: 0,
  high: 10000 + money(n, line), low: 10000, decisionMix: { hard: n, soft: 0, pair: 0, double: 0, split: 0, hit: 0, stand: n },
  boxStats: { 1: { decisions: n, correct: n, mainPL: money(n, line) } },
  roundHistory: history(n, line), currentWinStreak: 1, currentLossStreak: 0, longestWinStreak: n, longestLossStreak: 0,
  largestMainBet: 700, totalMainStaked: n * 700, totalSideStaked: 0, peakBankroll: 10000 + money(n, line),
  maxDrawdown: 0, shoeNumber: 1, eventLog: [],
});
const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const shoe = () => Array.from({ length: 6 }, () => RANKS.flatMap((r) => SUITS.map((s) => ({ r, s })))).flat().slice(0, 250);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });

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

/** A fresh phone, signed in, with its storage seeded before the app loads. */
async function phone(seed) {
  const context = await browser.newContext({ viewport: { width: 412, height: 860 }, baseURL: BASE });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const syncs = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/sessions/sync') && r.method() === 'POST') {
      let body = null; try { body = JSON.parse(r.postData() || ''); } catch { /* */ }
      syncs.push({ at: Date.now(), phase: null, rounds: body && body.state && body.state.rounds,
                   newRounds: body && Array.isArray(body.newRounds) ? body.newRounds.map((x) => x.round) : null });
    }
  });
  const r = await context.request.post('/api/login', { data: { username: 'ram', password: 'e2e-pass-123' } });
  if (!r.ok()) throw new Error('login failed ' + r.status());
  await page.goto('/api/health');
  await page.evaluate((s) => {
    localStorage.clear();
    localStorage.setItem('bjfFreshStart-2026-09-12', '1');
    localStorage.setItem('bjfWhatsNewSeen', '9.9.9');
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, seed);
  return { context, page, errors, syncs };
}
/** Server-side state of a session, seeded the way an old-build phone sends it. */
async function serverGame(context, id, n, line = 'a') {
  const r = await context.request.post('/api/sessions/sync', { data: {
    sessionId: id, deviceId: 'other', appVersion: 'old', mode: 'practice',
    state: state(n, line), shoe: shoe(), lastBets: [], roundLog: Array.from({ length: n }, (_, i) => round(i + 1, line)),
  } });
  if (!r.ok()) throw new Error('seed failed ' + r.status() + ' ' + await r.text());
}
const rounds = (page) => page.evaluate(() => (typeof state !== 'undefined' && state ? state.rounds : -1));
const bar = (page) => page.evaluate(() => {
  const b = document.getElementById('bjfSaveWarn');
  const btn = b && b.querySelector('.a');
  return b ? { cls: b.className, text: b.textContent, button: btn && btn.classList.contains('on') ? btn.textContent : null } : null;
});
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  return null;
}
/* The "Application updated" card sits over the bottom of the screen — the deal
   and "Next round" buttons included — until it is answered, as it would for Ram
   after a deploy. Answer it the way he would. */
async function dismissPopup(page) {
  const later = await page.$('.bjf-wn-pop .later');
  if (later && await later.isVisible()) { try { await later.click({ timeout: 1000 }); } catch { /* gone */ } await sleep(400); }
}
async function playRound(page, { holdMs = 0 } = {}) {
  await dismissPopup(page);
  await page.waitForSelector('#dealBtn', { state: 'visible', timeout: 10000 });
  const before = await rounds(page);
  await page.click('#dealBtn');
  if (holdMs) await sleep(holdMs);
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
  await dismissPopup(page);
  const back = await page.waitForSelector('#returnToBettingBtn', { state: 'visible', timeout: 8000 }).catch(() => null);
  if (back) { try { await back.click({ timeout: 2000 }); } catch { /* re-rendered */ } }
  await page.waitForSelector('#dealBtn', { state: 'visible', timeout: 8000 }).catch(() => null);
  await sleep(700);   // the save, then the 400 ms sync debounce
  return page.evaluate(() => state.rounds);
}
const engineSave = (st) => JSON.stringify({ state: st, lastBets: [], shoe: shoe() });
const logSave = (id, list) => JSON.stringify({ sessionId: id, rounds: list, truncated: false });
const meta = (id) => JSON.stringify({ deviceId: 'phone-e2e', sessionId: id });

/* ------------------------------------------------------------- finding 3 */
console.log('\n3 — a phone with rounds of its own is not overwritten on reload');
{
  const S = 'e2e-diverged';
  const local = [...Array.from({ length: 50 }, (_, i) => round(i + 1, 'a')), ...[51, 52, 53, 54, 55].map((n) => round(n, 'b'))];
  const p = await phone({ ramsBjFriendBetaV14: engineSave(state(55, 'b')), bjfRoundLog: logSave(S, local), bjfCloudMeta: meta(S) });
  await serverGame(p.context, S, 60, 'a');
  await p.page.goto('/');
  await sleep(3500);
  ok('the server is further ahead, but on another game: NOT taken over', (await rounds(p.page)) === 55, `rounds ${await rounds(p.page)}`);
  const banner = await p.page.evaluate(() => { const b = document.getElementById('cloudRestoreBanner'); return b ? b.textContent : null; });
  ok('he is asked, and told his own rounds are kept', Boolean(banner && /further ahead/.test(banner) && /kept too/.test(banner)), String(banner));

  await p.page.click('#cloudRestoreYes');
  const switched = await waitFor(async () => (await rounds(p.page)) === 60, 15000);
  ok('"Go to saved game" switches to R60', Boolean(switched), `rounds ${await rounds(p.page)}`);
  const fork = d1(`SELECT (SELECT COUNT(*) FROM round_detail WHERE session_id = '${S}-fork1') AS kept,
                          (SELECT rounds FROM sessions WHERE id = '${S}') AS main`)[0];
  ok("…only after this phone's 55 rounds were saved beside it", fork.kept === 55, JSON.stringify(fork));
  ok('…and the saved game itself was never touched', fork.main === 60, JSON.stringify(fork));
  const note = await bar(p.page);
  ok('the notice does not claim "nothing was lost" — it says what happened',
     Boolean(note && /saved separately first/.test(note.text) && !/Nothing was lost/.test(note.text)), JSON.stringify(note));
  ok('no JavaScript errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 200));
  await p.context.close();
}

/* ------------------------------------------------------------- finding 2 */
console.log('\n2 — a phone kept beside the saved game can get back to it');
{
  const S = 'e2e-forked';
  const local = [...Array.from({ length: 50 }, (_, i) => round(i + 1, 'a')), ...[51, 52, 53, 54, 55].map((n) => round(n, 'b'))];
  const p = await phone({ ramsBjFriendBetaV14: engineSave(state(55, 'b')), bjfRoundLog: logSave(S, local), bjfCloudMeta: meta(S) });
  await serverGame(p.context, S, 60, 'a');
  await p.page.goto('/');
  await waitFor(() => p.page.$('#cloudRestoreNo'), 8000);
  await p.page.click('#cloudRestoreNo');                    // "Not now": keeps playing here
  await playRound(p.page);
  const kept = await waitFor(async () => { const b = await bar(p.page); return b && /isn't on your saved game/.test(b.text) ? b : null; }, 10000);
  ok('playing on here: the bar says so, plainly', Boolean(kept), JSON.stringify(await bar(p.page)));
  ok('…and offers the real fix, not "Reload"', Boolean(kept && kept.button === 'Go to saved game' && !/Reload/.test(kept.text)),
     JSON.stringify(kept));
  await p.page.click('#bjfSaveWarn .a');
  const back = await waitFor(async () => (await rounds(p.page)) === 60, 15000);
  ok('one tap and he is back on his saved game', Boolean(back), `rounds ${await rounds(p.page)}`);
  await sleep(6500);
  const after = await bar(p.page);
  ok('…and the warning is gone', Boolean(after && !/show/.test(after.cls)), JSON.stringify(after));
  ok('no JavaScript errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 200));
  await p.context.close();
}

/* ------------------------------------------------------------- finding 6 */
console.log('\n6 — nothing is sent while a hand is in progress');
{
  const S = 'e2e-midhand';
  const p = await phone({ ramsBjFriendBetaV14: engineSave(state(20)),
                          bjfRoundLog: logSave(S, Array.from({ length: 20 }, (_, i) => round(i + 1))), bjfCloudMeta: meta(S) });
  await serverGame(p.context, S, 20, 'a');
  await p.page.goto('/');
  await sleep(2500);
  // Fail one sync so the retry timer is armed (4 s), then sit in a hand past it.
  await p.page.route('**/api/sessions/sync', (route) => route.abort());
  await playRound(p.page);
  await p.page.unroute('**/api/sessions/sync');
  p.syncs.length = 0;
  await dismissPopup(p.page);
  await p.page.waitForSelector('#dealBtn', { state: 'visible', timeout: 10000 });
  await p.page.click('#dealBtn');
  const sentInHand = [];
  for (let i = 0; i < 30; i++) {         // ~7.5 s in the player phase: the retry fires inside it
    const phase = await p.page.evaluate(() => state.phase);
    if (phase !== 'player') break;
    if (p.syncs.length) sentInHand.push(...p.syncs.splice(0));
    await sleep(250);
  }
  const inHand = await p.page.evaluate(() => state.phase);
  ok('a hand held open past the retry timer', inHand === 'player', inHand);
  ok('…and no sync went out during it', sentInHand.length === 0, JSON.stringify(sentInHand));
  for (let i = 0; i < 40; i++) {
    const stand = await p.page.$('[data-action="S"]:not([disabled])');
    if (!stand) break;
    try { await stand.click({ timeout: 500 }); } catch { /* */ }
    await sleep(250);
  }
  const landed = await waitFor(async () => p.syncs.find((s) => s.newRounds && s.newRounds.includes(22)), 15000);
  ok('once it settles, the sync goes — with the settled round', Boolean(landed), JSON.stringify(p.syncs));
  ok('no JavaScript errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 200));
  await p.context.close();
}

/* ---------------------------------------------------------------- holding */
console.log('\nHOLD — nothing is sent until the server has said what it holds');
{
  const S = 'e2e-hold';
  const p = await phone({ ramsBjFriendBetaV14: engineSave(state(30)),
                          bjfRoundLog: logSave(S, Array.from({ length: 30 }, (_, i) => round(i + 1))), bjfCloudMeta: meta(S) });
  await serverGame(p.context, S, 30, 'a');
  await p.page.route('**/api/sessions/latest*', (route) => route.abort());
  await p.page.goto('/');
  for (let i = 0; i < 3; i++) await playRound(p.page);
  await sleep(800);
  ok('three rounds played with the check unanswered: none sent', p.syncs.length === 0, JSON.stringify(p.syncs));
  const held = await bar(p.page);
  ok('…and the bar says so', Boolean(held && /Can't reach your account yet/.test(held.text)), JSON.stringify(held));
  await p.page.unroute('**/api/sessions/latest*');
  const caught = await waitFor(() => d1(`SELECT log_through AS n FROM sessions WHERE id = '${S}'`)[0].n === 33, 70000);
  ok('when it answers, all three go up', Boolean(caught), JSON.stringify(d1(`SELECT rounds, log_through FROM sessions WHERE id = '${S}'`)));
  ok('no JavaScript errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 200));
  await p.context.close();
}

/* ------------------------------------------------------------- finding 4 */
console.log('\n4 — a reply that does not move the starting point cannot loop');
{
  const S = 'e2e-loop';
  const p = await phone({ ramsBjFriendBetaV14: engineSave(state(10)),
                          bjfRoundLog: logSave(S, Array.from({ length: 10 }, (_, i) => round(i + 1))), bjfCloudMeta: meta(S) });
  await serverGame(p.context, S, 10, 'a');
  await p.page.goto('/');
  await sleep(2500);
  // An older server: answers ok, says nothing about how far it holds.
  await p.page.route('**/api/sessions/sync', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, sessionId: S, rounds: 0 }) }));
  p.syncs.length = 0;
  await playRound(p.page);
  await sleep(3000);
  ok('one round, one sync — not a stream of them', p.syncs.length <= 2, `${p.syncs.length} syncs in ~4 s`);
  ok('no JavaScript errors', p.errors.length === 0, p.errors.join(' | ').slice(0, 200));
  await p.context.close();
}

await browser.close();
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
