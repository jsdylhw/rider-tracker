"""Architecture guardrails for the repository's top-level dependency boundaries."""

from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


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


def test_removed_legacy_packages_are_not_imported() -> None:
    """Prevent old core/activity/workflow package names from returning after migration."""
    violations = _imports_with_prefix(
        ["agent", "app", "domain", "services", "fit", "storage", "integrations", "operations"],
        forbidden=("core", "sinks", "agent.activity", "agent.route", "agent.runtime.workflow"),
    )
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
