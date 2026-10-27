/**
 * Turn a de-noised conversation transcript into a memory + a set of skills.
 *
 * Two design decisions worth stating, because both are easy to get wrong:
 *
 *  1. The model is asked for JSON and the reply is parsed leniently, but a
 *     parse failure is *reported*, never silently turned into an empty digest.
 *     A digest that quietly stores nothing is worse than one that fails loudly:
 *     the caller then deletes the log and the information is gone for good.
 *  2. Only user/assistant text reaches the prompt. Tool results in these logs
 *     run up to ~13 KB each and carry no reusable knowledge — feeding them in
 *     would triple the token bill to teach the model that `glob` printed a file
 *     list.
 */

import { completeWithFallback, parseJsonReply } from './llm.js';

const SYSTEM_PROMPT = `You compress one finished coding session into durable memory.

You receive a transcript excerpt: the user's requests and the assistant's replies. Tool output has already been removed.

Produce a JSON object, and nothing else. No prose before or after.

{
  "title": "<= 60 chars, what this session was actually about",
  "summary": "3-6 sentences. The single most useful paragraph a future reader could get.",
  "decisions": ["one line each: the decision, then why it was chosen"],
  "facts": ["one string each, e.g. StarGateModuleId: 420 (SVManager.cs:1463)"],
  "openIssues": ["what was left unfinished or unknown, one line each"],
  "tags": ["2-6 short topical tags, kebab-case"],
  "skills": [
    {
      "name": "kebab-case-skill-name",
      "description": "one sentence: what capability this gives, used to decide relevance",
      "whenToUse": "concrete trigger conditions",
      "steps": ["ordered, concrete, reproducible steps"],
      "pitfalls": ["things that silently break, and the fix"],
      "verification": ["how to prove the work actually succeeded"]
    }
  ]
}

Rules:
- "skills" is [] when the session taught no transferable procedure. Do not invent
  a skill from a one-off question.
- Never write a skill that only records where a file lives; that is "facts".
- Preserve exact identifiers verbatim: file paths, function names, error codes,
  version numbers. Paraphrasing them destroys the memory's value.
- If the transcript is truncated, say so inside "openIssues" instead of guessing.
- Write in the language the user used.`;

function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

export function buildUserPrompt(source, { maxChars = 14000 } = {}) {
  const parts = [];
  parts.push(`Session: ${source.sessionId ?? 'unknown'}`);
  if (source.title) parts.push(`Existing title: ${source.title}`);
  if (source.cwd) parts.push(`Working directory: ${source.cwd}`);
  const started = source.startedAt ?? source.createdAt;
  if (started) parts.push(`Started: ${typeof started === 'number' ? new Date(started).toISOString() : started}`);
  if (source.turns !== undefined) parts.push(`User turns: ${source.turns}`);
  if (Array.isArray(source.toolNames) && source.toolNames.length > 0) {
    parts.push(`Tools used: ${source.toolNames.slice(0, 30).join(', ')}`);
  }
  parts.push('', 'Transcript (oldest first; it may have been trimmed):', '');
  // `extractDigestSource` hands us a pre-trimmed transcript string; callers that
  // build their own source may pass blocks instead. Accept both.
  const body = typeof source.transcript === 'string' && source.transcript !== ''
    ? source.transcript
    : (source.blocks ?? []).map((block) => `${block.role === 'user' ? '用户' : '助手'}：${clip(block.text, 2600)}`).join('\n\n');
  parts.push(clip(body, maxChars));
  return parts.join('\n');
}

function asStringArray(value, limit = 24) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed !== '') out.push(trimmed);
    } else if (item && typeof item === 'object') {
      // Models sometimes emit {text: "..."} for list items. A {label, value}
      // pair is also common for facts, and dropping one half of it silently
      // loses the number the reader actually needed — so join both.
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      const value = typeof item.value === 'string' ? item.value.trim() : '';
      if (label !== '' && value !== '') {
        out.push(`${label}: ${value}`);
      } else {
        const text = item.text ?? item.value ?? item.label;
        if (typeof text === 'string' && text.trim() !== '') out.push(text.trim());
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

export function normalizeDigest(parsed, source) {
  const raw = parsed && typeof parsed === 'object' ? parsed : {};
  const title = typeof raw.title === 'string' && raw.title.trim() !== ''
    ? raw.title.trim().slice(0, 120)
    : (source.title || source.sessionId || 'Archived session');
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const skills = Array.isArray(raw.skills)
    ? raw.skills
      .filter((skill) => skill && typeof skill === 'object')
      .map((skill) => ({
        name: typeof skill.name === 'string' && skill.name.trim() !== '' ? skill.name.trim() : (typeof skill.title === 'string' ? skill.title.trim() : ''),
        description: typeof skill.description === 'string' ? skill.description.trim() : '',
        whenToUse: typeof skill.whenToUse === 'string' ? skill.whenToUse.trim() : '',
        steps: asStringArray(skill.steps),
        pitfalls: asStringArray(skill.pitfalls),
        verification: asStringArray(skill.verification),
      }))
      // A skill with no actionable steps is a note, not a skill.
      .filter((skill) => skill.steps.length > 0 || skill.pitfalls.length > 0)
    : [];
  return {
    title,
    summary,
    decisions: asStringArray(raw.decisions, 16),
    facts: asStringArray(raw.facts, 24),
    openIssues: asStringArray(raw.openIssues, 12),
    tags: asStringArray(raw.tags, 8).map((tag) => tag.toLowerCase().replace(/\s+/g, '-')),
    skills,
  };
}

/**
 * Distill one session.
 *
 * Returns `{ ok: true, digest, route, usage }` or
 * `{ ok: false, code, message, attempts }`. The caller is expected to keep the
 * session un-digested on failure so a retry is possible.
 */
export async function distillSession(llm, routes, source, { maxSourceChars = 14000, maxTokens = 2400, signal } = {}) {
  if (!Array.isArray(routes) || routes.length === 0) {
    return { ok: false, code: 'NO_ROUTE', message: 'no llm route available; configure provider/model for this plugin' };
  }
  const user = buildUserPrompt(source, { maxChars: maxSourceChars });
  const result = await completeWithFallback(llm, routes, {
    system: SYSTEM_PROMPT,
    user,
    maxTokens,
    purpose: 'archived-digest',
    signal,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message, attempts: result.attempts, capture: result.capture };
  }
  const parsed = parseJsonReply(result.text);
  if (parsed === null) {
    // Keep the raw reply so the failure can be inspected from the panel instead
    // of vanishing into a log line. `capture` records what the stream actually
    // contained (chunk types and per-block sizes), which is the only way to tell
    // "the model wrote prose" from "reasoning leaked into the text channel".
    return {
      ok: false,
      code: 'PARSE_FAILED',
      message: `model reply was not JSON: ${result.text.slice(0, 400)}`,
      raw: result.text,
      route: result.route,
      attempts: result.attempts,
      capture: result.capture,
    };
  }
  return {
    ok: true,
    digest: normalizeDigest(parsed, source),
    route: result.route,
    usage: result.usage,
    raw: result.text,
    capture: result.capture,
  };
}
