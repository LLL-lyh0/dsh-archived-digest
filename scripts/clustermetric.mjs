/**
 * Measure topic clustering on a real (or synthetic) fact ledger.
 *
 *   node scripts/clustermetric.mjs [facts.json]
 *
 * Prints the cluster-size distribution. This exists because the first
 * implementation compared each candidate fact against the concatenation of a
 * cluster's members, which made a topic harder to join the bigger it got: on the
 * real ledger 127 of 156 topics held exactly one fact. A metric that can be run
 * on the live file is the only way to tell "aggregating" from "not aggregating".
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { clusterFacts } from '../lib/consolidate.js';

const file = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'archived-digest', 'facts.json');
const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
const live = ledger.facts.filter((fact) => !fact.validUntil);
const clusters = clusterFacts(ledger.facts);

const dist = {};
for (const cluster of clusters) {
  const n = cluster.facts.length;
  dist[n] = (dist[n] ?? 0) + 1;
}
const sizes = clusters.map((c) => c.facts.length).sort((a, b) => b - a);
const members = clusters.reduce((sum, c) => sum + c.facts.length, 0);
const grouped = clusters.filter((c) => c.facts.length > 1).reduce((sum, c) => sum + c.facts.length, 0);

console.log(`ledger        : ${file}`);
console.log(`live facts    : ${live.length}`);
console.log(`topics        : ${clusters.length}`);
console.log(`distribution  : ${JSON.stringify(dist)}`);
console.log(`largest topics: ${sizes.slice(0, 8).join(', ')}`);
console.log(`facts grouped : ${grouped}/${members} (${(grouped / Math.max(1, members) * 100).toFixed(0)}% live in a multi-fact topic)`);
for (const c of clusters.slice().sort((a, b) => b.facts.length - a.facts.length).slice(0, 3)) {
  console.log(`  · ${c.facts.length} facts — ${String(c.label).slice(0, 70)}`);
}
