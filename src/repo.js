// D1 data access. Every query is scoped by user_id so one account can never
// read another's sessions.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const int = (v) => Math.trunc(num(v));

/* ---------------------------------------------------------------- round log
 *
 * WHY THE ROUND LOG IS ONE ROW PER ROUND, APPENDED AND NEVER REPLACED
 *
 * It used to be one field, sessions.round_log_json, replaced on every sync with
 * whatever log the phone happened to hold. On 26 October that went wrong three
 * ways at once, and then again forty minutes later:
 *
 *  - Every round re-sent the whole history: 5.5 MB a round by R1635. The free
 *    plan's CPU allowance cannot parse that, so syncs died as exceededCpu and
 *    nothing reached the server for a day.
 *  - A phone that reloaded from an older copy sent the older log, and the
 *    replace destroyed newer rounds the server already had: 1610-1613 at about
 *    18:00, then the 1610-1635 that replaced them at 18:44, when his phone came
 *    back at the same frozen R1609 a second time.
 *  - D1 caps a row at 2 MB. That one field was 3.7 M characters.
 *
 * So each round is its own row in round_detail, keyed (session_id, round) and
 * written INSERT ... ON CONFLICT DO NOTHING. Nothing is ever read and rewritten,
 * so two syncs in flight together cannot lose each other's rounds — the 50-round
 * chunks this briefly used could, because each sync read a chunk, added to it
 * and wrote the whole chunk back. A stored round is never overwritten.
 *
 * The first time a session written by the old code is touched, its legacy blob
 * is copied into round_detail by one INSERT ... SELECT over json_each — inside
 * D1, so none of those megabytes pass through the Worker. From then on the blob
 * is a frozen backup, not the only copy: an older build overwriting it (a
 * rollback, say) can no longer destroy anything.
 */

/* D1 caps bound parameters at 100 per query, and an IN list spends one per id.
   Ram has more than 64 sessions and the count only grows. */
const IN_BATCH = 90;

/* The engine's raw event list is 91% of a stored state (1.37 of 1.51 MB at
   R1635) and nothing on the server reads it. The round log carries the same
   information per round; the AI context is built on the phone from the newest
   400. Keeping those 400 means a session restored on another device still has
   what the AI path would have sent. */
const EVENT_KEEP = 400;

/* Where the rounds sit inside a legacy blob. Most were written as a bare array;
   early ones as {rounds: [...]}. Evaluated by D1, per row. */
const LEGACY_PATH = "CASE WHEN json_type(s.round_log_json) = 'array' THEN '$' ELSE '$.rounds' END";

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** The legacy blob's rounds, in whichever of its two shapes it was written. */
function legacyRounds(text) {
  const parsed = parseJson(text, null);
  if (Array.isArray(parsed)) return parsed;
  return parsed && Array.isArray(parsed.rounds) ? parsed.rounds : [];
}

/** A copy of state as it is stored: the event list cut, nothing else touched. */
function stateForStorage(state) {
  if (!state || !Array.isArray(state.eventLog) || state.eventLog.length <= EVENT_KEEP) {
    return state;
  }
  return { ...state, eventLog: state.eventLog.slice(-EVENT_KEEP) };
}

const sameMoney = (a, b) => Math.abs(num(a) - num(b)) < 0.005;

/* A hand in progress. dealRound has already counted the round and taken the
   stake, but the round has not settled — so a snapshot taken now and later
   restored would bring back a bankroll missing a stake that is never paid out. */
const midRound = (state) => state && (state.phase === 'player' || state.phase === 'dealer');

/* IS THIS PHONE ON THE SAME LINE OF PLAY AS THE STORED SESSION?
 *
 * Comparing round counts is not enough. A phone that reloaded from R1609 is
 * behind a stored R1635, and that is caught — but if it plays on past R1635 its
 * count overtakes, and a count test would then write its line over the stored
 * one: the same destruction, a round later.
 *
 * So the test is whether the phone's copy of the stored session's last settled
 * round agrees with it. That is read from the stored STATE — the copy a resume
 * actually hands out — and not from the `rounds` ledger. The ledger keeps the
 * first copy of each round it sees, so on Ram's session it already mixes three
 * lines: round 1621 is net 700 there and 2,100 in the stored state. Tested
 * against the ledger, his genuine line would have forked on its first sync and
 * his published figures frozen. json_extract runs inside D1, so the Worker never
 * parses the stored state to answer this. */
async function divergesFrom(db, row, state) {
  const mine = state.roundHistory || [];
  const myLast = mine.length ? int(mine[mine.length - 1] && mine[mine.length - 1].round) : 0;
  if (myLast < 1) return false;                                    // nothing settled to compare
  const last = await db.prepare(`
    SELECT CAST(json_extract(state_json, '$.roundHistory[#-1].round') AS INTEGER) AS r
      FROM sessions WHERE id = ?`).bind(row.id).first();
  if (!last || last.r == null || int(last.r) < 1) return false;   // nothing settled is stored
  /* Compared at the last round BOTH have settled. Behind is not the same as
     diverged: an older snapshot landing after a newer one — two syncs crossing
     on a slow link — agrees with the stored line where it stops, and is just old
     news (the upsert's WHERE guard keeps it from moving the session back).
     A phone that reloaded from R1609 and played R1610 does NOT agree at 1610. */
  const at = Math.min(myLast, int(last.r));
  const theirs = await db.prepare(`
    SELECT json_extract(j.value, '$.totalNet') AS tn, json_extract(j.value, '$.bankroll') AS bk
      FROM sessions s, json_each(s.state_json, '$.roundHistory') j
     WHERE s.id = ? AND CAST(json_extract(j.value, '$.round') AS INTEGER) = ?`).bind(row.id, at).first();
  const ours = mine.find((r) => int(r && r.round) === at);
  if (!theirs || !ours) return false;                              // nothing to compare: trust it
  return !(sameMoney(theirs.tn, ours.totalNet) && sameMoney(theirs.bk, ours.bankroll));
}

/* A copy that has diverged is not refused — that phone may be the only place
   the rounds it goes on to play exist, and refusing would lose them instead.
   It is kept BESIDE the session as <id>-fork1 (then -fork2 ...), and the stored
   session is left exactly as it was. Forks are kept out of the published data
   and the history list, so a replayed stretch is never counted twice. */
async function resolveTarget(db, userId, sessionId, state) {
  let id = sessionId;
  for (let n = 1; n <= 9; n += 1) {
    const row = await db.prepare(`
      SELECT id, user_id, rounds, mistakes_count, log_through, round_log_meta, fork_of
        FROM sessions WHERE id = ?`).bind(id).first();
    const forkOf = id === sessionId ? null : sessionId;
    if (!row) return { id, row: null, forkOf };
    if (row.user_id !== userId) {
      const err = new Error('That session belongs to another account.');
      err.status = 403;
      throw err;
    }
    if (!(await divergesFrom(db, row, state))) return { id, row, forkOf };
    id = `${sessionId}-fork${n}`;
  }
  const err = new Error('This session has diverged more times than can be kept apart.');
  err.status = 409;
  throw err;
}

/** The highest round the server holds, for a row written before this change. */
function heldThrough(row) {
  if (!row) return 0;
  if (row.log_through != null) return int(row.log_through);
  const meta = parseJson(row.round_log_meta, null);
  return meta && Number.isFinite(Number(meta.lastRound)) ? int(meta.lastRound) : 0;
}

/* Rounds this sync may add. Past what the server already holds; not numbered
   past what the phone's own state has played; and on the phone's own line — a
   logged round whose net disagrees with the engine's own ledger for that round
   is from some other copy that ended up in the phone's log, and storing it would
   stitch two games together. On Ram's live session the two agree on every round
   (measured: 179 of 179), so this can only ever reject a stranger. */
function freshRounds(incoming, through, state) {
  const nets = new Map((state.roundHistory || []).map((r) => [int(r && r.round), r && r.totalNet]));
  const top = int(state.rounds);
  const out = new Map();
  for (const r of incoming || []) {
    const n = Number(r && r.round);
    if (!Number.isInteger(n) || n < 1 || n <= through || n > top || out.has(n)) continue;
    if (nets.has(n) && r.net != null && !sameMoney(r.net, nets.get(n))) continue;
    out.set(n, r);
  }
  return [...out.values()];
}

/* What the published caveats need to know about the legacy part: frozen as the
   phone last described it, since that is still the truth about those rounds.
   The phone now keeps only recent rounds, so its own view of "truncated" or
   "first round" must never reach round_log_meta again. */
function legacyFacts(row) {
  const prev = parseJson(row && row.round_log_meta, null);
  if (!prev) return { truncated: false, maxRounds: null };
  const legacy = prev.storage === 'rounds' ? (prev.legacy || {}) : prev;
  return { truncated: Boolean(legacy.truncated), maxRounds: legacy.maxRounds ?? null };
}

/**
 * Stores a session snapshot and appends whatever rounds the server lacks.
 *
 * Two shapes arrive. A current phone sends `newRounds` — only rounds past what
 * the server last told it it holds. A phone still running an older build sends
 * its whole `roundLog` every round; only the rounds past `through` are taken
 * from it, so the old shape can no longer overwrite stored rounds either.
 *
 * Returns logThrough — read back from what is actually stored, never from what
 * this request believes it added — which the phone uses to decide what to send.
 */
export async function syncSession(db, userId, {
  sessionId, deviceId, appVersion, mode, state, shoe, lastBets,
  roundLog, newRounds, strategyVersion, rulesProfileId,
}) {
  const sidePL = num(state.pairsPL) + num(state.triluxPL) + num(state.superPL);
  const target = await resolveTarget(db, userId, sessionId, state);
  const row = target.row;
  const through = heldThrough(row);
  const fresh = freshRounds(Array.isArray(newRounds) ? newRounds : roundLog, through, state);
  const facts = legacyFacts(row);
  const statements = [];

  // 1. A session from before this change: copy its legacy rounds across, once,
  //    inside D1. log_through is NULL until the first sync after the change.
  if (row && row.log_through == null) {
    statements.push(db.prepare(`
      INSERT INTO round_detail (session_id, round, data)
      SELECT s.id, CAST(json_extract(j.value, '$.round') AS INTEGER), j.value
        FROM sessions s, json_each(s.round_log_json, ${LEGACY_PATH}) j
       WHERE s.id = ?1 AND s.round_log_json IS NOT NULL
         AND json_type(j.value) = 'object'
         AND json_extract(j.value, '$.round') IS NOT NULL
      ON CONFLICT(session_id, round) DO NOTHING
    `).bind(target.id));
  }

  // 2. The new rounds. Never read back and rewritten, so nothing can race.
  for (const r of fresh) {
    statements.push(db.prepare(`
      INSERT INTO round_detail (session_id, round, data) VALUES (?1, ?2, ?3)
      ON CONFLICT(session_id, round) DO NOTHING
    `).bind(target.id, int(r.round), JSON.stringify(r)));
  }

  /* 3. The snapshot itself — unless a hand is in progress. Old builds could
     sync mid-hand (the 'online' event, a sign-in); a resumed snapshot like that
     would bring back the stake without the hand. The rounds above are all
     settled, so they are kept; the snapshot waits for the next settled round. */
  if (!midRound(state)) {
    statements.push(db.prepare(`
      INSERT INTO sessions (
        id, user_id, device_id, app_version, mode, started_at, updated_at,
        start_bankroll, bankroll, rounds, decisions, correct, mistakes_count,
        main_pl, pairs_pl, trilux_pl, super_pl,
        high_bankroll, low_bankroll, max_drawdown,
        total_main_staked, total_side_staked, largest_main_bet,
        longest_win_streak, longest_loss_streak, shoe_number,
        state_json, shoe_json, last_bets_json,
        strategy_version, rules_profile, log_through, fork_of
      ) VALUES (
        ?1, ?2, ?3, ?4, ?27, datetime('now'), datetime('now'),
        ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14,
        ?15, ?16, ?17,
        ?18, ?19, ?20,
        ?21, ?22, ?23,
        ?24, ?25, ?26,
        ?28, ?29,
        (SELECT MAX(round) FROM round_detail WHERE session_id = ?1),
        ?30
      )
      ON CONFLICT(id) DO UPDATE SET
        updated_at          = datetime('now'),
        device_id           = excluded.device_id,
        mode                = excluded.mode,
        -- A top-up raises state.start as well as state.bankroll, so session P/L
        -- (bankroll - start) stays a true profit figure and does not count
        -- deposited capital as winnings. That only holds if BOTH sides reach the
        -- database. start_bankroll was missing from this list, so it kept the
        -- value from the row's first write and every top-up appeared as profit
        -- in the published record — £18,500 across six sessions before this.
        start_bankroll      = excluded.start_bankroll,
        bankroll            = excluded.bankroll,
        rounds              = excluded.rounds,
        decisions           = excluded.decisions,
        correct             = excluded.correct,
        mistakes_count      = excluded.mistakes_count,
        main_pl             = excluded.main_pl,
        pairs_pl            = excluded.pairs_pl,
        trilux_pl           = excluded.trilux_pl,
        super_pl            = excluded.super_pl,
        high_bankroll       = excluded.high_bankroll,
        low_bankroll        = excluded.low_bankroll,
        max_drawdown        = excluded.max_drawdown,
        total_main_staked   = excluded.total_main_staked,
        total_side_staked   = excluded.total_side_staked,
        largest_main_bet    = excluded.largest_main_bet,
        longest_win_streak  = excluded.longest_win_streak,
        longest_loss_streak = excluded.longest_loss_streak,
        shoe_number         = excluded.shoe_number,
        state_json          = excluded.state_json,
        shoe_json           = excluded.shoe_json,
        last_bets_json      = excluded.last_bets_json,
        -- round_log_json is deliberately absent: frozen, never written again.
        strategy_version    = COALESCE(excluded.strategy_version, sessions.strategy_version),
        rules_profile       = COALESCE(excluded.rules_profile, sessions.rules_profile),
        app_version         = COALESCE(excluded.app_version, sessions.app_version)
      -- Belt and braces under the divergence check above: a concurrent sync can
      -- never move a stored session back a round.
      WHERE excluded.rounds >= sessions.rounds
    `).bind(
      target.id, userId, deviceId ?? null, appVersion ?? null,
      num(state.start), num(state.bankroll), int(state.rounds), int(state.decisions),
      int(state.correct), int(state.mistakes?.length),
      num(state.mainPL), num(state.pairsPL), num(state.triluxPL), num(state.superPL),
      num(state.high), num(state.low), num(state.maxDrawdown),
      num(state.totalMainStaked), num(state.totalSideStaked), num(state.largestMainBet),
      int(state.longestWinStreak), int(state.longestLossStreak), int(state.shoeNumber) || 1,
      JSON.stringify(stateForStorage(state)), JSON.stringify(shoe ?? []), JSON.stringify(lastBets ?? []),
      mode === 'live' ? 'live' : 'practice',
      strategyVersion ?? null,
      rulesProfileId ?? null,
      target.forkOf
    ));

    /* Only what is new. Both tables are keyed so a repeat is a no-op, but every
       sync used to re-send all of them anyway — 1,635 INSERTs a round at R1635,
       each one bound and shipped to D1, to store one round. The held round is
       included (>=, not >): a snapshot stored before a round settled leaves that
       round's ledger entry still to write. */
    const roundsHeld = row ? int(row.rounds) : 0;
    for (const r of state.roundHistory ?? []) {
      if (int(r.round) < roundsHeld) continue;
      statements.push(db.prepare(`
        INSERT INTO rounds (session_id, round_no, boxes, main_net, side_net, total_net, bankroll)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(session_id, round_no) DO NOTHING
      `).bind(
        target.id, int(r.round), int(r.boxes),
        num(r.mainNet), num(r.sideNet), num(r.totalNet), num(r.bankroll)
      ));
    }

    const mistakesHeld = row ? int(row.mistakes_count) : 0;
    (state.mistakes ?? []).forEach((m, seq) => {
      if (seq < mistakesHeld) return;
      statements.push(db.prepare(`
        INSERT INTO mistakes (
          session_id, seq, round_no, box, hand, hand_label,
          dealer_card, chosen_action, correct_action
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(session_id, seq) DO NOTHING
      `).bind(
        target.id, seq, int(m.round), int(m.box),
        m.hand ?? null, m.label ?? null, m.dealer ?? null,
        m.chosen ?? null, m.correct ?? null
      ));
    });
  }

  /* 4. How far the server holds, and the summary the published caveats read —
     both from what is actually stored, after everything above has landed. */
  statements.push(db.prepare(`
    UPDATE sessions SET
      log_through = MAX(COALESCE(log_through, 0),
                        COALESCE((SELECT MAX(round) FROM round_detail WHERE session_id = ?1), 0)),
      round_log_meta = json_object(
        'storage', 'rounds',
        'captured',  (SELECT COUNT(*)   FROM round_detail WHERE session_id = ?1),
        'firstRound',(SELECT MIN(round) FROM round_detail WHERE session_id = ?1),
        'lastRound', (SELECT MAX(round) FROM round_detail WHERE session_id = ?1),
        'truncated', json(?2),
        'maxRounds', ?3,
        'legacy', json_object('truncated', json(?2), 'maxRounds', ?3))
    WHERE id = ?1 AND EXISTS (SELECT 1 FROM round_detail WHERE session_id = ?1)
  `).bind(target.id, facts.truncated ? 'true' : 'false', facts.maxRounds));

  await db.batch(statements);

  const held = await db.prepare(`
    SELECT COALESCE((SELECT MAX(round) FROM round_detail WHERE session_id = ?1), 0) AS stored,
           (SELECT log_through FROM sessions WHERE id = ?1) AS through
  `).bind(target.id).first();
  const logThrough = Math.max(int(held && held.stored), int(held && held.through), through);

  return {
    sessionId: target.id,
    rounds: int(state.rounds),
    mistakes: int(state.mistakes?.length),
    sidePL,
    logThrough,
    appended: fresh.length,
    snapshotKept: !midRound(state),
    forked: Boolean(target.forkOf),
    forkOf: target.forkOf,
  };
}

/** Every stored round for these sessions, grouped by session, in round order. */
async function detailRounds(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    const part = ids.slice(i, i + IN_BATCH);
    const { results } = await db.prepare(
      `SELECT session_id, data FROM round_detail
        WHERE session_id IN (${part.map(() => '?').join(',')})
        ORDER BY session_id, round`,
    ).bind(...part).all();
    for (const row of results ?? []) {
      const list = out.get(row.session_id) || [];
      const r = parseJson(row.data, null);
      if (r) list.push(r);
      out.set(row.session_id, list);
    }
  }
  return out;
}

/* Give each row its whole log as round_log_rounds, which export.js's roundsOf()
   prefers. A session synced since this change has every round in round_detail —
   its legacy rounds were copied across in the same transaction as its first new
   one — so that is the whole log. A session never touched since keeps reading
   its legacy blob, parsed lazily as before, at no extra cost. */
async function withAssembledLog(db, rows) {
  if (!rows || !rows.length) return rows || [];
  const detail = await detailRounds(db, rows.map((r) => r.id));
  for (const row of rows) {
    const list = detail.get(row.id);
    if (list && list.length) row.round_log_rounds = list;
  }
  return rows;
}

export function ownsSession(db, userId, sessionId) {
  return db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, userId).first();
}

export function listSessions(db, userId, limit = 50) {
  return db.prepare(`
    SELECT s.id, s.mode, s.strategy_version, s.started_at, s.updated_at, s.rounds, s.decisions, s.correct,
           s.mistakes_count, s.start_bankroll, s.bankroll, s.main_pl,
           s.pairs_pl, s.trilux_pl, s.super_pl, s.max_drawdown,
           (SELECT COUNT(*) FROM ai_analyses a
             WHERE a.session_id = s.id AND a.status = 'complete') AS analyses
    FROM sessions s
    WHERE s.user_id = ? AND s.fork_of IS NULL
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).bind(userId, limit).all();
}

/**
 * Sessions for export. Only the columns the export needs, so a whole account's
 * round logs are not loaded twice.
 */
/* The same rows WITHOUT the two large blobs.
 *
 * round_log_json and state_json are 30 MB across Ram's history and were being
 * pulled on every publish to recompute figures that had been settled for weeks.
 * The cached fragment carries what the digests need; this fetches that instead,
 * plus a flag for whether a round log exists at all, which is the only thing
 * summary.json wanted the blob for.
 */
export async function exportSessionsLean(db, userId) {
  const cols = `id, started_at, updated_at, app_version, strategy_version,
                rules_profile, mode, rounds, round_log_meta,
                decisions, correct, mistakes_count,
                start_bankroll, bankroll, main_pl, pairs_pl, trilux_pl, super_pl,
                max_drawdown, total_main_staked, total_side_staked,
                digest_cache_json, digest_cache_at,
                (round_log_meta IS NOT NULL) AS has_round_log`;
  // round_log_meta, not round_log_json. Testing the blob for null makes D1 read
  // the column — 1.59s against 0.74s for the same 64 rows — which defeats the
  // whole point of a lean query. round_log_meta is written alongside the log and
  // is a few bytes.
  // Forks are excluded: a copy kept beside a session shares its early rounds,
  // so publishing it as well would count that stretch of play twice.
  const { results } = await db.prepare(
    `SELECT ${cols} FROM sessions WHERE user_id = ? AND fork_of IS NULL ORDER BY started_at`,
  ).bind(userId).all();
  return results ?? [];
}

/** The blobs for specific sessions — only the ones that actually need rebuilding. */
export async function loadBlobs(db, userId, ids) {
  if (!ids || !ids.length) return new Map();
  const marks = ids.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT id, round_log_json, state_json FROM sessions
      WHERE user_id = ? AND id IN (${marks})`,
  ).bind(userId, ...ids).all();
  // The frozen legacy log plus whatever has been appended since.
  await withAssembledLog(db, results ?? []);
  return new Map((results ?? []).map((r) => [r.id, r]));
}

/* Store many fragments in ONE round trip.
 *
 * Saving them one at a time cost a subrequest each, and Cloudflare allows 50
 * per request with D1 calls counting toward it — so a cold cache of 64 sessions
 * could not save its work without running the request out of budget. d1.batch
 * sends the lot as a single statement list. */
export async function saveFragments(db, userId, rows) {
  if (!rows || !rows.length) return;
  const stmt = db.prepare(
    'UPDATE sessions SET digest_cache_json = ?, digest_cache_at = ? WHERE id = ? AND user_id = ?',
  );
  await db.batch(rows.map((r) => stmt.bind(r.json, r.at, r.id, userId)));
}

/** Store a session's reduced form, stamped so staleness is decidable. */
export async function saveFragment(db, userId, id, json, at) {
  await db.prepare(
    'UPDATE sessions SET digest_cache_json = ?, digest_cache_at = ? WHERE id = ? AND user_id = ?',
  ).bind(json, at, id, userId).run();
}

export async function exportSessions(db, userId, sessionId) {
  // The per-session aggregates are here for src/digest.js, which summarises the
  // same rows. The CSV export ignores them; they are cheap scalars either way.
  const cols = `id, started_at, updated_at, app_version, strategy_version,
                rules_profile, mode, rounds, round_log_json, round_log_meta,
                decisions, correct, mistakes_count,
                state_json,
                start_bankroll, bankroll, main_pl, pairs_pl, trilux_pl, super_pl,
                max_drawdown, total_main_staked, total_side_staked`;
  // One session by id is returned even if it is a fork — someone asked for it.
  // "All sessions" excludes forks for the same reason exportSessionsLean does.
  const q = sessionId
    ? db.prepare(`SELECT ${cols} FROM sessions WHERE user_id = ? AND id = ?`).bind(userId, sessionId)
    : db.prepare(`SELECT ${cols} FROM sessions WHERE user_id = ? AND fork_of IS NULL ORDER BY started_at`).bind(userId);
  const { results } = await q.all();
  return withAssembledLog(db, results ?? []);
}

export async function getSession(db, userId, sessionId) {
  const session = await db.prepare(
    'SELECT * FROM sessions WHERE id = ? AND user_id = ?'
  ).bind(sessionId, userId).first();
  if (!session) return null;
  // The phone parses session.round_log_json to show a stored session's rounds,
  // and a build already on someone's phone expects exactly that string. So a
  // chunked session is handed back in the same shape, whole.
  await withAssembledLog(db, [session]);
  if (Array.isArray(session.round_log_rounds)) {
    session.round_log_json = JSON.stringify(session.round_log_rounds);
    delete session.round_log_rounds;
  }

  const [rounds, mistakes, analyses] = await Promise.all([
    db.prepare('SELECT * FROM rounds WHERE session_id = ? ORDER BY round_no').bind(sessionId).all(),
    db.prepare('SELECT * FROM mistakes WHERE session_id = ? ORDER BY seq').bind(sessionId).all(),
    db.prepare(`
      SELECT id, status, model, provider, prompt_version, analysis_text, analysis_json,
             error_message, total_tokens, latency_ms, created_at, completed_at
      FROM ai_analyses WHERE session_id = ? ORDER BY created_at DESC
    `).bind(sessionId).all(),
  ]);

  return {
    session,
    rounds: rounds.results ?? [],
    mistakes: mistakes.results ?? [],
    analyses: (analyses.results ?? []).map((a) => ({
      ...a,
      analysis_json: a.analysis_json ? JSON.parse(a.analysis_json) : null,
    })),
  };
}

/* THE RESUME READ, WITH NOTHING LARGE PARSED IN THE WORKER
 *
 * This is the request a phone makes the moment it reloads — the moment that
 * lost 145 rounds on 26 October. Answering it the obvious way means JSON.parse
 * of the stored state (1.6 MB for Ram's old session) and of its legacy log
 * (3.7 MB), then re-serialising both: the same CPU cost that was getting every
 * sync killed on the free plan. Killed here, the phone would never learn the
 * server holds a newer game, would carry on from its stale copy, and would fork.
 *
 * So nothing large is parsed. The newest rounds come straight off round_detail's
 * primary key; a session never synced since the change has its legacy tail
 * picked out by D1 itself (json_each runs in the database, not the Worker); and
 * the reply is assembled from stored JSON by concatenation.
 *
 * `tail` asks for that many of the newest rounds. Without it — an older build,
 * which treats what it gets as its whole history — the whole log is returned. */
export async function latestSessionText(db, userId, tail) {
  const row = await db.prepare(`
    SELECT id, rounds, updated_at, device_id, log_through, round_log_meta,
           state_json, shoe_json, last_bets_json
      FROM sessions WHERE user_id = ? AND fork_of IS NULL
     ORDER BY updated_at DESC LIMIT 1
  `).bind(userId).first();
  if (!row) return null;

  const want = Number.isInteger(tail) && tail > 0 ? tail : null;
  const pick = async (sql) => {
    const { results } = await db.prepare(sql).bind(...(want ? [row.id, want] : [row.id])).all();
    const items = (results ?? []).map((r) => r.v).filter((v) => v != null && v !== '');
    return want ? items.reverse() : items;           // fetched newest-first, so LIMIT cuts
  };
  let items = await pick(want
    ? 'SELECT data AS v FROM round_detail WHERE session_id = ? ORDER BY round DESC LIMIT ?'
    : 'SELECT data AS v FROM round_detail WHERE session_id = ? ORDER BY round');
  if (!items.length) {
    items = await pick(`
      SELECT j.value AS v FROM sessions s, json_each(s.round_log_json, ${LEGACY_PATH}) j
       WHERE s.id = ? AND s.round_log_json IS NOT NULL AND json_type(j.value) = 'object'
       ORDER BY j.key ${want ? 'DESC LIMIT ?' : ''}`);
  }

  const raw = (text, empty) => (text == null || text === '' ? empty : text);
  return '{"session":{'
    + '"id":' + JSON.stringify(row.id)
    + ',"rounds":' + JSON.stringify(row.rounds ?? 0)
    + ',"logThrough":' + JSON.stringify(heldThrough(row))
    + ',"updatedAt":' + JSON.stringify(row.updated_at ?? null)
    + ',"deviceId":' + JSON.stringify(row.device_id ?? null)
    + ',"state":' + raw(row.state_json, 'null')
    + ',"shoe":' + raw(row.shoe_json, '[]')
    + ',"lastBets":' + raw(row.last_bets_json, '[]')
    + ',"roundLog":[' + items.join(',') + ']'
    + '}}';
}

export async function saveSharedReport(db, { id, sessionId, userId, reportText, context }) {
  await db.prepare(`
    INSERT INTO shared_reports (id, session_id, user_id, report_text, context_json)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, sessionId, userId, reportText, JSON.stringify(context ?? {})).run();
  return id;
}

export async function recordAnalysis(db, row) {
  await db.prepare(`
    INSERT INTO ai_analyses (
      id, session_id, shared_report_id, user_id, status, provider, model, prompt_version,
      analysis_text, analysis_json, error_message,
      prompt_tokens, candidate_tokens, total_tokens, latency_ms, completed_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, datetime('now'))
  `).bind(
    row.id, row.sessionId, row.sharedReportId, row.userId, row.status,
    row.provider ?? 'vertex-ai', row.model ?? null, row.promptVersion ?? null,
    row.analysisText ?? null,
    row.analysisJson ? JSON.stringify(row.analysisJson) : null,
    row.errorMessage ?? null,
    row.promptTokens ?? null, row.candidateTokens ?? null,
    row.totalTokens ?? null, row.latencyMs ?? null
  ).run();
}

/**
 * The summary block from the most recent successfully-analysed report for this
 * session. Section 7 of the prompt uses it to compute the latest-segment delta.
 */
export async function previousCheckpoint(db, sessionId) {
  const row = await db.prepare(`
    SELECT sr.context_json, sr.created_at
    FROM shared_reports sr
    JOIN ai_analyses a ON a.shared_report_id = sr.id AND a.status = 'complete'
    WHERE sr.session_id = ?
    ORDER BY sr.created_at DESC
    LIMIT 1
  `).bind(sessionId).first();
  if (!row?.context_json) return null;

  try {
    const ctx = JSON.parse(row.context_json);
    if (!ctx.summary) return null;
    return { ...ctx.summary, checkpointAt: row.created_at };
  } catch {
    return null;
  }
}

export function listAnalyses(db, userId, limit = 50) {
  return db.prepare(`
    SELECT a.id, a.session_id, a.status, a.model, a.prompt_version,
           a.analysis_text, a.analysis_json,
           a.created_at, a.total_tokens, a.latency_ms,
           s.rounds, s.bankroll, s.start_bankroll
    FROM ai_analyses a
    JOIN sessions s ON s.id = a.session_id
    WHERE a.user_id = ? AND a.status = 'complete'
    ORDER BY a.created_at DESC
    LIMIT ?
  `).bind(userId, limit).all();
}
