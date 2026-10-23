import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkManifest, explainManifest, fixManifest, parseCrds, RuleError } from '../src/index.js';

const CRD = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: widgets.example.com }
spec:
  group: example.com
  names: { kind: Widget, plural: widgets }
  versions:
    - name: v1
      served: true
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [size]
              description: What the widget should look like.
              properties:
                size:
                  type: integer
                  minimum: 1
                  description: How many sprockets.
                mode:
                  type: string
                  enum: [fast, slow]
                dnsNames:
                  type: array
                  items: { type: string }
                labels:
                  type: object
                  additionalProperties: { type: string }
                free:
                  type: object
                  x-kubernetes-preserve-unknown-fields: true
`;

const rules = parseCrds(CRD);
const check = (yaml: string) => checkManifest(yaml, rules).documents[0]?.findings ?? [];
const ids = (yaml: string) => check(yaml).map((f) => f.ruleId);
const head = 'apiVersion: example.com/v1\nkind: Widget\nmetadata: { name: w }\n';

describe('parseCrds', () => {
  it('makes one rule per version and marks the kind as checked', () => {
    expect(rules).toHaveLength(1);
    const doc = checkManifest(`${head}spec: { size: 2 }`, rules).documents[0];
    expect(doc?.coverage.level).toBe('checked');
  });

  it('accepts a kubectl List and rejects other kinds', () => {
    const list = stringify({ kind: 'List', items: [parse(CRD)] });
    expect(parseCrds(list)).toHaveLength(1);
    expect(() => parseCrds('kind: Deployment\n')).toThrow(RuleError);
  });
});

describe('schema checks', () => {
  it('passes a valid resource, including free-form and map fields', () => {
    expect(
      ids(`${head}spec:\n  size: 3\n  mode: fast\n  labels: { a: b }\n  free: { anything: [1] }\n`),
    ).toEqual([]);
  });

  it('flags an unknown field with a did-you-mean and the right line', () => {
    const [f] = check(`${head}spec:\n  size: 3\n  dnsNmaes: [a]\n`);
    expect(f?.ruleId).toBe('crd-unknown-field');
    expect(f?.message).toContain('Did you mean "dnsNames"?');
    expect(f?.line).toBe(6);
  });

  it('suggests the field for a short typo that is two edits away', () => {
    const crd = parseCrds(CRD.replace('mode:', 'volumes: { type: object }\n                mode:'));
    const doc = checkManifest(`${head}spec: { size: 1, volue: {} }`, crd).documents[0];
    expect(doc?.findings[0]?.message).toContain('Did you mean "volumes"?');
  });

  it('points a missing field inside a list item at that item', () => {
    const crd = parseCrds(
      CRD.replace(
        'dnsNames:\n                  type: array\n                  items: { type: string }',
        'rows:\n                  type: array\n                  items:\n                    type: object\n                    required: [id]\n                    properties: { id: { type: string }, note: { type: string } }',
      ),
    );
    const f = checkManifest(`${head}spec:\n  size: 1\n  rows:\n    - note: x\n`, crd).documents[0]
      ?.findings[0];
    expect(f?.ruleId).toBe('crd-missing-required');
    expect(f?.line).toBe(7);
  });

  it('flags a missing required field, a wrong type and a bad value', () => {
    expect(ids(`${head}spec: { mode: fast }`)).toEqual(['crd-missing-required']);
    expect(ids(`${head}spec: { size: three }`)).toEqual(['crd-wrong-type']);
    expect(ids(`${head}spec: { size: 0, mode: warp }`).sort()).toEqual([
      'crd-invalid-value',
      'crd-invalid-value',
    ]);
  });

  it('flags a version the CRD does not define', () => {
    const yaml = 'apiVersion: example.com/v2\nkind: Widget\nspec: { size: 1 }\n';
    expect(ids(yaml)).toEqual(['crd-unknown-version']);
  });
});

describe('explain', () => {
  it('reports what the CRD finds wrong instead of hiding it', () => {
    const doc = explainManifest(`${head}spec:\n  size: 1\n  sise: 2\n`, rules).documents[0];
    expect(doc?.issues.map((i) => i.line)).toEqual([6]);
    expect(doc?.issues[0]?.message).toContain('"spec.sise"');
  });

  it('says so when part of a schema cannot be checked', () => {
    const crd = parseCrds(
      CRD.replace(
        'mode:',
        'either: { oneOf: [{ type: string }, { type: integer }] }\n                mode:',
      ),
    );
    const f = checkManifest(`${head}spec: { size: 1, either: 3 }`, crd).documents[0]?.findings;
    expect(f?.map((x) => x.ruleId)).toEqual(['crd-not-validated']);
    expect(f?.[0]?.severity).toBe('info');
  });

  it('uses the CRD descriptions for the fields of a custom kind', () => {
    const doc = explainManifest(`${head}spec: { size: 2, dnsNames: [a] }`, rules).documents[0];
    expect(doc?.unsupportedKind).toBe(false);
    expect(doc?.fields.find((f) => f.pattern === 'spec.size')?.explanation).toBe(
      'How many sprockets.',
    );
  });
});

describe('renaming a mistyped field', () => {
  const fix = (yaml: string, maxRisk: 'low' | 'medium' = 'medium') =>
    fixManifest(yaml, rules, { maxRisk });

  it('renames an unknown field to its one clear match, keeping comments and the value', () => {
    const yaml = `${head}spec:\n  mode: fast\n  sise: 3 # typo\n`;
    const r = fix(yaml);
    expect(r.status).toBe('fixed');
    expect(r.fixed).toBe(`${head}spec:\n  mode: fast\n  size: 3 # typo\n`);
    expect(r.applied[0]?.risk).toBe('medium');
    expect(r.remaining).toBe(0);
  });

  it('does nothing at the default low risk and says why', () => {
    const r = fix(`${head}spec:\n  sise: 3\n`, 'low');
    expect(r.status).toBe('unchanged');
    expect(r.skipped[0]?.reason).toBe('risk-too-high');
  });

  it('renames inside a list item, and keeps a quoted key quoted', () => {
    const crd = parseCrds(
      CRD.replace(
        'dnsNames:\n                  type: array\n                  items: { type: string }',
        'rows:\n                  type: array\n                  items:\n                    type: object\n                    properties: { name: { type: string } }',
      ),
    );
    const yaml = `${head}spec:\n  size: 1\n  rows:\n    - "nmae": a\n`;
    const r = fixManifest(yaml, crd, { maxRisk: 'medium' });
    expect(r.fixed).toBe(`${head}spec:\n  size: 1\n  rows:\n    - "name": a\n`);
  });

  it('leaves an ambiguous typo, an existing target and a plain unknown field alone', () => {
    const two = parseCrds(
      CRD.replace(
        'mode:',
        'volumeA: { type: string }\n                volumeB: { type: string }\n                mode:',
      ),
    );
    const ambiguous = fixManifest(`${head}spec:\n  size: 1\n  volumeC: x\n`, two, {
      maxRisk: 'medium',
    });
    expect(ambiguous.status).toBe('unchanged');
    expect(ambiguous.unfixed[0]?.message).toContain('"volumeA" or "volumeB"');
    expect(fix(`${head}spec:\n  size: 1\n  sise: 2\n`).status).toBe('unchanged');
    expect(fix(`${head}spec:\n  size: 1\n  zzzzzz: 2\n`).status).toBe('unchanged');
  });

  it('refuses a rename that would expose a new problem', () => {
    const r = fix(`${head}spec:\n  size: 1\n  modee: warp\n`);
    expect(r.status).toBe('unchanged');
    expect(r.skipped[0]?.reason).toBe('validation-failed');
  });
});
