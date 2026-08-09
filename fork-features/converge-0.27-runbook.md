# Converge 0.25.3 → 0.27：执行手册

目标基线 **`upstream/main` (mouriya, 0.27.0)**，不是 `tiann/main`。

依据：`git log --oneline --no-merges HEAD..upstream/main --not tiann/main` 只有 **4 条**
—— 我们落后 upstream 的 79 条里 75 条是 tiann 的，mouriya 已经把两边共有的
fork 功能（multi-user / session-fork / history-import / omp /
codex-compact-summary）全部 rebase 到 0.27.0。直接追 tiann 等于自己重做一遍。

| 参照 | 提交 | 版本 | SCHEMA_VERSION |
|---|---|---|---|
| 我们 `feat/converge-0.25.1` | `54294b10` | 0.25.3 | 16 |
| `upstream/main` | `47590217` | 0.27.0 | 20 |
| `tiann/main` | `06e2507a` | 0.27.2 | 22 |

落后：对 upstream 79（其中仅 4 条是 upstream 原创），对 tiann 90。
我们独有 48 条（作者 Bob Pang）。双方都改过的文件 **84 个** = 冲突面。

---

## Phase 0 —— 已完成（2026-08-09）

### 0.1 生产备份

| 物件 | 路径 | 校验 |
|---|---|---|
| 二进制 | `/root/hapi.bin.pre-converge027-20260810-000032` | sha256 `4c36c7ce6bf25274334d1949d8eb59e8d7f35b7707e1329a11a4a0c670312f68`，与线上运行的一致 |
| gateway 库 | `/root/.hapi/multi-user-gateway.sqlite.pre-converge027-20260810-000032` | `PRAGMA integrity_check` = ok，`gateway_grants` = 85 行 |
| 主库 `hapi.db` (1.6 GB) | **未备份 —— 故意推迟到换芯当天** | 现在备一份到部署时已过期；且 ECS `/` 已用 84%（13 G 可用，其中 18 G 是 `/root/.hapi` 的历史备份） |

换芯当天必须先跑（在线安全快照，不要用 `cp`）：

```bash
TS=$(date +%Y%m%d-%H%M%S)
sqlite3 /root/.hapi/hapi.db ".backup /root/.hapi/hapi.db.pre-converge027-$TS"
sqlite3 /root/.hapi/multi-user-gateway.sqlite ".backup /root/.hapi/multi-user-gateway.sqlite.pre-converge027-$TS"
```

线上真正要换的二进制（**不是** `/usr/bin/hapi`，那是软链到 4 KB 的 `hapi.cjs`）：

```
/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi   # 145 MB, 0.25.3
```

### 0.2 回滚点

本地 tag `pre-converge-0.27` → `54294b10`。

### 0.3 superseded / unique 定性

结果在 `fork-features/converge-0.27-dispositions.tsv`：**58 个文件，2 superseded / 56 unique**。

唯一两条 `superseded`（**不要重新落回**）：

| 文件 | 被谁取代 |
|---|---|
| `docs/guide/cursor.md` | `upstream:docs/guide/agents.md`（含 Cursor 支持矩阵 + 专章） |
| `docs/guide/grok.md` | 同上（含 Grok Build 行与专章） |

`fork-features/usage/*` 判 **unique**：upstream 确有自己的 usage 引擎，但它只读
`assistant` + `token_count`，不读 `usage_report`（代理 Claude 会话恒 0），也不认
gateway namespace / host 筛选。口径必须重新落回；**存储层**（upstream 的
`usage_events` + `usage_scan_state` 持久化投影）在 converge 之后再采纳，
详见 `trunk-patches.md` 的 disposition 小节。

---

## Phase 1 —— 建立 0.27 基线（2026-08-09 已完成）

```bash
git checkout -b feat/converge-0.27 upstream/main
```

### 实测结果

**上游 0.27 基线在 Windows 上本来就不绿**，且不稳定（同一份代码两次跑分别报
37 fail 和 10 fail）。批次 A 三条 cherry-pick 后：

| 套件 | 批次 A 前 | 批次 A 后 |
|---|---|---|
| hub | 10~37 fail（波动） | **1002 pass / 0 fail / 6 skip**，连跑 2 次稳定 |
| shared | — | 231 pass / 0 fail |
| web（vitest） | — | 2307 pass / 0 fail（267 文件） |
| cli（vitest） | **0 个测试能跑** | 2340 pass / 6 fail |
| typecheck（cli+web+hub） | — | exit 0 |

`fa8389ac` 是**承重的**：不带它时上游 globalSetup 在 Windows 上
`spawn C:\Users\Administrator\AppData\Roaming\npm\bun ENOENT`（npm shim 没有
`.exe`/`.cmd` 后缀），整个 CLI 套件一个测试都跑不起来。

### cli 剩余 6 条失败：**全部是本机 Windows 环境产物，不是 converge 回归**

判据（不是推测）：

1. **4/6 在 fork 从未有过的文件里** —— `src/agy/utils/agyHookCarrier.test.ts`（3 条，
   Antigravity 是 0.27 才引入）与 `src/modules/common/shellQuote.test.ts`（1 条），
   两者在 `pre-converge-0.27` 上都不存在。
2. **根因同一个**：本机用户名 `Administrator` 超过 8 字符，`os.tmpdir()` /
   `HAPI_HOME` 返回 8.3 短名 `C:\Users\ADMINI~1\...`，被测代码解析成长名
   `C:\Users\Administrator\...`，断言逐条对不上。剩下那条 `shellQuote` 是
   `cmd /c` 下带空格路径的引用问题。
3. `src/runner/validateWorkspaceDirectory.test.ts` 与旧分支**字节相同**（0 diff），
   失败同样是 `ADMINI~1` 短名断言。

这批不在本轮修（是上游自己的测试在特定环境下的断言问题），转为继承验证义务。

### 退出标准（原始）：

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | function | 全仓类型干净 | `bun run typecheck` | vircs | exit 0 |
| 2 | function | 上游自带测试全绿 | `bun test`（hub / cli / shared） | vircs | exit 0 |
| 3 | function | web 测试全绿 | `cd web && bun run test` | vircs | exit 0 |
| 4 | assumption | 生产库能被 0.27 打开并迁移 | 拿 `hapi.db` 副本冷启一次 hub | vircs | 无 schema 抛错，`user_version` 16→20 |

### schema 16 → 20：已读迁移体，纯新增

| 迁移 | 内容 | 风险 |
|---|---|---|
| v16→v17 | `CREATE TABLE usage_events` + 2 索引 | 不碰现有表 |
| v17→v18 | 加 4 个 `last_*` 列 + `DELETE FROM usage_events` | 派生索引重建 |
| v18→v19 | `CREATE TABLE usage_scan_state` + 清空重建 | 不碰现有表 |
| v19→v20 | 空实现 | 无 |

**但方向不可逆**：升到 20 后，当前 0.25.3 二进制会因 `currentVersion !== SCHEMA_VERSION`
拒绝启动。回滚只能靠 0.1 的库备份。

---

## Phase 2 —— 重放 48 条独有提交

每批一个 PR、独立跑测。顺序按依赖与冲突面：

| 批次 | 内容 | 提交数 | 冲突面 |
|---|---|---:|---|
| A | Windows / 测试环境加固 | 3 | 低（先做，后续才跑得动测） |
| B | 多用户 SSE 隔离 + 机器授权继承 | 8 | **最高**（`executionMount` `cliAdapter` `sseManager`） |
| C | usage 统计页（含 `54294b10`） | 10 | 高（需与 upstream usage 引擎合并，非二选一） |
| D | 崩溃防线 + 移动端内存 | 7 | 中（与 upstream `f4e69493` 离屏裁剪共存） |
| E | 提示音 + UI 细节 + 事件过滤 | 6 | 中 |
| F | 代理会话适配（cx2cc） | 3 | 中 |
| G | CLI 可观测性 | 3 | 低 |
| H | hub 杂项（标题泄漏 / `/download`） | 2 | 低 |
| I | 账本与文档 | 5 | 低，最后统一重写 |

批次 B 的 `fork-features/multi-user/*` 有 11 个文件**双方都改过**，必须逐文件
三方 diff，不能靠 git 自动合。

---

## Phase 3 —— tiann 剩余 29 条

**默认不做**，等 mouriya 下次 `sync/merge` 带进来。只有这三条要提前才单独
cherry-pick：`3da9f778`（会话置顶）、`b7f52f58`（音频/文件展示）、
`28df974e`（语音凭据 onboarding）。

---

## Phase 4 —— 上线（合并 ≠ 上线）

按 `.claude/rules/hapi-fork-cd-release.rule.md`：问 CD → 打 tag `v0.27.0-fork.0`
→ 等 Release CI 全绿 → 取 `hapi-linux-x64-baseline.tar.gz` 的 URL + sha256 →
stop / 备份 / `mv` 换芯 / start。

### 继承验证义务（本机跑不了，不可二次推迟）

| 项 | 转给谁 | 怎么验 |
|---|---|---|
| `cli/src/runner/runner.integration.test.ts` | CI（Linux、干净环境） | 本机跑会挂死 75 分钟零输出并泄漏 6 个 bun 孤儿进程（§2.6 已记）；且本机同时有 13 条真实会话，环境是脏的，给不出可信结论。Release 流水线必须跑到它全绿 |
| cli 那 6 条 Windows 短名/引用失败 | CI（Linux）+ 本机后续批次 | Linux 上无 8.3 短名问题，CI 应直接全绿；若要本机也绿，另开一批做路径断言归一（参照 fork 已有的 `76a99ac3` win 路径断言修法） |
| Codex/ACP 用量数值正确性 | ECS 换芯后 | 跑一个真实 Codex 会话，对 `/usage` 与 Codex 自报 token。**本机无法验**：生产库 11 个 codex 会话全是导入历史，0 条真实用量帧 |
| 18 条 resource_grants 迁移后可读 | ECS | peter 账号登录列会话，数量 = 迁移前基线 |
| schema 16→20 在真实生产库上 | 换芯前 | 拿库副本干跑，不许直接升生产库 |
| 6 台 runner 换芯后全回 | ECS | `POST /api/auth` 换 JWT 后读 `/api/machines` 内存态（DB 的 `machines.active` 是旧值，不可信） |
