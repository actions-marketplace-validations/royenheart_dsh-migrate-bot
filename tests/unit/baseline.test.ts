import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attribute, declaredDshVersion, resolveBaseline, signatureStalled } from '../../src/verify/baseline.ts'
import type { BootProbeResult } from '../../src/verify/boot.ts'

function probe(outcome: 'pass' | 'fail' | 'timeout', signature: string = outcome): BootProbeResult {
  return { outcome, signature, detail: '' }
}

function pluginWith(deps: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-peers-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', ...deps }))
  return dir
}

test('the recorded tag wins over declared peers', () => {
  const dir = pluginWith({ devDependencies: { '@deepseek-ai/dsh-base': '^0.1.0-rc.8' } })
  try {
    const baseline = resolveBaseline({ tag: 'dsh-v0.1.2-alpha.3', version: '0.1.2-alpha.3', recordedAt: '' }, dir)
    assert.deepEqual(baseline, { tag: 'dsh-v0.1.2-alpha.3', source: 'state' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a verified tag is preferred when a pending migration exists', () => {
  const dir = pluginWith({})
  try {
    const baseline = resolveBaseline({
      tag: 'dsh-v0.1.2-alpha.3',
      version: '0.1.2-alpha.3',
      recordedAt: '',
      verified: { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' },
    }, dir)
    assert.equal(baseline.tag, 'dsh-v0.1.1-rc.2')
    assert.equal(baseline.source, 'state')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with no recorded state the declared peer version becomes a pseudo-baseline', () => {
  const dir = pluginWith({
    devDependencies: { '@deepseek-ai/dsh-session': '^0.1.2-alpha.2', typescript: '^5' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.1-rc.2' },
  })
  try {
    assert.equal(declaredDshVersion(dir), '0.1.1-rc.2')
    assert.deepEqual(resolveBaseline(undefined, dir), { tag: 'dsh-v0.1.1-rc.2', source: 'declared-peers' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a prerelease sorts below its release when picking the lowest peer', () => {
  const dir = pluginWith({
    dependencies: { '@deepseek-ai/dsh-base': '0.1.2', '@deepseek-ai/dsh-llm': '0.1.2-alpha.3' },
  })
  try {
    assert.equal(declaredDshVersion(dir), '0.1.2-alpha.3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with nothing to go on the baseline is absent, not guessed', () => {
  const dir = pluginWith({ dependencies: { yaml: '^2' } })
  try {
    assert.deepEqual(resolveBaseline(undefined, dir), { source: 'none' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('baseline pass plus target fail is a regression', () => {
  const result = attribute(probe('pass'), probe('fail', 'load: x'), 'state')
  assert.equal(result.regression, true)
  assert.equal(result.preExisting, false)
  assert.match(result.summary, /corridor caused this/)
})

test('baseline fail plus target pass reports a pre-existing break that also got repaired', () => {
  const result = attribute(probe('fail', 'load: x'), probe('pass'), 'state')
  assert.equal(result.preExisting, true)
  assert.equal(result.regression, false)
  assert.match(result.summary, /pre-existing/)
})

test('baseline fail plus target fail never stops the run and widens the scope', () => {
  const same = attribute(probe('fail', 'load: x'), probe('fail', 'load: x'), 'state')
  assert.equal(same.preExisting, true)
  assert.match(same.summary, /further back than from→to/)
  const different = attribute(probe('fail', 'load: x'), probe('fail', 'load: y'), 'state')
  assert.equal(different.preExisting, true)
})

test('both passing is reported as such', () => {
  assert.match(attribute(probe('pass'), probe('pass'), 'state').summary, /both baseline and target pass/)
})

test('no baseline says the scope is unknown instead of implying health', () => {
  const result = attribute(undefined, probe('fail'), 'none')
  assert.match(result.summary, /scope unknown/)
})

test('a stalled signature is only reported when two rounds agree', () => {
  assert.equal(signatureStalled(undefined, 'load: x'), false)
  assert.equal(signatureStalled('load: x', 'load: y'), false)
  assert.equal(signatureStalled('load: x', 'load: x'), true)
  assert.equal(signatureStalled('', ''), false)
})
