# 抖音栈 VM 重启恢复套件（recovery/）

## 用途

这台 VM 会被整机更换：`/root`、`/opt` 和全部进程会被清空，而 `~/workspace` 是持久的。
抖音栈（Xvfb + 大脑桥 3199 + agent 3218 + Edge + 私信服务）每次更换后都要按同一套配方手工恢复，
本套件把这套配方打包进仓库，下次整机更换后拉下仓库跑一次脚本即可恢复，不用再翻聊天记录找步骤。

恢复口径（2026-10-26 爸爸定）：栈被重启带倒时，按老配方直接恢复、恢复完报结果，不用每次现问。

## 内容清单

| 文件 | 说明 |
|---|---|
| `restore-stack.sh` | 一键恢复脚本（步骤见下），幂等 |
| `bootguard.sh` | 本地适配版：相比仓库 `tools/bootguard.sh` 原件，多了 `EVENTS_FILE` 环境变量覆盖（默认指向旧树事件文件），验证段改用 `$EVENTS_FILE`。仓库 `tools/` 原件不动 |
| `bootguard-loop.sh` | 监督环启动器：setsid 自成会话，120 秒一轮调 `bootwatch.sh` |
| `bootwatch.sh` | 健康门：全栈健康就安静退出，任一不健康才调 `/root/bootguard.sh` 全流程（避免对活着的服务 configure 重建基线吞消息） |
| `ui_hook.sh` / `ui_check.py` | bootguard 的 UI 钩子：检测 Edge「Restore pages」气泡（标题带亮度采样），有才点 X 关掉，绝不点 Restore |
| `list_pin.mjs` | 私信列表守护：钉最新端 + 每 15 秒全程遍历逐段停 2.6 秒，逼虚拟列表每段都渲染进快照（连发丢消息 P0 修复件）。本身是无限循环，启动方式就是 `node list_pin.mjs` 长跑 |
| `text_send.mjs` | 手动补发私信：最多 3 次尝试（退避 8s/20s），重发前回读防重复，`found:true` 才算送达，全败打印 `TEXT_SEND_FINAL_FAILURE` 并非 0 退出 |
| `sticker_send.mjs` | 按名字发抖音表情包：`node sticker_send.mjs "表情名"`，缺省「吹泡泡」 |
| `xshot.py` / `xclick.py` | X11 截图 / 拟人轨迹点击（依赖 python-xlib、Pillow） |

## 与 tools-x 的关系（重要）

`recovery/` 是**可随仓库搬运的副本**；运行时实际用的是 `~/workspace/douyin-fish/tools-x/` 里的那份。
原因是 `bootguard-loop.sh`、`bootwatch.sh`、`ui_hook.sh` 内部写死了 tools-x 的绝对路径。
所以 `restore-stack.sh` 的第 0 步会先把 `recovery/` 的副本同步回 tools-x 再启动；
反过来，tools-x 里的脚本有了改进，记得拷回 `recovery/` 并提交，别让两边长期分叉。

## 恢复步骤

```bash
git clone -b recovery-kit-20261026 https://github.com/baijiang-441/dsh-douyin-agent.git
# 已有克隆则 git pull
bash recovery/restore-stack.sh
```

脚本依次做：

1. 同步 `recovery/` 工具副本回 `~/workspace/douyin-fish/tools-x/`
2. 装 Edge：本机已装则跳过；否则优先装 `~/workspace/edge-installer.deb`，没有就从本仓库 `recovery-kit-v1` Release 下载再装（见下节说明）
3. `pip install --break-system-packages python-xlib`
4. `cp recovery/bootguard.sh /root/bootguard.sh && chmod +x`
5. 以 `PREFERRED_TREE=old`、`EVENTS_FILE=$HOME/workspace/dsh-src/douyin/state/chat-events.jsonl`、`UI_HOOK=$HOME/workspace/douyin-fish/tools-x/ui_hook.sh` 跑 `/root/bootguard.sh` 全流程
6. 从 `GET http://127.0.0.1:3218/api/bootstrap` 取新 token 存回 `~/workspace/douyin-fish/agent_token.txt`（脚本只报成功与否，绝不打印 token；必须排在下一步之前——`bootwatch.sh` 靠这个文件判活，拿旧 token 会误判不健康、多跑一轮恢复并多停启一次服务）
7. 跑 `bootguard-loop.sh` 重挂监督环
8. 重拉 `list_pin`（`setsid nohup node list_pin.mjs`，已在跑则跳过）
9. 自检打印：桥 `http://127.0.0.1:3199/health`、agent bootstrap、私信 `chat/state` 是否 `running`

手动分步恢复也可以照上面顺序逐条执行，命令都在 `restore-stack.sh` 里。

## 环境变量说明

`restore-stack.sh` / `bootguard.sh` 认这些变量（括号里是恢复时的取值）：

- `PREFERRED_TREE`（`old`）：优先拉哪棵树；切换到新树（10-28）后改 `new`，同时把 `EVENTS_FILE` 改指新树事件文件、`bootguard-loop.sh` 里的一行同步改
- `EVENTS_FILE`（`$HOME/workspace/dsh-src/douyin/state/chat-events.jsonl`）：旧树事件文件在树内 `state/`，不在默认的 `~/.dsh` 路径下，验证 `service.started` 必须看这个文件
- `UI_HOOK`（`$HOME/workspace/douyin-fish/tools-x/ui_hook.sh`）：关 Restore 气泡的钩子
- bootguard 自带：`BRIDGE_DIR`、`BRIDGE_PORT`（3199）、`API_PORT`（3218）、`OLD_TREE`、`NEW_TREE`、`DATA_DIR`（`~/.dsh/douyin-browser`）、`DISPLAY_NUM`（`:99`）、`WHITELIST_CONV`（私信白名单会话）

## day3 冻结提醒（2026-10-27）

2026-10-27 是抖音火花 day3，**全天冻结**：`chat-service`、哨兵提示词、`list_pin` 一律不改代码。
栈若倒，只准用本套件恢复、不许借恢复之名改任何逻辑；恢复后保至少一次私信往来不断。

## Edge 安装包说明

本地存档 `~/workspace/edge-installer.deb` 约 191M（200,086,994 字节），超过 GitHub git 单文件 100M 上限，
**不进 git**，原计划放本仓库 Release `recovery-kit-v1`。

2026-10-26 本次上传尝试结果：**Release 上传失败**。本机 `gh` CLI 未登录，原样报错：

```text
To get started with GitHub CLI, please run:  gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.
```

在 Release 补传成功之前，Edge 安装包用微软官方办法获取：

- 官网下载页 <https://www.microsoft.com/edge/download> 选 Linux (.deb) 下载，放到 `~/workspace/edge-installer.deb` 再跑脚本；或
- 微软官方 apt 仓库法：

  ```bash
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > /tmp/microsoft.gpg
  install -o root -g root -m 644 /tmp/microsoft.gpg /usr/share/keyrings/microsoft.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/edge stable main" > /etc/apt/sources.list.d/microsoft-edge.list
  apt-get update && apt-get install -y microsoft-edge-stable
  ```

日后在已登录 `gh` 的机器上可补传（传完把本节改回 Release 链接）：

```bash
gh release create recovery-kit-v1 ~/workspace/edge-installer.deb \
  --repo baijiang-441/dsh-douyin-agent \
  --title "recovery-kit-v1" \
  --notes "抖音栈 VM 重启恢复套件：Microsoft Edge 安装包，配合 recovery/restore-stack.sh 使用。"
```

补传后脚本里的下载地址即生效：
`https://github.com/baijiang-441/dsh-douyin-agent/releases/download/recovery-kit-v1/edge-installer.deb`

## 不包含私密数据（声明）

本目录只含脚本与说明，**不包含任何私密数据**：没有 `agent_token.txt` 的内容、没有 `history.jsonl`、
没有桥的 `pending/`、没有 `diary.md` 与任何对话笔记本/聊天记录、没有 `chat-watermarks.json`、
没有 `bank.json`、没有任何 `.env`、密钥或凭据。脚本里出现的只是这些文件的**路径**，不是内容。
提交前已逐个核对文件清单，并 grep 检查过待提交文件不含 token 字符串与手机号/QQ 号等隐私信息。
