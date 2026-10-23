import { describe, expect, it } from 'vitest';
import { toRawUrl } from '../src/crd-url.js';

describe('toRawUrl', () => {
  it('accepts raw GitHub hosts as they are', () => {
    const u = 'https://raw.githubusercontent.com/o/r/main/crd.yaml';
    expect(toRawUrl(` ${u} `)?.href).toBe(u);
    expect(toRawUrl('https://gist.githubusercontent.com/o/1/raw/crd.yaml')).toBeDefined();
  });

  it('turns a GitHub file link into its raw form', () => {
    expect(toRawUrl('https://github.com/o/r/blob/main/deploy/crd.yaml')?.href).toBe(
      'https://raw.githubusercontent.com/o/r/main/deploy/crd.yaml',
    );
  });

  it('refuses other hosts, plain http, credentials and non-file GitHub pages', () => {
    for (const bad of [
      'https://example.com/crd.yaml',
      'http://raw.githubusercontent.com/o/r/main/crd.yaml',
      'https://user:pw@raw.githubusercontent.com/o/r/main/crd.yaml',
      'https://github.com/o/r',
      'https://raw.githubusercontent.com.evil.com/x',
      'not a url',
      '',
    ]) {
      expect(toRawUrl(bad), bad).toBeUndefined();
    }
  });
});
