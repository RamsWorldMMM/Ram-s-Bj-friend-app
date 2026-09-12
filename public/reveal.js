/* Ram's BJ Friend — CARD REVEAL PAUSE
 *
 * Pacing only. No rule, calculation, card, wager or result is changed — the
 * same actions happen in the same order, just with a beat inserted so the card
 * you drew is actually seen.
 *
 * THE PROBLEM
 * takeAction() draws the card, renders, then immediately calls
 * advanceAfterAction(). When the action FINISHES the hand — Double always, and
 * Hit when it makes 21 or busts — focus jumps to the next hand or the round
 * settles outright. On a phone only the active box is rendered
 * (`.play-box.active-mobile-box`), so the card that was just dealt vanishes
 * before it can be read.
 *
 * THE FIX
 * When an action both drew a card AND ended the hand, hold the board for a
 * moment with the card visible, then advance exactly as before.
 */
(function () {
  'use strict';

  var REVEAL_MS = 1100;      // long enough to read a card, short enough to keep pace
  var pausing = false;
  var beforeCtx = null;

  function disableActions() {
    document.querySelectorAll('.action-grid button').forEach(function (b) {
      b.disabled = true;
    });
  }

  var revealAnimated = false;   // the lift plays once per reveal, not per render

  /** Marks the newly dealt card so the eye lands on it during the pause. */
  function flagLastCard() {
    var box = document.querySelector('.play-box.active-box') ||
              document.querySelector('.play-box');
    if (!box) return;
    var hand = box.querySelector('.hand-card.active-hand') || box;
    var cards = hand.querySelectorAll('.playing-card');
    if (!cards.length) return;
    var card = cards[cards.length - 1];
    card.classList.add('just-dealt');
    // The ring is idempotent; the motion is not. Replaying it on a re-render
    // made the card bounce twice, 317ms apart.
    if (!revealAnimated) {
      card.classList.add('just-dealt-in');
      revealAnimated = true;
    }
  }

  /**
   * True when the dealer's up-card could still complete a natural. Under ENHC
   * the dealer's second card is not dealt until player decisions are done, so
   * a player natural is NOT yet confirmed as a 3:2 win — it may push.
   */
  function dealerMayHaveNatural() {
    if (typeof state === 'undefined' || !state.dealer || !state.dealer.length) return false;
    var r = state.dealer[0].r;
    return r === 'A' || r === '10' || r === 'J' || r === 'Q' || r === 'K';
  }

  /** A natural: two cards totalling 21, not the product of a split. */
  function isNatural(hand) {
    return hand && !hand.isSplit && hand.cards.length === 2 &&
      typeof isBlackjack === 'function' && isBlackjack(hand.cards);
  }

  /**
   * Labels every natural on the table. The engine's own hand-meta only ever
   * says "Soft 21 · Complete", so without this a blackjack is indistinguishable
   * from an ordinary 21 until settlement.
   */
  function badgeNaturals() {
    if (typeof state === 'undefined' || !state.boxes) return;
    var boxes = document.querySelectorAll('#boxDisplay .play-box');
    state.boxes.forEach(function (box, bi) {
      var section = boxes[bi];
      if (!section) return;
      var handEls = section.querySelectorAll('.hand-card');
      box.hands.forEach(function (hand, hi) {
        var elh = handEls[hi];
        if (!elh || !isNatural(hand)) return;
        elh.classList.add('is-blackjack');
        if (elh.querySelector('.bj-badge')) return;
        var meta = elh.querySelector('.hand-meta');
        if (meta) {
          var pending = dealerMayHaveNatural();
          var b = document.createElement('span');
          b.className = 'bj-badge' + (pending ? ' pending' : '');
          b.textContent = pending
            ? 'BLACKJACK · awaiting dealer check'
            : 'BLACKJACK · pays 3:2';
          meta.parentNode.insertBefore(b, meta);
        }
      });
    });
  }

  /**
   * Announces naturals the moment the round is dealt. Focus skips a blackjack
   * (it is already finished) and on a phone only the active box is rendered, so
   * without this the player is never told until settlement.
   */
  /* ------------------------------------------------------------- LAYOUT DOCK
   * Anything that appears ABOVE the action buttons shoves them mid-decision.
   * Ram hit this in play: a strip appears, the buttons drop ~80px, the strip
   * auto-hides 2.6s later and they snap back. A tap already travelling toward
   * Hit lands on Double, which doubles the wager and ends the hand.
   *
   * Measured on a 360px phone, identical hand, only the strip toggled:
   *   strip hidden -> Hit top 487, Double top 544
   *   strip shown  -> Hit top 567, Double top 624      (80px, 1.6 buttons)
   *
   * So nothing transient is allowed above the table any more. Everything that
   * used to sit on top now lives in one dock BELOW the table and directly
   * above the Session analysis panel, where it cannot move a live button.
   */
  function belowTableDock() {
    var dock = document.getElementById('bjfDock');
    if (dock) return dock;
    var main = document.querySelector('main');
    if (!main) return null;
    dock = document.createElement('div');
    dock.id = 'bjfDock';
    // Anchor on the Session analysis panel: it is the first thing after the
    // table that the player reads, so the dock sits between the two.
    var report = document.getElementById('analysisReport');
    var anchorSection = report && report.closest ? report.closest('section') : null;
    if (anchorSection && anchorSection.parentNode === main) main.insertBefore(dock, anchorSection);
    else main.appendChild(dock);
    return dock;
  }

  /** Moves the banners that are authored at the top of <main> into the dock. */
  function relocateTopBanners() {
    var dock = belowTableDock();
    if (!dock) return;
    ['shoeBanner', 'cloudRestoreBanner'].forEach(function (id) {
      var node = document.getElementById(id);
      if (node && node.parentNode !== dock) dock.appendChild(node);
    });
  }

  /* --------------------------------------------------------- SEQUENCE NOTE
   * Ram's ask: when the three cards make a sequence, or a pair, say so in
   * plain words — including when it did NOT pay, and why. "You got the
   * sequence but the suits were different" is the case he cares about.
   *
   * Read-only. Every value here comes from the engine's own classifiers
   * (classifyThree / pairOutcome); nothing is recomputed or judged here.
   */
  function threeCardNote(x) {
    if (x.miniRoyal)     return { label: 'Mini Royal',       why: 'Q, K, A all in one suit' };
    if (x.suitedTrips)   return { label: 'Suited trips',     why: 'three of a kind, one suit' };
    if (x.straightFlush) return { label: 'Straight flush',   why: 'sequence and all one suit' };
    if (x.trips)         return { label: 'Three of a kind',  why: 'same rank, mixed suits' };
    if (x.straight)      return { label: 'Sequence',         why: 'in order, but different suits' };
    if (x.flush)         return { label: 'Same suit',        why: 'all one suit, not in order' };
    return null;
  }

  /* Ram: say whether the side bets hit, at the moment they are decided.
   *
   * These are settled inside dealRound — the stake is taken and any winnings
   * are credited before a single button is pressed — so the bankroll in the
   * header has ALREADY moved by the time this renders. Saying nothing left him
   * reverse-engineering a balance change. "Settled at deal" in the heading
   * keeps it from reading like a second, separate payout at settlement.
   *
   * Only bets that were actually staked appear. sideSettlement() reports an
   * unplayed bet as stake 0, which is silence, not a loss.
   */
  var SIDE_BETS = [
    { key: 'pairs',  name: 'Pairs' },
    { key: 'trilux', name: 'Trilux' },
    { key: 'super',  name: 'Trilux Super' },
  ];

  function sideBetLines(box) {
    var side = box.side || {};
    var fmt = (typeof money === 'function')
      ? money
      : function (n) { return (n < 0 ? '-' : '') + '£' + Math.abs(n); };
    var out = [], lost = [], lostNet = 0;
    SIDE_BETS.forEach(function (bet) {
      var r = side[bet.key];
      if (!r || !r.stake) return;            // not played — say nothing
      if (r.mult > 0) {
        // A win gets its own line: which bet, what it made, what it paid.
        out.push('<div class="seq-bet won">'
          + '<span class="seq-bet-name">' + bet.name + '</span>'
          + '<span class="seq-bet-result">' + (r.name || 'Win') + '</span>'
          + '<span class="seq-bet-net">+' + fmt(r.net) + '</span></div>');
      } else {
        lost.push(bet.name);
        lostNet += r.net;
      }
    });
    // Losers collapse into one line. Three separate "No qualifying hand" rows
    // per box, every round, buries the one line that actually matters.
    if (lost.length) {
      out.push('<div class="seq-bet">'
        + '<span class="seq-bet-name">' + (lost.length === SIDE_BETS.length && !out.length
            ? 'Side bets' : lost.join(', ')) + '</span>'
        + '<span class="seq-bet-result">no win</span>'
        + '<span class="seq-bet-net">' + fmt(lostNet) + '</span></div>');
    }
    return out;
  }

  /* Which side bets this box actually staked AND won. Used by the badge that
   * marks the winning box. A top-of-screen banner used to use this too; it was
   * removed — an alert over the table is exactly where Ram does not want it. */
  function sideBetWins(box) {
    var side = box.side || {}, out = [];
    SIDE_BETS.forEach(function (bet) {
      var r = side[bet.key];
      if (r && r.stake && r.mult > 0) {
        out.push({ name: bet.name, result: r.name, net: r.net, mult: r.mult, box: box.number });
      }
    });
    return out;
  }

  /* --------------------------------------------------- SIDE-BET WIN BADGE
   * A win shows in the white space beside the box name, and clears after three
   * seconds. Nothing announces itself over the table any more.
   *
   * Wins are gathered from EVERY box, not just the one on screen. On a phone
   * only the active box is displayed, so a win on Box 1 while Box 2 is being
   * played would otherwise be invisible — which is exactly what happened to
   * Ram. Each chip carries its box number when more than one box is in play.
   *
   * LAYOUT SAFETY: the header sits directly above the action buttons, so it
   * reserves the chip's height permanently. The badge appearing AND vanishing
   * three seconds later both leave Hit, Stand, Double and Split untouched.
   */
  var BADGE_MS = 6000;   // Ram asked for longer — three seconds was too quick to register
  var badgeRound = null;
  var badgeExpired = false;

  function clearWinStrips() {
    Array.prototype.forEach.call(
      document.querySelectorAll('#boxDisplay .won-strip'),
      function (el) { el.remove(); });
  }

  function badgeSideBetWins() {
    if (typeof state === 'undefined' || !state.boxes) return;

    // renderTable runs many times a round, so the three-second dismissal has to
    // be remembered per round or the next render puts the badge straight back.
    if (badgeRound !== state.rounds) {
      badgeRound = state.rounds;
      badgeExpired = false;
      clearTimeout(badgeSideBetWins._t);
      badgeSideBetWins._t = setTimeout(function () {
        badgeExpired = true;
        clearWinStrips();
      }, BADGE_MS);
    }
    clearWinStrips();
    if (badgeExpired) return;

    var wins = [];
    state.boxes.forEach(function (box) { wins = wins.concat(sideBetWins(box)); });
    if (!wins.length) return;

    // Whichever box the player is actually looking at.
    var host = document.querySelector('#boxDisplay .active-mobile-box h3')
            || document.querySelector('#boxDisplay .play-box h3');
    if (!host) return;

    var many = state.boxes.length > 1;
    var fmt = (typeof money === 'function') ? money
            : function (n) { return '£' + Math.abs(n); };

    var strip = document.createElement('span');
    strip.className = 'won-strip';
    strip.innerHTML = wins.map(function (w) {
      return '<span class="won-chip' + (w.mult >= 30 ? ' big' : '') + '">'
        + (many ? '<span class="won-box">B' + w.box + '</span>' : '')
        + '<span class="won-bet">' + w.name.toUpperCase() + '</span>'
        + '<span class="won-said">WON</span>'
        + '<span class="won-amt">' + fmt(w.net) + '</span>'
        + '</span>';
    }).join('');
    host.appendChild(strip);
  }

  /* ------------------------------------------------------- WAGER WARNING
   * "Total committed exceeds the available bankroll" renders at the BOTTOM of
   * the betting panel, just above the Deal button. On a phone, with the wager
   * cards scrolled, it is off-screen — so pressing Deal appears to do nothing
   * at all and there is no clue why.
   *
   * Mirror it to the top of the screen where it cannot be missed. Unlike the
   * win banner, which was removed, this one is EARNED: it is blocking, the
   * player asked for it, and the betting screen has no action buttons beneath
   * it to displace. It is fixed, so it shifts nothing, and it clears the moment
   * a wager is touched or a round deals.
   */
  function wagerAlert(msg) {
    var el = document.getElementById('bjfWagerAlert');
    if (!msg) { if (el) el.classList.remove('show'); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'bjfWagerAlert';
      el.setAttribute('role', 'alert');
      el.addEventListener('click', function () { el.classList.remove('show'); });
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="wa-card"><span class="wa-mark">!</span>'
      + '<span class="wa-text"></span></div>';
    el.querySelector('.wa-text').textContent = msg;   // never inject the message as HTML
    el.classList.add('show');
  }

  function mirrorWagerWarning() {
    var w = document.getElementById('warning');
    if (!w) return;
    var live = !w.classList.contains('hidden') && w.textContent.trim();
    wagerAlert(live ? w.textContent.trim() : '');
  }

  function watchWagers() {
    var panel = document.getElementById('bettingPanel');
    if (!panel) return;
    // Any adjustment means he is acting on it — take the warning away.
    ['input', 'change', 'click'].forEach(function (ev) {
      panel.addEventListener(ev, function (e) {
        // Deal itself lives inside this panel. Clicking it must NOT count as
        // acting on the warning — that is the very click that raises it.
        var t = e.target;
        if (t && t.closest && t.closest('#dealBtn')) return;
        wagerAlert('');
      }, true);
    });
  }

  /* ------------------------------------------------------ BETTING HEADER
   * 266px — 31% of a 390x860 phone — went by before the first wager card:
   *
   *   94px  "Round setup", a subtitle, and the shoe pill, stacked
   *   72px  an "Active boxes" label above a full-width select
   *   46px  "Clear bets" alone on its own row
   *
   * The subtitle explains what the screen plainly shows. The label repeats the
   * select's own text ("3 boxes"). And a lone button does not deserve a row.
   *
   * Collapse to two rows: title with the shoe pill beside it, then the box
   * count and Clear bets sharing one line. Moving the nodes rather than
   * restyling siblings keeps the game's own click handlers attached.
   */
  function compactBettingHeader() {
    var panel = document.getElementById('bettingPanel');
    if (!panel || document.getElementById('bjfSetupRow')) return;

    var field = panel.querySelector('.compact-field');
    var acts  = panel.querySelector('.bet-actions');
    if (!field || !acts) return;

    var row = document.createElement('div');
    row.id = 'bjfSetupRow';
    field.parentNode.insertBefore(row, field);
    row.appendChild(field);
    row.appendChild(acts);

    // The select already reads "3 boxes", so the visible label is noise — but
    // it still has to be announced, so it becomes the accessible name.
    var sel = document.getElementById('boxCount');
    var lab = field.querySelector('span');
    if (sel && lab && !sel.getAttribute('aria-label')) {
      sel.setAttribute('aria-label', lab.textContent.trim());
    }
  }

  function renderSequenceNote() {
    var dock = belowTableDock();
    if (!dock || typeof state === 'undefined' || !state.boxes) return;
    var host = document.getElementById('bjfSeq');
    if (!host) {
      host = document.createElement('div');
      host.id = 'bjfSeq';
      dock.appendChild(host);
    }
    if (!state.dealer || !state.dealer.length ||
        typeof classifyThree !== 'function' || typeof pairOutcome !== 'function') {
      host.innerHTML = ''; return;
    }
    var up = state.dealer[0];
    var rows = [];
    state.boxes.forEach(function (box) {
      var hand = box.hands && box.hands[0];
      if (!hand || hand.cards.length < 2) return;
      // The dealt two plus the dealer up-card — the same three the engine scores.
      var two = hand.cards.slice(0, 2);
      var three = [two[0], two[1], up];
      var bits = [];
      var note = threeCardNote(classifyThree(three));
      if (note) {
        bits.push('<span class="seq-cards">' + three.map(function (c) {
          return typeof cardHTML === 'function' ? cardHTML(c) : '';
        }).join('') + '</span>'
          + '<span class="seq-label">' + note.label + '</span>'
          + '<span class="seq-why">' + note.why + '</span>');
      }
      var pair = pairOutcome(two);
      if (pair && pair.mult) {
        bits.push('<span class="seq-label">' + pair.name + '</span>'
          + '<span class="seq-why">your two cards</span>');
      }
      var bets = sideBetLines(box);
      // A staked bet that lost still deserves a line — it is his money.
      if (!bits.length && !bets.length) return;
      rows.push('<div class="seq-row"><span class="seq-box">Box ' + box.number + '</span>'
        + '<div class="seq-main">'
        + (bits.length ? '<div class="seq-made">' + bits.join('<span class="seq-sep">·</span>') + '</div>' : '')
        + (bets.length ? '<div class="seq-bets">' + bets.join('') + '</div>' : '')
        + '</div></div>');
    });
    host.innerHTML = rows.length
      ? '<div class="seq-title">What the cards made'
        + '<span class="seq-when">settled at deal</span></div>' + rows.join('')
      : '';
  }

  function announceNaturals() {
    if (typeof state === 'undefined' || !state.boxes) return;
    var hits = [];
    state.boxes.forEach(function (box) {
      box.hands.forEach(function (hand) {
        if (isNatural(hand)) hits.push({ box: box.number, cards: hand.cards });
      });
    });
    if (!hits.length) return;

    var host = document.getElementById('bjAnnounce');
    if (!host) {
      host = document.createElement('div');
      host.id = 'bjAnnounce';
      // Was table.insertBefore(host, table.firstChild) — i.e. directly above
      // the buttons. That is the 80px shove; it lives in the dock now.
      var dock = belowTableDock();
      if (!dock) return;
      dock.appendChild(host);
    }
    // ENHC: with an Ace or ten-value up-card the dealer may still make a
    // natural, which would push this hand. Do not promise 3:2 until that is
    // resolved (Ram's ENHC dealer-natural brief).
    var pending = dealerMayHaveNatural();
    host.innerHTML = hits.map(function (h) {
      var cards = h.cards.map(function (c) {
        return typeof cardHTML === 'function' ? cardHTML(c) : '';
      }).join('');
      return '<div class="bj-shout' + (pending ? ' pending' : '') + '">' +
        '<span class="bj-box">Box ' + h.box + '</span>' +
        '<span class="bj-cards">' + cards + '</span>' +
        '<span class="bj-word">BLACKJACK</span>' +
        '<span class="bj-pay">' + (pending
          ? 'awaiting dealer check — may push'
          : 'pays 3:2') + '</span></div>';
    }).join('');
    host.classList.remove('hidden');
    host.classList.add('show');

    clearTimeout(host._t);
    host._t = setTimeout(function () { host.classList.remove('show'); }, 2600);
    host.onclick = function () { host.classList.remove('show'); };
  }

  /**
   * (5) Colour each box result by outcome and (7) promote the round's net
   * movement to the hero figure. The engine states outcomes in words only, so a
   * three-box round takes three reads; a colour edge makes it one glance.
   * Decoration applied after render — no figure is recomputed.
   */
  function decorateSettlement() {
    if (typeof state === 'undefined' || !state.boxes) return;

    var results = document.querySelectorAll('#settlements .compact-box-result');

    /* The Main / Pairs / Trilux / Super breakdown is authored inside a
     * <details>, so it starts collapsed and a side-bet win is invisible until
     * you tap the box open. That is the one number Ram is looking for, and he
     * should not have to hunt for it. Open every box, and mark the side bets
     * that actually paid so a win reads at a glance instead of sitting in a
     * row of identical figures. */
    state.boxes.forEach(function (box, i) {
      var elb = results[i];
      if (!elb) return;
      elb.open = true;

      var side = box.side || {};
      var order = ['main', 'pairs', 'trilux', 'super'];
      var cells = elb.querySelectorAll('.compact-breakdown > div');
      Array.prototype.forEach.call(cells, function (cell, n) {
        var key = order[n];
        cell.classList.remove('paid', 'unplayed');
        if (key === 'main' || !side[key]) return;
        var r = side[key];
        if (!r.stake) {
          // Never staked. "£0" is ambiguous — it reads as "I bet and got
          // nothing back" when he did not bet at all. Say so, and keep it
          // readable: an earlier pass faded these to 38% and they vanished.
          cell.classList.add('unplayed');
          Array.prototype.forEach.call(cell.childNodes, function (n) {
            if (n.nodeType === 3 && n.textContent.trim()) n.textContent = 'not played';
          });
        } else if (r.mult > 0) {
          cell.classList.add('paid');                      // it hit — lift it
        }
      });
    });
    state.boxes.forEach(function (box, i) {
      var elb = results[i];
      if (!elb) return;
      elb.classList.remove('res-win', 'res-loss', 'res-push');
      elb.classList.add(box.totalNet > 0 ? 'res-win'
        : box.totalNet < 0 ? 'res-loss' : 'res-push');
    });

    // The per-hand row already states the outcome; the summary label repeats it
    // verbatim whenever a box has a single hand. Hide the duplicate, keep it for
    // splits where it usefully combines both results.
    state.boxes.forEach(function (box, i) {
      var elb = results[i];
      if (!elb) return;
      var label = elb.querySelector('.compact-result-label');
      if (label) label.classList.toggle('dupe', box.hands.length === 1);
    });

    var move = document.querySelector('#roundResultPanel .movement');
    if (move) {
      var net = state.bankroll - state.roundStart;
      move.classList.remove('res-win', 'res-loss', 'res-push');
      move.classList.add(net > 0 ? 'res-win' : net < 0 ? 'res-loss' : 'res-push');
      var label = move.querySelector('span');
      if (label) {
        label.textContent = net > 0 ? 'Round won' : net < 0 ? 'Round lost' : 'Round even';
      }
    }
  }

  /* ======================= FLICKER: RENDER COALESCING =====================
   * renderTable() wipes #boxDisplay and rebuilds every card. It was running
   * 2-3 times per action:
   *   +0ms    takeAction -> renderTable()            (old active hand)
   *   +1ms    moveToNextPlayable -> renderTable()    (new active hand)
   *   +320ms  takeAction's timer -> renderTable()    (byte-identical output)
   * The 1ms pair rebuilt the table twice in one tick; the 320ms one rebuilt it
   * for no reason at all, a third of a second after the tap — which is what
   * reads as a flicker.
   *
   * Fix, without touching the engine:
   *   · collapse all calls made in one tick into a single render, via a
   *     microtask so it still lands before the browser paints;
   *   · skip a render whose output would be identical to what is on screen,
   *     compared by a signature of everything renderTable actually displays.
   * ===================================================================== */

  var renderQueued = false;
  var lastSignature = null;
  var innerRender = null;

  function stateSignature() {
    if (typeof state === 'undefined' || !state) return 'none';
    var parts = [state.phase, state.activeBox, state.activeHand,
      (state.dealer || []).map(function (c) { return c.r + c.s; }).join(',')];
    (state.boxes || []).forEach(function (box) {
      box.hands.forEach(function (h) {
        parts.push(box.number + '/' +
          h.cards.map(function (c) { return c.r + c.s; }).join('') + '/' +
          h.bet + '/' + (h.finished ? 1 : 0) + '/' + (h.splitAces ? 1 : 0));
      });
    });
    return parts.join('|');
  }

  function flushRender() {
    renderQueued = false;
    try {
      var sig = stateSignature();
      if (sig === lastSignature) return;      // nothing visible would change
      lastSignature = sig;
      innerRender.call(window);
    } catch (e) {
      lastSignature = null;                   // never get stuck skipping
      throw e;
    }
  }

  function installCoalescing() {
    innerRender = window.renderTable;
    if (typeof innerRender !== 'function') return;
    window.renderTable = function () {
      if (renderQueued) return;               // one render per tick
      renderQueued = true;
      Promise.resolve().then(flushRender);
    };
    // A reset or a new shoe must always repaint.
    window.BJF_INVALIDATE_RENDER = function () { lastSignature = null; };
    ['resetSession', 'makeShoe', 'returnToBetting'].forEach(function (fn) {
      var original = window[fn];
      if (typeof original !== 'function') return;
      window[fn] = function () {
        lastSignature = null;
        return original.apply(this, arguments);
      };
    });
  }

  function install() {
    var originalTake = window.takeAction;
    var originalAdvance = window.advanceAfterAction;
    var originalRender = window.renderTable;
    if (typeof originalTake !== 'function' || typeof originalAdvance !== 'function') return;

    // Record which hand is being acted on, before the action runs.
    window.takeAction = function (action) {
      if (pausing) return;                      // ignore taps during the reveal
      beforeCtx = null;
      if (state.phase === 'player' && action !== 'P') {
        var box = state.boxes[state.activeBox];
        var hand = box && box.hands[state.activeHand];
        if (hand) {
          beforeCtx = { box: state.activeBox, hand: state.activeHand, n: hand.cards.length };
        }
      }
      return originalTake.apply(this, arguments);
    };

    // Called synchronously by takeAction once the card has been dealt.
    window.advanceAfterAction = function () {
      var reveal = false;
      if (beforeCtx) {
        var box = state.boxes[beforeCtx.box];
        var hand = box && box.hands[beforeCtx.hand];
        // A card arrived AND the hand is now closed — nothing more will be
        // shown for it, so this is the last chance to see that card.
        if (hand && hand.cards.length > beforeCtx.n && hand.finished) reveal = true;
      }
      beforeCtx = null;
      if (!reveal) return originalAdvance.apply(this, arguments);

      pausing = true;
      revealAnimated = false;
      disableActions();
      // Do NOT flag the card here: renders are coalesced into a microtask, so
      // the newly dealt card is not in the DOM yet. The render wrapper flags it
      // (and plays the lift once) as soon as it flushes.
      document.body.classList.add('revealing');

      window.setTimeout(function () {
        pausing = false;
        document.body.classList.remove('revealing');
        originalAdvance.call(window);
      }, REVEAL_MS);
    };

    // takeAction re-renders 320ms later, which would restore the buttons
    // mid-pause. Keep them down until the pause ends.
    if (typeof originalRender === 'function') {
      window.renderTable = function () {
        var r = originalRender.apply(this, arguments);
        if (pausing) { disableActions(); flagLastCard(); }
        badgeNaturals();
        try { badgeSideBetWins(); } catch (e) { /* cosmetic */ }
        return r;
      };
    }

    // Deal-time wager validation writes into #warning at the foot of the panel.
    var originalValidate = window.validateWagers;
    if (typeof originalValidate === 'function') {
      window.validateWagers = function () {
        var ok = originalValidate.apply(this, arguments);
        try { mirrorWagerWarning(); } catch (e) { /* cosmetic */ }
        return ok;
      };
    }
    watchWagers();
    try { compactBettingHeader(); } catch (e) { /* cosmetic */ }

    // Settlement decoration (items 5 and 7).
    var originalSettle = window.renderSettlement;
    if (typeof originalSettle === 'function') {
      window.renderSettlement = function () {
        var r = originalSettle.apply(this, arguments);
        try { decorateSettlement(); } catch (e) { /* cosmetic */ }
        return r;
      };
    }

    // Announce blackjacks as soon as the cards are on the table.
    var originalDeal = window.dealRound;
    if (typeof originalDeal === 'function') {
      window.dealRound = function () {
        // A REJECTED deal returns immediately, leaving the warning it just
        // raised. Only a deal that actually happened should clear it.
        var before = (typeof state !== 'undefined') ? state.rounds : null;
        var r = originalDeal.apply(this, arguments);
        var dealt = (typeof state !== 'undefined') && state.rounds !== before;
        if (!dealt) return r;
        try {
          wagerAlert('');
          announceNaturals(); badgeNaturals(); badgeSideBetWins();
          renderSequenceNote();
        } catch (e) { /* cosmetic */ }
        return r;
      };
    }
  }

  function injectStyles() {
    var css = ''
      + '.playing-card.just-dealt{box-shadow:0 0 0 2px var(--gold),0 4px 14px rgba(0,0,0,.28)}'
      + '.playing-card.just-dealt-in{animation:bjfDeal .28s ease-out}'
      + '@keyframes bjfDeal{from{transform:translateY(-6px) scale(.94);opacity:.4}'
      + 'to{transform:none;opacity:1}}'
      + 'body.revealing .action-grid button{opacity:.3}'
      // blackjack badge on the hand itself
      + '.hand-card.is-blackjack{outline:2px solid var(--gold);outline-offset:1px;'
      + 'background:linear-gradient(180deg,#FFFDF4,#FFF8E3)}'
      + '.bj-badge{display:inline-block;background:linear-gradient(180deg,#D9B23A,#B8901B);'
      + 'color:#fff;font-weight:800;font-size:.66rem;letter-spacing:.06em;'
      + 'border-radius:999px;padding:3px 9px;margin-bottom:2px;align-self:start}'
      // announcement strip at the top of the felt
      + '#bjAnnounce{display:none}'
      + '#bjAnnounce.show{display:grid;gap:7px;margin-bottom:10px;animation:bjPop .3s ease-out}'
      + '.bj-shout{display:flex;align-items:center;gap:9px;flex-wrap:wrap;'
      + 'background:linear-gradient(180deg,#FFF7DC,#F6E7B4);border:2px solid var(--gold);'
      + 'border-radius:14px;padding:9px 12px;box-shadow:0 6px 18px rgba(0,0,0,.22);cursor:pointer}'
      + '.bj-box{font-size:.74rem;font-weight:700;color:#7A5E06;text-transform:uppercase;letter-spacing:.06em}'
      + '.bj-cards{display:inline-flex;gap:4px}'
      + '.bj-cards .playing-card{width:34px;height:48px;flex:0 0 34px;border-radius:5px;padding:2px}'
      + '.bj-cards .playing-card .corner{font-size:8px;line-height:.9}'
      + '.bj-cards .playing-card .corner.top{top:2px;left:3px}'
      + '.bj-cards .playing-card .corner.bottom{right:3px;bottom:2px}'
      + '.bj-cards .playing-card .center{font-size:15px}'
      + '.bj-word{font-weight:900;letter-spacing:.05em;color:#7A5E06;font-size:.95rem}'
      + '.bj-pay{font-size:.7rem;color:#8A6E12;font-weight:700}'
      // pending state: the dealer may still make a natural, so no promise
      + '.bj-shout.pending{background:linear-gradient(180deg,#FFF9E8,#F3E9CE);'
      + 'border-style:dashed}'
      + '.bj-shout.pending .bj-pay{color:#8A6E12;font-weight:600;font-style:italic}'
      + '.bj-badge.pending{background:linear-gradient(180deg,#B9A050,#947B2E)}'
      + '@keyframes bjPop{from{transform:translateY(-6px);opacity:0}to{transform:none;opacity:1}}'
      // the dock: everything that used to sit above the buttons
      + '#bjfDock{display:grid;gap:10px}'
      + '#bjfDock:empty{display:none}'
      + '#bjfDock #shoeBanner{margin:0}'
      + '#bjfDock #bjAnnounce.show{margin-bottom:0}'
      // Ram: say in words what the three cards made, and why it fell short
      + '#bjfSeq:empty{display:none}'
      + '#bjfSeq{background:var(--panel,#fff);border:1px solid var(--border,#E3E6EA);'
      + 'border-radius:12px;padding:9px 11px}'
      + '.seq-title{font-size:.68rem;font-weight:800;letter-spacing:.07em;'
      + 'text-transform:uppercase;color:var(--muted,#6B7280);margin-bottom:6px}'
      + '.seq-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;'
      + 'padding:4px 0;font-size:.78rem}'
      + '.seq-row+.seq-row{border-top:1px solid var(--border,#E3E6EA)}'
      + '.seq-box{font-size:.66rem;font-weight:700;text-transform:uppercase;'
      + 'letter-spacing:.05em;color:var(--muted,#6B7280);min-width:44px}'
      + '.seq-cards{display:inline-flex;gap:3px}'
      + '.seq-cards .playing-card{width:24px;height:34px;flex:0 0 24px;'
      + 'border-radius:4px;padding:1px}'
      + '.seq-cards .playing-card .corner{font-size:6px;line-height:.9}'
      + '.seq-cards .playing-card .corner.top{top:1px;left:2px}'
      + '.seq-cards .playing-card .corner.bottom{right:2px;bottom:1px}'
      + '.seq-cards .playing-card .center{font-size:11px}'
      // settlement breakdown: a bet that paid should not look like one that lost
      + '.compact-breakdown > div.paid{font-weight:800;color:var(--green,#0B5D3B)}'
      + '.compact-breakdown > div.paid span{color:var(--green,#0B5D3B);opacity:.85}'
      + '.compact-breakdown > div.unplayed{color:var(--muted,#6B7280);font-style:italic}'
      + '.compact-breakdown > div.unplayed span{color:var(--muted,#6B7280)}'
      /* The box header reserves the badge's height ALWAYS, present or not, so a
         win appearing can never push the action buttons down. */
      + '.play-box h3{display:flex;align-items:center;gap:9px;min-height:30px;'
      + 'flex-wrap:nowrap;overflow:hidden}'
      + '.won-strip{display:inline-flex;gap:6px;min-width:0;overflow:hidden;'
      + 'flex-wrap:nowrap}'
      + '.won-chip{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;'
      + 'background:linear-gradient(180deg,#12885F,#0B5D3B);color:#fff;'
      + 'border-radius:8px;padding:4px 9px;box-shadow:0 2px 6px rgba(11,93,59,.34);'
      + 'font-size:.74rem;line-height:1}'
      + '.won-chip.big{background:linear-gradient(180deg,#E0B63F,#B8901B);color:#2E2205;'
      + 'box-shadow:0 2px 8px rgba(184,144,27,.4)}'
      + '.won-box{font-weight:800;opacity:.7;font-size:.64rem;letter-spacing:.04em}'
      + '.won-bet{font-weight:800;letter-spacing:.04em}'
      + '.won-said{font-weight:700;opacity:.75;font-size:.66rem;letter-spacing:.08em}'
      + '.won-amt{font-weight:900;font-variant-numeric:tabular-nums;font-size:.86rem}'
      /* "WON" is the whole point — it is what makes the chip read as a win
         rather than a stake. Tighten everything else before dropping it. */
      + '@media(max-width:420px){'
      + '.won-chip{padding:4px 7px;gap:5px;font-size:.68rem}'
      + '.won-amt{font-size:.8rem}'
      + '.play-box h3{gap:7px;font-size:.9rem}'
      + '}'
      + '#bjfWagerAlert{position:fixed;left:50%;top:78px;transform:translate(-50%,-10px);'
      + 'z-index:70;width:min(94vw,440px);opacity:0;pointer-events:none;'
      + 'transition:opacity .16s ease,transform .16s ease}'
      + '#bjfWagerAlert.show{opacity:1;transform:translate(-50%,0);pointer-events:auto;cursor:pointer}'
      + '@media(prefers-reduced-motion:reduce){#bjfWagerAlert{transition:none}}'
      + '.wa-card{display:flex;align-items:flex-start;gap:10px;border-radius:13px;'
      + 'padding:12px 14px;background:linear-gradient(180deg,#FFF3F3,#FBE2E2);'
      + 'border:1px solid #C98B8B;box-shadow:0 12px 34px rgba(0,0,0,.26);color:#7C2222}'
      + '.wa-mark{flex:0 0 21px;width:21px;height:21px;border-radius:50%;background:#9B2C2C;'
      + 'color:#fff;font-weight:900;font-size:.82rem;display:grid;place-items:center;line-height:1}'
      + '.wa-text{font-size:.88rem;font-weight:600;line-height:1.35}'
            /* index.html's phone media query sets flex-direction:column here, which
         is what stacked the title above the pill. Override the direction too,
         not just the alignment. */
      + '#bettingPanel .section-heading{flex-direction:row;align-items:center;'
      + 'gap:10px;flex-wrap:nowrap;justify-content:space-between}'
      + '#bettingPanel .section-heading > div{flex:0 1 auto;min-width:0}'
      + '#bettingPanel .section-heading h2{white-space:nowrap}'
      + '#bettingPanel .shoe-pill{flex:0 1 auto;min-width:0;overflow:hidden;'
      + 'text-overflow:ellipsis;padding:6px 10px;font-size:.76rem}'
      + '#bettingPanel .section-heading p{display:none}'
      + '#bettingPanel .section-heading h2{font-size:1rem}'
      + '#bjfSetupRow{display:flex;align-items:center;gap:9px}'
      + '#bjfSetupRow .compact-field{flex:1 1 auto;min-width:0;max-width:none}'
      + '#bjfSetupRow .compact-field span{display:none}'
      + '#bjfSetupRow .compact-field select{min-height:44px}'
      + '#bjfSetupRow .bet-actions{flex:0 0 auto;margin:0}'
      + '#bjfSetupRow .bet-actions button{min-height:44px;white-space:nowrap}'
            /* ------------------------------------------------- PLAY SCREEN BALANCE
         Measured at 390x860: the box chips took 54px and the dealer's card —
         the single input every decision turns on — was 73px, SMALLER than the
         player's own cards at 79px. The chips are set disabled in renderTable:
         they are status indicators, not controls, so they never needed a 44px
         thumb target.

         Spend that height on the card instead. */
      + '#playBoxTabs.box-tabs{gap:6px}'
      + '#playBoxTabs.box-tabs button{min-height:0;padding:5px 10px;'
      + 'font-size:.78rem;border-radius:999px;cursor:default}'
      /* The dealer's up-card leads the decision, so let it lead the screen. */
      + '#dealerCards .playing-card{width:68px;height:99px;flex-basis:68px;'
      + 'border-radius:11px;box-shadow:0 6px 16px rgba(0,0,0,.34)}'
      + '#dealerCards .playing-card .center{font-size:38px}'
      + '#dealerCards .playing-card .corner{font-size:17px}'
      /* Trim the furniture around it, not the card. */
      + '.dealer-area .table-label{padding:2px 10px;font-size:.66rem}'
      + '#dealerTotal{font-size:.74rem;margin-top:2px}'
      + '#focusContext.focus-context{padding:5px 12px;font-size:.78rem;'
      + 'margin-bottom:7px}'
      + '.feedback{padding:7px 9px;font-size:.75rem}'
      /* Short phones (a 640-tall screen) were 13px from showing the whole hand
         without scrolling. Tighten the padding there only — the dealer's card
         stays the largest thing on the felt. */
      + '@media(max-height:700px){'
      + '#focusContext.focus-context{padding:3px 11px;font-size:.74rem;margin-bottom:5px}'
      + '.dealer-area .table-label{padding:1px 9px}'
      + '#dealerCards .playing-card{width:62px;height:90px;flex-basis:62px}'
      + '#dealerCards .playing-card .center{font-size:34px}'
      + '.feedback{padding:5px 8px;font-size:.73rem}'
      + '.play-box{padding:10px;gap:8px}'
      + '.hand-card{padding:9px;gap:7px}'
      + '.action-grid button{padding:9px}'
      + '}'
      + '.seq-main{display:grid;gap:5px;min-width:0;flex:1}'
      + '.seq-made{display:flex;align-items:center;gap:7px;flex-wrap:wrap}'
      // one line per staked side bet: what it was, how it landed, what it paid
      + '.seq-bets{display:grid;gap:3px}'
      + '.seq-bet{display:grid;grid-template-columns:auto 1fr auto;gap:8px;'
      + 'align-items:baseline;font-size:.74rem;color:var(--muted,#6B7280)}'
      + '.seq-bet-name{font-weight:700;color:var(--text,#111);min-width:74px}'
      + '.seq-bet-result{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.seq-bet-net{font-weight:800;font-variant-numeric:tabular-nums;'
      + 'color:var(--muted,#6B7280)}'
      + '.seq-bet.won .seq-bet-result{color:var(--text,#111)}'
      + '.seq-bet.won .seq-bet-net{color:var(--green,#0B5D3B)}'
      + '.seq-when{float:right;font-weight:600;letter-spacing:.03em;'
      + 'text-transform:none;opacity:.8}'
      + '.seq-label{font-weight:800;color:var(--text,#111)}'
      + '.seq-why{color:var(--muted,#6B7280);font-size:.72rem}'
      + '.seq-sep{color:var(--border-strong,#C9CED6)}'
      // The header stat strip wraps to a second line once Accuracy stops being
      // a dash, which grew the sticky header and moved every button by 18px.
      // Reserve both lines so the text can change without moving anything.
      + '.app-header .status-strip{min-height:36px;align-content:flex-start}'
      + '@media(prefers-reduced-motion:reduce){'
      + '.playing-card.just-dealt-in{animation:none}}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  function boot() {
    injectStyles();
    relocateTopBanners();
    install();
    installCoalescing();   // must wrap the fully decorated renderTable

    // cloud.js builds its restore banner only after a login resolves, and it
    // prepends to <main>. Catch it whenever it turns up and dock it too.
    try {
      var main = document.querySelector('main');
      if (main && window.MutationObserver) {
        new MutationObserver(function () {
          var stray = document.getElementById('cloudRestoreBanner');
          var dock = document.getElementById('bjfDock');
          if (stray && dock && stray.parentNode !== dock) dock.appendChild(stray);
        }).observe(main, { childList: true });
      }
    } catch (e) { /* observation is a nicety, never fatal */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
