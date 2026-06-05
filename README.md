# Bumpkin

GitHub Action that validates pull request release intent and resolves the next semantic version from Conventional Commit
history.

- On `pull_request` / `pull_request_target`, Bumpkin validates the PR title, checks that no PR commit requires a higher
  bump than the title promises, and optionally maintains one explanatory PR comment.
- On `push`, Bumpkin resolves the next semantic version from Git tags and commit history.

This is designed for squash-merge workflows: the PR title is the release signal, and the default-branch commit history
is used to calculate the concrete version.

## PR Guard

```yaml
name: Bumpkin

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  bumpkin:
    runs-on: ubuntu-latest
    steps:
      - uses: goeselt/bumpkin@v1.2.3
```

Disable the PR comment when you only want the check result:

```yaml
- uses: goeselt/bumpkin@v1.2.3
  with:
    pr-comment: false
```

## Version Resolution

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: goeselt/bumpkin@v1.2.3
        id: version

      - run: echo "${{ steps.version.outputs.release-tag }}"
        if: steps.version.outputs.release-needed == 'true'
```

## Inputs

| Input                  | Default | Used on | Description                                                     |
| ---------------------- | ------- | ------- | --------------------------------------------------------------- |
| `github-token`         | token   | PR      | Token used to list PR commits and post the PR comment.          |
| `pr-comment`           | `true`  | PR      | Whether to create or update the explanatory PR comment.         |
| `release-scope`        |         | push    | Tag namespace for scoped releases, e.g. `cli` for `cli/v1.2.3`. |
| `tag-prefix`           | `v`     | push    | Prefix for version tags, e.g. `v` for `v1.2.3`.                 |
| `initial-version`      | `0.0.0` | push    | Version used when no matching release tag exists.               |
| `release-paths`        |         | push    | Paths allowed to contribute to version resolution.              |
| `release-ignore-paths` |         | push    | Paths ignored during version resolution.                        |

`release-paths` and `release-ignore-paths` are newline-separated Git pathspecs. When `release-paths` is set, only
commits touching those paths can contribute a bump. When `release-ignore-paths` is set, commits touching only ignored
paths are left out of the release calculation.

```yaml
- uses: goeselt/bumpkin@v1.2.3
  id: version
  with:
    release-scope: cli
    release-paths: |
      cmd/cli
      internal/cli
      .goreleaser.yaml
    release-ignore-paths: |
      docs/
      README.md
```

## Outputs

| Output            | Example  | Description                                      |
| ----------------- | -------- | ------------------------------------------------ |
| `release-needed`  | `true`   | Whether the PR title or commit history releases. |
| `bump-level`      | `minor`  | Bump level: `major`, `minor`, `patch`, `none`.   |
| `current-version` | `1.2.3`  | Current version without tag prefix. Push only.   |
| `next-version`    | `1.3.0`  | Next version without tag prefix. Push only.      |
| `previous-tag`    | `v1.2.3` | Latest matching release tag. Push only.          |
| `release-tag`     | `v1.3.0` | Full release tag. Push only.                     |
| `major-tag`       | `v1`     | Floating major tag. Push only.                   |
| `minor-tag`       | `v1.3`   | Floating minor tag. Push only.                   |

## Commit Mapping

| Pattern                   | Bump    |
| ------------------------- | ------- |
| `!` after type or scope   | `major` |
| `BREAKING CHANGE:` footer | `major` |
| `feat: ...`               | `minor` |
| `fix: ...` / `perf: ...`  | `patch` |
| Other accepted types      | `none`  |

Accepted types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
