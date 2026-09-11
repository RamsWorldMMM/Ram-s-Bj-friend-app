# Ram's BJ Friend — Cloudflare + D1 + Vertex AI

Adds durable storage, cross-device sync, and automated AI session analysis to
the existing trainer. **No game rule, strategy matrix, or settlement behaviour
was changed** — see [Guarantee: game logic is untouched](#guarantee-game-logic-is-untouched).

---

## What it does

| Requirement | How |
|---|---|
| Store all session data in SQLite | Cloudflare **D1**; full schema in `schema.sql` |
| Capture and retain shared-session data | `shared_reports` — the exact report text, every time |
| Send session data to the LLM automatically | Worker calls **Gemini on Vertex AI**; the old Share button is now **Analyse with AI** |
| Store the analysis with its session | `ai_analyses`, linked to both the session and the shared report |
| Maintain retrievable history | `GET /api/sessions`, `/api/sessions/:id`, plus a **Session history** panel in the app |
| Suitable for Cloudflare | Single Worker + static assets + D1. No servers, no containers |

Manual copy-paste into ChatGPT is gone: press one button, the report is stored,
sent to Vertex, and the insights are saved and rendered in the app.

---

## Architecture

```
Browser (public/index.html + cloud.js)
   │  localStorage = live gameplay state (unchanged, still works offline)
   │
   ├── POST /api/sessions/sync        after every settled round
   ├── POST /api/sessions/:id/analyze on "Analyse with AI"
   └── GET  /api/sessions             history
   │
   ▼
Cloudflare Worker (src/index.js)
   ├── auth.js    PBKDF2 passwords, HMAC-signed HttpOnly cookie
   ├── repo.js    all D1 queries, scoped by user_id
   ├── prompt.js  the analysis agent's system prompt + response schema
   └── vertex.js  service-account JWT → OAuth token → Gemini generateContent
   │
   ├──► D1 (SQLite)
   └──► Vertex AI (Gemini)
```

**Local-first.** localStorage stays the source of truth during play, so the game
never blocks on the network. D1 is a durable mirror. If a sync fails the client
stays dirty and retries on the next settled round or when `online` fires.

### Files

| File | Purpose |
|---|---|
| `rams_bj_friend_…-18.html` | **The original, untouched.** Kept as the reference for diffing |
| `public/index.html` | The app. Identical to the original + 4 lines loading `cloud.js` |
| `public/cloud.js` | Auth, sync, AI trigger, history UI. All additive |
| `src/index.js` | Worker router; serves `/api/*`, everything else is a static asset |
| `src/auth.js` | Password hashing, token issue/verify, cookies |
| `src/repo.js` | D1 data access |
| `src/prompt.js` | System prompt (v1.0) + Vertex response schema |
| `src/vertex.js` | Vertex AI client |
| `schema.sql` | Full database schema |
| `scripts/create-user.mjs` | Creates/rotates an account |

---

## Database

Six tables (`schema.sql`):

- **`users`** — PBKDF2-SHA256 (210k iterations), per-user random salt
- **`sessions`** — headline figures denormalised for fast lists, plus `state_json`,
  `shoe_json`, `last_bets_json` so any device resumes exactly where another stopped
- **`rounds`** — one row per round, `UNIQUE(session_id, round_no)`
- **`mistakes`** — one row per mistake, `UNIQUE(session_id, seq)`
- **`shared_reports`** — captured report text + context snapshot
- **`ai_analyses`** — status, model, prompt version, structured JSON, raw text,
  token counts, latency. **Failed attempts are recorded too**, so every call is auditable

The `UNIQUE` constraints make sync idempotent: the client can re-POST the whole
session after every round and rows are never duplicated.

---

## Setup

### 1. Create the database

```bash
npm install
npx wrangler d1 create rams-bj-friend
```

Paste the returned `database_id` into `wrangler.toml`, then apply the schema:

```bash
npm run db:migrate:remote
```

### 2. Secrets

```bash
# Signs session cookies — any random 32+ byte string
openssl rand -base64 32 | npx wrangler secret put AUTH_SECRET

# The full service-account JSON key, pasted verbatim
npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON
```

Set `GCP_PROJECT_ID` in `wrangler.toml` (it's an identifier, not a secret).

### 3. Google Cloud

1. Enable the **Vertex AI API** on the project.
2. Create a service account with role **Vertex AI User** (`roles/aiplatform.user`).
3. Create a **JSON key** and feed it to the `GCP_SERVICE_ACCOUNT_JSON` secret above.

```bash
PROJECT=tryonme-20260731
gcloud iam service-accounts create bjf-vertex --project "$PROJECT"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:bjf-vertex@$PROJECT.iam.gserviceaccount.com" \
  --role roles/aiplatform.user
gcloud iam service-accounts keys create /tmp/bjf-key.json \
  --iam-account "bjf-vertex@$PROJECT.iam.gserviceaccount.com"

npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON < /tmp/bjf-key.json
rm /tmp/bjf-key.json
```

No SDK is used — the Worker mints an RS256 JWT with Web Crypto and exchanges it
for an access token, which is cached in the isolate until it expires.

#### Credential types

`GCP_SERVICE_ACCOUNT_JSON` accepts either shape:

| Type | Use |
|---|---|
| `service_account` | **Production.** Not tied to a person; won't break when a password changes |
| `authorized_user` | gcloud ADC (`~/.config/gcloud/application_default_credentials.json`). Convenient for local testing with credentials you already have |

`authorized_user` is a *personal* refresh token carrying your own IAM rights, and
it can be revoked by a password change or a 
policy timeout. Fine on your machine; use a service account for the deployed Worker.

### 4. Create your accounts

```bash
npm run user:create -- --username ram --password 'your-password' --remote
```

Re-running with the same username rotates that password. Run it once per person;
both your devices sign into the **same** account to share data.

### 5. Deploy

```bash
npm run deploy
```

---

## Local development

```bash
cp .dev.vars.example .dev.vars     # already contains MOCK_LLM="1"
npm run db:migrate:local
npm run user:create -- --username ram --password 'testpass123' --local
npm run dev                        # http://127.0.0.1:8787
```

`MOCK_LLM="1"` runs the **entire** pipeline — capture, store, analyse, persist,
render — without calling Vertex or spending tokens.

To test against **real Vertex** using the gcloud credentials already on this
machine, `.dev.vars` needs `MOCK_LLM="0"` plus your ADC file as the credential:

```bash
python3 - <<'EOF'
import json
adc = json.load(open('/home/mango213/.config/gcloud/application_default_credentials.json'))
with open('.dev.vars', 'a') as f:
    f.write("\nMOCK_LLM=\"0\"\nGCP_PROJECT_ID=\"tryonme-20260731\"\n")
    f.write("GCP_SERVICE_ACCOUNT_JSON='" + json.dumps(adc) + "'\n")
EOF
```

`.dev.vars` is gitignored, but it now holds a real refresh token — keep it local.

### Response latency

Real analyses took **25–45 seconds** and ~20–28k tokens, most of it thinking.
That is a long wait behind a button press. If it feels slow, lower
`VERTEX_THINKING_BUDGET` (e.g. `1024`) in `wrangler.toml` — faster and cheaper,
at some cost to analysis depth. Setting it to `0` disables thinking entirely.

---

## The AI analysis

`src/prompt.js` holds the analysis agent's system prompt verbatim (v1.0) and the
response schema. Vertex is called with `responseMimeType: application/json` and a
`responseSchema`, so the model **cannot** return unparseable output. Temperature
is 0.2 — analysis should be reproducible, not creative.

The schema mirrors the prompt's Section 18 structure: `session_assessment`,
`strategy`, `mistakes`, `financial`, `risk`, `latest_segment`, `next_focus`, plus
`accuracy_display`, `financial_reconciliation`, a two-layer `mistake_breakdown`
(strategy result + behavioural cause, per Section 5) and `data_integrity_flags`.

What gets sent:

- the report text (exactly what used to be pasted into ChatGPT)
- structured context: summary, decision mix, box stats, round history, mistakes
- **raw `eventLog`** — per-decision events, so Section 20 can prefer raw data over
  aggregates (capped at the last 400, with a `eventLogTruncated` flag)
- an explicit **`rulesProfile`** so Section 3 never has to assume the rules
- the **previous checkpoint** for the same session, when one exists, so Section 7
  can compute the latest-segment delta

Accuracy is formatted client-side so an imperfect score can never round to 100%
(Section 17): it adds decimal places until the string is genuinely below 100.

Changing the prompt: edit `src/prompt.js` and bump `PROMPT_VERSION`. It's stored
on every row, so you can tell which revision produced which analysis.

---

## API

All routes except `/api/health` and `/api/login` require the session cookie.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + which LLM mode is active |
| POST | `/api/login` | `{username, password}` → HttpOnly cookie |
| POST | `/api/logout` | Clears the cookie |
| GET | `/api/me` | Current user |
| POST | `/api/sessions/sync` | Upsert session + append rounds/mistakes |
| GET | `/api/sessions/latest` | Newest session, for cross-device resume |
| GET | `/api/sessions` | History list |
| GET | `/api/sessions/:id` | Session + rounds + mistakes + analyses |
| POST | `/api/sessions/:id/analyze` | Capture report → Vertex → persist |
| GET | `/api/analyses` | All completed analyses |

Security: HttpOnly + SameSite=Lax + Secure cookies (Lax blocks cross-site POSTs,
so no CSRF token is needed); PBKDF2 password storage; constant-time comparison on
both password and token checks; identical error text and work for a wrong username
vs a wrong password; every query scoped by `user_id`.

---

## Guarantee: game logic is untouched

`public/index.html` differs from the original by exactly four lines — a comment
and a `<script src="/cloud.js" defer>` tag, after the closing `</script>`:

```bash
diff rams_bj_friend_v1_4_1_speed_flow_cards_steppers-18.html public/index.html
```

`cloud.js` never edits the game script. It attaches from outside:

- `window.saveSession` is **wrapped** — the original runs first, then a sync is
  queued. `settleRound` calls it unqualified, so the wrapper is picked up.
- `window.resetSession` is wrapped to mint a new cloud session id, leaving the
  previous session intact in the database.
- The Share button node is **cloned and replaced**, which drops its original
  listener without touching the source.
- `state` / `shoe` / `lastBets` are top-level `let` bindings in the shared global
  lexical environment, so they are read by name — and only written during an
  explicit cross-device restore.

This was verified by running the original and the deployed app side by side and
comparing **11,756 cases**, all identical:

| Check | Cases |
|---|---|
| `HARD`, `SOFT`, `PAIRS`, `DEALER_ORDER`, `CUT_CARDS_REMAINING` | exact match |
| `recommendedAction` over every 2-card hand × dealer up-card, plus multi-card soft hands | 2,366 |
| `handTotal` / `isBlackjack` / `handLabel`, 2- and 3-card | 2,366 |
| `pairOutcome` / `triluxOutcome` / `superOutcome` | 4,901 |
| `settleHand` over every player/dealer/blackjack/bust permutation | 2,116 |
| Shoe size and composition | exact match |

---

## Operations

```bash
npm run tail                                          # live logs
npx wrangler d1 execute rams-bj-friend --remote \
  --command "SELECT COUNT(*) FROM ai_analyses;"       # query production
```

Failed Vertex calls return HTTP 502 with the reason and are written to
`ai_analyses` with `status='error'`, so nothing fails silently.

**Cost.** D1 and Workers sit inside the free tier at personal-use volumes. Vertex
is billed per token; each analysis is one request and only fires when you press
the button. `gemini-2.5-flash` is the default — change `VERTEX_MODEL` in
`wrangler.toml` for a different tier.
