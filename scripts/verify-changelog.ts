/**
 * Gate: `CHANGELOG.md` keeps exactly one header and only generated entries.
 *
 * The changelog is written by two `cz` code paths that treat the file
 * differently: a full `cz changelog` rebuilds it from the template, while
 * `cz bump --changelog` inserts a release into the file it already has. A
 * template that emits the header unconditionally therefore satisfies the first
 * path and duplicates the header on the second — which is a defect that renders
 * fine and is easy to miss in review.
 *
 * This gate states the invariant both paths must satisfy: the file begins with
 * the expected header, that header appears once, and every release section is
 * one `cz` would generate.
 */

import { readText, REPO_ROOT } from './repo.ts'
import { resolve } from 'node:path'

/** The file this gate reads. */
export const CHANGELOG_PATH = resolve(REPO_ROOT, 'CHANGELOG.md')

/** The heading that opens the file, and must appear nowhere else. */
const HEADER = '# Changelog'

/** One defect in the changelog. */
export interface ChangelogViolation {
  line: number
  detail: string
}

/**
 * Check the changelog's structure.
 * @param source - the changelog text; defaults to the file on disk, and is a
 *   parameter so a test can exercise the shape checks without writing files.
 * @returns one entry per defect, and how many release sections it holds.
 */
export function verifyChangelog(source: string = readText(CHANGELOG_PATH)): {
  violations: ChangelogViolation[]
  releases: number
} {
  const lines = source.split('\n')
  const violations: ChangelogViolation[] = []

  const headerLines = lines.flatMap((line, index) => (line === HEADER ? [index + 1] : []))
  if (headerLines.length === 0) {
    violations.push({ line: 0, detail: `CHANGELOG.md is missing its \`${HEADER}\` heading` })
  } else if (headerLines.length > 1) {
    violations.push({
      line: headerLines[1] ?? 0,
      detail: `\`${HEADER}\` appears ${String(headerLines.length)} times (lines ${headerLines.join(', ')}); a full regeneration and a bump disagree`,
    })
  } else if (headerLines[0] !== 1) {
    violations.push({ line: headerLines[0] ?? 0, detail: `\`${HEADER}\` must be the first line` })
  }

  // A release heading is `## v<version>`, and a full regeneration emits
  // `## Unreleased` for commits after the last tag until the next bump consumes
  // it. Anything else at that level is a hand-written section, which means the
  // file is no longer fully generated.
  const stray = lines.flatMap((line, index) =>
    line.startsWith('## ') && !/^## (v\d|Unreleased)/.test(line)
      ? [{ line: index + 1, detail: `unexpected section \`${line}\`` }]
      : [],
  )
  violations.push(...stray)

  const releases = lines.filter(line => /^## v\d/.test(line)).length
  return { violations, releases }
}

if (import.meta.filename === process.argv[1]) {
  const { violations, releases } = verifyChangelog()
  if (violations.length === 0) {
    console.log(`verify-changelog: one header, ${String(releases)} generated release section(s).`)
    process.exit(0)
  }
  console.error('verify-changelog: CHANGELOG.md is not in generated shape:')
  for (const violation of violations) {
    console.error(`  ${violation.detail}`)
  }
  process.exit(1)
}
