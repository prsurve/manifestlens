# Changelog

## Unreleased

### Added

- **Custom resources from a CRD.** Give ManifestLens a CustomResourceDefinition and documents of that
  kind are explained from the CRD's descriptions and checked against its schema: unknown fields (with
  a "did you mean"), wrong types, missing required fields, enum, pattern and range violations, and an
  `apiVersion` the CRD does not define. Web page: a "Custom resources" box that also loads a GitHub link. CLI: `--crd`. GitHub
  Action: the `crds` input. Core API: `parseCrds` and an optional `rules` argument for
  `explainManifest`. Schema features that need a full validator (`oneOf`, CEL rules) are skipped.
  A mistyped field with one clear closest match can be renamed by `fix` (medium risk, preview first).
  `fix` also lists the findings it cannot fix under "Needs a manual fix", and a clicked finding in the
  web page scrolls to its line even when long lines wrap.
  See [docs/custom-resources.md](docs/custom-resources.md).
- **Automatic fixes.** Rules can carry a structured `autofix`. `manifestlens fix <file>` previews
  validated fixes as a unified diff and writes them only with `--write` (a `.bak` copy is kept). Options:
  `--policy`, `--max-risk`, `--only`, `--no-backup`, plus `--rules` as for `check`.
  See [docs/auto-fix.md](docs/auto-fix.md).
- Five built-in fixes: `allow-privilege-escalation` (low risk), `may-run-as-root` (medium),
  `privileged-container` (high), and policy-driven `missing-memory-limit` and
  `loadbalancer-open-to-world` (medium).
- Core API: `fixManifest`, `isStale`, `unifiedDiff`, `lineEdits`, `parseFixPolicy`.
- Web page: a Fix tab with a preview, the diff and a copy button.
- VS Code extension: quick fixes and a preview-first "Fix this manifest" command.
- GitHub Action: inputs `suggest-fixes`, `fix-patch-file`, `fix-max-risk`, `fix-policy`, outputs
  `fixes-available` and `fix-patch-file`, a "Suggested fixes" summary section and a `fixes` key in the
  JSON report. All are opt in. The action never edits, commits or pushes.

- **Complex YAML in fixes.** Fixes now edit flow style (`{ a: 1 }`), JSON, and keys that hold an alias
  (`securityContext: *base` becomes a local override beside `<<: *base`). Merge keys are understood
  when checking, so inherited settings no longer cause false findings.
- **Kinds without rules are highlighted.** Each checked document has a `coverage`. Custom resources
  and other unknown kinds, and kinds that are explained but have no rules, are reported as not checked
  in the CLI, the web page, VS Code and the GitHub Action (a "Not checked" section and `notChecked`
  in the JSON report), so "no findings" is never mistaken for "safe".
- The fix result lists `notChecked` documents, so a misspelt or unknown kind (`Poddsds`) is
  called out in the CLI and the web Fix tab, with a "did you mean" hint, instead of "no fixes to apply".
- 18 new rules (34 in total): `default-service-account-token`, `missing-seccomp-profile`,
  `docker-socket-mount`, `sensitive-hostpath`, `host-port`, `dangerous-capabilities`, `secret-in-env`,
  `external-ips`, `ingress-no-tls`, `rbac-wildcard`, `rbac-escalation-verbs`, `cluster-admin-binding`,
  `anonymous-binding`, `secret-in-manifest`, `deprecated-api-version`, `job-no-ttl`,
  `cronjob-concurrency` and `pdb-blocks-eviction`. The first two have medium-risk fixes.
- Rule language: a `some` operator (one list item must satisfy a whole condition) and a `(?i)` prefix
  for case-insensitive `matches`.

### Compatibility

- Existing rules, CLI commands, Action inputs, outputs and report keys are unchanged. The `fixes` report
  key and the new summary section appear only when fixes are requested.
- New rules can add findings to files that were clean before (mostly `info`, and `error` for removed
  apiVersions and risky RBAC). Pin a rule off with `disable-rules` if needed.
- Rule files accept a new optional `autofix` key. Rules without it are never modified.
