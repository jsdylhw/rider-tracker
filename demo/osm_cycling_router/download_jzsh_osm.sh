#!/usr/bin/env bash
set -euo pipefail

# Build one routing/search extract from the three official Geofabrik regions.
# A single PBF matters: GraphHopper and the local place index must see the
# same OSM objects, otherwise a search result can fall outside the router.

root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
osm_dir="$root/data/osm"
output="$osm_dir/jzsh-latest.osm.pbf"

declare -A urls=(
  [shanghai-latest.osm.pbf]="https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf"
  [jiangsu-latest.osm.pbf]="https://download.geofabrik.de/asia/china/jiangsu-latest.osm.pbf"
  [zhejiang-latest.osm.pbf]="https://download.geofabrik.de/asia/china/zhejiang-latest.osm.pbf"
)

if ! python3 -c 'import osmium' >/dev/null 2>&1; then
  echo "Python package osmium is required to merge regional PBF files." >&2
  echo "Install it with: python3 -m pip install osmium" >&2
  exit 1
fi

mkdir -p "$osm_dir"
for file in "${!urls[@]}"; do
  target="$osm_dir/$file"
  partial="$target.part"
  if [[ ! -s "$target" ]]; then
    # Keep incomplete downloads separate. A restarted container resumes the
    # partial file instead of treating a non-empty truncated PBF as complete.
    curl --fail --location --retry 3 --retry-all-errors --continue-at - \
      --output "$partial" "${urls[$file]}"
    mv "$partial" "$target"
  fi
done

# Geofabrik extracts are sorted OSM files. The local pyosmium merge preserves
# a valid PBF stream and removes duplicate objects along province boundaries.
python3 "$root/merge_osm.py" --output "$output" \
  "$osm_dir/shanghai-latest.osm.pbf" \
  "$osm_dir/jiangsu-latest.osm.pbf" \
  "$osm_dir/zhejiang-latest.osm.pbf"

echo "Built $output"
