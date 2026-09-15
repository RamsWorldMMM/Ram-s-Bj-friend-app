/* Ram's BJ Friend — SIDE-BET STAKING CHECK
 *
 * Presentation and arithmetic over already-captured play. No rule, wager, card
 * or result is touched.
 *
 * THE QUESTION
 * "Is varying my side-bet stakes actually working?" Answering it needs a
 * comparison, and the comparison is exact rather than simulated: a side bet is
 * settled from the dealt cards alone — before any player decision and without
 * reference to what was staked — so net = stake x mult, and the same cards can
 * be re-staked by multiplying. Nothing is replayed, so nothing can be
 * reshuffled and no outcome can change.
 *
 * ON DEMAND, NOT ON DISPLAY
 * This is a question asked between sessions, not a number watched during play,
 * so it sits behind a button and opens over the page. Nothing on the page moves
 * when it opens, which matters on a phone where a shifted button is a mis-tap.
 *
 * WHERE THE NUMBERS COME FROM
 * Signed in, /api/staking covers every session on every device. Signed out, the
 * same maths runs here against the local round log and the panel says so —
 * signing out narrows the answer rather than removing it.
 *
 * COUPLING: the multiplier table must match sideSettlement() in index.html and
 * SIDE_MULT in src/digest.js. Names are unique within a product, but 'Straight
 * flush' and 'Three of a kind' pay differently in Trilux and Super, so the
 * table is keyed by product and never shared between them.
 */
(function () {
  'use strict';

  var MULT = {
    pairs: { 'No pair': 0, 'Perfect pair': 30, 'Colour pair': 10, 'Mixed pair': 5 },
    trilux: { 'No qualifying hand': 0, 'Mini Royal': 100, 'Straight flush': 35,
              'Three of a kind': 30, Straight: 10, Flush: 5 },
    super: { 'No qualifying hand': 0, 'Suited trips': 270, 'Straight flush': 180,
             'Three of a kind': 90 }
  };
  var LABEL = { pairs: 'Pairs', trilux: 'Trilux', super: 'Trilux Super' };
  var ORDER = ['pairs', 'trilux', 'super'];
  var TRIALS = 800;
  var MIN_BETS = 60;

  function money(n) {
    return (n < 0 ? '−£' : '£')
      + Math.round(Math.abs(n)).toLocaleString('en-GB');
  }
  function signed(n) {
    return (n > 0 ? '+£' : n < 0 ? '−£' : '£')
      + Math.round(Math.abs(n)).toLocaleString('en-GB');
  }
  function pctTxt(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%';
  }
  /* "deeper by £0" is not a sentence anyone means. */
  function dropTxt(delta) {
    if (Math.round(delta) === 0) return 'worst drop the same as flat';
    return 'worst drop ' + (delta > 0 ? 'deeper by ' : 'shallower by ') + money(Math.abs(delta));
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------------------------------------------------------- local maths --
   * Only used signed out. Emits the same shape as /api/staking so one renderer
   * serves both and the two can never drift into different-looking answers. */

  function localBets() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem('bjfRoundLog') || 'null'); } catch (e) { return []; }
    var rounds = (raw && (Array.isArray(raw) ? raw : raw.rounds)) || [];
    var out = [];
    rounds.slice().sort(function (a, b) { return (a.round || 0) - (b.round || 0); })
      .forEach(function (r) {
        (r.boxes || []).forEach(function (box) {
          var side = box.side || {};
          ORDER.forEach(function (p) {
            var b = side[p];
            if (!b || !b.name || b.name === 'Not played') return;
            var m = typeof b.mult === 'number' ? b.mult : MULT[p][b.name];
            if (m === undefined) return;
            var net = Number(b.net) || 0;
            var stake = (typeof b.stake === 'number' && b.stake > 0)
              ? b.stake : (m === 0 ? -net : net / m);
            if (!(stake > 0)) return;
            out.push({ p: p, stake: stake, mult: m, box: box.number });
          });
        });
      });
    return out;
  }

  function run(list, stakeOf) {
    var cum = 0, peak = 0, dd = 0;
    for (var i = 0; i < list.length; i++) {
      var x = stakeOf(list[i].stake);
      cum += list[i].mult ? x * list[i].mult : -x;
      if (cum > peak) peak = cum;
      if (peak - cum > dd) dd = peak - cum;
    }
    return { pl: cum, max_drawdown: dd };
  }

  /* Fixed seed: a p-value that wanders between openings invites a reroll until
     it reads well. */
  function luckP(list) {
    var stakes = [], mults = [], actual = 0, i;
    for (i = 0; i < list.length; i++) {
      stakes.push(list[i].stake); mults.push(list[i].mult);
      actual += list[i].mult ? list[i].stake * list[i].mult : -list[i].stake;
    }
    var seed = 0x9e3779b9;
    function rnd() {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    var sims = new Float64Array(TRIALS), sh = mults.slice(), j, tmp, sum, mean = 0;
    for (var t = 0; t < TRIALS; t++) {
      for (i = sh.length - 1; i > 0; i--) {
        j = Math.floor(rnd() * (i + 1)); tmp = sh[i]; sh[i] = sh[j]; sh[j] = tmp;
      }
      sum = 0;
      for (i = 0; i < stakes.length; i++) sum += sh[i] ? stakes[i] * sh[i] : -stakes[i];
      sims[t] = sum; mean += sum;
    }
    mean /= TRIALS;
    var extreme = 0;
    for (t = 0; t < TRIALS; t++) if (Math.abs(sims[t] - mean) >= Math.abs(actual - mean)) extreme++;
    return extreme / TRIALS;
  }

  function localDigest() {
    var all = localBets();
    if (!all.length) return null;
    var staked = 0, i;
    for (i = 0; i < all.length; i++) staked += all[i].stake;
    var avg = staked / all.length;
    var a = run(all, function (s) { return s; });
    var f = run(all, function () { return avg; });
    var products = ORDER.map(function (p) {
      var mine = all.filter(function (b) { return b.p === p; });
      if (!mine.length) return null;
      var st = 0, k;
      for (k = 0; k < mine.length; k++) st += mine[k].stake;
      var pa = run(mine, function (s) { return s; });
      var pf = run(mine, function () { return st / mine.length; });
      var byBox = {}, dirs = { raised: [], held: [], lowered: [] }, up = [], down = [];
      mine.forEach(function (b) { (byBox[b.box] = byBox[b.box] || []).push(b); });
      Object.keys(byBox).forEach(function (kk) {
        var list = byBox[kk];
        for (var n = 1; n < list.length; n++) {
          var d = list[n].stake - list[n - 1].stake;
          if (d > 0) { dirs.raised.push(list[n]); up.push(d); }
          else if (d < 0) { dirs.lowered.push(list[n]); down.push(-d); }
          else dirs.held.push(list[n]);
        }
      });
      var roiOf = function (l) {
        if (!l.length) return null;
        var s2 = 0, n2 = 0;
        l.forEach(function (b) { s2 += b.stake; n2 += b.mult ? b.stake * b.mult : -b.stake; });
        return { bets: l.length, staked: s2, net: n2, roi_pct: s2 ? Math.round(n2 / s2 * 1000) / 10 : null };
      };
      var mean = function (arr) {
        return arr.length ? Math.round(arr.reduce(function (x, y) { return x + y; }, 0) / arr.length * 100) / 100 : 0;
      };
      var wins = mine.filter(function (b) { return b.mult; });
      var amts = wins.map(function (b) { return b.stake * b.mult; }).sort(function (x, y) { return y - x; });
      var gross = amts.reduce(function (x, y) { return x + y; }, 0);
      var stakesOnly = mine.map(function (b) { return b.stake; });
      return {
        product: LABEL[p], bets_placed: mine.length, total_staked: st, net_pl: pa.pl,
        roi_pct: st ? Math.round(pa.pl / st * 1000) / 10 : null,
        max_drawdown: pa.max_drawdown,
        wager: { average: Math.round(st / mine.length * 100) / 100,
                 min: Math.min.apply(null, stakesOnly), max: Math.max.apply(null, stakesOnly) },
        stake_changes: { raised: up.length, lowered: down.length, held: dirs.held.length,
                         average_rise: mean(up), average_fall: mean(down) },
        after_a_stake_change: { raised: roiOf(dirs.raised), held: roiOf(dirs.held), lowered: roiOf(dirs.lowered) },
        counterfactual: { varying_gained_pl: pa.pl - pf.pl,
                          varying_added_drawdown: pa.max_drawdown - pf.max_drawdown },
        luck_test: { p: mine.length >= MIN_BETS ? luckP(mine) : null },
        concentration: { winning_bets: wins.length,
          biggest_win_share_pct: gross > 0 ? Math.round((amts[0] || 0) / gross * 1000) / 10 : null,
          top_5_share_pct: gross > 0 ? Math.round(amts.slice(0, 5).reduce(function (x, y) { return x + y; }, 0) / gross * 1000) / 10 : null }
      };
    }).filter(Boolean);
    return {
      combined: {
        bets_placed: all.length, total_staked: staked, average_stake: avg,
        varying_stakes: a, flat_at_same_average: f,
        flat_5: run(all, function () { return 5; }),
        flat_10: run(all, function () { return 10; }),
        flat_25: run(all, function () { return 25; }),
        varying_gained_pl: a.pl - f.pl,
        varying_added_drawdown: a.max_drawdown - f.max_drawdown
      },
      products: products
    };
  }

  /* --------------------------------------------------------------- render -- */

  function styles() {
    if (document.getElementById('bjfStakingCss')) return;
    var st = document.createElement('style');
    st.id = 'bjfStakingCss';
    st.textContent =
      '#bjfStakeOverlay{position:fixed;inset:0;z-index:70;display:flex;align-items:flex-end;'
      + 'justify-content:center;background:rgba(8,20,14,.55);backdrop-filter:blur(3px);'
      + 'opacity:0;transition:opacity .16s ease}'
    + '#bjfStakeOverlay.on{opacity:1}'
    + '#bjfStakeCard{background:var(--panel,#fff);width:100%;max-width:540px;max-height:92vh;'
      + 'border-radius:20px 20px 0 0;display:flex;flex-direction:column;overflow:hidden;'
      + 'box-shadow:0 -10px 40px rgba(8,20,14,.3);transform:translateY(14px);'
      + 'transition:transform .18s ease}'
    + '#bjfStakeOverlay.on #bjfStakeCard{transform:none}'
    + '@media(min-width:600px){#bjfStakeOverlay{align-items:center}'
      + '#bjfStakeCard{border-radius:20px;max-height:88vh}}'
    + '.stk-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 12px;'
      + 'border-bottom:1px solid var(--border);flex:0 0 auto}'
    + '.stk-head h3{margin:0;font-size:1.02rem;line-height:1.3}'
    + '.stk-scope{display:block;font-size:.72rem;color:var(--muted);margin-top:3px;font-weight:600}'
    + '.stk-x{margin-left:auto;flex:0 0 auto;border:1px solid var(--border);background:#fff;'
      + 'border-radius:10px;width:38px;height:38px;font-size:1.1rem;line-height:1;color:var(--muted)}'
    + '.stk-body{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 18px 22px;'
      + 'display:grid;gap:18px}'
    + '.stk-verdict{font-size:1.1rem;font-weight:800;color:var(--text);line-height:1.32}'
    + '.stk-because{font-size:.82rem;color:var(--muted);margin-top:6px;line-height:1.5}'
    + '.stk-tiles{display:grid;grid-template-columns:1fr 1fr;gap:9px}'
    + '.stk-tile{border:1px solid var(--border);border-radius:13px;padding:11px 12px}'
    + '.stk-tile b{display:block;font-size:.68rem;letter-spacing:.05em;text-transform:uppercase;'
      + 'color:var(--muted);font-weight:700;margin-bottom:5px}'
    + '.stk-tile s{display:block;text-decoration:none;font-size:1.22rem;font-weight:800;'
      + 'font-variant-numeric:tabular-nums;line-height:1.1}'
    + '.stk-tile i{display:block;font-style:normal;font-size:.7rem;color:var(--muted);margin-top:4px}'
    + '.stk-sec>h4{margin:0 0 4px;font-size:.92rem}'
    + '.stk-sec>p.lead{margin:0 0 10px;font-size:.78rem;color:var(--muted);line-height:1.5}'
    + '.stk-prod{border-top:1px solid var(--border);padding-top:9px;margin-top:9px}'
    + '.stk-prod:first-of-type{border-top:0;padding-top:0;margin-top:0}'
    + '.stk-prow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}'
    + '.stk-prow strong{font-size:.9rem}'
    + '.stk-delta{margin-left:auto;font-weight:800;font-variant-numeric:tabular-nums;font-size:.92rem}'
    + '.stk-tag{font-size:.64rem;letter-spacing:.05em;text-transform:uppercase;font-weight:700;'
      + 'border:1px solid currentColor;border-radius:999px;padding:2px 7px}'
    + '.stk-meta{font-size:.72rem;color:var(--muted);margin-top:4px;'
      + 'font-variant-numeric:tabular-nums;line-height:1.5}'
    + '.up{color:var(--green,#0B5D3B)}.down{color:var(--danger,#A3282C)}'
    + '.luck{color:var(--muted)}'
    + '.stk-ladder{display:grid;gap:7px}'
    + '.stk-lrow{display:grid;grid-template-columns:78px 1fr 74px;gap:9px;align-items:center;'
      + 'font-size:.76rem;font-variant-numeric:tabular-nums}'
    + '.stk-lbar{height:15px;background:#eef2ef;border-radius:3px;overflow:hidden}'
    + '.stk-lbar i{display:block;height:100%}'
    + '.stk-lval{text-align:right;font-weight:700}'
    + '.stk-note{font-size:.73rem;color:var(--muted);line-height:1.55;'
      + 'border-left:3px solid var(--gold,#C8A24A);padding-left:12px}'
    + '.stk-tbl{width:100%;border-collapse:collapse;font-size:.76rem;'
      + 'font-variant-numeric:tabular-nums}'
    + '.stk-tbl th{text-align:right;font-size:.63rem;letter-spacing:.05em;text-transform:uppercase;'
      + 'color:var(--muted);font-weight:700;padding:0 0 6px}'
    + '.stk-tbl th:first-child,.stk-tbl td:first-child{text-align:left}'
    + '.stk-tbl td{text-align:right;padding:6px 0;border-top:1px solid var(--border)}'
    /* It sat between two solid-green buttons wearing .secondary — white on white
       with a hairline border — and read as disabled rather than as a control.
       Gold is the app's other brand colour (the hairline under the header) and
       is on no other button, so it gets its own identity instead of becoming a
       third green. #2A2206 on #C9A227 is past AA at this size. */
    + '#bjfStakeBtn{width:100%;background:linear-gradient(180deg,#D8B23A 0%,#C9A227 100%);'
      + 'border-color:#A8861C;color:#2A2206;font-weight:800}'
    + '#bjfStakeBtn:hover{background:linear-gradient(180deg,#C9A227 0%,#B8931F 100%)}'
    + '#bjfStakeBtn:disabled{opacity:.62}'
    /* Four full-width buttons and two paragraphs ran to 428px of a phone screen
       before a single figure was visible. Two to a row halves it.
       .section-heading is flex, and index.html's phone rule forces it to a
       column; both are single-class selectors, so this two-class one wins
       wherever it sits in the cascade. */
    + '.section-heading.bjf-actions{display:grid;grid-template-columns:1fr 1fr;'
      + 'gap:9px;align-items:stretch}'
    /* The title and the publish status line are not buttons — they take the
       full width and keep their reading order. */
    + '.section-heading.bjf-actions>div:first-child,'
      + '.section-heading.bjf-actions>p{grid-column:1/-1;margin:0}'
    /* align-self, not just the container's align-items: "Analyse with Gemini"
       wraps to two lines at half width while "Submit to ChatGPT" does not, and
       without this the pair sits 10px out of line with each other. Stretching
       equalises them without shrinking the type to force one line. */
    /* cloud.js gives its own button a 10px top margin for the old stacked
       layout. In a grid cell that margin is inset, so the pair sat 10px out of
       line; the grid's gap owns the spacing here. */
    + '.section-heading.bjf-actions>button{width:100%;min-height:48px;align-self:stretch;'
      /* Something gives this button a 10px top margin that a full scan of the
         cascade does not turn up — no matching rule, no inline style, yet it
         computes. In a grid cell that margin is inset, so the pair sat 10px
         out of line. Scoped to this container only, where the gap owns all
         the spacing and no margin should survive anyway. */
      + 'margin:0 !important;'
      + 'display:flex;align-items:center;justify-content:center;text-align:center;'
      + 'white-space:normal;line-height:1.2;padding:10px 12px}'
    /* Pairing by what the button does: the two that hand the session off for
       review sit together, the two that answer it here sit together. */
    + '.section-heading.bjf-actions>#publishDataBtn{order:1}'
    + '.section-heading.bjf-actions>#shareReportBtn{order:2}'
    + '.section-heading.bjf-actions>#publishNote{order:3}'
    + '.section-heading.bjf-actions>#bjfStakeBtn{order:4}'
    + '.section-heading.bjf-actions>#copyReportBtn{order:5}'
    + '@media(max-width:340px){.section-heading.bjf-actions{grid-template-columns:1fr}}'
    + '@media(prefers-reduced-motion:reduce){#bjfStakeOverlay,#bjfStakeCard{transition:none}}';
    document.head.appendChild(st);
  }

  function ladder(c) {
    var items = [
      ['Flat £5', c.flat_5.pl, false], ['Flat £10', c.flat_10.pl, false],
      ['Flat £25', c.flat_25.pl, false]
    ];
    // Its own rung only when it is not already one of the three above — two rows
    // reading "Flat £5" is a bug on the screen even when the maths is right.
    var avg = Math.round(c.average_stake);
    if (avg !== 5 && avg !== 10 && avg !== 25) {
      items.push(['Your average', c.flat_at_same_average.pl, false]);
    }
    items.push(['What you did', c.varying_stakes.pl, true]);
    var max = Math.max.apply(null, items.map(function (i) { return Math.abs(i[1]); })) || 1;
    return '<div class="stk-ladder">' + items.map(function (i) {
      return '<div class="stk-lrow"><span>' + i[0] + '</span>'
        + '<span class="stk-lbar"><i style="width:' + (Math.abs(i[1]) / max * 100).toFixed(1)
        + '%;background:' + (i[2] ? 'var(--green,#0B5D3B)' : '#b9c4bd') + '"></i></span>'
        + '<span class="stk-lval ' + (i[1] >= 0 ? 'up' : 'down') + '">' + money(i[1]) + '</span></div>';
    }).join('') + '</div>';
  }

  function body(d, scope) {
    var c = d.combined;
    var small = Math.abs(c.varying_gained_pl) < c.total_staked * 0.005;
    var verdict = c.bets_placed < MIN_BETS
      ? 'Too early to say \u2014 only ' + c.bets_placed + ' side '
        + (c.bets_placed === 1 ? 'bet' : 'bets') + ' so far.'
      : (small
          ? 'Moving your stakes up and down made almost no difference.'
          : (c.varying_gained_pl > 0
              ? 'Varying your stakes came out ahead over this run.'
              : 'Varying your stakes came out behind.'));

    var tiles = '<div class="stk-tiles">'
      + '<div class="stk-tile"><b>Profit</b><s class="' + (c.varying_gained_pl >= 0 ? 'up' : 'down') + '">'
      + signed(c.varying_gained_pl) + '</s><i>versus the same cards flat</i></div>'
      + '<div class="stk-tile"><b>Worst drop</b><s class="' + (c.varying_added_drawdown <= 0 ? 'up' : 'down') + '">'
      + signed(c.varying_added_drawdown) + '</s><i>' + (c.varying_added_drawdown > 0 ? 'deeper than flat' : 'shallower than flat') + '</i></div>'
      + '</div>';

    var prods = d.products.map(function (p) {
      var g = p.counterfactual.varying_gained_pl;
      var pv = p.luck_test && typeof p.luck_test.p === 'number' ? p.luck_test.p : null;
      var tag = pv === null ? '<span class="stk-tag luck">too few bets</span>'
        : (pv > 0.05 ? '<span class="stk-tag luck">luck</span>'
                     : '<span class="stk-tag ' + (g > 0 ? 'up' : 'down') + '">real · p ' + pv.toFixed(2) + '</span>');
      var sc = p.stake_changes || {};
      return '<div class="stk-prod"><div class="stk-prow"><strong>' + esc(p.product) + '</strong>'
        + tag + '<span class="stk-delta ' + (g > 0 ? 'up' : 'down') + '">' + signed(g) + '</span></div>'
        + '<div class="stk-meta">' + money(p.total_staked) + ' staked · '
        + pctTxt(p.roi_pct) + ' return · '
        + dropTxt(p.counterfactual.varying_added_drawdown) + '<br>'
        + 'stakes £' + p.wager.min + '–£' + p.wager.max
        + ' · raised ' + (sc.raised || 0) + ', lowered ' + (sc.lowered || 0)
        + ', left alone ' + (sc.held || 0) + '</div></div>';
    }).join('');

    var a = d.products.map(function (p) {
      var s = p.after_a_stake_change || {};
      var cell = function (x) {
        return '<td class="' + (x && x.roi_pct >= 0 ? 'up' : 'down') + '">'
          + (x ? pctTxt(x.roi_pct) : '—') + '</td>';
      };
      return '<tr><td>' + esc(p.product) + '</td>' + cell(s.raised) + cell(s.held) + cell(s.lowered) + '</tr>';
    }).join('');

    /* Only where it is both true and sayable: below ten wins, "its five biggest"
       is not even arithmetically sensible. */
    var thin = d.products.filter(function (p) {
      return p.concentration && p.concentration.winning_bets >= 10
        && p.concentration.top_5_share_pct > 30;
    });
    /* Too few stake changes and this table is three columns of noise. */
    var moves = d.products.reduce(function (a, p) {
      var sc = p.stake_changes || {};
      return a + (sc.raised || 0) + (sc.lowered || 0);
    }, 0);

    return '<div class="stk-body">'
      + '<div><div class="stk-verdict">' + verdict + '</div>'
      + '<div class="stk-because">Measured against the very same cards staked flat at your own '
      + 'average of £' + c.average_stake.toFixed(2) + '. '
      + c.bets_placed.toLocaleString('en-GB') + ' side bets, ' + money(c.total_staked) + ' staked.</div></div>'
      + tiles
      + '<div class="stk-sec"><h4>Each bet on its own</h4>'
      + '<p class="lead">Kept apart, so a win on one cannot hide a loss on another.</p>'
      + prods + '</div>'
      + (moves < 30 ? '' : '<div class="stk-sec"><h4>What happened after you moved a stake</h4>'
      + '<p class="lead">Return on the very next bet, split by what you did to the stake before it.</p>'
      + '<table class="stk-tbl"><thead><tr><th></th><th>Raised</th><th>Left</th><th>Lowered</th></tr></thead>'
      + '<tbody>' + a + '</tbody></table>'
      + '<div class="stk-note" style="margin-top:11px">These gaps look large and mostly are not. '
      + 'Anything marked <em>luck</em> above turns up this big by chance more than one time in twenty, '
      + 'so it is not worth changing how you bet.'
      + (thin.length ? ' ' + esc(thin[0].product) + ' rests on just '
          + plural(thin[0].concentration.winning_bets, 'winning bet') + ', and its five biggest carry '
          + thin[0].concentration.top_5_share_pct + '% of everything it paid — at those odds a single card writes the column.' : '')
      + '</div></div>')
      + '<div class="stk-sec"><h4>What would actually change it</h4>'
      + '<p class="lead">The same cards, every bet at one flat stake.</p>'
      + ladder(c)
      + '<div class="stk-note" style="margin-top:11px">Double the stake and you double the result; '
      + 'halve it and you halve it. Moving up and down around the same average does neither. '
      + 'Side bets are settled the instant the cards land, before you act, which is why the same '
      + 'cards can be re-staked exactly — nothing here is a guess.</div></div>'
      + '<p class="stk-because" style="margin:0">' + esc(scope) + '</p>'
      + '</div>';
  }

  function close() {
    var o = document.getElementById('bjfStakeOverlay');
    if (!o) return;
    o.classList.remove('on');
    document.body.style.overflow = '';
    setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, 180);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function open(inner, title, scope) {
    styles();
    close();
    var o = document.createElement('div');
    o.id = 'bjfStakeOverlay';
    o.innerHTML = '<div id="bjfStakeCard" role="dialog" aria-modal="true" aria-label="Side-bet staking">'
      + '<div class="stk-head"><div><h3>' + esc(title) + '</h3>'
      + (scope ? '<span class="stk-scope">' + esc(scope) + '</span>' : '')
      + '</div><button type="button" class="stk-x" aria-label="Close">✕</button></div>'
      + inner + '</div>';
    document.body.appendChild(o);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { o.classList.add('on'); });
    o.querySelector('.stk-x').addEventListener('click', close);
    o.addEventListener('click', function (e) { if (e.target === o) close(); });
    document.addEventListener('keydown', onKey);
    o.querySelector('.stk-x').focus();
  }

  function show() {
    var btn = document.getElementById('bjfStakeBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Working it out…'; }
    var done = function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Check my side bets'; }
    };

    fetch('/api/staking', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (d) {
        done();
        if (!d || !d.products || !d.products.length) return fallback('No side bets have been recorded yet.');
        open(body(d, 'Covers every session on every device.'), 'Is varying your stakes working?',
          'All your recorded play');
      })
      .catch(function () { done(); fallback(null); });
  }

  /* Signed out, or the Worker unreachable: answer from what is on this device
     and say so, rather than showing nothing. */
  function fallback(msg) {
    var d = null;
    try { d = localDigest(); } catch (e) { d = null; }
    if (!d) {
      open('<div class="stk-body"><div class="stk-verdict">Nothing to check yet.</div>'
        + '<div class="stk-because">' + esc(msg || 'Play some rounds with Pairs, Trilux or '
        + 'Trilux Super staked, then come back and this will tell you whether moving those '
        + 'stakes around is doing anything for you.') + '</div></div>',
        'Is varying your stakes working?', '');
      return;
    }
    open(body(d, 'Signed out, so this covers the play stored on this device only. '
      + 'Sign in to include every session.'),
      'Is varying your stakes working?', 'This device only');
  }

  function mount() {
    if (document.getElementById('bjfStakeBtn')) return;
    var anchor = document.getElementById('shareReportBtn');
    var host = anchor && anchor.parentNode;
    if (!host) return;
    styles();

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'bjfStakeBtn';
    btn.className = 'secondary';
    btn.textContent = 'Check my side bets';
    host.insertBefore(btn, anchor);

    // No caption. The label says what it does and the sheet asks the question
    // in its own title; a third paragraph here only pushed the buttons further
    // down the screen.
    host.classList.add('bjf-actions');
    /* One of these buttons computes a 10px top margin that no rule in the
       document accounts for — a full CSSOM scan finds nothing, there is no
       inline style, and a scoped `margin:0 !important` does not shift it. In a
       grid cell that margin is inset, so the pair sits out of line. Setting it
       on the element ends the argument; the grid's gap owns all spacing here. */
    [].forEach.call(host.children, function (e) {
      if (e.tagName === 'BUTTON') e.style.setProperty('margin', '0', 'important');
    });

    btn.addEventListener('click', show);
  }

  window.BJF_STAKING_OPEN = show;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
