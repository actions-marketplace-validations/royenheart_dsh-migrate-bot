import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderDocuments } from '../../src/github/templates.ts'

const base = {
  status: 'migrated' as const,
  target: { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' },
  pluginName: '@me/dsh-plugin-x',
  skippedReview: false,
  fixAttempts: 2,
  mechanical: { ok: true, errors: '', log: 'ok' },
  verdictA: '## Verdict\nshrink',
  verdictB: '## Edits\nuse official slot',
  diff: '+ key: x',
}

test('English documents have root-cause and test sections', () => {
  const docs = renderDocuments({ ...base, language: 'en' })
  assert.match(docs.title, /0\.1\.1-rc\.2/)
  assert.match(docs.issue, /## Root cause/)
  assert.match(docs.issue, /Overlap verdict: `shrink`/)
  assert.match(docs.issue, /## Mechanical test report/)
  assert.match(docs.issue, /patch-reports/)
  assert.match(docs.pr, /## Test plan/)
  assert.match(docs.pr, /## Risk/)
})

test('Chinese documents keep the same section set', () => {
  const docs = renderDocuments({ ...base, language: 'zh' })
  assert.match(docs.issue, /## 根因/)
  assert.match(docs.issue, /## 机械测试报告/)
  assert.match(docs.issue, /patch-reports/)
  assert.match(docs.pr, /## 测试计划/)
})

test('the report renders the baseline attribution and the verification layer', () => {
  const docs = renderDocuments({
    language: 'en',
    status: 'failed',
    target: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1' },
    pluginName: '@acme/plugin',
    skippedReview: false,
    fixAttempts: 2,
    mechanical: { ok: true, errors: '', log: '' },
    diff: '',
    attribution: { preExisting: true, regression: false, summary: 'baseline already broken (state): look further back' },
    verification: {
      ok: false,
      layer: 'web',
      signature: 'web: exited before serving',
      detail: 'dsh web: exited before serving',
    },
  })
  assert.match(docs.issue, /## Layered verification/)
  assert.match(docs.issue, /Baseline: baseline already broken/)
  assert.match(docs.issue, /web smoke: fail/)
  assert.match(docs.issue, /dsh web: exited before serving/)
})

test('the Chinese report names every layer in Chinese', () => {
  const docs = renderDocuments({
    language: 'zh',
    status: 'migrated',
    target: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1' },
    pluginName: '@acme/plugin',
    skippedReview: false,
    fixAttempts: 0,
    mechanical: { ok: true, errors: '', log: '' },
    diff: '',
    verification: { ok: true, layer: 'boot', signature: 'pass', detail: '' },
  })
  assert.match(docs.issue, /## 分层验证/)
  assert.match(docs.issue, /boot 探针: pass/)
})

test('a report with no verification section stays unchanged', () => {
  const docs = renderDocuments({
    language: 'en',
    status: 'compatible',
    target: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1' },
    pluginName: '@acme/plugin',
    skippedReview: true,
    fixAttempts: 0,
    mechanical: { ok: true, errors: '', log: '' },
    diff: '',
  })
  assert.doesNotMatch(docs.issue, /## Layered verification/)
})
