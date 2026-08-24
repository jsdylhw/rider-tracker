#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
jar="$root/graphhopper-web-11.0.jar"
pbf="$root/data/osm/jzsh-latest.osm.pbf"
config="$root/graphhopper.yml"

if [[ ! -f "$jar" ]]; then
  curl --fail --location --retry 3 --retry-all-errors \
    --output "$jar" \
    "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/11.0/graphhopper-web-11.0.jar"
fi
if [[ ! -f "$pbf" ]]; then
  bash "$root/download_jzsh_osm.sh"
fi

java_bin="${GRAPHOPPER_JAVA_BIN:-java}"
if ! command -v "$java_bin" >/dev/null 2>&1; then
  java_bin="$root/runtime/java/bin/java"
fi
if [[ ! -x "$java_bin" ]] && ! command -v "$java_bin" >/dev/null 2>&1; then
  echo "Java 25+ is required. Run: $root/download_java_runtime.sh" >&2
  exit 1
fi

cd "$root"
exec "$java_bin" \
  -jar "$jar" server "$config"
