#!/usr/bin/env bash
# 把新编的 hub/CLI 二进制推到 ECS，逐块 md5 判收后在远端重组并对 sha256。
#
# 判收只认逐块 md5，不看大小（见 CLAUDE.md §2.6：曾用 du 判完成，触发时首块还差 786KB）。
# git-bash 的 md5sum 输出是 `<hash> *<name>`，两边都要 tr -d '*' 归一，否则 comm 永远判成全缺。
set -uo pipefail

REPO=/c/Users/Administrator/hapi
TAG=${TAG:-fork7}
SRC=$REPO/cli/dist-exe/bun-linux-x64-baseline/hapi
NAME=hapi-linux-x64-$TAG
STAGE=$REPO/cli/dist-exe/xfer-hub-$TAG
REMOTE=/root/xfer-hub-$TAG
SSHOPT="-o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"

[ -f "$SRC" ] || { echo "FATAL: missing $SRC"; exit 1; }
mkdir -p "$STAGE" && cd "$STAGE" || exit 1

echo "=== 1/4 compress ==="
if [ ! -s "$NAME.gz" ]; then gzip -9 -c "$SRC" > "$NAME.gz" || exit 1; fi
ls -la "$NAME.gz"

echo "=== 2/4 split ==="
rm -f part-*
split -b 12m -d "$NAME.gz" part- || exit 1
md5sum part-* | tr -d '*' | awk '{print $1, $2}' | sort > local.md5
echo "parts=$(wc -l < local.md5)"

echo "=== 3/4 transfer (parallel 3, retry until per-chunk md5 all match) ==="
ssh $SSHOPT ecs "mkdir -p $REMOTE" || exit 1
for attempt in $(seq 1 40); do
    ssh $SSHOPT ecs "cd $REMOTE && md5sum * 2>/dev/null" | tr -d '*' | awk 'NF==2 {print $1, $2}' | sort > remote.md5
    comm -23 local.md5 remote.md5 | awk '{print $2}' | sort -u > todo.txt
    todo=$(wc -l < todo.txt)
    echo "attempt=$attempt todo=$todo at $(date +%H:%M:%S)"
    [ "$todo" -eq 0 ] && break
    # 坏块先删再传，避免续写把块撑坏
    xargs -a todo.txt -I{} ssh $SSHOPT ecs "rm -f $REMOTE/{}" 2>/dev/null
    xargs -a todo.txt -P 3 -I{} scp -q $SSHOPT {} "ecs:$REMOTE/{}"
done
[ "$(wc -l < todo.txt)" -eq 0 ] || { echo "FATAL: chunks still missing/corrupt"; cat todo.txt; exit 1; }
echo "all $(wc -l < local.md5) chunks md5 OK"

echo "=== 4/4 reassemble + sha256 ==="
LOCAL_SHA=$(sha256sum "$SRC" | tr -d '*' | awk '{print $1}')
echo "local  sha=$LOCAL_SHA"
ssh $SSHOPT ecs "set -e; cd $REMOTE; cat part-* > $NAME.gz; gunzip -f $NAME.gz; sha256sum $NAME" > remote.sha 2>&1 \
    || { echo "FATAL: reassemble failed"; cat remote.sha; exit 1; }
cat remote.sha
grep -q "$LOCAL_SHA" remote.sha || { echo "FATAL: sha256 mismatch"; exit 1; }
echo "SHA256 OK — 就绪待换芯：$REMOTE/$NAME"
