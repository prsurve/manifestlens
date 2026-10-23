import { bundledRuleSources } from './bundled.js';
import { parseRules } from './load.js';
import type { Rule } from './types.js';

export { checkManifest } from './check.js';
export { checkedKinds, kindCoverage } from './coverage.js';
export { parseCrds } from './crd.js';
export { RuleError, parseRules } from './load.js';
export type {
  CheckResult,
  CrdInfo,
  CrdSchema,
  CheckedDocument,
  Coverage,
  Finding,
  FixRisk,
  FixSet,
  FixSpec,
  Rule,
  Severity,
} from './types.js';

/** The rules that ship with ManifestLens. */
export function loadBundledRules(): Rule[] {
  return Object.entries(bundledRuleSources).flatMap(([file, text]) => parseRules(text, file));
}
