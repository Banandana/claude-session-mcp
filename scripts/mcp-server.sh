#!/usr/bin/env bash
# Launcher for the MCP registration.
#
# The server must not be started as a bare `tsx /path/to/src/server.ts`: tsx
# resolves tsconfig.json from the CURRENT WORKING DIRECTORY, and an MCP client
# spawns its servers with the client's cwd, not the repo's. Without this repo's
# tsconfig the `experimentalDecorators` flag is off and the first inversify
# parameter decorator fails the transform, so the server dies before it speaks
# a single byte of protocol.
#
# Pinning the tsconfig explicitly makes startup independent of cwd. The local
# tsx is preferred over `npx tsx` so startup does not depend on the npx cache.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TSX_TSCONFIG_PATH="$repo/tsconfig.json"

tsx="$repo/node_modules/.bin/tsx"
if [[ -x "$tsx" ]]; then
  exec "$tsx" "$repo/src/server.ts" "$@"
fi
exec npx tsx "$repo/src/server.ts" "$@"
