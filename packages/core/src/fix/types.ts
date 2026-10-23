import type { FixRisk, Severity } from '../rules/types.js';

export const RISK_ORDER: Record<FixRisk, number> = { low: 0, medium: 1, high: 2 };

/** Values a team supplies for fixes that cannot guess them, such as a memory limit. */
export interface FixPolicy {
  params: Record<string, unknown>;
}

export interface FixOptions {
  /** Highest risk to apply. Default `low`; anything above is reported, not applied. */
  maxRisk?: FixRisk;
  policy?: FixPolicy;
  /** Only consider these rule ids. */
  only?: string[];
  /**
   * Only fix these findings, named by rule id and 1-based line in the original text. Lets an editor
   * fix the one finding under the cursor, and a CI job skip findings its settings ignore.
   */
  findings?: { ruleId: string; line: number }[];
  /** Safety valve against runaway loops. Default 500. */
  maxFixes?: number;
}

export interface FixTarget {
  /** 0-based document position in the file. */
  document: number;
  kind?: string;
  name?: string;
  /** Path of the scope the rule fired in, e.g. `spec.template.spec.containers[0]`; `''` for the document. */
  scope: string;
}

export interface FixChange {
  /** Full path of the changed field. */
  path: string;
  /** The value before, as JSON, or `absent`. */
  before: string;
  /** The value after, as JSON. */
  after: string;
}

export interface AppliedFix {
  ruleId: string;
  risk: FixRisk;
  summary: string;
  target: FixTarget;
  /** 1-based line of the finding in the original file. */
  line: number;
  changes: FixChange[];
}

export type SkipReason =
  | 'risk-too-high'
  | 'needs-input'
  | 'invalid-input'
  | 'precondition-failed'
  | 'unsupported-layout'
  | 'conflict'
  | 'validation-failed';

export interface SkippedFix {
  ruleId: string;
  reason: SkipReason;
  /** What to do about it, in plain words. */
  detail: string;
  risk: FixRisk;
  target: FixTarget;
  line: number;
}

export interface IntroducedFinding {
  ruleId: string;
  severity: Severity;
  message: string;
  line: number;
}

/** The outcome of re-checking the fixed text. Nothing counts as fixed unless `ok` is true. */
export interface FixValidation {
  ok: boolean;
  /** Findings of the original text that are gone in the fixed text. */
  resolved: number;
  /** Findings in the fixed text that were not in the original. */
  introduced: IntroducedFinding[];
  /** Why validation failed, if it did. */
  problems: string[];
}

/** A document the rules do not cover, so a result without fixes says nothing about it. */
export interface UncheckedDocument {
  /** 0-based position among the documents in the file. */
  document: number;
  kind?: string;
  name?: string;
  /** 1-based line where the document starts. */
  line: number;
  level: 'explain-only' | 'unchecked';
  headline: string;
  detail: string;
  suggestion?: string;
  note: string;
  message: string;
}

/** A finding whose rule has no automatic fix: the user has to change it by hand. */
export interface UnfixedFinding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** 1-based line the finding points at. */
  line: number;
  kind?: string;
  name?: string;
}

export type FixStatus = 'unchanged' | 'fixed' | 'rejected';

export interface FixResult {
  /** `fixed`: changes made and validated. `rejected`: validation failed, so `fixed` equals `original`. */
  status: FixStatus;
  original: string;
  fixed: string;
  /** Fingerprint of `original`; applying the result to other text is refused. */
  sourceHash: string;
  applied: AppliedFix[];
  skipped: SkippedFix[];
  /** Findings from rules that have no structured fix (nothing is ever done about these). */
  withoutFix: number;
  /** Those findings themselves, so a typo in a custom resource is shown, not just counted. */
  unfixed: UnfixedFinding[];
  /** Documents of a kind no rule covers: nothing was checked or fixed there. */
  notChecked: UncheckedDocument[];
  /** Findings still present in `fixed`. */
  remaining: number;
  validation: FixValidation;
}
