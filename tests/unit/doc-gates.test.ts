import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  documentAnchors,
  githubSlug,
  headingsOf,
  isExternalTarget,
  linksOf,
  splitTarget,
  stripInlineMarkdown,
} from '../../scripts/md.ts'
import { parseIndexRows } from '../../scripts/verify-doc-index.ts'

test('githubSlug matches GitHub, including its punctuation removal', () => {
  assert.equal(githubSlug('Security and authority are non-goals'), 'security-and-authority-are-non-goals')
  assert.equal(githubSlug('Comparability (not done yet)'), 'comparability-not-done-yet')
  assert.equal(githubSlug('3. The gate stack'), '3-the-gate-stack')
  assert.equal(githubSlug('The record format (`schema: 1`)'), 'the-record-format-schema-1')
  // Removing the em dash leaves two spaces, which become two hyphens. That is
  // what GitHub produces, so the gate must agree with it rather than "fix" it.
  assert.equal(githubSlug('1. Oracle self-check — no Harbor'), '1-oracle-self-check--no-harbor')
})

test('documentAnchors suffixes repeated headings the way GitHub does', () => {
  const anchors = documentAnchors('# Repeat\n\n## Repeat\n\n### Repeat\n')
  assert.deepEqual([...anchors].sort(), ['repeat', 'repeat-1', 'repeat-2'])
})

test('documentAnchors collects explicit <a id> anchors and ignores commented ones', () => {
  const anchors = documentAnchors('<a id="pinned"></a>\n\n<!-- <a id="hidden"></a> -->\n')
  assert.ok(anchors.has('pinned'))
  assert.ok(!anchors.has('hidden'))
})

test('headingsOf reports levels, line numbers, and rendered text', () => {
  const headings = headingsOf('# One\n\ntext\n\n## Two `code`\n')
  assert.deepEqual(headings, [
    { level: 1, text: 'One', line: 1 },
    { level: 2, text: 'Two code', line: 5 },
  ])
})

test('headingsOf and linksOf ignore fenced code blocks', () => {
  const source = '# Real\n\n```sh\n# not a heading\nsee [x](missing.md)\n```\n\n~~~\n## also not\n~~~\n'
  assert.deepEqual(
    headingsOf(source).map(heading => heading.text),
    ['Real'],
  )
  assert.deepEqual(linksOf(source), [])
})

test('linksOf skips inline code spans and keeps line numbers', () => {
  const source = 'a [real](docs/a.md) b\n\n`[not](docs/b.md)`\n\n![img](docs/c.png)\n'
  assert.deepEqual(linksOf(source), [
    { url: 'docs/a.md', line: 1 },
    { url: 'docs/c.png', line: 5 },
  ])
})

test('linksOf also finds reference definitions', () => {
  assert.deepEqual(linksOf('[label]: docs/a.md\n'), [{ url: 'docs/a.md', line: 1 }])
})

test('stripInlineMarkdown keeps link labels and code content', () => {
  assert.equal(stripInlineMarkdown('the [`schema`](a.md) field'), 'the schema field')
  assert.equal(stripInlineMarkdown('**bold** and _em_'), 'bold and em')
})

test('splitTarget separates path from fragment and decodes escapes', () => {
  assert.deepEqual(splitTarget('docs/a.md#some-heading'), { path: 'docs/a.md', fragment: 'some-heading' })
  assert.deepEqual(splitTarget('#local'), { path: '', fragment: 'local' })
  assert.deepEqual(splitTarget('docs/a.md'), { path: 'docs/a.md', fragment: undefined })
  assert.deepEqual(splitTarget('docs/a.md?x=1#f'), { path: 'docs/a.md', fragment: 'f' })
  assert.deepEqual(splitTarget('My%20File.md'), { path: 'My File.md', fragment: undefined })
  // A malformed escape must not throw; it stays raw so the gate reports it broken.
  assert.deepEqual(splitTarget('%zz.md'), { path: '%zz.md', fragment: undefined })
})

test('isExternalTarget excludes schemes, protocol-relative hosts, and root paths', () => {
  assert.ok(isExternalTarget('https://example.com/x'))
  assert.ok(isExternalTarget('mailto:a@b.c'))
  assert.ok(isExternalTarget('//cdn.example.com/x'))
  assert.ok(isExternalTarget('/docs/index.md'))
  assert.ok(!isExternalTarget('docs/index.md'))
  assert.ok(!isExternalTarget('#local'))
})

test('parseIndexRows reads the fixed table shape and skips its header', () => {
  const rows = parseIndexRows(
    ['| Topic | Home | Entry point |', '|---|---|---|', '| A subject | `docs/a.md` | [Section](a.md#section) |', ''].join('\n'),
  )
  assert.deepEqual(rows, [{ line: 3, topic: 'A subject', home: 'docs/a.md', linkUrl: 'a.md#section' }])
})
