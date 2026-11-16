#!/bin/sh
set -eu
# Keep the host configuration private and copy it to a file readable only by the application user.
install -d -o node -g node -m 700 /app/.runtime/private
install -d -o node -g node /app/.data
install -o node -g node -m 600 /app/project.config.json /app/.runtime/private/project.config.json
export PIXELPRINT_CONFIG=/app/.runtime/private/project.config.json
exec gosu node "$@"
