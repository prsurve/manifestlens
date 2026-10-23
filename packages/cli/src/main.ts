#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  FixPolicyError,
  RuleError,
  checkManifest,
  diffManifests,
  explainManifest,
  fixManifest,
  isStale,
  loadBundledRules,
  parseFixPolicy,
  parseCrds,
  parseRules,
  unifiedDiff,
} from '@manifestlens/core';
import type { FixOptions, FixRisk, Rule, Severity } from '@manifestlens/core';
import { formatFixReport } from './format-fix.js';
import { formatExplanation } from './format.js';
import { formatDiff } from './format-diff.js';
import { formatFindings } from './format-check.js';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage:
  manifestlens explain <file> [--crd <file-or-dir>]...
  manifestlens check <file> [--rules <file-or-dir>]... [--crd <file-or-dir>]...
                   [--fail-on error|warning|info|none]
  manifestlens diff <old-file> <new-file> [--rules <file-or-dir>]... [--crd <file-or-dir>]...
                   [--fail-on ...]
  manifestlens fix <file> [--rules <file-or-dir>]... [--crd <file-or-dir>]... [--policy <file>] [--max-risk low|medium|high]
                   [--only <rule-id>]... [--write] [--no-backup]

explain  Explain a Kubernetes manifest in plain English, line by line.
check    Flag risky or non-best-practice settings using the built-in rules.
diff     Explain what applying <new-file> instead of <old-file> will do to the cluster,
         and which findings the change adds or removes.
fix      Preview fixes for findings that have one, as a unified diff (nothing is written).
         Add --write to apply them. Every fix is checked before it is reported.

Options:
  --rules <path>   Also load rules from a YAML file, or every .yaml file in a directory
                   (repeatable)
  --crd <path>     Also learn custom resources from CustomResourceDefinition YAML (a file, or every
                   .yaml file in a directory, e.g. from kubectl get crd -o yaml). Their fields are
                   explained and checked against the schema (repeatable)
  --fail-on <lvl>  Exit 1 if there is a (new) finding at this level or worse (default: error)
  --policy <file>  Values for fixes that cannot guess them (YAML, "params:"), e.g. memoryLimit
  --max-risk <lvl> Highest fix risk to apply: low (default), medium or high
  --only <rule-id> Only fix findings of this rule (repeatable)
  --write          Apply the fixes to the file. A backup (<file>.bak) is kept unless --no-backup
  -h, --help       Show this help

Exit codes: 0 ok, 1 findings or YAML problems, 2 bad usage or unreadable file.
`;

const LEVELS = ['info', 'warning', 'error'] as const;

/** Run the CLI. Returns the process exit code instead of exiting, so tests can call it directly. */
export function run(argv: string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        rules: { type: 'string', multiple: true },
        crd: { type: 'string', multiple: true },
        'fail-on': { type: 'string' },
        policy: { type: 'string' },
        'max-risk': { type: 'string' },
        only: { type: 'string', multiple: true },
        write: { type: 'boolean' },
        'no-backup': { type: 'boolean' },
      },
    });
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }

  const [command, file, ...extra] = parsed.positionals;
  if (parsed.values.help) {
    io.stdout(USAGE);
    return 0;
  }
  const fileCount = command === 'diff' ? 2 : 1;
  if (
    (command !== 'explain' && command !== 'check' && command !== 'diff' && command !== 'fix') ||
    !file ||
    extra.length !== fileCount - 1
  ) {
    io.stderr(USAGE);
    return 2;
  }
  if (command === 'diff') {
    return runDiff(
      file,
      extra[0] as string,
      parsed.values.rules ?? [],
      parsed.values.crd ?? [],
      parsed.values['fail-on'],
      io,
    );
  }

  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    io.stderr(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  if (command === 'fix') {
    return runFix(file, source, parsed.values, io);
  }
  if (command === 'explain') return runExplain(file, source, parsed.values.crd ?? [], io);
  return runCheck(
    file,
    source,
    parsed.values.rules ?? [],
    parsed.values.crd ?? [],
    parsed.values['fail-on'],
    io,
  );
}

function runExplain(file: string, source: string, crdPaths: string[], io: Io): number {
  const rules = loadAllRules([], crdPaths, io);
  if (!rules) return 2;
  const result = explainManifest(source, rules);
  if (result.documents.length === 0) {
    io.stderr(`${file}: no Kubernetes documents found.\n`);
    return 1;
  }
  io.stdout(`${formatExplanation(result, source)}\n`);
  return result.documents.some((d) => d.issues.length > 0) ? 1 : 0;
}

/** Load bundled plus extra rules, or explain to the user why that failed. */
function loadAllRules(rulePaths: string[], crdPaths: string[], io: Io): Rule[] | undefined {
  let rules: Rule[];
  try {
    rules = [
      ...loadBundledRules(),
      ...rulePaths.flatMap((p) => loadRuleFiles(p, parseRules)),
      ...crdPaths.flatMap((p) => loadRuleFiles(p, parseCrds)),
    ];
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return undefined;
  }
  const duplicate = rules.find((r, i) => rules.findIndex((o) => o.id === r.id) !== i);
  if (duplicate) {
    io.stderr(`Duplicate rule id "${duplicate.id}" (${duplicate.origin ?? 'unknown source'}).\n`);
    return undefined;
  }
  return rules;
}

function validFailOn(failOn: string | undefined, io: Io): boolean {
  if (failOn !== undefined && failOn !== 'none' && !LEVELS.includes(failOn as Severity)) {
    io.stderr(`--fail-on must be one of error, warning, info, none.\n`);
    return false;
  }
  return true;
}

/** True when a finding is at or above the --fail-on level (default: error). */
function failsThreshold(findings: { severity: Severity }[], failOn: string | undefined): boolean {
  const threshold = failOn ?? 'error';
  if (threshold === 'none') return false;
  const min = LEVELS.indexOf(threshold as Severity);
  return findings.some((f) => LEVELS.indexOf(f.severity) >= min);
}

function runDiff(
  oldFile: string,
  newFile: string,
  rulePaths: string[],
  crdPaths: string[],
  failOn: string | undefined,
  io: Io,
): number {
  if (!validFailOn(failOn, io)) return 2;
  const sources: string[] = [];
  for (const file of [oldFile, newFile]) {
    try {
      sources.push(readFileSync(file, 'utf8'));
    } catch (err) {
      io.stderr(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  const rules = loadAllRules(rulePaths, crdPaths, io);
  if (!rules) return 2;

  const result = diffManifests(sources[0] as string, sources[1] as string, rules);
  if (result.documents.length === 0 && result.issues.length === 0) {
    io.stderr('No Kubernetes documents found in either file.\n');
    return 1;
  }
  io.stdout(`${formatDiff(result)}\n`);
  if (result.issues.length > 0) return 1;
  return failsThreshold(
    result.documents.flatMap((d) => d.newFindings),
    failOn,
  )
    ? 1
    : 0;
}

interface FixFlags {
  rules?: string[] | undefined;
  crd?: string[] | undefined;
  policy?: string | undefined;
  'max-risk'?: string | undefined;
  only?: string[] | undefined;
  write?: boolean | undefined;
  'no-backup'?: boolean | undefined;
}

const RISKS = ['low', 'medium', 'high'] as const;

function runFix(file: string, source: string, flags: FixFlags, io: Io): number {
  const maxRisk = flags['max-risk'] ?? 'low';
  if (!RISKS.includes(maxRisk as FixRisk)) {
    io.stderr('--max-risk must be one of low, medium, high.\n');
    return 2;
  }
  if (flags['no-backup'] && !flags.write) {
    io.stderr('--no-backup only makes sense with --write.\n');
    return 2;
  }
  const rules = loadAllRules(flags.rules ?? [], flags.crd ?? [], io);
  if (!rules) return 2;

  const options: FixOptions = { maxRisk: maxRisk as FixRisk };
  if (flags.only?.length) {
    const unknown = flags.only.filter((id) => !rules.some((r) => r.id === id));
    if (unknown.length > 0) {
      io.stderr(`Unknown rule id: ${unknown.join(', ')}.\n`);
      return 2;
    }
    options.only = flags.only;
  }
  if (flags.policy !== undefined) {
    try {
      options.policy = parseFixPolicy(readFileSync(flags.policy, 'utf8'), flags.policy);
    } catch (err) {
      const unreadable = !(err instanceof FixPolicyError);
      io.stderr(
        `${unreadable ? `Cannot read ${flags.policy}: ` : ''}${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
  }

  const documents = checkManifest(source, []).documents;
  if (documents.length === 0) {
    io.stderr(`${file}: no Kubernetes documents found.\n`);
    return 1;
  }
  const problems = documents.some((d) => d.issues.length > 0);
  const result = fixManifest(source, rules, options);

  if (!flags.write) {
    const label = file.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    io.stdout(unifiedDiff(result.original, result.fixed, `a/${label}`, `b/${label}`));
    io.stderr(`${formatFixReport(file, result, 'preview')}\n`);
    return result.status === 'rejected' || problems ? 1 : 0;
  }

  if (result.status === 'fixed') {
    const failure = writeFixed(file, result, flags['no-backup'] !== true, io);
    if (failure !== undefined) return failure;
  }
  io.stdout(`${formatFixReport(file, result, 'written')}\n`);
  return result.status === 'rejected' || problems ? 1 : 0;
}

/** Write the fixed text next to the file and move it into place. Returns an exit code on failure. */
function writeFixed(
  file: string,
  result: ReturnType<typeof fixManifest>,
  backup: boolean,
  io: Io,
): number | undefined {
  try {
    // The file may have changed since it was read; never overwrite someone else's edit.
    if (isStale(result, readFileSync(file, 'utf8'))) {
      io.stderr(`${file} changed while the fixes were being prepared. Nothing was written.\n`);
      return 1;
    }
    const mode = statSync(file).mode;
    if (backup) {
      let path = `${file}.bak`;
      for (let i = 1; existsSync(path); i++) path = `${file}.bak.${i}`;
      writeFileSync(path, result.original, { mode });
      io.stdout(`Original saved to ${path}\n`);
    }
    const temp = `${file}.manifestlens-${process.pid}.tmp`;
    writeFileSync(temp, result.fixed, { mode });
    chmodSync(temp, mode);
    renameSync(temp, file);
    if (readFileSync(file, 'utf8') !== result.fixed) {
      io.stderr(
        `${file} does not contain the expected text after writing. Restore it from the backup.\n`,
      );
      return 1;
    }
  } catch (err) {
    io.stderr(`Cannot write ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  return undefined;
}

function runCheck(
  file: string,
  source: string,
  rulePaths: string[],
  crdPaths: string[],
  failOn: string | undefined,
  io: Io,
): number {
  if (!validFailOn(failOn, io)) return 2;
  const rules = loadAllRules(rulePaths, crdPaths, io);
  if (!rules) return 2;

  const result = checkManifest(source, rules);
  if (result.documents.length === 0) {
    io.stderr(`${file}: no Kubernetes documents found.\n`);
    return 1;
  }
  io.stdout(`${formatFindings(result)}\n`);

  if (result.documents.some((d) => d.issues.length > 0)) return 1;
  return failsThreshold(
    result.documents.flatMap((d) => d.findings),
    failOn,
  )
    ? 1
    : 0;
}

/** Load rules (or CRDs) from a YAML file, or from every .yaml/.yml file in a directory. */
function loadRuleFiles(path: string, parse: (text: string, origin: string) => Rule[]): Rule[] {
  let files: string[];
  try {
    files = statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((f) => /\.ya?ml$/.test(f))
          .sort()
          .map((f) => join(path, f))
      : [path];
  } catch (err) {
    throw new RuleError(
      `Cannot read rules at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return files.flatMap((f) => parse(readFileSync(f, 'utf8'), f));
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  });
}
