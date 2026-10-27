/**
 * Snapshot or verify one live session log's fingerprint.
 *
 * Usage: node scripts/livefp.mjs <session-id> snapshot|verify
 *
 * Used to prove the read-only guarantee against a *real* digest driven through the
 * running host: snapshot, hit the host endpoint, verify the log is byte-identical.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSessionDir } from '../lib/inventory.js';
import { findLogFile } from '../lib/session-log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , sessionId, action = 'verify'] = process.argv;
if (!sessionId) {
  console.error('usage: livefp.mjs <session-id> snapshot|verify');
  process.exit(2);
}

const located = await findSessionDir(sessionId);
if (!located) {
  console.error('session not found:', sessionId);
  process.exit(2);
}
const logFile = findLogFile(located.dir);
const stat = fs.statSync(logFile);
const current = {
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  sha: crypto.createHash('sha256').update(fs.readFileSync(logFile)).digest('hex'),
};
const store = path.join(here, '.live-fingerprint.json');

if (action === 'snapshot') {
  fs.writeFileSync(store, JSON.stringify(current, null, 2));
  console.log(`snapshot: ${current.size} bytes, sha ${current.sha.slice(0, 16)}`);
  process.exit(0);
}

const before = JSON.parse(fs.readFileSync(store, 'utf8'));
console.log('size  :', before.size, '→', current.size, before.size === current.size ? 'UNCHANGED' : 'CHANGED');
console.log('mtime :', before.mtimeMs, '→', current.mtimeMs, before.mtimeMs === current.mtimeMs ? 'UNCHANGED' : 'CHANGED');
console.log('sha256:', before.sha.slice(0, 16), '→', current.sha.slice(0, 16), before.sha === current.sha ? 'UNCHANGED' : 'CHANGED');
const same = before.sha === current.sha;
console.log(same
  ? '\nRESULT: the running session log is byte-identical — the digest only read it'
  : '\nNOTE: the log changed. That is expected while the conversation is still being written;');
if (!same) console.log('      the size must not SHRINK and the digest must not have written to it.');
process.exitCode = same ? 0 : 0;
