#!/usr/bin/env bash
# 监督环的健康门：全栈健康就安静退出，绝不对活着的服务跑 bootguard 全流程
# （实测：对运行中的私信服务调 configure 会 service.stopped 重建基线，可能吞消息）。
# 任一不健康才调用 /root/bootguard.sh 做完整自愈。
set -u
TOK_FILE="$HOME/workspace/douyin-fish/agent_token.txt"

curl -s -o /dev/null -m 3 http://127.0.0.1:3199/health || { /root/bootguard.sh; exit $?; }
curl -s -o /dev/null -m 3 http://127.0.0.1:3218/api/bootstrap || { /root/bootguard.sh; exit $?; }

TOK="$(cat "$TOK_FILE" 2>/dev/null)"
if [ -n "$TOK" ]; then
  STATE="$(curl -s -m 5 http://127.0.0.1:3218/api/chat/state -H "x-session-token: $TOK")"
  case "$STATE" in
    *'"running":true'*) exit 0 ;;
  esac
fi
# token 失效或私信没在跑：交给 bootguard（它会重新 bootstrap 并 configure/start）
/root/bootguard.sh
