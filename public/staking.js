/* Ram's BJ Friend — SIDE-BET STAKING PANEL
 *
 * Presentation and arithmetic on already-captured data. No rule, wager, card or
 * result is touched.
 *
 * WHAT IT ANSWERS
 * "Is varying my side-bet stakes actually working?" The honest answer needs a
 * comparison, and the comparison is exact rather than simulated: a side bet is
 * settled from the dealt cards alone — before any player decision and without
 * reference to what was staked — so net = stake x mult, and the same cards can
 * be re-staked by multiplying. Nothing is replayed, so nothing can be reshuffled.
 *
 * WHY IN THE BROWSER
 * It has to answer while signed out, so it reads the local round log rather than
 * the server. That also means it is live during play instead of waiting on a sync.
 *
 * COUPLING: the multiplier table below must match sideSettlement() in
 * index.html and SIDE_MULT in src/digest.js. Names are unique within a product,
 * but 'Straight flush' and 'Three of a kind' pay differently in Trilux and
 * Super, so the table is keyed by product and never shared between them.
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
  var TRIALS = 800;            // p to ~0.001; enough to separate 0.04 from 0.2
  var MIN_BETS = 60;           // below this, say so rather than pronounce

  var lastKey = null, lastHtml = null;

  function money(n) {
    var v = Math.round(Math.abs(n));
    return (n < 0 ? '−£' : '£') + v.toLocaleString('en-GB');
  }
  function signed(n) {
    return (n > 0 ? '+£' : n < 0 ? '−£' : '£')
      + Math.round(Math.abs(n)).toLocaleString('en-GB');
  }

  /* Every placed side bet in play order. Rounds captured before stake was
     stored still resolve: a loss gives stake = -net, a win divides by the
     multiplier its outcome name names. */
  function bets() {
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
    return { pl: cum, dd: dd };
  }

  /* How often chance alone gives a gap this big. Fixed seed, so the figure does
     not wander between renders and invite a reroll. */
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

  function analyse(all) {
    var staked = 0, i;
    for (i = 0; i < all.length; i++) staked += all[i].stake;
    var avg = all.length ? staked / all.length : 0;
    var actual = run(all, function (s) { return s; });
    var flat = run(all, function () { return avg; });
    var products = ORDER.map(function (p) {
      var mine = all.filter(function (b) { return b.p === p; });
      if (!mine.length) return null;
      var st = 0;
      for (i = 0; i < mine.length; i++) st += mine[i].stake;
      var a = run(mine, function (s) { return s; });
      var f = run(mine, function () { return st / mine.length; });
      return {
        name: LABEL[p], bets: mine.length, staked: st, pl: a.pl,
        gained: a.pl - f.pl, ddDelta: a.dd - f.dd,
        p: mine.length >= MIN_BETS ? luckP(mine) : null
      };
    }).filter(Boolean);
    return {
      bets: all.length, staked: staked, avg: avg,
      pl: actual.pl, gained: actual.pl - flat.pl, ddDelta: actual.dd - flat.dd,
      flat10: run(all, function () { return 10; }).pl,
      products: products
    };
  }

  function styles() {
    if (document.getElementById('bjfStakingCss')) return;
    var st = document.createElement('style');
    st.id = 'bjfStakingCss';
    st.textContent =
      '#bjfStaking{border:1px solid var(--border);border-radius:13px;padding:13px;margin-top:12px}'
    + '#bjfStaking .stk-q{font-size:.82rem;color:var(--muted);margin:0 0 6px}'
    + '#bjfStaking .stk-a{font-size:1.02rem;font-weight:800;color:var(--text);line-height:1.3}'
    + '#bjfStaking .stk-sub{font-size:.75rem;color:var(--muted);margin-top:4px}'
    + '#bjfStaking .stk-rows{display:grid;gap:6px;margin-top:11px}'
    + '#bjfStaking .stk-row{display:grid;grid-template-columns:1fr auto auto;gap:9px;'
      + 'align-items:baseline;font-size:.8rem;padding-top:6px;border-top:1px solid var(--border)}'
    + '#bjfStaking .stk-name{font-weight:700;color:var(--text)}'
    + '#bjfStaking .stk-delta{font-variant-numeric:tabular-nums;font-weight:700}'
    + '#bjfStaking .stk-tag{font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;'
      + 'color:var(--muted);white-space:nowrap}'
    + '#bjfStaking .up{color:var(--green,#0B5D3B)}#bjfStaking .down{color:var(--danger,#A3282C)}'
    + '#bjfStaking .stk-foot{font-size:.74rem;color:var(--muted);margin-top:10px;line-height:1.45}';
    document.head.appendChild(st);
  }

  function render() {
    var host = document.getElementById('bjfStaking');
    if (!host) return;
    var all = bets();
    var key = all.length + ':' + (all.length ? Math.round(all[all.length - 1].stake) : 0);
    if (key === lastKey) { host.innerHTML = lastHtml; return; }   // the maths is not free

    var html;
    if (!all.length) {
      html = '<p class="stk-q">Side-bet staking</p>'
        + '<div class="stk-sub">Play some rounds with Pairs, Trilux or Trilux Super '
        + 'staked and this will tell you whether moving those stakes up and down is '
        + 'doing anything for you.</div>';
    } else {
      var d = analyse(all);
      var early = d.bets < MIN_BETS;
      var verdict = early
        ? 'Too early to say — ' + d.bets + ' side bets so far.'
        : (Math.abs(d.gained) < d.staked * 0.005
            ? 'Varying your stakes made almost no difference.'
            : (d.gained > 0 ? 'Varying your stakes is ahead — so far.'
                            : 'Varying your stakes is behind.'));
      html = '<p class="stk-q">Is varying your side-bet stakes working?</p>'
        + '<div class="stk-a">' + verdict + '</div>'
        + '<div class="stk-sub">Against the same cards staked flat at your own average of '
        + '\u00a3' + d.avg.toFixed(2) + ': <strong>' + signed(d.gained) + '</strong> in profit, '
        + '<strong>' + signed(d.ddDelta) + '</strong> on the worst drop. '
        + d.bets.toLocaleString('en-GB') + ' bets, ' + money(d.staked) + ' staked.</div>'
        + '<div class="stk-rows">'
        + d.products.map(function (p) {
            var tag = p.p === null ? 'too few'
              : (p.p > 0.05 ? 'luck' : 'real · p ' + p.p.toFixed(2));
            return '<div class="stk-row"><span class="stk-name">' + p.name + '</span>'
              + '<span class="stk-delta ' + (p.gained > 0 ? 'up' : 'down') + '">'
              + signed(p.gained) + '</span>'
              + '<span class="stk-tag">' + tag + '</span></div>';
          }).join('')
        + '</div>'
        + '<div class="stk-foot">Side bets are settled the moment the cards land, before '
        + 'you act, so the same cards can be re-staked exactly. &ldquo;Luck&rdquo; means a gap '
        + 'this size turns up by chance more than 1 time in 20 &mdash; not something to act on. '
        + 'The same cards at a flat £10 would have returned ' + money(d.flat10) + '.</div>';
    }
    lastKey = key; lastHtml = html; host.innerHTML = html;
  }

  function mount() {
    var diag = document.getElementById('diagnosis');
    if (!diag || document.getElementById('bjfStaking')) return;
    styles();
    var box = document.createElement('div');
    box.id = 'bjfStaking';
    diag.parentNode.insertBefore(box, diag);
    render();

    // refreshAnalysis() runs after every settled round; follow it so the panel
    // is current without polling.
    if (typeof window.refreshAnalysis === 'function') {
      var orig = window.refreshAnalysis;
      window.refreshAnalysis = function () {
        var r = orig.apply(this, arguments);
        try { render(); } catch (e) { /* never break the session report */ }
        return r;
      };
    }
  }

  window.BJF_STAKING_RENDER = render;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
