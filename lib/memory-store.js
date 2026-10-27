/**
 * Where digests land.
 *
 * Layout under `<storeRoot>` (default `$DSH_HOME/archived-digest`):
 *
 *   memories/<session-id>.md     one memory per archived session (1:1, never merges)
 *   memories/index.json          ledger of every memory, so the panel never has to
 *                                re-read or re-parse 77 markdown files
 *   skills/<name>/SKILL.md       reusable skills, frontmatter-compatible with
 *                                @michengai/dsh-skills-manager
 *   skills/index.json            ledger + a dedupe record (which sessions fed which skill)
 *   trash/<session-id>-<ts>/     quarantined session dirs, when cleanup uses trash mode
 *
 * Memories are per-session on purpose: merging two unrelated sessions into one
 * file loses the "which conversation said this" provenance that makes a memory
 * worth reading later. Skills are the opposite — several sessions often teach the
 * same lesson, so skills dedupe by name and accumulate their sources.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const TMP_SUFFIX = '.tmp-archived-digest';

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function defaultStoreRoot() {
  return path.join(resolveDshHome(), 'archived-digest');
}

/**
 * Where the rest of the harness looks for skills.
 *
 * `@michengai/dsh-skills-manager` scans `$DSH_HOME/skills` (source key "dsh"),
 * and the agent's own skill catalog is built from that same scan. A skill that
 * lives only inside this plugin's store is therefore invisible: it is listed in
 * our panel and nowhere else. So every skill is mirrored here.
 *
 * The store stays the source of truth (it carries the ledger, the sources and
 * the dedupe history); this directory is the delivery surface.
 */
export function skillMirrorRoot() {
  const override = process.env.DSH_ARCHIVED_DIGEST_SKILLS;
  if (override !== undefined && String(override).trim() !== '') return path.resolve(String(override));
  return path.join(resolveDshHome(), 'skills');
}

/** Marks a mirrored SKILL.md as ours, so we never delete a user's own skill. */
export const MIRROR_MARKER = '<!-- dsh-archived-digest:mirror -->';

export function paths(storeRoot) {
  const root = storeRoot && String(storeRoot).trim() !== '' ? path.resolve(String(storeRoot)) : defaultStoreRoot();
  return {
    root,
    memories: path.join(root, 'memories'),
    skills: path.join(root, 'skills'),
    trash: path.join(root, 'trash'),
    memoryIndex: path.join(root, 'memories', 'index.json'),
    skillIndex: path.join(root, 'skills', 'index.json'),
  };
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

/** Write via `tmp` + `rename` so a crash mid-write cannot truncate a ledger. */
async function writeFileAtomic(target, content) {
  await ensureDir(path.dirname(target));
  const tmp = `${target}${TMP_SUFFIX}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, target);
}

async function readJsonOr(target, fallback) {
  try {
    const text = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function ensureStore(storeRoot) {
  const p = paths(storeRoot);
  await ensureDir(p.memories);
  await ensureDir(p.skills);
  await ensureDir(p.trash);
  return p;
}

/** Safe, collision-free file stem for a session id. */
export function sessionSlug(sessionId) {
  const raw = String(sessionId ?? '').trim();
  const slug = raw.replace(/^session-/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'unknown' : slug.slice(0, 120);
}

const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Skill directory names must survive as-is: the skills manager derives a name
 * from the directory and rejects anything outside kebab-case.
 */
export function skillSlug(name) {
  const kebab = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  const trimmed = kebab.slice(0, 60).replace(/-+$/g, '');
  if (trimmed !== '' && KEBAB_RE.test(trimmed)) return trimmed;
  const fallback = `skill-${Date.now().toString(36)}`;
  return KEBAB_RE.test(fallback) ? fallback : 'skill-digest';
}

function yamlScalar(value) {
  const s = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  // Quote whenever the raw text could be misread as YAML structure.
  if (s === '') return '""';
  if (/^[A-Za-z0-9][A-Za-z0-9 _.,:/()'"-]*$/.test(s) && !/^(true|false|null|yes|no|\d+)$/i.test(s)) return s;
  return JSON.stringify(s);
}

export function buildMemoryMarkdown(record) {
  const lines = [
    '---',
    `title: ${yamlScalar(record.title)}`,
    `session-id: ${yamlScalar(record.sessionId)}`,
    `source: archived-digest`,
  ];
  if (record.workspace) lines.push(`workspace: ${yamlScalar(record.workspace)}`);
  if (record.cwd) lines.push(`cwd: ${yamlScalar(record.cwd)}`);
  if (record.createdAt) lines.push(`session-created: ${yamlScalar(record.createdAt)}`);
  lines.push(`digested-at: ${yamlScalar(record.digestedAt)}`);
  if (record.turns !== undefined) lines.push(`turns: ${Number(record.turns) || 0}`);
  if (record.bytes !== undefined) lines.push(`log-bytes: ${Number(record.bytes) || 0}`);
  const tags = Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '') : [];
  lines.push(`tags: [${tags.map((tag) => yamlScalar(tag)).join(', ')}]`);
  lines.push('---', '');
  lines.push(`# ${record.title}`, '');
  if (record.summary) lines.push(record.summary.trim(), '');
  const decisions = Array.isArray(record.decisions) ? record.decisions.filter(Boolean) : [];
  if (decisions.length > 0) {
    lines.push('## Key decisions', '');
    for (const item of decisions) lines.push(`- ${String(item).trim()}`);
    lines.push('');
  }
  const facts = Array.isArray(record.facts) ? record.facts.filter(Boolean) : [];
  if (facts.length > 0) {
    lines.push('## Facts worth keeping', '');
    for (const item of facts) lines.push(`- ${String(item).trim()}`);
    lines.push('');
  }
  const open = Array.isArray(record.openIssues) ? record.openIssues.filter(Boolean) : [];
  if (open.length > 0) {
    lines.push('## Left unresolved', '');
    for (const item of open) lines.push(`- ${String(item).trim()}`);
    lines.push('');
  }
  if (Array.isArray(record.toolNames) && record.toolNames.length > 0) {
    lines.push('## Tools exercised', '', record.toolNames.slice(0, 24).join(', '), '');
  }
  /**
   * Earlier segments of a live session.
   *
   * A live session is digested repeatedly as it grows, and each pass only sees the
   * events since the last cursor. The newest summary is the body above; the
   * segments before it are kept here, because overwriting them would mean the
   * first hour of a conversation disappears from memory the moment it is extended.
   * An archived session has one pass and therefore no history.
   */
  const history = Array.isArray(record.history) ? record.history.filter(Boolean) : [];
  if (history.length > 0) {
    lines.push(`## Earlier updates (${history.length})`, '');
    for (const item of history.slice().reverse()) {
      const range = Number.isFinite(item.fromSeq) && Number.isFinite(item.toSeq)
        ? `seq ${item.fromSeq}–${item.toSeq}`
        : 'seq unknown';
      lines.push(`### ${item.at ? String(item.at).slice(0, 19).replace('T', ' ') : 'earlier'} · ${range}`, '');
      if (item.summary) lines.push(String(item.summary).trim(), '');
      for (const decision of (item.decisions ?? []).slice(0, 8)) lines.push(`- 决定：${String(decision).trim()}`);
      for (const fact of (item.facts ?? []).slice(0, 12)) lines.push(`- 事实：${String(fact).trim()}`);
      for (const open of (item.openIssues ?? []).slice(0, 8)) lines.push(`- 待办：${String(open).trim()}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function readMemoryIndex(storeRoot) {
  const p = paths(storeRoot);
  const index = await readJsonOr(p.memoryIndex, null);
  if (!index || typeof index.entries !== 'object' || index.entries === null) {
    return { version: 1, updatedAt: null, entries: {} };
  }
  return { version: 1, updatedAt: index.updatedAt ?? null, entries: { ...index.entries } };
}

export async function writeMemory(storeRoot, record) {
  const p = await ensureStore(storeRoot);
  const slug = sessionSlug(record.sessionId);
  const file = path.join(p.memories, `${slug}.md`);
  const markdown = buildMemoryMarkdown(record);
  await writeFileAtomic(file, markdown);

  const index = await readMemoryIndex(storeRoot);
  const history = Array.isArray(record.history) ? record.history : [];
  index.entries[record.sessionId] = {
    sessionId: record.sessionId,
    title: record.title,
    file: path.relative(p.root, file).split(path.sep).join('/'),
    workspace: record.workspace ?? null,
    cwd: record.cwd ?? null,
    sessionCreatedAt: record.createdAt ?? null,
    digestedAt: record.digestedAt,
    turns: Number(record.turns) || 0,
    bytes: Number(record.bytes) || 0,
    chars: markdown.length,
    tags: Array.isArray(record.tags) ? record.tags : [],
    summary: record.summary ?? '',
    skills: Array.isArray(record.skillRefs) ? record.skillRefs : [],
    cleaned: record.cleaned ?? null,
    // Live sessions are digested more than once; the panel needs to show how many
    // passes a memory has had and confirm the earlier ones are still in the file.
    live: record.live === true,
    segments: history.length + 1,
    // Seq coverage, so "is this memory up to date with the conversation" is
    // answerable from the index alone.
    fromSeq: record.fromSeq ?? null,
    toSeq: record.toSeq ?? null,
  };
  index.updatedAt = new Date().toISOString();
  await writeFileAtomic(p.memoryIndex, `${JSON.stringify(index, null, 2)}\n`);
  return { file, entry: index.entries[record.sessionId], index };
}

export async function removeMemory(storeRoot, sessionId) {
  const p = paths(storeRoot);
  const index = await readMemoryIndex(storeRoot);
  const entry = index.entries[sessionId];
  if (!entry) return { removed: false };
  await fs.rm(path.join(p.memories, `${sessionSlug(sessionId)}.md`), { force: true });
  delete index.entries[sessionId];
  index.updatedAt = new Date().toISOString();
  await writeFileAtomic(p.memoryIndex, `${JSON.stringify(index, null, 2)}\n`);
  return { removed: true };
}

export async function readSkillIndex(storeRoot) {
  const p = paths(storeRoot);
  const index = await readJsonOr(p.skillIndex, null);
  if (!index || typeof index.entries !== 'object' || index.entries === null) {
    return { version: 1, updatedAt: null, entries: {} };
  }
  return { version: 1, updatedAt: index.updatedAt ?? null, entries: { ...index.entries } };
}

export function buildSkillMarkdown(skill) {
  const lines = [
    '---',
    `name: ${yamlScalar(skill.slug)}`,
    `description: ${yamlScalar(skill.description)}`,
    '---',
    '',
    `# ${skill.title || skill.slug}`,
    '',
  ];
  if (skill.whenToUse) lines.push('## When to use', '', skill.whenToUse.trim(), '');
  if (skill.steps?.length) {
    lines.push('## Steps', '');
    for (const step of skill.steps) lines.push(`- ${String(step).trim()}`);
    lines.push('');
  }
  if (skill.pitfalls?.length) {
    lines.push('## Pitfalls', '');
    for (const item of skill.pitfalls) lines.push(`- ${String(item).trim()}`);
    lines.push('');
  }
  if (skill.verification?.length) {
    lines.push('## How to verify it worked', '');
    for (const item of skill.verification) lines.push(`- ${String(item).trim()}`);
    lines.push('');
  }
  lines.push('---', '');
  lines.push(`_Distilled by dsh-archived-digest from: ${(skill.sources ?? []).join(', ') || 'unknown'}._`);
  return lines.join('\n');
}

/**
 * Create or update one skill.
 *
 * Same-name skills accumulate rather than overwrite: the body of the first
 * digest stays the canonical text, and later sessions contribute only their
 * distinct steps/pitfalls, so repeated digesting cannot bloat a skill with
 * duplicates.
 */
export async function writeSkill(storeRoot, skill, { sessionId, allowOverwrite = true } = {}) {
  const p = await ensureStore(storeRoot);
  const slug = skillSlug(skill.slug || skill.name || skill.title);
  const dir = path.join(p.skills, slug);
  const file = path.join(dir, 'SKILL.md');
  const index = await readSkillIndex(storeRoot);
  const existing = index.entries[slug];

  let merged;
  if (existing) {
    const prior = {
      slug,
      title: existing.title,
      description: existing.description,
      whenToUse: existing.whenToUse ?? '',
      steps: Array.isArray(existing.steps) ? [...existing.steps] : [],
      pitfalls: Array.isArray(existing.pitfalls) ? [...existing.pitfalls] : [],
      verification: Array.isArray(existing.verification) ? [...existing.verification] : [],
      sources: Array.isArray(existing.sources) ? [...existing.sources] : [],
    };
    if (!allowOverwrite) {
      return { created: false, skipped: true, slug, entry: existing };
    }
    const dedupe = (base, extra) => {
      const seen = new Set(base.map((item) => String(item).trim().toLowerCase()));
      const added = [];
      for (const item of extra ?? []) {
        const key = String(item).trim().toLowerCase();
        if (key === '' || seen.has(key)) continue;
        seen.add(key);
        added.push(String(item).trim());
      }
      return [...base, ...added];
    };
    merged = {
      ...prior,
      // A richer description from the newer digest is worth taking; a shorter
      // one usually means the model got lazy.
      description: (skill.description ?? '').length > prior.description.length ? skill.description : prior.description,
      whenToUse: (skill.whenToUse ?? '').trim() !== '' ? skill.whenToUse : prior.whenToUse,
      steps: dedupe(prior.steps, skill.steps),
      pitfalls: dedupe(prior.pitfalls, skill.pitfalls),
      verification: dedupe(prior.verification, skill.verification),
      sources: dedupe(prior.sources, sessionId ? [sessionId] : []),
      updatedAt: new Date().toISOString(),
      createdAt: existing.createdAt ?? new Date().toISOString(),
    };
  } else {
    merged = {
      slug,
      title: skill.title || slug,
      description: skill.description ?? '',
      whenToUse: skill.whenToUse ?? '',
      steps: Array.isArray(skill.steps) ? skill.steps.map((s) => String(s).trim()).filter(Boolean) : [],
      pitfalls: Array.isArray(skill.pitfalls) ? skill.pitfalls.map((s) => String(s).trim()).filter(Boolean) : [],
      verification: Array.isArray(skill.verification) ? skill.verification.map((s) => String(s).trim()).filter(Boolean) : [],
      sources: sessionId ? [sessionId] : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // The skills manager reports `diagnostic.description.missing` as an error, so
  // never emit a skill without one.
  if (String(merged.description ?? '').trim() === '') {
    merged.description = `Distilled from archived session ${sessionId ?? merged.sources[0] ?? 'unknown'}`;
  }

  await writeFileAtomic(file, buildSkillMarkdown(merged));
  const mirror = await mirrorSkill(slug, merged);
  index.entries[slug] = {
    ...merged,
    file: path.relative(p.root, file).split(path.sep).join('/'),
    mirror: mirror.path,
    mirrorError: mirror.error ?? null,
  };
  index.updatedAt = new Date().toISOString();
  await writeFileAtomic(p.skillIndex, `${JSON.stringify(index, null, 2)}\n`);
  return { created: !existing, slug, entry: index.entries[slug], mirror };
}

/**
 * Publish a skill into `$DSH_HOME/skills` so the skills center and the agent's
 * catalog can see it.
 *
 * Deliberately non-fatal: a failure here (read-only home, a name collision with
 * a real user skill) must not lose the memory the digest already produced. The
 * caller records the error and the panel surfaces it.
 */
async function mirrorSkill(slug, skill) {
  const root = skillMirrorRoot();
  const target = path.join(root, slug);
  const file = path.join(target, 'SKILL.md');
  try {
    // Never clobber a skill the user wrote by hand: only touch a directory we
    // created (detected by our marker) or an empty/absent one.
    const existing = await fs.readFile(file, 'utf8').catch(() => null);
    if (existing !== null && !existing.includes(MIRROR_MARKER)) {
      return { path: null, error: 'MIRROR_OCCUPIED' };
    }
    const body = `${buildSkillMarkdown(skill)}\n\n${MIRROR_MARKER}\n`;
    await writeFileAtomic(file, body);
    return { path: file, error: null };
  } catch (error) {
    return { path: null, error: String(error?.message ?? error) };
  }
}

export async function removeSkill(storeRoot, slug) {
  const p = paths(storeRoot);
  const index = await readSkillIndex(storeRoot);
  if (!index.entries[slug]) return { removed: false };
  await fs.rm(path.join(p.skills, slug), { recursive: true, force: true });
  // Drop the published copy too — but only if it is ours, so a user skill that
  // happens to share the name survives.
  let mirrorRemoved = false;
  const mirrorFile = path.join(skillMirrorRoot(), slug, 'SKILL.md');
  const mirrored = await fs.readFile(mirrorFile, 'utf8').catch(() => null);
  if (mirrored !== null && mirrored.includes(MIRROR_MARKER)) {
    await fs.rm(path.join(skillMirrorRoot(), slug), { recursive: true, force: true }).catch(() => {});
    mirrorRemoved = true;
  }
  delete index.entries[slug];
  index.updatedAt = new Date().toISOString();
  await writeFileAtomic(p.skillIndex, `${JSON.stringify(index, null, 2)}\n`);
  return { removed: true, mirrorRemoved };
}

/** Directory size in bytes, without following symlinks. */
export async function dirSize(target) {
  let total = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else {
        const stat = await statOrNull(full);
        if (stat) total += stat.size;
      }
    }
  };
  await walk(target);
  return total;
}

export async function storeStats(storeRoot) {
  const p = paths(storeRoot);
  const memoryIndex = await readMemoryIndex(storeRoot);
  const skillIndex = await readSkillIndex(storeRoot);
  const memoryEntries = Object.values(memoryIndex.entries);
  return {
    root: p.root,
    exists: (await statOrNull(p.root)) !== null,
    memories: memoryEntries.length,
    skills: Object.keys(skillIndex.entries).length,
    memoryBytes: await dirSize(p.memories),
    skillBytes: await dirSize(p.skills),
    trashBytes: await dirSize(p.trash),
    lastDigestAt: memoryIndex.updatedAt,
    lastSkillUpdateAt: skillIndex.updatedAt,
    digestedSessions: memoryEntries.map((entry) => entry.sessionId),
  };
}

/**
 * Reclaim the disk space an archived session log occupies.
 *
 * `mode: 'logs'` deletes only the `.zstd` payloads (the session directory and
 * its metadata survive, so the archived entry does not turn into a dangling id).
 * `mode: 'dir'` removes the whole directory and is only safe when the caller has
 * already dropped the session from the archive list.
 */
export async function cleanSessionLogs(sessionDir, { mode = 'logs', storeRoot } = {}) {
  const before = await dirSize(sessionDir);
  if (mode === 'dir') {
    await fs.rm(sessionDir, { recursive: true, force: true });
    return { freed: before, mode, target: sessionDir };
  }
  let freed = 0;
  const removed = [];
  let entries;
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true });
  } catch {
    return { freed: 0, mode, removed };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.zstd$/i.test(entry.name)) continue;
    const full = path.join(sessionDir, entry.name);
    const stat = await statOrNull(full);
    const size = stat?.size ?? 0;
    // Keep a marker so a later pass can tell "cleaned" apart from "never existed".
    await fs.writeFile(path.join(sessionDir, '.archived-digest-cleaned'), new Date().toISOString(), 'utf8').catch(() => {});
    await fs.rm(full, { force: true });
    freed += size;
    removed.push({ name: entry.name, bytes: size });
  }
  void storeRoot;
  return { freed, mode, removed, before };
}

/** Move (not delete) a session directory into the store's trash, for undoability. */
export async function trashSessionDir(sessionDir, { storeRoot } = {}) {
  const p = await ensureStore(storeRoot);
  const before = await dirSize(sessionDir);
  const name = `${sessionSlug(path.basename(sessionDir))}-${Date.now()}`;
  const target = path.join(p.trash, name);
  try {
    await fs.rename(sessionDir, target);
  } catch {
    // Cross-device rename: fall back to copy-then-remove.
    await fs.cp(sessionDir, target, { recursive: true });
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
  return { freed: before, mode: 'trash', target };
}

export async function purgeTrash(storeRoot) {
  const p = paths(storeRoot);
  const size = await dirSize(p.trash);
  await fs.rm(p.trash, { recursive: true, force: true });
  await ensureDir(p.trash);
  return { freed: size };
}
