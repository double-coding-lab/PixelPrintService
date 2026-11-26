#!/usr/bin/env bash
# Install outside the checkout; use as authorized_keys command= for the dedicated CI key.
set -euo pipefail
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([a-f0-9]{40})$ ]]; then
  exec bash /usr/local/lib/pixelprint/deploy-server.sh "${BASH_REMATCH[1]}"
fi
echo 'This key only accepts PixelPrint deployments' >&2
exit 2
