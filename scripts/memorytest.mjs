/**
 * Memory-layer tests: facts, merging, decay, topics, retrieval, export.
 *
 * The three properties that make this layer worth having, each pinned here:
 *  1. A restatement **updates** the fact instead of duplicating it (mem0's
 *     ADD/UPDATE/DELETE, https://github.com/mem0ai/mem0).
 *  2. A superseded fact keeps `validUntil` instead of vanishing, so history stays
 *     answerable (Zep's temporal edges, https://arxiv.org/abs/2501.13956).
 *  3. Consolidation is idempotent: topics are a pure function of the facts, so
 *     running it twice must not create a second copy of anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(here, '..', rel)).href);

const facts = await load('lib/facts.js');
const consolidate = await load('lib/consolidate.js');
const backends = await load('lib/backends.js');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log(`  FAIL ${name} — ${error?.message ?? error}`);
  }
}

// Scratch DSH_HOME so nothing touches the real store.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-memory-'));
process.env.DSH_HOME = sandbox;
process.env.DSH_ARCHIVED_DIGEST_SKILLS = path.join(sandbox, 'skills');
const storeRoot = path.join(sandbox, 'store');

// ── similarity calibration ──────────────────────────────────────────────────
await check('restatements score above the merge threshold', () => {
  const pairs = [
    ['多帧 zstd 日志要先按 magic 切帧再解压', '多帧 zstd 日志需要按 magic bytes 切帧'],
    ['面板语言按 documentElement.lang 现读', '面板语言应该读 documentElement.lang 而不是缓存'],
    ['the panel reads html lang at call time', 'panel should read html lang on each use'],
  ];
  let worst = 1;
  for (const [a, b] of pairs) {
    const score = facts.similarity(a, b);
    worst = Math.min(worst, score);
    assert.ok(score >= facts.MERGE_THRESHOLD, `"${a.slice(0, 20)}" vs "${b.slice(0, 20)}" scored ${score.toFixed(3)} < ${facts.MERGE_THRESHOLD}`);
  }
  return `worst restatement ${worst.toFixed(3)} ≥ ${facts.MERGE_THRESHOLD}`;
});

await check('unrelated statements score below the merge threshold', () => {
  const pairs = [
    ['多帧 zstd 日志要先按 magic 切帧', '面板语言要现读不能缓存'],
    ['the panel reads html lang at call time', 'skills must be mirrored to DSH_HOME'],
    ['StarGateModuleId is 420', 'the build range check uses live ship position'],
  ];
  let worst = 0;
  for (const [a, b] of pairs) {
    const score = facts.similarity(a, b);
    worst = Math.max(worst, score);
    assert.ok(score < facts.MERGE_THRESHOLD, `"${a.slice(0, 20)}" vs "${b.slice(0, 20)}" scored ${score.toFixed(3)}`);
  }
  return `worst unrelated ${worst.toFixed(3)} < ${facts.MERGE_THRESHOLD}`;
});

// ── the write pipeline ──────────────────────────────────────────────────────
await check('ADD / UPDATE / NOOP are chosen correctly', () => {
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  const ops = [];
  ops.push(facts.applyWrite(ledger, { kind: 'fact', text: '多帧 zstd 日志要先按 magic 切帧再解压', source: 'a' }).op);
  // A restatement with more detail must UPDATE, not append.
  ops.push(facts.applyWrite(ledger, { kind: 'fact', text: '多帧 zstd 日志需要按 magic bytes 切帧', source: 'b' }).op);
  // The exact same sentence again must NOOP and refresh.
  ops.push(facts.applyWrite(ledger, { kind: 'fact', text: '多帧 zstd 日志需要按 magic bytes 切帧', source: 'c' }).op);
  // A different subject must ADD.
  ops.push(facts.applyWrite(ledger, { kind: 'decision', text: '面板语言按 documentElement.lang 现读', source: 'd' }).op);
  assert.deepStrictEqual(ops, ['ADD', 'UPDATE', 'NOOP', 'ADD'], `got ${ops.join(',')}`);
  assert.strictEqual(ledger.facts.filter((f) => !f.validUntil).length, 2, 'expected two live facts');
  return ops.join(' → ');
});

await check('a superseded fact keeps validUntil instead of vanishing', () => {
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  facts.applyWrite(ledger, { kind: 'fact', text: '配置要写到 state.json 而不是 settings.json', source: 'a' });
  facts.applyWrite(ledger, { kind: 'fact', text: '配置应该写进 state.json，settings.json 不放配置', source: 'b' });
  assert.strictEqual(ledger.facts.length, 2, 'the old row must survive as history');
  const [old, next] = ledger.facts;
  assert.ok(old.validUntil, 'old fact must carry validUntil');
  assert.strictEqual(old.supersededBy, next.id, 'old fact must point at its replacement');
  assert.strictEqual(old.text, '配置要写到 state.json 而不是 settings.json', 'old wording must be preserved verbatim');
  return `old.validUntil=${String(old.validUntil).slice(0, 10)}, supersededBy=${old.supersededBy}`;
});

await check('corroboration keeps a fact warm and counts its sources', () => {
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  facts.applyWrite(ledger, { kind: 'fact', text: '技能要镜像到 DSH_HOME/skills 才对 agent 可见', source: 'a' });
  facts.applyWrite(ledger, { kind: 'fact', text: '技能要镜像到 DSH_HOME/skills 才对 agent 可见', source: 'b' });
  const fact = ledger.facts[0];
  assert.deepStrictEqual(fact.sources.sort(), ['a', 'b'], `sources=${JSON.stringify(fact.sources)}`);
  assert.ok(fact.hits >= 2, `hits=${fact.hits}`);
  return `sources=${fact.sources.length}, hits=${fact.hits}`;
});

await check('decay ranks an old open issue below a fresh one', () => {
  const day = 86400000;
  const now = Date.UTC(2026, 9, 26);
  const old = { kind: 'open', createdAt: new Date(now - 200 * day).toISOString(), lastSeenAt: new Date(now - 200 * day).toISOString(), sources: ['a'], hits: 1 };
  const fresh = { kind: 'open', createdAt: new Date(now - day).toISOString(), lastSeenAt: new Date(now - day).toISOString(), sources: ['a'], hits: 1 };
  const oldScore = facts.strengthOf(old, now);
  const freshScore = facts.strengthOf(fresh, now);
  assert.ok(freshScore > oldScore + 0.3, `fresh=${freshScore.toFixed(3)} old=${oldScore.toFixed(3)}`);
  return `fresh=${freshScore.toFixed(3)} vs 200d-old=${oldScore.toFixed(3)}`;
});

await check('a preference outlives an open issue of the same age', () => {
  const day = 86400000;
  const now = Date.UTC(2026, 9, 26);
  const at = new Date(now - 90 * day).toISOString();
  const base = { createdAt: at, lastSeenAt: at, sources: ['a'], hits: 1 };
  const pref = facts.strengthOf({ ...base, kind: 'preference' }, now);
  const open = facts.strengthOf({ ...base, kind: 'open' }, now);
  assert.ok(pref > open, `preference=${pref.toFixed(3)} open=${open.toFixed(3)}`);
  return `preference=${pref.toFixed(3)} > open=${open.toFixed(3)}`;
});

await check('invalidated facts score zero and drop out of search', () => {
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  facts.applyWrite(ledger, { kind: 'fact', text: '旧结论：日志只有一帧', source: 'a' });
  facts.applyWrite(ledger, { kind: 'fact', text: '新结论：日志有多帧，要逐帧解压', source: 'b' });
  const hits = facts.searchFacts(ledger, '日志', {});
  assert.ok(hits.every((entry) => !entry.fact.validUntil), 'an invalidated fact surfaced in search');
  const all = facts.searchFacts(ledger, '日志', { includeInvalid: true });
  assert.ok(all.some((entry) => entry.fact.validUntil), 'includeInvalid must still see history');
  return `${hits.length} live / ${all.length} with history`;
});

// ── forgetting is explicit only ─────────────────────────────────────────────
await check('forget removes by id, and nothing else deletes rows', () => {
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  facts.applyWrite(ledger, { kind: 'fact', text: '这条要被删掉', source: 'a' });
  facts.applyWrite(ledger, { kind: 'fact', text: '这条要保留下来', source: 'b' });
  const target = ledger.facts[0];
  const removed = facts.forgetFact(ledger, { id: target.id });
  assert.strictEqual(removed.removed, 1, `removed=${removed.removed}`);
  assert.strictEqual(ledger.facts.length, 1, 'wrong survivor count');
  assert.ok(ledger.facts[0].text.includes('保留'), 'the wrong fact was removed');
  return `removed ${target.id}`;
});

// ── retrieval relevance gate ───────────────────────────────────────────────
await check('an unrelated query returns nothing, not everything', () => {
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  facts.applyWrite(ledger, { kind: 'fact', text: 'StarGateModuleId: 420 (SVManager.cs:1463)', source: 'a' });
  facts.applyWrite(ledger, { kind: 'fact', text: 'log format: multi-frame zstd, split on 28 b5 2f fd', source: 'b' });
  facts.applyWrite(ledger, { kind: 'open', text: 'Build-range fix still needs a manual Unity editor pass', source: 'c' });
  // Strength alone lifted unrelated facts over the score floor, so a query with
  // zero real hits used to return the entire ledger ordered by freshness.
  const unrelated = facts.searchFacts(ledger, '完全不相干的话题', {});
  assert.strictEqual(unrelated.length, 0, `unrelated query returned ${unrelated.length} facts`);
  const matched = facts.searchFacts(ledger, 'zstd log format', {});
  assert.strictEqual(matched.length, 1, `expected exactly the zstd fact, got ${matched.length}`);
  assert.ok(matched[0].fact.text.includes('zstd'), 'wrong fact matched');
  return '0 for unrelated, 1 for the real hit';
});

await check('a Chinese query matches a Chinese fact', () => {
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  facts.applyWrite(ledger, { kind: 'pitfall', text: '清理前 state 没写盘会被 NOT_DIGESTED 拒', source: 'a' });
  facts.applyWrite(ledger, { kind: 'fact', text: '技能要镜像到 DSH_HOME/skills 才对 agent 可见', source: 'b' });
  const hits = facts.searchFacts(ledger, '清理 state 落盘', {});
  assert.ok(hits.length >= 1, 'Chinese query matched nothing');
  assert.ok(hits[0].fact.text.includes('state'), `wrong top hit: ${hits[0].fact.text}`);
  return `${hits.length} hit(s), top = ${hits[0].fact.text.slice(0, 24)}`;
});

// ── topic consolidation ────────────────────────────────────────────────────
function seedLedger() {
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  const seed = [
    // Same subject, DIFFERENT facts. Measured similarity sits in the
    // cluster-but-don't-merge band (0.3–0.5): they must group into one topic
    // while staying two separate facts.
    { kind: 'pitfall', text: 'cleanup 前必须先把 state 落盘', source: 's1' },
    { kind: 'pitfall', text: '清理前 state 没写盘会被 NOT_DIGESTED 拒', source: 's2' },
    // Unrelated subjects.
    { kind: 'decision', text: '面板语言按 documentElement.lang 现读，不用缓存', source: 's3' },
    { kind: 'fact', text: '技能要镜像到 DSH_HOME/skills 才对 agent 可见', source: 's4' },
  ];
  for (const item of seed) facts.applyWrite(ledger, item);
  return ledger;
}

await check('facts sharing a subject cluster into one topic', () => {
  const ledger = seedLedger();
  // Precondition: the pair must NOT have merged, or there is nothing to cluster.
  assert.strictEqual(ledger.facts.filter((f) => !f.validUntil).length, 4, 'fixture facts merged unexpectedly; the cluster pair must stay distinct');
  const topics = consolidate.buildTopics(ledger);
  const grouped = topics.find((topic) => topic.factIds.length >= 2);
  assert.ok(grouped, `no multi-fact topic; sizes=${topics.map((t) => t.factIds.length).join(',')}`);
  assert.ok(grouped.body.includes('state'), 'topic body lost the shared subject');
  return `${topics.length} topics, largest has ${grouped.factIds.length} facts`;
});

await check('facts with the same subject group even with no shared wording', () => {
  // The cross-session case that pure similarity cannot solve: one session calls it
  // 「碰撞体穿透」, another 「ShipHullCollision 扫掠」. Measured character overlap
  // between these two is far below any threshold, yet they are one subject.
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  const subject = '定位并修复飞船相撞穿透';
  facts.applyWrite(ledger, { kind: 'pitfall', text: '高速穿透要在船体外壳做 sweep test 兜底', source: 's1', topic: subject });
  facts.applyWrite(ledger, { kind: 'decision', text: '碰撞检测改用逐帧位移预测而不是离散点测', source: 's2', topic: subject });
  const a = ledger.facts[0].text;
  const b = ledger.facts[1].text;
  const overlap = facts.similarity(a, b);
  assert.ok(overlap < facts.MERGE_THRESHOLD, `fixture facts are too similar (${overlap.toFixed(3)}); they must stay distinct`);
  const topics = consolidate.buildTopics(ledger);
  assert.strictEqual(topics.length, 1, `expected one topic, got ${topics.length}`);
  assert.strictEqual(topics[0].factIds.length, 2);
  assert.strictEqual(topics[0].label, subject);
  return `overlap ${overlap.toFixed(3)} but grouped as "${topics[0].label}"`;
});

await check('a subject resolver groups facts written before subjects existed', () => {
  // Older ledgers have facts with no `topic`. `subjectOf` is what lets them
  // aggregate instead of staying 127-singleton fragmented forever.
  const ledger = { version: 1, seq: 0, facts: [], topics: [] };
  facts.applyWrite(ledger, { kind: 'fact', text: 'alpha one', source: 's1' });
  facts.applyWrite(ledger, { kind: 'fact', text: 'bravo two', source: 's2' });
  facts.applyWrite(ledger, { kind: 'fact', text: 'charlie three', source: 's3' });
  assert.strictEqual(facts.similarity('alpha one', 'bravo two') < facts.MERGE_THRESHOLD, true);
  const subjectOf = (fact) => (fact.sources?.includes('s1') || fact.sources?.includes('s2') ? 'shared subject' : '');
  const topics = consolidate.buildTopics(ledger, { subjectOf });
  const grouped = topics.find((topic) => topic.factIds.length === 2);
  assert.ok(grouped, `no grouped topic; sizes=${topics.map((t) => t.factIds.length).join(',')}`);
  assert.strictEqual(grouped.label, 'shared subject');
  return `${topics.length} topics, one holds ${grouped.factIds.length} facts by resolved subject`;
});

await check('factsFromDigest stamps the digest title as the subject', () => {
  const rows = consolidate.factsFromDigest({ title: '分析 Watt/302', decisions: ['用 hosts 劫持'], facts: [{ label: '签名', value: '自签根证书' }] }, 's9');
  assert.ok(rows.length >= 2, 'fixture produced too few facts');
  for (const row of rows) {
    assert.strictEqual(row.topic, '分析 Watt/302', `fact lost its subject: ${JSON.stringify(row.topic)}`);
    assert.strictEqual(row.source, 's9');
  }
  const untitled = consolidate.factsFromDigest({ decisions: ['no title here'] }, 's10');
  assert.strictEqual(untitled[0].topic, undefined, 'an untitled digest must not invent a subject');
  return `${rows.length} facts carry the digest title as subject`;
});

await check('every topic bullet cites the fact id it came from', () => {
  const ledger = seedLedger();
  const topics = consolidate.buildTopics(ledger);
  let bullets = 0;
  for (const topic of topics) {
    for (const line of topic.body.split('\n')) {
      if (!line.startsWith('- [') || line.includes('…')) continue;
      const match = /\^f\d{5}/.exec(line);
      assert.ok(match, `bullet without a fact id: ${line.slice(0, 60)}`);
      const id = match[0].slice(1);
      assert.ok(ledger.facts.some((fact) => fact.id === id), `cited id ${id} does not exist`);
      bullets += 1;
    }
  }
  assert.ok(bullets >= 4, `only ${bullets} bullets`);
  return `${bullets} traceable bullets`;
});

await check('consolidation is idempotent and keeps topic ids stable', () => {
  const ledger = seedLedger();
  const first = consolidate.buildTopics(ledger);
  ledger.topics = first;
  const second = consolidate.buildTopics(ledger);
  assert.strictEqual(second.length, first.length, `topic count drifted ${first.length} → ${second.length}`);
  assert.deepStrictEqual(second.map((t) => t.id), first.map((t) => t.id), 'topic ids changed between runs');
  for (let i = 0; i < first.length; i += 1) {
    assert.strictEqual(second[i].body, first[i].body, `topic ${first[i].id} body changed between identical runs`);
    assert.strictEqual(second[i].createdAt, first[i].createdAt, `topic ${first[i].id} createdAt changed`);
  }
  return `${first.length} topics, ids and bodies stable`;
});

await check('pruneTopics drops a topic whose facts were all superseded', () => {
  const ledger = seedLedger();
  ledger.topics = consolidate.buildTopics(ledger);
  const before = ledger.topics.length;
  for (const fact of ledger.facts) fact.validUntil = new Date().toISOString();
  const pruned = consolidate.pruneTopics(ledger);
  assert.strictEqual(ledger.topics.length, 0, 'empty topics survived pruning');
  return `${before} → 0 topics, removed ${pruned.removed}`;
});

await check('digest arrays become fact rows without a second model call', () => {
  const rows = consolidate.factsFromDigest({
    decisions: ['chose the multi-frame decoder'],
    facts: [{ label: 'StarGateModuleId', value: '420 (SVManager.cs:1463)' }, 'plain string fact'],
    openIssues: ['build-range fix needs a manual pass'],
    tags: ['unity'],
  }, 'session-x');
  const kinds = rows.map((row) => row.kind);
  assert.deepStrictEqual(kinds.sort(), ['decision', 'fact', 'fact', 'open'], `kinds=${kinds.join(',')}`);
  const labelled = rows.find((row) => row.text.includes('StarGateModuleId'));
  assert.ok(labelled.text.includes('420'), 'label/value pair lost its value');
  assert.ok(rows.every((row) => row.source === 'session-x'), 'source not propagated');
  return `${rows.length} facts`;
});

await check('a digest round-trips into the ledger (end to end)', async () => {
  const fresh = fs.mkdtempSync(path.join(sandbox, 'e2e-'));
  const digest = {
    decisions: ['Use the multi-frame decoder'],
    facts: [{ label: 'frame magic', value: '28 b5 2f fd' }],
    openIssues: ['verify against a 63 MB session'],
    tags: ['zstd'],
  };
  const first = await consolidate.ingestDigestFacts(fresh, digest, 'session-one');
  // Same knowledge, second session: must merge, not duplicate.
  const second = await consolidate.ingestDigestFacts(fresh, digest, 'session-two');
  assert.strictEqual(first.counts.ADD, 3, `first ingest ADD=${first.counts.ADD}`);
  assert.ok((second.counts.NOOP ?? 0) + (second.counts.UPDATE ?? 0) === 3, `second ingest counts=${JSON.stringify(second.counts)}`);
  const ledger = await facts.readFacts(fresh);
  assert.strictEqual(ledger.facts.length, 3, `duplicated facts: ${ledger.facts.length}`);
  assert.ok(ledger.facts.every((fact) => fact.sources.length === 2), 'sources did not accumulate');
  return `3 facts, each from 2 sessions`;
});

await check('recall finds a topic and its facts by free text', async () => {
  const fresh = fs.mkdtempSync(path.join(sandbox, 'recall-'));
  const digest = {
    decisions: ['面板语言按 documentElement.lang 现读，不用缓存'],
    facts: ['zstd 日志是多帧，要按 magic 切帧'],
    openIssues: [],
  };
  await consolidate.ingestDigestFacts(fresh, digest, 'session-a');
  const ledger = await facts.readFacts(fresh);
  ledger.topics = consolidate.buildTopics(ledger);
  await facts.writeFacts(fresh, ledger);

  const zh = consolidate.findTopics(ledger, '面板语言', {});
  assert.ok(zh.length >= 1, 'Chinese query matched no topic');
  const search = facts.searchFacts(ledger, 'zstd magic', {});
  assert.ok(search.length >= 1, 'latin query matched no fact');
  return `${zh.length} topic / ${search.length} fact hits`;
});

// ── backends ───────────────────────────────────────────────────────────────
await check('backend detection reports nothing when no memory plugin is mounted', () => {
  const detected = backends.detectBackends({ get: () => undefined });
  assert.deepStrictEqual(detected, [], `unexpected backends: ${JSON.stringify(detected)}`);
  return 'local store is the only sink';
});

await check('backend detection finds OpenViking when its service is provided', () => {
  const detected = backends.detectBackends({ get: (name) => (name === 'openvikingMemory' ? { fake: true } : undefined) });
  assert.strictEqual(detected.length, 1, `detected=${JSON.stringify(detected)}`);
  assert.strictEqual(detected[0].id, 'openviking');
  return detected[0].note;
});

await check('exporting to a missing OpenViking service reports why, without throwing', async () => {
  const ledger = seedLedger();
  ledger.topics = consolidate.buildTopics(ledger);
  const result = await backends.exportToBackend({ get: () => undefined }, 'openviking', ledger);
  assert.strictEqual(result.ok, false, 'export claimed success with no service');
  assert.strictEqual(result.code, 'NOT_MOUNTED', `code=${result.code}`);
  return result.message;
});

await check('exporting to OpenViking says it has no document-write API', async () => {
  const ledger = seedLedger();
  ledger.topics = consolidate.buildTopics(ledger);
  const result = await backends.exportToBackend({ get: () => ({ runtime: true }) }, 'openviking', ledger);
  assert.strictEqual(result.ok, false, 'export claimed success without a write API');
  assert.strictEqual(result.code, 'NO_WRITE_API', `code=${result.code}`);
  return result.message.slice(0, 60);
});

await check('the export document carries topics, not raw session prose', () => {
  const ledger = seedLedger();
  ledger.topics = consolidate.buildTopics(ledger);
  const document = backends.buildExportDocument(ledger);
  assert.ok(document.includes('###'), 'no topic headings');
  assert.ok(document.includes('^f'), 'no fact citations');
  assert.ok(document.length <= 8000, `document too large: ${document.length}`);
  return `${document.length} chars, ${(document.match(/^### /gm) ?? []).length} topics`;
});

await check('exportAll never throws when no backend is mounted', async () => {
  const ledger = seedLedger();
  const result = await backends.exportAll({ get: () => undefined }, storeRoot, { ledger });
  assert.strictEqual(result.ok, true, 'exportAll failed with no backends');
  assert.strictEqual(result.backends.length, 0, 'phantom backend');
  return result.note;
});

// ── summary ────────────────────────────────────────────────────────────────
const failed = results.filter((entry) => !entry.ok);
console.log('');
if (failed.length > 0) {
  console.log(`${failed.length} check(s) failed:`);
  for (const entry of failed) console.log(`  - ${entry.name}: ${entry.error}`);
} else {
  console.log(`all ${results.length} checks passed`);
}
fs.rmSync(sandbox, { recursive: true, force: true });
process.exitCode = failed.length > 0 ? 1 : 0;
