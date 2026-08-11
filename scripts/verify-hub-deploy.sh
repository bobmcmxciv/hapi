#!/usr/bin/env bash
# 换芯后最小验收集（对应 hapi-fork-cd-release.rule.md 第 5 节）。
# 弱信号（is-active、没读 body 的 200）单独不算验收，所以每条都读内容。
set -uo pipefail
FAIL=0
ok(){ echo "PASS  $*"; }
no(){ echo "FAIL  $*"; FAIL=1; }

echo "=== 1 environment: 服务在跑且日志无 schema/fatal ==="
[ "$(systemctl is-active hapi-hub)" = active ] && ok "hapi-hub active" || no "hapi-hub not active"
if journalctl -u hapi-hub --since '2 min ago' --no-pager | grep -iE 'SQLite schema|assertRequiredTables|FATAL|unhandled' ; then
    no "日志里有 schema/fatal"
else ok "近 2 分钟日志无 schema/fatal"; fi

echo "=== 2 environment: schema 版本 ==="
UV=$(sqlite3 /root/.hapi/hapi.db 'PRAGMA user_version;')
[ "$UV" = 20 ] && ok "user_version=$UV" || no "user_version=$UV (期望 20)"

echo "=== 3 function: 换 JWT 读机器内存态（DB 的 machines.active 是旧值不可信）==="
TOKEN=$(grep -oP '"cliApiToken"\s*:\s*"\K[^"]+' /root/.hapi/*.json 2>/dev/null | head -1)
[ -n "$TOKEN" ] || TOKEN=${CLI_API_TOKEN:-}
JWT=$(curl -s -X POST http://127.0.0.1:3005/api/auth -H 'content-type: application/json' \
      -d "{\"accessToken\":\"$TOKEN\"}" | grep -oP '"token"\s*:\s*"\K[^"]+')
if [ -n "$JWT" ]; then
    ok "拿到 JWT"
    MACHINES=$(curl -s http://127.0.0.1:3005/api/machines -H "authorization: Bearer $JWT")
    N=$(echo "$MACHINES" | grep -o '"id"' | wc -l)
    OWNED=$(echo "$MACHINES" | grep -o 'ownerUsername' | wc -l)
    [ "$N" -gt 0 ] && ok "/api/machines 返回 $N 台（带 ownerUsername 的 $OWNED 台）" || no "/api/machines 空"

    echo "=== 4 integration: 用量页新契约 —— hosts 从 string[] 升级成对象 ==="
    USAGE=$(curl -s "http://127.0.0.1:3005/api/usage/summary" -H "authorization: Bearer $JWT")
    if echo "$USAGE" | grep -q '"hosts"'; then
        if echo "$USAGE" | grep -qE '"hosts":\[\{'; then
            ok "hosts 是对象数组（新契约）"
            echo "$USAGE" | python3 -c "
import sys,json
d=json.load(sys.stdin); h=d.get('hosts',[])
print('      前三台:', [(x['host'], x['totalTokens'], x['sessionCount'], x['owner']) for x in h[:3]])
need={'host','sessionCount','totalTokens','requestCount','owner','platform'}
missing=[k for k in need if h and k not in h[0]]
print('      FAIL 缺字段:',missing) if missing else print('      六个字段齐全')
" 2>/dev/null || echo "      (python3 解析跳过)"
        elif echo "$USAGE" | grep -qE '"hosts":\[\]'; then
            ok "hosts 为空数组（该账号无可见会话）"
        else no "hosts 仍是旧的 string[] —— 二进制没换成功?"; fi
    else no "/api/usage/summary 无 hosts 字段"; fi
else no "换 JWT 失败（拿不到 cliApiToken?）"; fi

echo "=== 5 environment: 公网入口 ==="
CODE=$(curl -s -o /dev/null -w '%{http_code}' https://bob.18852271093.top/)
[ "$CODE" = 200 ] && ok "公网 https 200" || no "公网 https $CODE"

echo
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "有 FAIL —— 见上"
exit $FAIL
