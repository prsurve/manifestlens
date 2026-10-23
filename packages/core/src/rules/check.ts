import { POD_SPEC_PATH } from '../fields/locate.js';
import { parseManifest } from '../parse.js';
import type { FieldNode, ManifestDocument } from '../types.js';
import { kindCoverage } from './coverage.js';
import { CRD_ISSUES, validateAgainst } from './crd.js';
import type { CrdIssue, CrdIssueCode } from './crd.js';
import { evaluate, isPodPath, resolve } from './evaluate.js';
import type { EvalContext } from './evaluate.js';
import type { CheckResult, CheckedDocument, Finding, Rule, RuleScope } from './types.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export interface ScopeInstance {
  /** Path of the scope inside the document, `''` for the whole document. */
  path: string;
  data: unknown;
  /** Container name, when the scope is a container. */
  container?: string;
}

/** Run rules against every document of a manifest. */
export function checkManifest(source: string, rules: Rule[]): CheckResult {
  return { documents: parseManifest(source).map((doc) => checkDocument(doc, rules)) };
}

/** One rule that fired, with the scope instance and evaluation context it fired in. */
export interface RuleMatch {
  rule: Rule;
  instance: ScopeInstance;
  ctx: EvalContext;
  finding: Finding;
}

/** Evaluate rules against one document. Matches come in rule order, then scope order. */
export function matchRules(doc: ManifestDocument, rules: Rule[]): RuleMatch[] {
  const matches: RuleMatch[] = [];
  if (!doc.data || !doc.kind) return matches;

  const kind = doc.kind;
  const fieldsByPath = new Map<string, FieldNode>(doc.fields.map((f) => [f.path, f]));
  const podPath = Object.hasOwn(POD_SPEC_PATH, kind) ? POD_SPEC_PATH[kind] : undefined;
  const podData = podPath === undefined ? undefined : get(doc.data, podPath);

  matches.push(...crdMatches(doc, kind, rules, fieldsByPath));

  for (const rule of rules) {
    if (rule.crd || (!rule.kinds.includes('*') && !rule.kinds.includes(kind))) continue;
    for (const scope of rule.scopes) {
      for (const instance of scopeInstances(scope, doc.data, podPath, podData)) {
        const ctx: EvalContext = { scope: instance.data, pod: podData };
        if (!evaluate(rule.when, ctx)) continue;
        matches.push({
          rule,
          instance,
          ctx,
          finding: buildFinding(rule, instance, ctx, doc, podPath, fieldsByPath),
        });
      }
    }
  }
  return matches;
}

/** Findings from the CustomResourceDefinitions that describe this document's kind. */
function crdMatches(
  doc: ManifestDocument,
  kind: string,
  rules: Rule[],
  fieldsByPath: Map<string, FieldNode>,
): RuleMatch[] {
  if (!doc.data) return [];
  const known = rules.filter((r) => r.crd && r.crd.kind === kind);
  if (known.length === 0) return [];
  const data = doc.data;
  const here = known.find((r) => r.crd && `${r.crd.group}/${r.crd.version}` === doc.apiVersion);
  const make = (
    rule: Rule,
    code: CrdIssueCode,
    issue: CrdIssue | undefined,
    message: string,
  ): RuleMatch => {
    const info = CRD_ISSUES[code];
    const derived: Rule = {
      ...rule,
      id: `crd-${code}`,
      title: info.title,
      severity: info.severity,
      why: info.why,
      ...(issue?.rename
        ? {
            autofix: {
              risk: 'medium',
              summary: `Rename "${issue.rename.from}" to "${issue.rename.to}". The settings under it will start to apply, where before they were ignored.`,
              set: [],
              rename: issue.rename,
            },
          }
        : {}),
    };
    const node = issue ? fieldsByPath.get(issue.path) : undefined;
    // A list item has no field of its own: point at its first key. The document itself, at its start.
    const inside =
      issue && !node && issue.path !== ''
        ? doc.fields.filter((f) => f.path.startsWith(`${issue.path}.`)).map((f) => f.line)
        : [];
    return {
      rule: derived,
      instance: { path: issue?.path ?? '', data },
      ctx: { scope: data, pod: undefined },
      finding: {
        ruleId: derived.id,
        title: info.title,
        severity: info.severity,
        message,
        why: info.why,
        line: node?.line ?? (inside.length > 0 ? Math.min(...inside) : doc.startLine),
        ...(node ? { path: node.path } : {}),
      },
    };
  };
  if (!here?.crd) {
    const versions = known.map((r) => `${r.crd?.group}/${r.crd?.version}`).join(', ');
    const rule = known[0] as Rule;
    return [
      make(
        rule,
        'unknown-version',
        undefined,
        `${kind} uses apiVersion "${doc.apiVersion ?? ''}", but its CustomResourceDefinition defines ${versions}.`,
      ),
    ];
  }
  return validateAgainst(data, here.crd.schema).map((issue) =>
    make(here, issue.code, issue, issue.message),
  );
}

function checkDocument(doc: ManifestDocument, rules: Rule[]): CheckedDocument {
  const checked: CheckedDocument = {
    index: doc.index,
    startLine: doc.startLine,
    issues: doc.issues,
    coverage: kindCoverage(doc.kind, doc.apiVersion, rules),
    findings: matchRules(doc, rules).map((m) => m.finding),
    ...(doc.apiVersion !== undefined ? { apiVersion: doc.apiVersion } : {}),
    ...(doc.kind !== undefined ? { kind: doc.kind } : {}),
    ...(doc.name !== undefined ? { name: doc.name } : {}),
  };
  checked.findings.sort(
    (a, b) =>
      a.line - b.line ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return checked;
}

function get(data: unknown, path: string): unknown {
  return resolve(data, path)[0]?.value;
}

function scopeInstances(
  scope: RuleScope,
  data: Record<string, unknown>,
  podPath: string | undefined,
  podData: unknown,
): ScopeInstance[] {
  if (scope === 'document') return [{ path: '', data }];
  if (podPath === undefined || podData === undefined) return [];
  if (scope === 'pod') return [{ path: podPath, data: podData }];

  const list = scope === 'container' ? 'containers' : 'initContainers';
  const items = (podData as Record<string, unknown>)[list];
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown, i): ScopeInstance[] => {
    if (item === null || typeof item !== 'object') return [];
    const name = (item as Record<string, unknown>).name;
    return [
      {
        path: `${podPath}.${list}[${i}]`,
        data: item,
        ...(typeof name === 'string' ? { container: name } : {}),
      },
    ];
  });
}

function buildFinding(
  rule: Rule,
  instance: ScopeInstance,
  ctx: EvalContext,
  doc: ManifestDocument,
  podPath: string | undefined,
  fieldsByPath: Map<string, FieldNode>,
): Finding {
  // Point at the first `report` path that exists; otherwise at the scope itself.
  let node: FieldNode | undefined;
  let value: unknown;
  for (const reportPath of rule.report) {
    const base = isPodPath(reportPath) ? ctx.pod : ctx.scope;
    const basePath = isPodPath(reportPath) ? podPath : instance.path;
    const match = resolve(base, reportPath)[0];
    if (!match) continue;
    const full = basePath ? `${basePath}.${match.path}` : match.path;
    node = fieldsByPath.get(full);
    value = match.value;
    if (node) break;
  }

  const line = node?.line ?? scopeLine(instance, doc);
  const text = fill(rule.message, {
    name: doc.name ?? '',
    kind: doc.kind ?? '',
    container: instance.container ?? '',
    value: typeof value === 'object' ? '' : String(value ?? ''),
  });
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    message: text,
    line,
    ...(rule.why !== undefined ? { why: rule.why } : {}),
    ...(rule.fix !== undefined ? { fix: rule.fix } : {}),
    ...(node ? { path: node.path } : {}),
  };
}

/** The line of a scope: its first key (for a container, the line of its first field). */
function scopeLine(instance: ScopeInstance, doc: ManifestDocument): number {
  if (instance.path === '') return doc.startLine;
  const prefix = `${instance.path}.`;
  const lines = doc.fields.filter((f) => f.path.startsWith(prefix)).map((f) => f.line);
  const own = doc.fields.find((f) => f.path === instance.path);
  return lines.length > 0 ? Math.min(...lines) : (own?.line ?? doc.startLine);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}
