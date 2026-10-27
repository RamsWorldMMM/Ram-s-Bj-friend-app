/* Ram's BJ Friend — SAVE WATCH
 *
 * On 26 October Ram played from R1609 to R1754 and none of it was saved. His
 * phone's storage had filled — the engine's save and the round log together
 * reached 5.31 M characters against a 5.00 M quota — and every save after
 * R1609 failed. The engine's response to that is console.warn. The cloud sync
 * was failing too, for its own reasons, and its only sign was a small chip
 * reading "Offline — will retry". He refreshed and lost 145 rounds without ever
 * having been told anything was wrong.
 *
 * This does two things and changes no rule, card, wager or result:
 *
 *  1. Before each save, cuts the engine's raw event list to its newest
 *     EVENT_CAP entries. It was 91% of the save (1.37 of 1.51 MB at R1635).
 *     Nothing in the game reads it: history.js reads the current round's events
 *     only, and cloud.js sends the newest 400 to the AI.
 *  2. After each save, checks that it actually landed, and says so on screen
 *     — plainly — whenever play is not being saved somewhere.
 *
 * It is loaded last (from reveal.js, like staking.js and whatsnew.js), so its
 * wrapper is the outermost around saveSession: the cut happens before every
 * other layer runs, and the check sees what they all did.
 */
(function () {
  'use strict';

  var ENGINE_KEY = 'ramsBjFriendBetaV14';
  /* Comfortably more than anything reads: one round is ~3 to ~20 events (a deal,
     each decision, the dealer), history.js needs only the round just settled,
     and the AI context takes the newest 400. */
  var EVENT_CAP = 600;

  var localFailedFrom = null;   // first round whose local save failed, or null
  var lastHealth = null;        // latest from cloud.js
  var restoreTimer = null;

  /* global state */
  function rounds() {
    try { return (typeof state !== 'undefined' && state && state.rounds) || 0; }
    catch (e) { return 0; }
  }

  function capEvents() {
    try {
      if (typeof state === 'undefined' || !state || !Array.isArray(state.eventLog)) return;
      var extra = state.eventLog.length - EVENT_CAP;
      if (extra > 0) state.eventLog.splice(0, extra);
    } catch (e) { /* never in the way of the save itself */ }
  }

  /* Did the engine's save land? Its own failure is swallowed into console.warn,
     so read it back. The round count sits near the front — the save is
     {"state":{"start":…,"bankroll":…,"rounds":N,…} — so a short slice finds it
     without parsing the rest. */
  function engineSaved() {
    try {
      var raw = localStorage.getItem(ENGINE_KEY);
      if (!raw) return false;
      var m = /"rounds":(\d+)/.exec(raw.slice(0, 4000));
      if (m) return Number(m[1]) === rounds();
      var saved = JSON.parse(raw);
      return Boolean(saved && saved.state && saved.state.rounds === rounds());
    } catch (e) { return false; }
  }

  function logSaved() {
    try {
      var h = typeof window.BJF_LOCAL_LOG_HEALTH === 'function' ? window.BJF_LOCAL_LOG_HEALTH() : null;
      return !h || h.ok !== false;
    } catch (e) { return true; }
  }

  function cloud() {
    if (lastHealth) return lastHealth;
    try { return typeof window.BJF_SYNC_HEALTH === 'function' ? window.BJF_SYNC_HEALTH() : null; }
    catch (e) { return null; }
  }

  // ------------------------------------------------------------------ the bar

  function styles() {
    if (document.getElementById('bjfSaveWatchCss')) return;
    var css = document.createElement('style');
    css.id = 'bjfSaveWatchCss';
    css.textContent = [
      '#bjfSaveWarn{position:fixed;left:0;right:0;top:0;z-index:8500;',
      '  font-family:Inter,system-ui,-apple-system,sans-serif;color:#fff;',
      '  padding:9px 14px 10px;box-shadow:0 6px 18px -8px rgba(0,0,0,.45);',
      '  display:none;line-height:1.35}',
      '#bjfSaveWarn.show{display:block}',
      '#bjfSaveWarn .t{font-size:14px;font-weight:700;letter-spacing:-.005em}',
      '#bjfSaveWarn .d{font-size:12.5px;opacity:.95;margin-top:2px}',
      '#bjfSaveWarn .a{margin-top:8px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;',
      '  border:0;border-radius:8px;padding:7px 12px;background:#fff;color:#16221c;display:none}',
      '#bjfSaveWarn .a.on{display:inline-block}',
      '#bjfSaveWarn .a:disabled{opacity:.6;cursor:default}',
      '#bjfSaveWarn.critical{background:#9d2727}',
      '#bjfSaveWarn.warn{background:#8a5a00}',
      '#bjfSaveWarn.info{background:#3c4a43}',
      '#bjfSaveWarn.ok{background:#0b5d3b}',
      /* Push the page down rather than cover it: the header carries his bankroll
         and P/L, and a warning should never hide the numbers it is about.
         Padding alone is not enough — the header is position:sticky; top:0, so
         once he scrolls it pins to the very top of the screen, underneath the
         bar. It is moved to stick just below the bar instead. */
      'body.bjf-save-warn{transition:padding-top .15s ease}',
      'body.bjf-save-warn .app-header{top:var(--bjf-save-bar,0px)}',
    ].join('');
    document.head.appendChild(css);
  }

  function bar() {
    var b = document.getElementById('bjfSaveWarn');
    if (b) return b;
    styles();
    b = document.createElement('div');
    b.id = 'bjfSaveWarn';
    b.setAttribute('role', 'status');
    b.setAttribute('aria-live', 'polite');
    b.innerHTML = '<div class="t"></div><div class="d"></div><button class="a" type="button"></button>';
    b.querySelector('.a').addEventListener('click', function () {
      var fn = b.__action; if (typeof fn === 'function') fn();
    });
    document.body.appendChild(b);
    return b;
  }

  function show(kind, title, detail, action) {
    var b = bar();
    b.className = kind + ' show';
    b.querySelector('.t').textContent = title;
    b.querySelector('.d').textContent = detail || '';
    var btn = b.querySelector('.a');
    b.__action = action && action.run;
    btn.textContent = action ? action.label : '';
    btn.className = 'a' + (action ? ' on' : '');
    btn.disabled = Boolean(action && action.busy);
    document.body.classList.add('bjf-save-warn');
    document.body.style.paddingTop = b.offsetHeight + 'px';
    document.documentElement.style.setProperty('--bjf-save-bar', b.offsetHeight + 'px');
  }

  function hide() {
    var b = document.getElementById('bjfSaveWarn');
    if (b) b.className = '';
    document.body.classList.remove('bjf-save-warn');
    document.body.style.paddingTop = '';
    document.documentElement.style.removeProperty('--bjf-save-bar');
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* What to say, from the facts. Severity is about where the rounds exist:
     nowhere (red), on this phone only (amber), or safe (nothing, or a calm note). */
  function render() {
    if (restoreTimer) return;                 // the "picked up" notice is showing
    var localOk = localFailedFrom === null;
    var c = cloud() || { signedIn: false, failStreak: 0, lastOkRound: null };
    var now = rounds();
    var behind = c.signedIn && typeof c.lastOkRound === 'number' ? Math.max(0, now - c.lastOkRound) : 0;
    var cloudTrouble = c.signedIn && (c.failStreak >= 2 || behind >= 3);
    var unsaved = localOk ? 0 : Math.max(1, now - localFailedFrom + 1);

    if (!localOk && (!c.signedIn || c.failStreak >= 1 || behind >= 3)) {
      var n = c.signedIn && behind ? Math.max(unsaved, behind) : unsaved;
      show('critical',
        'Your last ' + plural(n, 'round is', 'rounds are') + ' not saved anywhere',
        c.signedIn
          ? "Don't refresh or close this page — it keeps trying to save to your account."
          : "Don't refresh or close this page. Sign in so your play is saved to your account.");
      return;
    }
    if (c.restoring) {
      show('info', 'Switching to your saved game',
        "Saving this screen's rounds first, so none are lost.",
        { label: 'Working…', busy: true });
      return;
    }
    /* A reload does not fix this: the saved game is still elsewhere. It used to
       say "Reload to carry on", which sent him round in a circle. The button does
       the real thing — sends this screen's rounds, then switches. */
    if (c.forked) {
      show('warn', "This screen isn't on your saved game",
        "Its rounds are being saved separately, so nothing is lost or overwritten.",
        typeof window.BJF_GO_TO_SAVED_GAME === 'function'
          ? { label: 'Go to saved game', run: window.BJF_GO_TO_SAVED_GAME } : null);
      return;
    }
    // Signed in, but the server has not yet said what it holds, so nothing has
    // been sent. Quiet for the first couple of rounds; then said.
    if (c.signedIn && c.holding && typeof c.bootRounds === 'number' && now - c.bootRounds >= 3) {
      show('warn', "Can't reach your account yet",
        'Your play is saved on this phone and goes up as soon as it connects.');
      return;
    }
    if (cloudTrouble) {
      show('warn',
        'Not backed up to your account for ' + plural(Math.max(behind, 1), 'round', 'rounds'),
        'Saved on this phone. Keep this page open — it keeps retrying.');
      return;
    }
    if (!localOk && c.signedIn) {
      show('info', 'Your play is safe in your account',
        "This phone's storage is full, which is fine while you're signed in.");
      return;
    }
    hide();
  }

  function check() {
    var ok = engineSaved() && logSaved();
    if (ok) localFailedFrom = null;
    else if (localFailedFrom === null) localFailedFrom = rounds();
    render();
  }

  function install() {
    var original = window.saveSession;
    if (typeof original !== 'function' || original.bjfSaveWatch) return;
    var wrapped = function () {
      capEvents();
      var r = original.apply(this, arguments);
      try { check(); } catch (e) { /* the warning must never break a save */ }
      return r;
    };
    wrapped.bjfSaveWatch = true;
    window.saveSession = wrapped;
  }

  function boot() {
    install();
    // Shrink the event list held in memory now, so the first save of this page
    // is already small. Deliberately NOT a save: saving here would sync whatever
    // the page loaded with before cloud.js has checked whether the server holds
    // something newer — and a stale copy synced first is how a game forks.
    capEvents();

    window.addEventListener('bjf:sync', function (e) {
      lastHealth = e && e.detail ? e.detail : null;
      render();
    });
    window.addEventListener('bjf:restored', function (e) {
      var n = e && e.detail && e.detail.rounds;
      clearTimeout(restoreTimer);
      var lossless = Boolean(e && e.detail && e.detail.lossless);
      show('ok', 'Picked up your latest saved game' + (n ? ' — round ' + n : ''),
        lossless && e.detail.reason === 'newer'
          ? 'This screen had an older copy of the same game. Nothing was lost.'
          : lossless && e.detail.reason === 'chosen'
            ? "This screen's own rounds were saved separately first."
            : '');
      restoreTimer = setTimeout(function () { restoreTimer = null; render(); }, 6000);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
