"""Harbor agent adapter that runs this project's own dsh migration profile.

Harbor drives benchmark trials by installing an agent into the task container
and running it there. This adapter makes *our* agent the one under test: it
uploads the migrate profile this Action ships in `container/profile/` into the
task container's `$DSH_HOME`, then runs the same headless command the Action
runs in production.

    harbor run -p <task> -a tools.harbor.dsh_agent:DshAgent -m deepseek-official/deepseek-v4-flash

with `PYTHONPATH` pointing at this repository (Harbor imports the class by path).

Deliberate choices, each matching what the upstream task contract expects:

* The container's default `$DSH_HOME` (`/root/.dsh`) is left alone. The tasks'
  own judge hardcodes that path, so overriding it would silently invalidate
  every runtime-graded task.
* The task's `instruction.md` is passed through verbatim as the session's task,
  with no extra routing prompt: each task's score bands depend on the traps
  written into its own statement.
* The working directory is `/app`, the layout the tasks declare.
* No `--skill` is passed, so this measures the agent without the community
  skill installed. Add one later to measure the skill's delta.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

#: Matches the version the upstream hands-on tasks install globally.
DEFAULT_DSH_VERSION = "0.1.2-alpha.2"

#: Profile id the uploaded composition mounts.
PROFILE = "migrate"

#: The stock headless runner, used when the migration runner cannot drive the
#: task container's dsh version. It runs the same preset and the same task; what
#: is lost is the runner's `dsh-migrate-status:` usage reporting.
STOCK_PROFILE = "bench"

#: `migrate` uses this Action's own runner; `stock` uses `@deepseek-ai/dsh-headless`.
#: Default is `stock`: the runner shipped in `container/profile/migrate-runner.js`
#: reads `agent.session.events` in a shape dsh 0.1.2-alpha.2 no longer produces
#: ("events is not iterable"). Run with DSH_HARBOR_RUNNER=migrate once that is fixed.
RUNNER_ENV = "DSH_HARBOR_RUNNER"

#: Working directory the upstream tasks declare for the agent.
WORKDIR = "/app"


class DshAgent(BaseAgent):
    """Runs the dsh headless migration session inside the task container."""

    SUPPORTS_WINDOWS = False

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._repo_root = Path(__file__).resolve().parents[2]
        self._version: str | None = None
        self._last_status: dict[str, object] = {}
        requested = os.environ.get(RUNNER_ENV, "stock").strip().lower()
        self._runner = "migrate" if requested == "migrate" else "stock"

    @staticmethod
    @override
    def name() -> str:
        return "dsh"

    @override
    def version(self) -> str | None:
        return self._version or DEFAULT_DSH_VERSION

    # ── setup ───────────────────────────────────────────────────────────────

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        """Install dsh + pnpm when the task image lacks them, then mount our profile."""
        probe = await environment.exec(command="command -v dsh >/dev/null 2>&1 && dsh --version")
        if probe.return_code != 0:
            # Static tasks ship no global dsh; every task declares public network.
            await self._install_dsh(environment)

        version = await environment.exec(command="dsh --version")
        if version.return_code == 0 and version.stdout:
            self._version = version.stdout.strip()

        await self._upload_profile(environment)

    async def _install_dsh(self, environment: BaseEnvironment) -> None:
        install = await environment.exec(
            command=(
                "set -e; "
                "command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@11.24.0; "
                f"npm install -g @deepseek-ai/dsh@{DEFAULT_DSH_VERSION}"
            ),
            timeout_sec=900,
        )
        if install.return_code != 0:
            raise RuntimeError(
                "dsh is not available in the task container and could not be installed: "
                f"{(install.stderr or install.stdout or '').strip()[-800:]}"
            )

    #: The `standard` preset needs this host row on dsh >= 0.1.2-alpha.2, where
    #: `@deepseek-ai/dsh-tool-subagent` exports it. On 0.1.1-rc.2 the subpath does
    #: not exist and inserting the row fails the boot, so it is added only when
    #: the installed package actually exports it.
    _SETTINGS_ROW = """- insert:
    - id: subagent-model-selection-settings
      name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"
"""

    # Resolved at run time from the container's own npm root: the dsh install
    # location differs between images (global prefix, nvm, a custom prefix).
    _HAS_SETTINGS_ROW = (
        "node -e \""
        "const {execSync}=require('child_process');const fs=require('fs');const path=require('path');"
        "let root='';try{root=execSync('npm root -g',{encoding:'utf8'}).trim()}catch(e){process.exit(2)}"
        "const pkg=path.join(root,'@deepseek-ai/dsh','node_modules','@deepseek-ai','dsh-tool-subagent','package.json');"
        "if(!fs.existsSync(pkg)) process.exit(2);"
        "const e=JSON.parse(fs.readFileSync(pkg,'utf8')).exports||{};"
        "process.exit(e['./model-selection-settings']?0:1)\""
    )

    async def _upload_profile(self, environment: BaseEnvironment) -> None:
        """Install the composition this Action ships, plus any row the host needs."""
        profile_dir = f"/root/.dsh/profiles/{PROFILE}"
        await environment.exec(command=f"mkdir -p {shlex.quote(profile_dir)}")
        for name in ("package.json", "cordis.patch.yml", "migrate-runner.js", "session-events.js"):
            await environment.upload_file(
                source_path=self._repo_root / "container" / "profile" / name,
                target_path=f"{profile_dir}/{name}",
            )

        # The stock headless runner needs its own profile: ours inserts the
        # migration runner in place of `headless-runner`.
        bench_dir = f"/root/.dsh/profiles/{STOCK_PROFILE}"
        await environment.exec(command=(
            f"mkdir -p {shlex.quote(bench_dir)} && "
            f"printf '%s' '{{\"name\":\"dsh-migrate-bench\",\"private\":true,\"type\":\"module\","
            f"\"dsh\":{{\"profile\":{{\"bundles\":[\"@deepseek-ai/dsh-base\",\"@deepseek-ai/dsh-headless\"]}}}}}}' "
            f"> {shlex.quote(bench_dir)}/package.json"
        ))

        probe = await environment.exec(command=self._HAS_SETTINGS_ROW)
        if probe.return_code == 0:
            await environment.upload_file(
                source_path=self._repo_root / "tools" / "harbor" / "settings-row.cordis.patch.yml",
                target_path=f"{profile_dir}/settings-row.cordis.patch.yml",
            )
            for target in (profile_dir, bench_dir):
                await environment.exec(command=(
                    f"touch {shlex.quote(target)}/cordis.patch.yml && "
                    f"cat {profile_dir}/settings-row.cordis.patch.yml >> {shlex.quote(target)}/cordis.patch.yml"
                ))
            self.logger.info(
                "dsh: added the subagent-model-selection-settings host row "
                "(required by the standard preset on this dsh version)"
            )
        # Home-level fallback exactly as container/setup-profile.sh writes it.
        await environment.exec(command=(
            "cat > /root/.dsh/settings.yaml <<'EOF'\n"
            "agent-default-model:\n"
            "  provider: deepseek-official\n"
            "  model: deepseek-v4-flash\n"
            "  reasoningEffort: max\n"
            "llm-deepseek:\n"
            "  thinking: enabled\n"
            "  reasoningEffort: max\n"
            "agent-presets:\n"
            "  default: standard\n"
            "EOF\n"
        ))

    # ── run ─────────────────────────────────────────────────────────────────

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run one headless migration session with the task statement verbatim."""
        api_key = self._get_env("DEEPSEEK_API_KEY", "DSH_MIGRATE_API_KEY")
        if not api_key:
            raise RuntimeError(
                "DEEPSEEK_API_KEY is required to run the dsh agent "
                "(set it in the environment running Harbor)"
            )

        env = {
            "DEEPSEEK_API_KEY": api_key,
            "DSH_MIGRATE_PROVIDER": "deepseek-official",
            "DSH_MIGRATE_MODEL": "deepseek-v4-flash",
            "DSH_MIGRATE_THINKING": "enabled",
            "DSH_MIGRATE_EFFORT": "max",
            "DSH_MIGRATE_MODE": "standard",
            "DSH_MIGRATE_TASK": instruction,
            "DSH_MIGRATE_STATUS_INTERVAL_MS": "15000",
            # The tasks foreclose a second confirmation round; the agent is
            # authorised to proceed, so it must not block on a prompt.
            "CI": "1",
        }
        for key in ("DEEPSEEK_BASE_URL", "DSH_MIGRATE_USAGE_LIMIT", "DSH_MIGRATE_USAGE_SO_FAR"):
            value = self._get_env(key)
            if value:
                env[key] = value

        profile = PROFILE if self._runner == "migrate" else STOCK_PROFILE
        command = f"cd {shlex.quote(WORKDIR)} && dsh --profile {profile} {shlex.quote(instruction)}"
        result = await environment.exec(command=command, env=env, timeout_sec=1800)

        transcript = (result.stdout or "") + "\n--- stderr ---\n" + (result.stderr or "")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "dsh-session.log").write_text(transcript, encoding="utf-8")
        (self.logs_dir / "dsh-command.txt").write_text(command + "\n", encoding="utf-8")

        # The migrate runner prints one status line per interval with the usage
        # of the run so far; the last one is the run's total.
        status = self._last_status_line(result.stderr or "")
        if status is not None:
            self._last_status = status
            context.n_input_tokens = _as_int(status.get("cacheMissTokens"))
            context.n_cache_tokens = _as_int(status.get("cacheHitTokens"))
            context.n_output_tokens = _as_int(status.get("outputTokens"))
            cost = status.get("costUsd")
            if isinstance(cost, (int, float)):
                context.cost_usd = float(cost)
            context.metadata = {
                "dsh_version": self._version,
                "runner": self._runner,
                "profile": profile,
                "agent_exit_code": result.return_code,
                "turns": status.get("turns"),
                "steps": status.get("steps"),
                "elapsed_seconds": status.get("elapsedSeconds"),
            }
        else:
            context.metadata = {
                "dsh_version": self._version,
                "runner": self._runner,
                "profile": profile,
                "agent_exit_code": result.return_code,
            }

    @staticmethod
    def _last_status_line(stderr: str) -> dict[str, object] | None:
        """Newest `dsh-migrate-status:` payload in the captured stderr."""
        prefix = "dsh-migrate-status:"
        found: dict[str, object] | None = None
        for line in stderr.splitlines():
            stripped = line.strip()
            if not stripped.startswith(prefix):
                continue
            try:
                payload = json.loads(stripped[len(prefix):].strip())
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                found = payload
        return found


def _as_int(value: object) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


def agent_import_path() -> str:
    """Convenience for `-a $(...)`-style wiring and documentation."""
    return f"{__name__}:DshAgent"


_ = os  # kept for parity with sibling adapters that read env directly
