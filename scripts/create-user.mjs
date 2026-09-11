#!/usr/bin/env node
// Creates (or updates) an account. Password hashing matches src/auth.js exactly.
//
//   npm run user:create -- --username ram --password 'secret' --local
//   npm run user:create -- --username ram --password 'secret' --remote

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PBKDF2_ITERATIONS = 210_000;
const DB_NAME = 'rams-bj-friend';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const username = arg('username');
const password = arg('password');
const remote = process.argv.includes('--remote');
const local = process.argv.includes('--local') || !remote;

if (!username || !password) {
  console.error(`
Usage: npm run user:create -- --username <name> --password <password> [--local|--remote]

  --local   write to the local dev database (default)
  --remote  write to the deployed Cloudflare D1 database
`);
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
);
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256
);

const b64 = (buf) => Buffer.from(buf).toString('base64');
const id = crypto.randomUUID();
const esc = (s) => String(s).replace(/'/g, "''");

// Upsert so re-running the command rotates the password instead of failing.
const sql = `
INSERT INTO users (id, username, password_hash, password_salt, iterations)
VALUES ('${id}', '${esc(username)}', '${b64(bits)}', '${b64(salt)}', ${PBKDF2_ITERATIONS})
ON CONFLICT(username) DO UPDATE SET
  password_hash = excluded.password_hash,
  password_salt = excluded.password_salt,
  iterations    = excluded.iterations;
`.trim();

const tmpFile = join(tmpdir(), `bjf-user-${Date.now()}.sql`);
writeFileSync(tmpFile, sql, { mode: 0o600 });

try {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', `--file=${tmpFile}`],
    { stdio: 'inherit' }
  );
  console.log(`\n✓ Account "${username}" ready on the ${local ? 'local' : 'remote'} database.`);
} catch {
  console.error('\nwrangler failed. Is the database created and schema applied?');
  process.exit(1);
} finally {
  unlinkSync(tmpFile);   // the file holds a password-derived hash; don't leave it around
}
