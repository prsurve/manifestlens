# ManifestLens GitHub Action

Checks your Kubernetes manifests for risky settings and passes or fails the build. It uses the same rules
and explanations as the CLI, the web page and the VS Code extension, runs entirely on the runner, and
sends nothing anywhere.

```yaml
- uses: actions/checkout@v7
- uses: prsurve/manifestlens@v1
```

That is a working setup: it checks every Kubernetes manifest in the repository and fails the build if any
finding is an **error** (privileged containers, running as root).

## What passes and what fails

A run **fails** when any of these is true:

1. A severity has more findings than it is allowed. By default **errors** are allowed 0 times and warnings
   and info are not limited. `fail-on` moves that line (see below).
2. `max-total` is set and there are more findings than that.
3. A manifest is not valid YAML (turn this off with `fail-on-parse-error: false`).

Otherwise it **passes**. Two modes change what a violation does to the build, never what is reported:

| Mode            | A violation...                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| `mode: enforce` | fails the step (exit code 1). This is the default.                                       |
| `mode: report`  | is reported in full (summary, annotations, comment, outputs) but the step stays green.   |
| `dry-run: true` | is only logged: no annotations, no comment, never fails. For trying settings out safely. |

Mistakes in your own configuration (a typo in an input, an unknown key in the config file) always fail the
step with a clear message, even in report mode, because a silently ignored setting would be worse.

### `fail-on` and the limits

`fail-on` is the lowest severity that counts as a failure. It sets the default limits:

| `fail-on`         | errors allowed | warnings allowed | info allowed |
| ----------------- | -------------- | ---------------- | ------------ |
| `error` (default) | 0              | any              | any          |
| `warning`         | 0              | 0                | any          |
| `info`            | 0              | 0                | 0            |
| `none`            | any            | any              | any          |

An explicit `max-errors`, `max-warnings` or `max-info` replaces what `fail-on` implies for that severity,
so `fail-on: warning` with `max-warnings: 10` tolerates ten warnings, and `fail-on: none` with
`max-errors: 2` tolerates two errors.

## Three levels of settings

Settings can be given in three places. When the same setting appears in more than one, the more specific one
wins:

```
built-in defaults   <   .github/manifestlens.yml   <   workflow inputs (with:)
   (lowest)                 (your project)              (this job; highest)
```

- **Built-in defaults** are in the code. Every input is optional.
- **The config file** (`.github/manifestlens.yml`, or the path in `config-file`) holds your team's policy,
  reviewed like any other file. Every input has a key of the same name, plus `ignore`. A missing file at the
  default location is fine; a missing file you named is an error.
- **Workflow inputs** override the file for one job, which is what you want for a matrix leg or a one-off.

How values combine:

- A single value (a number, `fail-on`, `scope`...) is **replaced** by the higher level.
- `paths` is **replaced** by the higher level.
- `rules`, `disable-rules` and `ignore` are **added together**, so a workflow can add to team policy.
- `severity-overrides` are **merged rule by rule**, the workflow winning on a clash.

An input you leave out counts as "not set", so it never hides a value from the config file. The job summary
ends with a "Configuration used" table showing the value and the level each setting came from.

## Inputs

All are optional.

| Input                 | Default                    | Meaning                                                                                                                                                      |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paths`               | `**/*.yaml`, `**/*.yml`    | Globs, one per line; `!` excludes. Only files with `apiVersion` and `kind` are checked.                                                                      |
| `working-directory`   | repository root            | What `paths` is relative to (monorepos, matrix jobs).                                                                                                        |
| `config-file`         | `.github/manifestlens.yml` | Project settings file.                                                                                                                                       |
| `scope`               | `all`                      | `all`, `changed` (files this change touches) or `new` (only findings this change introduces).                                                                |
| `base-ref`            | from the event             | What to compare with for `changed` and `new`.                                                                                                                |
| `fail-on`             | `error`                    | `error`, `warning`, `info` or `none`.                                                                                                                        |
| `max-errors`          | from `fail-on`             | Most errors allowed.                                                                                                                                         |
| `max-warnings`        | from `fail-on`             | Most warnings allowed.                                                                                                                                       |
| `max-info`            | from `fail-on`             | Most info findings allowed.                                                                                                                                  |
| `max-total`           | no limit                   | Most findings of any severity.                                                                                                                               |
| `fail-on-parse-error` | `true`                     | Fail on a manifest that is not valid YAML.                                                                                                                   |
| `mode`                | `enforce`                  | `enforce` or `report`.                                                                                                                                       |
| `dry-run`             | `false`                    | Compute and log only.                                                                                                                                        |
| `rules`               | none                       | Extra rule files or folders in the repository ([how to write rules](writing-rules.md)).                                                                      |
| `crds`                | none                       | CustomResourceDefinition files or folders in the repository, so custom resources are checked against their schema ([custom resources](custom-resources.md)). |
| `disable-rules`       | none                       | Rule ids to turn off.                                                                                                                                        |
| `severity-overrides`  | none                       | `rule-id=severity` per line (`error`, `warning`, `info`, `off`).                                                                                             |
| `annotations`         | `true`                     | Mark findings on the changed lines in pull requests.                                                                                                         |
| `max-annotations`     | `30`                       | Most annotations in total; GitHub shows 10 of each severity.                                                                                                 |
| `comment`             | `auto`                     | `auto`: comment when there is something to say. `always`. `never`.                                                                                           |
| `summary`             | `true`                     | Write the job summary.                                                                                                                                       |
| `sarif-file`          | none                       | Write SARIF here for code scanning.                                                                                                                          |
| `suggest-fixes`       | `false`                    | List validated automatic fixes in the summary and report. Nothing is changed.                                                                                |
| `fix-patch-file`      | none                       | Write all suggested fixes as one unified diff for `git apply`. Implies `suggest-fixes`.                                                                      |
| `fix-max-risk`        | `low`                      | Highest fix risk to suggest: `low`, `medium` or `high`.                                                                                                      |
| `fix-policy`          | none                       | YAML file in the repository with values fixes cannot guess ([auto-fix.md](auto-fix.md)).                                                                     |
| `report-file`         | `manifestlens-report.json` | Where to write the JSON report.                                                                                                                              |
| `label`               | none                       | Names the run: separate summary heading and pull request comment per matrix leg.                                                                             |
| `max-files`           | `2000`                     | Safety limit on files matched.                                                                                                                               |
| `max-file-size-kb`    | `1024`                     | Larger files are skipped.                                                                                                                                    |
| `github-token`        | `${{ github.token }}`      | Used only for the pull request comment.                                                                                                                      |

## Outputs

| Output                                    | Meaning                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `result`                                  | `pass`, `fail`, `report` (violated, not blocking) or `dry-run`.                    |
| `passed`                                  | `true` when no rule was violated, whatever the mode.                               |
| `errors`, `warnings`, `infos`, `findings` | Counts.                                                                            |
| `parse-errors`                            | Manifests that could not be read.                                                  |
| `files-checked`                           | Manifest files checked.                                                            |
| `suppressed`                              | Findings silenced by `ignore` or inline comments.                                  |
| `report-file`                             | Path of the JSON report (every finding, the limits, where each setting came from). |
| `sarif-file`                              | Path of the SARIF file, or empty.                                                  |
| `fixes-available`                         | Validated fixes found (`0` when `suggest-fixes` is off).                           |
| `fix-patch-file`                          | Path of the fix patch, or empty.                                                   |

## Large result sets

A repository with hundreds of findings stays readable:

- **By rule.** When there are more than 10 findings, the job summary and the pull request comment open with a
  table of how many findings each rule produced, most severe and most common first
  (`allow-privilege-escalation: 172`, `image-latest-tag: 163`...). Fixing one rule across the repository
  often clears a large share of them.
- **Two jobs on the same lines.** If one job reports on the whole repository and another enforces with
  `scope: new`, both annotate the same new lines and an error shows up twice. Set `annotations: false` on the
  report-only job.
- **Annotations.** GitHub shows at most 10 annotations of each severity (error, warning, notice) per step and
  silently drops the rest. The action therefore asks for up to 10 of each, errors first, and spreads them
  across different rules so a long run of the same finding does not crowd out the others. When some are left
  out, the log says how many; every finding is still in the summary and the report file.

## Config file

See [`examples/manifestlens.config.yml`](../examples/manifestlens.config.yml) for a commented example
that uses every kind of setting. A typo is caught with a hint:

```
.github/manifestlens.yml: unknown setting "fail-onn" (did you mean "fail-on"?).
```

## Ignoring things

- **By path or rule, in the config file:** `ignore: [{ path: 'k8s/jobs/**', rules: [missing-readiness-probe] }]`.
  Leave out `rules` to silence everything under the path.
- **On one line, in the manifest:** a `# manifestlens-ignore: rule-id, other-rule` comment on the line a
  finding points at, or on a comment line directly above it. `all` silences every rule there.
- **Switch a rule off or change its severity everywhere:** `disable-rules`, `severity-overrides`.

Ignored findings are counted in the `suppressed` output so they stay visible.

## Adopting it in a repository that already has problems

Use `scope: new`. The action compares each changed manifest with its version on the base branch and counts
only the findings the change introduces, so existing problems do not block anyone, and the job summary
explains what the change does ("Scales up from 2 to 5", "Pods are replaced in a rolling update"). It needs
`actions/checkout` with `fetch-depth: 0`. Editing a line that is still wrong counts as new: the finding
names the value you changed.

## Matrix jobs

Give each leg a `label`. It becomes part of the summary heading and of the comment marker, so legs do not
overwrite each other's pull request comment. Combine with `working-directory` to check one folder per leg.
See [`examples/workflows/manifestlens.yml`](../examples/workflows/manifestlens.yml).

## Security notes

- The action makes no network calls except the optional pull request comment to the GitHub API.
- Files, configuration and rules are all read from the checkout. Paths in settings must stay inside the
  repository; links pointing outside it are skipped.
- Text from manifests is escaped before it goes into the summary or a comment.
- Pull requests from forks get a read-only token, so the comment cannot be posted there. The action warns
  and carries on; the summary and annotations still work.
- **Be careful with `pull_request_target`.** It runs with a write token against the base repository. If you
  use it, check out trusted code, not the pull request's, and do not load `config-file` or `rules` from
  the untrusted checkout: a pull request could change them.
- A custom rule can contain a regular expression. Review rule changes like code.

## Testing it before you publish

### On your machine

```sh
npm ci
npm run build -w @manifestlens/action
npm test                      # unit tests plus end-to-end runs of the whole action
```

Run the built action on any folder the way GitHub would, with inputs as `--name value`:

```sh
npm run local -w @manifestlens/action -- --workspace . --paths examples/risky.yaml --fail-on warning
npm run local -w @manifestlens/action -- --workspace . --paths examples/risky.yaml --mode report
npm run local -w @manifestlens/action -- --workspace . --paths examples/risky.yaml --dry-run true
```

It prints the log, the outputs, the job summary as markdown, and the exit code ("the build would fail").
To run a whole workflow locally, [`act`](https://github.com/nektos/act) works with `uses: ./`.

### In a real repository

1. Push the branch. The **Action self-test** workflow runs the action from that exact commit on the sample
   manifests and checks that it passes, fails, reports and rejects bad input as designed.
2. In a test repository, reference the branch: `uses: prsurve/manifestlens@your-branch`, set
   `mode: report` first and read the job summary, then switch to `enforce`.
3. Open a pull request that breaks a rule to see the annotations, the comment and the failing check.

### Publishing

GitHub runs `packages/action/dist/index.js` directly, so the bundle is committed and CI fails if it is
out of date. To release: merge, then tag `v1.0.0` and move the `v1` tag to it
(`git tag -fa v1 -m v1 && git push origin v1 --force`). Users pin `@v1` and get compatible updates.
Listing the action in the GitHub Marketplace is a checkbox when you create the release; `action.yml`
already has the name, description and branding it needs.
