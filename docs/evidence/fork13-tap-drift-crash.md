# fork.13 上线后会话页必崩：坏 lockfile → tap 漂移 → tap 循环保护抛错（2026-09-06）

## 现象

生产 `bob.18852271093.top` 自 2026-09-06 18:34Z（fork.13 第一次换芯后 hub 就绪的同一分钟）起，打开任一 Claude 会话页即被崩溃防线接住：

```
Error: Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.
    at https://bob.18852271093.top/assets/vendor-assistant-OltFwI5w.js:41:16621
    at ky (…:41:20238) at Ay (…:41:20751) at Kt (…:41:22815) …（重复三轮）
    at finishFlush / handleUpdate / runTask / n.port1.onmessage
```

`docker logs hapi-hub --since 192h | grep ClientError | grep "update depth"` 按日计数：只有 2026-09-06 一天，20 条；另有 5 条同源变体「This can happen when a resource repeatedly calls setState」。受影响 UA：Mac 桌面端、Android Edge、以及本机的 HeadlessChrome（其他会话的验证）。会话列表（左栏）不受影响。

## 根因链（每一环都有观测）

| 环 | 观测 |
|---|---|
| 抛错点在哪 | 拉下线上 chunk，第 41 行第 16621 列附近的源码是 `@assistant-ui/tap` 自己的 `useSyncExternalStore`：`if(++o.current>50)throw new Error("Maximum update depth exceeded. The result of getSnapshot should be cached…")`。`react-dom` 19.2.3 生产包里**没有**这段文本。 |
| 谁在用它 | chunk 里唯一调用点是通用包装 `en=(t,e,n)=>je()?Xu(t,e,n):ue.useSyncExternalStore(t,e,n)`，在 tap fiber 内走 tap 实现；`core/store/runtime-clients/useSubscribable.js` 把各 runtime 的 `getState` 直接喂给它。 |
| 为什么会抖 | assistant-ui#6440（2026-08-27）：`@assistant-ui/core 0.2.23`（0.2 线最后一版，2026-07-28）的 `ThreadListRuntimeImpl` 用 `LazyMemoizeSubject` 包状态，subject 未连接时每次 `getState()` 返回新对象；上游修复（#5897，2026-08-13）没有发进 0.2 线。同一 PR 给 tap 加了 50 次循环保护，随 tap 0.9.12+ 发布。**core 冻结 + tap 更新 = 必崩**，#6133 里另一位用户的二分结论相同。 |
| 线上为何是新 tap | 本仓库 `bun.lock` 钉的是 `@assistant-ui/tap@0.9.8`（无保护代码，本机 8/2 安装的 node_modules 也是 0.9.8）。但 `bun.lock` 第 1110 行 `"@twsxtd/hapi-win32-x64"` 键重复（0.27.1 与 0.27.0 各一条，8/9 的 converge 提交 00ae52b3 合入）。在全新目录 `bun install --frozen-lockfile` 实测：`error: Duplicate package path … InvalidPackageKey: failed to parse lockfile … warn: Ignoring lockfile`，冻结安装直接失败；非冻结安装则忽略 lockfile 按 semver 重解析，`@assistant-ui/react` 声明 `tap ^0.9.6` → 解析到 0.9.16。 |
| 为何 fork.12 没事 | fork.12（8/29）在本机长期存在的 node_modules 上构建，tap 仍是 0.9.8；fork.13 在全新安装的环境里构建。`.github/workflows/release.yml` 的 `bun install` 也不冻结，CI 产物同样会漂。 |
| 为何本机 dev 复现不了 | 同一原因：本机 tap 0.9.8 没有保护代码。用 dev 前端代理生产打开崩溃会话 30s 无异常；直接在无头 Chrome 打开生产站点同一会话，30s 内抛错 4 次（`Runtime.exceptionThrown` 抓取）。 |

## 修复

1. `bun.lock`：删掉第 1110 行的 `@twsxtd/hapi-win32-x64@0.27.0` 重复项（保留与 `cli/package.json` optionalDependencies 一致的 0.27.1）。修后顶层重复键计数为 0。
2. `.github/workflows/release.yml`：`bun install` → `bun install --frozen-lockfile`，lockfile 坏或与 manifest 不一致时必须失败，不能静默漂移。
3. 不升级 assistant-ui：0.14/0.2 线冻结，正确的长期解是升到 0.15 线（core 含 #5897 修复），那是独立的 converge 工作。

## 验证（见下表；未执行的行明确标注）

| # | Dimension | Check | Command | Env | Expect | 实测 |
|---|-----------|-------|---------|-----|--------|------|
| 1 | assumption | 修后 lockfile 可被冻结安装 | 新 worktree + 修后 bun.lock：`bun install --frozen-lockfile` | local | exit 0，`node_modules/@assistant-ui/tap` = 0.9.8，dist 中无 "should be cached" | 通过：`1631 packages installed [685.81s]`，exit 0；tap 0.9.8、core 0.2.23、保护文本 0 个文件（修前同一命令在同样的干净 worktree 里 exit 1：`lockfile had changes, but lockfile is frozen`） |
| 2 | function | 漂移安装确实复现崩溃 | 另一 worktree 非冻结安装（tap 0.9.16）起 dev 前端代理生产，打开会话 4cd662c8 | local + browser | 抛同一错误 | 待填 |
| 3 | environment | 修后构建的二进制不含保护代码 | `grep -c "should be cached to avoid an infinite loop" <linux 二进制>` | local | 0 | 待填 |
| 4 | integration | 换芯后线上会话页可开 | 无头 Chrome 打开 `https://bob…/sessions/4cd662c8…`，30s 内 `Runtime.exceptionThrown` 为空，DOM 有消息行 | ecs + browser | 无异常 | 待换芯 |
| 5 | integration | 换芯后 ClientError 不再新增 | `docker logs hapi-hub --since <换芯时刻> | grep -c "update depth"` | ecs | 0 | 待换芯 |
