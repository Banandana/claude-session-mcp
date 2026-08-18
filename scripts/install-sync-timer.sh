#!/usr/bin/env bash
# Installs the user timer that keeps the session index warm for every source.
# Claude Code can fire src/cli/sync.ts from a Stop hook; pi, Codex and opencode
# cannot, so this timer is the floor for all four.
#
# Usage: scripts/install-sync-timer.sh [--enable]
#   (without --enable it only writes the units and reloads, so you can inspect
#    them before anything starts running)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"

sed "s#%h/workspace/research/agent-systems/grid/repos/session-history-mcp#${repo_root}#g" \
  "$repo_root/scripts/session-history-sync.service" > "$unit_dir/session-history-sync.service"
cp "$repo_root/scripts/session-history-sync.timer" "$unit_dir/session-history-sync.timer"

systemctl --user daemon-reload
echo "installed: $unit_dir/session-history-sync.{service,timer}"

if [[ "${1:-}" == "--enable" ]]; then
  systemctl --user enable --now session-history-sync.timer
  systemctl --user list-timers session-history-sync.timer --no-pager
else
  echo "not enabled. to start it:  systemctl --user enable --now session-history-sync.timer"
  echo "to dry-run once:           systemctl --user start session-history-sync.service && journalctl --user -u session-history-sync -n 20"
fi
