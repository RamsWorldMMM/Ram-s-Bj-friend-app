/* Compact, model-readable summaries of stored play.
 *
 * These exist because ChatGPT reads Ram's GitHub repository but will not read a
 * 3.6 MB CSV — it skims it or refuses. Forty-odd KB of well-shaped summary it
 * reads completely and can reason over, so the small files are the better input
 * rather than a compromise.
 *
 * Written for a model, not for a database:
 *   · flat objects, no nesting to unpick
 *   · every figure already computed, so nothing has to be derived
 *   · units and meaning stated in the file itself
 *   · the awkward truths (shoes that were cut short, sessions with no detail)
 *     stated plainly rather than left to be inferred
 */

import { rowsForSession } from './export.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** One record per session: the shape a trend question needs. */
function sessionRows(sessions) {
  return sessions.map((s) => {
    const decisions = Number(s.decisions) || 0;
    const correct = Number(s.correct) || 0;
    const sidePL = round2((Number(s.pairs_pl) || 0) + (Number(s.trilux_pl) || 0)
      + (Number(s.super_pl) || 0));
    return {
      session_id: s.id,
      started_at: s.started_at,
      updated_at: s.updated_at,
      app_version: s.app_version || null,
      rules_profile: s.rules_profile || null,
      rounds: Number(s.rounds) || 0,
      decisions,
      correct,
      mistakes: Number(s.mistakes_count) || 0,
      accuracy_pct: pct(correct, decisions),
      start_bankroll: round2(s.start_bankroll),
      end_bankroll: round2(s.bankroll),
      session_pl: round2((Number(s.bankroll) || 0) - (Number(s.start_bankroll) || 0)),
      main_pl: round2(s.main_pl),
      pairs_pl: round2(s.pairs_pl),
      trilux_pl: round2(s.trilux_pl),
      super_pl: round2(s.super_pl),
      side_pl: sidePL,
      max_drawdown: round2(s.max_drawdown),
      total_main_staked: round2(s.total_main_staked),
      total_side_staked: round2(s.total_side_staked),
      has_round_detail: Boolean(s.round_log_json),
    };
  }).sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
}

/** Lifetime totals, so the commonest questions need no arithmetic at all. */
function lifetime(rows) {
  const sum = (k) => round2(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0));
  const decisions = rows.reduce((a, r) => a + r.decisions, 0);
  const correct = rows.reduce((a, r) => a + r.correct, 0);
  const mainStaked = sum('total_main_staked');
  const sideStaked = sum('total_side_staked');
  return {
    sessions: rows.length,
    rounds: rows.reduce((a, r) => a + r.rounds, 0),
    decisions,
    correct,
    mistakes: rows.reduce((a, r) => a + r.mistakes, 0),
    accuracy_pct: pct(correct, decisions),
    main_pl: sum('main_pl'),
    pairs_pl: sum('pairs_pl'),
    trilux_pl: sum('trilux_pl'),
    super_pl: sum('super_pl'),
    side_pl: sum('side_pl'),
    total_pl: round2(sum('main_pl') + sum('side_pl')),
    total_main_staked: mainStaked,
    total_side_staked: sideStaked,
    main_roi_pct: mainStaked > 0 ? Math.round((sum('main_pl') / mainStaked) * 1000) / 10 : null,
    side_roi_pct: sideStaked > 0 ? Math.round((sum('side_pl') / sideStaked) * 1000) / 10 : null,
    worst_drawdown: rows.reduce((a, r) => Math.max(a, Number(r.max_drawdown) || 0), 0),
  };
}

/* Describe a hand the way basic strategy does, so mistakes group into patterns.
 * Grouping on the literal cards is useless: "4♣ 10♥" and "4♠ 10♦" are the same
 * decision, and every group ends up with a count of one. */
const RANK_VALUE = { A: 11, K: 10, Q: 10, J: 10, 10: 10 };

function describeHand(cardText) {
  const cards = String(cardText).trim().split(/\s+/)
    .map((c) => c.replace(/[^0-9AKQJ]/gi, '').toUpperCase())
    .filter(Boolean);
  if (!cards.length) return null;
  if (cards.length === 2 && cards[0] === cards[1]) {
    return `Pair of ${cards[0] === 'A' ? 'Aces' : cards[0] + 's'}`;
  }
  let total = 0, aces = 0;
  cards.forEach((r) => {
    const v = RANK_VALUE[r] ?? Number(r);
    if (!isFinite(v)) return;
    if (r === 'A') aces += 1;
    total += v;
  });
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return `${aces > 0 ? 'Soft' : 'Hard'} ${total}`;
}

/** Ten-value cards play identically, so they are one column on the chart. */
function describeUpcard(card) {
  const r = String(card).replace(/[^0-9AKQJ]/gi, '').toUpperCase();
  return (r === 'K' || r === 'Q' || r === 'J') ? '10' : r;
}

/** Mistakes grouped by the situation, which is what makes a pattern visible. */
function mistakePatterns(allRows) {
  const byCell = new Map();
  for (const r of allRows) {
    if (!r.decisions || !r.decisions_incorrect) continue;
    // "8♠ 3♦ vs 9♥: Hit [should Double] | ..." — one entry per decision.
    String(r.decisions).split(' | ').forEach((entry) => {
      const m = entry.match(/^(.+?)\s+vs\s+(\S+):\s+(\S+)\s+\[should\s+([^\]]+)\]$/);
      if (!m) return;                         // graded correct, or an unknown shape
      const hand = describeHand(m[1]);
      const up = describeUpcard(m[2]);
      if (!hand) return;
      const key = `${hand}|${up}|${m[3]}|${m[4]}`;
      const hit = byCell.get(key) || {
        hand, dealer_card: up, chose: m[3], correct_play: m[4], times: 0,
      };
      hit.times += 1;
      byCell.set(key, hit);
    });
  }
  return [...byCell.values()]
    .sort((a, b) => b.times - a.times)
    .slice(0, 60);                            // the tail is noise, not a pattern
}

/**
 * One record per shoe. The shoe_end marker is the point of this file: without
 * it a shoe cut short by the player quitting looks identical to one played to
 * the cut card, and treating the two alike has already produced one false
 * analytical result.
 */
function shoeRows(sessions) {
  const out = [];
  for (const s of sessions) {
    let rounds = [];
    try { rounds = s.round_log_json ? JSON.parse(s.round_log_json) : []; } catch { continue; }
    if (!rounds.length) continue;

    const shoes = new Map();
    rounds.forEach((r) => {
      const n = Number(r.shoeNumber) || 1;
      const cur = shoes.get(n) || {
        session_id: s.id, started_at: s.started_at, shoe: n,
        rounds: 0, decisions: 0, mistakes: 0,
        main_net: 0, pairs_net: 0, trilux_net: 0, super_net: 0,
        played_to_cut_card: false, first_round: r.round, last_round: r.round,
        cards_left_at_end: null,
      };
      cur.rounds += 1;
      cur.last_round = r.round;
      cur.cards_left_at_end = r.cardsRemaining ?? cur.cards_left_at_end;
      if (r.shoeEnd === 'reshuffle') cur.played_to_cut_card = true;

      (r.boxes || []).forEach((box) => {
        const side = box.side || {};
        cur.main_net += Number(box.mainNet) || 0;
        cur.pairs_net += Number(side.pairs?.net) || 0;
        cur.trilux_net += Number(side.trilux?.net) || 0;
        cur.super_net += Number(side.super?.net) || 0;
        const decs = box.decisions || [];
        cur.decisions += decs.length;
        cur.mistakes += decs.filter((d) => !d.correct).length;
      });
      shoes.set(n, cur);
    });

    for (const v of shoes.values()) {
      v.main_net = round2(v.main_net);
      v.pairs_net = round2(v.pairs_net);
      v.trilux_net = round2(v.trilux_net);
      v.super_net = round2(v.super_net);
      v.side_net = round2(v.pairs_net + v.trilux_net + v.super_net);
      v.accuracy_pct = pct(v.decisions - v.mistakes, v.decisions);
      out.push(v);
    }
  }
  return out;
}

/** The two files, ready to write. */
export function buildDigests(sessions, meta = {}) {
  const rows = sessionRows(sessions);
  const detail = sessions.filter((s) => s.round_log_json);
  const allRows = detail.flatMap((s) => rowsForSession(s));
  const shoes = shoeRows(sessions);
  const cut = shoes.filter((s) => s.played_to_cut_card).length;

  const summary = {
    what_this_is: 'Every blackjack session recorded by Ram\'s BJ Friend, summarised '
      + 'one row per session. Money is pounds. accuracy_pct is correct decisions as a '
      + 'percentage of decisions graded against basic strategy.',
    generated_at: meta.generatedAt || null,
    app_version: meta.appVersion || null,
    rules: sessions[0]?.rules_profile
      || '6 decks / dealer stands soft 17 / European No Hole Card, full loss on '
         + 'splits and doubles / double on any two / double after split',
    read_this_first: [
      'A top-up of the bankroll is capital, not winnings: session_pl already '
        + 'excludes deposits, so it stays a true profit-and-loss figure.',
      `${rows.filter((r) => !r.has_round_detail).length} of ${rows.length} session(s) `
        + 'have no per-round detail and appear in totals only.',
      'Side bets are decided the moment the cards are dealt, before any player '
        + 'decision, so they cannot be affected by how a hand was played.',
    ],
    lifetime: lifetime(rows),
    sessions: rows,
  };

  const shoeFile = {
    what_this_is: 'One row per shoe. A shoe is the 6-deck pack; it is reshuffled '
      + 'when the cut card is reached, roughly every 22 to 28 rounds.',
    generated_at: meta.generatedAt || null,
    read_this_first: [
      'played_to_cut_card tells you whether the shoe finished. false means the '
        + 'player stopped part-way through it, so that shoe is a fragment and is '
        + 'NOT comparable with a complete one. Mistakes are far denser in '
        + 'fragments, and treating the two alike has already produced one false '
        + 'result.',
      `${cut} of ${shoes.length} shoes here were played to the cut card.`,
      'Money figures are the net for that shoe in pounds.',
    ],
    shoes,
  };

  return {
    summary,
    shoes: shoeFile,
    mistakes: {
      what_this_is: 'Recurring strategy errors, grouped by the exact situation and '
        + 'ordered by how often each happened. hand is the player\'s cards, '
        + 'dealer_card is the up-card, chose is what was played and correct_play is '
        + 'what basic strategy says for these rules.',
      generated_at: meta.generatedAt || null,
      patterns: mistakePatterns(allRows),
    },
  };
}
