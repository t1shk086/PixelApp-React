"""PixelApp first migration slice — original Google Drive CSV schemas preserved.

This is a private, single-user API. It does not move or delete existing Drive files.
Production requires HTTPS and a secret API key, held server-side or sent via an
authenticated reverse proxy. Never expose the Google refresh token to the browser.
"""
import csv
import json
import hashlib
import re
from decimal import Decimal, InvalidOperation
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
# Explicitly armed experimental endpoint ONLY; all legacy CRUD routes stay locked.
TEST_WRITE_ARMED = os.getenv('PIXELAPP_TEST_WRITE_ARMED', '').strip() == 'I_UNDERSTAND_TEST_ONLY'

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



# Patch 58: Restore a clean Render instance from Drive on its first authenticated
# read. Render's ephemeral filesystem can be empty after redeployment.
# This code NEVER uploads, creates, updates, or deletes files in Google Drive.
BOOTSTRAP_REQUIRED = ('settings', 'expenses', 'budgets')
BOOTSTRAP_STATE = {'restored': False}


def ensure_local_snapshot():
    """Read-only cold-start restore, serialized across simultaneous HTTP reads.

    Only bootstrap a completely empty local data directory. If some CSVs are
    already present, never replace them automatically; ask for manual recovery
    instead, because they might contain changes that have not reached Drive.
    """
    with LOCK:
        if all((DATA_DIR / FILENAMES[kind]).is_file() for kind in BOOTSTRAP_REQUIRED):
            return
        existing = [name for name in FILENAMES.values() if (DATA_DIR / name).exists()]
        if existing:
            raise HTTPException(503, 'Непълен локален архив. Автоматичното възстановяване е отказано, за да не се презапишат данни. Провери Render.')
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е конфигуриран. Не могат да се заредят пътуванията.')
        try:
            _, mapping = folder_and_files(service)
            missing = [FILENAMES[k] for k in BOOTSTRAP_REQUIRED if FILENAMES[k] not in mapping]
            if missing:
                raise HTTPException(503, 'В Google Drive липсват основни CSV файлове. Не показваме празни пътувания.')
            staged = {}
            for kind, name in FILENAMES.items():
                if name not in mapping:
                    continue  # optional CSV absent in Drive
                raw = service.files().get_media(fileId=mapping[name]).execute()
                if not isinstance(raw, bytes):
                    raise ValueError('Invalid Drive response')
                reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
                required = COLUMNS[kind]
                if not reader.fieldnames or any(col not in reader.fieldnames for col in required):
                    raise ValueError('Unknown CSV schema: ' + name)
                list(reader)  # validate CSV decoding before touching the local files
                staged[name] = raw
        except HTTPException:
            raise
        except Exception as exc:
            # Do not accidentally expose OAuth details in an HTTP response.
            raise HTTPException(503, 'Автоматичното четене от Google Drive не успя. Опитай отново.') from exc
        # All required files are downloaded and validated before installing any.
        # Unique names prevent accidental collisions with other temporary files.
        created = []
        try:
            for name, raw in staged.items():
                target = DATA_DIR / name
                if target.exists():
                    raise RuntimeError('Local data appeared while bootstrapping')
                tmp = DATA_DIR / ('.bootstrap_' + uuid.uuid4().hex + '_' + name)
                tmp.write_bytes(raw)
                os.replace(tmp, target)
                created.append(target)
            BOOTSTRAP_STATE['restored'] = True
        except Exception as exc:
            # Fresh cold start only: these files were created by this routine.
            for target in created:
                target.unlink(missing_ok=True)
            raise HTTPException(503, 'Неуспешно локално зареждане на CSV файловете.') from exc


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
def health(): return {'ok':True,'drive_configured':bool(os.getenv('GOOGLE_REFRESH_TOKEN')), 'read_only':not WRITES_ENABLED, 'test_write_armed':TEST_WRITE_ARMED}

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
            'test_write_armed': TEST_WRITE_ARMED,
            'expenses_sha256': None,
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
                    if kind == 'expenses':
                        report['expenses_sha256'] = hashlib.sha256(remote).hexdigest()
                report['csv_checks'].append(item)
            report['drive_matches_local'] = all(x['matches'] for x in report['csv_checks']) and bool(report['csv_checks'])
        except Exception as exc:
            # No traceback/credential information sent to the browser.
            report['drive_error'] = 'Неуспешна сверка с Google Drive. Провери връзката и настройките на сървъра.'
        return report


# Patch 42: purpose-built test transaction. NO ordinary React editing endpoints are enabled.
# This is optimistic conflict detection, not a distributed lock: Streamlit cannot
# participate until its sync code is upgraded. Use only while Streamlit is closed.
class ExperimentalExpense(BaseModel):
    trip_id: str = Field(min_length=1, max_length=200)
    amount: Decimal = Field(gt=0, le=1000)
    category: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=200)
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmation: str

@app.post('/safety/test-expense', dependencies=[Depends(authorize)])
def experimental_test_expense(payload: ExperimentalExpense):
    if not TEST_WRITE_ARMED:
        raise HTTPException(423, 'Тестовото записване е заключено от администратора на сървъра.')
    if payload.confirmation not in ('ЗАПИШИ САМО В ТЕСТ', 'ЗАПИШИ САМО В ТЕСТ P44'):
        raise HTTPException(400, 'Липсва точното потвърждение.')
    if payload.category not in ('Храна и напитки', 'Транспорт', 'Други', 'Нощувки/Хотел'):
        raise HTTPException(422, 'Непозволена категория за първия тест.')
    if not payload.amount.is_finite() or payload.amount.as_tuple().exponent < -2:
        raise HTTPException(422, 'Сумата трябва да има най-много два знака след запетаята.')
    # No fuel, deposit, settings, budgets or existing trips may be written through this endpoint.
    if payload.confirmation == 'ЗАПИШИ САМО В ТЕСТ P44' and re.search(r'газ|гориво|зареждане|бензин|дизел', payload.description, flags=re.I):
        raise HTTPException(422, 'Пач 44 не записва зареждания на гориво. Използвай временното тестване.')
    with LOCK:
        settings = load_rows('settings')
        def norm(value):
            return re.sub(r'[^\w]+', '', str(value or '').casefold(), flags=re.UNICODE).replace('_','')
        matches = [r for r in settings if norm(r.get('trip_id')) == norm('ТЕСТ PixelApp')]
        if len(matches) != 1 or matches[0].get('trip_id') != payload.trip_id:
            raise HTTPException(403, 'Записът е разрешен единствено за точно едно тестово пътуване.')
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е конфигуриран.')
        _, mapping = folder_and_files(service)
        name = FILENAMES['expenses']
        file_id = mapping.get(name)
        if not file_id:
            raise HTTPException(409, 'Липсва съществуващ CSV файл в Drive. Няма да създавам нов.')
        remote = service.files().get_media(fileId=file_id).execute()
        local_path = DATA_DIR / name
        if not local_path.exists():
            raise HTTPException(409, 'Липсва локалният CSV. Първо синхронизирай.')
        local = local_path.read_bytes()
        digest = hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or hashlib.sha256(local).hexdigest() != digest:
            raise HTTPException(409, 'Данните са променени. Обнови ги от Drive, провери и опитай пак.')
        decoded = remote.decode('utf-8-sig')
        reader = csv.DictReader(io.StringIO(decoded))
        cols = reader.fieldnames
        if not cols or not all(x in cols for x in COLUMNS['expenses']):
            raise HTTPException(422, 'Непознат CSV формат. Записът е отказан.')
        rows = list(reader)
        # All non-test rows are copied verbatim at the data level. We do not edit other trips.
        stamp = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
        marker = '[P44 TEST] ' if payload.confirmation == 'ЗАПИШИ САМО В ТЕСТ P44' else '[P42 TEST] '
        if any(x.get('trip_id') == payload.trip_id and x.get('description') == marker + payload.description for x in rows):
            raise HTTPException(409, 'Вече има тестов разход със същото описание. Избери друго.')
        row = {k:'' for k in cols}
        row.update({'trip_id':payload.trip_id,'date':stamp,'amount':str(payload.amount),
                    'category':payload.category,'description':marker + payload.description,
                    'type':'expense','liters':'0','current_km':'0'})
        rows.append(row)
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output, fieldnames=cols, extrasaction='ignore', lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        new_bytes = output.getvalue().encode('utf-8')
        # A persistent Drive-side copy is created BEFORE the original is touched.
        backup_name = f'P44_BACKUP_{datetime.now().strftime("%Y%m%d_%H%M%S")}_{uuid.uuid4().hex[:8]}_{name}'
        try:
            backup = service.files().copy(fileId=file_id, body={'name':backup_name}, fields='id,name').execute()
            backup_id = backup['id']
        except Exception:
            raise HTTPException(503, 'Резервното копие в Drive не беше създадено. Няма запис.')
        # Check once more after backup creation: refuse if Streamlit altered the file meanwhile.
        latest = service.files().get_media(fileId=file_id).execute()
        if hashlib.sha256(latest).hexdigest() != digest:
            raise HTTPException(409, 'Конфликт след създаване на архива. Записът е отказан.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media = MediaIoBaseUpload(io.BytesIO(new_bytes), mimetype='text/csv', resumable=False)
            service.files().update(fileId=file_id, media_body=media).execute()
            confirmed = service.files().get_media(fileId=file_id).execute()
            if hashlib.sha256(confirmed).digest() != hashlib.sha256(new_bytes).digest():
                raise RuntimeError('Drive verification mismatch')
        except Exception:
            # Keep the Drive backup. Do not claim success if verification fails.
            raise HTTPException(503, 'Записът не е потвърден. Провери данните в Drive; архивът е запазен.')
        tmp = local_path.with_suffix('.p42_verified')
        tmp.write_bytes(confirmed)
        os.replace(tmp,local_path)
        return {'ok':True, 'trip_id':payload.trip_id, 'amount':str(payload.amount),
                'backup_id':backup_id, 'new_sha256':hashlib.sha256(confirmed).hexdigest(),
                'note':'Записано и потвърдено в Drive. Отвори Streamlit и провери тестовия разход.'}


# Patch 45: restricted modification of precisely matched P44 test records only.
# No legacy, fuel, deposit or other-trip expense can be changed here.
class ExperimentalExpenseChange(BaseModel):
    trip_id: str = Field(min_length=1,max_length=200)
    operation: str
    original: dict[str,str]
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmation: str
    amount: Decimal | None = None
    category: str | None = None
    description: str | None = None


@app.post('/safety/test-expense-change', dependencies=[Depends(authorize)])
def experimental_test_expense_change(payload: ExperimentalExpenseChange):
    if not TEST_WRITE_ARMED:
        raise HTTPException(423, 'Тестовото записване е заключено от администратора.')
    if payload.confirmation != 'ПРОМЕНИ САМО P44 ТЕСТ':
        raise HTTPException(400, 'Липсва потвърждението за тестовата операция.')
    if payload.operation not in ('edit','delete'):
        raise HTTPException(422, 'Невалиден вид операция.')
    base_fields = ('date','amount','category','description','type','liters','current_km')
    if set(payload.original) != set(base_fields) or any(not isinstance(v,str) for v in payload.original.values()):
        raise HTTPException(422, 'Непълен оригинален запис. Няма промяна.')
    if not payload.original['description'].startswith('[P44 TEST] '):
        raise HTTPException(403, 'Може да се редактират само разходи от Пач 44.')
    if payload.original['type'] != 'expense' or payload.original['liters'] not in ('0','0.0','') or payload.original['current_km'] not in ('0','0.0',''):
        raise HTTPException(403, 'Гориво и други видове плащания са заключени.')
    if payload.operation == 'edit':
        if payload.amount is None or not payload.amount.is_finite() or not (Decimal('0.01') <= payload.amount <= Decimal('1000')) or payload.amount.as_tuple().exponent < -2:
            raise HTTPException(422,'Невалидна сума.')
        if payload.category not in ('Храна и напитки','Транспорт','Други','Нощувки/Хотел'):
            raise HTTPException(422,'Непозволена категория.')
        desc = (payload.description or '').strip()
        if not desc or len(desc)>200 or re.search(r'газ|гориво|зареждане|бензин|дизел',desc,flags=re.I):
            raise HTTPException(422,'Този тест не поддържа гориво или празно описание.')
    with LOCK:
        settings = load_rows('settings')
        def norm(v):
            return re.sub(r'[^\w]+','',str(v or '').casefold(),flags=re.UNICODE).replace('_','')
        matches = [r for r in settings if norm(r.get('trip_id')) == norm('ТЕСТ PixelApp')]
        if len(matches) != 1 or matches[0].get('trip_id') != payload.trip_id:
            raise HTTPException(403,'Разрешено е единствено точното тестово пътуване.')
        service = drive_service()
        if not service: raise HTTPException(503,'Няма Google Drive връзка.')
        _, mapping = folder_and_files(service)
        filename = FILENAMES['expenses']; file_id = mapping.get(filename)
        if not file_id: raise HTTPException(409,'Липсва CSV в Drive.')
        local_path = DATA_DIR / filename
        if not local_path.is_file(): raise HTTPException(409,'Липсва локалният CSV.')
        remote = service.files().get_media(fileId=file_id).execute()
        digest = hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or hashlib.sha256(local_path.read_bytes()).hexdigest() != digest:
            raise HTTPException(409,'Данните са се променили. Обнови от Drive, преди да опиташ пак.')
        reader = csv.DictReader(io.StringIO(remote.decode('utf-8-sig')))
        cols = reader.fieldnames
        if not cols or not all(f in cols for f in ('trip_id',*base_fields)):
            raise HTTPException(422,'Непознат CSV формат.')
        rows = list(reader)
        matching = [i for i,r in enumerate(rows) if r.get('trip_id') == payload.trip_id and all(str(r.get(k,'')) == payload.original[k] for k in base_fields)]
        if len(matching) != 1:
            raise HTTPException(409,'Разходът не е намерен еднозначно. Не е променено нищо.')
        index = matching[0]
        if payload.operation == 'edit':
            rows[index]['amount'] = str(payload.amount)
            rows[index]['category'] = payload.category
            rows[index]['description'] = '[P44 TEST] ' + desc
        else:
            del rows[index]
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output,fieldnames=cols,extrasaction='ignore',lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
        new_bytes = output.getvalue().encode('utf-8')
        backup_name = f'P45_BACKUP_{datetime.now().strftime("%Y%m%d_%H%M%S")}_{uuid.uuid4().hex[:8]}_{filename}'
        try:
            backup = service.files().copy(fileId=file_id,body={'name':backup_name},fields='id,name').execute()
            backup_id = backup['id']
        except Exception:
            raise HTTPException(503,'Неуспешно резервно копие. Записът е отказан.')
        if hashlib.sha256(service.files().get_media(fileId=file_id).execute()).hexdigest() != digest:
            raise HTTPException(409,'Drive се промени след архива. Отказана операция.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media = MediaIoBaseUpload(io.BytesIO(new_bytes),mimetype='text/csv',resumable=False)
            service.files().update(fileId=file_id,media_body=media).execute()
            confirmed = service.files().get_media(fileId=file_id).execute()
            if hashlib.sha256(confirmed).digest() != hashlib.sha256(new_bytes).digest():
                raise RuntimeError('Verification mismatch')
        except Exception:
            raise HTTPException(503,'Операцията не е потвърдена. Не повтаряй преди проверка на Drive. Архивът е запазен.')
        tmp = local_path.with_suffix('.p45_verified')
        tmp.write_bytes(confirmed); os.replace(tmp,local_path)
        return {'ok':True,'operation':payload.operation,'backup_id':backup_id,'new_sha256':hashlib.sha256(confirmed).hexdigest()}


@app.get('/trips',dependencies=[Depends(authorize)])
def list_trips():
    ensure_local_snapshot()
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
    ensure_local_snapshot()
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
    ensure_local_snapshot()
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
    ensure_local_snapshot()
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


# Patch 59: separate, fail-closed TEST-ONLY trip creation. Never enables normal CRUD.
# This is still optimistic checking, NOT a distributed transaction with Streamlit.
NEW_TRIP_TEST_ARMED = os.getenv('PIXELAPP_NEW_TRIP_TEST_ARMED', '') == 'I_ACCEPT_SINGLE_WRITER_TEST'

class TestNewTrip(BaseModel):
    name: str
    start_date: str
    end_date: str
    car_trip: bool = False
    start_km: int = Field(default=0, ge=0, le=9999999)
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmation: str

def _validate_test_trip(payload: TestNewTrip):
    if payload.name.strip() != 'ТЕСТ НОВО – PixelApp':
        raise HTTPException(403, 'Разрешено е само тестово пътуване с точно определено име.')
    if payload.confirmation != 'СЪЗДАЙ САМО ТЕСТОВО ПЪТУВАНЕ':
        raise HTTPException(400, 'Липсва потвърждение.')
    try:
        start = datetime.strptime(payload.start_date, '%d.%m.%Y').date()
        end = datetime.strptime(payload.end_date, '%d.%m.%Y').date()
    except ValueError:
        raise HTTPException(422, 'Датите трябва да бъдат във формат ДД.ММ.ГГГГ.')
    if end < start or (end - start).days > 365:
        raise HTTPException(422, 'Крайната дата е невалидна или периодът надвишава година.')
    if not payload.car_trip and payload.start_km:
        raise HTTPException(422, 'Пътуване без автомобил не може да има начален километраж.')
    return 'ТЕСТ_НОВО_–_PixelApp'

@app.get('/safety/new-trip-preflight', dependencies=[Depends(authorize)])
def new_trip_preflight():
    ensure_local_snapshot()
    with LOCK:
        local = DATA_DIR / FILENAMES['settings']
        raw = local.read_bytes()
        rows = load_rows('settings')
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е конфигуриран.')
        _, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['settings'])
        if not fid:
            raise HTTPException(409, 'Липсва файлът за настройки в Drive.')
        remote = service.files().get_media(fileId=fid).execute()
        equal = hashlib.sha256(raw).digest() == hashlib.sha256(remote).digest()
        return {'can_test':equal and not any(r.get('trip_id') == 'ТЕСТ_НОВО_–_PixelApp' for r in rows),
                'armed':NEW_TRIP_TEST_ARMED, 'settings_sha256':hashlib.sha256(remote).hexdigest(),
                'drive_matches_local':equal,
                'already_exists':any(r.get('trip_id') == 'ТЕСТ_НОВО_–_PixelApp' for r in rows)}

@app.post('/safety/new-trip-create', dependencies=[Depends(authorize)])
def new_trip_create(payload: TestNewTrip):
    if not NEW_TRIP_TEST_ARMED:
        raise HTTPException(423, 'Тестовото създаване е изключено в Render.')
    tid = _validate_test_trip(payload)
    ensure_local_snapshot()
    with LOCK:
        local_path = DATA_DIR / FILENAMES['settings']
        old_local = local_path.read_bytes()
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е конфигуриран.')
        _, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['settings'])
        if not fid:
            raise HTTPException(409, 'Липсва файлът за настройки в Drive.')
        old_remote = service.files().get_media(fileId=fid).execute()
        digest = hashlib.sha256(old_remote).hexdigest()
        if digest != payload.expected_sha256 or hashlib.sha256(old_local).hexdigest() != digest:
            raise HTTPException(409, 'Настройките са променени. Опресни проверката.')
        reader = csv.DictReader(io.StringIO(old_remote.decode('utf-8-sig')))
        cols = reader.fieldnames
        if not cols or any(k not in cols for k in COLUMNS['settings']):
            raise HTTPException(422, 'Непознати колони в CSV.')
        rows = list(reader)
        if any(r.get('trip_id') == tid for r in rows):
            raise HTTPException(409, 'Тестовото пътуване вече съществува.')
        row = {k:'' for k in cols}
        row.update({'trip_id':tid,'car_trip':'Да' if payload.car_trip else 'Не',
                    'track_fuel':'Да' if payload.car_trip else 'Добави впоследствие',
                    'start_km':str(payload.start_km),'end_km':'0','manual_fuel':'0',
                    'start_date':payload.start_date,'end_date':payload.end_date,'trip_finished':'Не'})
        rows.append(row)
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output, fieldnames=cols, extrasaction='ignore', lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        new_bytes = output.getvalue().encode('utf-8')
        try:
            backup = service.files().copy(fileId=fid,
                body={'name':'P59_TEST_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['settings']},
                fields='id').execute()
        except Exception:
            raise HTTPException(503, 'Резервното копие не беше създадено. Записът е отказан.')
        backup_id = backup['id']
        latest = service.files().get_media(fileId=fid).execute()
        if hashlib.sha256(latest).hexdigest() != digest:
            raise HTTPException(409, 'Настъпила е промяна след архива. Записът е отказан.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media = MediaIoBaseUpload(io.BytesIO(new_bytes), mimetype='text/csv', resumable=False)
            service.files().update(fileId=fid, media_body=media).execute()
            verified = service.files().get_media(fileId=fid).execute()
            if hashlib.sha256(verified).digest() != hashlib.sha256(new_bytes).digest():
                raise RuntimeError('Drive verification failed')
        except Exception:
            raise HTTPException(503, 'Записът не е потвърден. Провери Drive преди повторение.')
        temp = local_path.with_suffix('.p59_verified')
        temp.write_bytes(verified)
        os.replace(temp,local_path)
        return {'ok':True,'trip_id':tid,'backup_id':backup_id}


# Patch 61: narrowly scoped test-trip SETTINGS edit. Other trips and CRUD locked.
# Requires a DIFFERENT explicit switch from test creation and stays OFF by default.
TEST_EDIT_ARMED = os.getenv('PIXELAPP_TEST_TRIP_EDIT_ARMED', '') == 'I_ACCEPT_SINGLE_TEST_EDIT'
TEST_TRIP_ID = 'ТЕСТ_НОВО_–_PixelApp'

class TestTripEdit(BaseModel):
    start_date: str
    end_date: str
    car_trip: bool
    start_km: int = Field(ge=0, le=9999999)
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmation: str

def _validated_test_edit(payload: TestTripEdit):
    if payload.confirmation != 'РЕДАКТИРАЙ САМО ТЕСТОВОТО ПЪТУВАНЕ':
        raise HTTPException(400, 'Липсва потвърждение за тестовата редакция.')
    try:
        start = datetime.strptime(payload.start_date,'%d.%m.%Y').date()
        end = datetime.strptime(payload.end_date,'%d.%m.%Y').date()
    except ValueError:
        raise HTTPException(422, 'Датите трябва да бъдат във формат ДД.ММ.ГГГГ.')
    if end < start or (end-start).days > 365:
        raise HTTPException(422, 'Невалиден период на пътуване.')
    if not payload.car_trip and payload.start_km != 0:
        raise HTTPException(422, 'За пътуване без автомобил километражът трябва да е 0.')

@app.get('/safety/test-trip-edit-preflight', dependencies=[Depends(authorize)])
def test_trip_edit_preflight():
    ensure_local_snapshot()
    with LOCK:
        local = (DATA_DIR / FILENAMES['settings']).read_bytes()
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е конфигуриран.')
        _, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['settings'])
        if not fid:
            raise HTTPException(409, 'Настройките липсват в Drive.')
        remote = service.files().get_media(fileId=fid).execute()
        reader = csv.DictReader(io.StringIO(remote.decode('utf-8-sig')))
        rows = list(reader)
        found = [r for r in rows if r.get('trip_id') == TEST_TRIP_ID]
        return {
            'armed':TEST_EDIT_ARMED,
            'drive_matches_local':hashlib.sha256(remote).digest()==hashlib.sha256(local).digest(),
            'settings_sha256':hashlib.sha256(remote).hexdigest(),
            'trip_found':len(found)==1,
            'test_trip': {k:found[0].get(k,'') for k in ('start_date','end_date','start_km','car_trip','trip_finished')} if len(found)==1 else None,
            'can_edit': TEST_EDIT_ARMED and len(found)==1 and remote==local and found[0].get('trip_finished','Не')!='Да' if len(found)==1 else False,
        }

@app.post('/safety/test-trip-edit', dependencies=[Depends(authorize)])
def test_trip_edit(payload: TestTripEdit):
    if not TEST_EDIT_ARMED:
        raise HTTPException(423, 'Тестовото редактиране е заключено.')
    _validated_test_edit(payload)
    ensure_local_snapshot()
    with LOCK:
        local_path=DATA_DIR / FILENAMES['settings']
        local=local_path.read_bytes()
        service=drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е конфигуриран.')
        _, mapping=folder_and_files(service)
        fid=mapping.get(FILENAMES['settings'])
        if not fid:
            raise HTTPException(409, 'Липсват настройки в Drive.')
        remote=service.files().get_media(fileId=fid).execute()
        digest=hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or hashlib.sha256(local).hexdigest()!=digest:
            raise HTTPException(409,'Данните в Drive/Render са променени. Направи нова проверка.')
        reader=csv.DictReader(io.StringIO(remote.decode('utf-8-sig')))
        cols=reader.fieldnames
        if not cols or any(k not in cols for k in COLUMNS['settings']):
            raise HTTPException(422,'Невалидни колони на CSV.')
        rows=list(reader)
        targets=[r for r in rows if r.get('trip_id')==TEST_TRIP_ID]
        if len(targets)!=1:
            raise HTTPException(409,'Тестовото пътуване липсва или се повтаря.')
        target=targets[0]
        if target.get('trip_finished')=='Да':
            raise HTTPException(409,'Приключено пътуване не се редактира.')
        # Keep the ID, all unrelated columns, and all other trips untouched.
        target.update(start_date=payload.start_date,end_date=payload.end_date,
                      car_trip='Да' if payload.car_trip else 'Не',
                      start_km=str(payload.start_km),
                      track_fuel='Да' if payload.car_trip else 'Не')
        out=io.StringIO(newline='')
        writer=csv.DictWriter(out,fieldnames=cols,extrasaction='ignore',lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated=out.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={
                'name':'P61_TEST_EDIT_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['settings']},fields='id').execute()
        except Exception:
            raise HTTPException(503,'Неуспешно резервно копие. Записът е отказан.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest()!=digest:
            raise HTTPException(409,'Данните са променени след създаването на архив. Записът е отказан.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)
            service.files().update(fileId=fid,media_body=media).execute()
            verified=service.files().get_media(fileId=fid).execute()
            if hashlib.sha256(verified).digest()!=hashlib.sha256(updated).digest():
                raise RuntimeError('Drive verification failed')
        except Exception:
            raise HTTPException(503,'Записът не е потвърден. Провери Drive преди нов опит.')
        tmp=local_path.with_suffix('.p61_verified')
        tmp.write_bytes(verified)
        os.replace(tmp,local_path)
        return {'ok':True,'trip_id':TEST_TRIP_ID,'backup_id':backup['id']}


# Patch 68: persistent allowlist of trips created by React, stored in Drive.
# The two explicitly verified pilot trips are allowed; historical trips are NOT.
REACT_OWNED_FILENAME = 'pixelapp_react_owned_trips.json'
REACT_OWNED_PILOTS = frozenset((TEST_TRIP_ID, 'ТЕСТ_67_PixelApp'))


def _react_owned_ids(service, mapping):
    fid = mapping.get(REACT_OWNED_FILENAME)
    if not fid:
        return set(REACT_OWNED_PILOTS)
    try:
        raw = service.files().get_media(fileId=fid).execute()
        parsed = json.loads(raw.decode('utf-8'))
        if parsed.get('schema') != 1 or not isinstance(parsed.get('trip_ids'), list) or any(not isinstance(x, str) for x in parsed['trip_ids']):
            raise ValueError('Invalid ownership registry')
        return set(parsed['trip_ids']) | set(REACT_OWNED_PILOTS)
    except Exception:
        raise HTTPException(503, 'Регистърът на новите пътувания не може да се прочете. Записването е спряно.')


def _register_react_trip(service, folder_id, mapping, tid):
    """Write ownership BEFORE creating a trip; orphan registration is harmless.

    A trip is never writable unless it exists in settings and the registry.
    """
    owned = _react_owned_ids(service, mapping)
    if tid in owned:
        return
    owned.add(tid)
    raw = json.dumps({'schema': 1, 'trip_ids': sorted(owned)}, ensure_ascii=False, indent=2).encode('utf-8')
    from googleapiclient.http import MediaIoBaseUpload
    media = MediaIoBaseUpload(io.BytesIO(raw), mimetype='application/json', resumable=False)
    fid = mapping.get(REACT_OWNED_FILENAME)
    try:
        if fid:
            old = service.files().get_media(fileId=fid).execute()
            service.files().copy(fileId=fid, body={'name':'P68_REGISTRY_BACKUP_'+uuid.uuid4().hex}, fields='id').execute()
            if service.files().get_media(fileId=fid).execute() != old:
                raise HTTPException(409, 'Регистърът беше променен от друго устройство.')
            service.files().update(fileId=fid, media_body=media).execute()
        else:
            created = service.files().create(body={'name': REACT_OWNED_FILENAME, 'parents': [folder_id]}, media_body=media, fields='id').execute()
            fid = created['id']
        verified = service.files().get_media(fileId=fid).execute()
        if verified != raw:
            raise ValueError('Ownership registry verification failed')
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'Неуспешно потвърждение на регистъра на новите пътувания. Няма създадено пътуване.')


def _assert_react_owned_trip(trip_id, service, mapping):
    if trip_id not in _react_owned_ids(service, mapping):
        raise HTTPException(403, 'Старите пътувания са само за четене.')
    settings = [r for r in load_rows('settings') if r.get('trip_id') == trip_id]
    if len(settings) != 1 or settings[0].get('trip_finished', 'Не') == 'Да':
        raise HTTPException(409, 'Пътуването липсва или е приключено.')
    return settings[0]


# Patch 62: isolated finances for the NEW test trip only. Ordinary CRUD remains locked.
# Enabling requires a dedicated, temporary Render environment switch.
# Persistent, server-scoped finance pilot. Only TEST_TRIP_ID is writable.
# Set PIXELAPP_PILOT_FINANCE_ENABLED=false to instantly disable without a code change.
# Existing legacy/test finance environment switches do not grant access to other trips.
TEST_FINANCE_ARMED = os.getenv('PIXELAPP_PILOT_FINANCE_ENABLED', 'true').strip().lower() == 'true'
FINANCE_CATEGORIES = ('Храна и напитки', 'Транспорт', 'Други', 'Нощувки/Хотел')

class TestFinanceChange(BaseModel):
    operation: str
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmation: str
    amount: Decimal | None = None
    category: str | None = None
    description: str | None = None
    # The original expense is a full 8-field snapshot, never a row index.
    original: dict[str, str] | None = None


def _finance_decimal(value: Decimal | None, *, zero_ok: bool = False):
    if value is None or not value.is_finite() or value.as_tuple().exponent < -2:
        raise HTTPException(422, 'Въведи валидна сума с най-много 2 знака.')
    if (Decimal('0') if zero_ok else Decimal('0.01')) > value or value > Decimal('100000'):
        raise HTTPException(422, 'Сумата е извън разрешените граници.')
    return str(value.quantize(Decimal('0.01')))


def _finance_remote(kind, service, mapping):
    filename = FILENAMES[kind]
    fid = mapping.get(filename)
    path = DATA_DIR / filename
    if not fid or not path.is_file():
        raise HTTPException(409, 'Липсва CSV файл за финансовите данни.')
    remote = service.files().get_media(fileId=fid).execute()
    local = path.read_bytes()
    reader = csv.DictReader(io.StringIO(remote.decode('utf-8-sig')))
    columns = reader.fieldnames
    if not columns or any(col not in columns for col in COLUMNS[kind]):
        raise HTTPException(422, 'Непознат финансов CSV формат.')
    rows = list(reader)
    return fid, path, remote, local, columns, rows


@app.get('/safe/trip-finance-preflight/{trip_id}', dependencies=[Depends(authorize)])
def safe_trip_finance_preflight(trip_id: str):
    ensure_local_snapshot()
    with LOCK:
        service = drive_service()
        if not service:
            raise HTTPException(503, 'Няма връзка с Drive.')
        _, mapping = folder_and_files(service)
        _assert_react_owned_trip(trip_id, service, mapping)
        snapshots = {}
        results = {}
        for kind in ('budgets', 'expenses'):
            _, _, remote, local, _, rows = _finance_remote(kind, service, mapping)
            match = hashlib.sha256(remote).digest() == hashlib.sha256(local).digest()
            results[kind] = {'drive_matches_local': match, 'sha256': hashlib.sha256(remote).hexdigest()}
            snapshots[kind] = [r for r in rows if r.get('trip_id') == trip_id]
        return {'armed': TEST_FINANCE_ARMED, 'test_trip_found': True, 'trip_id': trip_id,
                'can_write': TEST_FINANCE_ARMED and all(x['drive_matches_local'] for x in results.values()),
                'files': results, 'budgets': snapshots['budgets'], 'expenses': snapshots['expenses'],
                'start_km': next((r.get('start_km', '0') for r in load_rows('settings') if r.get('trip_id') == trip_id), '0')}


@app.get('/safety/test-finance-preflight', dependencies=[Depends(authorize)])
def test_finance_preflight():
    return safe_trip_finance_preflight(TEST_TRIP_ID)


@app.post('/safe/trip-finance/{trip_id}', dependencies=[Depends(authorize)])
def safe_trip_finance_change(trip_id: str, payload: TestFinanceChange):
    if not TEST_FINANCE_ARMED:
        raise HTTPException(423, 'Пилотното финансово записване е заключено.')
    if payload.confirmation != 'ЗАПИШИ САМО ТЕСТОВИ ФИНАНСИ':
        raise HTTPException(400, 'Липсва тестовото потвърждение.')
    if payload.operation not in ('budget', 'expense-add', 'expense-edit', 'expense-delete'):
        raise HTTPException(422, 'Непозната финансова операция.')
    kind = 'budgets' if payload.operation == 'budget' else 'expenses'
    amount = None
    if payload.operation != 'expense-delete':
        amount = _finance_decimal(payload.amount,zero_ok=kind=='budgets')
    if kind == 'expenses' and payload.operation != 'expense-delete':
        if payload.category not in FINANCE_CATEGORIES:
            raise HTTPException(422, 'Категорията не е разрешена за теста.')
        desc = (payload.description or '').strip()
        if not desc or len(desc) > 120 or re.search(r'гориво|газ|бензин|дизел|зареждане', desc, re.I):
            raise HTTPException(422, 'Въведи описание до 120 знака. Горивото е отделен модул.')
    else:
        desc = ''
    ensure_local_snapshot()
    with LOCK:
        service = drive_service()
        if not service:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        _, mapping = folder_and_files(service)
        _assert_react_owned_trip(trip_id, service, mapping)
        fid, path, remote, local, columns, rows = _finance_remote(kind, service, mapping)
        digest = hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or hashlib.sha256(local).hexdigest() != digest:
            raise HTTPException(409, 'Има промяна в Drive или Render. Направи нова проверка.')
        existing = [r for r in rows if r.get('trip_id') == trip_id]
        if payload.operation == 'budget':
            if any(r.get('category') != '__GLOBAL__' for r in existing):
                raise HTTPException(409, 'Има бюджет по категории; не го презаписваме автоматично.')
            rows = [r for r in rows if not (r.get('trip_id')==trip_id and r.get('category')=='__GLOBAL__')]
            if amount != '0.00':
                row = {k:'' for k in columns}
                row.update(trip_id=trip_id, category='__GLOBAL__', budget=amount)
                rows.append(row)
        elif payload.operation == 'expense-add':
            if any(r.get('trip_id')==trip_id and r.get('description')=='[P62] '+desc for r in rows):
                raise HTTPException(409, 'Разход с това описание вече съществува.')
            row = {k:'' for k in columns}
            row.update(trip_id=trip_id, date=datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
                       amount=amount, category=payload.category, description='[P62] '+desc,
                       type='expense',liters='0',current_km='0')
            rows.append(row)
        else:
            original = payload.original or {}
            fields = COLUMNS['expenses']
            if set(original) != set(fields) or any(not isinstance(v,str) for v in original.values()):
                raise HTTPException(422, 'Невалиден оригинален запис.')
            if original.get('trip_id') != trip_id or not original.get('description','').startswith('[P62] ') or original.get('type') != 'expense' or original.get('liters') not in ('0','0.0','0.00','') or original.get('current_km') not in ('0','0.0','0.00',''):
                raise HTTPException(403, 'Позволени са само обикновени разходи, създадени с PixelApp.')
            matches = [i for i,r in enumerate(rows) if all(str(r.get(k,'')) == original[k] for k in fields)]
            if len(matches) != 1:
                raise HTTPException(409, 'Записът липсва или не е еднозначен. Няма промяна.')
            index = matches[0]
            if payload.operation == 'expense-delete':
                del rows[index]
            else:
                if any(r.get('trip_id')==trip_id and r.get('description')=='[P62] '+desc and i != index for i,r in enumerate(rows)):
                    raise HTTPException(409, 'Разход с това описание вече съществува.')
                rows[index].update(amount=amount, category=payload.category, description='[P62] '+desc)
        out = io.StringIO(newline='')
        writer = csv.DictWriter(out, fieldnames=columns, extrasaction='ignore', lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated = out.getvalue().encode('utf-8')
        try:
            backup = service.files().copy(fileId=fid,body={'name':'P68_FINANCE_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES[kind]},fields='id').execute()
        except Exception:
            raise HTTPException(503, 'Архивът не е създаден. Няма запис.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest() != digest:
            raise HTTPException(409, 'Drive се е променил след архива. Записът е отказан.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media = MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)
            service.files().update(fileId=fid,media_body=media).execute()
            verified = service.files().get_media(fileId=fid).execute()
            if hashlib.sha256(verified).digest() != hashlib.sha256(updated).digest():
                raise RuntimeError('Verification failed')
        except Exception:
            raise HTTPException(503, 'Записът не е потвърден. Не опитвай повторно, преди проверка.')
        tmp = path.with_suffix('.p62_verified')
        tmp.write_bytes(verified)
        os.replace(tmp, path)
        return {'ok':True, 'operation':payload.operation, 'backup_id':backup['id']}


# Patch 69: safe, normal refuel for React-created trips. Legacy trips stay read-only.
class SafeFuelAdd(BaseModel):
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmation: str
    amount: Decimal
    liters: Decimal
    current_km: int
    fuel_kind: str
    description: str = ''


@app.post('/safe/trip-fuel/{trip_id}', dependencies=[Depends(authorize)])
def safe_trip_fuel_add(trip_id: str, payload: SafeFuelAdd):
    if not TEST_FINANCE_ARMED:
        raise HTTPException(423, 'Записването е заключено от сървъра.')
    if payload.confirmation != 'ЗАПИШИ ЗАРЕЖДАНЕ':
        raise HTTPException(400, 'Липсва потвърждение.')
    if payload.fuel_kind not in ('full', 'partial'):
        raise HTTPException(422, 'Избери пълно или частично зареждане.')
    amount = _finance_decimal(payload.amount)
    if (not payload.liters.is_finite() or payload.liters <= 0 or
        payload.liters > Decimal('300') or payload.liters.as_tuple().exponent < -2):
        raise HTTPException(422, 'Литрите трябва да са от 0,01 до 300,00.')
    liters = str(payload.liters.quantize(Decimal('0.01')))
    desc = payload.description.strip()
    if len(desc) > 90 or '\n' in desc or '\r' in desc:
        raise HTTPException(422, 'Описанието е твърде дълго.')
    if not (0 < payload.current_km <= 9999999):
        raise HTTPException(422, 'Невалиден километраж.')
    ensure_local_snapshot()
    with LOCK:
        service = drive_service()
        if not service:
            raise HTTPException(503, 'Няма връзка с Google Drive.')
        _, mapping = folder_and_files(service)
        settings = _assert_react_owned_trip(trip_id, service, mapping)
        if settings.get('car_trip') != 'Да' or settings.get('track_fuel') != 'Да':
            raise HTTPException(409, 'За това пътуване не е включено проследяване на гориво.')
        fid, path, remote, local, columns, rows = _finance_remote('expenses', service, mapping)
        digest = hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or digest != hashlib.sha256(local).hexdigest():
            raise HTTPException(409, 'Данните в Drive са променени. Обнови и провери пак.')
        fuel_rows = [r for r in rows if r.get('trip_id') == trip_id and
                     r.get('type') == 'expense' and r.get('category') == 'Транспорт' and
                     Decimal(str(r.get('liters') or '0')) > 0 and
                     Decimal(str(r.get('current_km') or '0')) > 0]
        start = int(Decimal(str(settings.get('start_km') or '0')))
        last = max([start] + [int(Decimal(str(r['current_km']))) for r in fuel_rows])
        if payload.current_km <= last:
            raise HTTPException(422, f'Километражът трябва да е над {last} км.')
        label = 'ПЪЛНО' if payload.fuel_kind == 'full' else 'ЧАСТИЧНО'
        fuel_desc = f'[{label} ЗАРЕЖДАНЕ] {desc or "Гориво"}'
        # Keep original Streamlit CSV schema and description prefix, without computing
        # an unverified real-consumption estimate on the first full refill.
        newrow = {k: '' for k in columns}
        newrow.update(trip_id=trip_id, date=datetime.now().strftime('%d.%m.%Y %H:%M:%S'),
                      amount=amount, category='Транспорт', description=fuel_desc,
                      type='expense', liters=liters, current_km=str(payload.current_km))
        rows.append(newrow)
        out = io.StringIO(newline='')
        writer = csv.DictWriter(out, fieldnames=columns, extrasaction='ignore', lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
        updated = out.getvalue().encode('utf-8')
        try:
            backup = service.files().copy(fileId=fid, body={'name': 'P69_FUEL_BACKUP_' + uuid.uuid4().hex + '_' + FILENAMES['expenses']}, fields='id').execute()
        except Exception:
            raise HTTPException(503, 'Не е създаден архив. Няма запис.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest() != digest:
            raise HTTPException(409, 'Данните са променени след архива. Няма запис.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media = MediaIoBaseUpload(io.BytesIO(updated), mimetype='text/csv', resumable=False)
            service.files().update(fileId=fid, media_body=media).execute()
            verified = service.files().get_media(fileId=fid).execute()
            if hashlib.sha256(verified).digest() != hashlib.sha256(updated).digest():
                raise RuntimeError('Drive verification failed')
        except Exception:
            raise HTTPException(503, 'Неясен резултат от запис. Не натискай повторно преди проверка.')
        tmp = path.with_suffix('.p69_verified')
        tmp.write_bytes(verified)
        os.replace(tmp, path)
        return {'ok': True, 'backup_id': backup['id'], 'km': payload.current_km}


@app.post('/safety/test-finance', dependencies=[Depends(authorize)])
def test_finance_change(payload: TestFinanceChange):
    return safe_trip_finance_change(TEST_TRIP_ID, payload)


@app.get('/safe/react-owned-trips', dependencies=[Depends(authorize)])
def react_owned_trips():
    ensure_local_snapshot()
    with LOCK:
        service = drive_service()
        if not service:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        _, mapping = folder_and_files(service)
        return {'trip_ids': sorted(_react_owned_ids(service, mapping))}


# Patch 67: create NEW trips only. Existing rows are immutable through this route.
# Does not enable the old generic CRUD routes; Streamlit must be closed during writes.
# No Environment toggle needed; emergency lock: PIXELAPP_NEW_TRIPS_ENABLED=false.
NEW_TRIPS_ENABLED = os.getenv('PIXELAPP_NEW_TRIPS_ENABLED', 'true').lower() == 'true'

class SafeNewTrip(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    start_date: str
    end_date: str
    car_trip: bool = False
    start_km: int = Field(default=0, ge=0, le=9999999)
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')

def safe_new_trip_id(payload: SafeNewTrip):
    name = re.sub(r'\s+', ' ', payload.name.strip())
    if not re.fullmatch(r'[\w\s\-–().,]+', name, flags=re.UNICODE) or not re.search(r'\w', name):
        raise HTTPException(422, 'Името съдържа непозволени символи.')
    try:
        start = datetime.strptime(payload.start_date, '%d.%m.%Y').date()
        end = datetime.strptime(payload.end_date, '%d.%m.%Y').date()
    except ValueError:
        raise HTTPException(422, 'Невалидна дата. Използвай ДД.ММ.ГГГГ.')
    if end < start or (end - start).days > 365:
        raise HTTPException(422, 'Периодът трябва да бъде от 0 до 365 дни.')
    if not payload.car_trip and payload.start_km != 0:
        raise HTTPException(422, 'Километражът трябва да е 0 за пътуване без автомобил.')
    return name.replace(' ', '_')

@app.get('/safe/new-trip-preflight', dependencies=[Depends(authorize)])
def safe_new_trip_preflight():
    ensure_local_snapshot()
    with LOCK:
        path = DATA_DIR / FILENAMES['settings']
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е конфигуриран.')
        _, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['settings'])
        if not fid:
            raise HTTPException(409, 'Липсва CSV файлът на пътуванията в Drive.')
        remote = service.files().get_media(fileId=fid).execute()
        digest = hashlib.sha256(remote).hexdigest()
        return {'enabled': NEW_TRIPS_ENABLED,
                'drive_matches_local': hashlib.sha256(path.read_bytes()).hexdigest() == digest,
                'settings_sha256': digest}

@app.post('/safe/new-trip', dependencies=[Depends(authorize)])
def safe_new_trip_create(payload: SafeNewTrip):
    if not NEW_TRIPS_ENABLED:
        raise HTTPException(423, 'Създаването на нови пътувания е временно изключено.')
    tid = safe_new_trip_id(payload)
    ensure_local_snapshot()
    with LOCK:
        path = DATA_DIR / FILENAMES['settings']
        local = path.read_bytes()
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е конфигуриран.')
        folder_id, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['settings'])
        if not fid:
            raise HTTPException(409, 'Липсва CSV файлът на пътуванията.')
        remote = service.files().get_media(fileId=fid).execute()
        digest = hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or hashlib.sha256(local).hexdigest() != digest:
            raise HTTPException(409, 'Данните са променени. Обнови и опитай отново.')
        reader = csv.DictReader(io.StringIO(remote.decode('utf-8-sig')))
        cols = reader.fieldnames
        if not cols or any(k not in cols for k in COLUMNS['settings']):
            raise HTTPException(422, 'Непознат формат на CSV файла.')
        rows = list(reader)
        if any(r.get('trip_id', '').casefold() == tid.casefold() for r in rows):
            raise HTTPException(409, 'Вече има пътуване с това име. Избери различно.')
        # Record proven React ownership first; never unlock a legacy trip by date/name.
        _register_react_trip(service, folder_id, mapping, tid)
        newrow = {k: '' for k in cols}
        newrow.update({'trip_id': tid, 'car_trip': 'Да' if payload.car_trip else 'Не',
            'track_fuel': 'Да' if payload.car_trip else 'Добави впоследствие',
            'start_km': str(payload.start_km), 'end_km': '0', 'manual_fuel': '0',
            'start_date': payload.start_date, 'end_date': payload.end_date,
            'trip_finished': 'Не'})
        rows.append(newrow)
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output, fieldnames=cols, extrasaction='ignore', lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
        new_bytes = output.getvalue().encode('utf-8')
        try:
            backup = service.files().copy(fileId=fid,
                body={'name':'P67_NEW_TRIP_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['settings']},
                fields='id').execute()
            backup_id = backup['id']
        except Exception:
            raise HTTPException(503, 'Неуспешен архив. Не е записано пътуване.')
        latest = service.files().get_media(fileId=fid).execute()
        if hashlib.sha256(latest).hexdigest() != digest:
            raise HTTPException(409, 'Drive се е променил след архива. Записът е отказан.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media = MediaIoBaseUpload(io.BytesIO(new_bytes), mimetype='text/csv', resumable=False)
            service.files().update(fileId=fid, media_body=media).execute()
            confirmed = service.files().get_media(fileId=fid).execute()
            if hashlib.sha256(confirmed).digest() != hashlib.sha256(new_bytes).digest():
                raise RuntimeError('Drive mismatch')
        except Exception:
            raise HTTPException(503, 'Неясен резултат от записа. Провери списъка, преди нов опит.')
        temp = path.with_suffix('.p67_verified')
        temp.write_bytes(confirmed)
        os.replace(temp, path)
        return {'ok': True, 'trip_id': tid, 'backup_id': backup_id}
