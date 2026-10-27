/**
 * Integration check: the skills we emit must be readable by the skills-center
 * plugin that actually lists them. That plugin has its own frontmatter parser,
 * and a skill whose description breaks it silently disappears from the catalog —
 * the user would just see "no skills" with no error anywhere.
 *
 * So: generate real SKILL.md text through the real builder, then feed it to the
 * real parseSkillDoc from `@michengai/dsh-skills-manager`.
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Locate the skills-center plugin the way the harness itself would, so this
// check works on any machine that has it installed. Its exports map does not
// expose lib/core.js, so resolve the manifest and walk to the file. It is an
// OPTIONAL integration check — without it there is nothing to compare against,
// so skip instead of failing.
function locateSkillsManager() {
  const roots = [
    createRequire(process.execPath),                                     // bare `dsh` CLI installs
    createRequire(join(homedir(), '.dsh', 'package.json')),              // profile-root installs
    createRequire(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'package.json')),
  ];
  for (const req of roots) {
    try {
      return pathToFileURL(join(dirname(req.resolve('@michengai/dsh-skills-manager/package.json')), 'lib', 'core.js')).href;
    } catch { /* try the next root */ }
  }
  return null;
}

const SKILLS_MANAGER = locateSkillsManager();
if (SKILLS_MANAGER === null) {
  console.log('  skip  @michengai/dsh-skills-manager is not installed here');
  console.log('\n0 checks run (optional integration check skipped)');
  process.exit(0);
}
const STORE = new URL('../lib/memory-store.js', import.meta.url).href;

const { parseSkillDoc } = await import(SKILLS_MANAGER);
const { buildSkillMarkdown } = await import(STORE);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A realistic distilled skill, the shape `normalizeDigest` produces. */
const base = {
  slug: 'decode-multiframe-zstd',
  title: 'Decode multi-frame zstd logs',
  description: 'Split the file on the magic bytes before decompressing.',
  trigger: 'When a zstd session log decodes to only its first event.',
  steps: ['Read the file as a Buffer.', 'Split on every magic occurrence.', 'Decompress each frame.'],
  pitfalls: ['zstdDecompressSync on the whole file returns only frame one.'],
  verification: ['The joined result has more than one JSONL line.'],
  sources: ['session-bbbb2222-0000-0000-0000-000000000002'],
};

const md = buildSkillMarkdown(base);
const doc = parseSkillDoc(md);
check('the skills center parses a distilled skill', doc.hasFrontmatter === true, 'frontmatter');
check('the parsed name is the slug', doc.map.name === base.slug, JSON.stringify(doc.map.name));
check('the parsed description is present', typeof doc.map.description === 'string' && doc.map.description.length > 0, JSON.stringify(doc.map.description));
check('the body survives with its sections', /## Steps/.test(doc.body) && /## Pitfalls/.test(doc.body) && /## How to verify/.test(doc.body), `${doc.body.length} chars`);
check('the source session is traceable from the body', doc.body.includes(base.sources[0]), 'source cited');

// Frontmatter is line-based: a value that contains a newline, a bare colon+space,
// a leading dash/hash, or Windows backslashes must not break or truncate it.
const hostile = [
  ['colon', 'Decode: split on magic, then decompress: twice.'],
  ['newlines', 'Line one.\nLine two.\n\nLine three.'],
  ['windows path', String.raw`Read C:\Users\TGL\.dsh\sessions\x\session.jsonl.zstd`],
  ['double quotes', 'Use "quoted" text and "more" text.'],
  ['single quotes', "Use 'quoted' text."],
  ['leading hash', '# starts with what looks like a comment'],
  ['leading dash', '- looks like a list item'],
  ['unicode', '解码多帧 zstd 日志，先按魔数切分。'],
  ['trailing space', 'ends with a space   '],
  ['very long', `prefix ${'x'.repeat(400)} suffix`],
];

for (const [label, description] of hostile) {
  const generated = buildSkillMarkdown({ ...base, slug: `hostile-${label.replace(/\s+/g, '-')}`, description });
  const parsed = parseSkillDoc(generated);
  const name = parsed.map.name;
  const desc = parsed.map.description;
  const firstLine = description.split('\n')[0].trim();
  const intact = parsed.hasFrontmatter === true
    && typeof name === 'string'
    && name === `hostile-${label.replace(/\s+/g, '-')}`
    && typeof desc === 'string'
    && desc.length > 0
    && desc.startsWith(firstLine.slice(0, Math.min(20, firstLine.length)));
  check(`frontmatter survives ${label}`, intact, `name=${JSON.stringify(name)} desc=${JSON.stringify(String(desc).slice(0, 60))}`);
}

// The slug itself must be a legal skill directory name.
for (const raw of ['Decode Multi Frame Zstd!', '  spaced  ', 'UPPER_case', 'a'.repeat(120), '中文技能', '--dash--', 'dot.sep']) {
  const { skillSlug } = await import(STORE);
  const slug = skillSlug(raw);
  const legal = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) && slug.length > 0 && slug.length <= 64;
  check(`slug is path- and name-safe for ${JSON.stringify(raw.slice(0, 22))}`, legal, slug);
}

// A skill written without steps or pitfalls is dropped upstream; make sure the
// builder never emits an empty body that would look valid but teach nothing.
const minimal = buildSkillMarkdown({ slug: 'minimal', title: 'Minimal', description: 'Only a description.', sources: ['session-y'] });
const minimalDoc = parseSkillDoc(minimal);
check('a minimal skill still parses', minimalDoc.hasFrontmatter && typeof minimalDoc.map.description === 'string', `${minimal.length} chars`);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${failed.length === 0 ? 'all' : failed.length + ' of'} ${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
