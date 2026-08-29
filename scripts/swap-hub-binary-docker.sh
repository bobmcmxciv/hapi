#!/usr/bin/env bash
# ECS 换芯（docker 版）：重组 → 校验 → 备份 → compose stop → mv 换芯 → compose start。
#
# 2026-08-11 起 ECS 上的 hub 已 docker 化，systemd 单元 hapi-hub.service 已 disabled。
# 容器 bind-mount 的是宿主上的 npm 包目录，所以换芯动作没变——照旧替换宿主那个平台
# 二进制，只是重启方式从 systemctl 改成 docker compose。停容器再换是必须的：mount 跟随
# 宿主路径，但运行中的进程持有旧 inode，不重启不会生效。
#
# 覆写运行中的二进制会 Text file busy，所以只能 mv rename（CLAUDE.md §2.6）。
# 换芯目标不是 /usr/bin/hapi（那是软链到 4KB 的 hapi.cjs 脚手架）。
set -euo pipefail

TAG=${TAG:?TAG 必填，例如 fork12}
XFER=${XFER:?XFER 必填，分块所在目录，例如 /root/xfer28}
EXPECT_SHA=${EXPECT_SHA:?EXPECT_SHA 必填，本机算出的新二进制 sha256}
TS=$(date -u +%Y%m%dT%H%M%SZ)
COMPOSE=/clouddream/containerized/hapi/docker-compose.yml
BIN=/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi

echo "=== 重组分块 ==="
cd "$XFER"
cat part-* > hapi.gz
gunzip -kf hapi.gz
NEW="$XFER/hapi"
NEW_SHA=$(sha256sum "$NEW" | awk '{print $1}')
echo "new sha: $NEW_SHA"
if [ "$NEW_SHA" != "$EXPECT_SHA" ]; then
    echo "FATAL: 重组后 sha 不符，期望 $EXPECT_SHA"; exit 1
fi
echo "old sha: $(sha256sum "$BIN" | awk '{print $1}')"

echo "=== 备份（二进制留在原地由 mv 承担；库先 .backup） ==="
sqlite3 /root/.hapi/hapi.db ".backup /root/.hapi/hapi.db.pre-$TAG-$TS"
sqlite3 /root/.hapi/multi-user-gateway.sqlite ".backup /root/.hapi/multi-user-gateway.sqlite.pre-$TAG-$TS"
sqlite3 /root/.hapi/subscription-snapshots.sqlite ".backup /root/.hapi/subscription-snapshots.sqlite.pre-$TAG-$TS"
ls -la /root/.hapi/*.pre-$TAG-$TS

echo "=== swap ==="
docker compose -f "$COMPOSE" stop hapi-hub
mv "$BIN" "/root/hapi.bin.pre-$TAG-$TS"
mv "$NEW" "$BIN"
chmod 755 "$BIN"
docker compose -f "$COMPOSE" start hapi-hub

echo "swapped at $TS"
echo "rollback binary = /root/hapi.bin.pre-$TAG-$TS"
echo "rollback dbs    = /root/.hapi/*.pre-$TAG-$TS"
