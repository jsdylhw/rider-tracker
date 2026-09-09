#!/usr/bin/env bash
set -euo pipefail

# Demo-local Java runtime.  This avoids a system package installation.
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
target="$root/runtime/java"
archive="$root/runtime/temurin-jre.tar.gz"
url="https://api.adoptium.net/v3/binary/latest/25/ga/linux/x64/jre/hotspot/normal/eclipse"

if [[ -x "$target/bin/java" ]]; then
  "$target/bin/java" -version >&2
  exit 0
fi

mkdir -p "$root/runtime"
curl --fail --location --retry 3 --retry-all-errors --output "$archive" "$url"
rm -rf "$target"
mkdir -p "$target"
tar -xzf "$archive" --strip-components=1 -C "$target"
rm -f "$archive"
"$target/bin/java" -version >&2
