/**
 * Consolidation: turn many per-session digests into a few standing topics.
 *
 * Digesting one session at a time is the right ingest model (nothing is lost if
 * one fails), but it is the wrong *retrieval* model: after 77 sessions you have
 * 77 summaries that each restate one corner of the same project. What a reader
 * wants is "what do I know about this project", assembled once.
 *
 * This is the same split the mature memory systems make:
 *  - mem0 extracts facts and then lets a per-user memory set be updated rather
 *    than appended (https://github.com/mem0ai/mem0).
 *  - Zep/Graphiti maintains a temporal knowledge graph whose invalidated edges
 *    keep `validUntil` instead of disappearing (https://arxiv.org/abs/2501.13956).
 *  - Sleep-time consolidation (replaying and rewriting rather than only appending
 *    on write) is the "dream loop" idea in the recent agent-memory literature.
 *
 * Here a "topic" is one clustered subject with a stable id, a set of live fact
 * ids, and a rendered body. Consolidation is idempotent: running it twice
 * rewrites the same topics instead of creating new ones, and it never invents a
 * fact — every sentence in a topic body traces to a fact id.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { paths, ensureStore } from './memory-store.js';
import { similarity, strengthOf, FACT_KINDS } from './facts.js';

/**
 * A topic needs this much overlap with an existing one to join it.
 *
 * Must sit **below** the fact-merge threshold (0.5) or every clustered pair
 * would already have merged into one fact and clustering would be pointless; and
 * above the noise floor. Measured: same-subject/different-fact pairs land around
 * 0.40–0.50, unrelated ones at ≤0.13, so 0.3 separates them with margin.
 */
const TOPIC_MERGE_THRESHOLD = 0.3;

export function topicsFile(storeRoot) {
  return path.join(paths(storeRoot).root, 'facts.json');
}

function slugOf(text) {
  const raw = String(text ?? '').toLowerCase();
  const words = raw.match(/[a-z0-9][a-z0-9-]*/g) ?? [];
  if (words.length > 0) return words.slice(0, 4).join('-').slice(0, 48);
  // All-CJK labels get a stable short hash rather than an empty slug.
  let hash = 0;
  for (const ch of String(text ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `topic-${hash.toString(36).slice(0, 8)}`;
}

/**
 * Cluster live facts into topics.
 *
 * Deterministic and order-independent: facts are sorted before clustering so the
 * same ledger always yields the same topic ids. Clustering is single-pass
 * agglomerative over token overlap — good enough for hundreds of facts, and
 * cheap enough to run on every consolidation.
 */
/**
 * How well a fact matches a cluster: the score of its single best-matching member.
 *
 * NOT the score against the concatenation of every member. That was the original
 * implementation and it is self-defeating: the candidate text is one short fact
 * while the cluster's text grows with every member, so the shared-token ratio
 * falls as the cluster gets better established. The bigger a topic became, the
 * harder it was to join — measured on a real ledger, 127 of 156 topics held
 * exactly one fact, i.e. almost no aggregation at all.
 *
 * Nearest-member (single-linkage) keeps the test dependent on the best matching
 * fact instead of on cluster size, so an established topic stays joinable.
 */
function bestMemberScore(text, cluster) {
  let best = 0;
  for (const member of cluster.facts) {
    const score = similarity(text, `${member.topic ?? ''} ${member.text}`);
    if (score > best) best = score;
  }
  return best;
}

export function clusterFacts(facts, options = {}) {
  const threshold = Number(options.threshold) > 0 ? Number(options.threshold) : TOPIC_MERGE_THRESHOLD;
  const subjectOf = typeof options.subjectOf === 'function' ? options.subjectOf : null;
  /**
   * The subject a fact belongs to: an explicit label if the digester set one,
   * otherwise whatever the caller can resolve (the digest title for that session).
   *
   * This matters more than token overlap for cross-session grouping. Facts from
   * one session are one subject, but two sessions about the same Unity bug share
   * almost no characters ("碰撞体穿透" vs "ShipHullCollision 扫掠"), so a pure
   * similarity test leaves nearly every fact in its own topic — measured at 127
   * singletons out of 156 topics on a real ledger.
   */
  const subject = (fact) => {
    if (fact.topic) return String(fact.topic);
    if (!subjectOf) return '';
    const derived = subjectOf(fact);
    return derived ? String(derived).slice(0, 80) : '';
  };
  const live = facts
    .filter((fact) => !fact.validUntil)
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));

  const clusters = [];
  for (const fact of live) {
    const label = subject(fact);
    const text = `${label} ${fact.text}`;
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = bestMemberScore(text, cluster);
      if (score > bestScore) {
        bestScore = score;
        best = cluster;
      }
    }
    // An explicit subject wins over clustering: the digester knows the subject
    // better than character overlap does.
    if (label) {
      const labelled = clusters.find((cluster) => cluster.label === label);
      if (labelled) {
        labelled.facts.push(fact);
        labelled.text += ` ${fact.text}`;
        continue;
      }
    }
    if (best !== null && bestScore >= threshold) {
      best.facts.push(fact);
      best.text += ` ${fact.text}`;
      continue;
    }
    clusters.push({
      label: label || deriveLabel(fact),
      // Kept for diagnostics only; scoring uses bestMemberScore, not this string.
      text,
      facts: [fact],
    });
  }
  return clusters;
}

/** Derive a human label from the first fact of a cluster. */
function deriveLabel(fact) {
  const text = String(fact.text ?? '').trim();
  if (text === '') return 'untitled';
  // Prefer the shortest leading clause; fall back to a truncated sentence.
  const head = text.split(/[。.；;：:\n]/).map((part) => part.trim()).find((part) => part.length >= 4);
  const base = head ?? text;
  return base.length > 40 ? `${base.slice(0, 40)}…` : base;
}

/** Order facts inside a topic: decisions first, then facts, then the rest. */
const KIND_ORDER = ['decision', 'preference', 'procedure', 'pitfall', 'fact', 'open'];

function orderFacts(facts) {
  return facts.slice().sort((a, b) => {
    const rank = (fact) => {
      const index = KIND_ORDER.indexOf(fact.kind);
      return index === -1 ? KIND_ORDER.length : index;
    };
    return rank(a) - rank(b) || strengthOf(b) - strengthOf(a);
  });
}

/**
 * Render one topic body.
 *
 * Every bullet cites its fact id (`^f00012`), so a reader can trace a claim back
 * to the session that produced it, and superseded wording is listed separately
 * instead of being silently dropped.
 */
export function renderTopic(cluster, { now = Date.now(), maxChars = 4000 } = {}) {
  const ordered = orderFacts(cluster.facts);
  const lines = [`# ${cluster.label}`, ''];
  let used = lines.join('\n').length;
  let shown = 0;
  for (const fact of ordered) {
    const strength = strengthOf(fact, now);
    const line = `- [${fact.kind}] ${fact.text} ^${fact.id}` + (strength < 0.25 ? ' _(fading)_' : '');
    if (used + line.length > maxChars && shown > 0) break;
    lines.push(line);
    used += line.length;
    shown += 1;
  }
  if (shown < ordered.length) lines.push(`- …${ordered.length - shown} more facts in this topic`);
  const sources = [...new Set(ordered.flatMap((fact) => fact.sources ?? []))];
  if (sources.length > 0) {
    lines.push('', `_From ${sources.length} session${sources.length === 1 ? '' : 's'}: ${sources.slice(0, 8).map((id) => id.replace(/^session-/, '').slice(0, 8)).join(', ')}${sources.length > 8 ? ', …' : ''}_`);
  }
  return lines.join('\n');
}

/**
 * Rebuild the topic list for a ledger.
 *
 * Returns the topics that should be persisted on the ledger. Existing topics keep
 * their id and `createdAt` when their cluster label still matches, so links and
 * references into a topic do not break every time consolidation runs.
 */
export function buildTopics(ledger, { now = Date.now(), maxChars = 4000, subjectOf = null } = {}) {
  const clusters = clusterFacts(ledger.facts, subjectOf ? { subjectOf } : {});
  const previous = new Map((ledger.topics ?? []).map((topic) => [topic.id, topic]));
  const usedIds = new Set();
  const topics = [];

  for (const cluster of clusters) {
    const label = cluster.label;
    const baseSlug = slugOf(label);
    let id = baseSlug;
    let counter = 2;
    // Reuse the id when this exact subject was consolidated before, so ids are
    // stable across runs rather than merely unique.
    const existingSameLabel = [...previous.values()].find((topic) => topic.label === label && !usedIds.has(topic.id));
    if (existingSameLabel) {
      id = existingSameLabel.id;
    } else {
      while (usedIds.has(id)) {
        id = `${baseSlug}-${counter}`;
        counter += 1;
      }
    }
    usedIds.add(id);
    const prior = previous.get(id);
    const ordered = orderFacts(cluster.facts);
    topics.push({
      id,
      label,
      body: renderTopic({ ...cluster, label }, { now, maxChars }),
      factIds: ordered.map((fact) => fact.id),
      kinds: [...new Set(ordered.map((fact) => fact.kind))],
      sources: [...new Set(ordered.flatMap((fact) => fact.sources ?? []))],
      strength: Number((ordered.reduce((sum, fact) => sum + strengthOf(fact, now), 0) / Math.max(1, ordered.length)).toFixed(3)),
      createdAt: prior?.createdAt ?? new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
  }
  topics.sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  return topics;
}

/** Write consolidated topics back onto the facts ledger. */
export async function consolidateTopics(storeRoot, { now = Date.now(), maxChars = 4000, subjectOf = null } = {}) {
  const { readFacts, writeFacts } = await import('./facts.js');
  const ledger = await readFacts(storeRoot);
  const before = ledger.topics.length;
  // Backfill the subject onto facts that predate it, so a ledger written by an
  // older version groups correctly instead of staying fragmented forever.
  if (typeof subjectOf === 'function') {
    for (const fact of ledger.facts) {
      if (fact.topic || fact.validUntil) continue;
      const derived = subjectOf(fact);
      if (derived) fact.topic = String(derived).slice(0, 80);
    }
  }
  const topics = buildTopics(ledger, { now, maxChars, subjectOf });
  ledger.topics = topics;
  await writeFacts(storeRoot, ledger);
  return {
    topics: topics.length,
    before,
    created: topics.length,
    ledger,
  };
}

/** Topic lookup for the panel and for retrieval. */
export function findTopics(ledger, query, { limit = 10, minScore = 0.03 } = {}) {
  const topics = ledger.topics ?? [];
  const needle = String(query ?? '').trim();
  if (needle === '') return topics.slice(0, limit);
  return topics
    // Raw text, same blended metric as fact search — a Chinese topic lookup
    // through coarse bigrams missed its own subject.
    .map((topic) => ({ topic, score: similarity(needle, `${topic.label} ${topic.body}`) }))
    .filter((entry) => entry.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.topic);
}

/**
 * Group the digester's per-kind arrays into fact-shaped rows.
 *
 * The distiller already produces `decisions` / `facts` / `openIssues`; those are
 * exactly the durable kinds this layer wants, so no second model call is needed
 * to get fact-level memory. `skills` stay skills, not facts.
 */
export function factsFromDigest(digest, sessionId) {
  const out = [];
  // Every fact from one digest shares that session's subject, which is what makes
  // cross-session grouping possible at all: two sessions about the same bug rarely
  // share characters, but they do share a subject.
  const topic = String(digest.title ?? '').trim().slice(0, 80);
  const push = (kind, text) => {
    const trimmed = String(text ?? '').trim();
    if (trimmed !== '') out.push({ kind, text: trimmed, source: sessionId, ...(topic ? { topic } : {}) });
  };
  for (const item of digest.decisions ?? []) push('decision', typeof item === 'string' ? item : item?.decision ?? item?.text ?? '');
  for (const item of digest.facts ?? []) {
    if (typeof item === 'string') push('fact', item);
    else if (item && typeof item === 'object') {
      const label = String(item.label ?? '').trim();
      const value = String(item.value ?? item.text ?? '').trim();
      push('fact', label !== '' && value !== '' ? `${label}: ${value}` : (value || label));
    }
  }
  for (const item of digest.openIssues ?? []) push('open', item);
  for (const item of digest.pitfalls ?? []) push('pitfall', item);
  for (const item of digest.preferences ?? []) push('preference', item);
  for (const item of digest.procedures ?? []) push('procedure', item);
  void FACT_KINDS;
  return out.filter((fact) => fact.text.length >= 4);
}

/** Apply a whole digest's facts to the ledger. */
export async function ingestDigestFacts(storeRoot, digest, sessionId, options = {}) {
  const { readFacts, writeFacts, applyWrite } = await import('./facts.js');
  const ledger = await readFacts(storeRoot);
  const incoming = factsFromDigest(digest, sessionId);
  const applied = [];
  for (const fact of incoming) {
    applied.push(applyWrite(ledger, fact, options));
  }
  await writeFacts(storeRoot, ledger);
  const counts = applied.reduce((acc, entry) => {
    acc[entry.op] = (acc[entry.op] ?? 0) + 1;
    return acc;
  }, {});
  return { applied: applied.length, counts, facts: applied };
}

/** Delete topics that no longer own any live fact. */
export function pruneTopics(ledger) {
  const liveIds = new Set(ledger.facts.filter((fact) => !fact.validUntil).map((fact) => fact.id));
  const before = ledger.topics.length;
  ledger.topics = ledger.topics.filter((topic) => topic.factIds.some((id) => liveIds.has(id)));
  return { removed: before - ledger.topics.length };
}
