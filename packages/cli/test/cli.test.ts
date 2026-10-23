import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../src/main.js';

const fixture = fileURLToPath(new URL('../../../examples/web.yaml', import.meta.url));

function cli(...args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = run(args, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
  });
  return { code, stdout, stderr };
}

describe('manifestlens explain', () => {
  it('prints each source line with its explanation', () => {
    const { code, stdout } = cli('explain', fixture);
    expect(code).toBe(0);
    expect(stdout).toContain('== Deployment "web" (apps/v1), document 1 of 2, line 1 ==');
    expect(stdout).toContain('== Service "web" (v1), document 2 of 2, line 26 ==');
    expect(stdout).toContain('19 |           image: nginx:1.27');
    expect(stdout).toContain('The container image to run');
  });

  it('prints help and exits 0', () => {
    const { code, stdout } = cli('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('manifestlens explain <file>');
  });

  it('exits 2 with usage when the command or file is missing', () => {
    expect(cli().code).toBe(2);
    expect(cli('explain').code).toBe(2);
    expect(cli('explain').stderr).toContain('Usage:');
    expect(cli('frobnicate', fixture).code).toBe(2);
  });

  it('exits 2 for an unknown option', () => {
    const { code, stderr } = cli('explain', '--nope', fixture);
    expect(code).toBe(2);
    expect(stderr).toContain('Usage:');
  });

  it('exits 2 when the file cannot be read', () => {
    const { code, stderr } = cli('explain', join(fixture, 'missing.yaml'));
    expect(code).toBe(2);
    expect(stderr).toContain('Cannot read');
  });
});

describe('manifestlens check', () => {
  const risky = fileURLToPath(new URL('../../../examples/risky.yaml', import.meta.url));
  const hardened = fileURLToPath(new URL('../../../examples/hardened.yaml', import.meta.url));

  it('reports findings with line numbers and exits 1 on errors', () => {
    const { code, stdout } = cli('check', risky);
    expect(code).toBe(1);
    expect(stdout).toContain('line 17  ERROR  privileged-container');
    expect(stdout).toContain('Fix:');
    expect(stdout).toMatch(/\d+ findings: 2 error, /);
  });

  it('exits 0 and says so when nothing is wrong', () => {
    const { code, stdout } = cli('check', hardened);
    expect(code).toBe(0);
    expect(stdout).toContain('No issues found.');
    expect(stdout).toContain('0 findings: 0 error, 0 warning, 0 info');
  });

  it('honours --fail-on', () => {
    const noErrors = (extra: string[]) => cli('check', hardened, ...extra).code;
    expect(noErrors(['--fail-on', 'info'])).toBe(0);
    expect(cli('check', risky, '--fail-on', 'none').code).toBe(0);
    expect(cli('check', risky, '--fail-on', 'bogus').code).toBe(2);
  });

  it('loads extra rules from a file or directory', () => {
    const dir = fileURLToPath(new URL('./fixtures/custom-rules/', import.meta.url));
    for (const target of [dir, join(dir, 'team.yaml')]) {
      const { code, stdout } = cli('check', hardened, '--rules', target);
      expect(stdout).toContain('team-needs-owner-label');
      expect(code).toBe(0); // the custom rule is only a warning
    }
  });

  it('learns a custom resource from --crd and checks it against the schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-crd-'));
    const crd = join(dir, 'widget-crd.yaml');
    writeFileSync(
      crd,
      `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
spec:
  group: example.com
  names: { kind: Widget }
  versions:
    - name: v1
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                size: { type: integer, description: How many sprockets. }
`,
    );
    const widget = join(dir, 'widget.yaml');
    writeFileSync(widget, 'apiVersion: example.com/v1\nkind: Widget\nspec:\n  sise: 3\n');

    const without = cli('check', widget);
    expect(without.stdout).toContain('Custom resource Widget');
    const checked = cli('check', widget, '--crd', crd, '--fail-on', 'warning');
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain('Did you mean "size"?');
    const good = join(dir, 'good.yaml');
    writeFileSync(good, 'apiVersion: example.com/v1\nkind: Widget\nspec:\n  size: 3\n');
    expect(cli('explain', good, '--crd', crd).stdout).toContain('How many sprockets.');
    const held = cli('fix', widget, '--crd', crd);
    expect(held.stderr).toContain('Not applied:');
    expect(held.stderr).toContain('--max-risk medium');
    const renamed = cli('fix', widget, '--crd', crd, '--max-risk', 'medium');
    expect(renamed.stdout).toContain('+  size: 3');
    expect(renamed.stderr).toContain('Rename "sise" to "size"');
    expect(cli('check', widget, '--crd', widget).code).toBe(2);
  });

  it('rejects broken or duplicate rules with exit 2', () => {
    const bad = join(
      fileURLToPath(new URL('./fixtures/custom-rules/', import.meta.url)),
      'nope.yaml',
    );
    expect(cli('check', hardened, '--rules', bad).code).toBe(2);
    const dup = fileURLToPath(new URL('./fixtures/duplicate-rule.yaml', import.meta.url));
    const { code, stderr } = cli('check', hardened, '--rules', dup);
    expect(code).toBe(2);
    expect(stderr).toContain('Duplicate rule id "single-replica"');
  });
});

describe('manifestlens diff', () => {
  const cli = (...args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = run(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
    return { code, stdout, stderr };
  };
  const example = (name: string) =>
    fileURLToPath(new URL(`../../../examples/${name}`, import.meta.url));
  const oldF = example('diff-old.yaml');
  const newF = example('diff-new.yaml');

  it('prints a readable summary', () => {
    const { code, stdout } = cli('diff', oldF, newF);
    expect(code).toBe(0);
    expect(stdout).toContain('== Deployment "web": changed ==');
    expect(stdout).toContain('Scales up from 2 to 5');
    expect(stdout).toContain(
      'line 29 (old file)  - spec.template.spec.containers[0].readinessProbe',
    );
    expect(stdout).toContain('== Service "metrics": added ==');
    expect(stdout).toContain('== Service "legacy": removed ==');
    expect(stdout).toMatch(
      /2 changed, 1 added, 1 removed, 1 unchanged\. Findings: \d+ new, 0 resolved\./,
    );
  });

  it('fails when the change adds findings at the --fail-on level', () => {
    expect(cli('diff', oldF, newF, '--fail-on', 'warning').code).toBe(1);
    expect(cli('diff', oldF, newF, '--fail-on', 'error').code).toBe(0);
    expect(cli('diff', oldF, oldF, '--fail-on', 'info').code).toBe(0);
  });

  it('needs exactly two readable files', () => {
    expect(cli('diff', oldF).code).toBe(2);
    expect(cli('diff', oldF, newF, oldF).code).toBe(2);
    const missing = cli('diff', oldF, example('nope.yaml'));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('Cannot read');
  });
});

describe('explain docs links', () => {
  it('prints each docs link once per document', () => {
    const { stdout } = cli(
      'explain',
      fileURLToPath(new URL('../../../examples/hardened.yaml', import.meta.url)),
    );
    expect((stdout.match(/Docs: \S+/g) ?? []).length).toBeGreaterThan(3);
    const deployment = stdout.split('== Service')[0] ?? '';
    const links = deployment.match(/Docs: \S+/g) ?? [];
    expect(new Set(links).size).toBe(links.length);
  });
});

describe('manifestlens fix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifestlens-fix-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const POD = `# keep this comment
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: app
      image: nginx:1.27
      securityContext:
        privileged: true
`;
  function write(name: string, text: string): string {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  }

  it('previews a diff on stdout and the report on stderr, and writes nothing', () => {
    const file = write('preview.yaml', POD.replace('privileged: true', 'runAsUser: 1000'));
    const { code, stdout, stderr } = cli('fix', file);
    expect(code).toBe(0);
    expect(stdout).toContain('+        allowPrivilegeEscalation: false');
    expect(stdout).toContain(`--- a${file}\n`); // absolute path: no doubled slash
    expect(stderr).toContain('1 fix ready (preview, nothing written)');
    expect(stderr).toContain('Validation passed');
    expect(stderr).toContain('Run again with --write');
    expect(readFileSync(file, 'utf8')).toBe(POD.replace('privileged: true', 'runAsUser: 1000'));
  });

  it('prints a diff that git apply accepts', () => {
    const file = write('git.yaml', POD.replace('privileged: true', 'runAsUser: 1000'));
    const { stdout } = cli('fix', file, '--max-risk', 'medium');
    const patch = join(dir, 'p.patch');
    // The labels hold the absolute path; point them at the file name so git can find it from `dir`.
    writeFileSync(
      patch,
      stdout.replace(/^--- .*$/m, '--- a/git.yaml').replace(/^\+\+\+ .*$/m, '+++ b/git.yaml'),
    );
    const out = spawnSync('git', ['apply', '--check', patch], { cwd: dir, encoding: 'utf8' });
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
  });

  it('does not apply medium or high risk fixes unless asked', () => {
    const file = write('risk.yaml', POD);
    const low = cli('fix', file, '--only', 'privileged-container');
    expect(low.code).toBe(0);
    expect(low.stdout).toBe('');
    expect(low.stderr).toContain('risk-too-high');
    expect(low.stderr).toContain('--max-risk high');
    const high = cli('fix', file, '--only', 'privileged-container', '--max-risk', 'high');
    expect(high.stdout).toContain('-        privileged: true\n+        privileged: false');
  });

  it('--write applies the fixes, keeps a backup and the comments, and is idempotent', () => {
    const file = write('apply.yaml', POD);
    const first = cli('fix', file, '--write', '--max-risk', 'high');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('applied');
    const fixed = readFileSync(file, 'utf8');
    expect(fixed).toContain('# keep this comment');
    expect(fixed).toContain('privileged: false');
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(POD);

    const second = cli('fix', file, '--write', '--max-risk', 'high');
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('no fixes to apply');
    expect(readFileSync(file, 'utf8')).toBe(fixed);
    expect(existsSync(`${file}.bak.1`)).toBe(false);
  });

  it('--no-backup skips the backup, and is refused without --write', () => {
    const file = write('nobak.yaml', POD);
    expect(cli('fix', file, '--write', '--no-backup', '--max-risk', 'high').code).toBe(0);
    expect(existsSync(`${file}.bak`)).toBe(false);
    const bad = cli('fix', file, '--no-backup');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--no-backup');
  });

  it('reads policy values for fixes that need them', () => {
    const file = write('policy.yaml', POD.replace('privileged: true', 'runAsUser: 1000'));
    const without = cli('fix', file, '--only', 'missing-memory-limit', '--max-risk', 'medium');
    expect(without.stdout).toBe('');
    expect(without.stderr).toContain('needs-input');
    const policy = write('policy-file.yaml', 'params:\n  memoryLimit: 256Mi\n');
    const withPolicy = cli(
      'fix',
      file,
      '--only',
      'missing-memory-limit',
      '--max-risk',
      'medium',
      '--policy',
      policy,
    );
    expect(withPolicy.stdout).toContain('+          memory: 256Mi');
    const bad = cli('fix', file, '--policy', write('bad-policy.yaml', 'params: 3'));
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('"params" must be a mapping');
    expect(cli('fix', file, '--policy', join(dir, 'nope.yaml')).code).toBe(2);
  });

  it('leaves findings from custom rules without a fix untouched', () => {
    const file = write('custom.yaml', POD.replace('privileged: true', 'runAsUser: 1000'));
    const { code, stderr } = cli(
      'fix',
      file,
      '--rules',
      fileURLToPath(new URL('./fixtures/custom-rules/team.yaml', import.meta.url)),
      '--only',
      'allow-privilege-escalation',
    );
    expect(code).toBe(0);
    expect(stderr).toContain('1 fix ready');
  });

  it('rejects bad usage', () => {
    const file = write('usage.yaml', POD);
    expect(cli('fix', file, '--max-risk', 'extreme').code).toBe(2);
    expect(cli('fix', file, '--only', 'no-such-rule').stderr).toContain('Unknown rule id');
    expect(cli('fix', join(dir, 'missing.yaml')).code).toBe(2);
    expect(cli('fix').code).toBe(2);
  });

  it('exits 1 for files with no Kubernetes documents or with YAML errors, and never writes them', () => {
    const empty = write('empty.yaml', '# nothing\n');
    expect(cli('fix', empty).code).toBe(1);
    const broken = write('broken.yaml', `${POD}      oops: [\n`);
    const result = cli('fix', broken, '--write', '--no-backup');
    expect(result.code).toBe(1);
    expect(readFileSync(broken, 'utf8')).toBe(`${POD}      oops: [\n`);
  });

  it('does not change what the other commands print', () => {
    const risky = fileURLToPath(new URL('../../../examples/risky.yaml', import.meta.url));
    const check = cli('check', risky);
    expect(check.stdout).not.toContain('autofix');
    expect(check.stdout).toContain('privileged-container');
  });
});
