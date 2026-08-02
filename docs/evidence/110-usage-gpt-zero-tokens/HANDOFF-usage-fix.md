# 交接：修复 HAPI 用量页 gpt 模型 token 恒为 0

交接时间：2026-08-02　交接人：上一个 Claude Code 会话（在 `C:\Users\Administrator\cx2cc` 目录下工作）
接手方：在 `C:\Users\Administrator\hapi` 目录下的 Claude Code 会话

**当前状态：代码改动已完成并通过完整验证（零回归），尚未部署。**
剩余工作是纯部署，见「五、剩余待办」。

---

## 一、问题与根因（已实测确认，不需要重新调查）

用量页显示 `gpt-5.6-sol` 有数千次请求但 token 数为 0。

因果链，每一环都有实测支撑：

| 环节 | Claude 官方来源 | gpt-5.6-sol（经 cx2cc 代理） |
|---|---|---|
| 上游 `message_start` 里的 usage | 真实 input/cache 数字 | **必然是 0**。cx2cc 必须在上游开口前就发出 `message_start`，而 OpenAI/Codex 只在流末尾才给 usage |
| Claude Code `assistant` 事件 | 继承 message_start → 真实 | `{"input_tokens":0,"output_tokens":0}` |
| Claude Code `result` 事件 | 真实 | **真实**（实测 `input_tokens: 24966`，且带 `modelUsage` 分模型明细） |
| HAPI 入库 | 只存 `assistant` | 只存 `assistant` |
| **库里的结果** | 32,060 行有真实数字 ✅ | **2,789 行全为 0** ❌ |

实测证据（可复现）：

```bash
# 1. 直接看 Claude Code 的 stream-json：assistant 事件 usage 全 0，result 事件才有真数
cd /tmp && ANTHROPIC_BASE_URL=http://100.97.242.41:8901 \
  ANTHROPIC_AUTH_TOKEN=<codex-bridge token> ANTHROPIC_MODEL=gpt-5.6-sol \
  claude -p "Reply with exactly: ok" --output-format stream-json --verbose --model gpt-5.6-sol

# 2. 直接查 hub 库确认 gpt 全 0、claude 正常
ssh ecs 'sqlite3 -readonly /root/.hapi/hapi.db' <<'SQL'
SELECT json_extract(content,'$.content.data.message.model') AS model, COUNT(*),
       SUM(COALESCE(json_extract(content,'$.content.data.message.usage.input_tokens'),0))
FROM messages
WHERE json_extract(content,'$.role')='agent'
  AND json_extract(content,'$.content.type')='output'
  AND json_extract(content,'$.content.data.type')='assistant'
GROUP BY model ORDER BY 2 DESC LIMIT 15;
SQL
```

**关键结论：真实用量在 HAPI 库里从来没有存在过。** 不是聚合口径错，是数据在入库前就被 `sdkToLogConverter.ts` 的 `case 'result'` 丢掉了（它只取了 `contextWindow`，扔掉 token 字段后 `break`，不产出任何日志行）。所以只改聚合端不可能修好。

**一个未解释项（不要当结论用）：** `gpt-5.5` 在库里有 268M input 被正确记录。它走的是已废弃的 tuzi 上游，路径与现在不同，我没有回溯验证，不排除当时是非流式或另一套代理。

---

## 二、已完成的代码改动（4 处，在工作区未提交）

基线 commit：`da7f91ac`。`git status` 应显示这 7 个文件被修改：

```
 M cli/src/claude/types.ts
 M cli/src/claude/utils/sdkToLogConverter.ts
 M cli/src/claude/utils/sdkToLogConverter.test.ts
 M fork-features/usage/usageAggregate.ts
 M fork-features/usage/usageAggregate.test.ts
 M shared/src/messages.ts
 M shared/src/messages.test.ts
```

1. **`cli/src/claude/utils/sdkToLogConverter.ts`** — `case 'result'` 新增产出 `usage_report` 帧（携带 `modelUsage`）；并把该类型排除出父链（与 `summary` 同列），否则会在会话回复链里插入一个 UI 永不渲染的节点，让下一条真实消息认错父节点。

2. **`shared/src/messages.ts`** — 把 `usage_report` 登记进 `NON_CHAT_CLAUDE_MESSAGE_TYPES`。
   **这一条是必须的**：该集合是黑名单，`isClaudeChatVisibleMessage` 对非 system 类型一律 `return true`，漏登记就会被当普通消息渲染成一坨原始 JSON（正是 converter 顶部注释警告过的坑）。
   它只挡「导出/渲染」（hub 侧过滤在 `isExportVisibleStoredMessage`），**不挡入库**，所以统计仍读得到。

3. **`cli/src/claude/types.ts`** — `RawJSONLinesSchema` 加 `usage_report` 变体，保持本地/远程两条路径同构。

4. **`fork-features/usage/usageAggregate.ts`** — 新增 `queryUsageReportTotals()` + `mergeUsageReportFallback()`。
   **硬约束：按模型「择一替换」而非相加。** 每个会话都会产出 `result`，Claude 模型两侧都有数，相加会让所有官方来源数字翻倍。只在 assistant 侧全零时回退，Claude 数字逐位不变。`requestCount` 始终取 assistant 侧（它才是 API 轮次）。

### 一个已验证的关键事实

**`result.modelUsage` 是「每轮」而非「整会话累计」**，所以聚合端 SUM 是正确的。
验证方法（同会话两轮）：

```bash
claude -p "..." --output-format json                       # 轮1: inputTokens 24958
claude -p --resume <session-id> "..." --output-format json # 轮2: inputTokens 24971（不是累计 49929）
```

---

## 三、验证结果（已全部完成，零回归）

每一项都用 `git stash` 做了**基线对照**，不是凭经验判断：

| 套件 | 带改动 | 基线 | 结论 |
|---|---|---|---|
| `bun run test:shared` | 164 pass / 0 fail | — | ✅ |
| `bun run test:web` | 218 个测试文件全过 | — | ✅ |
| `bun run test:hub` | 786 pass / 9 fail | 785 pass / 10 fail | 失败集合逐行 diff：**「仅带改动时失败」为空**；三次跑批计数在 9/10/11 漂移 → 这批测试本身 flaky |
| `bun run test:cli` | 172 文件过 / 3 失败 | **同样这 3 个失败** | ✅ 零回归 |
| `typecheck:cli` / `typecheck:hub` | exit 0 | — | ✅ |
| `typecheck:web` | 1 error（`useViewportHeight.test.ts`） | **同样 1 error** | ✅ 零回归 |

**既有失败清单（与本次改动无关，别去修）：** hub 侧在 ACP 探针 PATH / Cursor 迁移 / Store schema 迁移；cli 侧在 `apiMachine.test.ts`、`runner.integration.test.ts`、`validateWorkspaceDirectory.test.ts`。多为 Windows 文件系统相关；`runner.integration` 那几条还受本机正在运行的真实 runner 干扰。

**端到端验证（最有力的一条）：** 用真实形态的 SDK 事件走 converter → Store → 聚合，复原出
`{requestCount: 2, inputTokens: 49929, outputTokens: 10, cacheReadInputTokens: 22272}`，
与上面两轮实跑的 24,958 + 24,971 精确吻合；同时确认 `usage_report chat-visible? false`。

### ☠️ 最重要的一条：不要跑 `bun run test:cli`（会杀掉本机 runner）

**测试已经全部跑完了，你不需要再跑一遍。如果非要跑，必须排除 `runner.integration.test.ts`。**

`cli/src/runner/runner.integration.test.ts` 文件开头明确写着：

```
DO NOT run with regular 'npm test' or 'yarn test' - it will use the wrong environment
The integration test environment uses .env.integration-test which sets:
- HAPI_HOME=~/.hapi-dev-test (DIFFERENT from dev's ~/.hapi-dev!)
```

但仓库自带的 `bun run test:cli` **会把它一起跑**。缺少那个专用环境时，它读的是**真实的 `~/.hapi`**，
而其中包含 `stopRunner` / `killProcess` / 「should detect version mismatch and **kill old runner**」
这类操作——于是它把本机正在服务的 runner 当作「旧 runner」杀掉。

**这已经真实发生过一次**（2026-08-02 00:58:53）：交接方跑 `test:cli` 后本机 runner 被强杀，
用户随即无法新建会话。证据是 runner 日志在该时刻**无任何正常关闭记录**地中断、心跳停在 00:59:37、
`hapi runner status` 报 "Runner is not running"。已用下面的命令恢复（版本保持 0.23.3 不变）：

```bash
cd /c/Users/Administrator && \
HAPI_RELAY_FORCE_TCP=true \
HAPI_CLAUDE_PATH='C:\Users\Administrator\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe' \
hapi runner start --workspace-root 'C:\Users\Administrator'
```

验收不要只看 "Runner started successfully"（弱信号）。要看 `hapi runner status` 显示 running，
**并等 `~/.hapi/runner.state.json` 的 `lastHeartbeat` 出现且在推进**（约 1 分钟一次），
确认它不是起来就僵死。

若确实需要跑 CLI 测试，排除掉那个文件：
```bash
cd cli && NODE_OPTIONS="--max-old-space-size=6144" npx vitest run \
  --pool=forks --no-file-parallelism --exclude '**/runner.integration.test.ts'
```

### 跑测试时的另外两个坑（不是代码问题）

- **OOM**：本机 16GB 内存、常只剩 ~6.7GB。`test:cli` 和 `typecheck:web` 直接跑会以 `exit 134` + `FATAL ERROR: Zone Allocation failed - process out of memory` 崩溃。
  解法：加 `NODE_OPTIONS="--max-old-space-size=6144" --pool=forks --no-file-parallelism`，且**不要与其他构建/测试并跑**。
- vitest 该版本**不支持** `--poolOptions` 参数（会报 `CACError: Unknown option`）。用 `--no-file-parallelism`。

---

## 四、部署目标与现状

| 组件 | 位置 | 当前版本 | 作用 |
|---|---|---|---|
| hub | ECS `101.133.153.229`（`ssh ecs`），systemd `hapi-hub.service` | 0.25.1 | 跑聚合查询（改动 4） |
| runner/CLI | vircs 本机，npm 全局 `C:\Users\Administrator\AppData\Roaming\npm\hapi` | **0.23.3** | 产出 `usage_report` 帧（改动 1~3） |

真实二进制路径（`/usr/bin/hapi` 只是软链到启动器，启动器再 exec 平台包）：

```
ECS: /usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi   （144MB 编译产物）
```

该目录下已有大量 `hapi.pre-*` / `hapi.old-*` 备份，说明**就地替换二进制 + 重启**是这台机器上成熟的既有流程。systemd 配了 `Restart=always`。

**⚠️ 只更新 hub 不会有任何效果。** 产出数据的是 CLI（converter），不是 hub。vircs 的 runner 停在 0.23.3，必须一并升级到含本改动的版本，否则库里依旧没有 `usage_report` 行，用量页仍是 0。这是一次跨两个小版本的升级，风险独立于 hub，需单独评估。

---

## 五、剩余待办

### 已完成的构建产物

linux-x64 hub 二进制**已交叉编译成功**，可直接用：

```
本地路径: C:\Users\Administrator\hapi\cli\dist-exe\bun-linux-x64-baseline\hapi
大小:     144,472,192 bytes
SHA256:   14fe1bd0bb643651882f5fb30a8be925aea95b15d824682906eea9b3945bd34d
```

构建命令（如需重建）：

```bash
cd /c/Users/Administrator/hapi
bun run build:web && (cd hub && bun run generate:embedded-web-assets)
cd cli && bun run scripts/build-executable.ts --target bun-linux-x64-baseline --with-web-assets
```

### 待办 1：上传并校验（**未开始，由你从零执行**）

交接方已把 ECS 上的 `/tmp/hapi.usage-fix` **彻底删除**（两次半途中断的残留都已清掉），
也停掉了自己那边的后台 scp。**现在 ECS 上没有任何相关文件，不存在并发写入冲突，你直接开传即可。**

**这条链路极慢且不稳定**：实测第一次 10 分钟传了 79MB，第二次几分钟只到 18MB。
**务必放后台，并以 SHA256 而不是「命令退出了」作为完成判据** —— 前两次都是命令被终止后
留下半截文件，只看 `ls` 的大小会被骗过去。

```bash
scp /c/Users/Administrator/hapi/cli/dist-exe/bun-linux-x64-baseline/hapi ecs:/tmp/hapi.usage-fix

# 完成判据（必须逐字相等）
ssh ecs 'sha256sum /tmp/hapi.usage-fix'
# 必须等于 14fe1bd0bb643651882f5fb30a8be925aea95b15d824682906eea9b3945bd34d
ssh ecs 'chmod +x /tmp/hapi.usage-fix && /tmp/hapi.usage-fix --version'   # 应输出 0.25.1
```

进度可随时查：`ssh ecs 'stat -c%s /tmp/hapi.usage-fix'`（目标 144472192）。
若中途失败要重传，**先 `ssh ecs 'rm -f /tmp/hapi.usage-fix'` 删干净再传**，避免 scp 续写出坏文件。

### 待办 2：备份 + 替换 + 重启 hub

**⚠️ 这一步会中断正在通过该 hub 进行的会话。** 需先向用户确认时机。

```bash
ssh ecs '
  set -e
  BIN=/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi
  cp -p "$BIN" "$BIN.pre-usagefix-$(date +%Y%m%d-%H%M%S)"
  install -m 750 -o root -g root /tmp/hapi.usage-fix "$BIN"
  systemctl restart hapi-hub
  sleep 5; systemctl is-active hapi-hub
'
```

回滚：把对应的 `hapi.pre-usagefix-*` 拷回原路径再 `systemctl restart hapi-hub`。

**注意：`systemctl is-active` 返回 active 不算验收**（启动成功 ≠ 行为正确）。必须用待办 4 的实际数据验证。

### 待办 3：升级 vircs 的 runner（**这一步才让数据真正产生**）

**产物已编好，勘察已完成**（2026-08-02 补充）：

```
本地路径: C:\Users\Administrator\hapi\cli\dist-exe\bun-windows-x64\hapi.exe
大小:     150,233,088 bytes
SHA256:   caffc1f5e2d0ae65d2a311cd3bc75035dc4ee24a120ce16bfa1d20511f4cf2c4
自检:     ./hapi.exe --version → "hapi version: 0.25.1"（现役为 0.23.3）
```

构建命令（如需重建）：
```bash
cd /c/Users/Administrator/hapi/cli
bun run scripts/build-executable.ts --target bun-windows-x64 --with-web-assets
```

**目标路径**（布局与 ECS 同构，已实测确认）：
```
C:\Users\Administrator\AppData\Roaming\npm\node_modules\@twsxtd\hapi\node_modules\@twsxtd\hapi-win32-x64\bin\hapi.exe
```

**这台机器的既有手法就是「就地替换二进制」**，证据有两条：
- 同目录已有备份 `hapi.exe.pre-health-20260727-1010`；
- `@twsxtd/hapi` 的 `package.json` 仍写着 **0.18.4**，而 `hapi --version` 是 **0.23.3** —— 版本号是陈旧的，说明历来只换 exe、不走 npm 安装。**因此不要用 `npm i -g` 去升级**，那会把这台机器上历次的定制改动一起冲掉。

**⚠️ Windows 文件锁——这是本步最容易踩的坑：**
实测当前有 **7 个 hapi.exe 进程**正从该路径运行（`Get-Process hapi`）。Windows 会锁定正在运行的可执行文件映像，**直接 `cp` 覆盖必定失败**。可行做法是「先改名、再放新文件」（Windows 允许重命名正在运行的 exe）：

```powershell
$bin = "C:\Users\Administrator\AppData\Roaming\npm\node_modules\@twsxtd\hapi\node_modules\@twsxtd\hapi-win32-x64\bin\hapi.exe"
Rename-Item $bin "hapi.exe.pre-usagefix-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item "C:\Users\Administrator\hapi\cli\dist-exe\bun-windows-x64\hapi.exe" $bin
```
换完后需重启 runner 让新二进制生效（重启方式请自行确认，见下）。

**⚠️ 重启 runner 可能中断正在进行的会话**（包括执行这次部署的那个会话自身）——请先与用户确认时机。

**重启 runner 的正确命令**（就是本机既有的 `~/.hapi/start-runner.bat` 里那条，务必带上两个环境变量）：

```bash
cd /c/Users/Administrator && \
HAPI_RELAY_FORCE_TCP=true \
HAPI_CLAUDE_PATH='C:\Users\Administrator\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe' \
hapi runner start --workspace-root 'C:\Users\Administrator'
```

验收：`hapi runner status` 显示 running，**且** `~/.hapi/runner.state.json` 的 `lastHeartbeat`
出现并在推进。刚启动时 `lastHeartbeat` 会是 null，要等一个周期（约 1 分钟）；
只看 "Runner started successfully" 不算验收。

**runner 状态文件可能陈旧，别直接信它。** 2026-08-02 恢复前它还记着一个早已不存在的
`pid 15312`。真实在跑的进程用 `hapi runner status` 或 `Get-Process hapi` 看。

**⚠️ 本机还有若干 7/27–7/29 启动的老 hapi.exe 进程**（`Get-Process hapi` 可见）。新 runner
未必接管得了它们。如果换完二进制、重启 runner 后新建会话仍异常，先查这些孤儿进程。

### 待办 4：端到端验收（唯一能证明修好的证据）

1. 通过 HAPI 起一个 gpt-5.6-sol 会话，跑至少两轮。
2. 确认库里出现了 `usage_report` 行：

```bash
ssh ecs 'sqlite3 -readonly /root/.hapi/hapi.db "
SELECT COUNT(*) FROM messages
WHERE json_extract(content,''\$.content.data.type'')=''usage_report'';"'
```

3. 确认用量页/接口给出非零数字：`GET /api/usage/summary`，`gpt-5.6-sol` 的 `inputTokens > 0`。
4. **回归确认：Claude 官方来源的数字没有翻倍**（拿升级前后同一时间窗的 `claude-opus-4-8` 等模型对比）。

---

## 六、必须知道的限制

- **历史数据不可追回。** `result` 事件从未落库，那 2,789 行 gpt 记录的真实 token 已永久缺失。修复只对**新产生**的会话生效。
- **本地启动器路径不受益。** 它读 transcript，而 transcript 里没有 `result` 事件。不过 hub 库里那些带 `context_window` 的 gpt 行只可能出自 converter（SDK 远程路径），正是本次覆盖的路径；若将来有走本地路径的 gpt 会话，仍会是 0，需另做。
- **代码尚未提交。** 工作区还有两个无关的未跟踪文件 `NUL` 和 `hapi-file-for-you.md`，提交时注意别带上。
