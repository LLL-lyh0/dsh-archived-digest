/**
 * Which assembler does the plugin actually get, and does it keep reasoning out
 * of the reply?
 *
 * Two digest runs against real live sessions failed with PARSE_FAILED whose
 * "reply" was plainly the model's reasoning ("We need produce JSON only...").
 * That can only happen if reasoning text reached the reply string, so this probe
 * pins down which code path is at fault instead of guessing:
 *
 *  1. Does `import('@deepseek-ai/dsh-llm')` resolve AT ALL from here? If not,
 *     every digest runs on the fallback shim, and the shim must be correct on
 *     its own.
 *  2. Feed the REAL chunk shapes (text-delta / reasoning-delta / block-end /
 *     finish{reason}) through `complete()` and see what comes back.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(here, '..', rel)).href);

// ── 1. does the real module resolve from the plugin's own location? ────────
let real = null;
try {
  real = await import('@deepseek-ai/dsh-llm');
  console.log('import @deepseek-ai/dsh-llm: RESOLVED');
} catch (error) {
  console.log('import @deepseek-ai/dsh-llm: FAILED —', String(error.code || error.message).slice(0, 70));
}
console.log('  → Host and tests both run on the', real ? 'REAL assembler' : 'FALLBACK shim');

const { complete } = await load('lib/llm.js');

// ── 2. the real chunk shapes, as read from the shipped BlockAssembler ──────
// push() switch: block-start{index,blockType} | text-delta{index,text}
// | reasoning-delta{index,text} | block-end{index,block} | finish{reason}
const REASONING = 'We need produce JSON only. Need compress session. The session is analysis.';
const ANSWER = '{"title":"T","summary":"ok","decisions":[],"facts":[],"openIssues":[],"tags":[],"skills":[]}';

function streamOf(chunks) {
  return { stream: async function* () { for (const c of chunks) yield c; } };
}

const realShaped = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: REASONING },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: ANSWER },
  { type: 'block-end', index: 1, block: { type: 'text', text: ANSWER } },
  { type: 'finish', reason: { kind: 'stop' } },
];

const res = await complete(streamOf(realShaped), { provider: 'p', model: 'm' }, { system: 's', user: 'u' });
console.log('\n--- complete() over real-shaped chunks ---');
console.log('ok:', res.ok);
if (res.ok) {
  const leaked = res.text.includes('We need produce JSON');
  console.log('reply:', JSON.stringify(res.text.slice(0, 60)));
  console.log('reasoning leaked into reply:', leaked, leaked ? '  <<< BUG' : '  (correct)');
  console.log('reply is parseable JSON:', (() => { try { JSON.parse(res.text); return true; } catch { return false; } })());
} else {
  console.log('code:', res.code, '|', res.message);
}

// ── 3. a max-tokens finish must not be reported as success ─────────────────
const truncated = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '{"title":"cut off' },
  { type: 'finish', reason: { kind: 'max-tokens' } },
];
const cut = await complete(streamOf(truncated), { provider: 'p', model: 'm' }, { system: 's', user: 'u' });
console.log('\n--- truncated stream ---');
console.log('ok:', cut.ok, '| code:', cut.code, cut.code === 'MAX_TOKENS' ? '  (correct)' : '  <<< BUG: truncation misreported');
