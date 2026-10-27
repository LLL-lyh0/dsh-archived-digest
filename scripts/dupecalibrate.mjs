/**
 * Calibrate the fact-dedupe threshold, because 0.5 is NOT safe for merging.
 *
 * A dry run at similarity >= 0.5 flagged 84 groups, but inspection showed
 * false positives: 「等用户拍板 6 个设计点：消耗规则…」 vs 「上一轮遗留的事件时机
 * 问题…」 scored 0.630 and are plainly different facts that share vocabulary
 * (事件/问题/遗留/确认). Merging those would destroy information, silently.
 *
 * So print the actual score distribution with the texts, to find the band where
 * two facts are genuinely the same statement rather than the same topic. The
 * merge threshold must sit above the topic-similarity band.
 */
import { readFacts, similarity } from '../lib/facts.js';

const ledger = await readFacts(process.argv[2]);
const live = ledger.facts.filter((fact) => !fact.validUntil);

const pairs = [];
for (let i = 0; i < live.length; i += 1) {
  for (let j = i + 1; j < live.length; j += 1) {
    const score = similarity(live[i].text, live[j].text);
    if (score >= 0.5) pairs.push({ score, a: live[i], b: live[j] });
  }
}
pairs.sort((x, y) => y.score - x.score);

const buckets = { '>=0.9': 0, '0.8-0.9': 0, '0.7-0.8': 0, '0.6-0.7': 0, '0.5-0.6': 0 };
for (const pair of pairs) {
  if (pair.score >= 0.9) buckets['>=0.9'] += 1;
  else if (pair.score >= 0.8) buckets['0.8-0.9'] += 1;
  else if (pair.score >= 0.7) buckets['0.7-0.8'] += 1;
  else if (pair.score >= 0.6) buckets['0.6-0.7'] += 1;
  else buckets['0.5-0.6'] += 1;
}
console.log('live facts:', live.length, '| pairs >= 0.5:', pairs.length);
console.log('distribution:', JSON.stringify(buckets, null, 0));

console.log('\n=== top of the band (likely true duplicates) ===');
for (const pair of pairs.slice(0, 10)) {
  console.log(`\n${pair.score.toFixed(3)}  [${pair.a.kind} vs ${pair.b.kind}]`);
  console.log(`  A: ${pair.a.text.slice(0, 110)}`);
  console.log(`  B: ${pair.b.text.slice(0, 110)}`);
}

console.log('\n\n=== bottom of the band (likely same-topic false positives) ===');
for (const pair of pairs.slice(-8)) {
  console.log(`\n${pair.score.toFixed(3)}  [${pair.a.kind} vs ${pair.b.kind}]`);
  console.log(`  A: ${pair.a.text.slice(0, 110)}`);
  console.log(`  B: ${pair.b.text.slice(0, 110)}`);
}

// Same-kind pairs only: the write pipeline only auto-NOOPs within one kind.
let sameKind = 0;
for (const pair of pairs) if (pair.a.kind === pair.b.kind) sameKind += 1;
console.log(`\npairs in the same kind: ${sameKind}/${pairs.length}`);
for (const t of [0.7, 0.75, 0.8, 0.85, 0.9]) {
  const n = pairs.filter((pair) => pair.score >= t).length;
  const grouped = new Set(pairs.filter((pair) => pair.score >= t).flatMap((pair) => [pair.a.id, pair.b.id])).size;
  console.log(`  >= ${t}: ${n} pairs, ${grouped} distinct facts involved`);
}
