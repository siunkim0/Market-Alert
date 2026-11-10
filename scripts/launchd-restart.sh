#!/bin/zsh
# 코드 변경 후: 다시 빌드하고 재시작
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$APP_DIR" && npm run build >/dev/null)
launchctl kickstart -k "gui/$(id -u)/com.fivesigma.alert"
echo "재시작됨"
