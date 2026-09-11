// Gemini on Vertex AI, called directly from a Cloudflare Worker.
//
// Vertex needs a Google OAuth2 access token. There is no googleapis SDK that
// runs on Workers, so we mint a service-account JWT with Web Crypto and
// exchange it ourselves. Tokens are cached in the isolate until they expire.

import { SYSTEM_PROMPT, RESPONSE_SCHEMA, PROMPT_VERSION } from './prompt.js';

const enc = new TextEncoder();

let cachedToken = null; // { token, expiresAt } — per-isolate, best-effort

function b64url(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

function credentials(env) {
  if (!env.GCP_SERVICE_ACCOUNT_JSON) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON secret is not configured');
  }
  try {
    return JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
}

async function postToken(tokenUri, params, kind) {
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}, ${kind}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Obtains a cloud-platform access token. Two credential shapes are accepted:
 *
 *   service_account  — the production path. An RS256 JWT is minted here and
 *                      exchanged for a token. Not tied to any human account.
 *   authorized_user  — gcloud ADC (`gcloud auth application-default login`).
 *                      Handy for testing with credentials you already have,
 *                      but it is a personal refresh token: it can be revoked
 *                      when the password changes and it carries your own IAM
 *                      rights, so prefer a service account for deployment.
 */
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const creds = credentials(env);
  const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token';

  if (creds.type === 'authorized_user') {
    if (!creds.refresh_token || !creds.client_id || !creds.client_secret) {
      throw new Error('authorized_user credentials need refresh_token, client_id and client_secret');
    }
    const data = await postToken(tokenUri, {
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    }, 'authorized_user');
    cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) };
    return cachedToken.token;
  }

  if (creds.type && creds.type !== 'service_account') {
    throw new Error(`Unsupported credential type "${creds.type}"`);
  }
  if (!creds.private_key || !creds.client_email) {
    throw new Error('service_account credentials need private_key and client_email');
  }

  const sa = creds;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`)
  );
  const assertion = `${header}.${claims}.${b64url(signature)}`;

  const data = await postToken(tokenUri, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }, 'service_account');

  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

/** Assembles the user turn: report text, structured context, prior checkpoint. */
function buildUserPrompt({ reportText, context, previousCheckpoint }) {
  const parts = [
    'Session report produced by the trainer:',
    '',
    reportText,
    '',
    'Structured session context (JSON). Raw events are under `eventLog` and take '
      + 'precedence over the aggregates per Section 20. The `reconciliation` block '
      + 'is computed by the application from a single settled snapshot and is '
      + 'AUTHORITATIVE for Section 9 — copy its `verdict` into '
      + '`financial_reconciliation` and do NOT recompute the arithmetic yourself '
      + 'from the formatted currency strings in the text report:',
    JSON.stringify(context ?? {}, null, 2),
  ];

  if (previousCheckpoint) {
    parts.push(
      '',
      'PREVIOUS CHECKPOINT for this same continuing session. Per Section 7, compute '
        + 'the delta and populate `latest_segment`:',
      JSON.stringify(previousCheckpoint, null, 2)
    );
  } else {
    parts.push(
      '',
      'No previous checkpoint exists for this session — this is the first analysis. '
        + 'Return an empty string for `latest_segment`.'
    );
  }

  return parts.join('\n');
}

/**
 * Runs the session report through Gemini and returns structured insights.
 * Set MOCK_LLM=1 to exercise the full pipeline without GCP credentials.
 */
export async function analyseSession(env, { reportText, context, previousCheckpoint }) {
  const model = env.VERTEX_MODEL || 'gemini-2.5-flash';
  const started = Date.now();

  if (env.MOCK_LLM === '1' || env.MOCK_LLM === 'true') {
    return mockAnalysis(model, started, context, previousCheckpoint);
  }

  const project = env.GCP_PROJECT_ID;
  const location = env.VERTEX_LOCATION || 'us-central1';
  if (!project || project.startsWith('REPLACE_WITH')) {
    throw new Error('GCP_PROJECT_ID is not configured');
  }

  const token = await getAccessToken(env);
  const endpoint =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:generateContent`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        role: 'user',
        parts: [{ text: buildUserPrompt({ reportText, context, previousCheckpoint }) }],
      }],
      generationConfig: {
        temperature: 0.2,          // analysis should be reproducible, not creative
        // Gemini 2.5 thinks by default and thinking tokens are drawn from this
        // same budget, so it must cover reasoning AND the JSON answer. Too low
        // and the response is truncated mid-object, which fails to parse.
        maxOutputTokens: Number(env.VERTEX_MAX_OUTPUT_TOKENS) || 12000,
        thinkingConfig: {
          thinkingBudget: Number(env.VERTEX_THINKING_BUDGET ?? 4096),
        },
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Vertex AI request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const finish = candidate?.finishReason;
  const text = candidate?.content?.parts?.map((p) => p.text).join('') ?? '';
  const usage = data.usageMetadata || {};

  if (!text) {
    if (finish === 'MAX_TOKENS') {
      throw new Error(
        `Vertex AI hit the token ceiling before answering (thinking used `
        + `${usage.thoughtsTokenCount ?? '?'} tokens). Raise VERTEX_MAX_OUTPUT_TOKENS `
        + 'or lower VERTEX_THINKING_BUDGET.'
      );
    }
    throw new Error(`Vertex AI returned no analysis (${finish || 'no candidates returned'})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A truncated response is the usual cause, and it is fixable by config.
    throw new Error(
      finish === 'MAX_TOKENS'
        ? 'Vertex AI response was truncated mid-JSON. Raise VERTEX_MAX_OUTPUT_TOKENS.'
        : `Vertex AI returned malformed JSON (finishReason: ${finish || 'unknown'})`
    );
  }
  return {
    model,
    promptVersion: PROMPT_VERSION,
    json: parsed,
    text: renderAnalysis(parsed),
    promptTokens: usage.promptTokenCount ?? null,
    candidateTokens: usage.candidatesTokenCount ?? null,
    totalTokens: usage.totalTokenCount ?? null,
    latencyMs: Date.now() - started,
  };
}

/** Flattens the structured analysis into the Section 18 layout. */
export function renderAnalysis(a) {
  const lines = ['SESSION ASSESSMENT', ''];
  if (a.session_assessment) lines.push(a.session_assessment, '');
  if (a.strategy) lines.push('Strategy:', a.strategy, '');
  if (a.mistakes) lines.push('Mistakes:', a.mistakes, '');
  if (a.financial) lines.push('Financial:', a.financial, '');
  if (a.risk) lines.push('Risk:', a.risk, '');
  if (a.latest_segment) lines.push('Latest segment:', a.latest_segment, '');
  if (a.next_focus) lines.push('Next focus:', a.next_focus);
  return lines.join('\n').trim();
}

function mockAnalysis(model, started, context, previousCheckpoint) {
  const s = context?.summary ?? {};
  const json = {
    session_assessment:
      `Mock analysis of ${s.rounds ?? 0} round(s). MOCK_LLM is enabled, so no Vertex AI `
      + 'call was made; this proves the capture → store → analyse → persist pipeline.',
    strategy: `Placeholder strategy commentary. Accuracy as supplied: ${s.accuracy ?? '—'}.`,
    mistakes: `Placeholder mistake commentary. ${s.mistakes ?? 0} recorded.`,
    financial: `Placeholder financial commentary. Main P/L ${s.mainPL ?? 0}, side P/L ${s.sidePL ?? 0}.`,
    risk: `Placeholder risk commentary. True maximum drawdown ${s.maxDrawdown ?? 0}.`,
    latest_segment: previousCheckpoint
      ? `Previous checkpoint had ${previousCheckpoint.rounds} rounds; this one has ${s.rounds}.`
      : '',
    next_focus: 'Disable MOCK_LLM and configure Vertex credentials for real analysis.',
    accuracy_display: s.accuracy ?? '—',
    financial_reconciliation: 'insufficient_data',
    mistake_breakdown: (context?.mistakes ?? []).slice(0, 3).map((m, i) => ({
      reference: `Round ${m.round}, Box ${m.box} — ${m.label} vs ${m.dealer}`,
      strategy_result: 'Incorrect',
      behavioural_cause: 'Unknown',
      note: `Placeholder entry ${i + 1}; cause unconfirmed.`,
    })),
    data_integrity_flags: [],
  };
  return {
    model: `${model} (mock)`,
    promptVersion: PROMPT_VERSION,
    json,
    text: renderAnalysis(json),
    promptTokens: null,
    candidateTokens: null,
    totalTokens: null,
    latencyMs: Date.now() - started,
  };
}
