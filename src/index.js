// Cloudflare Worker: API for Ram's BJ Friend.
// Static assets (the app itself) are served by the [assets] binding; anything
// that isn't a file falls through to this fetch handler.

import {
  authenticate, verifyPassword, issueToken,
  sessionCookie, clearCookie,
} from './auth.js';
import * as repo from './repo.js';
import { analyseSession } from './vertex.js';
import { rowsForSession, toCSV, caveatsFor, COLUMNS } from './export.js';
import { ensureSchema, schemaReport } from './migrate.js';
import { buildDigests, buildStakingDigest, buildReportDigest,
         buildDeviationDigest } from './digest.js';
import { publishDigests } from './publish.js';

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(init.headers || {}),
  },
});

const error = (message, status = 400) => json({ error: message }, { status });

/** Cookies must not be marked Secure over plain-http localhost dev. */
const isSecure = (request) => new URL(request.url).protocol === 'https:';

/* Who may publish. The digests are read as one player's record, so the account
 * that writes them has to be fixed rather than "whoever is signed in". Username
 * comparison is case-insensitive because the users table is COLLATE NOCASE. */
/* Set while a publish is running, so a second one is refused rather than
 * interleaved. Module scope, so it lives as long as the isolate. */
/* Held as a TIMESTAMP, not a flag.
 *
 * A boolean plus finally looks sufficient and is not: when the runtime kills a
 * request for exceeding CPU, the finally never runs. The marker stayed set and
 * every later send on that isolate answered 409 "already running" — forever.
 * Twenty-five sends in a row showed it exactly: one 503, then nine straight
 * 409s that would only have cleared when the isolate recycled.
 *
 * A publish that has not finished in this long is not running any more. Ten
 * seconds, not ninety: a send takes under four, and the window is how long
 * publishing stays wedged after a request is killed. Ninety seconds of 409s is
 * a far worse failure than the overlap the lock exists to prevent — and an
 * overlap that does slip through is caught by the sha retry in publish.js
 * anyway. The drain is released before this, since it runs past the reply. */
const PUBLISH_LOCK_MS = 10_000;
let publishStartedAt = 0;
/* A deferred archive drain keeps running on this isolate after its reply has
 * gone, and it competes for the same CPU allowance as whatever arrives next.
 * A send landing on top of one is how an otherwise fine publish returned 503.
 * Counted, so a send can decline to add a drain while one is still going. */
let drainStartedAt = 0;

function publisherName(env) {
  return (env.PUBLISH_USER || 'ram').trim();
}
function canPublish(env, user) {
  return String(user?.username || '').trim().toLowerCase()
    === publisherName(env).toLowerCase();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // Not an API path — hand back to static assets.
      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : new Response('Not found', { status: 404 });
    }

    try {
      return await route(request, env, ctx, url);
    } catch (err) {
      console.error('Unhandled error:', err?.stack || err);
      return error(err?.message || 'Internal error', 500);
    }
  },
};

async function route(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  if (!env.DB) return error('D1 binding "DB" is not configured', 500);
  if (!env.AUTH_SECRET) return error('AUTH_SECRET is not configured', 500);

  // A database created by an earlier release is missing later columns; reconcile
  // before touching it. Cached per isolate, so this is one PRAGMA on a cold start.
  await ensureSchema(env.DB);

  // --- unauthenticated ------------------------------------------------------

  if (path === '/api/health' && method === 'GET') {
    const schema = await schemaReport(env.DB);
    return json({
      ok: schema.ok,
      llm: env.MOCK_LLM === '1' ? 'mock' : 'vertex-ai',
      model: env.VERTEX_MODEL || 'gemini-2.5-flash',
      appVersion: '1.4.9',
      schema,
    });
  }

  if (path === '/api/login' && method === 'POST') {
    const { username, password } = await request.json().catch(() => ({}));
    if (!username || !password) return error('Username and password are required', 400);

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ?'
    ).bind(String(username).trim()).first();

    // Same message and roughly the same work either way, so a wrong username
    // is indistinguishable from a wrong password.
    if (!user || !(await verifyPassword(String(password), user))) {
      return error('Invalid username or password', 401);
    }

    ctx.waitUntil(env.DB.prepare(
      "UPDATE users SET last_login_at = datetime('now') WHERE id = ?"
    ).bind(user.id).run());

    const token = await issueToken(user.id, env.AUTH_SECRET);
    return json(
      { ok: true, user: { id: user.id, username: user.username, canPublish: canPublish(env, user) } },
      { headers: { 'Set-Cookie': sessionCookie(token, { secure: isSecure(request) }) } }
    );
  }

  if (path === '/api/logout' && method === 'POST') {
    return json(
      { ok: true },
      { headers: { 'Set-Cookie': clearCookie({ secure: isSecure(request) }) } }
    );
  }

  // --- everything below requires a session ---------------------------------

  const user = await authenticate(request, env);
  if (!user) return error('Not authenticated', 401);

  if (path === '/api/me' && method === 'GET') {
    return json({ user: { ...user, canPublish: canPublish(env, user) } });
  }

  // Persist a session snapshot. Called after every settled round.
  if (path === '/api/sessions/sync' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.sessionId || !body?.state) {
      return error('sessionId and state are required', 400);
    }
    try {
      const result = await repo.syncSession(env.DB, user.id, {
        sessionId: String(body.sessionId),
        deviceId: body.deviceId,
        appVersion: body.appVersion,
        mode: body.mode,
        state: body.state,
        shoe: body.shoe,
        lastBets: body.lastBets,
        // A current phone sends newRounds; an older build still sends its whole
        // roundLog. Either way only rounds the server lacks are taken.
        newRounds: body.newRounds,
        roundLog: body.roundLog,
        strategyVersion: body.strategyVersion,
        rulesProfileId: body.rulesProfileId,
      });
      return json({ ok: true, ...result });
    } catch (err) {
      if (err && err.status) return error(err.message, err.status);
      throw err;
    }
  }

  // Most recent session across devices, for resume-on-login.
  if (path === '/api/sessions/latest' && method === 'GET') {
    /* ?tail=N is what a current phone asks for: it keeps only recent rounds,
       because the server holds the rest. An older build asks without it and
       treats what it gets as the whole history — so it must still get the whole
       history, or it would believe its log had shrunk.
       Built without parsing anything large: see repo.latestSessionText. */
    const tail = Number(url.searchParams.get('tail'));
    const text = await repo.latestSessionText(env.DB, user.id,
      Number.isInteger(tail) && tail > 0 ? tail : null);
    if (!text) return json({ session: null });
    // Same headers as json(): no-store matters — a cached copy of this is
    // exactly the stale game this endpoint exists to prevent.
    return new Response(text, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // Raw event-log export. CSV for spreadsheets, JSON for tooling.
  //   /api/export/rounds.csv            all sessions
  //   /api/export/rounds.csv?session=ID one session
  //   /api/export/rounds.json           same data plus caveats
  if (path.startsWith('/api/export/rounds') && method === 'GET') {
    const wantCsv = path.endsWith('.csv');
    const only = url.searchParams.get('session');
    const sessions = await repo.exportSessions(env.DB, user.id, only);

    const rows = sessions.flatMap((s) => rowsForSession(s));
    const caveats = caveatsFor(sessions);

    if (wantCsv) {
      // Leading caveats as CSV comments so they travel with the file.
      const header = caveats.length
        ? caveats.map((c) => '# ' + c.replace(/[\r\n]+/g, ' ')).join('\r\n') + '\r\n'
        : '';
      return new Response('\uFEFF' + header + toCSV(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bj-friend-rounds.csv"',
          'Cache-Control': 'no-store',
        },
      });
    }
    return json({
      columns: COLUMNS,
      sessions: sessions.length,
      rows: rows.length,
      caveats,
      data: rows,
    });
  }

  // Compact, model-readable summaries of stored play. These are what get
  // published to the repository for ChatGPT to read: the full CSV is too large
  // for it to consume, these are not.
  if (path === '/api/digests' && method === 'GET') {
    const sessions = await repo.exportSessions(env.DB, user.id, null);
    const generatedAt = new Date().toISOString();
    const digests = buildDigests(sessions, { generatedAt, appVersion: '1.4.9' });
    // Everything the publish button writes, so what will be published can be
    // inspected without publishing it.
    return json({
      ...digests,
      staking: buildStakingDigest(sessions, { generatedAt }),
      reports: buildReportDigest(sessions, { generatedAt }),
      deviations: buildDeviationDigest(sessions, { generatedAt }),
    });
  }

  // Pushes the digests to the repository Ram's ChatGPT already reads.
  //
  // One account only. The published files are read as "Ram's play", so a test
  // account publishing two rounds at 40% accuracy describes him as a beginner —
  // which is exactly what happened once. The button is hidden for everyone else,
  // but the button is a courtesy and this check is the actual rule.
  if (path === '/api/publish' && method === 'POST') {
    if (!canPublish(env, user)) {
      return error('Only ' + publisherName(env) + ' can publish gameplay data. '
        + 'These files are read as that account\'s record.', 403);
    }
    /* ONE PUBLISH AT A TIME.
     *
     * Publishing used to be a button press, so two could not overlap. Now the
     * shoe-end publish fires on its own, and it can start while he presses Send
     * now, or two shoe ends can land close together, or a second tab can be
     * open. Two runs interleaving is what produced the 409 Ram saw — both read
     * the same sha, the slower one writes against a file that has already moved.
     *
     * The retry in publish.js recovers from that; this stops it happening. The
     * lock is per isolate rather than global, which is the honest limit: it
     * catches the overlapping-tab and auto-plus-manual cases that actually
     * occur, not two requests landing in different Cloudflare colos at once.
     */
    if (publishStartedAt && (Date.now() - publishStartedAt) < PUBLISH_LOCK_MS) {
      return json({
        ok: false,
        error: 'A send is already running. It will finish on its own — '
          + 'nothing is lost.',
      }, { status: 409 });
    }
    publishStartedAt = Date.now();
    try {
      /* ?backlog=0 is the automatic send: digests only, so Ram is not waiting
         half a minute between shoes. Send now does the archive too. */
      const url2 = new URL(request.url);
      const backlog = url2.searchParams.get('backlog') !== '0';
      const result = await publishDigests(env, user.id, {
        appVersion: '1.4.9',
        backlog,
        // Lets the archive finish after the reply has gone, so Ram is not
        // waiting on fifteen seconds of raw-shoe writes he did not ask for.
        // Never more than one drain at a time, and never while another is
        // still going — the queue is recorded, so skipping one simply means it
        // happens on the next press instead of fighting for the same CPU.
        waitUntil: (drainStartedAt && (Date.now() - drainStartedAt) < PUBLISH_LOCK_MS)
          ? null
          : (pr) => {
            drainStartedAt = Date.now();
            ctx.waitUntil(pr.finally(() => { drainStartedAt = 0; }));
          },
      });
      return json(result);
    } catch (err) {
      console.error('Publish failed:', err?.stack || err);
      return json({ ok: false, error: err?.message || 'Publish failed' }, { status: 502 });
    } finally {
      publishStartedAt = 0;                     // released however it ended
    }
  }

  // The side-bet staking verdict across every session, not just the device in
  // hand. The panel falls back to computing locally when this cannot be reached,
  // so signing out narrows the answer rather than removing it.
  if (path === '/api/staking' && method === 'GET') {
    const sessions = await repo.exportSessions(env.DB, user.id, null);
    return json(buildStakingDigest(sessions, { generatedAt: new Date().toISOString() }));
  }

  if (path === '/api/sessions' && method === 'GET') {
    const { results } = await repo.listSessions(env.DB, user.id);
    return json({ sessions: results ?? [] });
  }

  if (path === '/api/analyses' && method === 'GET') {
    const { results } = await repo.listAnalyses(env.DB, user.id);
    return json({
      analyses: (results ?? []).map((a) => ({
        ...a,
        analysis_json: a.analysis_json ? JSON.parse(a.analysis_json) : null,
      })),
    });
  }

  // /api/sessions/:id  and  /api/sessions/:id/analyze
  const sessionMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(\/analyze)?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const isAnalyze = Boolean(sessionMatch[2]);

    if (!isAnalyze && method === 'GET') {
      const detail = await repo.getSession(env.DB, user.id, sessionId);
      if (!detail) return error('Session not found', 404);
      return json(detail);
    }

    if (isAnalyze && method === 'POST') {
      return analyzeHandler(request, env, user, sessionId);
    }
  }

  return error('Not found', 404);
}

/**
 * Captures the shared report, sends it to Vertex AI, and persists the result.
 * The analysis row is written whether the model succeeds or fails, so every
 * attempt is auditable.
 */
async function analyzeHandler(request, env, user, sessionId) {
  const body = await request.json().catch(() => ({}));
  const reportText = String(body.reportText || '').trim();
  if (!reportText) return error('reportText is required', 400);

  // The session must already have been synced — that is what ties the shared
  // report to stored gameplay data.
  const owned = await repo.ownsSession(env.DB, user.id, sessionId);
  if (!owned) return error('Session not found. Play at least one round first.', 404);

  // Captured before the new report is stored, so it really is the *previous* one.
  const previousCheckpoint = await repo.previousCheckpoint(env.DB, sessionId);

  const sharedReportId = crypto.randomUUID();
  await repo.saveSharedReport(env.DB, {
    id: sharedReportId,
    sessionId,
    userId: user.id,
    reportText,
    context: body.context,
  });

  const analysisId = crypto.randomUUID();
  try {
    const result = await analyseSession(env, {
      reportText,
      context: body.context,
      previousCheckpoint,
    });

    await repo.recordAnalysis(env.DB, {
      id: analysisId,
      sessionId,
      sharedReportId,
      userId: user.id,
      status: 'complete',
      model: result.model,
      promptVersion: result.promptVersion,
      analysisText: result.text,
      analysisJson: result.json,
      promptTokens: result.promptTokens,
      candidateTokens: result.candidateTokens,
      totalTokens: result.totalTokens,
      latencyMs: result.latencyMs,
    });

    return json({
      ok: true,
      analysis: {
        id: analysisId,
        sharedReportId,
        status: 'complete',
        model: result.model,
        promptVersion: result.promptVersion,
        text: result.text,
        json: result.json,
        totalTokens: result.totalTokens,
        latencyMs: result.latencyMs,
        hadPreviousCheckpoint: Boolean(previousCheckpoint),
      },
    });
  } catch (err) {
    const message = err?.message || 'Analysis failed';
    console.error('Vertex analysis failed:', err?.stack || err);

    await repo.recordAnalysis(env.DB, {
      id: analysisId,
      sessionId,
      sharedReportId,
      userId: user.id,
      status: 'error',
      model: env.VERTEX_MODEL || 'gemini-2.5-flash',
      errorMessage: message,
    });

    return json(
      { ok: false, error: message, analysisId, sharedReportId },
      { status: 502 }
    );
  }
}
