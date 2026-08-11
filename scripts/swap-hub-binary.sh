#!/usr/bin/env bash
# ECS 换芯：干跑 → 备份（双库 + 真二进制）→ stop/mv/start → 基本存活验证。
# 在 ECS 上执行（ssh ecs 'bash -s' < 本文件）。
#
# 换的不是 /usr/bin/hapi（那是软链 → hapi.cjs 启动脚手架），是平台包里的真二进制。
# 用 mv 换，覆写会 Text file busy。
set -euo pipefail

TAG=${TAG:-scoped-grants}
TS=$(date -u +%Y%m%dT%H%M%SZ)
NEW=/root/xfer-hub-$TAG/hapi-linux-x64-$TAG
BIN=/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi
HOME_DIR=/root/.hapi

[ -f "$NEW" ] || { echo "FATAL: 新二进制不在 $NEW"; exit 1; }
echo "new sha256 : $(sha256sum "$NEW" | awk '{print $1}')"
echo "cur sha256 : $(sha256sum "$BIN" | awk '{print $1}')"

echo "=== 1/5 干跑：拿生产库副本起一次新二进制，确认 schema 迁移不炸 ==="
DRY=/root/dryrun-$TAG
rm -rf "$DRY"; mkdir -p "$DRY"
sqlite3 "$HOME_DIR/hapi.db" ".backup $DRY/hapi.db"
sqlite3 "$HOME_DIR/multi-user-gateway.sqlite" ".backup $DRY/multi-user-gateway.sqlite"
cp "$HOME_DIR/jwt-secret.json" "$HOME_DIR/owner-id.json" "$DRY/" 2>/dev/null || true
echo "干跑前 gateway_grants 列: $(sqlite3 "$DRY/multi-user-gateway.sqlite" "PRAGMA table_info(gateway_grants);" | awk -F'|' '{print $2}' | tr '\n' ',')"
HAPI_HOME=$DRY HAPI_LISTEN_PORT=13099 HAPI_LISTEN_HOST=127.0.0.1 "$NEW" hub > "$DRY/dryrun.log" 2>&1 &
DRY_PID=$!
for i in $(seq 1 30); do
    sleep 1
    curl -sf -o /dev/null http://127.0.0.1:13099/ 2>/dev/null && break
done
sleep 2
kill $DRY_PID 2>/dev/null || true
wait $DRY_PID 2>/dev/null || true
echo "--- 干跑日志尾 ---"; tail -15 "$DRY/dryrun.log"
echo "干跑后 gateway_grants 列: $(sqlite3 "$DRY/multi-user-gateway.sqlite" "PRAGMA table_info(gateway_grants);" | awk -F'|' '{print $2}' | tr '\n' ',')"
echo "干跑后 hapi.db user_version: $(sqlite3 "$DRY/hapi.db" "PRAGMA user_version;")"
if ! sqlite3 "$DRY/multi-user-gateway.sqlite" "PRAGMA table_info(gateway_grants);" | grep -q path_prefix; then
    echo "FATAL: 干跑后 path_prefix 列没出现，迁移没跑起来"; exit 1
fi
if grep -qiE "schema|fatal|assertRequired" "$DRY/dryrun.log"; then
    echo "WARN: 干跑日志里有 schema/fatal 字样，人工确认上面的日志尾再继续"
fi
echo "干跑通过"

echo "=== 2/5 备份（双库 + 当前真二进制）==="
sqlite3 "$HOME_DIR/hapi.db" ".backup $HOME_DIR/hapi.db.pre-$TAG-$TS"
sqlite3 "$HOME_DIR/multi-user-gateway.sqlite" ".backup $HOME_DIR/multi-user-gateway.sqlite.pre-$TAG-$TS"
cp -p "$BIN" "/root/hapi.bin.pre-$TAG-$TS"
ls -la "$HOME_DIR/hapi.db.pre-$TAG-$TS" "$HOME_DIR/multi-user-gateway.sqlite.pre-$TAG-$TS" "/root/hapi.bin.pre-$TAG-$TS"

echo "=== 3/5 换芯（stop → mv → start）==="
systemctl stop hapi-hub
mv "$NEW" "$BIN"
chmod 755 "$BIN"
systemctl start hapi-hub

echo "=== 4/5 存活 ==="
sleep 4
systemctl is-active hapi-hub
echo "running sha256: $(sha256sum "$BIN" | awk '{print $1}')"

echo "=== 5/5 启动日志（找 schema/fatal）==="
journalctl -u hapi-hub --since "-2 min" --no-pager -o cat | tail -25
echo "hapi.db user_version: $(sqlite3 "$HOME_DIR/hapi.db" "PRAGMA user_version;")"
echo "gateway_grants 列: $(sqlite3 "$HOME_DIR/multi-user-gateway.sqlite" "PRAGMA table_info(gateway_grants);" | awk -F'|' '{print $2}' | tr '\n' ',')"
rm -rf "$DRY"
echo "SWAP DONE (rollback: /root/hapi.bin.pre-$TAG-$TS)"
