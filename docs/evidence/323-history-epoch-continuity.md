# #323 阅读连续性：epoch 变化不再替换历史窗口 —— 复现与验证记录（2026-09-06）

对应 mouriya-s-lab/hapi#323 的机制 1（epoch 变化导致整窗被 latest 替换）与机制 2（运行中占位 ID 每次换新）。
本记录只写本轮真正执行并观测到的结果；未执行的项明确标为未执行。

## 环境（全部真实入口，无 mock）

| 项 | 值 |
|---|---|
| hub | 本机真 hub：`HAPI_HOME=.tmp/hub323 HAPI_LISTEN_PORT=3399 bun run hub/src/index.ts`（fork 代码，含 multi-user gateway） |
| web | `vite --port 5199` 代理到 :3399；修改 store 后重启过 vite，保证探针 `import('/src/lib/message-window-store.ts')` 与页面共用同一模块实例 |
| 浏览器 | 专用无头 Chrome 150（`--headless=new --use-angle=swiftshader`），CDP :9333，裸 CDP 脚本驱动（`.tmp/cdp323.ts`）；rAF 实测触发 |
| 数据 | 会话 B `352f27be-1cb9-4a07-b20c-e88cf205268d`：850 条 user/agent 交替行，全部经 `/cli` socket 的 `message` 事件灌入（与 CLI 同一路径） |
| 触发 | 同一 socket 发送 `createdAt` 早于 head 的 agent 消息 → hub `addMessage` 命中 `positionAt < previousHead.at` → `bumpMessageEpoch` → SSE 广播 |

## 修复前（基线提交 1a30132b 的 store）

| 步骤 | 观测 |
|---|---|
| 进入历史模式并翻页 | store `n=600` seq 251..850，`viewMode=history`，阅读对象 Q#0301 在视口顶部（scrollTop 7985） |
| 乱序插入 | bump 脚本输出 `epoch: 1`（0→1）；SSE 合并后窗口不变、锚点仍在 |
| 用户置顶翻页（Home） | hub 日志：`beforeAt=…&beforeSeq=251` 返回 200 行（epoch 1）→ 客户端紧接着发 `limit=200` 重置 |
| 结果 | store `{"epoch":1,"n":200,"oldestSeq":653,"newestSeq":852}`；DOM 198 行；锚点 Q#0301 `document.getElementById` 为 null；视口跳到 seq 653 顶部 |

## 修复后（本次改动）

### 路径 1：翻旧页时发现 epoch 变化

| 步骤 | 观测 |
|---|---|
| 基线 | `viewMode=history`，`n=800` seq 54..853，锚点 Q#0301（`hapi-message-user-text:fc58fe28-…`）在 DOM |
| 乱序插入 | bump 输出 `{"epoch":2,"headAt":1788720064494,"headSeq":854}`（1→2）；SSE 合并后 `n=600`（历史模式裁剪挤掉尾部，`requiresLatestReset=true`），锚点仍在 |
| 用户置顶翻页（Home） | hub 日志逐字：`beforeAt=1788700818615&beforeSeq=54&limit=200 200` → `afterAt=…&afterSeq=53&untilAt=1788701417615&untilSeq=653` ×3 页（区间复核，不带 epoch）；**无** 裸 `limit=200` |
| 结果 | store `{"n":653,"epoch":2,"oldestSeq":1,"newestSeq":653,"viewMode":"history"}`；DOM 653 行；锚点 Q#0301 仍在 DOM（true）；视口顶部仍是用户拉取时所在的行（visibleFirst `A#0056`，scrollTop 9608） |

### 路径 2：阅读中 SSE 重连触发 tail sync 撞上 epoch 变化

| 步骤 | 观测 |
|---|---|
| 基线 | 重载后 PageUp 进入历史模式：`{"n":200,"epoch":3,"viewMode":"history","requiresLatestReset":false}`，锚点 `hapi-message-agent-text:567a228a-…` |
| 乱序插入 | bump 输出 `epoch: 4`（3→4）；SSE 合并后 `n=201`，锚点仍在 |
| 停止并重启本地 hub | 新 hub 日志（`.tmp/hub323b.log`）在 web 按退避重连后逐字出现：`afterAt=1788720064494&afterSeq=854&epoch=3&limit=200 200`（带旧 epoch 的 tail sync，hub 以 reset 应答）→ `afterAt=…&afterSeq=656&untilAt=1788720064494&untilSeq=854` → `afterAt=…&afterSeq=856&untilAt=…&untilSeq=854`（区间复核两页）；**无** 裸 `limit=200` |
| 结果 | store `{"n":201,"epoch":4,"oldestSeq":657,"newestSeq":857,"viewMode":"history","requiresLatestReset":false}`；7 条此前乱序插入的行全部并入窗口；锚点仍在 DOM；scrollTop 33371 与重启前逐字相同 |

### 机制 2：稳定占位

| 步骤 | 观测（DOM 末尾 `[data-hapi-message-role]`） |
|---|---|
| 空闲 | 末尾为真实 agent 消息，`data-status=complete` |
| socket `session-alive thinking:true`（末尾仍是 assistant） | 无占位（按契约：仅当末尾非 assistant 时占位） |
| 追加一条 user 行 | 末尾 id `hapi-message-pending-turn:352f27be-…:unknown`，role assistant，`data-status=running` |
| 再追加一条 user 行（数组换引用） | 末尾 id 仍为同一个 `hapi-message-pending-turn:352f27be-…:unknown` |
| 追加一条 agent 行（真实输出到达） | 占位消失，末尾为 `hapi-message-agent-text:ef8cdfdc-…`，status running |
| `thinking:false` | 末尾 status 变为 complete |

`activeTurnStartedAt` 为 `unknown` 是因为本地 hub 的合成 `session-alive` 不带回合起点；真实 CLI 会带，id 随回合变化。

## 自动化检查（本轮实测）

| 命令 | 结果 |
|---|---|
| `cd web && bun run typecheck` | exit 0 |
| `bunx vitest run src/lib/message-window-store.test.ts` | 36 passed |
| `bunx vitest run` 六个相关文件（runtime / store / HappyThread ×3 / shareTurnAvailability） | 6 files, 110 passed |

## 复现脚本

`scripts/dev/history-epoch-repro/`：`seed.ts`（真实 `/cli` socket：`seedmix` 灌交替行、`bump` 乱序插入、`thinking` 心跳、`appenduser`/`append`）、
`cdp.ts`（裸 CDP：`open`/`nav`/`eval`/`evalfile`/`key`/`metrics`/`netwatch`，绕开 agent-browser 守护进程）、
`probe.js`（DOM + sessionStorage 探针）、`fiberprobe.js`（React props 里的 tail-sync 门槛标志）、
`evidence-before.txt` / `evidence-after.txt`（本轮原始记录）。
两个坑：模块探针 `import('/src/lib/message-window-store.ts')` 在 vite HMR 之后会拿到另一个实例，改过 store 必须重启 vite；
后台/无帧的 headless 标签页 rAF 不触发，store 的节流通知永远到不了 React，看起来像 `isSyncingTail` 卡死，实际要用独立窗口或专用 Chrome。

## 验收表（本轮实测）

| # | Dimension | Check | Command | Env | Expect | 实测 |
|---|-----------|-------|---------|-----|--------|------|
| 1 | integration | 翻旧页遇 epoch 变化不替换窗口 | 本文「路径 1」步骤 | local + browser | 窗口保留、锚点在、hub 日志 beforeAt 后跟 after+until、无裸 limit=200 | 通过（n 653、锚点 true、日志逐字见上） |
| 2 | integration | 阅读中 SSE 重连不替换窗口 | 本文「路径 2」步骤（停/起 hub） | local + browser | 同上，日志出现 `afterAt&epoch=<旧>` 后跟 after+until | 通过（n 201、epoch 4、scrollTop 不变） |
| 3 | integration | 运行中占位 id 稳定 | 本文「机制 2」步骤 | local + browser | 两次 id 相同且以 `pending-turn:` 开头；输出到达/空闲后消失 | 通过 |
| 4 | function | store / runtime / HappyThread 定向测试 | `bunx vitest run` 六个文件 | local | 全绿 | 通过（110/110） |
| 5 | function | 全量 web 测试 | `bunx vitest run`（web 工作区） | local | 全绿 | 282 文件 / 2569 例：2567 通过、2 例超时（`ToolCard/inlineDetailFocus.test.tsx`、`ToolCard/ToolGroupCard.test.tsx`，各 5s timeout；整套在本机 CPU 100% 下跑了 696s）。两文件单独重跑 13/13 通过，判定为负载超时，与本次改动无关 |

## 继承验证义务（本机跑不了，不可二次推迟）

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | environment | 生产换芯后真会话翻页 | 换芯后在生产大会话（>500 条）PageUp 翻两页，然后 rewind 自己的测试会话或等待一次乱序插入 | ecs + browser | 阅读位置保持，无整窗替换；`docker logs hapi-hub` 里 beforeAt 后跟 after+until |
| 2 | integration | 真实 Claude 会话运行中占位 | 在生产对一个自己的会话发消息，模型回复前观察 DOM 末尾 assistant 元素 id | ecs + browser | id 形如 `pending-turn:<sid>:<activeTurnStartedAt>` 且流式输出前不变 |
