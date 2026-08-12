"""Run ON the hub host. Find recently-offline sessions and resume them,
preserving each session's stored model / context-window / effort parameters.

Why the resume-model step exists: syncEngine gates stored-model passthrough on
`flavor !== 'claude' || session.resumeWithSessionModel`. A claude-flavor session
resumed without that flag comes back on the machine's *default* model, silently
dropping e.g. `gpt-5.6-sol[1m]` -> whatever the box defaults to. So for claude
sessions that carry a stored model we first POST /resume-model {true}.
"""
import json, sys, time, urllib.request, urllib.error

BASE = 'http://127.0.0.1:13006'
WINDOW_H = float(sys.argv[1]) if len(sys.argv) > 1 else 12.0
APPLY = len(sys.argv) > 2 and sys.argv[2] == 'apply'

tok = json.load(open('/root/.hapi/settings.json'))['cliApiToken']
req = urllib.request.Request(BASE + '/api/auth', method='POST',
                             data=json.dumps({'accessToken': tok}).encode())
req.add_header('content-type', 'application/json')
JWT = json.loads(urllib.request.urlopen(req, timeout=60).read())['token']


def api(path, method='GET', body=None, timeout=120):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header('authorization', 'Bearer ' + JWT)
    if body is not None:
        r.add_header('content-type', 'application/json')
        r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            return x.status, json.loads(x.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}


_, ss = api('/api/sessions')
now_ms = time.time() * 1000
cands = []
for s in ss['sessions']:
    if s.get('active'):
        continue
    md = s.get('metadata') or {}
    if md.get('archivedAt') or s.get('archivedAt'):
        continue
    if (md.get('lifecycleState') or '') == 'archived':
        continue
    at = s.get('activeAt') or s.get('updatedAt') or 0
    if now_ms - at > WINDOW_H * 3600 * 1000:
        continue
    cands.append(s)

cands.sort(key=lambda x: -(x.get('activeAt') or 0))
print('offline within %sh: %d' % (WINDOW_H, len(cands)))

results = []
for s in cands:
    sid = s['id']
    md = s.get('metadata') or {}
    # summary rows may omit model fields; fetch the detail record
    st, det = api('/api/sessions/%s' % sid)
    d = det.get('session', det) if st == 200 else {}
    model = d.get('model')
    flavor = (md.get('flavor') or 'claude')
    idle_h = (now_ms - (s.get('activeAt') or 0)) / 3600000
    line = '%s host=%-16s flavor=%-8s model=%-22s effort=%-6s idle=%.1fh path=%s' % (
        sid[:8], md.get('host'), flavor, model, d.get('modelReasoningEffort') or d.get('effort'),
        idle_h, str(md.get('path'))[:44])
    if not APPLY:
        print('  ' + line)
        continue

    steps = []
    if flavor == 'claude' and model:
        st1, _ = api('/api/sessions/%s/resume-model' % sid, 'POST', {'resumeWithSessionModel': True})
        steps.append('resume-model=%s' % st1)
    st2, r2 = api('/api/sessions/%s/resume' % sid, 'POST', {}, timeout=180)
    steps.append('resume=%s %s' % (st2, json.dumps(r2)[:110]))
    print('  %s\n      %s' % (line, ' | '.join(steps)))
    results.append((sid, st2))
    time.sleep(2)

if APPLY:
    ok = sum(1 for _, c in results if c == 200)
    print('\nresumed OK=%d / attempted=%d' % (ok, len(results)))
