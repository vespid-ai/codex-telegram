#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_ID="com.mangaohua.codex-telegram"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_ID}.plist"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT_DIR/logs"

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "Missing $ROOT_DIR/.env. Copy .env.example to .env and set TELEGRAM_BOT_TOKEN first." >&2
  exit 1
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NPM_BIN}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${ROOT_DIR}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT_DIR}/logs/launchd.err.log</string>
</dict>
</plist>
PLIST

npm run build
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$PLIST_ID"

echo "Installed and started ${PLIST_ID}"
echo "Logs:"
echo "  $ROOT_DIR/logs/launchd.out.log"
echo "  $ROOT_DIR/logs/launchd.err.log"
