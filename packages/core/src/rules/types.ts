export type Severity = 'info' | 'warning' | 'error';
export type RuleScope = 'document' | 'pod' | 'container' | 'initContainer';

/** A parsed and validated rule condition. Paths are relative to the rule's scope. */
export type Condition =
  | { op: 'missing' | 'present'; path: string }
  | { op: 'equals' | 'contains'; path: string; value: unknown }
  | { op: 'in'; path: string; values: unknown[] }
  | { op: 'matches'; path: string; pattern: RegExp }
  | { op: 'all' | 'any'; conditions: Condition[] }
  | { op: 'not'; condition: Condition }
  /** True when some item of the list at `path` satisfies `condition`, evaluated on that item. */
  | { op: 'some'; path: string; condition: Condition };

/** How much a fix can change what runs. Low is safe to apply in bulk; high is never applied unasked. */
export type FixRisk = 'low' | 'medium' | 'high';

/** One field a fix sets. The value is either written in the rule or supplied by a team policy. */
export interface FixSet {
  /** Plain dotted keys relative to the rule's scope, e.g. `securityContext.allowPrivilegeEscalation`. */
  path: string;
  /** Literal value; unused when `param` is set. */
  value?: unknown;
  /** Name of a policy parameter that supplies the value. */
  param?: string;
  /** Every scalar of a policy value must match this, so a typo cannot reach the manifest. */
  pattern?: RegExp;
}

/** A structured, deterministic fix for a rule. Rules without one are never changed automatically. */
export interface FixSpec {
  risk: FixRisk;
  /** What the patch does, in one sentence. */
  summary: string;
  /** Extra preconditions, evaluated like `when` in the rule's scope. The fix is skipped if false. */
  requires?: Condition;
  /** Shown when `requires` is false, so the reason is specific ("runAsUser is 0"). */
  blockedMessage?: string;
  set: FixSet[];
  /** Rename a mapping key instead of setting values; used for a mistyped field of a custom resource. */
  rename?: { parent: string; from: string; to: string };
}

/** A subset of an OpenAPI v3 schema, as found in a CustomResourceDefinition. */
export interface CrdSchema {
  type?: string;
  description?: string;
  properties?: Record<string, CrdSchema>;
  additionalProperties?: CrdSchema | boolean;
  items?: CrdSchema;
  required?: string[];
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  nullable?: boolean;
  'x-kubernetes-preserve-unknown-fields'?: boolean;
  'x-kubernetes-int-or-string'?: boolean;
  oneOf?: unknown;
  anyOf?: unknown;
  allOf?: unknown;
  not?: unknown;
}

/** What a CustomResourceDefinition teaches ManifestLens about one version of a custom kind. */
export interface CrdInfo {
  group: string;
  version: string;
  kind: string;
  schema: CrdSchema;
}

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  /** Kinds the rule applies to; `*` means every kind. */
  kinds: string[];
  scopes: RuleScope[];
  when: Condition;
  /** Paths (tried in order) whose line the finding points at. Defaults to the scope itself. */
  report: string[];
  message: string;
  why?: string;
  fix?: string;
  /** Optional machine-applicable fix. `fix` stays the human advice. */
  autofix?: FixSpec;
  /** Where the rule was loaded from, for error messages. */
  origin?: string;
  /** Set on the rule a CustomResourceDefinition compiles to: the manifest is checked against it. */
  crd?: CrdInfo;
}

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  message: string;
  why?: string;
  fix?: string;
  /** 1-based line the finding points at. */
  line: number;
  /** Full path of the field the finding points at, when it exists in the manifest. */
  path?: string;
}

/**
 * How much of a document the rules looked at. `checked`: rules exist for its kind. `explain-only`:
 * the kind is known and explained but no rule checks it. `unchecked`: the kind is unknown to
 * ManifestLens (a custom resource, a newer API, or no `kind` at all).
 */
export interface Coverage {
  level: 'checked' | 'explain-only' | 'unchecked';
  /** Everything below is absent when the document was checked. */
  /** The point in a few words, e.g. `Unknown kind "Podds"`. */
  headline?: string;
  /** Why, in one sentence. */
  detail?: string;
  /** The known kind this is probably a typo for. */
  suggestion?: string;
  /** What an empty result does and does not mean. */
  note?: string;
  /** All of the above as one paragraph, for places that show a single line. */
  message?: string;
}

export interface CheckedDocument {
  index: number;
  startLine: number;
  apiVersion?: string;
  kind?: string;
  name?: string;
  issues: { message: string; line?: number }[];
  coverage: Coverage;
  findings: Finding[];
}

export interface CheckResult {
  documents: CheckedDocument[];
}
