import { Problems, asBool, asEnum, asInt, asList, asString, suggest } from './coerce.js';
import type {
  FailOn,
  IgnoreEntry,
  Layer,
  RuleSeverity,
  SettingKey,
  Settings,
  Source,
} from './types.js';

/** Level 1: what you get with no input and no config file. */
export const DEFAULTS: Settings = {
  paths: ['**/*.yaml', '**/*.yml'],
  workingDirectory: '.',
  configFile: '.github/manifestlens.yml',
  scope: 'all',
  baseRef: '',
  failOn: 'error',
  maxErrors: null,
  maxWarnings: null,
  maxInfo: null,
  maxTotal: null,
  failOnParseError: true,
  mode: 'enforce',
  dryRun: false,
  rules: [],
  crds: [],
  disableRules: [],
  severityOverrides: {},
  ignore: [],
  annotations: true,
  maxAnnotations: 30,
  comment: 'auto',
  summary: true,
  sarifFile: '',
  reportFile: 'manifestlens-report.json',
  label: '',
  suggestFixes: false,
  fixPatchFile: '',
  fixMaxRisk: 'low',
  fixPolicy: '',
  maxFiles: 2000,
  maxFileSizeKb: 1024,
};

type Parser<K extends SettingKey> = (
  value: unknown,
  name: string,
  p: Problems,
) => Settings[K] | undefined;
type Field<K extends SettingKey> = { name: string; parse: Parser<K> };
type Fields = { [K in SettingKey]: Field<K> };

const count = (min: number) => (v: unknown, n: string, p: Problems) => asInt(v, n, p, min);
const text = (v: unknown, n: string, p: Problems) => asString(v, n, p);

/**
 * One entry per setting. The same parser reads the workflow input and the config-file key, so the
 * two can never disagree about names or validation.
 */
const FIELDS: Fields = {
  paths: { name: 'paths', parse: (v, n, p) => asList(v, n, p, false) },
  workingDirectory: { name: 'working-directory', parse: text },
  configFile: { name: 'config-file', parse: text },
  scope: { name: 'scope', parse: (v, n, p) => asEnum(v, ['all', 'changed', 'new'] as const, n, p) },
  baseRef: { name: 'base-ref', parse: text },
  failOn: {
    name: 'fail-on',
    parse: (v, n, p) => asEnum<FailOn>(v, ['error', 'warning', 'info', 'none'], n, p),
  },
  maxErrors: { name: 'max-errors', parse: count(0) },
  maxWarnings: { name: 'max-warnings', parse: count(0) },
  maxInfo: { name: 'max-info', parse: count(0) },
  maxTotal: { name: 'max-total', parse: count(0) },
  failOnParseError: { name: 'fail-on-parse-error', parse: (v, n, p) => asBool(v, n, p) },
  mode: { name: 'mode', parse: (v, n, p) => asEnum(v, ['enforce', 'report'] as const, n, p) },
  dryRun: { name: 'dry-run', parse: (v, n, p) => asBool(v, n, p) },
  rules: { name: 'rules', parse: (v, n, p) => asList(v, n, p, false) },
  crds: { name: 'crds', parse: (v, n, p) => asList(v, n, p, false) },
  disableRules: { name: 'disable-rules', parse: (v, n, p) => asList(v, n, p, true) },
  severityOverrides: { name: 'severity-overrides', parse: parseSeverityOverrides },
  ignore: { name: 'ignore', parse: parseIgnore },
  annotations: { name: 'annotations', parse: (v, n, p) => asBool(v, n, p) },
  maxAnnotations: { name: 'max-annotations', parse: (v, n, p) => asInt(v, n, p, 0, 500) },
  comment: {
    name: 'comment',
    parse: (v, n, p) => asEnum(v, ['auto', 'always', 'never'] as const, n, p),
  },
  summary: { name: 'summary', parse: (v, n, p) => asBool(v, n, p) },
  sarifFile: { name: 'sarif-file', parse: text },
  reportFile: { name: 'report-file', parse: text },
  label: { name: 'label', parse: text },
  suggestFixes: { name: 'suggest-fixes', parse: (v, n, p) => asBool(v, n, p) },
  fixPatchFile: { name: 'fix-patch-file', parse: text },
  fixMaxRisk: {
    name: 'fix-max-risk',
    parse: (v, n, p) => asEnum(v, ['low', 'medium', 'high'] as const, n, p),
  },
  fixPolicy: { name: 'fix-policy', parse: text },
  maxFiles: { name: 'max-files', parse: (v, n, p) => asInt(v, n, p, 1, 100000) },
  maxFileSizeKb: { name: 'max-file-size-kb', parse: (v, n, p) => asInt(v, n, p, 1, 51200) },
};

const KEYS = Object.keys(FIELDS) as SettingKey[];
const SEVERITIES = ['error', 'warning', 'info', 'off'] as const;

/** `ignore` is structured, so it can only come from the config file. */
export const INPUT_NAMES: string[] = KEYS.filter((k) => k !== 'ignore').map((k) => FIELDS[k].name);
const CONFIG_NAMES = [...KEYS.map((k) => FIELDS[k].name), 'version'];

function parseSeverityOverrides(
  value: unknown,
  name: string,
  p: Problems,
): Record<string, RuleSeverity> | undefined {
  let pairs: [string, unknown][];
  if (typeof value === 'string') {
    pairs = [];
    for (const line of value.split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      const m = /^([^=:\s]+)\s*[=:]\s*(\S+)$/.exec(t);
      if (!m) {
        p.add(`${name}: "${t}" should look like rule-id=severity.`);
        return undefined;
      }
      pairs.push([m[1] as string, m[2]]);
    }
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    pairs = Object.entries(value);
  } else {
    p.add(`${name}: must be a list of rule-id=severity lines or a mapping.`);
    return undefined;
  }
  const out: Record<string, RuleSeverity> = {};
  for (const [id, level] of pairs) {
    const sev = asEnum<RuleSeverity>(level, SEVERITIES, `${name}.${id}`, p);
    if (sev) out[id] = sev;
  }
  return out;
}

function parseIgnore(value: unknown, name: string, p: Problems): IgnoreEntry[] | undefined {
  if (!Array.isArray(value)) {
    p.add(`${name}: must be a list of { path, rules } entries.`);
    return undefined;
  }
  const out: IgnoreEntry[] = [];
  value.forEach((entry: unknown, i) => {
    const at = `${name}[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      p.add(`${at}: must be a mapping with "path" and/or "rules".`);
      return;
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (key !== 'path' && key !== 'rules' && key !== 'rule') {
        const hint = suggest(key, ['path', 'rules']);
        p.add(`${at}: unknown key "${key}"${hint ? ` (did you mean "${hint}"?)` : ''}.`);
      }
    }
    const item: IgnoreEntry = {};
    if (e.path !== undefined) {
      const path = asString(e.path, `${at}.path`, p);
      if (path) item.path = path;
    }
    const rules = e.rules ?? e.rule;
    if (rules !== undefined) {
      const list = asList(rules, `${at}.rules`, p, true);
      if (list) item.rules = list;
    }
    if (item.path === undefined && item.rules === undefined) {
      p.add(`${at}: needs "path", "rules", or both.`);
      return;
    }
    out.push(item);
  });
  return out;
}

function readLayer(values: Record<string, unknown>, skipEmpty: boolean, p: Problems): Layer {
  const layer: Record<string, unknown> = {};
  for (const key of KEYS) {
    const { name, parse } = FIELDS[key] as Field<SettingKey>;
    const raw = values[name];
    if (raw === undefined || (skipEmpty && raw === '')) continue;
    const parsed = (parse as Parser<SettingKey>)(raw, name, p);
    if (parsed !== undefined) layer[key] = parsed;
  }
  return layer as Layer;
}

/** Level 3: values the workflow passed with `with:`. Empty means "not set", so defaults can be told apart. */
export function parseInputs(raw: Record<string, string>, p: Problems): Layer {
  const rest: Record<string, unknown> = { ...raw };
  delete rest.ignore;
  return readLayer(rest, true, p);
}

/** Level 2: the checked-in config file. Unknown keys are errors, with a hint for typos. */
export function parseConfig(data: unknown, origin: string, p: Problems): Layer {
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    p.add(`${origin}: must be a mapping of settings.`);
    return {};
  }
  const values = data as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!CONFIG_NAMES.includes(key)) {
      const hint = suggest(key, CONFIG_NAMES);
      p.add(`${origin}: unknown setting "${key}"${hint ? ` (did you mean "${hint}"?)` : ''}.`);
    }
  }
  if (values.version !== undefined && values.version !== 1) {
    p.add(
      `${origin}: version ${String(values.version)} is not supported. This action reads version 1.`,
    );
  }
  return readLayer(values, false, p);
}

const UNION_KEYS: SettingKey[] = ['rules', 'crds', 'disableRules', 'ignore', 'severityOverrides'];

/**
 * Combine the levels: defaults, then the config file, then workflow inputs. A setting given at a
 * higher level replaces the lower one, except the lists of rules to add, disable and ignore, which
 * are added together (so a workflow can add to team policy), and severity overrides, which are
 * merged key by key with the workflow winning.
 */
export function resolveSettings(
  config: Layer,
  inputs: Layer,
): { settings: Settings; sources: Record<SettingKey, Source> } {
  const settings: Record<string, unknown> = { ...DEFAULTS };
  const sources = {} as Record<SettingKey, Source>;

  for (const key of KEYS) {
    const inConfig = key in config;
    const inInputs = key in inputs;
    sources[key] =
      inConfig && inInputs
        ? UNION_KEYS.includes(key)
          ? 'config+input'
          : 'input'
        : inInputs
          ? 'input'
          : inConfig
            ? 'config'
            : 'default';

    if (key === 'severityOverrides') {
      settings[key] = { ...(config[key] ?? {}), ...(inputs[key] ?? {}) };
    } else if (UNION_KEYS.includes(key) && (inConfig || inInputs)) {
      const merged = [
        ...((config[key] as unknown[] | undefined) ?? []),
        ...((inputs[key] as unknown[] | undefined) ?? []),
      ];
      const seen = new Set<string>();
      settings[key] = merged.filter((item) => {
        const id = JSON.stringify(item);
        return seen.has(id) ? false : (seen.add(id), true);
      });
    } else if (inInputs) {
      settings[key] = inputs[key];
    } else if (inConfig) {
      settings[key] = config[key];
    }
  }
  return { settings: settings as unknown as Settings, sources };
}

const LABEL = /^[\w .:/@+-]{0,64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/;

function unsafePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes('..');
}

/** Checks that need more than one setting, or a closer look than a type can give. */
export function validateSettings(s: Settings): string[] {
  const problems: string[] = [];
  if (s.paths.length === 0) problems.push('paths: needs at least one pattern.');
  if (s.paths.every((p) => p.startsWith('!')))
    problems.push('paths: needs at least one pattern that is not an exclusion (!).');
  for (const key of [
    'workingDirectory',
    'configFile',
    'sarifFile',
    'reportFile',
    'fixPatchFile',
    'fixPolicy',
  ] as const) {
    const value = s[key];
    if (value !== '' && unsafePath(value)) {
      problems.push(
        `${FIELDS[key].name}: "${value}" must be a relative path inside the repository (no "..").`,
      );
    }
  }
  for (const [name, list] of [
    ['rules', s.rules],
    ['crds', s.crds],
  ] as const) {
    for (const path of list) {
      if (unsafePath(path))
        problems.push(
          `${name}: "${path}" must be a relative path inside the repository (no "..").`,
        );
    }
  }
  if (!LABEL.test(s.label))
    problems.push('label: use up to 64 letters, numbers, spaces and . : / @ + - characters.');
  if (s.baseRef !== '' && !REF.test(s.baseRef))
    problems.push(`base-ref: "${s.baseRef}" is not a valid commit, branch or tag name.`);
  if (s.reportFile === '') problems.push('report-file: must not be empty.');
  return problems;
}

const RANK = { info: 0, warning: 1, error: 2 } as const;

export interface Thresholds {
  error: number | null;
  warning: number | null;
  info: number | null;
  total: number | null;
}

/**
 * How many of each severity are allowed (`null` = any number). An explicit `max-*` wins. Otherwise
 * `fail-on` decides: severities at or above it allow none, the rest allow any number.
 */
export function thresholds(s: Settings): Thresholds {
  const derived = (sev: keyof typeof RANK, explicit: number | null): number | null => {
    if (explicit !== null) return explicit;
    return s.failOn !== 'none' && RANK[sev] >= RANK[s.failOn] ? 0 : null;
  };
  return {
    error: derived('error', s.maxErrors),
    warning: derived('warning', s.maxWarnings),
    info: derived('info', s.maxInfo),
    total: s.maxTotal,
  };
}
