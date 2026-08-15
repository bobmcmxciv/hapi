#!/usr/bin/env bash
# ECS hub 换芯到含 subscription 功能的新二进制。
#
# 本次特点：**不涉及 schema 迁移**——subscription 快照写在独立的
# subscription-snapshots.sqlite，hapi.db / multi-user-gateway.sqlite 一个字节没动。
# 所以回滚只需把旧二进制 mv 回去，库不用还原（旧二进制会无视那个多出来的文件）。
# 备份照做，是因为「换芯前不备份」这条纪律不该按单次风险高低放松。
#
# 用法：bash scripts/swap-hub-subscription.sh <tag>
set -uo pipefail

TAG="${1:?用法: $0 <tag>  例: fork8}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
COMPOSE=/clouddream/containerized/hapi/docker-compose.yml
BIN=/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi

run() { ssh -o ConnectTimeout=20 ecs "$@"; }

echo "=== 1. 重组分块并校验 ==="
run "cd /root/xfer-sub && cat part-* > hapi.gz && gunzip -c hapi.gz > hapi.new && chmod 755 hapi.new && sha256sum hapi.new && ls -la hapi.new" || exit 1

echo "=== 2. 备份（二进制 + 主库 + gateway 库）==="
run "sqlite3 /root/.hapi/hapi.db \".backup /root/.hapi/hapi.db.pre-${TAG}-${TS}\"" || exit 1
run "sqlite3 /root/.hapi/multi-user-gateway.sqlite \".backup /root/.hapi/multi-user-gateway.sqlite.pre-${TAG}-${TS}\"" || exit 1
run "ls -la /root/.hapi/*.pre-${TAG}-${TS}" || exit 1

echo "=== 3. 停容器（bind-mount 跟随宿主路径，但运行中进程持有旧 inode，必须重启）==="
run "docker compose -f $COMPOSE stop hapi-hub" || exit 1

echo "=== 4. mv 换芯（覆写会 Text file busy）==="
run "mv $BIN /root/hapi.bin.pre-${TAG}-${TS} && mv /root/xfer-sub/hapi.new $BIN && chmod 755 $BIN && sha256sum $BIN" || exit 1

echo "=== 5. 起容器 ==="
run "docker compose -f $COMPOSE start hapi-hub" || exit 1

echo "=== 6. 等待就绪 ==="
sleep 8
run "docker inspect -f '{{.State.Status}}' hapi-hub"
run "docker logs hapi-hub --since 2m 2>&1 | tail -25"

echo ""
echo "回滚坐标: /root/hapi.bin.pre-${TAG}-${TS}"
