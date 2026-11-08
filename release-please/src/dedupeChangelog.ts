import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BULLET = /^[*-] /
const HEADING = /^#{1,6} /
const RELEASE_HEADING = /^#{1,2} /
const SECTION_HEADING = /^### /
const THEMATIC_BREAK = /^---\s*$/
const COMMIT_URL = /\/commit\/([0-9a-f]{7,40})\b/i
const COMMIT_LINK = /\s*\(\[[0-9a-f]{7,40}\]\([^)]*\/commit\/[0-9a-f]{7,40}\)\)/gi
const FIRST_COMMIT_LINK = /\s*\(\[[0-9a-f]{7,40}\]\([^)]*\/commit\/[0-9a-f]{7,40}\)\)/i
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const DIFF_BUFFER_BYTES = 64 * 1024 * 1024

export function omitMergeCommitEntries(markdown: string, mergeShas: ReadonlySet<string>): string {
  const merges = new Set([...mergeShas].map((sha) => sha.toLowerCase()))
  return mapLines(markdown, (lines) => dropEmptySections(withoutMergeBullets(lines, merges)))
}

// A branch built on commits that were rebased and merged elsewhere brings the old copies to main
// as well. Those copies repeat both the subject and the diff of a commit listed before them.
export function omitCopiedCommitEntries(
  markdown: string,
  patchIds: ReadonlyMap<string, string>,
): string {
  return mapLines(markdown, (lines) => dropEmptySections(withoutCopiedBullets(lines, patchIds)))
}

export function shasWithRepeatedSubjects(markdown: string): string[] {
  const bySubject = new Map<string, string[]>()
  for (const { key, sha } of commitBullets(markdown.split('\n'))) {
    bySubject.set(key, [...(bySubject.get(key) ?? []), sha])
  }
  return [...bySubject.values()].filter((shas) => shas.length > 1).flat()
}

// Same format as release-please's include-commit-authors, which drops the author before
// release-please#2874 is released.
export function appendCommitAuthors(
  markdown: string,
  authors: ReadonlyMap<string, string>,
): string {
  return mapLines(markdown, (lines) => lines.map((line) => withAuthor(line, authors)))
}

interface PackageConfig {
  'include-commit-authors'?: boolean
  [option: string]: unknown
}

interface ReleasePleaseConfig extends PackageConfig {
  packages?: Record<string, PackageConfig>
}

export function commitAuthorsEnabled(config: ReleasePleaseConfig): boolean {
  const fallback = config['include-commit-authors'] === true
  const packages = Object.values(config.packages ?? {})
  if (packages.length === 0) return fallback
  return packages.some((entry) => (entry['include-commit-authors'] ?? fallback) === true)
}

function withAuthor(line: string, authors: ReadonlyMap<string, string>): string {
  if (!BULLET.test(line)) return line
  const sha = COMMIT_URL.exec(line)?.[1]?.toLowerCase()
  const author = sha === undefined ? undefined : authors.get(sha)
  const link = FIRST_COMMIT_LINK.exec(line)
  if (author === undefined || !link) return line
  const subject = line.slice(0, link.index)
  if (subject.endsWith(` (${author})`)) return line
  return `${subject} (${author})${line.slice(link.index)}`
}

function mapLines(markdown: string, transform: (lines: readonly string[]) => string[]): string {
  const endsWithNewline = markdown.endsWith('\n')
  const lines = markdown.split('\n')
  if (endsWithNewline) lines.pop()
  return `${transform(lines).join('\n')}${endsWithNewline ? '\n' : ''}`
}

interface CommitBullet {
  index: number
  key: string
  sha: string
}

// The key holds the release and section headings so equal subjects elsewhere stay apart.
function commitBullets(lines: readonly string[]): CommitBullet[] {
  const bullets: CommitBullet[] = []
  let release = ''
  let section = ''
  lines.forEach((line, index) => {
    if (RELEASE_HEADING.test(line)) {
      release = line
      section = ''
    } else if (SECTION_HEADING.test(line)) {
      section = line
    } else if (BULLET.test(line)) {
      const sha = COMMIT_URL.exec(line)?.[1]?.toLowerCase()
      const subject = line.replace(COMMIT_LINK, '').trim()
      if (sha) bullets.push({ index, key: `${release}\n${section}\n${subject}`, sha })
    }
  })
  return bullets
}

function withoutCopiedBullets(
  lines: readonly string[],
  patchIds: ReadonlyMap<string, string>,
): string[] {
  const seen = new Set<string>()
  const copies = new Set<number>()
  for (const { index, key, sha } of commitBullets(lines)) {
    const patchId = patchIds.get(sha)
    if (patchId === undefined) continue
    const change = `${key}\n${patchId}`
    if (seen.has(change)) copies.add(index)
    seen.add(change)
  }
  return lines.filter((_, index) => !copies.has(index))
}

function withoutMergeBullets(lines: readonly string[], mergeShas: ReadonlySet<string>): string[] {
  return lines.filter((line) => {
    if (!BULLET.test(line)) return true
    const sha = COMMIT_URL.exec(line)?.[1]?.toLowerCase()
    return sha === undefined || !mergeShas.has(sha)
  })
}

function dropEmptySections(lines: readonly string[]): string[] {
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined || !SECTION_HEADING.test(line)) {
      if (line !== undefined) kept.push(line)
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length) {
      const next = lines[end]
      if (next !== undefined && (HEADING.test(next) || THEMATIC_BREAK.test(next))) break
      end += 1
    }
    const body = lines.slice(index + 1, end)
    if (body.some((entry) => BULLET.test(entry))) kept.push(line, ...body)
    index = end
  }
  return kept
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const changelog = readFileSync(args.changelogPath, 'utf8')
  const pullRequestBody = args.pullRequestBodyPath
    ? readFileSync(args.pullRequestBodyPath, 'utf8')
    : undefined
  const commit = commitLookup(args.repo)
  const texts = [changelog, pullRequestBody ?? '']
  const deduped = args.dedupe ? dedupe(args.repo, texts, commit) : texts
  const isAuthorsEnabled =
    args.configPath !== undefined && commitAuthorsEnabled(readConfig(args.configPath))
  const [nextChangelog, nextBody] = isAuthorsEnabled ? withCommitAuthors(deduped, commit) : deduped
  replaceIfChanged(args.changelogPath, changelog, nextChangelog ?? changelog)
  if (args.pullRequestBodyPath && pullRequestBody !== undefined) {
    replaceIfChanged(args.pullRequestBodyPath, pullRequestBody, nextBody ?? pullRequestBody)
  }
}

function dedupe(repo: string, texts: readonly string[], commit: CommitLookup): string[] {
  const mergeShas = new Set(commitShas(texts).filter((sha) => commit(sha).parents > 1))
  const withoutMerges = texts.map((text) => omitMergeCommitEntries(text, mergeShas))
  const patchIds = commitPatchIds(repo, withoutMerges.flatMap(shasWithRepeatedSubjects))
  return withoutMerges.map((text) => omitCopiedCommitEntries(text, patchIds))
}

// Only the commits of the pull request body, so older releases in the changelog stay as they are.
function withCommitAuthors(texts: readonly string[], commit: CommitLookup): string[] {
  const [, pullRequestBody = ''] = texts
  const authors = new Map<string, string>()
  for (const sha of commitShas([pullRequestBody])) {
    const author = commit(sha).author
    if (author !== undefined) authors.set(sha, author)
  }
  return texts.map((text) => appendCommitAuthors(text, authors))
}

function readConfig(path: string): ReleasePleaseConfig {
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`${path} is not a release-please config`)
  }
  return config as ReleasePleaseConfig
}

function commitPatchIds(repo: string, shas: readonly string[]): Map<string, string> {
  const patchIds = new Map<string, string>()
  for (const sha of new Set(shas)) {
    const patchId = commitPatchId(repo, sha)
    if (patchId) patchIds.set(sha, patchId)
  }
  return patchIds
}

// GitHub refuses the diff of a very large commit. Such a commit stays in the notes.
function commitPatchId(repo: string, sha: string): string | undefined {
  try {
    const diff = execFileSync(
      'gh',
      ['api', `repos/${repo}/commits/${sha}`, '-H', 'Accept: application/vnd.github.diff'],
      { encoding: 'utf8', maxBuffer: DIFF_BUFFER_BYTES },
    )
    const output = execFileSync('git', ['patch-id', '--stable'], {
      encoding: 'utf8',
      input: diff,
      maxBuffer: DIFF_BUFFER_BYTES,
    })
    return /^[0-9a-f]{40}\b/.exec(output)?.[0]
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error'
    process.stderr.write(`keeping ${sha}: could not read its diff (${message})\n`)
    return undefined
  }
}

function commitShas(texts: readonly string[]): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(/\/commit\/([0-9a-f]{7,40})\b/gi)) {
      const sha = match[1]?.toLowerCase()
      if (sha) found.add(sha)
    }
  }
  return [...found]
}

interface CommitInfo {
  parents: number
  author: string | undefined
}

type CommitLookup = (sha: string) => CommitInfo

function commitLookup(repo: string): CommitLookup {
  const cache = new Map<string, CommitInfo>()
  return (sha) => {
    const cached = cache.get(sha)
    if (cached) return cached
    const info = commitInfo(repo, sha)
    cache.set(sha, info)
    return info
  }
}

function commitInfo(repo: string, sha: string): CommitInfo {
  const output = execFileSync(
    'gh',
    [
      'api',
      `repos/${repo}/commits/${sha}`,
      '--jq',
      '{parents: (.parents | length), login: .author.login, name: .commit.author.name}',
    ],
    { encoding: 'utf8' },
  )
  const { parents, login, name } = JSON.parse(output) as Record<string, unknown>
  if (typeof parents !== 'number') throw new Error(`could not read parents for ${sha}`)
  if (typeof login === 'string' && login !== '') return { parents, author: `@${login}` }
  return { parents, author: typeof name === 'string' && name !== '' ? name : undefined }
}

function replaceIfChanged(path: string, current: string, next: string): void {
  if (current !== next) writeFileSync(path, next)
}

interface CliArgs {
  repo: string
  changelogPath: string
  pullRequestBodyPath: string | undefined
  configPath: string | undefined
  dedupe: boolean
}

function parseArgs(argv: readonly string[]): CliArgs {
  let repo: string | undefined
  let changelogPath: string | undefined
  let pullRequestBodyPath: string | undefined
  let configPath: string | undefined
  let dedupe = true
  let index = 0
  while (index < argv.length) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag ?? 'argument'} needs a value`)
    if (flag === '--repo') repo = value
    else if (flag === '--changelog') changelogPath = value
    else if (flag === '--pull-request-body') pullRequestBodyPath = value
    else if (flag === '--config') configPath = value
    else if (flag === '--dedupe') dedupe = parseBoolean(flag, value)
    else throw new Error(`unknown argument ${flag ?? ''}`)
    index += 2
  }
  if (!repo || !REPO_NAME.test(repo)) throw new Error('--repo must be owner/name')
  if (!changelogPath) throw new Error('--changelog is required')
  return { repo, changelogPath, pullRequestBodyPath, configPath, dedupe }
}

function parseBoolean(flag: string, value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${flag} must be true or false`)
}

if (isDirectRun()) {
  try {
    main()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'cleaning up the release notes failed'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
