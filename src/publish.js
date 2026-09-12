/* Publishes the gameplay digests to GitHub, where Ram's ChatGPT can read them.
 *
 * His chat has read access to the repository but cannot reach the app's data,
 * which sits behind a login — so the data is pushed to a place he has already
 * connected rather than asking him to connect another.
 *
 * Writes through GitHub's contents API: read the file's current sha, then PUT
 * the new content with that sha. Without the sha GitHub rejects the write as a
 * conflict, which is what keeps two publishes from silently clobbering.
 */

import { buildDigests } from './digest.js';
import * as repo from './repo.js';

const API = 'https://api.github.com';

/** UTF-8 → base64, chunked: the card suits and £ signs are multi-byte, and
 *  spreading a large byte array into String.fromCharCode blows the stack. */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function headers(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub rejects API requests without one.
    'User-Agent': 'rams-bj-friend-worker',
  };
}

/** Current sha for a path, or null when the file does not exist yet. */
async function currentSha(token, owner, name, path, branch) {
  const url = `${API}/repos/${owner}/${name}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed for ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()).sha;
}

async function putFile(token, owner, name, path, branch, text, message) {
  const sha = await currentSha(token, owner, name, path, branch);
  const res = await fetch(`${API}/repos/${owner}/${name}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: toBase64(text), branch, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    throw new Error(`GitHub write failed for ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  return { path, bytes: text.length, created: !sha, commit: body.commit?.sha?.slice(0, 7) };
}

/**
 * Rebuilds the digests from stored play and commits any that changed.
 * Unchanged files are skipped so the history stays meaningful rather than
 * filling with identical commits.
 */
export async function publishDigests(env, userId, opts = {}) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured on this Worker.');

  const owner = env.GITHUB_OWNER || 'RamsWorldMMM';
  const name = env.GITHUB_REPO || 'Ram-s-Bj-friend-app';
  const branch = env.GITHUB_BRANCH || 'main';

  const sessions = await repo.exportSessions(env.DB, userId, null);
  const generatedAt = new Date().toISOString();
  const digests = buildDigests(sessions, { generatedAt, appVersion: opts.appVersion });

  const files = [
    ['data/summary.json', digests.summary],
    ['data/shoes.json', digests.shoes],
    ['data/mistakes.json', digests.mistakes],
  ];

  const rounds = digests.summary.lifetime.rounds;
  const message = `Publish gameplay data — ${sessions.length} session(s), ${rounds} rounds`;

  const written = [];
  for (const [path, obj] of files) {
    written.push(await putFile(token, owner, name, path, branch,
      JSON.stringify(obj, null, 1) + '\n', message));
  }

  return {
    ok: true,
    publishedAt: generatedAt,
    branch,
    repo: `${owner}/${name}`,
    sessions: sessions.length,
    rounds,
    files: written,
  };
}
