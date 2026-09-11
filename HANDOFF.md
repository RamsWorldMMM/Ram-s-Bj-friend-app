# Developer handoff — deploying to Cloudflare

> ### Running the tests
>
> ```
> npm test            # export/grain suite — no server, no credentials needed
> npm run test:browser -- http://127.0.0.1:8787/     # needs BJF_PASS
> ```
>
> The browser suite signs in, so it reads the password from the environment:
>
> ```
> BJF_PASS='<your local password>' npm run test:browser -- http://127.0.0.1:8787/
> ```
>
> It is deliberately **not** defaulted in source. The local dev account shares a
> password with production, and this repository is version controlled.
>

> **This build is v1.4.6.** Presentation-only change on top of v1.4.5. No schema
> change, no migration, no game-logic change (`public/index.html` is byte-identical
> to v1.4.5).
>
> ### What changed in v1.4.6
>
> **Fixes a mis-tap bug Ram reported.** Anything that appeared above the action
> buttons shoved them mid-decision: a strip appeared, the buttons dropped, it
> auto-hid 2.6s later and they snapped back, so a tap already travelling toward
> Hit landed on Double. Measured on a 360px phone with an identical hand, the
> blackjack strip moved every button 80px and the reshuffle banner moved them
> 220px. Everything transient now lives in one dock (`#bjfDock`) BELOW the table
> and above the Session analysis panel, where it cannot move a live button.
> Verified: 0 button jumps across 20 rounds, down from 80px and 220px.
>
> Also in this build:
> - The header stat strip reserves both lines, so `Accuracy —` becoming a
>   percentage no longer grows the sticky header and shifts the page 18px.
> - New "What the cards made" note under the table (Ram's request): says in plain
>   words what the three cards formed, including when it did not pay, e.g.
>   "Sequence · in order, but different suits". Read-only, driven entirely by the
>   engine's own `classifyThree()` / `pairOutcome()`.
> - The About panel's build string is now driven from `APP_VERSION` instead of
>   being hard-coded, so it cannot go stale again.
>
> ---
>
> **This build is v1.4.5.** No schema change since v1.4.4 — the new fields live
> inside the existing `round_log_json` column, so **no migration is required**
> and no manual step is needed beyond the normal deploy.
>
> ### What changed in v1.4.5
>
> All of it is data capture and export. **The game engine is byte-identical to
> v1.4.4** — verify with
> `diff rams_bj_friend_v1_4_1_speed_flow_cards_steppers-18.html public/index.html`
> which must show the same 9 hunks as before.
>
> 1. **Export no longer double-counts split hands.** `src/export.js` emitted one
>    row per hand but repeated the box's and round's money on every one of them,
>    so summing any money column over-counted every split round — and since a
>    split needs a pair, and a pair is what pays the side bets, the error landed
>    on winners. Box and round values are now written once, on the row flagged
>    `box_row = 1` / `round_row = 1`. Later rows are deliberately blank so a
>    plain `SUM()` is correct. **Column count went 42 → 47**, so anything reading
>    this file by column position must be re-pointed.
> 2. **New columns:** `shoe_round`, `shoe_end`, `round_ts`, `box_row`, `round_row`.
>    `shoe_end = 'reshuffle'` marks the last round played from a shoe; blank means
>    the shoe was still open. Without this a shoe cut short by the player was
>    indistinguishable from one played to the cut card.
> 3. **`round_ts`** is the first per-round timestamp the app has ever recorded.
> 4. **Resume now continues shoe numbering** instead of restarting at shoe 1.
> 5. **Export caveat text rewritten.** The old wording told readers to exclude
>    every session lacking `strategy_version`, which is all older sessions. It is
>    a provenance gap, not corrupt data.
>
> Old exports taken before v1.4.5 carry the double-count. Re-export rather than
> reusing them, and use `app_version` to tell the two apart.

> The Worker reconciles its own schema on start,
> so no manual ALTER TABLE is needed — v1.4.3 required them and a missed
> migration took production down. After deploying, confirm with:
>
> ```
> curl https://<your-host>/api/health
> # {"ok":true, ..., "schema":{"missing":[],"ok":true}}
> ```
>
> `"ok": false` with a populated `schema.missing` means the reconcile could not
> run — check `npx wrangler tail` for "Schema reconcile failed".


Everything needed to deploy is in this folder. Read `README.md` for the full
architecture; this file covers only the handoff and the deployment.

---

## 1. What to share

Share the **whole folder except three things**:

| Exclude | Why |
|---|---|
| `.dev.vars` | **Contains live credentials.** Never send this |
| `.wrangler/` | Local dev database + cache. Regenerated automatically |
| `node_modules/` | 222 MB, reinstalled with `npm install` |

All three are already in `.gitignore`, so pushing to a private git repo excludes
them automatically. To send a zip instead, use the command in section 6.

### Files the developer needs

```
public/index.html      the app (original file + 4 lines loading cloud.js)
public/cloud.js        auth, sync, AI trigger, history UI
src/index.js           Worker router
src/auth.js            password hashing, session cookies
src/repo.js            D1 queries
src/prompt.js          the analysis system prompt (v1.0) + response schema
src/vertex.js          Vertex AI client
schema.sql             database schema
scripts/create-user.mjs  creates/rotates accounts
wrangler.toml          Cloudflare config
package.json           dependencies + scripts
README.md              architecture + API reference
HANDOFF.md             this file

rams_bj_friend_...-18.html   ORIGINAL untouched file — keep for diffing
```

**Do not modify `public/index.html` or the game logic inside it.** The whole
build is designed so gameplay is untouched; `README.md` documents how that is
verified (11,756 exhaustive comparisons).

---

## 2. Where the database goes

**Cloudflare D1** — Cloudflare's managed SQLite. There is no server to run and
no file to host or back up manually; it is a managed service inside Cloudflare's
network, sitting right next to the Worker.

```bash
npx wrangler d1 create rams-bj-friend
```

That prints a `database_id`. Paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"                 # code reads env.DB — do not rename
database_name = "rams-bj-friend"
database_id = "<the id it printed>"
```

Then create the tables:

```bash
npm run db:migrate:remote      # wrangler d1 execute ... --remote --file=./schema.sql
```

The `database_id` is **not** a secret — it is an identifier, safe in the repo. It
grants nothing on its own; access comes from the Cloudflare account.

### Local vs remote — they are different databases

| | Where it lives | Command flag |
|---|---|---|
| Local dev | `.wrangler/state/` on the developer's laptop | `--local` |
| Production | Cloudflare D1 | `--remote` |

Data does **not** sync between them. The local one is disposable. Accounts must
be created separately on each (section 4).

---

## 3. Where secrets and API keys go

**Cloudflare Secrets** — encrypted at rest, never in the repo, injected into the
Worker at runtime as environment variables. Never put them in `wrangler.toml`.

```bash
# Signs login cookies. Any random 32+ byte string.
openssl rand -base64 32 | npx wrangler secret put AUTH_SECRET

# The Google service-account JSON key file, whole.
npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON < /path/to/service-account.json
```

Secrets are write-only: they can be replaced or deleted, never read back.
`npx wrangler secret list` shows names only.

### The three-way split

| Kind | Where | Example |
|---|---|---|
| Secret | `wrangler secret put` | `AUTH_SECRET`, `GCP_SERVICE_ACCOUNT_JSON` |
| Non-secret config | `[vars]` in `wrangler.toml` | `GCP_PROJECT_ID`, `VERTEX_MODEL` |
| Local dev only | `.dev.vars` (gitignored) | same names, throwaway values |

`.dev.vars` is the local stand-in for secrets. It must never be committed or
emailed. The developer creates their own from `.dev.vars.example`.

> **Note:** the `.dev.vars` currently in this folder holds a personal Google
> refresh token from local testing. It is excluded from the handoff and should be
> deleted rather than reused.

### The Google service account

Vertex AI is authenticated with a **service account**, not a personal login. The
Vertex AI API is already enabled on project `tryonme-20260731`.

```bash
PROJECT=tryonme-20260731
gcloud iam service-accounts create bjf-vertex --project "$PROJECT"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:bjf-vertex@$PROJECT.iam.gserviceaccount.com" \
  --role roles/aiplatform.user
gcloud iam service-accounts keys create /tmp/bjf-key.json \
  --iam-account "bjf-vertex@$PROJECT.iam.gserviceaccount.com"

npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON < /tmp/bjf-key.json
rm /tmp/bjf-key.json        # the secret now lives in Cloudflare; don't keep a copy
```

`roles/aiplatform.user` is the least privilege that works. The JSON key is a
credential — send it to the developer over a password manager or secret-sharing
link, never over chat or email, or let them generate it themselves with access to
the GCP project.

---

## 4. Deployment, start to finish

```bash
npm install

npx wrangler login                        # Cloudflare account access
npx wrangler d1 create rams-bj-friend     # paste database_id into wrangler.toml
npm run db:migrate:remote                 # create the tables

openssl rand -base64 32 | npx wrangler secret put AUTH_SECRET
npx wrangler secret put GCP_SERVICE_ACCOUNT_JSON < /path/to/key.json

npm run deploy                            # -> https://rams-bj-friend.<subdomain>.workers.dev
```

Then create the login account **on the remote database**:

```bash
npm run user:create -- --username ram --password '<real-password>' --remote
```

Both of the owner's devices sign into this **same** account — that is what makes
session data shared between them. Re-running the command rotates the password.

### Verify

```bash
curl https://<deployed-url>/api/health
# {"ok":true,"llm":"vertex-ai","model":"gemini-2.5-flash"}
```

`"llm":"vertex-ai"` confirms real Vertex. If it says `"mock"`, `MOCK_LLM` is set
and must be removed. Then open the URL, sign in, play a round, press **Analyse
with AI**, and confirm the analysis appears and survives a reload.

---

## 5. Things that will bite

- **`database_id` must be replaced.** It currently reads `local-dev-placeholder`,
  which only works locally. Deploying without changing it fails.
- **Do not set `MOCK_LLM` in production.** It bypasses Vertex and returns
  placeholder text. It exists for local testing.
- **Analyses take 25–45 seconds.** Normal — Gemini 2.5 thinking. Lower
  `VERTEX_THINKING_BUDGET` in `wrangler.toml` to trade depth for speed.
- **Binding names are load-bearing.** `DB` and `ASSETS` are referenced in code.
  Renaming them in `wrangler.toml` breaks the Worker.
- **Accounts are per-database.** A user created `--local` does not exist
  `--remote`. This causes most "invalid username or password" confusion.
- **Cookies need HTTPS.** They are marked `Secure` on https and automatically not
  on http localhost. A custom domain must be served over https.

---

## 6. Making a clean archive

```bash
cd "/home/mango213/Ram's Project_developed by him"
zip -r ~/rams-bj-friend-handoff.zip . \
  -x '.dev.vars' -x '.wrangler/*' -x 'node_modules/*' -x '*.log'
```

Verify before sending:

```bash
unzip -l ~/rams-bj-friend-handoff.zip | grep -E 'dev.vars|wrangler/|node_modules'
# .dev.vars.example may appear (safe). .dev.vars must NOT.
```

---

## 7. Cost

At personal-use volume, Workers and D1 sit inside the free tier. Vertex AI is
billed per token: roughly 20–28k tokens per analysis, only when the button is
pressed. `gemini-2.5-flash` is the default; change `VERTEX_MODEL` in
`wrangler.toml` for a different tier.


---

## Migrating an existing deployment (11 Aug build → v1.4.3)

### Schema — handled automatically as of v1.4.4

`schema.sql` is idempotent for a fresh database, but `CREATE TABLE IF NOT EXISTS`
does nothing to a table that already exists, so columns added in a later release
never reached an older database. That is what broke production on 2026-09-05:
`sessions.strategy_version` was missing, every sync INSERT returned 500, and no
play was recorded at all until it was found.

`src/migrate.js` now reconciles the schema on first use in each isolate, so this
cannot recur — adding a column to `REQUIRED_COLUMNS` is all a future release
needs. The statements below are kept only for reference or manual repair:

```bash
npx wrangler d1 execute rams-bj-friend --remote --command \
  "ALTER TABLE sessions ADD COLUMN round_log_meta TEXT;"
npx wrangler d1 execute rams-bj-friend --remote --command \
  "ALTER TABLE sessions ADD COLUMN strategy_version TEXT;"
npx wrangler d1 execute rams-bj-friend --remote --command \
  "ALTER TABLE sessions ADD COLUMN rules_profile TEXT;"
```

If the deployed database predates 12 Aug it may also be missing `mode` and
`round_log_json`. Check with `PRAGMA table_info(sessions);` and add whichever are
absent, same syntax.

### What changed since 11 Aug

**Strategy grading — two corrections. Accuracy figures move.**
- Matrix is now `HIP-ENHC-S17-v1`. `A,8 (Soft 19)` **stands against every
  up-card including 6**; `A,7` doubles vs 2-6; `A,A` splits vs 2-10. Multi-card
  soft hands fall back to Stand on soft 18/19 and Hit on soft 13-17.
- Sessions graded before this carry **false mistakes** and are stamped
  `LEGACY-v1.4.1` in the export. Exclude them from mistake-based analysis.

**ENHC dealer flow.** The dealer no longer draws past the natural check when
every live hand is a natural — it was burning shoe cards a real dealer never
takes, distorting penetration and any count.

**Raw event-log export.** `GET /api/export/rounds.csv` and `.json`, one row per
box per round, 42 columns. Optional `?session=<id>`.

**Shoe IDs now real.** `state.shoeNumber` was hardcoded to 1 forever. The round
log derives a genuine shoe index from cards-remaining. Rounds recorded before
this are all shoe 1 and cannot be recovered shoe-wise.

**Round log no longer truncates at 400.** Raised to 2000, and truncation is now
flagged rather than silent. Previously a 506-round session permanently lost its
first ~106 rounds.

**Round log can no longer be wiped.** The client used to send `[]` when the
history module had not booted, overwriting stored history. It now sends `null`
and the SQL uses `COALESCE`.

### Regression suite

```bash
npm test      # 32 assertions: strategy matrix + ENHC dealer/natural flow
```

Run it against a deployed URL with `node tests/strategy.test.mjs https://<host>/`.
It needs an account to exist on that database — see section 4.
