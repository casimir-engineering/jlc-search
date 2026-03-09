import json, sys

d = json.load(sys.stdin)
p = d['data']['componentPageInfo']['list'][0]
for k in sorted(p.keys()):
    v = p[k]
    if v is not None and v != '' and v != [] and v != {}:
        print(f'  {k}: {str(v)[:150]}')
