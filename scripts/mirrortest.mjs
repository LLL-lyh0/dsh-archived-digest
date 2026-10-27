/**
 * Verify the delivery surface: a distilled skill must be visible to the rest of
 * the harness, not just to this plugin's own panel.
 *
 * The skills center scans `$DSH_HOME/skills`. If we only wrote into
 * `$DSH_HOME/archived-digest/skills`, the panel would happily list skills that
 * the agent could never load — and nothing would report an error. This test
 * pins that path down, and pins the guard that keeps us from overwriting a
 * skill the user wrote by hand.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Point DSH_HOME at a scratch directory BEFORE importing the store, so nothing
// here can touch the real `~/.dsh/skills`.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-mirror-'));
process.env.DSH_HOME = sandbox;

const store = await import('../lib/memory-store.js');
const { parseSkillDoc } = await import('file:///C:/Users/TGL/.dsh/profiles/desktop/node_modules/@michengai/dsh-skills-manager/lib/core.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const storeRoot = path.join(sandbox, 'archived-digest');
const mirrorRoot = path.join(sandbox, 'skills');

check('the mirror root follows DSH_HOME', store.skillMirrorRoot() === mirrorRoot, store.skillMirrorRoot());

const skill = {
  slug: 'decode-multiframe-zstd',
  title: 'Decode multi-frame zstd logs',
  description: 'Split the file on the magic bytes before decompressing.',
  steps: ['Read the file as a Buffer.', 'Decompress each frame.'],
  pitfalls: ['One call returns only the first frame.'],
  verification: ['The joined text has several JSONL lines.'],
};
const written = await store.writeSkill(storeRoot, skill, { sessionId: 'session-1' });
check('writing a skill also publishes it', written.mirror?.error === null, JSON.stringify(written.mirror));

const mirroredFile = path.join(mirrorRoot, skill.slug, 'SKILL.md');
const mirroredText = await fs.readFile(mirroredFile, 'utf8').catch(() => null);
check('the published SKILL.md exists under $DSH_HOME/skills', mirroredText !== null, mirroredFile);
check('the published copy carries the ownership marker', mirroredText?.includes(store.MIRROR_MARKER) === true, 'marker');

const parsed = parseSkillDoc(mirroredText ?? '');
check('the skills center can parse the published copy', parsed.hasFrontmatter === true && parsed.map.name === skill.slug,
  `name=${JSON.stringify(parsed.map.name)}`);
check('the published copy keeps its description', typeof parsed.map.description === 'string' && parsed.map.description.length > 0,
  JSON.stringify(String(parsed.map.description).slice(0, 50)));

// Updating a skill republishes it and accumulates, rather than duplicating.
const again = await store.writeSkill(storeRoot, { ...skill, steps: ['A new distinct step.'], pitfalls: [] }, { sessionId: 'session-2' });
check('a re-digest updates the published copy', again.mirror?.error === null, JSON.stringify(again.mirror));
const updated = await fs.readFile(mirroredFile, 'utf8');
check('accumulated steps land in the published copy', updated.includes('A new distinct step.') && updated.includes('Read the file as a Buffer.'), 'both steps');
check('sources accumulate across sessions', updated.includes('session-1') && updated.includes('session-2'), 'both sources');

// The user's own skill must never be overwritten — and we must not fail loudly
// enough to lose the memory, just report the collision.
const occupiedSlug = 'my-handwritten-skill';
await fs.mkdir(path.join(mirrorRoot, occupiedSlug), { recursive: true });
await fs.writeFile(path.join(mirrorRoot, occupiedSlug, 'SKILL.md'), '---\nname: my-handwritten-skill\ndescription: Mine.\n---\n\nHand written.\n', 'utf8');
const collision = await store.writeSkill(storeRoot, { slug: occupiedSlug, title: 'x', description: 'y', steps: ['z'] }, { sessionId: 'session-3' });
check('a user-owned skill is not overwritten', collision.mirror?.error === 'MIRROR_OCCUPIED', JSON.stringify(collision.mirror));
const untouched = await fs.readFile(path.join(mirrorRoot, occupiedSlug, 'SKILL.md'), 'utf8');
check('the user-owned skill keeps its text', untouched.includes('Hand written.'), 'preserved');
check('the collision still records the skill in our own store', collision.entry?.slug === occupiedSlug, 'indexed');

// Removal must clean up our copy but leave the user's alone.
await store.removeSkill(storeRoot, skill.slug);
const gone = await fs.readFile(mirroredFile, 'utf8').catch(() => null);
check('removing a skill unpublishes it', gone === null, 'removed');
await store.removeSkill(storeRoot, occupiedSlug);
const kept = await fs.readFile(path.join(mirrorRoot, occupiedSlug, 'SKILL.md'), 'utf8').catch(() => null);
check('removing our record leaves the user skill in place', kept !== null && kept.includes('Hand written.'), 'preserved');

await fs.rm(sandbox, { recursive: true, force: true });
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${failed.length === 0 ? 'all' : failed.length + ' of'} ${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
