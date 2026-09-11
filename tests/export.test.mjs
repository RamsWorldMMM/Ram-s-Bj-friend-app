/* Regression tests for the raw event-log export.
 *
 * These exist because of a real defect: the export emitted one row per HAND but
 * repeated BOX-level and ROUND-level money on every one of those rows. Summing
 * any money column therefore double-counted every split round — and because a
 * split requires a pair, and a pair is what pays the side bets, the error landed
 * preferentially on winning rounds. It survived into production and corrupted an
 * analysis before anyone noticed. Nothing here is theoretical.
 */
import { rowsForSession, toCSV, caveatsFor, COLUMNS } from '../src/export.js';

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${ok ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

const hand = (net, over) => ({ cards: ['8♠', '3♦'], total: 11, soft: false, bust: false,
  isSplit: true, bet: 100, result: 'Win', net, ...over });

/** One round: box 1 split into two hands, box 2 unsplit. */
const round = {
  round: 1, shoeNumber: 2, shoeRound: 7, ts: 1757000000000, cardsRemaining: 250,
  dealer: ['9♥', '7♣'], dealerTotal: 16, dealerBlackjack: false, dealerDrew: true,
  net: -50, bankrollBefore: 10000, bankrollAfter: 9950,
  boxes: [
    { number: 1, wager: { main: 100, pairs: 25, trilux: 25, super: 25 },
      side: { pairs: { name: 'Pair', net: 500 }, trilux: { name: '-', net: -25 },
              super: { name: 'Flush', net: 1200 } },
      decisions: [
        { hand: ['8♠', '8♦'], dealerFirst: '9♥', chosen: 'Split', correct: true },
        { hand: ['8♠', '3♦'], dealerFirst: '9♥', chosen: 'Hit', correct: false, recommended: 'Double' },
      ],
      hands: [hand(100), hand(-100)], mainNet: 0, sideNet: 1675, totalNet: 1675 },
    { number: 2, wager: { main: 50, pairs: 0, trilux: 0, super: 0 },
      side: { pairs: null, trilux: null, super: null },
      decisions: [{ hand: ['10♠', '9♦'], dealerFirst: '9♥', chosen: 'Stand', correct: true }],
      hands: [{ cards: ['10♠','9♦'], total: 19, soft: false, bust: false, isSplit: false,
                bet: 50, result: 'Win', net: 50 }],
      mainNet: 50, sideNet: 0, totalNet: 50 },
  ],
};

const session = { id: 's1', started_at: '2026-09-05', app_version: "Ram's BJ Friend v1.4.5",
  strategy_version: 'HIP-ENHC-S17-v1', rules_profile: '6D / S17 / ENHC-full-loss / DOA / DAS',
  mode: 'practice', round_log_json: JSON.stringify([round]) };

const rows = rowsForSession(session);
const n = (v) => (v === null || v === undefined || v === '') ? 0 : Number(v);
const sum = (c) => rows.reduce((a, r) => a + n(r[c]), 0);

console.log('\nEXPORT GRAIN — a naive SUM() must be correct across a split round');
eq('three rows emitted (2 hands + 1 hand)', rows.length, 3);
eq('sum(round_net) is the round net, not 3x', sum('round_net'), -50);
eq('sum(super_net) counts the box once', sum('super_net'), 1200);
eq('sum(pairs_net) counts the box once', sum('pairs_net'), 500);
eq('sum(trilux_net) counts the box once', sum('trilux_net'), -25);
eq('sum(side_net) counts the box once', sum('side_net'), 1675);
eq('sum(box_total_net) equals both boxes', sum('box_total_net'), 1725);
eq('sum(main_net) equals both boxes', sum('main_net'), 50);
eq('sum(main_wager) is not multiplied by hands', sum('main_wager'), 150);
eq('sum(decisions_incorrect) counts one mistake', sum('decisions_incorrect'), 1);
eq('sum(decisions_correct) counts two', sum('decisions_correct'), 2);
eq('per-hand net survives on every row', sum('hand_net'), 50);
eq('per-hand bet survives on every row', sum('hand_bet'), 250);

console.log('\nROW MARKERS — how a reader filters');
eq('one round_row per round', rows.filter((r) => r.round_row === 1).length, 1);
eq('one box_row per box', rows.filter((r) => r.box_row === 1).length, 2);
eq('the repeat split hand is not a box row', rows[1].box_row, 0);
eq('box-level money blank on the repeat row', rows[1].super_net, null);
eq('decision text blank on the repeat row', rows[1].decisions, null);
eq('round money blank on non-first rows', [rows[1].round_net, rows[2].round_net], [null, null]);

console.log('\nSHOE AND TIME — the fields that make shoe analysis possible');
eq('derived shoe number is exported', rows[0].shoe_no, 2);
eq('within-shoe position is exported', rows[0].shoe_round, 7);
eq('open shoe exports empty shoe_end', rows[0].shoe_end, '');
eq('round timestamp is ISO', rows[0].round_ts, new Date(1757000000000).toISOString());

const ended = rowsForSession({ ...session,
  round_log_json: JSON.stringify([{ ...round, shoeEnd: 'reshuffle' }]) });
eq('a played-out shoe is marked', ended[0].shoe_end, 'reshuffle');

console.log('\nCSV SHAPE');
const csv = toCSV(rows);
const header = csv.split('\r\n')[0].split(',');
eq('header matches COLUMNS exactly', header, COLUMNS);
eq('one header + one row per hand', csv.split('\r\n').length, 4);
eq('blank cells really are empty', csv.split('\r\n')[2].split(',')[COLUMNS.indexOf('super_net')], '');

console.log('\nCAVEATS — wording that must never tell a reader to bin good data');
const cav = caveatsFor([session]);
eq('grain caveat always present', cav[0].startsWith('GRAIN:'), true);
eq('no legacy warning when version is recorded', cav.some((c) => c.includes('provenance gap')), false);
const legacyCav = caveatsFor([{ ...session, strategy_version: null }]);
eq('provenance gap flagged when version missing', legacyCav.some((c) => c.includes('provenance gap')), true);
eq('never instructs a blanket exclusion', legacyCav.some((c) => /Exclude them from any/.test(c)), false);

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
