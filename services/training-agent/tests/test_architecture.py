"""Architecture guardrails for the repository's top-level dependency boundaries."""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parents[1]

def test_non_agent_layers_do_not_depend_on_agent() -> None:
    """Keep reusable business and infrastructure code callable without a chat Agent."""
    violations = _imports_with_prefix(
        ["services", "domain", "fit", "storage", "integrations"],
        forbidden=("agent",),
    )
    assert violations == []


def test_domain_and_fit_do_not_depend_on_stateful_outer_layers() -> None:
    """Keep deterministic facts and domain contracts independent of I/O orchestration."""
    violations = _imports_with_prefix(
        ["domain", "fit"],
        forbidden=("agent", "services", "storage", "integrations", "operations"),
    )
    assert violations == []


def test_services_do_not_own_llm_clients() -> None:
    """Keep model calls in Agent adapters; services accept explicit collaborators."""
    violations = _imports_with_prefix(["services"], forbidden=("integrations.llm",))
    assert violations == []


def test_operations_do_not_depend_on_main_agent_state() -> None:
    """Allow report jobs to invoke the child analyzer, but never the chat runtime."""
    violations = _imports_with_prefix(
        ["operations"],
        forbidden=("agent.main_agent", "agent.skills", "agent.tools"),
    )
    assert violations == []


def test_worker_has_no_web_or_test_runtime_dependencies() -> None:
    assert _imports_with_prefix(["worker"], forbidden=("app", "tests", "fastapi", "uvicorn")) == []
    assert _imports_with_prefix(["domain", "services", "storage"], forbidden=("worker",)) == []


def test_removed_legacy_packages_are_not_imported() -> None:
    """Prevent old core/activity/workflow package names from returning after migration."""
    violations = _imports_with_prefix(
        ["agent", "app", "domain", "services", "fit", "storage", "integrations", "operations", "worker"],
        forbidden=("core", "sinks", "agent.activity", "agent.route", "agent.runtime.workflow"),
    )
    assert violations == []


def test_production_code_does_not_depend_on_demo() -> None:
    """Production and standalone experiments must remain separate source trees."""
    directories = ["agent", "app", "domain", "fit", "integrations", "operations", "services", "storage", "worker"]
    assert not (ROOT / "demo").exists()
    assert _import_edges_with_prefix(directories, prefix="demo") == set()
    assert _import_edges_with_prefix(directories, prefix="demos") == set()


def test_browser_http_surface_matches_migration_contract() -> None:
    """Keep browser-facing methods and URLs stable while ownership moves to Python."""
    contract_path = REPOSITORY_ROOT / "tests" / "contracts" / "rider-browser-http-api.v1.json"
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    expected = {(route["method"], route["path"]) for route in contract["routes"]}
    actual: set[tuple[str, str]] = set()
    route_files = [
        REPOSITORY_ROOT / "src" / "server" / "index.js",
        *(REPOSITORY_ROOT / "src" / "server" / "routes").glob("*.js"),
    ]
    route_pattern = re.compile(
        r"\b(?:app|router)\.(get|post|put|patch|delete)\(\s*[\"']([^\"']+)",
    )
    for path in route_files:
        for method, route_path in route_pattern.findall(path.read_text(encoding="utf-8")):
            normalized_path = re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", route_path)
            actual.add((method.upper(), normalized_path))
    assert actual == expected


def test_node_server_does_not_own_database_schema_ddl() -> None:
    """Python migrations are the only production owner of SQLite structure."""
    violations: list[str] = []
    for path in (REPOSITORY_ROOT / "src" / "server").rglob("*.js"):
        text = path.read_text(encoding="utf-8")
        if re.search(r"\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)\b", text, re.IGNORECASE):
            violations.append(str(path.relative_to(REPOSITORY_ROOT)))
    assert violations == []


def test_node_production_startup_does_not_open_sqlite() -> None:
    """Database readiness and migrations belong to the Python backend."""
    paths = [
        *(REPOSITORY_ROOT / "src" / "server").rglob("*.js"),
        REPOSITORY_ROOT / "scripts" / "database-preflight.js",
    ]
    violations = [
        str(path.relative_to(REPOSITORY_ROOT))
        for path in paths
        if "node:sqlite" in path.read_text(encoding="utf-8")
    ]
    assert violations == []


def _imports_with_prefix(directories: list[str], *, forbidden: tuple[str, ...]) -> list[str]:
    violations: list[str] = []
    for directory in directories:
        for path in (ROOT / directory).rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                names = _import_names(node)
                for name in names:
                    if any(name == prefix or name.startswith(f"{prefix}.") for prefix in forbidden):
                        violations.append(f"{path.relative_to(ROOT)}:{node.lineno}: {name}")
    return sorted(violations)


def _import_names(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if isinstance(node, ast.ImportFrom) and node.module:
        return [node.module]
    return []


def _import_edges_with_prefix(directories: list[str], *, prefix: str) -> set[str]:
    edges: set[str] = set()
    for directory in directories:
        for path in (ROOT / directory).rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                for name in _import_names(node):
                    if name == prefix or name.startswith(f"{prefix}."):
                        edges.add(f"{path.relative_to(ROOT)} -> {name}")
    return edges
