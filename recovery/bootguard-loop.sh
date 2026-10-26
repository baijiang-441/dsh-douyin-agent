#!/usr/bin/env bash
# 抖音栈看门狗监督环：VM 更换/进程被清后，手动跑一次本脚本即可（自成会话，不连坐）。
# 切换到新树那天（10-28）：把 PREFERRED_TREE 改成 new，EVENTS_FILE 改指新树的事件文件。
export PREFERRED_TREE=old
export EVENTS_FILE="$HOME/workspace/dsh-src/douyin/state/chat-events.jsonl"
export UI_HOOK="$HOME/workspace/douyin-fish/tools-x/ui_hook.sh"
PIDF=/root/bootguard-loop.pid
if [ -f "$PIDF" ]; then
  OLD_PID="$(cat "$PIDF" 2>/dev/null)"
  if [ -n "$OLD_PID" ] && [ -r "/proc/$OLD_PID/cmdline" ] && tr '\0' ' ' < "/proc/$OLD_PID/cmdline" | grep -q "bootwatch"; then
    echo "bootguard loop already running (pid $OLD_PID)"
    exit 0
  fi
fi
setsid bash -c 'while true; do /home/hatch/workspace/douyin-fish/tools-x/bootwatch.sh >> /root/bootguard.log 2>&1; sleep 120; done' >/dev/null 2>&1 &
echo $! > "$PIDF"
echo "bootguard loop started (pid $!, PREFERRED_TREE=$PREFERRED_TREE, via bootwatch health gate)"
