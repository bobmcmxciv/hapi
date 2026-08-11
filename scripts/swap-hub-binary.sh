#!/usr/bin/env bash
# ECS 换芯：备份 → stop → mv 换芯 → start。
# 覆写运行中的二进制会 Text file busy，所以只能 mv rename（见 CLAUDE.md §2.6）。
# 换芯目标不是 /usr/bin/hapi（那是软链到 4KB 的 hapi.cjs 脚手架）。
set -euo pipefail

TAG=${TAG:-fork7}
TS=$(date -u +%Y%m%dT%H%M%SZ)
NEW=/root/xfer-hub-$TAG/hapi-linux-x64-$TAG
BIN=/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi

[ -f "$NEW" ] || { echo "FATAL: 新二进制不在 $NEW"; exit 1; }
echo "new sha: $(sha256sum "$NEW" | awk '{print $1}')"
echo "old sha: $(sha256sum "$BIN" | awk '{print $1}')"

echo "=== backup (二进制 + 主库 + gateway 库) ==="
sqlite3 /root/.hapi/hapi.db ".backup /root/.hapi/hapi.db.pre-$TAG-$TS"
sqlite3 /root/.hapi/multi-user-gateway.sqlite ".backup /root/.hapi/multi-user-gateway.sqlite.pre-$TAG-$TS"
ls -la /root/.hapi/*.pre-$TAG-$TS

echo "=== swap ==="
systemctl stop hapi-hub
mv "$BIN" /root/hapi.bin.pre-$TAG-$TS
mv "$NEW" "$BIN"
chmod 755 "$BIN"
systemctl start hapi-hub
echo "swapped at $TS; rollback binary = /root/hapi.bin.pre-$TAG-$TS"
