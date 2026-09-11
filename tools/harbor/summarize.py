"""Turn Harbor job output into this repository's benchmark report format.

The JSON this emits is the interface a future quality-tracking framework would
consume: one stable, versioned record per benchmark invocation, holding the
subject (which commit of this Action ran), the upstream snapshot, and one entry
per task. Nothing here is specific to a machine.

    python3 tools/harbor/summarize.py --out-dir reports/upstream --kind upstream-benchmark <job-dir> ...
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = 1

UPSTREAM_REPOSITORY = "oh-my-dsh/dsh-plugin-upgrade-skill"

#: How the agent entry is described in a report.
AGENT_LABEL = "dsh"


def _git(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ("git", *args), capture_output=True, text=True, check=True
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _duration_seconds(trial: dict[str, Any]) -> float | None:
    execution = trial.get("agent_execution") or {}
    start, end = execution.get("started_at"), execution.get("finished_at")
    if not start or not end:
        return None
    try:
        begin = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        finish = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
    except ValueError:
        return None
    return round((finish - begin).total_seconds(), 1)


def _reward(trial: dict[str, Any]) -> float | None:
    rewards = (trial.get("verifier_result") or {}).get("rewards") or {}
    value = rewards.get("reward")
    return float(value) if isinstance(value, (int, float)) else None


def _exception(trial: dict[str, Any]) -> str | None:
    info = trial.get("exception_info")
    if not info:
        return None
    if isinstance(info, dict):
        return str(info.get("type") or info.get("exception_type") or "exception")
    return str(info)


def _usage(trial: dict[str, Any]) -> dict[str, Any] | None:
    result = trial.get("agent_result") or {}
    usage = {
        key: result.get(key)
        for key in ("n_input_tokens", "n_cache_tokens", "n_output_tokens", "cost_usd")
    }
    if all(value is None for value in usage.values()):
        return None
    return usage


def collect(job_dirs: list[Path], kind: str, upstream_commit: str | None) -> dict[str, Any]:
    """Build one report record from Harbor job directories."""
    tasks: list[dict[str, Any]] = []
    agent: dict[str, Any] = {"name": AGENT_LABEL}

    for job_dir in job_dirs:
        for trial_path in sorted(job_dir.glob("*/result.json")):
            trial = json.loads(trial_path.read_text(encoding="utf-8"))
            info = trial.get("agent_info") or {}
            if info:
                agent.setdefault("version", info.get("version"))
                model = info.get("model_info") or {}
                if model.get("name"):
                    agent.setdefault("model", model.get("name"))
            metadata = ((trial.get("agent_result") or {}).get("metadata")) or {}
            for key in ("runner", "profile"):
                if metadata.get(key) is not None:
                    agent.setdefault(key, metadata[key])

            tasks.append({
                "id": trial_path.parent.name.rsplit("__", 1)[0],
                "reward": _reward(trial),
                "exception": _exception(trial),
                "durationSeconds": _duration_seconds(trial),
                "usage": _usage(trial),
            })

    scored = [task["reward"] for task in tasks if task["reward"] is not None]
    return {
        "schema": SCHEMA,
        "kind": kind,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "producer": {
            "commit": _git("rev-parse", "HEAD"),
            "dirty": bool(_git("status", "--porcelain")),
        },
        "upstream": {"repository": UPSTREAM_REPOSITORY, "commit": upstream_commit},
        "agent": agent,
        "tasks": tasks,
        "summary": {
            "tasks": len(tasks),
            "scored": len(scored),
            "mean": round(sum(scored) / len(scored), 4) if scored else None,
            "exceptions": sum(1 for task in tasks if task["exception"] is not None),
        },
    }


def render_markdown(report: dict[str, Any]) -> str:
    """Human-readable companion to the JSON record."""
    agent = report["agent"]
    lines = [
        f"# Benchmark report: {report['kind']}",
        "",
        f"- generated: {report['generatedAt']}",
        f"- producer commit: `{report['producer']['commit']}`"
        f"{' (dirty tree)' if report['producer']['dirty'] else ''}",
        f"- upstream: {report['upstream']['repository']} @ `{report['upstream']['commit']}`",
        f"- agent: {agent.get('name')} {agent.get('version') or ''}"
        f" runner={agent.get('runner')} model={agent.get('model')}".rstrip(),
        "",
        "| task | reward | duration | exception |",
        "|---|---|---|---|",
    ]
    for task in report["tasks"]:
        reward = "-" if task["reward"] is None else f"{task['reward']:.3f}"
        duration = "-" if task["durationSeconds"] is None else f"{task['durationSeconds']:.0f}s"
        lines.append(
            f"| `{task['id']}` | {reward} | {duration} | {task['exception'] or '-'} |"
        )
    summary = report["summary"]
    lines += [
        "",
        f"**Summary**: {summary['scored']}/{summary['tasks']} scored, "
        f"mean {summary['mean']}, {summary['exceptions']} exception(s)",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_dirs", nargs="*", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--kind", default="upstream-benchmark")
    parser.add_argument("--upstream-commit", default=None)
    args = parser.parse_args(argv)

    jobs = [path for path in args.job_dirs if path.is_dir()]
    if not jobs:
        print("dsh-migrate: no job directories given", file=sys.stderr)
        return 2

    report = collect(jobs, args.kind, args.upstream_commit)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    stamp = report["generatedAt"].replace(":", "").replace("-", "")
    json_path = args.out_dir / f"{stamp}.json"
    md_path = args.out_dir / f"{stamp}.md"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"dsh-migrate: wrote {json_path} and {md_path}", file=sys.stderr)
    print(render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
