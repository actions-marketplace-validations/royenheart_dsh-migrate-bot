import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeBlocker, parseBlocker } from '../../src/verify/blocker.ts'

const FULL = `## 1. Errors you addressed

None.

BLOCKER: upstream
REASON: the harness no longer exposes a slot the plugin needs.
ATTEMPTED: renamed the registration; tried the settings namespace; both still fail at boot.
HARNESS: packages/client/ui-slots/src/index.ts:120
WHY-NOT-PLUGIN: the slot is resolved by the host before any plugin runs, so no plugin-side registration can create it.
`

test('a declaration with all three evidence fields is valid', () => {
  const blocker = parseBlocker(FULL)
  assert.equal(blocker.declared, true)
  assert.equal(blocker.valid, true)
  assert.deepEqual(blocker.missing, [])
  assert.match(blocker.reason ?? '', /no longer exposes a slot/)
  assert.match(describeBlocker(blocker), /with evidence/)
})

test('an ordinary report declares nothing', () => {
  const blocker = parseBlocker('## 1. Errors you addressed\n\nfixed the import.\n')
  assert.equal(blocker.declared, false)
  assert.equal(describeBlocker(blocker), '')
})

test('a declaration missing evidence is discarded so the loop keeps going', () => {
  const blocker = parseBlocker(`BLOCKER: upstream
REASON: too hard.
`)
  assert.equal(blocker.declared, true)
  assert.equal(blocker.valid, false)
  assert.deepEqual(blocker.missing, ['ATTEMPTED', 'HARNESS', 'WHY-NOT-PLUGIN'])
  assert.match(describeBlocker(blocker), /continuing the loop/)
})

test('two of three evidence fields still counts as incomplete', () => {
  const blocker = parseBlocker(`BLOCKER: upstream
REASON: r
ATTEMPTED: tried a rename.
HARNESS: packages/x/src/index.ts:9
`)
  assert.equal(blocker.valid, false)
  assert.deepEqual(blocker.missing, ['WHY-NOT-PLUGIN'])
})

test('the declaration must say upstream', () => {
  assert.equal(parseBlocker('BLOCKER: plugin\nREASON: r').declared, false)
})

test('a missing report is not a declaration', () => {
  assert.deepEqual(parseBlocker(undefined), { declared: false, valid: false, missing: [] })
})
