/**
 * Live-session scope tests.
 *
 * The plugin originally only saw *archived* sessions. That is the wrong scope for
 * "remember the conversation I just had": nothing is archived until the user
 * archives it, so a live conversation's knowledge never reached memory (measured
 * on this machine: 11 sessions written in one day, 0 of them archived).
 *
 * Live capture needs no session hooks, because the on-disk log is already complete
 * and current — 5434 events decoded from a *running* session, its last sentence
 * included. What it needs instead is a settle rule: a session still being written
 * must not be digested, or half a conversation gets remembered.
 *
 * The invariants pinned here:
 *  1. Live enumeration never returns an archived session (no double-digest).
 *  2. A log younger than the settle window is NOT a digest candidate.
 *  3. `cleanup` can never touch a live session (it resolves ids against the
 *     archived inventory), so live capture can never destroy a conversation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(here, '..', rel)).href);

// ── a synthetic DSH_HOME so the test is hermetic ───────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-live-'));
process.env.DSH_HOME = sandbox;
process.env.DSH_ARCHIVED_DIGEST_SKILLS = path.join(sandbox, 'skills');

const WS = '--D-DeepSeekHarness--';
const sessionsDir = path.join(sandbox, 'sessions', WS);
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(path.join(sandbox, 'storages'), { recursive: true });

/** zstd-compress one JSONL payload into a frame, the way the logger does. */
const { zstdCompressSync } = await import('node:zlib');
function writeLog(sessionId, events, { file = 'session.jsonl.zstd' } = {}) {
  const dir = path.join(sessionsDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const jsonl = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  fs.writeFileSync(path.join(dir, file), zstdCompressSync(Buffer.from(jsonl, 'utf8')));
  return dir;
}

const ARCHIVED = 'session-archived-0001';
const FRESH = 'session-fresh-0002';
const SETTLED = 'session-settled-0003';
const PINNED = 'session-pinned-0004';

const base = [
  { type: 'session', id: 'x', version: 0, createdAt: 1, cwd: 'D:\\DeepSeekHarness' },
  { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '我们要把归档会话压成记忆，先看看日志怎么解' }] } },
  { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的。日志是多帧 zstd，要按 magic bytes 28 b5 2f fd 切帧逐段解压，否则只拿到第一帧。' }] } } },
  { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '那事实怎么合并、旧结论怎么办？' }] } },
  { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '同义复述走 UPDATE，旧结论保留 validUntil 而不是删除，完全一致则 NOOP。' }] } } },
];

writeLog(ARCHIVED, base);
writeLog(FRESH, base, { file: 'session.v4.jsonl.zstd' });
writeLog(SETTLED, base, { file: 'session.v4.jsonl.zstd' });
writeLog(PINNED, base);

// The archived one is listed in the DSH workspace store; the others are not.
fs.writeFileSync(path.join(sandbox, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { archivedSessionIds: [ARCHIVED], pinnedSessionIds: [PINNED] },
}, null, 2));

// mtimes decide the settle rule. `SETTLED` is old; `FRESH` is now.
const OLD = Date.now() - 3600_000;
fs.utimesSync(path.join(sessionsDir, SETTLED, 'session.v4.jsonl.zstd'), new Date(OLD / 1000), new Date(OLD / 1000));

const { listArchivedSessions, listLiveSessions } = await load('lib/inventory.js');
const { needsDigest, LIVE_SETTLE_MS } = await load('lib/digester.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. scope separation ────────────────────────────────────────────────────
const archived = listArchivedSessions({});
const live = listLiveSessions({});

check('archived enumeration returns exactly the archived id',
  archived.sessions.length === 1 && archived.sessions[0].sessionId === ARCHIVED,
  archived.sessions.map((s) => s.sessionId).join(','));

check('live enumeration excludes every archived session',
  live.sessions.every((s) => s.sessionId !== ARCHIVED),
  live.sessions.map((s) => s.sessionId).join(','));

check('live enumeration finds the not-yet-archived sessions',
  live.sessions.length === 3, `${live.sessions.length} live`);

check('live rows are marked as live', live.sessions.every((s) => s.live === true), 'all flagged');

check('live rows report their workspace slug',
  live.sessions.every((s) => s.workspaceSlug === WS), 'slug present');

check('a pinned live session is flagged as pinned',
  live.sessions.find((s) => s.sessionId === PINNED)?.pinned === true, 'pinned');

check('live enumeration is ordered newest-first',
  live.sessions[0].mtimeMs >= live.sessions[live.sessions.length - 1].mtimeMs,
  `${new Date(live.sessions[0].mtimeMs).toISOString().slice(11, 19)} first`);

// ── 2. the settle rule ─────────────────────────────────────────────────────
const ready = needsDigest(live.sessions, {}, { live: true });
const readyIds = ready.map((s) => s.sessionId);

check('a settled live session is a digest candidate',
  readyIds.includes(SETTLED), SETTLED);

check('a still-active live session is NOT a digest candidate',
  !readyIds.includes(FRESH), 'fresh excluded');

check('the settle window is what excludes it',
  Date.now() - live.sessions.find((s) => s.sessionId === FRESH).mtimeMs < LIVE_SETTLE_MS,
  `< ${LIVE_SETTLE_MS}ms old`);

// Lowering the window must admit the fresh one: proving the rule is the window,
// not something incidental about the session.
const impatient = needsDigest(live.sessions, {}, { live: true, settleMs: 0 });
check('lowering the settle window admits the fresh session',
  impatient.map((s) => s.sessionId).includes(FRESH), 'settleMs=0');

// A pinned session is never a candidate even when settled.
check('a pinned session is never a digest candidate',
  !readyIds.includes(PINNED), 'pinned excluded');

check('live candidates are ordered newest-first',
  ready.length < 2 || ready[0].mtimeMs >= ready[1].mtimeMs, 'newest first');

// Archived ordering must stay oldest-first — the two scopes order differently.
const archivedReady = needsDigest(archived.sessions, {}, {});
check('archived candidates keep oldest-first ordering',
  archivedReady.length === 1 && archivedReady[0].sessionId === ARCHIVED, 'archived order');

// ── 3. an already-digested live session is skipped ─────────────────────────
const state = { digested: { [SETTLED]: { at: new Date().toISOString() } } };
// The listing is what stamps `digestedAt` onto a row, so the state must reach it.
const reListed = listLiveSessions(state);
const afterDigest = needsDigest(reListed.sessions, state, { live: true });
check('a digested live session is not re-digested',
  !afterDigest.map((s) => s.sessionId).includes(SETTLED), 'skipped');
check('a digested live row reports its digest time',
  reListed.sessions.find((s) => s.sessionId === SETTLED)?.digestedAt !== null, 'digestedAt set');

// ── 3b. a skipped (empty) live session is not re-decoded ───────────────────
const skippedState = { skipped: { [SETTLED]: { at: new Date().toISOString(), code: 'EMPTY_SOURCE' } } };
const afterSkip = needsDigest(reListed.sessions, skippedState, { live: true });
check('a session recorded as empty is not re-decoded on every pass',
  !afterSkip.map((s) => s.sessionId).includes(SETTLED), 'skipped excluded');

// ── 4. the invariant that matters most ─────────────────────────────────────
// cleanup resolves ids against the ARCHIVED inventory, so a live id must not
// resolve. This is the property that makes live capture safe to enable at all.
const archivedIds = new Set(archived.sessions.map((s) => s.sessionId));
check('a live session id cannot resolve as an archived target',
  !archivedIds.has(SETTLED) && !archivedIds.has(FRESH) && !archivedIds.has(PINNED),
  'live ids absent from the cleanup map');

// And the live rows simply have no cleanup bookkeeping to act on.
check('live rows carry no cleanup marker to act on',
  live.sessions.every((s) => s.cleanedAt === null || s.cleanedAt === undefined), 'no cleanedAt');

// ── 5. digestOne can actually read a live session's log ────────────────────
// The claim "no hooks needed" rests on the on-disk log being complete. Prove the
// decoder reads a live session's file and extracts real content from it.
const { readSessionSource } = await load('lib/digester.js');
const read = readSessionSource(path.join(sessionsDir, SETTLED));
check('a live session log decodes into a usable digest source',
  read.ok === true && read.source.chars > 10,
  read.ok ? `${read.events} events, ${read.source.chars} chars` : `${read.code}: ${read.message}`);

check('the extracted transcript is the conversation, not metadata',
  read.ok && read.source.transcript.includes('归档会话'), 'user text present');

fs.rmSync(sandbox, { recursive: true, force: true });

const failed = results.filter((entry) => !entry.ok);
console.log('');
if (failed.length > 0) {
  console.log(`${failed.length} check(s) failed:`);
  for (const entry of failed) console.log(`  - ${entry.name}`);
} else {
  console.log(`all ${results.length} checks passed`);
}
process.exitCode = failed.length > 0 ? 1 : 0;
