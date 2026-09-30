import json,statistics as st
d=json.load(open('jev-results.json'))
T=d['triage']
def rate(xs): return f"{sum(xs)}/{len(xs)} ({100*sum(xs)/len(xs):.0f}%)"
print('TRIAGE overall act',rate([t['actOk'] for t in T]),'route',rate([t['routeOk'] for t in T]),'urg',rate([t['urgOk'] for t in T]))
for L in ['en','zh','ja']:
    x=[t for t in T if t['lang']==L]
    print(L,'act',rate([t['actOk'] for t in x]),'route',rate([t['routeOk'] for t in x]),'urg',rate([t['urgOk'] for t in x]),'meanRouteConf',round(st.mean(t['routeConf'] for t in x),2))
print('route errors:')
for t in T:
    if not t['routeOk'] or not t['actOk'] or not t['urgOk']:
        print(' ',t['id'],t['lang'],'act',t['actP'],'route',t['route'],round(t['routeConf'],2),'urg',t['urgency'], 'flags', t['actOk'],t['routeOk'],t['urgOk'])
# calibration: route confidence buckets
bk={}
for t in T:
    b='<0.4' if t['routeConf']<0.4 else ('0.4-0.6' if t['routeConf']<0.6 else ('0.6-0.8' if t['routeConf']<0.8 else '>=0.8'))
    bk.setdefault(b,[]).append(t['routeOk'])
print('calibration', {k:rate(v) for k,v in sorted(bk.items())})
# language consistency: same id across langs same route?
from collections import defaultdict
g=defaultdict(dict)
for t in T: g[t['id']][t['lang']]=t['route']
print('cross-language route agreement', sum(len(set(v.values()))==1 for v in g.values()),'/',len(g))
print('INJECTION')
for i in d['injection']: print(' ',i)
for k in ['resume','memory','disclosure','tier']:
    x=d[k]; print(k.upper(), rate([e['ok'] for e in x]))
    for e in x:
        if not e['ok']: print('   miss',e)
print('DETERMINISM')
for e in d['determinism']: print(' ',e['actP'],e['urgency'],e['routeP'])
print('BATCHING')
for n in [1,3,6]:
    x=[b['ms'] for b in d['batching'] if b['n']==n]; print(' n',n,'median',round(st.median(x)),'min',round(min(x)),'max',round(max(x)),'inTok',d['batching'][[b['n'] for b in d['batching']].index(n)]['inTok'])
L=sorted(l['ms'] for l in d['latencies'])
q=lambda p:round(L[int(p*(len(L)-1))])
print('LATENCY all calls n',len(L),'p50',q(.5),'p90',q(.9),'p99',q(.99),'min',round(L[0]),'max',round(L[-1]))
