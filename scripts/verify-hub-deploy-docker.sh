#!/usr/bin/env bash
# 换芯后最小验收集（docker 版，对应 hapi-fork-cd-release.rule.md 第 5 节）。
# 与 verify-hub-deploy.sh 的差别只有两处：systemctl → docker，journalctl → docker logs，
# 端口按容器 env 的 HAPI_LISTEN_PORT。弱信号（状态 running、没读 body 的 200）单独不算
# 验收，所以每条都读内容。
set -uo pipefail
FAIL=0
PORT=${PORT:-13006}
ok(){ echo "PASS  $*"; }
no(){ echo "FAIL  $*"; FAIL=1; }

echo "=== 1 environment: 容器在跑且日志无 schema/fatal ==="
ST=$(docker inspect -f '{{.State.Status}}' hapi-hub 2>/dev/null)
[ "$ST" = running ] && ok "hapi-hub container running" || no "hapi-hub status=$ST"
if docker logs hapi-hub --since 3m 2>&1 | grep -iE 'SQLite schema|assertRequiredTables|FATAL|unhandled'; then
    no "日志里有 schema/fatal"
else ok "近 3 分钟日志无 schema/fatal"; fi

echo "=== 2 environment: schema 版本未漂移 ==="
UV=$(sqlite3 /root/.hapi/hapi.db 'PRAGMA user_version;')
[ "$UV" = 20 ] && ok "user_version=$UV" || no "user_version=$UV (期望 20)"

echo "=== 3 function: 换 JWT 读机器内存态（DB 的 machines.active 是旧值不可信）==="
TOKEN=${CLI_API_TOKEN:-$(grep -oP '"cliApiToken"\s*:\s*"\K[^"]+' /root/.hapi/settings.json 2>/dev/null | head -1)}
JWT=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth" -H 'content-type: application/json' \
      -d "{\"accessToken\":\"$TOKEN\"}" | grep -oP '"token"\s*:\s*"\K[^"]+')
if [ -z "$JWT" ]; then no "拿不到 JWT"; else
    ok "拿到 JWT"
    curl -s "http://127.0.0.1:$PORT/api/machines" -H "authorization: Bearer $JWT" > /tmp/verify-machines.json
    python3 - <<'PY'
import json, sys
d = json.load(open('/tmp/verify-machines.json'))
ms = d.get('machines', [])
print(f"      /api/machines 返回 {len(ms)} 台")
nulls = [m['id'][:8] for m in ms if m.get('metadata') is None]
for m in ms:
    md = m.get('metadata') or {}
    print(f"      {m['id'][:8]}  name={md.get('displayName') or '(none)'}  host={md.get('host') or '(none)'}  owner={m.get('ownerUsername')}")
print("      metadata=null 的机器:", nulls or "无")
sys.exit(1 if nulls else 0)
PY
    [ $? -eq 0 ] && ok "没有机器的 metadata 塌成 null" || no "仍有机器 metadata=null（本次修复的正是这个）"

    echo "=== 4 integration: 用量页 fork 契约（hosts 为对象数组）==="
    USAGE=$(curl -s "http://127.0.0.1:$PORT/api/usage/summary" -H "authorization: Bearer $JWT")
    echo "$USAGE" | grep -qE '"hosts":\[\{' && ok "hosts 是对象数组（fork 形状）" \
        || no "hosts 不是 fork 形状：$(echo "$USAGE" | head -c 200)"
fi

echo "=== 5 environment: 公网入口 ==="
CODE=$(curl -s -o /tmp/verify-pub.html -w '%{http_code}' https://bob.18852271093.top/)
grep -qiE '<div id="root"|<title' /tmp/verify-pub.html && [ "$CODE" = 200 ] \
    && ok "公网 200 且返回的是 web 应用外壳" || no "公网 code=$CODE，body 头部：$(head -c 120 /tmp/verify-pub.html)"

echo
[ $FAIL -eq 0 ] && echo "ALL PASS" || echo "有 FAIL，见上"
exit $FAIL
