/* Does the dealer take a card it should not?
 *
 * Under European no-hole-card the dealer's second card exists only to answer
 * one question: does the dealer hold a natural? Behind anything but an Ace or a
 * ten the answer is already no, so a table of naturals is paid and the dealer
 * turns nothing. The engine drew anyway, 34 times in 3,671 of Ram's recorded
 * rounds. No payout was ever wrong — every one settled "Blackjack — paid 3:2" —
 * but each burned a shoe card a live table would never spend, which moves
 * penetration and the running count away from the game being practised.
 *
 * The opposite error is worse and is what this mostly guards: reading the rule
 * as "picture or Ace" drops the plain 10, and a 10 makes a natural exactly as a
 * King does. In those same rounds 17 real dealer blackjacks sat behind a 10,
 * and skipping the draw there would settle every one as a player win.
 *
 * These run the SHIPPED function: dealerPlay is lifted out of public/index.html
 * and evaluated, so the test cannot drift from the engine the way a re-typed
 * copy would.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const engine = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');

/** The source of one top-level declaration, by brace matching from its start. */
function lift(signature) {
  const at = engine.indexOf(signature);
  if (at < 0) throw new Error(`not found in index.html: ${signature}`);
  let depth = 0;
  for (let i = at; i < engine.length; i += 1) {
    if (engine[i] === '{') depth += 1;
    else if (engine[i] === '}') {
      depth -= 1;
      if (depth === 0) return engine.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced: ${signature}`);
}

const rankValueSrc = engine.match(/const rankValue=[^\n]+/)[0];
const source = [
  rankValueSrc,
  lift('function handTotal(cards){'),
  lift('function isBlackjack(cards){'),
  lift('function dealerPlay(){'),
].join('\n');

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${ok ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

const card = (t) => ({ r: t.slice(0, -1), s: t.slice(-1) });
const hand = (cards, isSplit = false) => ({ cards: cards.map(card), isSplit });

/** Run the real dealerPlay over a table, with the shoe scripted. */
function play({ upcard, boxes, deck = [] }) {
  const queue = deck.map(card);
  const state = {
    phase: 'player', rounds: 1, dealer: [card(upcard)], eventLog: [],
    boxes: boxes.map((hands, i) => ({ number: i + 1, hands })),
  };
  const scope = {
    state,
    shoe: { length: 312 },
    draw: () => {
      if (!queue.length) throw new Error('dealer drew more cards than the test scripted');
      return queue.shift();
    },
    cardName: (c) => c.r + c.s,
    settleRound: () => {},
  };
  const run = new Function(...Object.keys(scope), `${source}\ndealerPlay();`);
  run(...Object.values(scope));
  return { cards: state.dealer.map((c) => c.r + c.s), left: queue.length };
}

const BJ = () => hand(['A♠', 'K♥']);
const LIVE18 = () => hand(['10♦', '8♣']);
const BUST = () => hand(['10♦', '8♣', '9♠']);

console.log('\nTHE BUG — a paid natural must not cost the shoe a card');
eq('one box, natural vs 5: dealer turns nothing',
   play({ upcard: '5♠', boxes: [[BJ()]], deck: ['K♦'] }).cards, ['5♠']);
eq('two boxes, both natural vs 5: dealer turns nothing',
   play({ upcard: '5♠', boxes: [[BJ()], [BJ()]], deck: ['K♦'] }).cards, ['5♠']);
eq('that card stays in the shoe',
   play({ upcard: '5♠', boxes: [[BJ()]], deck: ['K♦'] }).left, 1);
eq('round 129 exactly: 10♥A♦ and Q♣A♥ vs 5♠',
   play({ upcard: '5♠', deck: ['K♦'],
          boxes: [[hand(['10♥', 'A♦'])], [hand(['Q♣', 'A♥'])]] }).cards, ['5♠']);

console.log('\nTEN-VALUE, NOT "PICTURE" — the costly way to get this wrong');
for (const up of ['10♠', 'J♠', 'Q♠', 'K♠']) {
  eq(`natural vs ${up}: dealer must still check for its own`,
     play({ upcard: up, boxes: [[BJ()]], deck: ['A♥'] }).cards, [up, 'A♥']);
}
eq('natural vs A: dealer must still check for its own',
   play({ upcard: 'A♠', boxes: [[BJ()]], deck: ['K♥'] }).cards, ['A♠', 'K♥']);
eq('dealer natural behind a ten stops there, no completion',
   play({ upcard: '10♠', boxes: [[BJ()]], deck: ['A♥'] }).left, 0);

console.log('\nUNCHANGED — what the engine already had right');
eq('a live non-natural is still played out to 17',
   play({ upcard: '5♠', boxes: [[LIVE18()]], deck: ['6♥', '7♣'] }).cards, ['5♠', '6♥', '7♣']);
eq('natural beside a live hand: dealer still completes',
   play({ upcard: '5♠', boxes: [[BJ()], [LIVE18()]], deck: ['6♥', '7♣'] }).cards, ['5♠', '6♥', '7♣']);
eq('every hand bust: dealer takes nothing',
   play({ upcard: '5♠', boxes: [[BUST()]], deck: ['K♦'] }).cards, ['5♠']);
eq('dealer stands on 17',
   play({ upcard: '10♠', boxes: [[LIVE18()]], deck: ['7♥'] }).cards, ['10♠', '7♥']);

console.log('\nSPLIT ACES — 21 on a split is not a natural, so it must be beaten');
eq('split 21 vs 5: dealer completes rather than standing on 5',
   play({ upcard: '5♠', boxes: [[hand(['A♠', 'K♥'], true)]], deck: ['6♥', '7♣'] }).cards,
   ['5♠', '6♥', '7♣']);

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
