#!/usr/bin/env bash
# 把 xfer-sub 里的分块推到 ECS，逐块 md5 判收，缺哪块补哪块。
#
# 为什么长这样（每条都踩过，见 CLAUDE.md §2.6）：
#   - 单条 scp 只有 ~24KB/s，必须并行；但 -P 8 会把链路打崩，用 ≤3。
#   - 判完成**只认逐块 md5**，不看大小——曾出现尺寸满而内容损坏。
#   - git-bash 的 md5sum 输出是 `<hash> *<name>`，两边都要 tr -d '*' 归一，
#     否则比对永远判成全缺、脚本无限重传。
#   - 后台串联命令用 `;` 会让末尾命令的退出码掩盖前面的失败，这里显式判。

set -uo pipefail

LOCAL_DIR=/c/Users/Administrator/hapi/cli/dist-exe/bun-linux-x64-baseline/xfer-sub
REMOTE_DIR=/root/xfer-sub
MAX_ROUNDS=20
PARALLEL=3

ssh ecs "mkdir -p $REMOTE_DIR" || { echo "FATAL: cannot mkdir on ecs"; exit 1; }

norm_md5() { md5sum "$@" 2>/dev/null | awk '{gsub(/\*/,"",$NF); print $1, $NF}' | sort; }

cd "$LOCAL_DIR" || exit 1
norm_md5 part-* > /tmp/sub-local.md5
echo "local chunks: $(wc -l < /tmp/sub-local.md5)"

for round in $(seq 1 $MAX_ROUNDS); do
    # 远端逐块 md5，归一化后与本地比，得出还缺哪些块
    ssh ecs "cd $REMOTE_DIR 2>/dev/null && md5sum part-* 2>/dev/null" \
        | awk '{gsub(/\*/,"",$NF); print $1, $NF}' | sort > /tmp/sub-remote.md5
    missing=$(comm -23 /tmp/sub-local.md5 /tmp/sub-remote.md5 | awk '{print $2}' | sort -u)

    if [ -z "$missing" ]; then
        echo "ROUND $round: all chunks verified by md5"
        exit 0
    fi

    count=$(echo "$missing" | wc -l)
    echo "ROUND $round: $count chunk(s) missing/corrupt -> $(echo $missing | tr '\n' ' ')"

    # 并行推，但每段单独捕获退出码，不让链末成功掩盖前面的失败
    echo "$missing" | xargs -P $PARALLEL -I{} sh -c \
        'scp -o ConnectTimeout=20 -o ServerAliveInterval=10 -q "{}" ecs:'"$REMOTE_DIR"'/ ; \
         echo "  scp {} exit=$?"'
done

echo "FATAL: still incomplete after $MAX_ROUNDS rounds"
exit 1
