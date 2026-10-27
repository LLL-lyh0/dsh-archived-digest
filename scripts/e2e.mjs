/**
 * End-to-end: take a genuinely archived session on this machine, decode it,
 * distill it with a fake llm, and show exactly what lands on disk.
 *
 * This is the one test that proves the whole path works on real data — the unit
 * suites use synthetic events, so they cannot catch a decoder that works on
 * hand-built JSON but not on what the harness actually wrote.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-e2e-'));
process.env.DSH_ARCHIVED_DIGEST_SKILLS = path.join(sandbox, 'skills');

const { listArchivedSessions } = await load('lib/inventory.js');
const { readSessionSource, digestOne } = await load('lib/digester.js');
const facts = await load('lib/facts.js');
const consolidate = await load('lib/consolidate.js');

const all = listArchivedSessions({}).sessions;
const target = all.filter((s) => s.present && s.bytes > 400000).sort((a, b) => b.bytes - a.bytes)[0];
if (!target) throw new Error('no archived session to test with');
console.log(`target: ${target.sessionId}  ${(target.bytes / 1024 / 1024).toFixed(1)} MB`);

const pre = readSessionSource(target.dir);
if (!pre.ok) throw new Error(`preflight failed: ${pre.code} — ${pre.message}`);
const src = pre.source;
console.log(`events: ${pre.events}  turns: ${src.turns}  kept: ${src.keptTurns}  transcript: ${src.chars} chars`);
console.log(`title: ${JSON.stringify(src.title)}`);
console.log(`tools touched: ${src.toolNames.slice(0, 6).join(', ')}`);
console.log('\n--- transcript head ---');
console.log(src.transcript.slice(0, 600));
console.log('\n--- transcript tail ---');
console.log(src.transcript.slice(-400));

const reply = JSON.stringify({
  title: 'StarGate implementation survey',
  summary: 'Mapped every layer that touches the StarGate module id and traced the build-order distance rule.',
  decisions: [
    { decision: 'Keep the 100-unit build range check on live ship position', why: 'positions mid-flight were being read from the order target instead' },
  ],
  facts: [
    { label: 'StarGateModuleId', value: '420 (SVManager.cs:1463)' },
    { label: 'log format', value: 'multi-frame zstd, split on 28 b5 2f fd' },
  ],
  openIssues: ['Build-range fix still needs a manual Unity editor pass'],
  tags: ['unity', 'stargate', 'session-digest'],
  skills: [{
    name: 'decode-multiframe-zstd',
    title: 'Decode multi-frame zstd session logs',
    description: 'Split the buffer on the zstd magic bytes before decompressing, or you only get the first frame.',
    whenToUse: 'when a .jsonl.zstd session log decodes to a single metadata line',
    steps: ['Read the whole file as a Buffer.', 'Find every 0x28 0xB5 0x2F 0xFD offset.', 'Decompress each slice and join the results.'],
    pitfalls: ['zstdDecompressSync and the streaming decoder both stop at the first frame and report success.'],
    verification: ['The joined text parses as JSONL with more than one line.'],
  }],
});

const llm = {
  // Registration order matters here: the real service lists providers the way
  // they were added, and routeCandidates has to cope with an unusable first one.
  listProviders: () => [{ id: 'fake', name: 'Fake', compat: { reasoningEffort: false } }],
  listModels: async () => [{ id: 'fake-model', reasoning: false }],
  stream: async function* () {
    yield { type: 'block', block: { type: 'text', text: reply } };
    yield { type: 'finish', finish: { kind: 'stop' } };
  },
};
const fakeCtx = { get: (name) => (name === 'llm' ? llm : undefined) };

const out = await digestOne({
  ctx: fakeCtx,
  sessionId: target.sessionId,
  sessionDir: target.dir,
  storeRoot: path.join(sandbox, 'store'),
  route: {},
  options: { cleanupMode: 'off' },
});
console.log(`\ndigest: ok=${out.ok}${out.ok ? '' : ` code=${out.code} — ${out.message}`}`);
if (!out.ok) {
  await fs.rm(sandbox, { recursive: true, force: true });
  process.exitCode = 1;
} else {
  console.log(`skill slugs: ${out.skills.join(', ')}`);
  console.log('\n=== memory on disk ===');
  const memFile = out.memoryFile;
  console.log(await fs.readFile(memFile, 'utf8'));
  console.log('=== published SKILL.md ===');
  const skillFile = path.join(sandbox, 'skills', out.skills[0], 'SKILL.md');
  console.log(await fs.readFile(skillFile, 'utf8'));

  // ── memory layer: facts → topics ──────────────────────────────────────────
  const storeRoot = path.join(sandbox, 'store');
  console.log('=== fact ledger (merged, not appended) ===');
  const ingested = await consolidate.ingestDigestFacts(storeRoot, out.digest, target.sessionId);
  console.log(`applied ${ingested.applied} facts → ${JSON.stringify(ingested.counts)}`);

  // Re-ingest the same digest as a second session would: this must merge.
  const again = await consolidate.ingestDigestFacts(storeRoot, out.digest, 'session-second-pass');
  console.log(`re-ingest → ${JSON.stringify(again.counts)}`);

  const ledger = await facts.readFacts(storeRoot);
  ledger.topics = consolidate.buildTopics(ledger);
  await facts.writeFacts(storeRoot, ledger);
  console.log(`\nledger: ${ledger.facts.length} rows (${ledger.facts.filter((f) => !f.validUntil).length} live), ${ledger.topics.length} topics`);
  for (const fact of ledger.facts) {
    console.log(`  ${fact.id} [${fact.kind}] ${fact.text.slice(0, 70)}${fact.validUntil ? '  (superseded)' : ''}`);
  }

  console.log('\n=== consolidated topics ===');
  for (const topic of ledger.topics) console.log(`${topic.body}\n`);

  console.log('=== recall("magic 切帧") ===');
  const hits = facts.searchFacts(ledger, 'magic 切帧', { limit: 5 });
  console.log(facts.renderFacts(hits, { heading: 'Recall' }) || '(no hits)');

  // The archived log must still be untouched: cleanup is off by default.
  const logInode = await fs.stat(target.dir).catch(() => null);
  console.log(`\n=== original log still present: ${logInode !== null} (cleanupMode=off) ===`);
  await fs.rm(sandbox, { recursive: true, force: true });
}
