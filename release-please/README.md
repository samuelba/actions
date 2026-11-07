# release-please

Runs [release-please](https://github.com/googleapis/release-please) and then cleans up the notes of
the open release pull request:

- Entries for merge commits are dropped, so a pull request merged with a merge commit shows up once.
- A later commit that repeats both the subject and the diff of an earlier one in the same section is
  dropped. Such copies come from branches built on commits that were rebased and merged elsewhere.

Both `CHANGELOG.md` on the release branch and the pull request body are updated. Sections left
without entries are removed.

## Usage

The repo needs a `release-please-config.json` and a `.release-please-manifest.json`. Run the action
in its own job, because the cleanup checks out the release branch.

```yaml
name: Release

on:
  push:
    branches:
      - main

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      release_created: ${{ steps.release.outputs.release_created }}
      tag_name: ${{ steps.release.outputs.tag_name }}
    steps:
      - uses: samuelba/actions/release-please@v1
        id: release
        with:
          token: ${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}

  publish:
    needs: release-please
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "publish ${{ needs.release-please.outputs.tag_name }}"
```

Pull requests that `github.token` opens do not start other workflows. Store a fine-grained personal
access token with read and write access to Contents and Pull requests as `RELEASE_PLEASE_TOKEN` if
CI should run on the release pull request. Without one, enable "Allow GitHub Actions to create and
approve pull requests" in the repository's Actions settings.

## Inputs

| Input            | Default                         |
| ---------------- | ------------------------------- |
| `token`          | `github.token`                  |
| `config-file`    | `release-please-config.json`    |
| `manifest-file`  | `.release-please-manifest.json` |
| `target-branch`  | `main`                          |
| `changelog-path` | `CHANGELOG.md`                  |
| `dedupe`         | `true`                          |
| `node-version`   | `24`                            |

## Outputs

`release_created`, `tag_name`, `version`, `major`, `sha` and `pr`, passed through from
release-please. `pr` is the JSON of the release pull request, not its number.
