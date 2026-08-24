#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
exec python -m demo.gaode_cycling_router.web_server "$@"
