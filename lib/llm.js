/**
 * LLM access for the distiller.
 *
 * The archived sessions we digest have no live session object, so there is no
 * `session.requestHeader().config` to inherit a route from. Two consequences:
 *
 *  - the plugin config must be able to pin `provider` / `model`, and
 *  - when it does not, we walk `llm.listProviders()` and take the first route
 *    that can actually serve a request.
 *
 * `listProviders()` returns providers in **registration order**, and the
 * built-in `deepseek-official` is usually first — on a machine without an
 * official key that candidate fails before the request ever leaves the process,
 * which is easy to misread as "the model returned nothing". So failures are
 * recorded per candidate and the next one is tried.
 */

const DEFAULT_MAX_TOKENS = 1600;
/**
 * Hard ceiling for budget escalation on a truncated reply. Reasoning tokens are
 * charged against the same output budget, so a thinking model can spend the whole
 * allowance before writing an answer character; doubling the budget on
 * `max-tokens` is the cheap repair. Bounded so a runaway call cannot be asked for
 * an absurd allowance.
 */
const MAX_TOKENS_CEILING = 8000;

function supportsReasoningEffort(providerInfo, modelInfo) {
  const flag = (value) => (typeof value === 'boolean' ? value : null);
  const fromModel = modelInfo ? flag(modelInfo.reasoning) : null;
  if (fromModel !== null) return fromModel;
  if (providerInfo) {
    const compat = providerInfo.compat;
    if (compat && typeof compat === 'object') {
      const declared = flag(compat.reasoningEffort) ?? flag(compat.supportsReasoningEffort);
      if (declared !== null) return declared;
    }
    const caps = providerInfo.capabilities;
    if (caps && typeof caps === 'object') {
      const declared = flag(caps.reasoningEffort) ?? flag(caps.reasoning);
      if (declared !== null) return declared;
    }
  }
  // Unknown is treated as supported: guessing "unsupported" would silently
  // disable a capability the provider does have.
  return true;
}

/**
 * Ordered route candidates.
 *
 * @param {object} llm the dsh llm service
 * @param {{provider?: string, model?: string, limit?: number}} [options]
 * @returns {Promise<Array<{provider: string, model: string, reasoningEffort?: string|null}>>}
 */
export async function routeCandidates(llm, options = {}) {
  const want = String(options.provider ?? '').trim();
  const wantModel = String(options.model ?? '').trim();
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 4;
  const out = [];
  if (!llm || typeof llm.listProviders !== 'function') return out;

  const push = (providerId, model, modelInfo) => {
    if (providerId === '' || model === undefined || model === null || model === '') return;
    if (out.some((route) => route.provider === providerId)) return;
    const route = { provider: providerId, model: String(model) };
    if (!supportsReasoningEffort({ id: providerId }, modelInfo)) route.reasoningEffort = null;
    out.push(route);
  };

  let providers;
  try {
    providers = llm.listProviders() ?? [];
  } catch {
    return out;
  }

  const modelsOf = async (id) => {
    try {
      const list = await llm.listModels(id);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  // Configured route wins outright.
  if (want !== '') {
    const hit = providers.find((provider) => provider && provider.id === want) ?? { id: want };
    const models = await modelsOf(want);
    const model = wantModel !== '' ? wantModel : (models[0] && models[0].id);
    if (model) push(want, model, models.find((entry) => entry && entry.id === model) ?? null);
  }

  const rest = [];
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string' || provider.id === '') continue;
    if (out.some((route) => route.provider === provider.id)) continue;
    const models = await modelsOf(provider.id);
    const model = models[0] && models[0].id;
    if (!model) continue;
    rest.push({ provider, model, info: models[0] });
  }
  // Capability first, registration order second (sort is stable).
  rest.sort((a, b) => Number(!supportsReasoningEffort(a.provider, a.info)) - Number(!supportsReasoningEffort(b.provider, b.info)));
  for (const entry of rest) {
    if (out.length >= limit) break;
    push(entry.provider.id, entry.model, entry.info);
  }
  return out;
}

/** Lazily import the llm message helpers; degrades when the package is absent. */
async function importLlmHelpers() {
  try {
    const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm');
    return { BlockAssembler, createUserMessage };
  } catch {
    // Fallback assembler. This is NOT a rare path: @deepseek-ai/dsh-llm lives
    // inside the harness bundle, so a plugin outside it cannot resolve the
    // package and every real digest runs here.
    //
    // The chunk vocabulary is copied from the shipped BlockAssembler
    // (dsh-llm/lib/index.js, class BlockAssembler):
    //   block-start {index, blockType}
    //   text-delta | reasoning-delta {index, text}
    //   tool-call-delta {index, id, name, argumentsDelta}
    //   block-end {index, block}
    //   usage {usage} | finish {reason, replayState}
    //
    // The one rule that matters: a reasoning delta must never be appended to a
    // text block. Reasoning models emit both streams, and treating the thinking
    // as the answer makes the reply prose, which then fails to parse as JSON —
    // the digest silently dies on a "PARSE_FAILED" that blames the model.
    return {
      BlockAssembler: class {
        constructor() {
          this.order = [];
          this.partials = new Map();
          this._finish = undefined;
          this.usage = undefined;
        }
        /** Find or create the partial for a stream index, in first-seen order. */
        ensure(index, blockType) {
          // Partials are keyed by index AND kind. Keying by index alone would let
          // a reasoning delta and a text delta that share an index concatenate
          // into one block (the real assembler has that hazard: it only sets the
          // block type when the partial is first created). Distinct kinds must
          // never share a buffer, so thinking can never end up inside the answer.
          const key = `${index ?? 0}#${blockType || 'unknown'}`;
          let partial = this.partials.get(key);
          if (!partial) {
            partial = { blockType: blockType || 'unknown', text: '' };
            this.partials.set(key, partial);
            this.order.push(key);
          }
          return partial;
        }
        /** Accept the real chunk shapes, plus looser adapter-specific ones. */
        push(chunk) {
          if (typeof chunk === 'string') {
            this.ensure(0, 'text').text += chunk;
            return;
          }
          if (!chunk || typeof chunk !== 'object') return;
          switch (chunk.type) {
            case 'block-start':
              this.ensure(chunk.index, chunk.blockType);
              return;
            case 'text-delta':
              this.ensure(chunk.index, 'text').text += chunk.text ?? '';
              return;
            case 'reasoning-delta':
              // Its own buffer, so it can never be mistaken for the answer;
              // blocks() marks it non-text and complete() filters it out.
              this.ensure(chunk.index, 'reasoning').text += chunk.text ?? '';
              return;
            case 'tool-call-delta':
              this.ensure(chunk.index, 'tool-call');
              return;
            case 'block-end':
              if (chunk.block && typeof chunk.block === 'object') {
                const partial = this.ensure(chunk.index, chunk.block.type);
                if (typeof chunk.block.text === 'string') partial.text = chunk.block.text;
              }
              return;
            case 'usage':
              if (chunk.usage) this.usage = chunk.usage;
              return;
            case 'finish':
              // Real shape: {type:'finish', reason:{kind, failure?}}. The reason
              // may also arrive pre-unwrapped; accept both.
              this._finish = chunk.reason ?? chunk.finish
                ?? { kind: chunk.kind ?? 'stop', failure: chunk.failure };
              return;
            default:
              break;
          }
          // Whole-block deltas: `{block:{type:'text'|'reasoning', text}}`.
          if (chunk.block && typeof chunk.block === 'object') {
            const partial = this.ensure(chunk.index, chunk.block.type);
            if (typeof chunk.block.text === 'string') partial.text = chunk.block.text;
            return;
          }
          // Legacy flat shapes are always plain text; a reasoning delta always
          // arrives typed (handled above), so this cannot swallow thinking.
          const text = chunk.text
            ?? (typeof chunk.delta === 'string' ? chunk.delta : chunk.delta?.text)
            ?? (typeof chunk.content === 'string' ? chunk.content : undefined);
          if (typeof text === 'string' && text !== '') this.ensure(chunk.index, 'text').text += text;
        }
        /** One block per seen partial; only genuine text blocks are type 'text'. */
        blocks() {
          return this.order.map((key) => {
            const partial = this.partials.get(key);
            return { type: partial.blockType, text: partial.text };
          });
        }
        get finish() {
          return this._finish ?? { kind: 'stop' };
        }
      },
      createUserMessage: (message) => ({ role: 'user', content: message?.content ?? message, source: message?.source }),
    };
  }
}

/**
 * Run one completion and return `{ ok, text }` or `{ ok: false, code, message }`.
 *
 * The failure truth is `assembler.finish`, not whether text came back: an auth
 * error surfaces as a `finish` of `kind: 'error'` with a `failure` payload, and a
 * truncated response surfaces as `kind: 'max-tokens'` — which must never be
 * reported as "unparseable output".
 */
export async function complete(llm, route, { system, user, maxTokens = DEFAULT_MAX_TOKENS, purpose = 'archived-digest', signal } = {}) {
  const { BlockAssembler, createUserMessage } = await importLlmHelpers();
  const assembler = new BlockAssembler();
  // Diagnostic ledger for this call. The shipped BlockAssembler sets a partial's
  // block type only when that partial is first created, so a reasoning delta that
  // arrives for a stream index already opened as `text` is appended straight into
  // the answer. We therefore also accumulate the answer ourselves, from the typed
  // deltas, and record both views so a mismatch is visible instead of silent.
  const capture = { chunks: [], blocks: [], joined: '' };
  // Answer text mirrored per (index, kind) slot. Keeping the kind in the key is
  // what keeps thinking out of the reply even when two streams share an index.
  const slots = new Map();
  const slotOrder = [];
  const writeSlot = (index, kind, text, mode = 'append') => {
    if (typeof text !== 'string' || text === '') return;
    const key = `${index ?? 0}#${kind}`;
    let slot = slots.get(key);
    if (!slot) {
      slot = { kind, text: '' };
      slots.set(key, slot);
      slotOrder.push(key);
    }
    // A `block-end` (or whole-block delta) restates the FINAL text of that block,
    // so it replaces the slot rather than being appended a second time.
    slot.text = mode === 'replace' ? text : slot.text + text;
  };
  const answerText = () => slotOrder
    .map((key) => slots.get(key))
    .filter((slot) => slot.kind === 'text')
    .map((slot) => slot.text)
    .join('');
  /**
   * Classify one chunk by its OWN declared type — never by what the assembler
   * decided. This is the whole point: the shipped assembler keys partials by
   * index alone, so a reasoning delta sharing an index with an already-open text
   * partial is appended to the answer. Classifying here keeps thinking out of the
   * reply even when the assembler's view says otherwise.
   */
  const classify = (chunk) => {
    if (typeof chunk === 'string') return { index: 0, kind: 'text', text: chunk, mode: 'append' };
    if (!chunk || typeof chunk !== 'object') return null;
    switch (chunk.type) {
      case 'text-delta': return { index: chunk.index, kind: 'text', text: chunk.text ?? '', mode: 'append' };
      case 'reasoning-delta': return { index: chunk.index, kind: 'reasoning', text: chunk.text ?? '', mode: 'append' };
      case 'block-end':
        if (chunk.block && typeof chunk.block === 'object' && typeof chunk.block.text === 'string') {
          return { index: chunk.index, kind: chunk.block.type === 'reasoning' ? 'reasoning' : 'text', text: chunk.block.text, mode: 'replace' };
        }
        return null;
      default: break;
    }
    if (chunk.block && typeof chunk.block === 'object' && typeof chunk.block.text === 'string') {
      return { index: chunk.index, kind: chunk.block.type === 'reasoning' ? 'reasoning' : 'text', text: chunk.block.text, mode: 'replace' };
    }
    const flat = chunk.text
      ?? (typeof chunk.delta === 'string' ? chunk.delta : chunk.delta?.text)
      ?? (typeof chunk.content === 'string' ? chunk.content : undefined);
    return typeof flat === 'string' && flat !== '' ? { index: chunk.index, kind: 'text', text: flat, mode: 'append' } : null;
  };
  const options = {
    provider: route.provider,
    model: route.model,
    system,
    messages: [createUserMessage({
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin', plugin: 'dsh-archived-digest' },
    })],
    maxTokens,
    purpose,
    signal: signal ?? AbortSignal.timeout(90000),
  };
  if (route.reasoningEffort) options.reasoningEffort = route.reasoningEffort;
  else if (route.reasoningEffort === null) delete options.reasoningEffort;

  try {
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk);
      if (capture.chunks.length < 40) {
        capture.chunks.push({
          type: chunk?.type,
          index: chunk?.index,
          blockType: chunk?.blockType ?? chunk?.block?.type,
          len: typeof chunk?.text === 'string' ? chunk.text.length
            : typeof chunk?.argumentsDelta === 'string' ? chunk.argumentsDelta.length : 0,
        });
      }
      // Mirror the answer text by the chunk's own declared kind.
      const seen = classify(chunk);
      if (seen) writeSlot(seen.index, seen.kind, seen.text, seen.mode);
    }
  } catch (error) {
    return { ok: false, code: 'error.llm.stream', message: String(error?.message ?? error), capture };
  }

  const finish = assembler.finish && typeof assembler.finish === 'object' ? assembler.finish : { kind: 'stop' };
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const failure = finish.failure ?? {};
    return {
      ok: false,
      code: String(failure.code ?? failure.kind ?? finish.kind),
      message: String(failure.message ?? failure.detail ?? 'model call failed'),
    };
  }
  if (finish.kind === 'max-tokens') {
    // Reasoning tokens are charged against the same ceiling, so on a reasoning
    // model the answer can be cut off before a single answer character exists.
    // Keep the capture: it is the only way to tell "budget spent on thinking"
    // from "the reply itself was too long".
    capture.blocks = (typeof assembler.blocks === 'function' ? assembler.blocks() : [])
      .map((block) => ({ type: block?.type, len: String(block?.text ?? '').length }));
    const reasoningChars = slotOrder
      .map((key) => slots.get(key))
      .filter((slot) => slot.kind === 'reasoning')
      .reduce((sum, slot) => sum + slot.text.length, 0);
    capture.joined = { assemblerTextChars: 0, deltaTextChars: answerText().trim().length, reasoningChars };
    capture.assemblerText = answerText().trim().slice(0, 400);
    capture.usage = assembler.usage;
    return {
      ok: false,
      code: 'MAX_TOKENS',
      message: `output hit the maxTokens=${maxTokens} ceiling and was truncated `
        + `(reasoning ${reasoningChars} chars before the answer)`,
      capture,
    };
  }
  const fromAssembler = (typeof assembler.blocks === 'function' ? assembler.blocks() : [])
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  const text = answerText().trim();
  capture.blocks = (typeof assembler.blocks === 'function' ? assembler.blocks() : [])
    .map((block) => ({ type: block?.type, len: String(block?.text ?? '').length }));
  const reasoningChars = slotOrder
    .map((key) => slots.get(key))
    .filter((slot) => slot.kind === 'reasoning')
    .reduce((sum, slot) => sum + slot.text.length, 0);
  capture.joined = { assemblerTextChars: fromAssembler.length, deltaTextChars: text.length, reasoningChars };
  capture.assemblerText = fromAssembler.slice(0, 400);
  if (text === '') {
    return {
      ok: false,
      code: 'EMPTY_OUTPUT',
      message: fromAssembler === ''
        ? 'model returned no text'
        : 'model returned only reasoning; no answer text in the stream',
      capture,
    };
  }
  return { ok: true, text, usage: assembler.usage, capture };
}

/**
 * Try each candidate until one answers. Returns the first success plus the
 * route that produced it, or the last failure with every attempt recorded.
 */
export async function completeWithFallback(llm, routes, request) {
  const attempts = [];
  let lastCapture;
  let lastMessage;
  let lastCode;
  const ceiling = Number(request?.maxTokensCeiling ?? MAX_TOKENS_CEILING);
  for (const route of routes) {
    let budget = Number(request?.maxTokens ?? DEFAULT_MAX_TOKENS);
    // Escalate the budget on truncation before giving up on this route: on a
    // reasoning model the thinking tokens are charged against the same ceiling,
    // so `max-tokens` usually means "the budget was wrong", not "the route is
    // broken". Retrying the SAME route with a larger ceiling is the cheap fix;
    // switching providers would just reproduce it.
    for (;;) {
      const result = await complete(llm, route, { ...request, maxTokens: budget });
      if (result.ok) return { ...result, route, attempts };
      if (result.capture) lastCapture = result.capture;
      lastCode = result.code;
      lastMessage = result.message;
      attempts.push({ provider: route.provider, model: route.model, code: result.code, maxTokens: budget, message: result.message });
      if (result.code !== 'MAX_TOKENS' || budget >= ceiling) break;
      budget = Math.min(ceiling, budget * 2);
    }
    // Only a hard failure (auth, unknown model, stream error) justifies trying
    // the next candidate; a truncation was already retried with more room above.
    if (lastCode !== 'MAX_TOKENS') continue;
    break;
  }
  // The capture from the last attempt travels with the failure, so the panel can
  // show what the stream actually contained instead of only the model's prose.
  return {
    ok: false,
    code: lastCode ?? 'NO_ROUTE',
    message: lastMessage ?? 'no usable llm route',
    attempts,
    capture: lastCapture,
  };
}

/** The escape sequences JSON actually defines; anything else is a model bug. */
const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/**
 * Escape the characters JSON forbids inside a string literal.
 *
 * Models routinely emit a pretty-printed object whose string values contain real
 * newlines and tabs. That is invalid JSON, so `JSON.parse` rejects a reply that is
 * otherwise exactly what we asked for — and the failure blames the model for
 * "not returning JSON". Rewriting only the inside-of-string control characters
 * (plus trailing commas) repairs those replies without touching the structure.
 *
 * The third and most common offender on Windows is an unescaped path:
 * `"cwd": "D:\DeepSeekHarness"` dies with "Bad escaped character in JSON", which
 * costs a whole session's digest over one backslash. Unknown escapes are turned
 * into real escaped backslashes; known ones are left exactly as written.
 */
export function repairJsonText(body) {
  const text = String(body ?? '');
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        out += '\\\\';
        continue;
      }
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += text.slice(i, i + 6);
          i += 5;
          continue;
        }
        out += '\\\\';
        continue;
      }
      if (VALID_ESCAPES.has(next)) {
        out += ch + next;
        i += 1;
        continue;
      }
      // Not an escape JSON knows: keep the backslash the author meant, escaped.
      out += '\\\\';
      continue;
    }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    const code = ch.codePointAt(0);
    if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Parse `candidate` as-is, then after the string-literal repair. */
function parseJsonLenient(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through to the repair pass */
  }
  try {
    return JSON.parse(repairJsonText(candidate));
  } catch {
    return undefined;
  }
}

/** Pull the first JSON object out of a model reply that may be fenced or chatty. */
export function parseJsonReply(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const whole = parseJsonLenient(body);
  if (whole !== undefined) return whole;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = body.slice(start, i + 1);
        const parsed = parseJsonLenient(slice);
        return parsed === undefined ? null : parsed;
      }
    }
  }
  return null;
}
