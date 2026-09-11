import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appRootFrom } from '../../src/paths.ts'

const dockerfile = readFileSync(join(appRootFrom(import.meta.url), 'Dockerfile'), 'utf8')

test('the image ships a browser for the agent-authored end-to-end suite', () => {
  // Without this layer every E2E run fails at launch, and only at runtime.
  assert.match(dockerfile, /playwright install --with-deps chromium/)
  assert.match(dockerfile, /ENV PLAYWRIGHT_BROWSERS_PATH=/)
})

test('every slow or mirrored download is a build argument', () => {
  // GitHub runners reach the public mirrors; a local build in a filtered
  // network needs these to point elsewhere. Removing one strands those builds.
  for (const arg of ['DEBIAN_MIRROR', 'NPM_REGISTRY', 'PLAYWRIGHT_DOWNLOAD_HOST', 'DSH_CLI_VERSION']) {
    assert.match(dockerfile, new RegExp(`^ARG ${arg}=`, 'm'), `${arg} must stay overridable`)
  }
})

test('the browser download honours its mirror argument', () => {
  assert.match(dockerfile, /if \[ -n "\$PLAYWRIGHT_DOWNLOAD_HOST" \]; then export PLAYWRIGHT_DOWNLOAD_HOST; fi/)
})

test('the image still installs the harness CLI the probes run', () => {
  assert.match(dockerfile, /npm install -g --omit=dev "@deepseek-ai\/dsh@\$\{DSH_CLI_VERSION\}"/)
})
