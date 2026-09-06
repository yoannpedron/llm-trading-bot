import json, ssl, urllib.request, urllib.parse, base64, io, os, sys, re, collections, time
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
KEY=os.environ['TMDB_API_KEY']; ctx=ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE'))
def get(url, retries=3):
    for i in range(retries):
        try:
            with urllib.request.urlopen(url, context=ctx, timeout=40) as r: return r.read()
        except Exception as e:
            time.sleep(1)
            if i==retries-1: print('FAIL',url[:80],e,file=sys.stderr); return None
def api(path, **p):
    p.update(api_key=KEY, language='fr-FR'); b=get('https://api.themoviedb.org/3'+path+'?'+urllib.parse.urlencode(p))
    return json.loads(b) if b else None
def pages(path, n, **p):
    with ThreadPoolExecutor(5) as ex: res=list(ex.map(lambda i: api(path, page=i, **p), range(1,n+1)))
    return [r for pg in res if pg for r in pg.get('results',[])]
def img(path, size, width, q, alpha=False):
    if not path: return None
    b=get(f'https://image.tmdb.org/t/p/{size}{path}')
    if not b: return None
    try:
        im=Image.open(io.BytesIO(b))
        if im.width>width: im=im.resize((width, round(im.height*width/im.width)), Image.LANCZOS)
        im=im.convert('RGBA' if alpha else 'RGB'); out=io.BytesIO(); im.save(out,'WEBP',quality=q,method=4)
        return 'data:image/webp;base64,'+base64.b64encode(out.getvalue()).decode()
    except Exception as e: return None

# ---------- catalogue index ----------
vod=json.load(open('get_vod_streams.json')); ser=json.load(open('get_series.json'))
def adult(x): return str(x.get('is_adult'))=='1' or re.match(r'^\s*\[X\]',x['name'])
PREF={'FR':0,'QFR':1,'EN':2,'ENG':2,'NF':3,'4K':3,'EX':4}
def lang(n): m=re.match(r'^\s*([A-Z0-9+]{2,6})\s*-',n); return m.group(1) if m else None
def index(items):
    idx={}; versions=collections.defaultdict(set); added={}; fourk=set()
    for x in items:
        if adult(x): continue
        t=x.get('tmdb')
        if not t or not str(t).isdigit() or int(t)==0: continue
        t=int(t); l=lang(x['name']); s=PREF.get(l,9)
        if l: versions[t].add(l)
        if re.search(r'\b(4K|UHD|2160p)\b',x['name']) or l=='4K': fourk.add(t)
        a=int(x.get('added') or x.get('last_modified') or 0); added[t]=max(added.get(t,0),a)
        if t not in idx or s<idx[t][0]: idx[t]=(s,x,l)
    return idx,versions,added,fourk
MV,MVER,MADD,M4K=index(vod); TV,TVER,TADD,_=index(ser)
print('index films',len(MV),'séries',len(TV),'4K',len(M4K),file=sys.stderr)

# ---------- row candidates (priority order, strict dedup) ----------
usedM=set(); usedT=set()
def take(ids, idx, used, n):
    out=[]
    for i in ids:
        if i in idx and i not in used: used.add(i); out.append(i)
        if len(out)>=n: break
    return out
rows=[]
def addrow(kind,typ,name,ids,sub=None,meta=None):
    rows.append({'kind':kind,'type':typ,'name':name,'sub':sub,'ids':ids,'meta':meta or {}})

# 1 trending
addrow('movie','top10','Top 10 films cette semaine',take([r['id'] for r in pages('/trending/movie/week',3)],MV,usedM,10),'Tendances TMDB croisées avec le catalogue')
# 2 fresh: in cinemas ∩ catalogue, sorted by release date
now=pages('/movie/now_playing',6,region='FR'); now.sort(key=lambda r:r.get('release_date',''),reverse=True)
addrow('movie','wide','Dernières sorties cinéma disponibles',take([r['id'] for r in now],MV,usedM,12),'Sorties récentes en salle déjà présentes sur le serveur')
# 3 cross: newest on the server, ranked by TMDB popularity among them
recent=sorted(MADD.items(),key=lambda kv:-kv[1])[:1500]; recent_ids={t for t,_ in recent}
pop=[r['id'] for r in pages('/movie/popular',10)]
cand=[i for i in pop if i in recent_ids]
addrow('movie','wide','Ajoutés cette semaine sur le serveur',take(cand,MV,usedM,12),'Derniers ajouts du provider, classés par popularité TMDB')
# 4 4K cross
cand=[r['id'] for r in pages('/movie/popular',8)+pages('/movie/top_rated',5) if r['id'] in M4K]
addrow('movie','row','Disponibles en 4K',take(cand,MV,usedM,12),'Versions 4K/UHD du serveur, triées par popularité')
# 5 masterpieces
cand=[r['id'] for r in pages('/discover/movie',4,sort_by='vote_average.desc',**{'vote_count.gte':8000})]
addrow('movie','row','Chefs-d’œuvre',take(cand,MV,usedM,12),'Note ≥ 8 avec plus de 8 000 votes')
# 6 hidden gems
cand=[r['id'] for r in pages('/discover/movie',4,sort_by='vote_average.desc',**{'vote_count.gte':400,'vote_count.lte':2500,'primary_release_date.gte':'2015-01-01'})]
addrow('movie','row','Pépites méconnues',take(cand,MV,usedM,12),'Très bien notés, peu vus : 400 à 2 500 votes depuis 2015')
# 7 directors
DIR={'Christopher Nolan':525,'Denis Villeneuve':137427,'Quentin Tarantino':138,'Martin Scorsese':1032}
for name,pid in DIR.items():
    cr=api(f'/person/{pid}/movie_credits') or {}
    ids=[c['id'] for c in sorted([c for c in cr.get('crew',[]) if c.get('job')=='Director'],key=lambda c:-(c.get('popularity') or 0)*0+ (c.get('vote_count') or 0))]
    got=take(ids,MV,usedM,10)
    if len(got)>=4: addrow('movie','row',f'Réalisés par {name}',got,f'{len(got)} films du réalisateur présents sur le serveur',{'person':pid})
# 8 french cinema cross: original language fr & popular
cand=[r['id'] for r in pages('/discover/movie',5,with_original_language='fr',sort_by='popularity.desc',**{'vote_count.gte':200})]
addrow('movie','row','Cinéma français',take(cand,MV,usedM,12),'Films en langue originale française')
# 9 genres
GEN={'Action':28,'Comédie':35,'Thriller':53,'Science-Fiction':878,'Horreur':27,'Animation':16,'Crime':80,'Aventure':12,'Drame':18,'Familial':10751,'Romance':10749,'Guerre':10752}
for g,i in GEN.items():
    cand=[r['id'] for r in pages('/discover/movie',5,with_genres=i,sort_by='popularity.desc',**{'vote_count.gte':300})]
    addrow('movie','row',g,take(cand,MV,usedM,10))
# series
addrow('series','top10','Top 10 séries cette semaine',take([r['id'] for r in pages('/trending/tv/week',3)],TV,usedT,10))
cand=[r['id'] for r in pages('/tv/on_the_air',5)]
addrow('series','wide','Nouveaux épisodes cette semaine',take(cand,TV,usedT,12),'Séries en cours de diffusion, présentes sur le serveur')
addrow('series','row','Séries les mieux notées',take([r['id'] for r in pages('/tv/top_rated',3)],TV,usedT,12))
addrow('series','row','Séries populaires',take([r['id'] for r in pages('/tv/popular',4)],TV,usedT,12))
for g,i in {'Drame':18,'Comédie':35,'Crime':80,'Science-Fiction & Fantastique':10765,'Animation':16,'Documentaire':99}.items():
    cand=[r['id'] for r in pages('/discover/tv',4,with_genres=i,sort_by='popularity.desc',**{'vote_count.gte':200})]
    addrow('series','row',f'Séries · {g}',take(cand,TV,usedT,10))
rows=[r for r in rows if len(r['ids'])>=4]
print('rows',[(r['name'],len(r['ids'])) for r in rows],'unique',len(usedM),len(usedT),file=sys.stderr)
hero=rows[0]['ids'][:5]

# ---------- enrichment ----------
def logo_pick(images):
    logos=[l for l in images.get('logos',[]) if l['iso_639_1'] in ('fr','en',None)]
    logos.sort(key=lambda l:({'fr':0,'en':1,None:2}[l['iso_639_1']], -l['vote_average'])); return logos[0]['file_path'] if logos else None
collections_seen={}
def enrich(tid, media):
    d=api(f'/{media}/{tid}', append_to_response='credits,images,similar,videos,release_dates', include_image_language='fr,en,null')
    if not d: return None
    idx=MV if media=='movie' else TV; src=idx[tid]; x=src[1]
    date=d.get('release_date') or d.get('first_air_date') or ''
    trailer=next((v['key'] for v in d.get('videos',{}).get('results',[]) if v['site']=='YouTube' and v['type'] in('Trailer','Teaser')),None)
    cert=None
    for rd in d.get('release_dates',{}).get('results',[]):
        if rd['iso_3166_1'] in('FR','US'):
            for r in rd['release_dates']:
                if r.get('certification'): cert=r['certification']; break
        if cert: break
    is_hero=tid in hero and media=='movie'
    stills=[b['file_path'] for b in d.get('images',{}).get('backdrops',[]) if b['file_path']!=d.get('backdrop_path')][:3] if is_hero else []
    col=d.get('belongs_to_collection')
    if col: collections_seen[col['id']]=col
    vers=sorted((MVER if media=='movie' else TVER).get(tid,set()))
    return {
      'id':('movie:' if media=='movie' else 'series:')+str(x.get('stream_id') or x.get('series_id')),'kind':'movie' if media=='movie' else 'series',
      'rawName':x['name'],'lang':src[2],'versions':vers,'is4k':tid in M4K,'added':(MADD if media=='movie' else TADD).get(tid),
      'tmdbId':d['id'],'title':d.get('title') or d.get('name'),'original':d.get('original_title') or d.get('original_name'),
      'tagline':d.get('tagline'),'overview':d.get('overview'),'year':int(date[:4]) if date[:4].isdigit() else None,'date':date,
      'runtime':d.get('runtime') or (d.get('episode_run_time') or [None])[0] or (d.get('last_episode_to_air') or {}).get('runtime'),
      'rating':d.get('vote_average'),'votes':d.get('vote_count'),'genres':[g['name'] for g in d.get('genres',[])],'cert':cert,
      'seasons':d.get('number_of_seasons'),'episodes':d.get('number_of_episodes'),'status':d.get('status'),'collection':col['id'] if col else None,
      'director':next((c['name'] for c in d.get('credits',{}).get('crew',[]) if c.get('job')=='Director'),None),
      'creators':[c['name'] for c in d.get('created_by',[])],
      'cast':[{'name':c['name'],'character':c.get('character'),'photo':img(c.get('profile_path'),'w45',45,45)} for c in d.get('credits',{}).get('cast',[])[:5]],
      'similar':[{'tmdbId':s['id'],'title':s.get('title') or s.get('name'),'poster':img(s.get('poster_path'),'w92',60,45)} for s in d.get('similar',{}).get('results',[]) if s.get('poster_path')][:4],
      'trailer':trailer,
      'poster':img(d.get('poster_path'),'w185',120,55),
      'backdrop':img(d.get('backdrop_path'),'w780',480,45),
      'stills':[s for s in (img(p,'w780',480,42) for p in stills) if s],
      'logo':img(logo_pick(d.get('images',{})),'w300',220,70,alpha=True),
    }
jobs=[(i,'movie') for i in usedM]+[(i,'tv') for i in usedT]
with ThreadPoolExecutor(8) as ex: res=list(ex.map(lambda j: enrich(*j), jobs))
byT={(r['kind'],r['tmdbId']):r for r in res if r and r['poster']}

# ---------- collections (sagas) complete on the server ----------
def collection(cid):
    c=api(f'/collection/{cid}')
    if not c: return None
    parts=[p for p in c.get('parts',[]) if p.get('release_date') and p['release_date']<=time.strftime('%Y-%m-%d')]
    have=[p for p in parts if p['id'] in MV]
    if len(parts)<2 or len(have)<2: return None
    return {'id':cid,'name':c['name'],'total':len(parts),'have':len(have),'complete':len(have)==len(parts),
            'poster':img(c.get('poster_path'),'w185',120,55),'backdrop':img(c.get('backdrop_path'),'w780',480,45),
            'films':[{'tmdbId':p['id'],'title':p['title'],'year':p['release_date'][:4],'onServer':p['id'] in MV,'poster':img(p.get('poster_path'),'w92',60,45),'rating':p.get('vote_average')} for p in sorted(parts,key=lambda p:p['release_date'])]}
EXTRA={10:'Star Wars',1241:'Harry Potter',86311:'Avengers',9485:'Fast & Furious',263:'The Dark Knight',2344:'Matrix',119:'Le Seigneur des anneaux',87359:'Mission Impossible',645:'James Bond',528:'Terminator',8945:'Mad Max',748:'X-Men',328:'Jurassic Park',31562:'Bourne',1575:'Rocky'}
cids=list(dict.fromkeys(list(EXTRA.keys())+list(collections_seen.keys())))[:24]
with ThreadPoolExecutor(6) as ex: cols=[c for c in ex.map(collection,cids) if c]
cols.sort(key=lambda c:(-c['complete'],-c['have']))
cols=cols[:12]
print('collections',[(c['name'],c['have'],c['total']) for c in cols],file=sys.stderr)

out={'counts':{'movie':len(MV),'series':len(TV),'live':55716},'hero':[byT[('movie',i)] for i in hero if ('movie',i) in byT],'rows':[],'collections':cols}
for r in rows:
    items=[byT[(r['kind'],i)] for i in r['ids'] if (r['kind'],i) in byT]
    out['rows'].append({'kind':r['kind'],'type':r['type'],'name':r['name'],'sub':r['sub'],'items':items})
# insert collections row after 4K
pos=next((k for k,r in enumerate(out['rows']) if r['name']=='Disponibles en 4K'),3)+1
out['rows'].insert(pos,{'kind':'movie','type':'collection','name':'Sagas complètes sur le serveur','sub':'Franchises dont tous les films sont disponibles','items':[]})
# live rows from v1 (icons server is down today)
v1=json.load(open('demo-data.json'))
for r in v1['rows']:
    if r['kind']=='live':
        out['rows'].append({'kind':'live','type':'live','name':r['name'].title(),'sub':None,'items':[{'id':i['id'],'kind':'live','title':re.sub(r'\s+(FHD|HD|SD|4K|UHD)$','',i['title']),'rawName':i['rawName'],'icon':i.get('icon')} for i in r['items']][:10]})
json.dump(out,open('demo3.json','w'),ensure_ascii=False,separators=(',',':'))
print('titles',len(byT),'MB',os.path.getsize('demo3.json')/1e6,file=sys.stderr)
