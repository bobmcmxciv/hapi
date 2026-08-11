#!/usr/bin/env bash
# 把新编的客户端二进制推到 ECS 的 /root/.hapi/downloads/（hub 的 /download/<token>/<file> 就读这个目录）。
#
# 为什么是 split + 并行 scp 而不是 rsync：vircs 上没有 rsync/zstd/pigz（2026-08-11 实测
# command -v 全空），ECS 侧有 rsync 但发送端没有就用不上。单条 scp 实测 ~35KB/s，
# GitHub release asset 直链在 ECS 上只有 17.5KB/s（更慢），所以仍走 scp 并行。
#
# 判收只认逐块 md5（见 CLAUDE.md §2.6）。git-bash 的 md5sum 输出带 `*` 前缀，两边都要归一。
set -uo pipefail

REPO=/c/Users/Administrator/hapi
TAG=${TAG:-0271f0}
SRC_WIN=$REPO/cli/dist-exe/bun-windows-x64/hapi.exe
SRC_MAC=$REPO/cli/dist-exe/bun-darwin-arm64/hapi
NAME_WIN=hapi-win32-x64-$TAG.exe
NAME_MAC=hapi-darwin-arm64-$TAG
STAGE=$REPO/cli/dist-exe/xfer-client-$TAG
REMOTE=/root/xfer-client-$TAG
DEST=/root/.hapi/downloads

for f in "$SRC_WIN" "$SRC_MAC"; do
    [ -f "$f" ] || { echo "FATAL: missing $f"; exit 1; }
done

mkdir -p "$STAGE" && cd "$STAGE" || exit 1

echo "=== 1/5 compress ==="
if [ ! -s "$NAME_WIN.gz" ]; then gzip -9 -c "$SRC_WIN" > "$NAME_WIN.gz" & fi
if [ ! -s "$NAME_MAC.gz" ]; then gzip -9 -c "$SRC_MAC" > "$NAME_MAC.gz" & fi
wait
ls -la "$NAME_WIN.gz" "$NAME_MAC.gz" || exit 1

echo "=== 2/5 split ==="
rm -f win-part-* mac-part-*
split -b 12m -d "$NAME_WIN.gz" win-part- || exit 1
split -b 12m -d "$NAME_MAC.gz" mac-part- || exit 1
md5sum win-part-* mac-part-* | tr -d '*' | awk '{print $1, $2}' | sort > local.md5
echo "parts=$(wc -l < local.md5)"

echo "=== 3/5 transfer (parallel 3, retry until per-chunk md5 all match) ==="
ssh ecs "mkdir -p $REMOTE" || exit 1
for attempt in $(seq 1 12); do
    ssh ecs "cd $REMOTE && md5sum * 2>/dev/null" | tr -d '*' | awk 'NF==2 {print $1, $2}' | sort > remote.md5
    comm -23 local.md5 remote.md5 | awk '{print $2}' | sort -u > todo.txt
    todo=$(wc -l < todo.txt)
    echo "attempt=$attempt todo=$todo at $(date +%H:%M:%S)"
    [ "$todo" -eq 0 ] && break
    # 坏块先删掉再传，避免续写把块撑坏
    xargs -a todo.txt -I{} ssh ecs "rm -f $REMOTE/{}" 2>/dev/null
    xargs -a todo.txt -P 3 -I{} scp -q {} "ecs:$REMOTE/{}"
done
[ "$(wc -l < todo.txt)" -eq 0 ] || { echo "FATAL: chunks still missing/corrupt after retries"; cat todo.txt; exit 1; }

echo "=== 4/5 reassemble + verify sha256 on ECS ==="
LOCAL_WIN_SHA=$(sha256sum "$SRC_WIN" | tr -d '*' | awk '{print $1}')
LOCAL_MAC_SHA=$(sha256sum "$SRC_MAC" | tr -d '*' | awk '{print $1}')
echo "local  win=$LOCAL_WIN_SHA"
echo "local  mac=$LOCAL_MAC_SHA"
ssh ecs "set -e
cd $REMOTE
cat win-part-* > $NAME_WIN.gz && gunzip -f $NAME_WIN.gz
cat mac-part-* > $NAME_MAC.gz && gunzip -f $NAME_MAC.gz
sha256sum $NAME_WIN $NAME_MAC" > remote.sha 2>&1 || { echo "FATAL: reassemble failed"; cat remote.sha; exit 1; }
cat remote.sha
REMOTE_WIN_SHA=$(awk -v n="$NAME_WIN" '$2 ~ n {print $1}' remote.sha | head -1)
REMOTE_MAC_SHA=$(awk -v n="$NAME_MAC" '$2 == n {print $1}' remote.sha | head -1)
[ "$LOCAL_WIN_SHA" = "$REMOTE_WIN_SHA" ] || { echo "FATAL: win sha256 mismatch"; exit 1; }
[ "$LOCAL_MAC_SHA" = "$REMOTE_MAC_SHA" ] || { echo "FATAL: mac sha256 mismatch"; exit 1; }
echo "sha256 OK both"

echo "=== 5/5 publish into $DEST ==="
ssh ecs "set -e
mv $REMOTE/$NAME_WIN $DEST/$NAME_WIN
mv $REMOTE/$NAME_MAC $DEST/$NAME_MAC
chmod 644 $DEST/$NAME_WIN $DEST/$NAME_MAC
rm -rf $REMOTE
ls -la $DEST" || exit 1
echo "DONE"
