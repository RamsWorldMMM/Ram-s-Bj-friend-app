/* Self-healing schema.
 *
 * `CREATE TABLE IF NOT EXISTS` in schema.sql does nothing to a table that
 * already exists, so columns added in a later release never reach a database
 * created by an earlier one. On 2026-09-05 that took production down silently:
 * `sessions.strategy_version` was missing, so every sync INSERT and every
 * session SELECT returned 500 and no play was being recorded at all.
 *
 * Rather than depend on someone remembering an ALTER TABLE at deploy time, the
 * Worker now reconciles its own schema on first use in each isolate. Adding a
 * column here is all a future release needs to do.
 */

const REQUIRED_COLUMNS = [
  // table,        column,             definition
  ['sessions',    'mode',             "TEXT NOT NULL DEFAULT 'practice'"],
  ['sessions',    'round_log_json',   'TEXT'],
  ['sessions',    'round_log_meta',   'TEXT'],
  ['sessions',    'strategy_version', 'TEXT'],
  ['sessions',    'rules_profile',    'TEXT'],
  ['ai_analyses', 'prompt_version',   'TEXT'],
];

let settled = false;          // per-isolate: reconcile once, not per request

/** Existing column names for a table, or null if the shape can't be read. */
async function columnsOf(db, table) {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (!results || !results.length) return null;
    return new Set(results.map((r) => r.name));
  } catch {
    return null;               // some D1 versions restrict PRAGMA
  }
}

/**
 * Adds any missing column. Safe to call concurrently and repeatedly: a race
 * that loses simply hits "duplicate column name", which is not an error here.
 */
export async function ensureSchema(db) {
  if (settled) return { skipped: true };

  const added = [];
  const failed = [];
  const cache = new Map();

  for (const [table, column, definition] of REQUIRED_COLUMNS) {
    if (!cache.has(table)) cache.set(table, await columnsOf(db, table));
    const existing = cache.get(table);

    // A null set means the shape is unreadable — attempt the ALTER anyway and
    // let the duplicate-column error tell us it was already there.
    if (existing && existing.has(column)) continue;

    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      added.push(`${table}.${column}`);
    } catch (err) {
      const msg = String(err && err.message || err);
      if (/duplicate column name/i.test(msg)) continue;   // already present
      failed.push(`${table}.${column}: ${msg}`);
    }
  }

  // Only latch once the schema is actually correct, so a transient failure is
  // retried on the next request instead of being cached as "done".
  if (!failed.length) settled = true;
  if (added.length) console.log('Schema reconciled, added:', added.join(', '));
  if (failed.length) console.error('Schema reconcile failed:', failed.join(' | '));

  return { added, failed };
}

/** Exposed for the health endpoint so a deploy can be verified without playing. */
export async function schemaReport(db) {
  const report = {};
  for (const [table] of REQUIRED_COLUMNS) {
    if (report[table]) continue;
    const cols = await columnsOf(db, table);
    report[table] = cols ? [...cols] : null;
  }
  const missing = REQUIRED_COLUMNS
    .filter(([t, c]) => report[t] && !report[t].includes(c))
    .map(([t, c]) => `${t}.${c}`);
  return { missing, ok: missing.length === 0 };
}
