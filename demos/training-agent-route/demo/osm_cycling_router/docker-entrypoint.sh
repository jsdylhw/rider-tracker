#!/usr/bin/env bash
set -euo pipefail

root=/app
pbf="$root/data/osm/jzsh-latest.osm.pbf"
places_db="$root/data/scenic_places.sqlite"
roads_db="$root/data/road_corridors.sqlite"

if [[ ! -s "$pbf" ]]; then
  echo "[bootstrap] downloading and merging Jiangsu / Zhejiang / Shanghai OSM data"
  bash "$root/download_jzsh_osm.sh"
fi

if [[ ! -s "$places_db" ]]; then
  echo "[bootstrap] building local scenic-place index"
  python3 "$root/places.py" build --pbf "$pbf" --database "$places_db"
fi

if [[ ! -s "$roads_db" ]]; then
  echo "[bootstrap] building local semantic-road index"
  python3 "$root/road_corridors.py" build --pbf "$pbf" --database "$roads_db"
fi

exec java ${JAVA_OPTS:-} \
  -jar /opt/graphhopper/graphhopper-web.jar server "$root/graphhopper.yml"
