# Scoring this Action against the community benchmark

One directory below `vendor/` holds the community migration exam suite,
[`oh-my-dsh/dsh-plugin-upgrade-skill`](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill),
as a git submodule pinned to a single commit. Harbor runs the tasks; `tools/harbor/`
makes **this project's own agent** the one being scored.

## Why a vendor directory

`vendor/` is a collection point, not a binding to this one repository. The
submodule pins a **commit**, never `main`, because the upstream project's own
comparability rules require a frozen evaluation snapshot
(`benchmark/snapshots/README.md`).

Pinned: `ecab245c6c1831c51b0240aca13573b94a6e525e`

```sh
git submodule update --init vendor/dsh-plugin-upgrade-skill
```

It is **not** part of the production image (`.dockerignore` excludes `vendor`):
those tasks run in one-shot containers Harbor starts, so only a development
machine or a Docker-capable CI job needs it.

## Two ways to run it

### 1. Oracle self-check — no Harbor, no API key

Every upstream task ships a reference answer, and `harbor run -p <task> -a oracle`
must score exactly `1.0`; that is the grading system's own self-check.

```sh
npm run check:upstream                 # the M1 task, two arms
./scripts/run-upstream-oracle.sh <task-dir>
```

Harbor's execution model for these tasks is "build the task image, run the agent
inside it, copy `tests/` in and run `test.sh`", so this script replicates those
three steps with Docker and needs no Harbor at all. If the submodule is not
initialized it materializes the single task from the pinned commit instead.

### 2. Harbor scoring this project's agent

```sh
# once: the upstream project pins this Harbor version
python3 -m venv .harbor-venv && .harbor-venv/bin/pip install harbor==0.22.0

DEEPSEEK_API_KEY=... ./tools/harbor/run-benchmark.sh M1-host-migration H1-plane-trap
```

`tools/harbor/dsh_agent.py` is a Harbor agent adapter. `setup()` uploads the
migrate profile this repository ships in `container/profile/` into the task
container; `run()` executes the same headless command production uses, with the
task's `instruction.md` **verbatim** and no routing prompt, working directory
`/app`, and **without overriding `$DSH_HOME`** — the upstream judge hardcodes
`/root/.dsh/profiles`, and overriding it silently invalidates every
runtime-graded task (measured: adding that one line takes a task from `1.0` to
`0.4`).

Runner selection (`DSH_HARBOR_RUNNER`):

| Mode | Behaviour |
|---|---|
| `stock` (default) | the upstream `@deepseek-ai/dsh-headless` runner drives the same preset and task. Default because the migration runner could not yet drive the dsh version these tasks pin (see below) |
| `migrate` | `container/profile/migrate-runner.js`, identical to production |

## Preparations

Applied to a **copy** of each task, so the vendored submodule stays pristine, and
annotated in the generated Dockerfile.

1. **Harness in the image.** Tasks designed for a plain coding agent ship no
   global dsh; the prep bakes one in, because a dsh-based agent would otherwise
   spend the whole of such a task's 300-second agent budget installing it. The
   tasks that already ship dsh (`M1`, `H1`) are left alone. The fixture, the
   judge and the baseline commit are untouched.
2. **Registry mirror (opt-in).** With `NPM_REGISTRY` set, build-time
   `npm install -g` lines get `--registry`. The public registry is the default,
   so neither script is tied to one host's mirror.
3. **Prebuilt image.** Harbor builds on the docker bridge and has no way to pass
   a registry mirror through. The task image is therefore built here and handed
   to Harbor through `[environment] docker_image`, which Harbor supports natively
   and which skips its own build.

An earlier version of this script also rewrote each task's `apt-get` step to
tolerate incomplete installs. That workaround was **wrong**: the failures it
papered over were symptoms of the build host's root filesystem being full
(0 bytes free), which also made apt report bogus "invalid signature" errors.
With free space, every task's stock `apt-get update && apt-get install -y
--no-install-recommends git` succeeds unchanged, so the workaround and its
script were removed. The production `Dockerfile` keeps apt's documented
`Acquire::Retries` / timeout knobs, which are a legitimate safeguard against a
slow mirror and not a verification bypass.

Note for anyone re-running this on a full disk: `apt` misreports a full
filesystem as a signature-verification failure, so check `df -h /` before
suspecting the archive keys.

## Measured results

| Task | Type | reward | Duration | Notes |
|---|---|---|---|---|
| `M1-host-migration` | M (mutable) | **1.000** | 3m10s | no exception; the agent also wrote its self-check logs to `/app/agent-output/` as the task contract asks |
| `H1-plane-trap` | H (trap) | **1.000** | 5m30s | no exception |
| `S1-static-scan` | S (read-only) | 0.000 | 5m00s | `AgentTimeoutError` against that task's `[agent] timeout_sec = 300` |
| `oracle` (control) | — | **1.000** | 20s | needs no API key; arm 2 repeated with this Action's `DSH_HOME` scores 0.400, which is the regression that check exists to catch |

The two mutable/trap rewards reproduced `1.000` across runs, including after the
apt workaround above was removed, which is the point of the second run: the
generic build path scores the same as the patched one.

The S1 timeout is not an implementation defect: upstream's own published
validation report lists `AgentTimeoutError` as a known outcome (12 with the skill,
including `S1×2`; 9 without). Our agent finishes its analysis before writing the
report, which is a tight fit for a 300-second static task.

## Three real defects this exercise exposed in our own code

### 1. The migrate profile is brittle across dsh versions

On dsh **0.1.2-alpha.2** (the version these tasks pin) the `standard` preset fails
to mount:

```
tool-subagent: `modelSelectionSettings` requires
@deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope
```

That host row is normally contributed by the **web-app bundle**; our composition
is base + headless, which is what a headless agent should be. Adding the row
(`tools/harbor/settings-row.cordis.patch.yml`) makes the preset mount — but the
subpath does not exist on **0.1.1-rc.2**, the CLI version our image pins, where
inserting it fails the boot outright:

```
Package subpath './model-selection-settings' is not defined by "exports"
```

So the adapter probes before appending. The wider point: our profile has only ever
been validated against the one CLI version the image pins, and pointing the agent
at someone else's harness is what surfaced that.

### 2. `migrate-runner.js` was incompatible with dsh 0.1.2-alpha.2

With the mount fixed, the runner failed with:

```
dsh-migrate: events is not iterable
```

It read `agent.session.events`. dsh 0.1.1 exposes that getter; 0.1.2-alpha.2
removed it in favour of `snapshotEvents(fromSeq, toSeqExclusive)`, alongside
`ownEvents()` and `eventAt(seq)` — verified against the installed build. Reading
`session.events` there yields `undefined` and iterating it throws.

Fixed in `container/profile/session-events.js`, a dependency-free helper the
runner now uses; it supports all three accessors and returns an empty log rather
than throwing when a host exposes none. Unit-tested in
`tests/unit/session-events.test.ts` against every version's shape.

**This is why the answer to "do we need our own runner?" is "yes, but one
version-adaptive runner, not one per version":** the incompatibility was a single
renamed accessor, not a different architecture.

### 3. The benchmark record silently dropped tasks

`run-benchmark.sh` decided which Harbor job directories belonged to the current
invocation with `find jobs -newer "$WORK_ROOT"`. `prepare()` rewrites the work
root once per task, so after the last task every earlier job directory was older
than the reference point. A three-task run therefore produced a record holding
one task and reported no error — a summary that understated its own coverage.

Fixed by snapshotting the job directories before the loop and taking a `comm`
set difference afterwards, plus a warning when fewer records appear than tasks
were requested. Regenerating the record for the run above yields all three tasks
(`mean 0.6667`, one exception) instead of one (`mean 0.0000`).

## Isolation: the upstream suite does not require it

An exhaustive search of the upstream repository (`isolat`, `sandbox`, `escape`,
`cap-drop`, `security-opt`, `seccomp`, `chroot`, `privileg`, `jailbreak`,
`docker.sock`) returns **no rule, document or code** requiring that an agent
cannot escape a sandbox. None of the 56 tasks sets `[agent] user` (root is the
expectation); there are no read-only mounts and no resource-limit requirements.
Their only statement on isolation delegates it to the container:

> security is guaranteed jointly by the one-shot container, the scope
> constraints, and the verifier.

"May not modify the fixture, the judge or the reference solution" is enforced by
prose, by a git baseline commit made at image build time, and by `tests/` being
uploaded only during `verify()` — after the agent has finished. Their own helper
script states the same thing in the opposite direction: *"this is NOT a sandbox …
Run it inside a throwaway Docker container"*, which is precisely this Action's
architecture.

## Comparability (not done yet)

A comparable score also requires their protocol: a frozen snapshot (the 40-character
commit and an explicit task list from `benchmark/snapshots/`), three runs per task
taking the median, and reported token counts and durations. These runs are single
attempts and the stock runner emits no usage lines, so the numbers above are
**internal reference only** and must not be compared against upstream's published
results.
