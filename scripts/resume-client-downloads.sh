#!/usr/bin/env bash
# 断点续传（v2）：按 64KB 对齐用 dd seek 定点写入远端分块，只补缺失的字节。
#
# 踩过的两个坑，别退回去：
# 1) scp 整块重试 —— vircs→ECS 的稳定窗口小于 12MB 块的传输时间（实测有效速率
#    7.6~35KB/s 波动），断一次就整块作废，永不收敛。
# 2) v1 用 `truncate -s $A` + `cat >>` —— ssh 探测失败时 R 取不到被当成 0，
#    于是把已传的字节 truncate 掉，进度倒退。现在探测失败就跳过本轮，绝不动远端。
#
# 另外：同时只允许一个传输脚本在跑。多个脚本并存会互相删改同一批分块
# （2026-08-11 实测三个并存，块尺寸反复变小）。启动前先确认没有同名进程。
set -uo pipefail

REPO=/c/Users/Administrator/hapi
TAG=${TAG:-0271f0}
BS=65536
STAGE=$REPO/cli/dist-exe/xfer-client-$TAG
REMOTE=/root/xfer-client-$TAG
DEST=/root/.hapi/downloads
NAME_WIN=hapi-win32-x64-$TAG.exe
NAME_MAC=hapi-darwin-arm64-$TAG
SRC_WIN=$REPO/cli/dist-exe/bun-windows-x64/hapi.exe
SRC_MAC=$REPO/cli/dist-exe/bun-darwin-arm64/hapi
SSHOPT="-o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"

cd "$STAGE" || exit 1
ssh $SSHOPT ecs "mkdir -p $REMOTE" >/dev/null 2>&1

remote_size() {
    local out
    out=$(ssh $SSHOPT ecs "stat -c %s $REMOTE/$1 2>/dev/null || echo 0" 2>/dev/null | tr -d '\r ')
    case "$out" in ''|*[!0-9]*) echo "" ;; *) echo "$out" ;; esac
}

push_one() {
    local p=$1 L R A
    L=$(stat -c %s "$p")
    for try in $(seq 1 120); do
        R=$(remote_size "$p")
        if [ -z "$R" ]; then
            echo "$p try=$try probe-failed (远端尺寸读不到，跳过本轮，不动远端)"
            continue
        fi
        if [ "$R" -ge "$L" ]; then
            echo "$p COMPLETE $R/$L tries=$((try-1))"
            return 0
        fi
        A=$(( R / BS * BS ))
        echo "$p try=$try seek=$A remote=$R/$L $(date +%H:%M:%S)"
        dd if="$p" bs=$BS skip=$(( A / BS )) 2>/dev/null \
            | ssh $SSHOPT ecs "dd of=$REMOTE/$p bs=$BS seek=$(( A / BS )) conv=notrunc 2>/dev/null"
    done
    echo "$p GAVE-UP after 120 tries"
    return 1
}

echo "=== 1/4 resume (dd seek, 缺块并发 2) ==="
pending=""
for p in $(ls win-part-* mac-part-* 2>/dev/null); do
    L=$(stat -c %s "$p")
    R=$(remote_size "$p")
    if [ -n "$R" ] && [ "$R" -ge "$L" ]; then echo "$p already complete $R/$L"; else pending="$pending $p"; fi
done
echo "pending:$pending"
for p in $pending; do
    push_one "$p" &
    while [ "$(jobs -rp | wc -l)" -ge 2 ]; do wait -n; done
done
wait

echo "=== 2/4 per-chunk md5 ==="
md5sum win-part-* mac-part-* | tr -d '*' | awk '{print $1, $2}' | sort > local.md5
ssh $SSHOPT ecs "cd $REMOTE && md5sum *part-* 2>/dev/null" | tr -d '*' | awk 'NF==2 {print $1, $2}' | sort > remote.md5
comm -23 local.md5 remote.md5 > bad.md5
if [ -s bad.md5 ]; then echo "FATAL: 下列块 md5 不符或缺失:"; cat bad.md5; exit 1; fi
echo "all $(wc -l < local.md5) chunks md5 OK"

echo "=== 3/4 reassemble + sha256 对账 ==="
LOCAL_WIN_SHA=$(sha256sum "$SRC_WIN" | tr -d '*' | awk '{print $1}')
LOCAL_MAC_SHA=$(sha256sum "$SRC_MAC" | tr -d '*' | awk '{print $1}')
echo "local win=$LOCAL_WIN_SHA"
echo "local mac=$LOCAL_MAC_SHA"
ssh $SSHOPT ecs "set -e
cd $REMOTE
cat win-part-* > $NAME_WIN.gz && gunzip -f $NAME_WIN.gz
cat mac-part-* > $NAME_MAC.gz && gunzip -f $NAME_MAC.gz
sha256sum $NAME_WIN $NAME_MAC" > remote.sha 2>&1 || { echo "FATAL: reassemble failed"; cat remote.sha; exit 1; }
cat remote.sha
grep -q "$LOCAL_WIN_SHA" remote.sha || { echo "FATAL: win sha256 mismatch"; exit 1; }
grep -q "$LOCAL_MAC_SHA" remote.sha || { echo "FATAL: mac sha256 mismatch"; exit 1; }
echo "sha256 OK both"

echo "=== 4/4 publish ==="
ssh $SSHOPT ecs "set -e
mv $REMOTE/$NAME_WIN $DEST/$NAME_WIN
mv $REMOTE/$NAME_MAC $DEST/$NAME_MAC
chmod 644 $DEST/$NAME_WIN $DEST/$NAME_MAC
rm -rf $REMOTE
ls -la $DEST" || exit 1
echo "DONE"
