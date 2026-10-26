#!/usr/bin/env bash
# restore-stack.sh — 抖音栈 VM 重启一键恢复（恢复套件 recovery-kit，2026-10-26）
#
# 背景：VM 整机更换会清掉 /root、/opt 和全部进程，~/workspace 持久。
# 本脚本封装既定恢复配方，幂等：健康的部分跳过，缺哪块补哪块。
# 注意：全栈健康时不要运行本脚本——bootguard 全流程里的 chat configure
# 会重建消息基线（有吞消息风险）；日常自愈由监督环 + bootwatch 健康门负责。
#
# 步骤：
#   0) 把 recovery/ 里的工具副本同步回 ~/workspace/douyin-fish/tools-x
#      （bootguard-loop.sh、ui_hook.sh 等脚本内部写死了 tools-x 路径，
#       新 VM 上只拉仓库时也必须先落回原位才能启动——见 README）
#   1) Edge：本机有 microsoft-edge 就跳过；否则优先裝 ~/workspace/edge-installer.deb，
#      没有本地包就从本仓库 recovery-kit-v1 Release 下载再装
#      （Release 资产 URL 见 EDGE_RELEASE_URL；该 Release 尚未上传成功时
#       本步会明确报错，请按 README 的微软官方办法先拿到 deb 放到上述路径）
#   2) pip install --break-system-packages python-xlib（ui_check/xshot/xclick 依赖）
#   3) 把本目录 bootguard.sh（本地适配版，含 EVENTS_FILE 覆盖）装到 /root/bootguard.sh
#   4) 以旧树口径跑 bootguard 全流程：PREFERRED_TREE=old + EVENTS_FILE 旧树事件文件 + UI_HOOK
#   5) 跑 bootguard-loop.sh 重挂监督环（120 秒一轮，经 bootwatch 健康门）
#   6) 重拉 list_pin（setsid + nohup 后台长跑，已在跑则跳过）
#   7) 从 agent /api/bootstrap 取新 token 存回 agent_token.txt（只报成功与否，绝不打印 token）
#   8) 自检并打印：桥 /health、agent bootstrap、私信 chat/state 是否 running

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_X="$HOME/workspace/douyin-fish/tools-x"
TOKEN_FILE="$HOME/workspace/douyin-fish/agent_token.txt"
EVENTS_FILE_PATH="$HOME/workspace/dsh-src/douyin/state/chat-events.jsonl"
EDGE_LOCAL_DEB="$HOME/workspace/edge-installer.deb"
EDGE_RELEASE_URL="https://github.com/baijiang-441/dsh-douyin-agent/releases/download/recovery-kit-v1/edge-installer.deb"
API_PORT="${API_PORT:-3218}"
BRIDGE_PORT="${BRIDGE_PORT:-3199}"

LOG() { echo "[$(date '+%F %T')] $*"; }
FAIL() { LOG "FAIL: $*"; exit "${2:-1}"; }

# ---------- 0) 同步工具副本回 tools-x ----------
LOG "步骤 0：同步 recovery/ 工具副本 → $TOOLS_X"
mkdir -p "$TOOLS_X"
for f in bootguard-loop.sh bootwatch.sh ui_hook.sh ui_check.py list_pin.mjs text_send.mjs sticker_send.mjs xshot.py xclick.py; do
  [ -f "$SCRIPT_DIR/$f" ] || FAIL "套件缺文件：$SCRIPT_DIR/$f" 10
  cp "$SCRIPT_DIR/$f" "$TOOLS_X/$f"
done
chmod +x "$TOOLS_X/bootguard-loop.sh" "$TOOLS_X/bootwatch.sh" "$TOOLS_X/ui_hook.sh" "$TOOLS_X/ui_check.py" "$TOOLS_X/xshot.py" "$TOOLS_X/xclick.py" 2>/dev/null || true
LOG "同步完成"

# ---------- 1) Microsoft Edge ----------
if command -v microsoft-edge >/dev/null 2>&1 || command -v microsoft-edge-stable >/dev/null 2>&1; then
  LOG "步骤 1：Edge 已安装，跳过"
else
  LOG "步骤 1：安装 Edge"
  if [ -f "$EDGE_LOCAL_DEB" ]; then
    LOG "使用本地安装包：$EDGE_LOCAL_DEB"
    dpkg -i "$EDGE_LOCAL_DEB" || FAIL "dpkg 安装本地 Edge 包失败" 11
  else
    LOG "本地无安装包，从 Release 下载：$EDGE_RELEASE_URL"
    curl -fL -o /tmp/edge-installer.deb "$EDGE_RELEASE_URL" \
      || FAIL "Release 下载失败（recovery-kit-v1 可能尚未上传）；请按 recovery/README.md 的微软官方办法下载 .deb 放到 $EDGE_LOCAL_DEB 后重跑" 12
    dpkg -i /tmp/edge-installer.deb || FAIL "dpkg 安装下载的 Edge 包失败" 13
  fi
  command -v microsoft-edge >/dev/null 2>&1 || command -v microsoft-edge-stable >/dev/null 2>&1 \
    || FAIL "Edge 安装后仍找不到可执行文件" 14
  LOG "Edge 安装完成"
fi

# ---------- 2) python-xlib ----------
if python3 -c "import Xlib" >/dev/null 2>&1; then
  LOG "步骤 2：python-xlib 已可用，跳过"
else
  LOG "步骤 2：pip 安装 python-xlib"
  pip install --break-system-packages python-xlib || FAIL "python-xlib 安装失败" 20
fi
python3 -c "import PIL" >/dev/null 2>&1 || pip install --break-system-packages pillow || LOG "WARN: pillow 安装失败，ui_check.py 可能无法运行"

# ---------- 3) 安装 bootguard 到 /root ----------
LOG "步骤 3：安装 bootguard.sh → /root/bootguard.sh"
[ -f "$SCRIPT_DIR/bootguard.sh" ] || FAIL "套件缺 bootguard.sh" 30
cp "$SCRIPT_DIR/bootguard.sh" /root/bootguard.sh && chmod +x /root/bootguard.sh || FAIL "复制 /root/bootguard.sh 失败（需要 root）" 31
grep -q 'EVENTS_FILE=' /root/bootguard.sh || LOG "WARN: /root/bootguard.sh 里没找到 EVENTS_FILE 适配行，旧树验证段可能验不过"

# ---------- 4) bootguard 全流程 ----------
LOG "步骤 4：跑 bootguard 全流程（PREFERRED_TREE=old）"
PREFERRED_TREE=old \
EVENTS_FILE="$EVENTS_FILE_PATH" \
UI_HOOK="$TOOLS_X/ui_hook.sh" \
  /root/bootguard.sh 2>&1 | tee -a /root/bootguard.log
BG_EXIT="${PIPESTATUS[0]}"
[ "$BG_EXIT" = 0 ] || FAIL "bootguard 全流程退出码 $BG_EXIT（查 /root/bootguard.log 与 agent.out.log）" 40
LOG "bootguard PASS"

# ---------- 5) 重挂监督环 ----------
LOG "步骤 5：重挂 bootguard 监督环"
bash "$TOOLS_X/bootguard-loop.sh" || LOG "WARN: 监督环启动脚本返回非零，请人工检查 /root/bootguard-loop.pid"

# ---------- 6) 重拉 list_pin ----------
# list_pin.mjs 本身是无限循环的守护脚本（钉列表最新端 + 每 15 秒全程遍历渲染），
# 启动方式就是 node 直接跑；这里用 setsid + nohup 脱离本脚本会话长跑，防连坐。
if pgrep -f "list_pin.mjs" >/dev/null 2>&1; then
  LOG "步骤 6：list_pin 已在跑，跳过"
else
  LOG "步骤 6：启动 list_pin"
  setsid nohup node "$TOOLS_X/list_pin.mjs" >> "$HOME/workspace/douyin-fish/list_pin.log" 2>&1 &
  sleep 2
  pgrep -f "list_pin.mjs" >/dev/null 2>&1 || LOG "WARN: list_pin 启动后未探到进程（agent 浏览器/CDP 未就绪时它会空转重试，可稍后看 list_pin.log）"
fi

# ---------- 7) 刷新 token ----------
LOG "步骤 7：从 /api/bootstrap 刷新 token（不打印内容）"
TOKEN="$(curl -s -m 5 "http://127.0.0.1:$API_PORT/api/bootstrap" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.token||"")}catch{console.log("")}})')"
if [ -n "$TOKEN" ]; then
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  LOG "token 已存回 $TOKEN_FILE"
else
  LOG "WARN: bootstrap 没拿到 token，agent_token.txt 未更新"
fi

# ---------- 8) 自检 ----------
LOG "步骤 8：自检"
if curl -s -o /dev/null -m 3 "http://127.0.0.1:$BRIDGE_PORT/health"; then
  LOG "桥 /health：OK (:$BRIDGE_PORT)"
else
  LOG "桥 /health：不通 (:$BRIDGE_PORT)"
fi
if curl -s -o /dev/null -m 3 "http://127.0.0.1:$API_PORT/api/bootstrap"; then
  LOG "agent bootstrap：OK (:$API_PORT)"
else
  LOG "agent bootstrap：不通 (:$API_PORT)"
fi
TOK="$(cat "$TOKEN_FILE" 2>/dev/null)"
STATE="$(curl -s -m 5 "http://127.0.0.1:$API_PORT/api/chat/state" -H "x-session-token: $TOK")"
case "$STATE" in
  *'"running":true'*) LOG "私信 chat/state：running ✓ 恢复完成" ;;
  *) LOG "私信 chat/state：未见 running:true，请查 $EVENTS_FILE_PATH 与 agent.out.log" ;;
esac
