/**
 * Read files out of an Electron asar archive from plain node.
 *
 * The archive is a single file, so the shell cannot list or grep it; but its
 * header is a JSON index with a byte offset per entry, which is enough to pull
 * any one file out by exact path.
 *
 * Usage:
 *   node scripts/asar-read.mjs <asar> list [substring]
 *   node scripts/asar-read.mjs <asar> read <inner-path> [maxBytes]
 */
import fs from 'node:fs';

const [, , archive, action, target, third] = process.argv;
if (!archive || !action) {
  console.error('usage: asar-read.mjs <archive> list [substr] | read <inner-path> [maxBytes]');
  process.exit(2);
}

const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
// Layout: [uint32 headerPickleSize][uint32 headerStringSize][uint32 headerJsonSize][json]
const jsonSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const dataStart = 16 + jsonSize;

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = `${prefix}/${name}`;
    if (value.files) walk(value, full, out);
    else out.push({ path: full, offset: Number(value.offset), size: value.size });
  }
  return out;
}
const entries = walk(header, '', []);
const index = new Map(entries.map((entry) => [entry.path, entry]));

if (action === 'list') {
  const filtered = target ? entries.filter((entry) => entry.path.includes(target)) : entries;
  for (const entry of filtered) console.log(`${entry.size}\t${entry.path}`);
} else if (action === 'read') {
  const entry = index.get(target);
  if (!entry) {
    console.error(`not in archive: ${target}`);
    process.exit(1);
  }
  const max = Number(third) > 0 ? Number(third) : entry.size;
  const length = Math.min(max, entry.size);
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, dataStart + entry.offset);
  process.stdout.write(buf.toString('utf8'));
} else {
  console.error(`unknown action: ${action}`);
  process.exit(2);
}
