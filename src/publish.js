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

import {
  buildDigests, buildStakingDigest, buildReportDigest,
  buildDeviationDigest, buildRawShoeFiles, buildRawIndex,
} from './digest.js';
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

/** Current sha and decoded content for a path, or nulls when it does not exist.
 *  The content is what lets an unchanged file be skipped. */
async function currentFile(token, owner, name, path, branch) {
  const url = `${API}/repos/${owner}/${name}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return { sha: null, text: null };
  if (!res.ok) throw new Error(`GitHub read failed for ${path}: ${res.status} ${await res.text()}`);
  const body = await res.json();
  let text = null;
  try {
    if (body.content && body.encoding === 'base64') {
      const bin = atob(body.content.replace(/\n/g, ''));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    }
  } catch { text = null; }
  return { sha: body.sha || null, text };
}

/* Every file carries generated_at, stamped fresh on each publish, so nothing is
 * ever byte-identical and "skip the unchanged" could never fire. Comparing with
 * that field removed is what makes it work: press the button twice having played
 * nothing and the second press writes no commits at all. */
function sameIgnoringTimestamp(a, b) {
  if (a === null || b === null) return false;
  try {
    const strip = (t) => {
      const o = JSON.parse(t);
      delete o.generated_at;
      return JSON.stringify(o);
    };
    return strip(a) === strip(b);
  } catch { return false; }
}

async function putFile(token, owner, name, path, branch, text, message) {
  const { sha, text: existing } = await currentFile(token, owner, name, path, branch);
  if (sameIgnoringTimestamp(existing, text)) {
    return { path, bytes: text.length, skipped: true };
  }
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
    // Answers the side-bet staking question directly, rather than shipping the
    // round-level data and hoping the arithmetic is done correctly downstream.
    ['data/staking.json', buildStakingDigest(sessions, { generatedAt })],
    // The report Ram was copying out by hand and pasting in. Published, so the
    // button carries everything the paste did and he no longer has to do both.
    ['data/reports.json', buildReportDigest(sessions, { generatedAt })],
    ['data/deviations.json', buildDeviationDigest(sessions, { generatedAt })],
  ];

  const rounds = digests.summary.lifetime.rounds;
  const message = `Publish gameplay data — ${sessions.length} session(s), ${rounds} rounds`;

  const written = [];
  for (const [path, obj] of files) {
    written.push(await putFile(token, owner, name, path, branch,
      JSON.stringify(obj, null, 1) + '\n', message));
  }

  /* The raw record, split by shoe. Capped per publish because the contents API
   * makes one commit per file, and 233 of them in a single press would be both
   * slow and a secondary-rate-limit risk. Newest first, so the useful end is
   * written first; already-published shoes are skipped unchanged, so each press
   * advances the backlog until it is empty. The index says what is still queued
   * rather than letting a gap look like missing data. */
  /* THE SUBREQUEST BUDGET IS THE REAL CEILING, AND IT IS SHARED.
   *
   * Cloudflare's free plan allows 50 subrequests per request, and D1 calls count
   * toward it as well as fetches. Before this loop runs we have already spent:
   * the auth lookup, ensureSchema's PRAGMAs on a cold isolate, exportSessions,
   * and six digests at a GET plus a PUT each. Two hand-tuned constants could not
   * see any of that, and the worst case came out at 48 of 50.
   *
   * Running out mid-loop is the bad failure: every file written before that
   * point is already its own commit, so the repository is left with summary.json
   * at the new round count and reports.json at the old one — internally
   * inconsistent, and looking perfectly fine to anyone reading it.
   *
   * So the budget is counted explicitly, and the index write is RESERVED out of
   * it before the loop starts rather than hoped for afterwards.
   */
  const SUBREQUEST_LIMIT = 50;
  const SPENT_BEFORE_SHOES = 4 + (files.length * 2);   // auth, 2 PRAGMA, export
  const RESERVED_FOR_INDEX = 2;
  let budget = SUBREQUEST_LIMIT - SPENT_BEFORE_SHOES - RESERVED_FOR_INDEX;

  /* OLDEST UNPUBLISHED FIRST.
   *
   * The loop used to run newest-first, which meant the backlog could never
   * drain: 28 shoes of 134 were published and the other 106, going back to
   * 12 September, were never reached because new shoes kept arriving ahead of
   * them. Publishing more often made it worse, not better.
   *
   * A finished shoe never changes, so the right order is oldest-missing-first:
   * each publish advances the archive, and the newest shoe is the one most
   * likely to already be current anyway.
   */
  const shoeFiles = buildRawShoeFiles(sessions, { generatedAt })
    .slice()
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.shoe - b.shoe);

  const rawWritten = [];
  const confirmedOnRepo = [];
  for (const f of shoeFiles) {
    if (budget < 2) break;                  // a read plus a possible write
    const res = await putFile(token, owner, name, f.path, branch,
      JSON.stringify(f.build(), null, 1) + '\n', message);
    rawWritten.push(res);
    budget -= res.skipped ? 1 : 2;
    // Present on the repository — either written just now, or read back
    // unchanged. Both mean the file is there, which is what the index claims.
    confirmedOnRepo.push(f.path);
  }

  /* The index used to mark a shoe published if this run had TOUCHED it, which
   * said nothing about the 106 it never reached — they were simply absent from
   * the published set with no way to tell "not yet" from "never". Carrying the
   * previous index forward means a shoe stays published once it is. */
  let previouslyPublished = [];
  try {
    const prev = await currentFile(token, owner, name, 'data/rounds/index.json', branch);
    if (prev.text) {
      previouslyPublished = (JSON.parse(prev.text).shoes || [])
        .filter((x) => x.published).map((x) => x.file);
    }
  } catch { previouslyPublished = []; }     // first run, or unreadable

  const publishedPaths = [...new Set([...previouslyPublished, ...confirmedOnRepo])];
  written.push(await putFile(token, owner, name, 'data/rounds/index.json', branch,
    JSON.stringify(buildRawIndex(shoeFiles, publishedPaths, { generatedAt }), null, 1) + '\n',
    message));

  const rawNew = rawWritten.filter((r) => !r.skipped).length;

  return {
    rawShoes: {
      total: shoeFiles.length,
      writtenThisTime: rawNew,
      alreadyCurrent: rawWritten.length - rawNew,
      remaining: Math.max(0, shoeFiles.length - publishedPaths.length),
    },
    ok: true,
    publishedAt: generatedAt,
    branch,
    repo: `${owner}/${name}`,
    sessions: sessions.length,
    rounds,
    files: written,
  };
}
