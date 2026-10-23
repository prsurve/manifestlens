import { parseManifestWithTree } from '../parse.js';
import { matchRules } from '../rules/check.js';
import { kindCoverage } from '../rules/coverage.js';
import type { RuleMatch } from '../rules/check.js';
import { evaluate, resolve } from '../rules/evaluate.js';
import type { Finding, FixSet, FixSpec, Rule } from '../rules/types.js';
import { diffLines } from './diff.js';
import { renameKeyInSource, setInSource, toSteps } from './edit.js';
import type { Step } from './edit.js';
import { fingerprint } from './hash.js';
import { RISK_ORDER } from './types.js';
import type {
  AppliedFix,
  FixChange,
  FixOptions,
  FixResult,
  FixTarget,
  FixValidation,
  IntroducedFinding,
  SkipReason,
  SkippedFix,
  UncheckedDocument,
  UnfixedFinding,
} from './types.js';

interface Analysis {
  /** Documents that parsed cleanly, with what the rules found. */
  matches: { documentIndex: number; match: RuleMatch; kind?: string; name?: string }[];
  /** Number of YAML problems in the whole file. */
  issues: number;
  documents: { kind?: string; name?: string; canon: string }[];
  notChecked: UncheckedDocument[];
}

function analyze(text: string, rules: Rule[]): Analysis {
  const parsed = parseManifestWithTree(text);
  const out: Analysis = { matches: [], issues: 0, documents: [], notChecked: [] };
  for (const { manifest: doc } of parsed) {
    out.issues += doc.issues.length;
    const coverage = kindCoverage(doc.kind, doc.apiVersion, rules);
    if (
      coverage.level !== 'checked' &&
      coverage.headline &&
      coverage.detail &&
      coverage.note &&
      coverage.message
    ) {
      out.notChecked.push({
        document: doc.index,
        line: doc.startLine,
        level: coverage.level,
        headline: coverage.headline,
        detail: coverage.detail,
        note: coverage.note,
        message: coverage.message,
        ...(coverage.suggestion !== undefined ? { suggestion: coverage.suggestion } : {}),
        ...(doc.kind !== undefined ? { kind: doc.kind } : {}),
        ...(doc.name !== undefined ? { name: doc.name } : {}),
      });
    }
    out.documents.push({
      ...(doc.kind !== undefined ? { kind: doc.kind } : {}),
      ...(doc.name !== undefined ? { name: doc.name } : {}),
      canon: canon(doc.data),
    });
    for (const match of matchRules(doc, rules)) {
      out.matches.push({
        documentIndex: doc.index,
        match,
        ...(doc.kind !== undefined ? { kind: doc.kind } : {}),
        ...(doc.name !== undefined ? { name: doc.name } : {}),
      });
    }
  }
  return out;
}

/** Documents with YAML problems are never edited: their structure cannot be trusted. */
function brokenDocuments(text: string): Set<number> {
  return new Set(
    parseManifestWithTree(text)
      .filter((d) => d.manifest.issues.length > 0)
      .map((d) => d.manifest.index),
  );
}

/** JSON with sorted keys, so two equal data structures compare equal. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

const slot = (a: Analysis['matches'][number]): string =>
  `${a.match.rule.id}|${a.documentIndex}|${a.match.instance.path}`;

function countSlots(matches: Analysis['matches']): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of matches) counts.set(slot(m), (counts.get(slot(m)) ?? 0) + 1);
  return counts;
}

/** Findings in `after` beyond what `before` already had. */
function newFindings(before: Analysis, after: Analysis): IntroducedFinding[] {
  const known = countSlots(before.matches);
  const seen = new Map<string, number>();
  const out: IntroducedFinding[] = [];
  for (const m of after.matches) {
    const key = slot(m);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > (known.get(key) ?? 0)) out.push(toIntroduced(m.match.finding));
  }
  return out;
}

function toIntroduced(f: Finding): IntroducedFinding {
  return { ruleId: f.ruleId, severity: f.severity, message: f.message, line: f.line };
}

interface Resolved {
  set: FixSet;
  value: unknown;
}

/** Fill in policy parameters. Returns a skip reason when a value is missing or unacceptable. */
function resolveValues(
  spec: FixSpec,
  params: Record<string, unknown>,
): { values: Resolved[] } | { reason: SkipReason; detail: string } {
  const values: Resolved[] = [];
  for (const set of spec.set) {
    if (set.param === undefined) {
      values.push({ set, value: set.value });
      continue;
    }
    if (!Object.hasOwn(params, set.param)) {
      return {
        reason: 'needs-input',
        detail: `Needs the policy value "${set.param}": add it under "params:" in the fix policy.`,
      };
    }
    const value = params[set.param];
    const items = Array.isArray(value) ? value : [value];
    const scalar = (v: unknown): boolean =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    if (items.length === 0 || !items.every(scalar)) {
      return {
        reason: 'invalid-input',
        detail: `Policy parameter "${set.param}" must be a value or a non-empty list of values.`,
      };
    }
    if (set.pattern && !items.every((v) => set.pattern?.test(String(v)))) {
      return {
        reason: 'invalid-input',
        detail: `Policy parameter "${set.param}" does not look right (must match ${set.pattern.source}).`,
      };
    }
    values.push({ set, value });
  }
  return { values };
}

function setDeep(root: unknown, steps: Step[], value: unknown): void {
  let node = root as Record<string | number, unknown>;
  steps.forEach((step, i) => {
    if (i === steps.length - 1) {
      node[step] = value;
      return;
    }
    const next = node[step];
    if (next === null || typeof next !== 'object') node[step] = {};
    node = node[step] as Record<string | number, unknown>;
  });
}

/** The expected data after renaming `from` to `to` in the mapping at `steps`. */
function renameDeep(root: unknown, steps: Step[], from: string, to: string): void {
  let node = root as Record<string | number, unknown> | undefined;
  for (const step of steps) node = node?.[step] as Record<string | number, unknown> | undefined;
  if (node === undefined || node === null || typeof node !== 'object') return;
  node[to] = node[from];
  Reflect.deleteProperty(node, from);
}

/** Where a line of the current text sits in the original: earlier fixes insert lines above it. */
function originalLine(source: string, text: string, line: number): number {
  if (source === text) return line;
  let before = 0;
  let after = 0;
  let last = 0;
  for (const op of diffLines(source, text)) {
    if (op.type !== 'del') after++;
    if (op.type !== 'add') before++;
    if (op.type === 'same') last = before;
    if (after === line) return op.type === 'same' ? before : Math.max(last, 1);
  }
  return line;
}

const fullPath = (scope: string, path: string): string =>
  scope === '' ? path : `${scope}.${path}`;
const target = (
  documentIndex: number,
  kind: string | undefined,
  name: string | undefined,
  scope: string,
): FixTarget => ({
  document: documentIndex,
  ...(kind !== undefined ? { kind } : {}),
  ...(name !== undefined ? { name } : {}),
  scope,
});

/**
 * Compute fixes for a manifest. Pure and offline: nothing is read or written. Fixes are applied one
 * at a time to the text, and each is re-checked (the YAML still parses, only the intended fields
 * changed, its finding is gone, no new finding appeared) before the next one is planned. A fix that
 * fails any check is dropped and reported; it never reaches the result.
 */
export function fixManifest(source: string, rules: Rule[], options: FixOptions = {}): FixResult {
  const maxRisk = RISK_ORDER[options.maxRisk ?? 'low'];
  const params = options.policy?.params ?? {};
  const only = options.only ? new Set(options.only) : undefined;
  const budget = options.maxFixes ?? 500;

  const original = analyze(source, rules);
  // `findings` refers to the original text, which shifts as fixes go in, so pin it to slots now.
  const allowed = options.findings
    ? new Set(
        original.matches
          .filter((m) =>
            options.findings?.some(
              (f) => f.ruleId === m.match.rule.id && f.line === m.match.finding.line,
            ),
          )
          .map(slot),
      )
    : undefined;
  const broken = brokenDocuments(source);
  const applied: AppliedFix[] = [];
  const skipped = new Map<string, SkippedFix>();
  const attempted = new Set<string>();
  const touched = new Map<string, string>();
  let text = source;

  for (let attempts = 0; attempts < budget;) {
    const state = analyze(text, rules);
    const candidates = state.matches
      .filter(
        (m) =>
          m.match.rule.autofix !== undefined &&
          !broken.has(m.documentIndex) &&
          (!only || only.has(m.match.rule.id)) &&
          (!allowed || allowed.has(slot(m))),
      )
      .sort(
        (a, b) =>
          a.documentIndex - b.documentIndex ||
          a.match.finding.line - b.match.finding.line ||
          a.match.rule.id.localeCompare(b.match.rule.id),
      );

    let progressed = false;
    for (const candidate of candidates) {
      const key = slot(candidate);
      if (attempted.has(key)) continue;
      attempted.add(key);
      attempts++;

      const outcome = attempt(text, state, candidate, rules, { maxRisk, params, touched, source });
      if ('skip' in outcome) {
        skipped.set(key, outcome.skip);
      } else {
        // A change can make an earlier "not safe here" verdict obsolete, so look at those again.
        for (const [k, s] of skipped) {
          if (s.reason !== 'precondition-failed' && s.reason !== 'conflict') continue;
          skipped.delete(k);
          attempted.delete(k);
        }
        text = outcome.text;
        applied.push(outcome.applied);
        for (const c of outcome.applied.changes) {
          touched.set(`${candidate.documentIndex}|${c.path}`, c.after);
        }
        progressed = true;
        break;
      }
      if (attempts >= budget) break;
    }
    if (!progressed) break;
  }

  return finish(source, text, rules, original, applied, [...skipped.values()]);
}

interface Context {
  maxRisk: number;
  params: Record<string, unknown>;
  touched: Map<string, string>;
  /** The original text, for reporting lines. */
  source: string;
}

function attempt(
  text: string,
  state: Analysis,
  candidate: Analysis['matches'][number],
  rules: Rule[],
  ctx: Context,
): { text: string; applied: AppliedFix } | { skip: SkippedFix } {
  const { rule, instance, finding } = candidate.match;
  const spec = rule.autofix as FixSpec;
  const reported = originalLine(ctx.source, text, finding.line);
  const where = target(candidate.documentIndex, candidate.kind, candidate.name, instance.path);
  const skip = (reason: SkipReason, detail: string): { skip: SkippedFix } => ({
    skip: { ruleId: rule.id, reason, detail, risk: spec.risk, target: where, line: reported },
  });

  if (RISK_ORDER[spec.risk] > ctx.maxRisk) {
    return skip(
      'risk-too-high',
      `Risk is ${spec.risk}. Review the change, then allow it with --max-risk ${spec.risk}.`,
    );
  }
  if (spec.requires && !evaluate(spec.requires, candidate.match.ctx)) {
    return skip(
      'precondition-failed',
      spec.blockedMessage ?? 'The surrounding settings make this fix unsafe or ambiguous.',
    );
  }
  if (spec.rename) {
    const { parent, from, to } = spec.rename;
    const result = renameKeyInSource(text, candidate.documentIndex, toSteps(parent), from, to);
    if (!result.ok)
      return skip('unsupported-layout', `Cannot rename this safely: ${result.detail}.`);
    const moved = (want: unknown): void => renameDeep(want, toSteps(parent), from, to);
    const problem = verifyStep(text, result.text, state, candidate, rules, moved);
    if (problem) return skip('validation-failed', problem);
    return {
      text: result.text,
      applied: {
        ruleId: rule.id,
        risk: spec.risk,
        summary: spec.summary,
        target: where,
        line: reported,
        changes: [
          {
            path: parent === '' ? 'the document' : parent,
            before: `key "${from}"`,
            after: `key "${to}"`,
          },
        ],
      },
    };
  }
  const resolved = resolveValues(spec, ctx.params);
  if ('reason' in resolved) return skip(resolved.reason, resolved.detail);

  const changes: FixChange[] = [];
  const edits: { steps: Step[]; value: unknown }[] = [];
  for (const { set, value } of resolved.values) {
    const path = fullPath(instance.path, set.path);
    for (const [other, after] of ctx.touched) {
      const [doc, otherPath] = [
        other.slice(0, other.indexOf('|')),
        other.slice(other.indexOf('|') + 1),
      ];
      const overlaps =
        doc === String(candidate.documentIndex) &&
        (otherPath === path ||
          otherPath.startsWith(`${path}.`) ||
          path.startsWith(`${otherPath}.`));
      if (overlaps && (otherPath !== path || after !== canon(value))) {
        return skip('conflict', `Another fix already changed ${otherPath} in this run.`);
      }
    }
    const current = resolve(instance.data, set.path)[0]?.value;
    changes.push({
      path,
      before: current === undefined ? 'absent' : (JSON.stringify(current) ?? 'absent'),
      after: JSON.stringify(value) ?? 'null',
    });
    edits.push({ steps: toSteps(instance.path, set.path), value });
  }

  let next = text;
  for (const edit of edits) {
    const result = setInSource(next, candidate.documentIndex, edit.steps, edit.value);
    if (!result.ok) return skip('unsupported-layout', `Cannot edit this safely: ${result.detail}.`);
    next = result.text;
  }
  if (next === text) return skip('precondition-failed', 'The field already has this value.');

  const problem = verifyStep(text, next, state, candidate, rules, (want) => {
    for (const e of edits) setDeep(want, e.steps, e.value);
  });
  if (problem) return skip('validation-failed', problem);

  return {
    text: next,
    applied: {
      ruleId: rule.id,
      risk: spec.risk,
      summary: spec.summary,
      target: where,
      line: reported,
      changes,
    },
  };
}

/** Checks one fix against the text before it. Returns a description of the problem, or undefined. */
function verifyStep(
  before: string,
  after: string,
  state: Analysis,
  candidate: Analysis['matches'][number],
  rules: Rule[],
  change: (want: unknown) => void,
): string | undefined {
  const parsed = parseManifestWithTree(after);
  if (parsed.length !== state.documents.length) return 'The number of documents changed.';
  if (parsed.reduce((n, d) => n + d.manifest.issues.length, 0) > state.issues) {
    return 'The result has YAML problems.';
  }

  // Only the intended fields may differ.
  const expected = parseManifestWithTree(before);
  for (const [i, d] of parsed.entries()) {
    let want = (expected[i] as { manifest: { data?: unknown } }).manifest.data;
    if (i === candidate.documentIndex) {
      want = want === undefined ? want : (JSON.parse(JSON.stringify(want)) as unknown);
      change(want);
    }
    if (canon(want) !== canon(d.manifest.data)) {
      return i === candidate.documentIndex
        ? 'The edit changed more than the intended fields.'
        : 'The edit changed another document.';
    }
  }

  const now = analyze(after, rules);
  const slotNow = countSlots(now.matches).get(slot(candidate)) ?? 0;
  const slotBefore = countSlots(state.matches).get(slot(candidate)) ?? 0;
  if (slotNow >= slotBefore) return 'The finding is still reported after the fix.';
  const introduced = newFindings(state, now);
  if (introduced.length > 0) {
    return `The fix would introduce ${introduced.map((f) => f.ruleId).join(', ')}.`;
  }
  return undefined;
}

function finish(
  source: string,
  text: string,
  rules: Rule[],
  original: Analysis,
  applied: AppliedFix[],
  skipped: SkippedFix[],
): FixResult {
  const base = {
    original: source,
    sourceHash: fingerprint(source),
    skipped,
    withoutFix: original.matches.filter((m) => m.match.rule.autofix === undefined).length,
    unfixed: original.matches
      .filter((m) => m.match.rule.autofix === undefined)
      .map((m): UnfixedFinding => ({
        ruleId: m.match.rule.id,
        severity: m.match.finding.severity,
        message: m.match.finding.message,
        line: m.match.finding.line,
        ...(m.kind !== undefined ? { kind: m.kind } : {}),
        ...(m.name !== undefined ? { name: m.name } : {}),
      })),
    notChecked: original.notChecked,
  };
  if (text === source) {
    return {
      ...base,
      status: 'unchanged',
      fixed: source,
      applied: [],
      remaining: original.matches.length,
      validation: { ok: true, resolved: 0, introduced: [], problems: [] },
    };
  }

  // Independent end-to-end check of the final text, on top of the per-fix checks.
  const final = analyze(text, rules);
  const problems: string[] = [];
  if (final.documents.length !== original.documents.length)
    problems.push('The number of documents changed.');
  if (final.issues > original.issues) problems.push('The result has YAML problems.');
  const introduced = newFindings(original, final);
  if (introduced.length > 0) problems.push('The result has findings the original did not.');
  const validation: FixValidation = {
    ok: problems.length === 0,
    resolved: Math.max(original.matches.length - final.matches.length + introduced.length, 0),
    introduced,
    problems,
  };
  if (!validation.ok) {
    return {
      ...base,
      status: 'rejected',
      fixed: source,
      applied: [],
      remaining: original.matches.length,
      validation,
    };
  }
  return {
    ...base,
    status: 'fixed',
    fixed: text,
    applied,
    remaining: final.matches.length,
    validation,
  };
}

/**
 * Confirm that a result still applies to `current` text before writing it out. Editors and the CLI
 * call this just before saving, so a file edited since the preview is never overwritten.
 */
export function isStale(result: FixResult, current: string): boolean {
  return fingerprint(current) !== result.sourceHash;
}
