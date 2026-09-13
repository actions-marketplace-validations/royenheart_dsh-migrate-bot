# Open work

What this repository intends to do next, and what it has decided not to do. Each item owns no design of its own: it names the state and links the document that works it out.

## Open work

| Item | State | Owner |
|---|---|---|
| Continuous quality tracking: store one metric per benchmark run against a moving baseline and detect a regression band before it is merged | Designed, not implemented; phasing in the linked section | [Phasing](../design/continuous-quality-tracking.md#7-phasing) |
| Benchmark comparability: freeze a snapshot and task list, run each task three times and report the median with token usage | Not started; current numbers are single attempts and are explicitly not comparable | [Comparability](../upstream-benchmark.md#comparability-not-done-yet) |
| Drive the benchmark with the shipped `migrate` runner instead of the stock runner | Not verified live; the adapter supports both, and the benchmark currently selects `stock` | [Two ways to run it](../upstream-benchmark.md#two-ways-to-run-it) |
| Delivering dsh trace logs by email after a run | Deferred; no design recorded yet, so the delivery mechanism and its failure handling are still open | — |

## Non-goals

- **Making the benchmark suite a per-pull-request gate.** It costs model budget and minutes per task, and the tasks grade a whole migration rather than a diff. `npm run check:upstream` is the keyless, cheap check that runs in CI.
- **Tuning the agent for `S1-static-scan`.** Its agent budget is the task's own 300-second limit, and upstream's published validation report lists `AgentTimeoutError` there as a known outcome. Treating it as a defect would mean optimising against one task's timeout rather than the migrations this Action exists to perform.
- **Escaping the agent sandbox.** The upstream suite requires no isolation beyond a one-shot container, so there is nothing to build against ([what the suite requires](../upstream-benchmark.md#isolation-the-upstream-suite-does-not-require-it)).
- **A hand-written changelog.** [CHANGELOG.md](../../CHANGELOG.md) is generated from the commit history; a fact that needs prose belongs in a document here, not in a release entry.
