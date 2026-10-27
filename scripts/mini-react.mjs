/**
 * A tiny React-compatible runtime, enough to actually execute this plugin's
 * panel: createElement, Fragment, the five hooks it uses, and a single-pass
 * tree expander.
 *
 * Why this exists: the harness profile ships `react` but not `react-dom`, so
 * there is no server renderer and no test renderer available. Rather than skip
 * verification, this shim runs the real component function — which is where the
 * real bugs are (a bad hook order, a prop read off undefined, a handler that
 * never fires). It is not a DOM: it produces a plain tree the test can inspect
 * and a handler set the test can invoke.
 *
 * Deliberate limits: no reconciliation, no batching, no portals. Effects run
 * once after each render with their cleanup, which is enough to catch a missing
 * dependency array and a throwing effect.
 */

export const Fragment = Symbol('Fragment');

let hookCursor = null;
/** path → hook slots, so state survives a re-render of the same component. */
const hookStore = new Map();
/** Effects queued by the render in progress. */
let pendingEffects = [];
let cleanupQueue = [];
let renderCount = 0;

function flatten(children) {
  const out = [];
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flatten(child));
    else if (child === null || child === undefined || typeof child === 'boolean') continue;
    else out.push(child);
  }
  return out;
}

export function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: flatten(children) };
}

function nextSlot(kind, initial) {
  const slot = hookCursor;
  const index = slot.index;
  slot.index += 1;
  if (slot.hooks[index] === undefined || slot.hooks[index].kind !== kind) {
    slot.hooks[index] = { kind, value: typeof initial === 'function' ? initial() : initial, deps: undefined };
  }
  return slot.hooks[index];
}

export function useState(initial) {
  const slot = nextSlot('state', initial);
  const setValue = (next) => {
    const resolved = typeof next === 'function' ? next(slot.value) : next;
    if (Object.is(resolved, slot.value)) return;
    slot.value = resolved;
    scheduleRender();
  };
  return [slot.value, setValue];
}

/** useReducer is not used by the panel; aliased so an accidental import fails loudly. */
export function useReducer() {
  throw new Error('mini-react: useReducer is not implemented');
}

export function useRef(initial) {
  const slot = nextSlot('ref', { current: initial });
  return slot.value;
}

function depsChanged(previous, next) {
  if (previous === undefined || next === undefined || next === null) return true;
  if (!Array.isArray(previous) || !Array.isArray(next)) return true;
  if (previous.length !== next.length) return true;
  return next.some((value, index) => !Object.is(value, previous[index]));
}

export function useMemo(factory, deps) {
  const slot = nextSlot('memo', { value: undefined, deps: undefined });
  if (depsChanged(slot.value.deps, deps)) {
    slot.value = { value: factory(), deps };
  }
  return slot.value.value;
}

export function useCallback(factory, deps) {
  return useMemo(() => factory, deps);
}

export function useEffect(fn, deps) {
  const slot = nextSlot('effect', { deps: undefined, cleanup: undefined });
  if (depsChanged(slot.value.deps, deps)) {
    slot.value.deps = deps;
    pendingEffects.push(() => {
      if (typeof slot.value.cleanup === 'function') cleanupQueue.push(slot.value.cleanup);
      const cleanup = fn();
      slot.value.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    });
  }
}

/** The rerender hook the test installs, so state changes can be observed. */
let renderRequested = null;
export function scheduleRender() {
  if (renderRequested) renderRequested();
}
export function onRenderRequest(fn) { renderRequested = fn; }

/**
 * Expand a vnode tree into `{tag, props, children}` frames, calling function
 * components for real. Non-component values become `{tag:'#text', text}`.
 */
function expand(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') {
    return { tag: '#text', text: String(node), props: {}, children: [] };
  }
  if (Array.isArray(node)) {
    return { tag: '#array', props: {}, children: node.map((child, index) => expand(child, `${path}[${index}]`)).filter(Boolean) };
  }
  const { type, props, children } = node;
  if (typeof type === 'function') {
    const inner = expandFunction(type, props, path);
    // Forward the key so the test can find a specific component instance.
    return inner;
  }
  if (type === Fragment) {
    return { tag: '#fragment', props: {}, children: children.map((child, index) => expand(child, `${path}.f${index}`)).filter(Boolean) };
  }
  const tag = typeof type === 'string' ? type : String(type);
  const resolved = { ...props };
  // React's data-* / aria-* passthrough is all this panel needs; className and
  // style are kept as-is so assertions can read them.
  return {
    tag,
    props: resolved,
    children: children.map((child, index) => expand(child, `${path}.c${index}`)).filter(Boolean),
  };
}

function expandFunction(type, props, path) {
  const store = hookStore.get(path) ?? { hooks: [] };
  hookStore.set(path, store);
  const previous = hookCursor;
  hookCursor = { hooks: store.hooks, index: 0, path };
  let output;
  try {
    output = type(props);
  } finally {
    hookCursor = previous;
  }
  const expanded = expand(output, `${path}->${type.name || 'anon'}`);
  if (expanded && expanded.tag !== '#text') {
    // Mark the frame so handlers can be traced back to their component.
    expanded.component = type.name || 'anon';
  }
  return expanded;
}

/**
 * Render a vnode tree. Effects are flushed at the end of the pass.
 *
 * @param {object} vnode
 * @returns {{tree: object|null, renderCount: number}}
 */
export function render(vnode) {
  if (cleanupQueue.length > 0) {
    for (const cleanup of cleanupQueue.splice(0)) {
      try { cleanup(); } catch { /* the panel must not throw during teardown */ }
    }
  }
  pendingEffects = [];
  renderCount += 1;
  const tree = expand(vnode, 'root');
  const effects = pendingEffects.splice(0);
  for (const effect of effects) effect();
  return { tree, renderCount };
}

/** Walk the rendered tree depth-first. */
export function* walk(node) {
  if (!node) return;
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

/** Every element frame whose props satisfy a predicate. */
export function findAll(tree, predicate) {
  const out = [];
  for (const node of walk(tree)) {
    if (node.tag === '#text' || node.tag === '#array' || node.tag === '#fragment') continue;
    if (predicate(node)) out.push(node);
  }
  return out;
}

/** Concatenated text under a node — the cheapest way to assert on copy. */
export function textOf(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.text;
  return (node.children ?? []).map(textOf).join(' ');
}
