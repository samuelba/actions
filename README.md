# actions

GitHub Actions shared by my repositories.

| Action                            | What it does                                                         |
| --------------------------------- | -------------------------------------------------------------------- |
| [release-please](release-please/) | release-please, with merge commits and copies dropped from the notes |

Use an action as `samuelba/actions/<name>@v1`, or pin a commit:
`samuelba/actions/<name>@<sha> # v1.2.3`.

## Releases

The whole repository shares one version, because a tag covers every action. release-please opens a
release pull request from conventional commits, and each release moves the major tag, for example
`v1`, to the new version.

## Development

```sh
npm ci
npm run typecheck
npm run format:check
npm test
```
