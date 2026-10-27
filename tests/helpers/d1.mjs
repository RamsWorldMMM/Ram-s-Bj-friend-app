// A stand-in for Cloudflare D1 over node:sqlite, shared by the suites that
// run src/ against a real database.
/* ------------------------------------------------------------- D1 stand-in --
 * The surface repo.js and migrate.js use: prepare().bind().first/all/run, and
 * batch() as one transaction. node:sqlite refuses `undefined` as a parameter,
 * which D1 would quietly turn into NULL — stricter, so a missing `?? null`
 * fails here rather than in production. */
export function d1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...args).changes } }),
    exec: () => sqlite.prepare(sql).run(...args),
  });
  return {
    prepare: (sql) => statement(sql),
    // Each statement in a batch is bound and shipped to D1 — that per-statement
    // cost is CPU, and CPU is what was killing the syncs. Count it.
    lastBatch: 0,
    async batch(list) {
      this.lastBatch = list.length;
      sqlite.exec('BEGIN');
      try {
        const out = list.map((s) => ({ meta: { changes: s.exec().changes } }));
        sqlite.exec('COMMIT');
        return out;
      } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}

