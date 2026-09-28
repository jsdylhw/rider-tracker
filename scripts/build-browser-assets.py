#!/usr/bin/env python3
"""Export the Rider browser allowlist; never copy configuration or user data."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BROWSER_DIRS = ('adapters', 'app', 'domain', 'shared', 'styles', 'ui')


def build(source: Path, destination: Path) -> dict:
    source, destination = source.resolve(), destination.resolve()
    if destination.exists():
        raise ValueError('Output already exists; choose a new release directory.')
    files = [(source / 'index.html', Path('index.html')),
             (source / 'src/style.css', Path('src/style.css'))]
    for directory in BROWSER_DIRS:
        files.extend((p, p.relative_to(source)) for p in sorted((source / 'src' / directory).rglob('*'))
                     if p.suffix in {'.js', '.css'} and p.is_file())
    sdk = source / 'node_modules/@garmin/fitsdk'
    if not (sdk / 'src/index.js').is_file():
        raise ValueError('FIT SDK missing; install npm dependencies before exporting assets.')
    files.extend((p, Path('vendor/@garmin/fitsdk') / p.relative_to(sdk))
                 for p in sorted(sdk.rglob('*'))
                 if p.is_file() and (p.suffix == '.js' or p.name.lower().startswith('license')))
    # Reject symlinks at every level before creating any output.
    for path, _ in files:
        if not path.is_file() or any(p.is_symlink() for p in (path, *path.parents) if p != source.parent):
            raise ValueError('Missing or symbolic-link asset: ' + str(path.relative_to(source)))
        if not path.resolve().is_relative_to(source):
            raise ValueError('Asset escapes source directory.')
    destination.mkdir(parents=True)
    manifest = {'schema_version': 'rider_browser_assets.v1', 'files': {}}
    try:
        for path, relative in files:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            manifest['files'][relative.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    except BaseException:
        shutil.rmtree(destination)
        raise
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = build(ROOT, args.output)
    print(f"Exported {len(result['files'])} browser assets to {args.output}")
