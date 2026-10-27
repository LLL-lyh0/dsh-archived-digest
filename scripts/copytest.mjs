/**
 * Copy-language test: the panel must be Chinese in a Chinese GUI.
 *
 * This exists because the panel rendered in English for a Chinese user and no
 * error was produced: `document.documentElement.lang` is empty when the client
 * factory runs (the locale service writes it later), and '' does not start with
 * 'zh', so the ternary fell through to English — and `t` was captured once, so
 * it stayed English for the whole session.
 *
 * The assertions pin the three things that failed:
 *  1. An unset `<html lang>` still resolves to Chinese.
 *  2. An explicit `zh-CN` resolves to Chinese.
 *  3. The sidebar label and the visible copy follow the language live, so
 *     switching language in Settings does not need a reload.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as MiniReact from './mini-react.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(here, '..', rel)).href);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A DOM stub whose <html lang> the test controls. */
function makeDocument(lang) {
  return {
    get documentElement() { return { lang }; },
    addEventListener() {},
    removeEventListener() {},
  };
}

// Empty lang on purpose: this is the state the factory actually sees in the GUI.
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN', languages: ['zh-CN', 'zh'] },
  configurable: true,
  writable: true,
});
globalThis.document = makeDocument('');
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.confirm = () => true;

// Minimal fetch: the panel loads data on mount; the copy is what is under test.
const emptyRoutes = {
  status: {
    ok: true,
    settings: {
      autoEnabled: false, autoIntervalMinutes: 30, autoMaxPerRun: 3, autoRetryFailed: true,
      cleanupMode: 'off', cleanupMinAgeDays: 7, extractSkills: true,
      maxSourceChars: 14000, maxTokens: 2400, provider: '', model: '',
    },
    llm: { ready: true, note: null },
    store: { root: '/tmp/x', memories: 0, skills: 0, memoryBytes: 0, skillBytes: 0 },
    counts: { archived: 0, missing: 0, present: 0, digested: 0, cleaned: 0, pending: 0, failed: 0, memories: 0, skills: 0 },
    bytes: { archivedLogs: 0, allLogs: 0, allSessions: 0, workspaces: 0, freed: 0, store: 0 },
    run: null, runs: [], failures: [],
  },
  sessions: { ok: true, sessions: [], counts: { archived: 0, pending: 0 } },
  memories: { ok: true, memories: [], total: 0 },
  skills: { ok: true, skills: [], total: 0 },
};
globalThis.fetch = async (input) => {
  const key = String(input).split('?')[0].split('/').pop();
  return { ok: true, status: 200, async json() { return emptyRoutes[key] ?? { ok: true }; } };
};

let registration = null;
globalThis.window.__ModuleLoader__ = { load(entry) { registration = entry; } };

await load('client.js');
const mod = registration.factory((name) => {
  if (name === 'react') return MiniReact;
  throw new Error(`unexpected require("${name}")`);
});

const slots = [];
mod.apply({
  slots: {
    inject(_name, fn) { fn(); return () => {}; },
    register(definition, Component) { slots.push({ definition, Component }); return () => {}; },
  },
  effect(fn) { return fn() ?? (() => {}); },
});

const entry = slots.find((slot) => slot.definition.name === 'sidebar.panellist');
const page = slots.find((slot) => slot.definition.name === 'main');
check('both slots registered', entry !== undefined && page !== undefined, `${slots.length} slots`);

// ── 1. unset <html lang> must still be Chinese ──────────────────────────────
const labelEmpty = entry.definition.label();
check('sidebar label is Chinese when <html lang> is empty', labelEmpty === '归档会话提炼', JSON.stringify(labelEmpty));

const first = MiniReact.render(MiniReact.createElement(page.Component, {}));
const textEmpty = MiniReact.textOf(first.tree);
check('panel copy is Chinese when <html lang> is empty', textEmpty.includes('归档会话提炼') && textEmpty.includes('概览'), 'zh copy');
check('no English copy leaked in', !textEmpty.includes('Archived session digest') && !textEmpty.includes('Overview'), 'no en');

// ── 2. explicit zh-CN ──────────────────────────────────────────────────────
globalThis.document = makeDocument('zh-CN');
check('sidebar label is Chinese for zh-CN', entry.definition.label() === '归档会话提炼', entry.definition.label());
const zh = MiniReact.render(MiniReact.createElement(page.Component, {}));
check('panel copy is Chinese for zh-CN', MiniReact.textOf(zh.tree).includes('概览'), 'zh');

// ── 3. English when the GUI really is English ──────────────────────────────
globalThis.document = makeDocument('en');
const labelEn = entry.definition.label();
check('sidebar label is English for en', labelEn === 'Archived digest', JSON.stringify(labelEn));
const en = MiniReact.render(MiniReact.createElement(page.Component, {}));
const textEn = MiniReact.textOf(en.tree);
check('panel copy is English for en', textEn.includes('Archived session digest') && textEn.includes('Overview'), 'en copy');
check('no Chinese copy leaked into the English panel', !textEn.includes('概览'), 'no zh');

// ── 4. the label follows a live switch, with no reload ─────────────────────
globalThis.document = makeDocument('zh');
check('switching back to zh takes effect immediately', entry.definition.label() === '归档会话提炼', entry.definition.label());
globalThis.document = makeDocument('en');
check('switching to en takes effect immediately', entry.definition.label() === 'Archived digest', entry.definition.label());

// ── 5. dictionary parity: neither language may be missing a key ────────────
// A missing key renders "undefined" in the panel, which is how half-translated
// panels usually ship.
globalThis.document = makeDocument('zh');
const zhRender = MiniReact.render(MiniReact.createElement(page.Component, {}));
const zhText = MiniReact.textOf(zhRender.tree);
check('Chinese panel has no "undefined" placeholders', !zhText.includes('undefined'), 'no undefined');

globalThis.document = makeDocument('en');
const enRender = MiniReact.render(MiniReact.createElement(page.Component, {}));
const enText = MiniReact.textOf(enRender.tree);
check('English panel has no "undefined" placeholders', !enText.includes('undefined'), 'no undefined');

// The tabs are the densest label surface; assert the full set in both languages.
// The count is taken from what renders rather than hardcoded, so adding a tab does
// not need this file edited — but an untranslated label still fails.
globalThis.document = makeDocument('zh');
const zhTabs = MiniReact.findAll(MiniReact.render(MiniReact.createElement(page.Component, {})).tree,
  (node) => node.tag === 'button' && String(node.props.className ?? '').includes('ad-tab')).map(MiniReact.textOf);
check('every tab is Chinese', zhTabs.length >= 5 && zhTabs.every((label) => !/[A-Za-z]{4,}/.test(label)), zhTabs.join(' | '));

globalThis.document = makeDocument('en');
const enTabs = MiniReact.findAll(MiniReact.render(MiniReact.createElement(page.Component, {})).tree,
  (node) => node.tag === 'button' && String(node.props.className ?? '').includes('ad-tab')).map(MiniReact.textOf);
check('every tab is English', enTabs.length === zhTabs.length && enTabs.every((label) => /[A-Za-z]{4,}/.test(label)), enTabs.join(' | '));
check('both languages render the same number of tabs', enTabs.length === zhTabs.length, `${zhTabs.length} vs ${enTabs.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'all' : failed.length + ' of'} ${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
