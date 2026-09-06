import json, ssl, urllib.request, urllib.parse, base64, io, os, sys, re, collections
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
KEY=os.environ['TMDB_API_KEY']; ctx=ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE'))
def get(url, retries=3):
    for i in range(retries):
        try:
            with urllib.request.urlopen(url, context=ctx, timeout=40) as r: return r.read()
        except Exception as e:
            if i==retries-1: print('FAIL',url[:80],e,file=sys.stderr); return None
def api(path, **p):
    p.update(api_key=KEY, language='fr-FR'); b=get('https://api.themoviedb.org/3'+path+'?'+urllib.parse.urlencode(p))
    return json.loads(b) if b else None
def pages(path, n, **p):
    with ThreadPoolExecutor(5) as ex: res=list(ex.map(lambda i: api(path, page=i, **p), range(1,n+1)))
    return [r for pg in res if pg for r in pg['results']]
def img(path, size, width, q, alpha=False):
    if not path: return None
    b=get(f'https://image.tmdb.org/t/p/{size}{path}')
    if not b: return None
    try:
        im=Image.open(io.BytesIO(b))
        if im.width>width: im=im.resize((width, round(im.height*width/im.width)), Image.LANCZOS)
        im=im.convert('RGBA' if alpha else 'RGB'); out=io.BytesIO(); im.save(out,'WEBP',quality=q,method=4)
        return 'data:image/webp;base64,'+base64.b64encode(out.getvalue()).decode()
    except Exception as e: print('IMG',path,e,file=sys.stderr); return None

# ---- catalogue index: tmdb id -> best provider entry (FR > EN > other) ----
vod=json.load(open('get_vod_streams.json')); ser=json.load(open('get_series.json'))
def adult(x): return str(x.get('is_adult'))=='1' or re.match(r'^\s*\[X\]',x['name'])
PREF={'FR':0,'EN':1,'ENG':1,'NF':2,'4K':2,'EX':3}
def lang(n): m=re.match(r'^\s*([A-Z0-9+]{2,6})\s*-',n); return m.group(1) if m else None
def index(items, idkey):
    idx={}
    for x in items:
        if adult(x): continue
        t=x.get('tmdb')
        if not t or not str(t).isdigit() or int(t)==0: continue
        t=int(t); l=lang(x['name']); score=PREF.get(l,9)
        if t not in idx or score<idx[t][0]: idx[t]=(score,x,l)
    return idx
MV=index(vod,'stream_id'); TV=index(ser,'series_id')
print('index films',len(MV),'séries',len(TV))

# ---- TMDB lists ∩ catalogue ----
def pick(results, idx, n):
    out=[]; seen=set()
    for r in results:
        if r['id'] in idx and r['id'] not in seen: seen.add(r['id']); out.append(r['id'])
        if len(out)>=n: break
    return out
rows=[]
rows.append(('movie','top10','Top 10 films cette semaine',pick(pages('/trending/movie/week',3),MV,10)))
rows.append(('movie','row','Dernières sorties cinéma',pick(pages('/movie/now_playing',5,region='FR'),MV,14)))
rows.append(('movie','row','Populaires en ce moment',pick(pages('/movie/popular',3),MV,16)))
rows.append(('movie','row','Les mieux notés de tous les temps',pick(pages('/movie/top_rated',3),MV,16)))
GEN={'Action':28,'Comédie':35,'Thriller':53,'Science-Fiction':878,'Horreur':27,'Animation':16,'Crime':80,'Aventure':12,'Drame':18,'Familial':10751}
for g,i in GEN.items():
    rows.append(('movie','row',g,pick(pages('/discover/movie',3,with_genres=i,sort_by='popularity.desc',**{'vote_count.gte':300}),MV,14)))
rows.append(('series','top10','Top 10 séries cette semaine',pick(pages('/trending/tv/week',3),TV,10)))
rows.append(('series','row','Séries populaires',pick(pages('/tv/popular',3),TV,14)))
rows.append(('series','row','Séries les mieux notées',pick(pages('/tv/top_rated',3),TV,14)))
ids_m=collections.OrderedDict(); ids_t=collections.OrderedDict()
for kind,_,_,ids in rows:
    for i in ids: (ids_m if kind=='movie' else ids_t)[i]=1
hero=rows[0][3][:5]
print('rows',[(r[2],len(r[3])) for r in rows],'unique films',len(ids_m),'séries',len(ids_t))

def logo_pick(images):
    logos=[l for l in images.get('logos',[]) if l['iso_639_1'] in ('fr','en',None)]
    logos.sort(key=lambda l:({'fr':0,'en':1,None:2}[l['iso_639_1']], -l['vote_average'])); return logos[0]['file_path'] if logos else None
def enrich(tid, media):
    d=api(f'/{media}/{tid}', append_to_response='credits,images,similar,videos,release_dates', include_image_language='fr,en,null')
    if not d: return None
    src=(MV if media=='movie' else TV)[tid]; x=src[1]
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
    return {
      'id':('movie:' if media=='movie' else 'series:')+str(x.get('stream_id') or x.get('series_id')),'kind':'movie' if media=='movie' else 'series',
      'rawName':x['name'],'lang':src[2],'tmdbId':d['id'],'title':d.get('title') or d.get('name'),'original':d.get('original_title') or d.get('original_name'),
      'tagline':d.get('tagline'),'overview':d.get('overview'),'year':int(date[:4]) if date[:4].isdigit() else None,'date':date,
      'runtime':d.get('runtime') or (d.get('episode_run_time') or [None])[0] or (d.get('last_episode_to_air') or {}).get('runtime'),
      'rating':d.get('vote_average'),'votes':d.get('vote_count'),'genres':[g['name'] for g in d.get('genres',[])],'cert':cert,
      'seasons':d.get('number_of_seasons'),'episodes':d.get('number_of_episodes'),'status':d.get('status'),
      'director':next((c['name'] for c in d.get('credits',{}).get('crew',[]) if c.get('job')=='Director'),None),
      'creators':[c['name'] for c in d.get('created_by',[])],
      'cast':[{'name':c['name'],'character':c.get('character'),'photo':img(c.get('profile_path'),'w45',45,50)} for c in d.get('credits',{}).get('cast',[])[:6]],
      'similar':[{'tmdbId':s['id'],'title':s.get('title') or s.get('name'),'poster':img(s.get('poster_path'),'w92',64,50)} for s in d.get('similar',{}).get('results',[]) if s.get('poster_path')][:5],
      'trailer':trailer,
      'poster':img(d.get('poster_path'),'w185',130,60),
      'backdrop':img(d.get('backdrop_path'),'w780',520,50),
      'stills':[s for s in (img(p,'w780',520,45) for p in stills) if s],
      'logo':img(logo_pick(d.get('images',{})),'w300',240,72,alpha=True),
    }
jobs=[(i,'movie') for i in ids_m]+[(i,'tv') for i in ids_t]
with ThreadPoolExecutor(8) as ex: res=list(ex.map(lambda j: enrich(*j), jobs))
byT={(r['kind'],r['tmdbId']):r for r in res if r and r['poster']}
out={'counts':{'movie':len(MV),'series':len(TV)},'hero':[],'rows':[]}
for kind,typ,name,ids in rows:
    items=[byT[(kind,i)] for i in ids if (kind,i) in byT]
    out['rows'].append({'kind':kind,'type':typ,'name':name,'items':items})
out['hero']=[byT[('movie',i)] for i in hero if ('movie',i) in byT]
# live rows from mock sample
live=json.load(open('/home/user/llm-trading-bot/iptv-app/src/api/mock/live_streams.json')); lc={str(c['category_id']):c['category_name'] for c in json.load(open('/home/user/llm-trading-bot/iptv-app/src/api/mock/live_categories.json'))}
def icon(url):
    b=get(url) if url else None
    if not b: return None
    try: im=Image.open(io.BytesIO(b)); im.thumbnail((140,70)); im=im.convert('RGBA'); o=io.BytesIO(); im.save(o,'WEBP',quality=65); return 'data:image/webp;base64,'+base64.b64encode(o.getvalue()).decode()
    except: return None
groups=collections.defaultdict(list)
for x in live:
    if x.get('stream_icon') and re.match(r'^(FR|UK|US)\|',x['name']): groups[str(x['category_id'])].append(x)
best=sorted(groups.items(),key=lambda kv:-len(kv[1]))[:4]
with ThreadPoolExecutor(8) as ex:
    for cid,items in best:
        items=items[:10]; icons=list(ex.map(lambda i: icon(i['stream_icon']), items))
        name=re.sub(r'^[A-Z]{2,3}\|\s*','',lc.get(cid,cid))
        out['rows'].append({'kind':'live','type':'live','name':name,'items':[{'id':'live:'+str(i['stream_id']),'kind':'live','title':re.sub(r'^[A-Z]{2,3}\|\s*','',i['name']).replace(' FHD','').replace(' HD','').strip(),'rawName':i['name'],'icon':ic} for i,ic in zip(items,icons) if ic]})
out['counts']['live']=55716
json.dump(out,open('demo2.json','w'),ensure_ascii=False,separators=(',',':'))
print('titles',len(byT),'MB',os.path.getsize('demo2.json')/1e6,'hero',len(out['hero']),'stills',sum(len(h['stills']) for h in out['hero']))
