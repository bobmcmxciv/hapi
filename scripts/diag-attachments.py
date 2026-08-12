"""Run ON the hub host. Dump how image-bearing messages are actually shaped,
so we stop guessing which transport the broken pictures use."""
import json, sys, urllib.request, urllib.error, collections

BASE = 'http://127.0.0.1:13006'
tok = json.load(open('/root/.hapi/settings.json'))['cliApiToken']
req = urllib.request.Request(BASE + '/api/auth', method='POST',
                             data=json.dumps({'accessToken': tok}).encode())
req.add_header('content-type', 'application/json')
JWT = json.loads(urllib.request.urlopen(req, timeout=60).read())['token']


def api(p, raw=False, timeout=180):
    r = urllib.request.Request(BASE + p)
    r.add_header('authorization', 'Bearer ' + JWT)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            d = x.read()
            return x.status, (d if raw else json.loads(d))
    except urllib.error.HTTPError as e:
        d = e.read()
        try:
            return e.code, (d if raw else json.loads(d))
        except Exception:
            return e.code, d


needle = sys.argv[1] if len(sys.argv) > 1 else 'fgo-agent'
st, ss = api('/api/sessions')
hits = [s for s in ss['sessions'] if needle.lower() in str(s.get('metadata', {}).get('path', '')).lower()]
hits.sort(key=lambda x: -x.get('updatedAt', 0))

kinds = collections.Counter()
samples = {}
for s in hits[:4]:
    sid = s['id']
    st, m = api('/api/sessions/%s/messages?limit=200' % sid)
    for msg in m.get('messages', []):
        blob = json.dumps(msg)
        if 'image' not in blob.lower():
            continue
        c = msg.get('content')
        if not isinstance(c, dict):
            continue
        d = c.get('data') if isinstance(c.get('data'), dict) else {}
        key = '%s/%s' % (c.get('type'), d.get('type'))
        kinds[key] += 1
        if key not in samples:
            samples[key] = (sid, blob[:900])

print('image-bearing message shapes:')
for k, n in kinds.most_common():
    print('  %-40s x%d' % (k, n))
print()
for k, (sid, blob) in list(samples.items())[:6]:
    print('=== %s  (session %s)' % (k, sid[:8]))
    print(blob[:900])
    print()
