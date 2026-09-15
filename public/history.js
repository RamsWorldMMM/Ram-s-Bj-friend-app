/* Ram's BJ Friend — ROUND HISTORY (capture + visual replay)
 *
 * Presentation and data capture only. No game logic, rules, calculations or
 * flows are touched.
 *
 * WHY CAPTURE IS NEEDED
 * The engine's own eventLog records each `decision` with the hand as it stood
 * BEFORE the action, so the final hand after the last hit is never stored.
 * settleRound() calls saveSession() as its last step, and at that instant
 * state.dealer / state.boxes still hold the finished hands and their results.
 * Wrapping saveSession therefore yields a complete, accurate round snapshot
 * without altering a single line of the engine.
 */
(function () {
  'use strict';

  var LOG_KEY = 'bjfRoundLog';
  // A 506-round session measures ~65KB of JSON (16KB per 12 rounds observed), so
  // 2000 is comfortably inside localStorage and the sync payload. At 400 the
  // first ~106 rounds of a long session were silently and permanently destroyed,
  // because src/repo.js overwrites round_log_json wholesale on every sync.
  var MAX_ROUNDS = 2000;
  var roundLogTruncated = false;

  /* ------------------------------- SHOE INDEX -------------------------------
   * state.shoeNumber is assigned once in createInitialState() and never
   * incremented — makeShoe() does not touch it — so every round in every session
   * was stamped shoe 1. That silently invalidates any shoe-by-shoe analysis.
   *
   * Deriving it here instead of fixing the engine, for two reasons: the standing
   * rule is to wrap the game from outside, and wrapping window.makeShoe would not
   * work anyway — index.html binds the ORIGINAL function reference into the two
   * shuffle click handlers before any deferred script loads, so a later wrapper
   * is never called.
   *
   * shoe.length falls monotonically while a shoe is in play and jumps back up
   * toward 312 when makeShoe() rebuilds it. A rise therefore marks a new shoe.
   * Known limit: a reshuffle with no round dealt on the old shoe is invisible —
   * acceptable, since a shoe with no rounds has no rounds to attribute.
   * ------------------------------------------------------------------------ */
  var shoeIndex = 1;
  var lastCardsRemaining = null;
  var shoeRoundNo = 0;          // this round's position within its shoe, 1-based
  var shoeJustStarted = false;  // this round is the first dealt from a new shoe
  var lastCountedRound = null;  // makes the derivation idempotent per round

  function currentShoeIndex(cardsRemaining, roundNo) {
    // captureRound may snapshot the same round twice; only count it once, or the
    // within-shoe position drifts.
    if (roundNo !== null && roundNo === lastCountedRound) {
      shoeJustStarted = false;
      return shoeIndex;
    }
    lastCountedRound = roundNo;
    shoeJustStarted = false;
    if (typeof cardsRemaining !== 'number') { shoeRoundNo++; return shoeIndex; }
    if (lastCardsRemaining !== null && cardsRemaining > lastCardsRemaining) {
      shoeIndex++;
      shoeRoundNo = 0;
      shoeJustStarted = true;
    }
    lastCardsRemaining = cardsRemaining;
    shoeRoundNo++;
    return shoeIndex;
  }

  /** Continues shoe tracking from the last stored round, for resume. */
  function restoreShoeTracking(last) {
    if (!last) { resetShoeTracking(); return; }
    shoeIndex = typeof last.shoeNumber === 'number' ? last.shoeNumber : 1;
    lastCardsRemaining = typeof last.cardsRemaining === 'number' ? last.cardsRemaining : null;
    shoeRoundNo = typeof last.shoeRound === 'number' ? last.shoeRound : 0;
    lastCountedRound = typeof last.round === 'number' ? last.round : null;
    shoeJustStarted = false;
  }

  function resetShoeTracking() {
    shoeIndex = 1;
    lastCardsRemaining = null;
    shoeRoundNo = 0;
    shoeJustStarted = false;
    lastCountedRound = null;
    roundLogTruncated = false;
  }

  var VISIBLE_DEFAULT = 2;       // newest 2 rounds; the rest behind "View more"
  var expanded = false;

  var roundLog = [];
  var currentSessionId = null;

  function el(id) { return document.getElementById(id); }

  function money(n) {
    var v = Number(n) || 0;
    return (v < 0 ? '-' : '') + '£' + Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------- card chips

  var RED = ['♥', '♦'];

  /** Splits "10♦" into rank + suit. Card names are always rank followed by suit. */
  function parseCard(name) {
    var s = String(name || '');
    var suit = s.slice(-1);
    return { rank: s.slice(0, -1), suit: suit, red: RED.indexOf(suit) !== -1 };
  }

  /**
   * Renders the app's own playing card, so history shows exactly the same card
   * face as the table — corner rank+suit, centre pip, real red/black ink.
   * cardHTML() is the engine's read-only renderer; calling it changes nothing.
   */
  function chip(name) {
    var c = parseCard(name);
    if (!c.rank) return '';
    if (typeof window.cardHTML === 'function') {
      return window.cardHTML({ r: c.rank, s: c.suit });
    }
    // Fallback only if the engine renderer is unavailable.
    return '<div class="playing-card ' + (c.red ? 'red' : '') + '">' +
      '<div class="corner top">' + esc(c.rank) + '<br>' + esc(c.suit) + '</div>' +
      '<div class="center">' + esc(c.suit) + '</div>' +
      '<div class="corner bottom">' + esc(c.rank) + '<br>' + esc(c.suit) + '</div></div>';
  }

  function chips(names, extraClass) {
    return '<span class="hcards' + (extraClass ? ' ' + extraClass : '') + '">' +
      (names || []).map(function (n) { return chip(n); }).join('') +
      '</span>';
  }

  // ------------------------------------------------------------ round capture

  /** Builds a full snapshot of the round that has just settled. */
  function snapshotRound() {
    /* global state */
    if (!state || state.phase !== 'complete' || !state.boxes.length) return null;

    var cardsRemaining = (typeof shoe !== 'undefined' && shoe) ? shoe.length : null;
    var dealerNames = state.dealer.map(function (c) { return c.r + c.s; });
    var dt = handTotal(state.dealer);
    var decisions = (state.eventLog || []).filter(function (e) {
      return e.type === 'decision' && e.round === state.rounds;
    });

    return {
      round: state.rounds,
      // Derived (see SHOE INDEX above). engineShoeNumber is kept so a consumer
      // can see that the engine's own field is a constant.
      shoeNumber: currentShoeIndex(cardsRemaining, state.rounds),
      engineShoeNumber: state.shoeNumber,
      // Position within the shoe, and when this round settled. The timestamp is
      // the only temporal field the app records; without it, questions about
      // pace of play are not answerable at all.
      shoeRound: shoeRoundNo,
      ts: Date.now(),
      mode: window.BJF_MODE || 'practice',
      dealer: dealerNames,
      dealerTotal: dt.total,
      dealerSoft: dt.soft,
      dealerBlackjack: state.dealer.length === 2 && isBlackjack(state.dealer),
      dealerDrew: state.dealer.length > 1,
      boxes: state.boxes.map(function (box, i) {
        return {
          number: box.number,
          wager: box.wager,
          hands: box.hands.map(function (h, hi) {
            var t = handTotal(h.cards);
            var res = box.results && box.results[hi];
            return {
              cards: h.cards.map(function (c) { return c.r + c.s; }),
              total: t.total,
              soft: t.soft,
              bust: t.total > 21,
              bet: h.bet,
              isSplit: !!h.isSplit,
              result: res ? res.label : null,
              net: res ? res.net : 0,
            };
          }),
          /* stake and mult are what make the staking question answerable.
             sideSettlement() returns {stake, name, mult, returned, net}; only
             name and net were kept, and from net alone a stake is recoverable
             for a losing bet (net = -stake) but not a winning one without
             mapping the name back to its multiplier. Storing both ends that
             guesswork, and costs two numbers per bet. */
          side: {
            pairs: { name: box.side.pairs.name, net: box.side.pairs.net,
                     stake: box.side.pairs.stake, mult: box.side.pairs.mult },
            trilux: { name: box.side.trilux.name, net: box.side.trilux.net,
                      stake: box.side.trilux.stake, mult: box.side.trilux.mult },
            super: { name: box.side.super.name, net: box.side.super.net,
                     stake: box.side.super.stake, mult: box.side.super.mult },
          },
          mainNet: box.mainNet,
          sideNet: box.sideNet,
          totalNet: box.totalNet,
          decisions: decisions.filter(function (d) { return d.box === box.number; })
            .map(function (d) {
              return {
                hand: d.hand, chosen: d.chosen, recommended: d.recommended,
                correct: d.correct, dealerFirst: d.dealerFirst,
              };
            }),
        };
      }),
      bankrollBefore: state.roundStart,
      bankrollAfter: state.bankroll,
      net: state.bankroll - state.roundStart,
      cardsRemaining: cardsRemaining,
    };
  }

  function captureRound() {
    var snap = snapshotRound();
    if (!snap) return;
    // settleRound fires saveSession exactly once per round, but guard anyway.
    if (roundLog.length && roundLog[roundLog.length - 1].round === snap.round) {
      roundLog[roundLog.length - 1] = snap;
    } else {
      // A shoe's end is only knowable once the NEXT one starts, so stamp it
      // backwards. A round with no shoeEnd is either mid-shoe or the last round
      // played — which is exactly the distinction that was missing before, and
      // the reason session-final fragments were mistaken for complete shoes.
      if (shoeJustStarted && roundLog.length) {
        roundLog[roundLog.length - 1].shoeEnd = 'reshuffle';
      }
      roundLog.push(snap);
    }
    if (roundLog.length > MAX_ROUNDS) {
      roundLog = roundLog.slice(-MAX_ROUNDS);
      roundLogTruncated = true;     // never drop rounds silently
    }
    showingStored = false;
    expanded = false;              // a fresh round resets the list to the newest 2
    persist();
    render();
  }

  function persist() {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify({
        sessionId: currentSessionId, rounds: roundLog,
      }));
    } catch (e) { /* quota — the server copy is authoritative */ }
  }

  function restore() {
    try {
      var raw = JSON.parse(localStorage.getItem(LOG_KEY) || 'null');
      if (raw && Array.isArray(raw.rounds)) {
        roundLog = raw.rounds;
        currentSessionId = raw.sessionId || null;
      }
    } catch (e) { roundLog = []; }
  }

  // ------------------------------------------------------------------ render

  function verdictBadge(d) {
    var ok = d.correct;
    return '<span class="hverdict ' + (ok ? 'ok' : 'bad') + '">' +
      (ok ? '✓' : '✗') + ' ' + esc(d.chosen) +
      (ok ? '' : ' <em>→ ' + esc(d.recommended) + '</em>') + '</span>';
  }

  function renderRound(r, index) {
    var netClass = r.net > 0 ? 'up' : r.net < 0 ? 'down' : 'flat';
    var open = index === 0 ? ' open' : '';

    var html = '<details class="hround"' + open + '>';
    html += '<summary class="hround-head">' +
      '<span class="hround-no">#' + r.round + '</span>' +
      '<span class="hround-cards">' +
        '<span class="hlabel">Dealer</span>' + chips(r.dealer) +
        '<b class="htotal">' + (r.dealerTotal > 21 ? 'Bust' : r.dealerTotal) + '</b>' +
      '</span>' +
      '<span class="hround-net ' + netClass + '">' + money(r.net) + '</span>' +
      '</summary>';

    html += '<div class="hround-body">';
    if (r.dealerBlackjack) html += '<div class="hflag">Dealer blackjack</div>';
    if (!r.dealerDrew) html += '<div class="hflag muted-flag">Dealer kept first card only — all hands busted</div>';

    r.boxes.forEach(function (box) {
      html += '<div class="hbox">';
      html += '<div class="hbox-head"><b>Box ' + box.number + '</b>' +
        '<span class="hbox-net ' + (box.totalNet >= 0 ? 'up' : 'down') + '">' +
        money(box.totalNet) + '</span></div>';

      box.hands.forEach(function (h) {
        html += '<div class="hhand">' +
          chips(h.cards) +
          '<span class="htotal">' + (h.bust ? 'Bust' : (h.soft ? 'Soft ' : '') + h.total) + '</span>' +
          '<span class="hresult ' + (h.net > 0 ? 'up' : h.net < 0 ? 'down' : 'flat') + '">' +
            esc(h.result || '') + '</span>' +
          '</div>';
      });

      if (box.decisions.length) {
        html += '<div class="hdecisions">' +
          box.decisions.map(function (d) {
            return '<span class="hdec">' + chips(d.hand, 'tiny') + verdictBadge(d) + '</span>';
          }).join('') + '</div>';
      }

      var sides = ['pairs', 'trilux', 'super'].filter(function (k) {
        return box.wager && box.wager[k === 'super' ? 'super' : k] > 0;
      });
      if (sides.length) {
        html += '<div class="hsides">' + sides.map(function (k) {
          var s = box.side[k];
          var label = k === 'super' ? 'Trilux Super' : k === 'trilux' ? 'Trilux' : 'Pairs';
          return '<span class="hside ' + (s.net > 0 ? 'up' : s.net < 0 ? 'down' : 'flat') + '">' +
            label + ': ' + esc(s.name) + ' ' + money(s.net) + '</span>';
        }).join('') + '</div>';
      }
      html += '</div>';
    });

    html += '<div class="hround-foot">' +
      'Bankroll ' + money(r.bankrollBefore) + ' → <b>' + money(r.bankrollAfter) + '</b>' +
      (r.cardsRemaining != null ? ' · ' + r.cardsRemaining + ' cards left' : '') +
      (r.mode === 'live' ? ' · <span class="hmode">live</span>' : '') +
      '</div>';

    html += '</div></details>';
    return html;
  }

  function render(rounds, heading) {
    var host = el('roundHistoryList');
    if (!host) return;
    var list = rounds || roundLog;
    var title = el('roundHistoryTitle');
    if (title) title.textContent = heading || 'This session';

    if (!list.length) {
      host.className = 'muted';
      host.textContent = 'No rounds recorded yet. Play a round to build the history.';
      return;
    }
    host.className = '';

    // Newest first — the most recent round is what gets reviewed most.
    var ordered = list.slice().reverse();
    var shown = expanded ? ordered : ordered.slice(0, VISIBLE_DEFAULT);
    var hidden = ordered.length - shown.length;

    var html = shown.map(renderRound).join('');
    if (hidden > 0) {
      html += '<button type="button" class="secondary small hist-more" id="roundHistoryMore">'
        + 'View more (' + hidden + ' earlier round' + (hidden === 1 ? '' : 's') + ')</button>';
    } else if (expanded && ordered.length > VISIBLE_DEFAULT) {
      html += '<button type="button" class="secondary small hist-more" id="roundHistoryLess">'
        + 'Show less</button>';
    }
    host.innerHTML = html;

    var more = el('roundHistoryMore');
    if (more) more.addEventListener('click', function () { expanded = true; render(list, heading); });
    var less = el('roundHistoryLess');
    if (less) less.addEventListener('click', function () {
      expanded = false;
      render(list, heading);
      var panel = el('roundHistoryPanel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ------------------------------------------- fall back to a stored session

  var showingStored = false;

  /**
   * A mode switch starts a fresh session, which empties the working log. Rather
   * than showing "no rounds", pull the most recent STORED session for the
   * current mode so the panel still has something useful in it. Read-only —
   * the working log stays empty so new rounds start clean.
   */
  function showLastStoredIfEmpty() {
    if (roundLog.length) { showingStored = false; return; }
    var mode = window.BJF_MODE || 'practice';
    fetch('/api/sessions', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.sessions) return;
        var match = data.sessions.filter(function (s) {
          return (s.mode || 'practice') === mode && s.rounds > 0;
        })[0];
        if (!match) return;
        return fetch('/api/sessions/' + match.id, { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (detail) {
            if (!detail || !detail.session || !detail.session.round_log_json) return;
            if (roundLog.length) return;          // a round landed meanwhile
            var rounds = JSON.parse(detail.session.round_log_json);
            if (!rounds.length) return;
            showingStored = true;
            render(rounds, 'last ' + mode + ' session · ' + fmtStamp(detail.session.updated_at));
          });
      })
      .catch(function () { /* history is optional */ });
  }

  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso.indexOf('T') === -1 ? iso.replace(' ', 'T') + 'Z' : iso);
    return isNaN(d) ? iso : d.toLocaleString('en-GB',
      { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // -------------------------------------------------------------------- boot

  function injectStyles() {
    var css = ''
      // --- real playing cards, scaled for history density
      + '#roundHistoryPanel .hcards,#prevHandStrip .hcards'
      + '{display:inline-flex;gap:4px;flex-wrap:wrap;align-items:center}'
      // Card DIMENSIONS live in theme.css (single owner — see "6 · ONE CARD
      // SIZE FOR EVERY REVIEW SURFACE"). Only layout is set here.
      + '#roundHistoryPanel .playing-card,#prevHandStrip .playing-card'
      + '{padding:3px}'
      + '#roundHistoryPanel .playing-card .corner.top,#prevHandStrip .playing-card .corner.top'
      + '{top:3px;left:4px}'
      + '#roundHistoryPanel .playing-card .corner.bottom,#prevHandStrip .playing-card .corner.bottom'
      + '{right:4px;bottom:3px}'
      // --- round block
      + '.hround{border:1px solid var(--border);border-radius:13px;background:#fff;'
      + 'margin-top:8px;overflow:hidden}'
      + '.hround[open]{border-color:var(--border-strong);box-shadow:var(--shadow-sm)}'
      + '.hround-head{list-style:none;cursor:pointer;display:grid;'
      + 'grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 12px}'
      + '.hround-head::-webkit-details-marker{display:none}'
      + '.hround-head:hover{background:var(--panel-sunk)}'
      + '.hround-no{font-weight:800;font-size:.78rem;color:var(--muted);min-width:34px}'
      + '.hround-cards{display:inline-flex;gap:6px;align-items:center;min-width:0;flex-wrap:wrap}'
      + '.hlabel{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}'
      + '.htotal{font-size:.76rem;font-weight:700;color:var(--muted)}'
      + '.hround-net{font-weight:800;font-variant-numeric:tabular-nums}'
      + '.up{color:#0E6B44}.down{color:var(--danger)}.flat{color:var(--muted)}'
      + '.hround-body{padding:0 12px 12px;border-top:1px dashed var(--border)}'
      + '.hflag{margin-top:9px;font-size:.75rem;font-weight:700;color:#7A5E06;'
      + 'background:var(--gold-soft);border:1px solid #E7D9A6;border-radius:8px;padding:6px 9px}'
      + '.hflag.muted-flag{color:var(--muted);background:var(--panel-sunk);border-color:var(--border);font-weight:600}'
      // --- per box
      + '.hbox{margin-top:10px;border:1px solid var(--border);border-radius:11px;padding:9px 10px;'
      + 'background:var(--panel-sunk)}'
      + '.hbox-head{display:flex;justify-content:space-between;align-items:center;font-size:.82rem}'
      + '.hbox-net{font-weight:800;font-variant-numeric:tabular-nums}'
      + '.hhand{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:7px}'
      + '.hresult{font-size:.72rem;font-weight:700}'
      + '.hdecisions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;'
      + 'padding-top:8px;border-top:1px dashed var(--border)}'
      + '.hdec{display:inline-flex;gap:5px;align-items:center;background:#fff;'
      + 'border:1px solid var(--border);border-radius:9px;padding:4px 7px}'
      + '.hverdict{font-size:.7rem;font-weight:700}'
      + '.hverdict.ok{color:#0E6B44}.hverdict.bad{color:var(--danger)}'
      + '.hverdict em{font-style:normal;opacity:.85}'
      + '.hsides{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}'
      + '.hside{font-size:.68rem;font-weight:600;background:#fff;border:1px solid var(--border);'
      + 'border-radius:999px;padding:3px 8px}'
      + '.hround-foot{margin-top:10px;font-size:.72rem;color:var(--muted)}'
      + '.hmode{background:var(--green);color:#fff;border-radius:999px;padding:1px 7px;font-weight:700}'
      // --- previous hand while betting (§9)
      + '#prevHandStrip{margin-bottom:12px}'
      + '.prev-hand{border:1px solid var(--border);border-radius:12px;background:var(--panel-sunk);overflow:hidden}'
      + '.prev-hand[open]{background:#fff;border-color:var(--border-strong)}'
      + '.prev-head{list-style:none;cursor:pointer;display:flex;align-items:center;gap:9px;'
      + 'padding:8px 11px;flex-wrap:wrap}'
      + '.prev-head::-webkit-details-marker{display:none}'
      + '.prev-head:hover{background:#fff}'
      + '.prev-mini{display:inline-flex;gap:5px;align-items:center;min-width:0}'
      + '.prev-warn{background:var(--danger-soft);color:var(--danger);border-radius:999px;'
      + 'padding:1px 8px;font-size:.7rem;font-weight:700}'
      + '.prev-body{padding:0 11px 11px;border-top:1px dashed var(--border)}'
      + '.prev-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}'
      + '.prev-mistakes{margin-top:9px;font-size:.75rem;color:var(--danger);'
      + 'background:var(--danger-soft);border-radius:9px;padding:7px 9px;display:grid;gap:3px}'
      // --- legend
      + '.hist-more{width:100%;margin-top:10px}'
      + '.hlegend{display:flex;gap:14px;align-items:center;font-size:.72rem;color:var(--muted);margin-top:4px}'
      + '.hlegend span{display:inline-flex;gap:5px;align-items:center}'
      + '.legend-red{color:#C0202F;font-weight:700}.legend-black{color:#16221C;font-weight:700}'
      + '@media(max-width:850px){.hround-head{grid-template-columns:auto 1fr auto;gap:7px}}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  function injectUI() {
    // §9 host: lives inside the betting panel so the finished hand is visible
    // while the next round's wagers are set.
    var betting = el('bettingPanel');
    if (betting) {
      var strip = document.createElement('div');
      strip.id = 'prevHandStrip';
      strip.className = 'hidden';
      betting.insertBefore(strip, betting.firstChild);
    }

    var anchor = el('historyPanel') || el('aiPanel');
    if (!anchor || !anchor.parentNode) return;

    var sec = document.createElement('section');
    sec.className = 'panel';
    sec.id = 'roundHistoryPanel';
    sec.innerHTML =
      '<div class="section-heading">' +
        '<div><h2>Round history</h2>' +
          '<p>Every round, card by card — <span id="roundHistoryTitle">this session</span>.</p>' +
          '<div class="hlegend">' +
            '<span class="legend-red">♥ ♦ red</span>' +
            '<span class="legend-black">♠ ♣ black</span>' +
            '<span class="hverdict ok">✓ correct</span>' +
            '<span class="hverdict bad">✗ mistake</span>' +
          '</div>' +
        '</div>' +
        '<button id="roundHistoryMine" class="secondary small">This session</button>' +
      '</div>' +
      '<div id="roundHistoryList" class="muted" style="margin-top:12px"></div>';

    anchor.parentNode.insertBefore(sec, anchor.nextSibling);
    el('roundHistoryMine').addEventListener('click', function () {
      render();
      showLastStoredIfEmpty();
    });
  }

  function installHooks() {
    // settleRound() ends with saveSession(); at that point the finished hands
    // and their results are still in state. Capture, then defer to the original.
    var originalSave = window.saveSession;
    if (typeof originalSave === 'function') {
      window.saveSession = function () {
        var r = originalSave.apply(this, arguments);
        try { captureRound(); } catch (e) { console.warn('round capture failed', e); }
        return r;
      };
    }
    // A reset or a mode switch starts a new history.
    var originalReset = window.resetSession;
    if (typeof originalReset === 'function') {
      window.resetSession = function () {
        var r = originalReset.apply(this, arguments);
        roundLog = []; resetShoeTracking(); persist(); render(); renderPrevHand();
        showLastStoredIfEmpty();
        return r;
      };
    }

    // Brief §9 — the finished hand stays reviewable while the next round's bets
    // are placed. Rendered purely from the captured snapshot, so reviewing it
    // cannot mutate game state.
    var originalReturn = window.returnToBetting;
    if (typeof originalReturn === 'function') {
      window.returnToBetting = function () {
        var r = originalReturn.apply(this, arguments);
        renderPrevHand();
        return r;
      };
    }
    // It disappears the moment the next round is dealt.
    var originalDeal = window.dealRound;
    if (typeof originalDeal === 'function') {
      window.dealRound = function () {
        var r = originalDeal.apply(this, arguments);
        if (state.phase === 'player') hidePrevHand();
        return r;
      };
    }

    // "Next round" was bound to the ORIGINAL function reference
    // (`addEventListener('click', returnToBetting)`), so reassigning
    // window.returnToBetting never reaches it. Re-bind to resolve at click time.
    var back = el('returnToBettingBtn');
    if (back) {
      var fresh = back.cloneNode(true);
      back.parentNode.replaceChild(fresh, back);
      fresh.addEventListener('click', function () { window.returnToBetting(); });
    }
  }

  // --------------------------------------------- previous hand while betting

  function hidePrevHand() {
    var host = el('prevHandStrip');
    if (host) host.classList.add('hidden');
  }

  /** Compact, collapsed summary of the round just completed. */
  function renderPrevHand() {
    var host = el('prevHandStrip');
    if (!host) return;
    var r = roundLog[roundLog.length - 1];
    if (!r) { host.classList.add('hidden'); return; }

    var netClass = r.net > 0 ? 'up' : r.net < 0 ? 'down' : 'flat';
    var mistakes = [];
    r.boxes.forEach(function (box) {
      box.decisions.forEach(function (d) {
        if (!d.correct) {
          mistakes.push('Box ' + box.number + ': chose ' + d.chosen +
            ', correct play ' + d.recommended);
        }
      });
    });

    var html = '<details class="prev-hand"><summary class="prev-head">' +
      '<span class="hlabel">Previous</span>' +
      '<span class="prev-mini">' + chips(r.dealer, 'tiny') +
        '<b class="htotal">' + (r.dealerTotal > 21 ? 'Bust' : r.dealerTotal) + '</b></span>' +
      '<span class="hround-net ' + netClass + '">' + money(r.net) + '</span>' +
      (mistakes.length ? '<span class="prev-warn">✗ ' + mistakes.length + '</span>' : '') +
      '</summary><div class="prev-body">';

    html += '<div class="prev-line"><span class="hlabel">Dealer</span>' +
      chips(r.dealer) + '<b class="htotal">' +
      (r.dealerTotal > 21 ? 'Bust' : r.dealerTotal) + '</b></div>';

    r.boxes.forEach(function (box) {
      box.hands.forEach(function (h) {
        html += '<div class="prev-line"><span class="hlabel">Box ' + box.number + '</span>' +
          chips(h.cards) +
          '<b class="htotal">' + (h.bust ? 'Bust' : (h.soft ? 'Soft ' : '') + h.total) + '</b>' +
          '<span class="hresult ' + (h.net > 0 ? 'up' : h.net < 0 ? 'down' : 'flat') + '">' +
          esc(h.result || '') + '</span></div>';
      });
    });

    if (mistakes.length) {
      html += '<div class="prev-mistakes">' +
        mistakes.map(function (m) { return '<div>✗ ' + esc(m) + '</div>'; }).join('') +
        '</div>';
    }
    html += '</div></details>';

    host.innerHTML = html;
    host.classList.remove('hidden');
  }

  function boot() {
    restore();
    injectStyles();
    injectUI();
    installHooks();
    render();
    renderPrevHand();
    showLastStoredIfEmpty();

    // Consumed by the cloud layer for sync, and by the session viewer.
    window.BJF_ROUND_LOG = function () { return roundLog; };
    window.BJF_ROUND_LOG_META = function () {
      // firstRound/lastRound make a coverage gap visible. They differ from
      // 1..captured whenever rounds were dropped by the cap, or when capture
      // began part-way through a session (e.g. a build shipped mid-session).
      return { truncated: roundLogTruncated, maxRounds: MAX_ROUNDS,
               shoesSeen: shoeIndex, captured: roundLog.length,
               firstRound: roundLog.length ? roundLog[0].round : null,
               lastRound: roundLog.length ? roundLog[roundLog.length - 1].round : null };
    };
    window.BJF_SET_ROUND_LOG = function (rounds, heading) {
      render(Array.isArray(rounds) ? rounds : [], heading);
    };
    // Adopts a log pulled from the server (cross-device restore) as the
    // working history for this session.
    window.BJF_LOAD_ROUND_LOG = function (rounds, sessionId) {
      roundLog = Array.isArray(rounds) ? rounds.slice(-MAX_ROUNDS) : [];
      // Resume has to continue the shoe count, not restart it. Without this a
      // session picked up on another device stamps its next round as shoe 1
      // while the stored log is already on shoe 5, and the within-shoe position
      // restarts mid-shoe.
      restoreShoeTracking(roundLog[roundLog.length - 1]);
      if (sessionId) currentSessionId = sessionId;
      persist();
      render();
    };
    window.BJF_RESET_ROUND_LOG = function (sessionId) {
      roundLog = []; resetShoeTracking();
      currentSessionId = sessionId || null; persist(); render();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
