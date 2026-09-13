#!/usr/bin/env bash
# Faithfully run one upstream benchmark task's oracle self-check.
#
# The upstream project (`oh-my-dsh/dsh-plugin-upgrade-skill`, vendored under
# `vendor/`) ships Harbor tasks whose reference solution must score exactly 1.0
# with `harbor run -p <task> -a oracle`. Harbor itself is not required to run
# that check: Harbor's execution model for these tasks is "build the task image,
# run the agent inside it, then copy `tests/` in and execute `test.sh`", and this
# script does exactly those steps with Docker.
#
# Usage:
#   scripts/run-upstream-oracle.sh [task-dir]
#
# The task directory defaults to the M1 task in the vendored submodule. Run
# `git submodule update --init vendor/dsh-plugin-upgrade-skill` first.
#
# No model API key is needed: the oracle writes the reference answer, and the
# judge is keyless by design.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBMODULE="$ROOT/vendor/dsh-plugin-upgrade-skill"
# Pinned upstream commit. Never `main`: their own rules require a frozen snapshot.
UPSTREAM_SHA="${UPSTREAM_SHA:-ecab245c6c1831c51b0240aca13573b94a6e525e}"
UPSTREAM_REPO="${UPSTREAM_REPO:-oh-my-dsh/dsh-plugin-upgrade-skill}"
TASK_ID="${TASK_ID:-M1-host-migration}"
# Opt-in npm mirror: the public registry is the default, so this script is not
# tied to any host's network. Set NPM_REGISTRY to a mirror on a slow route.
NPM_REGISTRY="${NPM_REGISTRY:-}"
REPORT_DIR="${BENCHMARK_REPORT_DIR:-$ROOT/reports/upstream}"

# Some networks cannot clone the upstream repository at all, so fall back to
# materializing just this one task from the pinned commit.
fetch_task() {
  local dest="$1"
  echo "dsh-migrate: materializing $TASK_ID at $UPSTREAM_SHA (submodule not initialized)" >&2
  local tree
  if command -v gh >/dev/null 2>&1; then
    tree="$(gh api "/repos/$UPSTREAM_REPO/git/trees/$UPSTREAM_SHA?recursive=1" 2>/dev/null)" || tree=""
  else
    tree=""
  fi
  if [[ -z "$tree" ]]; then
    tree="$(curl -sfL "https://api.github.com/repos/$UPSTREAM_REPO/git/trees/$UPSTREAM_SHA?recursive=1")" || tree=""
  fi
  if [[ -z "$tree" ]]; then
    echo "dsh-migrate: cannot list the upstream tree (need gh, or an open route to api.github.com)" >&2
    echo "  alternative: git submodule update --init vendor/dsh-plugin-upgrade-skill" >&2
    exit 2
  fi
  # The tree listing is far too large for argv; hand it over as a file.
  printf '%s' "$tree" > "$dest.tree.json"
  python3 - "$dest.tree.json" "$dest" "$TASK_ID" <<'PYEOF'
import json, os, subprocess, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    tree = json.load(handle)
dest, task = sys.argv[2], sys.argv[3]
prefix = f"benchmark/tasks/{task}/"
files = [n for n in tree["tree"] if n["type"] == "blob" and n["path"].startswith(prefix)]
for node in files:
    rel = node["path"][len("benchmark/tasks/") + len(task) + 1:]
    out = os.path.join(dest, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    url = f"https://raw.githubusercontent.com/{os.environ['UPSTREAM_REPO']}/{os.environ['UPSTREAM_SHA']}/{node['path']}"
    subprocess.run(["curl", "-sfL", url, "-o", out], check=True)
    if node["mode"] == "100755":
        os.chmod(out, 0o755)
sys.stderr.write("dsh-migrate: fetched %d files\n" % len(files))
PYEOF
}

TASK_DIR="${1:-$SUBMODULE/benchmark/tasks/$TASK_ID}"
if [[ ! -f "$TASK_DIR/task.toml" ]]; then
  TASK_DIR="$(mktemp -d)/$TASK_ID"
  export UPSTREAM_REPO UPSTREAM_SHA
  fetch_task "$TASK_DIR"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$TASK_DIR/environment/fixture" "$WORK/fixture"
cp -R "$TASK_DIR/tests" "$WORK/tests"
cp -R "$TASK_DIR/solution" "$WORK/solution"

# One deviation from the upstream Dockerfile, for speed only: the base image
# already ships git, so the apt step is unnecessary here. The npm mirror is
# applied only when the caller set NPM_REGISTRY. Neither changes what runs
# inside the container.
registry_step=""
if [[ -n "$NPM_REGISTRY" ]]; then
  registry_step="RUN npm config set registry $NPM_REGISTRY"
fi
cat > "$WORK/Dockerfile" <<EOF
FROM node:24-bookworm
$registry_step
RUN npm install -g pnpm@11.24.0 @deepseek-ai/dsh@0.1.2-alpha.2
WORKDIR /app
COPY fixture /app/fixture
RUN git init -q && git add -A \\
    && git -c user.email=bench@local -c user.name=bench commit -q -m "baseline"
EOF

# A second arm adds the one line this Action's image sets and the task does not:
# DSH_HOME. The judge hardcodes /root/.dsh/profiles, so a different DSH_HOME
# makes dsh initialize a different (empty) profile and the run is pinned to the
# 40 band instead of 100.
sed 's|^WORKDIR /app|ENV DSH_HOME=/opt/dsh-home\nWORKDIR /app|' "$WORK/Dockerfile" > "$WORK/Dockerfile.dshhome"

run_arm() {
  local name="$1" dockerfile="$2" image="dsh-migrate-oracle-$1-$$" container="dsh-mig-oracle-$1-$$"
  docker build -q -f "$dockerfile" -t "$image" "$WORK" >/dev/null
  docker run -d --name "$container" "$image" sleep 900 >/dev/null
  docker exec "$container" mkdir -p /tests /solution
  docker cp "$WORK/tests/." "$container:/tests/" >/dev/null
  docker cp "$WORK/solution/." "$container:/solution/" >/dev/null
  docker exec "$container" bash /solution/solve.sh >/dev/null 2>&1 || true
  docker exec "$container" bash /tests/test.sh >/dev/null 2>&1 || true
  local reward
  reward="$(docker exec "$container" cat /logs/verifier/reward.txt 2>/dev/null || echo missing)"
  ARM_NAMES+=("$name")
  ARM_REWARDS+=("$reward")
  printf '%-10s reward=%s\n' "$name" "$reward"
  docker exec "$container" sh -c 'tail -1 /tmp/judge.out' 2>/dev/null | head -c 400 || true
  printf '\n'
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker rmi -f "$image" >/dev/null 2>&1 || true
}

ARM_NAMES=()
ARM_REWARDS=()
echo "== upstream task: $(basename "$TASK_DIR") =="
echo "-- arm 1: the task environment as upstream declares it (expect 1) --"
run_arm upstream "$WORK/Dockerfile"
echo "-- arm 2: same, plus this Action's DSH_HOME (the regression to avoid) --"
run_arm dsh-home "$WORK/Dockerfile.dshhome"

# Same record format the Harbor runs write, so one consumer reads both.
python3 - "$REPORT_DIR" "$(basename "$TASK_DIR")" "$UPSTREAM_SHA" "${ARM_NAMES[@]}" -- "${ARM_REWARDS[@]}" <<'PYEOF'
import json, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

out_dir, task, upstream, rest = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4:]
split = rest.index("--")
names, rewards = rest[:split], rest[split + 1:]

def git(*args):
    try:
        return subprocess.run(("git", *args), capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None

tasks = []
for name, raw in zip(names, rewards):
    try:
        reward = float(raw)
    except ValueError:
        reward = None
    tasks.append({"id": name, "reward": reward, "exception": None if reward is not None else "no-reward",
                  "durationSeconds": None, "usage": None})
scored = [t["reward"] for t in tasks if t["reward"] is not None]
report = {
    "schema": 1, "kind": "oracle-selfcheck",
    "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "producer": {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain"))},
    "upstream": {"repository": "oh-my-dsh/dsh-plugin-upgrade-skill", "commit": upstream},
    "agent": {"name": "oracle", "task": task},
    "tasks": tasks,
    "summary": {"tasks": len(tasks), "scored": len(scored),
                "mean": round(sum(scored) / len(scored), 4) if scored else None,
                "exceptions": sum(1 for t in tasks if t["exception"] is not None)},
}
out_dir.mkdir(parents=True, exist_ok=True)
stamp = report["generatedAt"].replace(":", "").replace("-", "")
path = out_dir / f"{stamp}.json"
path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
sys.stderr.write(f"dsh-migrate: wrote {path}\n")
PYEOF
