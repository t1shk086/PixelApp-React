"""PixelApp first migration slice — original Google Drive CSV schemas preserved.

This is a private, single-user API. It does not move or delete existing Drive files.
Production requires HTTPS and a secret API key, held server-side or sent via an
authenticated reverse proxy. Never expose the Google refresh token to the browser.
"""
import csv
import io
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()
DATA_DIR = Path(os.getenv('DATA_DIR', './data')).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
FOLDER_NAME = 'PixelApp_Data'
FILENAMES = {
    'settings': 'trip_settings_2026.csv',
    'expenses': 'budget_data_2026.csv',
    'budgets': 'trip_category_budgets_2026.csv',
    'tasks': 'trip_plan_2026.csv',
    'points': 'trip_map_points_2026.csv',
    'categories': 'pixelapp_custom_categories_2026.csv',
    'labels': 'pixelapp_labels_2026.csv',
}
COLUMNS = {
    'settings': ['trip_id','car_trip','track_fuel','start_km','end_km','manual_fuel','start_date','end_date','trip_finished'],
    'expenses': ['trip_id','date','amount','category','description','type','liters','current_km'],
    'budgets': ['trip_id','category','budget'],
    'tasks': ['trip_id','item_id','title','done','created'],
    'points': ['trip_id','lat','lon','title','color','stop_type'],
    'categories': ['trip_id','category'],
    'labels': ['pet','hotel','deposit','planned_stops_label','saved_place_label','my_location_label','fuel_red_threshold'],
}
LOCK = threading.RLock()
# Safe by default: legacy Streamlit can still write the same CSVs.
# Do not enable writes until cross-device synchronization and conflict handling are implemented.
# Patch 41: fail closed even if the legacy environment flag was left enabled.
# Cross-process conflict protection with Streamlit is NOT implemented yet.
WRITES_ENABLED = False

def require_writes():
    if not WRITES_ENABLED:
        raise HTTPException(423, 'Preview is read-only. Google Drive data cannot be modified from React yet.')


app = FastAPI(title='PixelApp API', version='0.1.0')
origins = [x.strip() for x in os.getenv('ALLOWED_ORIGINS','http://localhost:5173').split(',') if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=['GET','POST','PUT','DELETE'], allow_headers=['X-API-Key','Content-Type'])


def authorize(x_api_key: str | None = Header(default=None)):
    import hmac
    key = os.getenv('PIXELAPP_API_KEY','')
    if not key or not x_api_key or not hmac.compare_digest(x_api_key, key):
        raise HTTPException(401, 'Private API key required. Set PIXELAPP_API_KEY in backend/.env.')


def drive_service():
    client_id = os.getenv('GOOGLE_CLIENT_ID','')
    client_secret = os.getenv('GOOGLE_CLIENT_SECRET','')
    token = os.getenv('GOOGLE_REFRESH_TOKEN','')
    if not all([client_id, client_secret, token]):
        return None
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    creds = Credentials(token=None, refresh_token=token, token_uri='https://oauth2.googleapis.com/token',
                        client_id=client_id, client_secret=client_secret,
                        scopes=['https://www.googleapis.com/auth/drive'])
    creds.refresh(Request())
    return build('drive','v3',credentials=creds,cache_discovery=False)


def folder_and_files(service):
    safe_name = FOLDER_NAME.replace("'", "\\'")
    result = service.files().list(q=f"name = '{safe_name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", fields='files(id,name)',pageSize=20).execute()['files']
    if not result:
        raise HTTPException(404, 'PixelApp_Data folder not found; refusing to create another one automatically.')
    folder = result[0]['id']
    records = service.files().list(q=f"'{folder}' in parents and trashed = false", fields='nextPageToken,files(id,name)',pageSize=1000).execute()
    return folder, {x['name']:x['id'] for x in records.get('files',[])}


def load_rows(kind):
    path = DATA_DIR / FILENAMES[kind]
    if not path.exists(): return []
    with path.open('r',encoding='utf-8-sig',newline='') as f:
        return list(csv.DictReader(f))


def save_rows(kind, rows):
    path = DATA_DIR / FILENAMES[kind]
    cols = COLUMNS[kind]
    # Keep pre-existing extra columns during a migration.
    for row in rows:
        for k in row:
            if k not in cols: cols = cols + [k]
    tmp = path.with_suffix('.tmp')
    with tmp.open('w',encoding='utf-8',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=cols,extrasaction='ignore')
        writer.writeheader();writer.writerows(rows)
    os.replace(tmp,path)
    service = drive_service()
    if service:
        from googleapiclient.http import MediaFileUpload
        folder, files = folder_and_files(service)
        media=MediaFileUpload(str(path),mimetype='text/csv',resumable=False)
        if FILENAMES[kind] in files:
            service.files().update(fileId=files[FILENAMES[kind]],media_body=media).execute()
        else:
            service.files().create(body={'name':FILENAMES[kind],'parents':[folder]},media_body=media,fields='id').execute()


class TripIn(BaseModel):
    name: str = Field(min_length=1,max_length=150)
    start_date: str = ''
    end_date: str = ''
    car_trip: bool = False
    start_km: float = 0

class ExpenseIn(BaseModel):
    amount: float = Field(ge=0)
    category: str
    description: str = ''
    is_deposit: bool = False
    liters: float = 0
    current_km: float = 0

class BudgetIn(BaseModel):
    mode: str
    total: float = 0
    categories: dict[str,float] = Field(default_factory=dict)

class TaskIn(BaseModel):
    title: str = Field(min_length=1,max_length=500)

@app.get('/health')
def health(): return {'ok':True,'drive_configured':bool(os.getenv('GOOGLE_REFRESH_TOKEN')), 'read_only':not WRITES_ENABLED}

@app.post('/sync-from-drive',dependencies=[Depends(authorize)])
def sync_from_drive():
    """Explicit import. Never overwrite files in Drive and never import photos here."""
    with LOCK:
        service=drive_service()
        if not service: raise HTTPException(400,'Google Drive not configured; see .env.example')
        _, mapping = folder_and_files(service)
        count=0
        for kind,name in FILENAMES.items():
            if name not in mapping: continue
            raw=service.files().get_media(fileId=mapping[name]).execute()
            # Basic CSV validation before replacing local version
            decoded=raw.decode('utf-8-sig')
            reader=csv.DictReader(io.StringIO(decoded))
            if not reader.fieldnames or 'trip_id' not in reader.fieldnames and kind != 'labels':
                raise HTTPException(422,f'Unexpected CSV format: {name}')
            tmp=(DATA_DIR/name).with_suffix('.download')
            tmp.write_bytes(raw)
            os.replace(tmp,DATA_DIR/name)
            count+=1
        return {'imported_files':count,'photos':'remain untouched in Google Drive'}

# Patch 41: read-only preflight. Never modifies local files or Google Drive.
@app.get('/safety/preflight', dependencies=[Depends(authorize)])
def safety_preflight():
    import hashlib
    import re
    with LOCK:
        settings = load_rows('settings')
        def normal(value):
            return re.sub(r'[^\w]+', '', str(value or '').casefold(), flags=re.UNICODE).replace('_', '')
        target = normal('ТЕСТ PixelApp')
        candidates = [r for r in settings if normal(r.get('trip_id')) == target]
        report = {
            'write_enabled': False,
            'test_trip_found': len(candidates) == 1,
            'test_trip_count': len(candidates),
            'test_trip_id': candidates[0].get('trip_id') if len(candidates) == 1 else None,
            'drive_configured': bool(os.getenv('GOOGLE_REFRESH_TOKEN')),
            'csv_checks': [],
            'drive_matches_local': False,
            'safe_to_enable_writes': False,
            'note': 'Това е само проверка. Записването остава изключено до защита от конфликти между Streamlit и React.'
        }
        try:
            service = drive_service()
            if service is None:
                report['drive_error'] = 'Google Drive не е конфигуриран.'
                return report
            _, mapping = folder_and_files(service)
            for kind, filename in FILENAMES.items():
                local = DATA_DIR / filename
                item = {'file': filename, 'local_exists': local.is_file(), 'drive_exists': filename in mapping, 'matches': False}
                if local.is_file() and filename in mapping:
                    remote = service.files().get_media(fileId=mapping[filename]).execute()
                    item['matches'] = hashlib.sha256(local.read_bytes()).digest() == hashlib.sha256(remote).digest()
                report['csv_checks'].append(item)
            report['drive_matches_local'] = all(x['matches'] for x in report['csv_checks']) and bool(report['csv_checks'])
        except Exception as exc:
            # No traceback/credential information sent to the browser.
            report['drive_error'] = 'Неуспешна сверка с Google Drive. Провери връзката и настройките на сървъра.'
        return report


@app.get('/trips',dependencies=[Depends(authorize)])
def list_trips():
    with LOCK:
        settings=load_rows('settings'); expenses=load_rows('expenses'); budgets=load_rows('budgets')
        ids=list(dict.fromkeys([x.get('trip_id','') for group in (settings,budgets,expenses) for x in group if x.get('trip_id')]))
        result=[]
        for tid in ids:
            setting=next((s for s in settings if s.get('trip_id')==tid),{})
            b=[x for x in budgets if x.get('trip_id')==tid]
            global_budget=sum(float(x.get('budget') or 0) for x in b if x.get('category')=='__GLOBAL__')
            cat_budgets={x['category']:float(x.get('budget') or 0) for x in b if x.get('category')!='__GLOBAL__'}
            budget=global_budget if global_budget>0 else sum(cat_budgets.values())
            trip_exp=[x for x in expenses if x.get('trip_id')==tid]
            if global_budget>0 or not cat_budgets:
                spent=sum(float(x.get('amount') or 0) for x in trip_exp if x.get('type') in ('expense','deposit'))
            else:
                spent=sum(float(x.get('amount') or 0) for x in trip_exp if (x.get('type')=='expense' and x.get('category') in cat_budgets) or (x.get('type')=='deposit' and 'Нощувки/Хотел' in cat_budgets))
            result.append({'id':tid,'name':tid.replace('_',' ').rsplit(' __ ',1)[0], 'settings':setting,'budget':budget,'spent':spent})
        return result



@app.get('/home/places', dependencies=[Depends(authorize)])
def home_places():
    """All saved places from the imported map CSV; read-only, no geocoding."""
    import math
    with LOCK:
        settings=load_rows('settings')
        valid_ids={str(x.get('trip_id','')).strip() for x in settings if str(x.get('trip_id','')).strip()}
        places=[]
        for point in load_rows('points'):
            tid=str(point.get('trip_id') or '').strip()
            if not tid or (valid_ids and tid not in valid_ids):
                continue
            try:
                lat=float(point.get('lat'))
                lon=float(point.get('lon'))
            except (ValueError, TypeError):
                continue
            if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat)>90 or abs(lon)>180:
                continue
            display_name=tid.replace('_',' ').rsplit(' __ ',1)[0]
            places.append({'trip_id':tid,'trip_name':display_name,'lat':lat,'lon':lon,
                           'title':str(point.get('title') or 'Място'),
                           'color':str(point.get('color') or ''),
                           'stop_type':str(point.get('stop_type') or '')})
        return places

@app.get('/dashboard', dependencies=[Depends(authorize)])
def dashboard():
    """Read-only summary for the original PixelApp home screen."""
    from datetime import date
    with LOCK:
        trips=list_trips()
        entries=load_rows('expenses')
        today=date.today()
        next_trip=None
        km=0.0
        for trip in trips:
            s=trip['settings']; tid=trip['id']
            start=str(s.get('start_date') or '')
            end=str(s.get('end_date') or '')
            finished=(float(s.get('end_km') or 0)>0 if s.get('car_trip')=='Да' else str(s.get('trip_finished','')).strip().lower() in ('да','true','yes','1'))
            try:
                start_dt=datetime.strptime(start,'%d.%m.%Y').date()
            except (ValueError,TypeError):
                start_dt=None
            if start_dt and not finished and start_dt >= today:
                days=(start_dt-today).days
                if next_trip is None or days<next_trip['days']:
                    next_trip={'name':trip['name'],'date':start,'days':days}
            try:
                end_km=float(s.get('end_km') or 0)
                start_km=float(s.get('start_km') or 0)
                readings=[float(x.get('current_km') or 0) for x in entries if x.get('trip_id')==tid]
                maximum=end_km if end_km>0 else max(readings,default=0)
                km+=max(0,maximum-start_km)
            except (ValueError,TypeError):
                pass
        last=None;last_date=None
        names={t['id']:t['name'] for t in trips}
        for row in entries:
            raw=str(row.get('date') or '').strip()
            try: stamp=datetime.strptime(raw,'%d.%m.%Y %H:%M:%S')
            except ValueError:
                try: stamp=datetime.strptime(raw,'%d.%m.%Y %H:%M')
                except ValueError: continue
            if last_date is None or stamp>last_date:
                last_date=stamp
                last={'trip':names.get(row.get('trip_id'),row.get('trip_id','')),'amount':float(row.get('amount') or 0),'category':row.get('category',''),'description':row.get('description','')}
        return {'trips':len(trips),'spent':round(sum(float(t['spent']) for t in trips),2),'km':round(km,1),'next_trip':next_trip,'last_activity':last}

@app.post('/trips',dependencies=[Depends(authorize)])
def create_trip(payload:TripIn):
    require_writes()
    with LOCK:
        data=load_rows('settings')
        ids={x.get('trip_id') for x in data}
        base=payload.name.strip().replace(' ','_')
        tid=base;n=2
        while tid in ids: tid=f'{base}__{n}';n+=1
        data.append({'trip_id':tid,'car_trip':'Да' if payload.car_trip else 'Не','track_fuel':'Да' if payload.car_trip else 'Добави впоследствие','start_km':payload.start_km,'end_km':0,'manual_fuel':0,'start_date':payload.start_date,'end_date':payload.end_date,'trip_finished':'Не'})
        save_rows('settings',data)
        return {'id':tid}

@app.get('/trips/{trip_id}',dependencies=[Depends(authorize)])
def trip_detail(trip_id:str):
    with LOCK:
        return {'settings':next((x for x in load_rows('settings') if x.get('trip_id')==trip_id),{}),
                'expenses':[x for x in load_rows('expenses') if x.get('trip_id')==trip_id],
                'budgets':[x for x in load_rows('budgets') if x.get('trip_id')==trip_id],
                'tasks':[x for x in load_rows('tasks') if x.get('trip_id')==trip_id],
                'points':[x for x in load_rows('points') if x.get('trip_id')==trip_id]}

@app.post('/trips/{trip_id}/expenses',dependencies=[Depends(authorize)])
def add_expense(trip_id:str,payload:ExpenseIn):
    require_writes()
    with LOCK:
        if not any(x.get('trip_id')==trip_id for x in load_rows('settings')): raise HTTPException(404,'Trip not found')
        rows=load_rows('expenses')
        rows.append({'trip_id':trip_id,'date':datetime.now().strftime('%d.%m.%Y %H:%M:%S'),'amount':payload.amount,'category':payload.category,
                     'description':payload.description or 'Без описание','type':'deposit' if payload.is_deposit else 'expense','liters':payload.liters,'current_km':payload.current_km})
        save_rows('expenses',rows)
        return {'ok':True}

@app.put('/trips/{trip_id}/budget',dependencies=[Depends(authorize)])
def put_budget(trip_id:str,payload:BudgetIn):
    require_writes()
    if payload.mode not in ('global','category'): raise HTTPException(422,'Invalid budget mode')
    with LOCK:
        rows=[x for x in load_rows('budgets') if x.get('trip_id')!=trip_id]
        if payload.mode=='global' and payload.total>0: rows.append({'trip_id':trip_id,'category':'__GLOBAL__','budget':payload.total})
        elif payload.mode=='category':
            rows.extend({'trip_id':trip_id,'category':cat,'budget':value} for cat,value in payload.categories.items() if value>0 and cat!='Депозит/Резервация')
        save_rows('budgets',rows)
        return {'ok':True}

@app.post('/trips/{trip_id}/tasks',dependencies=[Depends(authorize)])
def add_task(trip_id:str,payload:TaskIn):
    require_writes()
    with LOCK:
        rows=load_rows('tasks');item_id=f'{trip_id}_{datetime.now().strftime("%Y%m%d%H%M%S%f")}'
        rows.append({'trip_id':trip_id,'item_id':item_id,'title':payload.title.strip(),'done':False,'created':datetime.now().strftime('%d.%m.%Y %H:%M')})
        save_rows('tasks',rows)
        return {'item_id':item_id}

@app.put('/tasks/{item_id}/toggle',dependencies=[Depends(authorize)])
def toggle_task(item_id:str):
    require_writes()
    with LOCK:
        rows=load_rows('tasks')
        for row in rows:
            if row.get('item_id')==item_id:
                row['done']='False' if str(row.get('done','')).lower() in ('true','1','yes','да') else 'True'
                save_rows('tasks',rows)
                return {'ok':True}
        raise HTTPException(404,'Task not found')

@app.delete('/tasks/{item_id}',dependencies=[Depends(authorize)])
def delete_task(item_id:str):
    require_writes()
    with LOCK:
        rows=load_rows('tasks');new=[x for x in rows if x.get('item_id')!=item_id]
        save_rows('tasks',new)
        return {'ok':True}
