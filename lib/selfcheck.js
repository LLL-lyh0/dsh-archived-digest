/**
 * Self-check and compaction: keep the accumulated memory from becoming noise.
 *
 * Long use makes memory *interfere* with the model rather than help it, but not
 * uniformly — measured on a real store (85 memories / 139 skills / 2037 facts):
 *
 *  - **Skills are a permanent tax.** Every skill's name + description is injected
 *    into EVERY session's prompt: 139 skills measured 12,582 chars ≈ 3,595 tokens
 *    *per turn, forever*, whether or not any of them is relevant. This is by far
 *    the largest recurring cost, and it grows monotonically with use.
 *  - **Facts are noise on retrieval.** 1,732 live facts produced 100 near-duplicate
 *    pairs (similarity ≥ 0.5) that the write-time threshold should have merged but
 *    did not, because each arrived in a different write. They crowd search results.
 *  - **Trash is disk, not context.** 222 MB of quarantined session dirs.
 *
 * So the rules here are ordered by what actually interferes:
 *
 *  1. `mergeFacts` — collapse near-duplicate live facts the write pipeline missed.
 *     Supersede, never delete: the loser keeps `validUntil` + `supersededBy`, so
 *     history stays answerable and the operation is reversible by inspection.
 *  2. `pruneStaleFacts` — retire `open` facts that have decayed past usefulness.
 *     Only the fast-decaying kind, and only below a low strength floor.
 *  3. `findRedundantSkills` / `mergeSkills` — the catalog tax. Merge by *measured*
 *     similarity, but only ever into an existing skill directory, and report every
 *     merge rather than acting silently.
 *  4. `purgeTrash` — reclaim disk.
 *
 * Every step is idempotent and reports what it did, because a "cleanup" that
 * cannot say what it removed is indistinguishable from a bug that deletes memory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { paths, readSkillIndex, readMemoryIndex, removeSkill, purgeTrash, dirSize } from './memory-store.js';
import { readFacts, writeFacts, similarity, strengthOf, MERGE_THRESHOLD } from './facts.js';
import { buildTopics, pruneTopics, consolidateTopics } from './consolidate.js';

/**
 * How similar two live facts must be before one is retired.
 *
 * **Deliberately far above the write-time merge threshold (0.5).** Calibrated on a
 * real 1,732-fact ledger, printed with the texts by `scripts/dupecalibrate.mjs`:
 *
 *   >= 0.75  true restatements — e.g. 0.914 「网格淡出改为逐顶点、每条线切 14 段
 *            —— ImmediateMesh 单段线只能取一个亮度…」 vs 「淡出改为逐顶点（每条线
 *            切 14 段），因为 ImmediateMesh 两点线只能取单一亮度…」
 *   <= 0.51  *different* facts that merely share vocabulary — e.g. 0.510 「把代码
 *            注释里的历史断言与 git 提交版本对质」 vs 「会话未提供 git 是否可用的
 *            信息」
 *
 * The write pipeline may accept 0.5 because a false positive there costs one
 * merged fact at write time and the user can see it. A housekeeping pass that runs
 * unattended must not gamble on that band: merging two genuinely different facts
 * destroys information *silently*. So the floor sits at the bottom of the measured
 * restatement band, where the choice is no longer a judgement call.
 */
export const FACT_DEDUPE_THRESHOLD = 0.75;

/**
 * Strength below which a fast-decaying fact is considered stale.
 *
 * Must sit **above** the corroboration floor, and that is the whole subtlety:
 * `strengthOf` awards `min(0.25, log2(1 + sources) * 0.1)`, so even a maximally
 * decayed fact with one source scores ≈0.1. A floor at 0.05 is therefore
 * *unreachable* — `pruneStaleFacts` would be dead code that reports "0 stale"
 * forever. 0.13 clears the one-source floor with margin while staying well below
 * a fresh fact (≈0.85), so only genuinely decayed rows qualify.
 */
export const STALE_FLOOR = 0.13;

/**
 * Kinds safe to prune on age alone.
 *
 * Only `open`. An open question that has decayed for months is either answered or
 * abandoned, and its half-life is 21 days — so this is genuinely stale. A decision
 * or preference at the same age is still the reason things are the way they are.
 */
const PRUNABLE_KINDS = new Set(['open']);

/**
 * Skill-pair similarity worth flagging.
 *
 * Measured: genuinely duplicate skill pairs (two sessions teaching the same
 * lesson) landed at 0.40–0.55, unrelated ones at ≤0.13. The catalog is enormous
 * relative to this signal, so the floor is set at the bottom of the measured
 * duplicate band rather than at the fact threshold.
 */
export const SKILL_REDUNDANCY_THRESHOLD = 0.4;

/**
 * Skill pairs treated as the same skill outright.
 *
 * Must sit at or below the *strongest measured duplicate pair*, or `mergeable`
 * becomes unreachable and the merge action is dead code that always reports
 * "reported" — caught exactly this way by a mutation that raised it to 0.99.
 * The real catalog's strongest duplicates measured 0.548 and 0.538 (and the
 * git-commit pair at 0.517), so 0.51 keeps the action reachable for real pairs
 * while staying inside the measured duplicate band (0.40–0.55); unrelated skills
 * measure ≤0.13. Merging is additionally gated behind its own explicit switch,
 * because it changes the agent's visible catalog: the gate that matters is
 * consent, not this number.
 */
export const SKILL_MERGE_THRESHOLD = 0.51;

function skillText(entry) {
  return `${entry.slug ?? ''} ${entry.description ?? ''} ${entry.title ?? ''}`;
}

/** Chars of skill name+description injected into every session prompt. */
export function catalogCost(skillIndex) {
  let chars = 0;
  for (const entry of Object.values(skillIndex.entries ?? {})) {
    chars += String(entry.slug ?? '').length + String(entry.description ?? '').length;
  }
  return { skills: Object.keys(skillIndex.entries ?? {}).length, chars, tokens: Math.round(chars / 3.5) };
}

/**
 * Pairs of skills that look like the same lesson learned twice.
 *
 * Reported, not merged: which of two similar skills is the better home is a
 * judgement call, so the caller decides. `mergeSkills` is the explicit action.
 */
export function findRedundantSkills(skillIndex, { threshold = SKILL_REDUNDANCY_THRESHOLD } = {}) {
  const list = Object.entries(skillIndex.entries ?? {}).map(([slug, entry]) => ({ slug, ...entry }));
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const score = similarity(skillText(list[i]), skillText(list[j]));
      if (score < threshold) continue;
      // The one with more accumulated detail is the natural survivor.
      const weightOf = (entry) => (entry.steps?.length ?? 0) + (entry.pitfalls?.length ?? 0) + (entry.sources?.length ?? 0);
      const [keep, drop] = weightOf(list[i]) >= weightOf(list[j]) ? [list[i], list[j]] : [list[j], list[i]];
      pairs.push({ score: Number(score.toFixed(3)), keep: keep.slug, drop: drop.slug, mergeable: score >= SKILL_MERGE_THRESHOLD });
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}

/**
 * Group near-duplicate live facts and retire all but the strongest of each group.
 *
 * Union-find over the measured pairs so a chain of three similar facts collapses
 * to one survivor instead of two overlapping merges. The survivor is the row with
 * the highest strength (recency + corroboration + use), because that is the one a
 * retrieval would have surfaced anyway.
 */
export function mergeFacts(ledger, { threshold = FACT_DEDUPE_THRESHOLD, now = Date.now(), apply = true } = {}) {
  const live = ledger.facts.filter((fact) => !fact.validUntil);
  const parent = new Map(live.map((fact) => [fact.id, fact.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression keeps repeated lookups cheap on a 1.7k-fact ledger.
    let walk = id;
    while (parent.get(walk) !== root) { const next = parent.get(walk); parent.set(walk, root); walk = next; }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  let compared = 0;
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      compared += 1;
      // Same kind only. A `decision` and a `fact` can describe one event yet carry
      // different standing — "we decided X" is not the same as "X is true" — and
      // the write pipeline draws the same line (it only NOOPs across equal kinds).
      // Merging across kinds would silently promote or demote a decision.
      if (live[i].kind !== live[j].kind) continue;
      if (similarity(live[i].text, live[j].text) >= threshold) union(live[i].id, live[j].id);
    }
  }

  const groups = new Map();
  for (const fact of live) {
    const root = find(fact.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(fact);
  }

  const merged = [];
  let retired = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ranked = members.slice().sort((a, b) => strengthOf(b, now) - strengthOf(a, now) || String(a.id).localeCompare(String(b.id)));
    const survivor = ranked[0];
    for (const loser of ranked.slice(1)) {
      merged.push({ kept: survivor.id, retired: loser.id, text: String(loser.text ?? '').slice(0, 80) });
      // Counted whether or not we are applying: a dry run whose report says
      // "84 duplicate groups, 0 to retire" is worse than no report at all.
      retired += 1;
      if (!apply) continue;
      // Supersede rather than delete: the row stays with validUntil, so this is
      // inspectable and "what did we believe then" remains answerable.
      loser.validUntil = new Date(now).toISOString();
      loser.supersededBy = survivor.id;
      loser.supersededReason = 'self-check duplicate';
      // Merge corroboration: a statement confirmed by two sessions is stronger
      // than either alone, and losing that on merge would weaken the survivor.
      survivor.sources = [...new Set([...(survivor.sources ?? []), ...(loser.sources ?? [])])];
    }
  }
  return { groups: merged.length, retired, merged, compared };
}

/**
 * Retire open questions that have decayed past usefulness.
 *
 * Conservative by construction: one kind, a 0.05 floor (an `open` fact reaches it
 * only after ~6 half-lives ≈ 4 months), and the same supersede-not-delete rule.
 */
export function pruneStaleFacts(ledger, { floor = STALE_FLOOR, now = Date.now(), apply = true } = {}) {
  const stale = [];
  for (const fact of ledger.facts) {
    if (fact.validUntil) continue;
    if (!PRUNABLE_KINDS.has(fact.kind)) continue;
    if (strengthOf(fact, now) >= floor) continue;
    stale.push({ id: fact.id, kind: fact.kind, strength: Number(strengthOf(fact, now).toFixed(3)), text: String(fact.text ?? '').slice(0, 80) });
    if (!apply) continue;
    fact.validUntil = new Date(now).toISOString();
    fact.supersededReason = 'self-check stale';
  }
  return { pruned: stale.length, stale, floor };
}

/**
 * Fold redundant skills into their survivors.
 *
 * `mergeSkills` copies the loser's distinct steps/pitfalls into the survivor and
 * then removes the loser via `removeSkill`, which also un-publishes our mirrored
 * copy but leaves a user's own same-named skill alone. Reported per pair, because
 * a silent skill deletion is exactly the kind of thing that erodes trust.
 */
export async function mergeSkills(storeRoot, skillIndex, pairs, { apply = false } = {}) {
  const outcomes = [];
  const removed = new Set();
  for (const pair of pairs) {
    if (!pair.mergeable) {
      outcomes.push({ ...pair, action: 'reported' });
      continue;
    }
    if (removed.has(pair.drop) || removed.has(pair.keep)) continue;
    const keepEntry = skillIndex.entries[pair.keep];
    const dropEntry = skillIndex.entries[pair.drop];
    if (!keepEntry || !dropEntry) {
      // Report rather than silently skip: a pair naming an entry that is gone is
      // itself worth surfacing, and silently dropping it would let the same stale
      // pair reappear on every pass while the summary claims nothing was found.
      outcomes.push({ ...pair, action: 'missing-entry' });
      continue;
    }
    if (!apply) {
      outcomes.push({ ...pair, action: 'would-merge' });
      continue;
    }
    // Merge the *data* through the normal write path so dedupe semantics hold.
    const { writeSkill } = await import('./memory-store.js');
    await writeSkill(storeRoot, {
      slug: keepEntry.slug,
      title: keepEntry.title,
      description: keepEntry.description,
      whenToUse: keepEntry.whenToUse,
      steps: [...(keepEntry.steps ?? []), ...(dropEntry.steps ?? [])],
      pitfalls: [...(keepEntry.pitfalls ?? []), ...(dropEntry.pitfalls ?? [])],
      verification: [...(keepEntry.verification ?? []), ...(dropEntry.verification ?? [])],
    }, { sessionId: null });
    const result = await removeSkill(storeRoot, pair.drop);
    removed.add(pair.drop);
    outcomes.push({ ...pair, action: 'merged', mirrorRemoved: result.mirrorRemoved === true });
  }
  return outcomes;
}

/**
 * Run the whole self-check: a read-only diagnosis, then the chosen repairs.
 *
 * `apply: false` is the default everywhere so the panel can show the plan before
 * anything changes; `prune` and `merge` are separate switches because they differ
 * in risk (facts are already historical, skills are user-visible).
 */
export async function selfCheck(storeRoot, {
  apply = false,
  mergeFacts: doMergeFacts = true,
  pruneStale = true,
  mergeSkillDuplicates = false,
  purgeTrash: doPurgeTrash = false,
  now = Date.now(),
} = {}) {
  const p = paths(storeRoot);
  const ledger = await readFacts(storeRoot);
  const skillIndex = await readSkillIndex(storeRoot);
  const memoryIndex = await readMemoryIndex(storeRoot);

  const factsBefore = {
    live: ledger.facts.filter((fact) => !fact.validUntil).length,
    invalidated: ledger.facts.filter((fact) => fact.validUntil).length,
    topics: (ledger.topics ?? []).length,
  };

  const factMerge = doMergeFacts ? mergeFacts(ledger, { now, apply }) : { groups: 0, retired: 0, merged: [], compared: 0 };
  const stale = pruneStale ? pruneStaleFacts(ledger, { now, apply }) : { pruned: 0, stale: [] };
  const redundantSkills = findRedundantSkills(skillIndex);
  const ledgerChanged = factMerge.retired > 0 || stale.pruned > 0;

  let topicsRebuilt = null;
  if (ledgerChanged && apply) {
    // Topics are a pure function of the facts, so retiring facts requires a
    // rebuild or the ledger keeps citing rows it just invalidated.
    pruneTopics(ledger);
    ledger.topics = buildTopics(ledger, { subjectOf: memorySubjectFactResolver(memoryIndex) });
    await writeFacts(storeRoot, ledger);
    topicsRebuilt = ledger.topics.length;
  } else if (ledgerChanged) {
    topicsRebuilt = 0;
  }

  const skillMerges = await mergeSkills(storeRoot, skillIndex, redundantSkills, { apply: apply && mergeSkillDuplicates });

  let trash = null;
  if (doPurgeTrash && apply) {
    const result = await purgeTrash(storeRoot);
    trash = { purged: 'all', freed: result?.freed ?? 0, pendingBytes: 0 };
  } else {
    const size = await dirSize(p.trash).catch(() => 0);
    trash = { purged: 0, freed: 0, pendingBytes: size };
  }

  const factsAfter = await readFacts(storeRoot);
  const after = {
    live: factsAfter.facts.filter((fact) => !fact.validUntil).length,
    invalidated: factsAfter.facts.filter((fact) => fact.validUntil).length,
    topics: (factsAfter.topics ?? []).length,
  };

  return {
    ok: true,
    applied: apply === true,
    facts: {
      before: factsBefore,
      after,
      duplicateGroups: factMerge.groups,
      retiredDuplicates: factMerge.retired,
      pairsCompared: factMerge.compared,
      stalePruned: stale.pruned,
      merged: factMerge.merged.slice(0, 24),
      stale: stale.stale.slice(0, 24),
      topicsRebuilt,
    },
    skills: {
      catalog: catalogCost(skillIndex),
      redundant: redundantSkills.slice(0, 24),
      redundantCount: redundantSkills.length,
      merges: skillMerges,
    },
    memories: { count: Object.keys(memoryIndex.entries ?? {}).length },
    trash,
  };
}

/** Resolve a fact's subject from the memory that produced it (same rule as the panel). */
function memorySubjectFactResolver(memoryIndex) {
  return (fact) => {
    const sources = Array.isArray(fact?.sources) && fact.sources.length > 0
      ? fact.sources
      : (fact?.source ? [fact.source] : []);
    for (const id of sources) {
      const entry = memoryIndex.entries?.[id];
      if (entry?.title) return entry.title;
    }
    return '';
  };
}
