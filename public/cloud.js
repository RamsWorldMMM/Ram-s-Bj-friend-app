/* Ram's BJ Friend — cloud layer (auth, D1 sync, Vertex AI analysis, history).
 *
 * DESIGN CONSTRAINT: this file must not alter gameplay. It never touches the
 * strategy matrices, shoe handling, settlement, or any rule. It only:
 *   1. reads the game's state after the game has finished writing it,
 *   2. wraps three global functions to piggyback on events that already occur,
 *   3. adds its own UI, injected at runtime.
 *
 * The game script declares `state`, `shoe` and `lastBets` with top-level `let`,
 * which puts them in the shared global lexical environment — readable and
 * assignable by bare name from this classic script. Its `function` declarations
 * land on `window`, so wrapping window.saveSession is picked up by the
 * unqualified `saveSession()` call inside settleRound.
 */
(function () {
  'use strict';

  var META_KEY = 'bjfCloudMeta';
  var APP_VERSION = "Ram's BJ Friend v1.4.6";
  var STRATEGY_VERSION = "HIP-ENHC-S17-v1";
  var RULES_PROFILE = "6D / S17 / ENHC-full-loss / DOA / DAS";
  var API = {
    me: '/api/me',
    login: '/api/login',
    logout: '/api/logout',
    sync: '/api/sessions/sync',
    latest: '/api/sessions/latest',
    sessions: '/api/sessions',
  };

  var meta = loadMeta();
  var currentUser = null;
  var syncTimer = null;
  var syncPending = false;
  var lastSyncedAt = null;

  // ---------------------------------------------------------------- helpers

  function loadMeta() {
    var m;
    try { m = JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { m = {}; }
    if (!m.deviceId) m.deviceId = uuid();
    if (!m.sessionId) m.sessionId = uuid();
    saveMeta(m);
    return m;
  }

  function saveMeta(m) {
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) { /* quota */ }
  }

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (crypto.getRandomValues(new Uint8Array(1))[0] % 16) | 0;
      var v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  function api(path, options) {
    return fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.error || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  function el(id) { return document.getElementById(id); }

  function money(n) {
    var v = Number(n) || 0;
    return (v < 0 ? '-' : '') + '£' + Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    // D1 datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC.
    var d = new Date(iso.indexOf('T') === -1 ? iso.replace(' ', 'T') + 'Z' : iso);
    return isNaN(d) ? iso : d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  // ------------------------------------------------------------------ styles

  function injectStyles() {
    var css = ''
      + '.cloud-pill{border:1px solid var(--border);border-radius:999px;padding:6px 12px;font-size:.76rem;'
      + 'display:inline-flex;align-items:center;gap:7px;background:#fff;white-space:nowrap}'
      + '.cloud-dot{width:8px;height:8px;border-radius:50%;background:#b9c4be;flex:0 0 8px}'
      + '.cloud-dot.ok{background:#1f9d55}.cloud-dot.busy{background:#d09500}.cloud-dot.err{background:#9d2727}'
      // add-funds control, sitting in Session controls beside the reset field
      + '.add-funds-row{display:grid;grid-template-columns:1fr auto;gap:7px}'
      + '.add-funds-row input{min-width:0}'
      + '.add-funds-row button{white-space:nowrap;min-height:44px}'
      + '.cloud-overlay{position:fixed;inset:0;z-index:100;background:rgba(12,32,22,.62);'
      + 'backdrop-filter:blur(6px);display:grid;place-items:center;padding:18px}'
      + '.cloud-login{background:#fff;border-radius:20px;padding:26px;width:min(400px,100%);'
      + 'box-shadow:0 20px 60px rgba(0,0,0,.32);display:grid;gap:14px}'
      + '.cloud-login h2{margin:0;font-size:1.2rem}'
      + '.cloud-login .muted{margin:0}'
      + '.cloud-error{background:#fdeaea;border:1px solid #e6b8b8;color:var(--danger);'
      + 'border-radius:10px;padding:10px;font-size:.82rem}'
      + '.ai-panel .ai-body{white-space:pre-wrap;line-height:1.5;font-size:.9rem;'
      + 'border:1px solid var(--border);border-radius:13px;padding:14px;background:#fbfdfc}'
      + '.ai-grade{display:inline-flex;align-items:center;justify-content:center;min-width:42px;height:42px;'
      + 'padding:0 12px;border-radius:12px;background:var(--green);color:#fff;font-weight:700;font-size:1.05rem}'
      + '.recon{border-radius:10px;padding:9px 11px;font-size:.78rem;margin-bottom:12px}'
      + '.recon.reconciles{background:#eaf6ef;border:1px solid #bcd8ca;color:#1f7a4d}'
      + '.recon.failed{background:#fdeaea;border:1px solid #e6b8b8;color:var(--danger);font-weight:700}'
      + '.recon.insufficient_data{background:#f5f7f6;border:1px solid var(--border);color:var(--muted)}'
      + '.integrity{margin-top:14px;background:var(--warn);border:1px solid #e7d17d;'
      + 'border-radius:11px;padding:11px;font-size:.82rem}'
      + '.integrity ul{margin:6px 0 0;padding-left:18px}'
      + '.ai-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}'
      + '.ai-head strong{font-size:1rem}'
      + '.ai-meta{color:var(--muted);font-size:.74rem;margin-top:8px}'
      + '.leak{border:1px solid var(--border);border-left:4px solid var(--green);'
      + 'border-radius:11px;padding:11px;margin-top:8px;font-size:.84rem}'
      + '.leak b{display:block;margin-bottom:4px}'
      + '.leak span{display:block;color:var(--muted);margin-top:3px}'
      + '.hist-row{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;'
      + 'border:1px solid var(--border);border-radius:12px;padding:11px;margin-top:8px;font-size:.85rem}'
      + '.hist-row .sub{color:var(--muted);font-size:.75rem;margin-top:3px}'
      + '.hist-row .pl{font-weight:700}'
      + '.hist-row .pl.up{color:#1f7a4d}.hist-row .pl.down{color:var(--danger)}'
      + '.cloud-banner{background:#eef5f1;border:1px solid #bcd8ca;border-radius:13px;'
      + 'padding:12px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}'
      + '@media(max-width:850px){.hist-row{grid-template-columns:1fr auto}}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------------ markup

  function injectUI() {
    // Status pill in the header, next to the existing version pill.
    var header = document.querySelector('.app-header');
    if (header) {
      var pill = document.createElement('span');
      pill.className = 'cloud-pill';
      pill.id = 'cloudPill';
      pill.innerHTML = '<span class="cloud-dot" id="cloudDot"></span><span id="cloudText">Connecting…</span>';
      header.appendChild(pill);
    }

    // Login overlay.
    var overlay = document.createElement('div');
    overlay.className = 'cloud-overlay hidden';
    overlay.id = 'cloudOverlay';
    overlay.innerHTML =
      '<form class="cloud-login" id="cloudLoginForm">' +
        '<h2>Sign in</h2>' +
        '<p class="muted">Your sessions and AI analyses are stored against this account.</p>' +
        '<div id="cloudLoginError" class="cloud-error hidden"></div>' +
        '<label class="field"><span>Username</span>' +
          '<input id="cloudUsername" autocomplete="username" required /></label>' +
        '<label class="field"><span>Password</span>' +
          '<input id="cloudPassword" type="password" autocomplete="current-password" required /></label>' +
        '<button class="primary large" type="submit" id="cloudLoginBtn">Sign in</button>' +
        '<button class="secondary" type="button" id="cloudOfflineBtn">Continue offline</button>' +
      '</form>';
    document.body.appendChild(overlay);

    // AI analysis panel + history panel, placed after the existing
    // "Session analysis" section so nothing existing moves.
    var analysisPanel = el('analysisReport') ? el('analysisReport').closest('section.panel') : null;
    var aiSection = document.createElement('section');
    aiSection.className = 'panel ai-panel';
    aiSection.id = 'aiPanel';
    aiSection.innerHTML =
      '<div class="section-heading">' +
        '<div><h2>AI session analysis</h2>' +
        '<p>Generated automatically by Gemini on Vertex AI and saved with the session.</p></div>' +
        '<button id="aiRefreshBtn" class="secondary small">Reload latest</button>' +
      '</div>' +
      '<div id="aiContent" class="muted" style="margin-top:12px">' +
        'Press “Analyse with AI” above after playing some rounds.</div>';

    var histSection = document.createElement('section');
    histSection.className = 'panel';
    histSection.id = 'historyPanel';
    histSection.innerHTML =
      '<div class="section-heading">' +
        '<div><h2>Session history</h2>' +
        '<p>Every synced session and its stored AI insights.</p></div>' +
        '<button id="histRefreshBtn" class="secondary small">Refresh</button>' +
      '</div>' +
      '<div id="historyList" class="muted" style="margin-top:12px">Sign in to view history.</div>';

    if (analysisPanel && analysisPanel.parentNode) {
      analysisPanel.parentNode.insertBefore(aiSection, analysisPanel.nextSibling);
      aiSection.parentNode.insertBefore(histSection, aiSection.nextSibling);
    } else {
      document.querySelector('main').appendChild(aiSection);
      document.querySelector('main').appendChild(histSection);
    }
  }

  function setStatus(kind, text) {
    var dot = el('cloudDot'), label = el('cloudText');
    if (!dot || !label) return;
    dot.className = 'cloud-dot' + (kind ? ' ' + kind : '');
    label.textContent = text;
  }

  // -------------------------------------------------------------- game hooks

  /** Snapshot of the live game state. Read-only — never mutated here. */
  function snapshot() {
    /* global state, shoe, lastBets */
    return {
      sessionId: meta.sessionId,
      deviceId: meta.deviceId,
      // Explicit, not document.title — the production title is now just the
      // app name, but reports still need the build identifier.
      appVersion: APP_VERSION,
      mode: window.BJF_MODE || 'practice',
      // Omit rather than send [] — history.js loads AFTER cloud.js, so sending an
      // empty array on a boot failure would wipe the stored per-hand history.
      roundLog: typeof window.BJF_ROUND_LOG === 'function' ? window.BJF_ROUND_LOG() : null,
      roundLogMeta: typeof window.BJF_ROUND_LOG_META === 'function'
        ? window.BJF_ROUND_LOG_META() : null,
      strategyVersion: STRATEGY_VERSION,
      rulesProfileId: RULES_PROFILE,
      state: state,
      shoe: shoe,
      lastBets: lastBets,
    };
  }

  function scheduleSync() {
    if (!currentUser) return;
    syncPending = true;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, 400);
  }

  function flushSync() {
    if (!currentUser || !syncPending) return;
    setStatus('busy', 'Syncing…');
    var payload = snapshot();
    api(API.sync, { method: 'POST', body: JSON.stringify(payload) })
      .then(function (res) {
        syncPending = false;
        lastSyncedAt = new Date();
        setStatus('ok', currentUser.username + ' · saved');
        return res;
      })
      .catch(function (err) {
        if (err.status === 401) return requireLogin();
        // Stay dirty; the next settled round or the online event retries.
        setStatus('err', 'Offline — will retry');
      });
  }

  function installHooks() {
    // 1. Piggyback on the existing save point (fires once per settled round).
    var originalSave = window.saveSession;
    if (typeof originalSave === 'function') {
      window.saveSession = function () {
        var result = originalSave.apply(this, arguments);
        try { scheduleSync(); } catch (e) { console.warn('cloud sync hook failed', e); }
        return result;
      };
    }

    // 2. A reset starts a brand-new cloud session, leaving the old one intact.
    var originalReset = window.resetSession;
    if (typeof originalReset === 'function') {
      window.resetSession = function () {
        var result = originalReset.apply(this, arguments);
        meta.sessionId = uuid();
        saveMeta(meta);
        renderAnalysis(null);
        loadHistory();
        return result;
      };
    }

    // 3. Repurpose "Share session" as the AI trigger. Replacing the node drops
    //    the original listener without editing the game script.
    var share = el('shareReportBtn');
    if (share) {
      var fresh = share.cloneNode(true);
      fresh.textContent = 'Analyse with AI';
      share.parentNode.replaceChild(fresh, share);
      fresh.addEventListener('click', runAnalysis);
    }
  }

  // ------------------------------------------------------------- AI analysis

  /**
   * Accuracy string that can never read 100% unless every decision was correct
   * (system prompt, Section 17). Adds precision until the text stops rounding up.
   */
  function accuracyText(correct, decisions) {
    if (!decisions) return '—';
    if (correct === decisions) return '100%';
    var pct = (correct / decisions) * 100;
    for (var dp = 1; dp <= 6; dp++) {
      var s = pct.toFixed(dp);
      if (Number(s) < 100) return s + '%';
    }
    return '99.999999%';
  }

  /** Rules metadata, so the model never has to assume a profile (Section 3). */
  function rulesProfile() {
    return {
      variant: 'European No Hole Card (ENHC)',
      decks: 6,
      dealerFirstCardOnly: true,
      dealerStandsOnSoft17: true,
      blackjackPays: '3:2',
      surrender: false,
      doubleAfterSplit: 'allowed except on split Aces',
      resplitAces: true,
      cardsPerSplitAce: 1,
      sideBets: ['Pairs', 'Trilux', 'Trilux Super'],
      shuffle: 'manual shuffle simulation',
      appVersion: APP_VERSION,
      strategyVersion: STRATEGY_VERSION,
      rulesProfileId: RULES_PROFILE,
      validatedStrategyMatrix: true,
      strategyNote:
        'Total-dependent basic strategy matrix, locked in the app. The trainer grades '
        + 'against this matrix only; no count-based deviations exist. '
        + 'Strategy HIP-ENHC-S17-v1 is the corrected Hippodrome ENHC profile. It '
        + 'fixes: (a) the multi-card soft fallback — where the chart says Double but '
        + 'Double is unavailable, the fallback is Stand for soft 18/19 and Hit for '
        + 'soft 13-17; (b) A,8 (Soft 19) now STANDS against every up-card, including '
        + '5 and 6, because under full-loss ENHC a doubled wager is also lost to a '
        + 'dealer natural; (c) A,7 (Soft 18) doubles vs 2-6; (d) A,A splits vs 2-10. '
        + 'Decisions in THIS session are graded by that profile and are genuine. '
        + 'Sessions carrying no strategyVersion field are LEGACY (v1.4.1 grading) and '
        + 'their Soft-19-vs-6 "mistakes" were the app\'s error, not the player\'s.',
    };
  }

  /** Structured context sent alongside the report text. */
  function buildContext() {
    var accuracy = accuracyText(state.correct, state.decisions);
    var liveState = typeof window.BJF_LIVE_STATE === 'function' ? window.BJF_LIVE_STATE() : null;

    // Deterministic financial reconciliation. Computed here from the same
    // snapshot the report is built from, so the model is told the answer
    // instead of estimating it from formatted currency strings.
    var mainPL = state.mainPL;
    var sideParts = { pairs: state.pairsPL, trilux: state.triluxPL, super: state.superPL };
    var sidePLsum = sideParts.pairs + sideParts.trilux + sideParts.super;
    var sessionPL = state.bankroll - state.start;
    var boxMainSum = Object.keys(state.boxStats || {}).reduce(function (n, k) {
      return n + (state.boxStats[k].mainPL || 0);
    }, 0);
    var delta = Math.round((mainPL + sidePLsum - sessionPL) * 100) / 100;
    var boxDelta = Math.round((boxMainSum - mainPL) * 100) / 100;

    var reconciliation = {
      verdict: (Math.abs(delta) < 0.005 && Math.abs(boxDelta) < 0.005) ? 'PASS' : 'FAIL',
      mainPL: mainPL,
      pairsPL: sideParts.pairs,
      triluxPL: sideParts.trilux,
      superPL: sideParts.super,
      sidePLTotal: sidePLsum,
      sessionPL: sessionPL,
      mainPlusSide: Math.round((mainPL + sidePLsum) * 100) / 100,
      differenceFromSessionPL: delta,
      sumOfBoxMainPL: boxMainSum,
      boxSumMinusMainPL: boxDelta,
      phase: state.phase,
      note: 'These figures are computed by the app from a single settled '
        + 'snapshot and are AUTHORITATIVE. Use this verdict for '
        + 'financial_reconciliation; do not recompute it from the text report, '
        + 'and do not report a mismatch that contradicts it.',
    };

    return {
      reconciliation: reconciliation,
      rulesProfile: rulesProfile(),
      mode: (window.BJF_MODE || 'practice'),
      modeNote: (window.BJF_MODE === 'live')
        ? 'LIVE TABLE session. The chart play was displayed before every decision, '
          + 'so these decisions are ASSISTED. Do not report this accuracy as evidence '
          + 'of unaided strategy knowledge; compare it only with other live sessions.'
        : 'PRACTICE session. No hints were shown; accuracy reflects unaided knowledge.',
      liveTelemetry: liveState,
      summary: {
        rounds: state.rounds,
        decisions: state.decisions,
        correct: state.correct,
        mistakes: state.mistakes.length,
        accuracy: accuracy,
        startBankroll: state.start,
        bankroll: state.bankroll,
        sessionPL: state.bankroll - state.start,
        mainPL: state.mainPL,
        sidePL: state.pairsPL + state.triluxPL + state.superPL,
        maxDrawdown: state.maxDrawdown,
        highBankroll: state.high,
        lowBankroll: state.low,
        totalMainStaked: state.totalMainStaked,
        totalSideStaked: state.totalSideStaked,
        longestWinStreak: state.longestWinStreak,
        longestLossStreak: state.longestLossStreak,
      },
      decisionMix: state.decisionMix,
      boxStats: state.boxStats,
      roundHistory: state.roundHistory,
      mistakes: state.mistakes,
      // Raw per-decision events take precedence over aggregates (Section 20).
      // Capped so a very long session cannot blow the request size.
      eventLog: (state.eventLog || []).slice(-400),
      eventLogTruncated: (state.eventLog || []).length > 400,
    };
  }

  function runAnalysis() {
    var btn = el('shareReportBtn');
    var report = el('analysisReport') ? el('analysisReport').value : '';

    if (!currentUser) { requireLogin(); return; }
    if (!report.trim() || !state.rounds) {
      renderMessage('Play at least one round before requesting an analysis.');
      return;
    }
    // Mid-round the main stakes have left the bankroll but have not been booked
    // into mainPL yet, so Session P/L cannot equal main + side. Analysing here
    // produces spurious "data integrity" failures. Finish the round first.
    if (state.phase === 'player' || state.phase === 'dealer') {
      renderMessage('Finish the current round first — mid-round the wagers are '
        + 'committed but not yet settled, so the figures cannot reconcile.');
      return;
    }
    // Guarantee the text report and the JSON context come from the same instant.
    if (typeof window.refreshAnalysis === 'function') window.refreshAnalysis();
    report = el('analysisReport') ? el('analysisReport').value : report;

    if (btn) { btn.disabled = true; btn.textContent = 'Analysing…'; }
    renderMessage('Sending this session to Gemini on Vertex AI…');

    // The session must exist server-side before it can be analysed.
    syncPending = true;
    api(API.sync, { method: 'POST', body: JSON.stringify(snapshot()) })
      .then(function () {
        syncPending = false;
        return api('/api/sessions/' + meta.sessionId + '/analyze', {
          method: 'POST',
          body: JSON.stringify({ reportText: report, context: buildContext() }),
        });
      })
      .then(function (res) {
        renderAnalysis(res.analysis);
        setStatus('ok', currentUser.username + ' · analysed');
        loadHistory();
      })
      .catch(function (err) {
        if (err.status === 401) { requireLogin(); return; }
        renderMessage('Analysis failed: ' + err.message +
          (err.body && err.body.analysisId ? ' (recorded as a failed attempt)' : ''));
        setStatus('err', 'Analysis failed');
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Analyse with AI'; }
      });
  }

  function renderMessage(msg) {
    var box = el('aiContent');
    if (box) { box.className = 'muted'; box.textContent = msg; }
  }

  function renderAnalysis(analysis) {
    var box = el('aiContent');
    if (!box) return;
    if (!analysis) {
      box.className = 'muted';
      box.textContent = 'Press “Analyse with AI” above after playing some rounds.';
      return;
    }

    var a = analysis.json || {};
    var html = '';

    html += '<div class="ai-head">';
    if (a.accuracy_display) {
      html += '<span class="ai-grade">' + escapeHTML(a.accuracy_display) + '</span>';
    }
    html += '<strong>' + escapeHTML(a.session_assessment || 'Session analysed') + '</strong></div>';

    // Reconciliation is a data-trust signal, so it gets its own badge.
    if (a.financial_reconciliation) {
      var raw = String(a.financial_reconciliation || '').toLowerCase();
      // Accept both the current PASS/FAIL vocabulary and the earlier wording.
      var kind = (raw === 'pass' || raw === 'reconciles') ? 'reconciles'
        : (raw === 'fail' || raw === 'failed') ? 'failed'
        : 'insufficient_data';
      var recLabel = kind === 'reconciles' ? 'Financial reconciliation: PASS'
        : kind === 'failed' ? 'Financial reconciliation: FAIL — treat figures as unreliable'
        : 'Financial reconciliation: insufficient data';
      html += '<div class="recon ' + kind + '">' + escapeHTML(recLabel) + '</div>';
    }

    if (analysis.text) {
      html += '<div class="ai-body">' + escapeHTML(analysis.text) + '</div>';
    }

    if (a.mistake_breakdown && a.mistake_breakdown.length) {
      html += '<div style="margin-top:14px"><strong style="font-size:.9rem">' +
        'Mistake breakdown</strong>';
      a.mistake_breakdown.forEach(function (m) {
        html += '<div class="leak"><b>' + escapeHTML(m.reference) + '</b>' +
          '<span>Strategy result: ' + escapeHTML(m.strategy_result) + '</span>' +
          '<span>Behavioural cause: ' + escapeHTML(m.behavioural_cause) + '</span>' +
          (m.note ? '<span>' + escapeHTML(m.note) + '</span>' : '') +
          '</div>';
      });
      html += '</div>';
    }

    if (a.data_integrity_flags && a.data_integrity_flags.length) {
      html += '<div class="integrity"><strong>Data integrity flags</strong><ul>';
      a.data_integrity_flags.forEach(function (f) {
        html += '<li>' + escapeHTML(f) + '</li>';
      });
      html += '</ul></div>';
    }

    var bits = [];
    if (analysis.model) bits.push('Model: ' + analysis.model);
    if (analysis.promptVersion || analysis.prompt_version) {
      bits.push('Prompt v' + (analysis.promptVersion || analysis.prompt_version));
    }
    if (analysis.totalTokens || analysis.total_tokens) {
      bits.push((analysis.totalTokens || analysis.total_tokens) + ' tokens');
    }
    if (analysis.latencyMs || analysis.latency_ms) {
      bits.push((analysis.latencyMs || analysis.latency_ms) + ' ms');
    }
    if (analysis.hadPreviousCheckpoint) bits.push('delta vs previous checkpoint');
    if (analysis.created_at) bits.push(fmtDate(analysis.created_at));
    if (bits.length) html += '<div class="ai-meta">' + escapeHTML(bits.join(' · ')) + '</div>';

    box.className = '';
    box.innerHTML = html;
  }

  // ----------------------------------------------------------------- history

  var SESSIONS_VISIBLE = 2;
  var sessionsExpanded = false;

  function loadHistory() {
    var list = el('historyList');
    if (!list) return;
    if (!currentUser) {
      list.className = 'muted';
      list.textContent = 'Sign in to view history.';
      return;
    }
    api(API.sessions).then(function (res) {
      var rows = res.sessions || [];
      if (!rows.length) {
        list.className = 'muted';
        list.textContent = 'No sessions stored yet. Play a round to create one.';
        return;
      }
      list.className = '';
      var shown = sessionsExpanded ? rows : rows.slice(0, SESSIONS_VISIBLE);
      var hiddenCount = rows.length - shown.length;
      list.innerHTML = shown.map(function (s) {
        var pl = (s.bankroll || 0) - (s.start_bankroll || 0);
        var acc = s.decisions ? (s.correct / s.decisions * 100).toFixed(1) + '%' : '—';
        var isCurrent = s.id === meta.sessionId;
        return '<div class="hist-row">' +
            '<div><strong>' + fmtDate(s.updated_at) + (isCurrent ? ' · current' : '') + '</strong>' +
              '<div class="sub">' + s.rounds + ' rounds · ' + acc + ' accuracy · ' +
                s.mistakes_count + ' mistakes · ' + s.analyses +
                (s.analyses === 1 ? ' AI analysis' : ' AI analyses') + '</div></div>' +
            '<span class="pl ' + (pl >= 0 ? 'up' : 'down') + '">' + money(pl) + '</span>' +
            '<button class="secondary small" data-session="' + escapeHTML(s.id) + '">View</button>' +
          '</div>';
      }).join('')
        + (hiddenCount > 0
            ? '<button type="button" class="secondary small hist-more" id="sessionsMore">'
              + 'View more (' + hiddenCount + ' earlier session'
              + (hiddenCount === 1 ? '' : 's') + ')</button>'
            : (sessionsExpanded && rows.length > SESSIONS_VISIBLE
                ? '<button type="button" class="secondary small hist-more" id="sessionsLess">Show less</button>'
                : ''));

      list.querySelectorAll('button[data-session]').forEach(function (b) {
        b.addEventListener('click', function () { viewSession(b.getAttribute('data-session')); });
      });
      var sm = el('sessionsMore');
      if (sm) sm.addEventListener('click', function () { sessionsExpanded = true; loadHistory(); });
      var sl = el('sessionsLess');
      if (sl) sl.addEventListener('click', function () { sessionsExpanded = false; loadHistory(); });
    }).catch(function (err) {
      if (err.status === 401) return requireLogin();
      list.className = 'muted';
      list.textContent = 'Could not load history: ' + err.message;
    });
  }

  function viewSession(id) {
    api('/api/sessions/' + id).then(function (detail) {
      var complete = (detail.analyses || []).filter(function (a) { return a.status === 'complete'; });
      if (!complete.length) {
        renderMessage('That session has no stored AI analysis yet.');
      } else {
        var a = complete[0];
        renderAnalysis({
          json: a.analysis_json,
          text: a.analysis_text,
          model: a.model,
          promptVersion: a.prompt_version,
          totalTokens: a.total_tokens,
          latencyMs: a.latency_ms,
          created_at: a.created_at,
        });
      }
      if (typeof window.BJF_SET_ROUND_LOG === 'function') {
        var rl = detail.session && detail.session.round_log_json
          ? JSON.parse(detail.session.round_log_json) : [];
        window.BJF_SET_ROUND_LOG(rl, 'stored session · ' + fmtDate(detail.session.updated_at));
      }
      el('aiPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      renderMessage('Could not load that session: ' + err.message);
    });
  }

  // -------------------------------------------------------------------- auth

  function requireLogin() {
    currentUser = null;
    setStatus('err', 'Signed out');
    el('cloudOverlay').classList.remove('hidden');
  }

  function onSignedIn(user, opts) {
    currentUser = user;
    el('cloudOverlay').classList.add('hidden');
    setStatus('ok', user.username);
    loadHistory();
    if (opts && opts.offerRestore) maybeRestore();
    if (syncPending) flushSync();
  }

  /**
   * Pulls the newest session from the other device. Only auto-applies when the
   * local session has no rounds, so an in-progress local session is never
   * silently overwritten.
   */
  function maybeRestore() {
    api(API.latest).then(function (res) {
      var remote = res.session;
      if (!remote || !remote.state) return;
      if (remote.id === meta.sessionId) return;
      if (!remote.state.rounds) return;

      if (state.rounds === 0) {
        applyRestore(remote);
      } else {
        showRestoreBanner(remote);
      }
    }).catch(function () { /* history is optional */ });
  }

  function applyRestore(remote) {
    /* global state, shoe, lastBets, makeShoe */
    // Assigning the game's global `let` bindings by bare name.
    state = remote.state;
    shoe = remote.shoe && remote.shoe.length ? remote.shoe : shoe;
    lastBets = remote.lastBets || [];

    // The game clears these on its own load path; mirror that exactly.
    state.phase = 'ready';
    state.dealer = [];
    state.boxes = [];

    meta.sessionId = remote.id;
    saveMeta(meta);
    if (typeof window.BJF_LOAD_ROUND_LOG === 'function') {
      window.BJF_LOAD_ROUND_LOG(remote.roundLog || [], remote.id);
    }

    if (typeof window.buildWagerCards === 'function') window.buildWagerCards();
    if (typeof window.updateUI === 'function') window.updateUI();
    if (typeof window.refreshAnalysis === 'function') window.refreshAnalysis();
    if (typeof window.saveSession === 'function') window.saveSession();

    var banner = el('cloudRestoreBanner');
    if (banner) banner.remove();
    setStatus('ok', currentUser.username + ' · restored');
  }

  function showRestoreBanner(remote) {
    if (el('cloudRestoreBanner')) return;
    var main = document.querySelector('main');
    var div = document.createElement('div');
    div.className = 'cloud-banner';
    div.id = 'cloudRestoreBanner';
    div.innerHTML =
      '<div>A newer session from another device is available — ' +
        remote.state.rounds + ' rounds, updated ' + fmtDate(remote.updatedAt) + '.' +
        '<div class="muted">Restoring replaces the session on this device.</div></div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="primary small" id="cloudRestoreYes">Restore</button>' +
        '<button class="secondary small" id="cloudRestoreNo">Keep this device</button></div>';
    main.insertBefore(div, main.firstChild);
    el('cloudRestoreYes').addEventListener('click', function () { applyRestore(remote); });
    el('cloudRestoreNo').addEventListener('click', function () { div.remove(); });
  }

  /** The About panel hard-codes a build string that nobody remembers to edit.
   *  Drive it from APP_VERSION so it can never disagree with what is running. */
  function stampBuild() {
    var slot = el('aboutVersion');
    if (slot) slot.textContent = APP_VERSION.replace(/^.*\bv/, 'v');
  }

  /* ------------------------------------------------------- ADD CAPITAL
   * Ram needs to top up mid-session, the way he would buy more chips at the
   * table. The trap is the accounting: Session P/L is bankroll - start, and
   * the AI's reconciliation FAILS unless main P/L + side P/L equals it. Adding
   * money to bankroll alone would read as a £X profit and flag a data-integrity
   * error on the next analysis.
   *
   * So a deposit shifts the whole baseline rather than the balance:
   *   start, bankroll, high, low, peakBankroll, roundStart  all += amount
   * Session P/L is then unchanged by the deposit (correct — capital is not
   * winnings), peakBankroll - bankroll is unchanged, so drawdown stays honest,
   * and every existing formula keeps working untouched. The deposits array is
   * the audit trail, and rides to D1 inside state_json automatically.
   */
  function addCapital(amount) {
    /* global state */
    amount = Math.round(Number(amount) * 100) / 100;
    if (!isFinite(amount) || amount <= 0) return { ok: false, why: 'Enter an amount above zero.' };
    // Mid-round the stakes have left the bankroll but are not yet settled, so a
    // deposit then would land in the middle of an unbalanced ledger.
    if (state.phase === 'player' || state.phase === 'dealer') {
      return { ok: false, why: 'Finish the current round before adding funds.' };
    }
    ['start', 'bankroll', 'high', 'low', 'peakBankroll', 'roundStart'].forEach(function (k) {
      if (typeof state[k] === 'number') state[k] += amount;
    });
    if (!Array.isArray(state.deposits)) state.deposits = [];
    state.deposits.push({ amount: amount, round: state.rounds, at: new Date().toISOString() });

    if (typeof window.updateUI === 'function') window.updateUI();
    if (typeof window.refreshAnalysis === 'function') window.refreshAnalysis();
    // saveSession is wrapped by this file, so this also queues the D1 sync.
    if (typeof window.saveSession === 'function') window.saveSession();
    return { ok: true, amount: amount, bankroll: state.bankroll };
  }
  window.BJF_ADD_CAPITAL = addCapital;

  /** Puts the control in Session controls, beside the reset bankroll field. */
  function injectCapitalControl() {
    if (el('addFundsBtn')) return;
    var startField = el('startBankroll');
    var grid = startField && startField.closest ? startField.closest('.controls-grid') : null;
    if (!grid) return;
    var label = document.createElement('label');
    label.className = 'field';
    label.innerHTML =
      '<span>Add funds to bankroll</span>' +
      '<div class="add-funds-row">' +
        '<input id="addFunds" type="number" inputmode="decimal" min="0" step="500" value="1000" />' +
        '<button type="button" id="addFundsBtn" class="secondary">Add</button>' +
      '</div>';
    grid.insertBefore(label, startField.closest('.field').nextSibling);

    var note = document.createElement('p');
    note.className = 'fine-print';
    note.id = 'addFundsNote';
    note.textContent = 'A top-up is capital, not winnings — Session P/L does not move.';
    grid.parentNode.insertBefore(note, grid.nextSibling);

    el('addFundsBtn').addEventListener('click', function () {
      var r = addCapital(el('addFunds').value);
      note.textContent = r.ok
        ? 'Added ' + fmtMoney(r.amount) + '. Bankroll is now ' + fmtMoney(r.bankroll)
          + '. Session P/L is unchanged — a top-up is capital, not winnings.'
        : r.why;
    });
  }

  function fmtMoney(n) {
    return (typeof money === 'function')
      ? money(n)
      : (n < 0 ? '-' : '') + '£' + Math.abs(Number(n) || 0).toLocaleString('en-GB');
  }

  function wireAuthUI() {
    el('cloudLoginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = el('cloudLoginBtn');
      var errBox = el('cloudLoginError');
      errBox.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'Signing in…';

      api(API.login, {
        method: 'POST',
        body: JSON.stringify({
          username: el('cloudUsername').value,
          password: el('cloudPassword').value,
        }),
      }).then(function (res) {
        el('cloudPassword').value = '';
        onSignedIn(res.user, { offerRestore: true });
      }).catch(function (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
    });

    el('cloudOfflineBtn').addEventListener('click', function () {
      el('cloudOverlay').classList.add('hidden');
      setStatus('', 'Offline — not saving');
    });

    el('cloudPill').addEventListener('click', function () {
      if (!currentUser) { requireLogin(); return; }
      if (!confirm('Sign out? Local play continues, but nothing will sync.')) return;
      api(API.logout, { method: 'POST' }).then(function () {
        currentUser = null;
        setStatus('', 'Signed out');
        loadHistory();
        el('cloudOverlay').classList.remove('hidden');
      });
    });

    el('aiRefreshBtn').addEventListener('click', function () {
      if (!currentUser) { requireLogin(); return; }
      viewSession(meta.sessionId);
    });
    el('histRefreshBtn').addEventListener('click', loadHistory);
  }

  // -------------------------------------------------------------------- boot

  // Live mode switches start a fresh session so live and practice data are
  // never blended in history or analysis.
  window.startNewCloudSession = function () {
    meta.sessionId = uuid();
    saveMeta(meta);
    if (typeof window.BJF_RESET_ROUND_LOG === 'function') window.BJF_RESET_ROUND_LOG(meta.sessionId);
    renderAnalysis(null);
    loadHistory();
  };

  function boot() {
    injectStyles();
    injectUI();
    stampBuild();
    injectCapitalControl();
    wireAuthUI();
    installHooks();

    // Retry a stalled sync when connectivity returns.
    window.addEventListener('online', function () { if (syncPending) flushSync(); });

    api(API.me)
      .then(function (res) { onSignedIn(res.user, { offerRestore: true }); })
      .catch(function (err) {
        if (err.status === 401) {
          el('cloudOverlay').classList.remove('hidden');
          setStatus('', 'Sign in to sync');
        } else {
          // No API reachable (opened as a bare file, or Worker down).
          setStatus('', 'Local only');
        }
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
