/* Does a sync ever lose, overwrite or double-count a round?
 *
 * On 26 October Ram was at R1754, refreshed, and came back at R1609. Two
 * failures, both silent:
 *
 *  - his phone's storage was full, so from R1609 nothing was saved locally;
 *  - every sync re-sent his whole history, 5.5 MB a round, and Cloudflare
 *    killed each one for CPU, so nothing reached the server either.
 *
 * Then the refreshed phone synced its older copy, and because the server
 * REPLACED the round log with whatever arrived, newer rounds it already held
 * were destroyed — twice: 1610-1613 first, then at 18:44 the 1610-1635 that had
 * replaced them, when the phone came back at the same frozen R1609 again.
 *
 * These run src/repo.js against a real SQLite database through a stand-in for
 * D1, starting from the schema production had on the day — so the self-healing
 * migration is exercised on exactly the path the live database will take. Each
 * finding from the pre-ship review has a test of its own below.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/migrate.js';
import * as repo from '../src/repo.js';
import { roundsOf, hasRoundLog, caveatsFor, releaseRounds } from '../src/export.js';
import { buildSessionFragment } from '../src/digest.js';
import { d1 } from './helpers/d1.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${ok ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(join(here, 'fixtures', 'schema-before-chunking.sql'), 'utf8'));
const db = d1(sqlite);
const USER = 'u-ram', OTHER = 'u-vijay';
sqlite.prepare(`INSERT INTO users (id, username, password_hash, password_salt, iterations)
                VALUES (?, 'ram', 'x', 'x', 1), (?, 'vijay', 'x', 'x', 1)`).run(USER, OTHER);

/* ---------------------------------------------------------------- fixtures
 * Money per round differs by line of play, as two replays of the same shoe
 * would. A round carries `net` exactly as history.js writes it, equal to the
 * engine's own totalNet for that round — which is what the server's
 * line-consistency filter checks, so every test below also proves that filter
 * rejects nothing genuine. */
const money = (n, tag) => (tag === 'a' ? n * 10 : tag === 'b' ? n * 10 + 7 : n * 10 + 3);
const round = (n, tag = 'a') => ({ round: n, branch: tag, net: money(n, tag), boxes: [{ number: 1, net: n * 10 }], dealer: ['5♠'] });
const history = (upTo, tag = 'a', from = 1, base = []) => base.concat(Array.from({ length: upTo - from + 1 }, (_, i) => ({
  round: from + i, boxes: 1, mainNet: 0, sideNet: 0,
  totalNet: money(from + i, tag), bankroll: 10000 + money(from + i, tag),
})));
const state = (rounds, tag = 'a', events = 3) => ({
  start: 10000, bankroll: 10000 + money(rounds, tag), rounds, decisions: rounds * 2, correct: rounds * 2,
  mistakes: [], mainPL: 0, pairsPL: 0, triluxPL: 0, superPL: 0, high: 12000, low: 9000,
  maxDrawdown: 100, totalMainStaked: rounds * 100, totalSideStaked: 0, largestMainBet: 100,
  longestWinStreak: 2, longestLossStreak: 2, shoeNumber: 1, phase: 'complete',
  roundHistory: history(rounds, tag),
  eventLog: Array.from({ length: rounds * events }, (_, i) => ({ type: 'decision', round: Math.floor(i / events) + 1 })),
});
const rows = (sql, ...a) => sqlite.prepare(sql).all(...a);
const one = (sql, ...a) => sqlite.prepare(sql).get(...a);
const stored = (id) => rows('SELECT round FROM round_detail WHERE session_id = ? ORDER BY round', id).map((r) => r.round);
const sync = (body) => repo.syncSession(db, USER, { deviceId: 'phone', appVersion: 't', mode: 'practice', shoe: [], lastBets: [], ...body });
const seed = (id, user, n, logRounds, ledger = history(n)) => {
  sqlite.prepare(`INSERT INTO sessions (id, user_id, rounds, state_json, round_log_json, round_log_meta)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(id, user, n, JSON.stringify(state(n)),
    JSON.stringify(logRounds),
    JSON.stringify({ truncated: false, maxRounds: 2000, captured: logRounds.length, firstRound: 1, lastRound: n }));
  for (const r of ledger) {
    sqlite.prepare('INSERT INTO rounds (session_id, round_no, total_net, bankroll) VALUES (?, ?, ?, ?)')
      .run(id, r.round, r.totalNet, r.bankroll);
  }
};

/* ------------------------------------------------------------------ schema */
console.log('\nMIGRATION — the live database is the old shape and must heal itself');
const migrated = await ensureSchema(db);
eq('nothing failed', migrated.failed, []);
eq('sessions gains log_through and fork_of', migrated.added.filter((c) => /log_through|fork_of/.test(c)).sort(),
   ['sessions.fork_of', 'sessions.log_through']);
eq('round_detail exists', Boolean(one("SELECT name FROM sqlite_master WHERE type='table' AND name='round_detail'")), true);

/* -------------------------------------------- a session from before the change */
console.log('\nLEGACY — a session written by the old code is copied, then frozen');
const LEG = 'sess-legacy';
seed(LEG, USER, 10, Array.from({ length: 10 }, (_, i) => round(i + 1)));
const blobBefore = one('SELECT round_log_json FROM sessions WHERE id = ?', LEG).round_log_json;

// The OLD build: whole roundLog, every round.
let res = await sync({ sessionId: LEG, state: state(12), roundLog: Array.from({ length: 12 }, (_, i) => round(i + 1)) });
eq('old build: only rounds past the stored 10 are taken from its log', res.appended, 2);
eq('server now holds through 12', res.logThrough, 12);
eq('the legacy rounds were copied into round_detail, inside the database', stored(LEG), [1,2,3,4,5,6,7,8,9,10,11,12]);
eq('legacy blob is untouched, byte for byte', one('SELECT round_log_json FROM sessions WHERE id = ?', LEG).round_log_json, blobBefore);
const meta = JSON.parse(one('SELECT round_log_meta FROM sessions WHERE id = ?', LEG).round_log_meta);
eq('meta is server-owned and describes what is stored', [meta.storage, meta.captured, meta.firstRound, meta.lastRound], ['rounds', 12, 1, 12]);

let assembled = (await repo.loadBlobs(db, USER, [LEG])).get(LEG);
eq('readers see all 12, from round_detail alone', assembled.round_log_rounds.map((r) => r.round), [1,2,3,4,5,6,7,8,9,10,11,12]);
releaseRounds();
eq('roundsOf takes the assembled log without parsing', roundsOf(assembled).length, 12);

/* Review finding: rolling back to the previous build after this one had run
   would let the old code overwrite the legacy blob with a phone's 300-round
   tail — and the blob was the only copy. It no longer is. */
console.log('\nROLLBACK — an older build overwriting the legacy blob costs nothing');
sqlite.prepare('UPDATE sessions SET round_log_json = ? WHERE id = ?').run(JSON.stringify([round(11), round(12)]), LEG);
eq('the full log is still there', (await repo.loadBlobs(db, USER, [LEG])).get(LEG).round_log_rounds.length, 12);
sqlite.prepare('UPDATE sessions SET round_log_json = ? WHERE id = ?').run(blobBefore, LEG);

/* ---------------------------------------------------------- the new client */
console.log('\nNEW BUILD — sends only what the server lacks');
res = await sync({ sessionId: LEG, state: state(13), newRounds: [round(13)] });
eq('one round in, one round stored', [res.appended, res.logThrough], [1, 13]);
eq('a repeat of the same round is a no-op', (await sync({ sessionId: LEG, state: state(13), newRounds: [round(13)] })).appended, 0);
eq('rounds table gains only the new round, not all 13 again',
   one('SELECT COUNT(*) AS n FROM rounds WHERE session_id = ?', LEG).n, 13);
// A duplicate INSERT is a silent no-op, so the row count above cannot tell
// "sent one" from "sent all of them". The batch size can, and it is the part
// that cost CPU: 1,635 statements a round at R1635.
const BATCH = 'sess-batch';
await sync({ sessionId: BATCH, state: state(200), newRounds: Array.from({ length: 200 }, (_, i) => round(i + 1)) });
await sync({ sessionId: BATCH, state: state(201), newRounds: [round(201)] });
eq('a one-round sync at R201 ships a handful of statements, not 201', db.lastBatch <= 5, true);

res = await sync({ sessionId: LEG, state: state(13), newRounds: [{ ...round(13), boxes: [{ number: 1, net: 999 }] }] });
eq('a DIFFERENT copy of a stored round is never written over it', res.appended, 0);
eq('stored round 13 is the original', (await repo.loadBlobs(db, USER, [LEG])).get(LEG).round_log_rounds.at(-1).boxes[0].net, 130);

eq('stored state keeps only the newest 400 raw events',
   JSON.parse(one('SELECT state_json FROM sessions WHERE id = ?', LEG).state_json).eventLog.length <= 400, true);
await sync({ sessionId: LEG, state: state(13, 'a', 100), newRounds: [] });    // 1,300 events
eq('…even when the phone sends 1,300', JSON.parse(one('SELECT state_json FROM sessions WHERE id = ?', LEG).state_json).eventLog.length, 400);

/* Review finding: a stale phone's log can hold rounds from another copy (saved
   locally, never confirmed) beside the rounds of the game it is now playing.
   Storing them would stitch two games together. */
console.log('\nONE LINE — a round from some other copy is never stitched in');
res = await sync({ sessionId: LEG, state: state(14), newRounds: [round(14), round(15), round(16)] });
eq('rounds numbered past what the phone has played are not stored', [res.appended, stored(LEG).at(-1)], [1, 14]);
res = await sync({ sessionId: LEG, state: state(15), newRounds: [round(15, 'b')] });
eq('a round whose net disagrees with the phone’s own ledger is not stored', [res.appended, stored(LEG).at(-1)], [0, 14]);
res = await sync({ sessionId: LEG, state: state(15), newRounds: [round(15)] });
eq('…and the genuine round 15 is', [res.appended, stored(LEG).at(-1)], [1, 15]);

/* Review finding: syncs could fire mid-hand (old builds on the 'online' event or
   a sign-in), and a resumed snapshot like that brings back a bankroll missing a
   stake that is never paid out. */
console.log('\nMID-HAND — a snapshot taken during a hand is never stored');
const beforeHand = one('SELECT rounds, state_json FROM sessions WHERE id = ?', LEG);
res = await sync({ sessionId: LEG, state: { ...state(16), phase: 'player', roundHistory: history(15) }, newRounds: [] });
eq('the hand in progress is not stored as the session', [res.snapshotKept, one('SELECT rounds, state_json FROM sessions WHERE id = ?', LEG)],
   [false, beforeHand]);
res = await sync({ sessionId: LEG, state: state(16), newRounds: [round(16)] });
eq('…the settled round is', [res.snapshotKept, one('SELECT rounds FROM sessions WHERE id = ?', LEG).rounds, res.logThrough], [true, 16, 16]);

// A snapshot stored by an older build before its round settled: the ledger
// row for the held round is still owed, and is written on the next sync.
sqlite.prepare('DELETE FROM rounds WHERE session_id = ? AND round_no = 16').run(LEG);
await sync({ sessionId: LEG, state: state(16), newRounds: [] });
eq('the held round’s ledger entry is written, not skipped', Boolean(one('SELECT 1 AS x FROM rounds WHERE session_id = ? AND round_no = 16', LEG)), true);

/* Review finding: with the round log in 50-round chunks, each sync read a chunk,
   added to it and wrote it back, so two in flight together could lose a round
   while log_through claimed it. One row per round has no read-modify-write. */
console.log('\nOVERLAP — two syncs in flight together lose nothing');
const OV = 'sess-overlap';
await sync({ sessionId: OV, state: state(160), newRounds: Array.from({ length: 160 }, (_, i) => round(i + 1)) });
const newer = await sync({ sessionId: OV, state: state(162), newRounds: [round(161), round(162)] });  // lands first
const older = await sync({ sessionId: OV, state: state(161), newRounds: [round(161)] });             // lands last
eq('both rounds stored', stored(OV).slice(-2), [161, 162]);
eq('and the reply only ever claims what is stored', [newer.logThrough, older.logThrough], [162, 162]);
eq('the older snapshot did not move the session back', one('SELECT rounds FROM sessions WHERE id = ?', OV).rounds, 162);
eq('…and a late snapshot on the SAME line is not mistaken for a fork',
   [older.forked, Boolean(one('SELECT 1 AS x FROM sessions WHERE id = ?', `${OV}-fork1`))], [false, false]);

/* ------------------------------------------------------ the 26 October case */
console.log('\nFORKS — a phone on another line of play never overwrites the stored one');
const before = one('SELECT rounds, state_json FROM sessions WHERE id = ?', LEG);
res = await sync({ sessionId: LEG, state: state(9, 'b'), newRounds: [round(9, 'b')] });
eq('a stale phone (9 behind 16) is kept apart, not applied', [res.forked, res.sessionId], [true, `${LEG}-fork1`]);
eq('the stored session is exactly as it was', one('SELECT rounds, state_json FROM sessions WHERE id = ?', LEG), before);

res = await sync({ sessionId: LEG, state: state(17, 'b'), newRounds: [round(17, 'b')] });
eq('…and it STAYS apart after it plays past the stored count', [res.forked, res.sessionId], [true, `${LEG}-fork1`]);
eq('the stored session still has not moved', one('SELECT rounds FROM sessions WHERE id = ?', LEG).rounds, 16);

res = await sync({ sessionId: LEG, state: state(17, 'a'), newRounds: [round(17, 'a')] });
eq('the genuine line of play carries on in the session itself', [res.forked, res.sessionId, res.logThrough], [false, LEG, 17]);

eq('forks are out of the history list', (await repo.listSessions(db, USER)).results.some((s) => s.fork_of), false);
eq('forks are out of the published data', (await repo.exportSessionsLean(db, USER)).map((s) => s.id).includes(`${LEG}-fork1`), false);
eq('forks are never offered as the session to resume',
   JSON.parse(await repo.latestSessionText(db, USER, 1)).session.id === `${LEG}-fork1`, false);
eq('…but one can still be fetched by id', Boolean((await repo.exportSessions(db, USER, `${LEG}-fork1`)).length), true);

/* Review finding — and it was live: Ram's session 94817d60 is stored at R1621
   on one line of play while its `rounds` ledger holds round 1621 from another
   (net 700 in the ledger, 2,100 in the state; the ledger keeps the first copy
   of each round it ever saw). Tested against the ledger, his genuine line
   would fork on its very first sync and his published figures would freeze. */
console.log('\nRAM’S SESSION — a ledger mixing lines must not fork the stored one');
const MIX = 'sess-mixed';
seed(MIX, USER, 21, [...Array.from({ length: 8 }, (_, i) => round(i + 1)), ...Array.from({ length: 12 }, (_, i) => round(10 + i, 'c'))],
     history(13, 'a').concat(history(21, 'b', 14)));
sqlite.prepare('UPDATE sessions SET state_json = ? WHERE id = ?')
  .run(JSON.stringify({ ...state(21), roundHistory: history(9, 'a').concat(history(21, 'c', 10)), bankroll: 10000 + money(21, 'c') }), MIX);
const lineC = (n) => ({ ...state(n), roundHistory: history(9, 'a').concat(history(n, 'c', 10)), bankroll: 10000 + money(n, 'c') });
res = await sync({ sessionId: MIX, state: lineC(22), roundLog: [round(22, 'c')] });
eq('the stored line carries on — no fork', [res.forked, res.sessionId], [false, MIX]);
eq('and its new round is stored', stored(MIX).at(-1), 22);
res = await sync({ sessionId: MIX, state: { ...state(23), roundHistory: history(13, 'a').concat(history(23, 'b', 14)) }, newRounds: [] });
eq('a phone on the ledger’s other line IS kept apart', [res.forked, res.sessionId], [true, `${MIX}-fork1`]);

/* --------------------------------------------------------- a fresh session */
console.log('\nROUND ROWS — a session started after the change');
const NEW = 'sess-new';
const first = Array.from({ length: 120 }, (_, i) => round(i + 1));
for (let i = 0; i < 120; i += 40) {
  await sync({ sessionId: NEW, state: state(i + 40), newRounds: first.slice(i, i + 40) });
}
eq('120 rounds, one row each', stored(NEW).length, 120);
eq('no row anywhere near D1’s 2 MB row limit', one('SELECT MAX(LENGTH(data)) AS n FROM round_detail').n < 2000000, true);
const fresh = (await repo.exportSessions(db, USER, NEW))[0];
eq('a session with NO legacy blob still reports per-round detail', hasRoundLog(fresh), true);
eq('…so the published caveats do not call it a pre-capture build',
   caveatsFor([fresh]).some((c) => /no per-round detail/.test(c)), false);
eq('…and do not claim rounds were truncated', caveatsFor([fresh]).some((c) => /truncated/.test(c)), false);

/* Publishing's fast path does not go through exportSessions: it builds one
   fragment per stale session from loadBlobs, and copies the log across by hand
   in src/publish.js. A fragment built from the legacy blob alone would silently
   drop every round played since the change from every published file. */
console.log('\nPUBLISHING — the fragment a publish builds sees every round');
releaseRounds();
const blob = (await repo.loadBlobs(db, USER, [LEG])).get(LEG);
const frag = buildSessionFragment({ id: LEG, started_at: '2026-10-23 03:04:59', ...blob });
eq('fragment counts every stored round', frag.rounds_seen, stored(LEG).length);
eq('…which is every round the server holds', frag.rounds_seen, one('SELECT log_through AS n FROM sessions WHERE id = ?', LEG).n);

/* ----------------------------------------------------------------- reading */
console.log('\nREADING — more sessions than one D1 query can name');
for (let i = 0; i < 95; i += 1) {
  await sync({ sessionId: `bulk-${i}`, state: state(1), newRounds: [round(1)] });
}
const everything = await repo.exportSessions(db, USER, null);
eq('all sessions assemble past the 100-parameter cap', everything.filter((s) => s.id.startsWith('bulk-'))
   .every((s) => s.round_log_rounds && s.round_log_rounds.length === 1), true);
eq('resume reports how far the server holds',
   typeof JSON.parse(await repo.latestSessionText(db, USER, 1)).session.logThrough, 'number');

/* ------------------------------------------------------------------ resume */
console.log('\nRESUME — the reload read, assembled without parsing anything large');
const RU = 'u-resume';
sqlite.prepare(`INSERT INTO users (id, username, password_hash, password_salt, iterations)
                VALUES (?, 'resume', 'x', 'x', 1)`).run(RU);
seed('res-a', RU, 10, Array.from({ length: 10 }, (_, i) => round(i + 1)));
sqlite.prepare("UPDATE sessions SET updated_at = '2000-01-01 00:00:00' WHERE id = 'res-a'").run();
await repo.syncSession(db, RU, { sessionId: 'res-a', deviceId: 'p', appVersion: 't', mode: 'practice', shoe: [],
  lastBets: [], state: state(15), newRounds: [11, 12, 13, 14, 15].map((n) => round(n)) });
const resume = async (tail) => JSON.parse(await repo.latestSessionText(db, RU, tail));
const nums = (r) => r.session.roundLog.map((x) => x.round);

let got = await resume(null);
eq('the hand-built reply is valid JSON, whole log in order', nums(got), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
eq('…state arrives intact', got.session.state.rounds, 15);
eq('…with how far the server holds', got.session.logThrough, 15);
got = await resume(8);
eq('tail 8: exactly the newest 8', nums(got), [8,9,10,11,12,13,14,15]);
got = await resume(3);
eq('tail 3: exactly the newest 3', nums(got), [13,14,15]);

// Never synced since the change, in the other shape the blob was once written in.
seed('res-b', RU, 10, []);
sqlite.prepare("UPDATE sessions SET round_log_json = ?, updated_at = '2099-01-01 00:00:00' WHERE id = 'res-b'")
  .run(JSON.stringify({ rounds: Array.from({ length: 10 }, (_, i) => round(i + 1)) }));
got = await resume(4);
eq('a never-synced, object-shaped legacy log reads the same way', nums(got), [7,8,9,10]);
got = await resume(null);
eq('…whole', nums(got).length, 10);

sqlite.prepare("UPDATE sessions SET fork_of = 'res-b' WHERE id = 'res-b'").run();
got = await resume(4);
eq('a fork is never offered as the game to resume', got.session.id, 'res-a');

/* ----------------------------------------------------------------- privacy */
console.log('\nACCOUNTS — one account cannot write another’s session');
let refused = null;
try { await repo.syncSession(db, OTHER, { sessionId: LEG, state: state(20), newRounds: [] }); }
catch (e) { refused = e.status; }
eq('a sync to another account’s session id is refused', refused, 403);

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
