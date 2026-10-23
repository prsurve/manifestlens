import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import * as core from '@actions/core';
import {
  FixPolicyError,
  RuleError,
  loadBundledRules,
  parseFixPolicy,
  parseCrds,
  parseRules,
} from '@manifestlens/core';
import type { FixPolicy, Rule } from '@manifestlens/core';
import { analyze, prepareRules } from './analyze.js';
import type { FileToAnalyze } from './analyze.js';
import { determineBase } from './base.js';
import type { Base } from './base.js';
import { ConfigError, Problems } from './coerce.js';
import { loadConfig } from './config.js';
import { discover } from './discover.js';
import { evaluate } from './evaluate.js';
import { suggestFixes } from './fixes.js';
import { changedFiles, fileAt, resolveCommit } from './git.js';
import { emitAnnotations, upsertComment } from './github.js';
import { buildComment, buildReport, buildSarif, buildSummary } from './report.js';
import type { RunInfo } from './report.js';
import {
  DEFAULTS,
  INPUT_NAMES,
  parseInputs,
  resolveSettings,
  validateSettings,
} from './settings.js';
import type { Settings } from './types.js';

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';

/** Entry point: any failure becomes a clear message and a non-zero exit, never a stack trace. */
export async function run(): Promise<void> {
  try {
    await execute();
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const problem of err.problems) core.error(problem);
      await writeSummary(
        `## ManifestLens: configuration problem\n\n${err.problems.map((p) => `- ${p}`).join('\n')}\n`,
      );
      core.setFailed(
        `ManifestLens is not configured correctly (${err.problems.length} problem${err.problems.length === 1 ? '' : 's'}). See the messages above.`,
      );
    } else {
      core.setFailed(
        `ManifestLens failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function execute(): Promise<void> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

  // 1. Read the layers: workflow inputs, then the checked-in config file.
  const problems = new Problems();
  const raw: Record<string, string> = {};
  for (const name of INPUT_NAMES) raw[name] = core.getInput(name);
  const inputs = parseInputs(raw, problems);
  const config = loadConfig(
    workspace,
    inputs.configFile ?? DEFAULTS.configFile,
    'configFile' in inputs,
    problems,
  );
  if (problems.any) throw new ConfigError(problems.items);

  // 2. Combine them (defaults < config file < inputs) and check the result.
  const { settings, sources } = resolveSettings(config.layer, inputs);
  const invalid = validateSettings(settings);
  if (invalid.length > 0) throw new ConfigError(invalid);
  logConfiguration(settings, config.path);
  warnIfUntrusted(settings, config.path);

  // 3. Rules: the built-in ones plus any the project added.
  const rules = loadRules(workspace, settings);

  // 4. Find the manifests, and for diff-aware scopes, narrow them down and fetch the base versions.
  const found = await discover(settings, workspace);
  core.info(
    `Found ${found.files.length} Kubernetes manifest file(s) among ${found.matched} matched.`,
  );
  let base: Base | null = null;
  let files: FileToAnalyze[] = found.files;
  if (settings.scope !== 'all') {
    ({ base, files } = scopeToChange(settings, workspace, found.files));
    core.info(
      `Scope "${settings.scope}": ${files.length} file(s) in this change, compared with ${base.ref.slice(0, 12)} (${base.source}).`,
    );
  }

  // 5. Check, then decide.
  const analysis = analyze(files, rules, settings);
  const verdict = evaluate(analysis, settings);
  const info: RunInfo = {
    version: VERSION,
    settings,
    sources,
    configPath: config.path,
    base,
    analysis,
    verdict,
    rules,
    matchedFiles: found.matched,
    skipped: found.skipped,
  };

  // Optional: work out fixes for what was found. This only reports; no file is ever changed.
  if (settings.suggestFixes || settings.fixPatchFile !== '') {
    info.fixes = suggestFixes(
      files,
      prepareRules(rules, settings).rules,
      analysis,
      settings,
      loadFixPolicy(workspace, settings),
    );
    core.info(
      `Suggested fixes: ${info.fixes.available} ready, ${info.fixes.heldBack} held back (up to ${settings.fixMaxRisk} risk). Nothing was changed.`,
    );
  }

  // 6. Report: outputs and files first, so downstream steps work even if a later step fails.
  logFindings(info);
  setOutputs(info, workspace);
  if (settings.summary) await writeSummary(buildSummary(info));
  if (!settings.dryRun) {
    if (settings.annotations) {
      const { emitted, total } = emitAnnotations(
        analysis.findings,
        analysis.parseProblems,
        settings.maxAnnotations,
      );
      if (emitted < total) {
        core.info(
          `Annotated ${emitted} of ${total} findings. GitHub shows at most 10 of each severity per step, so the rest are in the job summary and the report file.`,
        );
      }
    }
    await maybeComment(info);
  } else {
    core.info('Dry run: no annotations, no pull request comment, and the build is not affected.');
  }

  if (verdict.blocking) core.setFailed(`ManifestLens: ${verdict.reasons.join(' ')}`);
  else if (!verdict.passed)
    core.warning(
      `ManifestLens found problems but is not blocking the build (${verdict.result}): ${verdict.reasons.join(' ')}`,
    );
}

/**
 * `pull_request_target` runs with a write token in the base repository. If the checkout is the pull
 * request's code, its config file and rules are written by whoever opened the pull request.
 */
function warnIfUntrusted(s: Settings, configPath: string | null): void {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request_target') return;
  const sources = [
    configPath ? `the config file (${configPath})` : '',
    s.rules.length > 0 ? 'custom rules' : '',
    s.crds.length > 0 ? 'custom resource definitions' : '',
    s.fixPolicy !== '' ? 'the fix policy' : '',
  ].filter(Boolean);
  if (sources.length === 0) return;
  core.warning(
    `This is a pull_request_target run, and ${sources.join(' and ')} are read from the checked-out code. If that is the pull request's code, its author controls them. Check out the base branch, or pass settings as workflow inputs instead.`,
  );
}

function logConfiguration(s: Settings, configPath: string | null): void {
  core.startGroup('Configuration');
  core.info(
    configPath
      ? `Config file: ${configPath}`
      : 'Config file: none found, using defaults and inputs.',
  );
  core.info(
    `scope=${s.scope} fail-on=${s.failOn} mode=${s.mode}${s.dryRun ? ' dry-run' : ''} paths=${s.paths.join(', ')}`,
  );
  core.endGroup();
}

/** Read extra rule and CRD files, keeping them inside the repository and their ids unique. */
function loadRules(workspace: string, s: Settings): Rule[] {
  const rules = loadBundledRules();
  const root = realpathSync(workspace);
  const sources: [string, string[], (text: string, origin: string) => Rule[]][] = [
    ['rules', s.rules, parseRules],
    ['crds', s.crds, parseCrds],
  ];
  for (const [setting, paths, parse] of sources) {
    for (const path of paths) {
      const abs = join(workspace, path);
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        throw new ConfigError([`${setting}: "${path}" does not exist.`]);
      }
      if (real !== root && !real.startsWith(root + sep))
        throw new ConfigError([`${setting}: "${path}" points outside the repository.`]);
      const files = statSync(real).isDirectory()
        ? readdirSync(real)
            .filter((f) => /\.ya?ml$/.test(f))
            .sort()
            .map((f) => join(real, f))
        : [real];
      for (const file of files) {
        try {
          rules.push(...parse(readFileSync(file, 'utf8'), file.slice(root.length + 1)));
        } catch (err) {
          if (err instanceof RuleError) throw new ConfigError([err.message]);
          throw err;
        }
      }
    }
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id))
      throw new ConfigError([
        `rules: the rule id "${rule.id}" is defined twice (${rule.origin ?? 'unknown file'}).`,
      ]);
    seen.add(rule.id);
  }
  return rules;
}

/** Read the fix policy file, keeping it inside the repository. */
function loadFixPolicy(workspace: string, s: Settings): FixPolicy | undefined {
  if (s.fixPolicy === '') return undefined;
  let real: string;
  const root = realpathSync(workspace);
  try {
    real = realpathSync(join(workspace, s.fixPolicy));
  } catch {
    throw new ConfigError([`fix-policy: "${s.fixPolicy}" does not exist.`]);
  }
  if (real !== root && !real.startsWith(root + sep))
    throw new ConfigError([`fix-policy: "${s.fixPolicy}" points outside the repository.`]);
  try {
    return parseFixPolicy(readFileSync(real, 'utf8'), s.fixPolicy);
  } catch (err) {
    if (err instanceof FixPolicyError) throw new ConfigError([err.message]);
    throw err;
  }
}

function scopeToChange(
  s: Settings,
  workspace: string,
  found: { path: string; text: string }[],
): { base: Base; files: FileToAnalyze[] } {
  let event: unknown;
  try {
    if (process.env.GITHUB_EVENT_PATH)
      event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    event = undefined;
  }
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const base = determineBase(s, eventName, event);
  if (!base) {
    throw new ConfigError([
      `scope: "${s.scope}" needs a commit to compare with, but none could be worked out from a "${eventName || 'local'}" event. Set the base-ref input (or use scope: all).`,
    ]);
  }
  const commit = resolveCommit(workspace, base.ref);
  if (!commit) {
    throw new ConfigError([
      `scope: the commit ${base.ref} (${base.source}) is not in this checkout. Use actions/checkout with fetch-depth: 0, or fetch that commit first.`,
    ]);
  }
  const changed = changedFiles(workspace, commit);
  const files: FileToAnalyze[] = found
    .filter((f) => changed.has(f.path))
    .map((f) => ({
      ...f,
      ...(s.scope === 'new'
        ? { base: fileAt(workspace, commit, changed.get(f.path) ?? f.path) }
        : {}),
    }));
  return { base: { ...base, ref: commit }, files };
}

function logFindings(info: RunInfo): void {
  const { analysis: a, verdict: v } = info;
  core.startGroup(`Findings (${a.findings.length})`);
  for (const f of a.findings.slice(0, 200))
    core.info(`${f.severity.padEnd(7)} ${f.file}:${f.line}  ${f.ruleId}  ${f.message}`);
  if (a.findings.length > 200)
    core.info(`...and ${a.findings.length - 200} more (see the report file).`);
  for (const p of a.parseProblems)
    core.info(`invalid  ${p.file}${p.line ? `:${p.line}` : ''}  ${p.message}`);
  core.endGroup();
  core.info(
    `Result: ${v.result}. ${v.counts.error} error(s), ${v.counts.warning} warning(s), ${v.counts.info} info.`,
  );
  for (const reason of v.reasons) core.info(`  - ${reason}`);
}

function writeFile(workspace: string, path: string, content: string): string {
  const abs = join(workspace, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function setOutputs(info: RunInfo, workspace: string): void {
  const { verdict: v, analysis: a, settings: s } = info;
  let patchPath = '';
  if (s.fixPatchFile !== '') {
    patchPath = writeFile(workspace, s.fixPatchFile, info.fixes?.patch ?? '');
    info.fixPatchPath = patchPath;
  }
  const reportPath = writeFile(
    workspace,
    s.reportFile,
    `${JSON.stringify(buildReport(info), null, 2)}\n`,
  );
  let sarifPath = '';
  if (s.sarifFile !== '')
    sarifPath = writeFile(workspace, s.sarifFile, `${JSON.stringify(buildSarif(info), null, 2)}\n`);

  core.setOutput('result', v.result);
  core.setOutput('passed', String(v.passed));
  core.setOutput('errors', String(v.counts.error));
  core.setOutput('warnings', String(v.counts.warning));
  core.setOutput('infos', String(v.counts.info));
  core.setOutput('findings', String(v.counts.total));
  core.setOutput('parse-errors', String(v.counts.parseErrors));
  core.setOutput('files-checked', String(a.filesChecked));
  core.setOutput('suppressed', String(a.suppressed));
  core.setOutput('report-file', reportPath);
  core.setOutput('sarif-file', sarifPath);
  core.setOutput('fixes-available', String(info.fixes?.available ?? 0));
  core.setOutput('fix-patch-file', patchPath);
}

async function writeSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown, true).write();
  } catch {
    // Not running on GitHub (for example locally): show the summary in the log instead.
    core.info(markdown);
  }
}

/** Post or update the pull request comment. A failure here only warns: it must never fail the build. */
async function maybeComment(info: RunInfo): Promise<void> {
  const s = info.settings;
  if (s.comment === 'never') return;
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') return;

  let number: number | undefined;
  try {
    number = (
      JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as {
        pull_request?: { number?: number };
      }
    ).pull_request?.number;
  } catch {
    number = undefined;
  }
  const token = core.getInput('github-token');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!number || !token || !repo) {
    core.info('Skipping the pull request comment: no pull request, token or repository found.');
    return;
  }

  const marker = `<!-- manifestlens-action${s.label ? `:${s.label}` : ''} -->`;
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
  const hasNews = info.analysis.findings.length > 0 || info.analysis.parseProblems.length > 0;
  try {
    const outcome = await upsertComment(
      { apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com', repo, number, token },
      marker,
      buildComment(info, marker, runUrl),
      s.comment === 'auto' && !hasNews,
    );
    core.info(`Pull request comment: ${outcome}.`);
  } catch (err) {
    core.warning(
      `Could not post the pull request comment (${err instanceof Error ? err.message : String(err)}). It needs "pull-requests: write" permission, and pull requests from forks cannot write. The build is not affected.`,
    );
  }
}
