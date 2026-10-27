/**
 * Host smoke test: mount index.js against a fake Cordis context, then drive the
 * HTTP handler the way the panel does.
 *
 * The panel can only be exercised in the running GUI, but everything the panel
 * calls goes through this one handler — so hitting it here proves the wiring
 * (route dispatch, origin fence, settings round-trip, run registry) without a
 * restart.
 */
import { apply } from '../index.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── fake host ──────────────────────────────────────────────────────────────
const registered = { routes: [], tools: [], effects: [] };
/** Every dispose returned by ctx.effect — run in the finally block. */
const disposers = [];
const fakeCtx = {
  effect(fn, label) {
    registered.effects.push(label);
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose ?? (() => {});
  },
  get() { return undefined; },
  async get() { return undefined; },
  inject(names, fn) { fn(fakeCtx); return () => {}; },
  webServer: {
    register(surface) { registered.routes.push(surface); return () => {}; },
  },
  tools: {
    register(tool) { registered.tools.push(tool); return () => {}; },
  },
};

// The store must be redirected: without storeDir the plugin writes into the
// user's real $DSH_HOME. The session logs themselves are read from the real
// home, which is the point — this test decodes a genuinely archived session.
const storeRoot = await mkdtemp(join(tmpdir(), 'archived-digest-host-'));
// Skills publish into `$DSH_HOME/skills`; keep that out of the real catalog too.
// (`skillMirrorRoot()` reads this at call time, so setting it here is in time.)
process.env.DSH_ARCHIVED_DIGEST_SKILLS = await mkdtemp(join(tmpdir(), 'archived-digest-host-skills-'));
try {
  const config = { storeDir: storeRoot };
  apply(fakeCtx, config);

  check('apply() registered the HTTP surface', registered.routes.length === 1, registered.routes[0]?.path);
  check('apply() registered the agent tool', registered.tools.some((tool) => tool.name === 'archived_digest'),
    registered.tools.map((tool) => tool.name).join(','));
  check('every registration is wrapped in ctx.effect()', registered.effects.length >= 2, registered.effects.join(' | '));

  const surface = registered.routes[0];
  check('surface is a prefix route', surface?.kind === 'prefix', surface?.kind);

  // ── drive the handler ────────────────────────────────────────────────────
  function makeReq(method, url, body, headers = {}) {
    const chunks = [];
    if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body), 'utf8'));
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:58902', 'sec-fetch-site': 'same-origin', ...headers },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
    };
    return req;
  }

  function makeRes() {
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writableEnded: false,
      destroyed: false,
      writeHead(code, headers) { res.statusCode = code; res.headers = headers; },
      end(text) { res.body = text; res.writableEnded = true; },
    };
    return res;
  }

  async function call(method, path, body, headers) {
    const res = makeRes();
    await surface.handler(makeReq(method, path, body, headers), res);
    let json;
    try { json = JSON.parse(res.body); } catch { json = undefined; }
    return { status: res.statusCode, json };
  }

  // Origin fence: a non-loopback Host must be refused.
  const bad = await call('GET', '/api/dsh-archived-digest/status', undefined, { host: 'evil.example.com' });
  check('non-loopback Host is refused', bad.status === 403, `status ${bad.status}`);

  const crossSite = await call('GET', '/api/dsh-archived-digest/status', undefined, { 'sec-fetch-site': 'cross-site' });
  check('cross-site request is refused', crossSite.status === 403, `status ${crossSite.status}`);

  // A mutation without the client marker must be refused.
  const noMarker = await call('POST', '/api/dsh-archived-digest/settings', { autoIntervalMinutes: 45 });
  check('mutation without the client marker is refused', noMarker.status === 403, `status ${noMarker.status}`);

  // ── /status ──────────────────────────────────────────────────────────────
  const status = await call('GET', '/api/dsh-archived-digest/status');
  check('/status responds 200', status.status === 200, `status ${status.status}`);
  check('/status reports the archive inventory', typeof status.json?.counts?.archived === 'number' && status.json.counts.archived > 0,
    `archived=${status.json?.counts?.archived}`);
  check('/status reports log bytes', typeof status.json?.bytes?.archivedLogs === 'number' && status.json.bytes.archivedLogs > 0,
    `${status.json?.bytes?.archivedLogs} bytes`);
  check('/status exposes settings', status.json?.settings?.autoEnabled === false, 'autoEnabled defaults to false');
  check('/status reports llm readiness as a boolean', typeof status.json?.llm?.ready === 'boolean', `ready=${status.json?.llm?.ready}`);

  // ── /sessions ────────────────────────────────────────────────────────────
  const sessions = await call('GET', '/api/dsh-archived-digest/sessions');
  check('/sessions lists archived sessions', Array.isArray(sessions.json?.sessions) && sessions.json.sessions.length > 0,
    `${sessions.json?.sessions?.length} rows`);
  const first = sessions.json?.sessions?.[0];
  check('/sessions rows carry what the panel renders',
    first !== undefined && 'sessionId' in first && 'bytes' in first && 'present' in first && 'blocked' in first,
    Object.keys(first ?? {}).join(','));
  // Cleaned sessions are listed but have no directory any more, so "inspect the
  // first row" would test MISSING_DIR instead of the decode path. And a *present*
  // row is not enough either: the shortest archived logs decode to a couple of
  // dozen events and yield EMPTY_SOURCE. Pick a session that is both on disk and
  // substantive, which is what /inspect is meant to preview.
  const presentRows = sessions.json?.sessions?.filter((row) => row.present === true) ?? [];
  check('/sessions exposes sessions still on disk', presentRows.length > 0, `${presentRows.length} present`);
  const presentRow = presentRows.find((row) => Number(row.bytes) > 100000) ?? presentRows[0];
  const cleanedRows = sessions.json?.sessions?.filter((row) => row.cleaned === true) ?? [];
  check('cleaned sessions are reported as cleaned, not missing',
    cleanedRows.length === 0 || cleanedRows.every((row) => row.present === false),
    `${cleanedRows.length} cleaned, ${sessions.json?.counts?.missing ?? '?'} missing`);

  // ── /settings round-trip ─────────────────────────────────────────────────
  const patched = await call('POST', '/api/dsh-archived-digest/settings',
    { autoEnabled: true, autoIntervalMinutes: 45, cleanupMode: 'logs' },
    { 'x-dsh-archived-digest': '1' });
  check('/settings accepts a marked mutation', patched.status === 200 && patched.json?.settings?.autoEnabled === true,
    `autoEnabled=${patched.json?.settings?.autoEnabled}`);
  check('/settings clamps and keeps unrelated keys',
    patched.json?.settings?.autoIntervalMinutes === 45 && patched.json?.settings?.maxSourceChars === 14000,
    `interval=${patched.json?.settings?.autoIntervalMinutes}`);
  const clamped = await call('POST', '/api/dsh-archived-digest/settings', { autoIntervalMinutes: 1 }, { 'x-dsh-archived-digest': '1' });
  check('/settings clamps out-of-range values', clamped.json?.settings?.autoIntervalMinutes === 5,
    `interval=${clamped.json?.settings?.autoIntervalMinutes}`);
  const bogus = await call('POST', '/api/dsh-archived-digest/settings', { autoEnabled: 'yes', notASetting: 1 },
    { 'x-dsh-archived-digest': '1' });
  check('/settings ignores wrong types and unknown keys',
    bogus.json?.settings?.autoEnabled === true && !('notASetting' in (bogus.json?.settings ?? {})), 'guarded');

  // Settings must survive as a file — that is what makes the switch stick.
  const onDisk = JSON.parse(await readFile(join(status.json.store.root, 'settings.json'), 'utf8'));
  check('settings are persisted to disk', onDisk.autoIntervalMinutes === 5 && onDisk.cleanupMode === 'logs',
    `autoIntervalMinutes=${onDisk.autoIntervalMinutes} cleanupMode=${onDisk.cleanupMode}`);

  // Turning it back off must be possible — the user's requirement.
  const off = await call('POST', '/api/dsh-archived-digest/settings', { autoEnabled: false }, { 'x-dsh-archived-digest': '1' });
  check('auto digest can be switched off', off.json?.settings?.autoEnabled === false, 'autoEnabled=false');

  // ── read-only endpoints ──────────────────────────────────────────────────
  const memories = await call('GET', '/api/dsh-archived-digest/memories');
  check('/memories responds', memories.status === 200 && Array.isArray(memories.json?.memories), `${memories.json?.memories?.length} entries`);
  const skills = await call('GET', '/api/dsh-archived-digest/skills');
  check('/skills responds', skills.status === 200 && Array.isArray(skills.json?.skills), `${skills.json?.skills?.length} entries`);

  const target = presentRow?.sessionId;
  const inspected = await call('GET', `/api/dsh-archived-digest/inspect?sessionId=${encodeURIComponent(target)}`);
  check('/inspect decodes a real session without spending tokens',
    inspected.json?.ok === true && inspected.json?.chars > 0 && inspected.json?.events > 0,
    `${inspected.json?.events} events → ${inspected.json?.chars} chars`);
  check('/inspect preview is non-empty text', typeof inspected.json?.preview === 'string' && inspected.json.preview.length > 0,
    `${inspected.json?.preview?.length} chars`);

  const missing = await call('GET', '/api/dsh-archived-digest/inspect?sessionId=session-nope');
  check('/inspect rejects an unknown session', missing.json?.ok === false, missing.json?.code);

  const unknown = await call('GET', '/api/dsh-archived-digest/nope');
  check('unknown routes 404', unknown.status === 404, `status ${unknown.status}`);

  // A run must be refusable when the model is unavailable, and must never take
  // the process down.
  const digest = await call('POST', '/api/dsh-archived-digest/digest', { sessionIds: [target] }, { 'x-dsh-archived-digest': '1' });
  check('/digest answers without throwing', typeof digest.json?.ok === 'boolean', JSON.stringify(digest.json).slice(0, 120));

  // The digest above starts a background batch. Let it settle so the run
  // registry is not left mid-flight, and so the NO_LLM path is exercised.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const afterRun = await call('GET', '/api/dsh-archived-digest/run');
  check('/run reports a settled batch', afterRun.json?.run === null || afterRun.json.run.phase !== 'running',
    afterRun.json?.run?.phase ?? 'no run');
  const afterStatus = await call('GET', '/api/dsh-archived-digest/status');
  check('a digest with no llm fails cleanly instead of writing a memory',
    afterStatus.json?.counts?.memories === 0, `memories=${afterStatus.json?.counts?.memories}`);
  check('the failure is recorded for the panel to show',
    (afterStatus.json?.failures ?? []).some((entry) => entry.code === 'NO_LLM'),
    (afterStatus.json?.failures ?? []).map((entry) => entry.code).join(','));

  // ── the agent tool ───────────────────────────────────────────────────────
  const tool = registered.tools.find((entry) => entry.name === 'archived_digest');
  const toolStatus = await tool.execute({ action: 'status' });
  check('tool status works', toolStatus?.ok === true && toolStatus.counts.archived > 0, `archived=${toolStatus?.counts?.archived}`);
  const toolSessions = await tool.execute({ action: 'sessions' });
  check('tool sessions works', toolSessions?.ok === true && toolSessions.sessions.length > 0, `${toolSessions?.sessions?.length} rows`);
  const toolBad = await tool.execute({ action: 'nope' });
  check('tool rejects an unknown action', toolBad?.ok === false, toolBad?.code);
  const toolInspect = await tool.execute({ action: 'inspect', sessionIds: [target] });
  check('tool inspect works', toolInspect?.ok === true, `${toolInspect?.chars} chars`);
  const rendered = tool.output.render(toolBad);
  check('tool render handles failures', Array.isArray(rendered) && rendered[0]?.text?.includes('失败'), rendered[0]?.text?.slice(0, 60));

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${failed.length === 0 ? 'all' : failed.length + ' of'} ${results.length} checks passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  // Release every effect first: the scheduler holds a live interval, so without
  // this the process would never exit.
  for (const dispose of disposers.splice(0)) {
    try { dispose(); } catch { /* already released */ }
  }
  await rm(storeRoot, { recursive: true, force: true });
  await rm(process.env.DSH_ARCHIVED_DIGEST_SKILLS, { recursive: true, force: true });
}
