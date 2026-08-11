#!/usr/bin/env bash
# 把新编的 linux hub 二进制推到 ECS 暂存目录（只暂存，不换芯 —— 换芯要带备份单独做）。
#
# 与 push-client-downloads.sh 同型：vircs 无 rsync/zstd，单条 scp 只有 ~24-35KB/s，
# 所以 gzip → split 12m → 并行 scp（-P 3，再高会 Connection reset）→ 逐块 md5 判收。
# 判收只认逐块 md5，不看大小（CLAUDE.md §2.6：曾按大小判完成而首块还差 786KB）。
# git-bash 的 md5sum 输出带 `*` 前缀，两边都要 tr -d '*' 归一，否则 comm 永远判成全缺。
set -uo pipefail

REPO=/c/Users/Administrator/hapi
TAG=${TAG:-scoped-grants}
SRC=$REPO/cli/dist-exe/bun-linux-x64-baseline/hapi
NAME=hapi-linux-x64-$TAG
STAGE=$REPO/cli/dist-exe/xfer-hub-$TAG
REMOTE=/root/xfer-hub-$TAG

[ -f "$SRC" ] || { echo "FATAL: missing $SRC"; exit 1; }

mkdir -p "$STAGE" && cd "$STAGE" || exit 1

echo "=== 1/4 compress ==="
[ -s "$NAME.gz" ] || gzip -9 -c "$SRC" > "$NAME.gz" || exit 1
ls -la "$NAME.gz"

echo "=== 2/4 split ==="
rm -f part-*
split -b 12m -d "$NAME.gz" part- || exit 1
md5sum part-* | tr -d '*' | awk '{print $1, $2}' | sort > local.md5
echo "parts=$(wc -l < local.md5)"

echo "=== 3/4 transfer (parallel 3, retry until per-chunk md5 all match) ==="
ssh ecs "mkdir -p $REMOTE" || exit 1
for attempt in $(seq 1 20); do
    ssh ecs "cd $REMOTE && md5sum * 2>/dev/null" | tr -d '*' | awk 'NF==2 {print $1, $2}' | sort > remote.md5
    comm -23 local.md5 remote.md5 | awk '{print $2}' | sort -u > todo.txt
    todo=$(wc -l < todo.txt)
    echo "attempt=$attempt todo=$todo at $(date +%H:%M:%S)"
    [ "$todo" -eq 0 ] && break
    # 坏块先删再传：续写会把块撑坏（实测 6 块里 part-ae 尺寸满但 md5 不符）
    xargs -a todo.txt -I{} ssh ecs "rm -f $REMOTE/{}" 2>/dev/null
    xargs -a todo.txt -P 3 -I{} scp -q {} "ecs:$REMOTE/{}"
done
[ "$(wc -l < todo.txt)" -eq 0 ] || { echo "FATAL: chunks still missing/corrupt after retries"; cat todo.txt; exit 1; }

echo "=== 4/4 reassemble + verify sha256 on ECS ==="
LOCAL_SHA=$(sha256sum "$SRC" | tr -d '*' | awk '{print $1}')
echo "local  sha256=$LOCAL_SHA"
ssh ecs "set -e
cd $REMOTE
cat part-* > $NAME.gz && gunzip -f $NAME.gz
chmod 755 $NAME
sha256sum $NAME" > remote.sha 2>&1 || { echo "FATAL: reassemble failed"; cat remote.sha; exit 1; }
cat remote.sha
REMOTE_SHA=$(awk -v n="$NAME" '$2 == n {print $1}' remote.sha | head -1)
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] || { echo "FATAL: sha256 mismatch (local=$LOCAL_SHA remote=$REMOTE_SHA)"; exit 1; }
echo "sha256 OK — staged at $REMOTE/$NAME （尚未换芯）"
echo "DONE"
