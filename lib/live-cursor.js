/**
 * Read-only progress tracking for *in-progress* (live) sessions.
 *
 * Every other digest path runs on a session that is over. A live session never
 * is: the conversation continues while we read it. That shapes this whole file.
 *
 * 1. **The session log is READ-ONLY.** It belongs to the running agent, which is
 *    appending to it while we read. Writing a "digested" marker into it would
 *    corrupt a file the host is actively flushing. So the watermark lives here,
 *    in our own store, and a session file is only ever opened for reading.
 *
 * 2. **Already-digested content must never be digested twice.** `seq` is a dense,
 *    monotonic, never-reused append counter — measured on a real running session:
 *    8361 events, 0 gaps, 0 reuse, 0 order inversions — so "highest seq I have
 *    processed" is a complete and safe cursor. The host's own compaction does not
 *    break this: a `compaction/prune` event *shadows* a range
 *    (`{shadowedRange:{start,end}, shadowedSeqs, shadowedTokenCount}`) rather than
 *    removing it, so the log never rewrites history underneath the cursor.
 *
 * The cursor also records the segments already written, which is how the panel
 * can show exactly which part of a running conversation is already in memory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './memory-store.js';

const CURSORS_VERSION = 1;

/** Kept bounded: enough history for the panel, not an unbounded log of our own. */
const MAX_SEGMENTS = 200;

export function cursorsFile(storeRoot) {
  return path.join(paths(storeRoot).root, 'live-cursors.json');
}

function emptyCursors() {
  return { version: CURSORS_VERSION, updatedAt: null, sessions: {} };
}

export async function readCursors(storeRoot) {
  try {
    const text = await fs.readFile(cursorsFile(storeRoot), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return emptyCursors();
    const sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    return { version: CURSORS_VERSION, updatedAt: parsed.updatedAt ?? null, sessions: { ...sessions } };
  } catch {
    return emptyCursors();
  }
}

export async function writeCursors(storeRoot, cursors) {
  const p = paths(storeRoot);
  await fs.mkdir(p.root, { recursive: true });
  const file = cursorsFile(storeRoot);
  const next = { ...cursors, version: CURSORS_VERSION, updatedAt: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return next;
}

export function getCursor(cursors, sessionId) {
  const found = cursors?.sessions?.[sessionId];
  if (!found || typeof found !== 'object') {
    return { sessionId, lastSeq: 0, segments: [], digestedAt: null, bytesAtDigest: 0, mtimeMs: 0, totalTurns: 0 };
  }
  return {
    sessionId,
    lastSeq: Number(found.lastSeq) || 0,
    segments: Array.isArray(found.segments) ? found.segments : [],
    digestedAt: found.digestedAt ?? null,
    bytesAtDigest: Number(found.bytesAtDigest) || 0,
    mtimeMs: Number(found.mtimeMs) || 0,
    totalTurns: Number(found.totalTurns) || 0,
  };
}

/**
 * Detect a log that moved backwards.
 *
 * `seq` is append-only, so a *shorter* log than the one we digested means the
 * session was reset, truncated or replaced rather than continued. Keeping the old
 * watermark then would skip the new content forever, so the cursor must restart.
 * This is cheap insurance against a silent, permanent gap.
 */
export function detectRewind(cursor, stats = {}) {
  const bytes = Number(stats.bytes) || 0;
  const stored = Number(cursor?.bytesAtDigest) || 0;
  if (stored > 0 && bytes > 0 && bytes < stored) return true;
  const mtime = Number(stats.mtimeMs) || 0;
  const storedMtime = Number(cursor?.mtimeMs) || 0;
  return storedMtime > 0 && mtime > 0 && mtime < storedMtime;
}

/**
 * Split a parsed event list into "already digested" and "new".
 *
 * Returns the fresh slice plus the seq bounds needed to advance the cursor. When
 * there is no cursor yet every event is new, which is the first pass over a
 * session that was already running when capture was switched on.
 */
export function selectFresh(events, cursor, stats = {}) {
  const rewound = detectRewind(cursor, stats);
  const lastSeq = rewound ? 0 : Number(cursor?.lastSeq) || 0;
  let minSeq = null;
  let maxSeq = null;
  const fresh = [];
  for (const event of events) {
    const seq = Number.isInteger(event.seq) ? event.seq : null;
    if (seq !== null) maxSeq = maxSeq === null ? seq : Math.max(maxSeq, seq);
    // An event with no `seq` is the `session` header (the only event in a real log
    // without one, measured 8349/8350). It carries the identity — id, cwd,
    // createdAt — so it must travel with every pass rather than be left behind by
    // the watermark, which would strip the session's own metadata from the digest.
    if (seq === null) {
      fresh.push(event);
      continue;
    }
    if (seq <= lastSeq) continue;
    if (minSeq === null) minSeq = seq;
    fresh.push(event);
  }
  return { fresh, lastSeq, minSeq, maxSeq, rewound, already: events.length - fresh.length };
}

/**
 * Advance a session's cursor after a successful digest.
 *
 * The segment is what makes the read-only guarantee visible: it states exactly
 * which seq range this digest consumed, so a later pass can prove it is only
 * looking at newer events.
 */
export function advanceCursor(cursors, sessionId, segment, stats = {}) {
  const next = cursors ?? emptyCursors();
  const prior = getCursor(next, sessionId);
  const segments = [...prior.segments, segment];
  const trimmed = segments.length > MAX_SEGMENTS ? segments.slice(-MAX_SEGMENTS) : segments;
  next.sessions[sessionId] = {
    sessionId,
    lastSeq: Math.max(prior.lastSeq, Number(segment?.toSeq) || 0),
    segments: trimmed,
    // Kept separately so trimming the visible history cannot lose the total.
    segmentCount: segments.length,
    totalTurns: prior.totalTurns + (Number(segment?.turns) || 0),
    firstDigestedAt: prior.digestedAt ?? segment?.at ?? null,
    digestedAt: segment?.at ?? new Date().toISOString(),
    bytesAtDigest: Number(stats.bytes) || prior.bytesAtDigest,
    mtimeMs: Number(stats.mtimeMs) || prior.mtimeMs,
  };
  return next.sessions[sessionId];
}

/** Aggregate numbers for the panel headline. */
export function cursorStats(cursors) {
  const all = Object.values(cursors?.sessions ?? {});
  let segments = 0;
  let lastSeq = 0;
  let turns = 0;
  for (const cursor of all) {
    segments += Number(cursor?.segmentCount) || (Array.isArray(cursor?.segments) ? cursor.segments.length : 0);
    lastSeq = Math.max(lastSeq, Number(cursor?.lastSeq) || 0);
    turns += Number(cursor?.totalTurns) || 0;
  }
  return { sessions: all.length, segments, turns, maxSeq: lastSeq };
}

/** Human-readable progress label, used by both the panel and the tool output. */
export function cursorLabel(cursor) {
  if (!cursor || !cursor.digestedAt) return '未提炼';
  const count = Number(cursor.segmentCount) || cursor.segments.length;
  const from = cursor.segments[0]?.fromSeq;
  const to = cursor.lastSeq;
  const range = from === undefined ? `seq ≤ ${to}` : `seq ${from}–${to}`;
  return `${range} · ${count} 段`;
}
