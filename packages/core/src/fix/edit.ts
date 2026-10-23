import { isAlias, isMap, isScalar, isSeq, stringify } from 'yaml';
import type { Alias, Pair, Scalar, YAMLMap } from 'yaml';
import { parseManifestWithTree } from '../parse.js';

/** One step down a path: a mapping key, or a list index. */
export type Step = string | number;

export type EditResult = { ok: true; text: string } | { ok: false; detail: string };

const INDENT = 2;

/** `spec.template.spec.containers[0]` plus `securityContext.privileged` becomes a list of steps. */
export function toSteps(...paths: string[]): Step[] {
  const steps: Step[] = [];
  for (const path of paths) {
    if (path === '') continue;
    for (const part of path.split('.')) {
      const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
      if (!match) throw new Error(`Bad path "${path}".`);
      steps.push(match[1] as string);
      for (const index of (match[2] as string).matchAll(/\[(\d+)\]/g)) {
        steps.push(Number(index[1]));
      }
    }
  }
  return steps;
}

const unsupported = (detail: string): EditResult => ({ ok: false, detail });

/**
 * Set the value at `steps` in one document by editing the source text itself. Only the lines that
 * need to change are touched, so comments, quoting, blank lines and other documents stay as written.
 * Flow style (`{ a: 1 }`, JSON) is edited in flow style, and a key that holds an alias
 * (`securityContext: *base`) gets a local override next to a `<<: *base` merge, so the shared anchor
 * and everything else that uses it stay untouched. Refuses (with a reason) any layout it cannot edit
 * exactly: other aliases, odd structures.
 */
export function setInSource(
  source: string,
  documentIndex: number,
  steps: Step[],
  value: unknown,
): EditResult {
  const tree = parseManifestWithTree(source)[documentIndex]?.tree;
  if (!tree) return unsupported('the document is no longer there');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  let node: unknown = tree.contents;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Step;
    if (isAlias(node)) return unsupported('a list item on the path is a YAML alias');
    const last = i === steps.length - 1;

    if (typeof step === 'number') {
      if (!isSeq(node)) return unsupported(`expected a list at step ${i + 1}`);
      node = node.items[step];
      if (node === undefined) return unsupported('a list item on the path does not exist');
      if (last) return unsupported('cannot replace a whole list item');
      continue;
    }

    if (!isMap(node)) return unsupported(`expected a mapping at "${step}"`);
    const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === step);
    if (!pair) {
      const rest = steps.slice(i);
      if (rest.some((s) => typeof s === 'number')) {
        return unsupported('cannot create a list item that does not exist');
      }
      return insertKeys(source, node, rest as string[], value, eol);
    }
    if (isAlias(pair.value)) {
      if (last) return unsupported('the value is a YAML alias');
      return overrideAlias(source, tree, node, pair, pair.value, steps.slice(i + 1), value, eol);
    }
    if (last) return replaceValue(source, node, pair, value, eol);

    const child = pair.value;
    if (child === null || child === undefined || isEmpty(child)) {
      const rest = steps.slice(i + 1);
      if (rest.some((r) => typeof r === 'number')) {
        return unsupported('cannot create a list item that does not exist');
      }
      return fillEmpty(source, node, pair, rest as string[], value, eol);
    }
    node = child;
  }
  return unsupported('empty path');
}

/**
 * Rename a mapping key in one document, touching only the key's own text. The mapping is found by
 * `steps`; quoting of the key is kept. Refuses when the key is not written in that mapping itself
 * (for example it comes in through a YAML merge) or the new name is already there.
 */
export function renameKeyInSource(
  source: string,
  documentIndex: number,
  steps: Step[],
  from: string,
  to: string,
): EditResult {
  const tree = parseManifestWithTree(source)[documentIndex]?.tree;
  if (!tree) return unsupported('the document is no longer there');
  let node: unknown = tree.contents;
  for (const step of steps) {
    if (isAlias(node)) return unsupported('a YAML alias is on the path');
    if (typeof step === 'number') {
      if (!isSeq(node)) return unsupported('expected a list on the path');
      node = node.items[step];
    } else {
      if (!isMap(node)) return unsupported(`expected a mapping at "${step}"`);
      node = node.items.find((p) => isScalar(p.key) && String(p.key.value) === step)?.value;
    }
    if (node === undefined) return unsupported('the path does not exist');
  }
  if (!isMap(node)) return unsupported('the parent is not a mapping');
  const keys = node.items
    .filter((p) => isScalar(p.key))
    .map((p) => String((p.key as Scalar).value));
  if (keys.includes(to)) return unsupported(`"${to}" already exists there`);
  const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === from);
  const range = pair && isScalar(pair.key) ? pair.key.range : undefined;
  if (!range) return unsupported('cannot locate the key');
  const old = source.slice(range[0], range[1]);
  const quote = old.startsWith('"') || old.startsWith("'") ? old[0] : '';
  return ok(source, range[0], range[1], `${quote}${to}${quote}`);
}

function isEmpty(node: unknown): boolean {
  if (isScalar(node)) return node.value === null || node.value === undefined;
  return isMap(node) && node.flow === true && node.items.length === 0;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

/** Offset where the line containing `offset` ends, before its `\r\n` or `\n`. */
function lineEnd(source: string, offset: number): number {
  const i = source.indexOf('\n', offset);
  if (i === -1) return source.length;
  return source[i - 1] === '\r' && i - 1 >= offset ? i - 1 : i;
}

function indentOf(source: string, offset: number): number {
  return offset - lineStart(source, offset);
}

/** Render `{ a: { b: value } }` as indented block lines. */
function renderBlock(keys: string[], value: unknown, indent: number): string[] {
  let nested: unknown = value;
  for (const key of [...keys].reverse()) nested = { [key]: nested };
  const text = stringify(nested, { indent: INDENT, lineWidth: 0 }).replace(/\n$/, '');
  return text.split('\n').map((line) => ' '.repeat(indent) + line);
}

function isCollection(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

/** True when the keys of this mapping are written "like this", as in JSON. */
function isJsonStyle(map: YAMLMap): boolean {
  const key = map.items[0]?.key;
  return isScalar(key) && key.type === 'QUOTE_DOUBLE';
}

/** `{ b: { c: value } }` on one line, without the outer braces: `b: {c: value}`. */
function renderFlowPairs(keys: string[], value: unknown, json: boolean): string {
  let nested: unknown = value;
  for (const key of [...keys].reverse()) nested = { [key]: nested };
  const text = stringify(nested, {
    collectionStyle: 'flow',
    lineWidth: 0,
    flowCollectionPadding: false,
    ...(json ? { defaultKeyType: 'QUOTE_DOUBLE', defaultStringType: 'QUOTE_DOUBLE' } : {}),
  }).trim();
  return text.slice(1, -1);
}

function renderFlowValue(value: unknown, json: boolean): string {
  return stringify(value, {
    collectionStyle: 'flow',
    lineWidth: 0,
    flowCollectionPadding: false,
    ...(json ? { defaultStringType: 'QUOTE_DOUBLE' } : {}),
  }).trim();
}

/** Add `rest` as new keys at the end of a flow mapping, on the same line or on a new one. */
function insertFlowKeys(
  source: string,
  map: YAMLMap,
  rest: string[],
  value: unknown,
  eol: string,
): EditResult {
  const first = map.items[0] as Pair | undefined;
  const lastPair = map.items[map.items.length - 1] as Pair | undefined;
  if (!first || !lastPair || !isScalar(first.key) || !first.key.range) {
    return unsupported('the mapping has no keys to align with');
  }
  const keyEnd = (lastPair.key as { range?: number[] }).range?.[1] ?? 0;
  const valueEnd = (lastPair.value as { range?: number[] } | null)?.range?.[1] ?? keyEnd;
  const end = Math.max(keyEnd, valueEnd);
  const pairs = renderFlowPairs(rest, value, isJsonStyle(map));

  // A mapping spread over several lines gets the new key on its own line, like the others.
  const firstStart = first.key.range[0];
  const ownLine = source.slice(lineStart(source, firstStart), firstStart).trim() === '';
  const text = ownLine
    ? `,${eol}${' '.repeat(indentOf(source, firstStart))}${pairs}`
    : `, ${pairs}`;
  return ok(source, end, end, text);
}

/**
 * A key whose value is an alias (`securityContext: *base`): put a local override next to a merge of
 * the alias (`<<: *base`). The anchor, and every other use of it, keeps its meaning exactly, and the
 * local keys win over merged ones. Only done when the override cannot hide something inherited.
 */
function overrideAlias(
  source: string,
  tree: { contents: unknown },
  parent: unknown,
  pair: Pair,
  alias: Alias,
  rest: Step[],
  value: unknown,
  eol: string,
): EditResult {
  if (rest.some((r) => typeof r === 'number')) {
    return unsupported('the path goes through a list inside a YAML alias');
  }
  const keys = rest as string[];
  const target = alias.resolve(tree as Parameters<Alias['resolve']>[0]);
  if (!isMap(target)) return unsupported('the YAML alias is not a mapping');
  const inherited = target.items.some((p) => isScalar(p.key) && String(p.key.value) === keys[0]);
  if (keys.length > 1 && inherited) {
    return unsupported(
      `"${keys[0]}" comes from a YAML alias and would be replaced as a whole, not merged`,
    );
  }
  if (!alias.range || !isScalar(pair.key) || !pair.key.range) {
    return unsupported('cannot locate the alias');
  }
  const [start, end] = alias.range;
  const ref = source.slice(start, end);

  if (isMap(parent) && parent.flow) {
    const pairs = renderFlowPairs(keys, value, isJsonStyle(parent));
    return ok(source, start, end, `{<<: ${ref}, ${pairs}}`);
  }
  const colon = source.indexOf(':', pair.key.range[1]);
  if (colon === -1 || colon >= start) return unsupported('cannot locate the key');
  const indent = indentOf(source, pair.key.range[0]) + INDENT;
  const lines = [`<<: ${ref}`, ...renderBlock(keys, value, 0)]
    .map((l) => ' '.repeat(indent) + l)
    .join(eol);
  return ok(source, colon + 1, end, `${eol}${lines}`);
}

/** Add `rest` as new keys at the end of a mapping. */
function insertKeys(
  source: string,
  map: YAMLMap,
  rest: string[],
  value: unknown,
  eol: string,
): EditResult {
  if (map.flow) return insertFlowKeys(source, map, rest, value, eol);
  const first = map.items[0];
  if (!first || !isScalar(first.key) || !first.key.range) {
    return unsupported('the mapping has no keys to align with');
  }
  const indent = indentOf(source, first.key.range[0]);
  const lines = renderBlock(rest, value, indent).join(eol);

  const lastPair = map.items[map.items.length - 1] as Pair;
  const keyEnd = (lastPair.key as { range?: number[] }).range?.[1] ?? 0;
  const valueEnd = (lastPair.value as { range?: number[] } | null)?.range?.[1] ?? keyEnd;
  const end = Math.max(keyEnd, valueEnd);

  // A block scalar's range already ends after its newline. Otherwise go to the end of the line,
  // which keeps a trailing comment on the line it belongs to.
  if (end > keyEnd && source[end - 1] === '\n') return ok(source, end, end, `${lines}${eol}`);
  const at = lineEnd(source, end);
  return ok(source, at, at, `${eol}${lines}`);
}

/** Replace the value of an existing key. */
function replaceValue(
  source: string,
  parent: unknown,
  pair: Pair,
  value: unknown,
  eol: string,
): EditResult {
  const old = pair.value;
  if (old === null || old === undefined || isEmpty(old)) {
    return fillEmpty(source, parent, pair, [], value, eol);
  }
  if (!isScalar(old) || !old.range) return unsupported('the existing value is a list or mapping');
  if (isCollection(value)) return unsupported('cannot merge into an existing value');
  const json = isMap(parent) && parent.flow === true && isJsonStyle(parent);
  const text = stringify(value, {
    lineWidth: 0,
    ...(json ? { defaultStringType: 'QUOTE_DOUBLE' } : {}),
  }).replace(/\n$/, '');
  return ok(source, old.range[0], old.range[1], text);
}

/** Give a key that has no value (`key:` or `key: {}`) its value, on the same line or below it. */
function fillEmpty(
  source: string,
  parent: unknown,
  pair: Pair,
  rest: string[],
  value: unknown,
  eol: string,
): EditResult {
  const keyRange = (pair.key as { range?: number[] }).range;
  if (!keyRange || keyRange[0] === undefined || keyRange[1] === undefined) {
    return unsupported('cannot locate the key');
  }
  const colon = source.indexOf(':', keyRange[1]);
  if (colon === -1) return unsupported('cannot locate the key');
  const indent = indentOf(source, keyRange[0]);
  const flow = pair.value && isMap(pair.value) && pair.value.range ? pair.value.range : undefined;
  const end = flow ? flow[1] : colon + 1;

  // Inside a { flow } mapping the value is written in flow style too, in place.
  if (isMap(parent) && parent.flow) {
    if (!flow) return unsupported('the key has no value to fill inside a { flow } mapping');
    const json = isJsonStyle(parent);
    const text =
      rest.length > 0 ? `{${renderFlowPairs(rest, value, json)}}` : renderFlowValue(value, json);
    return ok(source, flow[0], flow[1], text);
  }

  const after = source.slice(end, lineEnd(source, end));
  if (flow && after.trim() !== '') {
    return unsupported('a comment or text follows the empty { } on its line');
  }
  if (!flow && after.trim() !== '' && !after.trim().startsWith('#')) {
    return unsupported('the key has an unusual value');
  }

  if (rest.length === 0 && !isCollection(value)) {
    const text = stringify(value, { lineWidth: 0 }).replace(/\n$/, '');
    return ok(source, colon + 1, end, ` ${text}`);
  }
  let lines: string[];
  if (rest.length > 0) lines = renderBlock(rest, value, indent + INDENT);
  else {
    lines = stringify(value, { indent: INDENT, lineWidth: 0 })
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => ' '.repeat(indent + INDENT) + l);
  }
  const at = flow ? flow[1] : lineEnd(source, end);
  return ok(source, flow ? colon + 1 : at, flow ? flow[1] : at, `${eol}${lines.join(eol)}`);
}

function ok(source: string, start: number, end: number, text: string): EditResult {
  return { ok: true, text: source.slice(0, start) + text + source.slice(end) };
}
