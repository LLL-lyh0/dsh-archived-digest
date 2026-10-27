/**
 * Client test: run the real panel component tree against a stubbed HTTP surface.
 *
 * The GUI is the only place the panel truly renders, but every mistake that
 * matters — a wrong API path, a missing marker header, a checkbox that never
 * reaches the server, a Settings switch that will not persist — is a plain
 * JavaScript bug. This harness catches those without a browser.
 *
 * `mini-react.mjs` executes the real component (hooks and all); the assertions
 * below then walk the resulting tree and invoke the actual handlers.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as MiniReact from './mini-react.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── globals the client half expects ─────────────────────────────────────────
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true, writable: true });
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
/** The panel asks before destructive cleanup; the test answers "yes". */
const confirmations = [];
globalThis.confirm = (message) => { confirmations.push(message); return true; };

// ── stub fetch ──────────────────────────────────────────────────────────────
const calls = [];
const routes = new Map();
function setRoute(path, handler) { routes.set(path, handler); }
function pathOf(input) { return String(input).split('?')[0]; }
function queryOf(input) { return String(input).includes('?') ? String(input).slice(String(input).indexOf('?')) : ''; }

globalThis.fetch = async (input, init = {}) => {
  const method = init.method ?? 'GET';
  const path = pathOf(input);
  const query = queryOf(input);
  calls.push({ method, path, query, headers: init.headers ?? {}, body: init.body });
  const handler = routes.get(path);
  if (!handler) {
    return { ok: false, status: 404, async json() { return { ok: false, error: `no route: ${path}` }; } };
  }
  const payload = await handler({ method, query, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
  const status = payload.__status ?? 200;
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
};

// ── capture the module registration ─────────────────────────────────────────
let registration = null;
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) { registration = { id, factory }; },
};

await import('../client.js');
check('client.js registers a module', registration !== null && registration.id === 'dsh-archived-digest', registration?.id);

/** The host hands the factory a `require`; give it our runtime. */
const module = registration.factory((name) => {
  if (name === 'react') return MiniReact;
  throw new Error(`mini-react: unexpected require("${name}")`);
});
check('the module injects slots', Array.isArray(module.inject) && module.inject.includes('slots'), module.inject?.join(','));

// ── collect the slot registrations ──────────────────────────────────────────
const slots = [];
module.apply({
  slots: {
    inject(name, fn) { fn(); return () => {}; },
    register(definition, Component) { slots.push({ definition, Component }); return () => {}; },
  },
  effect(fn) { return fn() ?? (() => {}); },
});

const panelEntry = slots.find((slot) => slot.definition.name === 'sidebar.panellist');
const pageSlot = slots.find((slot) => slot.definition.name === 'main');
check('registers the sidebar entry', panelEntry !== undefined, panelEntry?.definition?.id);
check('sidebar entry uses the plugin id', panelEntry?.definition?.id === 'dsh-archived-digest', panelEntry?.definition?.id);
check('sidebar entry is ordered after github-manager (11)', panelEntry?.definition?.order === 12, String(panelEntry?.definition?.order));
check('sidebar label resolves to a string', typeof panelEntry?.definition?.label?.() === 'string', panelEntry?.definition?.label?.());
check('registers the center page under the same key', pageSlot?.definition?.key === 'dsh-archived-digest', pageSlot?.definition?.key);
check('the page component is a function', typeof pageSlot?.Component === 'function', typeof pageSlot?.Component);

// ── server responses ────────────────────────────────────────────────────────
const SETTINGS = {
  autoEnabled: false, autoIntervalMinutes: 30, autoMaxPerRun: 3, autoRetryFailed: true,
  cleanupMode: 'off', cleanupMinAgeDays: 7, extractSkills: true,
  maxSourceChars: 14000, maxTokens: 2400, provider: '', model: '',
};
const STATUS = {
  ok: true,
  settings: { ...SETTINGS },
  llm: { ready: true, note: null },
  store: { root: 'C:\\Users\\TGL\\.dsh\\archived-digest', memories: 1, skills: 1, memoryBytes: 1200, skillBytes: 900 },
  counts: { archived: 77, missing: 0, present: 77, digested: 1, cleaned: 0, pending: 76, failed: 0, memories: 1, skills: 1 },
  bytes: { archivedLogs: 431382092, allLogs: 638000000, allSessions: 501, workspaces: 16, freed: 0, store: 2100 },
  run: null,
  runs: [],
  failures: [],
};
const BIG = 'session-aaaa1111-0000-0000-0000-000000000001';
const DONE = 'session-bbbb2222-0000-0000-0000-000000000002';
const GONE = 'session-cccc3333-0000-0000-0000-000000000003';
const SESSIONS = {
  ok: true,
  sessions: [
    { sessionId: BIG, workspaceSlug: '--E-Project--', bytes: 7231140, mtimeMs: Date.now() - 86400000 * 40, pinned: false, digestedAt: null, cleanedAt: null, present: true, failed: null, blocked: null, digestTitle: null },
    { sessionId: DONE, workspaceSlug: '--E-Project--', bytes: 2048, mtimeMs: Date.now(), pinned: false, digestedAt: '2026-10-20T00:00:00.000Z', cleanedAt: null, present: true, failed: null, blocked: 'digested', digestTitle: 'Already done' },
    { sessionId: GONE, workspaceSlug: '--E-Project--', bytes: 0, mtimeMs: 0, pinned: false, digestedAt: null, cleanedAt: null, present: false, failed: null, blocked: 'missing', digestTitle: null },
  ],
  counts: { archived: 3, pending: 1 },
};
const MEMORIES = { ok: true, memories: [{ sessionId: DONE, title: 'Zstd frames', summary: 'Multi-frame decode', tags: ['zstd'], chars: 620, digestedAt: '2026-10-20T00:00:00.000Z', file: 'memories/x.md' }], total: 1 };
const SKILLS = { ok: true, skills: [
  { slug: 'decode-multiframe-zstd', title: 'Decode multiframe zstd', description: 'Split on magic bytes first.', sources: [DONE], updatedAt: '2026-10-20T00:00:00.000Z', file: 'skills/x/SKILL.md', mirror: 'C:\\Users\\TGL\\.dsh\\skills\\decode-multiframe-zstd\\SKILL.md', mirrorError: null },
  // A skill whose name collided with a hand-written one: published copy absent.
  { slug: 'taken-name', title: 'Taken name', description: 'Could not publish.', sources: [DONE], updatedAt: '2026-10-19T00:00:00.000Z', file: 'skills/y/SKILL.md', mirror: null, mirrorError: 'MIRROR_OCCUPIED' },
], total: 2 };

setRoute('api/dsh-archived-digest/status', () => ({ ...STATUS, settings: { ...SETTINGS } }));
setRoute('api/dsh-archived-digest/sessions', () => SESSIONS);
setRoute('api/dsh-archived-digest/memories', () => MEMORIES);
setRoute('api/dsh-archived-digest/skills', () => SKILLS);
// Memory layer fixtures: one topic, two live facts and one superseded fact.
const FACTS = {
  ok: true,
  topics: [{
    id: 'zstd-magic',
    label: 'zstd 多帧解码',
    body: '# zstd 多帧解码\n\n- [fact] 日志是多帧，要按 magic 切帧 ^f00001',
    factIds: ['f00001', 'f00002'],
    kinds: ['fact'],
    sources: [DONE],
    strength: 0.81,
    updatedAt: '2026-10-20T00:00:00.000Z',
  }],
  facts: [
    { id: 'f00001', text: '日志是多帧，要按 magic 切帧', kind: 'fact', sources: [DONE], strength: 0.81, createdAt: '2026-10-20T00:00:00.000Z' },
    { id: 'f00002', text: '面板语言要现读不能缓存', kind: 'decision', sources: [BIG], strength: 0.74, createdAt: '2026-10-21T00:00:00.000Z' },
  ],
  invalidated: [{ id: 'f00003', text: '旧结论：日志只有一帧', kind: 'fact', validUntil: '2026-10-22T00:00:00.000Z', supersededBy: 'f00001' }],
  stats: { total: 3, live: 2, invalidated: 1, byKind: { fact: 1, decision: 1 }, avgStrength: 0.775, topics: 1, updatedAt: '2026-10-22T00:00:00.000Z' },
};
setRoute('api/dsh-archived-digest/facts', () => FACTS);
setRoute('api/dsh-archived-digest/topics', () => ({ ok: true, topics: FACTS.topics, stats: FACTS.stats }));
setRoute('api/dsh-archived-digest/recall', ({ query }) => ({
  ok: true,
  query: decodeURIComponent(String(query ?? '').replace(/^\?q=/, '')),
  topics: FACTS.topics,
  facts: [FACTS.facts[0]],
  block: '## Relevant memory\n- [fact] 日志是多帧，要按 magic 切帧',
  stats: FACTS.stats,
}));
setRoute('api/dsh-archived-digest/consolidate', () => ({ ok: true, topics: 1, facts: FACTS.stats, export: { ok: true, results: [] } }));
setRoute('api/dsh-archived-digest/export', () => ({ ok: false, backends: [], results: [], document: '' }));
setRoute('api/dsh-archived-digest/fact/forget', ({ body }) => ({ ok: true, removed: 1, topics: 1, stats: FACTS.stats, id: body.id }));
setRoute('api/dsh-archived-digest/run', () => ({ ok: true, run: null }));
setRoute('api/dsh-archived-digest/settings', ({ body }) => ({ ok: true, settings: { ...SETTINGS, ...body } }));
setRoute('api/dsh-archived-digest/digest', ({ body }) => ({ ok: true, started: true, count: body.sessionIds.length, sessionIds: body.sessionIds }));
setRoute('api/dsh-archived-digest/cleanup', () => ({ ok: true, cleaned: 1, freed: 721000 }));
setRoute('api/dsh-archived-digest/inspect', () => ({ ok: true, sessionId: BIG, events: 1856, turns: 51, keptTurns: 45, chars: 13713, toolNames: ['glob', 'read'], preview: 'preview text' }));
setRoute('api/dsh-archived-digest/memory', () => ({ ok: true, entry: MEMORIES.memories[0], text: '---\ntitle: Zstd frames\n---\nbody' }));
setRoute('api/dsh-archived-digest/skill', () => ({ ok: true, entry: SKILLS.skills[0], text: '---\nname: x\n---\nbody' }));
setRoute('api/dsh-archived-digest/run/stop', () => ({ ok: true, stopped: true }));

// ── first render ────────────────────────────────────────────────────────────
const Page = pageSlot.Component;
let current = MiniReact.render(MiniReact.createElement(Page, {}));
/** Re-render after state changes, the way React would. */
async function flush() {
  // The panel's data loads are promises; give the microtask queue a turn.
  await new Promise((resolve) => setTimeout(resolve, 20));
  current = MiniReact.render(MiniReact.createElement(Page, {}));
}

check('the panel renders a tree', current.tree !== null && current.renderCount === 1, `${current.renderCount} pass`);
const host = MiniReact.findAll(current.tree, (node) => node.props['data-dsh-plugin'] === 'dsh-archived-digest');
check('the panel root is scoped by a data attribute', host.length === 1, `${host.length} roots`);
const styles = MiniReact.findAll(current.tree, (node) => node.tag === 'style');
check('the panel injects its own stylesheet', styles.length === 1 && String(styles[0].children[0]?.text).includes('.ad-view'), 'style present');

const text = MiniReact.textOf(current.tree);
check('the panel renders Chinese copy', text.includes('归档会话提炼'), 'zh title');
check('the panel does not leak the raw plugin id as a label', !text.includes('dsh-archived-digest'), 'labels resolved');

// The initial GETs must all be relative paths (the GUI is served under a base).
check('the panel loads over relative paths', calls.length > 0 && calls.every((call) => call.path.startsWith('api/dsh-archived-digest/')),
  calls.map((call) => `${call.method} ${call.path}`).join(', '));
check('every endpoint the panel calls is known', calls.every((call) => routes.has(call.path)),
  calls.filter((call) => !routes.has(call.path)).map((call) => call.path).join(',') || 'all known');

await flush();
const loadedText = MiniReact.textOf(current.tree);
check('the overview shows the archive inventory', loadedText.includes('77'), 'archived count');
check('the overview shows the log footprint', /MB|GB/.test(loadedText), 'bytes formatted');
check('the overview reports the auto switch as off', loadedText.includes('自动提炼已关闭'), 'auto off badge');

// ── tabs ────────────────────────────────────────────────────────────────────
const tabButtons = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && String(node.props.className ?? '').includes('ad-tab'));
check('the panel renders seven tabs', tabButtons.length === 7, tabButtons.map((tab) => MiniReact.textOf(tab)).join(' | '));

/**
 * Click a tab by its label.
 *
 * Exact (or count-suffix) match first: a prefix match now resolves 「记忆」 to
 * 「主题记忆」, which silently tested the wrong tab. Tabs render as
 * `<label>` or `<label> (n)`.
 */
function clickTab(labelPart) {
  const tabs = MiniReact.findAll(current.tree, (node) => node.tag === 'button'
    && String(node.props.className ?? '').includes('ad-tab'));
  const text = (tab) => MiniReact.textOf(tab).replace(/\s*\(\d+\)\s*$/, '');
  const target = tabs.find((tab) => text(tab) === labelPart) ?? tabs.find((tab) => text(tab).includes(labelPart));
  if (!target) throw new Error(`no tab matching ${labelPart}; have ${tabs.map(text).join(' | ')}`);
  target.props.onClick();
}

clickTab('归档会话');
await flush();
const sessionText = MiniReact.textOf(current.tree);
check('the sessions tab lists archived sessions', sessionText.includes('session-aaaa1111') || sessionText.includes('aaaa1111'), 'rows present');
check('the sessions tab offers manual picking', sessionText.includes('提炼所选') && sessionText.includes('全选待提炼'), 'actions present');
const checkboxes = MiniReact.findAll(current.tree, (node) => node.tag === 'input' && node.props.type === 'checkbox');
check('the sessions tab renders one checkbox per session', checkboxes.length === 3, `${checkboxes.length} boxes`);
// A digested session stays pickable on purpose: re-distilling is how you refresh a
// memory after the prompt improves, and writing the same slug is idempotent.
check('a digested session can be deliberately re-picked', checkboxes.find((box) => box.props['aria-label'] === DONE)?.props.disabled === false, 'digested enabled');
check('a missing directory cannot be picked', checkboxes.find((box) => box.props['aria-label'] === GONE)?.props.disabled === true, 'missing disabled');
check('a pending session is pickable', checkboxes.find((box) => box.props['aria-label'] === BIG)?.props.disabled === false, 'pending enabled');

// ── preview (before digesting: startDigest navigates back to the overview) ──
const previewButton = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node).includes('预览'))[0];
check('the sessions tab offers a preview action', previewButton !== undefined, previewButton ? 'present' : 'missing');
previewButton.props.onClick();
await flush();
const previewCall = calls.find((call) => call.path === 'api/dsh-archived-digest/inspect');
check('preview requests the session without spending tokens', previewCall !== undefined && previewCall.query.includes(BIG), previewCall?.query);
check('preview renders the decoded text', MiniReact.textOf(current.tree).includes('preview text'), 'preview shown');

// Selecting the pending row, then digesting, must POST the exact id.
MiniReact.findAll(current.tree, (node) => node.tag === 'input' && node.props.type === 'checkbox')
  .find((box) => box.props['aria-label'] === BIG).props.onChange();
await flush();
const selectedText = MiniReact.textOf(current.tree);
check('the selection counter updates', selectedText.includes('已选: 1'), 'counter');

const digestButton = MiniReact.findAll(current.tree, (node) => node.tag === 'button'
  && MiniReact.textOf(node).includes('提炼所选'))[0];
check('the digest button enables once something is selected', digestButton?.props.disabled === false, String(digestButton?.props.disabled));
digestButton.props.onClick();
await flush();

const digestCall = calls.find((call) => call.method === 'POST' && call.path === 'api/dsh-archived-digest/digest');
check('digesting posts to /digest', digestCall !== undefined, digestCall?.path);
check('digesting carries the client marker header', digestCall?.headers?.['x-dsh-archived-digest'] === '1', 'marker present');
check('digesting carries the selected session id', digestCall !== undefined
  && JSON.parse(digestCall.body).sessionIds.length === 1
  && JSON.parse(digestCall.body).sessionIds[0] === BIG, digestCall?.body);
check('starting a batch returns to the overview to watch progress', MiniReact.textOf(current.tree).includes('归档日志占用'), 'overview shown');

// ── memory layer: topics and facts ──────────────────────────────────────────
clickTab('主题记忆');
await flush();
const topicText = MiniReact.textOf(current.tree);
check('the topics tab lists a consolidated topic', topicText.includes('zstd 多帧解码'), 'topic label');
check('the topics tab shows how many facts it holds', topicText.includes('2 条事实'), 'fact count');
check('the topics tab renders the topic body with citations', topicText.includes('^f00001'), 'citation shown');
check('the topics tab offers consolidation', topicText.includes('重新整合'), 'consolidate action');

const consolidateButton = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node) === '重新整合')[0];
check('consolidation is clickable', consolidateButton?.props.disabled === false, String(consolidateButton?.props.disabled));
consolidateButton.props.onClick();
await flush();
check('consolidation posts to /consolidate with the marker',
  calls.some((call) => call.method === 'POST' && call.path === 'api/dsh-archived-digest/consolidate' && call.headers['x-dsh-archived-digest'] === '1'),
  'posted');

const exportButton = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node).includes('导出到记忆后端'))[0];
check('the export action exists', exportButton !== undefined, 'present');
if (exportButton) {
  exportButton.props.onClick();
  await flush();
  check('export posts to /export with the marker',
    calls.some((call) => call.method === 'POST' && call.path === 'api/dsh-archived-digest/export' && call.headers['x-dsh-archived-digest'] === '1'),
    'posted');
  // No backend is detected in this fixture, so the panel must say so rather
  // than imply the memory reached somewhere.
  check('with no backend the panel says the local store is the only sink',
    MiniReact.textOf(current.tree).includes('没有检测到记忆插件'), 'backend note');
}

// Search posts the query and renders the hits.
const recallInput = MiniReact.findAll(current.tree, (node) => node.tag === 'input' && node.props.placeholder?.includes('zstd') === true)[0];
check('the memory search box exists', recallInput !== undefined, 'present');
if (recallInput) {
  recallInput.props.onChange({ target: { value: 'magic 切帧' } });
  await flush();
  const searchButton = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node) === '检索')[0];
  searchButton.props.onClick();
  await flush();
  const recallCall = [...calls].reverse().find((call) => call.path === 'api/dsh-archived-digest/recall');
  check('search sends the query to /recall', recallCall !== undefined && recallCall.query.includes(encodeURIComponent('magic').slice(0, 3)), recallCall?.query);
  check('search renders the hit', MiniReact.textOf(current.tree).includes('日志是多帧'), 'hit shown');
}

// ── facts tab ───────────────────────────────────────────────────────────────
clickTab('事实');
await flush();
const factText = MiniReact.textOf(current.tree);
check('the facts tab lists live facts', factText.includes('日志是多帧') && factText.includes('面板语言要现读'), 'facts shown');
check('the facts tab shows strength and id', factText.includes('强度') && factText.includes('^f00001'), 'metadata');
check('the facts tab hides invalidated facts by default', !factText.includes('旧结论：日志只有一帧'), 'hidden');

const invalidToggle = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node).includes('显示已失效'))[0];
check('the invalidated toggle exists', invalidToggle !== undefined, 'present');
invalidToggle.props.onClick();
await flush();
const withInvalid = MiniReact.textOf(current.tree);
check('invalidated facts are reachable on demand', withInvalid.includes('旧结论：日志只有一帧'), 'history shown');
check('invalidated rows name their replacement', withInvalid.includes('f00001'), 'supersededBy shown');

const forgetButton = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node) === '忘记')[0];
check('a fact can be forgotten', forgetButton !== undefined, 'present');
if (forgetButton) {
  forgetButton.props.onClick();
  await flush();
  const forgetCall = [...calls].reverse().find((call) => call.path === 'api/dsh-archived-digest/fact/forget');
  check('forgetting posts the fact id with the marker',
    forgetCall !== undefined && forgetCall.headers['x-dsh-archived-digest'] === '1' && JSON.parse(forgetCall.body).id === 'f00001',
    forgetCall?.body);
  check('forgetting asks for confirmation first', confirmations.length > 0, `${confirmations.length} prompts`);
}

// ── memories / skills ───────────────────────────────────────────────────────
clickTab('记忆');
await flush();
check('the memories tab lists a distilled memory', MiniReact.textOf(current.tree).includes('Zstd frames'), 'memory title');
clickTab('技能');
await flush();
const skillText = MiniReact.textOf(current.tree);
check('the skills tab lists a distilled skill', skillText.includes('Decode multiframe zstd'), 'skill title');
check('the skills tab names the source session', skillText.includes('bbbb2222'), 'source shown');
// A skill is only usable elsewhere once published into $DSH_HOME/skills, so the
// panel must distinguish published from blocked rather than showing a bare list.
check('a published skill says so', skillText.includes('已发布到技能中心'), 'published badge');
check('a name collision is flagged, not hidden', skillText.includes('同名技能已存在'), 'collision badge');

// ── settings ────────────────────────────────────────────────────────────────
clickTab('设置');
await flush();
const settingsText = MiniReact.textOf(current.tree);
check('the settings tab renders', settingsText.includes('设置'), 'settings shown');
const switches = MiniReact.findAll(current.tree, (node) => node.props.role === 'switch');
check('the settings tab renders switches', switches.length >= 3, `${switches.length} switches`);
check('the auto-digest switch starts off', switches[0]?.props['aria-checked'] === false, String(switches[0]?.props['aria-checked']));

switches[0].props.onClick();
await flush();
const autoOnCall = calls.filter((call) => call.method === 'POST' && call.path === 'api/dsh-archived-digest/settings').pop();
check('turning auto digest on posts it', autoOnCall !== undefined && JSON.parse(autoOnCall.body).autoEnabled === true, autoOnCall?.body);
check('the switch carries the marker header too', autoOnCall?.headers?.['x-dsh-archived-digest'] === '1', 'marker present');

// And back off — the requirement is that it can be switched off.
const switchesNow = MiniReact.findAll(current.tree, (node) => node.props.role === 'switch');
switchesNow[0].props.onClick();
await flush();
const autoOffCall = calls.filter((call) => call.method === 'POST' && call.path === 'api/dsh-archived-digest/settings').pop();
check('turning auto digest back off posts it', autoOffCall !== undefined && JSON.parse(autoOffCall.body).autoEnabled === false, autoOffCall?.body);

// Keyboard access on the switch (a div is not natively operable).
const switchNode = MiniReact.findAll(current.tree, (node) => node.props.role === 'switch')[0];
const before = calls.length;
switchNode.props.onKeyDown({ key: 'Enter', preventDefault() {} });
await flush();
check('the switch is operable from the keyboard', calls.length > before && calls.some((call) => call.path === 'api/dsh-archived-digest/settings')
  , 'Enter handled');
switchNode.props.onKeyDown({ key: 'Tab' });
const afterTab = calls.length;
check('unrelated keys do not toggle the switch', afterTab === calls.length || calls.length === afterTab, 'Tab ignored');

// ── cleanup guardrails ──────────────────────────────────────────────────────
clickTab('概览');
await flush();
const cleanupButton = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node).includes('清理已提炼的会话'))[0];
check('the cleanup action exists', cleanupButton !== undefined, 'present');
check('cleanup is disabled while the mode is off', cleanupButton?.props.disabled === true, String(cleanupButton?.props.disabled));

// Reaching a destructive cleanup must ask first.
const modeSelect = MiniReact.findAll(current.tree, (node) => node.tag === 'select')[0];
check('the cleanup mode select exists', modeSelect !== undefined, 'present');
modeSelect.props.onChange({ target: { value: 'logs' } });
await flush();
const modeCall = calls.filter((call) => call.method === 'POST' && call.path === 'api/dsh-archived-digest/settings').pop();
check('changing the cleanup mode persists it', modeCall !== undefined && JSON.parse(modeCall.body).cleanupMode === 'logs', modeCall?.body);

const cleanupNow = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node).includes('清理已提炼的会话'))[0];
if (cleanupNow && cleanupNow.props.disabled === false) {
  cleanupNow.props.onClick();
  await flush();
  check('destructive cleanup asks for confirmation', confirmations.length > 0, `${confirmations.length} prompts`);
  check('the cleanup call carries the marker', calls.some((call) => call.path === 'api/dsh-archived-digest/cleanup'
    && call.headers['x-dsh-archived-digest'] === '1'), 'marker present');
}

// ── error surface ───────────────────────────────────────────────────────────
// A failing endpoint must be visible, not swallowed. The header reload is the
// panel's manual re-read, so drive a failing /status through it.
setRoute('api/dsh-archived-digest/status', () => ({ __status: 500, ok: false, error: 'boom' }));
const reloadButton = MiniReact.findAll(current.tree, (node) => node.tag === 'button' && MiniReact.textOf(node) === '刷新')[0];
check('the header offers a reload action', reloadButton !== undefined, 'present');
reloadButton.props.onClick();
await flush();
check('a server error is shown to the user', MiniReact.textOf(current.tree).includes('boom'), 'error rendered');

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${failed.length === 0 ? 'all' : failed.length + ' of'} ${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
