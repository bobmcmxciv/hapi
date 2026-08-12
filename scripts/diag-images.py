"""Run ON the hub host. Separates 'blob is gone' from 'link cannot carry it'.

Fetching an image over the public URL exercises hub + WAN together, so a failure
there is ambiguous. Fetching from 127.0.0.1 removes the WAN, so:
  - 404 from localhost  -> the blob really is gone (CLI memory lost on restart)
  - 200 from localhost  -> the blob is fine and the WAN link is the problem
"""
import json, subprocess, sys, time, urllib.request, urllib.error

PORT = 13006
BASE = 'http://127.0.0.1:%d' % PORT

tok = json.load(open('/root/.hapi/settings.json'))['cliApiToken']


def api(path, raw=False, timeout=180):
    req = urllib.request.Request(BASE + path)
    req.add_header('authorization', 'Bearer ' + JWT)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = r.read()
            return r.status, (d if raw else json.loads(d))
    except urllib.error.HTTPError as e:
        d = e.read()
        try:
            return e.code, (d if raw else json.loads(d))
        except Exception:
            return e.code, d


req = urllib.request.Request(BASE + '/api/auth', method='POST',
                             data=json.dumps({'accessToken': tok}).encode())
req.add_header('content-type', 'application/json')
JWT = json.loads(urllib.request.urlopen(req, timeout=60).read())['token']

st, ss = api('/api/sessions')
sessions = ss['sessions']
needle = sys.argv[1] if len(sys.argv) > 1 else 'fgo-agent'
hits = [s for s in sessions if needle.lower() in str(s.get('metadata', {}).get('path', '')).lower()]
hits.sort(key=lambda x: -x.get('updatedAt', 0))
print('matched sessions: %d (of %d total)' % (len(hits), len(sessions)))

total_img = ok = gone = other = 0
for s in hits[:5]:
    sid = s['id']
    st, m = api('/api/sessions/%s/messages?limit=200' % sid)
    msgs = m.get('messages', []) if st == 200 else []
    imgs = []
    for msg in msgs:
        c = msg.get('content')
        if isinstance(c, dict):
            d = c.get('data')
            if isinstance(d, dict) and d.get('type') in ('generated-image', 'generated-file'):
                imgs.append(d)
    print('\n%s  active=%-5s msgs=%-4d blobs=%d  path=%s'
          % (sid[:8], s.get('active'), len(msgs), len(imgs), s.get('metadata', {}).get('path')))
    for d in imgs[:6]:
        total_img += 1
        kind = 'generated-images' if d.get('type') == 'generated-image' else 'generated-files'
        bid = d.get('imageId') or d.get('fileId') or d.get('id')
        t0 = time.time()
        st, body = api('/api/sessions/%s/%s/%s' % (sid, kind, bid), raw=True, timeout=300)
        dt = time.time() - t0
        if st == 200:
            ok += 1
            note = '%d bytes' % len(body)
        else:
            try:
                j = json.loads(body)
                note = '%s / %s' % (j.get('reason'), str(j.get('error'))[:70])
            except Exception:
                note = str(body)[:80]
            if st == 404:
                gone += 1
            else:
                other += 1
        print('   %-10s %-8s HTTP %s  %.2fs  %s' % (str(bid)[:8], d.get('type'), st, dt, note))

print('\n本机直连结果: 200=%d  404(真没了)=%d  其他=%d  合计=%d' % (ok, gone, other, total_img))
