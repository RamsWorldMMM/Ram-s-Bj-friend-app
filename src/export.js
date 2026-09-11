/* Raw event-log export.
 *
 * Ram's requirement, verbatim:
 *   "the raw event log with shoe IDs, not merely a shoe summary. Ideally each
 *    round should contain: shoe ID, round number, card sequence, box, main
 *    wager, each side-bet wager/result, every player decision, strategy
 *    grading, dealer cards, settlement and bankroll after the round."
 *
 * Emitted at ONE ROW PER BOX PER ROUND, which is the grain that lets a
 * spreadsheet pivot mistakes against side-bet outcomes shoe by shoe.
 */

/** RFC4180 quoting: quote when needed, double any embedded quote. */
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const COLUMNS = [
  'session_id', 'session_started', 'app_version', 'strategy_version', 'rules_profile',
  'mode', 'shoe_no', 'shoe_round', 'shoe_end',
  'round_no', 'round_ts', 'cards_remaining_after',
  'dealer_cards', 'dealer_total', 'dealer_natural', 'dealer_drew',
  'box', 'hand_index', 'box_row', 'round_row',
  'hand_cards', 'hand_total', 'hand_soft', 'hand_bust',
  'hand_is_split', 'hand_bet', 'hand_result', 'hand_net',
  'main_wager', 'main_net',
  'pairs_stake', 'pairs_result', 'pairs_net',
  'trilux_stake', 'trilux_result', 'trilux_net',
  'super_stake', 'super_result', 'super_net',
  'side_net', 'box_total_net',
  'decisions', 'decisions_correct', 'decisions_incorrect',
  'round_net', 'bankroll_before', 'bankroll_after',
];

/** Flattens one stored session into export rows. */
export function rowsForSession(session) {
  let rounds = [];
  try {
    rounds = session.round_log_json ? JSON.parse(session.round_log_json) : [];
  } catch { rounds = []; }

  const rows = [];
  for (const r of rounds) {
    // Box- and round-level values are written on their FIRST row only. Every
    // later hand row leaves them empty, so a naive SUM() over a column is
    // correct without the reader knowing anything about splits. See the
    // box_row / round_row markers.
    let roundRowPending = true;
    for (const box of r.boxes || []) {
      const w = box.wager || {};
      const side = box.side || {};
      const decs = box.decisions || [];
      // Decisions are recorded per box, not per hand — the engine's decision
      // event carries no hand index. After a split they cannot be attributed to
      // a specific hand, so they are reported at box level on every hand row.
      const decText = decs.map((d) =>
        `${(d.hand || []).join(' ')} vs ${d.dealerFirst}: ${d.chosen}` +
        (d.correct ? ' [ok]' : ` [should ${d.recommended}]`)).join(' | ');

      (box.hands || []).forEach((h, hi) => {
        const isBoxRow = hi === 0;
        const isRoundRow = roundRowPending;
        roundRowPending = false;
        // Blank on repeat rows rather than repeat: summing was the failure mode.
        const perBox = (v) => (isBoxRow ? v : null);
        const perRound = (v) => (isRoundRow ? v : null);
        rows.push({
          session_id: session.id,
          session_started: session.started_at,
          app_version: session.app_version,
          // NULL strategy_version means the session predates HIP-ENHC-S17-v1 and
          // may contain false Soft 18/19 mistakes — exclude it from grading analysis.
          strategy_version: session.strategy_version || 'LEGACY-v1.4.1',
          rules_profile: session.rules_profile,
          mode: r.mode || session.mode,
          shoe_no: r.shoeNumber,
          shoe_round: r.shoeRound,
          // 'reshuffle' means this round was the last played from that shoe.
          // Empty means the shoe was still open — either play continued past the
          // end of this export, or the session simply stopped here. Only shoes
          // whose last round says 'reshuffle' were played to the cut card.
          shoe_end: r.shoeEnd || '',
          round_no: r.round,
          round_ts: r.ts ? new Date(r.ts).toISOString() : '',
          cards_remaining_after: r.cardsRemaining,
          dealer_cards: (r.dealer || []).join(' '),
          dealer_total: r.dealerTotal,
          dealer_natural: r.dealerBlackjack ? 1 : 0,
          dealer_drew: r.dealerDrew ? 1 : 0,
          box: box.number,
          hand_index: hi + 1,
          box_row: isBoxRow ? 1 : 0,
          round_row: isRoundRow ? 1 : 0,
          hand_cards: (h.cards || []).join(' '),
          hand_total: h.total,
          hand_soft: h.soft ? 1 : 0,
          hand_bust: h.bust ? 1 : 0,
          hand_is_split: h.isSplit ? 1 : 0,
          hand_bet: h.bet,
          hand_result: h.result,
          hand_net: h.net,
          // --- box level: one row per box carries these (box_row = 1) ---------
          main_wager: perBox(w.main),
          main_net: perBox(box.mainNet),
          pairs_stake: perBox(w.pairs),
          pairs_result: perBox(side.pairs && side.pairs.name),
          pairs_net: perBox(side.pairs && side.pairs.net),
          trilux_stake: perBox(w.trilux),
          trilux_result: perBox(side.trilux && side.trilux.name),
          trilux_net: perBox(side.trilux && side.trilux.net),
          super_stake: perBox(w.super),
          super_result: perBox(side.super && side.super.name),
          super_net: perBox(side.super && side.super.net),
          side_net: perBox(box.sideNet),
          box_total_net: perBox(box.totalNet),
          // The decision list is recorded per box and carries no hand index, so
          // it too belongs to the box, not the hand. Repeating it once per split
          // hand inflated the mistake count for anyone who parsed this column.
          decisions: perBox(decText),
          decisions_correct: perBox(decs.filter((d) => d.correct).length),
          decisions_incorrect: perBox(decs.filter((d) => !d.correct).length),
          // --- round level: one row per round carries these (round_row = 1) ---
          round_net: perRound(r.net),
          bankroll_before: perRound(r.bankrollBefore),
          bankroll_after: perRound(r.bankrollAfter),
        });
      });
    }
  }
  return rows;
}

export function toCSV(rows) {
  const head = COLUMNS.join(',');
  const body = rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','));
  return [head, ...body].join('\r\n');
}

/** Anything a consumer must know before trusting the numbers. */
export function caveatsFor(sessions) {
  const out = [];

  // Always first: the grain. Getting this wrong double-counted every split
  // round's side bets and produced a false analytical result.
  out.push('GRAIN: one row per hand. A box that was split has several rows. '
    + 'Box-level money (main_*, pairs_*, trilux_*, super_*, side_net, '
    + 'box_total_net, decisions*) is written ONLY on the row where box_row = 1, '
    + 'and round-level money (round_net, bankroll_*) ONLY where round_row = 1. '
    + 'Later rows are left empty on purpose, so summing any column is safe. '
    + 'Per-hand values (hand_bet, hand_net, hand_result) are on every row. '
    + 'To count rounds, count round_row = 1; to count boxes, count box_row = 1.');

  const detail = sessions.filter((s) => s.round_log_json);
  const legacy = detail.filter((s) => !s.strategy_version);
  if (legacy.length) {
    out.push(`${legacy.length} of ${detail.length} session(s) with per-round detail predate the `
      + `strategy_version field, so which grading matrix scored them is not recorded. This is a `
      + `provenance gap, NOT known bad data — do not discard these sessions by default. The two `
      + `matrices differ only in specific cells (Soft 18 and Soft 19 doubling, and A,A vs 10). `
      + `If a mistake matters to your conclusion, check it against those cells directly; the `
      + `'decisions' column carries the hand, the dealer up-card, the action taken and the `
      + `action expected, which is enough to re-grade any decision without the version field.`);
  }
  for (const s of sessions) {
    let meta = null;
    try { meta = s.round_log_meta ? JSON.parse(s.round_log_meta) : null; } catch { /* ignore */ }
    if (meta && meta.truncated) {
      out.push(`Session ${s.id}: round log was truncated to the newest ${meta.maxRounds} ` +
        `rounds; earlier rounds are not in this export.`);
    }
    // A gap that truncation does not explain — capture starting late, for
    // instance. Previously invisible: the rounds were simply absent.
    if (meta && meta.firstRound > 1 && !meta.truncated) {
      out.push(`Session ${s.id}: per-round detail starts at round ${meta.firstRound}, so ` +
        `${meta.firstRound - 1} earlier round(s) were played but not captured.`);
    }
    if (s.rounds > 0 && !s.round_log_json) {
      out.push(`Session ${s.id}: ${s.rounds} rounds recorded but no per-round detail ` +
        `(played on a build before round-log capture existed).`);
    }
  }
  return out;
}
