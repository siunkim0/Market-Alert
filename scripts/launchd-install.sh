#!/bin/zsh
# 5σ Alert를 macOS launchd 사용자 에이전트로 등록한다.
# - 로그인 시 자동 시작(RunAtLoad), 죽으면 자동 재시작(KeepAlive)
# - caffeinate -i: 실행 중 유휴 잠자기 방지 (뚜껑 닫힘 잠자기는 막지 못함)
# 로그: ~/Library/Logs/5sigma-alert/{out,err}.log
set -euo pipefail

LABEL="com.fivesigma.alert"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/5sigma-alert"

[[ -f "$APP_DIR/.env" ]] || { echo ".env가 없습니다: $APP_DIR/.env"; exit 1; }

echo "빌드: $APP_DIR"
(cd "$APP_DIR" && npm run build >/dev/null)

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>$NODE</string>
    <string>$APP_DIR/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "등록 완료: $PLIST"
echo "상태: launchctl print gui/$(id -u)/$LABEL | grep -E 'state|pid'"
echo "로그: tail -f $LOG_DIR/out.log"
