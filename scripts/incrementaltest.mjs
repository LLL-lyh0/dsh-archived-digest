/**
 * Incremental capture of *running* sessions, and the self-check.
 *
 * Two requirements drive these tests, and each has one invariant that is easy to
 * break silently:
 *
 *  1. **A running session is read-only.** Its log is being appended to by a live
 *     agent, so writing a marker into it would corrupt an open file. Pinned here:
 *     the log's bytes AND mtime are unchanged after a digest, and the watermark
 *     lives in our own store instead.
 *  2. **Already-digested content is never re-sent.** Pinned here by advancing the
 *     cursor and then asserting the same events are no longer selected — and by
 *     checking the model would receive only the new turns.
 *
 * The self-check's invariants: a dry run changes nothing, a real run supersedes
 * (never deletes) duplicate facts, and running it twice is a no-op the second time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(here, '..', rel)).href);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-incr-'));
process.env.DSH_HOME = sandbox;
process.env.DSH_ARCHIVED_DIGEST_SKILLS = path.join(sandbox, 'skills');
const storeRoot = path.join(sandbox, 'store');

const WS = '--D--';
const sessionsDir = path.join(sandbox, 'sessions', WS);
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(path.join(sandbox, 'storages'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { archivedSessionIds: [], pinnedSessionIds: [] },
}, null, 2));

const { zstdCompressSync } = await import('node:zlib');
/**
 * Append events the way the logger does: a NEW zstd frame per flush.
 *
 * This matters — one frame per write is what makes the log multi-frame, and
 * rewriting a single frame would change the file's identity instead of extending
 * it, which is exactly the corruption the read-only rule prevents.
 */
function appendEvents(sessionId, events, frame = 'session.jsonl.zstd') {
  const dir = path.join(sessionsDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, frame);
  const payload = zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8'));
  fs.appendFileSync(file, payload);
  return dir;
}

const userText = (seq, text) => ({ type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }] } });
const assistantText = (seq, text) => ({ type: 'assistant/message', seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });

const SID = 'session-incremental-0001';
const dir = appendEvents(SID, [
  { type: 'session', id: SID, version: 0, createdAt: Date.now(), cwd: 'D:\\DeepSeekHarness' },
  userText(10, '第一个问题：多帧 zstd 日志要怎么解？逐帧切还是整体解？'),
  assistantText(20, '必须按 magic bytes 28 b5 2f fd 逐帧切分，否则 zstdDecompressSync 只返回第一帧的内容。'),
]);

const logFile = path.join(dir, 'session.jsonl.zstd');
const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = { hash: hashOf(logFile), stat: fs.statSync(logFile) };

const cursor = await load('lib/live-cursor.js');
const digester = await load('lib/digester.js');
const sessionLog = await load('lib/session-log.js');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log(` FAIL  ${name} — ${error?.message ?? error}`);
  }
}

// A fake llm that records exactly what it was asked to digest.
function fakeCtx(reply) {
  const seen = [];
  const llm = {
    listProviders: () => [{ id: 'fake', compat: { reasoningEffort: false } }],
    listModels: async () => [{ id: 'm' }],
    async *stream(options) {
      const content = options.messages?.[0]?.content ?? [];
      seen.push(Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('') : String(content));
      yield { type: 'text', text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  return { ctx: { get: (name) => (name === 'llm' ? llm : undefined) }, seen };
}

const REPLY = JSON.stringify({
  title: '增量提炼', summary: '按帧解 zstd。',
  decisions: ['逐帧解压多帧 zstd 日志'], facts: [{ label: '切帧依据', value: 'magic bytes 28 b5 2f fd' }],
  openIssues: [], tags: ['zstd'], skills: [],
});

// ── 1. the cursor excludes what was already digested ────────────────────────
await check('a session with no cursor selects every event', async () => {
  const events = sessionLog.parseEvents(sessionLog.readSessionLogText(logFile));
  const selection = cursor.selectFresh(events, cursor.getCursor({}, SID));
  assert.strictEqual(selection.lastSeq, 0, 'first pass must start at zero');
  assert.strictEqual(selection.fresh.length, events.length, 'all events should be fresh');
  return `${events.length} events, lastSeq=0`;
});

await check('events at or below the watermark are excluded', async () => {
  const events = sessionLog.parseEvents(sessionLog.readSessionLogText(logFile));
  const at20 = cursor.getCursor({ sessions: { [SID]: { lastSeq: 20 } } }, SID);
  const selection = cursor.selectFresh(events, at20);
  assert.ok(selection.fresh.length > 0, 'the assistant message at seq 20 is excluded; the header still passes');
  const seqs = selection.fresh.filter((e) => Number.isInteger(e.seq)).map((e) => e.seq);
  assert.ok(seqs.every((seq) => seq > 20), `selected a stale event: ${seqs.join(',')}`);
  return `${selection.fresh.length} fresh, all seq > 20`;
});

await check('extractDigestSource honours sinceSeq', async () => {
  const events = sessionLog.parseEvents(sessionLog.readSessionLogText(logFile));
  const all = sessionLog.extractDigestSource(events);
  const from20 = sessionLog.extractDigestSource(events, { sinceSeq: 20 });
  assert.ok(all.transcript.includes('多帧 zstd'), 'baseline transcript should hold the first question');
  assert.ok(!from20.transcript.includes('多帧 zstd'), 'sinceSeq=20 must drop the first question');
  assert.strictEqual(from20.fromSeq, 10, 'seq bounds are reported even when filtered');
  assert.strictEqual(from20.toSeq, 20);
  return `full ${all.chars} chars → sinceSeq=20 ${from20.chars} chars`;
});

// ── 2. the read-only invariant ──────────────────────────────────────────────
await check('digesting a running session does not modify its log', async () => {
  const { ctx } = fakeCtx(REPLY);
  const result = await digester.digestLiveIncremental({
    ctx, sessionId: SID, sessionDir: dir, storeRoot,
    route: { provider: 'fake', model: 'm' }, options: { extractSkills: false },
  });
  assert.ok(result.ok, `digest failed: ${result.code} ${result.message}`);
  const afterHash = hashOf(logFile);
  const afterStat = fs.statSync(logFile);
  assert.strictEqual(afterHash, before.hash, 'the session log content changed');
  assert.strictEqual(afterStat.size, before.stat.size, 'the session log size changed');
  assert.strictEqual(afterStat.mtimeMs, before.stat.mtimeMs, 'the session log mtime changed');
  return `sha256 unchanged, ${afterStat.size} bytes, mtime unchanged`;
});

await check('the watermark is stored in OUR store, not the session', async () => {
  const cursors = await cursor.readCursors(storeRoot);
  const entry = cursors.sessions[SID];
  assert.ok(entry, 'no cursor recorded');
  assert.strictEqual(entry.lastSeq, 20, `lastSeq should be 20, got ${entry.lastSeq}`);
  assert.strictEqual(entry.segments.length, 1, 'one segment expected');
  assert.strictEqual(entry.segments[0].toSeq, 20);
  const sessionFiles = fs.readdirSync(dir);
  assert.deepStrictEqual(sessionFiles, ['session.jsonl.zstd'], `unexpected file written into the session: ${sessionFiles.join(',')}`);
  return `live-cursors.json holds seq 20; session dir still has only its log`;
});

// ── 3. the second pass takes only the new part ──────────────────────────────
appendEvents(SID, [
  userText(30, '第二个问题：进行中的会话会不会被改写？'),
  assistantText(40, '不会。提炼只读日志，已提炼的位置记在我们自己的游标里，重复内容不会再送进模型。'),
]);

await check('a second pass sends only the new turns to the model', async () => {
  const { ctx, seen } = fakeCtx(REPLY);
  const result = await digester.digestLiveIncremental({
    ctx, sessionId: SID, sessionDir: dir, storeRoot,
    route: { provider: 'fake', model: 'm' }, options: { extractSkills: false },
  });
  assert.ok(result.ok, `second pass failed: ${result.code} ${result.message}`);
  assert.strictEqual(seen.length, 1, 'expected exactly one model call');
  const prompt = seen[0];
  assert.ok(prompt.includes('第二个问题'), 'the new turn must be included');
  assert.ok(!prompt.includes('第一个问题'), 'the already-digested turn must NOT be re-sent');
  assert.strictEqual(result.seq.from, 30);
  assert.strictEqual(result.seq.to, 40);
  return `1 call, seq 30–40, first turn absent from the prompt`;
});

await check('the cursor advanced to the newest consumed seq', async () => {
  const cursors = await cursor.readCursors(storeRoot);
  const entry = cursors.sessions[SID];
  assert.strictEqual(entry.lastSeq, 40, `lastSeq=${entry.lastSeq}`);
  assert.strictEqual(entry.segments.length, 2, 'two segments expected');
  assert.strictEqual(entry.totalTurns, 4, `accumulated turns should be 4, got ${entry.totalTurns}`);
  return `seq 40, 2 segments, 4 turns accumulated`;
});

await check('earlier segments survive in the memory file', async () => {
  const { readMemoryIndex } = await load('lib/memory-store.js');
  const index = await readMemoryIndex(storeRoot);
  const entry = index.entries[SID];
  assert.ok(entry, 'no memory recorded');
  assert.strictEqual(entry.live, true, 'memory should be flagged live');
  assert.strictEqual(entry.segments, 2, `index should report 2 segments, got ${entry.segments}`);
  const text = fs.readFileSync(path.join(storeRoot, 'memories', `${entry.file.split('/').pop()}`), 'utf8');
  assert.ok(text.includes('Earlier updates'), 'the memory file lost its earlier updates section');
  assert.ok(text.includes('seq 10–20'), 'the earlier seq range is not recorded');
  return `2 segments, earlier range present in the file`;
});

await check('a pass with nothing new spends no model call', async () => {
  const { ctx, seen } = fakeCtx(REPLY);
  const result = await digester.digestLiveIncremental({
    ctx, sessionId: SID, sessionDir: dir, storeRoot,
    route: { provider: 'fake', model: 'm' }, options: { extractSkills: false },
  });
  assert.ok(result.ok, `unexpected failure: ${result.code}`);
  assert.strictEqual(result.unchanged, true, 'should report unchanged');
  assert.strictEqual(seen.length, 0, `spent ${seen.length} model calls on an unchanged session`);
  return 'UP_TO_DATE, 0 model calls';
});

await check('new events with no conversation advance the cursor without a call', async () => {
  // Tool/machinery events only: real events, nothing to remember.
  appendEvents(SID, [{ type: 'tool/call', seq: 50, data: { name: 'grep', arguments: '{}' } }]);
  const { ctx, seen } = fakeCtx(REPLY);
  const result = await digester.digestLiveIncremental({
    ctx, sessionId: SID, sessionDir: dir, storeRoot,
    route: { provider: 'fake', model: 'm' }, options: { extractSkills: false },
  });
  assert.ok(result.ok, `unexpected failure: ${result.code}`);
  assert.strictEqual(result.code, 'NO_CONVERSATION', `expected NO_CONVERSATION, got ${result.code}`);
  assert.strictEqual(seen.length, 0, 'machinery events must not cost a model call');
  const cursors = await cursor.readCursors(storeRoot);
  assert.strictEqual(cursors.sessions[SID].lastSeq, 50, 'cursor should still advance past machinery');
  return 'NO_CONVERSATION, no call, cursor advanced to 50';
});

// ── 4. a rewound log must not silently skip content ─────────────────────────
await check('a shrunken log resets the cursor instead of skipping forever', async () => {
  const entry = cursor.getCursor({ sessions: { [SID]: { lastSeq: 500, bytesAtDigest: 10_000_000, mtimeMs: Date.now() + 100000 } } }, SID);
  const rewound = cursor.detectRewind(entry, { bytes: 1000, mtimeMs: Date.now() });
  assert.strictEqual(rewound, true, 'a smaller log than the one digested must be detected');
  const events = sessionLog.parseEvents(sessionLog.readSessionLogText(logFile));
  const selection = cursor.selectFresh(events, entry, { bytes: 1000, mtimeMs: Date.now() });
  assert.strictEqual(selection.rewound, true);
  assert.strictEqual(selection.lastSeq, 0, 'a rewound session must start from zero');
  assert.ok(selection.fresh.length > 0, 'fresh content must be re-selected');
  return 'rewind detected, cursor reset to 0';
});

// ── 5. the self-check ───────────────────────────────────────────────────────
const selfcheck = await load('lib/selfcheck.js');
const facts = await load('lib/facts.js');

/**
 * Build a ledger by direct construction, not through `applyWrite`.
 *
 * This models what the self-check actually faces: rows that the *current* write
 * pipeline would have merged, but which are already in the ledger because an
 * earlier version wrote them (the real store has 8 such groups at ≥0.75, all from
 * before `similarity` was calibrated — under the old coarse metric they scored
 * below 0.5 and were added as separate facts). Writing the fixture through
 * `applyWrite` would collapse it at write time and test nothing.
 */
let seq = 0;
function row(kind, text, source, extra = {}) {
  seq += 1;
  return {
    id: `f${String(seq).padStart(5, '0')}`,
    text, kind, topic: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    validUntil: null, supersededBy: null, sources: [source], hits: 1, tags: [], ...extra,
  };
}

function seedLedger() {
  // True restatements (measured 0.914 in the real ledger) — must merge.
  const a = row('decision', '网格淡出改为逐顶点、每条线切 14 段，ImmediateMesh 单段线只能取一个亮度', 's1');
  const b = row('decision', '淡出改为逐顶点（每条线切 14 段），因为 ImmediateMesh 两点线只能取单一亮度', 's2');
  // Same topic, different fact (measured 0.51) — must NOT merge.
  const c = row('open', '审查未提交改动时把代码注释里的历史断言与 git 提交版本对质', 's3');
  const d = row('open', '会话未提供 git 或其他版本控制是否可用的信息', 's4');
  return { version: 1, seq, facts: [a, b, c, d], topics: [] };
}

await check('the dedupe threshold separates restatements from same-topic noise', async () => {
  const ledger = seedLedger();
  const live = ledger.facts.filter((f) => !f.validUntil);
  const same = facts.similarity(live[0].text, live[1].text);
  const noise = facts.similarity(live[2].text, live[3].text);
  assert.ok(same >= selfcheck.FACT_DEDUPE_THRESHOLD, `restatement scored ${same.toFixed(3)}, below the threshold`);
  assert.ok(noise < selfcheck.FACT_DEDUPE_THRESHOLD, `same-topic noise scored ${noise.toFixed(3)}, above the threshold`);
  return `restatement ${same.toFixed(3)} ≥ ${selfcheck.FACT_DEDUPE_THRESHOLD} > ${noise.toFixed(3)} noise`;
});

await check('a dry run retires duplicates on paper and changes nothing on disk', async () => {
  const ledger = seedLedger();
  const before = JSON.stringify(ledger);
  const result = selfcheck.mergeFacts(ledger, { apply: false });
  assert.strictEqual(result.retired, 1, `expected 1 retirement, got ${result.retired}`);
  assert.strictEqual(JSON.stringify(ledger), before, 'a dry run modified the ledger');
  return `1 retirement reported, ledger byte-identical`;
});

await check('applying supersedes rather than deletes, and merges corroboration', async () => {
  const ledger = seedLedger();
  const liveBefore = ledger.facts.filter((f) => !f.validUntil).length;
  const result = selfcheck.mergeFacts(ledger, { apply: true });
  assert.strictEqual(result.retired, 1);
  const liveAfter = ledger.facts.filter((f) => !f.validUntil).length;
  assert.strictEqual(liveAfter, liveBefore - 1, 'exactly one fact should stop being live');
  assert.strictEqual(ledger.facts.length, liveBefore, 'no row may be removed from the ledger');
  const retired = ledger.facts.find((f) => f.supersededReason === 'self-check duplicate');
  assert.ok(retired.validUntil, 'the retired fact has no validUntil');
  assert.ok(retired.supersededBy, 'the retired fact has no supersededBy link');
  const survivor = ledger.facts.find((f) => f.id === retired.supersededBy);
  assert.ok(survivor, 'the survivor named by supersededBy does not exist');
  // The survivor must remain live: no validUntil, no link away from it.
  assert.strictEqual(survivor.validUntil, null, 'the survivor was itself retired');
  assert.strictEqual(survivor.supersededBy, null, 'the survivor carries a supersede link');
  assert.strictEqual(survivor.sources.length, 2, `corroboration should merge to 2 sources, got ${survivor.sources.length}`);
  return `${liveBefore} → ${liveAfter} live, row kept with validUntil, sources merged to 2`;
});

await check('the self-check is idempotent', async () => {
  const ledger = seedLedger();
  const first = selfcheck.mergeFacts(ledger, { apply: true });
  const second = selfcheck.mergeFacts(ledger, { apply: true });
  assert.strictEqual(first.retired, 1);
  assert.strictEqual(second.retired, 0, `a second pass retired ${second.retired} more`);
  const third = selfcheck.mergeFacts(ledger, { apply: true });
  assert.strictEqual(third.retired, 0);
  return 'first pass 1, second 0, third 0';
});

await check('facts of different kinds are never merged', async () => {
  const ledger = { version: 1, seq: 0, topics: [], facts: [] };
  // Same wording, different standing: a decision and an open item.
  const text = '进入章节时先定下难度，避免读到时已被清成 null';
  ledger.facts = [row('decision', text, 's1'), row('open', `${text}（待确认）`, 's2')];
  ledger.seq = 2;
  const result = selfcheck.mergeFacts(ledger, { apply: true });
  assert.strictEqual(result.retired, 0, `cross-kind merge happened: ${JSON.stringify(result.merged)}`);
  assert.strictEqual(ledger.facts.filter((f) => !f.validUntil).length, 2, 'both facts should stay live');
  return 'a decision and an open issue sharing wording both survive';
});

await check('the stale sweep only touches fast-decaying open items', async () => {
  // 900 days, so the *decision* really falls below the stale floor. At 400 days it
  // stays above (≈0.13) and the assertion would pass even with the sweep widened
  // to every kind — verified: that mutation went uncaught at 400 days.
  const old = Date.now() - 900 * 86400000;
  const ledger = {
    version: 1, seq: 2, topics: [],
    facts: [
      row('open', '很久以前的一个待确认问题', 's1', { createdAt: new Date(old).toISOString(), lastSeenAt: new Date(old).toISOString() }),
      row('decision', '很久以前定下的一条决定', 's2', { createdAt: new Date(old).toISOString(), lastSeenAt: new Date(old).toISOString() }),
    ],
  };
  // Precondition: the decision really is below the floor, or this proves nothing.
  assert.ok(facts.strengthOf(ledger.facts[1]) < selfcheck.STALE_FLOOR,
    `fixture decision scores ${facts.strengthOf(ledger.facts[1]).toFixed(3)}, not below the floor`);
  const result = selfcheck.pruneStaleFacts(ledger, { apply: true });
  assert.strictEqual(result.pruned, 1, `expected 1 prune, got ${result.pruned}`);
  const prunedOpen = ledger.facts.find((f) => f.kind === 'open');
  const keptDecision = ledger.facts.find((f) => f.kind === 'decision');
  assert.ok(prunedOpen.validUntil, 'the stale open item should be retired');
  assert.strictEqual(keptDecision.validUntil, null, 'a decision below the floor must still survive: only `open` is prunable');
  assert.strictEqual(ledger.facts.length, 2, 'no row may be removed');
  return 'stale open retired, equally stale decision kept, rows intact';
});

await check('skill redundancy is detected by measured similarity', async () => {
  const index = { version: 1, entries: {
    'git-commit-cjk-message-safety': { slug: 'git-commit-cjk-message-safety', description: '避免通过 heredoc 向 git commit -m 传递中文导致的字符损坏', steps: ['a'], pitfalls: [], sources: ['s1'] },
    'git-commit-message-cjk-encoding-safe': { slug: 'git-commit-message-cjk-encoding-safe', description: '避免 CJK 提交信息经 heredoc 传给 git commit -m 时被损坏，并检测与修正已损坏的历史提交', steps: ['a', 'b'], pitfalls: [], sources: ['s1', 's2'] },
    'unity-mobile-pinch-zoom-fix': { slug: 'unity-mobile-pinch-zoom-fix', description: '定位并修复 Unity 移动端双指缩放的死区丢帧与量程缺陷', steps: ['x'], pitfalls: [], sources: ['s3'] },
  } };
  const pairs = selfcheck.findRedundantSkills(index);
  assert.ok(pairs.length >= 1, 'the two git-commit skills should be flagged');
  const found = pairs.find((p) => p.keep === 'git-commit-message-cjk-encoding-safe' && p.drop === 'git-commit-cjk-message-safety');
  assert.ok(found, `expected the richer skill to survive; got ${JSON.stringify(pairs)}`);
  assert.ok(!pairs.some((p) => p.keep === 'unity-mobile-pinch-zoom-fix' || p.drop === 'unity-mobile-pinch-zoom-fix'), 'an unrelated skill was flagged');
  // The merge action must be reachable for a real duplicate. Without this, raising
  // SKILL_MERGE_THRESHOLD above every measured pair leaves `mergeSkills` as dead
  // code that always reports 'reported' — invisible to the other assertions.
  assert.ok(pairs.some((p) => p.mergeable), `no pair is mergeable, so the merge action is unreachable; pairs=${JSON.stringify(pairs)}`);
  assert.ok(found.mergeable, 'the measured duplicate pair should be mergeable, not merely reported');
  return `${pairs.length} pair flagged, richer skill kept, ${pairs.filter((p) => p.mergeable).length} mergeable`;
});

await check('catalog cost accounts for every skill description', async () => {
  const index = { version: 1, entries: {
    a: { slug: 'a', description: '12345' },
    b: { slug: 'b', description: '1234567890' },
  } };
  const cost = selfcheck.catalogCost(index);
  assert.strictEqual(cost.skills, 2);
  assert.strictEqual(cost.chars, 'a'.length + 5 + 'b'.length + 10);
  assert.ok(cost.tokens > 0);
  return `2 skills, ${cost.chars} chars, ~${cost.tokens} tokens per session`;
});

await check('only mergeable pairs are acted on, and only when asked', async () => {
  // The entries must actually exist: `mergeSkills` reports a pair naming a missing
  // entry as `missing-entry` rather than pretending it could be merged, so a
  // fixture with an empty index would test the wrong branch.
  const index = { version: 1, entries: {
    k: { slug: 'k', description: 'an existing skill', steps: [], pitfalls: [], sources: ['s1'] },
    d: { slug: 'd', description: 'a duplicate of it', steps: [], pitfalls: [], sources: ['s2'] },
  } };
  const pairs = [
    { score: 0.9, keep: 'k', drop: 'd', mergeable: true },
    { score: 0.42, keep: 'k', drop: 'd', mergeable: false },
  ];
  const outcomes = await selfcheck.mergeSkills(storeRoot, index, pairs, { apply: false });
  assert.strictEqual(outcomes[0].action, 'would-merge', `expected would-merge, got ${outcomes[0].action}`);
  assert.strictEqual(outcomes[1].action, 'reported', `expected reported, got ${outcomes[1].action}`);
  return 'mergeable → would-merge, weak → reported';
});

// ── 6. full selfCheck on a store ────────────────────────────────────────────
await check('selfCheck reports a plan and writes nothing when apply is false', async () => {
  const ledger = seedLedger();
  await facts.writeFacts(storeRoot, ledger);
  const marker = fs.statSync(path.join(storeRoot, 'facts.json')).mtimeMs;
  const report = await selfcheck.selfCheck(storeRoot, { apply: false });
  assert.strictEqual(report.applied, false);
  assert.ok(report.facts.duplicateGroups >= 1, `expected duplicate groups, got ${report.facts.duplicateGroups}`);
  assert.ok(report.facts.retiredDuplicates >= 1, 'a dry run must still count what it would retire');
  assert.strictEqual(report.facts.after.live, report.facts.before.live, 'a dry run changed the live count');
  const after = await facts.readFacts(storeRoot);
  assert.strictEqual(after.facts.filter((f) => !f.validUntil).length, ledger.facts.filter((f) => !f.validUntil).length, 'a dry run altered the store');
  return `${report.facts.duplicateGroups} groups to retire, store untouched`;
});

await check('selfCheck with apply retires duplicates and rebuilds topics', async () => {
  const beforeRows = (await facts.readFacts(storeRoot)).facts.length;
  const report = await selfcheck.selfCheck(storeRoot, { apply: true, purgeTrash: true });
  assert.strictEqual(report.applied, true);
  assert.ok(report.facts.retiredDuplicates >= 1, 'nothing was retired');
  assert.ok(report.facts.after.live < report.facts.before.live, 'the live count should drop');
  assert.ok(report.facts.after.invalidated > report.facts.before.invalidated, 'the retired rows should become invalidated, not vanish');
  assert.ok(typeof report.facts.topicsRebuilt === 'number', 'topics should be rebuilt after retiring facts');
  const after = await facts.readFacts(storeRoot);
  // The decisive invariant: nothing was deleted, and no rows were added or lost.
  assert.strictEqual(after.facts.length, beforeRows, `rows changed: ${beforeRows} → ${after.facts.length}`);
  const retired = after.facts.filter((f) => f.supersededReason === 'self-check duplicate');
  assert.ok(retired.length >= 1, 'no row carries the self-check supersede reason');
  return `${report.facts.before.live} → ${report.facts.after.live} live, ${after.facts.length} rows kept, ${report.facts.topicsRebuilt} topics`;
});

await check('selfCheck is idempotent on a real store', async () => {
  const second = await selfcheck.selfCheck(storeRoot, { apply: true });
  assert.strictEqual(second.facts.retiredDuplicates, 0, `second pass retired ${second.facts.retiredDuplicates} more`);
  assert.strictEqual(second.facts.after.live, second.facts.before.live, 'live count drifted on a second pass');
  return 'second pass retires nothing';
});

// ── 7. cleanup must refuse a partially-remembered session ───────────────────
await check('an incremental capture marks the entry partial', async () => {
  const { readState } = await load('lib/state.js');
  const state = await readState(storeRoot);
  const entry = state.digested[SID];
  assert.ok(entry, 'no digest entry for the incrementally captured session');
  assert.strictEqual(entry.live, true, 'the entry should be flagged live');
  assert.strictEqual(entry.partial, true, 'the entry should be flagged partial');
  return 'live=true, partial=true';
});

await check('cleanup refuses a session that is only partially remembered', async () => {
  const { cleanupSession } = digester;
  const refused = await cleanupSession({ storeRoot, sessionId: SID, sessionDir: dir, mode: 'logs' });
  assert.strictEqual(refused.ok, false, 'cleanup was allowed on a partially-captured session');
  assert.strictEqual(refused.code, 'PARTIAL_DIGEST', `expected PARTIAL_DIGEST, got ${refused.code}`);
  assert.ok(fs.existsSync(logFile), 'the running session log was deleted');
  return `refused with ${refused.code}, log intact`;
});

await check('inventory rows expose the partial flag to the panel', async () => {
  const { listLiveSessions, listArchivedSessions } = await load('lib/inventory.js');
  const { readState } = await load('lib/state.js');
  const state = await readState(storeRoot);
  const live = listLiveSessions(state).sessions.find((s) => s.sessionId === SID);
  assert.ok(live, 'the live session is missing from the listing');
  assert.strictEqual(live.partial, true, 'the live row should expose partial=true');
  // Cross-check the archived path too, so a session archived mid-capture keeps it.
  fs.writeFileSync(path.join(sandbox, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: [SID], pinnedSessionIds: [] },
  }, null, 2));
  const archived = listArchivedSessions(state).sessions.find((s) => s.sessionId === SID);
  assert.strictEqual(archived.partial, true, 'the archived row should expose partial=true');
  return 'both listings report partial=true';
});

await check('a full digest clears the partial flag and unblocks cleanup', async () => {
  // A full pass over the same session must be able to replace the partial entry.
  const { digestOne } = digester;
  const { readState } = await load('lib/state.js');
  const { ctx } = fakeCtx(REPLY);
  const result = await digestOne({
    ctx, sessionId: SID, sessionDir: dir, storeRoot,
    route: { provider: 'fake', model: 'm' },
    options: { extractSkills: false, cleanupMode: 'off' },
  });
  assert.ok(result.ok, `full digest failed: ${result.code} ${result.message}`);
  const state = await readState(storeRoot);
  // A full digest writes without the partial flag, so cleanup's guard passes.
  assert.notStrictEqual(state.digested[SID].partial, true, 'the partial flag survived a full digest');
  const { cleanupSession } = digester;
  const allowed = await cleanupSession({ storeRoot, sessionId: SID, sessionDir: dir, mode: 'logs' });
  assert.strictEqual(allowed.ok, true, `cleanup should now be allowed: ${allowed.code} ${allowed.message}`);
  return 'full digest replaced the partial entry; cleanup then permitted';
});

fs.rmSync(sandbox, { recursive: true, force: true });

const failed = results.filter((entry) => !entry.ok);
console.log('');
if (failed.length > 0) {
  console.log(`${failed.length} check(s) failed:`);
  for (const entry of failed) console.log(`  - ${entry.name}: ${entry.error}`);
} else {
  console.log(`all ${results.length} checks passed`);
}
process.exitCode = failed.length > 0 ? 1 : 0;
