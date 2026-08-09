# hapi fork 的发布→部署编排：合并后先问 CD，再构建→scp 推送→ECS 换芯

本仓库是 `mouriya-s-lab/hapi` 的 fork（**origin=`bobmcmxciv/hapi`**，upstream=`mouriya-s-lab/hapi`，tiann=`tiann/hapi` 原始上游）。生产部署是 **operator 自己的阿里云 ECS**（`bob.18852271093.top` = 101.133.153.229，systemd 单元 `hapi-hub`），跑的是**钉死版本的预编译 fork 二进制**，不是分支 HEAD。所以**代码进分支/main ≠ 已上线**——中间隔着「构建 → 传输 → 换芯」三道关。

> ⚠️ 历史坑：本文件的旧版继承自 mouriya-s-lab 的仓库，描述的是**他们的** homelab 部署宇宙（`hapi.237575.xyz`、`mouriya-s-lab/homelab-tf` IaC、launchd `xyz.237575.hapi-runner-macos`）。那些坐标与本 fork 无关；`hapi.237575.xyz` 解析到 Cloudflare，是 mouriya 的入口。**本 fork 的主入口只有 `bob.18852271093.top`**。已因此误标过一次部署报告（2026-08-10）。

## 触发时机

分支上积累了**尚未部署**的 runtime 改动（会进编译二进制/影响 hub·cli·web·shared 运行行为）时适用。只动 `.github/`、docs、README 等不进二进制的改动不触发。

## 流程

### 1. 合并/积累后必须主动问一次「是否现在 CD」

不要默认「已生效」。有 runtime 改动后主动问 operator 是否现在换芯到 `bob.18852271093.top`。这是少数值得问的决策（部署有 blast radius，时机由 operator 定）。

### 2. 要 CD → vircs 本机构建（ECS 拉不了任何外网产物）

ECS 出网锁死（GitHub/npm 全 `http=000`），**Release 产物下载在 ECS 上不可用**，唯一进货通道是 scp 推送（入站 22）。所以构建在 vircs 做：

```bash
bun run build:web && (cd hub && bun run generate:embedded-web-assets)   # 先生成真 web 资产（防 stub 覆写）
cd cli && bun run scripts/build-executable.ts --target bun-linux-x64-baseline --with-web-assets
```

构建后**必须**：查 exit code + 比对新旧 sha256 确认真变了（失败时 dist-exe 里留着旧货）。逐条坑见 `CLAUDE.md` §2.6。

### 3. 传输：gzip → split 12m → scp（并行 ≤3）→ 逐块 md5 判收

判收**只认逐块 md5，不看大小**。比对前两边都归一化（`md5sum` 的 `*` 前缀与空格数不一致都踩过）：`md5sum part-* | awk '{gsub(/\*/,"",$NF); print $1, $NF}'`。长传输必须 `run_in_background`，串联命令显式捕获每段 `$?`。

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

### 6. 发布记档：tag `vX.Y.Z-fork.N` 单推 origin

`X.Y.Z` = `cli/package.json` 版本，`N` 递增。**单推该 tag**（`git push origin <tag>`）——`--tags` 多 tag 同推会漏发 tag 事件，Release workflow 不触发（2026-08-10 踩过）。Release 产物（6 平台 + checksums）用于追溯与将来他处部署，**不是 ECS 的进货来源**。

## 本规则禁止

- 把「代码推上分支」当成「已上线」而不问 CD
- 在 ECS 上尝试从 GitHub/npm 拉产物（出网锁死，白等）
- 只看传输字节数/大小判传完；后台串联命令不捕获分段退出码
- schema 变更不经副本干跑直接升生产库
- 覆写运行中的二进制（必须 mv）

## 与其他规则/文档的边界

- 部署链路的**逐条坑**归 `CLAUDE.md` §2.6（本文件只编排顺序）
- 验证标准归 `runtime-verification-required` 与上面第 5 节最小集
- **mouriya 的 homelab/IaC 流程**（compose pin、`iac:deploy` issue）只在给 mouriya-s-lab 送 PR 且他们要部署时才相关——那是他们的宇宙，见其仓库内同名 rule 的原版
