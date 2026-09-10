import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  compareVersions,
  listRemoteTags,
  resolveDshVersion,
} from '../../src/watch/dsh-version.ts'

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

const RELEASE_BODY = JSON.stringify([
  { tag_name: 'landlock-run-v1' },
  { tag_name: 'dsh-v0.1.1-rc.2' },
])

test('pins pass through as dsh-v tags', async () => {
  const resolved = await resolveDshVersion('0.1.0-rc.8')
  assert.equal(resolved.tag, 'dsh-v0.1.0-rc.8')
  assert.equal(resolved.version, '0.1.0-rc.8')
})

test('latest reads the first dsh-v release', async () => {
  const fetchImpl: typeof fetch = async () => new Response(RELEASE_BODY, { status: 200 })
  const resolved = await resolveDshVersion('latest', { fetchImpl })
  assert.equal(resolved.version, '0.1.1-rc.2')
})

test('latest sends Authorization when a token is available', async () => {
  let seen: Headers | undefined
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen = new Headers(init?.headers)
    return new Response(RELEASE_BODY, { status: 200 })
  }
  await resolveDshVersion('latest', { fetchImpl, token: 'ghs_test' })
  assert.equal(seen?.get('authorization'), 'Bearer ghs_test')
})

test('latest omits Authorization without a token', async () => {
  let seen: Headers | undefined
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen = new Headers(init?.headers)
    return new Response(RELEASE_BODY, { status: 200 })
  }
  await resolveDshVersion('latest', { fetchImpl })
  assert.equal(seen?.get('authorization'), null)
})

test('a rate-limited 403 falls back to git ls-remote and picks the newest tag', async () => {
  const fetchImpl: typeof fetch = async () => new Response('{"message":"API rate limit exceeded"}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
  })
  const listTags = async (): Promise<string[]> => [
    'landlock-run-v1',
    'dsh-v0.1.2-alpha.3',
    'dsh-v0.1.5-alpha.1',
    'dsh-v0.1.5-rc.1',
    'dsh-v0.1.5-alpha.2',
    'dsh-v0.1.3-alpha.2',
  ]
  const resolved = await resolveDshVersion('latest', { fetchImpl, listTags })
  assert.equal(resolved.version, '0.1.5-rc.1')
})

test('a token-backed 500 also falls back, and reports both failures when git fails too', async () => {
  const fetchImpl: typeof fetch = async () => new Response('boom', { status: 500 })
  const resolved = await resolveDshVersion('latest', {
    fetchImpl,
    listTags: async () => ['dsh-v0.1.2-rc.1'],
  })
  assert.equal(resolved.version, '0.1.2-rc.1')

  await assert.rejects(
    () => resolveDshVersion('latest', {
      fetchImpl,
      listTags: async () => { throw new Error('git ls-remote https://… failed: not found') },
    }),
    /git ls-remote/,
  )
})

test('a 404 is a hard error, not a fallback', async () => {
  let called = false
  await assert.rejects(
    () => resolveDshVersion('latest', {
      fetchImpl: async () => new Response('nope', { status: 404 }),
      listTags: async () => { called = true; return ['dsh-v0.1.2-rc.1'] },
    }),
    /HTTP 404/,
  )
  assert.equal(called, false)
})

test('a transport failure falls back instead of aborting the run', async () => {
  const resolved = await resolveDshVersion('latest', {
    fetchImpl: async () => { throw new Error('ECONNRESET') },
    listTags: async () => ['dsh-v0.1.4-alpha.1'],
  })
  assert.equal(resolved.version, '0.1.4-alpha.1')
})

test('compareVersions orders rc above alpha and releases above prereleases', () => {
  assert.equal(compareVersions('0.1.5-rc.1', '0.1.5-alpha.2'), 1)
  assert.equal(compareVersions('0.1.3-alpha.2', '0.1.5-alpha.1'), -1)
  assert.equal(compareVersions('0.1.5', '0.1.5-rc.1'), 1)
  assert.equal(compareVersions('0.1.5-alpha.2', '0.1.5-alpha.10'), -1)
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1)
  assert.equal(compareVersions('0.1.5-rc.1', '0.1.5-rc.1'), 0)
})

test('listRemoteTags parses real git output and drops peeled refs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-tags-'))
  try {
    const origin = join(dir, 'origin.git')
    const work = join(dir, 'work')
    git(dir, ['init', '--bare', '--initial-branch=main', origin])
    git(dir, ['init', '--initial-branch=main', work])
    git(work, ['config', 'user.name', 'test'])
    git(work, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(work, 'keep.txt'), 'ok\n')
    git(work, ['add', 'keep.txt'])
    git(work, ['commit', '-m', 'init'])
    git(work, ['tag', 'landlock-run-v1'])
    git(work, ['tag', '-a', 'dsh-v0.1.5-rc.1', '-m', 'release'])
    git(work, ['remote', 'add', 'origin', origin])
    git(work, ['push', 'origin', '--tags'])

    const tags = await listRemoteTags(origin)
    assert.deepEqual(tags.sort(), ['dsh-v0.1.5-rc.1', 'landlock-run-v1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
