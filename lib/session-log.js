/**
 * Reading an archived session's own on-disk log.
 *
 * Two hard-won facts drive this file:
 *
 * 1. The log is a **multi-frame** zstd file. The DSH logger appends one zstd
 *    frame per flush, so `zstdDecompressSync(wholeFile)` (and the streaming
 *    decompressor) return only the FIRST frame — a 16 KB file decodes to a few
 *    hundred bytes of session header. We split on the frame magic and decode
 *    every frame, then concatenate the JSONL.
 *
 * 2. The log is mostly noise. Measured on a real 1856-line archived session:
 *    `assistant/chunk` 812, `tool/result` 148, `tool/call` 147 — all redundant
 *    with the final `assistant/message` records, and a single `tool/result` can
 *    be 13 KB. So the digest source only keeps user text and assistant text
 *    blocks, never reasoning, never tool payloads.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Session log file names, newest format first. */
export const LOG_NAMES = ['session.jsonl.zstd', 'session.v4.jsonl.zstd'];

/** Locate the log file inside a session directory (or null). */
export function findLogFile(sessionDir) {
  for (const name of LOG_NAMES) {
    const file = join(sessionDir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/** All offsets where a zstd frame could start. */
function magicOffsets(buf) {
  const offsets = [];
  let at = buf.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + 4);
  }
  return offsets;
}

/**
 * Decode a multi-frame zstd buffer.
 *
 * A magic-byte match inside a compressed payload is a false positive, so each
 * candidate slice is decoded and validated: on failure the window grows to the
 * next magic offset. That keeps a stray in-payload match from silently
 * swallowing a real frame boundary.
 */
export function decodeZstdFrames(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  if (buf.indexOf(ZSTD_MAGIC) === -1) return '';
  const offsets = magicOffsets(buf);
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    if (start < cursor) continue;
    let decoded = null;
    let end = -1;
    for (let j = i + 1; j <= offsets.length; j += 1) {
      const stop = j < offsets.length ? offsets[j] : buf.length;
      if (stop <= start) continue;
      try {
        decoded = zstdDecompressSync(buf.subarray(start, stop));
        end = stop;
        break;
      } catch {
        /* false positive or truncated frame: widen the window */
      }
    }
    if (decoded === null) break;
    parts.push(decoded.toString('utf8'));
    cursor = end;
  }
  return parts.join('');
}

/** Decode a session log file into raw JSONL text ('' when unreadable). */
export function readSessionLogText(file) {
  try {
    return decodeZstdFrames(readFileSync(file));
  } catch {
    return '';
  }
}

/** Parse JSONL defensively: bad lines are skipped, never fatal. */
export function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch {
      /* a torn tail line is normal for an appended log */
    }
  }
  return events;
}

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const chunks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
  }
  return chunks.join('\n');
}

/**
 * Runtime snapshots, skill catalogs and approval-policy notices are replayed
 * into `user/message` records by the harness. They are length-expensive and
 * carry no task content, so they are stripped before the transcript is built.
 */
const INJECTED_PREFIXES = [
  'Current runtime context.',
  'This snapshot supersedes earlier runtime-context snapshots.',
  'Time sampled while preparing',
  'Browser time zone for this request:',
  'The approval policy changed from',
  'The available skill catalog changed.',
];

const INJECTED_TAGS = ['system-reminder', 'available_skills', 'environment_context'];

function isInjected(text) {
  const head = text.slice(0, 400);
  for (const prefix of INJECTED_PREFIXES) {
    if (head.includes(prefix)) return true;
  }
  return false;
}

/** Remove whole injected tags, then drop the message if nothing real is left. */
function stripInjectedBlocks(text) {
  let out = text;
  for (const tag of INJECTED_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }
  // Harness-written system turns that arrive without tags.
  out = out.replace(/^[^\n]*(?:Current runtime context|This snapshot supersedes)[^\n]*$/gim, '');
  out = out.replace(/^Time sampled while preparing[^\n]*$/gim, '');
  out = out.replace(/^Browser time zone for this request:[^\n]*$/gim, '');
  out = out.replace(/^The approval policy changed from[^\n]*$/gim, '');
  out = out.replace(/^The available skill catalog changed[^\n]*$/gim, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Condense a parsed event list into what the distiller actually needs:
 * a title, the project cwd, and a trimmed user/assistant transcript.
 *
 * @param {Array<object>} events
 * @param {{maxSourceChars?: number, perMessageCap?: number, sinceSeq?: number}} [options]
 */
export function extractDigestSource(events, options = {}) {
  const maxSourceChars = Number(options.maxSourceChars) > 0 ? Number(options.maxSourceChars) : 14000;
  const perMessageCap = Number(options.perMessageCap) > 0 ? Number(options.perMessageCap) : 2600;
  // For an in-progress session this is the cursor: only events after the last
  // digested seq are considered, so content already in memory is never re-sent.
  const sinceSeq = Number.isInteger(options.sinceSeq) ? options.sinceSeq : null;

  let header = null;
  let title = '';
  const turns = [];
  const toolNames = new Set();
  let fromSeq = null;
  let toSeq = null;

  for (const event of events) {
    const seq = Number.isInteger(event.seq) ? event.seq : null;
    if (seq !== null) {
      if (fromSeq === null) fromSeq = seq;
      toSeq = seq;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'session' && header === null) {
      header = event;
      continue;
    }
    // The header carries the session identity and must be read on every pass;
    // everything else is subject to the cursor.
    if (sinceSeq !== null && seq !== null && seq <= sinceSeq) continue;
    if (type === 'session/title') {
      const next = event?.data?.title;
      if (typeof next === 'string' && next.trim() !== '') title = next.trim();
      continue;
    }
    if (type === 'user/message') {
      const raw = textOfContent(event?.data?.content).trim();
      if (raw === '' || isInjected(raw)) continue;
      const text = stripInjectedBlocks(raw);
      if (text.length < 2) continue;
      turns.push({ role: 'user', text });
      continue;
    }
    if (type === 'assistant/message') {
      const text = textOfContent(event?.data?.message?.content).trim();
      if (text !== '') turns.push({ role: 'assistant', text });
      continue;
    }
    if (type === 'tool/call') {
      const name = event?.data?.name;
      if (typeof name === 'string' && name !== '') toolNames.add(name);
    }
  }

  const startedAt = Number(header?.createdAt) > 0 ? Number(header.createdAt) : null;
  const cwd = typeof header?.cwd === 'string' ? header.cwd : '';
  const sessionId = typeof header?.id === 'string' ? header.id : '';

  // Trim newest-first from the tail: the end of a session holds its conclusions.
  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    let text = turn.text;
    if (text.length > perMessageCap) {
      text = `${text.slice(0, Math.floor(perMessageCap * 0.35))}\n…\n${text.slice(-Math.floor(perMessageCap * 0.65))}`;
    }
    if (used + text.length > maxSourceChars && kept.length > 0) break;
    kept.push({ role: turn.role, text });
    used += text.length;
  }
  kept.reverse();

  const transcript = kept.map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`).join('\n\n');

  return {
    sessionId,
    title,
    cwd,
    startedAt,
    turns: turns.length,
    keptTurns: kept.length,
    toolNames: [...toolNames].slice(0, 40),
    transcript,
    chars: transcript.length,
    // Which seq range this extraction actually covers. The live cursor records it
    // so the next pass provably starts after what this one already consumed.
    fromSeq,
    toSeq,
    sinceSeq,
  };
}

/** Byte size of a session directory's log files (0 when absent). */
export function sessionBytes(sessionDir) {
  const file = findLogFile(sessionDir);
  if (file === null) return 0;
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
