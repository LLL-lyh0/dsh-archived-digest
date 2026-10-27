/**
 * End-to-end on a REAL live (unarchived) session.
 *
 * This is the test that answers "does the memory feature work on my current
 * conversation". The unit suites use synthetic events; this one picks an actual
 * log written by this machine, decodes it, distils it with a fake llm, and shows
 * exactly what lands in the fact ledger.
 *
 * Two things only this run can prove:
 *  1. A live session's on-disk log is complete enough to digest (the claim that
 *     no host hooks are needed).
 *  2. The settle rule selects the conversation that actually finished.
 *
 * It never writes to the real store: the plugin's store root is redirected to a
 * temp dir, and DSH_HOME is left alone so the logs read are the real ones.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(here, '..', rel)).href);

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-live-e2e-'));
process.env.DSH_ARCHIVED_DIGEST_SKILLS = path.join(sandbox, 'skills');

const { listLiveSessions, listArchivedSessions } = await load('lib/inventory.js');
const { readSessionSource, digestOne, needsDigest, LIVE_SETTLE_MS } = await load('lib/digester.js');
const facts = await load('lib/facts.js');
const consolidate = await load('lib/consolidate.js');

// ── pick a real settled live session with real content ─────────────────────
const live = listLiveSessions({});
const archived = listArchivedSessions({});
console.log(`live sessions on this machine: ${live.liveCount} (${(live.totalBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`archived sessions:             ${archived.archivedCount}`);
console.log(`overlap (must be 0):           ${live.sessions.filter((s) => archived.sessions.some((a) => a.sessionId === s.sessionId)).length}`);

const settled = needsDigest(live.sessions, {}, { live: true });
console.log(`settled & pending:             ${settled.length} of ${live.liveCount} (rest are still being written)\n`);

// Prefer a substantial one so the digest has something to chew on.
const target = settled.filter((s) => s.bytes > 20000).sort((a, b) => b.bytes - a.bytes)
  .find((s) => readSessionSource(s.dir).ok) ?? settled.find((s) => readSessionSource(s.dir).ok);
if (!target) {
  console.log('no settled live session decoded; nothing to prove here');
  await fs.rm(sandbox, { recursive: true, force: true });
  process.exit(0);
}

const quietFor = Math.round((Date.now() - target.mtimeMs) / 1000);
console.log(`target: ${target.sessionId}`);
console.log(`  ${(target.bytes / 1024).toFixed(0)} KB, quiet for ${quietFor}s (settle window ${LIVE_SETTLE_MS / 1000}s)`);

const pre = readSessionSource(target.dir);
if (!pre.ok) throw new Error(`preflight failed: ${pre.code}`);
console.log(`  decoded ${pre.events} events → ${pre.source.turns} turns, ${pre.source.chars} chars of transcript`);
console.log(`  title: ${JSON.stringify(pre.source.title)}`);
console.log('\n--- transcript tail ---');
console.log(pre.source.transcript.slice(-420));

// ── digest it with a fake llm ──────────────────────────────────────────────
const reply = JSON.stringify({
  title: pre.source.title || 'Live session',
  summary: 'A live, not-yet-archived conversation distilled straight from its on-disk log.',
  decisions: ['Live sessions are digested from the on-disk log, so no host hooks are needed'],
  facts: [
    { label: 'live log is current', value: 'a running session decodes to its last sentence' },
    { label: 'settle window', value: `${LIVE_SETTLE_MS / 1000}s of quiet before a live session is eligible` },
  ],
  openIssues: ['live capture is opt-in because it costs a model call per session'],
  tags: ['live', 'session-digest'],
  skills: [],
});

const llm = {
  listProviders: () => [{ id: 'fake', name: 'Fake', compat: { reasoningEffort: false } }],
  listModels: async () => [{ id: 'fake-model', reasoning: false }],
  stream: async function* () {
    yield { type: 'block', block: { type: 'text', text: reply } };
    yield { type: 'finish', finish: { kind: 'stop' } };
  },
};
const fakeCtx = { get: (name) => (name === 'llm' ? llm : undefined) };

const storeRoot = path.join(sandbox, 'store');
const out = await digestOne({
  ctx: fakeCtx,
  sessionId: target.sessionId,
  sessionDir: target.dir,
  storeRoot,
  route: {},
  options: { cleanupMode: 'off' },
});
console.log(`\ndigest: ok=${out.ok}${out.ok ? '' : ` code=${out.code} — ${out.message}`}`);
if (!out.ok) {
  await fs.rm(sandbox, { recursive: true, force: true });
  process.exit(1);
}

// ── facts → topics ─────────────────────────────────────────────────────────
const ingested = await consolidate.ingestDigestFacts(storeRoot, out.digest, target.sessionId);
console.log(`facts ingested: ${JSON.stringify(ingested.counts)}`);
const ledger = await facts.readFacts(storeRoot);
ledger.topics = consolidate.buildTopics(ledger);
await facts.writeFacts(storeRoot, ledger);
console.log(`ledger: ${ledger.facts.length} facts, ${ledger.topics.length} topics`);
for (const fact of ledger.facts) console.log(`  ${fact.id} [${fact.kind}] ${fact.text.slice(0, 72)}`);

console.log('\n--- recall("live 会话 日志") ---');
const hits = facts.searchFacts(ledger, 'live 会话 日志', { limit: 5 });
console.log(facts.renderFacts(hits, { heading: 'Recall' }) || '(no hits)');

// The live session's own log must be untouched: cleanup only ever sees archived
// sessions, and this one is not archived.
const stillThere = await fs.stat(target.logFile).then(() => true, () => false);
console.log(`\n=== live session log untouched: ${stillThere} (cleanup is archived-only) ===`);

await fs.rm(sandbox, { recursive: true, force: true });
