/**
 * Forensic probe: read ONE real session log and report every inner chunk shape
 * that appears, so lib/llm.js's fallback assembler is written against what the
 * provider adapter actually emits rather than against a guess.
 *
 *   node scripts/chunkshape.mjs <session-id>
 */
import { findLogFile, readSessionLogText, parseEvents } from '../lib/session-log.js';
import { findSessionDir } from '../lib/inventory.js';

const want = process.argv[2];
if (!want) {
  console.error('usage: node scripts/chunkshape.mjs <session-id>');
  process.exit(2);
}
const found = findSessionDir(want);
if (!found) {
  console.error('session dir not found:', want);
  process.exit(2);
}
const log = findLogFile(found.dir);
const events = parseEvents(readSessionLogText(log));
console.log('session:', want);
console.log('log file:', log);
console.log('events:', events.length);

const outer = new Map();
for (const ev of events) outer.set(ev.type, (outer.get(ev.type) || 0) + 1);
console.log('\ntop event types (top 14):');
for (const [t, n] of [...outer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${String(n).padStart(6)}  ${t}`);
}

// Every event whose payload might carry a streamed chunk.
const inner = new Map();
const samples = new Map();
for (const ev of events) {
  const d = ev.data ?? ev;
  const candidates = [d.chunk, d.delta, d.block, d];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const t = typeof c.type === 'string' ? c.type : null;
    if (!t) continue;
    inner.set(t, (inner.get(t) || 0) + 1);
    if (!samples.has(t)) samples.set(t, { outer: ev.type, keys: Object.keys(c).join(','), json: JSON.stringify(c).slice(0, 240) });
  }
}
console.log('\ninner chunk/payload types:');
for (const [t, n] of [...inner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  const s = samples.get(t);
  console.log(`  ${String(n).padStart(6)}  ${t}   [outer=${s.outer}] keys=${s.keys}`);
  console.log(`          ${s.json}`);
}

// Does the persisted stream keep thinking in its own channel?
for (const name of ['reasoning-chunks', 'text-chunks', 'assistant/chunk']) {
  const hit = events.find((e) => e.type === name);
  if (hit) {
    const d = hit.data ?? hit;
    console.log(`\n${name}: keys=${Object.keys(d).join(',')}`);
    console.log('  ', JSON.stringify(d).slice(0, 300));
  }
}
