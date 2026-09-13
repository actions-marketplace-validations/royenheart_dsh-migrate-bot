# Test and benchmark reports

Committed records of what the test suites and the upstream benchmark actually produced. They exist so a change to this Action can be compared against what came before it, rather than judged from memory.

## Layout

```
reports/upstream/<timestamp>.json   machine-readable record
reports/upstream/<timestamp>.md     the same record, rendered for reading
```

Both are written together by `tools/harbor/summarize.py`, which every benchmark entry point calls: `tools/harbor/run-benchmark.sh` for Harbor runs, `scripts/run-upstream-oracle.sh` for the oracle self-check.

## The record format (`schema: 1`)

```jsonc
{
  "schema": 1,
  "kind": "upstream-benchmark",      // or "oracle-selfcheck"
  "generatedAt": "2026-09-11T02:17:06+00:00",
  "producer": {                      // what produced this, i.e. this Action
    "commit": "9b43e3ae819317639032f76cdcf60ee87c6888b3",
    "dirty": true                    // true when the tree had uncommitted changes
  },
  "upstream": {                      // the frozen evaluation snapshot
    "repository": "oh-my-dsh/dsh-plugin-upgrade-skill",
    "commit": "ecab245c6c1831c51b0240aca13573b94a6e525e"
  },
  "agent": {                         // the subject under test
    "name": "dsh",
    "version": "0.1.2-alpha.2",
    "runner": "stock",
    "model": "deepseek-v4-flash"
  },
  "tasks": [
    {
      "id": "M1-host-migration",
      "reward": 1.0,                 // null when the trial produced no reward
      "exception": null,             // e.g. "AgentTimeoutError"
      "durationSeconds": 305.0,
      "usage": null                  // token counts, once the runner reports them
    }
  ],
  "summary": { "tasks": 3, "scored": 3, "mean": 0.6667, "exceptions": 1 }
}
```

### Rules that make the record comparable over time

- **`producer.commit` is mandatory context.** A record without it cannot be
  attributed to a revision, and a `dirty: true` record describes a tree that
  never existed as a commit.
- **`upstream.commit` is the frozen snapshot, never a branch name.** The upstream
  project states the same requirement for its own benchmark
  (`benchmark/snapshots/README.md`), because the task set is a living benchmark
  that has already moved through 18 / 19 / 22 / 23-task states.
- **A missing reward is `null`, never `0`.** Upstream's own reporting treats an
  unscored trial as an anomaly rather than a zero, and so does this format: only
  entries with a non-null `reward` contribute to `summary.mean`.
- **Exceptions are recorded, not swallowed.** A trial that raises is evidence
  about the harness or the budget, not a quiet zero.

## How these records are consumed

`docs/design/continuous-quality-tracking.md` designs the framework that turns a sequence of these records into a trend, compares a revision against the one before it, and fails a workflow when migration quality drops. The format above is its input contract, and both benchmark entry points already write it.

Two consumers read these records today. `scripts/sync-readme-benchmark.ts` renders the benchmark table in [README.md](../README.md#upstream-benchmark) from the newest record of each kind, and `npm run gates` fails when that table is stale, so a run that is not reflected in the README breaks the build rather than drifting. `npm run bench:upstream` writes the records themselves.

## What is not here yet

- **Three runs per task, reporting the median.** Upstream's protocol recommends
  this; current records are single attempts, so a delta between two records can
  be noise.
- **Token counts.** The stock headless runner emits no usage; the migration
  runner does, and the `usage` field above is where it will land.
- **A frozen task list.** The record names the upstream commit but not which
  tasks were selected; a comparison between records with different task sets has
  to check that manually.
