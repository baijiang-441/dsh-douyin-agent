#!/usr/bin/env bash
# 监督环的健康门：全栈健康就安静退出，绝不对活着的服务跑 bootguard 全流程
# （实测：对运行中的私信服务调 configure 会 service.stopped 重建基线，可能吞消息）。
# 任一不健康才调用 /root/bootguard.sh 做完整自愈。
set -u
TOK_FILE="$HOME/workspace/douyin-fish/agent_token.txt"

curl -s -o /dev/null -m 3 http://127.0.0.1:3199/health || { /root/bootguard.sh; exit $?; }
curl -s -o /dev/null -m 3 http://127.0.0.1:3218/api/bootstrap || { /root/bootguard.sh; exit $?; }

chat_running() { # $1=token；私信在跑返回 0
  local state
  state="$(curl -s -m 5 http://127.0.0.1:3218/api/chat/state -H "x-session-token: $1")"
  case "$state" in
    *'"running":true'*) return 0 ;;
    *) return 1 ;;
  esac
}

TOK="$(cat "$TOK_FILE" 2>/dev/null)"
if [ -n "$TOK" ] && chat_running "$TOK"; then
  exit 0
fi
# 走到这里有两种可能：私信真没在跑，或 token 已被 agent 换代（重启即换）。
# 先去 bootstrap 取新 token 存回再判一次——绝不拿旧 token 误判不健康、
# 白跑一轮 bootguard 全流程（2026-10-26 实测教训：多停启一次＋重建基线）。
NEWTOK="$(curl -s -m 5 http://127.0.0.1:3218/api/bootstrap | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.token||"")}catch{console.log("")}})' 2>/dev/null)"
if [ -n "$NEWTOK" ] && [ "$NEWTOK" != "$TOK" ]; then
  printf '%s' "$NEWTOK" > "$TOK_FILE" 2>/dev/null || true
  if chat_running "$NEWTOK"; then
    exit 0
  fi
fi
# token 刷新后仍不在跑：交给 bootguard（它会重新 bootstrap 并 configure/start）
/root/bootguard.sh
