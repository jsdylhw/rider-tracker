#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
pbf="$root/data/osm/jzsh-latest.osm.pbf"
database="$root/data/scenic_places.sqlite"

if [[ ! -s "$pbf" ]]; then
  echo "Missing $pbf. Run: bash $root/download_jzsh_osm.sh" >&2
  exit 1
fi

if ! python3 -c 'import osmium' >/dev/null 2>&1; then
  echo "Python package osmium is required." >&2
  echo "Install it with: python3 -m pip install osmium" >&2
  exit 1
fi

exec python3 "$root/places.py" build --pbf "$pbf" --database "$database"
