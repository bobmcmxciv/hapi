"""End-to-end check of the chunked / persistent-snapshot file transfer.

Runs against the live hub. Proves two things the unit tests cannot:
  1. a blob larger than one 2 MiB chunk round-trips byte-exact through the real
     hub -> socket.io -> CLI path;
  2. the snapshot survives the sending session process being killed, which is
     precisely the failure that made every pre-restart file card 404.
"""
import hashlib, json, subprocess, sys, time, urllib.request

HUB = 'https://bob.18852271093.top'
MACHINE_HOST = sys.argv[1] if len(sys.argv) > 1 else 'DESKTOP-4SQALMG'
SRC = sys.argv[2] if len(sys.argv) > 2 else 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\e2e-5mb.bin'
EXPECT_SHA = sys.argv[3] if len(sys.argv) > 3 else None
DIRECTORY = sys.argv[4] if len(sys.argv) > 4 else 'C:\\Users\\Administrator'


def ssh(host, cmd):
    return subprocess.check_output(['ssh', '-o', 'ConnectTimeout=15', host, cmd],
                                   stderr=subprocess.DEVNULL).decode()


def api(path, jwt, method='GET', body=None, raw=False):
    req = urllib.request.Request(HUB + path, method=method)
    req.add_header('authorization', 'Bearer ' + jwt)
    if body is not None:
        req.add_header('content-type', 'application/json')
        req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
            return (r.status, data) if raw else (r.status, json.loads(data))
    except urllib.error.HTTPError as e:
        data = e.read()
        if raw:
            return e.code, data
        try:
            return e.code, json.loads(data)
        except Exception:
            return e.code, data.decode('utf-8', 'replace')


tok = ssh('ecs', 'python3 -c "import json;print(json.load(open(\'/root/.hapi/settings.json\'))[\'cliApiToken\'])"').strip()
jwt = json.loads(ssh('ecs', 'curl -s -X POST http://127.0.0.1:13006/api/auth -H "content-type: application/json" -d \'{"accessToken":"%s"}\'' % tok))['token']
print('got JWT')

_, m = api('/api/machines', jwt)
machine = next(x for x in m['machines']
               if x.get('metadata', {}).get('host') == MACHINE_HOST and x.get('active'))
mid = machine['id']
print('machine %s id=%s cli=%s' % (MACHINE_HOST, mid[:12], machine['metadata'].get('happyCliVersion')))

st, spawn = api('/api/machines/%s/spawn' % mid, jwt, 'POST',
                {'directory': DIRECTORY, 'agent': 'claude', 'yolo': True, 'startingMode': 'remote'})
print('spawn ->', st, json.dumps(spawn)[:200])
sid = spawn.get('sessionId')
if not sid:
    print('FATAL: no sessionId'); sys.exit(1)
print('session', sid)

# Wait for the session to come up, then ask it to send the file.
for _ in range(60):
    st, s = api('/api/sessions/' + sid, jwt)
    if st == 200 and s.get('session', s).get('active'):
        break
    time.sleep(2)
print('session active')

prompt = ('Call the mcp__hapi__send_file tool with path "%s" and nothing else. '
          'Do not read the file. Do not summarize. Just call the tool.' % SRC)
st, r = api('/api/sessions/%s/messages' % sid, jwt, 'POST', {'text': prompt})
print('sent prompt ->', st)

# Poll for the generated-file envelope.
file_id = None
for _ in range(90):
    time.sleep(4)
    st, msgs = api('/api/sessions/%s/messages?limit=200' % sid, jwt)
    if st != 200:
        continue
    for msg in msgs.get('messages', []):
        c = msg.get('content')
        if isinstance(c, dict):
            d = c.get('data')
            if isinstance(d, dict) and d.get('type') == 'generated-file':
                file_id = d.get('fileId')
                print('generated-file: id=%s name=%s size=%s' % (file_id, d.get('fileName'), d.get('size')))
                break
    if file_id:
        break
if not file_id:
    print('FATAL: no generated-file message appeared'); sys.exit(1)

url = '/api/sessions/%s/generated-files/%s' % (sid, file_id)


def download(label):
    t0 = time.time()
    st, data = api(url, jwt, raw=True)
    dt = time.time() - t0
    if st == 200:
        sha = hashlib.sha256(data).hexdigest()
        ok = (EXPECT_SHA is None) or (sha == EXPECT_SHA)
        print('%-26s HTTP %s  %d bytes  %.1fs  sha=%s  %s'
              % (label, st, len(data), dt, sha[:16], 'MATCH' if ok else 'MISMATCH!'))
        return st, ok
    print('%-26s HTTP %s  %.1fs  %s' % (label, st, dt, str(data)[:160]))
    return st, False


st1, ok1 = download('1) 首次下载')

# Kill the session process on the machine -- the exact condition that used to
# invalidate every previously sent file.
print('killing session processes on %s ...' % MACHINE_HOST)
try:
    ssh(sys.argv[5] if len(sys.argv) > 5 else '4sqalmg', 'taskkill //F //IM hapi.exe 2>/dev/null; echo killed')
except Exception as e:
    print('  (kill returned nonzero, continuing):', e)
time.sleep(20)

st2, ok2 = download('2) 杀掉会话进程后再下载')

print()
print('结果: 首次 %s / 进程重启后 %s' % ('PASS' if (st1 == 200 and ok1) else 'FAIL',
                                        'PASS' if (st2 == 200 and ok2) else 'FAIL'))
