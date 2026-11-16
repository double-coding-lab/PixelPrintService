#!/bin/sh

set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -f "$project_root/.env" ]; then
  set -a
  . "$project_root/.env"
  set +a
fi

exec "$@"
