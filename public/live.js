/* Ram's BJ Friend — LIVE TABLE COMPANION
 *
 * Practice mode (the simulator) is untouched: the app deals, no hints, graded.
 * Live mode turns the same engine into a companion for a real table — Ram
 * records the cards he is actually dealt and the app runs the identical
 * dealing, action, settlement, grading and reporting path.
 *
 * HOW IT REUSES THE ENGINE WITHOUT EDITING IT
 * `draw()` is the only card source in the whole engine — dealRound(),
 * takeAction() and dealerPlay() all obtain every card through it. So Live mode
 * fills a queue with observed cards and wraps window.draw to serve that queue.
 * Everything downstream (settlement, mistake grading, event log, reporting,
 * D1 sync, AI analysis) then behaves exactly as in Practice mode.
 *
 * `shoe` is kept as the model of REMAINING UNSEEN cards: each observed card is
 * removed from it. That makes cards-remaining, penetration, the cut card and
 * the running count all correct without any special-casing in the engine.
 */
(function () {
  'use strict';

  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUITS = ['♠', '♥', '♦', '♣'];
  var DECKS = 6;
  var SHOE_SIZE = DECKS * 52;

  // Set to true to bring Live mode back. See injectUI() for the details.
  var SHOW_MODE_SWITCH = false;

  var SUIT_PREF_KEY = 'bjfLiveAskSuits';
  var askSuits = (function () {
    try { return localStorage.getItem(SUIT_PREF_KEY) === '1'; } catch (e) { return false; }
  })();

  var live = false;
  var queue = [];          // observed cards waiting to be consumed by draw()
  var pending = null;      // active card-entry request
  var observed = [];       // every card seen this shoe, in order
  var integrity = [];      // data-integrity warnings (impossible cards etc.)

  function el(id) { return document.getElementById(id); }
  function isRed(c) { return c === '♥' || c === '♦'; }

  // ---------------------------------------------------------------- counting

  /** Hi-Lo tag. Presented as an observation only — never as a bet instruction. */
  function hiLo(rank) {
    if (['2', '3', '4', '5', '6'].indexOf(rank) !== -1) return 1;
    if (['10', 'J', 'Q', 'K', 'A'].indexOf(rank) !== -1) return -1;
    return 0;
  }

  function counts() {
    var running = observed.reduce(function (n, c) { return n + hiLo(c.r); }, 0);
    var seen = observed.length;
    var remaining = SHOE_SIZE - seen;
    var decksLeft = remaining / 52;
    return {
      running: running,
      true_: decksLeft >= 0.25 ? running / decksLeft : 0,
      seen: seen,
      remaining: remaining,
      penetration: seen / SHOE_SIZE,
    };
  }

  // ------------------------------------------------------------ card sourcing

  /**
   * Picks a concrete suit for a rank when the suit was not captured, choosing
   * one that is still unseen so the composition model stays consistent.
   */
  function pickSuit(rank) {
    /* global shoe */
    var left = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    for (var j = 0; j < shoe.length; j++) {
      if (shoe[j].r === rank) left[shoe[j].s]++;
    }
    var best = null;
    SUITS.forEach(function (s) {
      if (left[s] > 0 && (best === null || left[s] > left[best])) best = s;
    });
    return best || SUITS[0];
  }

  var unknownSuits = 0;

  /** Removes an observed card from the remaining-shoe model. */
  function consume(card) {
    if (card.suitKnown === false) unknownSuits++;
    var idx = -1;
    for (var i = 0; i < shoe.length; i++) {
      if (shoe[i].r === card.r && shoe[i].s === card.s) { idx = i; break; }
    }
    if (idx === -1) {
      integrity.push('All four ' + card.r + card.s + ' already seen this shoe — '
        + 'check the entry or whether the shoe was reshuffled.');
    } else {
      shoe.splice(idx, 1);
    }
    observed.push(card);
  }

  // ------------------------------------------------------------- card entry UI

  /**
   * Asks Ram for one or more cards, then runs `done()`.
   * specs: [{ label, needSuit }]
   */
  function requestCards(specs, done) {
    pending = { specs: specs, got: [], done: done, rank: null };
    renderPad();
  }

  function renderPad() {
    var pad = el('livePad');
    if (!pending) { pad.classList.add('hidden'); return; }
    pad.classList.remove('hidden');

    var spec = pending.specs[pending.got.length];
    var step = (pending.got.length + 1) + ' of ' + pending.specs.length;
    // Suit is asked for when the side bet needs it, or whenever Ram has turned
    // suit capture on. Otherwise one tap per card.
    var wantSuit = spec.needSuit || askSuits;
    var showSuitRow = wantSuit && pending.rank;

    var html = '<div class="live-pad-head"><strong>' + spec.label + '</strong>' +
      '<span>' + step + '</span></div>';

    if (showSuitRow) {
      html += '<div class="live-pad-sub">Suit for <b>' + pending.rank + '</b>' +
        (spec.needSuit ? ' — required by the side bet' : '') + '</div>';
      html += '<div class="suit-row">' + SUITS.map(function (s) {
        return '<button data-suit="' + s + '" class="' + (isRed(s) ? 'red' : '') + '">' + s + '</button>';
      }).join('') + '</div>';
      if (!spec.needSuit) {
        html += '<button class="secondary small" id="livePadSkipSuit">Skip suit</button>';
      }
    } else {
      html += '<div class="rank-grid">' + RANKS.map(function (r) {
        return '<button data-rank="' + r + '">' + r + '</button>';
      }).join('') + '</div>';
    }

    if (pending.got.length) {
      html += '<div class="live-pad-sofar">Entered: ' +
        pending.got.map(function (c) { return c.r + c.s; }).join('  ') + '</div>';
    }

    html += '<div class="live-pad-actions">' +
      '<button class="secondary small" id="livePadUndo">Undo last</button>' +
      '<button class="secondary small" id="livePadSuitToggle">Suits: ' +
        (askSuits ? 'Ask' : 'Auto') + '</button></div>';
    pad.innerHTML = html;

    pad.querySelectorAll('[data-rank]').forEach(function (b) {
      b.addEventListener('click', function () { onRank(b.getAttribute('data-rank')); });
    });
    pad.querySelectorAll('[data-suit]').forEach(function (b) {
      b.addEventListener('click', function () { onSuit(b.getAttribute('data-suit')); });
    });
    el('livePadUndo').addEventListener('click', undoLast);
    el('livePadSuitToggle').addEventListener('click', toggleSuits);
    var skip = el('livePadSkipSuit');
    if (skip) skip.addEventListener('click', function () {
      var r = pending.rank; pending.rank = null;
      commitCard({ r: r, s: pickSuit(r), suitKnown: false });
    });
  }

  function toggleSuits() {
    askSuits = !askSuits;
    try { localStorage.setItem(SUIT_PREF_KEY, askSuits ? '1' : '0'); } catch (e) { /* quota */ }
    renderPad();
  }

  function onRank(rank) {
    var spec = pending.specs[pending.got.length];
    if (spec.needSuit || askSuits) { pending.rank = rank; renderPad(); return; }
    commitCard({ r: rank, s: pickSuit(rank), suitKnown: false });
  }

  function onSuit(suit) {
    var r = pending.rank;
    pending.rank = null;
    commitCard({ r: r, s: suit, suitKnown: true });
  }

  function commitCard(card) {
    pending.got.push(card);
    if (pending.got.length < pending.specs.length) { renderPad(); return; }
    var done = pending.done, cards = pending.got;
    pending = null;
    el('livePad').classList.add('hidden');
    queue = queue.concat(cards);
    done(cards);
  }

  function undoLast() {
    if (!pending) return;
    if (pending.rank) { pending.rank = null; renderPad(); return; }
    if (pending.got.length) pending.got.pop();
    renderPad();
  }

  // ------------------------------------------------------------- engine hooks

  function installHooks() {
    // 1. Card source. Every engine card comes through here.
    var originalDraw = window.draw;
    window.draw = function () {
      if (!live) return originalDraw.apply(this, arguments);
      if (!queue.length) throw new Error('Live mode: no observed card queued.');
      var card = queue.shift();
      consume(card);
      return card;
    };

    // 2. Deal: collect the dealer up-card and two cards per box first.
    var originalDeal = window.dealRound;
    window.dealRound = function () {
      if (!live) return originalDeal.apply(this, arguments);
      if (queue.length) return originalDeal.apply(this, arguments);
      if (state.phase !== 'ready' || state.shoeEnded) return;
      if (typeof validateWagers === 'function' && !validateWagers()) return;

      var bets = readWagers();
      var specs = [{ label: "Dealer's up-card", needSuit: anySideBet(bets) }];
      bets.forEach(function (b, i) {
        var suit = b.pairs > 0 || b.trilux > 0 || b.super > 0;
        specs.push({ label: 'Box ' + (i + 1) + ' — first card', needSuit: suit });
        specs.push({ label: 'Box ' + (i + 1) + ' — second card', needSuit: suit });
      });
      requestCards(specs, function () { originalDeal.call(window); });
    };

    // 3. Player actions that consume cards.
    var originalTake = window.takeAction;
    window.takeAction = function (action) {
      if (!live) return originalTake.apply(this, arguments);
      // Ignore actions while a card is being entered — the hand list may already
      // be exhausted, and acting here would index past the end of state.boxes.
      if (pending) return;
      var need = action === 'H' || action === 'D' ? 1 : action === 'P' ? 2 : 0;
      if (!need || queue.length >= need) return originalTake.apply(this, arguments);
      var label = action === 'P' ? 'Split — card for hand ' : 'Your next card';
      var specs = [];
      for (var i = 0; i < need; i++) {
        specs.push({ label: action === 'P' ? label + (i + 1) : label, needSuit: false });
      }
      requestCards(specs, function () { originalTake.call(window, action); });
    };

    // 4. Dealer completion. The engine's stopping rule is mirrored here so the
    //    right number of cards is collected before it runs.
    var originalDealerPlay = window.dealerPlay;
    window.dealerPlay = function () {
      if (!live) return originalDealerPlay.apply(this, arguments);
      var needed = dealerCardsNeeded();
      if (!needed) return originalDealerPlay.apply(this, arguments);
      // Leave the player phase first so the action buttons disable while Ram
      // enters the dealer's cards. The engine sets this again on entry.
      state.phase = 'dealer';
      if (typeof window.renderTable === 'function') window.renderTable();
      collectDealerCards(function () { originalDealerPlay.call(window); });
    };

    // 5. Always-on recommendation (Live mode only).
    var originalRender = window.renderTable;
    window.renderTable = function () {
      var r = originalRender.apply(this, arguments);
      if (live) showRecommendation();
      renderCountBar();
      return r;
    };

    // 6. A new shoe resets the composition model.
    var originalMakeShoe = window.makeShoe;
    window.makeShoe = function () {
      var r = originalMakeShoe.apply(this, arguments);
      observed = []; queue = []; integrity = []; unknownSuits = 0;
      renderCountBar();
      return r;
    };

    // 7. Three buttons were bound to the ORIGINAL function references
    //    (`addEventListener('click', dealRound)`), so reassigning window.*
    //    does not reach them. Re-bind them to call through window at click
    //    time. The action buttons already do this — they use
    //    `() => takeAction(...)`, which resolves by name on each click.
    rebind('dealBtn', function () { window.dealRound(); });
    rebind('shuffleBtn', function () { window.makeShoe(); });
    rebind('shoeBannerShuffle', function () { window.makeShoe(); });
  }

  /** Replaces a node to drop its original listener, then binds a fresh one. */
  function rebind(id, handler) {
    var btn = el(id);
    if (!btn) return;
    var fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', handler);
  }

  function anySideBet(bets) {
    return bets.some(function (b) { return b.pairs > 0 || b.trilux > 0 || b.super > 0; });
  }

  /** True when the dealer still needs at least one more card. */
  function dealerCardsNeeded() {
    var anyLive = state.boxes.some(function (box) {
      return box.hands.some(function (h) { return handTotal(h.cards).total <= 21; });
    });
    if (!anyLive) return false;
    if (state.dealer.length < 2) return true;
    if (isBlackjack(state.dealer)) return false;
    return handTotal(state.dealer).total < 17;
  }

  /** Collects dealer cards one at a time until the engine's rule is satisfied. */
  function collectDealerCards(done) {
    var simulated = state.dealer.slice();
    function step() {
      var anyLive = state.boxes.some(function (box) {
        return box.hands.some(function (h) { return handTotal(h.cards).total <= 21; });
      });
      if (!anyLive) return done();
      if (simulated.length >= 2 && isBlackjack(simulated)) return done();
      if (simulated.length >= 2 && handTotal(simulated).total >= 17) return done();

      requestCards([{ label: "Dealer's card " + (simulated.length + 1), needSuit: false }],
        function (cards) { simulated.push(cards[0]); step(); });
    }
    step();
  }

  // ----------------------------------------------------------------- displays

  function showRecommendation() {
    if (state.phase !== 'player') return;
    var box = state.boxes[state.activeBox];
    if (!box) return;
    var hand = box.hands[state.activeHand];
    if (!hand || hand.finished) return;
    var fb = el('feedback-' + state.activeBox + '-' + state.activeHand);
    if (!fb) return;
    var action = recommendedAction(hand.cards, state.dealer[0], hand);
    var name = { H: 'Hit', S: 'Stand', D: 'Double', P: 'Split' }[action] || action;
    fb.innerHTML = '<span class="rec">Chart play: <b>' + name + '</b></span>';
    fb.className = 'feedback rec-shown';
  }

  function renderCountBar() {
    var bar = el('liveCountBar');
    if (!bar) return;
    if (!live) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    var c = counts();
    bar.innerHTML =
      '<span><i>Running</i><b>' + (c.running > 0 ? '+' : '') + c.running + '</b></span>' +
      '<span><i>True</i><b>' + (c.true_ > 0 ? '+' : '') + c.true_.toFixed(1) + '</b></span>' +
      '<span><i>Seen</i><b>' + c.seen + '</b></span>' +
      '<span><i>Left</i><b>' + c.remaining + '</b></span>' +
      '<span><i>Pen</i><b>' + Math.round(c.penetration * 100) + '%</b></span>' +
      (integrity.length ? '<span class="warn-dot" title="' + integrity.length +
        ' data warning(s)"><i>⚠</i><b>' + integrity.length + '</b></span>' : '');
  }

  // --------------------------------------------------------------------- mode

  function setMode(next) {
    if (next === live) return;
    if (state.phase !== 'ready') {
      alert('Finish the current round before switching mode.');
      return;
    }
    live = next;
    window.BJF_MODE = live ? 'live' : 'practice';
    document.body.classList.toggle('live-mode', live);

    // A mode change starts a genuinely fresh session. Without this the live
    // session inherits practice rounds, decisions and mistakes, which is
    // exactly the blending the two modes exist to prevent.
    observed = []; queue = []; integrity = []; unknownSuits = 0;
    if (typeof window.resetSession === 'function') {
      window.resetSession();          // clears state + new shoe; cloud.js mints a new session id
    } else if (typeof window.makeShoe === 'function') {
      window.makeShoe();
      if (typeof window.startNewCloudSession === 'function') window.startNewCloudSession();
    }

    updateModeUI();
    renderCountBar();
    if (typeof window.updateUI === 'function') window.updateUI();
  }

  function updateModeUI() {
    var p = el('modePractice'), l = el('modeLive');
    if (!p || !l) return;
    p.className = live ? 'secondary small' : 'primary small';
    l.className = live ? 'primary small' : 'secondary small';
    var note = el('liveNote');
    if (note) note.classList.toggle('hidden', !live);
  }

  // --------------------------------------------------------------------- boot

  function injectUI() {
    var css = ''
      + '.mode-switch{display:flex;gap:6px}'
      + '.mode-switch button{border-radius:999px;padding:5px 12px;font-size:.75rem;border:1px solid var(--border)}'
      + '#liveCountBar{display:flex;gap:0;flex-wrap:wrap;align-items:baseline;font-size:.78rem;'
      + 'background:#0b5d3b;color:#fff;border-radius:12px;padding:8px 12px;margin-bottom:10px}'
      + '#liveCountBar span{display:inline-flex;align-items:baseline;gap:5px}'
      + '#liveCountBar span+span::before{content:"·";margin:0 8px;opacity:.5}'
      + '#liveCountBar i{font-style:normal;opacity:.75;font-size:.72rem}'
      + '#liveCountBar b{font-size:.9rem}'
      + '#liveCountBar .warn-dot b{color:#ffd76e}'
      + '#livePad{position:fixed;left:0;right:0;bottom:0;z-index:60;background:#fff;'
      + 'border-top:1px solid var(--border);box-shadow:0 -8px 30px rgba(0,0,0,.18);'
      + 'padding:12px 12px calc(12px + env(safe-area-inset-bottom))}'
      + '.live-pad-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}'
      + '.live-pad-head span{color:var(--muted);font-size:.75rem}'
      + '.live-pad-sub{color:var(--muted);font-size:.75rem;margin-bottom:7px}'
      + '.rank-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}'
      + '.rank-grid button{min-height:52px;font-size:1.05rem;font-weight:700;'
      + 'border:1px solid var(--border);border-radius:11px;background:#f8faf9}'
      + '.suit-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}'
      + '.suit-row button{min-height:56px;font-size:1.5rem;border:1px solid var(--border);'
      + 'border-radius:11px;background:#fff}'
      + '.suit-row button.red{color:#b21f2d}'
      + '.live-pad-sofar{margin-top:8px;font-size:.78rem;color:var(--muted)}'
      + '.live-pad-actions{display:flex;gap:8px;margin-top:8px}'
      + '.live-pad-actions button{flex:1}'
      + '#livePadSkipSuit{margin-top:8px;width:100%}'
      + '.feedback.rec-shown{background:#e8f1ec;border:1px solid #bcd8ca}'
      + '.feedback .rec b{color:var(--green)}'
      + '#liveNote{background:#fff8da;border:1px solid #e7d17d;border-radius:11px;'
      + 'padding:9px 11px;font-size:.76rem;margin-bottom:10px}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // Mode switch in the compact header.
    // ---------------------------------------------------------------------
    // LIVE MODE IS TEMPORARILY DISABLED.
    // The mode switch is not injected, so the app always runs in Practice.
    // Everything else in this file stays loaded and working — in particular the
    // dealBtn / shuffle re-binds below, which later wrappers depend on.
    // TO RE-ENABLE: delete the `if (SHOW_MODE_SWITCH)` guard (or set the flag
    // to true at the top of this file). Nothing else needs changing.
    // ---------------------------------------------------------------------
    var header = document.querySelector('.app-header');
    if (SHOW_MODE_SWITCH && header) {
      var sw = document.createElement('div');
      sw.className = 'mode-switch';
      sw.style.order = '1';
      sw.innerHTML = '<button id="modePractice" class="primary small">Practice</button>' +
        '<button id="modeLive" class="secondary small">Live</button>';
      header.appendChild(sw);
    }

    // Count bar + guidance note above the betting panel.
    var betting = el('bettingPanel');
    if (betting && betting.parentNode) {
      var bar = document.createElement('div');
      bar.id = 'liveCountBar';
      bar.className = 'hidden';
      betting.parentNode.insertBefore(bar, betting);

      var note = document.createElement('div');
      note.id = 'liveNote';
      note.className = 'hidden';
      note.innerHTML = '<b>Live mode.</b> Record the cards as they are dealt. ' +
        'The chart play is shown on every decision, so these hands are marked ' +
        '<b>assisted</b> and are reported separately from practice accuracy. ' +
        'Count and penetration are observations only — no bet sizing is implied.';
      betting.parentNode.insertBefore(note, betting);
    }

    var pad = document.createElement('div');
    pad.id = 'livePad';
    pad.className = 'hidden';
    document.body.appendChild(pad);

    var mp = el('modePractice'), ml = el('modeLive');
    if (mp) mp.addEventListener('click', function () { setMode(false); });
    if (ml) ml.addEventListener('click', function () { setMode(true); });
  }

  function boot() {
    injectUI();
    installHooks();
    window.BJF_MODE = 'practice';
    // Exposed so the cloud layer can label sessions and the AI can separate them.
    window.BJF_LIVE_STATE = function () {
      return {
        mode: window.BJF_MODE,
        counts: counts(),
        integrity: integrity.slice(),
        suitCapture: askSuits ? 'ask' : 'auto',
        unknownSuits: unknownSuits,
        suitNote: unknownSuits
          ? unknownSuits + ' card(s) were recorded by rank only; their suits were '
            + 'auto-assigned and must not be treated as observed. Suit-dependent '
            + 'side-bet outcomes for those hands are unreliable.'
          : 'All recorded suits were confirmed.',
      };
    };
    updateModeUI();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
