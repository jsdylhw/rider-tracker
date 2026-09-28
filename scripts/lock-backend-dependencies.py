#!/usr/bin/env python3
"""Record or check the tested environment's dependency closure, without downloads.

This is a platform-specific release constraint, not a cross-platform resolver.
Run from an environment whose Rider tests have passed. It never freezes unrelated
Conda packages and never changes the active environment.
"""
import argparse
from collections import deque
import hashlib
from importlib import metadata
from pathlib import Path
import platform
import sys
import tomllib

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

PROJECT = Path(__file__).resolve().parents[1] / 'services/training-agent/pyproject.toml'


def snapshot(project=PROJECT):
    raw = project.read_bytes()
    definition = tomllib.loads(raw.decode())
    roots = [*definition['project']['dependencies'], *definition['build-system']['requires'],
             *definition['project']['optional-dependencies']['test']]
    pending = deque((Requirement(value), frozenset()) for value in roots)
    seen = set()
    versions = {}
    while pending:
        requirement, parent_extras = pending.popleft()
        if requirement.marker and not any(requirement.marker.evaluate({'extra': extra})
                                          for extra in {'', *parent_extras}):
            continue
        distribution = metadata.distribution(requirement.name)
        if not requirement.specifier.contains(distribution.version, prereleases=True):
            raise ValueError(f'{requirement.name} installed version does not satisfy {requirement.specifier}')
        name = canonicalize_name(distribution.metadata['Name'])
        versions[name] = distribution.version
        state = (name, frozenset(requirement.extras))
        if state in seen:
            continue
        seen.add(state)
        pending.extend((Requirement(value), state[1]) for value in distribution.requires or [])
    target = f'{platform.system().lower()}-{platform.machine().lower()}-py{sys.version_info.major}{sys.version_info.minor}'
    header = [
        '# Rider tested environment constraints; do not edit by hand.',
        f'# Target: {target}',
        f'# pyproject-sha256: {hashlib.sha256(raw).hexdigest()}',
        '# Includes runtime, build and test dependencies; excludes unrelated environment packages.',
        '# No artifact hashes: this pins versions, not package-index content.',
    ]
    return '\n'.join([*header, *(f'{name}=={version}' for name, version in sorted(versions.items())), ''])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    content = snapshot()
    if args.check:
        if args.output.read_text(encoding='utf-8') != content:
            parser.exit(1, 'Dependency constraints differ from the active environment or project definition.\n')
        print('Dependency constraints match the active environment and project definition.')
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding='utf-8')
        print(f'Wrote dependency constraints to {args.output}')


if __name__ == '__main__':
    main()
