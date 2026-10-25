# ng 重建构建说明（2026-10-26）

- 基线：上游 LockyBee/dsh-douyin-agent v1.4.5（提交 17676b0）。
- 提交 1：重放 2026-10-25 的五个本地补丁（chat 水位 v2.2 / persona 截断 / bringToFront / watch 并入 listen）。
- 提交 2：ng 健壮性层（lib/store.mjs、lib/guards.mjs、/api/health、启动存储探针、端口仲裁、chat 看门狗、listen 25 秒硬预算、15 个单测）。
- 提交 3：ng 修正（v2 水位吸收不再吞掉生成期间新到的 incoming；persona 写入保持上游事务契约；两处上游测试随 v2 语义更新）。
- 提交 5（2026-10-26 凌晨，回应鱼实测反馈）：恢复水位判定的时序护栏（chronology 非 oldest-first 即拦）；chat-browser 两条发送安全测试随 v2.2 语义更新（尾部新消息放行）；package.json files 补 lib/guards.mjs、lib/store.mjs、NG-BUILD.md、tests/ng-guards.test.mjs；私信上下文窗口 12→24 条（chat-agent + chat-service 两处）；新增 /api/agent/command、/api/agent/commands、/api/agent/command/ack 本机命令收件端点（command-inbox.jsonl 队列，token 鉴权，经存储层落盘）。
- 本树由 GLM 在独立环境从上游克隆构建，全程未接触旧目录 ~/workspace/dsh-src/douyin 的任何文件。
- 污点假说缓解：新目录部署 + 本文件与 lib/ 新文件使内容集与旧树不同；如需进一步差异化，
  可执行 `for f in *.mjs lib/*.mjs; do printf '\n// ng-build %s\n' "$(date +%Y%m%d)" >> "$f"; done`。
