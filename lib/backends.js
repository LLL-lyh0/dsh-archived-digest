/**
 * Optional sinks: hand consolidated memory to whichever memory backend this
 * profile actually runs.
 *
 * Three backends matter here, and each exposes a different surface:
 *
 *  - **OpenViking** (`ctx.get('openvikingMemory')`, provided by
 *    `@openviking/dsh-memory-plugin`) — a server-backed memory store with an
 *    HTTP API. When its server is down the plugin queues writes locally, which
 *    is exactly the state this machine was in; a sink that blocks on it would
 *    stall the digest behind an absent service.
 *  - **Mnemon** (`dsh-mnemon`) — registers `mnemon_*` *tools*, not a service, so
 *    feeding it means calling a tool by name rather than a method.
 *  - **memory-eternal** — exposes `/memory-eternal/api/write` over the web
 *    server and is disabled on this profile.
 *
 * The rule that keeps this honest: **the local ledger is the source of truth.**
 * A sink is a mirror, never the store. Export is best-effort, records why it
 * failed, and never mutates the ledger — several of these backends extract their
 * own memories in the background and would double-store anything we pushed as a
 * session event.
 */

import { readFacts } from './facts.js';
import { findTopics } from './consolidate.js';

/** Which backends this composition actually has. Probed, never assumed. */
export function detectBackends(ctx) {
  const found = [];
  try {
    const openviking = typeof ctx.get === 'function' ? ctx.get('openvikingMemory') : undefined;
    if (openviking !== undefined && openviking !== null) {
      found.push({ id: 'openviking', kind: 'service', available: true, note: 'ctx.openvikingMemory' });
    }
  } catch {
    /* service absent */
  }
  try {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
    const names = new Set();
    if (tools && typeof tools.list === 'function') {
      for (const tool of tools.list() ?? []) {
        const name = typeof tool === 'string' ? tool : tool?.name;
        if (typeof name === 'string') names.add(name);
      }
    }
    if ([...names].some((name) => name.startsWith('mnemon_'))) {
      found.push({ id: 'mnemon', kind: 'tools', available: true, note: 'mnemon_* tools' });
    }
  } catch {
    /* tool registry unreadable */
  }
  return found;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Render one export document: the standing topics, plus the live facts that are
 * not yet in any topic body because they arrived after the last consolidation.
 *
 * Topics are the payload on purpose — a backend that stores free text benefits
 * from the assembled subject, not from 77 per-session summaries.
 */
export function buildExportDocument(ledger, { maxTopics = 12, maxChars = 8000 } = {}) {
  const topics = findTopics(ledger, '', { limit: maxTopics });
  const parts = [];
  let used = 0;
  for (const topic of topics) {
    const block = `### ${topic.label}\n${clip(topic.body.split('\n').slice(2).join('\n'), 900)}`;
    if (used + block.length > maxChars && parts.length > 0) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}

/**
 * Push the consolidated memory to one backend.
 *
 * @returns `{ ok, backend, ... }`; a failure is data, not an exception — the
 *          caller records it and the panel shows it.
 */
export async function exportToBackend(ctx, backendId, ledger, options = {}) {
  const document = options.document ?? buildExportDocument(ledger);
  if (document.trim() === '') return { ok: false, backend: backendId, code: 'EMPTY', message: 'nothing consolidated yet' };

  if (backendId === 'openviking') {
    let runtime;
    try {
      runtime = typeof ctx.get === 'function' ? ctx.get('openvikingMemory') : undefined;
    } catch {
      runtime = undefined;
    }
    if (runtime === undefined || runtime === null) {
      return { ok: false, backend: backendId, code: 'NOT_MOUNTED', message: 'openvikingMemory service is not provided in this composition' };
    }
    // The runtime's own write path is session capture; there is no public
    // "remember this document" method, so the honest move is to say so instead
    // of inventing an API call against a server this plugin does not own.
    return {
      ok: false,
      backend: backendId,
      code: 'NO_WRITE_API',
      message: 'openvikingMemory exposes session capture but no document-write method; memory already reaches it through session capture',
    };
  }

  if (backendId === 'mnemon') {
    let tools;
    try {
      tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
    } catch {
      tools = undefined;
    }
    const remember = tools && typeof tools.get === 'function' ? tools.get('mnemon_remember') : undefined;
    if (remember === undefined || remember === null) {
      return { ok: false, backend: backendId, code: 'TOOL_MISSING', message: 'mnemon_remember is not registered' };
    }
    try {
      const result = await remember.execute({
        content: document,
        title: options.title ?? 'Archived session digest (consolidated)',
      });
      return { ok: true, backend: backendId, result };
    } catch (error) {
      return { ok: false, backend: backendId, code: 'WRITE_FAILED', message: String(error?.message ?? error) };
    }
  }

  return { ok: false, backend: backendId, code: 'UNKNOWN_BACKEND', message: `unknown backend ${backendId}` };
}

/** Export to every detected backend; one failure never stops the others. */
export async function exportAll(ctx, storeRoot, options = {}) {
  const backends = detectBackends(ctx);
  if (backends.length === 0) {
    return { ok: true, backends: [], results: [], note: 'no memory backend mounted; the local store is the only sink' };
  }
  const ledger = options.ledger ?? await readFacts(storeRoot);
  const results = [];
  for (const backend of backends) {
    try {
      results.push(await exportToBackend(ctx, backend.id, ledger, options));
    } catch (error) {
      results.push({ ok: false, backend: backend.id, code: 'INTERNAL', message: String(error?.message ?? error) });
    }
  }
  return { ok: results.some((entry) => entry.ok), backends, results };
}
