# 用量页 gpt token 恒为 0 —— 部署报告

日期：2026-08-02　执行：hapi 仓库会话（vircs）

## 结论

修复已上线。`gpt-5.6-sol` 的 token 从恒为 0 变为记录真实用量，Claude 官方来源数字逐字节未变。

**部署过程中发现并修复了交接文档里的一个错误假设**（见「二」）。

## 一、已部署内容

| 组件 | 机器 | 版本变化 | 二进制 sha256 | 备份名 |
|---|---|---|---|---|
| hub | ECS 101.133.153.229 | 0.25.1 → 0.25.1(+修复) | `f5ce6c8f002320564d95a9835d6f82c7968c109a217079ab7a1753646bfb03c3` | `hapi.pre-usagefix-20260802-225033`（**原始，回滚用这个**）<br>`hapi.pre-aggfix-20260802-232058`（第一版）<br>`hapi.pre-modelkey-20260803-000041`（第二版） |
| runner | DESKTOP-HT3P09U | 0.23.3 → 0.25.1 | `caffc1f5…f4cf2c4` | `hapi.exe.pre-usagefix-20260802-225359` |
| runner | TXFA608INDEX | 0.23.3 → 0.25.1 | `caffc1f5…f4cf2c4` | `hapi.exe.pre-usagefix-20260802-225451` |
| runner | FA608_INDEX | 0.20.2 → 0.25.1 | `caffc1f5…f4cf2c4` | `hapi.exe.pre-usagefix-20260802-225454` |
| runner | Mac173Index (darwin-arm64) | 0.23.3 → 0.25.1 | `6aa559ac…b9293b44` | `hapi.pre-usagefix-20260802-225515` |
| runner | vircs (WIN-GVHSJ7B378A) | 0.23.3 → 0.25.1 | `caffc1f5…f4cf2c4` | `hapi.exe.pre-usagefix-20260802-083857` |

换芯后机群在线状态（hub 内存态 `/api/machines`，非 DB 的 `machines.active`）：
WIN-GVHSJ7B378A / DESKTOP-HT3P09U / TXFA608INDEX / Mac173Index.local 均 `active=True`；
FA608_INDEX `active=False`（其 runner 本就未运行，本次未拉起，见「四」）。

数据库备份（ECS）：`hapi.db.pre-usagefix-20260802-225033`、`hapi.db.pre-aggfix-20260802-232058`、
`multi-user-gateway.sqlite.pre-usagefix-*` / `.pre-aggfix-*`。均用 `sqlite3 .backup` 在线安全备份，非 `cp`。

## 二、部署中发现的缺陷（已修）

交接文档「二.一个已验证的关键事实」断言 `result.modelUsage` 是**每轮**而非累计，聚合端据此用 SUM。
该结论是用 `claude -p --resume` 验证的——**那种方式每轮新起一个进程**。
而 HAPI runner 用的是常驻 SDK 会话，同一进程跨轮累加。

线上三轮会话实测：

```
seq=4   input=55931    output=5    costUSD=0.27978
seq=8   input=111945   output=10   costUSD=0.574695
seq=12  input=168046   output=15   costUSD=0.882845
```

`output` 走 5→10→15，`costUSD` 单调递增 —— 是运行总计。
SUM 会把 168,046 报成 335,922，放大倍数 **(n+1)/2**（3 轮 2 倍，20 轮 10.5 倍）。

**修法**：`fork-features/usage/usageAggregate.ts` 的 `queryUsageReportTotals` 改为按
`(session_id, model)` 分区、按 `seq` 排序取相邻帧**差值**求和；帧值低于前一帧视为
进程重启（会话 resume），按全额计入。时间窗在算完差值之后再过滤，避免窗内首帧把整段
运行总计算进来。

只影响 hub 一个二进制，CLI 端发出的帧本身正确，五台机器的产物无需重发。

### 缺陷二：模型名变体后缀导致两侧配不上（部署后由用户截图暴露）

`assistant` 行的 `message.model` 永远是裸名，而 `result.modelUsage` 的键带上下文变体后缀。
实测同一个 Mac 会话：assistant 记 `gpt-5.6-sol`（0 token），帧记 `gpt-5.6-sol[1m]`（193,152 → 227,938）。

`mergeUsageReportFallback` 按模型名**精确**配对，于是回退不触发，用量页上同一模型裂成两行：
`gpt-5.6-sol` 有 20 次请求但 0 token，`gpt-5.6-sol[1m]` 有 227,938 token 但 0 次请求。

**修法**：配对时用 `canonicalModelName()` 剥掉结尾的 `[...]`，并把折叠到同一裸名的多个变体先求和；
同一裸名只回退一次（防止两行都被替换成同一份数据）；token 全零的 report-only 模型不再产出幽灵行。
Claude 官方模型不受影响——它们 assistant 侧有真数，回退分支根本不触发。

同样只需重编重传 hub 一个二进制。

**这条也说明我第一次的端到端测试不具代表性**：测试会话恰好用了不带 `[1m]` 的变体，完全没碰到这条路径。

## 三、验收结果（全部为实测）

| # | 维度 | 检查项 | 实测 |
|---|---|---|---|
| 1 | environment | hub 换芯后是新版本且真在服务 | sha256 `ab3c7cf3…` 相等；pid 963486；`/api/usage/summary` 200 且数据正确 |
| 2 | function | 库里出现 usage_report 行 | 出现。内容 `gpt-5.6-sol inputTokens 55931`；同会话 assistant 行仍 `in=0 out=0` |
| 3 | function | gpt-5.6-sol inputTokens > 0 | **395984** = 168046 + 227938，两个会话的真实用量合成一行，req=20（修复前：SUM 版报 335922；配对版裂成 168046 + `[1m]` 227938 两行） |
| 4 | integration | Claude 官方数字没翻倍 | 冻结窗 2026-07-01→08-02，14 个模型**逐字段与基线完全相等**，totals 相等（三次换芯后各验一次，均 IDENTICAL） |
| 5 | environment | 各机 runner 未起来就僵死 | 两次采样心跳推进：desktop 22:55:06→22:58:06；tx 空→22:57:59；mac 22:58:17；vircs 8:40:30→8:41:30；均 0.25.1 |
| 6 | assumption | usage_report 不被渲染成原始 JSON | 真实 Chrome 打开生产 Mac 会话 `133cb5c3…`：渲染文本 **20,184 字符**（确认渲染完成），`Unsupported message`/`usage_report`/`modelUsage`/`costUSD`/`canonicalModel` 及 227938/193152/168046 **全部 false** |
| 7 | environment | 部署的前端产物确实带修复 | 从线上 hub 拉 `/assets/index-CByiKwRd.js`（1,935,477 B），内含 `control_cancel_request","log","usage_report"]` |

**第 6 行的更正记录**：首次验收时我只抓到 325 字符的页面文本（侧栏仍显示「还没有会话」，说明根本没渲染完）
就判定通过，属于假阴性取证。用户随后用截图指出会话流里确实有 `Unsupported message · output/usage_report`。
复查结论：那是**浏览器缓存的旧 bundle**（截图右上角同时可见「新版本可用，重新加载」横幅），
部署版前端会正确挡掉——由上表第 6、7 行两条独立证据确认。

基线与结果 JSON 存于 `.usage-baseline/`：`before-hub.json`（部署前）、`after-hub.json`、
`after-aggfix-window.json`、`after-aggfix-frozen.json`。

验收所用真实会话：`ae54744b-6f94-4ddb-a7cd-cbe296ee92aa`（DESKTOP-HT3P09U，gpt-5.6-sol，3 轮）。

## 四、已知遗留

- **FA608_INDEX 的 runner 未启动**。换芯前它就是停的（0 进程，状态停在 17:44，版本 0.20.2）。
  二进制已换成 0.25.1，但按保守处理**没有拉起**。要启动：
  `Start-ScheduledTask -TaskName HapiRunner`（该机 `C:\Users\bobmc\.hapi\start-runner.bat`）。
- **历史数据不可追回**。`result` 事件此前从未落库，那 2,789 行 gpt 记录的真实 token 永久缺失，
  修复只对新会话生效。
- **本地启动器路径仍为 0**。它读 transcript，而 transcript 里没有 `result` 事件。
- **逐条消息页脚（`MessageMetadata`）仍显示 `Tokens: 0 total`**。它读的是该条 assistant 消息自己的
  `usage.input_tokens`，对经代理的 gpt 结构性恒为 0。本次修复只覆盖**用量页的聚合层**，
  没有改这个逐条显示。要修需要另一条路径（让页脚也能取到 usage_report 的数），属独立任务。
- 用量页的模型行现在按裸名合并，`gpt-5.6-sol` 与 `gpt-5.6-sol[1m]` 计入同一行，
  **丢失 1M 变体的区分**。这是刻意取舍：assistant 侧本来就分不出变体，
  保留区分只会让「有请求无 token」和「有 token 无请求」两行并存。
- **代码未提交**。工作区仍是修改状态，含本次对 `usageAggregate.ts` / `usageAggregate.test.ts` 的改动。

## 五、测试

- `bun test ../fork-features/usage/` → **20 pass / 0 fail**（含 9 条新增：累计语义、计数器重置、跨会话、
  时间窗归属、`[1m]` 变体配对、多变体合并、report-only 用裸名、全零幽灵行剔除、带变体时不叠加）
- `bun test ../fork-features/multi-user/` → **64 pass / 0 fail**
- `bun run typecheck:hub` → exit 0
- 未跑 `bun run test:cli`（会杀本机 runner，按指令禁止）

## 六、回滚

```bash
# hub 回滚到本次部署前的原始二进制
ssh ecs '
  BIN=/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi
  cp "$BIN.pre-usagefix-20260802-225033" "$BIN.rollback" && chmod 750 "$BIN.rollback" && mv "$BIN.rollback" "$BIN"
  systemctl restart hapi-hub && systemctl is-active hapi-hub'
```

各 runner 回滚：把同目录下对应的 `hapi.exe.pre-usagefix-*` / `hapi.pre-usagefix-*` 改回原名，
再 `Start-ScheduledTask`（Windows）或 `launchctl kickstart -k gui/501/com.hapi.relay`（Mac）。
