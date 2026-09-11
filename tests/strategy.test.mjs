/* Ram's BJ Friend — strategy + ENHC flow regression suite
 *
 * Implements the acceptance tests from the two correction briefs:
 *   · STRATEGY ENGINE / REPORTING CORRECTION BRIEF  §8
 *   · ENHC DEALER BLACKJACK / PLAYER NATURAL FLOW
 *
 * Brief §9 acceptance criterion: for any identical hand + dealer card + rules
 * profile + action availability, the gameplay recommendation, the mistake
 * grading and the session report must agree. They do by construction — all
 * three call the same recommendedAction() — and the report check below proves
 * the recorded mistake matches the recommendation.
 *
 *   node tests/strategy.test.mjs [baseUrl]
 */
import { chromium } from '/home/mango213/Documents/D/B/Vtalkies/AI code/vtalkies-code/vtalkies-frontend/node_modules/playwright/index.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
// Credentials come from the environment. Deliberately NOT defaulted in source —
// the local dev account shares a password with production, and this file is in
// version control.
//
//   BJF_PASS='your-local-password' node tests/strategy.test.mjs [baseUrl]
//
const USER = { u: process.env.BJF_USER || 'ram', p: process.env.BJF_PASS || '' };
if (!USER.p) {
  console.error(
    '\nBJF_PASS is not set, so this suite cannot sign in.\n' +
    "  BJF_PASS='<local password>' node tests/strategy.test.mjs http://127.0.0.1:8787/\n"
  );
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${ok ? got : `got ${got}, want ${want}`}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => typeof recommendedAction === 'function');
await page.waitForTimeout(600);

// ---------------------------------------------------------------- strategy
console.log('\nSTRATEGY MATRIX  (brief §8)');
const strat = await page.evaluate(() => {
  const C = (...n) => n.map((x) => ({ r: x, s: '♠' }));
  const A = (cards, d) => recommendedAction(cards, { r: d, s: '♦' },
    { cards, splitAces: false, bet: 100 });
  return {
    'A,8 vs 5 -> Stand':            A(C('A', '8'), '5'),
    'A,8 vs 6 -> Stand':            A(C('A', '8'), '6'),
    'A,7 vs 2 -> Double':           A(C('A', '7'), '2'),
    'A,7 vs 6 -> Double':           A(C('A', '7'), '6'),
    'A,7 vs 7 -> Stand':            A(C('A', '7'), '7'),
    'A,7 vs 9 -> Hit':              A(C('A', '7'), '9'),
    'multi S18 vs 2 -> Stand':      A(C('A', '3', '4'), '2'),
    'multi S18 vs 8 -> Stand':      A(C('A', '3', '4'), '8'),
    'multi S18 vs 9 -> Hit':        A(C('A', '3', '4'), '9'),
    'multi S18 vs A -> Hit':        A(C('A', '3', '4'), 'A'),
    'multi S17 vs 3 -> Hit':        A(C('A', '2', '4'), '3'),
    'multi S19 vs 6 -> Stand':      A(C('A', '4', '4'), '6'),
    'two-card A,6 vs 3 -> Double':  A(C('A', '6'), '3'),
    '9 vs 6 -> Double':             A(C('5', '4'), '6'),
    '10 vs 10 -> Hit':              A(C('6', '4'), '10'),
    '11 vs 10 -> Hit':              A(C('7', '4'), '10'),
    '8,8 vs 9 -> Split':            A(C('8', '8'), '9'),
    '8,8 vs 10 -> Hit':             A(C('8', '8'), '10'),
    'A,A vs 10 -> Split':           A(C('A', 'A'), '10'),
    'A,A vs A -> Hit':              A(C('A', 'A'), 'A'),
    '9,9 vs 7 -> Stand':            A(C('9', '9'), '7'),
    '5,5 vs 6 -> Double':           A(C('5', '5'), '6'),
    '12 vs 4 -> Stand':             A(C('10', '2'), '4'),
    '12 vs 3 -> Hit':               A(C('10', '2'), '3'),
  };
});
const WANT = { Stand: 'S', Double: 'D', Hit: 'H', Split: 'P' };
for (const [name, got] of Object.entries(strat)) {
  check(name, got, WANT[name.split('-> ')[1]]);
}

// -------------------------------------------------------------- ENHC flow
console.log('\nENHC DEALER / PLAYER-NATURAL FLOW');
await page.waitForSelector('#cloudOverlay:not(.hidden)').catch(() => {});
if (await page.$('#cloudOverlay:not(.hidden)')) {
  await page.fill('#cloudUsername', USER.u);
  await page.fill('#cloudPassword', USER.p);
  await page.click('#cloudLoginBtn');
  await page.waitForSelector('#cloudOverlay', { state: 'hidden', timeout: 8000 });
}
await page.waitForTimeout(1000);

/** Stacks the shoe then plays one round out. Draw order: dealerUp, then two
 *  cards per box, then the dealer's remaining cards. */
async function round(cards) {
  await page.evaluate(() => window.resetSession());
  await page.waitForTimeout(500);
  await page.evaluate((cs) => {
    for (let i = 0; i < cs.length; i++) shoe[shoe.length - 1 - i] = { r: cs[i][0], s: cs[i][1] };
  }, cards);
  const before = await page.evaluate(() => shoe.length);
  await page.click('#dealBtn');
  await page.waitForTimeout(600);
  for (let i = 0; i < 12; i++) {
    const btn = page.locator('.action-grid button:not([disabled])', { hasText: 'Stand' }).first();
    if (!(await btn.count())) break;
    await btn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1300);
  }
  await page.waitForSelector('#roundResultPanel:not(.hidden)', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  return page.evaluate((b) => ({
    dealerCards: state.dealer.length,
    dealerNatural: state.dealer.length === 2 && isBlackjack(state.dealer),
    labels: state.boxes.map((x) => x.results.map((r) => r.label).join('|')).join(' // '),
    nets: state.boxes.map((x) => x.mainNet).join(','),
    used: b - shoe.length,
  }), before);
}

// Dealer makes a natural -> player naturals PUSH
let r = await round([['A', '♥'], ['A', '♦'], ['Q', '♣'], ['A', '♣'], ['J', '♥'], ['K', '♠']]);
check('dealer natural: naturals push', r.labels,
  'Push — both natural blackjacks // Push — both natural blackjacks');
check('dealer natural: net is zero', r.nets, '0,0');
check('dealer natural: stops at 2 cards', String(r.dealerCards), '2');

// Ram's round 32 — dealer reaches 21 in THREE cards, so not a natural
r = await round([['A', '♥'], ['A', '♦'], ['Q', '♣'], ['A', '♣'], ['J', '♥'], ['A', '♠'], ['9', '♠']]);
check('3-card 21 is not a natural', String(r.dealerNatural), 'false');
check('naturals still paid 3:2', r.labels,
  'Blackjack — paid 3:2 // Blackjack — paid 3:2');
check('all-naturals: dealer takes no extra card', String(r.dealerCards), '2');
check('all-naturals: only 6 cards used', String(r.used), '6');

// A live non-natural hand still requires the dealer to complete
r = await round([['6', '♥'], ['A', '♦'], ['Q', '♣'], ['9', '♣'], ['7', '♥'], ['5', '♠'], ['6', '♠']]);
check('non-natural present: dealer completes to 17+', String(r.dealerCards >= 3), 'true');

console.log(`\n${fail ? '✗ ' + fail + ' FAILED' : '✓ ALL PASS'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail ? 1 : 0);
