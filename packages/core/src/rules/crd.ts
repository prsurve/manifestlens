import { isMap, parseAllDocuments } from 'yaml';
import { RuleError } from './load.js';
import type { CrdInfo, CrdSchema, Rule, Severity } from './types.js';

/** A pasted CRD bundle can be large (the Prometheus Operator's is over 1MB) but not unbounded. */
const MAX_CRD_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 40;

/**
 * Compile CustomResourceDefinitions into rules, one per served version. The rule has no condition of
 * its own: `matchRules` checks a manifest of that kind against its schema. Accepts several CRDs
 * separated by `---` and the `items` of a `kind: List`, as `kubectl get crd -o yaml` prints.
 */
export function parseCrds(text: string, origin = 'crd'): Rule[] {
  if (text.length > MAX_CRD_BYTES) throw new RuleError(`${origin}: the CRD text is too large.`);
  const rules: Rule[] = [];
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0) {
      throw new RuleError(`${origin}: ${doc.errors[0]?.message.split('\n')[0] ?? 'invalid YAML'}`);
    }
    if (doc.contents === null || !isMap(doc.contents)) continue;
    const data = doc.toJS() as Record<string, unknown>;
    const items = data.kind === 'List' && Array.isArray(data.items) ? data.items : [data];
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (item.kind !== 'CustomResourceDefinition') {
        throw new RuleError(
          `${origin}: expected a CustomResourceDefinition but found kind "${String(item.kind)}".`,
        );
      }
      rules.push(...fromCrd(item, origin));
    }
  }
  return rules;
}

function fromCrd(crd: Record<string, unknown>, origin: string): Rule[] {
  const spec = crd.spec;
  const names = isRecord(spec) && isRecord(spec.names) ? spec.names : undefined;
  const group = isRecord(spec) ? spec.group : undefined;
  const kind = names?.kind;
  if (!isRecord(spec) || typeof group !== 'string' || typeof kind !== 'string') {
    throw new RuleError(
      `${origin}: a CustomResourceDefinition needs spec.group and spec.names.kind.`,
    );
  }
  const versions = Array.isArray(spec.versions) ? spec.versions : [];
  const legacy = isRecord(spec.validation) ? spec.validation.openAPIV3Schema : undefined;
  const rules: Rule[] = [];
  for (const v of versions) {
    if (!isRecord(v) || typeof v.name !== 'string') continue;
    const schema = isRecord(v.schema) ? v.schema.openAPIV3Schema : legacy;
    if (!isRecord(schema)) continue;
    rules.push(crdRule({ group, version: v.name, kind, schema: schema as CrdSchema }, origin));
  }
  if (rules.length === 0) {
    throw new RuleError(`${origin}: ${kind} has no openAPIV3Schema, so there is nothing to check.`);
  }
  return rules;
}

function crdRule(crd: CrdInfo, origin: string): Rule {
  return {
    id: `crd-${crd.kind}-${crd.version}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title: `${crd.kind} matches its CustomResourceDefinition`,
    severity: 'warning',
    kinds: [crd.kind],
    scopes: ['document'],
    when: { op: 'any', conditions: [] },
    report: [],
    message: `${crd.kind} does not match its CustomResourceDefinition.`,
    origin,
    crd,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export type CrdIssueCode =
  | 'not-validated'
  | 'unknown-version'
  | 'unknown-field'
  | 'wrong-type'
  | 'invalid-value'
  | 'missing-required';

export interface CrdIssue {
  code: CrdIssueCode;
  /** Path of the field the issue is about, or of its parent for a missing field. */
  path: string;
  message: string;
  /** For an unknown field with exactly one clearly closest known name: the key to rename it to. */
  rename?: { parent: string; from: string; to: string };
}

export const CRD_ISSUES: Record<CrdIssueCode, { title: string; severity: Severity; why: string }> =
  {
    'not-validated': {
      title: 'Part of the schema cannot be checked',
      severity: 'info',
      why: 'ManifestLens does not evaluate oneOf, anyOf, allOf, not or CEL rules, so this part was not validated. "No findings" here does not mean it is valid.',
    },
    'unknown-version': {
      title: 'apiVersion is not in the CustomResourceDefinition',
      severity: 'warning',
      why: 'The API server only serves the versions the CustomResourceDefinition lists.',
    },
    'unknown-field': {
      title: 'Field is not in the CustomResourceDefinition',
      severity: 'warning',
      why: 'The API server drops fields it does not know, or rejects the manifest, so this setting is probably a typo and has no effect.',
    },
    'wrong-type': {
      title: 'Field has the wrong type',
      severity: 'error',
      why: 'The API server rejects a value of the wrong type.',
    },
    'invalid-value': {
      title: 'Field value is not allowed',
      severity: 'error',
      why: 'The CustomResourceDefinition restricts this value and the API server rejects anything else.',
    },
    'missing-required': {
      title: 'Required field is missing',
      severity: 'error',
      why: 'The CustomResourceDefinition marks this field as required and the API server rejects the manifest without it.',
    },
  };

/** Fields every object has, whatever the CRD says. */
const ENVELOPE = new Set(['apiVersion', 'kind', 'metadata']);

/** Check a custom resource against its schema. Only what a schema can state for certain is reported. */
export function validateAgainst(data: Record<string, unknown>, schema: CrdSchema): CrdIssue[] {
  const issues: CrdIssue[] = [];
  const root: CrdSchema = { ...schema, type: 'object' };
  walk(data, root, '', issues, 0, true);
  return issues;
}

function walk(
  value: unknown,
  schema: CrdSchema,
  path: string,
  issues: CrdIssue[],
  depth: number,
  top = false,
): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  // oneOf/anyOf/allOf/not need a full validator; guessing would give false alarms, so say so.
  const cel = (schema as Record<string, unknown>)['x-kubernetes-validations'];
  if (schema.oneOf || schema.anyOf || schema.allOf || schema.not || Array.isArray(cel)) {
    const where = path === '' ? 'The document' : `"${path}"`;
    issues.push({
      code: 'not-validated',
      path,
      message: `${where} uses schema rules (oneOf, anyOf, allOf, not or CEL) that ManifestLens cannot check, so it was only partly validated.`,
    });
    if (schema.oneOf || schema.anyOf || schema.allOf || schema.not) return;
  }

  const label = path === '' ? 'the document' : `"${path}"`;
  if (schema['x-kubernetes-int-or-string']) {
    if (typeof value !== 'string' && !isInteger(value)) {
      issues.push(typeIssue(path, label, 'an integer or a string', value));
    }
    return;
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    issues.push(typeIssue(path, label, article(schema.type), value));
    return;
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    issues.push({
      code: 'invalid-value',
      path,
      message: `${label} is ${show(value)}, but only ${schema.enum.map(show).join(', ')} are allowed.`,
    });
  }
  if (typeof value === 'string') checkString(value, schema, path, label, issues);
  if (typeof value === 'number') checkNumber(value, schema, path, label, issues);

  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, i) =>
        walk(item, schema.items as CrdSchema, `${path}[${i}]`, issues, depth + 1),
      );
    }
    return;
  }
  if (typeof value === 'object')
    walkObject(value as Record<string, unknown>, schema, path, issues, depth, top);
}

function walkObject(
  obj: Record<string, unknown>,
  schema: CrdSchema,
  path: string,
  issues: CrdIssue[],
  depth: number,
  top: boolean,
): void {
  const props = schema.properties;
  const extra = schema.additionalProperties;
  const open = schema['x-kubernetes-preserve-unknown-fields'] === true;
  for (const name of schema.required ?? []) {
    if (obj[name] === undefined && !(top && ENVELOPE.has(name))) {
      issues.push({
        code: 'missing-required',
        path,
        message: `${path === '' ? 'The document' : `"${path}"`} has no required field "${name}".`,
      });
    }
  }
  for (const [key, child] of Object.entries(obj)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (top && ENVELOPE.has(key)) continue;
    const known = props !== undefined && Object.hasOwn(props, key) ? props[key] : undefined;
    if (known) walk(child, known, childPath, issues, depth + 1);
    else if (typeof extra === 'object') walk(child, extra, childPath, issues, depth + 1);
    else if (props !== undefined && extra !== true && !open) {
      const near = nearest(key, Object.keys(props));
      const to = near.length === 1 ? near[0] : undefined;
      // Only a plain key with one clear match, and no field of that name already there, is renamed.
      const renamable = to !== undefined && /^[\w-]+$/.test(key) && !Object.hasOwn(obj, to);
      issues.push({
        code: 'unknown-field',
        path: childPath,
        message: `"${childPath}" is not a field of this custom resource.${hint(near)}`,
        ...(renamable ? { rename: { parent: path, from: key, to } } : {}),
      });
    }
  }
}

function checkString(
  s: string,
  schema: CrdSchema,
  path: string,
  label: string,
  issues: CrdIssue[],
): void {
  const bad = (message: string) => issues.push({ code: 'invalid-value', path, message });
  if (schema.minLength !== undefined && s.length < schema.minLength) {
    bad(`${label} must be at least ${schema.minLength} characters long.`);
  }
  if (schema.maxLength !== undefined && s.length > schema.maxLength) {
    bad(`${label} must be at most ${schema.maxLength} characters long.`);
  }
  if (schema.pattern !== undefined && s.length <= 2000) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      // A Go (RE2) pattern JavaScript cannot read: say nothing rather than guess.
    }
    if (re && !re.test(s))
      bad(`${label} is ${show(s)}, which does not match the pattern ${schema.pattern}.`);
  }
}

function checkNumber(
  n: number,
  schema: CrdSchema,
  path: string,
  label: string,
  issues: CrdIssue[],
): void {
  if (schema.minimum !== undefined && n < schema.minimum) {
    issues.push({
      code: 'invalid-value',
      path,
      message: `${label} is ${n}, below the minimum of ${schema.minimum}.`,
    });
  }
  if (schema.maximum !== undefined && n > schema.maximum) {
    issues.push({
      code: 'invalid-value',
      path,
      message: `${label} is ${n}, above the maximum of ${schema.maximum}.`,
    });
  }
}

function isInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v);
}

function matchesType(v: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof v === 'object' && !Array.isArray(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'boolean':
      return typeof v === 'boolean';
    default:
      return true;
  }
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

function describeType(v: unknown): string {
  return Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'a mapping' : article(typeof v);
}

function typeIssue(path: string, label: string, want: string, got: unknown): CrdIssue {
  return {
    code: 'wrong-type',
    path,
    message: `${label} should be ${want}, but it is ${describeType(got)}.`,
  };
}

function show(v: unknown): string {
  return typeof v === 'string' ? `"${v}"` : String(v);
}

/** The known names closest to `key` (all tied at the smallest distance), if any is a likely typo. */
function nearest(key: string, known: string[]): string[] {
  const lower = known.filter((k) => k.toLowerCase() === key.toLowerCase());
  if (lower.length > 0) return lower;
  const limit = key.length >= 5 ? 2 : 1;
  let best = limit + 1;
  let found: string[] = [];
  for (const k of known) {
    const d = editDistance(key, k);
    if (d < best) {
      best = d;
      found = [k];
    } else if (d === best && d <= limit) found.push(k);
  }
  return best <= limit ? found : [];
}

function hint(near: string[]): string {
  if (near.length === 0) return '';
  const names = near.slice(0, 3).map((k) => `"${k}"`);
  return ` Did you mean ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`}?`;
}

/** Edits to turn `a` into `b`; swapping two neighbouring letters (`nmae`) counts as one. */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        row[j] = j;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        (rows[i - 1]?.[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (rows[i - 1]?.[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (rows[i - 2]?.[j - 2] ?? 0) + 1);
      }
      row[j] = d;
    }
    rows.push(row);
  }
  return rows[a.length]?.[b.length] ?? 0;
}

/** The description the CRD gives for a field pattern like `spec.dnsNames[]`. */
export function describeCrdField(schema: CrdSchema, pattern: string): string | undefined {
  let node: CrdSchema | undefined = schema;
  let text: string | undefined;
  for (const token of pattern.split('.')) {
    if (!node) return undefined;
    const each = token.endsWith('[]');
    const key = each ? token.slice(0, -2) : token;
    const next: CrdSchema | undefined =
      node.properties && Object.hasOwn(node.properties, key)
        ? node.properties[key]
        : typeof node.additionalProperties === 'object'
          ? node.additionalProperties
          : undefined;
    if (!next) return undefined;
    node = each ? next.items : next;
    text = node?.description || next.description;
  }
  text = text?.replace(/\s+/g, ' ').trim();
  return text ? text : undefined;
}
