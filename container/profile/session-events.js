/**
 * Read a dsh session's event log across host versions.
 *
 * dsh 0.1.1 exposes the log as the `events` getter. 0.1.2-alpha.2 removed that
 * getter in favour of `snapshotEvents(fromSeq, toSeqExclusive)`, alongside
 * `ownEvents()` and `eventAt(seq)`. Reading `session.events` on the newer host
 * yields `undefined`, and iterating it throws `events is not iterable` — which
 * is exactly how the migration runner broke there.
 *
 * This module deliberately imports nothing so it can be unit-tested without a
 * dsh installation.
 */

/**
 * The event log of a session, whichever accessor the running host provides.
 * @param {object|undefined} session - the agent's session object
 * @returns {Array} the events, or an empty array when no accessor is present
 */
export function readSessionEvents(session) {
  if (session === undefined || session === null) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    const snapshot = session.snapshotEvents()
    if (Array.isArray(snapshot)) return snapshot
  }
  if (typeof session.ownEvents === 'function') {
    const own = session.ownEvents()
    if (Array.isArray(own)) return own
  }
  return []
}
