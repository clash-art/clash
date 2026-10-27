#!/bin/sh
# gateway-node process roles (#373). tini is PID 1; this script selects the
# long-running server or the one-shot migrate. A compose `command:` (outbox
# process, mock-upstream, …) replaces the role default — those are not
# GATEWAY_ROLE values (BullMQ outbox stays a separate process; no gateway
# process-role named for it).
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

role="${GATEWAY_ROLE:-api}"
case "$role" in
  migrate)
    exec node src/gateway-cli.ts migrate
    ;;
  api|admin|all)
    # Deliberate tsx ship: api-node has no compile step; workspace deps are
    # built to dist/ in the image and this package runs TypeScript via tsx
    # (see deploy/Dockerfile). Swap to a production build only when api-node
    # gains one — do not pretend dist/ exists today.
    exec node_modules/.bin/tsx \
      --tsconfig tsconfig.json \
      --import ./src/telemetry.ts \
      src/server.ts
    ;;
  *)
    echo "GATEWAY_ROLE must be api, admin, all or migrate (got: ${role})" >&2
    exit 1
    ;;
esac
