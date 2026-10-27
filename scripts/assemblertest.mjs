/**
 * Regression suite for the LLM stream assembler contract.
 *
 * WHY THIS EXISTS
 * Two real digests of live sessions failed with PARSE_FAILED whose "reply" was
 * plainly the model's reasoning ("We need produce JSON only..."). The cause was
 * not the model: `@deepseek-ai/dsh-llm` does not resolve from a plugin outside
 * the harness bundle (ERR_MODULE_NOT_FOUND), so every digest runs on the
 * fallback assembler in lib/llm.js — and that assembler had no `reasoning-delta`
 * guard, so it appended thinking to the answer.
 *
 * The chunk vocabulary below is copied from the shipped BlockAssembler
 * (dsh-llm/lib/index.js, class BlockAssembler.push), so these tests pin the shim
 * to the real contract rather than to guesses about it.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { complete, completeWithFallback, parseJsonReply } = await import(pathToFileURL(path.join(here, '..', 'lib', 'llm.js')).href);

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const streamOf = (chunks) => ({ stream: async function* () { for (const c of chunks) yield c; } });
const route = { provider: 'p', model: 'm' };
const call = (chunks) => complete(streamOf(chunks), route, { system: 's', user: 'u' });

const ANSWER = '{"title":"T","summary":"ok"}';
const THINKING = 'We need produce JSON only. Need compress session.';

// ── reasoning must never reach the reply ───────────────────────────────────
{
  const r = await call([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: THINKING },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: ANSWER },
    { type: 'block-end', index: 1, block: { type: 'text', text: ANSWER } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  check('a reasoning delta never leaks into the reply', r.ok && !r.text.includes('We need produce'), JSON.stringify((r.text || '').slice(0, 40)));
  check('the reply is the text block, not the thinking', r.ok && r.text === ANSWER);
  check('a reasoning-only prefix still parses as JSON', !!parseJsonReply(r.text));
}
// ── reasoning arriving FIRST (the real failure's order) ────────────────────
{
  const r = await call([
    { type: 'reasoning-delta', index: 0, text: THINKING },
    { type: 'text-delta', index: 1, text: ANSWER },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  check('reasoning before text does not poison the answer', r.ok && r.text === ANSWER, JSON.stringify((r.text || '').slice(0, 40)));
}
// ── reasoning interleaved between text chunks ──────────────────────────────
{
  const r = await call([
    { type: 'text-delta', index: 0, text: '{"a":' },
    { type: 'reasoning-delta', index: 0, text: ' let me think ' },
    { type: 'text-delta', index: 0, text: '1}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  check('interleaved reasoning does not split the text block', r.ok && r.text === '{"a":1}', JSON.stringify(r.text));
}
// ── finish.reason carries the real outcome ─────────────────────────────────
{
  const r = await call([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'max-tokens' } }]);
  check('finish.reason max-tokens is reported as MAX_TOKENS', !r.ok && r.code === 'MAX_TOKENS', r.code);
}
{
  const r = await call([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'no key' } } }]);
  check('finish.reason error surfaces its failure code', !r.ok && r.code === 'AUTH', r.code);
}
{
  const r = await call([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'aborted' } }]);
  check('an aborted stream is a failure', !r.ok, r.code);
}
{
  const r = await call([{ type: 'text-delta', index: 0, text: 'hi' }, { type: 'finish', reason: { kind: 'stop' } }]);
  check('a clean stop succeeds', r.ok && r.text === 'hi');
}
// ── a stream with no finish at all (adapter dropped it) ────────────────────
{
  const r = await call([{ type: 'text-delta', index: 0, text: ANSWER }]);
  check('a missing finish event is treated as a clean stop', r.ok && r.text === ANSWER, r.code || '');
}
// ── text split across many deltas must concatenate in order ────────────────
{
  const r = await call([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '{"title":' },
    { type: 'text-delta', index: 0, text: '"T","summary"' },
    { type: 'text-delta', index: 0, text: ':"ok"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  check('deltas concatenate in stream order', r.ok && r.text === ANSWER, JSON.stringify((r.text || '').slice(0, 48)));
  check('the concatenated reply parses', !!parseJsonReply(r.text));
}
// ── tool calls are not text ────────────────────────────────────────────────
{
  const r = await call([
    { type: 'text-delta', index: 0, text: 'done' },
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'glob', argumentsDelta: '{"p":"*"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  check('a tool-call block is not included in the reply', r.ok && r.text === 'done', JSON.stringify(r.text));
}
// ── an empty answer is EMPTY_OUTPUT, not a parse failure ───────────────────
{
  const r = await call([{ type: 'reasoning-delta', index: 0, text: THINKING }, { type: 'finish', reason: { kind: 'stop' } }]);
  check('a reasoning-only stream reports EMPTY_OUTPUT', !r.ok && r.code === 'EMPTY_OUTPUT', r.code);
}
// ── usage is captured ──────────────────────────────────────────────────────
{
  const r = await call([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'usage', usage: { inputTokens: 7 } }, { type: 'finish', reason: { kind: 'stop' } }]);
  check('usage is captured from the stream', r.ok && r.usage?.inputTokens === 7, JSON.stringify(r.usage));
}
// ── whole-block and legacy shapes still work ───────────────────────────────
{
  const r = await call([{ block: { type: 'text', text: ANSWER } }, { type: 'finish', reason: { kind: 'stop' } }]);
  check('a whole-block delta is accepted', r.ok && r.text === ANSWER, JSON.stringify((r.text || '').slice(0, 40)));
}
{
  const r = await call([{ block: { type: 'reasoning', text: THINKING } }, { block: { type: 'text', text: ANSWER } }, { type: 'finish', reason: { kind: 'stop' } }]);
  check('a whole reasoning block is excluded', r.ok && r.text === ANSWER, JSON.stringify((r.text || '').slice(0, 40)));
}
{
  const r = await call([{ type: 'text', text: ANSWER }, { type: 'finish', kind: 'stop' }]);
  check('legacy flat text plus bare finish kind still works', r.ok && r.text === ANSWER, JSON.stringify((r.text || '').slice(0, 40)));
}
// ── a stream that throws mid-way is an error, not a partial success ────────
{
  const throwing = { stream: async function* () { yield { type: 'text-delta', index: 0, text: '{"a"' }; throw new Error('socket died'); } };
  const r = await complete(throwing, route, { system: 's', user: 'u' });
  check('a mid-stream throw fails instead of returning a truncated reply', !r.ok, r.code);
}

// ── budget escalation: truncation is retried with more room ────────────────
{
  // A reasoning model charges thinking against the same ceiling, so the first
  // call truncates before any answer text exists; the second has enough room.
  const seen = [];
  const llm = {
    stream: async function* (options) {
      seen.push(options.maxTokens);
      if (options.maxTokens < 3200) {
        yield { type: 'reasoning-delta', index: 0, text: THINKING };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: ANSWER };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const r = await completeWithFallback(llm, [route], { system: 's', user: 'u', maxTokens: 1600 });
  check('a truncated reply is retried with a larger budget', r.ok && r.text === ANSWER, JSON.stringify(seen));
  check('the retry doubles the ceiling', seen.length === 2 && seen[1] === 3200, JSON.stringify(seen));
  check('the truncation is recorded as an attempt', r.attempts?.[0]?.code === 'MAX_TOKENS', JSON.stringify(r.attempts?.[0] ?? null));
}
{
  // Always truncating: must stop at the ceiling instead of looping forever.
  const seen = [];
  const llm = {
    stream: async function* (options) {
      seen.push(options.maxTokens);
      yield { type: 'reasoning-delta', index: 0, text: THINKING };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    },
  };
  const r = await completeWithFallback(llm, [route], { system: 's', user: 'u', maxTokens: 1600 });
  check('a permanently truncated route ends as MAX_TOKENS', !r.ok && r.code === 'MAX_TOKENS', r.code);
  check('escalation stops at the ceiling', seen.length <= 4 && Math.max(...seen) <= 8000, JSON.stringify(seen));
  check('a truncated call still carries its capture', !r.ok && Number(r.capture?.joined?.reasoningChars) > 0, JSON.stringify(r.capture?.joined ?? null));
}
{
  // A hard failure must not be retried on the same route; it moves on.
  const seen = [];
  const llm = {
    stream: async function* (options) {
      seen.push(options.model);
      if (options.model === 'bad') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'unauthorized', message: 'no key' } } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: ANSWER };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const r = await completeWithFallback(llm, [{ provider: 'p', model: 'bad' }, { provider: 'p', model: 'good' }], { system: 's', user: 'u', maxTokens: 1600 });
  check('a hard failure falls through to the next route', r.ok && r.route?.model === 'good', JSON.stringify(seen));
  check('a hard failure is not retried on the same route', seen.length === 2, JSON.stringify(seen));
}

console.log(`\n${failures.length ? `${failures.length} check(s) failed:\n  ` + failures.join('\n  ') : `all ${passed} checks passed`}`);
process.exit(failures.length ? 1 : 0);
