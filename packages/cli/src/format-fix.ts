import type { AppliedFix, FixResult, SkippedFix } from '@manifestlens/core';

/** The "not checked" note as short lines: what, why, the likely typo, and what an empty result means. */
export function coverageLines(
  what: string,
  line: number,
  c: { headline?: string; detail?: string; suggestion?: string; note?: string },
): string[] {
  return [
    `! Not checked: ${what} (line ${line})`,
    ...(c.headline ? [`    ${c.headline}.`] : []),
    ...(c.detail ? [`    ${c.detail}`] : []),
    ...(c.suggestion ? [`    Did you mean "${c.suggestion}"?`] : []),
    ...(c.note ? [`    ${c.note}`] : []),
  ];
}

const where = (t: { kind?: string; name?: string }): string =>
  t.kind ? `${t.kind}${t.name ? ` "${t.name}"` : ''}` : 'document';

function appliedLine(a: AppliedFix): string[] {
  const out = [
    `  line ${a.line}  ${a.ruleId}  [${a.risk}]  ${where(a.target)}`,
    `    ${a.summary}`,
  ];
  for (const c of a.changes) out.push(`    ${c.path}: ${c.before} -> ${c.after}`);
  return out;
}

function skippedLine(s: SkippedFix): string[] {
  return [`  line ${s.line}  ${s.ruleId}  [${s.risk}]  ${s.reason}`, `    ${s.detail}`];
}

/** The human-readable report for `manifestlens fix`. The diff itself is printed separately. */
export function formatFixReport(
  file: string,
  result: FixResult,
  mode: 'preview' | 'written',
): string {
  const out: string[] = [];
  const n = result.applied.length;
  if (result.status === 'rejected') {
    out.push(`${file}: nothing changed. The fixes failed validation:`);
    for (const p of result.validation.problems) out.push(`  ${p}`);
    for (const f of result.validation.introduced) out.push(`  would add ${f.ruleId}: ${f.message}`);
  } else if (n === 0) {
    out.push(
      `${file}: no fixes to apply${result.unfixed.length > 0 ? ', but some findings need a manual fix' : result.notChecked.length > 0 ? ', but not everything was checked' : ''}.`,
    );
  } else if (mode === 'preview') {
    out.push(`${file}: ${n} fix${n === 1 ? '' : 'es'} ready (preview, nothing written).`);
  } else {
    out.push(`${file}: applied ${n} fix${n === 1 ? '' : 'es'}.`);
  }

  if (result.applied.length > 0)
    out.push(
      '',
      mode === 'preview' ? 'Would apply:' : 'Applied:',
      ...result.applied.flatMap(appliedLine),
    );
  if (result.skipped.length > 0) {
    out.push('', 'Not applied:', ...result.skipped.flatMap(skippedLine));
  }

  if (result.status === 'fixed') {
    out.push(
      '',
      `Validation passed: the YAML parses, only the fields above changed, ${result.validation.resolved} finding${result.validation.resolved === 1 ? ' is' : 's are'} gone and none were added.`,
    );
  }
  if (result.unfixed.length > 0) {
    out.push('', 'Needs a manual fix:');
    for (const f of result.unfixed) {
      out.push(`  line ${f.line}  ${f.severity.toUpperCase()}  ${f.ruleId}  ${f.message}`);
    }
  }
  for (const d of result.notChecked) out.push('', ...coverageLines(where(d), d.line, d));
  const notes: string[] = [];
  if (result.remaining > 0)
    notes.push(`${result.remaining} finding${result.remaining === 1 ? '' : 's'} remain`);
  if (result.withoutFix > 0) notes.push(`${result.withoutFix} have no automatic fix`);
  if (notes.length > 0) out.push(`${notes.join('; ')}.`);
  if (mode === 'preview' && result.status === 'fixed') out.push('Run again with --write to apply.');
  return out.join('\n');
}
