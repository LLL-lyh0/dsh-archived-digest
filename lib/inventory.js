/**
 * Which sessions are archived, and where their logs live.
 *
 * The archive list is not a plugin concern of its own — DSH already keeps it in
 * `<DSH_HOME>/storages/workspace.json` under `global.archivedSessionIds`. Writing
 * it ourselves would desynchronise the sidebar, so this file is read-only on that
 * store: it answers "what is archived" and "how big is it".
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDshHome } from './memory-store.js';
import { findLogFile } from './session-log.js';

export function workspaceStoreFile() {
  return join(resolveDshHome(), 'storages', 'workspace.json');
}

export function sessionsRoot() {
  return join(resolveDshHome(), 'sessions');
}

export function readWorkspaceStore() {
  const file = workspaceStoreFile();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return { ok: false, file, data: null, error: 'not an object' };
    return { ok: true, file, data: parsed, error: null };
  } catch (error) {
    return { ok: false, file, data: null, error: String(error?.message ?? error) };
  }
}

/** Archived session ids, in the order DSH stores them. */
export function archivedSessionIds() {
  const store = readWorkspaceStore();
  if (!store.ok) return [];
  const list = store.data?.global?.archivedSessionIds;
  if (!Array.isArray(list)) return [];
  return list.filter((id) => typeof id === 'string' && id.trim() !== '');
}

/** Session ids that are pinned — never touch these, even if archived. */
export function pinnedSessionIds() {
  const store = readWorkspaceStore();
  if (!store.ok) return new Set();
  const list = store.data?.global?.pinnedSessionIds;
  return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
}

/**
 * Session ids whose directory we moved into the store's trash.
 *
 * Read from disk rather than from `state.json`, because the trash directory name
 * literally carries the session id (`<session-id>-<timestamp>`) and the file is the
 * thing that proves the conversation still exists. Trusting only the state file
 * made a store with 38 correctly-trashed sessions report all 38 as *missing* —
 * indistinguishable from losing them.
 */
export function trashedSessionIds(storeRoot) {
  const trash = join(resolveDshHome(), 'archived-digest', 'trash');
  const root = storeRoot && String(storeRoot).trim() !== ''
    ? join(String(storeRoot), 'trash')
    : trash;
  const out = new Map();
  if (!existsSync(root)) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    /**
     * `<session-id>-<timestamp>`, where the id part has been through
     * `sessionSlug()`, which **strips the `session-` prefix** — so a real trash
     * directory is named `01231136-….…-1793096037689`, not `session-01231136-…`.
     * Keying on a required `session-` prefix therefore matched nothing and every
     * trashed session still counted as missing (verified: 38 cleaned, 0
     * recoverable). Both spellings are registered so the lookup works whichever
     * form the archived id uses.
     */
    const match = /^(session-)?([0-9a-fA-F-]{36})-(\d+)$/.exec(entry.name);
    if (!match) continue;
    const bare = match[2];
    const full = `session-${bare}`;
    out.set(bare, join(root, entry.name));
    out.set(full, join(root, entry.name));
  }
  return out;
}

/**
 * Locate `<sessions>/<workspace-slug>/<session-id>`, where the slug is derived
 * from the project path and therefore unknown to us. A flat directory scan is
 * cheap (16 slugs on this machine) and avoids guessing the slug algorithm, which
 * would break the moment DSH changes it.
 */
export function findSessionDir(sessionId) {
  const root = sessionsRoot();
  if (!existsSync(root)) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, sessionId);
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return { dir: candidate, workspaceSlug: entry.name };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function logStats(sessionDir) {
  const file = findLogFile(sessionDir);
  if (file === null) return { logFile: null, bytes: 0, mtimeMs: 0 };
  try {
    const stat = statSync(file);
    return { logFile: file, bytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { logFile: file, bytes: 0, mtimeMs: 0 };
  }
}

function cleanedMarker(sessionDir) {
  const marker = join(sessionDir, '.archived-digest-cleaned');
  if (!existsSync(marker)) return null;
  try {
    return readFileSync(marker, 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Enumerate archived sessions with everything the panel and the scheduler need.
 *
 * @param {{digested?: Record<string, object>, cleaned?: Record<string, object>}} [state]
 */
export function listArchivedSessions(state = {}) {
  const ids = archivedSessionIds();
  const pinned = pinnedSessionIds();
  const digested = state.digested ?? {};
  const cleaned = state.cleaned ?? {};
  const trashed = trashedSessionIds(state.storeRoot);
  const out = [];
  let missing = 0;
  let totalBytes = 0;
  for (const sessionId of ids) {
    const found = findSessionDir(sessionId);
    if (found === null) {
      /**
       * Absent from `sessions/` means one of two very different things.
       *
       * A cleaned session was moved to our `trash/` on purpose — it is gone from
       * the live tree *because we cleaned it*. Counting that as `missing` made the
       * panel report "38 missing" on a store where all 38 had memories and cleanup
       * records: indistinguishable from losing 38 conversations, which is the one
       * thing this plugin must never appear to do.
       *
       * Both the state file and the trash directory are consulted: a trashed dir
       * proves the conversation still exists (undoable), while a state record
       * covers the `logs`/`dir` modes where nothing is left on disk.
       */
      const cleanedRecord = cleaned[sessionId];
      const trashPath = trashed.get(sessionId);
      if (cleanedRecord || trashPath) {
        out.push({
          sessionId,
          workspaceSlug: null,
          dir: null,
          logFile: null,
          bytes: 0,
          mtimeMs: 0,
          pinned: pinned.has(sessionId),
          digestedAt: digested[sessionId]?.at ?? null,
          partial: digested[sessionId]?.partial === true,
          digestTitle: digested[sessionId]?.title ?? null,
          cleanedAt: cleanedRecord?.at ?? null,
          cleanedMarker: null,
          present: false,
          // Distinguishable from "the log vanished": we have a record or the
          // directory itself, and `recoverable` says the bytes still exist.
          cleaned: true,
          recoverable: trashPath !== undefined,
          trashPath: trashPath ?? null,
        });
        continue;
      }
      missing += 1;
      out.push({
        sessionId,
        workspaceSlug: null,
        dir: null,
        logFile: null,
        bytes: 0,
        mtimeMs: 0,
        pinned: pinned.has(sessionId),
        digestedAt: digested[sessionId]?.at ?? null,
        // Set by an incremental capture that stopped at a cursor: "partially
        // remembered". Such a session may not be cleaned on this basis and is
        // still eligible for the full digest that replaces the entry.
        partial: digested[sessionId]?.partial === true,
        cleanedAt: null,
        cleanedMarker: null,
        present: false,
        cleaned: false,
      });
      continue;
    }
    const stats = logStats(found.dir);
    totalBytes += stats.bytes;
    out.push({
      sessionId,
      workspaceSlug: found.workspaceSlug,
      dir: found.dir,
      logFile: stats.logFile,
      bytes: stats.bytes,
      mtimeMs: stats.mtimeMs,
      pinned: pinned.has(sessionId),
      digestedAt: digested[sessionId]?.at ?? null,
      partial: digested[sessionId]?.partial === true,
      digestTitle: digested[sessionId]?.title ?? null,
      digestError: digested[sessionId]?.error ?? null,
      cleanedAt: cleaned[sessionId]?.at ?? null,
      freedBytes: cleaned[sessionId]?.freedBytes ?? 0,
      cleanedMarker: cleanedMarker(found.dir),
      present: true,
    });
  }
  return { sessions: out, missing, totalBytes, archivedCount: ids.length };
}

/**
 * Enumerate every session on disk that is *not* archived.
 *
 * Archived sessions are the plugin's original scope, but they are the wrong
 * scope for "remember the conversation I just had": nothing is archived until
 * the user archives it, so a live session's knowledge never reaches memory.
 *
 * These are safe to digest without any session hooks because the on-disk log is
 * already complete and current — measured on the conversation that prompted this:
 * 5434 events decoded from a *running* session, including its last sentence. The
 * log is appended per flush, so waiting for it to stop changing is what makes a
 * session "finished"; nothing needs to be asked of the host.
 */
export function listLiveSessions(state = {}) {
  const archived = new Set(archivedSessionIds());
  const pinned = pinnedSessionIds();
  const digested = state.digested ?? {};
  const out = [];
  const root = sessionsRoot();
  if (!existsSync(root)) return { sessions: out, totalBytes: 0, liveCount: 0 };

  let slugs;
  try {
    slugs = readdirSync(root, { withFileTypes: true });
  } catch {
    return { sessions: out, totalBytes: 0, liveCount: 0 };
  }

  let totalBytes = 0;
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    let dirs;
    try {
      dirs = readdirSync(join(root, slug.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const sessionId = dir.name;
      if (archived.has(sessionId)) continue;
      const full = join(root, slug.name, sessionId);
      const stats = logStats(full);
      if (stats.bytes === 0) continue;
      totalBytes += stats.bytes;
      out.push({
        sessionId,
        workspaceSlug: slug.name,
        dir: full,
        logFile: stats.logFile,
        bytes: stats.bytes,
        mtimeMs: stats.mtimeMs,
        pinned: pinned.has(sessionId),
        digestedAt: digested[sessionId]?.at ?? null,
        partial: digested[sessionId]?.partial === true,
        digestTitle: digested[sessionId]?.title ?? null,
        digestError: digested[sessionId]?.error ?? null,
        cleanedAt: null,
        cleanedMarker: cleanedMarker(full),
        present: true,
        live: true,
      });
    }
  }
  out.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return { sessions: out, totalBytes, liveCount: out.length };
}

/** Total bytes of every session log on disk, archived or not (for the headline). */
export function totalLogBytes() {
  const root = sessionsRoot();
  if (!existsSync(root)) return { bytes: 0, sessions: 0, workspaces: 0 };
  let bytes = 0;
  let sessions = 0;
  let workspaces = 0;
  let slugs;
  try {
    slugs = readdirSync(root, { withFileTypes: true });
  } catch {
    return { bytes: 0, sessions: 0, workspaces: 0 };
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    workspaces += 1;
    let dirs;
    try {
      dirs = readdirSync(join(root, slug.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      sessions += 1;
      bytes += logStats(join(root, slug.name, dir.name)).bytes;
    }
  }
  return { bytes, sessions, workspaces };
}
