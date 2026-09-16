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

/* ---------------------------------------------------------------- staking ---
 * Answers one question: did varying the side-bet stakes improve P/L or control
 * drawdown, against the same cards played flat?
 *
 * The counterfactual needs no replay engine. A side bet is settled from the
 * dealt cards alone — before any player decision, and without reference to what
 * was staked — so net = stake x mult, and re-staking the same cards is
 * arithmetic rather than simulation. That makes the comparison exact.
 *
 * The permutation test is the part that stops a false finding. Splitting ROI by
 * "after raising" versus "after lowering" produces dramatic-looking gaps out of
 * pure noise, because a 270-to-1 payout lets one card decide a column. Keeping
 * every stake and every outcome but shuffling which met which says how often
 * chance alone produces a gap this size.
 */

/* Must match sideSettlement() in index.html. Names are unique within a product;
 * 'Straight flush' and 'Three of a kind' pay differently in Trilux and Super,
 * which is why the table is keyed by product and never shared. */
const SIDE_MULT = {
  pairs: { 'No pair': 0, 'Perfect pair': 30, 'Colour pair': 10, 'Mixed pair': 5 },
  trilux: { 'No qualifying hand': 0, 'Mini Royal': 100, 'Straight flush': 35,
            'Three of a kind': 30, Straight: 10, Flush: 5 },
  super: { 'No qualifying hand': 0, 'Suited trips': 270, 'Straight flush': 180,
           'Three of a kind': 90 },
};
const SIDE_LABEL = { pairs: 'Pairs', trilux: 'Trilux', super: 'Trilux Super' };

/** Every placed side bet, in play order, as {product, stake, mult, box}.
 *  Rounds captured before stake was stored still resolve: a losing bet gives
 *  stake = -net, and a winning one divides net by the multiplier its name names. */
function sideBets(sessions) {
  const out = [];
  for (const s of sessions) {
    let rounds = [];
    try { rounds = s.round_log_json ? JSON.parse(s.round_log_json) : []; } catch { continue; }
    if (!Array.isArray(rounds)) rounds = rounds.rounds || [];
    rounds.slice().sort((a, b) => (a.round || 0) - (b.round || 0)).forEach((r) => {
      (r.boxes || []).forEach((box) => {
        const side = box.side || {};
        Object.keys(SIDE_MULT).forEach((p) => {
          const b = side[p];
          if (!b || !b.name || b.name === 'Not played') return;
          const mult = typeof b.mult === 'number' ? b.mult : SIDE_MULT[p][b.name];
          if (mult === undefined) return;                 // unrecognised outcome
          const net = Number(b.net) || 0;
          const stake = typeof b.stake === 'number' && b.stake > 0
            ? b.stake
            : (mult === 0 ? -net : net / mult);
          if (!(stake > 0)) return;
          out.push({ p, stake, mult, box: box.number, shoe: r.shoeNumber, round: r.round });
        });
      });
    });
  }
  return out;
}

/** Final P/L and worst peak-to-trough fall, staking each bet by `stakeOf`. */
function runCurve(bets, stakeOf) {
  let cum = 0, peak = 0, dd = 0, low = 0;
  for (const b of bets) {
    const x = stakeOf(b.stake);
    cum += b.mult ? x * b.mult : -x;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
    if (cum < low) low = cum;
  }
  return { pl: round2(cum), max_drawdown: round2(dd), worst_point: round2(low) };
}

/** How often chance alone produces a gap this large. Mulberry32 keeps the
 *  figure reproducible — a p-value that moves every publish invites the reader
 *  to reroll until they like it. */
function permutationP(bets, trials) {
  const stakes = bets.map((b) => b.stake);
  const mults = bets.map((b) => b.mult);
  const actual = bets.reduce((a, b) => a + (b.mult ? b.stake * b.mult : -b.stake), 0);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const sims = new Float64Array(trials);
  const shuffled = mults.slice();
  for (let t = 0; t < trials; t += 1) {
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    let sum = 0;
    for (let i = 0; i < stakes.length; i += 1) {
      sum += shuffled[i] ? stakes[i] * shuffled[i] : -stakes[i];
    }
    sims[t] = sum;
  }
  let mean = 0;
  for (let i = 0; i < trials; i += 1) mean += sims[i];
  mean /= trials;
  let extreme = 0;
  for (let i = 0; i < trials; i += 1) {
    if (Math.abs(sims[i] - mean) >= Math.abs(actual - mean)) extreme += 1;
  }
  return { p: Math.round((extreme / trials) * 1000) / 1000, null_mean: round2(mean), trials };
}

function stakingForProduct(bets, key) {
  const mine = bets.filter((b) => b.p === key);
  if (!mine.length) return null;
  const staked = mine.reduce((a, b) => a + b.stake, 0);
  const avg = staked / mine.length;
  const actual = runCurve(mine, (s) => s);
  const flat = runCurve(mine, () => avg);

  // Stake movement is only meaningful against this player's previous bet on the
  // same box; boxes are staked independently.
  const byBox = new Map();
  mine.forEach((b) => {
    const k = String(b.box);
    if (!byBox.has(k)) byBox.set(k, []);
    byBox.get(k).push(b);
  });
  const dir = { raised: [], held: [], lowered: [] };
  const moves = { up: [], down: [] };
  byBox.forEach((list) => {
    for (let i = 1; i < list.length; i += 1) {
      const d = list[i].stake - list[i - 1].stake;
      if (d > 0) { dir.raised.push(list[i]); moves.up.push(d); }
      else if (d < 0) { dir.lowered.push(list[i]); moves.down.push(-d); }
      else dir.held.push(list[i]);
    }
  });
  const roiOf = (list) => {
    if (!list.length) return null;
    const st = list.reduce((a, b) => a + b.stake, 0);
    const nt = list.reduce((a, b) => a + (b.mult ? b.stake * b.mult : -b.stake), 0);
    return { bets: list.length, staked: round2(st), net: round2(nt), roi_pct: pct(nt, st) };
  };
  const mean = (a) => (a.length ? round2(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const wins = mine.filter((b) => b.mult);
  const winAmounts = wins.map((b) => b.stake * b.mult).sort((a, b) => b - a);
  const grossWon = winAmounts.reduce((a, b) => a + b, 0);

  return {
    product: SIDE_LABEL[key],
    bets_placed: mine.length,
    total_staked: round2(staked),
    total_returned: round2(grossWon + mine.filter((b) => b.mult).reduce((a, b) => a + b.stake, 0)),
    net_pl: actual.pl,
    roi_pct: pct(actual.pl, staked),
    wager: { average: round2(avg), min: round2(Math.min(...mine.map((b) => b.stake))),
             max: round2(Math.max(...mine.map((b) => b.stake))) },
    peak_profit: round2(Math.max(0, ...(() => { let c = 0; return mine.map((b) => { c += b.mult ? b.stake * b.mult : -b.stake; return c; }); })())),
    max_drawdown: actual.max_drawdown,
    stake_changes: {
      raised: moves.up.length, lowered: moves.down.length, held: dir.held.length,
      average_rise: mean(moves.up), average_fall: mean(moves.down),
    },
    after_a_stake_change: {
      raised: roiOf(dir.raised), held: roiOf(dir.held), lowered: roiOf(dir.lowered),
    },
    counterfactual: {
      varying_stakes: actual,
      flat_at_same_average: flat,
      flat_5: runCurve(mine, () => 5),
      flat_10: runCurve(mine, () => 10),
      flat_25: runCurve(mine, () => 25),
      varying_gained_pl: round2(actual.pl - flat.pl),
      varying_added_drawdown: round2(actual.max_drawdown - flat.max_drawdown),
    },
    // Below this a permutation test says nothing useful, and a p-value printed
    // beside three bets reads as authority it has not earned.
    luck_test: mine.length >= 60 ? permutationP(mine, 2000) : { p: null, trials: 0 },
    concentration: {
      winning_bets: wins.length,
      biggest_win_share_pct: grossWon > 0 ? pct(winAmounts[0] || 0, grossWon) : null,
      top_5_share_pct: grossWon > 0 ? pct(winAmounts.slice(0, 5).reduce((a, b) => a + b, 0), grossWon) : null,
    },
  };
}

/** The staking file. Separate per product, so a win in one cannot mask a loss
 *  in another — which is the whole reason the three are never pooled here. */
export function buildStakingDigest(sessions, meta = {}) {
  const bets = sideBets(sessions);
  const products = Object.keys(SIDE_MULT).map((k) => stakingForProduct(bets, k)).filter(Boolean);
  const staked = bets.reduce((a, b) => a + b.stake, 0);
  const avg = bets.length ? staked / bets.length : 0;
  const actual = runCurve(bets, (s) => s);
  const flat = runCurve(bets, () => avg);

  return {
    what_this_is: 'Did varying the Pairs, Trilux and Trilux Super stakes improve '
      + 'profit or reduce drawdown, compared with the same cards played at a flat '
      + 'stake? Money is pounds. Each product is reported separately.',
    generated_at: meta.generatedAt || null,
    read_this_first: [
      'A side bet is settled from the dealt cards alone, before any player '
        + 'decision and without reference to the stake. So the counterfactual is '
        + 'exact arithmetic on the same cards, not a simulation — nothing is '
        + 'reshuffled and no outcome changes.',
      'Compare varying against flat_at_same_average, NOT against flat_5 or '
        + 'flat_10. Those are smaller bets, so they lose less for a reason that '
        + 'has nothing to do with varying. Only the same-average comparison '
        + 'isolates the effect of moving the stake around.',
      'luck_test.p is how often chance alone produces a gap this large. Above '
        + 'about 0.05 the result is indistinguishable from noise, and the ROI '
        + 'split in after_a_stake_change should NOT be reported as a finding '
        + 'however dramatic it looks.',
      'Check concentration before trusting any product. Where a handful of wins '
        + 'carry most of the return, a single 270-to-1 card decides the figures.',
    ],
    combined: {
      bets_placed: bets.length,
      total_staked: round2(staked),
      average_stake: round2(avg),
      varying_stakes: actual,
      flat_at_same_average: flat,
      flat_5: runCurve(bets, () => 5),
      flat_10: runCurve(bets, () => 10),
      flat_25: runCurve(bets, () => 25),
      varying_gained_pl: round2(actual.pl - flat.pl),
      varying_added_drawdown: round2(actual.max_drawdown - flat.max_drawdown),
    },
    products,
  };
}

/* ---------------------------------------------------------------- reports ---
 * The session report Ram has been copying out of the app and pasting into
 * ChatGPT by hand, as JSON, one entry per session.
 *
 * It exists because the other digests do not carry it. summary.json reduces a
 * session to money and accuracy; this keeps the things that only make sense
 * within one session — which hands he was dealt, how he split his actions, how
 * each box did, how long the runs went — and the mistakes written out one by
 * one rather than grouped into patterns.
 *
 * Everything here is read from the stored `state` object, which is the same
 * object the app builds the on-screen report from. So this is the pasted report,
 * not a reconstruction of it.
 */

const MAX_MISTAKES_LISTED = 150;   // a bad session must not swell the file

function reportForSession(s) {
  let st = null;
  try { st = s.state_json ? JSON.parse(s.state_json) : null; } catch { return null; }
  if (!st) return null;

  const mix = st.decisionMix || {};
  const boxes = Object.entries(st.boxStats || {})
    .filter(([, b]) => (b.decisions > 0 || b.mainPL !== 0))
    .map(([box, b]) => ({
      box: Number(box),
      decisions: b.decisions || 0,
      correct: b.correct || 0,
      accuracy_pct: pct(b.correct || 0, b.decisions || 0),
      main_pl: round2(b.mainPL),
    }));

  const mainStaked = Number(st.totalMainStaked) || 0;
  const sideStaked = Number(st.totalSideStaked) || 0;
  const all = Array.isArray(st.mistakes) ? st.mistakes : [];

  return {
    session_id: s.id,
    started_at: s.started_at,
    rounds: Number(st.rounds) || 0,
    decisions: Number(st.decisions) || 0,
    correct: Number(st.correct) || 0,
    mistakes: all.length,
    accuracy_pct: pct(st.correct || 0, st.decisions || 0),

    // What he was actually asked to decide, and what he chose. Two sessions with
    // the same accuracy can be completely different hands.
    decision_mix: {
      hard_hands: mix.hard || 0, soft_hands: mix.soft || 0, pairs: mix.pair || 0,
      hit: mix.hit || 0, stand: mix.stand || 0, double: mix.double || 0, split: mix.split || 0,
    },
    box_performance: boxes,
    streaks: {
      longest_winning_rounds: Number(st.longestWinStreak) || 0,
      longest_losing_rounds: Number(st.longestLossStreak) || 0,
    },
    largest_main_wager: round2(st.largestMainBet),
    bankroll: {
      start: round2(st.start), end: round2(st.bankroll),
      highest: round2(st.high), lowest: round2(st.low),
      range: round2((Number(st.high) || 0) - (Number(st.low) || 0)),
      max_drawdown: round2(st.maxDrawdown),
    },
    side_bet_share_of_stakes_pct: pct(sideStaked, mainStaked + sideStaked),

    mistakes_listed: Math.min(all.length, MAX_MISTAKES_LISTED),
    mistakes_detail: all.slice(0, MAX_MISTAKES_LISTED).map((m) => ({
      round: m.round, box: m.box,
      hand: m.hand, hand_value: m.label,
      dealer_card: m.dealer,
      chose: m.chosen, correct_play: m.correct,
    })),
  };
}

/** One report per session — the thing Ram used to paste, published instead. */
export function buildReportDigest(sessions, meta = {}) {
  const reports = sessions.map(reportForSession).filter(Boolean)
    .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
  const capped = reports.filter((r) => r.mistakes > r.mistakes_listed);

  return {
    what_this_is: 'The per-session report, one entry per session — the detail that '
      + 'only means anything inside a single session. Money is pounds. For totals '
      + 'across every session read summary.json instead; this file deliberately '
      + 'does not aggregate.',
    generated_at: meta.generatedAt || null,
    read_this_first: [
      'decision_mix is what he was dealt and what he chose, not what was correct. '
        + 'Two sessions at the same accuracy can be entirely different hands, and '
        + 'comparing accuracy without it hides that.',
      'mistakes_detail lists each mistake separately, unlike mistakes.json which '
        + 'groups them into repeating patterns. Use this to see a single session, '
        + 'that one to see a habit.',
      'bankroll.range is the high-water mark minus the low-water mark, which is '
        + 'NOT the same as max_drawdown — drawdown is the worst fall from a peak, '
        + 'and is the honest measure of how bad it got.',
      capped.length
        ? `${capped.length} session(s) had more mistakes than the ${MAX_MISTAKES_LISTED} `
          + 'listed here; mistakes is the true count and mistakes_listed is how many '
          + 'appear below.'
        : 'Every mistake is listed in full; none were truncated.',
    ],
    sessions: reports,
  };
}
