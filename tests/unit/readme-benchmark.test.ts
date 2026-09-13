import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOCK_END,
  BLOCK_START,
  type BenchmarkRecord,
  latestOf,
  renderBenchmarkBlock,
  replaceBlock,
} from '../../scripts/sync-readme-benchmark.ts'

/** A benchmark record with every field the renderer reads. */
function benchmark(overrides: Partial<BenchmarkRecord> = {}): BenchmarkRecord {
  return {
    schema: 1,
    kind: 'upstream-benchmark',
    generatedAt: '2026-09-11T03:46:24+00:00',
    producer: { commit: 'abc', dirty: true },
    upstream: { repository: 'oh-my-dsh/dsh-plugin-upgrade-skill', commit: 'ecab245c6c1831c51b0240aca13573b94a6e525e' },
    agent: { name: 'dsh', version: '0.1.2-alpha.2', model: 'deepseek-v4-flash' },
    tasks: [
      { id: 'M1-host-migration', reward: 1, exception: null, durationSeconds: 190.2, usage: null },
      { id: 'S1-static-scan', reward: 0, exception: 'AgentTimeoutError', durationSeconds: 300, usage: null },
    ],
    summary: { tasks: 2, scored: 2, mean: 0.5, exceptions: 1 },
    ...overrides,
  }
}

/** An oracle self-check record. */
function oracle(): BenchmarkRecord {
  return {
    ...benchmark(),
    kind: 'oracle-selfcheck',
    agent: { name: 'oracle', task: 'M1-host-migration' },
    tasks: [
      { id: 'upstream', reward: 1, exception: null, durationSeconds: null, usage: null },
      { id: 'dsh-home', reward: 0.4, exception: null, durationSeconds: null, usage: null },
    ],
  }
}

test('latestOf picks the newest record of a kind and ignores the others', () => {
  const older = benchmark({ generatedAt: '2026-09-01T00:00:00+00:00' })
  const newer = benchmark({ generatedAt: '2026-09-11T00:00:00+00:00' })
  assert.equal(latestOf([newer, older, oracle()], 'upstream-benchmark'), newer)
  assert.equal(latestOf([older], 'oracle-selfcheck'), undefined)
})

test('renderBenchmarkBlock renders the table, the mean, and the oracle arms', () => {
  const block = renderBenchmarkBlock([benchmark(), oracle()])
  assert.ok(block !== undefined)
  assert.ok(block.startsWith(BLOCK_START))
  assert.ok(block.endsWith(BLOCK_END))
  assert.match(block, /\| `M1-host-migration` \| \*\*1\.000\*\* \| 190s \| — \|/)
  assert.match(block, /\| `S1-static-scan` \| \*\*0\.000\*\* \| 300s \| `AgentTimeoutError` \|/)
  assert.match(block, /\| _mean of 2 scored_ \| \*\*0\.500\*\* \| \| 1 exception\(s\) \|/)
  assert.match(block, /Oracle self-check .*`upstream` 1\.000, `dsh-home` 0\.400\./)
  // The pinned upstream commit is abbreviated, and the record is linked.
  assert.match(block, /upstream `ecab245`/)
  assert.match(block, /20260911T034624\+0000\.json/)
})

test('renderBenchmarkBlock reports no block when there is no scored run', () => {
  assert.equal(renderBenchmarkBlock([oracle()]), undefined)
  assert.equal(renderBenchmarkBlock([]), undefined)
})

test('renderBenchmarkBlock tolerates a task with no score', () => {
  const block = renderBenchmarkBlock([
    benchmark({
      tasks: [{ id: 'X', reward: null, exception: 'no-reward', durationSeconds: null, usage: null }],
      summary: { tasks: 1, scored: 0, mean: null, exceptions: 1 },
    }),
  ])
  assert.ok(block !== undefined)
  assert.match(block, /\| `X` \| — \| — \| `no-reward` \|/)
  assert.match(block, /\| _mean of 0 scored_ \| — \| \| 1 exception\(s\) \|/)
})

test('replaceBlock swaps only the marked region', () => {
  const readme = `before\n${BLOCK_START}\nstale\n${BLOCK_END}\nafter\n`
  const updated = replaceBlock(readme, `${BLOCK_START}\nfresh\n${BLOCK_END}`)
  assert.equal(updated, `before\n${BLOCK_START}\nfresh\n${BLOCK_END}\nafter\n`)
})

test('replaceBlock rejects a README whose markers are missing or reversed', () => {
  assert.throws(() => replaceBlock('no markers here\n', `${BLOCK_START}\nx\n${BLOCK_END}`), /must contain/)
  assert.throws(
    () => replaceBlock(`${BLOCK_END}\nx\n${BLOCK_START}\n`, `${BLOCK_START}\ny\n${BLOCK_END}`),
    /must contain/,
  )
})
