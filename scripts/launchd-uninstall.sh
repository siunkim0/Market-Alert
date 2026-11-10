#!/bin/zsh
# launchd 등록 해제
set -euo pipefail
LABEL="com.fivesigma.alert"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "중지됨" || echo "실행 중이 아님"
rm -f "$PLIST" && echo "삭제: $PLIST"
