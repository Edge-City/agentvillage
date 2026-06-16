#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from common import context_path, default_state, state_path, vault_root, write_json
from secret_redaction import scan_files


ENZYME_BLOCK_BEGIN = "# BEGIN agentvillage-memory-workspace"
ENZYME_BLOCK_END = "# END agentvillage-memory-workspace"
DEFAULT_CRON_NAME = "Hermes agent memory heartbeat"
DEFAULT_CRON_SCHEDULE = "0 2 * * *"
DEFAULT_CRON_SCRIPT_NAME = "agentvillage-memory-workspace-cron_prepare.py"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_OPENROUTER_MODEL = "google/gemini-3-flash-preview"
OFFICIAL_ENZYME_INSTALL = "curl -fsSL https://enzyme.garden/install.sh | bash"
ENZYME_ENV_KEYS = [
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "OPENROUTER_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
]


def enzyme_example(vault: Path) -> str:
    return f'''# Prefer forum/ and irl/ for user-facing memory retrieval.
# hermes/sessions is transcript provenance; rendered validation/debug sessions
# include session_kind/retrieval_weight frontmatter and should be ignored or
# down-ranked unless explicitly auditing the workspace.
[vaults."{vault}"]
entities = [
  {{ "folder:hermes/sessions" = {{ profile = "resonance_trace" }} }},
  {{ "folder:forum" = {{ profile = "resonance_trace" }} }},
  {{ "folder:irl" = {{ profile = "relational" }} }},
  {{ "folder:irl/people" = {{ profile = "relational" }} }},
  {{ "folder:irl/events" = {{ profile = "relational" }} }}
]
excluded_folders = [".enzyme", ".git", ".obsidian", "templates"]
'''


def managed_enzyme_block(vault: Path) -> str:
    return f"{ENZYME_BLOCK_BEGIN}\n{enzyme_example(vault).rstrip()}\n{ENZYME_BLOCK_END}\n"


def remove_unmanaged_target_vault_table(config: str, vault: Path) -> str:
    target_header = f'[vaults."{vault}"]'
    table_header = re.compile(r"^\s*\[[^\]]+\]\s*(?:#.*)?$")
    lines = config.splitlines()
    kept: list[str] = []
    skipping = False
    for line in lines:
        if skipping:
            if table_header.match(line):
                skipping = False
            else:
                continue
        if not skipping and line.strip() == target_header:
            skipping = True
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def install_enzyme_config(vault: Path, config_path: Path) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    existing = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    block = managed_enzyme_block(vault)
    if ENZYME_BLOCK_BEGIN in existing and ENZYME_BLOCK_END in existing:
        before, rest = existing.split(ENZYME_BLOCK_BEGIN, 1)
        _, after = rest.split(ENZYME_BLOCK_END, 1)
        before = remove_unmanaged_target_vault_table(before, vault)
        after = remove_unmanaged_target_vault_table(after, vault)
        updated = before.rstrip() + "\n\n" + block + after.lstrip()
    else:
        existing = remove_unmanaged_target_vault_table(existing, vault)
        updated = existing.rstrip() + ("\n\n" if existing.strip() else "") + block
    config_path.write_text(updated.rstrip() + "\n", encoding="utf-8")


def dotenv_files(root: Path) -> list[Path]:
    candidates = [root / ".env"]
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        candidates.append(Path(hermes_home).expanduser() / ".env")
    candidates.append(Path.home() / ".hermes" / ".env")
    unique: list[Path] = []
    seen = set()
    for candidate in candidates:
        resolved = candidate.expanduser()
        key = str(resolved)
        if key not in seen:
            unique.append(resolved)
            seen.add(key)
    return unique


def parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in ENZYME_ENV_KEYS:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def resolve_env_value(root: Path, key: str) -> tuple[str | None, str | None]:
    if os.environ.get(key):
        return os.environ[key], "process"
    for path in dotenv_files(root):
        values = parse_dotenv(path)
        if values.get(key):
            return values[key], f"dotenv:{path}"
    return None, None


def select_provider(root: Path, provider: str) -> str:
    if provider in {"openrouter", "openai"}:
        return provider
    openrouter_key, _ = resolve_env_value(root, "OPENROUTER_API_KEY")
    openai_key, _ = resolve_env_value(root, "OPENAI_API_KEY")
    if openrouter_key:
        return "openrouter"
    if openai_key:
        return "openai"
    return "openrouter"


def provider_presence(root: Path) -> dict:
    vars_report = {}
    for key in ENZYME_ENV_KEYS:
        _, source = resolve_env_value(root, key)
        vars_report[key] = {
            "present": bool(source),
            "source": "process" if source == "process" else "dotenv" if source else None,
        }
    selected = select_provider(root, "auto")
    warnings = []
    if vars_report["OPENROUTER_API_KEY"]["present"] and vars_report["OPENAI_API_KEY"]["present"]:
        warnings.append("both OPENROUTER_API_KEY and OPENAI_API_KEY are present; auto selects OPENROUTER for AgentVillage hosted defaults")
    return {"selectedProvider": selected, "vars": vars_report, "warnings": warnings}


def write_enzyme_env(root: Path, provider: str) -> Path:
    env_path = root / "memory" / "enzyme-env.sh"
    env_path.parent.mkdir(parents=True, exist_ok=True)
    selected = select_provider(root, provider)
    lines = [
        "# Source this before running Enzyme manually for the Hermes memory vault.",
        "# This file stores variable references only; it does not store API secrets.",
        f'export PATH="{root}/.local/bin:${{HERMES_HOME:-{root}}}/.local/bin:$HOME/.local/bin:/opt/data/.local/bin:$PATH"',
    ]
    if selected == "openai":
        lines.append('export OPENAI_API_KEY="${OPENAI_API_KEY:?OPENAI_API_KEY must be set before running Enzyme}"')
        lines.append('export OPENAI_BASE_URL="${OPENAI_BASE_URL:-}"')
        lines.append('export OPENAI_MODEL="${OPENAI_MODEL:-}"')
    else:
        lines.append('export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set before running Enzyme}"')
        lines.append(f'export OPENROUTER_BASE_URL="${{OPENROUTER_BASE_URL:-{DEFAULT_OPENROUTER_BASE_URL}}}"')
        lines.append(f'export OPENROUTER_MODEL="${{OPENROUTER_MODEL:-{DEFAULT_OPENROUTER_MODEL}}}"')
    lines.append("")
    env_path.write_text("\n".join(lines), encoding="utf-8")
    return env_path


def install_enzyme_cli(enzyme_bin: str) -> dict:
    resolved = shutil.which(enzyme_bin) if enzyme_bin == "enzyme" else shutil.which(enzyme_bin) or enzyme_bin
    if resolved and Path(resolved).exists():
        return {"installed": False, "reason": "already-present", "enzymeBin": resolved}
    result = subprocess.run(["bash", "-lc", OFFICIAL_ENZYME_INSTALL], text=True)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    resolved = shutil.which("enzyme") or str(Path.home() / ".local" / "bin" / "enzyme")
    return {"installed": True, "enzymeBin": resolved}


def enzyme_env(root: Path, provider: str) -> dict:
    selected = select_provider(root, provider)
    env = os.environ.copy()
    for dotenv_path in reversed(dotenv_files(root)):
        for dotenv_key, dotenv_value in parse_dotenv(dotenv_path).items():
            env.setdefault(dotenv_key, dotenv_value)
    if selected == "openai":
        key, _ = resolve_env_value(root, "OPENAI_API_KEY")
        if not key:
            raise SystemExit(
                {
                    "ok": False,
                    "selectedProvider": selected,
                    "missingEnv": ["OPENAI_API_KEY"],
                    "detail": "Set OPENAI_API_KEY in process env or a target Hermes .env file; the value will not be printed or stored.",
                }
            )
        env["OPENAI_API_KEY"] = key
    else:
        key, _ = resolve_env_value(root, "OPENROUTER_API_KEY")
        if not key:
            raise SystemExit(
                {
                    "ok": False,
                    "selectedProvider": selected,
                    "missingEnv": ["OPENROUTER_API_KEY"],
                    "detail": "Set OPENROUTER_API_KEY in process env or a target Hermes .env file; the value will not be printed or stored.",
                }
            )
        env["OPENROUTER_API_KEY"] = key
        env.setdefault("OPENROUTER_BASE_URL", DEFAULT_OPENROUTER_BASE_URL)
        env.setdefault("OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL)
    return env


def run_enzyme(vault: Path, action: str, enzyme_bin: str, root: Path, provider: str, use_env_llm: bool) -> dict:
    if action == "none":
        return {"action": "none"}
    resolved = shutil.which(enzyme_bin) if enzyme_bin == "enzyme" else shutil.which(enzyme_bin) or enzyme_bin
    if not resolved or not Path(resolved).exists():
        raise SystemExit({"ok": False, "missingExecutable": enzyme_bin, "install": OFFICIAL_ENZYME_INSTALL})
    cmd = [resolved, action, "--vault", str(vault)]
    if use_env_llm and action in {"init", "refresh"}:
        cmd.append("--use-env-llm")
    result = subprocess.run(cmd, text=True, env=enzyme_env(root, provider) if use_env_llm else os.environ.copy())
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return {
        "action": action,
        "vault": str(vault),
        "enzymeBin": resolved,
        "providerEnv": {
            "provider": select_provider(root, provider) if use_env_llm else "hosted-default",
            "apiKey": ("OPENROUTER_API_KEY" if select_provider(root, provider) == "openrouter" else "OPENAI_API_KEY") if use_env_llm else None,
            "baseUrl": ("OPENROUTER_BASE_URL" if select_provider(root, provider) == "openrouter" else "OPENAI_BASE_URL") if use_env_llm else None,
            "model": ("OPENROUTER_MODEL" if select_provider(root, provider) == "openrouter" else "OPENAI_MODEL") if use_env_llm else None,
            "useEnvLlm": use_env_llm,
        },
    }


def scan_vault_secrets(root: Path, include_memory: bool) -> dict:
    files = list(vault_root(root).rglob("*.md"))
    if include_memory:
        memory = root / "memory"
        if memory.exists():
            files.extend(path for path in memory.rglob("*") if path.is_file())
    return scan_files(files)


def cron_prompt() -> str:
    return "\n".join(
        [
            "Use the injected Hermes agent memory heartbeat context.",
            "Write or update `agent-memory-vault/forum/YYYY-MM-DD.md` and `agent-memory-vault/irl/YYYY-MM-DD.md`.",
            "Keep the notes concise, grounded, and uncertainty-aware.",
            "Do not copy `memory/hermes-workspace-context.json` wholesale into the vault.",
            "After writing the notes, run `python3 skills/index-network/scripts/memory-workspace/workspace_loop.py --prepare`.",
            "Return `[SILENT]` unless a local operator-facing summary is genuinely needed.",
        ]
    )


def json_cron_jobs_named(value: object, name: str) -> list[dict]:
    jobs: list[dict] = []
    if isinstance(value, dict):
        if value.get("name") == name:
            jobs.append(value)
        for child in value.values():
            jobs.extend(json_cron_jobs_named(child, name))
    if isinstance(value, list):
        for child in value:
            jobs.extend(json_cron_jobs_named(child, name))
    return jobs


def cron_job_uses_script(job: dict, script_name: str) -> bool:
    for key in ["script", "scriptPath", "script_path"]:
        value = job.get(key)
        if isinstance(value, str) and Path(value).name == script_name:
            return True
    return script_name in json.dumps(job, sort_keys=True)


def remove_cron_job(job: dict, hermes_bin: str) -> bool:
    job_id = str(job.get("id") or "").strip()
    if not job_id:
        return False
    result = subprocess.run([hermes_bin, "cron", "remove", job_id], text=True, capture_output=True)
    if result.returncode != 0:
        return False
    return True


def cron_exists(name: str, hermes_bin: str, script_name: str | None = None) -> bool:
    json_result = subprocess.run([hermes_bin, "cron", "list", "--all", "--json"], text=True, capture_output=True)
    if json_result.returncode == 0 and json_result.stdout.strip():
        try:
            jobs = json_cron_jobs_named(json.loads(json_result.stdout), name)
            if script_name is None:
                return bool(jobs)
            return any(cron_job_uses_script(job, script_name) for job in jobs)
        except json.JSONDecodeError:
            pass

    result = subprocess.run([hermes_bin, "cron", "list", "--all"], text=True, capture_output=True)
    if result.returncode != 0:
        return False
    return bool(re.search(rf"(?m)^\s*Name:\s*{re.escape(name)}\s*$", result.stdout))


def cron_prepare_script(root: Path) -> Path:
    return root / "skills" / "index-network" / "scripts" / "memory-workspace" / "cron_prepare.py"


def write_cron_wrapper(root: Path, script: Path, script_name: str = DEFAULT_CRON_SCRIPT_NAME) -> Path:
    scripts_dir = root / ".hermes" / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    wrapper = scripts_dir / script_name
    wrapper.write_text(
        "\n".join(
            [
                "#!/usr/bin/env python3",
                "from pathlib import Path",
                "import os",
                "import subprocess",
                "import sys",
                "",
                f'DEFAULT_ROOT = Path({str(root)!r})',
                "root = Path(os.environ.get('HERMES_HOME') or DEFAULT_ROOT).expanduser().resolve()",
                "os.chdir(root)",
                f"script = root / {str(script.relative_to(root))!r}",
                "raise SystemExit(subprocess.run(['python3', str(script)] + sys.argv[1:]).returncode)",
                "",
            ]
        ),
        encoding="utf-8",
    )
    wrapper.chmod(0o755)
    return wrapper


def remove_stale_crons(name: str, hermes_bin: str, script_name: str) -> list[str]:
    json_result = subprocess.run([hermes_bin, "cron", "list", "--all", "--json"], text=True, capture_output=True)
    if json_result.returncode != 0 or not json_result.stdout.strip():
        return []
    try:
        jobs = json_cron_jobs_named(json.loads(json_result.stdout), name)
    except json.JSONDecodeError:
        return []
    removed: list[str] = []
    for job in jobs:
        if cron_job_uses_script(job, script_name):
            continue
        if remove_cron_job(job, hermes_bin):
            removed.append(str(job.get("id") or "unknown"))
    return removed


def install_cron(root: Path, schedule: str, name: str, hermes_bin: str) -> dict:
    script = cron_prepare_script(root)
    if not script.exists():
        raise SystemExit(
            {
                "ok": False,
                "missingCronScript": str(script),
                "detail": "Copy AgentVillage skills into the target Hermes root before creating the cron, then rerun setup from that root or pass --root.",
            }
        )
    wrapper = write_cron_wrapper(root, script)
    removed_stale = remove_stale_crons(name, hermes_bin, wrapper.name)
    if cron_exists(name, hermes_bin, wrapper.name):
        return {"installed": False, "reason": "already-exists", "name": name, "schedule": schedule, "script": wrapper.name, "removedStale": removed_stale}
    args = [
        hermes_bin,
        "cron",
        "create",
        schedule,
        cron_prompt(),
        "--name",
        name,
        "--script",
        wrapper.name,
        "--workdir",
        str(root),
    ]
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode != 0:
        if result.stdout.strip():
            print(result.stdout.strip(), file=sys.stderr)
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        raise SystemExit(result.returncode)
    if not cron_exists(name, hermes_bin, wrapper.name):
        raise SystemExit(
            {
                "ok": False,
                "cronCreatedButNotVerified": name,
                "detail": "Hermes accepted the cron create command, but `hermes cron list --all` did not show the job. Confirm HERMES_HOME/HERMES_BIN point at the target Hermes instance and create the cron there.",
            }
        )
    return {"installed": True, "name": name, "schedule": schedule, "script": wrapper.name, "removedStale": removed_stale}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".", help="Target Hermes workspace root")
    parser.add_argument("--check", action="store_true", help="Validate expected files/folders exist")
    parser.add_argument("--install-enzyme-config", action="store_true", help="Write/update managed vault mapping in ~/.enzyme/config.toml")
    parser.add_argument("--enzyme-config", default=str(Path.home() / ".enzyme" / "config.toml"), help="Enzyme config path")
    parser.add_argument("--install-enzyme-cli", action="store_true", help="Install the Enzyme CLI with the official installer if missing")
    parser.add_argument("--write-enzyme-env", action="store_true", help="Write memory/enzyme-env.sh with non-secret Enzyme environment exports")
    parser.add_argument("--enzyme-provider", choices=["auto", "openrouter", "openai"], default="auto", help="Provider env family to use for Enzyme subprocesses and env file references")
    parser.add_argument("--check-enzyme-env", action="store_true", help="Report Enzyme env presence and selected provider without printing values")
    parser.add_argument("--scan-vault-secrets", action="store_true", help="Scan vault output and report secret counts/paths only")
    parser.add_argument("--scan-include-memory", action="store_true", help="With --scan-vault-secrets, also scan memory/* operational files")
    parser.add_argument("--api-key-env", default=None, help="Deprecated; use --enzyme-provider. OPENROUTER_API_KEY selects openrouter, OPENAI_API_KEY selects openai.")
    parser.add_argument("--enzyme-bin", default=shutil.which("enzyme") or "enzyme", help="Enzyme executable")
    parser.add_argument(
        "--run-enzyme",
        choices=["none", "init", "refresh", "status"],
        default="none",
        help="Run an Enzyme command against agent-memory-vault after setup",
    )
    parser.add_argument("--use-env-llm", action="store_true", help="Pass --use-env-llm to Enzyme init/refresh intentionally")
    parser.add_argument("--install-cron", action="store_true", help="Install the default 2am Hermes heartbeat cron")
    parser.add_argument("--cron-schedule", default=DEFAULT_CRON_SCHEDULE, help="Hermes heartbeat cron schedule")
    parser.add_argument("--cron-name", default=DEFAULT_CRON_NAME, help="Hermes heartbeat cron name")
    parser.add_argument("--hermes-bin", default=shutil.which("hermes") or "hermes", help="Hermes executable")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    if args.api_key_env:
        if args.api_key_env == "OPENAI_API_KEY":
            args.enzyme_provider = "openai"
        elif args.api_key_env == "OPENROUTER_API_KEY":
            args.enzyme_provider = "openrouter"

    vault = vault_root(root)
    folders = [
        vault / "hermes" / "sessions",
        vault / "forum",
        vault / "irl",
        vault / "irl" / "people",
        vault / "irl" / "events",
        root / "memory",
        root / "memory" / "hermes-workspace-staged",
    ]

    missing = [str(folder) for folder in folders if not folder.exists()]
    missing_files = [
        str(path)
        for path in [
            root / "skills" / "index-network" / "scripts" / "memory-workspace" / "cron_prepare.py",
            root / "skills" / "index-network" / "scripts" / "memory-workspace" / "render_hermes_sessions.py",
        ]
        if not path.exists()
    ]
    if args.check_enzyme_env:
        print(json.dumps(provider_presence(root), indent=2, sort_keys=True))
        return

    if args.scan_vault_secrets:
        report = scan_vault_secrets(root, args.scan_include_memory)
        print(json.dumps(report, indent=2, sort_keys=True))
        if not report["ok"]:
            raise SystemExit(1)
        return

    if args.check:
        print(
            {
                "ok": not missing and not missing_files,
                "vault": str(vault),
                "missing": missing,
                "missingFiles": missing_files,
                "mutated": False,
            }
        )
        if missing or missing_files:
            raise SystemExit(1)
        return

    for folder in folders:
        folder.mkdir(parents=True, exist_ok=True)

    if not state_path(root).exists():
        write_json(state_path(root), default_state())
    if not context_path(root).exists():
        write_json(context_path(root), {"created": None, "forum": {}, "irl": {}, "petri": {}})

    (vault / "enzyme-config.example.toml").write_text(enzyme_example(vault), encoding="utf-8")
    enzyme_config = Path(args.enzyme_config).expanduser().resolve()
    if args.install_enzyme_config:
        install_enzyme_config(vault, enzyme_config)
    enzyme_cli_result = None
    if args.install_enzyme_cli:
        enzyme_cli_result = install_enzyme_cli(args.enzyme_bin)
        if enzyme_cli_result.get("enzymeBin"):
            args.enzyme_bin = enzyme_cli_result["enzymeBin"]
    enzyme_env_path = None
    if args.write_enzyme_env:
        enzyme_env_path = write_enzyme_env(root, args.enzyme_provider)
    enzyme_run_result = run_enzyme(vault, args.run_enzyme, args.enzyme_bin, root, args.enzyme_provider, args.use_env_llm)
    cron_result = None
    if args.install_cron:
        cron_result = install_cron(root, args.cron_schedule, args.cron_name, args.hermes_bin)

    print({
        "ok": True,
        "vault": str(vault),
        "enzymeExample": str(vault / "enzyme-config.example.toml"),
        "enzymeConfigInstalled": bool(args.install_enzyme_config),
        "enzymeConfig": str(enzyme_config) if args.install_enzyme_config else None,
        "enzymeCli": enzyme_cli_result,
        "enzymeEnv": str(enzyme_env_path) if enzyme_env_path else None,
        "enzymeRun": enzyme_run_result,
        "cron": cron_result,
    })


if __name__ == "__main__":
    main()
