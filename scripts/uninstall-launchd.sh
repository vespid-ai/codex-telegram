#!/usr/bin/env bash
set -euo pipefail

PLIST_ID="com.mangaohua.codex-telegram"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_ID}.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "Uninstalled ${PLIST_ID}"
