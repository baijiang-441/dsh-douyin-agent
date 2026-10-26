#!/usr/bin/env bash
# bootguard.sh — dsh 抖音栈一键拉起/自愈看门狗（ng 2026-10-26，GLM 交付）
#
# 解决的问题：平台经常重启 VM、清掉全部进程；之前 20 分钟一次的 Muse 侧重试任务
# 自己超时被平台连坐清理时，会把它拉起的子进程一起带走。
#
# 设计要点：
#   1) 幂等：Xvfb / 桥 / agent 已在跑就直接跳过，缺哪块补哪块；
#   2) 分离进程组：所有常驻进程用 setsid 启动，脱离本脚本与 crontab 的进程组，
#      看门狗自己被清理也不会连带杀死栈（这是之前「连坐」事故的根因修复）；
#   3) 健康探测优先：agent 探 /api/health（ng 树），没有就退回 /api/bootstrap；
#      端口被另一棵树占着就按内置让位逻辑等待，不抢；
#   4) 每一步都有明确日志与阶段退出码，方便事后查 bootguard.log。
#
# 安装（VM 上，root）：
#   cp bootguard.sh /root/ && chmod +x /root/bootguard.sh
#   crontab -e 加一行（每 2 分钟兜底）：
#     */2 * * * * /root/bootguard.sh >> /root/bootguard.log 2>&1
#   若 VM 的 crontab 也会被清，用分离监督环代替（跑一次即可，自成会话）：
#     setsid bash -c 'while true; do /root/bootguard.sh >/dev/null 2>&1; sleep 120; done' >/dev/null 2>&1 &
#
# 可用环境变量覆盖所有路径/参数（见下）。

set -u

BRIDGE_DIR="${BRIDGE_DIR:-$HOME/workspace/dsh-bridge}"
BRIDGE_PORT="${BRIDGE_PORT:-3199}"
OLD_TREE="${OLD_TREE:-$HOME/workspace/dsh-src/douyin}"
NEW_TREE="${NEW_TREE:-$HOME/workspace/douyin-ng}"
PREFERRED_TREE="${PREFERRED_TREE:-new}"            # new | old：优先拉哪棵；另一棵活着就让它服务
API_PORT="${API_PORT:-3218}"
DISPLAY_NUM="${DISPLAY_NUM:-:99}"
XVFB_SIZE="${XVFB_SIZE:-1280x900x24}"
DATA_DIR="${DATA_DIR:-$HOME/.dsh/douyin-browser}"
EVENTS_FILE="${EVENTS_FILE:-$HOME/workspace/dsh-src/douyin/state/chat-events.jsonl}"
WHITELIST_CONV="${WHITELIST_CONV:-conv:e9fc4edcd1d689166af2369717904340139467306320e9c801f8d766977ec251}"
UI_HOOK="${UI_HOOK:-}"                              # 可选：弹窗处理脚本（关 Restore 气泡等），存在才执行
LOG() { echo "[$(date '+%F %T')] $*"; }

http_up() { # 任意 HTTP 响应即算活（旧树没有 /api/health）
  curl -s -o /dev/null -m 3 "http://127.0.0.1:$1$2" && return 0 || return 1
}
wait_http() { # wait_http 端口 路径 超时秒
  local i; for i in $(seq 1 "$3"); do http_up "$1" "$2" && return 0; sleep 1; done; return 1
}

# ---------- 1) Xvfb ----------
if pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null 2>&1; then
  LOG "Xvfb 已在跑"
else
  LOG "启动 Xvfb $DISPLAY_NUM ($XVFB_SIZE)"
  setsid Xvfb "$DISPLAY_NUM" -screen 0 "$XVFB_SIZE" -nolisten tcp >/dev/null 2>&1 &
  sleep 1
  pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null 2>&1 || { LOG "FAIL: Xvfb 起不来"; exit 10; }
fi

# ---------- 2) 桥（OpenAI 兼容端点） ----------
if wait_http "$BRIDGE_PORT" "/v1/models" 1; then
  LOG "桥已在跑 (:$BRIDGE_PORT)"
else
  [ -d "$BRIDGE_DIR" ] || { LOG "FAIL: 桥目录不存在 $BRIDGE_DIR"; exit 20; }
  LOG "启动桥 (:$BRIDGE_PORT)"
  ( cd "$BRIDGE_DIR" && setsid nohup node bridge.mjs >> bridge.out.log 2>&1 & )
  wait_http "$BRIDGE_PORT" "/v1/models" 15 || { LOG "FAIL: 桥 15 秒内未响应"; exit 21; }
fi

# ---------- 3) agent（优先树，端口被占则让位） ----------
agent_tree=""
if http_up "$API_PORT" "/api/health" || http_up "$API_PORT" "/api/bootstrap"; then
  LOG "agent 已在跑 (:$API_PORT)，让位不重复拉起"
else
  pick_tree() { [ "$PREFERRED_TREE" = "new" ] && { [ -d "$NEW_TREE" ] && echo "$NEW_TREE" || echo "$OLD_TREE"; } || { [ -d "$OLD_TREE" ] && echo "$OLD_TREE" || echo "$NEW_TREE"; }; }
  agent_tree="$(pick_tree)"
  [ -d "$agent_tree" ] || { LOG "FAIL: 两棵树目录都不存在"; exit 30; }
  LOG "启动 agent：$agent_tree"
  # 清掉残留的 persona 写锁（>120 秒的一律视为死锁；ng 树自身也会自愈，双保险）
  find "$DATA_DIR/memory/persona" -name '.write.lock' -mmin +2 -delete 2>/dev/null
  ( cd "$agent_tree" && DISPLAY="$DISPLAY_NUM" DEEPSEEK_API_KEY=fish-bridge \
      DEEPSEEK_BASE_URL="http://127.0.0.1:$BRIDGE_PORT" DOUYIN_MODEL=guoguo \
      setsid nohup node app.mjs >> agent.out.log 2>&1 & )
  ok=0
  for i in $(seq 1 30); do
    http_up "$API_PORT" "/api/health" && ok=1 && break
    http_up "$API_PORT" "/api/bootstrap" && ok=1 && break
    sleep 2
  done
  [ "$ok" = 1 ] || { LOG "FAIL: agent 60 秒内未就绪（看 $agent_tree/agent.out.log；若存储探针 exit 78 说明写隔离又来了）"; exit 31; }
  LOG "agent 就绪 (:$API_PORT)"
fi

# ---------- 4) 取 token、开浏览器、起私信 ----------
TOKEN="$(curl -s -m 5 "http://127.0.0.1:$API_PORT/api/bootstrap" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.token||"")}catch{console.log("")}})')"
[ -n "$TOKEN" ] || { LOG "FAIL: bootstrap 没拿到 token"; exit 40; }
LOG "token 已取得"

curl -s -m 60 -X POST "http://127.0.0.1:$API_PORT/api/browser/open" \
  -H "x-session-token: $TOKEN" -H 'content-type: application/json' -d '{}' >/dev/null || true
LOG "browser/open 已请求"

if [ -n "$UI_HOOK" ] && [ -x "$UI_HOOK" ]; then
  LOG "执行 UI 钩子：$UI_HOOK（关 Restore 气泡等）"
  "$UI_HOOK" || LOG "WARN: UI 钩子返回非零，气泡可能需要人工看一眼"
else
  LOG "WARN: 未配置 UI_HOOK——首次拉起后请截屏确认 Edge 的 Restore 气泡已关（只点 X）"
fi

# configure/start 的 HTTP 响应经常超时，不作为成败依据，以事件日志为准
curl -s -m 90 -X POST "http://127.0.0.1:$API_PORT/api/chat/configure" \
  -H "x-session-token: $TOKEN" -H 'content-type: application/json' \
  -d "{\"recipientIds\":[\"$WHITELIST_CONV\"],\"allowConversationOnly\":true}" >/dev/null || true
curl -s -m 90 -X POST "http://127.0.0.1:$API_PORT/api/chat/start" \
  -H "x-session-token: $TOKEN" -H 'content-type: application/json' -d '{}' >/dev/null || true
LOG "chat configure/start 已请求"

# ---------- 5) 验证 ----------
for i in $(seq 1 30); do
  if tail -n 50 "$EVENTS_FILE" 2>/dev/null | grep -q 'service.started'; then
    LOG "PASS: 全栈就绪（Xvfb + 桥 + agent + 私信 service.started）"
    exit 0
  fi
  sleep 2
done
LOG "FAIL: 60 秒内未见 service.started（查 $EVENTS_FILE 与 agent.out.log）"
exit 50
