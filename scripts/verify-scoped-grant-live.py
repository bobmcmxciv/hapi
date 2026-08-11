#!/usr/bin/env python3
"""生产环境走真实登录路径验证目录限定授权（不自签 JWT）。

流程：admin 用真 cliApiToken 走 POST /api/auth 换 JWT → 建临时账号 → 该账号用
用户名密码走真 /api/auth 换 JWT → 用 POST /api/grants 下发带 pathPrefix 的机器授权
→ 以真 JWT 跑完整矩阵 → 清理（撤授权、删账号、归档 spawn 出来的会话）。

在 ECS 上执行。入口用公网 URL，与 peter 实际用的是同一条路。
"""
import json
import sys
import urllib.request
import urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://bob.18852271093.top"
ADMIN_TOKEN = sys.argv[2]
MACHINE = "b8181939-c3fe-47cc-89a6-9af0d7ac2b55"
B = chr(92)
SCOPE = "C:" + B + "Users" + B + "Administrator" + B + "peter"
OUTSIDE = "C:" + B + "Users" + B + "Administrator" + B + "hapi"
TMP_USER = "scope-verify-tmp"
TMP_PASS = "verify-scope-20260811!"

failures = []


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode()
            return response.getcode(), (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"raw": raw[:200]}


def check(label, got, want):
    ok = got == want
    print("  [{}] {}: got {} want {}".format("PASS" if ok else "FAIL", label, got, want))
    if not ok:
        failures.append(label)
    return ok


print("=== 0. admin 真登录（accessToken = 本机 cliApiToken）===")
status, body = call("POST", "/api/auth", {"accessToken": ADMIN_TOKEN})
check("admin login", status, 200)
admin_jwt = body.get("token")
claims = json.loads(__import__("base64").urlsafe_b64decode(
    admin_jwt.split(".")[1] + "=" * (-len(admin_jwt.split(".")[1]) % 4)).decode())
print("  admin claims:", {k: claims[k] for k in sorted(claims) if k in ("uid", "ns", "gaid", "role", "source", "tid")})

print("=== 1. 建临时账号 ===")
status, body = call("POST", "/api/accounts",
                    {"username": TMP_USER, "password": TMP_PASS, "role": "user"}, admin_jwt)
if status == 201:
    tmp_id = body["account"]["id"]
else:
    status2, listing = call("GET", "/api/accounts", None, admin_jwt)
    tmp_id = next((a["id"] for a in listing.get("accounts", []) if a["username"] == TMP_USER), None)
    print("  account already existed ->", tmp_id)
check("account created/resolved", tmp_id is not None, True)
print("  tmp account id:", tmp_id)

print("=== 2. 临时账号真登录（用户名+密码，不是自签 JWT）===")
status, body = call("POST", "/api/auth", {"username": TMP_USER, "password": TMP_PASS})
check("tmp login", status, 200)
tmp_jwt = body.get("token")
tclaims = json.loads(__import__("base64").urlsafe_b64decode(
    tmp_jwt.split(".")[1] + "=" * (-len(tmp_jwt.split(".")[1]) % 4)).decode())
print("  tmp claims:", {k: tclaims[k] for k in sorted(tclaims) if k in ("uid", "ns", "gaid", "role", "source")})
check("jwt gaid == account id", tclaims.get("gaid"), tmp_id)

print("=== 3. 无授权基线：vircs 不可见、spawn 应 403 ===")
status, body = call("GET", "/api/machines", None, tmp_jwt)
ids = [m["id"] for m in body.get("machines", [])]
check("machines before grant", MACHINE in ids, False)
status, body = call("POST", "/api/machines/%s/spawn" % MACHINE, {"directory": SCOPE, "agent": "claude"}, tmp_jwt)
check("spawn before grant", status, 403)

print("=== 4. 经 API 下发带 pathPrefix 的机器授权（不是手改 SQL）===")
status, body = call("POST", "/api/grants/machine/" + MACHINE,
                    {"accountId": tmp_id, "role": "operator", "pathPrefix": SCOPE}, admin_jwt)
check("grant with pathPrefix", status, 201)
status, body = call("GET", "/api/grants/machine/" + MACHINE, None, admin_jwt)
mine = [g for g in body.get("grants", []) if g.get("accountId") == tmp_id]
print("  grant row echoed:", mine)
check("pathPrefix echoed by API", mine[0].get("pathPrefix") if mine else None, SCOPE)

print("=== 5. 矩阵（全部用真登录换来的 JWT）===")
status, body = call("GET", "/api/machines", None, tmp_jwt)
ids = [m["id"] for m in body.get("machines", [])]
check("vircs 出现在机器列表", MACHINE in ids, True)

status, body = call("GET", "/api/sessions", None, tmp_jwt)
sessions = body.get("sessions", [])
paths = sorted(set((s.get("metadata") or {}).get("path") for s in sessions))
print("  可见会话 %d 条，路径集合: %s" % (len(sessions), paths))
outside = [p for p in paths if p and not p.lower().replace(B, "/").startswith(SCOPE.lower().replace(B, "/"))]
check("可见会话全部落在限定内", outside, [])

status, body = call("POST", "/api/machines/%s/spawn" % MACHINE,
                    {"directory": SCOPE + B + "mac", "agent": "claude"}, tmp_jwt)
check("限定内 spawn", status, 200)
spawned = body.get("sessionId")
print("  spawned:", spawned)

status, body = call("POST", "/api/machines/%s/spawn" % MACHINE, {"directory": OUTSIDE, "agent": "claude"}, tmp_jwt)
check("限定外 spawn 被拒", status, 403)

status, body = call("POST", "/api/machines/%s/list-directory" % MACHINE, {"path": OUTSIDE}, tmp_jwt)
check("限定外 list-directory 被拒", status, 403)

status, body = call("POST", "/api/machines/%s/paths/exists" % MACHINE,
                    {"paths": [SCOPE, OUTSIDE]}, tmp_jwt)
check("paths/exists 含越界项整体拒", status, 403)

status, body = call("PATCH", "/api/machines/" + MACHINE, {"displayName": "nope"}, tmp_jwt)
check("PATCH 改机器名被拒", status, 403)

print("=== 6. 清理 ===")
if spawned:
    status, _ = call("POST", "/api/sessions/%s/archive" % spawned, {}, tmp_jwt)
    check("归档 spawn 出来的会话", status, 200)
status, _ = call("DELETE", "/api/grants/machine/%s/%s" % (MACHINE, tmp_id), None, admin_jwt)
print("  revoke grant ->", status)
status, _ = call("DELETE", "/api/accounts/%s" % tmp_id, None, admin_jwt)
print("  delete account ->", status)
status, listing = call("GET", "/api/accounts", None, admin_jwt)
check("临时账号已删干净", [a["username"] for a in listing.get("accounts", []) if a["username"] == TMP_USER], [])

print()
print("RESULT:", "ALL PASS" if not failures else "FAILURES: " + ", ".join(failures))
sys.exit(1 if failures else 0)
