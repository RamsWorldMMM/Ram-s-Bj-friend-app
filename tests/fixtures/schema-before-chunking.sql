-- Ram's BJ Friend — D1 (SQLite) schema
-- Persistence + shared-session capture + Vertex AI analysis history.
-- Nothing in here encodes game rules; it only records what the app produced.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Accounts (personal use: a small number of fixed users, created via CLI)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,          -- PBKDF2-SHA256 derived key, base64
  password_salt TEXT NOT NULL,          -- random 16 bytes, base64
  iterations    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- ---------------------------------------------------------------------------
-- Play sessions. One row per session id minted by the client.
-- state_json / shoe_json hold the verbatim localStorage payload so any device
-- can resume exactly where another left off.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id          TEXT,
  app_version        TEXT,
  mode               TEXT NOT NULL DEFAULT 'practice',  -- practice | live
  started_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),

  -- denormalised headline figures, so history lists need no JSON parsing
  start_bankroll     REAL NOT NULL DEFAULT 0,
  bankroll           REAL NOT NULL DEFAULT 0,
  rounds             INTEGER NOT NULL DEFAULT 0,
  decisions          INTEGER NOT NULL DEFAULT 0,
  correct            INTEGER NOT NULL DEFAULT 0,
  mistakes_count     INTEGER NOT NULL DEFAULT 0,
  main_pl            REAL NOT NULL DEFAULT 0,
  pairs_pl           REAL NOT NULL DEFAULT 0,
  trilux_pl          REAL NOT NULL DEFAULT 0,
  super_pl           REAL NOT NULL DEFAULT 0,
  high_bankroll      REAL NOT NULL DEFAULT 0,
  low_bankroll       REAL NOT NULL DEFAULT 0,
  max_drawdown       REAL NOT NULL DEFAULT 0,
  total_main_staked  REAL NOT NULL DEFAULT 0,
  total_side_staked  REAL NOT NULL DEFAULT 0,
  largest_main_bet   REAL NOT NULL DEFAULT 0,
  longest_win_streak  INTEGER NOT NULL DEFAULT 0,
  longest_loss_streak INTEGER NOT NULL DEFAULT 0,
  shoe_number        INTEGER NOT NULL DEFAULT 1,

  state_json         TEXT,              -- full `state` object
  shoe_json          TEXT,              -- remaining undealt cards
  last_bets_json     TEXT,
  round_log_json     TEXT,              -- complete card-by-card round replay
  round_log_meta     TEXT,              -- {truncated, maxRounds, shoesSeen, captured}

  -- Grading provenance. Without these a session cannot be excluded from an
  -- analysis on the grounds that it was graded by a superseded matrix.
  strategy_version   TEXT,              -- e.g. HIP-ENHC-S17-v1; NULL = legacy v1.4.1
  rules_profile      TEXT               -- e.g. 6D / S17 / ENHC-full-loss / DOA / DAS
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
  ON sessions(user_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Round-by-round ledger (mirrors state.roundHistory, one row per round)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rounds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_no   INTEGER NOT NULL,
  boxes      INTEGER NOT NULL DEFAULT 0,
  main_net   REAL NOT NULL DEFAULT 0,
  side_net   REAL NOT NULL DEFAULT 0,
  total_net  REAL NOT NULL DEFAULT 0,
  bankroll   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, round_no)          -- makes re-sync idempotent
);

CREATE INDEX IF NOT EXISTS idx_rounds_session ON rounds(session_id, round_no);

-- ---------------------------------------------------------------------------
-- Strategy mistakes (mirrors state.mistakes; seq = index in that array)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mistakes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  round_no       INTEGER,
  box            INTEGER,
  hand           TEXT,
  hand_label     TEXT,
  dealer_card    TEXT,
  chosen_action  TEXT,
  correct_action TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, seq)               -- makes re-sync idempotent
);

CREATE INDEX IF NOT EXISTS idx_mistakes_session ON mistakes(session_id, seq);

-- ---------------------------------------------------------------------------
-- Shared-session capture: the exact report text the user submitted.
-- This is what used to be pasted into ChatGPT by hand.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shared_reports (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_text TEXT NOT NULL,
  context_json TEXT,                    -- rounds + mistakes snapshot at share time
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shared_session ON shared_reports(session_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- AI analyses produced by Gemini on Vertex AI
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_analyses (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  shared_report_id  TEXT REFERENCES shared_reports(id) ON DELETE SET NULL,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | complete | error
  provider          TEXT NOT NULL DEFAULT 'vertex-ai',
  model             TEXT,
  prompt_version    TEXT,               -- which system-prompt revision produced this
  analysis_text     TEXT,               -- human-readable rendering
  analysis_json     TEXT,               -- structured output from the model
  error_message     TEXT,
  prompt_tokens     INTEGER,
  candidate_tokens  INTEGER,
  total_tokens      INTEGER,
  latency_ms        INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_analyses_session ON ai_analyses(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_user ON ai_analyses(user_id, created_at DESC);
