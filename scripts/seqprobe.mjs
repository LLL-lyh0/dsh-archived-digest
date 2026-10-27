/**
 * Probe: what identifies a position in a session log?
 *
 * The incremental (in-progress session) digest needs a watermark so that content
 * already turned into memory is never digested twice. Two candidates exist —
 * a per-event `seq`, and the event's position in the file. This prints which is
 * actually present, whether it is monotonic, and how events are ordered, so the
 * cursor is designed against measured data instead of assumption.
 */
import * as inventory from '../lib/inventory.js';
import { findLogFile, readSessionLogText, parseEvents } from '../lib/session-log.js';

const live = inventory.listLiveSessions({}).sessions;
const target = live[0];
console.log('target      :', target.sessionId);
console.log('log bytes   :', target.bytes, '| mtime', new Date(target.mtimeMs).toISOString());

const events = parseEvents(readSessionLogText(findLogFile(target.dir)));
console.log('events      :', events.length);

const byType = new Map();
for (const event of events) {
  const type = String(event.type ?? '(none)');
  const rec = byType.get(type) ?? { n: 0, withSeq: 0, min: Infinity, max: -Infinity };
  rec.n += 1;
  if (Number.isInteger(event.seq)) {
    rec.withSeq += 1;
    rec.min = Math.min(rec.min, event.seq);
    rec.max = Math.max(rec.max, event.seq);
  }
  byType.set(type, rec);
}
console.log('\ntype                         count   withSeq   seq range');
for (const [type, r] of [...byType.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 24)) {
  console.log(
    String(type).padEnd(28),
    String(r.n).padStart(6),
    String(r.withSeq).padStart(9),
    r.withSeq > 0 ? `   [${r.min}..${r.max}]` : '',
  );
}

const withSeq = events.filter((event) => Number.isInteger(event.seq));
console.log('\nwith seq    :', withSeq.length, '/', events.length);
let monotonic = true;
for (let i = 1; i < withSeq.length; i += 1) {
  if (withSeq[i - 1].seq > withSeq[i].seq) { monotonic = false; break; }
}
console.log('monotonic   :', monotonic);
console.log('first event :', events[0]?.type, '| keys', Object.keys(events[0] ?? {}).join(','));

const user = events.find((event) => event.type === 'user/message');
const assistant = events.find((event) => event.type === 'assistant/message');
console.log('user/message      seq=', user?.seq, '| data keys', Object.keys(user?.data ?? {}).join(','));
console.log('assistant/message seq=', assistant?.seq, '| data keys', Object.keys(assistant?.data ?? {}).join(','));
const prune = events.filter((event) => String(event.type).startsWith('compaction/'));
console.log('compaction events :', prune.length, prune.map((event) => event.type).join(',') || '(none)');
