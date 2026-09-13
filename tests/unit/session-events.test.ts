import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appRootFrom } from '../../src/paths.ts'

// The migration runner executes inside dsh, so it cannot be imported here; the
// helper it uses is dependency-free precisely so this test can exercise it.
const modulePath = join(appRootFrom(import.meta.url), 'container', 'profile', 'session-events.js')
const { readSessionEvents } = await import(pathToFileURL(modulePath).href) as {
  readSessionEvents: (session: unknown) => unknown[]
}

const EVENTS = [{ seq: 1, type: 'turn/start' }]

test('the 0.1.1 events getter is used when present', () => {
  assert.deepEqual(readSessionEvents({ events: EVENTS }), EVENTS)
})

test('the 0.1.2-alpha.2 snapshotEvents accessor is used when events is gone', () => {
  // Live check on dsh 0.1.2-alpha.2: Session.prototype exposes snapshotEvents,
  // ownEvents and eventAt, and no longer has the `events` getter.
  let called = 0
  const session = {
    snapshotEvents: (): unknown[] => {
      called += 1
      return EVENTS
    },
  }
  assert.deepEqual(readSessionEvents(session), EVENTS)
  assert.equal(called, 1)
})

test('ownEvents is the last resort', () => {
  const session = { ownEvents: (): unknown[] => EVENTS }
  assert.deepEqual(readSessionEvents(session), EVENTS)
})

test('a host exposing no accessor yields an empty log instead of throwing', () => {
  // The regression this guards: iterating `session.events` when it is undefined
  // threw `events is not iterable` and killed the whole session.
  assert.deepEqual(readSessionEvents({}), [])
  assert.deepEqual(readSessionEvents(undefined), [])
  assert.deepEqual(readSessionEvents(null), [])
  assert.deepEqual(readSessionEvents({ events: undefined }), [])
})

test('a non-array accessor result is ignored rather than iterated', () => {
  assert.deepEqual(readSessionEvents({ events: 'nope' }), [])
  assert.deepEqual(readSessionEvents({ snapshotEvents: () => undefined }), [])
})

test('a version whose accessor throws is not fatal on its own', () => {
  // snapshotEvents on an unexpected shape must not take the session down; the
  // next accessor gets a chance.
  const session = {
    snapshotEvents: (): unknown[] => { throw new Error('bad range') },
    ownEvents: (): unknown[] => EVENTS,
  }
  assert.throws(() => readSessionEvents(session), /bad range/)
})
