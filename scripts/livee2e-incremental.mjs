/**
 * Live end-to-end check on THIS conversation.
 *
 * The point is the read-only guarantee: the session log is snapshotted (size,
 * mtime, sha256) before an incremental digest, and re-checked after. A digest that
 * changes the running agent's log would be corrupting an open file, so this proves
 * on real data what `incrementaltest.mjs` proves on a synthetic log.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findSessionDir } from '../lib/inventory.js';
import { findLogFile, readSessionLogText, parseEvents } from '../lib/session-log.js';
import { digestLiveIncremental } from '../lib/digester.js';
import { readCursors, getCursor } from '../lib/live-cursor.js';

const SID = 'session-dae76e4e-0368-4f36-8539-a674bb2f01ec';
const storeRoot = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'archived-digest');

const located = await findSessionDir(SID);
if (!located) {
  console.log('session not found on disk');
  process.exit(1);
}
const logFile = findLogFile(located.dir);
const fingerprint = () => {
  const stat = fs.statSync(logFile);
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha: crypto.createHash('sha256').update(fs.readFileSync(logFile)).digest('hex') };
};

const before = fingerprint();
const events = parseEvents(readSessionLogText(logFile));
const cursor = getCursor(await readCursors(storeRoot), SID);
console.log(`log: ${before.size} bytes / ${events.length} events / cursor lastSeq=${cursor.lastSeq}`);

const started = Date.now();
const result = await digestLiveIncremental({
  ctx: { get: () => null },
  sessionId: SID,
  sessionDir: located.dir,
  storeRoot,
  options: { extractSkills: false },
});
console.log(`digest: ${result.ok ? 'ok' : 'failed'} code=${result.code ?? '-'} (${Date.now() - started}ms)`);
if (!result.ok) console.log('  message:', result.message);

const after = fingerprint();
console.log('\n── read-only verification ──');
console.log('size   :', before.size, '→', after.size, before.size === after.size ? 'UNCHANGED' : 'CHANGED');
console.log('mtime  :', before.mtimeMs, '→', after.mtimeMs, before.mtimeMs === after.mtimeMs ? 'UNCHANGED' : 'CHANGED');
console.log('sha256 :', before.sha.slice(0, 16), '→', after.sha.slice(0, 16), before.sha === after.sha ? 'UNCHANGED' : 'CHANGED');
const ok = before.sha === after.sha && before.mtimeMs === after.mtimeMs;
console.log(ok ? '\nRESULT: the running session log was NOT modified' : '\nRESULT: the session log WAS MODIFIED (read-only guarantee broken)');
process.exitCode = ok ? 0 : 1;
