import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/main.js';
import { POD, commitAll, example, gitRepo, tempDir } from './helpers.js';

interface Result {
  exitCode: number | undefined;
  outputs: Record<string, string>;
  summary: string;
  log: string;
  workspace: string;
}

const savedEnv = { ...process.env };
let stdout: string[] = [];
// @actions/core remembers the first summary file it writes to for the life of the process (a real run
// is one process), so the tests share one file and empty it before each run.
const SUMMARY_FILE = join(tempDir(), 'summary.md');

beforeEach(() => {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, savedEnv);
});

/** Run the whole action in-process the way GitHub does: inputs, outputs and summary go through files and env. */
async function runAction(opts: {
  files?: Record<string, string>;
  workspace?: string;
  inputs?: Record<string, string>;
  eventName?: string;
  event?: unknown;
  repository?: string;
}): Promise<Result> {
  const workspace = opts.workspace ?? tempDir(opts.files ?? {});
  const scratch = tempDir();
  const eventFile = join(scratch, 'event.json');
  writeFileSync(eventFile, JSON.stringify(opts.event ?? {}));
  writeFileSync(join(scratch, 'out'), '');
  writeFileSync(SUMMARY_FILE, '');

  for (const key of Object.keys(process.env))
    if (key.startsWith('INPUT_')) Reflect.deleteProperty(process.env, key);
  process.env.GITHUB_WORKSPACE = workspace;
  process.env.GITHUB_OUTPUT = join(scratch, 'out');
  process.env.GITHUB_STEP_SUMMARY = SUMMARY_FILE;
  process.env.GITHUB_EVENT_NAME = opts.eventName ?? 'workflow_dispatch';
  process.env.GITHUB_EVENT_PATH = eventFile;
  if (opts.repository) process.env.GITHUB_REPOSITORY = opts.repository;
  else delete process.env.GITHUB_REPOSITORY;
  for (const [name, value] of Object.entries(opts.inputs ?? {}))
    process.env[`INPUT_${name.toUpperCase()}`] = value;

  process.exitCode = undefined;
  await run();

  const outputs: Record<string, string> = {};
  const raw = readFileSync(join(scratch, 'out'), 'utf8');
  for (const m of raw.matchAll(/^(.+?)<<(ghadelimiter_[^\n]+)\n([\s\S]*?)\n\2$/gm))
    outputs[m[1] as string] = m[3] as string;
  return {
    exitCode: process.exitCode as number | undefined,
    outputs,
    summary: readFileSync(SUMMARY_FILE, 'utf8'),
    log: stdout.join(''),
    workspace,
  };
}

const risky = example('risky.yaml');
const hardened = example('hardened.yaml');

describe('pass and fail', () => {
  it('passes a clean repository and says so', async () => {
    const r = await runAction({ files: { 'k8s/ok.yaml': hardened } });
    expect(r.exitCode).toBeUndefined();
    expect(r.outputs).toMatchObject({
      result: 'pass',
      passed: 'true',
      errors: '0',
      findings: '0',
      'files-checked': '1',
    });
    expect(r.summary).toContain('✅ **Passed**');
  });

  it('fails on errors, and still sets outputs and the summary', async () => {
    const r = await runAction({ files: { 'k8s/bad.yaml': risky } });
    expect(r.exitCode).toBe(1);
    expect(r.outputs).toMatchObject({
      result: 'fail',
      passed: 'false',
      errors: '2',
      warnings: '9',
      infos: '7',
      findings: '18',
    });
    expect(r.summary).toContain('❌ **Failed**');
    expect(r.log).toContain('::error::ManifestLens: 2 errors found, none allowed.');
  });

  it('passes when the findings are below the failure level', async () => {
    const r = await runAction({ files: { 'a.yaml': risky }, inputs: { 'fail-on': 'none' } });
    expect(r.exitCode).toBeUndefined();
    expect(r.outputs.result).toBe('pass');
    expect(r.outputs.findings).toBe('18');
  });

  it('applies thresholds', async () => {
    const files = { 'a.yaml': risky };
    expect(
      (
        await runAction({
          files,
          inputs: { 'fail-on': 'warning', 'max-warnings': '9', 'max-errors': '2' },
        })
      ).exitCode,
    ).toBeUndefined();
    const over = await runAction({
      files,
      inputs: { 'fail-on': 'warning', 'max-warnings': '8', 'max-errors': '2' },
    });
    expect(over.exitCode).toBe(1);
    expect(over.log).toContain('9 warnings found, at most 8 allowed.');
    expect(
      (await runAction({ files, inputs: { 'fail-on': 'none', 'max-total': '15' } })).exitCode,
    ).toBe(1);
  });

  it('fails on a manifest that cannot be read, unless told not to', async () => {
    const files = { 'bad.yaml': 'apiVersion: v1\nkind: Pod\nspec: [oops\n' };
    const bad = await runAction({ files });
    expect(bad.exitCode).toBe(1);
    expect(bad.outputs['parse-errors']).not.toBe('0');
    expect(
      (await runAction({ files, inputs: { 'fail-on-parse-error': 'false' } })).exitCode,
    ).toBeUndefined();
  });

  it('passes with nothing to check', async () => {
    const r = await runAction({ files: { 'readme.txt': 'hi', 'ci.yaml': 'name: ci\n' } });
    expect(r.exitCode).toBeUndefined();
    expect(r.outputs['files-checked']).toBe('0');
  });
});

describe('modes that do not block', () => {
  it('report mode states the violation but leaves the build green', async () => {
    const r = await runAction({ files: { 'a.yaml': risky }, inputs: { mode: 'report' } });
    expect(r.exitCode).toBeUndefined();
    expect(r.outputs).toMatchObject({ result: 'report', passed: 'false', errors: '2' });
    expect(r.log).toContain(
      '::warning::ManifestLens found problems but is not blocking the build (report)',
    );
    expect(r.summary).toContain('Rules violated, not blocking');
  });

  it('dry-run creates no annotations and never fails', async () => {
    const r = await runAction({ files: { 'a.yaml': risky }, inputs: { 'dry-run': 'true' } });
    expect(r.exitCode).toBeUndefined();
    expect(r.outputs.result).toBe('dry-run');
    expect(r.log).not.toMatch(/^::(error|warning|notice) title=/m);
    expect(r.log).toContain('Dry run: no annotations');
  });

  it('annotations can be switched off or capped', async () => {
    const off = await runAction({ files: { 'a.yaml': risky }, inputs: { annotations: 'false' } });
    expect(off.log).not.toMatch(/^::(error|warning|notice) title=/m);
    const capped = await runAction({
      files: { 'a.yaml': risky },
      inputs: { 'max-annotations': '3' },
    });
    expect(capped.log.match(/^::(error|warning|notice) title=/gm)).toHaveLength(3);
    const full = await runAction({ files: { 'a.yaml': risky } });
    expect(full.log).toContain(
      '::error title=ManifestLens%3A privileged-container,file=a.yaml,line=17::',
    );
  });
});

describe('the three levels of configuration', () => {
  it('reads project settings from the config file', async () => {
    const r = await runAction({
      files: { 'a.yaml': risky, '.github/manifestlens.yml': 'fail-on: none\nlabel: from-file\n' },
    });
    expect(r.exitCode).toBeUndefined();
    expect(r.summary).toContain('## ManifestLens · from-file');
    expect(r.summary).toMatch(/<code>failOn<\/code> \| <code>none<\/code> \| config/);
    expect(r.summary).toContain('<code>.github/manifestlens.yml</code>');
  });

  it('lets a workflow input override the config file', async () => {
    const files = { 'a.yaml': risky, '.github/manifestlens.yml': 'mode: report\n' };
    expect((await runAction({ files })).exitCode).toBeUndefined();
    const r = await runAction({ files, inputs: { mode: 'enforce' } });
    expect(r.exitCode).toBe(1);
    expect(r.summary).toMatch(/<code>mode<\/code> \| <code>enforce<\/code> \| input/);
  });

  it('reads a config file from a named location, and fails if it is missing', async () => {
    const ok = await runAction({
      files: { 'a.yaml': risky, 'ci/ml.yml': 'fail-on: none\n' },
      inputs: { 'config-file': 'ci/ml.yml' },
    });
    expect(ok.exitCode).toBeUndefined();
    const missing = await runAction({
      files: { 'a.yaml': risky },
      inputs: { 'config-file': 'nope.yml' },
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.log).toContain('config-file: "nope.yml" does not exist.');
  });

  it('adds up rule settings from the file and the workflow', async () => {
    const r = await runAction({
      files: { 'a.yaml': risky, '.github/manifestlens.yml': 'disable-rules: [single-replica]\n' },
      inputs: { 'disable-rules': 'image-latest-tag', 'fail-on': 'none' },
    });
    expect(r.outputs.findings).toBe('16');
  });

  it('changes severities and ignores paths from the config file', async () => {
    const yml = [
      'fail-on: error',
      'severity-overrides:',
      '  image-latest-tag: error',
      '  privileged-container: info',
      'ignore:',
      '  - path: "examples/**"',
    ].join('\n');
    const r = await runAction({
      files: { 'a.yaml': risky, 'examples/demo.yaml': risky, '.github/manifestlens.yml': yml },
    });
    expect(r.outputs.suppressed).toBe('18');
    expect(r.outputs.errors).toBe('2'); // run-as-root-user and image-latest-tag; privileged-container is now info
  });
});

describe('safeguards', () => {
  it('reports every bad input at once with a clear message, and fails even in report mode', async () => {
    const r = await runAction({
      files: { 'a.yaml': risky },
      inputs: { 'fail-on': 'bogus', scope: 'sideways', 'max-errors': '-1', mode: 'report' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain(
      '::error::fail-on: "bogus" is not valid. Use one of: error, warning, info, none.',
    );
    expect(r.log).toContain('::error::scope: "sideways" is not valid');
    expect(r.log).toContain('::error::max-errors: "-1" must be a whole number');
    expect(r.log).toContain('ManifestLens is not configured correctly (3 problems)');
    expect(r.summary).toContain('configuration problem');
  });

  it('catches a typo in the config file and suggests the fix', async () => {
    const r = await runAction({
      files: { 'a.yaml': risky, '.github/manifestlens.yml': 'fail-onn: warning\n' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain('unknown setting "fail-onn" (did you mean "fail-on"?)');
  });

  it('rejects paths that escape the repository', async () => {
    const r = await runAction({
      files: { 'a.yaml': risky },
      inputs: { 'working-directory': '../elsewhere', 'report-file': '/tmp/x.json' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain(
      'working-directory: "../elsewhere" must be a relative path inside the repository',
    );
    expect(r.log).toContain('report-file: "/tmp/x.json" must be a relative path');
  });

  it('refuses a pattern that matches too many files', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`f${i}.yaml`, POD('a:1')]),
    );
    const r = await runAction({ files, inputs: { 'max-files': '2' } });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain('paths matched 4 files, more than max-files (2)');
  });

  it('warns about rule ids that match no rule instead of silently ignoring them', async () => {
    const r = await runAction({
      files: { 'a.yaml': hardened },
      inputs: { 'disable-rules': 'image-latest-tagg' },
    });
    expect(r.exitCode).toBeUndefined();
    expect(r.summary).toContain('<code>image-latest-tagg</code>');
  });
});

describe('extra rules', () => {
  const team =
    'id: team-owner\ntitle: No owner label\nseverity: error\nkinds: ["*"]\nwhen: { missing: metadata.labels.owner }\nmessage: \'{kind} "{name}" has no owner label.\'\n';

  it('loads rule files and folders from the repository', async () => {
    const one = await runAction({
      files: { 'a.yaml': hardened, 'rules/team.yaml': team },
      inputs: { rules: 'rules/team.yaml' },
    });
    expect(one.exitCode).toBe(1);
    expect(one.log).toContain('team-owner');
    const dir = await runAction({
      files: { 'a.yaml': hardened, 'rules/team.yaml': team },
      inputs: { rules: 'rules' },
    });
    expect(dir.outputs.errors).toBe('2');
  });

  it('checks custom resources against CRDs from the repository', async () => {
    const crd = [
      'apiVersion: apiextensions.k8s.io/v1',
      'kind: CustomResourceDefinition',
      'spec:',
      '  group: example.com',
      '  names: { kind: Widget }',
      '  versions:',
      '    - name: v1',
      '      schema:',
      '        openAPIV3Schema:',
      '          type: object',
      '          properties:',
      '            spec:',
      '              type: object',
      '              properties:',
      '                size: { type: integer }',
      '',
    ].join('\n');
    const widget = 'apiVersion: example.com/v1\nkind: Widget\nspec:\n  sise: 3\n';
    const r = await runAction({
      files: { 'w.yaml': widget, 'crds/widget.yaml': crd },
      inputs: { crds: 'crds', 'fail-on': 'warning' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain('Did you mean "size"?');
    const bad = await runAction({
      files: { 'w.yaml': widget, 'crds/widget.yaml': 'kind: Deployment\n' },
      inputs: { crds: 'crds' },
    });
    expect(bad.log).toContain('expected a CustomResourceDefinition');
  });

  it('names the file and the rule when a rule is invalid', async () => {
    const r = await runAction({
      files: {
        'a.yaml': hardened,
        'rules/x.yaml': team.replace('severity: error', 'severity: loud'),
      },
      inputs: { rules: 'rules/x.yaml' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toMatch(/rules\/x\.yaml: rule "team-owner": "severity" must be one of/);
  });

  it('refuses a duplicate id, a missing path and a path outside the repository', async () => {
    const dup = await runAction({
      files: { 'a.yaml': hardened, 'rules/x.yaml': team.replace('team-owner', 'single-replica') },
      inputs: { rules: 'rules/x.yaml' },
    });
    expect(dup.log).toContain('the rule id "single-replica" is defined twice');
    expect(
      (await runAction({ files: { 'a.yaml': hardened }, inputs: { rules: 'nope.yaml' } })).log,
    ).toContain('rules: "nope.yaml" does not exist.');
    expect(
      (await runAction({ files: { 'a.yaml': hardened }, inputs: { rules: '../rules' } })).log,
    ).toContain('must be a relative path inside the repository');
  });
});

describe('inline suppression', () => {
  it('silences a finding with a comment, and counts it', async () => {
    const text = risky
      .replace('privileged: true', 'privileged: true # manifestlens-ignore: privileged-container')
      .replace('runAsUser: 0', 'runAsUser: 0 # manifestlens-ignore: run-as-root-user');
    const r = await runAction({ files: { 'a.yaml': text } });
    expect(r.exitCode).toBeUndefined();
    expect(r.outputs).toMatchObject({ errors: '0', suppressed: '2', result: 'pass' });
  });
});

describe('outputs and report files', () => {
  it('writes the JSON report and exposes its path', async () => {
    const r = await runAction({
      files: { 'a.yaml': risky },
      inputs: { 'report-file': 'out/report.json' },
    });
    const path = join(r.workspace, 'out/report.json');
    expect(r.outputs['report-file']).toBe(path);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    expect(report).toMatchObject({ result: 'fail', counts: { error: 2, total: 18 } });
    expect(report.findings).toHaveLength(18);
  });

  it('writes SARIF only when asked', async () => {
    const without = await runAction({ files: { 'a.yaml': risky } });
    expect(without.outputs['sarif-file']).toBe('');
    const r = await runAction({
      files: { 'a.yaml': risky },
      inputs: { 'sarif-file': 'results.sarif' },
    });
    expect(r.outputs['sarif-file']).toBe(join(r.workspace, 'results.sarif'));
    const sarif = JSON.parse(readFileSync(join(r.workspace, 'results.sarif'), 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results).toHaveLength(18);
  });

  it('can leave the job summary out', async () => {
    const r = await runAction({ files: { 'a.yaml': risky }, inputs: { summary: 'false' } });
    expect(r.summary).toBe('');
  });

  it('puts the label in the summary heading, for matrix jobs', async () => {
    const r = await runAction({ files: { 'a.yaml': hardened }, inputs: { label: 'prod' } });
    expect(r.summary).toContain('## ManifestLens · prod');
  });
});

describe('scope: only what this change introduces', () => {
  /** A repository whose base commit already has plenty of problems, plus one new commit. */
  function repoWithChange() {
    const { dir, commit } = gitRepo({
      'k8s/legacy.yaml': risky,
      'k8s/app.yaml': hardened,
      'README.md': 'x\n',
    });
    writeFileSync(
      join(dir, 'k8s/app.yaml'),
      hardened.replace('image: ghcr.io/example/app:1.4.2', 'image: ghcr.io/example/app'),
    );
    writeFileSync(join(dir, 'README.md'), 'y\n');
    commitAll(dir);
    return { dir, push: { eventName: 'push', event: { before: commit } } };
  }

  it('ignores problems that were already there', async () => {
    const { dir, push } = repoWithChange();
    const all = await runAction({ workspace: dir, ...push });
    expect(all.outputs.findings).toBe('19'); // 18 old + 1 new
    expect(all.exitCode).toBe(1);

    const added = await runAction({ workspace: dir, ...push, inputs: { scope: 'new' } });
    expect(added.outputs).toMatchObject({
      findings: '1',
      errors: '0',
      warnings: '1',
      result: 'pass',
      'files-checked': '1',
    });
    expect(added.exitCode).toBeUndefined();
    expect(added.summary).toContain('only findings this change introduces');
    expect(added.summary).toContain('What this change does');
  });

  it('fails the build for a new problem at the chosen level, even though old ones are not counted', async () => {
    const { dir, push } = repoWithChange();
    const r = await runAction({
      workspace: dir,
      ...push,
      inputs: { scope: 'new', 'fail-on': 'warning' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain('1 warning found, none allowed.');
  });

  it('with scope changed, judges the whole of each touched file but not untouched files', async () => {
    const { dir, push } = repoWithChange();
    const r = await runAction({ workspace: dir, ...push, inputs: { scope: 'changed' } });
    expect(r.outputs).toMatchObject({ 'files-checked': '1', findings: '1' });
  });

  it('counts every finding of a file that is new in the change', async () => {
    const { dir, commit } = gitRepo({ 'README.md': 'x\n' });
    writeFileSync(join(dir, 'new.yaml'), risky);
    commitAll(dir);
    const r = await runAction({
      workspace: dir,
      eventName: 'push',
      event: { before: commit },
      inputs: { scope: 'new' },
    });
    expect(r.outputs.findings).toBe('18');
    expect(r.exitCode).toBe(1);
  });

  it('uses the pull request base, and the base-ref input when given', async () => {
    const { dir, commit } = gitRepo({ 'a.yaml': hardened });
    writeFileSync(
      join(dir, 'a.yaml'),
      hardened.replace('image: ghcr.io/example/app:1.4.2', 'image: x'),
    );
    commitAll(dir);
    const pr = await runAction({
      workspace: dir,
      eventName: 'pull_request',
      event: { pull_request: { base: { sha: commit } } },
      inputs: { scope: 'new' },
    });
    expect(pr.outputs.findings).toBe('1');
    const manual = await runAction({
      workspace: dir,
      inputs: { scope: 'new', 'base-ref': 'HEAD~1' },
    });
    expect(manual.outputs.findings).toBe('1');
  });

  it('explains how to fix it when there is nothing to compare with', async () => {
    const r = await runAction({ files: { 'a.yaml': risky }, inputs: { scope: 'new' } });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain('needs a commit to compare with');
    expect(r.log).toContain('Set the base-ref input');
  });

  it('explains how to fix it when the base commit is not checked out', async () => {
    const { dir } = gitRepo({ 'a.yaml': hardened });
    const r = await runAction({
      workspace: dir,
      eventName: 'push',
      event: { before: 'a'.repeat(40) },
      inputs: { scope: 'new' },
    });
    expect(r.exitCode).toBe(1);
    expect(r.log).toContain('is not in this checkout. Use actions/checkout with fetch-depth: 0');
  });
});

describe('pull_request_target', () => {
  const target = {
    eventName: 'pull_request_target',
    event: { pull_request: { number: 1, base: { sha: 'b'.repeat(40) } } },
  };

  it('warns when the config file or rules could be controlled by the pull request author', async () => {
    const withConfig = await runAction({
      files: { 'a.yaml': hardened, '.github/manifestlens.yml': 'fail-on: none\n' },
      ...target,
    });
    expect(withConfig.log).toContain(
      '::warning::This is a pull_request_target run, and the config file (.github/manifestlens.yml)',
    );
    const withRules = await runAction({
      files: {
        'a.yaml': hardened,
        'r/x.yaml':
          'id: x\ntitle: t\nseverity: info\nkinds: ["*"]\nwhen: { missing: a }\nmessage: m\n',
      },
      ...target,
      inputs: { rules: 'r' },
    });
    expect(withRules.log).toContain('and custom rules are read from the checked-out code');
  });

  it('stays quiet when nothing comes from the checkout, or on a normal pull request', async () => {
    expect((await runAction({ files: { 'a.yaml': hardened }, ...target })).log).not.toContain(
      'pull_request_target run',
    );
    const normal = await runAction({
      files: { 'a.yaml': hardened, '.github/manifestlens.yml': 'fail-on: none\n' },
      eventName: 'pull_request',
      event: target.event,
    });
    expect(normal.log).not.toContain('pull_request_target run');
  });
});

describe('pull request comment', () => {
  const pr = {
    eventName: 'pull_request',
    event: { pull_request: { number: 12, base: { sha: 'b'.repeat(40) } } },
    repository: 'o/r',
  };
  const apiBase = (extra: Record<string, string> = {}) => ({
    'github-token': 'tkn',
    'dry-run': 'false',
    ...extra,
  });

  function stubApi(status = 200) {
    const calls: { method: string; url: string; body?: { body: string } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          url,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (status !== 200) return new Response('no', { status });
        return Response.json((init?.method ?? 'GET') === 'GET' ? [] : { id: 1 });
      }),
    );
    return calls;
  }

  it('posts one comment with the findings on a pull request', async () => {
    const calls = stubApi();
    const r = await runAction({
      files: { 'a.yaml': risky },
      ...pr,
      inputs: apiBase({ label: 'prod' }),
    });
    expect(r.exitCode).toBe(1);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.github.com/repos/o/r/issues/12/comments');
    expect(post?.body?.body.split('\n')[0]).toBe('<!-- manifestlens-action:prod -->');
    expect(post?.body?.body).toContain('privileged-container');
    expect(r.log).toContain('Pull request comment: created.');
  });

  it('stays quiet when there is nothing to say and no earlier comment', async () => {
    const calls = stubApi();
    await runAction({ files: { 'a.yaml': hardened }, ...pr, inputs: apiBase() });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('posts even when clean if asked to always comment', async () => {
    const calls = stubApi();
    await runAction({
      files: { 'a.yaml': hardened },
      ...pr,
      inputs: apiBase({ comment: 'always' }),
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
  });

  it('does not comment when turned off, outside pull requests, or in a dry run', async () => {
    const calls = stubApi();
    await runAction({ files: { 'a.yaml': risky }, ...pr, inputs: apiBase({ comment: 'never' }) });
    await runAction({ files: { 'a.yaml': risky }, inputs: apiBase() });
    await runAction({ files: { 'a.yaml': risky }, ...pr, inputs: apiBase({ 'dry-run': 'true' }) });
    expect(calls).toEqual([]);
  });

  it('only warns when GitHub refuses the comment, and never changes the result', async () => {
    stubApi(403);
    const r = await runAction({
      files: { 'a.yaml': risky },
      ...pr,
      inputs: apiBase({ mode: 'report' }),
    });
    expect(r.exitCode).toBeUndefined();
    expect(r.log).toContain('::warning::Could not post the pull request comment');
    expect(r.log).toContain('pull-requests: write');
    expect(r.log).not.toContain('tkn');
  });
});

it('cleans up: the example repo files are unchanged by running the action', async () => {
  const dir = tempDir({ 'a.yaml': risky });
  await runAction({ workspace: dir });
  expect(readFileSync(join(dir, 'a.yaml'), 'utf8')).toBe(risky);
  expect(existsSync(join(dir, 'manifestlens-report.json'))).toBe(true);
});

describe('fix suggestions', () => {
  const pod = (extra = '') =>
    `apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\nspec:\n  containers:\n    - name: app\n      image: nginx:1.27\n      securityContext:\n        runAsUser: 1000\n${extra}`;

  it('is off by default: no new section, no new report key, no files', async () => {
    const r = await runAction({ files: { 'a.yaml': pod() } });
    expect(r.summary).not.toContain('Suggested fixes');
    expect(r.outputs['fixes-available']).toBe('0');
    expect(r.outputs['fix-patch-file']).toBe('');
    const report = JSON.parse(readFileSync(r.outputs['report-file'] as string, 'utf8'));
    expect(report).not.toHaveProperty('fixes');
  });

  it('lists fixes in the summary and report without touching any file', async () => {
    const files = { 'a.yaml': pod() };
    const r = await runAction({ files, inputs: { 'suggest-fixes': 'true' } });
    expect(r.summary).toContain('### Suggested fixes');
    expect(r.summary).toContain('Nothing was changed');
    expect(r.summary).toContain('allow-privilege-escalation');
    expect(r.outputs['fixes-available']).toBe('1');
    expect(r.outputs['fix-patch-file']).toBe('');
    expect(readFileSync(join(r.workspace, 'a.yaml'), 'utf8')).toBe(files['a.yaml']);
    const report = JSON.parse(readFileSync(r.outputs['report-file'] as string, 'utf8'));
    expect(report.fixes).toMatchObject({ available: 1, heldBack: 3, maxRisk: 'low' });
    expect(report.fixes.files[0].applied[0].ruleId).toBe('allow-privilege-escalation');
    expect(report.fixes.files[0]).not.toHaveProperty('patch');
    expect(report.counts.total).toBe(report.findings.length); // findings unchanged
  });

  it('writes a patch that git apply accepts, and leaves the file as it was', async () => {
    const files = { 'k8s/a.yaml': pod() };
    const r = await runAction({ files, inputs: { 'fix-patch-file': 'out/fixes.patch' } });
    const patchPath = join(r.workspace, 'out/fixes.patch');
    expect(r.outputs['fix-patch-file']).toBe(patchPath);
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toContain('--- a/k8s/a.yaml\n+++ b/k8s/a.yaml\n');
    expect(patch).toContain('+        allowPrivilegeEscalation: false');
    const check = spawnSync('git', ['apply', '--check', patchPath], {
      cwd: r.workspace,
      encoding: 'utf8',
    });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
    expect(readFileSync(join(r.workspace, 'k8s/a.yaml'), 'utf8')).toBe(files['k8s/a.yaml']);
  });

  it('writes an empty patch when there is nothing to fix, so an upload step still finds a file', async () => {
    const r = await runAction({
      files: { 'a.yaml': example('hardened.yaml') },
      inputs: { 'fix-patch-file': 'fixes.patch' },
    });
    expect(readFileSync(join(r.workspace, 'fixes.patch'), 'utf8')).toBe('');
    expect(r.summary).toContain('No automatic fixes apply');
  });

  it('does not fix what ignores and disabled rules silence', async () => {
    // The finding points at the container's first key when the field is missing.
    const text = pod().replace(
      '    - name: app',
      '    # manifestlens-ignore: allow-privilege-escalation\n    - name: app',
    );
    const inline = await runAction({
      files: { 'a.yaml': text },
      inputs: { 'suggest-fixes': 'true' },
    });
    expect(inline.outputs['fixes-available']).toBe('0');
    const disabled = await runAction({
      files: { 'a.yaml': pod() },
      inputs: { 'suggest-fixes': 'true', 'disable-rules': 'allow-privilege-escalation' },
    });
    expect(disabled.outputs['fixes-available']).toBe('0');
  });

  it('holds back risky fixes until the risk is raised, and reads values from a policy file', async () => {
    const files = {
      'a.yaml': pod().replace('runAsUser: 1000', 'privileged: true'),
      'policy.yaml': 'params:\n  memoryLimit: 256Mi\n',
    };
    const low = await runAction({ files, inputs: { 'suggest-fixes': 'true' } });
    expect(low.summary).toContain('held back');
    expect(low.summary).toContain('--max-risk high');
    const high = await runAction({
      files,
      inputs: { 'suggest-fixes': 'true', 'fix-max-risk': 'high', 'fix-policy': 'policy.yaml' },
    });
    const report = JSON.parse(readFileSync(high.outputs['report-file'] as string, 'utf8'));
    const rulesFixed = report.fixes.files[0].applied.map((a: { ruleId: string }) => a.ruleId);
    expect(rulesFixed).toContain('privileged-container');
    expect(rulesFixed).toContain('missing-memory-limit');
  });

  it('rejects a fix policy outside the repository or with bad content', async () => {
    const outside = await runAction({
      files: { 'a.yaml': pod() },
      inputs: { 'suggest-fixes': 'true', 'fix-policy': '../policy.yaml' },
    });
    expect(outside.exitCode).toBe(1);
    const bad = await runAction({
      files: { 'a.yaml': pod(), 'p.yaml': 'params: 3' },
      inputs: { 'suggest-fixes': 'true', 'fix-policy': 'p.yaml' },
    });
    expect(bad.exitCode).toBe(1);
    expect(bad.log).toContain('"params" must be a mapping');
    const missing = await runAction({
      files: { 'a.yaml': pod() },
      inputs: { 'suggest-fixes': 'true', 'fix-policy': 'nope.yaml' },
    });
    expect(missing.exitCode).toBe(1);
  });

  it('does not change the verdict', async () => {
    const plain = await runAction({ files: { 'a.yaml': risky } });
    const withFixes = await runAction({
      files: { 'a.yaml': risky },
      inputs: { 'suggest-fixes': 'true' },
    });
    expect(withFixes.outputs).toMatchObject({
      result: plain.outputs['result'],
      findings: plain.outputs['findings'],
      errors: plain.outputs['errors'],
    });
    expect(withFixes.exitCode).toBe(plain.exitCode);
  });
});
