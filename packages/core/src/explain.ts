import { docsLinkFor, hasDocsFor, lookupField } from './fields/index.js';
import { parseManifest } from './parse.js';
import { matchRules } from './rules/check.js';
import { describeCrdField } from './rules/crd.js';
import type { Rule } from './rules/types.js';
import type { ExplainResult, ExplainedField } from './types.js';

/**
 * Parse a manifest and attach a plain-English explanation to every field we know about. Rules
 * compiled from CustomResourceDefinitions (see `parseCrds`) explain the fields of custom kinds.
 */
export function explainManifest(source: string, rules: Rule[] = []): ExplainResult {
  const documents = parseManifest(source).map((doc) => {
    const crd = rules.find(
      (r) =>
        r.crd !== undefined &&
        r.crd.kind === doc.kind &&
        `${r.crd.group}/${r.crd.version}` === doc.apiVersion,
    )?.crd;
    // Everything the CRD finds wrong is reported, so explaining a manifest never hides a problem.
    const problems = crd
      ? matchRules(doc, rules)
          .filter((m) => m.rule.crd !== undefined)
          .map((m) => ({ message: m.finding.message, line: m.finding.line }))
      : [];
    return {
      ...doc,
      issues: [...doc.issues, ...problems],
      unsupportedKind: !hasDocsFor(doc.kind) && !crd,
      fields: doc.fields.map((field): ExplainedField => {
        const explanation =
          lookupField(doc.kind, field.pattern) ??
          (crd ? describeCrdField(crd.schema, field.pattern) : undefined);
        if (explanation === undefined) return field;
        const docsUrl = docsLinkFor(doc.kind, field.pattern);
        return { ...field, explanation, ...(docsUrl !== undefined ? { docsUrl } : {}) };
      }),
    };
  });
  return { documents };
}
