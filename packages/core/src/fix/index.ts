export { fixManifest, isStale } from './engine.js';
export { diffLines, lineEdits, unifiedDiff } from './diff.js';
export type { LineEdit, LineOp } from './diff.js';
export { FixPolicyError, parseFixPolicy } from './policy.js';
export { fingerprint } from './hash.js';
export type {
  AppliedFix,
  FixChange,
  FixOptions,
  FixPolicy,
  FixResult,
  FixStatus,
  FixTarget,
  FixValidation,
  IntroducedFinding,
  SkipReason,
  SkippedFix,
  UncheckedDocument,
  UnfixedFinding,
} from './types.js';
