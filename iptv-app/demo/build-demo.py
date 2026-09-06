import json, ssl, urllib.request, urllib.parse, base64, io, os, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
KEY=os.environ['TMDB_API_KEY']
ctx=ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE'))
def get(url, retries=3):
    for i in range(retries):
        try:
            with urllib.request.urlopen(url, context=ctx, timeout=40) as r: return r.read()
        except Exception as e:
            if i==retries-1: print('FAIL',url[:90],e,file=sys.stderr); return None
def api(path, **p):
    p.update(api_key=KEY, language='fr-FR'); b=get('https://api.themoviedb.org/3'+path+'?'+urllib.parse.urlencode(p))
    return json.loads(b) if b else None
def img(path, size, width, q, fmt='WEBP', keep_alpha=False):
    if not path: return None
    b=get(f'https://image.tmdb.org/t/p/{size}{path}')
    if not b: return None
    try:
        im=Image.open(io.BytesIO(b))
        if im.width>width: im=im.resize((width, round(im.height*width/im.width)), Image.LANCZOS)
        im=im.convert('RGBA' if keep_alpha else 'RGB')
        out=io.BytesIO(); im.save(out, fmt, quality=q, method=4)
        return 'data:image/webp;base64,'+base64.b64encode(out.getvalue()).decode()
    except Exception as e: print('IMG',path,e,file=sys.stderr); return None
def logo_pick(images):
    logos=images.get('logos',[]); pref={'fr':0,'en':1,None:2}
    logos=[l for l in logos if l['iso_639_1'] in pref]
    logos.sort(key=lambda l:(pref[l['iso_639_1']], -l['vote_average']))
    return logos[0]['file_path'] if logos else None
sel=json.load(open('selection.json'))
for r in sel['movies']: r['items']=r['items'][:14]
for r in sel['shows']: r['items']=r['items'][:10]
def enrich(item, media):
    d=api(f'/{media}/{item["tmdbId"]}', append_to_response='credits,images,similar,videos', include_image_language='fr,en,null')
    if not d: return None
    date=d.get('release_date') or d.get('first_air_date') or ''
    trailer=next((v['key'] for v in d.get('videos',{}).get('results',[]) if v['site']=='YouTube' and v['type']=='Trailer'),None)
    return {
      'id':item['id'],'kind':item['kind'],'rawName':item['rawName'],'lang':item.get('lang'),'quality':item.get('quality'),'tags':item.get('tags',[]),
      'tmdbId':d['id'],'title':d.get('title') or d.get('name'),'original':d.get('original_title') or d.get('original_name'),
      'tagline':d.get('tagline'),'overview':d.get('overview'),'year':int(date[:4]) if date[:4].isdigit() else item.get('year'),
      'runtime':d.get('runtime') or (d.get('episode_run_time') or [None])[0] or (d.get('last_episode_to_air') or {}).get('runtime'),
      'rating':d.get('vote_average'),'votes':d.get('vote_count'),'genres':[g['name'] for g in d.get('genres',[])],
      'seasons':d.get('number_of_seasons'),'episodes':d.get('number_of_episodes'),'status':d.get('status'),
      'director':next((c['name'] for c in d.get('credits',{}).get('crew',[]) if c.get('job')=='Director'),None),
      'creators':[c['name'] for c in d.get('created_by',[])],
      'cast':[{'name':c['name'],'character':c.get('character'),'photo':img(c.get('profile_path'),'w45',45,60)} for c in d.get('credits',{}).get('cast',[])[:6]],
      'similar':[{'tmdbId':s['id'],'title':s.get('title') or s.get('name'),'year':(s.get('release_date') or s.get('first_air_date') or '')[:4],'poster':img(s.get('poster_path'),'w92',80,55)} for s in d.get('similar',{}).get('results',[]) if s.get('poster_path')][:6],
      'trailer':trailer,
      'poster':img(d.get('poster_path'),'w185',150,65),
      'backdrop':img(d.get('backdrop_path'),'w780',600,55),
      'logo':img(logo_pick(d.get('images',{})),'w300',300,75,keep_alpha=True),
    }
jobs=[]
for r in sel['movies']:
    for it in r['items']: jobs.append((it,'movie'))
for r in sel['shows']:
    for it in r['items']: jobs.append((it,'tv'))
with ThreadPoolExecutor(8) as ex: res=list(ex.map(lambda j: enrich(*j), jobs))
byid={r['id']:r for r in res if r}
def icon(url):
    b=get(url) if url else None
    if not b: return None
    try:
        im=Image.open(io.BytesIO(b)); im.thumbnail((160,90)); im=im.convert('RGBA'); out=io.BytesIO(); im.save(out,'WEBP',quality=70); return 'data:image/webp;base64,'+base64.b64encode(out.getvalue()).decode()
    except Exception as e: return None
with ThreadPoolExecutor(8) as ex:
    for r in sel['live']:
        icons=list(ex.map(lambda i: icon(i.get('poster')), r['items']))
        r['items']=[{'id':i['id'],'title':i['title'],'rawName':i['rawName'],'lang':i.get('lang'),'quality':i.get('quality'),'icon':ic} for i,ic in zip(r['items'],icons)]
out={'counts':sel['counts'],'rows':[]}
for kind,rows in (('movie',sel['movies']),('series',sel['shows'])):
    for r in rows:
        items=[byid[i['id']] for i in r['items'] if i['id'] in byid and byid[i['id']]['poster']]
        out['rows'].append({'kind':kind,'name':r['name'],'lang':r.get('lang'),'items':items})
for r in sel['live']: out['rows'].append({'kind':'live','name':r['name'],'lang':r.get('lang'),'items':r['items']})
json.dump(out,open('demo-data.json','w'),ensure_ascii=False)
print('titles',len(byid),'size MB',os.path.getsize('demo-data.json')/1e6, 'logos',sum(1 for r in byid.values() if r['logo']),'backdrops',sum(1 for r in byid.values() if r['backdrop']))
