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
/* `decode` is off for the raw shoe files.
 *
 * Decoding is what makes the comparison possible, and the comparison is what
 * lets an unchanged digest be skipped — worth it for six small files. For the
 * shoe archive it is pure cost: each body is ~100 KB, the decode walks it a
 * byte at a time through a callback, and a settled shoe is already skipped by
 * path before it gets here. Doing it anyway is what took the full send past the
 * Worker's CPU ceiling and returned 1102. */
async function currentFile(token, owner, name, path, branch, decode = true) {
  const url = `${API}/repos/${owner}/${name}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return { sha: null, text: null };
  if (!res.ok) throw new Error(`GitHub read failed for ${path}: ${res.status} ${await res.text()}`);
  const body = await res.json();
  let text = null;
  try {
    if (decode && body.content && body.encoding === 'base64') {
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

/* A 409 means the file moved between our read and our write — the sha we sent
 * is no longer current. Ram hit exactly this:
 *
 *   GitHub write failed for data/reports.json: 409
 *   "is at 07ce1a51... but expected 4775ffb5..."
 *
 * It became likely the moment publishing stopped being one button press: the
 * shoe-end publish can start while he presses Send now, two shoe ends can land
 * close together, or a second tab can be open. The sha check is doing its job —
 * it is what stops two writers clobbering each other — so the answer is not to
 * drop it but to re-read and try again, which is the whole point of having it.
 *
 * Three attempts. A conflict that survives three fresh reads is not a race, it
 * is something else, and should surface rather than loop.
 */
const PUT_ATTEMPTS = 3;

async function putFile(token, owner, name, path, branch, text, message, compare = true) {
  let lastStatus = null;
  let lastBody = '';
  for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt += 1) {
    // Re-read every attempt: after a 409 the stale sha is exactly what has to
    // be replaced, so reusing the first read would fail the same way forever.
    const { sha, text: existing } = await currentFile(token, owner, name, path, branch, compare);
    if (compare && sameIgnoringTimestamp(existing, text)) {
      return { path, bytes: text.length, skipped: true };
    }
    const res = await fetch(`${API}/repos/${owner}/${name}/contents/${encodeURI(path)}`, {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: toBase64(text), branch, ...(sha ? { sha } : {}) }),
    });
    if (res.ok) {
      const body = await res.json();
      return {
        path, bytes: text.length, created: !sha,
        commit: body.commit?.sha?.slice(0, 7),
        retried: attempt > 1 ? attempt : undefined,
      };
    }
    lastStatus = res.status;
    lastBody = (await res.text()).slice(0, 200);
    // 409 is the race and is worth retrying; 401, 403 and 422 are not, and
    // retrying them just spends the subrequest budget before failing anyway.
    if (res.status !== 409) break;
  }
  throw new Error(`GitHub write failed for ${path}: ${lastStatus} ${lastBody}`);
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

  /* Read every digest at once, then write only what changed, one at a time.
   *
   * Reads are independent, so doing them in sequence spent seven round trips of
   * latency for no reason. Writes stay sequential on purpose: they all commit to
   * the same branch, and concurrent commits to one ref conflict with each other
   * — which is the very thing being fixed here. */
  const bodies = files.map(([path, obj]) => [path, JSON.stringify(obj, null, 1) + '\n']);
  const existing = await Promise.all(
    bodies.map(([path]) => currentFile(token, owner, name, path, branch)
      .catch(() => ({ sha: null, text: null }))),
  );

  const written = [];
  for (let i = 0; i < bodies.length; i += 1) {
    const [path, text] = bodies[i];
    if (sameIgnoringTimestamp(existing[i].text, text)) {
      written.push({ path, bytes: text.length, skipped: true });
      continue;
    }
    written.push(await putFile(token, owner, name, path, branch, text, message));
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
  /* The archive backfill is the slow half, and it is not what Ram is waiting
   * for. He finishes a shoe, the digests go up, and he asks ChatGPT about the
   * play he just did — that needs the six summary files and nothing else. The
   * raw per-shoe records are a backlog being filled in behind him, and writing
   * a dozen 100 KB files is what turned a send into half a minute.
   *
   * So the automatic send writes the digests only, and Send now does the
   * backfill as well. Nothing is lost either way: the queue is recorded in the
   * index and drains on the next manual press. */
  const withBacklog = opts.backlog !== false;

  const SUBREQUEST_LIMIT = 50;
  // auth, two PRAGMAs on a cold isolate, exportSessions, then a read and a
  // possible write for each digest. The index costs a read before the loop and
  // a write after it, so both are accounted for here rather than hoped for.
  const SPENT_BEFORE_SHOES = 4 + (files.length * 2) + 1;
  const RESERVED_FOR_INDEX_WRITE = 1;
  let budget = SUBREQUEST_LIMIT - SPENT_BEFORE_SHOES - RESERVED_FOR_INDEX_WRITE;

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

  /* The index is read FIRST so it can steer the loop, not just record it.
   *
   * Oldest-first was meant to drain the archive and did the opposite: the
   * oldest shoes are the published ones, each still cost a read to confirm, and
   * the budget ran out before reaching the first unpublished one. The count sat
   * at 59 of 246 and could not move — it got worse as Ram played, because every
   * new shoe lengthened the queue behind a wall of re-reads.
   *
   * A finished shoe never changes, so one already recorded as published does
   * not need reading at all. Skipping those spends the whole budget on the
   * queue. */
  let previouslyPublished = [];
  try {
    const prev = await currentFile(token, owner, name, 'data/rounds/index.json', branch);
    if (prev.text) {
      previouslyPublished = (JSON.parse(prev.text).shoes || [])
        .filter((x) => x.published).map((x) => x.file);
    }
  } catch { previouslyPublished = []; }     // first run, or unreadable
  const alreadyDone = new Set(previouslyPublished);

  /* A separate cap on WRITES, not just on subrequests.
   *
   * Each shoe body is around 100 KB and has to be built and serialised before
   * it is sent. Twelve of those on top of the digest build took the request
   * past what the Worker would give it and returned 503 — the subrequest budget
   * said there was room, but the CPU did not. Six completes reliably, and the
   * queue drains over successive presses rather than failing on each one. */
  const MAX_SHOE_WRITES = 6;
  let shoeWrites = MAX_SHOE_WRITES;

  const rawWritten = [];
  const confirmedOnRepo = [];
  for (const f of (withBacklog ? shoeFiles : [])) {
    // Published already, and settled, so it cannot have changed. Costs nothing.
    if (alreadyDone.has(f.path) && f.complete) continue;
    if (shoeWrites <= 0) break;
    if (budget < 2) break;                  // a read plus a possible write
    const res = await putFile(token, owner, name, f.path, branch,
      JSON.stringify(f.build(), null, 1) + '\n', message, false);
    rawWritten.push(res);
    budget -= res.skipped ? 1 : 2;
    if (!res.skipped) shoeWrites -= 1;
    // Present on the repository — either written just now, or read back
    // unchanged. Both mean the file is there, which is what the index claims.
    confirmedOnRepo.push(f.path);
  }

  /* Published is cumulative: a shoe stays published once it is, so the previous
   * index (read above) is carried forward rather than replaced by whatever this
   * one run happened to touch. */
  const publishedPaths = [...new Set([...previouslyPublished, ...confirmedOnRepo])];
  // Only when the archive actually moved. On a fast send nothing did, and
  // rewriting it would cost a round trip to change one timestamp.
  if (withBacklog) {
    written.push(await putFile(token, owner, name, 'data/rounds/index.json', branch,
      JSON.stringify(buildRawIndex(shoeFiles, publishedPaths, { generatedAt }), null, 1) + '\n',
      message));
  }

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
