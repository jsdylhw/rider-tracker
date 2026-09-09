#!/usr/bin/env python3
"""Audit or explicitly migrate legacy Rider runtime paths."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = PROJECT_ROOT / "services" / "training-agent"
sys.path.insert(0, str(AGENT_ROOT))

from project_paths import runtime_paths  # noqa: E402
from runtime_data_migration import audit_runtime_data, migrate_runtime_data  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("audit", "migrate"))
    args = parser.parse_args()
    paths = runtime_paths()
    result = audit_runtime_data(paths) if args.operation == "audit" else migrate_runtime_data(paths)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result["status"] == "conflict":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
