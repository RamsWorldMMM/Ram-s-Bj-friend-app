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
      appVersion: '1.4.6',
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
      { ok: true, user: { id: user.id, username: user.username } },
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
    return json({ user });
  }

  // Persist a session snapshot. Called after every settled round.
  if (path === '/api/sessions/sync' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.sessionId || !body?.state) {
      return error('sessionId and state are required', 400);
    }
    const result = await repo.syncSession(env.DB, user.id, {
      sessionId: String(body.sessionId),
      deviceId: body.deviceId,
      appVersion: body.appVersion,
      mode: body.mode,
      state: body.state,
      shoe: body.shoe,
      lastBets: body.lastBets,
      roundLog: body.roundLog,
      roundLogMeta: body.roundLogMeta,
      strategyVersion: body.strategyVersion,
      rulesProfileId: body.rulesProfileId,
    });
    return json({ ok: true, ...result });
  }

  // Most recent session across devices, for resume-on-login.
  if (path === '/api/sessions/latest' && method === 'GET') {
    const row = await repo.latestSession(env.DB, user.id);
    if (!row) return json({ session: null });
    return json({
      session: {
        id: row.id,
        updatedAt: row.updated_at,
        deviceId: row.device_id,
        state: row.state_json ? JSON.parse(row.state_json) : null,
        shoe: row.shoe_json ? JSON.parse(row.shoe_json) : [],
        lastBets: row.last_bets_json ? JSON.parse(row.last_bets_json) : [],
        roundLog: row.round_log_json ? JSON.parse(row.round_log_json) : [],
      },
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
