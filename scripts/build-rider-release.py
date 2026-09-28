#!/usr/bin/env python3
"""Build a relocatable Rider source release with no runtime Node dependency."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def build(destination: Path):
    spec = importlib.util.spec_from_file_location('browser_assets', ROOT / 'scripts/build-browser-assets.py')
    assets = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assets)
    destination = destination.resolve()
    assets.build(ROOT, destination)  # Fails before writing if destination already exists.
    backend = ROOT / 'services/training-agent'
    definition = tomllib.loads((backend / 'pyproject.toml').read_text())
    paths = [ROOT / 'config.yaml.example', ROOT / 'docs/python-release-runbook.md',
             ROOT / 'scripts/start-rider.py', ROOT / 'scripts/database-tool.py',
             backend / 'pyproject.toml', backend / 'requirements.txt']
    paths.extend(backend / f'{name}.py' for name in definition['tool']['setuptools']['py-modules'])
    packages = definition['tool']['setuptools']['packages']['find']['include']
    for name in packages:
        if '.' not in name:
            paths.extend(p for p in (backend / name).rglob('*.py') if p.is_file())
    paths.extend((backend / 'agent/skills/library').rglob('*.md'))
    paths.extend((backend / 'constraints').glob('*.txt'))
    try:
        for path in paths:
            if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
                raise ValueError('Release source must not escape repository.')
            relative = path.relative_to(ROOT)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        files = sorted(p for p in destination.rglob('*') if p.is_file())
        manifest = {'schema_version': 'rider_source_release.v1', 'files': {
            p.relative_to(destination).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
        (destination / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    except BaseException:
        shutil.rmtree(destination)
        raise
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    manifest = build(args.output)
    print(f"Exported {len(manifest['files'])} Rider release files to {args.output}")
