#!/usr/bin/env python3
"""Merge sorted regional OSM PBF extracts without a system osmium-tool install."""

from __future__ import annotations

import argparse
from pathlib import Path


def merge(inputs: list[Path], output: Path) -> None:
    try:
        import osmium
    except ImportError as exc:  # pragma: no cover - environment-level error
        raise RuntimeError("Install pyosmium first: python -m pip install osmium") from exc
    if len(inputs) < 2:
        raise ValueError("at least two regional PBF files are required")
    missing = [str(path) for path in inputs if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"missing input PBF files: {', '.join(missing)}")
    output.parent.mkdir(parents=True, exist_ok=True)
    reader = osmium.MergeInputReader()
    for path in inputs:
        reader.add_file(str(path))
    with osmium.SimpleWriter(str(output), overwrite=True) as writer:
        reader.apply(writer)


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge regional OSM PBF extracts")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("inputs", type=Path, nargs="+")
    args = parser.parse_args()
    merge(args.inputs, args.output)
    print(f"Built {args.output}")


if __name__ == "__main__":
    main()
