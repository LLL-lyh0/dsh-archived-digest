/**
 * Probe: does the host's own compaction remove content from the log?
 *
 * The incremental digest keeps a `seq` watermark. That is only sound if a
 * watermark means "everything before this is already digested and still
 * readable" — i.e. the log is append-only and `seq` never gets reused. This
 * prints the compaction events and checks for seq reuse/gaps, because a log that
 * rewrites history would silently make a watermark skip content forever.
 */
import * as inventory from '../lib/inventory.js';
import { findLogFile, readSessionLogText, parseEvents } from '../lib/session-log.js';

const target = inventory.listLiveSessions({}).sessions[0];
console.log('target:', target.sessionId);

const events = parseEvents(readSessionLogText(findLogFile(target.dir)));

const compactions = events.filter((event) => String(event.type).startsWith('compaction/'));
console.log('\ncompaction payload sample:');
for (const event of compactions.slice(0, 3)) {
  console.log(' ', JSON.stringify(event).slice(0, 400));
}

const seqs = events.filter((event) => Number.isInteger(event.seq)).map((event) => event.seq);
const unique = new Set(seqs);
console.log('\nseq count      :', seqs.length, '| unique', unique.size, '| reused', seqs.length - unique.size);
console.log('seq min/max    :', Math.min(...seqs), '/', Math.max(...seqs));

let gaps = 0;
const sorted = [...unique].sort((a, b) => a - b);
for (let i = 1; i < sorted.length; i += 1) if (sorted[i] - sorted[i - 1] > 1) gaps += 1;
console.log('gaps in seq    :', gaps, '(a gap is fine: it only means an event type was never written)');

// Do any late-arriving events carry a low seq (i.e. an insert, not an append)?
const headerSeq = events.find((event) => event.type === 'session')?.seq;
console.log('header seq     :', headerSeq);
let inversions = 0;
for (let i = 1; i < events.length; i += 1) {
  const a = events[i - 1].seq;
  const b = events[i].seq;
  if (Number.isInteger(a) && Number.isInteger(b) && b < a) inversions += 1;
}
console.log('order inversions:', inversions, '(0 means the file is strictly append-ordered)');

// How much of the log is "answerable" content vs. machinery?
const content = events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message');
const contentSeqs = content.filter((event) => Number.isInteger(event.seq)).map((event) => event.seq);
console.log('content events :', content.length, '| seq range', Math.min(...contentSeqs), '..', Math.max(...contentSeqs));
console.log('pruned content?:', compactions.filter((event) => event?.data?.removedSeqs || event?.data?.seqs).length, 'with removed-seq info');
