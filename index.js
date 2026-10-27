/**
 * dsh-archived-digest — Host half.
 *
 * Archived sessions are, on this machine, 77 conversations and 411 MB of logs
 * that nobody will read again. This plugin turns each one into a short memory
 * plus (optionally) a reusable skill, stores them in one managed place, and can
 * then reclaim the log bytes.
 *
 * Three roots of the design:
 *
 *  - **Nothing is deleted before its memory is on disk.** `digester.js` enforces
 *    the order; this file only exposes it.
 *  - **Automation is opt-in and can be switched off.** With `autoEnabled: false`
 *    there is no timer, no background work, and the plugin is purely manual.
 *  - **The panel is the control surface.** Every action is one HTTP route that
 *    wraps one function, and the same functions back the agent tools, so the UI
 *    and the model cannot drift.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  paths,
  ensureStore,
  readMemoryIndex,
  readSkillIndex,
  storeStats,
  removeMemory,
  removeSkill,
  purgeTrash,
} from './lib/memory-store.js';
import { listArchivedSessions, listLiveSessions, totalLogBytes, findSessionDir } from './lib/inventory.js';
import { readState, writeState, pushRun } from './lib/state.js';
import {
  digestOne,
  digestLiveIncremental,
  cleanupSession,
  needsDigest,
  runBatch,
  readSessionSource,
  resolveLlm,
} from './lib/digester.js';
import { readCursors, getCursor, cursorStats, cursorLabel } from './lib/live-cursor.js';
import { selfCheck, catalogCost, findRedundantSkills } from './lib/selfcheck.js';
import { routeCandidates } from './lib/llm.js';
import {
  readFacts,
  writeFacts,
  searchFacts,
  renderFacts,
  factStats,
  applyWrite,
  forgetFact,
  strengthOf,
  FACT_KINDS,
} from './lib/facts.js';
import {
  buildTopics,
  findTopics,
  ingestDigestFacts,
  pruneTopics,
} from './lib/consolidate.js';
import { detectBackends, exportAll, buildExportDocument } from './lib/backends.js';

export const inject = ['webServer', 'tools'];

const NS = 'dsh-archived-digest';
const ROUTE_BASE = '/api/dsh-archived-digest';
/**
 * Build stamp for the running instance. Exposed in /status so a stale host — one
 * still executing a pre-edit copy of this file — is visible from the panel
 * instead of looking like a logic bug. Bump on every behavioural change.
 */
// Bumped whenever the plugin's own behaviour changes. The panel shows it, and
// scripts/reload.sh asserts it, so "the fix did not help" can never secretly mean
// "the host is still executing the previous module graph".
const BUILD = 'selfcheck-tabs-12';
/** Mutating requests must carry this header (client marker, CSRF fence). */
const CLIENT_MARKER_HEADER = 'x-dsh-archived-digest';
const MAX_BODY_BYTES = 1 << 20;

/** Runtime settings, persisted in the store so the panel can edit them. */
const DEFAULT_SETTINGS = {
  /** Master switch for the background pass. False = fully manual. */
  autoEnabled: false,
  /** Minutes between automatic passes. */
  autoIntervalMinutes: 30,
  /** Max sessions digested per automatic pass (cost control). */
  autoMaxPerRun: 3,
  /** Retry sessions that previously failed with a non-permanent error. */
  autoRetryFailed: true,
  /** What to do with a session's log after a successful digest. */
  cleanupMode: 'off', // off | logs | dir | trash
  /** Only clean sessions older than N days (avoids touching recent ones). */
  cleanupMinAgeDays: 7,
  /** Write skills as well as memories. */
  extractSkills: true,
  /** Fold each digest's facts into the fact ledger (merged, not appended). */
  extractFacts: true,
  /** Re-cluster topics automatically after a digest batch. */
  autoConsolidate: true,
  /** Push consolidated memory to a mounted memory backend when one exists. */
  exportToBackend: true,
  /**
   * Also digest *live* (not-yet-archived) sessions, so the conversation you just
   * had reaches memory. Off by default: this machine has 426 live sessions and
   * digesting them all costs a model call each.
   */
  captureLiveSessions: false,
  /** How many settled live sessions an automatic pass may digest. */
  liveMaxPerRun: 2,
  /** A live log must be quiet this long before it counts as finished. */
  liveSettleSeconds: 90,
  /**
   * Digest the *new* part of a session that is still running.
   *
   * Separate from `captureLiveSessions`, which waits for a session to stop
   * changing. This one reads a session mid-conversation, only takes events newer
   * than its cursor, and never writes to the session — so it can remember a long
   * conversation as it happens instead of forgetting the beginning by the time it
   * ends. Off by default because it spends a model call per pass.
   */
  incrementalLiveCapture: false,
  /** Minimim new events before a running session is worth another pass. */
  incrementalMinEvents: 40,
  /** Assess accumulated memory and compact it (self-check). */
  selfCheckEnabled: false,
  /** Minutes between automatic self-checks. */
  selfCheckIntervalMinutes: 720,
  /** Apply the self-check's repairs automatically (vs. only reporting them). */
  selfCheckApply: false,
  /** Let a self-check merge near-duplicate skills (visible in the skills center). */
  selfCheckMergeSkills: false,
  /** Let a self-check purge quarantined trash directories. */
  selfCheckPurgeTrash: false,
  /** Transcript chars sent to the model. */
  maxSourceChars: 14000,
  /** Output ceiling per digest. */
  maxTokens: 2400,
  /** Explicit route; empty = auto-pick among registered providers. */
  provider: '',
  model: '',
};

function settingsFile(storeRoot) {
  return path.join(paths(storeRoot).root, 'settings.json');
}

async function readSettings(storeRoot) {
  try {
    const raw = await fs.readFile(settingsFile(storeRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** True when the user (or a previous run) has already persisted settings. */
async function settingsExist(storeRoot) {
  try {
    await fs.access(settingsFile(storeRoot));
    return true;
  } catch {
    return false;
  }
}

async function writeSettings(storeRoot, patch) {
  const current = await readSettings(storeRoot);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const expected = typeof DEFAULT_SETTINGS[key];
    if (typeof value !== expected) continue;
    next[key] = value;
  }
  // Guard the ranges the scheduler divides by.
  next.autoIntervalMinutes = Math.min(1440, Math.max(5, Number(next.autoIntervalMinutes) || 30));
  next.autoMaxPerRun = Math.min(20, Math.max(1, Number(next.autoMaxPerRun) || 3));
  next.cleanupMinAgeDays = Math.min(3650, Math.max(0, Number(next.cleanupMinAgeDays) || 0));
  next.maxSourceChars = Math.min(120000, Math.max(2000, Number(next.maxSourceChars) || 14000));
  next.maxTokens = Math.min(16000, Math.max(400, Number(next.maxTokens) || 2400));
  await ensureStore(storeRoot);
  const file = settingsFile(storeRoot);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return next;
}

// ── run coordination ────────────────────────────────────────────────────────

/** One in-memory run record; the panel polls `/run` while a batch is going. */
function createRunRegistry() {
  /** @type {{ id: number, kind: string, total: number, done: number, current: string|null, phase: string, startedAt: number, finishedAt: number|null, error: string|null, results: object[], abort: AbortController|null }} */
  let current = null;
  let seq = 0;
  return {
    start(kind, total) {
      seq += 1;
      current = {
        id: seq,
        kind,
        total,
        done: 0,
        current: null,
        phase: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        results: [],
        abort: new AbortController(),
      };
      return current;
    },
    get() {
      if (current === null) return null;
      const { abort, ...rest } = current;
      return { ...rest, aborted: abort.signal.aborted };
    },
    signal() {
      return current?.abort.signal ?? null;
    },
    progress(payload) {
      if (current === null) return;
      current.phase = payload.phase === 'start' ? 'running' : current.phase;
      current.done = payload.phase === 'start' ? payload.index : payload.index + 1;
      current.current = payload.sessionId;
      if (payload.phase === 'done' && payload.outcome) {
        current.results.push({
          sessionId: payload.sessionId,
          ok: payload.outcome.ok === true,
          code: payload.outcome.code ?? 'OK',
          title: payload.outcome.title ?? null,
          message: payload.outcome.ok ? null : String(payload.outcome.message ?? '').slice(0, 300),
          freed: payload.outcome.cleanup?.ok ? payload.outcome.cleanup.freed : 0,
        });
      }
    },
    finish(error) {
      if (current === null) return;
      current.phase = error ? 'failed' : 'finished';
      current.error = error ?? null;
      current.finishedAt = Date.now();
      current.current = null;
    },
    stop() {
      current?.abort.abort();
      return current !== null;
    },
    busy() {
      return current !== null && current.phase === 'running';
    },
  };
}

// ── operational functions (shared by HTTP and tools) ────────────────────────

function buildOps(ctx, storeRootRef) {
  const runs = createRunRegistry();
  const storeRoot = () => storeRootRef.value;

  async function snapshot() {
    const root = storeRoot();
    const settings = await readSettings(root);
    const state = await readState(root);
    const memoryIndex = await readMemoryIndex(root);
    const skillIndex = await readSkillIndex(root);
    const stats = await storeStats(root);
    const inventory = listArchivedSessions({
      digested: Object.fromEntries(Object.entries(state.digested).map(([id, entry]) => [id, entry])),
      cleaned: state.cleaned,
      storeRoot: root,
    });
    const pending = needsDigest(inventory.sessions, state, {
      retryFailed: settings.autoRetryFailed,
      maxAttempts: 3,
    });
    const all = totalLogBytes();
    let memory = { facts: null, topics: 0, backends: [] };
    try {
      const ledger = await readFacts(root);
      memory = {
        facts: factStats(ledger),
        topics: ledger.topics.length,
        backends: detectBackends(ctx).map((backend) => backend.id),
      };
    } catch {
      /* a broken ledger must not blank the whole overview */
    }
    let llmReady = false;
    let llmNote = null;
    try {
      const llm = await resolveLlm(ctx);
      if (llm === null) llmNote = 'llm service unavailable';
      else {
        const routes = await routeCandidates(llm, { provider: settings.provider, model: settings.model, limit: 1 });
        llmReady = routes.length > 0;
        if (!llmReady) llmNote = 'no usable provider/model';
      }
    } catch (error) {
      llmNote = String(error?.message ?? error);
    }
    let cursors = null;
    try {
      cursors = cursorStats(await readCursors(root));
    } catch {
      /* a missing cursor file just means nothing has been captured incrementally */
    }
    return {
      ok: true,
      build: BUILD,
      settings,
      llm: { ready: llmReady, note: llmNote },
      store: { ...stats, root },
      memory,
      live: cursors,
      counts: {
        archived: inventory.archivedCount,
        missing: inventory.missing,
        present: inventory.sessions.filter((s) => s.present).length,
        digested: inventory.sessions.filter((s) => s.digestedAt).length,
        cleaned: Object.keys(state.cleaned).length,
        pending: pending.length,
        failed: Object.keys(state.failed).length,
        memories: Object.keys(memoryIndex.entries).length,
        skills: Object.keys(skillIndex.entries).length,
        facts: memory.facts?.live ?? 0,
        topics: memory.topics ?? 0,
        liveCaptured: cursors?.sessions ?? 0,
        liveSegments: cursors?.segments ?? 0,
      },
      bytes: {
        archivedLogs: inventory.totalBytes,
        allLogs: all.bytes,
        allSessions: all.sessions,
        workspaces: all.workspaces,
        freed: Number(state.totals.freedBytes ?? 0),
        store: stats.memoryBytes + stats.skillBytes,
      },
      run: runs.get(),
      runs: state.runs,
      failures: Object.entries(state.failed)
        .map(([sessionId, detail]) => ({ sessionId, ...detail }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, 40),
    };
  }

  async function sessions() {
    const root = storeRoot();
    const state = await readState(root);
    const settings = await readSettings(root);
    const inventory = listArchivedSessions({ digested: state.digested, cleaned: state.cleaned, storeRoot: root });
    const live = listLiveSessions({ digested: state.digested });
    const settleMs = Math.max(10_000, Number(settings.liveSettleSeconds) * 1000);
    const livePending = needsDigest(live.sessions, state, {
      retryFailed: settings.autoRetryFailed,
      live: true,
      settleMs,
    });
    const decorate = (session) => ({
      ...session,
      failed: state.failed[session.sessionId] ?? null,
      // The panel needs to know why a row is not actionable.
      blocked: session.digestedAt ? 'digested' : (session.pinned ? 'pinned' : (session.present ? null : 'missing')),
    });
    return {
      ok: true,
      sessions: inventory.sessions.map(decorate),
      // Live sessions are a separate list so the archived view keeps its shape.
      live: live.sessions.map(decorate),
      liveReady: livePending.map((session) => session.sessionId),
      counts: {
        archived: inventory.archivedCount,
        pending: needsDigest(inventory.sessions, state, { retryFailed: settings.autoRetryFailed }).length,
        live: live.liveCount,
        livePending: livePending.length,
        liveBytes: live.totalBytes,
      },
    };
  }

  async function memories(query) {
    const root = storeRoot();
    const index = await readMemoryIndex(root);
    const q = String(query ?? '').trim().toLowerCase();
    let list = Object.values(index.entries);
    if (q !== '') {
      list = list.filter((entry) => `${entry.title} ${entry.summary} ${(entry.tags ?? []).join(' ')}`.toLowerCase().includes(q));
    }
    list.sort((a, b) => String(b.digestedAt ?? '').localeCompare(String(a.digestedAt ?? '')));
    return { ok: true, memories: list, total: Object.keys(index.entries).length };
  }

  async function memory(sessionId) {
    const root = await ensureStore(storeRoot());
    const index = await readMemoryIndex(root.root);
    const entry = index.entries[sessionId];
    if (!entry) return { ok: false, code: 'NOT_FOUND', message: 'no memory for that session' };
    try {
      const text = await fs.readFile(path.join(root.root, entry.file), 'utf8');
      return { ok: true, entry, text };
    } catch (error) {
      return { ok: false, code: 'READ_FAILED', message: String(error?.message ?? error) };
    }
  }

  async function skills() {
    const root = storeRoot();
    const index = await readSkillIndex(root);
    const list = Object.values(index.entries).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return { ok: true, skills: list, total: list.length };
  }

  async function skill(slug) {
    const root = await ensureStore(storeRoot());
    const index = await readSkillIndex(root.root);
    const entry = index.entries[slug];
    if (!entry) return { ok: false, code: 'NOT_FOUND', message: 'no such skill' };
    try {
      const text = await fs.readFile(path.join(root.root, entry.file), 'utf8');
      return { ok: true, entry, text };
    } catch (error) {
      return { ok: false, code: 'READ_FAILED', message: String(error?.message ?? error) };
    }
  }

  /** Run a digest batch. Returns as soon as the batch is registered. */
  async function digest({ sessionIds, limit, force, live }) {
    if (runs.busy()) return { ok: false, code: 'BUSY', message: 'a digest run is already in progress' };
    const root = storeRoot();
    const settings = await readSettings(root);
    const state = await readState(root);
    const inventory = listArchivedSessions({ digested: state.digested, cleaned: state.cleaned, storeRoot: root });
    const liveInventory = listLiveSessions({ digested: state.digested });
    const settleMs = Math.max(10_000, Number(settings.liveSettleSeconds) * 1000);

    // Explicit ids may name either scope — a caller passing an id it read from
    // the live list must not get "unknown session" back.
    const known = new Map([
      ...inventory.sessions.map((session) => [session.sessionId, session]),
      ...liveInventory.sessions.map((session) => [session.sessionId, session]),
    ]);
    let targets;
    if (Array.isArray(sessionIds) && sessionIds.length > 0) {
      targets = sessionIds
        .map((id) => known.get(String(id)))
        .filter((session) => session !== undefined)
        // A live session is never "cleaned", so this filter is archived-only in
        // practice; it stays here because `force` must still mean what it says.
        .filter((session) => force || !session.cleanedAt);
    } else if (live === true || (live === undefined && settings.captureLiveSessions === true)) {
      targets = needsDigest(liveInventory.sessions, state, {
        retryFailed: settings.autoRetryFailed,
        live: true,
        settleMs,
      });
      const liveCap = Math.min(20, Math.max(1, Number(settings.liveMaxPerRun) || 2));
      targets = targets.slice(0, Number(limit) > 0 ? Number(limit) : liveCap);
    } else {
      targets = needsDigest(inventory.sessions, state, { retryFailed: settings.autoRetryFailed });
    }
    const cap = Math.min(50, Math.max(1, Number(limit) > 0 ? Number(limit) : (targets.length || 1)));
    targets = targets.slice(0, cap);
    if (targets.length === 0) {
      return { ok: true, started: false, message: 'nothing to digest', count: 0 };
    }

    const ids = targets.map((session) => session.sessionId);
    runs.start('digest', ids.length);
    // Fire and forget: the panel polls `/run` for progress.
    void (async () => {
      try {
        const results = await runBatch({
          ctx,
          sessionIds: ids,
          storeRoot: root,
          route: { provider: settings.provider || undefined, model: settings.model || undefined },
          options: {
            extractSkills: settings.extractSkills,
            maxSourceChars: settings.maxSourceChars,
            maxTokens: settings.maxTokens,
            cleanupMode: 'off', // cleanup happens in the separate, age-gated pass
          },
          signal: runs.signal(),
          onProgress: (payload) => runs.progress(payload),
        });
        const failed = results.filter((result) => !result.ok);
        // Facts land in the ledger for every successful digest. This is the
        // step that turns 77 independent summaries into one queryable memory.
        if (settings.extractFacts) {
          for (const result of results) {
            if (!result.ok || !result.digest) continue;
            try {
              await ingestDigestFacts(root, result.digest, result.sessionId);
            } catch (error) {
              console.warn(`[${NS}] fact ingest failed for ${result.sessionId}:`, error);
            }
          }
        }
        let consolidated = null;
        if (settings.autoConsolidate) {
          try {
            consolidated = await consolidate();
          } catch (error) {
            console.warn(`[${NS}] consolidation failed:`, error);
          }
        }
        const finalState = await readState(root);
        pushRun(finalState, {
          kind: 'digest',
          code: failed.length === 0 ? 'OK' : 'PARTIAL',
          count: results.length,
          failed: failed.length,
          topics: consolidated?.topics ?? null,
        });
        await writeState(root, finalState);
        runs.finish(failed.length > 0 && results.length === failed.length ? 'all sessions failed' : null);
      } catch (error) {
        runs.finish(String(error?.message ?? error));
      }
    })();

    return { ok: true, started: true, count: ids.length, sessionIds: ids };
  }

  // ── memory layer: facts, topics, retrieval, export ──────────────────────

  /**
   * Rebuild topics from the fact ledger.
   *
   * Idempotent by construction: topics are a pure function of the facts, so
   * running this repeatedly rewrites rather than accumulates. Pruning runs first
   * so a topic whose facts were all superseded does not linger as an empty shell.
   */
  /**
   * Resolve a fact's subject from the memory written for the session it came from.
   *
   * Facts carry no subject of their own when they were ingested before subjects
   * existed, and subject is what lets facts from *different* sessions group at
   * all: two sessions about the same Unity bug share almost no characters
   * ("碰撞体穿透" vs "ShipHullCollision 扫掠"), so similarity alone leaves nearly
   * every fact in its own topic.
   */
  async function memorySubjectOf(root) {
    const index = await readMemoryIndex(root);
    return (fact) => {
      const sources = Array.isArray(fact?.sources) && fact.sources.length > 0
        ? fact.sources
        : (fact?.source ? [fact.source] : []);
      for (const id of sources) {
        const entry = index.entries[id];
        if (entry?.title) return entry.title;
      }
      return '';
    };
  }

  async function consolidate() {
    const root = storeRoot();
    const ledger = await readFacts(root);
    const subjectOf = await memorySubjectOf(root);
    // Backfill subjects onto facts written before this existed, and persist them,
    // so the ledger stops fragmenting instead of needing a re-digest.
    for (const fact of ledger.facts) {
      if (fact.topic || fact.validUntil) continue;
      const derived = subjectOf(fact);
      if (derived) fact.topic = String(derived).slice(0, 80);
    }
    pruneTopics(ledger);
    const topics = buildTopics(ledger, { subjectOf });
    ledger.topics = topics;
    await writeFacts(root, ledger);
    let exportResult = null;
    const settings = await readSettings(root);
    if (settings.exportToBackend) {
      try {
        exportResult = await exportAll(ctx, root, { ledger });
      } catch (error) {
        exportResult = { ok: false, results: [], error: String(error?.message ?? error) };
      }
    }
    const state = await readState(root);
    pushRun(state, { kind: 'consolidate', code: 'OK', topics: topics.length, exported: exportResult?.results ?? [] });
    await writeState(root, state);
    return {
      ok: true,
      topics: topics.length,
      facts: factStats(ledger),
      export: exportResult,
    };
  }

  /** Search consolidated memory: topics first (they carry context), facts as fallback. */
  async function recall(query, options = {}) {
    const root = storeRoot();
    const ledger = await readFacts(root);
    const topics = findTopics(ledger, query, { limit: options.topicLimit ?? 5 });
    const facts = searchFacts(ledger, query, { limit: options.factLimit ?? 20, kind: options.kind ?? null });
    return {
      ok: true,
      query: String(query ?? ''),
      topics,
      facts: facts.map((entry) => ({
        ...entry.fact,
        relevance: Number(entry.relevance.toFixed(3)),
        strength: Number(entry.strength.toFixed(3)),
        score: Number(entry.score.toFixed(3)),
      })),
      block: renderFacts(facts, { heading: 'Relevant memory' }),
      stats: factStats(ledger),
    };
  }

  /** Add one fact by hand (agent or panel), through the same merge pipeline. */
  async function remember(payload) {
    const root = storeRoot();
    const ledger = await readFacts(root);
    const before = ledger.facts.filter((fact) => !fact.validUntil).length;
    const items = Array.isArray(payload?.facts) ? payload.facts : [payload];
    const applied = [];
    for (const item of items) {
      const result = applyWrite(ledger, {
        text: item?.text,
        kind: FACT_KINDS.includes(item?.kind) ? item.kind : 'fact',
        topic: typeof item?.topic === 'string' ? item.topic : null,
        tags: Array.isArray(item?.tags) ? item.tags : [],
        source: typeof item?.source === 'string' && item.source !== '' ? item.source : 'manual',
      });
      applied.push({ op: result.op, id: result.fact?.id ?? null, text: result.fact?.text ?? '' });
    }
    const topics = buildTopics(ledger, { subjectOf: await memorySubjectOf(root) });
    ledger.topics = topics;
    await writeFacts(root, ledger);
    return {
      ok: true,
      applied,
      counts: applied.reduce((acc, entry) => {
        acc[entry.op] = (acc[entry.op] ?? 0) + 1;
        return acc;
      }, {}),
      liveBefore: before,
      liveAfter: ledger.facts.filter((fact) => !fact.validUntil).length,
      stats: factStats(ledger),
    };
  }

  /** List every live fact (panel browsing), grouped by topic. */
  async function listFacts() {
    const root = storeRoot();
    const ledger = await readFacts(root);
    const live = ledger.facts
      .filter((fact) => !fact.validUntil)
      .map((fact) => ({ ...fact, strength: Number(strengthOf(fact).toFixed(3)) }))
      .sort((a, b) => b.strength - a.strength);
    return {
      ok: true,
      facts: live,
      invalidated: ledger.facts.filter((fact) => fact.validUntil).map((fact) => ({
        id: fact.id,
        text: fact.text,
        kind: fact.kind,
        validUntil: fact.validUntil,
        supersededBy: fact.supersededBy ?? null,
      })),
      topics: ledger.topics,
      stats: factStats(ledger),
    };
  }

  async function forgetFactById({ id, text: needle }) {
    const root = storeRoot();
    const ledger = await readFacts(root);
    const result = forgetFact(ledger, { id, text: needle });
    const topicsNext = buildTopics(ledger, { subjectOf: await memorySubjectOf(root) });
    ledger.topics = topicsNext;
    await writeFacts(root, ledger);
    return { ok: true, ...result, topics: topicsNext.length, stats: factStats(ledger) };
  }

  async function topics() {
    const root = storeRoot();
    const ledger = await readFacts(root);
    return { ok: true, topics: ledger.topics, stats: factStats(ledger) };
  }

  async function exportMemory() {
    const root = storeRoot();
    const ledger = await readFacts(root);
    const result = await exportAll(ctx, root, { ledger });
    return { ...result, document: buildExportDocument(ledger), backends: detectBackends(ctx) };
  }

  /**
   * Reclaim log bytes.
   *
   * `onlyDigested` defaults to true and is enforced here, not in the panel: a
   * cleanup call that would destroy a conversation with no stored memory is
   * exactly the mistake this plugin exists to avoid.
   */
  async function cleanup({ sessionIds, allDigested, onlyDigested = true, mode, minAgeDays }) {
    if (runs.busy()) return { ok: false, code: 'BUSY', message: 'a digest run is in progress' };
    const root = storeRoot();
    const settings = await readSettings(root);
    const state = await readState(root);
    const inventory = listArchivedSessions({ digested: state.digested, cleaned: state.cleaned, storeRoot: root });
    const effectiveMode = typeof mode === 'string' && ['logs', 'dir', 'trash'].includes(mode) ? mode : (settings.cleanupMode === 'off' ? 'logs' : settings.cleanupMode);
    const ageDays = Number.isFinite(Number(minAgeDays)) ? Number(minAgeDays) : settings.cleanupMinAgeDays;
    const ageFloor = ageDays > 0 ? Date.now() - ageDays * 86400000 : 0;

    let targets;
    if (Array.isArray(sessionIds) && sessionIds.length > 0) {
      const known = new Map(inventory.sessions.map((session) => [session.sessionId, session]));
      targets = sessionIds.map((id) => known.get(String(id))).filter(Boolean);
    } else if (allDigested === true) {
      targets = inventory.sessions.filter((session) => state.digested[session.sessionId] && !state.cleaned[session.sessionId]);
    } else {
      targets = [];
    }
    targets = targets.filter((session) => session.present && !session.pinned);
    // Age gate: never reclaim a log that was written moments ago — the user may
    // still be inside that conversation. Freshness is measured from the log's
    // own mtime, NOT from the digest time: an old session digested one minute
    // ago is still an old session.
    if (ageFloor > 0) {
      targets = targets.filter((session) => {
        const mtime = Number(session.mtimeMs) || 0;
        return mtime > 0 && mtime <= ageFloor;
      });
    }
    if (onlyDigested) targets = targets.filter((session) => state.digested[session.sessionId]);

    if (targets.length === 0) return { ok: true, cleaned: 0, freed: 0, message: 'nothing to clean' };

    const results = [];
    let freed = 0;
    for (const session of targets) {
      const outcome = await cleanupSession({
        storeRoot: root,
        sessionId: session.sessionId,
        sessionDir: session.dir,
        mode: effectiveMode,
        force: !onlyDigested,
      });
      if (outcome.ok) freed += outcome.freed;
      results.push({ sessionId: session.sessionId, ok: outcome.ok === true, code: outcome.code ?? 'OK', freed: outcome.freed ?? 0 });
    }
    const next = await readState(root);
    pushRun(next, { kind: 'cleanup', code: 'OK', count: results.length, freedBytes: freed, mode: effectiveMode });
    await writeState(root, next);
    return { ok: true, cleaned: results.filter((r) => r.ok).length, freed, mode: effectiveMode, results };
  }

  async function updateSettings(patch) {
    const next = await writeSettings(storeRoot(), patch);
    return { ok: true, settings: next };
  }

  async function forget({ sessionId, slug, purgeTrashToo }) {
    const root = storeRoot();
    const out = {};
    if (typeof sessionId === 'string' && sessionId !== '') out.memory = await removeMemory(root, sessionId);
    if (typeof slug === 'string' && slug !== '') out.skill = await removeSkill(root, slug);
    if (purgeTrashToo === true) out.trash = await purgeTrash(root);
    return { ok: true, ...out };
  }

  /** Read-only probe: how much usable text does this session have? */
  async function inspect(sessionId) {
    const located = findSessionDir(sessionId);
    if (located === null) return { ok: false, code: 'MISSING_DIR', message: 'no directory for that session' };
    const read = readSessionSource(located.dir, { maxSourceChars: 14000 });
    if (!read.ok) return { ok: false, ...read, dir: located.dir };
    return {
      ok: true,
      dir: located.dir,
      workspaceSlug: located.workspaceSlug,
      events: read.events,
      title: read.source.title,
      turns: read.source.turns,
      keptTurns: read.source.keptTurns,
      chars: read.source.chars,
      toolNames: read.source.toolNames,
      preview: read.source.transcript.slice(0, 1200),
    };
  }

  /**
   * Digest the *new* part of sessions that are still running.
   *
   * Read-only by construction (see `lib/live-cursor.js`): the session log is never
   * opened for writing, and the "already digested" watermark lives in our own
   * store. A session is only picked up once it has accumulated enough new events,
   * and each pass advances its cursor, so nothing is sent to the model twice.
   */
  async function digestIncremental({ sessionIds, limit } = {}) {
    if (runs.busy()) return { ok: false, code: 'BUSY', message: 'a digest run is already in progress' };
    const root = storeRoot();
    const settings = await readSettings(root);
    const state = await readState(root);
    const cursors = await readCursors(root);
    const liveInventory = listLiveSessions({ digested: state.digested });

    // Every running session with room for another pass; the cursor is what makes
    // "room" precise rather than a guess.
    const candidates = [];
    for (const session of liveInventory.sessions) {
      if (session.pinned || session.cleanedAt || !session.present || session.bytes === 0) continue;
      const cursor = getCursor(cursors, session.sessionId);
      if (cursor.lastSeq > 0 && session.bytes <= cursor.bytesAtDigest) continue;
      candidates.push({ session, cursor });
    }

    const explicit = Array.isArray(sessionIds) && sessionIds.length > 0
      ? new Set(sessionIds.map(String))
      : null;
    const minEvents = Math.max(1, Number(settings.incrementalMinEvents) || 40);
    const chosen = [];
    for (const entry of candidates) {
      if (explicit !== null && !explicit.has(entry.session.sessionId)) continue;
      const freshBytes = Math.max(0, entry.session.bytes - (entry.cursor.bytesAtDigest || 0));
      // A first pass over a long-running session has no cursor at all; anything
      // else must clear the threshold so a two-line reply is not a model call.
      const needed = entry.cursor.lastSeq === 0 ? 1 : minEvents;
      if (freshBytes <= 0 && entry.cursor.lastSeq !== 0) continue;
      chosen.push({ ...entry, freshBytes, needed });
    }
    chosen.sort((a, b) => b.freshBytes - a.freshBytes);

    const cap = Math.min(20, Math.max(1, Number(limit) > 0 ? Number(limit) : (Number(settings.liveMaxPerRun) || 2)));
    const targets = chosen.slice(0, cap);
    if (targets.length === 0) {
      return { ok: true, started: false, message: '没有可增量提炼的进行中会话', count: 0 };
    }

    const ids = targets.map((entry) => entry.session.sessionId);
    runs.start('live-digest', ids.length);
    void (async () => {
      try {
        const results = [];
        for (let i = 0; i < ids.length; i += 1) {
          if (runs.signal()?.aborted) break;
          const entry = targets[i];
          runs.progress({ phase: 'start', index: i, total: ids.length, sessionId: entry.session.sessionId });
          let outcome;
          try {
            outcome = await digestLiveIncremental({
              ctx,
              sessionId: entry.session.sessionId,
              sessionDir: entry.session.dir,
              storeRoot: root,
              route: { provider: settings.provider || undefined, model: settings.model || undefined },
              options: {
                extractSkills: settings.extractSkills,
                maxSourceChars: settings.maxSourceChars,
                maxTokens: settings.maxTokens,
              },
              signal: runs.signal(),
            });
          } catch (error) {
            outcome = { ok: false, code: 'INTERNAL', message: String(error?.message ?? error) };
          }
          results.push({ sessionId: entry.session.sessionId, ...outcome });
          runs.progress({ phase: 'done', index: i, total: ids.length, sessionId: entry.session.sessionId, outcome });
        }
        const failed = results.filter((result) => !result.ok);
        if (settings.extractFacts) {
          for (const result of results) {
            if (!result.ok || !result.digest) continue;
            try {
              await ingestDigestFacts(root, result.digest, result.sessionId);
            } catch (error) {
              console.warn(`[${NS}] incremental fact ingest failed for ${result.sessionId}:`, error);
            }
          }
        }
        if (settings.autoConsolidate) {
          try { await consolidate(); } catch (error) { console.warn(`[${NS}] consolidation failed:`, error); }
        }
        const finalState = await readState(root);
        pushRun(finalState, {
          kind: 'live-digest',
          code: failed.length === 0 ? 'OK' : 'PARTIAL',
          count: results.length,
          failed: failed.length,
        });
        await writeState(root, finalState);
        runs.finish(failed.length > 0 && results.length === failed.length ? 'all live sessions failed' : null);
      } catch (error) {
        runs.finish(String(error?.message ?? error));
      }
    })();

    return { ok: true, started: true, count: ids.length, sessionIds: ids };
  }

  /** Progress of every live session: what is already in memory, and what is not. */
  async function liveCursors() {
    const root = storeRoot();
    const cursors = await readCursors(root);
    const state = await readState(root);
    const inventory = listLiveSessions({ digested: state.digested });
    const sessions = inventory.sessions.map((session) => {
      const cursor = getCursor(cursors, session.sessionId);
      const pending = Math.max(0, session.bytes - (cursor.bytesAtDigest || 0));
      return {
        sessionId: session.sessionId,
        workspaceSlug: session.workspaceSlug,
        bytes: session.bytes,
        mtimeMs: session.mtimeMs,
        pinned: session.pinned,
        title: session.digestTitle ?? null,
        digestedAt: cursor.digestedAt,
        lastSeq: cursor.lastSeq,
        segments: Number(cursor.segmentCount) || cursor.segments.length,
        totalTurns: cursor.totalTurns,
        label: cursorLabel({ ...cursor, segmentCount: Number(cursor.segmentCount) || cursor.segments.length }),
        pendingBytes: pending,
        // "Up to date" is measured against the log, not a timer: bytes unchanged
        // since the last digest means there is nothing new to take.
        upToDate: cursor.lastSeq > 0 && session.bytes <= cursor.bytesAtDigest,
      };
    });
    sessions.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    return {
      ok: true,
      sessions: sessions.slice(0, 200),
      total: sessions.length,
      capturing: sessions.filter((session) => session.digestedAt).length,
      pending: sessions.filter((session) => !session.upToDate && session.bytes > 0).length,
      stats: cursorStats(cursors),
      bytes: inventory.totalBytes,
      settings: {
        incrementalLiveCapture: (await readSettings(root)).incrementalLiveCapture === true,
      },
    };
  }

  /** Run the self-check: report always, repair only when asked. */
  async function selfCheckNow({ apply, mergeSkillDuplicates, purgeTrash: purgeToo, mergeFacts: doFacts, pruneStale } = {}) {
    const root = storeRoot();
    const settings = await readSettings(root);
    const result = await selfCheck(root, {
      apply: apply === true,
      mergeFacts: doFacts !== false,
      pruneStale: pruneStale !== false,
      mergeSkillDuplicates: mergeSkillDuplicates ?? settings.selfCheckMergeSkills === true,
      purgeTrash: purgeToo ?? settings.selfCheckPurgeTrash === true,
    });
    if (apply === true) {
      const state = await readState(root);
      pushRun(state, {
        kind: 'self-check',
        code: 'OK',
        factsRetired: result.facts.retiredDuplicates,
        stalePruned: result.facts.stalePruned,
        skillsMerged: (result.skills.merges ?? []).filter((merge) => merge.action === 'merged').length,
      });
      await writeState(root, state);
    }
    return result;
  }

  /** Read-only diagnosis of accumulated memory (no writes at all). */
  async function memoryHealth() {
    const root = storeRoot();
    const ledger = await readFacts(root);
    const skillIndex = await readSkillIndex(root);
    const memoryIndex = await readMemoryIndex(root);
    const cursors = await readCursors(root);
    const live = ledger.facts.filter((fact) => !fact.validUntil);
    return {
      ok: true,
      facts: {
        live: live.length,
        invalidated: ledger.facts.length - live.length,
        topics: (ledger.topics ?? []).length,
        byKind: live.reduce((acc, fact) => { acc[fact.kind] = (acc[fact.kind] ?? 0) + 1; return acc; }, {}),
      },
      skills: {
        ...catalogCost(skillIndex),
        redundant: findRedundantSkills(skillIndex).length,
      },
      memories: Object.keys(memoryIndex.entries ?? {}).length,
      live: cursorStats(cursors),
    };
  }

  /**
   * Rename one live session through the host's own title service.
   *
   * The title is a projection folded from `session/title` events, so writing the
   * cache file directly would be overwritten on the next fold. The supported path
   * is `ctx.sessionTitle.rename(session, title)`, which appends a `session/title`
   * event with `source.kind: 'user'` — that also pins the title, so automatic
   * generation stops overwriting it later.
   */
  async function renameSession({ sessionId, title } = {}) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    const next = typeof title === 'string' ? title.trim() : '';
    if (id === '') return { ok: false, code: 'error.input.sessionId', message: 'rename needs a sessionId' };
    if (next === '') return { ok: false, code: 'error.input.title', message: 'rename needs a non-empty title' };
    const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null;
    if (!service || typeof service.rename !== 'function') {
      return { ok: false, code: 'NO_SERVICE', message: 'the sessionTitle service is not available in this composition' };
    }
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(id) : null;
    if (!session) {
      return { ok: false, code: 'NOT_LIVE', message: `session ${id} is not live, so its title cannot be renamed` };
    }
    try {
      const snapshot = service.rename(session, next);
      return { ok: true, sessionId: id, title: snapshot?.title ?? next, source: snapshot?.source?.kind ?? 'user' };
    } catch (error) {
      return { ok: false, code: 'RENAME_FAILED', message: String(error?.message ?? error) };
    }
  }

  return {
    runs, snapshot, sessions, memories, memory, skills, skill, digest, cleanup, updateSettings, forget, inspect,
    // memory layer
    consolidate, recall, remember, listFacts, forgetFactById, topics, exportMemory,
    // incremental live capture + self-check
    digestIncremental, liveCursors, selfCheckNow, memoryHealth,
    // host services
    renameSession,
  };
}

// ── HTTP surface ────────────────────────────────────────────────────────────

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

function sendJson(res, code, payload) {
  if (!res || res.writableEnded || res.destroyed) return;
  try {
    const body = JSON.stringify(payload);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  } catch {
    /* client gone */
  }
}

function isLoopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const name = parsed.hostname;
  if (name === 'localhost' || name === '[::1]' || name === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/** Reject cross-site callers: Host must be loopback, Origin must match it. */
function checkOrigin(req) {
  const host = req.headers.host;
  if (!isLoopbackAuthority(host)) return { code: 'error.proto.forbiddenHost', error: 'forbidden host' };
  if (req.headers['sec-fetch-site'] === 'cross-site') return { code: 'error.proto.forbiddenHost', error: 'forbidden host' };
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { code: 'error.proto.forbiddenHost', error: 'forbidden host' };
    }
    if (originHost !== host) return { code: 'error.proto.forbiddenHost', error: 'forbidden host' };
  }
  return null;
}

function routeHandler(ops) {
  return async (req, res) => {
    const denied = checkOrigin(req);
    if (denied) {
      sendJson(res, 403, { ok: false, ...denied });
      return;
    }
    let pathname = '/';
    let search = '';
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = url.pathname.replace(/\/+$/, '') || '/';
      search = url.searchParams.get('q') ?? url.searchParams.get('sessionId') ?? url.searchParams.get('name') ?? '';
      if (pathname.startsWith(ROUTE_BASE)) pathname = pathname.slice(ROUTE_BASE.length) || '/';
    } catch {
      sendJson(res, 400, { ok: false, code: 'error.proto.url', error: 'bad url' });
      return;
    }

    const isMutation = req.method !== 'GET' && req.method !== 'HEAD';
    if (isMutation && req.headers[CLIENT_MARKER_HEADER] !== '1') {
      sendJson(res, 403, { ok: false, code: 'error.proto.forbidden', error: 'forbidden mutation request' });
      return;
    }

    let body = {};
    if (isMutation) {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'error.input.body', error: String(error?.message ?? error) });
        return;
      }
    }

    try {
      switch (pathname) {
        case '/status':
          sendJson(res, 200, await ops.snapshot());
          return;
        case '/sessions':
          sendJson(res, 200, await ops.sessions());
          return;
        case '/memories':
          sendJson(res, 200, await ops.memories(search));
          return;
        case '/memory':
          sendJson(res, 200, await ops.memory(search));
          return;
        case '/skills':
          sendJson(res, 200, await ops.skills());
          return;
        case '/skill':
          sendJson(res, 200, await ops.skill(search));
          return;
        case '/inspect':
          sendJson(res, 200, await ops.inspect(search));
          return;
        case '/run':
          sendJson(res, 200, { ok: true, run: ops.runs.get() });
          return;
        case '/settings':
          sendJson(res, 200, await ops.updateSettings(body ?? {}));
          return;
        case '/digest':
          sendJson(res, 200, await ops.digest(body ?? {}));
          return;
        case '/cleanup':
          sendJson(res, 200, await ops.cleanup(body ?? {}));
          return;
        case '/forget':
          sendJson(res, 200, await ops.forget(body ?? {}));
          return;
        case '/run/stop':
          sendJson(res, 200, { ok: true, stopped: ops.runs.stop() });
          return;
        // ── memory layer ──
        case '/topics':
          sendJson(res, 200, await ops.topics());
          return;
        case '/facts':
          sendJson(res, 200, await ops.listFacts());
          return;
        case '/recall':
          sendJson(res, 200, await ops.recall(search));
          return;
        case '/remember':
          sendJson(res, 200, await ops.remember(body ?? {}));
          return;
        case '/consolidate':
          sendJson(res, 200, await ops.consolidate());
          return;
        case '/export':
          sendJson(res, 200, await ops.exportMemory());
          return;
        case '/fact/forget':
          sendJson(res, 200, await ops.forgetFactById(body ?? {}));
          return;
        // ── incremental live capture + self-check ──
        case '/live':
          sendJson(res, 200, await ops.liveCursors());
          return;
        case '/live/digest':
          sendJson(res, 200, await ops.digestIncremental(body ?? {}));
          return;
        case '/selfcheck':
          sendJson(res, 200, await ops.selfCheckNow(body ?? {}));
          return;
        case '/health':
          sendJson(res, 200, await ops.memoryHealth());
          return;
        case '/rename':
          sendJson(res, 200, await ops.renameSession(body ?? {}));
          return;
        default:
          sendJson(res, 404, { ok: false, code: 'error.proto.notFound', error: `unknown route: ${pathname}` });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'error.internal', error: String(error?.message ?? error) });
    }
  };
}

// ── agent tools ─────────────────────────────────────────────────────────────

function textRender(value) {
  if (value && value.ok === false) {
    return [{ type: 'text', text: `归档提炼失败${typeof value.code === 'string' ? ` (${value.code})` : ''}: ${value.error ?? value.message ?? '未知错误'}` }];
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function registerTools(ctx, ops) {
  ctx.effect(() => ctx.tools.register({
    name: 'archived_digest',
    description: 'Manage this machine\'s archived DSH conversations: list what is archived and how big it is, distill archived sessions into stored memories + reusable skills, and reclaim the log disk space afterwards. Use when the user asks about archived/history sessions, wants old conversations summarized or cleaned up, or asks where distilled memories and skills are stored. Distilling spends model tokens; cleanup deletes logs and is refused when a session has no stored memory.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'sessions', 'digest', 'cleanup', 'memories', 'skills', 'inspect', 'topics', 'facts', 'recall', 'remember', 'consolidate', 'export', 'live', 'live-digest', 'selfcheck', 'health'],
          description: 'status = overview + settings; sessions = archived list; digest = distill sessions into memories; cleanup = reclaim log bytes; memories/skills = read the store; inspect = preview one session\'s digest source without spending tokens. Memory layer: topics/facts = consolidated memory; recall = search memory; remember = add one fact through the merge pipeline; consolidate = re-cluster topics; export = push memory to a mounted backend. Incremental: live = progress of running sessions (read-only cursors); live-digest = digest only the events a running session accumulated since its last pass. Self-check: health = read-only diagnosis of accumulated memory; selfcheck = report (and with apply:true, compact) duplicate facts, stale open items, redundant skills and trash.',
        },
        sessionIds: { type: 'array', items: { type: 'string' }, description: 'Target session ids. Omit for digest=next-pending and cleanup=digested-only. live-digest: which running sessions to take.' },
        limit: { type: 'number', description: 'Max sessions to process in this call (digest, live-digest).' },
        mode: { type: 'string', enum: ['logs', 'dir', 'trash'], description: 'cleanup mode: logs deletes .zstd payloads only; dir removes the session directory; trash moves it to the store\'s trash.' },
        force: { type: 'boolean', description: 'digest: include already-cleaned sessions. cleanup: allow cleaning sessions with no stored memory (destructive).' },
        apply: { type: 'boolean', description: 'selfcheck: actually compact. Default false = report only. Facts are superseded (never deleted) when applied.' },
        mergeSkills: { type: 'boolean', description: 'selfcheck: also fold near-duplicate skills together. Affects the agent\'s visible skill catalog, so it is off unless asked.' },
        purgeTrash: { type: 'boolean', description: 'selfcheck: also delete everything in the store\'s trash directory.' },
        query: { type: 'string', description: 'recall: what to look for in consolidated memory (topics + facts).' },
        text: { type: 'string', description: 'remember: the fact text. Passed through the same merge pipeline as digested facts, so a restatement updates the existing fact instead of duplicating it.' },
        kind: { type: 'string', enum: ['decision', 'fact', 'preference', 'pitfall', 'procedure', 'open'], description: 'remember: fact kind (decides decay and ranking).' },
        topic: { type: 'string', description: 'remember: optional topic label to file the fact under.' },
        facts: { type: 'array', items: { type: 'object' }, description: 'remember: batch form, each {text, kind?, topic?}.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: textRender },
    async execute(args) {
      switch (args?.action) {
        case 'status':
          return ops.snapshot();
        case 'sessions':
          return ops.sessions();
        case 'digest':
          return ops.digest({ sessionIds: args?.sessionIds, limit: args?.limit, force: args?.force === true });
        case 'cleanup':
          return ops.cleanup({
            sessionIds: args?.sessionIds,
            allDigested: !Array.isArray(args?.sessionIds) || args.sessionIds.length === 0,
            onlyDigested: args?.force !== true,
            mode: args?.mode,
          });
        case 'memories':
          return ops.memories('');
        case 'skills':
          return ops.skills();
        case 'inspect':
          if (typeof args?.sessionIds?.[0] !== 'string') {
            return { ok: false, code: 'error.input.sessionId', message: 'inspect needs sessionIds[0]' };
          }
          return ops.inspect(args.sessionIds[0]);
        // ── memory layer ──
        case 'consolidate':
          return ops.consolidate();
        case 'recall':
          return ops.recall(String(args?.query ?? ''));
        case 'remember':
          return ops.remember({
            text: args?.text,
            kind: args?.kind,
            topic: args?.topic,
            facts: Array.isArray(args?.facts) ? args.facts : undefined,
          });
        case 'topics':
          return ops.topics();
        case 'facts':
          return ops.listFacts();
        case 'export':
          return ops.exportMemory();
        // ── incremental live capture + self-check ──
        case 'live':
          return ops.liveCursors();
        case 'live-digest':
          return ops.digestIncremental({ sessionIds: args?.sessionIds, limit: args?.limit });
        case 'selfcheck':
          return ops.selfCheckNow({
            apply: args?.apply === true,
            mergeSkillDuplicates: args?.mergeSkills === true,
            purgeTrash: args?.purgeTrash === true,
          });
        case 'health':
          return ops.memoryHealth();
        default:
          return { ok: false, code: 'error.input.action', message: `unknown action: ${args?.action}` };
      }
    },
  }), `${NS}: archived_digest tool`);
}

// ── background scheduler ────────────────────────────────────────────────────

/**
 * The automatic pass.
 *
 * Re-read on every tick rather than captured once, so flipping the switch in the
 * panel takes effect without restarting the plugin. When `autoEnabled` is false
 * the timer still exists but does nothing — cheaper than tearing down and
 * recreating the interval, and it keeps the setting toggle instant.
 */
function startScheduler(ctx, ops, storeRootRef) {
  let ticking = false;
  let lastRunAt = 0;
  let lastSelfCheckAt = 0;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const settings = await readSettings(storeRootRef.value);
      // The self-check is independent of the digest switch: assessing accumulated
      // memory is useful even when nothing new is being ingested.
      if (settings.selfCheckEnabled) {
        const selfEvery = Math.max(30, Number(settings.selfCheckIntervalMinutes) || 720) * 60000;
        if (lastSelfCheckAt === 0 || Date.now() - lastSelfCheckAt >= selfEvery) {
          lastSelfCheckAt = Date.now();
          try {
            await ops.selfCheckNow({ apply: settings.selfCheckApply === true });
          } catch (error) {
            console.warn(`[${NS}] self-check failed:`, error);
          }
        }
      }
      if (!settings.autoEnabled) return;
      if (ops.runs.busy()) return;

      // The interval is a setting, so it is compared here rather than baked into
      // setInterval: changing it must not require re-creating the timer.
      const every = Math.max(5, Number(settings.autoIntervalMinutes) || 30) * 60000;
      if (lastRunAt !== 0 && Date.now() - lastRunAt < every) return;
      lastRunAt = Date.now();

      // Incremental capture first: it is the smallest, most current work, and it
      // spends a call only when a running session actually grew.
      if (settings.incrementalLiveCapture) {
        try {
          await ops.digestIncremental({ limit: Number(settings.liveMaxPerRun) || 2 });
          for (let i = 0; i < 600 && ops.runs.busy(); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch (error) {
          console.warn(`[${NS}] incremental capture failed:`, error);
        }
      }

      const root = storeRootRef.value;
      const state = await readState(root);
      const inventory = listArchivedSessions({ digested: state.digested, cleaned: state.cleaned, storeRoot: root });
      const pending = needsDigest(inventory.sessions, state, {
        retryFailed: settings.autoRetryFailed,
        maxAttempts: 3,
      });

      // Live (not-yet-archived) sessions are a separate, separately-capped pass:
      // they are the conversation the user just had, and they must not let a
      // 426-session backlog crowd out the archived work.
      const settleMs = Math.max(10_000, Number(settings.liveSettleSeconds) * 1000);
      const livePending = settings.captureLiveSessions
        ? needsDigest(listLiveSessions({ digested: state.digested }).sessions, state, {
            retryFailed: settings.autoRetryFailed,
            maxAttempts: 3,
            live: true,
            settleMs,
          })
        : [];

      if (pending.length === 0 && livePending.length === 0) return;

      const batch = pending.slice(0, settings.autoMaxPerRun);
      const liveBatch = livePending.slice(0, Math.max(1, Number(settings.liveMaxPerRun) || 2));
      const all = [...batch, ...liveBatch].map((session) => session.sessionId);
      await ops.digest({ sessionIds: all, live: true });
      // Wait for the digest to settle before touching logs: cleanup must never
      // race ahead of the memory write.
      for (let i = 0; i < 600 && ops.runs.busy(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (settings.cleanupMode !== 'off') {
        // Cleanup reads the archived inventory, so a live session can never be
        // deleted here even though it was just digested.
        const after = await readState(root);
        const fresh = listArchivedSessions({ digested: after.digested, cleaned: after.cleaned, storeRoot: root });
        const ageFloor = settings.cleanupMinAgeDays > 0 ? Date.now() - settings.cleanupMinAgeDays * 86400000 : 0;
        const cleanable = fresh.sessions.filter((session) => {
          if (!session.present || session.pinned || session.cleanedAt) return false;
          if (!after.digested[session.sessionId]) return false;
          if (ageFloor > 0 && (session.mtimeMs || 0) > ageFloor) return false;
          return true;
        });
        if (cleanable.length > 0) {
          await ops.cleanup({
            sessionIds: cleanable.map((session) => session.sessionId),
            onlyDigested: true,
            mode: settings.cleanupMode,
          });
        }
      }
    } catch (error) {
      console.warn(`[${NS}] automatic pass failed:`, error);
    } finally {
      ticking = false;
    }
  };

  // One fixed 60s heartbeat: cheap (a settings read) and immune to the interval
  // setting changing underneath it.
  const timer = setInterval(() => { void tick(); }, 60000);
  // A first pass shortly after activation, once the composition has settled.
  const first = setTimeout(() => { void tick(); }, 20000);

  ctx.effect(() => () => {
    clearInterval(timer);
    clearTimeout(first);
  }, `${NS}: auto scheduler`);
}

// ── plugin entry ────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const storeRootRef = { value: '', settings: null };

  ctx.effect(() => {
    const root = (config && typeof config.storeDir === 'string' && config.storeDir.trim() !== '')
      ? config.storeDir
      : paths('').root;
    storeRootRef.value = root;
    return () => {};
  }, `${NS}: store root`);

  // Resolve synchronously for the common path so the first tick sees a root.
  storeRootRef.value = (config && typeof config.storeDir === 'string' && config.storeDir.trim() !== '')
    ? config.storeDir
    : paths('').root;

  const ops = buildOps(ctx, storeRootRef);

  // Bootstrap persisted settings from the composition once, so `cordis.patch.yml`
  // can preconfigure the plugin without the user opening the panel. Anything the
  // panel already saved wins — re-seeding would silently undo user choices.
  if (config && typeof config === 'object') {
    const seed = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in config && typeof config[key] === typeof DEFAULT_SETTINGS[key]) seed[key] = config[key];
    }
    if (Object.keys(seed).length > 0) {
      ensureStore(storeRootRef.value)
        .then(() => settingsExist(storeRootRef.value))
        .then((exists) => (exists ? null : writeSettings(storeRootRef.value, seed)))
        .catch(() => {});
    }
  }

  registerTools(ctx, ops);
  startScheduler(ctx, ops, storeRootRef);

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE,
    handler: routeHandler(ops),
  }), `${NS}: http surface`);
}
