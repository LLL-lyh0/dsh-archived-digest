/**
 * Offline self-test for the digest pipeline.
 *
 * Runs the real modules against a real archived session on this machine, with a
 * fake `llm` service, into a throwaway store root. It proves the parts that are
 * easy to get silently wrong:
 *
 *  - multi-frame zstd decoding (the bug that makes a 1.5 MB log look empty),
 *  - injection stripping (runtime snapshots must not reach the model),
 *  - memory + skill files actually landing on disk with valid frontmatter,
 *  - cleanup refusing to run before a memory exists, and working afterwards.
 *
 * Usage: node scripts/selftest.mjs [--keep]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { zstdCompressSync } from 'node:zlib';
import { existsSync } from 'node:fs';

import { archivedSessionIds, findSessionDir, listArchivedSessions, totalLogBytes, trashedSessionIds } from '../lib/inventory.js';
import { readSessionSource, digestOne, cleanupSession } from '../lib/digester.js';
import { readMemoryIndex, readSkillIndex, storeStats, paths } from '../lib/memory-store.js';
import { readState, recordFailure } from '../lib/state.js';
import { parseJsonReply } from '../lib/llm.js';
import { decodeZstdFrames } from '../lib/session-log.js';

const keep = process.argv.includes('--keep');
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-digest-test-'));
// Skills are published into `$DSH_HOME/skills` so the skills center can see them.
// Redirect that too, or a test run would drop fake skills into the user's real
// catalog. Must be set before the first writeSkill call.
const skillMirror = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-digest-skills-'));
process.env.DSH_ARCHIVED_DIGEST_SKILLS = skillMirror;
const results = [];

/** Run one check; a thrown assertion is a failure, never a crash of the suite. */
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      results.push({ name, ok: true });
      console.log(`  ok   ${name}${value === undefined ? '' : ` — ${value}`}`);
    })
    .catch((error) => {
      results.push({ name, ok: false, error: String(error?.message ?? error) });
      console.log(`  FAIL ${name} — ${error?.message ?? error}`);
    });
}

console.log(`store: ${storeRoot}`);

// ── decoder ─────────────────────────────────────────────────────────────────
await check('decodeZstdFrames() reads every frame, not just the first', () => {
  // Two frames of JSONL, concatenated: exactly the shape the DSH logger
  // produces. A naive whole-buffer decompress returns only the first frame,
  // which is what made a 1.5 MB log look like a 200-byte stub.
  const frameOne = zstdCompressSync(Buffer.from('{"type":"session","id":"multi"}\n', 'utf8'));
  const frameTwo = zstdCompressSync(Buffer.from('{"type":"user/message"}\n', 'utf8'));
  const text = decodeZstdFrames(Buffer.concat([frameOne, frameTwo]));
  assert.ok(text.includes('"type":"session"'), 'first frame missing');
  assert.ok(text.includes('"type":"user/message"'), 'second frame missing — decoder stopped at the first frame');
  assert.strictEqual(decodeZstdFrames(Buffer.alloc(0)), '', 'empty buffer must decode to empty text');
  assert.strictEqual(decodeZstdFrames(Buffer.from('not zstd at all', 'utf8')), '', 'non-zstd input must decode to empty text');
  return `${frameOne.length}+${frameTwo.length} byte frames both decoded`;
});

// ── inventory ───────────────────────────────────────────────────────────────
const ids = archivedSessionIds();
await check('archivedSessionIds() returns a non-empty list', () => {
  assert.ok(ids.length > 0, 'no archived sessions on this machine');
  return `${ids.length} archived`;
});

const totals = totalLogBytes();
await check('totalLogBytes() sees the session logs', () => {
  assert.ok(totals.bytes > 0, 'no log bytes');
  return `${(totals.bytes / 1048576).toFixed(1)} MB across ${totals.sessions} sessions`;
});

const inventory = listArchivedSessions({});
await check('every archived id resolves to a directory', () => {
  assert.strictEqual(inventory.missing, 0, `${inventory.missing} archived sessions have no directory`);
  return `${inventory.sessions.length} present`;
});

/**
 * Cleaned ≠ missing.
 *
 * Every archived session must end up in exactly one of three states, and the
 * totals must add up. Before this was enforced, a store where 38 sessions had been
 * correctly moved to `trash/` reported all 38 as `missing` — the panel showed
 * "38 missing" on a store with zero data loss, which is indistinguishable from
 * having destroyed 38 conversations.
 */
await check('archived sessions partition into present / cleaned / missing', () => {
  const present = inventory.sessions.filter((session) => session.present).length;
  const cleaned = inventory.sessions.filter((session) => !session.present && session.cleaned).length;
  assert.strictEqual(present + cleaned + inventory.missing, inventory.sessions.length,
    `${present} present + ${cleaned} cleaned + ${inventory.missing} missing ≠ ${inventory.sessions.length}`);
  return `${present} present + ${cleaned} cleaned + ${inventory.missing} missing = ${inventory.sessions.length}`;
});

await check('a session whose log was cleaned is not counted as missing', () => {
  // Anything with a cleanup record or a trash directory must be `cleaned`, and a
  // cleaned row must never also be `missing`.
  const cleanedButAbsent = inventory.sessions.filter((session) => !session.present && session.cleaned);
  for (const row of cleanedButAbsent) {
    assert.strictEqual(row.cleaned, true, `${row.sessionId} is absent without a cleanup record`);
  }
  return `${cleanedButAbsent.length} cleaned rows accounted for`;
});

await check('trashed directories are recoverable and map back to their session id', () => {
  // The trash directory name is `<session-id>-<timestamp>` after `sessionSlug()`,
  // which strips the `session-` prefix — so both spellings must resolve.
  const map = trashedSessionIds();
  if (map.size === 0) return 'no trash on this machine';
  // The trash directory name is `<session-id>-<timestamp>` after `sessionSlug()`,
  // which strips the `session-` prefix — so the map registers BOTH spellings. Assert
  // the property that matters (a lookup by the archived id resolves) rather than
  // which spelling happens to be inserted first.
  const bare = [...map.keys()].find((key) => !key.startsWith('session-'));
  if (bare === undefined) return `${map.size} keys, all prefixed`;
  const full = `session-${bare}`;
  assert.ok(map.has(full), `the prefixed id ${full} does not resolve to its trash directory`);
  const trashPath = map.get(full);
  assert.ok(existsSync(trashPath), `trash path vanished: ${trashPath}`);
  assert.strictEqual(map.get(bare), trashPath, 'both spellings must point at the same directory');
  const recoverable = inventory.sessions.filter((session) => session.recoverable);
  return `${map.size} keys (2 per dir), ${recoverable.length} archived rows marked recoverable`;
});

// ── decode one real session ─────────────────────────────────────────────────
const sample = inventory.sessions.find((session) => session.present && session.bytes > 100000) ?? inventory.sessions.find((s) => s.present);
await check('a real archived session decodes and yields source text', () => {
  assert.ok(sample, 'no present session to test');
  const located = findSessionDir(sample.sessionId);
  assert.ok(located, 'findSessionDir failed');
  const read = readSessionSource(located.dir);
  assert.ok(read.ok, `readSessionSource failed: ${read.code} ${read.message}`);
  assert.ok(read.source.chars > 100, `only ${read.source.chars} chars survived trimming`);
  // The injection strip is the whole point of this assertion.
  assert.ok(!read.source.transcript.includes('Current runtime context'), 'runtime snapshot leaked into the transcript');
  assert.ok(!read.source.transcript.includes('<system-reminder>'), 'system-reminder block leaked into the transcript');
  assert.ok(!read.source.transcript.includes('<available_skills>'), 'skill catalog leaked into the transcript');
  return `${sample.sessionId}: ${read.events} events → ${read.source.keptTurns}/${read.source.turns} turns, ${read.source.chars} chars`;
});

// ── json parser ─────────────────────────────────────────────────────────────
await check('parseJsonReply() tolerates fences and prose', () => {
  assert.deepStrictEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(parseJsonReply('here you go: {"a":{"b":2}} thanks'), { a: { b: 2 } });
  assert.deepStrictEqual(parseJsonReply('no json here'), null);
  assert.deepStrictEqual(parseJsonReply('{"broken": '), null);
  return 'fenced / chatty / absent / torn all handled';
});

await check('parseJsonReply() repairs raw newlines and trailing commas', () => {
  // A real model reply: pretty-printed, but with real newlines inside a string
  // value. `JSON.parse` rejects this, which used to be reported as "the model did
  // not return JSON" even though the object was fully present.
  const broken = '{\n "title": "line one\nline two",\n "tags": ["a", "b",],\n "cwd": "D:\\DeepSeekHarness",\n "tabbed": "a\\tb",\n "quoted": "say \\"hi\\"",\n}';
  const fixed = parseJsonReply(broken);
  assert.strictEqual(fixed.title, 'line one\nline two');
  assert.deepStrictEqual(fixed.tags, ['a', 'b']);
  // The Windows path is the dominant real-world failure: "\D" is not a legal JSON
  // escape, so one unescaped backslash used to cost the whole session's digest.
  assert.strictEqual(fixed.cwd, 'D:\\DeepSeekHarness');
  // Valid escapes must survive the repair untouched.
  assert.strictEqual(fixed.tabbed, 'a\tb');
  assert.strictEqual(fixed.quoted, 'say "hi"');
  // Repair must not rescue a reply that is genuinely incomplete.
  assert.strictEqual(parseJsonReply('{"title": '), null);
  assert.strictEqual(parseJsonReply('{"title": "unterminated'), null);
  return 'control characters escaped, bad escapes fixed, trailing commas dropped, torn still rejected';
});

await check('recordFailure() keeps attempts a countable number', () => {
  const empty = () => ({ digested: {}, failed: {}, skipped: {}, runs: [], totals: {} });
  const two = empty();
  recordFailure(two, 's1', {
    code: 'MAX_TOKENS',
    message: 'truncated',
    attempts: [{ code: 'MAX_TOKENS', maxTokens: 2400 }, { code: 'MAX_TOKENS', maxTokens: 4800 }],
    attemptLog: [{ maxTokens: 2400 }, { maxTokens: 4800 }],
    raw: '{"title":',
  });
  // The llm layer hands over one entry per route/budget; storing that array here
  // left the retry gate comparing an array, and the next failure concatenated the
  // array with a number into "[object Object]1".
  assert.strictEqual(typeof two.failed.s1.attempts, 'number');
  assert.strictEqual(two.failed.s1.attempts, 2);
  assert.strictEqual(two.failed.s1.attemptLog.length, 2);
  assert.strictEqual(two.failed.s1.rawSample, '{"title":');
  const one = empty();
  recordFailure(one, 's2', { code: 'NO_LOG', message: 'no log file' });
  assert.strictEqual(one.failed.s2.attempts, 1);
  recordFailure(one, 's2', { code: 'NO_LOG', message: 'no log file' });
  assert.strictEqual(one.failed.s2.attempts, 2, 'an uncounted failure still increments');
  return 'array collapsed to its length, absent count increments, raw sample kept';
});

// ── digest with a fake llm ──────────────────────────────────────────────────
const FAKE_DIGEST = {
  title: 'Selftest digest',
  summary: 'A synthetic summary produced by the offline self-test.',
  decisions: ['chose the multi-frame decoder', 'refused cleanup before memory write'],
  facts: ['store root is a temp dir', 'logs are multi-frame zstd'],
  openIssues: [],
  tags: ['selftest', 'archived-digest'],
  skills: [
    {
      name: 'decode-multiframe-zstd',
      description: 'Decode a zstd file that was written as several concatenated frames.',
      whenToUse: 'A decompress call returns only the first few hundred bytes of a much larger log.',
      steps: ['scan for the frame magic 28 b5 2f fd', 'decode each slice', 'concatenate the results'],
      pitfalls: ['the magic can appear inside a payload; validate each slice and widen on failure'],
      verification: ['decoded length is within an order of magnitude of the compressed size'],
    },
  ],
};

/** Minimal stand-in for the dsh llm service: one provider, one model. */
function fakeCtx(reply = JSON.stringify(FAKE_DIGEST)) {
  const llm = {
    listProviders: () => [{ id: 'fake-provider', compat: { reasoningEffort: false } }],
    listModels: async () => [{ id: 'fake-model' }],
    async *stream(options) {
      // Assert the request shape rather than trusting it.
      assert.ok(Array.isArray(options.messages) && options.messages.length === 1, 'expected exactly one message');
      assert.ok(options.provider === 'fake-provider', `unexpected provider ${options.provider}`);
      assert.ok(!('reasoningEffort' in options), 'reasoningEffort must be omitted for a provider that does not support it');
      yield { type: 'text', delta: reply.slice(0, 20) };
      yield { type: 'text', delta: reply.slice(20) };
      yield { type: 'finish', kind: 'stop' };
    },
  };
  return { get: (name) => (name === 'llm' ? llm : undefined) };
}

const target = inventory.sessions.find((session) => session.present && session.bytes > 100000) ?? sample;

const digest = await digestOne({
  ctx: fakeCtx(),
  sessionId: target.sessionId,
  sessionDir: target.dir,
  storeRoot,
  route: { provider: 'fake-provider', model: 'fake-model' },
  options: { extractSkills: true, cleanupMode: 'off' },
});

await check('digestOne() succeeds against the fake llm', () => {
  assert.ok(digest.ok, `failed: ${digest.code} ${digest.message}`);
  return `${digest.title} → ${path.basename(digest.memoryFile)}`;
});

await check('memory file exists and carries frontmatter', () => {
  assert.ok(digest.memoryFile && fs.existsSync(digest.memoryFile), 'memory file missing');
  const text = fs.readFileSync(digest.memoryFile, 'utf8');
  assert.ok(text.startsWith('---\n'), 'memory file has no frontmatter');
  assert.ok(text.includes('session-id:'), 'frontmatter lacks session-id');
  return `${text.length} chars`;
});

await check('memory index records the session', async () => {
  const index = await readMemoryIndex(storeRoot);
  assert.ok(index.entries[target.sessionId], 'index has no entry for the digested session');
  return `${Object.keys(index.entries).length} entries`;
});

await check('skill landed as a valid SKILL.md', async () => {
  const index = await readSkillIndex(storeRoot);
  const entry = index.entries['decode-multiframe-zstd'];
  assert.ok(entry, `skill not indexed; have ${Object.keys(index.entries).join(',') || 'none'}`);
  const file = path.join(paths(storeRoot).root, entry.file);
  assert.ok(fs.existsSync(file), 'skill file missing');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('---\n'), 'skill has no frontmatter');
  // The skills manager reports error-level diagnostics when these are missing.
  assert.ok(/^name:\s*\S/m.test(text), 'skill frontmatter lacks name');
  assert.ok(/^description:\s*\S/m.test(text), 'skill frontmatter lacks description');
  const nameLine = text.split('\n').find((line) => line.startsWith('name: ')) ?? '';
  assert.ok(/^name: [a-z][a-z0-9-]*$/.test(nameLine.trim()), `skill name is not kebab-case: ${nameLine}`);
  return entry.file;
});

await check('state records the digest', async () => {
  const state = await readState(storeRoot);
  assert.ok(state.digested[target.sessionId], 'state lacks the digest');
  return `${state.totals.digested} digested`;
});

// ── idempotence: digesting again must not corrupt or duplicate ──────────────
const again = await digestOne({
  ctx: fakeCtx(),
  sessionId: target.sessionId,
  sessionDir: target.dir,
  storeRoot,
  route: { provider: 'fake-provider', model: 'fake-model' },
  options: { extractSkills: true },
});
await check('re-digesting the same session is stable', async () => {
  assert.ok(again.ok, `second run failed: ${again.code} ${again.message}`);
  const index = await readSkillIndex(storeRoot);
  const skill = index.entries['decode-multiframe-zstd'];
  assert.strictEqual(skill.sources.filter((id) => id === target.sessionId).length, 1, 'skill source list duplicated the session');
  const memories = await readMemoryIndex(storeRoot);
  assert.strictEqual(Object.keys(memories.entries).length, 1, 'a second memory file appeared for one session');
  return 'one memory, one skill, one source entry';
});

// ── truncation: shrink the input, do not just buy more thinking ─────────────
/**
 * A fake llm that truncates while the prompt is still large.
 *
 * Models the real failure: `output hit the maxTokens=8000 ceiling and was
 * truncated (reasoning 17853 chars before the answer)`. The model never wrote an
 * answer character, so a bigger budget buys more thinking, not an answer. What
 * must happen instead is that the digest retries with a *smaller* transcript.
 */
function truncatingCtx(threshold) {
  const prompts = [];
  const llm = {
    listProviders: () => [{ id: 'fake-provider', compat: { reasoningEffort: false } }],
    listModels: async () => [{ id: 'fake-model' }],
    async *stream(options) {
      const text = (options.messages?.[0]?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      prompts.push(text.length);
      if (text.length > threshold) {
        // Thinking only: no answer text, and a max-tokens finish. Chunk field is
        // `text` (not `delta`) — that is the real shape the assembler pushes.
        yield { type: 'reasoning-delta', text: 'We need produce JSON only. '.repeat(20) };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      const reply = JSON.stringify(FAKE_DIGEST);
      yield { type: 'text-delta', text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  return { ctx: { get: (name) => (name === 'llm' ? llm : undefined) }, prompts };
}

await check('a truncated digest shrinks the transcript instead of only raising the budget', async () => {
  const shrinkTarget = inventory.sessions
    .filter((session) => session.present && session.bytes > 100000 && session.sessionId !== target.sessionId)
    .sort((a, b) => b.bytes - a.bytes)[0];
  assert.ok(shrinkTarget, 'no second large session available');
  // Between the full transcript and its half, so the first attempt truncates and
  // the shrunken retry fits.
  const { ctx, prompts } = truncatingCtx(9000);
  const shrunk = await digestOne({
    ctx,
    sessionId: shrinkTarget.sessionId,
    sessionDir: shrinkTarget.dir,
    storeRoot,
    route: { provider: 'fake-provider', model: 'fake-model' },
    options: { extractSkills: false, maxSourceChars: 14000 },
  });
  assert.ok(shrunk.ok, `shrinking did not recover the digest: ${shrunk.code} ${shrunk.message}`);
  const largest = Math.max(...prompts);
  const smallest = Math.min(...prompts);
  assert.ok(prompts.length > 1, `only one attempt was made; prompts=${prompts.join(',')}`);
  assert.ok(smallest < largest, `the retry did not shrink the input; prompts=${prompts.join(',')}`);
  assert.ok(smallest <= 9000, `the successful retry still exceeded the threshold; prompts=${prompts.join(',')}`);
  return `${prompts.length} attempts, prompt chars ${largest} → ${smallest}`;
});

// ── cleanup guard ───────────────────────────────────────────────────────────
await check('cleanup refuses a session with no stored memory', async () => {
  const undigested = inventory.sessions.find((session) => session.present && session.sessionId !== target.sessionId && !session.digestedAt);
  assert.ok(undigested, 'no second session available');
  const refused = await cleanupSession({
    storeRoot,
    sessionId: undigested.sessionId,
    sessionDir: undigested.dir,
    mode: 'logs',
  });
  assert.strictEqual(refused.ok, false, 'cleanup ran on an undigested session');
  assert.strictEqual(refused.code, 'NOT_DIGESTED', `unexpected refusal code ${refused.code}`);
  assert.ok(fs.existsSync(undigested.logFile), 'the log was deleted despite the refusal');
  return refused.message;
});

await check('cleanup works after a digest, and reports freed bytes', async () => {
  // Copy the target session dir so the test never destroys real history.
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-digest-copy-'));
  const copyDir = path.join(copyRoot, target.sessionId);
  fs.cpSync(target.dir, copyDir, { recursive: true });
  const before = fs.readdirSync(copyDir).filter((name) => name.endsWith('.zstd'));
  assert.ok(before.length > 0, 'copied dir has no log');
  const cleaned = await cleanupSession({
    storeRoot,
    sessionId: target.sessionId,
    sessionDir: copyDir,
    mode: 'logs',
  });
  assert.ok(cleaned.ok, `cleanup failed: ${cleaned.code} ${cleaned.message}`);
  assert.ok(cleaned.freed > 0, 'freed 0 bytes');
  assert.strictEqual(fs.readdirSync(copyDir).filter((name) => name.endsWith('.zstd')).length, 0, 'log survived cleanup');
  assert.ok(fs.existsSync(path.join(copyDir, '.archived-digest-cleaned')), 'no cleaned marker written');
  fs.rmSync(copyRoot, { recursive: true, force: true });
  return `${(cleaned.freed / 1024).toFixed(0)} KB freed`;
});

// The automatic path is a different code path from the manual one above: it runs
// inside digestOne, and it re-reads state from disk to authorise the deletion.
// Called out explicitly because getting the order wrong makes auto-cleanup a
// silent no-op — the digest reports success and nothing gets freed.
await check('digestOne honours cleanupMode by itself', async () => {
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-digest-auto-'));
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-digest-auto-log-'));
  const copyDir = path.join(copyRoot, target.sessionId);
  fs.cpSync(target.dir, copyDir, { recursive: true });
  const out = await digestOne({
    ctx: fakeCtx(),
    sessionId: target.sessionId,
    sessionDir: copyDir,
    storeRoot: freshRoot,
    route: {},
    options: { cleanupMode: 'logs' },
  });
  assert.ok(out.ok, `digest failed: ${out.code} ${out.message}`);
  assert.ok(out.cleanup && out.cleanup.ok, `auto-cleanup did not run: ${out.cleanup?.code} ${out.cleanup?.message}`);
  assert.strictEqual(fs.readdirSync(copyDir).filter((name) => name.endsWith('.zstd')).length, 0, 'log survived auto-cleanup');
  const state = await readState(freshRoot);
  assert.ok(state.cleaned[target.sessionId], 'cleanup not recorded in state');
  assert.ok(state.digested[target.sessionId], 'digest not recorded in state');
  fs.rmSync(freshRoot, { recursive: true, force: true });
  fs.rmSync(copyRoot, { recursive: true, force: true });
  return `${(out.cleanup.freed / 1024).toFixed(0)} KB freed automatically`;
});

await check('storeStats() reports the store size', async () => {
  const stats = await storeStats(storeRoot);
  assert.ok(stats.memories >= 1, 'no memories counted');
  assert.ok(stats.skills >= 1, 'no skills counted');
  return `${stats.memories} memories / ${stats.skills} skills / ${stats.memoryBytes + stats.skillBytes} bytes`;
});

// ── summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((result) => result.ok === false);
console.log('');
if (failed.length > 0) {
  console.log(`${failed.length} check(s) failed:`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.error}`);
} else {
  console.log(`all ${results.length} checks passed`);
}
if (!keep) {
  fs.rmSync(storeRoot, { recursive: true, force: true });
  fs.rmSync(skillMirror, { recursive: true, force: true });
} else console.log(`kept store at ${storeRoot} (skills mirror: ${skillMirror})`);
process.exitCode = failed.length > 0 ? 1 : 0;
