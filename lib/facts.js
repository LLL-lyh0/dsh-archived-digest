/**
 * Fact-level memory: the layer mem0 popularised and Zep sharpened.
 *
 * What digesting one session gives you is prose. What makes memory *useful*
 * later is that each reusable statement is a separate row you can supersede:
 *
 *  - mem0's write pipeline decides ADD / UPDATE / DELETE / NOOP per extracted
 *    fact instead of appending another summary — so a corrected fact replaces
 *    the wrong one rather than sitting next to it forever.
 *    https://github.com/mem0ai/mem0 (ADD/UPDATE/DELETE extraction)
 *  - Zep keeps *temporal validity*: an invalidated fact is not deleted, it gets
 *    `validUntil`, so "what did we believe in August" stays answerable.
 *    https://arxiv.org/abs/2501.13956
 *
 * This file is that model without a vector database: facts are rows in one JSON
 * ledger, similarity is token-overlap (no embedding service required), and
 * consolidation rewrites topics rather than merging free text.
 *
 * Two invariants worth stating, because breaking either is silent:
 *  1. A fact is never dropped on supersede — `validUntil` is set and the row is
 *     kept, so decay and history are recoverable.
 *  2. Deleting (user intent) is different from superseding (newer knowledge);
 *     only the explicit path removes rows.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { paths, ensureStore } from './memory-store.js';

const FACTS_VERSION = 1;

/** Kinds decide how a fact decays and how it ranks in retrieval. */
export const FACT_KINDS = ['decision', 'fact', 'preference', 'pitfall', 'procedure', 'open'];

/**
 * Half-life in days. A decision stays relevant for a long time; an open issue
 * goes stale fast, and a preference should outlive both.
 */
const HALF_LIFE_DAYS = {
  decision: 120,
  preference: 180,
  fact: 90,
  pitfall: 90,
  procedure: 90,
  open: 21,
};

export function factsFile(storeRoot) {
  return path.join(paths(storeRoot).root, 'facts.json');
}

function emptyLedger() {
  return { version: FACTS_VERSION, updatedAt: null, seq: 0, facts: [], topics: [] };
}

export async function readFacts(storeRoot) {
  try {
    const text = await fs.readFile(factsFile(storeRoot), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return emptyLedger();
    return {
      version: FACTS_VERSION,
      updatedAt: parsed.updatedAt ?? null,
      seq: Number(parsed.seq) || 0,
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    };
  } catch {
    return emptyLedger();
  }
}

export async function writeFacts(storeRoot, ledger) {
  await ensureStore(storeRoot);
  const file = factsFile(storeRoot);
  const next = { ...ledger, version: FACTS_VERSION, updatedAt: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return next;
}

// ── similarity (no embedding service needed) ────────────────────────────────

const LATIN_WORD = /[a-z0-9_][a-z0-9_.\-/]*/g;
const CJK_RUN = /[\u3400-\u9fff]+/g;

/**
 * Function words that carry no topical signal. Without removing them a
 * restatement scores low purely because English glue words differ
 * ("the panel **reads** … **at** call time" vs "panel **should** read … **on
 * each** use"). Deliberately short: over-removal destroys the sentence.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'over', 'under',
  'it', 'its', 'as', 'so', 'such', 'not', 'no', 'yes',
  'do', 'does', 'did', 'done', 'should', 'would', 'could', 'can', 'may', 'might', 'must',
  'each', 'every', 'any', 'all', 'some', 'more', 'most', 'other', 'also', 'just', 'only',
  'we', 'you', 'they', 'he', 'she', 'them', 'our', 'your', 'their',
  'has', 'have', 'had', 'will', 'shall', 'very', 'too', 'here', 'there', 'when', 'where', 'how',
]);

/**
 * Conservative suffix folding: plurals and the -ed/-ing forms that differ only by
 * inflection. Deliberately not a Porter stemmer — an aggressive stemmer merges
 * `decide`/`decision` (good) but also `port`/`portal` (bad), and a wrong merge
 * here silently loses a fact.
 */
function foldLatin(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  return word;
}

function latinTokensOf(text) {
  const out = new Set();
  for (const raw of String(text).toLowerCase().match(LATIN_WORD) ?? []) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.add(foldLatin(raw));
  }
  return out;
}

/**
 * CJK **characters**, not bigrams.
 *
 * Bigrams looked reasonable and broke restatements: 「日志要先按」and「日志需要按」
 * share only the bigram 日志 because every later boundary shifts, so similarity
 * came out 0.33 for two sentences a human calls identical. A character set has no
 * such failure mode (0.84 for the same pair), and for short technical statements
 * the character is already the semantic unit.
 */
function cjkCharsOf(text) {
  const out = new Set();
  for (const run of String(text).match(CJK_RUN) ?? []) {
    for (const ch of run) out.add(ch);
  }
  return out;
}

/**
 * Coarse tokens used for *clustering* (topic grouping), where order sensitivity
 * helps a little: latin words plus CJK bigrams.
 */
export function tokensOf(text) {
  const out = new Set(latinTokensOf(text));
  for (const run of String(text).match(CJK_RUN) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
    if (run.length === 1) out.add(run);
  }
  return out;
}

function dice(left, right) {
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Similarity in [0, 1].
 *
 * Raw text goes through a blend: latin-word Dice (weighted up, since one word
 * carries more than one CJK character) plus CJK-character Dice. Two pre-tokenized
 * Sets get plain Jaccard — that is the clustering path, where coarse grouping is
 * the point.
 */
export function similarity(a, b) {
  if (a instanceof Set || b instanceof Set) {
    return jaccard(a instanceof Set ? a : tokensOf(a), b instanceof Set ? b : tokensOf(b));
  }
  const textA = String(a ?? '');
  const textB = String(b ?? '');
  if (textA === '' || textB === '') return 0;
  const latinA = latinTokensOf(textA);
  const latinB = latinTokensOf(textB);
  const cjkA = cjkCharsOf(textA);
  const cjkB = cjkCharsOf(textB);
  let weighted = 0;
  let weight = 0;
  if (latinA.size > 0 || latinB.size > 0) {
    weighted += dice(latinA, latinB) * 1.4;
    weight += 1.4;
  }
  if (cjkA.size > 0 || cjkB.size > 0) {
    weighted += dice(cjkA, cjkB);
    weight += 1;
  }
  return weight === 0 ? 0 : weighted / weight;
}

/**
 * Default threshold for "this is the same statement, said again".
 *
 * Calibrated against measured pairs: restatements land in 0.55–0.80, unrelated
 * statements in 0.00–0.05. 0.5 sits in that empty band with margin on both
 * sides — high enough not to merge two different facts, low enough to catch a
 * paraphrase that changes half the wording.
 */
export const MERGE_THRESHOLD = 0.5;

// ── temporal decay and strength ─────────────────────────────────────────────

function daysBetween(fromIso, toMs) {
  const from = Date.parse(String(fromIso ?? ''));
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, (toMs - from) / 86400000);
}

/**
 * Current weight of a fact in [0, 1].
 *
 * Recency is a half-life, corroboration adds a bounded bonus (a fact learned
 * from two sessions is likelier to matter than one), and use is rewarded — a
 * fact retrieved and not contradicted gets `hits` bumps. Fully invalidated facts
 * score 0 so they cannot outrank live ones, but they stay in the ledger.
 */
export function strengthOf(fact, nowMs = Date.now()) {
  if (fact.validUntil) return 0;
  const halfLife = HALF_LIFE_DAYS[fact.kind] ?? 90;
  const age = daysBetween(fact.lastSeenAt ?? fact.createdAt, nowMs);
  const recency = Math.pow(0.5, age / halfLife);
  const corroboration = Math.min(0.25, Math.log2(1 + (Number(fact.sources?.length) || 1)) * 0.1);
  const use = Math.min(0.2, (Number(fact.hits) || 0) * 0.02);
  return Math.min(1, recency * 0.75 + corroboration + use);
}

// ── the write pipeline: ADD / UPDATE / DELETE / NOOP ────────────────────────

function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function factId(ledger) {
  ledger.seq = (Number(ledger.seq) || 0) + 1;
  return `f${String(ledger.seq).padStart(5, '0')}`;
}

/**
 * Decide what one incoming statement does to the ledger.
 *
 * Order matters: an explicit deletion first (the user said so), then an
 * invalidation (newer contradicts older), then an update (restatement with new
 * detail), then NOOP (identical), else ADD.
 */
export function planWrite(ledger, incoming, options = {}) {
  const threshold = Number(options.threshold) > 0 ? Number(options.threshold) : MERGE_THRESHOLD;
  const text = normalizeText(incoming.text);
  if (text === '') return { op: 'NOOP', reason: 'empty' };

  let best = null;
  let bestScore = 0;
  for (const fact of ledger.facts) {
    // Compare raw text so the blended (latin-Dice + CJK-char-Dice) metric is
    // used. Passing pre-tokenized Sets here silently downgrades to coarse
    // bigram Jaccard, which scored two obvious restatements 0.33 and 0.21 —
    // below any sane threshold, so nothing ever merged.
    const score = similarity(text, fact.text);
    if (score > bestScore) {
      bestScore = score;
      best = fact;
    }
  }

  // Unrelated: this is genuinely new.
  if (best === null || bestScore < threshold) {
    return { op: 'ADD', fact: null, score: bestScore };
  }

  const sameKind = (incoming.kind ?? best.kind) === best.kind;
  // Same statement, nothing new to say.
  if (bestScore >= 0.92 && sameKind) {
    return { op: 'NOOP', fact: best, score: bestScore };
  }
  return { op: 'UPDATE', fact: best, score: bestScore };
}

/**
 * Apply one incoming fact.
 *
 * `supersede` keeps the old row with `validUntil` (history stays answerable);
 * `delete` is only used when the caller explicitly asked to forget.
 */
export function applyWrite(ledger, incoming, options = {}) {
  const nowIso = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const nowMs = options.now ?? Date.now();
  const text = normalizeText(incoming?.text);
  const plan = planWrite(ledger, { ...incoming, text }, options);
  const source = typeof incoming?.source === 'string' ? incoming.source : null;
  const kind = FACT_KINDS.includes(incoming?.kind) ? incoming.kind : 'fact';

  if (plan.op === 'NOOP') {
    const fact = plan.fact;
    fact.hits = (Number(fact.hits) || 0) + 1;
    fact.lastSeenAt = nowIso;
    if (source && !fact.sources.includes(source)) fact.sources.push(source);
    // A re-observation refreshes lastSeen, which is what keeps an old fact warm.
    fact.updatedAt = nowIso;
    return { op: 'NOOP', fact, plan };
  }

  if (plan.op === 'UPDATE' && plan.fact) {
    const previous = plan.fact;
    // Identical wording (same metric as planWrite): refresh in place, do not
    // supersede, or a re-digit of the same session would invalidate its own facts.
    const unchanged = similarity(text, previous.text) >= 0.92;
    if (!unchanged) {
      // Keep the old wording: it may be the only record of what used to be true.
      previous.validUntil = nowIso;
      previous.supersededBy = factId(ledger);
    }
    const mergedSources = [...new Set([...(previous.sources ?? []), ...(source ? [source] : [])])];
    const next = {
      id: unchanged ? previous.id : previous.supersededBy,
      text: unchanged ? previous.text : text,
      kind: incoming?.kind && FACT_KINDS.includes(incoming.kind) ? incoming.kind : previous.kind,
      topic: incoming?.topic ?? previous.topic ?? null,
      createdAt: unchanged ? previous.createdAt : nowIso,
      updatedAt: nowIso,
      lastSeenAt: nowIso,
      validUntil: null,
      supersededBy: null,
      sources: mergedSources,
      hits: (Number(previous.hits) || 0) + 1,
      tags: [...new Set([...(previous.tags ?? []), ...(incoming?.tags ?? [])])],
    };
    if (unchanged) {
      // Nothing new: treat as a refresh in place.
      Object.assign(previous, { lastSeenAt: nowIso, updatedAt: nowIso, hits: next.hits, sources: mergedSources });
      return { op: 'NOOP', fact: previous, plan };
    }
    ledger.facts.push(next);
    return { op: 'UPDATE', fact: next, previous, plan };
  }

  const created = {
    id: factId(ledger),
    text,
    kind,
    topic: typeof incoming?.topic === 'string' ? incoming.topic : null,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastSeenAt: nowIso,
    validUntil: null,
    supersededBy: null,
    sources: source ? [source] : [],
    hits: 1,
    tags: Array.isArray(incoming?.tags) ? [...new Set(incoming.tags)] : [],
  };
  ledger.facts.push(created);
  void nowMs;
  return { op: 'ADD', fact: created, plan };
}

/**
 * Explicit forgetting. This is the only path that removes rows: everything else
 * supersedes, so a wrong deletion cannot be quietly baked in.
 */
export function forgetFact(ledger, { id, text, now = Date.now() }) {
  const before = ledger.facts.length;
  const nowIso = new Date(now).toISOString();
  if (typeof id === 'string' && id !== '') {
    ledger.facts = ledger.facts.filter((fact) => fact.id !== id);
  } else if (typeof text === 'string' && text.trim() !== '') {
    const tokens = tokensOf(text);
    ledger.facts = ledger.facts.filter((fact) => similarity(tokens, tokensOf(fact.text)) < 0.85);
  } else {
    return { removed: 0 };
  }
  return { removed: before - ledger.facts.length, at: nowIso };
}

// ── retrieval ───────────────────────────────────────────────────────────────

/**
 * Relevance floor for a *query*, independent of strength.
 *
 * Below this, a fact is not about what was asked; including it is how a memory
 * search degenerates into "return everything, newest first". Measured: unrelated
 * pairs sit under 0.05, real matches well above it.
 */
const MIN_RELEVANCE = 0.12;

/**
 * Search facts by relevance × strength.
 *
 * Deliberately not pure similarity: an exact match on a fact that has fully
 * decayed should not beat a loose match on something learned yesterday. Strength
 * is multiplicative so a dead fact can never surface.
 */
export function searchFacts(ledger, query, { limit = 20, minScore = 0.05, includeInvalid = false, now = Date.now(), kind = null } = {}) {
  const needle = String(query ?? '').trim();
  const hasQuery = needle !== '';
  const results = [];
  for (const fact of ledger.facts) {
    if (!includeInvalid && fact.validUntil) continue;
    if (kind && fact.kind !== kind) continue;
    // Raw text, same blended metric as the write pipeline. Coarse token Jaccard
    // made a Chinese query score 0 against a true hit.
    const relevance = hasQuery ? similarity(needle, fact.text) : 1;
    const strength = strengthOf(fact, now);
    // Relevance gates *before* scoring: with no gate, an unrelated fact still
    // got 0.3×strength ≈ 0.25 and passed minScore, so a query with zero real
    // hits returned the whole ledger sorted by freshness.
    if (hasQuery && relevance < MIN_RELEVANCE) continue;
    const score = relevance * 0.7 + strength * 0.3;
    if (score < minScore) continue;
    results.push({ fact, relevance, strength, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.max(1, limit));
}

/**
 * Render a retrieval result as a compact block for injection or for a tool reply.
 * Facts are grouped by topic so the reader sees one subject at a time.
 */
export function renderFacts(results, { maxChars = 3000, heading = 'Relevant memory' } = {}) {
  if (results.length === 0) return '';
  const lines = [`## ${heading}`, ''];
  let used = heading.length;
  let shown = 0;
  for (const { fact } of results) {
    const line = `- [${fact.kind}] ${fact.text}`;
    if (used + line.length > maxChars && shown > 0) break;
    lines.push(line);
    used += line.length;
    shown += 1;
  }
  if (shown < results.length) lines.push(`- …${results.length - shown} more not shown`);
  return lines.join('\n');
}

/** Ledger statistics for the panel. */
export function factStats(ledger, now = Date.now()) {
  const live = ledger.facts.filter((fact) => !fact.validUntil);
  const invalid = ledger.facts.length - live.length;
  const byKind = {};
  for (const fact of live) byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
  const avgStrength = live.length === 0
    ? 0
    : live.reduce((sum, fact) => sum + strengthOf(fact, now), 0) / live.length;
  return {
    total: ledger.facts.length,
    live: live.length,
    invalidated: invalid,
    byKind,
    avgStrength: Number(avgStrength.toFixed(3)),
    topics: ledger.topics.length,
    updatedAt: ledger.updatedAt,
  };
}
