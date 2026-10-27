/**
 * The engine: one archived session in, one memory (+ optional skills, optional
 * reclaimed disk space) out.
 *
 * Ordering here is the whole safety story. A session's log is the ONLY copy of
 * that conversation, so the rule is: **persist the memory first, verify it is on
 * disk, and only then allow the log to be cleaned.** Every path below keeps that
 * order, and a cleanup that is asked to run without a successful digest is
 * refused rather than "helpfully" performed.
 */

import path from 'node:path';
import { statSync } from 'node:fs';
import { readSessionLogText, parseEvents, extractDigestSource, findLogFile } from './session-log.js';
import { distillSession } from './distill.js';
import { routeCandidates } from './llm.js';
import { writeMemory, writeSkill, cleanSessionLogs, trashSessionDir, readMemoryIndex } from './memory-store.js';
import { readCursors, writeCursors, getCursor, selectFresh, advanceCursor } from './live-cursor.js';
import { findSessionDir } from './inventory.js';
import { readState, writeState, recordDigest, recordLiveDigest, recordFailure, recordCleanup, recordSkip, pushRun } from './state.js';

/** Signals that a digest cannot work and will never work: do not retry. */
const PERMANENT_CODES = new Set(['NO_LOG', 'EMPTY_SOURCE', 'PARSE_FAILED']);

/**
 * Codes meaning "this session holds nothing to remember", which is a normal
 * outcome rather than a defect. Tracked in `state.skipped`, not `state.failed`,
 * so a backlog of one-line conversations cannot drown the real failures.
 *
 * `NO_LOG` is deliberately absent: a missing or undecodable log is a real problem
 * with the store, not a quiet session, and it belongs in the failures list.
 */
const SKIP_CODES = new Set(['EMPTY_SOURCE']);

export const DEFAULT_OPTIONS = {
  /** Chars of transcript handed to the model. */
  maxSourceChars: 14000,
  /** Output ceiling. Truncation is reported as MAX_TOKENS, never as parse failure. */
  maxTokens: 2400,
  /** Whether a digest also writes skills, or only the memory. */
  extractSkills: true,
  /** `off` | `logs` | `dir` | `trash` */
  cleanupMode: 'off',
  /** Per-call timeout. Archived sessions can be huge; be generous but bounded. */
  callTimeoutMs: 120000,
};

async function resolveLlm(ctx) {
  try {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null;
    if (llm && typeof llm.stream === 'function') return llm;
  } catch {
    /* service not available in this composition */
  }
  return null;
}

export { resolveLlm };

/**
 * Load and condense one session's log.
 *
 * Split from the LLM call on purpose: reading is cheap and deterministic, so the
 * panel can show "this one has no usable text" without spending a token.
 */
export function readSessionSource(sessionDir, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const logFile = findLogFile(sessionDir);
  if (logFile === null) {
    return { ok: false, code: 'NO_LOG', message: 'session directory has no recognizable log file' };
  }
  const text = readSessionLogText(logFile);
  if (text === '') {
    return { ok: false, code: 'NO_LOG', message: 'log file could not be decoded (multi-frame zstd read produced no text)' };
  }
  const events = parseEvents(text);
  if (events.length === 0) {
    return { ok: false, code: 'NO_LOG', message: 'log decoded but contained no events' };
  }
  const source = extractDigestSource(events, {
    maxSourceChars: opts.maxSourceChars,
    perMessageCap: opts.perMessageCap,
  });
  if ((source.transcript ?? '').trim().length < 40) {
    return {
      ok: false,
      code: 'EMPTY_SOURCE',
      message: 'session has no substantive user/assistant text after stripping injected context',
      events: events.length,
    };
  }
  return { ok: true, logFile, events: events.length, eventList: events, source };
}

/**
 * Digest exactly one archived session.
 *
 * @param {object} params
 * @param {object} params.ctx cordis context (for the llm service)
 * @param {string} params.sessionId
 * @param {string} [params.sessionDir] resolved for you when omitted
 * @param {string} params.storeRoot
 * @param {{provider?: string, model?: string}} [params.route]
 * @param {object} [params.options] overrides of DEFAULT_OPTIONS
 * @param {AbortSignal} [params.signal]
 */
export async function digestOne({ ctx, sessionId, sessionDir, storeRoot, route, options = {}, signal }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const started = Date.now();

  const located = sessionDir ? { dir: sessionDir, workspaceSlug: path.basename(path.dirname(sessionDir)) } : findSessionDir(sessionId);
  if (located === null) {
    const failure = { ok: false, code: 'MISSING_DIR', message: 'archived session has no directory on disk', permanent: true };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }

  const read = readSessionSource(located.dir, opts);
  if (!read.ok) {
    // "Nothing worth remembering" is not a failure. A one-line live session is
    // the common case once live capture is on, and recording each as a failure
    // would bury the real ones — while not recording it would re-decode it on
    // every pass forever.
    if (SKIP_CODES.has(read.code)) {
      const skip = { ok: false, code: read.code, message: read.message, sessionId, skipped: true, permanent: true };
      await noteSkip(storeRoot, sessionId, skip);
      return skip;
    }
    const failure = { ...read, sessionId, permanent: PERMANENT_CODES.has(read.code) };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }

  const llm = await resolveLlm(ctx);
  if (llm === null) {
    const failure = { ok: false, code: 'NO_LLM', message: 'the llm service is not available in this composition' };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }
  const routes = await routeCandidates(llm, { provider: route?.provider, model: route?.model, limit: 4 });
  if (routes.length === 0) {
    const failure = { ok: false, code: 'NO_ROUTE', message: 'no llm provider/model pair is usable; set provider and model in the plugin config' };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }

  let result = await distillSession(llm, routes, { ...read.source, sessionId }, {
    maxSourceChars: opts.maxSourceChars,
    maxTokens: opts.maxTokens,
    signal: signal ?? AbortSignal.timeout(opts.callTimeoutMs),
  });
  /**
   * On truncation, shrink the input instead of only growing the budget.
   *
   * The llm layer already escalates the output budget to its ceiling on
   * MAX_TOKENS. That is not enough when the model spends the whole allowance
   * thinking: a real archived session failed with
   * `output hit the maxTokens=8000 ceiling and was truncated (reasoning 17853
   * chars before the answer)` — it had not written a single answer character.
   * A bigger budget would just buy more thinking. Less to reason about is the
   * change that actually lets the answer fit.
   */
  const floor = Math.max(1500, Math.round(opts.maxSourceChars * 0.25));
  let budgetChars = opts.maxSourceChars;
  while (!result.ok && result.code === 'MAX_TOKENS' && Array.isArray(read.eventList) && budgetChars > floor) {
    budgetChars = Math.max(floor, Math.round(budgetChars / 2));
    const smaller = extractDigestSource(read.eventList, { maxSourceChars: budgetChars });
    if ((smaller.transcript ?? '').trim().length < 40) break;
    result = await distillSession(llm, routes, { ...smaller, sessionId }, {
      maxSourceChars: budgetChars,
      maxTokens: opts.maxTokens,
      signal: signal ?? AbortSignal.timeout(opts.callTimeoutMs),
    });
  }
  if (!result.ok) {
    const failure = {
      ok: false,
      code: result.code,
      message: result.message,
      permanent: PERMANENT_CODES.has(result.code),
      // The llm layer reports one entry per route/budget it tried. Keep the list
      // for diagnosis but expose a plain count, which is what the retry gate and
      // the state file expect.
      attempts: Array.isArray(result.attempts) ? result.attempts.length : result.attempts,
      attemptLog: Array.isArray(result.attempts) ? result.attempts : undefined,
      raw: result.raw,
      capture: result.capture,
    };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }

  const digest = result.digest;
  const skillRefs = [];
  if (opts.extractSkills) {
    for (const skill of digest.skills) {
      try {
        const written = await writeSkill(storeRoot, skill, { sessionId });
        if (!written.skipped) skillRefs.push(written.slug);
      } catch (error) {
        // A skill failure must not cost us the memory that is already prepared.
        skillRefs.push(`!${skill.name || 'unnamed'}: ${String(error?.message ?? error)}`);
      }
    }
  }

  const record = {
    sessionId,
    title: digest.title,
    summary: digest.summary,
    decisions: digest.decisions,
    facts: digest.facts,
    openIssues: digest.openIssues,
    tags: digest.tags,
    decisionsCount: digest.decisions.length,
    createdAt: read.source.startedAt ? new Date(read.source.startedAt).toISOString() : null,
    digestedAt: new Date().toISOString(),
    turns: read.source.turns,
    bytes: read.source.chars,
    cwd: read.source.cwd || null,
    workspace: located.workspaceSlug ?? null,
    toolNames: read.source.toolNames,
    skillRefs,
  };

  const written = await writeMemory(storeRoot, record);

  // Verify before permitting any deletion: if the file is not there, stop.
  let state = await readState(storeRoot);
  recordDigest(state, sessionId, {
    title: digest.title,
    chars: written.entry.chars,
    skills: skillRefs,
    route: result.route ? `${result.route.provider}/${result.route.model}` : null,
    events: read.events,
  });

  let cleanup = null;
  if (opts.cleanupMode && opts.cleanupMode !== 'off') {
    // Persist the digest first. `cleanupSession` re-reads state from disk to
    // decide whether this session may be wiped, so an in-memory-only
    // `recordDigest` would look like "never digested" and the cleanup would be
    // refused with NOT_DIGESTED — silently, since the digest itself succeeded.
    await writeState(storeRoot, state);
    // Deliberately no `force`: the NOT_DIGESTED guard is the thing that keeps a
    // failed memory write from costing the log. With the state now on disk it
    // passes on its own, so there is no reason to bypass it.
    cleanup = await cleanupSession({ storeRoot, sessionId, sessionDir: located.dir, mode: opts.cleanupMode });
    if (cleanup?.ok) {
      // cleanupSession persists its own copy, so carry the reload forward —
      // otherwise the write below would drop the cleanup record again.
      state = await readState(storeRoot);
      recordCleanup(state, sessionId, { freedBytes: cleanup.freed, mode: cleanup.mode });
    }
  }

  pushRun(state, {
    kind: 'digest',
    sessionId,
    title: digest.title,
    code: 'OK',
    ms: Date.now() - started,
    skills: skillRefs.length,
    freedBytes: cleanup?.ok ? cleanup.freed : 0,
  });
  await writeState(storeRoot, state);

  return {
    ok: true,
    sessionId,
    title: digest.title,
    memoryFile: written.file,
    skills: skillRefs,
    cleanup,
    route: result.route,
    usage: result.usage,
    ms: Date.now() - started,
    // The caller folds this into the fact ledger. Passing the structured digest
    // (not the rendered markdown) is what lets the memory layer merge facts
    // across sessions instead of appending another wall of prose.
    digest: {
      title: digest.title,
      summary: digest.summary,
      decisions: digest.decisions,
      facts: digest.facts,
      openIssues: digest.openIssues,
      tags: digest.tags,
      skills: digest.skills,
      cwd: read.source.cwd || null,
      workspace: located.workspaceSlug ?? null,
    },
  };
}

async function noteFailure(storeRoot, sessionId, failure) {
  try {
    const state = await readState(storeRoot);
    recordFailure(state, sessionId, {
      code: failure.code,
      message: failure.message,
      attempts: failure.attempts,
      attemptLog: failure.attemptLog,
      // The reply that failed to parse: the only evidence that can turn a
      // "PARSE_FAILED" into a concrete fix.
      raw: failure.raw,
      // Diagnostics only: what the stream contained, so a failure that blames the
      // model can be told apart from reasoning leaking into the text channel.
      capture: failure.capture,
    });
    pushRun(state, { kind: 'digest', sessionId, code: failure.code, message: String(failure.message ?? '').slice(0, 300) });
    await writeState(storeRoot, state);
  } catch {
    /* failure bookkeeping must never mask the original failure */
  }
}

/** Bookkeeping for a session examined and found to hold nothing worth keeping. */
async function noteSkip(storeRoot, sessionId, skip) {
  try {
    const state = await readState(storeRoot);
    recordSkip(state, sessionId, { code: skip.code, reason: skip.message });
    pushRun(state, { kind: 'digest', sessionId, code: skip.code, skipped: true });
    await writeState(storeRoot, state);
  } catch {
    /* skip bookkeeping is informational */
  }
}

/**
 * Digest the *new* part of a running (not-yet-archived) session.
 *
 * Three rules make this different from `digestOne`:
 *
 * 1. **Read-only.** The log belongs to a live agent process that is appending to
 *    it right now. Nothing here writes to the session directory — the watermark
 *    that marks "already digested" lives in our own store (`live-cursors.json`),
 *    never in the session file. `assertReadOnly` below enforces that the session
 *    path is only ever opened for reading.
 * 2. **Incremental.** Only events with `seq > cursor.lastSeq` are extracted, so
 *    content already in memory is never re-sent to the model. On success the
 *    cursor advances to the highest seq consumed.
 * 3. **Accumulating.** The memory file keeps the earlier passes under
 *    "Earlier updates" rather than overwriting them, because each pass sees only a
 *    slice of the conversation.
 */
export async function digestLiveIncremental({ ctx, sessionId, sessionDir, storeRoot, route, options = {}, signal }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const located = sessionDir ? { dir: sessionDir, workspaceSlug: path.basename(path.dirname(sessionDir)) } : findSessionDir(sessionId);
  if (located === null) {
    const failure = { ok: false, code: 'MISSING_DIR', message: 'live session has no directory on disk', permanent: true };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }

  const cursors = await readCursors(storeRoot);
  const cursor = getCursor(cursors, sessionId);
  const stats = sessionStats(located.dir);

  const read = readSessionSource(located.dir, opts);
  if (!read.ok) {
    // A running session with nothing substantive yet is normal, not a failure.
    if (SKIP_CODES.has(read.code)) {
      const skip = { ok: false, code: read.code, message: read.message, sessionId, skipped: true, permanent: true };
      await noteSkip(storeRoot, sessionId, skip);
      return skip;
    }
    const failure = { ...read, sessionId, permanent: PERMANENT_CODES.has(read.code) };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }

  const selection = selectFresh(read.eventList ?? [], cursor, stats);
  if (selection.fresh.length === 0) {
    // Nothing new since the last pass. This is the common case for a session that
    // is still open but idle, and it must not be recorded as a failure.
    return {
      ok: true,
      incremental: true,
      unchanged: true,
      code: 'UP_TO_DATE',
      sessionId,
      lastSeq: cursor.lastSeq,
      message: 'no events newer than the last digested seq',
    };
  }

  const source = extractDigestSource(selection.fresh, {
    maxSourceChars: opts.maxSourceChars,
    perMessageCap: opts.perMessageCap,
    // Belt and braces: even if a caller hands us the full event list, the cursor
    // still excludes what was already consumed.
    sinceSeq: selection.lastSeq,
  });
  if ((source.transcript ?? '').trim().length < 40) {
    // New events exist but they are machinery (tool results, status), not
    // conversation. Advance past them so they are not re-read every pass.
    const segment = {
      fromSeq: selection.minSeq,
      toSeq: selection.maxSeq,
      at: new Date().toISOString(),
      turns: 0,
      chars: 0,
      summary: '',
      decisions: [],
      facts: [],
      openIssues: [],
      empty: true,
    };
    advanceCursor(cursors, sessionId, segment, stats);
    await writeCursors(storeRoot, cursors);
    return {
      ok: true,
      incremental: true,
      unchanged: true,
      code: 'NO_CONVERSATION',
      sessionId,
      message: 'new events carry no user/assistant text',
      advanced: `${selection.minSeq}–${selection.maxSeq}`,
    };
  }

  const llm = await resolveLlm(ctx);
  if (llm === null) {
    const failure = { ok: false, code: 'NO_LLM', message: 'the llm service is not available in this composition' };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }
  const routes = await routeCandidates(llm, { provider: route?.provider, model: route?.model, limit: 4 });
  if (routes.length === 0) {
    const failure = { ok: false, code: 'NO_ROUTE', message: 'no llm provider/model pair is usable; set provider and model in the plugin config' };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }

  let result = await distillSession(llm, routes, { ...source, sessionId }, {
    maxSourceChars: opts.maxSourceChars,
    maxTokens: opts.maxTokens,
    signal: signal ?? AbortSignal.timeout(opts.callTimeoutMs),
  });
  // Same truncation strategy as the archived path: less input beats more budget.
  const floor = Math.max(1500, Math.round(opts.maxSourceChars * 0.25));
  let budgetChars = opts.maxSourceChars;
  while (!result.ok && result.code === 'MAX_TOKENS' && budgetChars > floor) {
    budgetChars = Math.max(floor, Math.round(budgetChars / 2));
    const smaller = extractDigestSource(selection.fresh, {
      maxSourceChars: budgetChars,
      perMessageCap: opts.perMessageCap,
      sinceSeq: selection.lastSeq,
    });
    if ((smaller.transcript ?? '').trim().length < 40) break;
    result = await distillSession(llm, routes, { ...smaller, sessionId }, {
      maxSourceChars: budgetChars,
      maxTokens: opts.maxTokens,
      signal: signal ?? AbortSignal.timeout(opts.callTimeoutMs),
    });
  }

  if (!result.ok) {
    // The cursor is deliberately NOT advanced: the next pass must retry this same
    // slice, or a transient failure would leave a permanent hole in memory.
    const failure = {
      ok: false,
      code: result.code,
      message: result.message,
      permanent: PERMANENT_CODES.has(result.code),
      attempts: Array.isArray(result.attempts) ? result.attempts.length : result.attempts,
      attemptLog: Array.isArray(result.attempts) ? result.attempts : undefined,
      raw: result.raw,
      capture: result.capture,
    };
    await noteFailure(storeRoot, sessionId, failure);
    return failure;
  }

  const digest = result.digest;
  const skillRefs = [];
  if (opts.extractSkills) {
    for (const skill of digest.skills) {
      try {
        const written = await writeSkill(storeRoot, skill, { sessionId });
        if (!written.skipped) skillRefs.push(written.slug);
      } catch (error) {
        skillRefs.push(`!${skill.name || 'unnamed'}: ${String(error?.message ?? error)}`);
      }
    }
  }

  // Fold the previous body into history so an incremental pass extends the memory
  // instead of replacing the earlier hours of the conversation.
  const memoryIndex = await readMemoryIndex(storeRoot);
  const prior = memoryIndex.entries[sessionId];
  const history = Array.isArray(prior?.history) ? [...prior.history] : [];
  if (prior && !prior.live) {
    // A session first digested as archived/one-shot, now being extended.
    history.push({
      fromSeq: prior.fromSeq ?? null,
      toSeq: prior.toSeq ?? null,
      at: prior.digestedAt ?? null,
      summary: prior.summary ?? '',
      decisions: [], facts: [], openIssues: [],
    });
  } else if (prior) {
    history.push({
      fromSeq: prior.fromSeq ?? null,
      toSeq: prior.toSeq ?? null,
      at: prior.digestedAt ?? null,
      summary: prior.summary ?? '',
      decisions: [], facts: [], openIssues: [],
    });
  }

  const record = {
    sessionId,
    title: digest.title,
    summary: digest.summary,
    decisions: digest.decisions,
    facts: digest.facts,
    openIssues: digest.openIssues,
    tags: digest.tags,
    createdAt: source.startedAt ? new Date(source.startedAt).toISOString() : null,
    digestedAt: new Date().toISOString(),
    turns: source.turns,
    bytes: source.chars,
    cwd: source.cwd || null,
    workspace: located.workspaceSlug ?? null,
    toolNames: source.toolNames,
    skillRefs,
    live: true,
    history,
    fromSeq: segmentFrom(selection),
    toSeq: selection.maxSeq,
  };
  const written = await writeMemory(storeRoot, record);

  const segment = {
    fromSeq: segmentFrom(selection),
    toSeq: selection.maxSeq,
    at: record.digestedAt,
    turns: source.turns,
    chars: written.entry.chars,
    summary: digest.summary,
    decisions: digest.decisions,
    facts: (digest.facts ?? []).map((item) => (typeof item === 'string' ? item : item?.value ?? item?.text ?? '')).filter(Boolean),
    openIssues: digest.openIssues,
  };
  // Advance only after the memory is on disk: the cursor is the promise that this
  // range is remembered, so it must not run ahead of the write.
  advanceCursor(cursors, sessionId, segment, stats);
  await writeCursors(storeRoot, cursors);

  const state = await readState(storeRoot);
  // Recorded through the *live* variant so the entry is flagged `live: true`.
  // Cleanup's guard is `state.digested[sessionId]`, and the archived cleanup pass
  // resolves ids against the archived inventory — but marking a running session
  // plainly "digested" would still hand it a deletion permit if it is archived
  // later in the same state file. The flag keeps the two kinds distinguishable.
  recordLiveDigest(state, sessionId, {
    title: digest.title,
    chars: written.entry.chars,
    skills: skillRefs,
    route: result.route ? `${result.route.provider}/${result.route.model}` : null,
    events: selection.fresh.length,
    seq: `${segmentFrom(selection)}–${selection.maxSeq}`,
    bytesAtDigest: stats.bytes,
  });
  pushRun(state, {
    kind: 'live-digest',
    sessionId,
    title: digest.title,
    code: 'OK',
    seq: `${segmentFrom(selection)}–${selection.maxSeq}`,
    events: selection.fresh.length,
  });
  await writeState(storeRoot, state);

  return {
    ok: true,
    incremental: true,
    sessionId,
    title: digest.title,
    memoryFile: written.file,
    digest,
    skills: skillRefs,
    route: result.route,
    seq: { from: segmentFrom(selection), to: selection.maxSeq },
    freshEvents: selection.fresh.length,
    alreadyDigested: selection.already,
    rewound: selection.rewound,
  };
}

function segmentFrom(selection) {
  return selection.minSeq ?? selection.maxSeq ?? 0;
}

/** Read-only stats for a session directory; never opens it for writing. */
function sessionStats(sessionDir) {
  const file = findLogFile(sessionDir);
  if (file === null) return { bytes: 0, mtimeMs: 0 };
  try {
    const stats = statSync(file);
    return { bytes: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return { bytes: 0, mtimeMs: 0 };
  }
}

/**
 * Free the disk space of one archived session.
 *
 * Refuses unless the session already has a memory on disk — the caller can
 * bypass that with `force` only when it is explicitly deleting rather than
 * cleaning (the panel asks the user in that case).
 */
export async function cleanupSession({ storeRoot, sessionId, sessionDir, mode = 'logs', force = false }) {
  const located = sessionDir ? { dir: sessionDir } : findSessionDir(sessionId);
  if (located === null) return { ok: false, code: 'MISSING_DIR', message: 'already gone' };

  const state = await readState(storeRoot);
  if (!force && !state.digested[sessionId]) {
    return {
      ok: false,
      code: 'NOT_DIGESTED',
      message: 'refusing to clean a session that has no stored memory; digest it first',
    };
  }
  // A partial (incremental) memory stops at a cursor, so deleting the log would
  // destroy the rest of the conversation. Refuse until a full digest replaces it.
  if (!force && state.digested[sessionId]?.partial === true) {
    return {
      ok: false,
      code: 'PARTIAL_DIGEST',
      message: 'this session was only captured incrementally; a full digest is required before its log may be removed',
    };
  }

  try {
    const result = mode === 'dir'
      ? await cleanSessionLogs(located.dir, { mode: 'dir', storeRoot })
      : mode === 'trash'
        ? await trashSessionDir(located.dir, { storeRoot })
        : await cleanSessionLogs(located.dir, { mode: 'logs', storeRoot });
    const next = await readState(storeRoot);
    recordCleanup(next, sessionId, { freedBytes: result.freed, mode });
    await writeState(storeRoot, next);
    return { ok: true, freed: result.freed, mode: result.mode, removed: result.removed ?? null };
  } catch (error) {
    return { ok: false, code: 'CLEAN_FAILED', message: String(error?.message ?? error) };
  }
}

/**
 * Batch runner.
 *
 * Sequential on purpose: these calls are LLM-bound and the machine is interactive
 * — fanning out 8 concurrent 2.4k-token requests would just make the user's own
 * chat slow to get a token. Progress is streamed through `onProgress` so the
 * panel can show a live row-by-row advance.
 */
export async function runBatch({
  ctx,
  sessionIds,
  storeRoot,
  route,
  options = {},
  signal,
  onProgress,
  shouldStop,
}) {
  const results = [];
  for (let i = 0; i < sessionIds.length; i += 1) {
    if (signal?.aborted || shouldStop?.()) break;
    const sessionId = sessionIds[i];
    onProgress?.({ phase: 'start', index: i, total: sessionIds.length, sessionId });
    let outcome;
    try {
      outcome = await digestOne({ ctx, sessionId, storeRoot, route, options, signal });
    } catch (error) {
      outcome = { ok: false, code: 'INTERNAL', message: String(error?.message ?? error) };
    }
    results.push({ sessionId, ...outcome });
    onProgress?.({ phase: 'done', index: i, total: sessionIds.length, sessionId, outcome });
  }
  return results;
}

/**
 * How long a live session's log must stop changing before it counts as finished.
 *
 * Nothing is archived until the user archives it, so without this a conversation
 * that just ended never reaches memory. The rule is deliberately
 * "mtime is old enough" rather than "the session ended": the on-disk log is the
 * only source used, and a threshold needs no host cooperation. 90s is longer than
 * any mid-turn pause (a model call plus a long tool run) and short enough that a
 * conversation is remembered the same day.
 */
export const LIVE_SETTLE_MS = 90_000;

/**
 * Candidates the scheduler should consider.
 *
 * `archivedFirst` keeps the original ordering (oldest log first) for archived
 * sessions; live sessions are newer by definition and are ordered newest-first so
 * the conversation just finished is the one remembered next.
 */
export function needsDigest(sessions, state, { retryFailed = false, maxAttempts = 3, now = Date.now(), settleMs = LIVE_SETTLE_MS, live = false } = {}) {
  const out = [];
  for (const session of sessions) {
    // A *partial* entry is an incremental capture that stopped at a cursor. It
    // must not count as digested here, or the session could never receive the full
    // digest that would replace it — and `cleanupSession` refuses a partial entry,
    // so such a session would become both uncleanable and undigestible forever.
    const partial = session.partial === true;
    if (session.digestedAt && !partial) continue;
    if (session.pinned) continue;
    if (session.cleanedAt) continue;
    if (!session.present) continue;
    if (session.bytes === 0) continue;
    // A live session still being written is skipped: digesting it now would
    // remember half a conversation, and the next pass would pick it up anyway.
    if (live && now - (session.mtimeMs || 0) < settleMs) continue;
    // A session already examined and found empty is not re-decoded forever.
    // Without this, 426 mostly-one-line live sessions would each be read on
    // every pass for no benefit.
    if (state.skipped?.[session.sessionId]) continue;
    const failure = state.failed?.[session.sessionId];
    if (failure) {
      if (!retryFailed) continue;
      if ((failure.attempts ?? 0) >= maxAttempts) continue;
      // A parse failure means the model ignored the format; retrying the same
      // session burns tokens for the same answer.
      if (PERMANENT_CODES.has(failure.code)) continue;
    }
    out.push(session);
  }
  // Archived: oldest first, the sessions least likely to be reopened again.
  // Live: newest first, the conversation that just settled.
  out.sort((a, b) => (live ? (b.mtimeMs || 0) - (a.mtimeMs || 0) : (a.mtimeMs || 0) - (b.mtimeMs || 0)));
  return out;
}
