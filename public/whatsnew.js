/* Ram's BJ Friend — WHAT'S NEW
 *
 * Every deploy used to land silently. Ram would find the main wager buttons
 * showing different numbers, or a figure he had queried quietly corrected, with
 * nothing to say it had happened or why. This says it: once per release, after
 * a deploy, the app tells him it was updated and offers to show what moved.
 *
 * NOTHING HERE TOUCHES THE GAME. No rule, card, wager, figure or result is read
 * or changed. The only thing it asks the engine is whether a hand is in play, so
 * it can keep out of the way until one is not.
 *
 * NO NETWORK. The notes live in this file rather than a JSON file fetched at
 * load, so the panel works signed out, offline, and on a first run with a cold
 * cache — all three of which are ordinary for Ram, who plays on hotel wifi. The
 * cost is that adding a note means editing this file, which is the same work as
 * editing a JSON one.
 *
 * WRITING A NOTE
 * One line per change, in Ram's language. No version numbers in the sentence,
 * no file names, no cause. Add `why` only when it changes what he should think
 * about his own past figures — whether something he has already looked at was
 * wrong. Most changes do not need one.
 *
 * `kind` is one of: fix | change | add.
 */
(function () {
  'use strict';

  /* Newest first. The top entry's `version` is what decides whether anyone is
     shown anything, so a new release means a new entry at the top. */
  var RELEASES = [
    {
      version: '1.4.9',
      date: '27 October 2026',
      items: [
        {
          kind: 'fix',
          text: 'Your play is saved reliably again, however long the session runs.',
          why: 'On 26 October your phone ran out of storage after round 1609 and '
             + 'stopped saving without saying so — which is why refreshing took you '
             + 'back there, twice. The rounds played after 1609 in that session '
             + 'could not be recovered.',
        },
        {
          kind: 'add',
          text: 'If your play is ever not being saved, a bar across the top of the '
              + 'screen now says so, and what to do.',
        },
        {
          kind: 'change',
          text: 'Reloading now picks up your latest saved game, even when this '
              + "phone's own copy is older.",
        },
      ],
    },
    {
      version: '1.4.8',
      date: '23 October 2026',
      items: [
        {
          kind: 'fix',
          text: 'The dealer no longer takes a card when every hand already has '
              + "blackjack and the dealer can't make one.",
          why: 'You spotted this one. It was burning a card a real table would '
             + 'never use, about 1 round in 108. Your payouts were always correct.',
        },
      ],
    },
    {
      version: '1.4.7',
      date: '15 October 2026',
      items: [
        { kind: 'change', text: 'Main bet buttons are now £400, £700 and £1,500.' },
        { kind: 'fix', text: 'Sending a session to ChatGPT takes about 2 seconds instead of 36.' },
        { kind: 'fix', text: 'The shoe archive is filling in again after being stuck since September.' },
        {
          kind: 'fix',
          text: 'Your side-bet and shoe figures no longer lag behind the summary.',
          why: 'For a few hours on 15 October the files disagreed with each other, '
             + 'so a side-bet question asked then may have missed your newest rounds.',
        },
      ],
    },
    {
      version: '1.4.4',
      date: '5 October 2026',
      items: [
        { kind: 'add', text: 'Your session is sent automatically when a shoe finishes.' },
        { kind: 'change', text: 'Side bet buttons now go up to £400.' },
        {
          kind: 'fix',
          text: 'Bankroll top-ups are no longer counted as winnings.',
          why: 'Your profit figure was overstated before this.',
        },
      ],
    },
  ];

  var SEEN_KEY = 'bjfWhatsNewSeen';
  var LABEL = { fix: 'Fixed', change: 'Changed', add: 'Added' };
  var CLASS = { fix: 'fix', change: 'chg', add: 'new' };

  /* localStorage throws outright in some private-browsing modes rather than
     returning null, and a release note is never worth taking the app down. */
  function readSeen() {
    try { return window.localStorage.getItem(SEEN_KEY); } catch (e) { return null; }
  }
  function writeSeen(v) {
    try { window.localStorage.setItem(SEEN_KEY, v); } catch (e) { /* nothing to do */ }
  }

  /** The releases newer than what he has already acknowledged. */
  function unseenReleases() {
    var seen = readSeen();
    if (!seen) return RELEASES.slice();          // first run: show the recent history
    var at = RELEASES.findIndex(function (r) { return r.version === seen; });
    return at < 0 ? RELEASES.slice() : RELEASES.slice(0, at);
  }

  /* Mid-hand is the wrong moment. 'player' and 'dealer' mean cards are on the
     table; 'ready' and 'complete' mean they are not. Reaching `state` as a bare
     global is how every other file here talks to the engine — index.html is a
     classic script, so its top-level bindings are in the shared global scope
     even though window.state is undefined. */
  function midHand() {
    try {
      if (typeof state === 'undefined' || !state) return false;
      return state.phase === 'player' || state.phase === 'dealer';
    } catch (e) { return false; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function styles() {
    if (document.getElementById('bjfWhatsNewCss')) return;
    var css = document.createElement('style');
    css.id = 'bjfWhatsNewCss';
    css.textContent = [
      /* The app's own tokens are already on :root, so this inherits the table's
         palette rather than restating it and drifting from it later. */
      '.bjf-wn-pop{position:fixed;left:12px;right:12px;bottom:12px;z-index:9000;',
      '  max-width:420px;margin:0 auto;background:var(--panel,#fff);',
      '  border:1px solid var(--border,#d7dfda);border-radius:13px;',
      '  box-shadow:0 14px 34px -8px rgba(11,34,24,.45);padding:14px 15px 13px;',
      '  display:grid;gap:11px;font-family:Inter,system-ui,-apple-system,sans-serif;',
      '  color:var(--text,#16221c);transform:translateY(16px);opacity:0;',
      '  transition:transform .26s cubic-bezier(.22,.8,.3,1),opacity .2s ease}',
      '.bjf-wn-pop.is-in{transform:translateY(0);opacity:1}',
      '.bjf-wn-pop .t{display:flex;align-items:center;gap:8px;font-size:15px;',
      '  font-weight:600;letter-spacing:-.01em}',
      '.bjf-wn-pop .t svg{width:17px;height:17px;flex:none;color:var(--green,#0b5d3b)}',
      '.bjf-wn-pop .s{margin:0;font-size:12.5px;color:var(--muted,#64736b);line-height:1.45}',
      '.bjf-wn-pop .r{display:flex;gap:8px}',
      '.bjf-wn-pop button{font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;',
      '  padding:10px 12px;border-radius:9px}',
      '.bjf-wn-pop .go{flex:1;border:0;background:var(--green,#0b5d3b);color:#fff}',
      '.bjf-wn-pop .later{border:1px solid var(--border,#d7dfda);background:transparent;',
      '  color:var(--muted,#64736b)}',

      '.bjf-wn-scrim{position:fixed;inset:0;z-index:9001;background:rgba(11,34,24,.42);',
      '  opacity:0;transition:opacity .22s ease}',
      '.bjf-wn-scrim.is-in{opacity:1}',

      '.bjf-wn-sheet{position:fixed;left:0;right:0;bottom:0;z-index:9002;',
      '  background:var(--panel,#fff);border-top:1px solid var(--border,#d7dfda);',
      '  border-radius:14px 14px 0 0;max-height:84vh;display:flex;flex-direction:column;',
      '  font-family:Inter,system-ui,-apple-system,sans-serif;color:var(--text,#16221c);',
      '  transform:translateY(102%);transition:transform .3s cubic-bezier(.22,.8,.3,1);',
      '  max-width:560px;margin:0 auto}',
      '.bjf-wn-sheet.is-in{transform:translateY(0)}',
      '.bjf-wn-sheet .grab{width:34px;height:4px;border-radius:99px;flex:none;',
      '  background:var(--border,#d7dfda);margin:9px auto 3px}',
      '.bjf-wn-sheet header{padding:7px 17px 11px;flex:none}',
      '.bjf-wn-sheet h2{font-family:Georgia,serif;font-weight:400;font-size:19px;',
      '  margin:0 0 3px;letter-spacing:-.01em}',
      '.bjf-wn-sheet .sub{margin:0;color:var(--muted,#64736b);font-size:12px}',
      '.bjf-wn-sheet .body{overflow:auto;padding:0 17px 7px;flex:1;-webkit-overflow-scrolling:touch}',
      '.bjf-wn-rel + .bjf-wn-rel{margin-top:17px;padding-top:15px;',
      '  border-top:1px solid var(--border,#d7dfda)}',
      '.bjf-wn-rel h3{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;',
      '  color:var(--muted,#64736b);margin:0 0 9px;display:flex;align-items:baseline;gap:7px}',
      '.bjf-wn-rel h3 .v{color:var(--green,#0b5d3b);letter-spacing:.04em}',
      '.bjf-wn-rel.latest h3 .v:after{content:"NEW";margin-left:6px;font-size:9px;',
      '  background:var(--green,#0b5d3b);color:#fff;padding:2px 5px;border-radius:4px;',
      '  letter-spacing:.07em;vertical-align:1px}',
      '.bjf-wn-items{list-style:none;margin:0;padding:0;display:grid;gap:10px}',
      /* A fixed tag column, not auto: "CHANGED" is wider than "FIXED", and an
         auto column sizes per row, so every line of text started at a slightly
         different place down the list. */
      '.bjf-wn-items li{display:grid;grid-template-columns:74px minmax(0,1fr);gap:9px;',
      '  align-items:start}',
      '.bjf-wn-tag{justify-self:start}',
      '.bjf-wn-items p{margin:0;font-size:13.5px;line-height:1.5}',
      '.bjf-wn-items .why{display:block;color:var(--muted,#64736b);font-size:12px;margin-top:2px}',
      '.bjf-wn-tag{font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;',
      '  padding:3px 7px;border-radius:5px;white-space:nowrap;margin-top:1px}',
      '.bjf-wn-tag.fix{background:#e6f0ea;color:#0b5d3b}',
      '.bjf-wn-tag.new{background:#e8eef6;color:#1f4a7a}',
      '.bjf-wn-tag.chg{background:#f4efe2;color:#7a5a1f}',
      '.bjf-wn-sheet footer{padding:11px 17px 15px;flex:none;',
      '  border-top:1px solid var(--border,#d7dfda)}',
      '.bjf-wn-sheet .got{width:100%;font:inherit;font-size:14px;font-weight:600;',
      '  cursor:pointer;padding:11px;border-radius:10px;border:0;',
      '  background:var(--green,#0b5d3b);color:#fff}',
      '@media (prefers-reduced-motion: reduce){',
      '  .bjf-wn-pop,.bjf-wn-sheet,.bjf-wn-scrim{transition:none}}',
    ].join('');
    document.head.appendChild(css);
  }

  var popup = null, scrim = null, sheet = null;

  function dismiss() {
    writeSeen(RELEASES[0].version);
    [popup, sheet, scrim].forEach(function (n) {
      if (!n) return;
      n.classList.remove('is-in');
      window.setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 320);
    });
    popup = scrim = sheet = null;
  }

  function openSheet(releases) {
    if (popup) {
      popup.classList.remove('is-in');
      window.setTimeout(function () {
        if (popup && popup.parentNode) popup.parentNode.removeChild(popup);
        popup = null;
      }, 280);
    }

    scrim = el('div', 'bjf-wn-scrim');
    scrim.addEventListener('click', dismiss);

    sheet = el('div', 'bjf-wn-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', "What's new");
    sheet.appendChild(el('div', 'grab'));

    var head = document.createElement('header');
    head.appendChild(el('h2', null, "What's new"));
    var n = releases.reduce(function (a, r) { return a + r.items.length; }, 0);
    head.appendChild(el('p', 'sub',
      n === 1 ? 'One update since you last played'
              : n + ' updates since you last played'));
    sheet.appendChild(head);

    var body = el('div', 'body');
    releases.forEach(function (rel, i) {
      var sec = el('section', 'bjf-wn-rel' + (i === 0 ? ' latest' : ''));
      var h3 = document.createElement('h3');
      h3.appendChild(el('span', 'v', 'v' + rel.version));
      h3.appendChild(el('span', null, rel.date));
      sec.appendChild(h3);

      var ul = el('ul', 'bjf-wn-items');
      rel.items.forEach(function (item) {
        var li = document.createElement('li');
        li.appendChild(el('span', 'bjf-wn-tag ' + (CLASS[item.kind] || 'fix'),
                          LABEL[item.kind] || 'Fixed'));
        var p = el('p', null, item.text);
        if (item.why) p.appendChild(el('span', 'why', item.why));
        li.appendChild(p);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      body.appendChild(sec);
    });
    sheet.appendChild(body);

    var foot = document.createElement('footer');
    var got = el('button', 'got', 'Got it');
    got.type = 'button';
    got.addEventListener('click', dismiss);
    foot.appendChild(got);
    sheet.appendChild(foot);

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    // One frame, so the browser has a start state to animate away from.
    window.requestAnimationFrame(function () {
      scrim.classList.add('is-in');
      sheet.classList.add('is-in');
    });
    got.focus();
  }

  function showPopup(releases) {
    styles();
    var count = releases.reduce(function (a, r) { return a + r.items.length; }, 0);

    popup = el('div', 'bjf-wn-pop');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Application updated');

    var t = el('div', 't');
    t.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
                + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                + '<path d="M12 2v14"></path><path d="m6 10 6 6 6-6"></path>'
                + '<path d="M3 20h18"></path></svg>';
    t.appendChild(document.createTextNode('Application updated'));
    popup.appendChild(t);

    popup.appendChild(el('p', 's', 'Version ' + RELEASES[0].version + ' · '
      + (count === 1 ? 'one change' : count + ' changes') + ' since you last played.'));

    var row = el('div', 'r');
    var go = el('button', 'go', 'Show updates');
    go.type = 'button';
    go.addEventListener('click', function () { openSheet(releases); });
    var later = el('button', 'later', 'Later');
    later.type = 'button';
    later.addEventListener('click', dismiss);
    row.appendChild(go);
    row.appendChild(later);
    popup.appendChild(row);

    document.body.appendChild(popup);
    window.requestAnimationFrame(function () { popup.classList.add('is-in'); });
  }

  /* Wait for a gap between hands. If he is mid-round when the app loads, the
     card would sit over his cards at the one moment he needs them, so it holds
     until the round settles. It gives up after two minutes rather than firing
     at some unrelated later moment — the next load will offer it again. */
  function whenFree(fn) {
    if (!midHand()) { fn(); return; }
    var waited = 0;
    var timer = window.setInterval(function () {
      waited += 1000;
      if (!midHand()) { window.clearInterval(timer); fn(); }
      else if (waited >= 120000) window.clearInterval(timer);
    }, 1000);
  }

  function boot() {
    try {
      if (!RELEASES.length) return;
      var pending = unseenReleases();
      if (!pending.length) return;                       // already up to date
      styles();
      // A beat after load, so it arrives after the table has drawn rather than
      // competing with it.
      window.setTimeout(function () { whenFree(function () { showPopup(pending); }); }, 1200);
    } catch (e) { /* a release note must never be why the app fails to start */ }
  }

  /* Lets the notes be reopened deliberately — from the console today, and from
     a menu item if one is ever wanted. Reading them this way does not mark them
     seen, so an accidental open does not silence the next release. */
  window.bjfShowWhatsNew = function () {
    styles();
    openSheet(RELEASES.slice());
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
