/**
 * Probe: what actually accumulates after long use?
 *
 * The self-check (自检精简) exists to stop accumulated memory from interfering
 * with the model. Before writing prune rules, measure the store, because the
 * interference is not uniform:
 *  - every skill's name+description is injected into EVERY session's system
 *    prompt, so duplicate skills cost tokens on every turn forever;
 *  - facts and topics are only read on retrieval, so their cost is noise in
 *    results rather than a permanent tax.
 * Prints the real distribution so the rules target whatever is actually large.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { paths, readMemoryIndex, readSkillIndex } from '../lib/memory-store.js';
import { readFacts, similarity, strengthOf, factStats } from '../lib/facts.js';

const root = paths('').root;
console.log('store:', root);

const facts = await readFacts(root);
const memories = await readMemoryIndex(root);
const skills = await readSkillIndex(root);
console.log('memories:', Object.keys(memories.entries).length, '| skills:', Object.keys(skills.entries).length);
console.log('stats:', JSON.stringify(factStats(facts)));

// ── skills: the permanent tax ────────────────────────────────────────────────
const skillList = Object.entries(skills.entries).map(([slug, entry]) => ({ slug, ...entry }));
let descChars = 0;
for (const skill of skillList) descChars += String(skill.description ?? '').length + String(skill.slug).length;
console.log(`\nskill catalog injection: ${descChars} chars every session (${(descChars / 3.5).toFixed(0)} tokens/turn)`);

const pairs = [];
for (let i = 0; i < skillList.length; i += 1) {
  for (let j = i + 1; j < skillList.length; j += 1) {
    const a = `${skillList[i].slug} ${skillList[i].description ?? ''}`;
    const b = `${skillList[j].slug} ${skillList[j].description ?? ''}`;
    const score = similarity(a, b);
    if (score >= 0.4) pairs.push({ a: skillList[i].slug, b: skillList[j].slug, score });
  }
}
pairs.sort((x, y) => y.score - x.score);
console.log('near-duplicate skill pairs (>=0.4):', pairs.length);
for (const pair of pairs.slice(0, 12)) console.log(`  ${pair.score.toFixed(3)}  ${pair.a}  ~  ${pair.b}`);

// ── facts: noise on retrieval ────────────────────────────────────────────────
const live = facts.facts.filter((fact) => !fact.validUntil);
const invalid = facts.facts.filter((fact) => fact.validUntil);
console.log(`\nfacts: ${live.length} live / ${invalid.length} invalidated / ${facts.topics.length} topics`);
const now = Date.now();
const weak = live.filter((fact) => strengthOf(fact, now) < 0.15);
const orphan = live.filter((fact) => (fact.sources ?? []).length <= 1);
console.log('weak (strength<0.15):', weak.length, '| single-source:', orphan.length);
const kinds = {};
for (const fact of live) kinds[fact.kind] = (kinds[fact.kind] ?? 0) + 1;
console.log('by kind:', JSON.stringify(kinds));

// Near-duplicate live facts that the merge threshold missed.
let dupes = 0;
const flagged = [];
for (let i = 0; i < live.length; i += 1) {
  for (let j = i + 1; j < live.length; j += 1) {
    const score = similarity(live[i].text, live[j].text);
    if (score >= 0.5) { dupes += 1; if (flagged.length < 8) flagged.push({ score, a: live[i].text.slice(0, 42), b: live[j].text.slice(0, 42) }); }
  }
}
console.log('near-duplicate LIVE fact pairs (>=0.5):', dupes, dupes > 0 ? '(these should have merged)' : '(none — merging is working)');
for (const pair of flagged) console.log(`  ${pair.score.toFixed(3)}  ${pair.a}\n           ${pair.b}`);

// ── memories ────────────────────────────────────────────────────────────────
const memoryList = Object.values(memories.entries);
const totalChars = memoryList.reduce((sum, entry) => sum + (entry.chars ?? 0), 0);
console.log(`\nmemories: ${totalChars} chars total, largest ${Math.max(0, ...memoryList.map((m) => m.chars ?? 0))}`);
const empty = memoryList.filter((entry) => (entry.summary ?? '').length < 10);
console.log('memories with a near-empty summary:', empty.length);

const dirBytes = async (dir) => {
  let total = 0;
  try {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      total += item.isDirectory() ? await dirBytes(full) : (await fs.stat(full)).size;
    }
  } catch { /* absent */ }
  return total;
};
console.log('\nstore size:', ((await dirBytes(root)) / 1024).toFixed(0), 'KB');
