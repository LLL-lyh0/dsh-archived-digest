/**
 * Durable job state.
 *
 * `memories/index.json` answers "what was digested" for the store, but the
 * scheduler also needs a few things that do not belong in a memory file: the
 * per-session attempts and failures (so a hopeless session is not retried
 * forever), the reclaimed-bytes ledger, and the run history shown in the panel.
 *
 * Everything here is best-effort and self-healing: a corrupt state file degrades
 * to empty rather than taking the plugin down, because losing job history is
 * recoverable while refusing to load the panel is not.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { paths, ensureStore } from './memory-store.js';

const STATE_VERSION = 1;

function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: null,
    digested: {},   // sessionId -> { at, title, chars, skills: string[], route }
    failed: {},     // sessionId -> { at, code, message, attempts }
    cleaned: {},    // sessionId -> { at, freedBytes, mode }
    /**
     * Sessions examined and found to hold nothing worth remembering.
     *
     * Distinct from `failed` on purpose. `EMPTY_SOURCE` means the conversation had
     * no substantive text — a normal outcome for a short live session, not a
     * defect. Recording those as failures would bury real failures under noise
     * once live capture is on (426 live sessions on this machine, most of them
     * one-liners), while leaving them unrecorded would re-decode them forever.
     */
    skipped: {},    // sessionId -> { at, code, reason }
    runs: [],       // newest first, capped
    totals: { freedBytes: 0, digested: 0, cleaned: 0, failed: 0, skipped: 0 },
  };
}

export async function readState(storeRoot) {
  const p = paths(storeRoot);
  const file = p.runState ?? path.join(p.root, 'state.json');
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return emptyState();
    const state = { ...emptyState(), ...parsed };
    for (const key of ['digested', 'failed', 'cleaned', 'skipped']) {
      if (state[key] === null || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {};
    }
    if (!Array.isArray(state.runs)) state.runs = [];
    state.totals = { ...emptyState().totals, ...(state.totals ?? {}) };
    return state;
  } catch {
    return emptyState();
  }
}

export async function writeState(storeRoot, state) {
  const p = await ensureStore(storeRoot);
  const file = p.runState ?? path.join(p.root, 'state.json');
  const next = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  // Keep the file bounded: the panel only ever shows the recent tail.
  if (Array.isArray(next.runs) && next.runs.length > 40) next.runs = next.runs.slice(0, 40);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return next;
}

export function recordDigest(state, sessionId, detail) {
  state.digested[sessionId] = { at: new Date().toISOString(), ...detail };
  delete state.failed[sessionId];
  // A late success supersedes an earlier "nothing here" verdict.
  delete state.skipped[sessionId];
  state.totals.digested = Object.keys(state.digested).length;
  state.totals.skipped = Object.keys(state.skipped).length;
  return state;
}

/**
 * Record an incremental pass over a session that is still running.
 *
 * `partial: true` is a safety flag, not bookkeeping: cleanup's guard is
 * "does `state.digested[sessionId]` exist", and an incremental pass creates that
 * entry after remembering only the events up to a cursor. Without the flag, a
 * running session that is later archived could have its whole log deleted on the
 * strength of a memory that stops mid-conversation. `cleanupSession` refuses a
 * partial entry; a completed archived digest overwrites it without the flag.
 */
export function recordLiveDigest(state, sessionId, detail) {
  return recordDigest(state, sessionId, { ...detail, live: true, partial: true });
}

export function recordFailure(state, sessionId, { code, message, attempts, attemptLog, raw, capture }) {
  const prior = state.failed[sessionId];
  // `attempts` must be a countable number: the retry gate compares it with
  // `>= maxAttempts`, and an array left in this field silently disables that gate
  // (and then corrupts itself into "[object Object]1" on the next failure).
  const priorCount = Number.isFinite(prior?.attempts) ? prior.attempts : 0;
  const count = Array.isArray(attempts)
    ? attempts.length
    : Number.isFinite(attempts)
      ? attempts
      : Array.isArray(attemptLog) && attemptLog.length > 0
        ? attemptLog.length
        : priorCount + 1;
  const log = Array.isArray(attemptLog) && attemptLog.length > 0
    ? attemptLog.slice(-6)
    : Array.isArray(prior?.attemptLog) && prior.attemptLog.length > 0
      ? prior.attemptLog
      : undefined;
  state.failed[sessionId] = {
    at: new Date().toISOString(),
    code,
    message: String(message ?? '').slice(0, 800),
    attempts: count,
    // Which routes/budgets were tried, in order: without this a MAX_TOKENS
    // failure cannot be told apart from "the very first call was truncated".
    attemptLog: log,
    // A bounded sample of the offending reply. Kept separate from `message` so the
    // panel can show the real text without blowing up the message field.
    rawSample: raw === undefined ? prior?.rawSample : String(raw).slice(0, 4000),
    // Stream diagnostics, kept small on purpose: enough to tell "the model wrote
    // prose" from "reasoning leaked into the text channel", without storing a
    // second copy of the reply in the state file.
    capture: capture ? {
      chunkTypes: [...new Set((capture.chunks ?? []).map((c) => `${c.type}${c.blockType ? `:${c.blockType}` : ''}`))].slice(0, 12),
      chunks: (capture.chunks ?? []).slice(0, 12),
      blocks: (capture.blocks ?? []).slice(0, 8),
      joined: capture.joined,
      assemblerText: String(capture.assemblerText ?? '').slice(0, 300),
    } : undefined,
  };
  state.totals.failed = Object.keys(state.failed).length;
  return state;
}

/**
 * Record a session that was examined and holds nothing to remember.
 *
 * Not a failure: this is the normal outcome for a short conversation. Kept
 * separate so the failures list stays meaningful, and recorded at all so the same
 * empty session is not re-decoded on every pass.
 */
export function recordSkip(state, sessionId, { code, reason }) {
  state.skipped[sessionId] = {
    at: new Date().toISOString(),
    code: String(code ?? 'SKIP'),
    reason: String(reason ?? '').slice(0, 300),
  };
  delete state.failed[sessionId];
  state.totals.skipped = Object.keys(state.skipped).length;
  return state;
}

export function recordCleanup(state, sessionId, { freedBytes, mode }) {
  const prior = state.cleaned[sessionId];
  const freed = Math.max(0, Number(freedBytes) || 0);
  state.cleaned[sessionId] = {
    at: new Date().toISOString(),
    freedBytes: (prior?.freedBytes ?? 0) + freed,
    mode,
  };
  state.totals.freedBytes = Number(state.totals.freedBytes ?? 0) + freed;
  state.totals.cleaned = Object.keys(state.cleaned).length;
  return state;
}

export function pushRun(state, run) {
  state.runs.unshift({ at: new Date().toISOString(), ...run });
  if (state.runs.length > 40) state.runs.length = 40;
  return state;
}
