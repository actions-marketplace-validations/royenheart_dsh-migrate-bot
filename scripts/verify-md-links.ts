/**
 * Gate: every relative link in repository Markdown resolves.
 *
 * A link is broken when its path does not exist, or when its `#fragment` does
 * not name a heading (or explicit `<a id>`) in the target document. This is what
 * makes the documentation index more than a list of names: an index entry that
 * points at a heading which has since been renamed fails here, in CI, instead of
 * sending a reader to the top of a page.
 *
 * Scheme-qualified URLs, protocol-relative hosts, and root-absolute paths are
 * out of scope. A fragment onto a non-Markdown target (`file.ts#L10`) carries
 * renderer-owned semantics and is not judged.
 *
 * Run directly, or through `run-gates.ts`.
 */

import { dirname, resolve } from 'node:path'
import { documentAnchors, isExternalTarget, linksOf, splitTarget } from './md.ts'
import { isFile, readText, rel, repoFiles, REPO_ROOT } from './repo.ts'

/** One broken link. */
export interface LinkViolation {
  file: string
  line: number
  url: string
  reason: 'target' | 'anchor'
}

/**
 * Find every broken relative link in one document.
 * @param absPath - absolute path of the Markdown source.
 * @param anchorsOf - cached anchor lookup, shared across documents.
 * @returns one entry per broken link.
 */
export function findLinkViolations(
  absPath: string,
  anchorsOf: (path: string) => Set<string>,
): LinkViolation[] {
  const source = readText(absPath)
  const violations: LinkViolation[] = []
  for (const link of linksOf(source)) {
    if (isExternalTarget(link.url)) continue
    const { path, fragment } = splitTarget(link.url)
    const target = path === '' ? absPath : resolve(dirname(absPath), path)

    if (path !== '' && !isFile(target)) {
      violations.push({ file: rel(absPath), line: link.line, url: link.url, reason: 'target' })
      continue
    }
    if (fragment === undefined) continue
    if (!target.endsWith('.md')) continue
    const anchors = target === absPath ? documentAnchors(source) : anchorsOf(target)
    if (!anchors.has(fragment)) {
      violations.push({ file: rel(absPath), line: link.line, url: link.url, reason: 'anchor' })
    }
  }
  return violations
}

/**
 * Run the gate over every repository Markdown file.
 * @returns the violations found, and how many documents were checked.
 */
export function verifyMarkdownLinks(): { violations: LinkViolation[]; checked: number } {
  const cache = new Map<string, Set<string>>()
  const anchorsOf = (path: string): Set<string> => {
    const hit = cache.get(path)
    if (hit !== undefined) return hit
    const anchors = documentAnchors(readText(path))
    cache.set(path, anchors)
    return anchors
  }

  const files = repoFiles(['.md'], REPO_ROOT)
  const violations = files.flatMap(file => findLinkViolations(file, anchorsOf))
  return { violations, checked: files.length }
}

if (import.meta.filename === process.argv[1]) {
  const { violations, checked } = verifyMarkdownLinks()
  if (violations.length === 0) {
    console.log(`verify-md-links: ${checked} file(s) checked, all relative links resolve.`)
    process.exit(0)
  }
  console.error('verify-md-links: broken links (target file missing, or anchor absent from the target):')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  ${violation.url}  [${violation.reason}]`)
  }
  process.exit(1)
}
