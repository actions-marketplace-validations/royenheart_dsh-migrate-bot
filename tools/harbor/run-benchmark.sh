#!/usr/bin/env bash
# Prepare and run upstream benchmark tasks through Harbor with this project's agent.
#
#   tools/harbor/run-benchmark.sh <task-id> [<task-id> ...]
#
# The tasks are copied before preparation, so the vendored submodule stays
# pristine. A task's Dockerfile is used verbatim except for two declared,
# opt-out-able deviations:
#
#   1. The agent's harness (dsh + pnpm) is installed at build time when the task
#      does not already ship it. The tasks made for a dsh-based agent ship it
#      themselves; a task designed for a plain coding agent would otherwise
#      spend its whole budget installing tooling instead of solving the task.
#   2. When NPM_REGISTRY is set, build-time `npm install -g` gets `--registry`.
#      Opt-in, and only about which host the bytes come from.
#
# The fixture, the judge and the baseline commit are never touched.
#
# The image is built here and handed to Harbor as a prebuilt image, because
# Harbor's own build path has no way to pass a registry mirror through and would
# rebuild the same base layers once per task.
#
# Optional environment:
#   NPM_REGISTRY              npm registry mirror for the build-time install
#   DSH_BENCH_VERSION         harness version baked into tasks that lack one
#                             (default: the version the tasks themselves pin)
#
# See docs/upstream-benchmark.md for what the deviations do and do not change.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASKS_DIR="$ROOT/vendor/dsh-plugin-upgrade-skill/benchmark/tasks"
WORK_ROOT="${HARBOR_TASK_WORK:-/tmp/harbor-tasks}"
HARBOR="${HARBOR_BIN:-$ROOT/.harbor-venv/bin/harbor}"
AGENT="${HARBOR_AGENT:-tools.harbor.dsh_agent:DshAgent}"
MODEL="${HARBOR_MODEL:-deepseek-official/deepseek-v4-flash}"
NPM_REGISTRY="${NPM_REGISTRY:-}"
DSH_BENCH_VERSION="${DSH_BENCH_VERSION:-0.1.2-alpha.2}"
REPORT_DIR="${BENCHMARK_REPORT_DIR:-$ROOT/reports/upstream}"

# The public registry is the default, so the script is not tied to any host's
# mirror; a caller on a slow route sets NPM_REGISTRY.
registry_flag=""
if [[ -n "$NPM_REGISTRY" ]]; then
  registry_flag="--registry=$NPM_REGISTRY "
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <task-id> [<task-id> ...]" >&2
  exit 2
fi

mkdir -p "$WORK_ROOT"

prepare() {
  local task_id="$1" src="$TASKS_DIR/$1" dest="$WORK_ROOT/$1"
  [[ -d "$src" ]] || { echo "no such task: $task_id" >&2; return 1; }
  rm -rf "$dest"
  cp -R "$src" "$dest"

  local dockerfile="$dest/environment/Dockerfile"
  [[ -f "$dockerfile" ]] || { echo "$dest"; return 0; }

  # Deviation 2: point every build-time global install at the mirror. The copy
  # is rewritten, never the submodule.
  if [[ -n "$NPM_REGISTRY" ]]; then
    sed -i -E "s#(npm install -g )#\1${registry_flag}#g" "$dockerfile"
  fi

  # Deviation 1: only for tasks that ship no harness of their own.
  if ! grep -q "@deepseek-ai/dsh@" "$dockerfile"; then
    cat >> "$dockerfile" <<EOF

# DECLARED DEVIATION (not part of the task): this task does not ship a harness,
# and the agent being benchmarked needs one. Installed here so the task's own
# timeout is spent on the task, not on tooling. The fixture, judge and baseline
# commit are unchanged. See tools/harbor/run-benchmark.sh.
RUN npm install -g ${registry_flag}pnpm@11.24.0 @deepseek-ai/dsh@$DSH_BENCH_VERSION
EOF
  fi
  echo "$dest"
}

# Snapshot the job directories before running, so the record below can cover
# exactly the runs this invocation produced. Comparing mtimes instead is unsafe:
# prepare() rewrites the work root for every task, so only the last task would
# look new and the earlier results would vanish from the record with no error.
jobs_before="$(mktemp)"
jobs_after="$(mktemp)"
trap 'rm -f "$jobs_before" "$jobs_after"' EXIT
if [[ -d "$ROOT/jobs" ]]; then
  find "$ROOT/jobs" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort > "$jobs_before"
fi

for task_id in "$@"; do
  echo "== $task_id =="
  dest="$(prepare "$task_id")"
  image="dsh-migrate-bench-$(echo "$task_id" | tr 'A-Z' 'a-z'):latest"

  dockerfile="$dest/environment/Dockerfile"
  if [[ -f "$dockerfile" ]]; then
    echo "-- building $image --"
    docker build --network host -t "$image" "$dest/environment" >/dev/null
  else
    echo "no Dockerfile; relying on the task's declared docker_image" >&2
  fi

  python3 - "$dest/task.toml" "$image" <<'PY'
import sys
path, image = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
if "docker_image" not in text:
    text = text.replace(
        "[environment]\n",
        "[environment]\n# DECLARED DEVIATION: prebuilt outside Harbor so build\n"
        "# arguments can be passed (see tools/harbor/run-benchmark.sh).\n"
        f'docker_image = "{image}"\n', 1)
open(path, "w", encoding="utf-8").write(text)
PY

  echo "-- running --"
  PYTHONPATH="$ROOT" "$HARBOR" run -p "$dest" -a "$AGENT" -m "$MODEL" 2>&1 | tail -16
done

# One versioned record per invocation, in the format a tracking framework reads.
if [[ -d "$ROOT/jobs" ]]; then
  find "$ROOT/jobs" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort > "$jobs_after"
  mapfile -t NEW_JOBS < <(comm -13 "$jobs_before" "$jobs_after")

  # A run that produced no job directory is a failure worth surfacing, rather
  # than an empty record that reads like success.
  if [[ ${#NEW_JOBS[@]} -lt $# ]]; then
    echo "dsh-migrate: $# task(s) requested but ${#NEW_JOBS[@]} new job record(s) appeared" >&2
  fi
  if [[ ${#NEW_JOBS[@]} -gt 0 ]]; then
    UPSTREAM_COMMIT="$(git -C "$ROOT/vendor/dsh-plugin-upgrade-skill" rev-parse HEAD 2>/dev/null || true)"
    python3 "$ROOT/tools/harbor/summarize.py" --out-dir "$REPORT_DIR" \
      --upstream-commit "${UPSTREAM_COMMIT:-unknown}" "${NEW_JOBS[@]}" || true
  fi
fi
