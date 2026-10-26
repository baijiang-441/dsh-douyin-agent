#!/usr/bin/env bash
# bootguard 的 UI_HOOK：Edge 异常关闭后会出现「Restore pages」气泡，挡住私信入口。
# 检测到气泡（标题带近纯白）才点它的 X（953,113），绝不点 Restore；没气泡就什么都不做。
export DISPLAY="${DISPLAY:-:99}"
cd "$HOME/workspace/douyin-fish/tools-x" || exit 0
if python3 ui_check.py 2>/dev/null; then
  python3 xclick.py 953 113 2>/dev/null && echo "ui_hook: 已关 Restore 气泡"
else
  echo "ui_hook: 无气泡，不处理"
fi
exit 0
