/**
 * Prove the digest only ever *appends* to a running session log.
 *
 * "sha256 unchanged" is the wrong test for a live session: the agent keeps writing
 * to it, so the file legitimately changes during the digest. The property that
 * actually matters is **append-only** — every byte that existed before is still
 * there, at the same offset. A writer that rewrote or truncated the log would
 * break that even though the size happened to grow.
 *
 * Usage: node scripts/appendcheck.mjs <session-id> snapshot|verify
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
  console.error('usage: appendcheck.mjs <session-id> snapshot|verify');
  process.exit(2);
}

const located = await findSessionDir(sessionId);
if (!located) {
  console.error('session not found:', sessionId);
  process.exit(2);
}
const logFile = findLogFile(located.dir);
const store = path.join(here, '.append-fingerprint.json');

if (action === 'snapshot') {
  const buf = fs.readFileSync(logFile);
  const snapshot = {
    size: buf.length,
    prefixSha: crypto.createHash('sha256').update(buf).digest('hex'),
  };
  fs.writeFileSync(store, JSON.stringify(snapshot, null, 2));
  console.log(`snapshot: ${snapshot.size} bytes recorded (prefix sha ${snapshot.prefixSha.slice(0, 16)})`);
  process.exit(0);
}

const before = JSON.parse(fs.readFileSync(store, 'utf8'));
const now = fs.readFileSync(logFile);
if (now.length < before.size) {
  console.log(`FAIL: the log SHRANK ${before.size} → ${now.length} bytes — it was truncated`);
  process.exitCode = 1;
} else {
  const prefix = now.subarray(0, before.size);
  const prefixSha = crypto.createHash('sha256').update(prefix).digest('hex');
  const same = prefixSha === before.prefixSha;
  console.log(`size  : ${before.size} → ${now.length} (+${now.length - before.size} bytes appended)`);
  console.log(`prefix: ${before.prefixSha.slice(0, 16)} → ${prefixSha.slice(0, 16)} ${same ? 'IDENTICAL' : 'DIFFERS'}`);
  console.log(same
    ? '\nRESULT: append-only — every previously written byte is intact'
    : '\nRESULT: the existing bytes were modified, not just appended to');
  process.exitCode = same ? 0 : 1;
}
