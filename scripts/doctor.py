"""Offline startup diagnostics. Never starts services, opens databases or reads tokens."""
from __future__ import annotations

import argparse
import contextlib
import errno
import importlib.metadata as metadata
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "training-agent"))


def check_dependencies(root, add):
    try:
        import tomllib
        project = tomllib.loads((root / "services/training-agent/pyproject.toml").read_text(encoding="utf-8"))["project"]
        from packaging.requirements import Requirement
        from packaging.specifiers import SpecifierSet
    except ImportError:
        add("dependencies", "error", "Version checks require Python 3.12+ and packaging. Run npm run setup:agent.")
        return
    except Exception:
        add("dependencies", "error", "Cannot read the project dependency manifest.")
        return
    version = ".".join(map(str, sys.version_info[:3]))
    add("python", "ok" if version in SpecifierSet(project["requires-python"]) else "error",
        f"{sys.executable} (Python {version}; required {project['requires-python']})")
    for text in project["dependencies"]:
        requirement = Requirement(text)
        if requirement.marker and not requirement.marker.evaluate():
            continue
        try:
            installed = metadata.version(requirement.name)
            matches = installed in requirement.specifier
            add("dependency:" + requirement.name, "ok" if matches else "error",
                f"{installed}; required {requirement.specifier}" + ("" if matches else ". Run npm run setup:agent."))
        except metadata.PackageNotFoundError:
            add("dependency:" + requirement.name, "error", "Not installed. Run npm run setup:agent.")


def check_port(env, add):
    try:
        host = env.get("HOST") or "127.0.0.1"
        port = int(env.get("PORT") or "8787")
        if not 1 <= port <= 65535:
            raise ValueError()
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (ValueError, OSError):
        add("web-port", "error", "Invalid HOST or PORT; PORT must be 1..65535.")
        return
    occupied = False
    for family, kind, proto, _, address in addresses:
        try:
            with socket.socket(family, kind, proto) as probe:
                if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                probe.bind(address)
            add("web-port", "ok", f"Public port {port} is available (point-in-time check).")
            return
        except OSError as error:
            occupied = occupied or error.errno == errno.EADDRINUSE or getattr(error, "winerror", None) == 10048
    add("web-port", "warning" if occupied else "error",
        f"Public port {port} is occupied; Rider may already be running." if occupied else "Cannot bind the public port; check HOST and permissions.")


def check_paths(paths, add):
    file_fields = {"database", "strava_token_store", "legacy_athlete_file"}
    checked = set()
    for name, path in vars(paths).items():
        if name in {"project_root", "legacy_athlete_file"}:
            continue
        directory = path.parent if name in file_fields else path
        try:
            if name in file_fields and path.exists() and (not path.is_file() or not os.access(path, os.W_OK)):
                raise OSError()
            ancestor = directory
            while not ancestor.exists():
                ancestor = ancestor.parent
            if ancestor not in checked:
                # Probe and remove an empty temporary file; never create data directories.
                with tempfile.TemporaryFile(dir=ancestor):
                    pass
                checked.add(ancestor)
            add("path:" + name, "ok", f"{path}" + (" (created on startup)" if not path.exists() else ""))
        except OSError:
            add("path:" + name, "error", "Path is not writable or a parent is not a directory.")


def diagnose(root=ROOT, environ=None):
    checks = []
    def add(id, status, message):
        checks.append({"id": id, "status": status, "message": message})
    supplied = dict(os.environ if environ is None else environ)
    node = supplied.get("RIDER_DOCTOR_NODE_VERSION")
    if node:
        # Read the npm engine requirement rather than maintaining a separate version pin.
        try:
            from packaging.specifiers import SpecifierSet
            requirement = json.loads((root / "package.json").read_text(encoding="utf-8"))["engines"]["node"]
            add("node", "ok" if node in SpecifierSet(requirement) else "error", f"{node}; required {requirement}")
        except Exception:
            add("node", "error", "Cannot validate Node version against package.json.")
    else:
        add("node", "warning", "Run npm run doctor to check the Node launcher as well.")
    add("python-source", "info", supplied.get("RIDER_DOCTOR_PYTHON_SOURCE", "direct Python invocation"))
    check_dependencies(root, add)
    try:
        from app.runtime_config import load_runtime_environment
        from project_paths import runtime_paths
        # dotenv/YAML diagnostics may contain source lines; report only safe summaries.
        with contextlib.redirect_stderr(io.StringIO()):
            env = load_runtime_environment(root, supplied)
        config = Path(env["TRAINING_AGENT_CONFIG_PATH"])
        add("config", "ok" if config.is_file() else "warning",
            "Configuration parsed; secret values omitted." if config.is_file() else "No config.yaml; optional integrations may be unavailable.")
    except Exception:
        add("config", "error", "Cannot load configuration; check YAML syntax, permissions and Python dependencies.")
        return {"schemaVersion": 1, "ok": False, "checks": checks}
    try:
        paths = runtime_paths(base=root, environ=env)
        add("database-path", "ok", "Web/Agent database paths agree; database not opened.")
        check_paths(paths, add)
    except Exception:
        add("database-path", "error", "Invalid paths or conflicting RIDER_TRACKER_DB_PATH / TRAINING_AGENT_DB_PATH.")
    check_port(env, add)
    add("online-services", "info", "Garmin login, Agent readiness and Bluetooth hardware are not tested by this offline check.")
    return {"schemaVersion": 1, "ok": not any(c["status"] == "error" for c in checks), "checks": checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Emit a versioned, secret-free diagnostic report.")
    args = parser.parse_args()
    report = diagnose()
    if args.json:
        print(json.dumps(report, ensure_ascii=True))
    else:
        for check in report["checks"]:
            print(f"[{check['status'].upper()}] {check['id']}: {check['message']}")
        print("Result: " + ("PASS (review any warnings)" if report["ok"] else "FAIL (fix errors before starting)"))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
