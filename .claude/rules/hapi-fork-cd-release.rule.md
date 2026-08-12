# hapi fork 的发布→部署编排：合并后先问 CD，再构建→scp 推送→ECS 换芯

本仓库是 `mouriya-s-lab/hapi` 的 fork（**origin=`bobmcmxciv/hapi`**，upstream=`mouriya-s-lab/hapi`，tiann=`tiann/hapi` 原始上游）。生产部署是 **operator 自己的阿里云 ECS**（`bob.18852271093.top` = 101.133.153.229，systemd 单元 `hapi-hub`），跑的是**钉死版本的预编译 fork 二进制**，不是分支 HEAD。所以**代码进分支/main ≠ 已上线**——中间隔着「构建 → 传输 → 换芯」三道关。

> ⚠️ 历史坑：本文件的旧版继承自 mouriya-s-lab 的仓库，描述的是**他们的** homelab 部署宇宙（`hapi.237575.xyz`、`mouriya-s-lab/homelab-tf` IaC、launchd `xyz.237575.hapi-runner-macos`）。那些坐标与本 fork 无关；`hapi.237575.xyz` 解析到 Cloudflare，是 mouriya 的入口。**本 fork 的主入口只有 `bob.18852271093.top`**。已因此误标过一次部署报告（2026-08-10）。

## 触发时机

分支上积累了**尚未部署**的 runtime 改动（会进编译二进制/影响 hub·cli·web·shared 运行行为）时适用。只动 `.github/`、docs、README 等不进二进制的改动不触发。

## 流程

### 1. 合并/积累后必须主动问一次「是否现在 CD」

不要默认「已生效」。有 runtime 改动后主动问 operator 是否现在换芯到 `bob.18852271093.top`。这是少数值得问的决策（部署有 blast radius，时机由 operator 定）。

### 2. 要 CD → vircs 本机构建（ECS 仍拉不到 Release 产物）

ECS 出网是**部分**可用，别按「全锁死」也别按「全可用」下判断（2026-08-11 实测：`registry.npmjs.org` 200、`api.github.com` 200、`objects.githubusercontent.com` 主机可达、`github.com` **000**、`api.anthropic.com` 403 区域封锁）。**Release 页面直链要过 `github.com`，在 ECS 上仍下不了**，进货默认通道仍是 scp 推送（入站 22）。若某次要试 `api.github.com` 取 asset 直链再从 `objects.githubusercontent.com` 拉，先测吞吐再决定，不要当既定路径。构建仍在 vircs 做：

```bash
bun run build:web && (cd hub && bun run generate:embedded-web-assets)   # 先生成真 web 资产（防 stub 覆写）
cd cli && bun run scripts/build-executable.ts --target bun-linux-x64-baseline --with-web-assets
```

构建后**必须**：查 exit code + 比对新旧 sha256 确认真变了（失败时 dist-exe 里留着旧货）。逐条坑见 `CLAUDE.md` §2.6。

### 3. 传输：gzip → split 12m → scp（并行 ≤3）→ 逐块 md5 判收

判收**只认逐块 md5，不看大小**。比对前两边都归一化（`md5sum` 的 `*` 前缀与空格数不一致都踩过）：`md5sum part-* | awk '{gsub(/\*/,"",$NF); print $1, $NF}'`。长传输必须 `run_in_background`，串联命令显式捕获每段 `$?`。

### 3.5 ⚠️ ECS 上的 hub 已 docker 化（2026-08-11 起），systemd 单元已 disabled

**以后一律按 docker 方式部署。** 现状：

| 项 | 值 |
|---|---|
| compose | `/clouddream/containerized/hapi/docker-compose.yml`（project 名 `hapi`） |
| 容器 | `hapi-hub`，`node:20-slim`，`network_mode: host`，`restart: always` |
| 命令 | `node /usr/lib/node_modules/@twsxtd/hapi/bin/hapi.cjs hub` |
| 挂载 | `/usr/lib/node_modules/@twsxtd/hapi` → 同路径（**ro**）；`/root/.hapi` → 同路径（rw） |
| 日志 | `docker logs hapi-hub`（json-file，20m×3 轮转）——**不再是 journalctl** |
| systemd | `hapi-hub.service` 已 `inactive` + `disabled`，**不要再启用**（会与容器抢 13006） |

**关键点：容器 bind-mount 的是宿主上的 npm 包目录，所以换芯动作没变——照旧替换宿主
那个平台二进制，只是重启方式从 systemd 改成 docker。** 二进制路径仍是
`/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi`。

```bash
# 备份照旧（二进制 + 主库 + gateway 库）
sqlite3 /root/.hapi/hapi.db ".backup /root/.hapi/hapi.db.pre-<tag>-<ts>"
sqlite3 /root/.hapi/multi-user-gateway.sqlite ".backup /root/.hapi/multi-user-gateway.sqlite.pre-<tag>-<ts>"

BIN=/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi
docker compose -f /clouddream/containerized/hapi/docker-compose.yml stop hapi-hub
mv $BIN /root/hapi.bin.pre-<tag>-<ts>          # 仍用 mv，不覆写
mv <新二进制> $BIN && chmod 755 $BIN
docker compose -f /clouddream/containerized/hapi/docker-compose.yml start hapi-hub
```

停容器再换是必须的：mount 跟随宿主路径，但**运行中的进程持有旧 inode**，不重启不会生效。

验收命令也要跟着换：`systemctl is-active hapi-hub` → `docker inspect -f '{{.State.Status}}' hapi-hub`；
`journalctl -u hapi-hub` → `docker logs hapi-hub --since 10m`。

### 4. 换芯（若 schema 变更，先拿生产库副本干跑迁移）

- schema 有变：`.backup` 出副本 → `HAPI_HOME=<副本目录> HAPI_LISTEN_PORT=<空闲端口> <新二进制> hub` 干跑，确认 `user_version` 迁移成功再动真库。**迁移方向不可逆**——旧二进制拒启新 schema，回滚必须连库备份一起还原。
- 正式换芯（stop→start 窗口实测约 6 秒）：

```bash
sqlite3 /root/.hapi/hapi.db ".backup /root/.hapi/hapi.db.pre-<tag>-<ts>"
sqlite3 /root/.hapi/multi-user-gateway.sqlite ".backup /root/.hapi/multi-user-gateway.sqlite.pre-<tag>-<ts>"
systemctl stop hapi-hub
mv <旧二进制> /root/hapi.bin.pre-<tag>-<ts>          # mv 换芯，覆写会 Text file busy
mv <新二进制> $BIN && chmod 755 $BIN
systemctl start hapi-hub
```

真换芯目标（**不是** `/usr/bin/hapi` 那个软链）：
`/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi`

### 5. 换芯后验证（runtime-verification-required 的最小集）

- `systemctl is-active` + journal 无 schema/fatal；`PRAGMA user_version` 符合预期
- `POST /api/auth` 换 JWT 读 `/api/machines` **内存态**（DB 的 `machines.active` 是旧值不可信）；runner 靠各机看门狗 ≤5 分钟自愈回连（换芯前先比对双边 `PROTOCOL_VERSION`，不同则要全 fleet 升级，爆炸半径完全不同）
- `GET /api/usage/summary` 返回 fork 形状（含 `hosts`）；公网 `https://bob.18852271093.top` 200
- 更新 `/root/.hapi/DEPLOYED.txt`（tag/commit/sha256/回滚坐标）

### 5.5 会话保全：更新时怎么不把在跑的会话搞离线（2026-08-11 事故复盘固化）

**事故根链条**：机群 CLI 换芯用 `taskkill /F /IM hapi.exe` 杀掉了各机全部会话进程；
runner 自己回来了，但 **hub 不会自动 resume 被杀的会话**——结果 44 个会话集体离线，
只能事后手工恢复。而同一天 hub 的两次重启（systemd 换芯 + docker 化迁移）**一个会话
都没杀**：hub 停启窗口内 CLI 只是断连重试，几秒后自动回连。

由此分两类操作，纪律不同：

**A. hub 更新（docker compose stop → 换宿主二进制 → start）——本来就不杀会话**
- 停启窗口保持短（实测 ~6s）；CLI 断连自动重试，runner 看门狗 ≤5min 兜底
- 更新镜像时先 `docker compose pull` 再 stop/start，别把拉镜像时间算进停机窗口
- **不要 `docker compose down`**（会删容器重建，虽然状态都在 bind mount 里，
  但 stop/start 足够且窗口更短）；不要动 `network_mode: host`
- 唯一会波及机群的情形：`PROTOCOL_VERSION` 变了 → 那是机群升级（走 B），先比对两边版本

**B. 机群 CLI 换芯——必然杀会话，所以基线快照 + 事后恢复是换芯动作的一部分**
1. **换芯前**：把当前 active 会话清单落盘当基线
   （`python3 resume-offline-sessions.py 0.1` 的思路：记下每台机 active 数与会话 id）
2. 换芯（swap-cli-windows.ps1 / swap-cli-vircs.ps1）
3. 等 runner 回连（`/api/machines` 内存态看到该机 active）
4. **必跑** `resume-offline-sessions.py <窗口h> apply`（在 hub 宿主上跑）——
   它会对 claude 系会话先置 `resumeWithSessionModel=true` 再 resume，
   否则存储的模型串（`opus[1m]`/`gpt-5.6-sol`…）会被静默丢掉、落回机器默认模型
5. 复核：active 数回到基线；抽查恢复会话的 model/effort 与原值逐字一致

**本节禁止**：
- CLI 换芯后不跑恢复就收工（「runner 回来了」≠「会话回来了」）
- 恢复 claude 系会话时跳过 resume-model 步骤（模型参数静默丢失，用户下一条消息就换了模型）
- 把「hub 重启」当成会话离线的原因去排查——先看离线时长是否对齐某台机器的 CLI 换芯时刻

### 6. 发布记档：tag `vX.Y.Z-fork.N` 单推 origin

`X.Y.Z` = `cli/package.json` 版本，`N` 递增。**单推该 tag**（`git push origin <tag>`）——`--tags` 多 tag 同推会漏发 tag 事件，Release workflow 不触发（2026-08-10 踩过）。Release 产物（6 平台 + checksums）用于追溯与将来他处部署，**不是 ECS 的进货来源**。

## 本规则禁止

- 把「代码推上分支」当成「已上线」而不问 CD
- 把 ECS 出网当**全锁死**或**全可用**——两头都错。进货前按上面的实测口径确认（Release 页面直链确实下不了）
- 只看传输字节数/大小判传完；后台串联命令不捕获分段退出码
- schema 变更不经副本干跑直接升生产库
- 覆写运行中的二进制（必须 mv）

## 与其他规则/文档的边界

- 部署链路的**逐条坑**归 `CLAUDE.md` §2.6（本文件只编排顺序）
- 验证标准归 `runtime-verification-required` 与上面第 5 节最小集
- **mouriya 的 homelab/IaC 流程**（compose pin、`iac:deploy` issue）只在给 mouriya-s-lab 送 PR 且他们要部署时才相关——那是他们的宇宙，见其仓库内同名 rule 的原版
