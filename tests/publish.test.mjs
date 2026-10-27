/* Do the published files include rounds stored since the log was chunked?
 *
 * Ram's ChatGPT reads the files a publish writes to GitHub, not the database.
 * The rounds a phone sends now live in round_log_chunks, and src/publish.js
 * copies the assembled log onto each session by hand before building its
 * fragment. If that copy were missing, every publish would quietly be built from
 * the frozen legacy blob alone: the files would stop growing while play went on,
 * and nothing would say so — the same shape of failure as 15 October, when
 * staking.json sat at 77,288 bets while summary.json moved on.
 *
 * This runs the real publishDigests against a real SQLite database, with
 * GitHub faked so nothing leaves the machine.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1 } from './helpers/d1.mjs';
import { ensureSchema } from '../src/migrate.js';
import * as repo from '../src/repo.js';
import { publishDigests } from '../src/publish.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(60)} ${ok ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(join(here, 'fixtures', 'schema-before-chunking.sql'), 'utf8'));
const db = d1(sqlite);
await ensureSchema(db);
const USER = 'u-ram';
sqlite.prepare(`INSERT INTO users (id, username, password_hash, password_salt, iterations)
                VALUES (?, 'ram', 'x', 'x', 1)`).run(USER);

/* A round as history.js snapshots it, with all three side bets placed. */
const round = (n) => ({
  round: n, shoeNumber: 1, shoeRound: n, ts: 1792000000000 + n, mode: 'practice',
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
  bankrollBefore: 10000 + (n - 1) * 400, bankrollAfter: 10000 + n * 400, net: 400, cardsRemaining: 300 - n,
});
const state = (n) => ({
  start: 10000, bankroll: 10000 + n * 400, rounds: n, decisions: n, correct: n, mistakes: [],
  mainPL: n * 700, pairsPL: -n * 100, triluxPL: -n * 100, superPL: -n * 100,
  high: 10000 + n * 400, low: 10000, maxDrawdown: 0, totalMainStaked: n * 700, totalSideStaked: n * 300,
  largestMainBet: 700, longestWinStreak: n, longestLossStreak: 0, shoeNumber: 1,
  decisionMix: { hard: n, soft: 0, pair: 0, double: 0, split: 0, hit: 0, stand: n },
  boxStats: { 1: { decisions: n, correct: n, mainPL: n * 700 } },
  roundHistory: Array.from({ length: n }, (_, i) => ({ round: i + 1, boxes: 1, mainNet: 700, sideNet: -300, totalNet: 400, bankroll: 10000 + (i + 1) * 400 })),
  eventLog: [],
});

/* A session written by the OLD code — rounds 1-10 in the legacy blob — then
   five more rounds sent by the new build, which land in chunks. */
const S = 'sess-pub';
sqlite.prepare(`INSERT INTO sessions (id, user_id, started_at, rounds, state_json, round_log_json, round_log_meta)
                VALUES (?, ?, '2026-10-23 03:04:59', 10, ?, ?, ?)`).run(S, USER, JSON.stringify(state(10)),
  JSON.stringify(Array.from({ length: 10 }, (_, i) => round(i + 1))),
  JSON.stringify({ truncated: false, maxRounds: 2000, captured: 10, firstRound: 1, lastRound: 10 }));
for (const r of state(10).roundHistory) {
  sqlite.prepare('INSERT INTO rounds (session_id, round_no, total_net, bankroll) VALUES (?, ?, ?, ?)')
    .run(S, r.round, r.totalNet, r.bankroll);
}
const res = await repo.syncSession(db, USER, {
  sessionId: S, deviceId: 'phone', appVersion: 't', mode: 'practice', state: state(15),
  shoe: [], lastBets: [], newRounds: [11, 12, 13, 14, 15].map(round),
});
eq('setup: five rounds appended into chunks', [res.appended, res.logThrough], [5, 15]);

/* ------------------------------------------------------------ fake GitHub */
const written = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.github.com/')) return realFetch(url, init);
  const path = decodeURI(u.split('/contents/')[1] || '').split('?')[0];
  if ((init.method || 'GET') === 'PUT') {
    const body = JSON.parse(init.body);
    written.set(path, JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')));
    return new Response(JSON.stringify({ content: { sha: 'f' + written.size }, commit: { sha: 'c0ffee' + written.size } }),
      { status: 201, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
};

console.log('\nPUBLISH — the files ChatGPT reads, built from legacy + chunked rounds');
const out = await publishDigests({ DB: db, GITHUB_TOKEN: 'test', GITHUB_OWNER: 'o', GITHUB_REPO: 'n' },
  USER, { backlog: false, appVersion: 'test' });
globalThis.fetch = realFetch;

eq('publish succeeds', Boolean(out && out.files), true);
const summary = written.get('data/summary.json');
const staking = written.get('data/staking.json');
const shoes = written.get('data/shoes.json');
eq('summary.json: all 15 rounds', summary && summary.sessions.find((s) => s.session_id === S).rounds, 15);
eq('staking.json: 45 side bets — 30 legacy + 15 chunked, not 30',
   staking && staking.combined.bets_placed, 45);
eq('shoes.json: the shoe runs through round 15',
   shoes && Math.max(...shoes.shoes.map((s) => s.last_round)), 15);
eq('summary and staking agree on how much play there is',
   summary && staking && staking.combined.bets_placed === 3 * summary.sessions[0].rounds, true);

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
