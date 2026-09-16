// D1 data access. Every query is scoped by user_id so one account can never
// read another's sessions.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const int = (v) => Math.trunc(num(v));

/**
 * Upserts the session snapshot and appends any rounds/mistakes not yet stored.
 * Safe to call repeatedly with the same data — rounds and mistakes are keyed
 * by (session_id, round_no) and (session_id, seq).
 */
export async function syncSession(db, userId, { sessionId, deviceId, appVersion, mode, state, shoe, lastBets, roundLog, roundLogMeta, strategyVersion, rulesProfileId }) {
  const sidePL = num(state.pairsPL) + num(state.triluxPL) + num(state.superPL);

  const statements = [
    db.prepare(`
      INSERT INTO sessions (
        id, user_id, device_id, app_version, mode, started_at, updated_at,
        start_bankroll, bankroll, rounds, decisions, correct, mistakes_count,
        main_pl, pairs_pl, trilux_pl, super_pl,
        high_bankroll, low_bankroll, max_drawdown,
        total_main_staked, total_side_staked, largest_main_bet,
        longest_win_streak, longest_loss_streak, shoe_number,
        state_json, shoe_json, last_bets_json, round_log_json,
        round_log_meta, strategy_version, rules_profile
      ) VALUES (
        ?1, ?2, ?3, ?4, ?27, datetime('now'), datetime('now'),
        ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14,
        ?15, ?16, ?17,
        ?18, ?19, ?20,
        ?21, ?22, ?23,
        ?24, ?25, ?26, ?28,
        ?29, ?30, ?31
      )
      ON CONFLICT(id) DO UPDATE SET
        updated_at          = datetime('now'),
        device_id           = excluded.device_id,
        mode                = excluded.mode,
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
        round_log_json      = COALESCE(excluded.round_log_json, sessions.round_log_json),
        round_log_meta      = COALESCE(excluded.round_log_meta, sessions.round_log_meta),
        strategy_version    = COALESCE(excluded.strategy_version, sessions.strategy_version),
        rules_profile       = COALESCE(excluded.rules_profile, sessions.rules_profile),
        app_version         = COALESCE(excluded.app_version, sessions.app_version)
    `).bind(
      sessionId, userId, deviceId ?? null, appVersion ?? null,
      num(state.start), num(state.bankroll), int(state.rounds), int(state.decisions),
      int(state.correct), int(state.mistakes?.length),
      num(state.mainPL), num(state.pairsPL), num(state.triluxPL), num(state.superPL),
      num(state.high), num(state.low), num(state.maxDrawdown),
      num(state.totalMainStaked), num(state.totalSideStaked), num(state.largestMainBet),
      int(state.longestWinStreak), int(state.longestLossStreak), int(state.shoeNumber) || 1,
      JSON.stringify(state), JSON.stringify(shoe ?? []), JSON.stringify(lastBets ?? []),
      mode === 'live' ? 'live' : 'practice',
      roundLog == null ? null : JSON.stringify(roundLog),
      roundLogMeta == null ? null : JSON.stringify(roundLogMeta),
      strategyVersion ?? null,
      rulesProfileId ?? null
    ),
  ];

  for (const r of state.roundHistory ?? []) {
    statements.push(db.prepare(`
      INSERT INTO rounds (session_id, round_no, boxes, main_net, side_net, total_net, bankroll)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(session_id, round_no) DO NOTHING
    `).bind(
      sessionId, int(r.round), int(r.boxes),
      num(r.mainNet), num(r.sideNet), num(r.totalNet), num(r.bankroll)
    ));
  }

  (state.mistakes ?? []).forEach((m, seq) => {
    statements.push(db.prepare(`
      INSERT INTO mistakes (
        session_id, seq, round_no, box, hand, hand_label,
        dealer_card, chosen_action, correct_action
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(session_id, seq) DO NOTHING
    `).bind(
      sessionId, seq, int(m.round), int(m.box),
      m.hand ?? null, m.label ?? null, m.dealer ?? null,
      m.chosen ?? null, m.correct ?? null
    ));
  });

  await db.batch(statements);

  return {
    sessionId,
    rounds: int(state.rounds),
    mistakes: int(state.mistakes?.length),
    sidePL,
  };
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
    WHERE s.user_id = ?
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).bind(userId, limit).all();
}

/**
 * Sessions for export. Only the columns the export needs, so a whole account's
 * round logs are not loaded twice.
 */
export async function exportSessions(db, userId, sessionId) {
  // The per-session aggregates are here for src/digest.js, which summarises the
  // same rows. The CSV export ignores them; they are cheap scalars either way.
  const cols = `id, started_at, updated_at, app_version, strategy_version,
                rules_profile, mode, rounds, round_log_json, round_log_meta,
                decisions, correct, mistakes_count,
                state_json,
                start_bankroll, bankroll, main_pl, pairs_pl, trilux_pl, super_pl,
                max_drawdown, total_main_staked, total_side_staked`;
  const q = sessionId
    ? db.prepare(`SELECT ${cols} FROM sessions WHERE user_id = ? AND id = ?`).bind(userId, sessionId)
    : db.prepare(`SELECT ${cols} FROM sessions WHERE user_id = ? ORDER BY started_at`).bind(userId);
  const { results } = await q.all();
  return results ?? [];
}

export async function getSession(db, userId, sessionId) {
  const session = await db.prepare(
    'SELECT * FROM sessions WHERE id = ? AND user_id = ?'
  ).bind(sessionId, userId).first();
  if (!session) return null;

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

/** Returns the most recently updated session, for cross-device resume. */
export function latestSession(db, userId) {
  return db.prepare(`
    SELECT id, state_json, shoe_json, last_bets_json, round_log_json, updated_at, device_id
    FROM sessions WHERE user_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `).bind(userId).first();
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
