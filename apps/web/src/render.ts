import { formatValue, supportedKinds } from '@manifestlens/core';
import type {
  CheckResult,
  DiffResult,
  DocumentDiff,
  ExplainResult,
  FieldChange,
  Finding,
  FixResult,
  Severity,
} from '@manifestlens/core';
import { docsLink, el } from './dom.js';

const SEVERITIES: Severity[] = ['error', 'warning', 'info'];

/** Which text box a line number refers to. */
export type JumpTarget = 'main' | 'old' | 'new';

/** What the user has done to a result list. It survives re-rendering while they keep typing. */
export interface View {
  /** Severities switched off with the filter chips. */
  hidden: Set<Severity>;
  /** Keys of findings the user opened. */
  open: Set<string>;
  expandAll: boolean;
  /** Text in the explain filter box. */
  query: string;
  /** Select a line in the matching text box. */
  jump: (target: JumpTarget, line: number) => void;
}

export function createView(jump: View['jump'] = () => undefined): View {
  return { hidden: new Set(), open: new Set(), expandAll: false, query: '', jump };
}

export function renderMessage(text: string): HTMLElement {
  return el('p', { class: 'empty', text });
}

type Named = {
  kind?: string | undefined;
  name?: string | undefined;
  apiVersion?: string | undefined;
};

function title(doc: Named): string {
  if (!doc.kind) return 'Unknown object';
  return `${doc.kind}${doc.name ? ` "${doc.name}"` : ''}${doc.apiVersion ? ` (${doc.apiVersion})` : ''}`;
}

function issues(list: { message: string; line?: number | undefined }[]): HTMLElement[] {
  return list.map((i) =>
    el('p', { class: 'issue', text: `${i.line ? `Line ${i.line}: ` : ''}${i.message}` }),
  );
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A small "go to line" button that selects that line in the matching text box. */
function lineButton(view: View, target: JumpTarget, line: number, label?: string): HTMLElement {
  const where =
    target === 'old' ? ' in the old version' : target === 'new' ? ' in the new version' : '';
  const button = el('button', {
    class: 'ln',
    text: label ?? String(line),
    attrs: {
      type: 'button',
      'aria-label': `Go to line ${line}${where}`,
      title: `Go to line ${line}${where}`,
    },
  });
  button.addEventListener('click', () => view.jump(target, line));
  return button;
}

function toolbar(...children: (Node | false)[]): HTMLElement {
  return el('div', { class: 'toolbar' }, children);
}

/** A button that opens or closes every <details> matching `selector` inside `root`. */
function expandButton(root: HTMLElement, view: View, selector: string): HTMLElement {
  const button = el('button', {
    class: 'text-btn',
    text: view.expandAll ? 'Collapse all' : 'Expand all',
    attrs: { type: 'button' },
  });
  button.addEventListener('click', () => {
    view.expandAll = !view.expandAll;
    if (!view.expandAll) view.open.clear();
    root.querySelectorAll<HTMLDetailsElement>(selector).forEach((d) => (d.open = view.expandAll));
    button.textContent = view.expandAll ? 'Collapse all' : 'Expand all';
  });
  return button;
}

/* ------------------------------------------------------------------------------------------- */
/* Explain                                                                                     */
/* ------------------------------------------------------------------------------------------- */

export function renderExplain(
  result: ExplainResult,
  source: string,
  view: View = createView(),
): HTMLElement {
  const lines = source.split(/\r?\n/);
  const root = el('div');
  const rows: { item: HTMLElement; text: string }[] = [];

  const sections = result.documents.map((doc) => {
    // Show each docs link once per object, so the column does not repeat the same word 35 times.
    const linked = new Set<string>();
    const items = doc.fields.map((f) => {
      const text = (lines[f.line - 1] ?? '').trimEnd();
      const item = el('li', { class: 'row' }, [
        lineButton(view, 'main', f.line),
        el('code', { text }),
        el('div', {
          class: 'why',
          text: f.explanation ?? '',
          attrs: f.explanation ? { title: f.explanation } : {},
        }),
        f.docsUrl && !linked.has(f.docsUrl) ? docsLink(f.docsUrl) : el('span'),
      ]);
      if (f.docsUrl) linked.add(f.docsUrl);
      rows.push({ item, text: `${text} ${f.explanation ?? ''}`.toLowerCase() });
      return item;
    });
    return el('section', { class: 'doc' }, [
      el('h2', {}, [
        title(doc),
        el('span', { class: 'meta', text: plural(items.length, 'field') }),
      ]),
      ...issues(doc.issues),
      doc.unsupportedKind &&
        doc.kind &&
        el('p', {
          class: 'issue',
          text: `No field explanations for kind "${doc.kind}" yet (supported: ${supportedKinds().join(', ')}).`,
        }),
      el('ul', { class: 'rows' }, items),
    ]);
  });

  const count = el('p', { class: 'summary', text: plural(rows.length, 'field') });
  const filter = el('input', {
    class: 'filter',
    attrs: { type: 'search', placeholder: 'Filter fields', 'aria-label': 'Filter fields' },
  });
  filter.value = view.query;

  const apply = (): void => {
    const q = filter.value.trim().toLowerCase();
    view.query = filter.value;
    let shown = 0;
    for (const { item, text } of rows) {
      const match = q === '' || text.includes(q);
      item.hidden = !match;
      if (match) shown++;
    }
    count.textContent =
      q === '' ? plural(rows.length, 'field') : `${shown} of ${rows.length} fields`;
  };
  filter.addEventListener('input', apply);

  const full = el('button', { class: 'text-btn', attrs: { type: 'button' } });
  const showFull = (on: boolean): void => {
    view.expandAll = on;
    root.classList.toggle('full', on);
    full.textContent = on ? 'Compact' : 'Show full text';
    full.setAttribute('aria-pressed', String(on));
  };
  full.addEventListener('click', () => showFull(!view.expandAll));

  root.append(toolbar(count, filter, full), ...sections);
  showFull(view.expandAll);
  apply();
  return root;
}

/* ------------------------------------------------------------------------------------------- */
/* Findings (Check and Diff)                                                                   */
/* ------------------------------------------------------------------------------------------- */

function findingItem(f: Finding, view: View, target: JumpTarget): HTMLElement {
  const key = `${f.ruleId}|${f.message}`;
  const details = el('details', { class: `finding sev-${f.severity}` }, [
    el('summary', {}, [
      el('span', { class: 'badge', text: f.severity }),
      el('span', { class: 'msg', text: f.message }),
      el('span', { class: 'at', text: `L${f.line}` }),
    ]),
    el('div', { class: 'detail' }, [
      f.why && el('p', {}, [el('strong', { text: 'Why: ' }), f.why]),
      f.fix && el('p', {}, [el('strong', { text: 'Fix: ' }), f.fix]),
      el('p', {}, [
        el('span', { class: 'rule-id', text: f.ruleId }),
        ' ',
        lineButton(view, target, f.line, `Go to line ${f.line}`),
      ]),
    ]),
  ]);
  details.open = view.expandAll || view.open.has(key);
  details.addEventListener('toggle', () => {
    if (details.open) view.open.add(key);
    else view.open.delete(key);
  });
  return el('li', { class: `sev-${f.severity}` }, [details]);
}

function findingList(findings: Finding[], view: View, target: JumpTarget): HTMLElement {
  return el(
    'ul',
    { class: 'findings' },
    findings.map((f) => findingItem(f, view, target)),
  );
}

function severityChips(root: HTMLElement, findings: Finding[], view: View): HTMLElement[] {
  return SEVERITIES.map((s) => {
    const n = findings.filter((f) => f.severity === s).length;
    const chip = el('button', {
      class: `chip sev-${s}`,
      text: `${n} ${s}`,
      attrs: {
        type: 'button',
        'aria-pressed': String(!view.hidden.has(s)),
        title: `Show or hide ${s} findings`,
      },
    });
    chip.addEventListener('click', () => {
      const hide = !view.hidden.has(s);
      if (hide) view.hidden.add(s);
      else view.hidden.delete(s);
      chip.setAttribute('aria-pressed', String(!hide));
      root.toggleAttribute(`data-hide-${s}`, hide);
    });
    return chip;
  });
}

function applyHidden(root: HTMLElement, view: View): void {
  for (const s of view.hidden) root.setAttribute(`data-hide-${s}`, '');
}

/** A "not checked" box: the point first, then why, the likely typo, and what an empty result means. */
function coverageNote(
  c: { level: string; headline?: string; detail?: string; suggestion?: string; note?: string },
  what: string,
  line: number,
): HTMLElement {
  return el('div', { class: `coverage coverage-${c.level}` }, [
    el('p', { class: 'coverage-head' }, [
      el('strong', { text: `Not checked: ${c.headline ?? what}` }),
      el('span', { class: 'coverage-where', text: `${what}, line ${line}` }),
    ]),
    c.detail && el('p', { text: c.detail }),
    c.suggestion && el('p', {}, ['Did you mean ', el('code', { text: c.suggestion }), '?']),
    c.note && el('p', { class: 'coverage-note', text: c.note }),
  ]);
}

export function renderCheck(result: CheckResult, view: View = createView()): HTMLElement {
  const root = el('div');
  applyHidden(root, view);
  const all = result.documents.flatMap((d) => d.findings);

  const unchecked = result.documents.filter((d) => d.coverage.level !== 'checked').length;
  if (all.length === 0) {
    const text =
      unchecked === 0
        ? 'No issues found.'
        : `No findings, but ${plural(unchecked, 'document')} not checked (no rules for the kind).`;
    root.append(toolbar(el('p', { class: 'summary', text })));
  } else {
    root.append(
      toolbar(
        el('p', { class: 'summary', text: plural(all.length, 'finding') }),
        ...severityChips(root, all, view),
        expandButton(root, view, 'details.finding'),
      ),
    );
  }
  for (const doc of result.documents) {
    root.append(
      el('section', { class: 'doc' }, [
        el('h2', {}, [
          title(doc),
          el('span', {
            class: 'meta',
            text: doc.findings.length
              ? plural(doc.findings.length, 'finding')
              : doc.coverage.level === 'checked'
                ? 'no findings'
                : 'not checked',
          }),
        ]),
        ...issues(doc.issues),
        doc.coverage.level !== 'checked' && coverageNote(doc.coverage, title(doc), doc.startLine),
        doc.findings.length > 0 && findingList(doc.findings, view, 'main'),
      ]),
    );
  }
  return root;
}

/* ------------------------------------------------------------------------------------------- */
/* Diff                                                                                        */
/* ------------------------------------------------------------------------------------------- */

/** `spec.template.spec.containers[1].env[1].value` becomes `containers[web].env[LOG_LEVEL].value`. */
export function friendlyPath(change: FieldChange): string {
  const parts = change.path.split('.').map((token) => {
    const m = /^(.*)\[\d+\]$/.exec(token);
    const named = m ? change.within.find((w) => w.list === m[1]) : undefined;
    return m && named ? `${m[1]}[${named.name}]` : token;
  });
  // Drop the wrapper every Pod template field sits under; the heading already names the object.
  return parts.join('.').replace(/^spec\.(?:jobTemplate\.spec\.)?(?:template\.spec\.)?/, '');
}

const isObject = (v: unknown): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);

function changeItem(c: FieldChange, view: View): HTMLElement {
  const before = c.type === 'added' ? undefined : c.before;
  const after = c.type === 'removed' ? undefined : c.after;
  const values: (Node | string | false)[] = [];
  if (c.type === 'changed') {
    values.push(
      el('del', { text: formatValue(before) }),
      ' → ',
      el('ins', { text: formatValue(after) }),
    );
  } else if (c.type === 'added' && !isObject(after)) {
    values.push(el('ins', { text: formatValue(after) }));
  } else if (c.type === 'removed' && !isObject(before)) {
    values.push(el('del', { text: formatValue(before) }));
  }
  const target: JumpTarget = c.type === 'removed' ? 'old' : 'new';

  return el('li', { class: `change ch-${c.type}` }, [
    el('div', { class: 'change-head' }, [
      el('span', { class: 'ctx', text: c.type }),
      el('code', { text: friendlyPath(c) || c.path, attrs: { title: c.path } }),
      values.length > 0 && el('span', { class: 'val' }, values),
      lineButton(view, target, c.line, `L${c.line}${c.type === 'removed' ? ' old' : ''}`),
    ]),
    c.effect
      ? el('p', { class: 'effect' }, [c.effect, c.docsUrl && docsLink(c.docsUrl)])
      : c.explanation &&
        el('p', { class: 'effect why' }, [c.explanation, c.docsUrl && docsLink(c.docsUrl)]),
  ]);
}

function diffDocument(doc: DocumentDiff, view: View): HTMLElement {
  const ns = doc.namespace ? ` in ${doc.namespace}` : '';
  const counts = [
    doc.changes.length > 0 && plural(doc.changes.length, 'change'),
    doc.newFindings.length > 0 && `${plural(doc.newFindings.length, 'new finding')}`,
    doc.resolvedFindings.length > 0 && `${doc.resolvedFindings.length} resolved`,
  ].filter(Boolean);

  const newFindings =
    doc.newFindings.length > 0 &&
    el('details', { class: 'group' }, [
      el('summary', {}, [
        doc.status === 'added' ? 'Findings for this new object' : 'New findings',
        ` (${doc.newFindings.length})`,
      ]),
      findingList(doc.newFindings, view, 'new'),
    ]);
  const resolved =
    doc.resolvedFindings.length > 0 &&
    el('details', { class: 'group' }, [
      el('summary', { text: `Resolved findings (${doc.resolvedFindings.length})` }),
      el(
        'ul',
        { class: 'resolved' },
        doc.resolvedFindings.map((f) =>
          el('li', { text: `${f.severity.toUpperCase()}  ${f.ruleId}: ${f.message}` }),
        ),
      ),
    ]);

  const body = el('div', {}, [
    ...doc.notes.map((n) => el('p', { class: 'note', text: n })),
    doc.changes.length > 0 &&
      el(
        'ul',
        { class: 'changes' },
        doc.changes.map((c) => changeItem(c, view)),
      ),
    newFindings,
    resolved,
  ]);
  const details = el('details', { class: 'doc-body' }, [
    el('summary', { class: 'doc-head' }, [
      `${doc.kind} "${doc.name}"${ns}`,
      el('span', { class: `status st-${doc.status}`, text: doc.status }),
      el('span', { class: 'meta', text: counts.join(' · ') }),
    ]),
    body,
  ]);
  details.open = true;
  return el('section', { class: 'doc' }, [details]);
}

export function renderDiff(result: DiffResult, view: View = createView()): HTMLElement {
  const root = el('div');
  const tally = (s: DocumentDiff['status']) =>
    result.documents.filter((d) => d.status === s).length;
  const shown = result.documents.filter(
    (d) => d.status !== 'unchanged' || d.newFindings.length > 0 || d.resolvedFindings.length > 0,
  );

  root.append(
    toolbar(
      el('p', {
        class: 'summary',
        text: `${tally('changed')} changed, ${tally('added')} added, ${tally('removed')} removed, ${tally('unchanged')} unchanged`,
      }),
      shown.some((d) => d.newFindings.length > 0) &&
        expandButton(root, view, 'details.group, details.finding'),
    ),
  );
  for (const i of result.issues) {
    root.append(
      el('p', {
        class: 'issue',
        text: `${i.side} file${i.line ? `, line ${i.line}` : ''}: ${i.message}`,
      }),
    );
  }
  for (const doc of shown) root.append(diffDocument(doc, view));
  return root;
}

/* ------------------------------------------------------------------------------------------- */
/* Fix                                                                                         */
/* ------------------------------------------------------------------------------------------- */

/**
 * A preview of fixes: what would change, what was held back and why, and the diff. Nothing is
 * applied in the browser; the user copies the fixed manifest if they want it.
 */
function button(label: string, onClick: () => void): HTMLElement {
  const b = el('button', { class: 'text-btn', text: label, attrs: { type: 'button' } });
  b.addEventListener('click', onClick);
  return b;
}

/** What the Fix tab can do with a result. Applying only edits the text box; undo puts it back. */
export interface FixActions {
  copy?: (text: string) => void;
  apply?: (text: string) => void;
  /** Select a 1-based line in the input box. */
  jump?: (line: number) => void;
  /** Present right after an apply, to restore the text from before it. */
  undo?: () => void;
}

export function renderFix(result: FixResult, diff: string, actions: FixActions = {}): HTMLElement {
  const root = el('div');
  const n = result.applied.length;
  const view = createView((_target, line) => actions.jump?.(line));
  const lines = result.original.split('\n');
  /** A "go to line" button and the line's text, so the finding can be found in the YAML. */
  const at = (line: number): HTMLElement[] => [
    lineButton(view, 'main', line, `Line ${line}`),
    el('code', { class: 'src', text: ` ${(lines[line - 1] ?? '').trim()}` }),
  ];

  if (result.status === 'rejected') {
    root.append(
      el('p', { class: 'summary', text: 'Nothing changed: the fixes failed validation.' }),
      ...result.validation.problems.map((p) => el('p', { class: 'issue', text: p })),
    );
  } else if (n === 0) {
    root.append(
      toolbar(
        el('p', {
          class: 'summary',
          text:
            result.unfixed.length > 0
              ? `No fixes to apply, but ${plural(result.unfixed.length, 'finding')} need a manual fix.`
              : result.notChecked.length > 0
                ? `No fixes to apply, and ${plural(result.notChecked.length, 'document')} not checked.`
                : 'No fixes to apply.',
        }),
        actions.undo ? button('Undo last apply', actions.undo) : false,
      ),
    );
  } else {
    root.append(
      toolbar(
        el('p', { class: 'summary', text: `${plural(n, 'fix')} ready` }),
        button('Apply to input', () => actions.apply?.(result.fixed)),
        button('Copy fixed manifest', () => actions.copy?.(result.fixed)),
        actions.undo ? button('Undo last apply', actions.undo) : false,
      ),
    );
    root.append(
      el('p', {
        class: 'note',
        text: `Checked: the YAML parses, only the listed fields changed, ${plural(result.validation.resolved, 'finding')} gone, none added.`,
      }),
    );
  }

  for (const d of result.notChecked) {
    root.append(coverageNote(d, `${d.kind ?? 'Document'}${d.name ? ` "${d.name}"` : ''}`, d.line));
  }

  if (n > 0) {
    root.append(
      el('section', { class: 'doc' }, [
        el('h2', { text: 'Would change' }),
        ...result.applied.map((a) =>
          el('details', { class: `finding risk-${a.risk}` }, [
            el('summary', {}, [
              el('span', { class: 'badge', text: `${a.risk} risk` }),
              ` ${a.ruleId} `,
              ...at(a.line),
            ]),
            el('p', { text: a.summary }),
            ...a.changes.map((c) =>
              el('p', { class: 'meta', text: `${c.path}: ${c.before} -> ${c.after}` }),
            ),
          ]),
        ),
      ]),
    );
  }
  if (result.unfixed.length > 0) {
    root.append(
      el('section', { class: 'doc' }, [
        el('h2', { text: 'Needs a manual fix' }),
        ...result.unfixed.map((f) =>
          el('p', { class: `issue sev-${f.severity}` }, [
            el('span', { class: 'badge', text: f.severity }),
            ` ${f.ruleId} `,
            ...at(f.line),
            el('span', { text: ` ${f.message}` }),
          ]),
        ),
      ]),
    );
  }
  if (result.skipped.length > 0) {
    root.append(
      el('section', { class: 'doc' }, [
        el('h2', { text: 'Not applied' }),
        ...result.skipped.map((s) =>
          el('p', { class: `issue risk-${s.risk}` }, [
            el('span', { class: 'badge', text: `${s.risk} risk` }),
            ` ${s.ruleId} `,
            ...at(s.line),
            el('span', { text: ` ${s.detail}` }),
          ]),
        ),
      ]),
    );
  }
  if (diff !== '') {
    const pre = el('pre', { class: 'diff-text', attrs: { 'aria-label': 'Unified diff' } });
    for (const line of diff.split('\n')) {
      if (line === '') continue;
      const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
      pre.append(el('span', { class: `dl dl-${kind}`, text: `${line}\n` }));
    }
    root.append(el('section', { class: 'doc' }, [el('h2', { text: 'Diff' }), pre]));
  }
  return root;
}
