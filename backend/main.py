"""PixelApp first migration slice — original Google Drive CSV schemas preserved.

This is a private, single-user API. It does not move or delete existing Drive files.
Production requires HTTPS and a secret API key, held server-side or sent via an
authenticated reverse proxy. Never expose the Google refresh token to the browser.
"""
import csv
import math
import json
import hashlib
import re
from decimal import Decimal, InvalidOperation
import io
import os
import threading
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

# Human-readable dates in PixelApp CSV files use Bulgarian local time,
# regardless of the Render server timezone. Leave UTC audit timestamps as UTC.
SOFIA_TZ = ZoneInfo("Europe/Sofia")
def sofia_now():
    return datetime.now(SOFIA_TZ)
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Header, Request, Response, BackgroundTasks
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
# P89: serialize protected writes across worker processes on the same Render host.
# This is NOT a distributed lock across Render instances or the legacy Streamlit host.
from contextlib import contextmanager
import fcntl

@contextmanager
def guarded_csv_write():
    # Both locks cover the entire read/check/backup/update/verify transaction.
    # Keep ordinary GETs unchanged to preserve fast P87.4 startup.
    with LOCK:
        lock_path = DATA_DIR / '.pixelapp_csv_write.lock'
        with open(lock_path, 'a+b') as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

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
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=['GET','POST','PUT','DELETE'], allow_headers=['X-API-Key','Content-Type','Authorization'])

# P96.6: Server-side boundary while Livigno is Neon READ-only.
# The front end already disables Drive editors, but an old browser tab or a
# separately cached client must not silently mutate the original Drive CSVs.
# Only the legacy routes listed here are blocked; photographs deliberately
# remain in Drive and use the independent /gallery API.
from fastapi.responses import JSONResponse
_P966_PROTECTED_TRIP = 'Livigno_Italy'
_P966_LEGACY_TRIP_WRITE_PATHS = frozenset((
    '/trips/{id}/expenses', '/trips/{id}/budget', '/trips/{id}/tasks',
    '/safe/trip-finance/{id}', '/safe/fuel/{id}',
    '/safe/missed-fuel/{id}', '/safe/finish/{id}',
    '/safe/tasks/{id}', '/safe/route/{id}',
    '/safe/favorites/{id}', '/safe/trip-places/{id}',
    '/safe/basic/{id}', '/safe/adopt-legacy-trip/{id}',
))
_P966_LEGACY_BLOCKED_PATHS = frozenset(
    template.format(id=_P966_PROTECTED_TRIP)
    for template in _P966_LEGACY_TRIP_WRITE_PATHS
)

@app.middleware('http')
async def p966_protect_legacy_drive_writes(request: Request, call_next):
    # Legacy task IDs include their trip ID; protect those direct handlers too.
    path = request.url.path
    method = request.method.upper()
    legacy_task_write = (path.startswith('/tasks/' + _P966_PROTECTED_TRIP + '_')
                         and method in ('PUT', 'DELETE', 'PATCH', 'POST'))
    if method in ('POST', 'PUT', 'PATCH', 'DELETE') and (
        path in _P966_LEGACY_BLOCKED_PATHS or legacy_task_write
    ):
        return JSONResponse(status_code=409, content={'detail':
            'Livigno се чете от Neon. Старите Drive записи са блокирани до завършване на миграцията.'})
    return await call_next(request)



# P87: Optional two-account authentication. Shared-key login remains supported only
# until PIXELAPP_AUTH_MODE=accounts is explicitly configured on Render.
import base64
import hmac
import secrets
import time
from fastapi import Request

_AUTH_TTL = 24 * 60 * 60

def _auth_accounts():
    try:
        data = json.loads(os.getenv('PIXELAPP_AUTH_USERS', '{}'))
        if not isinstance(data, dict):
            return {}
        return {name: record for name, record in data.items() if isinstance(name, str) and isinstance(record, dict)}
    except (ValueError, TypeError):
        return {}

# P88: Password overrides live in separate, per-user Google Drive files.
# Nothing here modifies the travel CSVs or Render Environment.
def _password_file_name(user: str):
    return 'pixelapp_auth_' + hashlib.sha256(user.encode('utf-8')).hexdigest()[:24] + '.json'

def _password_override(user: str):
    service = drive_service()
    if service is None:
        raise HTTPException(503, 'Google Drive не е достъпен за проверка на профила.')
    try:
        folder, files = folder_and_files(service)
        file_id = files.get(_password_file_name(user))
        if not file_id:
            return None
        content = service.files().get_media(fileId=file_id).execute()
        record = json.loads(content)
        if not isinstance(record, dict) or set(('salt','hash')) - record.keys():
            raise ValueError('invalid account record')
        return record
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, 'Не може да се провери актуалната парола в Drive.') from exc

def _effective_account(user: str):
    base = _auth_accounts().get(user)
    if base is None: return None
    return _password_override(user) or base

def _check_password(password: str, record):
    try:
        salt = bytes.fromhex(record.get('salt',''))
        expected = bytes.fromhex(record.get('hash',''))
        if len(salt)<16 or len(expected)!=32: return False
    except (TypeError, ValueError, AttributeError):
        return False
    actual=hashlib.pbkdf2_hmac('sha256',password.encode('utf-8'),salt,600000)
    return hmac.compare_digest(actual,expected)

class ChangePassword(BaseModel):
    current_password: str = Field(min_length=1,max_length=256)
    new_password: str = Field(min_length=4,max_length=12)

@app.post('/auth/change-password')
def auth_change_password(payload: ChangePassword, request: Request):
    if not _accounts_mode(): raise HTTPException(404, 'Профилният вход не е активен.')
    user=authorize(request=request)
    if payload.new_password==payload.current_password:
        raise HTTPException(400, 'Новата парола трябва да е различна.')
    # Prevent simultaneous changes on this instance.
    with LOCK:
        current=_effective_account(user)
        if not current or not _check_password(payload.current_password,current):
            raise HTTPException(401, 'Текущата парола е неправилна.')
        salt=secrets.token_bytes(16)
        hashed=hashlib.pbkdf2_hmac('sha256',payload.new_password.encode('utf-8'),salt,600000)
        content=json.dumps({'salt':salt.hex(),'hash':hashed.hex()},separators=(',',':')).encode('utf-8')
        try:
            from googleapiclient.http import MediaInMemoryUpload
            service=drive_service()
            folder, files=folder_and_files(service)
            name=_password_file_name(user)
            existing=files.get(name)
            if existing:
                old=service.files().get_media(fileId=existing).execute()
                backup_name=name+'.backup.'+str(int(time.time()))
                service.files().create(body={'name':backup_name,'parents':[folder]},media_body=MediaInMemoryUpload(old,mimetype='application/json',resumable=False),fields='id').execute()
                service.files().update(fileId=existing,media_body=MediaInMemoryUpload(content,mimetype='application/json',resumable=False)).execute()
            else:
                service.files().create(body={'name':name,'parents':[folder]},media_body=MediaInMemoryUpload(content,mimetype='application/json',resumable=False),fields='id').execute()
            effective=_password_override(user)
            if not _check_password(payload.new_password,effective):
                raise ValueError('password verification failed')
        except Exception as exc:
            raise HTTPException(503, 'Промяната не е потвърдена. Провери входа, преди да опиташ отново.') from exc
    return {'ok':True,'message':'Паролата е променена и проверена в Google Drive.'}

def _accounts_mode():
    return os.getenv('PIXELAPP_AUTH_MODE', '').strip().lower() == 'accounts'

def _auth_secret():
    secret = os.getenv('PIXELAPP_AUTH_SECRET', '')
    if len(secret) < 32:
        raise HTTPException(503, 'Сървърното удостоверяване не е конфигурирано.')
    return secret.encode('utf-8')

def _b64(data: bytes):
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')

def _unb64(data: str):
    return base64.urlsafe_b64decode(data + '=' * (-len(data) % 4))

def _create_session(user: str):
    timestamp = int(time.time())
    body = _b64(json.dumps({'sub': user, 'exp': timestamp + _AUTH_TTL, 'iat': timestamp}, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
    signature = _b64(hmac.new(_auth_secret(), body.encode('ascii'), hashlib.sha256).digest())
    return body + '.' + signature

def _session_user(bearer: str):
    try:
        body, signature = bearer.split('.', 1)
        actual = _b64(hmac.new(_auth_secret(), body.encode('ascii'), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, actual):
            raise ValueError('signature')
        data = json.loads(_unb64(body))
        user = data.get('sub')
        if not isinstance(user, str) or user not in _auth_accounts():
            raise ValueError('user')
        now = int(time.time())
        if not isinstance(data.get('exp'), int) or not isinstance(data.get('iat'), int) or data['exp'] <= now or data['iat'] > now + 60:
            raise ValueError('expired')
        return user
    except (ValueError, TypeError, KeyError, UnicodeError, base64.binascii.Error):
        raise HTTPException(401, 'Сесията е невалидна или е изтекла. Влез отново.')

class AccountLogin(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)

@app.get('/auth/config')
def auth_config():
    return {'mode': 'accounts' if _accounts_mode() else 'legacy'}

@app.post('/auth/login')
def auth_login(login: AccountLogin):
    if not _accounts_mode():
        raise HTTPException(404, 'Входът с профили не е активиран.')
    accounts = _auth_accounts()
    if len(accounts) != 2:
        raise HTTPException(503, 'Очакват се точно два конфигурирани акаунта.')
    # Verify Drive override on login. Fail closed if Drive is unavailable.
    record = _effective_account(login.username) if login.username in accounts else None
    if not record or not _check_password(login.password, record):
        raise HTTPException(401, 'Неправилно потребителско име или парола.')
    return {'token': _create_session(login.username), 'username': login.username, 'expires_in': _AUTH_TTL}

@app.get('/auth/me')
def auth_me(request: Request):
    return {'username': authorize(request=request)}

def authorize(request: Request, x_api_key: str | None = Header(default=None)):
    if _accounts_mode():
        header = request.headers.get('authorization', '')
        if not header.startswith('Bearer '):
            raise HTTPException(401, 'Необходим е вход с потребителски профил.')
        return _session_user(header[7:])
    key = os.getenv('PIXELAPP_API_KEY', '')
    if not key or not x_api_key or not hmac.compare_digest(x_api_key, key):
        raise HTTPException(401, 'Private API key required. Set PIXELAPP_API_KEY in backend/.env.')
    return 'legacy'


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
        stamp = sofia_now().strftime('%d.%m.%Y %H:%M:%S')
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
        backup_name = f'P44_BACKUP_{sofia_now().strftime("%Y%m%d_%H%M%S")}_{uuid.uuid4().hex[:8]}_{name}'
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
        backup_name = f'P45_BACKUP_{sofia_now().strftime("%Y%m%d_%H%M%S")}_{uuid.uuid4().hex[:8]}_{filename}'
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


# P91.5: Recoverable trip archive. No shared CSV or photos are deleted.
_ARCHIVE_FILE = 'PixelApp_ArchivedTrips.json'
_ARCHIVE_CACHE = {'until': 0.0, 'ids': set()}


def _archived_trips(service=None, mapping=None):
    import time
    if time.monotonic() < _ARCHIVE_CACHE['until']:
        return _ARCHIVE_CACHE['ids']
    if service is None:
        service = drive_service()
        if not service:
            raise HTTPException(503, 'Google Drive не е достъпен за проверка на архивираните пътувания.')
    if mapping is None:
        _, mapping = folder_and_files(service)
    fid = mapping.get(_ARCHIVE_FILE)
    if not fid:
        ids = set()
    else:
        try:
            data = json.loads(service.files().get_media(fileId=fid).execute().decode('utf-8'))
            if not isinstance(data, dict) or not isinstance(data.get('archived'), dict):
                raise ValueError('invalid manifest')
            ids = set(data['archived'].keys())
        except Exception:
            raise HTTPException(503, 'Архивният регистър не може да се прочете; показването е спряно за безопасност.')
    _ARCHIVE_CACHE.update(ids=ids, until=time.monotonic()+4)
    return ids


class TripArchiveRequest(BaseModel):
    trip_id: str = Field(min_length=1, max_length=200)
    confirmation: str = Field(min_length=1, max_length=200)
    expected_settings_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')


@app.get('/safe/trip-archive-preflight/{trip_id}', dependencies=[Depends(authorize)])
def trip_archive_preflight(trip_id: str):
    ensure_local_snapshot()
    with LOCK:
        service = drive_service()
        if not service: raise HTTPException(503, 'Google Drive е недостъпен.')
        _, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['settings'])
        if not fid: raise HTTPException(409, 'Липсват настройките на пътуванията.')
        remote = service.files().get_media(fileId=fid).execute()
        digest = hashlib.sha256(remote).hexdigest()
        if hashlib.sha256((DATA_DIR/FILENAMES['settings']).read_bytes()).hexdigest() != digest:
            raise HTTPException(409, 'Локалните данни и Drive се различават. Обнови първо.')
        rows = list(csv.DictReader(io.StringIO(remote.decode('utf-8-sig'))))
        if sum(row.get('trip_id') == trip_id for row in rows) != 1:
            raise HTTPException(409, 'Пътуването не е открито еднозначно.')
        return {'trip_id': trip_id, 'settings_sha256': digest,
                'archived': trip_id in _archived_trips(service, mapping), 'recoverable': True}


@app.post('/safe/trip-archive', dependencies=[Depends(authorize)])
def trip_archive(payload: TripArchiveRequest):
    if payload.trip_id == _P966_PROTECTED_TRIP:
        raise HTTPException(409, 'Архивирането на Livigno е блокирано по време на Neon миграцията.')
    import time
    if payload.confirmation != payload.trip_id:
        raise HTTPException(422, 'Потвърждението не съвпада с името на пътуването.')
    ensure_local_snapshot()
    with guarded_csv_write():
        service = drive_service()
        if not service: raise HTTPException(503, 'Google Drive е недостъпен.')
        folder, mapping = folder_and_files(service)
        sfid = mapping.get(FILENAMES['settings'])
        if not sfid: raise HTTPException(409, 'Липсва CSV с пътуванията.')
        raw = service.files().get_media(fileId=sfid).execute()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != payload.expected_settings_sha256 or hashlib.sha256((DATA_DIR/FILENAMES['settings']).read_bytes()).hexdigest() != digest:
            raise HTTPException(409, 'Списъкът с пътувания е променен. Обнови и опитай пак.')
        rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        if sum(row.get('trip_id') == payload.trip_id for row in rows) != 1:
            raise HTTPException(409, 'Пътуването не съществува еднозначно.')
        mfid = mapping.get(_ARCHIVE_FILE)
        prior = service.files().get_media(fileId=mfid).execute() if mfid else None
        try:
            doc = json.loads(prior.decode('utf-8')) if prior else {'archived': {}}
            if not isinstance(doc,dict) or not isinstance(doc.get('archived'),dict): raise ValueError()
        except Exception:
            raise HTTPException(409, 'Невалиден регистър на архивите. Няма промяна.')
        if payload.trip_id in doc['archived']:
            raise HTTPException(409, 'Пътуването вече е архивирано.')
        doc['archived'][payload.trip_id] = {'archived_at': datetime.utcnow().isoformat()+'Z', 'restore_available': True}
        updated = json.dumps(doc,ensure_ascii=False,indent=2).encode('utf-8')
        from googleapiclient.http import MediaIoBaseUpload
        try:
            if mfid:
                backup = service.files().copy(fileId=mfid,body={'name':'ARCHIVE_MANIFEST_BACKUP_'+uuid.uuid4().hex},fields='id').execute()
                if service.files().get_media(fileId=mfid).execute() != prior:
                    raise HTTPException(409,'Друг профил промени архивния списък. Обнови.')
                service.files().update(fileId=mfid,media_body=MediaIoBaseUpload(io.BytesIO(updated),mimetype='application/json',resumable=False)).execute()
            else:
                created=service.files().create(body={'name':_ARCHIVE_FILE,'parents':[folder],'mimeType':'application/json'},media_body=MediaIoBaseUpload(io.BytesIO(updated),mimetype='application/json',resumable=False),fields='id').execute()
                mfid=created['id']
            if service.files().get_media(fileId=mfid).execute() != updated:
                raise RuntimeError('Verification mismatch')
        except HTTPException: raise
        except Exception:
            raise HTTPException(503,'Архивът не е потвърден. Обнови преди повторен опит.')
        _ARCHIVE_CACHE.update(ids=set(doc['archived']),until=time.monotonic()+4)
        return {'ok': True, 'trip_id': payload.trip_id, 'archived': True,
                'message': 'Пътуването е скрито от списъка. Данните и снимките са запазени.'}


@app.get('/trips',dependencies=[Depends(authorize)])
def list_trips():
    ensure_local_snapshot()
    with LOCK:
        settings=load_rows('settings'); expenses=load_rows('expenses'); budgets=load_rows('budgets')
        archived = _archived_trips()
        ids=list(dict.fromkeys([x.get('trip_id','') for group in (settings,budgets,expenses) for x in group if x.get('trip_id') and x.get('trip_id') not in archived]))
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
        archived=_archived_trips()
        valid_ids={str(x.get('trip_id','')).strip() for x in settings if str(x.get('trip_id','')).strip() and str(x.get('trip_id','')).strip() not in archived}
        places=[]
        for point in load_rows('points'):
            tid=str(point.get('trip_id') or '').strip()
            if not tid or tid in archived or (tid != FAVORITES_TRIP_ID and valid_ids and tid not in valid_ids):
                continue
            try:
                lat=float(point.get('lat'))
                lon=float(point.get('lon'))
            except (ValueError, TypeError):
                continue
            if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat)>90 or abs(lon)>180:
                continue
            display_name='Общи любими' if tid == FAVORITES_TRIP_ID else tid.replace('_',' ').rsplit(' __ ',1)[0]
            places.append({'trip_id':tid,'trip_name':display_name,'lat':lat,'lon':lon,
                           'title':(str(point.get('title') or 'Място')[len(FAVORITES_PREFIX):] if tid == FAVORITES_TRIP_ID and str(point.get('title') or '').startswith(FAVORITES_PREFIX) else str(point.get('title') or 'Място')),
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
            if row.get('trip_id') not in names: continue
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
        rows.append({'trip_id':trip_id,'date':sofia_now().strftime('%d.%m.%Y %H:%M:%S'),'amount':payload.amount,'category':payload.category,
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
        rows=load_rows('tasks');item_id=f'{trip_id}_{sofia_now().strftime("%Y%m%d%H%M%S%f")}'
        rows.append({'trip_id':trip_id,'item_id':item_id,'title':payload.title.strip(),'done':False,'created':sofia_now().strftime('%d.%m.%Y %H:%M')})
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
    budget_mode: str | None = None
    category_budgets: dict[str, Decimal] | None = None
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



# P91.8.7 - opt-in-free, safe duration diagnostics. No personal data, CSV content
# or credentials are logged; only stage duration numbers and operation type.
def _pixelapp_perf(operation, started, marks):
    previous = started
    parts = []
    for stage, instant in marks:
        parts.append(f"{stage}={int((instant-previous)*1000)}ms")
        previous = instant
    print(f"PIXELAPP_PERF {operation} total={int((time.perf_counter()-started)*1000)}ms " + ' '.join(parts), flush=True)

@app.get('/safe/trip-finance-preflight/{trip_id}', dependencies=[Depends(authorize)])
def safe_trip_finance_preflight(trip_id: str):
    _perf_start = time.perf_counter(); _perf_marks = []
    ensure_local_snapshot(); _perf_marks.append(('local_snapshot',time.perf_counter()))
    with LOCK:
        service = drive_service(); _perf_marks.append(('drive_auth',time.perf_counter()))
        if not service:
            raise HTTPException(503, 'Няма връзка с Drive.')
        _, mapping = folder_and_files(service); _perf_marks.append(('drive_listing',time.perf_counter()))
        _assert_react_owned_trip(trip_id, service, mapping); _perf_marks.append(('ownership',time.perf_counter()))
        snapshots = {}
        results = {}
        for kind in ('budgets', 'expenses'):
            _, _, remote, local, _, rows = _finance_remote(kind, service, mapping)
            match = hashlib.sha256(remote).digest() == hashlib.sha256(local).digest()
            results[kind] = {'drive_matches_local': match, 'sha256': hashlib.sha256(remote).hexdigest()}
            snapshots[kind] = [r for r in rows if r.get('trip_id') == trip_id]
        _perf_marks.append(('csv_reads',time.perf_counter())); _pixelapp_perf('finance_preflight',_perf_start,_perf_marks)
        return {'armed': TEST_FINANCE_ARMED, 'test_trip_found': True, 'trip_id': trip_id,
                'can_write': TEST_FINANCE_ARMED and all(x['drive_matches_local'] for x in results.values()),
                'files': results, 'budgets': snapshots['budgets'], 'expenses': snapshots['expenses']}


@app.get('/safety/test-finance-preflight', dependencies=[Depends(authorize)])
def test_finance_preflight():
    return safe_trip_finance_preflight(TEST_TRIP_ID)


@app.post('/safe/trip-finance/{trip_id}', dependencies=[Depends(authorize)])
def safe_trip_finance_change(trip_id: str, payload: TestFinanceChange):
    if not TEST_FINANCE_ARMED:
        raise HTTPException(423, 'Пилотното финансово записване е заключено.')
    if payload.confirmation != 'ЗАПИШИ САМО ТЕСТОВИ ФИНАНСИ':
        raise HTTPException(400, 'Липсва тестовото потвърждение.')
    if payload.operation not in ('budget', 'category-add', 'expense-add', 'expense-edit', 'expense-delete'):
        raise HTTPException(422, 'Непозната финансова операция.')
    kind = 'budgets' if payload.operation in ('budget', 'category-add') else 'expenses'
    amount = None
    if payload.operation not in ('expense-delete', 'category-add'):
        if payload.operation != 'budget' or payload.budget_mode != 'category':
            amount = _finance_decimal(payload.amount,zero_ok=kind=='budgets')
    if kind == 'expenses' and payload.operation != 'expense-delete':
        # Custom categories must have been explicitly created for this trip.
        if payload.category not in FINANCE_CATEGORIES:
            # Validation against remote budget rows is performed inside the locked transaction.
            if not payload.category or len(payload.category)>50:
                raise HTTPException(422, 'Невалидна категория.')
        desc = (payload.description or '').strip()
        if not desc or len(desc) > 120 or re.search(r'гориво|газ|бензин|дизел|зареждане', desc, re.I):
            raise HTTPException(422, 'Въведи описание до 120 знака. Горивото е отделен модул.')
    else:
        desc = ''
    _perf_start = time.perf_counter(); _perf_marks = []
    ensure_local_snapshot(); _perf_marks.append(('local_snapshot',time.perf_counter()))
    with guarded_csv_write():
        _perf_marks.append(('write_lock',time.perf_counter()))
        service = drive_service(); _perf_marks.append(('drive_auth',time.perf_counter()))
        if not service:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        _, mapping = folder_and_files(service); _perf_marks.append(('drive_listing',time.perf_counter()))
        _assert_react_owned_trip(trip_id, service, mapping); _perf_marks.append(('ownership',time.perf_counter()))
        fid, path, remote, local, columns, rows = _finance_remote(kind, service, mapping); _perf_marks.append(('csv_read',time.perf_counter()))
        digest = hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or hashlib.sha256(local).hexdigest() != digest:
            raise HTTPException(409, 'Има промяна в Drive или Render. Направи нова проверка.')
        existing = [r for r in rows if r.get('trip_id') == trip_id]
        if kind == 'expenses' and payload.operation in ('expense-add', 'expense-edit') and payload.category not in FINANCE_CATEGORIES:
            _, _, _, _, _, budget_rows = _finance_remote('budgets', service, mapping)
            if not any(r.get('trip_id') == trip_id and r.get('category') == payload.category for r in budget_rows):
                raise HTTPException(422, 'Категорията не принадлежи на това пътуване.')
        if payload.operation == 'budget':
            if payload.budget_mode not in ('global', 'category'):
                raise HTTPException(422, 'Избери общ бюджет или бюджет по категории.')
            custom_names = {r.get('category') for r in existing if r.get('category') not in ('__GLOBAL__', *FINANCE_CATEGORIES)}
            # Retain custom categories (zero-valued rows) even when switching to global.
            rows = [r for r in rows if r.get('trip_id') != trip_id]
            values = {}
            if payload.budget_mode == 'global':
                if amount != '0.00':
                    values['__GLOBAL__'] = amount
            else:
                selected = payload.category_budgets or {}
                allowed = set(FINANCE_CATEGORIES) | custom_names
                if set(selected) - allowed:
                    raise HTTPException(422, 'Непозната категория в бюджета.')
                if len(selected)>60:
                    raise HTTPException(422, 'Твърде много категории.')
                for name, value in selected.items():
                    values[name] = _finance_decimal(value, zero_ok=True)
            for name in custom_names:
                values.setdefault(name, '0.00')
            for name, value in values.items():
                if value != '0.00' or name in custom_names:
                    row = {k: '' for k in columns}
                    row.update(trip_id=trip_id, category=name, budget=value)
                    rows.append(row)
        elif payload.operation == 'category-add':
            name = (payload.category or '').strip()
            if not name or len(name)>50 or name.startswith('__') or re.search(r'[\r\n,;]', name):
                raise HTTPException(422, 'Въведи име до 50 знака, без запетаи и нови редове.')
            if name in FINANCE_CATEGORIES or any(r.get('category','').casefold()==name.casefold() for r in existing):
                raise HTTPException(409, 'Тази категория вече съществува.')
            if sum(1 for r in existing if r.get('category') not in ('__GLOBAL__', *FINANCE_CATEGORIES)) >= 30:
                raise HTTPException(422, 'Достигнат е лимитът за лични категории.')
            row = {k:'' for k in columns}
            row.update(trip_id=trip_id, category=name, budget='0.00')
            rows.append(row)
        elif payload.operation == 'expense-add':
            row = {k:'' for k in columns}
            row.update(trip_id=trip_id, date=sofia_now().strftime('%d.%m.%Y %H:%M:%S'),
                       amount=amount, category=payload.category, description='[P62] '+desc,
                       type='expense',liters='0',current_km='0')
            # Same label is allowed on different purchases. Only an exactly identical row
            # within the same second is ambiguous for later edit/delete operations.
            if any(all(str(r.get(k,'')) == str(row.get(k,'')) for k in COLUMNS['expenses']) for r in rows):
                raise HTTPException(409, 'Вече има идентичен запис в същата секунда. Провери списъка, преди да повториш.')
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
                rows[index].update(amount=amount, category=payload.category, description='[P62] '+desc)
        out = io.StringIO(newline='')
        writer = csv.DictWriter(out, fieldnames=columns, extrasaction='ignore', lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated = out.getvalue().encode('utf-8')
        try:
            backup = service.files().copy(fileId=fid,body={'name':'P68_FINANCE_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES[kind]},fields='id').execute()
        except Exception:
            raise HTTPException(503, 'Архивът не е създаден. Няма запис.')
        _perf_marks.append(('backup_copy',time.perf_counter()))
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest() != digest:
            raise HTTPException(409, 'Drive се е променил след архива. Записът е отказан.')
        _perf_marks.append(('before_upload_check',time.perf_counter()))
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media = MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)
            service.files().update(fileId=fid,media_body=media).execute()
            _perf_marks.append(('drive_upload',time.perf_counter()))
            verified = service.files().get_media(fileId=fid).execute(); _perf_marks.append(('drive_verify',time.perf_counter()))
            if hashlib.sha256(verified).digest() != hashlib.sha256(updated).digest():
                raise RuntimeError('Verification failed')
        except Exception:
            raise HTTPException(503, 'Записът не е потвърден. Не опитвай повторно, преди проверка.')
        tmp = path.with_suffix('.p62_verified')
        tmp.write_bytes(verified)
        os.replace(tmp, path)
        _perf_marks.append(('local_commit',time.perf_counter())); _pixelapp_perf('finance_write',_perf_start,_perf_marks)
        return {'ok':True, 'operation':payload.operation, 'backup_id':backup['id']}


@app.post('/safety/test-finance', dependencies=[Depends(authorize)])
def test_finance_change(payload: TestFinanceChange):
    return safe_trip_finance_change(TEST_TRIP_ID, payload)


# Patch 70: fuel from the standard expense form, for React-created car trips only.
# No fuel edit/delete and no missed-liters logic in this first stage.
FUEL_WRITE_ENABLED = os.getenv('PIXELAPP_FUEL_WRITE_ENABLED', 'true').strip().lower() == 'true'

class SafeFuelAdd(BaseModel):
    amount: Decimal
    liters: Decimal
    current_km: int = Field(ge=1, le=9999999)
    full: bool
    description: str = Field(min_length=1, max_length=120)
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')


def _fuel_last_km(rows, tid, start_km):
    readings = [start_km]
    for row in rows:
        if row.get('trip_id') != tid or row.get('category') != 'Транспорт' or row.get('type') != 'expense':
            continue
        try:
            if Decimal(str(row.get('liters') or '0')) > 0:
                readings.append(int(Decimal(str(row.get('current_km') or '0'))))
        except (ValueError, InvalidOperation):
            raise HTTPException(422, 'Невалиден исторически километраж или литри.')
    return max(readings)


@app.get('/safe/fuel-preflight/{trip_id}', dependencies=[Depends(authorize)])
def safe_fuel_preflight(trip_id: str):
    ensure_local_snapshot()
    with LOCK:
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        _, mapping = folder_and_files(service)
        settings = _assert_react_owned_trip(trip_id, service, mapping)
        if settings.get('car_trip') != 'Да':
            raise HTTPException(409, 'Пътуването е без автомобил.')
        if str(settings.get('trip_finished','')).casefold() == 'да' or Decimal(str(settings.get('end_km') or '0')) > 0:
            raise HTTPException(423, 'Приключеното пътуване е заключено за зареждания.')
        fid, path, remote, local, columns, rows = _finance_remote('expenses', service, mapping)
        digest = hashlib.sha256(remote).hexdigest()
        return {'can_write': FUEL_WRITE_ENABLED and hashlib.sha256(local).hexdigest() == digest,
                'drive_matches_local': hashlib.sha256(local).hexdigest() == digest,
                'sha256': digest, 'last_km': _fuel_last_km(rows, trip_id, int(Decimal(str(settings.get('start_km') or '0')))),
                'fuel_entries': sum(1 for r in rows if r.get('trip_id')==trip_id and r.get('category')=='Транспорт' and Decimal(str(r.get('liters') or '0'))>0)}


@app.post('/safe/fuel/{trip_id}', dependencies=[Depends(authorize)])
def safe_fuel_add(trip_id: str, payload: SafeFuelAdd):
    if not FUEL_WRITE_ENABLED:
        raise HTTPException(423, 'Записването на гориво е заключено.')
    amount = _finance_decimal(payload.amount)
    if not payload.liters.is_finite() or payload.liters <= 0 or payload.liters > Decimal('200') or payload.liters.as_tuple().exponent < -2:
        raise HTTPException(422, 'Литрите трябва да са между 0.01 и 200 с до два знака.')
    description = payload.description.strip()
    if not description or '[' in description or ']' in description or len(description)>120:
        raise HTTPException(422, 'Невалидно описание.')
    # Original Streamlit rule: category Transport AND one of five keywords.
    if not re.search(r'газ|гориво|зареждане|бензин|дизел', description, re.I):
        raise HTTPException(422, 'Описанието на горивото трябва да съдържа ключова дума от стария PixelApp.')
    ensure_local_snapshot()
    with guarded_csv_write():
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        _, mapping = folder_and_files(service)
        settings = _assert_react_owned_trip(trip_id, service, mapping)
        if settings.get('car_trip') != 'Да':
            raise HTTPException(409, 'Пътуването е без автомобил.')
        if str(settings.get('trip_finished','')).casefold() == 'да' or Decimal(str(settings.get('end_km') or '0')) > 0:
            raise HTTPException(423, 'Приключеното пътуване е заключено за зареждания.')
        fid, path, remote, local, columns, rows = _finance_remote('expenses', service, mapping)
        digest = hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or digest != hashlib.sha256(local).hexdigest():
            raise HTTPException(409, 'Данните в Google Drive се различават. Няма запис.')
        last_km = _fuel_last_km(rows, trip_id, int(Decimal(str(settings.get('start_km') or '0'))))
        if payload.current_km <= last_km:
            raise HTTPException(422, f'Километражът трябва да е по-голям от {last_km}.')
        row = {k:'' for k in columns}
        row.update(trip_id=trip_id, date=sofia_now().strftime('%d.%m.%Y %H:%M:%S'),
                   amount=amount, category='Транспорт',
                   description='[ПЪЛНО ЗАРЕЖДАНЕ] '+description if payload.full else '[ЧАСТИЧНО ЗАРЕЖДАНЕ] '+description,
                   type='expense', liters=str(payload.liters.quantize(Decimal('0.01'))), current_km=str(payload.current_km))
        rows.append(row)
        out=io.StringIO(newline='')
        writer=csv.DictWriter(out,fieldnames=columns,extrasaction='ignore',lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
        updated=out.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={'name':'P69_FUEL_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['expenses']},fields='id').execute()
        except Exception:
            raise HTTPException(503,'Неуспешно резервно копие. Няма запис.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest() != digest:
            raise HTTPException(409,'Drive е променен преди записа. Няма запис.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)
            service.files().update(fileId=fid,media_body=media).execute()
            verified=service.files().get_media(fileId=fid).execute()
            if verified != updated:
                raise RuntimeError('Verification mismatch')
        except Exception:
            raise HTTPException(503, 'Записът не е потвърден. Провери данните преди нов опит.')
        tmp=path.with_suffix('.p69_verified')
        tmp.write_bytes(verified)
        os.replace(tmp,path)
        return {'ok':True,'backup_id':backup['id'],'last_km':payload.current_km}


# Patch 72: missed litres, with or without known cost. A single CSV transaction
# stores litres directly (never in settings.manual_fuel), so there is no unsafe
# two-file write and the litres contribute exactly once to existing totals.
class MissedFuelAdd(BaseModel):
    liters: Decimal
    amount: Decimal = Decimal('0')
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')


@app.post('/safe/missed-fuel/{trip_id}', dependencies=[Depends(authorize)])
def safe_missed_fuel_add(trip_id: str, payload: MissedFuelAdd):
    if not FUEL_WRITE_ENABLED:
        raise HTTPException(423, 'Записването на гориво е заключено.')
    if (not payload.liters.is_finite() or payload.liters <= 0 or
            payload.liters > Decimal('500') or payload.liters.as_tuple().exponent < -2):
        raise HTTPException(422, 'Литрите трябва да са от 0.01 до 500, с до два знака.')
    if (not payload.amount.is_finite() or payload.amount < 0 or
            payload.amount > Decimal('10000') or payload.amount.as_tuple().exponent < -2):
        raise HTTPException(422, 'Сумата трябва да е от 0 до 10000 €, с до два знака.')
    ensure_local_snapshot()
    with guarded_csv_write():
        service=drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        _, mapping=folder_and_files(service)
        settings=_assert_react_owned_trip(trip_id,service,mapping)
        if settings.get('car_trip') != 'Да':
            raise HTTPException(409, 'Пътуването е без автомобил.')
        if str(settings.get('trip_finished','')).casefold() == 'да' or Decimal(str(settings.get('end_km') or '0')) > 0:
            raise HTTPException(423, 'Приключеното пътуване е заключено.')
        fid,path,remote,local,columns,rows=_finance_remote('expenses',service,mapping)
        digest=hashlib.sha256(remote).hexdigest()
        marker='[P72:'+payload.request_id+']'
        already=[r for r in rows if r.get('trip_id')==trip_id and marker in r.get('description','')]
        if already:
            if len(already)==1:
                return {'ok':True,'already_saved':True,'note':'Записът вече съществува. Не е дублиран.'}
            raise HTTPException(409, 'Открити са повторени идентификатори. Не е променено нищо.')
        if digest != payload.expected_sha256 or digest != hashlib.sha256(local).hexdigest():
            raise HTTPException(409, 'Google Drive е променен. Обнови данните преди нов запис.')
        litres=payload.liters.quantize(Decimal('0.01'))
        amount=payload.amount.quantize(Decimal('0.01'))
        label='[ПРОПУСНАТО ГОРИВО]' if amount>0 else '[ГОРИВО БЕЗ СТОЙНОСТ]'
        row={k:'' for k in columns}
        row.update(trip_id=trip_id,date=sofia_now().strftime('%d.%m.%Y %H:%M:%S'),
                   amount=str(amount),category='Транспорт',
                   description=f'{label} Добавени {litres:.2f} литра {marker}',
                   type='expense',liters=str(litres),current_km='0')
        rows.append(row)
        out=io.StringIO(newline='')
        writer=csv.DictWriter(out,fieldnames=columns,extrasaction='ignore',lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated=out.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={'name':'P72_MISSED_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['expenses']},fields='id').execute()
        except Exception:
            raise HTTPException(503, 'Неуспешно резервно копие. Няма запис.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest()!=digest:
            raise HTTPException(409, 'Drive е променен след архива. Няма запис.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            media=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)
            service.files().update(fileId=fid,media_body=media).execute()
            verified=service.files().get_media(fileId=fid).execute()
            if verified!=updated:
                raise RuntimeError('Verification mismatch')
        except Exception:
            raise HTTPException(503, 'Записът не е потвърден. Провери данните преди повторен опит.')
        tmp=path.with_suffix('.p72_verified')
        tmp.write_bytes(verified)
        os.replace(tmp,path)
        return {'ok':True,'backup_id':backup['id'],'liters':str(litres),'amount':str(amount)}


@app.get('/safe/react-owned-trips', dependencies=[Depends(authorize)])
def react_owned_trips():
    ensure_local_snapshot()
    with LOCK:
        service = drive_service()
        if not service:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        _, mapping = folder_and_files(service)
        return {'trip_ids': sorted(_react_owned_ids(service, mapping))}


# P91.7.1: read-only compatibility audit for imported Streamlit trips.
# This endpoint NEVER registers ownership or changes any Drive file.
@app.get('/safe/legacy-trip-audit/{trip_id}', dependencies=[Depends(authorize)])
def legacy_trip_audit(trip_id: str):
    ensure_local_snapshot()
    with LOCK:
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        _, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['settings'])
        if not fid:
            raise HTTPException(409, 'Липсва файлът с настройките в Drive.')
        remote = service.files().get_media(fileId=fid).execute()
        local_path = DATA_DIR / FILENAMES['settings']
        local_ok = local_path.exists() and hashlib.sha256(local_path.read_bytes()).digest() == hashlib.sha256(remote).digest()
        reader = csv.DictReader(io.StringIO(remote.decode('utf-8-sig')))
        if not reader.fieldnames or any(k not in reader.fieldnames for k in COLUMNS['settings']):
            raise HTTPException(422, 'Непознат формат на настройките.')
        matches = [r for r in reader if r.get('trip_id') == trip_id]
        if len(matches) != 1:
            raise HTTPException(409, 'Пътуването не е намерено еднозначно в Drive.')
        trip = matches[0]
        owned = trip_id in _react_owned_ids(service, mapping)
        sections = {}
        for kind in ('expenses', 'budgets', 'tasks', 'points', 'categories'):
            sections[kind] = sum(r.get('trip_id') == trip_id for r in load_rows(kind))
        return {
            'trip_id': trip_id,
            'react_owned': owned,
            'finished': trip.get('trip_finished') == 'Да',
            'start_date': trip.get('start_date', ''),
            'end_date': trip.get('end_date', ''),
            'car_trip': trip.get('car_trip') == 'Да',
            'settings_synced': local_ok,
            'settings_sha256': hashlib.sha256(remote).hexdigest(),
            'rows': sections,
            'writable': owned and trip.get('trip_finished') != 'Да',
            'migration_available': False,
            'message': ('Пътуването е от Streamlit. Не е разрешен запис, докато не се провери безопасната миграция.'
                        if not owned else 'Пътуването е регистрирано в React.'),
        }


# P91.7.2: one-trip, opt-in conversion of a legacy trip for React editing.
# No CSV row is modified during conversion. Existing guarded CRUD paths
# continue to require valid versions and write verified Drive backups.
class LegacyAdoptRequest(BaseModel):
    expected_settings_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmation: str

@app.post('/safe/adopt-legacy-trip/{trip_id}', dependencies=[Depends(authorize)])
def adopt_legacy_trip(trip_id: str, payload: LegacyAdoptRequest):
    if payload.confirmation != 'РАЗРЕШИ REACT':
        raise HTTPException(422, 'Липсва изрично потвърждение.')
    ensure_local_snapshot()
    with guarded_csv_write():
        service = drive_service()
        if service is None:
            raise HTTPException(503, 'Google Drive не е достъпен.')
        folder_id, mapping = folder_and_files(service)
        settings_id = mapping.get(FILENAMES['settings'])
        if not settings_id:
            raise HTTPException(409, 'Липсват настройките в Google Drive.')
        raw_settings = service.files().get_media(fileId=settings_id).execute()
        digest = hashlib.sha256(raw_settings).hexdigest()
        if digest != payload.expected_settings_sha256 or hashlib.sha256((DATA_DIR/FILENAMES['settings']).read_bytes()).hexdigest() != digest:
            raise HTTPException(409, 'Настройките са променени. Обнови и провери отново.')
        reader=csv.DictReader(io.StringIO(raw_settings.decode('utf-8-sig')))
        if not reader.fieldnames or any(col not in reader.fieldnames for col in COLUMNS['settings']):
            raise HTTPException(422, 'Непознат формат на настройките.')
        rows=[r for r in reader if r.get('trip_id')==trip_id]
        if len(rows)!=1 or rows[0].get('trip_finished')=='Да':
            raise HTTPException(409, 'Само еднозначно намерено неприключено пътуване може да се мигрира.')
        if trip_id in _react_owned_ids(service,mapping):
            return {'ok':True,'trip_id':trip_id,'already_enabled':True}
        # Snapshot every existing CSV before enabling *any* writes from React.
        # Refuse stale local snapshots; old Streamlit must not modify them during conversion.
        snapshots={}
        for kind,filename in FILENAMES.items():
            fid=mapping.get(filename)
            if not fid:
                if kind in BOOTSTRAP_REQUIRED:
                    raise HTTPException(409, 'Липсва задължителен файл: '+filename)
                continue
            remote=service.files().get_media(fileId=fid).execute()
            path=DATA_DIR/filename
            if not path.exists() or path.read_bytes()!=remote:
                raise HTTPException(409, 'Няма актуална локална версия на '+filename+'. Обнови данните преди миграция.')
            columns=csv.DictReader(io.StringIO(remote.decode('utf-8-sig')))
            if not columns.fieldnames or any(col not in columns.fieldnames for col in COLUMNS[kind]):
                raise HTTPException(422, 'Непознат формат на '+filename)
            snapshots[filename]=(fid,remote)
        backup_ids={}
        try:
            for filename,(fid,remote) in snapshots.items():
                item=service.files().copy(fileId=fid,body={'name':'P9172_LEGACY_MIGRATION_'+uuid.uuid4().hex+'_'+filename},fields='id').execute()
                backup_ids[filename]=item['id']
            # Recheck all source files after backups, before changing ownership registry.
            for filename,(fid,remote) in snapshots.items():
                if service.files().get_media(fileId=fid).execute()!=remote:
                    raise HTTPException(409, 'Данните се промениха по време на архивирането. Миграцията е отказана.')
            _register_react_trip(service,folder_id,mapping,trip_id)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503,'Неуспешно резервно копие. Миграцията е отказана.') from exc
        return {'ok':True,'trip_id':trip_id,'already_enabled':False,'backups':len(backup_ids)}

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
    with guarded_csv_write():
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


# Safe trip finalization: updates one React-owned settings row only.
# Existing Streamlit trips remain read-only. No expense or fuel rows are changed.
FINISH_WRITE_ENABLED = os.getenv('PIXELAPP_FINISH_ENABLED', 'true').lower() == 'true'

class FinishTripPayload(BaseModel):
    end_km: int = Field(ge=0, le=9999999)
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')


def _finish_snapshot(trip_id, service, mapping):
    if trip_id not in _react_owned_ids(service, mapping):
        raise HTTPException(403, 'Старите пътувания остават само за четене.')
    filename=FILENAMES['settings']
    fid=mapping.get(filename)
    path=DATA_DIR/filename
    if not fid or not path.exists():
        raise HTTPException(409, 'Липсва файлът с настройките.')
    remote=service.files().get_media(fileId=fid).execute()
    local=path.read_bytes()
    reader=csv.DictReader(io.StringIO(remote.decode('utf-8-sig')))
    cols=reader.fieldnames
    if not cols or any(c not in cols for c in COLUMNS['settings']):
        raise HTTPException(422, 'Непознат формат на настройките.')
    rows=list(reader)
    matches=[r for r in rows if r.get('trip_id')==trip_id]
    if len(matches)!=1:
        raise HTTPException(409, 'Нееднозначно пътуване. Записът е отказан.')
    return fid,path,remote,local,cols,rows,matches[0]


@app.get('/safe/finish-preflight/{trip_id}',dependencies=[Depends(authorize)])
def safe_finish_preflight(trip_id: str):
    ensure_local_snapshot()
    with LOCK:
        service=drive_service()
        if service is None:
            raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        fid,path,remote,local,cols,rows,item=_finish_snapshot(trip_id,service,mapping)
        finished=str(item.get('trip_finished','')).casefold()=='да' or Decimal(str(item.get('end_km') or '0'))>0
        car=item.get('car_trip')=='Да'
        start=int(Decimal(str(item.get('start_km') or '0')))
        digest=hashlib.sha256(remote).hexdigest()
        return {'can_write':FINISH_WRITE_ENABLED and not finished and hashlib.sha256(local).hexdigest()==digest,
                'drive_matches_local':hashlib.sha256(local).hexdigest()==digest,'sha256':digest,
                'car_trip':car,'start_km':start,'finished':finished}


@app.post('/safe/finish/{trip_id}',dependencies=[Depends(authorize)])
def safe_finish_trip(trip_id: str, payload: FinishTripPayload):
    if not FINISH_WRITE_ENABLED:
        raise HTTPException(423,'Приключването е временно заключено.')
    ensure_local_snapshot()
    with guarded_csv_write():
        service=drive_service()
        if service is None:
            raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        fid,path,remote,local,cols,rows,item=_finish_snapshot(trip_id,service,mapping)
        digest=hashlib.sha256(remote).hexdigest()
        if digest != payload.expected_sha256 or hashlib.sha256(local).hexdigest()!=digest:
            raise HTTPException(409,'Настройките са променени. Обнови приложението.')
        if str(item.get('trip_finished','')).casefold()=='да' or Decimal(str(item.get('end_km') or '0'))>0:
            raise HTTPException(423,'Пътуването вече е приключено. Няма втори запис.')
        car=item.get('car_trip')=='Да'
        start=int(Decimal(str(item.get('start_km') or '0')))
        if car:
            if payload.end_km<=start:
                raise HTTPException(422,'Крайният километраж трябва да е по-голям от началния.')
            # A finish cannot predate any real refueling odometer reading.
            expfid= mapping.get(FILENAMES['expenses'])
            if not expfid:
                raise HTTPException(409,'Липсва историята на разходите.')
            expraw=service.files().get_media(fileId=expfid).execute()
            expenses=list(csv.DictReader(io.StringIO(expraw.decode('utf-8-sig'))))
            last=_fuel_last_km(expenses,trip_id,start)
            if payload.end_km<last:
                raise HTTPException(422,f'Крайният километраж не може да е под последното зареждане ({last} км).')
            item['end_km']=str(payload.end_km)
            # Streamlit uses nonzero end_km for car trip closure.
            item['trip_finished']='Не'
        else:
            if payload.end_km!=0:
                raise HTTPException(422,'За пътуване без автомобил километражът е 0.')
            item['trip_finished']='Да'
        out=io.StringIO(newline='')
        writer=csv.DictWriter(out,fieldnames=cols,extrasaction='ignore',lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated=out.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={'name':'P73_FINISH_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['settings']},fields='id').execute()
        except Exception:
            raise HTTPException(503,'Архивът не успя. Пътуването не е приключено.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest()!=digest:
            raise HTTPException(409,'Drive се е променил след архива. Няма запис.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            service.files().update(fileId=fid,media_body=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)).execute()
            verified=service.files().get_media(fileId=fid).execute()
            if verified!=updated:
                raise RuntimeError('Verification mismatch')
        except Exception:
            raise HTTPException(503,'Записът не е потвърден. Провери статуса преди повторен опит.')
        tmp=path.with_suffix('.p73_verified')
        tmp.write_bytes(verified)
        os.replace(tmp,path)
        return {'ok':True,'backup_id':backup['id'],'end_km':payload.end_km,'finished':True}


# Patch 75: protected task writes for React-owned, active trips only.
TASK_WRITE_ENABLED = os.getenv('PIXELAPP_TASK_WRITE_ENABLED', 'true').lower() == 'true'

class SafeTaskChange(BaseModel):
    operation: str
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    item_id: str = ''
    title: str = ''
    expected_title: str | None = None
    expected_done: str | None = None

@app.get('/safe/tasks-preflight/{trip_id}', dependencies=[Depends(authorize)])
def safe_tasks_preflight(trip_id: str):
    _perf_start = time.perf_counter(); _perf_marks = []
    ensure_local_snapshot(); _perf_marks.append(('local_snapshot',time.perf_counter()))
    with LOCK:
        service=drive_service(); _perf_marks.append(('drive_auth',time.perf_counter()))
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service); _perf_marks.append(('drive_listing',time.perf_counter()))
        _assert_react_owned_trip(trip_id,service,mapping); _perf_marks.append(('ownership',time.perf_counter()))
        _,_,remote,local,_,rows=_finance_remote('tasks',service,mapping); _perf_marks.append(('csv_read',time.perf_counter()))
        digest=hashlib.sha256(remote).hexdigest()
        same=hashlib.sha256(local).hexdigest()==digest
        _pixelapp_perf('tasks_preflight',_perf_start,_perf_marks)
        return {'can_write':TASK_WRITE_ENABLED and same,'sha256':digest,
                'drive_matches_local':same,'tasks':[x for x in rows if x.get('trip_id')==trip_id]}

@app.post('/safe/tasks/{trip_id}', dependencies=[Depends(authorize)])
def safe_tasks_change(trip_id: str,payload: SafeTaskChange):
    if not TASK_WRITE_ENABLED: raise HTTPException(423,'Записването на задачи е заключено.')
    if payload.operation not in ('add','edit','toggle','toggle-fast','delete'):
        raise HTTPException(422,'Неподдържано действие.')
    title=payload.title.strip()
    if payload.operation in ('add','edit') and (not title or len(title)>200):
        raise HTTPException(422,'Задачата трябва да е между 1 и 200 символа.')
    _perf_start = time.perf_counter(); _perf_marks = []
    ensure_local_snapshot(); _perf_marks.append(('local_snapshot',time.perf_counter()))
    with guarded_csv_write():
        _perf_marks.append(('write_lock',time.perf_counter()))
        service=drive_service(); _perf_marks.append(('drive_auth',time.perf_counter()))
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service); _perf_marks.append(('drive_listing',time.perf_counter()))
        _assert_react_owned_trip(trip_id,service,mapping); _perf_marks.append(('ownership',time.perf_counter()))
        fid,path,remote,local,columns,rows=_finance_remote('tasks',service,mapping); _perf_marks.append(('csv_read',time.perf_counter()))
        digest=hashlib.sha256(remote).hexdigest()
        # P91.8.9: A one-request toggle uses the current Drive snapshot rather than
        # a stale preflight hash. It is accepted ONLY when the caller proves the
        # exact task state it displayed; all other operations still require SHA.
        if hashlib.sha256(local).hexdigest()!=digest or (payload.operation!='toggle-fast' and digest!=payload.expected_sha256):
            raise HTTPException(409,'Данните са променени от друг телефон. Обнови и опитай отново.')
        if payload.operation=='add':
            item_id=f'{trip_id}_{sofia_now().strftime("%Y%m%d%H%M%S%f")}_{uuid.uuid4().hex[:6]}'
            row={col:'' for col in columns}
            row.update(trip_id=trip_id,item_id=item_id,title=title,done='False',created=sofia_now().strftime('%d.%m.%Y %H:%M'))
            rows.append(row)
        else:
            matched=[r for r in rows if r.get('trip_id')==trip_id and r.get('item_id')==payload.item_id]
            if len(matched)!=1: raise HTTPException(404,'Задачата не е намерена еднозначно.')
            row=matched[0]
            if payload.operation=='toggle-fast':
                if payload.expected_title is None or payload.expected_done is None:
                    raise HTTPException(409,'Липсва потвърдено състояние на задачата. Обнови.')
                if str(row.get('title') or '')!=payload.expected_title or str(row.get('done') or '').lower()!=payload.expected_done.lower():
                    raise HTTPException(409,'Задачата е променена от друг профил. Обнови.')
            if payload.operation=='edit':
                # A client must prove which specific task state its editor opened.
                # This protects against stale editors, even when a UI refresh happens.
                if payload.expected_title is None or payload.expected_done is None:
                    raise HTTPException(409,'Редакцията е от стара версия. Отвори задачата отново.')
                if (str(row.get('title') or '') != payload.expected_title or
                        str(row.get('done') or '').lower() != payload.expected_done.lower()):
                    raise HTTPException(409,'Тази задача е редактирана от друг профил. Обнови я и опитай отново.')
                row['title']=title
            elif payload.operation in ('toggle','toggle-fast'): row['done']='False' if str(row.get('done','')).lower() in ('true','1','yes','да') else 'True'
            else: rows.remove(row)
            item_id=payload.item_id
        out=io.StringIO(newline='')
        writer=csv.DictWriter(out,fieldnames=columns,extrasaction='ignore',lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated=out.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={'name':'P75_TASKS_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['tasks']},fields='id').execute()
        except Exception: raise HTTPException(503,'Неуспешно резервно копие. Няма запис.')
        _perf_marks.append(('backup_copy',time.perf_counter()))
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest()!=digest:
            raise HTTPException(409,'Drive е променен преди записа. Няма запис.')
        _perf_marks.append(('before_upload_check',time.perf_counter()))
        try:
            from googleapiclient.http import MediaIoBaseUpload
            service.files().update(fileId=fid,media_body=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)).execute()
            _perf_marks.append(('drive_upload',time.perf_counter()))
            verified=service.files().get_media(fileId=fid).execute(); _perf_marks.append(('drive_verify',time.perf_counter()))
            if verified!=updated: raise RuntimeError('Mismatch')
        except Exception:
            raise HTTPException(503,'Записът не е потвърден. Провери данните преди нов опит.')
        tmp=path.with_suffix('.p75_verified');tmp.write_bytes(verified);os.replace(tmp,path)
        _perf_marks.append(('local_commit',time.perf_counter())); _pixelapp_perf('tasks_write',_perf_start,_perf_marks)
        return {'ok':True,'item_id':item_id,'backup_id':backup['id']}


# P76: protected route stops, preserving Streamlit CSV order and 3b: naming.
ROUTE_WRITE_ENABLED = os.getenv('PIXELAPP_ROUTE_WRITE_ENABLED','true').lower() == 'true'

class SafeRouteChange(BaseModel):
    operation: str
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    index: int = -1
    title: str = ''
    lat: float = 0
    lon: float = 0
    stop_type: str = 'planned'
    position: int = -1

def _route_stops(rows,trip_id):
    return [i for i,r in enumerate(rows) if r.get('trip_id')==trip_id and str(r.get('title','')).startswith('3b:') and r.get('color') in ('purple','orange')]

@app.get('/safe/route-preflight/{trip_id}',dependencies=[Depends(authorize)])
def safe_route_preflight(trip_id:str):
    ensure_local_snapshot()
    with LOCK:
        service=drive_service()
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        _assert_react_owned_trip(trip_id,service,mapping)
        _,_,remote,local,_,rows=_finance_remote('points',service,mapping)
        digest=hashlib.sha256(remote).hexdigest()
        same=hashlib.sha256(local).hexdigest()==digest
        return {'can_write':ROUTE_WRITE_ENABLED and same,'sha256':digest,'drive_matches_local':same,
                'stops':[dict(rows[i],route_index=n) for n,i in enumerate(_route_stops(rows,trip_id))]}

@app.post('/safe/route/{trip_id}',dependencies=[Depends(authorize)])
def safe_route_change(trip_id:str,payload:SafeRouteChange):
    if not ROUTE_WRITE_ENABLED: raise HTTPException(423,'Редакцията на маршрута е заключена.')
    if payload.operation not in ('add','delete','move'):
        raise HTTPException(422,'Неподдържано действие.')
    title=payload.title.strip()
    if payload.operation=='add':
        if not title or len(title)>150 or not all(map(math.isfinite,(payload.lat,payload.lon))) or abs(payload.lat)>90 or abs(payload.lon)>180:
            raise HTTPException(422,'Въведи валидно име и координати.')
        if payload.stop_type not in ('planned','unplanned'):
            raise HTTPException(422,'Невалиден тип спирка.')
    ensure_local_snapshot()
    with guarded_csv_write():
        service=drive_service()
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        _assert_react_owned_trip(trip_id,service,mapping)
        fid,path,remote,local,columns,rows=_finance_remote('points',service,mapping)
        digest=hashlib.sha256(remote).hexdigest()
        if digest!=payload.expected_sha256 or hashlib.sha256(local).hexdigest()!=digest:
            raise HTTPException(409,'Маршрутът е променен от друг телефон. Обнови страницата.')
        indices=_route_stops(rows,trip_id)
        if payload.operation=='add':
            row={col:'' for col in columns}
            row.update(trip_id=trip_id,lat=str(payload.lat),lon=str(payload.lon),title='3b: '+title,
                       color='purple' if payload.stop_type=='planned' else 'orange',stop_type=payload.stop_type)
            if payload.position < 0 or payload.position >= len(indices):
                insert_at=(indices[-1]+1) if indices else len(rows)
            else: insert_at=indices[payload.position]
            rows.insert(insert_at,row)
        else:
            if payload.index<0 or payload.index>=len(indices): raise HTTPException(409,'Спирката вече не съществува.')
            idx=indices[payload.index]
            if payload.operation=='delete': rows.pop(idx)
            else:
                next_idx=payload.index+payload.position
                if payload.position not in (-1,1) or next_idx<0 or next_idx>=len(indices):
                    raise HTTPException(422,'Невъзможно преместване.')
                other=indices[next_idx]
                rows[idx],rows[other]=rows[other],rows[idx]
        output=io.StringIO(newline='')
        writer=csv.DictWriter(output,fieldnames=columns,extrasaction='ignore',lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated=output.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={'name':'P76_ROUTE_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['points']},fields='id').execute()
        except Exception: raise HTTPException(503,'Архивът не успя. Няма запис.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest()!=digest:
            raise HTTPException(409,'Google Drive се е променил. Няма запис.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            service.files().update(fileId=fid,media_body=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)).execute()
            verified=service.files().get_media(fileId=fid).execute()
            if verified!=updated: raise RuntimeError('Drive verification mismatch')
        except Exception: raise HTTPException(503,'Записът не е потвърден. Провери данните, преди да повториш.')
        temp=path.with_suffix('.p76_verified');temp.write_bytes(verified);os.replace(temp,path)
        return {'ok':True,'backup_id':backup['id']}


# P80: shared favourites, separate from the route stops of individual trips.
FAVORITES_TRIP_ID = '__PIXELAPP_SHARED_FAVORITES__'
FAVORITES_COLOR = 'blue'
FAVORITES_PREFIX = 'fav: '

class SafeFavoriteChange(BaseModel):
    operation: str
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    index: int = -1
    title: str = ''
    lat: float = 0
    lon: float = 0

def _favorite_indices(rows):
    return [i for i,r in enumerate(rows) if r.get('trip_id') == FAVORITES_TRIP_ID and
            str(r.get('title','')).startswith(FAVORITES_PREFIX) and r.get('color') == FAVORITES_COLOR]

@app.get('/safe/favorites', dependencies=[Depends(authorize)])
def safe_favorites():
    ensure_local_snapshot()
    with LOCK:
        service=drive_service()
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        _, mapping=folder_and_files(service)
        _,_,remote,local,_,rows=_finance_remote('points',service,mapping)
        indices=_favorite_indices(rows)
        return {'sha256':hashlib.sha256(remote).hexdigest(),
                'can_write':hashlib.sha256(local).hexdigest()==hashlib.sha256(remote).hexdigest(),
                'places':[{'index':n,'title':rows[i]['title'][len(FAVORITES_PREFIX):],
                           'lat':rows[i]['lat'],'lon':rows[i]['lon']} for n,i in enumerate(indices)]}

@app.post('/safe/favorites/{trip_id}', dependencies=[Depends(authorize)])
def safe_favorites_change(trip_id:str,payload:SafeFavoriteChange):
    if payload.operation not in ('add','edit','delete'):
        raise HTTPException(422,'Неподдържано действие.')
    name=payload.title.strip()
    if payload.operation in ('add','edit'):
        if not name or len(name)>150 or not all(map(math.isfinite,(payload.lat,payload.lon))) or abs(payload.lat)>90 or abs(payload.lon)>180:
            raise HTTPException(422,'Въведи валидно име и координати.')
    ensure_local_snapshot()
    with guarded_csv_write():
        service=drive_service()
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        _assert_react_owned_trip(trip_id,service,mapping)
        fid,path,remote,local,columns,rows=_finance_remote('points',service,mapping)
        digest=hashlib.sha256(remote).hexdigest()
        if digest!=payload.expected_sha256 or hashlib.sha256(local).hexdigest()!=digest:
            raise HTTPException(409,'Местата са променени от друг телефон. Обнови страницата.')
        indices=_favorite_indices(rows)
        if payload.operation=='add':
            if any(rows[i]['title'][len(FAVORITES_PREFIX):].casefold()==name.casefold() and abs(float(rows[i]['lat'])-payload.lat)<0.00001 and abs(float(rows[i]['lon'])-payload.lon)<0.00001 for i in indices):
                raise HTTPException(409,'Това любимо място вече съществува.')
            new={c:'' for c in columns}
            new.update(trip_id=FAVORITES_TRIP_ID,lat=str(payload.lat),lon=str(payload.lon),title=FAVORITES_PREFIX+name,color=FAVORITES_COLOR,stop_type='favorite')
            rows.append(new)
        else:
            if payload.index<0 or payload.index>=len(indices):raise HTTPException(409,'Мястото е променено. Обнови страницата.')
            i=indices[payload.index]
            if payload.operation=='delete':rows.pop(i)
            else:rows[i].update(title=FAVORITES_PREFIX+name,lat=str(payload.lat),lon=str(payload.lon))
        output=io.StringIO(newline='')
        writer=csv.DictWriter(output,fieldnames=columns,extrasaction='ignore',lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated=output.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={'name':'P80_FAVORITES_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['points']},fields='id').execute()
        except Exception:raise HTTPException(503,'Архивът не успя. Няма запис.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest()!=digest:
            raise HTTPException(409,'Данните се промениха. Няма запис.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            service.files().update(fileId=fid,media_body=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)).execute()
            verified=service.files().get_media(fileId=fid).execute()
            if verified!=updated:raise RuntimeError('Drive verification mismatch')
        except Exception:raise HTTPException(503,'Записът не е потвърден. Провери преди повторение.')
        temp=path.with_suffix('.p80_verified');temp.write_bytes(verified);os.replace(temp,path)
        return {'ok':True,'backup_id':backup['id']}


# P86: per-trip places. Historical rows remain unchanged and visible on their own trip.
def _trip_place_indices(rows, trip_id):
    return [i for i, row in enumerate(rows) if row.get('trip_id') == trip_id
            and not (str(row.get('title','')).startswith('3b:') and row.get('color') in ('purple','orange'))]

@app.get('/safe/trip-places/{trip_id}', dependencies=[Depends(authorize)])
def trip_places_read(trip_id: str):
    ensure_local_snapshot()
    with LOCK:
        service=drive_service()
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        _,_,remote,local,_,rows=_finance_remote('points',service,mapping)
        return {'sha256':hashlib.sha256(remote).hexdigest(), 'can_write':hashlib.sha256(local).digest()==hashlib.sha256(remote).digest(), 'places':[{'index':n,'title':str(rows[i].get('title') or 'Място'),
                           'lat':rows[i].get('lat'),'lon':rows[i].get('lon')}
                          for n,i in enumerate(_trip_place_indices(rows,trip_id))]}

@app.post('/safe/trip-places/{trip_id}', dependencies=[Depends(authorize)])
def trip_places_change(trip_id: str, payload:SafeFavoriteChange):
    if payload.operation not in ('add','edit','delete'):
        raise HTTPException(422,'Неподдържано действие.')
    name=payload.title.strip()
    if payload.operation!='delete' and (not name or len(name)>150 or not all(map(math.isfinite,(payload.lat,payload.lon))) or abs(payload.lat)>90 or abs(payload.lon)>180):
        raise HTTPException(422,'Невалидно име или координати.')
    ensure_local_snapshot()
    with guarded_csv_write():
        service=drive_service()
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        _assert_react_owned_trip(trip_id,service,mapping)
        fid,path,remote,local,columns,rows=_finance_remote('points',service,mapping)
        digest=hashlib.sha256(remote).hexdigest()
        if digest!=payload.expected_sha256 or hashlib.sha256(local).hexdigest()!=digest:
            raise HTTPException(409,'Местата са променени от друго устройство. Обнови страницата.')
        indices=_trip_place_indices(rows,trip_id)
        if payload.operation=='add':
            if any(str(rows[i].get('title','')).casefold()==name.casefold() and abs(float(rows[i]['lat'])-payload.lat)<0.00001 and abs(float(rows[i]['lon'])-payload.lon)<0.00001 for i in indices):
                raise HTTPException(409,'Мястото вече съществува в това пътуване.')
            row={c:'' for c in columns}
            row.update(trip_id=trip_id,title=name,lat=str(payload.lat),lon=str(payload.lon),color='blue',stop_type='favorite')
            rows.append(row)
        else:
            if payload.index<0 or payload.index>=len(indices):
                raise HTTPException(409,'Мястото е променено. Обнови страницата.')
            i=indices[payload.index]
            if payload.operation=='delete': rows.pop(i)
            else: rows[i].update(title=name,lat=str(payload.lat),lon=str(payload.lon))
        output=io.StringIO(newline='')
        writer=csv.DictWriter(output,fieldnames=columns,extrasaction='ignore',lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated=output.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={'name':'P86_TRIP_PLACES_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['points']},fields='id').execute()
        except Exception: raise HTTPException(503,'Неуспешен архив. Записът е отказан.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest()!=digest:
            raise HTTPException(409,'Данните се промениха. Записът е отказан.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            service.files().update(fileId=fid,media_body=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)).execute()
            verified=service.files().get_media(fileId=fid).execute()
            if verified!=updated:raise RuntimeError('Drive verification mismatch')
        except Exception: raise HTTPException(503,'Записът не е потвърден. Провери Drive, преди да повториш.')
        temp=path.with_suffix('.p86_verified');temp.write_bytes(verified);os.replace(temp,path)
        return {'ok':True,'backup_id':backup['id']}

# P85: narrow, conflict-checked editing of non-identity trip settings.
class SafeBasicSettings(BaseModel):
    start_date: str
    end_date: str
    track_fuel: str
    expected_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')


def _validate_basic_dates(start, end):
    from datetime import datetime as dt
    for date in (start,end):
        try:
            if dt.strptime(date,'%d.%m.%Y').strftime('%d.%m.%Y') != date:
                raise ValueError()
        except ValueError:
            raise HTTPException(422, 'Въведи валидни дати.')
    if dt.strptime(end,'%d.%m.%Y') < dt.strptime(start,'%d.%m.%Y'):
        raise HTTPException(422, 'Крайната дата е преди началната.')


@app.get('/safe/basic-preflight/{trip_id}',dependencies=[Depends(authorize)])
def safe_basic_preflight(trip_id: str):
    ensure_local_snapshot()
    with LOCK:
        service=drive_service()
        if service is None: raise HTTPException(503,'Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        fid,path,remote,local,cols,rows,item=_finish_snapshot(trip_id,service,mapping)
        if trip_id not in _react_owned_ids(service,mapping):
            raise HTTPException(403,'Старите пътувания са само за четене.')
        finished=str(item.get('trip_finished','')).casefold()=='да' or Decimal(str(item.get('end_km') or '0'))>0
        digest=hashlib.sha256(remote).hexdigest()
        return {'can_write':not finished and hashlib.sha256(local).hexdigest()==digest,
                'sha256':digest,'drive_matches_local':hashlib.sha256(local).hexdigest()==digest,
                'start_date':item.get('start_date',''),'end_date':item.get('end_date',''),
                'track_fuel':item.get('track_fuel','')}


@app.post('/safe/basic/{trip_id}',dependencies=[Depends(authorize)])
def safe_basic_save(trip_id:str,payload:SafeBasicSettings):
    if payload.track_fuel not in ('Да','Не','Добави впоследствие'):
        raise HTTPException(422,'Невалидна настройка за горивото.')
    _validate_basic_dates(payload.start_date,payload.end_date)
    ensure_local_snapshot()
    with guarded_csv_write():
        service=drive_service()
        if service is None: raise HTTPException(503,'Drive не е достъпен.')
        _,mapping=folder_and_files(service)
        fid,path,remote,local,cols,rows,item=_finish_snapshot(trip_id,service,mapping)
        if trip_id not in _react_owned_ids(service,mapping):
            raise HTTPException(403,'Старите пътувания са само за четене.')
        if str(item.get('trip_finished','')).casefold()=='да' or Decimal(str(item.get('end_km') or '0'))>0:
            raise HTTPException(423,'Приключено пътуване не се редактира.')
        digest=hashlib.sha256(remote).hexdigest()
        if digest!=payload.expected_sha256 or hashlib.sha256(local).hexdigest()!=digest:
            raise HTTPException(409,'Данните са променени. Обнови пътуването.')
        item['start_date']=payload.start_date
        item['end_date']=payload.end_date
        item['track_fuel']=payload.track_fuel
        out=io.StringIO(newline='')
        writer=csv.DictWriter(out,fieldnames=cols,extrasaction='ignore',lineterminator='\n')
        writer.writeheader();writer.writerows(rows)
        updated=out.getvalue().encode('utf-8')
        try:
            backup=service.files().copy(fileId=fid,body={'name':'P85_BASIC_BACKUP_'+uuid.uuid4().hex+'_'+FILENAMES['settings']},fields='id').execute()
        except Exception: raise HTTPException(503,'Архивът не успя. Няма запис.')
        if hashlib.sha256(service.files().get_media(fileId=fid).execute()).hexdigest()!=digest:
            raise HTTPException(409,'Drive се промени преди записа. Няма запис.')
        try:
            from googleapiclient.http import MediaIoBaseUpload
            service.files().update(fileId=fid,media_body=MediaIoBaseUpload(io.BytesIO(updated),mimetype='text/csv',resumable=False)).execute()
            verified=service.files().get_media(fileId=fid).execute()
            if verified!=updated: raise RuntimeError('Verification mismatch')
        except Exception:
            raise HTTPException(503,'Неуспешна проверка след запис. Провери преди повторен опит.')
        tmp=path.with_suffix('.p85_verified');tmp.write_bytes(verified);os.replace(tmp,path)
        return {'ok':True,'backup_id':backup['id']}


# P91: Travel photo gallery. Files live separately from all legacy CSVs.
# List is read-only; upload creates only a photo and folders, deletion moves a photo to trash.
_GALLERY_ROOT = 'PixelApp_Gallery'
_GALLERY_LIMIT = 8 * 1024 * 1024
_GALLERY_MIMES = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp'}

def _gallery_folder(service, trip_id, create=False):
    if not trip_id or len(trip_id) > 240: raise HTTPException(422, 'Невалидно пътуване.')
    root, _ = folder_and_files(service)
    def child(parent, name):
        q = "'%s' in parents and name = '%s' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" % (parent, name)
        found = service.files().list(q=q, fields='files(id)', pageSize=20).execute().get('files', [])
        if found: return found[0]['id']
        if not create: return None
        return service.files().create(body={'name': name, 'mimeType':'application/vnd.google-apps.folder',
            'parents':[parent]}, fields='id').execute()['id']
    gallery = child(root, _GALLERY_ROOT)
    if not gallery: return None
    return child(gallery, hashlib.sha256(trip_id.encode('utf-8')).hexdigest()[:40])

# P91.1: Streamlit stored photos in a separate top-level Photos/trip_<id> folder.
# Also support the older flat Photos/<id>__gallery__*.jpg layout; never migrate/delete on read.
def _legacy_gallery_locations(service, trip_id):
    if not trip_id or len(trip_id) > 240:
        raise HTTPException(422, 'Невалидно пътуване.')
    safe = re.sub(r"[^\w.-]+", "_", str(trip_id).strip(), flags=re.UNICODE)
    q = "name = 'Photos' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    roots = service.files().list(q=q, fields='nextPageToken,files(id)', pageSize=1000).execute().get('files', [])
    folders = []
    for root in roots:
        child_name = 'trip_' + safe
        child_q = "'%s' in parents and name = '%s' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" % (root['id'], child_name.replace("'", "\\'"))
        children = service.files().list(q=child_q, fields='files(id)', pageSize=100).execute().get('files', [])
        folders.extend(x['id'] for x in children)
    return folders, [x['id'] for x in roots], safe + '__gallery__'


def _legacy_gallery_items(service, trip_id):
    folders, roots, prefix = _legacy_gallery_locations(service, trip_id)
    found = []
    for folder in folders:
        found.extend(x for x in _gallery_items(service, folder)
                     if x.get('name','').startswith(prefix))
    # Some early Streamlit versions kept photos directly in the Photos folder.
    for root in roots:
        found.extend(x for x in _gallery_items(service, root)
                     if x.get('name','').startswith(prefix))
    return found

def _gallery_items(service, folder):
    if not folder: return []
    items, token = [], None
    while True:
        result = service.files().list(q="'%s' in parents and trashed = false" % folder,
            fields='nextPageToken,files(id,name,mimeType,size,createdTime)', pageSize=1000,
            pageToken=token).execute()
        items += [x for x in result.get('files',[]) if x.get('mimeType') in _GALLERY_MIMES]
        token = result.get('nextPageToken')
        if not token: break
    return sorted(items,key=lambda x:x.get('createdTime',''),reverse=True)

@app.get('/gallery/{trip_id}', dependencies=[Depends(authorize)])
def gallery_list(trip_id: str):
    try:
        service = drive_service()
        if service is None: raise HTTPException(503, 'Google Drive не е достъпен.')
        folder = _gallery_folder(service, trip_id)
        photos = _gallery_items(service, folder) + _legacy_gallery_items(service, trip_id)
        unique = {photo['id']: photo for photo in photos}
        return {'photos': sorted(unique.values(), key=lambda x: x.get('createdTime',''), reverse=True)}
    except HTTPException: raise
    except Exception as exc: raise HTTPException(503, 'Не мога да прочета галерията.') from exc

@app.post('/gallery/{trip_id}', dependencies=[Depends(authorize)])
async def gallery_upload(trip_id: str, request: Request, filename: str = 'Снимка'):
    mime = request.headers.get('content-type','').split(';')[0].lower().strip()
    if mime not in _GALLERY_MIMES: raise HTTPException(415, 'Поддържат се JPEG, PNG и WebP.')
    if request.headers.get('content-length') and int(request.headers['content-length']) > _GALLERY_LIMIT:
        raise HTTPException(413, 'Максималният размер е 8 MB.')
    raw = await request.body()
    if not raw or len(raw)>_GALLERY_LIMIT: raise HTTPException(413,'Снимката е празна или над 8 MB.')
    if not ((mime=='image/jpeg' and raw.startswith(b'\xff\xd8\xff')) or
            (mime=='image/png' and raw.startswith(b'\x89PNG\r\n\x1a\n')) or
            (mime=='image/webp' and raw[:4]==b'RIFF' and raw[8:12]==b'WEBP')):
        raise HTTPException(415,'Файлът не е валидна снимка.')
    try:
        service=drive_service()
        if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
        folder=_gallery_folder(service,trip_id,create=True)
        if len(_gallery_items(service,folder))>=300:raise HTTPException(409,'Достигнат е лимитът от 300 снимки.')
        from googleapiclient.http import MediaIoBaseUpload
        safe_name = Path(filename).stem.strip()[:90] or 'Снимка'
        safe_name = re.sub(r'[\x00-\x1f/\\]', '_', safe_name)
        uploaded=service.files().create(body={'name':safe_name+'_'+uuid.uuid4().hex[:8]+_GALLERY_MIMES[mime],
          'parents':[folder]},media_body=MediaIoBaseUpload(io.BytesIO(raw),mimetype=mime,resumable=False),fields='id,name,mimeType').execute()
        return {'ok':True,'photo':uploaded}
    except HTTPException:raise
    except Exception as exc:raise HTTPException(503,'Неуспешен запис на снимката в Google Drive.') from exc

def _gallery_check_photo(service, trip_id, photo_id):
    if not re.fullmatch(r'[a-zA-Z0-9_-]{8,160}', photo_id):raise HTTPException(404,'Няма такава снимка.')
    folder = _gallery_folder(service, trip_id)
    file=service.files().get(fileId=photo_id,fields='id,name,mimeType,parents,trashed').execute()
    legacy_folders, legacy_roots, prefix = _legacy_gallery_locations(service, trip_id)
    parents = file.get('parents', [])
    in_new = bool(folder and folder in parents)
    in_legacy = (any(parent in parents for parent in legacy_folders + legacy_roots)
                 and file.get('name','').startswith(prefix))
    if file.get('trashed') or not (in_new or in_legacy) or file.get('mimeType') not in _GALLERY_MIMES:
        raise HTTPException(404,'Снимката не принадлежи на това пътуване.')
    return file

@app.get('/gallery/{trip_id}/{photo_id}',dependencies=[Depends(authorize)])
def gallery_photo(trip_id:str,photo_id:str):
    try:
        service=drive_service()
        if service is None:raise HTTPException(503,'Google Drive не е достъпен.')
        info=_gallery_check_photo(service,trip_id,photo_id)
        raw=service.files().get_media(fileId=photo_id).execute()
        return Response(content=raw,media_type=info['mimeType'],headers={'Cache-Control':'private, max-age=120'})
    except HTTPException:raise
    except Exception as exc:raise HTTPException(503,'Неуспешно зареждане на снимката.') from exc

@app.delete('/gallery/{trip_id}/{photo_id}',dependencies=[Depends(authorize)])
def gallery_delete(trip_id:str,photo_id:str):
    try:
        service=drive_service()
        if service is None:raise HTTPException(503,'Google Drive не е достъпен.')
        _gallery_check_photo(service,trip_id,photo_id)
        # Recoverable: move to Drive trash, never permanently delete.
        service.files().update(fileId=photo_id,body={'trashed':True},fields='id,trashed').execute()
        return {'ok':True}
    except HTTPException:raise
    except Exception as exc:raise HTTPException(503,'Неуспешно изтриване на снимката.') from exc


# P91.9 — isolated PostgreSQL latency benchmark.
# No Google Drive access, no trip reads/writes, no persistent database tables.
# The DB URL is read only from the Render environment; never returned to clients.
@app.post('/safe/neon-benchmark', dependencies=[Depends(authorize)])
def neon_benchmark():
    import time as _time
    url = os.getenv('DATABASE_URL', '').strip()
    if not url:
        raise HTTPException(503, 'Neon test is not configured: set DATABASE_URL on Render.')
    try:
        import psycopg
    except ImportError as exc:
        raise HTTPException(503, 'PostgreSQL driver is not installed.') from exc
    start = _time.perf_counter()
    stages = {}
    try:
        # connect_timeout caps initial network connection. Neon connection string
        # should use sslmode=require or stronger, as supplied by Neon.
        with psycopg.connect(url, connect_timeout=10) as conn:
            stages['connect_ms'] = round((_time.perf_counter() - start) * 1000)
            t = _time.perf_counter()
            with conn.cursor() as cur:
                # TEMP table belongs to this session and drops at commit.
                # No application schemas/data are read or changed.
                cur.execute('CREATE TEMP TABLE pixelapp_latency_check (id integer PRIMARY KEY, done boolean NOT NULL) ON COMMIT DROP')
                stages['create_temp_ms'] = round((_time.perf_counter() - t) * 1000)
                t = _time.perf_counter()
                cur.execute('INSERT INTO pixelapp_latency_check(id, done) VALUES (1, false)')
                stages['insert_ms'] = round((_time.perf_counter() - t) * 1000)
                t = _time.perf_counter()
                cur.execute('UPDATE pixelapp_latency_check SET done = true WHERE id = 1')
                stages['update_ms'] = round((_time.perf_counter() - t) * 1000)
                t = _time.perf_counter()
                cur.execute('SELECT done FROM pixelapp_latency_check WHERE id = 1')
                if cur.fetchone() != (True,):
                    raise RuntimeError('Neon benchmark verification failed')
                stages['verify_ms'] = round((_time.perf_counter() - t) * 1000)
            t = _time.perf_counter()
            conn.commit()
            stages['commit_ms'] = round((_time.perf_counter() - t) * 1000)
    except Exception as exc:
        # Do not send connection strings, SQL, database hostnames or credentials
        # in the error message or logs exposed by this endpoint.
        raise HTTPException(503, 'Neon speed test failed. Check the Render DATABASE_URL and Neon project status.') from None
    stages['total_ms'] = round((_time.perf_counter() - start) * 1000)
    return {'ok': True, 'benchmark': 'isolated_temp_table', 'times_ms': stages,
            'drive_touched': False, 'trip_data_touched': False}


# P91.9.1 — shared, isolated PostgreSQL test task.
# Does not read or write the application trips, CSVs or Google Drive.
class NeonDemoToggle(BaseModel):
    expected_version: int = Field(ge=0)


def _neon_demo_connection():
    url = os.getenv('DATABASE_URL', '').strip()
    if not url:
        raise HTTPException(503, 'Neon is not configured on Render.')
    try:
        import psycopg
        return psycopg.connect(url, connect_timeout=10)
    except Exception:
        raise HTTPException(503, 'Could not connect to test database.') from None


def _neon_demo_initialize(cur):
    # One shared row for both authenticated accounts; never contains trip data.
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_neon_demo_task_9191 (
        id integer PRIMARY KEY CHECK (id = 1),
        title text NOT NULL,
        done boolean NOT NULL DEFAULT false,
        version integer NOT NULL DEFAULT 0
    )""")
    cur.execute("""INSERT INTO pixelapp_neon_demo_task_9191 (id,title,done,version)
        VALUES (1, 'Тестова задача в Neon (без връзка с пътувания)', false, 0)
        ON CONFLICT (id) DO NOTHING""")


@app.get('/safe/neon-shared-task', dependencies=[Depends(authorize)])
def neon_shared_task_read():
    import time as _time
    start = _time.perf_counter()
    try:
        with _neon_demo_connection() as conn:
            with conn.cursor() as cur:
                _neon_demo_initialize(cur)
                cur.execute('SELECT title,done,version FROM pixelapp_neon_demo_task_9191 WHERE id=1')
                title, done, version = cur.fetchone()
            conn.commit()
        return {'title':title,'done':done,'version':version,
                'total_ms':round((_time.perf_counter()-start)*1000)}
    except HTTPException:raise
    except Exception:
        raise HTTPException(503, 'Test task read failed.') from None


@app.post('/safe/neon-conflict-selftest', dependencies=[Depends(authorize)])
def neon_conflict_selftest():
    """Validate optimistic CAS under one rolled-back transaction, without persisting test toggles."""
    import time as _time
    start = _time.perf_counter()
    try:
        with _neon_demo_connection() as conn:
            with conn.cursor() as cur:
                _neon_demo_initialize(cur)
            conn.commit()  # only the initial demo row is committed if not already present
            with conn.cursor() as cur:
                cur.execute('SELECT version, done FROM pixelapp_neon_demo_task_9191 WHERE id=1 FOR UPDATE')
                starting_version, starting_done = cur.fetchone()
                cur.execute("""UPDATE pixelapp_neon_demo_task_9191
                    SET done=NOT done, version=version+1 WHERE id=1 AND version=%s
                    RETURNING version""", (starting_version,))
                first = cur.fetchone()
                cur.execute("""UPDATE pixelapp_neon_demo_task_9191
                    SET done=NOT done, version=version+1 WHERE id=1 AND version=%s
                    RETURNING version""", (starting_version,))
                second = cur.fetchone()
            conn.rollback()  # do not persist either toggle
        return {'passed': bool(first and first[0] == starting_version+1 and second is None),
                'first_accepted': first is not None,
                'stale_update_rejected': second is None,
                'unchanged_version': starting_version,
                'unchanged_done': starting_done,
                'total_ms': round((_time.perf_counter()-start)*1000),
                'note': 'Both simulated updates were rolled back; no persistent task change.'}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'Neon concurrency check failed.') from None


@app.post('/safe/neon-shared-task/toggle', dependencies=[Depends(authorize)])
def neon_shared_task_toggle(data: NeonDemoToggle):
    import time as _time
    start = _time.perf_counter()
    try:
        with _neon_demo_connection() as conn:
            with conn.cursor() as cur:
                _neon_demo_initialize(cur)
                cur.execute("""UPDATE pixelapp_neon_demo_task_9191
                  SET done = NOT done, version = version + 1
                  WHERE id = 1 AND version = %s
                  RETURNING title,done,version""", (data.expected_version,))
                row = cur.fetchone()
                if row is None:
                    conn.rollback()
                    raise HTTPException(409, 'Задачата е променена от другия профил. Натисни „Прочети задача“.')
            conn.commit()
        return {'title':row[0], 'done':row[1], 'version':row[2],
                'total_ms':round((_time.perf_counter()-start)*1000)}
    except HTTPException:raise
    except Exception:
        raise HTTPException(503, 'Test task update failed.') from None


# P91.9.3 — read-only Drive task snapshot into an isolated Neon staging table.
# Never alters Drive, operational task endpoints, or any actual trip.
@app.post('/safe/neon-tasks-snapshot', dependencies=[Depends(authorize)])
def neon_tasks_snapshot():
    import time as _time
    started = _time.perf_counter()
    service = drive_service()
    if service is None:
        raise HTTPException(503, 'Google Drive не е конфигуриран.')
    try:
        _, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['tasks'])
        if not fid:
            raise HTTPException(409, 'Файлът със задачи не е намерен в Google Drive.')
        original = service.files().get_media(fileId=fid).execute()
        reader = csv.DictReader(io.StringIO(original.decode('utf-8-sig')))
        cols = reader.fieldnames
        if not cols or any(c not in cols for c in COLUMNS['tasks']):
            raise HTTPException(422, 'Непознат формат на задачите. Няма копиране.')
        source_rows = list(reader)
        if any(None in row or any(row.get(k) is None for k in cols) for row in source_rows):
            raise HTTPException(422, 'Невалидни CSV редове. Няма копиране.')
        keys = [(r['trip_id'], r['item_id']) for r in source_rows]
        if any(not a or not c for a,c in keys) or len(set(keys)) != len(keys):
            raise HTTPException(409, 'Липсващ или повтарящ се идентификатор на задача. Няма копиране.')
        def fingerprint(rows):
            canonical = sorted(json.dumps(r, ensure_ascii=False, sort_keys=True, separators=(',',':')) for r in rows)
            return hashlib.sha256(json.dumps(canonical, ensure_ascii=False, separators=(',',':')).encode('utf-8')).hexdigest()
        source_fingerprint = fingerprint(source_rows)
        # Recheck the source just before writing the staging snapshot.
        if service.files().get_media(fileId=fid).execute() != original:
            raise HTTPException(409, 'Drive се промени по време на проверката. Опитай отново.')
        with _neon_demo_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_neon_tasks_stage_9193 (
                    trip_id text NOT NULL,
                    item_id text NOT NULL,
                    row_json jsonb NOT NULL,
                    PRIMARY KEY (trip_id, item_id)
                )""")
                # Replace only the isolated staging table, transactionally.
                cur.execute('DELETE FROM pixelapp_neon_tasks_stage_9193')
                from psycopg.types.json import Jsonb
                cur.executemany("""INSERT INTO pixelapp_neon_tasks_stage_9193
                    (trip_id, item_id, row_json) VALUES (%s, %s, %s)""",
                    [(r['trip_id'], r['item_id'], Jsonb(r)) for r in source_rows])
                cur.execute('SELECT row_json FROM pixelapp_neon_tasks_stage_9193')
                verified = [r[0] for r in cur.fetchall()]
                if len(verified) != len(source_rows) or fingerprint(verified) != source_fingerprint:
                    raise RuntimeError('Neon staging verification mismatch')
            conn.commit()
        by_trip={}
        for r in source_rows:
            key=r['trip_id']
            by_trip[key]=by_trip.get(key,0)+1
        return {'ok':True,'tasks':len(source_rows),'trips':len(by_trip),
                'matching':True,'source_sha256':hashlib.sha256(original).hexdigest(),
                'content_sha256':source_fingerprint,
                'total_ms':round((_time.perf_counter()-started)*1000),
                'read_only_source':True,'staging_only':True}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'Копирането или проверката в Neon не успя. Данните в Drive не са променени.') from None


# P91.9.4: isolated Neon write workbench. Strictly no Drive writes.
class NeonSandboxAction(BaseModel):
    trip_id: str
    operation: str
    item_id: str = ''
    title: str = ''
    expected_version: int | None = None


def _neon_sandbox_table(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_neon_task_sandbox_9194 (
        trip_id text NOT NULL, item_id text NOT NULL, title text NOT NULL,
        done boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0,
        PRIMARY KEY (trip_id,item_id))""")


def _assert_test_trip(trip_id):
    if not trip_id or len(trip_id)>180 or not any(t in trip_id.casefold() for t in ('тест','test')):
        raise HTTPException(403,'Тестът е разрешен само за пътуване с ТЕСТ/TEST в името.')


@app.get('/safe/neon-task-sandbox/trips', dependencies=[Depends(authorize)])
def neon_sandbox_trips():
    from time import perf_counter
    start=perf_counter()
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT DISTINCT trip_id FROM pixelapp_neon_tasks_stage_9193 ORDER BY trip_id')
            names=[row[0] for row in cur.fetchall()]
    return {'trips':[name for name in names if 'тест' in name.casefold() or 'test' in name.casefold()],
            'elapsed_ms':round((perf_counter()-start)*1000)}


@app.get('/safe/neon-task-sandbox/{trip_id}', dependencies=[Depends(authorize)])
def neon_sandbox_read(trip_id: str):
    from time import perf_counter
    _assert_test_trip(trip_id)
    start=perf_counter()
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _neon_sandbox_table(cur)
            cur.execute('SELECT item_id,title,done,version FROM pixelapp_neon_task_sandbox_9194 WHERE trip_id=%s ORDER BY item_id',(trip_id,))
            rows=[{'item_id':a,'title':b,'done':c,'version':d} for a,b,c,d in cur.fetchall()]
        conn.commit()
    return {'tasks':rows,'elapsed_ms':round((perf_counter()-start)*1000),'sandbox':True}


@app.post('/safe/neon-task-sandbox', dependencies=[Depends(authorize)])
def neon_sandbox_action(payload: NeonSandboxAction):
    from time import perf_counter
    _assert_test_trip(payload.trip_id)
    if payload.operation not in ('add','toggle','edit','delete'):
        raise HTTPException(422,'Неподдържано действие.')
    title=payload.title.strip()
    if payload.operation in ('add','edit') and not (1<=len(title)<=200):
        raise HTTPException(422,'Заглавието трябва да е 1–200 символа.')
    if payload.operation!='add' and (not payload.item_id or payload.expected_version is None or payload.expected_version<0):
        raise HTTPException(422,'Липсва идентификатор или версия.')
    start=perf_counter()
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _neon_sandbox_table(cur)
            if payload.operation=='add':
                new_id='sb_'+uuid.uuid4().hex
                cur.execute('INSERT INTO pixelapp_neon_task_sandbox_9194(trip_id,item_id,title) VALUES (%s,%s,%s)',(payload.trip_id,new_id,title))
                result={'item_id':new_id,'title':title,'done':False,'version':0}
            else:
                # Compare-and-swap is atomic, including deletes.
                if payload.operation=='toggle':
                    cur.execute('UPDATE pixelapp_neon_task_sandbox_9194 SET done=NOT done,version=version+1 WHERE trip_id=%s AND item_id=%s AND version=%s RETURNING item_id,title,done,version',
                                (payload.trip_id,payload.item_id,payload.expected_version))
                elif payload.operation=='edit':
                    cur.execute('UPDATE pixelapp_neon_task_sandbox_9194 SET title=%s,version=version+1 WHERE trip_id=%s AND item_id=%s AND version=%s RETURNING item_id,title,done,version',
                                (title,payload.trip_id,payload.item_id,payload.expected_version))
                else:
                    cur.execute('DELETE FROM pixelapp_neon_task_sandbox_9194 WHERE trip_id=%s AND item_id=%s AND version=%s RETURNING item_id,title,done,version',
                                (payload.trip_id,payload.item_id,payload.expected_version))
                record=cur.fetchone()
                if record is None:
                    raise HTTPException(409,'Задачата е променена или изтрита от друг профил. Натисни Прочети.')
                result={'item_id':record[0],'title':record[1],'done':record[2],'version':record[3]}
        conn.commit()
    return {'ok':True,'task':result,'elapsed_ms':round((perf_counter()-start)*1000),'drive_unchanged':True}


# P91.9.8 — one test trip, verified non-destructive Drive -> Neon sandbox copy.
# The source is fetched live (not the possibly stale stage from P91.9.3).
@app.post('/safe/neon-task-sandbox/import/{trip_id}', dependencies=[Depends(authorize)])
def neon_import_one_test_trip(trip_id: str):
    from time import perf_counter
    from psycopg.types.json import Jsonb
    start = perf_counter()
    _assert_test_trip(trip_id)
    service = drive_service()
    if service is None:
        raise HTTPException(503, 'Google Drive не е достъпен. Няма импортиране.')
    try:
        _, mapping = folder_and_files(service)
        fid = mapping.get(FILENAMES['tasks'])
        if not fid:
            raise HTTPException(409, 'Няма файл със задачи в Drive.')
        raw = service.files().get_media(fileId=fid).execute()
        reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
        if not reader.fieldnames or any(c not in reader.fieldnames for c in COLUMNS['tasks']):
            raise HTTPException(422, 'Непознат формат на задачите.')
        all_rows = list(reader)
        if any(None in row or any(row.get(k) is None for k in reader.fieldnames) for row in all_rows):
            raise HTTPException(422, 'Невалидни редове в Drive. Няма импортиране.')
        selected = [r for r in all_rows if r['trip_id'] == trip_id]
        ids = [r['item_id'] for r in selected]
        if not all(ids) or len(set(ids)) != len(ids):
            raise HTTPException(409, 'Дублирани идентификатори в Drive. Няма импортиране.')
        def source_done(v):
            s=str(v).strip().lower()
            if s in ('true','1','yes','да'): return True
            if s in ('false','0','no','не',''): return False
            raise HTTPException(422, 'Непозната стойност на отметка. Няма импортиране.')
        records = [(r['item_id'],r['title'],source_done(r['done'])) for r in selected]
        if any(not title or len(title)>200 for _,title,_ in records):
            raise HTTPException(422, 'Невалидно заглавие на задача. Няма импортиране.')
        # Check that Drive has not changed during preparation.
        if service.files().get_media(fileId=fid).execute() != raw:
            raise HTTPException(409, 'Drive е променен по време на четенето. Няма импортиране.')
        with _neon_demo_connection() as conn:
            with conn.cursor() as cur:
                _neon_sandbox_table(cur)
                # Do not overwrite previous sandbox entries, including previously imported ones.
                cur.execute('SELECT item_id FROM pixelapp_neon_task_sandbox_9194 WHERE trip_id=%s',(trip_id,))
                existing={r[0] for r in cur.fetchall()}
                if any(item_id in existing for item_id,_,_ in records):
                    raise HTTPException(409, 'Някои оригинални задачи вече са в Neon. Нищо не е променено.')
                for item_id,title,done in records:
                    cur.execute('INSERT INTO pixelapp_neon_task_sandbox_9194(trip_id,item_id,title,done,version) VALUES (%s,%s,%s,%s,0)',(trip_id,item_id,title,done))
                if ids:
                    cur.execute('SELECT item_id,title,done FROM pixelapp_neon_task_sandbox_9194 WHERE trip_id=%s AND item_id=ANY(%s)',(trip_id,ids))
                    after=cur.fetchall()
                else: after=[]
                if sorted(records) != sorted(after):
                    raise RuntimeError('Неуспешна проверка на копието; транзакцията се отменя.')
            conn.commit()
        return {'ok':True,'trip_id':trip_id,'imported':len(records),'checked':len(after),
                'drive_unchanged':True,'existing_sandbox_preserved':True,
                'elapsed_ms':round((perf_counter()-start)*1000)}
    except HTTPException: raise
    except Exception:
        raise HTTPException(503, 'Неуспешно импортиране или проверка. Няма потвърден резултат.') from None


# P91.9.6 — manual verified backup of isolated Neon TEST task tables only.
# Backups are append-only in a separate Drive subfolder; legacy CSVs untouched.
@app.post('/safe/neon-test-backup', dependencies=[Depends(authorize)])
def neon_test_backup():
    from time import perf_counter
    from datetime import datetime, timezone
    from googleapiclient.http import MediaIoBaseUpload
    start = perf_counter()
    service = drive_service()
    if service is None:
        raise HTTPException(503, 'Google Drive не е свързан.')
    try:
        with _neon_demo_connection() as conn:
            with conn.cursor() as cur:
                # One consistent database snapshot for both test tables.
                cur.execute('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                _neon_sandbox_table_exists = None
                cur.execute("SELECT to_regclass('public.pixelapp_neon_tasks_stage_9193')::text, to_regclass('public.pixelapp_neon_task_sandbox_9194')::text")
                stage_exists, sandbox_exists = cur.fetchone()
                staged, sandbox = [], []
                if stage_exists:
                    cur.execute('SELECT trip_id,item_id,row_json FROM pixelapp_neon_tasks_stage_9193 ORDER BY trip_id,item_id')
                    staged = [{'trip_id':a,'item_id':b,'data':c} for a,b,c in cur.fetchall()]
                if sandbox_exists:
                    cur.execute('SELECT trip_id,item_id,title,done,version FROM pixelapp_neon_task_sandbox_9194 ORDER BY trip_id,item_id')
                    sandbox = [{'trip_id':a,'item_id':b,'title':c,'done':d,'version':e} for a,b,c,d,e in cur.fetchall()]
            conn.rollback()
        document = {'format':'pixelapp-neon-test-backup','schema_version':1,
                    'created_utc':datetime.now(timezone.utc).isoformat(),
                    'tables':{'staged_drive_tasks_9193':staged,'sandbox_tasks_9194':sandbox},
                    'note':'TEST/staging only. Not a full PixelApp backup. No automatic restore.'}
        data=json.dumps(document,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')
        checksum=hashlib.sha256(data).hexdigest()
        root,_ = folder_and_files(service)
        name='PixelApp_Neon_Test_Backups'
        query="'%s' in parents and name = '%s' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" % (root,name)
        existing=service.files().list(q=query,fields='files(id)',pageSize=20).execute().get('files',[])
        folder=existing[0]['id'] if existing else service.files().create(
            body={'name':name,'mimeType':'application/vnd.google-apps.folder','parents':[root]},fields='id').execute()['id']
        timestamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S_%fZ')
        filename='neon_test_'+timestamp+'_'+checksum[:10]+'.json'
        uploaded=service.files().create(body={'name':filename,'parents':[folder],
             'description':'Verified test-only Neon snapshot; not full PixelApp backup'},
             media_body=MediaIoBaseUpload(io.BytesIO(data),mimetype='application/json',resumable=False),
             fields='id,name,size').execute()
        fid=uploaded['id']
        verified=service.files().get_media(fileId=fid).execute()
        if hashlib.sha256(verified).hexdigest()!=checksum or verified!=data:
            raise HTTPException(503, 'Архивът е качен, но проверката му не съвпада. Не го приемай за успешно копие.')
        return {'ok':True,'verified':True,'filename':filename,'sha256':checksum,
                'staged_tasks':len(staged),'sandbox_tasks':len(sandbox),
                'size_bytes':len(data),'elapsed_ms':round((perf_counter()-start)*1000),
                'scope':'neon-test-only'}
    except HTTPException: raise
    except Exception:
        raise HTTPException(503, 'Неуспешно резервно копие на тестовите Neon данни.') from None


# P91.9.10 — non-destructive restore rehearsal of last verified Neon test backup.
# Reads archive from Drive, checks integrity, loads into TEMP tables in a transaction,
# compares exact content and rolls back. No existing Neon/Drive rows are changed.
@app.post('/safe/neon-test-restore-drill', dependencies=[Depends(authorize)])
def neon_test_restore_drill():
    from time import perf_counter
    start=perf_counter()
    service=drive_service()
    if service is None:
        raise HTTPException(503, 'Google Drive не е свързан.')
    try:
        root,_=folder_and_files(service)
        q="'%s' in parents and name = 'PixelApp_Neon_Test_Backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" % root
        folders=service.files().list(q=q,fields='nextPageToken,files(id)',pageSize=100).execute().get('files',[])
        if len(folders)!=1:
            raise HTTPException(409, 'Липсва еднозначна папка с архиви. Няма възстановяване.')
        folder=folders[0]['id']
        q="'%s' in parents and name contains 'neon_test_' and trashed = false" % folder
        files=[]; token=None
        while True:
            resp=service.files().list(q=q,fields='nextPageToken,files(id,name,mimeType)',pageSize=1000,pageToken=token).execute()
            files.extend(x for x in resp.get('files',[]) if x.get('name','').startswith('neon_test_') and x.get('name','').endswith('.json') and x.get('mimeType')=='application/json')
            token=resp.get('nextPageToken')
            if not token: break
        if not files:
            raise HTTPException(404, 'Няма намерен тестов Neon архив.')
        latest=max(files,key=lambda x:x['name'])
        raw=service.files().get_media(fileId=latest['id']).execute()
        if not isinstance(raw,bytes) or len(raw)>10_000_000:
            raise HTTPException(422,'Невалиден или прекалено голям архив.')
        checksum=hashlib.sha256(raw).hexdigest()
        if not latest['name'].endswith('_'+checksum[:10]+'.json'):
            raise HTTPException(422,'Архивът не премина SHA-256 проверката.')
        doc=json.loads(raw.decode('utf-8'))
        if doc.get('format')!='pixelapp-neon-test-backup' or doc.get('schema_version')!=1:
            raise HTTPException(422,'Неподдържан формат на архив.')
        tables=doc.get('tables')
        if not isinstance(tables,dict) or set(tables)!={'staged_drive_tasks_9193','sandbox_tasks_9194'}:
            raise HTTPException(422,'Невалидни таблици в архива.')
        staged=tables['staged_drive_tasks_9193']; sandbox=tables['sandbox_tasks_9194']
        if not isinstance(staged,list) or not isinstance(sandbox,list) or len(staged)+len(sandbox)>20000:
            raise HTTPException(422,'Невалидни записи в архива.')
        for row in staged:
            if not isinstance(row,dict) or set(row)!={'trip_id','item_id','data'} or not isinstance(row['data'],(dict,list,str,int,float,bool,type(None))):
                raise HTTPException(422,'Невалиден копиран запис.')
            if any(not isinstance(row[k],str) or not row[k] for k in ('trip_id','item_id')):
                raise HTTPException(422,'Невалиден идентификатор.')
        for row in sandbox:
            if not isinstance(row,dict) or set(row)!={'trip_id','item_id','title','done','version'}:
                raise HTTPException(422,'Невалиден тестов запис.')
            if any(not isinstance(row[k],str) or not row[k] for k in ('trip_id','item_id')) or not isinstance(row['title'],str) or type(row['done']) is not bool or type(row['version']) is not int:
                raise HTTPException(422,'Невалидни стойности в тестов запис.')
        with _neon_demo_connection() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute('CREATE TEMP TABLE pixelapp_restore_stage (trip_id TEXT NOT NULL, item_id TEXT NOT NULL, data JSONB, PRIMARY KEY(trip_id,item_id)) ON COMMIT DROP')
                    cur.execute('CREATE TEMP TABLE pixelapp_restore_sandbox (trip_id TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL, done BOOLEAN NOT NULL, version INT NOT NULL, PRIMARY KEY(trip_id,item_id)) ON COMMIT DROP')
                    for r in staged:
                        cur.execute('INSERT INTO pixelapp_restore_stage VALUES (%s,%s,%s::jsonb)',(r['trip_id'],r['item_id'],json.dumps(r['data'],ensure_ascii=False)))
                    for r in sandbox:
                        cur.execute('INSERT INTO pixelapp_restore_sandbox VALUES (%s,%s,%s,%s,%s)',(r['trip_id'],r['item_id'],r['title'],r['done'],r['version']))
                    cur.execute('SELECT trip_id,item_id,data::text FROM pixelapp_restore_stage ORDER BY trip_id,item_id')
                    verified_stage=[{'trip_id':a,'item_id':b,'data':json.loads(c)} for a,b,c in cur.fetchall()]
                    cur.execute('SELECT trip_id,item_id,title,done,version FROM pixelapp_restore_sandbox ORDER BY trip_id,item_id')
                    verified_sandbox=[dict(zip(('trip_id','item_id','title','done','version'),r)) for r in cur.fetchall()]
                    canonical=lambda x:json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'))
                    if canonical(verified_stage)!=canonical(staged) or canonical(verified_sandbox)!=canonical(sandbox):
                        raise HTTPException(409,'Пробното възстановяване не съвпада с архива.')
            finally:
                conn.rollback()
        return {'ok':True,'archive':latest['name'],'staged_tasks':len(staged),'sandbox_tasks':len(sandbox),
                'elapsed_ms':round((perf_counter()-start)*1000),'no_changes':True,
                'scope':'test-only','mode':'temporary-table-rollback'}
    except HTTPException: raise
    except Exception:
        raise HTTPException(503, 'Неуспешна проба за възстановяване. Работните данни не са променени.') from None


# P91.9.12 — shared, test-only task source preference for both accounts.
# No actual Drive/Neon task content is migrated or overwritten here.
class NeonSharedModeChange(BaseModel):
    trip_id: str
    mode: str
    expected_version: int


def _neon_shared_mode_table(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_neon_test_task_modes_91912 (
        trip_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('drive','neon')),
        version INTEGER NOT NULL DEFAULT 1,
        backup_filename TEXT NOT NULL DEFAULT ''
    )""")


@app.get('/safe/neon-task-shared-mode/{trip_id}', dependencies=[Depends(authorize)])
def neon_shared_mode_read(trip_id: str):
    _assert_test_trip(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _neon_shared_mode_table(cur)
            cur.execute('SELECT mode,version,backup_filename FROM pixelapp_neon_test_task_modes_91912 WHERE trip_id=%s',(trip_id,))
            row=cur.fetchone()
        conn.commit()
    return {'trip_id':trip_id,'mode':row[0] if row else 'drive','version':row[1] if row else 0,
            'backup_filename':row[2] if row else '', 'shared':bool(row)}


@app.post('/safe/neon-task-shared-mode', dependencies=[Depends(authorize)])
def neon_shared_mode_change(payload: NeonSharedModeChange):
    _assert_test_trip(payload.trip_id)
    if payload.mode not in ('drive','neon') or payload.expected_version<0:
        raise HTTPException(422,'Невалиден режим или версия.')
    # Snapshot before setting the shared mode to Neon. Existing backup logic also
    # reads the uploaded JSON back from Drive and compares its SHA-256.
    backup = neon_test_backup() if payload.mode=='neon' else None
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _neon_shared_mode_table(cur)
            cur.execute('SELECT mode,version,backup_filename FROM pixelapp_neon_test_task_modes_91912 WHERE trip_id=%s FOR UPDATE',(payload.trip_id,))
            old=cur.fetchone()
            if (old[1] if old else 0)!=payload.expected_version:
                raise HTTPException(409,'Режимът е променен от другия профил. Обнови и опитай пак.')
            if old is None:
                cur.execute('INSERT INTO pixelapp_neon_test_task_modes_91912(trip_id,mode,version,backup_filename) VALUES (%s,%s,1,%s)',
                            (payload.trip_id,payload.mode,backup['filename'] if backup else ''))
                ver=1
            else:
                ver=old[1]+1
                cur.execute('UPDATE pixelapp_neon_test_task_modes_91912 SET mode=%s,version=%s,backup_filename=%s WHERE trip_id=%s',
                            (payload.mode,ver,backup['filename'] if backup else old[2],payload.trip_id))
        conn.commit()
    return {'trip_id':payload.trip_id,'mode':payload.mode,'version':ver,'shared':True,
            'backup_filename':backup['filename'] if backup else (old[2] if old else ''),
            'drive_unmodified':True}



# P92.0: read-only Drive -> isolated Neon snapshot; no live app routing changes.
@app.post('/safe/p92-full-snapshot', dependencies=[Depends(authorize)])
def p92_full_snapshot():
    import time as _p92time
    from psycopg.types.json import Jsonb
    started = _p92time.perf_counter()
    service = drive_service()
    if service is None:
        raise HTTPException(503, 'Google Drive is not configured.')
    try:
        folder, mapping = folder_and_files(service)
        required = ('settings','expenses','budgets','tasks','points','categories','labels')
        raw_sets = {}
        # Read directly from Drive, not the Render local cache.
        for kind in required:
            name = FILENAMES[kind]
            if name not in mapping:
                if kind in ('settings','expenses','budgets'):
                    raise ValueError('Required source file missing: '+name)
                raw_sets[kind] = {'name':name,'exists':False,'rows':[],'columns':list(COLUMNS[kind]),'sha256':None}
                continue
            raw = service.files().get_media(fileId=mapping[name]).execute()
            text = raw.decode('utf-8-sig')
            reader = csv.DictReader(io.StringIO(text))
            headers = list(reader.fieldnames or [])
            if not headers or any(col not in headers for col in COLUMNS[kind]):
                raise ValueError('Unrecognized CSV schema for '+name)
            rows = list(reader)
            if any(None in row for row in rows):
                raise ValueError('Malformed CSV rows: '+name)
            raw_sets[kind] = {'name':name,'exists':True,'rows':rows,'columns':headers,'sha256':hashlib.sha256(raw).hexdigest()}
        # A second source signature check prevents claiming parity if source changes
        # while we are copying. Does not alter Drive.
        for kind, item in raw_sets.items():
            if not item['exists']:continue
            again=service.files().get_media(fileId=mapping[item['name']]).execute()
            if hashlib.sha256(again).hexdigest()!=item['sha256']:
                raise ValueError('Source changed during copy: '+item['name'])
        run_id = uuid.uuid4().hex
        report={}
        with _neon_demo_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('''CREATE TABLE IF NOT EXISTS pixelapp_p92_snapshot_runs (
                  run_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
                  inventory jsonb NOT NULL, verified boolean NOT NULL DEFAULT false)''')
                cur.execute('''CREATE TABLE IF NOT EXISTS pixelapp_p92_snapshot_rows (
                  run_id text NOT NULL REFERENCES pixelapp_p92_snapshot_runs(run_id),
                  source_kind text NOT NULL, row_number integer NOT NULL,
                  payload jsonb NOT NULL, PRIMARY KEY(run_id,source_kind,row_number))''')
                manifest={kind:{'filename':it['name'],'present':it['exists'],'count':len(it['rows']),
                    'columns':it['columns'],'source_sha256':it['sha256'],
                    'rows_sha256':hashlib.sha256(json.dumps(it['rows'],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
                    for kind,it in raw_sets.items()}
                cur.execute('INSERT INTO pixelapp_p92_snapshot_runs(run_id,inventory) VALUES (%s,%s)',(run_id,Jsonb(manifest)))
                for kind,it in raw_sets.items():
                    for idx,row in enumerate(it['rows'],1):
                        cur.execute('INSERT INTO pixelapp_p92_snapshot_rows(run_id,source_kind,row_number,payload) VALUES (%s,%s,%s,%s)',(run_id,kind,idx,Jsonb(row)))
                    cur.execute('SELECT payload FROM pixelapp_p92_snapshot_rows WHERE run_id=%s AND source_kind=%s ORDER BY row_number',(run_id,kind))
                    verify=[r[0] for r in cur.fetchall()]
                    actual=hashlib.sha256(json.dumps(verify,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
                    if actual!=manifest[kind]['rows_sha256'] or len(verify)!=len(it['rows']):
                        raise ValueError('Neon parity mismatch for '+kind)
                    report[kind]={'rows':len(verify),'present':it['exists'],'verified':True}
                cur.execute('UPDATE pixelapp_p92_snapshot_runs SET verified=true WHERE run_id=%s',(run_id,))
            conn.commit()
        return {'ok':True,'run_id':run_id,'datasets':report,
          'total_rows':sum(x['rows'] for x in report.values()),
          'elapsed_ms':round((_p92time.perf_counter()-started)*1000),
          'google_drive_modified':False,'live_neon_tables_modified':False,
          'note':'Diagnostic copy only; no trip has been switched to Neon.'}
    except HTTPException:
        raise
    except Exception:
        # Fail closed. No credentials or source data in public errors.
        raise HTTPException(503,'P92.0 copy/verification failed. No live tables were switched; inspect Render logs.') from None


# P92.1 — migration readiness audit. This endpoint is deliberately read-only.
@app.get('/safe/p92-readiness', dependencies=[Depends(authorize)])
def p92_readiness():
    import collections, time as _clock
    start = _clock.perf_counter()
    kinds = ('settings','expenses','budgets','tasks','points','categories','labels')
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.pixelapp_p92_snapshot_runs')::text")
            if cur.fetchone()[0] is None:
                raise HTTPException(409,'Няма P92.0 копие. Първо изпълни копирането.')
            cur.execute('SELECT run_id,inventory FROM pixelapp_p92_snapshot_runs WHERE verified=true ORDER BY created_at DESC LIMIT 1')
            latest=cur.fetchone()
            if latest is None:raise HTTPException(409,'Няма проверено P92.0 копие.')
            run_id,manifest=latest
            cur.execute('SELECT source_kind,payload FROM pixelapp_p92_snapshot_rows WHERE run_id=%s ORDER BY source_kind,row_number',(run_id,))
            records=collections.defaultdict(list)
            for kind,row in cur.fetchall():records[kind].append(row)
    # Validate all copied rows and references without touching either data store.
    known_ids={str(r.get('trip_id','')).strip() for r in records['settings'] if str(r.get('trip_id','')).strip()}
    issues=[]
    for kind in kinds:
        if len(records[kind])!=manifest[kind]['count']:
            issues.append(kind+': несъвпадащ брой редове')
        digest=hashlib.sha256(json.dumps(records[kind],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        if digest!=manifest[kind]['rows_sha256']:
            issues.append(kind+': хешът на редовете не съвпада')
    if len(known_ids)!=len(records['settings']):issues.append('Повтарящ се или празен идентификатор на пътуване')
    per_trip={k:{'settings':0,'expenses':0,'budgets':0,'tasks':0,'points':0,'categories':0} for k in sorted(known_ids)}
    warnings=[]
    shared_favorites=0
    orphan_categories=0
    for kind in ('settings','expenses','budgets','tasks','points','categories'):
        for r in records[kind]:
            tid=str(r.get('trip_id','')).strip()
            if tid in known_ids:
                per_trip[tid][kind]+=1
            elif kind=='points' and tid=='__PIXELAPP_SHARED_FAVORITES__':
                # Reserved system scope: shared favorites belong to the library, not a trip.
                shared_favorites+=1
            elif kind=='categories' and tid and tid not in known_ids:
                # Preserve historic category rows exactly; exclude them from per-trip views.
                # They remain warnings pending an explicit cleanup decision.
                orphan_categories+=1
                warnings.append('categories: стара категория без съществуващо пътуване')
            else:
                issues.append(kind+': запис с непознато пътуване')
    for tid in known_ids:
        ids=[str(r.get('item_id','')).strip() for r in records['tasks'] if str(r.get('trip_id','')).strip()==tid]
        if len(ids)!=len(set(ids)) or any(not v for v in ids):issues.append('Задачи: празен или повторен ID в пътуване')
    # Recheck source freshness directly in Google Drive (read only).
    service=drive_service()
    if service is None:raise HTTPException(503,'Google Drive не е достъпен за проверка на актуалността.')
    _,mapping=folder_and_files(service)
    stale=[]
    for kind in kinds:
        item=manifest[kind]
        file_id=mapping.get(item['filename'])
        if bool(file_id)!=bool(item['present']):stale.append(kind);continue
        if file_id:
            source=service.files().get_media(fileId=file_id).execute()
            if hashlib.sha256(source).hexdigest()!=item['source_sha256']:stale.append(kind)
    return {'ok':not issues and not stale,'ready_for_live_switch':False,'run_id':run_id,
      'total_rows':sum(len(records[k]) for k in kinds),'trip_count':len(known_ids),
      'per_trip':per_trip,'issues':list(dict.fromkeys(issues)),
      'warnings':list(dict.fromkeys(warnings)), 'shared_favorites':shared_favorites,
      'orphan_categories':orphan_categories, 'stale_sources':stale,
      'source_is_current':not stale,'elapsed_ms':round((_clock.perf_counter()-start)*1000),
      'note':'Integrity/readiness audit only. Live read/write migration and full backups are NOT yet implemented.'}


# P92.2 — detailed, read-only inspection of unresolved trip references.
@app.get('/safe/p92-reference-details', dependencies=[Depends(authorize)])
def p92_reference_details():
    import time as _clock
    start = _clock.perf_counter()
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.pixelapp_p92_snapshot_runs')::text")
            if cur.fetchone()[0] is None:
                raise HTTPException(409, 'Няма P92.0 копие.')
            cur.execute('SELECT run_id,inventory FROM pixelapp_p92_snapshot_runs WHERE verified=true ORDER BY created_at DESC LIMIT 1')
            latest=cur.fetchone()
            if latest is None:raise HTTPException(409, 'Няма проверено P92.0 копие.')
            run_id,manifest=latest
            cur.execute('SELECT source_kind,row_number,payload FROM pixelapp_p92_snapshot_rows WHERE run_id=%s AND source_kind IN (%s,%s,%s) ORDER BY source_kind,row_number',
                        (run_id,'settings','points','categories'))
            rows=cur.fetchall()
    known={str(payload.get('trip_id','')).strip() for kind,idx,payload in rows if kind=='settings' and str(payload.get('trip_id','')).strip()}
    details=[]
    for kind,idx,payload in rows:
        if kind not in ('points','categories'):continue
        trip_id=str(payload.get('trip_id','')).strip()
        if trip_id in known:continue
        classification=('shared_favorites' if kind=='points' and trip_id=='__PIXELAPP_SHARED_FAVORITES__'
                        else 'orphan_category' if kind=='categories' and trip_id
                        else 'unresolved')
        reason=('обща библиотека с любими места — системен идентификатор' if classification=='shared_favorites'
                else 'стара категория без съществуващо пътуване — запазена' if classification=='orphan_category'
                else 'празен trip_id' if not trip_id else 'няма такова пътуване в settings')
        details.append({'dataset':kind,'row_number':idx,'trip_id':trip_id,
                        'trip_id_is_blank':not bool(trip_id),
                        'title':str(payload.get('title',''))[:180] if kind=='points' else '',
                        'category':str(payload.get('category',''))[:180] if kind=='categories' else '',
                        'stop_type':str(payload.get('stop_type',''))[:80] if kind=='points' else '',
                        'classification':classification,'reason':reason})
    return {'ok':True,'run_id':run_id,'known_trip_count':len(known),
            'unresolved_count':len(details),'unresolved':details,
            'classification':'системните любими места са разрешени; старите категории са предупреждения',
            'ready_for_live_switch':False,'drive_modified':False,'live_neon_modified':False,
            'elapsed_ms':round((_clock.perf_counter()-start)*1000)}


# P92.4 — Neon working copy for a single TEST trip, with atomic revisions.
# This is deliberately separate from production and from P92.0 immutable snapshots.
_P924_DATASETS = ('settings', 'expenses', 'budgets', 'tasks', 'points', 'categories')

def _p924_schema(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_p924_workspaces (
        trip_id text PRIMARY KEY, source_run_id text NOT NULL,
        source_digest text NOT NULL, revision bigint NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(), modified_at timestamptz NOT NULL DEFAULT now()
    )""")
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_p924_records (
        trip_id text NOT NULL REFERENCES pixelapp_p924_workspaces(trip_id),
        dataset text NOT NULL, row_id text NOT NULL, row_order bigint NOT NULL,
        payload jsonb NOT NULL, version bigint NOT NULL DEFAULT 1,
        PRIMARY KEY (trip_id, dataset, row_id)
    )""")

def _p924_digest(rows):
    return hashlib.sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()

class P924Change(BaseModel):
    trip_id: str
    dataset: str
    operation: str  # add / edit / delete
    row_id: str = ''
    expected_version: int | None = None
    row: dict[str, str] | None = None

@app.post('/safe/p924-workspace/{trip_id}', dependencies=[Depends(authorize)])
def p924_prepare_workspace(trip_id: str):
    # Creating a working copy is explicit, never called on normal app startup.
    _assert_test_trip(trip_id)
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p924_schema(cur)
            cur.execute('SELECT source_run_id,source_digest,revision FROM pixelapp_p924_workspaces WHERE trip_id=%s',(trip_id,))
            existing=cur.fetchone()
            if existing:
                cur.execute('SELECT dataset,count(*) FROM pixelapp_p924_records WHERE trip_id=%s GROUP BY dataset',(trip_id,))
                return {'ok':True,'existing':True,'revision':existing[2],'counts':dict(cur.fetchall()),'trip_id':trip_id,'drive_unchanged':True,'live_switch':False}
            cur.execute('SELECT run_id,inventory FROM pixelapp_p92_snapshot_runs WHERE verified=true ORDER BY created_at DESC LIMIT 1')
            latest=cur.fetchone()
            if latest is None:raise HTTPException(409,'Няма проверено P92.0 копие.')
            run_id,inventory=latest
            cur.execute('SELECT source_kind,row_number,payload FROM pixelapp_p92_snapshot_rows WHERE run_id=%s ORDER BY source_kind,row_number',(run_id,))
            originals=cur.fetchall()
            grouped={k:[] for k in ('settings','expenses','budgets','tasks','points','categories','labels')}
            for kind,num,row in originals:grouped[kind].append(row)
            for kind,info in inventory.items():
                if len(grouped[kind])!=info['count'] or _p924_digest(grouped[kind])!=info['rows_sha256']:
                    raise HTTPException(409,'Копието не съвпада: '+kind)
            if sum(1 for r in grouped['settings'] if r.get('trip_id')==trip_id)!=1:
                raise HTTPException(409,'Пътуването не е открито еднозначно в копието.')
            selected=[(kind,num,row) for kind,num,row in originals if kind in _P924_DATASETS and row.get('trip_id')==trip_id]
            selected_digest=_p924_digest(selected)
            cur.execute('INSERT INTO pixelapp_p924_workspaces(trip_id,source_run_id,source_digest) VALUES (%s,%s,%s)',(trip_id,run_id,selected_digest))
            counts={k:0 for k in _P924_DATASETS}
            for kind,num,row in selected:
                cur.execute('INSERT INTO pixelapp_p924_records(trip_id,dataset,row_id,row_order,payload) VALUES (%s,%s,%s,%s,%s)',
                            (trip_id,kind,uuid.uuid4().hex,num,Jsonb(row)))
                counts[kind]+=1
            cur.execute('SELECT dataset,row_order,payload FROM pixelapp_p924_records WHERE trip_id=%s ORDER BY dataset,row_order',(trip_id,))
            verified=[(k,n,p) for k,n,p in cur.fetchall()]
            if _p924_digest(sorted(selected,key=lambda x:(x[0],x[1])))!=_p924_digest(verified):
                raise HTTPException(409,'Проверката на работното копие не е успешна.')
        conn.commit()
    return {'ok':True,'existing':False,'revision':1,'counts':counts,'trip_id':trip_id,'drive_unchanged':True,'live_switch':False}

@app.get('/safe/p924-workspace/{trip_id}', dependencies=[Depends(authorize)])
def p924_read_workspace(trip_id: str):
    _assert_test_trip(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p924_schema(cur)
            cur.execute('SELECT source_run_id,revision FROM pixelapp_p924_workspaces WHERE trip_id=%s',(trip_id,))
            meta=cur.fetchone()
            if meta is None:raise HTTPException(404,'Тестовото пътуване няма работно Neon копие.')
            cur.execute('SELECT dataset,row_id,payload,version FROM pixelapp_p924_records WHERE trip_id=%s ORDER BY dataset,row_order,row_id',(trip_id,))
            rows={kind:[] for kind in _P924_DATASETS}
            for kind,row_id,payload,version in cur.fetchall():rows[kind].append({'row_id':row_id,'version':version,'data':payload})
        conn.commit()
    return {'trip_id':trip_id,'source_run_id':meta[0],'revision':meta[1],'records':rows,'live_switch':False}

@app.post('/safe/p924-record', dependencies=[Depends(authorize)])
def p924_change_record(change: P924Change, background_tasks: BackgroundTasks):
    _assert_test_trip(change.trip_id)
    if change.dataset not in ('expenses','budgets','tasks','points','categories'):
        raise HTTPException(403,'Настройките на пътуванията и общите данни не се редактират в този етап.')
    if change.operation not in ('add','edit','delete'):raise HTTPException(422,'Невалидно действие.')
    if change.operation!='add' and (not change.row_id or change.expected_version is None or change.expected_version<1):
        raise HTTPException(422,'Изисква се версия на записа.')
    if change.operation in ('add','edit'):
        if not isinstance(change.row,dict) or set(change.row)!=set(COLUMNS[change.dataset]):
            raise HTTPException(422,'Редът трябва да съдържа точно оригиналните CSV колони.')
        if any(not isinstance(value,str) for value in change.row.values()) or change.row.get('trip_id')!=change.trip_id:
            raise HTTPException(422,'Невалидни стойности или пътуване.')
        if len(json.dumps(change.row,ensure_ascii=False))>12000:raise HTTPException(422,'Твърде голям запис.')
        if change.dataset=='tasks' and not change.row.get('item_id','').strip():raise HTTPException(422,'Задачата трябва да има item_id.')
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p924_schema(cur)
            # Row lock serializes edits and revision changes across both accounts.
            cur.execute('SELECT revision FROM pixelapp_p924_workspaces WHERE trip_id=%s FOR UPDATE',(change.trip_id,))
            found=cur.fetchone()
            if not found:raise HTTPException(409,'Няма подготвено тестово копие.')
            if change.operation=='add':
                row_id=uuid.uuid4().hex
                cur.execute('SELECT COALESCE(max(row_order),0)+1 FROM pixelapp_p924_records WHERE trip_id=%s AND dataset=%s',(change.trip_id,change.dataset))
                order=cur.fetchone()[0]
                cur.execute('INSERT INTO pixelapp_p924_records(trip_id,dataset,row_id,row_order,payload) VALUES (%s,%s,%s,%s,%s)',(change.trip_id,change.dataset,row_id,order,Jsonb(change.row)))
                version=1
            elif change.operation=='edit':
                cur.execute('UPDATE pixelapp_p924_records SET payload=%s,version=version+1 WHERE trip_id=%s AND dataset=%s AND row_id=%s AND version=%s RETURNING version',
                            (Jsonb(change.row),change.trip_id,change.dataset,change.row_id,change.expected_version))
                updated=cur.fetchone()
                if not updated:raise HTTPException(409,'Друг профил вече е променил или изтрил записа. Обнови данните.')
                row_id=change.row_id;version=updated[0]
            else:
                cur.execute('DELETE FROM pixelapp_p924_records WHERE trip_id=%s AND dataset=%s AND row_id=%s AND version=%s RETURNING version',
                            (change.trip_id,change.dataset,change.row_id,change.expected_version))
                deleted=cur.fetchone()
                if not deleted:raise HTTPException(409,'Друг профил вече е променил или изтрил записа. Обнови данните.')
                row_id=change.row_id;version=None
            cur.execute('UPDATE pixelapp_p924_workspaces SET revision=revision+1,modified_at=now() WHERE trip_id=%s RETURNING revision',(change.trip_id,))
            revision=cur.fetchone()[0]
            # P92.8: persist the archive obligation in the SAME transaction as the edit.
            _p928_schema(cur)
            cur.execute('''INSERT INTO pixelapp_p928_backup_state (trip_id,wanted_revision)
                           VALUES (%s,%s) ON CONFLICT (trip_id) DO UPDATE
                           SET wanted_revision=GREATEST(pixelapp_p928_backup_state.wanted_revision,EXCLUDED.wanted_revision),
                               updated_at=now()''', (change.trip_id,revision))
        conn.commit()
    # The write is committed before Drive access. A Drive error cannot roll it back.
    background_tasks.add_task(_p928_backup_worker,change.trip_id)
    return {'ok':True,'trip_id':change.trip_id,'dataset':change.dataset,'row_id':row_id,'version':version,'revision':revision,'drive_unchanged':True,'live_switch':False,'backup':'queued'}


# P92.7 — immutable, verified Google Drive archive of a single TEST Neon workspace.
# This is a manual safety gate before any production migration, not a full backup.
def _p927_archive_document(trip_id):
    _assert_test_trip(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            # Tables were initialized by the P92.4 workspace endpoints.
            # Never run CREATE TABLE inside this read-only snapshot transaction.
            cur.execute('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            cur.execute('SELECT source_run_id,source_digest,revision FROM pixelapp_p924_workspaces WHERE trip_id=%s',(trip_id,))
            meta=cur.fetchone()
            if meta is None:raise HTTPException(404,'Липсва тестово Neon работно копие.')
            cur.execute('SELECT dataset,row_id,row_order,payload,version FROM pixelapp_p924_records WHERE trip_id=%s ORDER BY dataset,row_order,row_id',(trip_id,))
            records=[{'dataset':kind,'row_id':rid,'row_order':order,'data':payload,'version':version} for kind,rid,order,payload,version in cur.fetchall()]
        conn.rollback()
    counts={kind:sum(r['dataset']==kind for r in records) for kind in _P924_DATASETS}
    return {'format':'pixelapp-p927-test-workspace','schema_version':1,'trip_id':trip_id,
            'source_run_id':meta[0],'source_digest':meta[1],'revision':meta[2],
            'counts':counts,'records':records,
            'note':'TEST Neon working copy only. No production switch; no automatic restore.'}

@app.post('/safe/p927-workspace-backup/{trip_id}', dependencies=[Depends(authorize)])
def p927_workspace_backup(trip_id: str):
    from datetime import datetime, timezone
    from googleapiclient.http import MediaIoBaseUpload
    _assert_test_trip(trip_id)
    service=drive_service()
    if service is None:raise HTTPException(503,'Drive не е свързан. Няма архив.')
    doc=_p927_archive_document(trip_id)
    doc['created_utc']=datetime.now(timezone.utc).isoformat()
    raw=json.dumps(doc,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')
    digest=hashlib.sha256(raw).hexdigest()
    try:
        root,_=folder_and_files(service)
        folder_name='PixelApp_Neon_Test_Backups'
        q="'%s' in parents and name = '%s' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"%(root,folder_name)
        found=service.files().list(q=q,fields='files(id)',pageSize=20).execute().get('files',[])
        folder=found[0]['id'] if found else service.files().create(body={'name':folder_name,'mimeType':'application/vnd.google-apps.folder','parents':[root]},fields='id').execute()['id']
        stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S_%fZ')
        name='p927_workspace_'+stamp+'_'+digest[:12]+'.json'
        created=service.files().create(body={'name':name,'parents':[folder], 'description':'Verified isolated Neon TEST workspace backup'},media_body=MediaIoBaseUpload(io.BytesIO(raw),mimetype='application/json',resumable=False),fields='id').execute()
        downloaded=service.files().get_media(fileId=created['id']).execute()
        if downloaded!=raw or hashlib.sha256(downloaded).hexdigest()!=digest:
            raise HTTPException(503,'Архивът не премина проверката след качването.')
        # Detect writes that landed during the upload. Archive is still valid for its labelled revision.
        latest=_p927_archive_document(trip_id)
        current=latest['revision']==doc['revision']
        return {'ok':True,'verified':True,'filename':name,'sha256':digest,'trip_id':trip_id,
                'revision':doc['revision'],'still_current':current,'counts':doc['counts'],
                'size_bytes':len(raw),'scope':'test-workspace-only', 'drive_csv_unchanged':True}
    except HTTPException:raise
    except Exception:
        raise HTTPException(503,'Неуспешно създаване или проверка на Drive архива.') from None

@app.post('/safe/p927-workspace-archive-check/{trip_id}', dependencies=[Depends(authorize)])
def p927_archive_check(trip_id: str):
    _assert_test_trip(trip_id)
    service=drive_service()
    if service is None:raise HTTPException(503,'Drive не е свързан.')
    try:
        root,_=folder_and_files(service)
        q="'%s' in parents and name = 'PixelApp_Neon_Test_Backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"%root
        found=service.files().list(q=q,fields='files(id)',pageSize=20).execute().get('files',[])
        if not found:raise HTTPException(404,'Няма папка за Neon архиви.')
        folder=found[0]['id']
        files=[];token=None
        while True:
            result=service.files().list(q="'%s' in parents and name contains 'p927_workspace_' and trashed = false"%folder,fields='nextPageToken,files(id,name)',pageSize=100,pageToken=token).execute()
            files.extend(f for f in result.get('files',[]) if f['name'].startswith('p927_workspace_') and f['name'].endswith('.json'))
            token=result.get('nextPageToken')
            if not token:break
        if not files:raise HTTPException(404,'Няма P92.7 архив.')
        # Names contain UTC timestamps with microseconds; lexicographic order is chronological.
        files.sort(key=lambda x:x['name'],reverse=True)
        found_doc=None;found_name=''
        for f in files:
            raw=service.files().get_media(fileId=f['id']).execute()
            data=json.loads(raw)
            if data.get('format')!='pixelapp-p927-test-workspace' or data.get('trip_id')!=trip_id:continue
            digest=hashlib.sha256(raw).hexdigest()
            if not f['name'].endswith('_'+digest[:12]+'.json'):
                raise HTTPException(409,'Невалидна контролна сума на архива.')
            if data.get('schema_version')!=1 or not isinstance(data.get('records'),list):
                raise HTTPException(409,'Неподдържан формат на архива.')
            counts={kind:sum(r.get('dataset')==kind for r in data['records']) for kind in _P924_DATASETS}
            if counts!=data.get('counts') or any(r.get('dataset') not in _P924_DATASETS or not isinstance(r.get('data'),dict) or r['data'].get('trip_id')!=trip_id for r in data['records']):
                raise HTTPException(409,'Нарушена структура на архивираните записи.')
            found_doc=data;found_name=f['name'];break
        if found_doc is None:raise HTTPException(404,'Не е открит архив за това тестово пътуване.')
        latest=_p927_archive_document(trip_id)
        same=(latest['revision']==found_doc['revision'] and latest['source_digest']==found_doc['source_digest'] and latest['records']==found_doc['records'])
        return {'ok':True,'verified':True,'archive':found_name,'revision':found_doc['revision'],
                'current_revision':latest['revision'],'matches_current_workspace':same,
                'counts':found_doc['counts'],'restore_performed':False,'drive_csv_unchanged':True}
    except HTTPException:raise
    except Exception:
        raise HTTPException(503,'Неуспешна проверка на тестовия архив.') from None


# P92.8 — test-only, best-effort automatic verified Drive archival after Neon commits.
# Pending revisions survive worker restarts in Postgres; GET status (or a new edit)
# retries pending archives. No production trip or legacy CSV is switched/modified.
def _p928_schema(cur):
    cur.execute('''CREATE TABLE IF NOT EXISTS pixelapp_p928_backup_state (
        trip_id text PRIMARY KEY REFERENCES pixelapp_p924_workspaces(trip_id),
        wanted_revision bigint NOT NULL,
        archived_revision bigint NOT NULL DEFAULT 0,
        archive_filename text NOT NULL DEFAULT '',
        last_error text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now(),
        archived_at timestamptz
    )''')


def _p928_backup_worker(trip_id):
    # Serialize automatic archival per trip, even across multiple Render workers.
    import hashlib as _hashlib
    lock_number = int.from_bytes(_hashlib.sha256(('p928:'+trip_id).encode()).digest()[:8], 'big', signed=True)
    try:
        with _neon_demo_connection() as lock_conn:
            with lock_conn.cursor() as cur:
                cur.execute('SELECT pg_try_advisory_lock(%s)', (lock_number,))
                if not cur.fetchone()[0]:
                    return  # another worker is archiving; next status poll can retry
            try:
                for _ in range(3):
                    with _neon_demo_connection() as conn:
                        with conn.cursor() as cur:
                            _p928_schema(cur)
                            cur.execute('SELECT wanted_revision,archived_revision FROM pixelapp_p928_backup_state WHERE trip_id=%s',(trip_id,))
                            state=cur.fetchone()
                    if not state or state[1]>=state[0]:
                        return
                    try:
                        result=p927_workspace_backup(trip_id)
                        if not result.get('verified'):
                            raise RuntimeError('Drive verification failed')
                    except Exception:
                        # Keep actionable state without leaking Drive credentials or internal errors.
                        with _neon_demo_connection() as conn:
                            with conn.cursor() as cur:
                                cur.execute('UPDATE pixelapp_p928_backup_state SET last_error=%s,updated_at=now() WHERE trip_id=%s',('Архивирането не успя; нужен е нов опит.',trip_id))
                            conn.commit()
                        return
                    with _neon_demo_connection() as conn:
                        with conn.cursor() as cur:
                            cur.execute('''UPDATE pixelapp_p928_backup_state
                                SET archived_revision=GREATEST(archived_revision,%s),
                                    archive_filename=CASE WHEN archived_revision<=%s THEN %s ELSE archive_filename END,
                                    last_error='',archived_at=now(),updated_at=now()
                                WHERE trip_id=%s''',(result['revision'],result['revision'],result['filename'],trip_id))
                        conn.commit()
            finally:
                with lock_conn.cursor() as cur:
                    cur.execute('SELECT pg_advisory_unlock(%s)',(lock_number,))
    except Exception:
        # Never throw from a background task and mask an already committed Neon edit.
        return


@app.get('/safe/p928-backup-status/{trip_id}', dependencies=[Depends(authorize)])
def p928_backup_status(trip_id: str, background_tasks: BackgroundTasks):
    _assert_test_trip(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p928_schema(cur)
            cur.execute('SELECT revision FROM pixelapp_p924_workspaces WHERE trip_id=%s',(trip_id,))
            meta=cur.fetchone()
            if meta is None:raise HTTPException(404,'Липсва тестово работно копие.')
            cur.execute('''INSERT INTO pixelapp_p928_backup_state(trip_id,wanted_revision)
                VALUES (%s,%s) ON CONFLICT (trip_id) DO UPDATE SET
                wanted_revision=GREATEST(pixelapp_p928_backup_state.wanted_revision,EXCLUDED.wanted_revision)''',(trip_id,meta[0]))
            cur.execute('''SELECT wanted_revision,archived_revision,archive_filename,last_error,archived_at
                           FROM pixelapp_p928_backup_state WHERE trip_id=%s''',(trip_id,))
            wanted,archived,filename,error,when=cur.fetchone()
        conn.commit()
    pending=archived<wanted
    if pending:background_tasks.add_task(_p928_backup_worker,trip_id)
    return {'ok':True,'trip_id':trip_id,'current_revision':meta[0],
            'wanted_revision':wanted,'archived_revision':archived,
            'matches_current':not pending,'status':'retrying' if pending and error else 'pending' if pending else 'verified',
            'archive':filename,'last_error':error,'archived_at':when.isoformat() if when else None,
            'scope':'test-workspace-only','automatic_restore':False,'drive_csv_unchanged':True}


# P92.9 — strictly read-only comparison of current Drive and the last verified P92 snapshot.
@app.get('/safe/p929-trip-diagnostics', dependencies=[Depends(authorize)])
def p929_trip_diagnostics():
    from collections import defaultdict
    kinds=('settings','expenses','budgets','tasks','points','categories')
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.pixelapp_p92_snapshot_runs')::text")
            if cur.fetchone()[0] is None:
                raise HTTPException(409, 'Няма P92.0 копие за сравнение.')
            cur.execute('SELECT run_id,inventory FROM pixelapp_p92_snapshot_runs WHERE verified=true ORDER BY created_at DESC LIMIT 1')
            meta=cur.fetchone()
            if not meta: raise HTTPException(409,'Няма проверено Neon копие.')
            run_id, manifest=meta
            cur.execute('SELECT source_kind,payload FROM pixelapp_p92_snapshot_rows WHERE run_id=%s ORDER BY source_kind,row_number',(run_id,))
            snapshot=defaultdict(list)
            for kind,payload in cur.fetchall(): snapshot[kind].append(payload)
    service=drive_service()
    if service is None: raise HTTPException(503,'Google Drive не е достъпен.')
    _,mapping=folder_and_files(service)
    source={}
    for kind in kinds:
        filename=FILENAMES[kind]
        if filename not in mapping:
            if kind in ('settings','expenses','budgets'): raise HTTPException(409,'Липсва необходим Drive файл: '+filename)
            source[kind]=[]
            continue
        raw=service.files().get_media(fileId=mapping[filename]).execute()
        reader=csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
        if not reader.fieldnames or any(c not in reader.fieldnames for c in COLUMNS[kind]):
            raise HTTPException(409,'Невалиден Drive CSV: '+filename)
        source[kind]=list(reader)
        if any(None in row for row in source[kind]):
            raise HTTPException(409,'Невалидни CSV редове: '+filename)

    def summary(rows,kind):
        # Preserve exact original row contents in fingerprints, including amounts and fuel.
        digest=hashlib.sha256(json.dumps(rows,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        data={'count':len(rows),'sha256':digest}
        if kind=='expenses':
            from decimal import Decimal, InvalidOperation
            amount=Decimal(0);fuel=0;liters=Decimal(0);bad=0
            by_category=defaultdict(int)
            for r in rows:
                by_category[str(r.get('category',''))]+=1
                try: amount+=Decimal(str(r.get('amount','0')).replace(',','.').strip() or '0')
                except InvalidOperation:bad+=1
                if str(r.get('type','')).lower() in ('fuel','гориво','refuel','зареждане') or str(r.get('liters','')).strip():
                    fuel+=1
                    try:liters+=Decimal(str(r.get('liters','0')).replace(',','.').strip() or '0')
                    except InvalidOperation:bad+=1
            data.update(amount=str(amount),fuel_records=fuel,fuel_liters=str(liters),invalid_numeric=bad,categories=dict(sorted(by_category.items())))
        return data

    trip_ids=sorted({str(r.get('trip_id','')).strip() for r in source['settings']+snapshot['settings'] if str(r.get('trip_id','')).strip()})
    comparison=[]
    for tid in trip_ids:
        items={};different=[]
        for kind in kinds:
            live_rows=[r for r in source[kind] if str(r.get('trip_id','')).strip()==tid]
            snap_rows=[r for r in snapshot[kind] if str(r.get('trip_id','')).strip()==tid]
            live=summary(live_rows,kind);snap=summary(snap_rows,kind)
            # Order-sensitive identity also detects reordering; no mismatches are hidden.
            match=live['sha256']==snap['sha256']
            if not match:different.append(kind)
            items[kind]={'drive':live,'snapshot':snap,'match':match}
        comparison.append({'trip_id':tid,'matches_snapshot':not different,'different_datasets':different,'datasets':items,'live_neon_migrated':False})
    extra={}
    for kind in kinds:
        live=[r for r in source[kind] if not str(r.get('trip_id','')).strip() or str(r.get('trip_id','')).strip() not in trip_ids]
        old=[r for r in snapshot[kind] if not str(r.get('trip_id','')).strip() or str(r.get('trip_id','')).strip() not in trip_ids]
        extra[kind]={'drive_count':len(live),'snapshot_count':len(old)}
    return {'ok':True,'read_only':True,'drive_modified':False,'snapshot_modified':False,
            'live_neon_migrated':False,'ready_for_live_switch':False,'snapshot_run_id':run_id,
            'trip_count':len(comparison),'matching_trips':sum(t['matches_snapshot'] for t in comparison),
            'trips':comparison,'unassigned_rows':extra,
            'warning':'Сравнява Drive с историческото P92.0 копие, НЕ с мигрирана продукционна Neon база. Различията може да са по-нови редакции в Drive.'}


# P93.0: immutable, isolated staging of ONE test trip from current Drive.
# No production writes, no switch, no changes to the P92.4 editable workspace.
_P930_KINDS=('settings','expenses','budgets','tasks','points','categories')

def _p930_load_drive_trip(trip_id):
    service=drive_service()
    if service is None:raise HTTPException(503,'Google Drive не е достъпен.')
    _,mapping=folder_and_files(service)
    out={}
    for kind in _P930_KINDS:
        filename=FILENAMES[kind]
        if filename not in mapping:
            if kind in ('settings','expenses','budgets'):
                raise HTTPException(409,'Липсва Drive файл: '+filename)
            out[kind]=[]
            continue
        raw=service.files().get_media(fileId=mapping[filename]).execute()
        reader=csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
        if not reader.fieldnames or any(k not in reader.fieldnames for k in COLUMNS[kind]):
            raise HTTPException(409,'Невалиден CSV: '+filename)
        rows=list(reader)
        if any(None in r for r in rows):raise HTTPException(409,'Невалидни CSV редове: '+filename)
        out[kind]=[r for r in rows if str(r.get('trip_id','')).strip()==trip_id]
    if len(out['settings'])!=1:
        raise HTTPException(409,'Тестовото пътуване не е открито еднозначно в текущия Drive.')
    return out

def _p930_schema(cur):
    cur.execute('''CREATE TABLE IF NOT EXISTS pixelapp_p930_test_stage (
        trip_id text PRIMARY KEY, digest text NOT NULL, created_at timestamptz DEFAULT now())''')
    cur.execute('''CREATE TABLE IF NOT EXISTS pixelapp_p930_test_rows (
        trip_id text NOT NULL REFERENCES pixelapp_p930_test_stage(trip_id),
        kind text NOT NULL, ord bigint NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY(trip_id,kind,ord))''')

def _p930_digest(groups):
    return _p924_digest({k:groups[k] for k in _P930_KINDS})

@app.post('/safe/p930-test-stage/{trip_id}',dependencies=[Depends(authorize)])
def p930_test_stage(trip_id:str):
    _assert_test_trip(trip_id)
    from psycopg.types.json import Jsonb
    rows=_p930_load_drive_trip(trip_id)
    digest=_p930_digest(rows)
    counts={k:len(v) for k,v in rows.items()}
    created=False
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p930_schema(cur)
            cur.execute('SELECT pg_advisory_xact_lock(hashtext(%s))',('p930:'+trip_id,))
            cur.execute('SELECT digest FROM pixelapp_p930_test_stage WHERE trip_id=%s FOR UPDATE',(trip_id,))
            found=cur.fetchone()
            if found and found[0]!=digest:
                raise HTTPException(409,'Drive е променен след създаване на P93.0 копието. Нищо не е презаписано.')
            if not found:
                cur.execute('INSERT INTO pixelapp_p930_test_stage(trip_id,digest) VALUES (%s,%s)',(trip_id,digest))
                for kind,items in rows.items():
                    for n,row in enumerate(items):
                        cur.execute('INSERT INTO pixelapp_p930_test_rows(trip_id,kind,ord,payload) VALUES (%s,%s,%s,%s)',(trip_id,kind,n,Jsonb(row)))
                created=True
            cur.execute('SELECT kind,ord,payload FROM pixelapp_p930_test_rows WHERE trip_id=%s ORDER BY kind,ord',(trip_id,))
            read={k:[] for k in _P930_KINDS}
            for kind,n,row in cur.fetchall():read[kind].append(row)
            if _p930_digest(read)!=digest:
                raise HTTPException(409,'Neon проверката не съвпада. Транзакцията се отменя.')
        conn.commit()
    return {'ok':True,'trip_id':trip_id,'created':created,'verified':True,
            'counts':counts,'sha256':digest,'drive_modified':False,
            'editable_workspace_modified':False,'production_modified':False,'live_switch':False}

@app.get('/safe/p930-test-stage/{trip_id}',dependencies=[Depends(authorize)])
def p930_verify_stage(trip_id:str):
    _assert_test_trip(trip_id)
    drive=_p930_load_drive_trip(trip_id)
    digest=_p930_digest(drive)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.pixelapp_p930_test_stage')::text")
            if cur.fetchone()[0] is None:raise HTTPException(404,'Няма P93.0 тестово копие.')
            cur.execute('SELECT digest FROM pixelapp_p930_test_stage WHERE trip_id=%s',(trip_id,))
            found=cur.fetchone()
            if not found:raise HTTPException(404,'Няма P93.0 тестово копие.')
            cur.execute('SELECT kind,ord,payload FROM pixelapp_p930_test_rows WHERE trip_id=%s ORDER BY kind,ord',(trip_id,))
            staged={k:[] for k in _P930_KINDS}
            for kind,n,row in cur.fetchall():staged[kind].append(row)
    consistent=_p930_digest(staged)==found[0]
    current=found[0]==digest
    return {'ok':consistent and current,'trip_id':trip_id,'stage_integrity':consistent,
            'drive_still_matches':current,'counts':{k:len(v) for k,v in staged.items()},
            'production_modified':False,'live_switch':False,
            'warning':None if consistent and current else 'Drive се е променил или копието не съвпада; превключване не е разрешено.'}


# P93.1: read-only, isolated normal-screen preview of the P93.0 migration stage.
# The original stage and the editable P92.4 workspace remain untouched.
@app.get('/safe/p931-stage-preview/{trip_id}',dependencies=[Depends(authorize)])
def p931_stage_preview(trip_id:str):
    if trip_id != 'ТЕСТ_НОВО_–_PixelApp':
        raise HTTPException(403,'P93.1 е разрешен само за избраното тестово пътуване.')
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.pixelapp_p930_test_stage')::text")
            if cur.fetchone()[0] is None:
                raise HTTPException(404,'Първо създай P93.0 копие.')
            cur.execute('SELECT digest FROM pixelapp_p930_test_stage WHERE trip_id=%s',(trip_id,))
            found=cur.fetchone()
            if not found:raise HTTPException(404,'Първо създай P93.0 копие.')
            cur.execute('SELECT kind,ord,payload FROM pixelapp_p930_test_rows WHERE trip_id=%s ORDER BY kind,ord',(trip_id,))
            groups={kind:[] for kind in _P930_KINDS}
            for kind,ord_value,row in cur.fetchall():
                if kind not in groups:raise HTTPException(409,'Непознат вид данни в копието.')
                groups[kind].append(row)
    if _p930_digest(groups)!=found[0]:
        raise HTTPException(409,'P93.0 копието не премина проверката за цялост.')
    return {'ok':True,'trip_id':trip_id,'readonly':True,'source':'p930-stage',
            'records':groups,'counts':{key:len(value) for key,value in groups.items()},
            'stage_digest':found[0], 'production_modified':False,
            'message':'Преглед само на мигрираното тестово копие. Записването е забранено.'}


# P93.2 — isolated editable fork of the immutable P93.0 migration stage.
# NEVER changes P93.0 stage, P92.4 workspace, production CSVs, or other trips.
_P932_TRIP = 'ТЕСТ_НОВО_–_PixelApp'

def _p932_schema(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_p932_workspaces (
        trip_id text PRIMARY KEY, source_digest text NOT NULL, revision bigint NOT NULL DEFAULT 1,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_p932_rows (
        trip_id text NOT NULL REFERENCES pixelapp_p932_workspaces(trip_id),
        dataset text NOT NULL, row_id text NOT NULL, row_order bigint NOT NULL,
        payload jsonb NOT NULL, version bigint NOT NULL DEFAULT 1,
        PRIMARY KEY (trip_id,dataset,row_id))""")

def _p932_assert(trip_id):
    if trip_id != _P932_TRIP:
        raise HTTPException(403,'P93.2 е разрешен само за изричното тестово пътуване.')

@app.post('/safe/p932-workspace/{trip_id}', dependencies=[Depends(authorize)])
def p932_prepare(trip_id:str):
    _p932_assert(trip_id)
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p932_schema(cur)
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s',(trip_id,))
            exists=cur.fetchone()
            if exists:
                return {'ok':True,'existing':True,'revision':exists[0]}
            cur.execute('SELECT digest FROM pixelapp_p930_test_stage WHERE trip_id=%s',(trip_id,))
            source=cur.fetchone()
            if not source:raise HTTPException(409,'Първо създай проверено P93.0 копие.')
            cur.execute('SELECT kind,ord,payload FROM pixelapp_p930_test_rows WHERE trip_id=%s ORDER BY kind,ord',(trip_id,))
            rows={kind:[] for kind in _P930_KINDS}
            records=cur.fetchall()
            for kind,order,row in records:rows[kind].append(row)
            if _p930_digest(rows)!=source[0]:raise HTTPException(409,'P93.0 копието не съвпада с оригинала.')
            cur.execute('INSERT INTO pixelapp_p932_workspaces (trip_id,source_digest) VALUES (%s,%s)',(trip_id,source[0]))
            for kind,order,row in records:
                cur.execute('INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload) VALUES (%s,%s,%s,%s,%s)',
                            (trip_id,kind,uuid.uuid4().hex,order,Jsonb(row)))
        conn.commit()
    return {'ok':True,'existing':False,'revision':1}

@app.get('/safe/p932-workspace/{trip_id}',dependencies=[Depends(authorize)])
def p932_read(trip_id:str):
    _p932_assert(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT source_digest,revision FROM pixelapp_p932_workspaces WHERE trip_id=%s',(trip_id,))
            meta=cur.fetchone()
            if not meta:raise HTTPException(404,'Първо създай P93.2 работно копие.')
            cur.execute('SELECT dataset,row_id,payload,version FROM pixelapp_p932_rows WHERE trip_id=%s ORDER BY dataset,row_order,row_id',(trip_id,))
            rows={k:[] for k in _P930_KINDS}
            for kind,row_id,payload,version in cur.fetchall():rows[kind].append({'row_id':row_id,'data':payload,'version':version})
    return {'ok':True,'trip_id':trip_id,'revision':meta[1],'source_digest':meta[0],
            'records':rows,'live_switch':False,'production_modified':False}

@app.post('/safe/p932-record',dependencies=[Depends(authorize)])
def p932_change(change:P924Change, background_tasks:BackgroundTasks):
    _p932_assert(change.trip_id)
    if change.dataset!='expenses':raise HTTPException(403,'P93.2 разрешава само редакции на тестовите разходи.')
    if change.operation not in ('add','edit','delete'):raise HTTPException(422,'Невалидно действие.')
    if change.operation!='add' and (not change.row_id or change.expected_version is None or change.expected_version<1):
        raise HTTPException(422,'Изисква се актуална версия на записа.')
    if change.operation!='delete':
        if not isinstance(change.row,dict) or set(change.row)!=set(COLUMNS['expenses']):
            raise HTTPException(422,'Невалидни колони в разхода.')
        if change.row.get('trip_id')!=change.trip_id or any(not isinstance(v,str) for v in change.row.values()):
            raise HTTPException(422,'Невалидни стойности за тестовото пътуване.')
        if len(json.dumps(change.row,ensure_ascii=False))>12000:raise HTTPException(422,'Твърде голям разход.')
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s FOR UPDATE',(change.trip_id,))
            if not cur.fetchone():raise HTTPException(409,'Първо подготви P93.2 копие.')
            cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='settings'",(change.trip_id,))
            st=cur.fetchone()
            if st and (str(st[0].get('trip_finished','')).lower()=='да' or float(st[0].get('end_km') or 0)>0):
                raise HTTPException(409,'Тестовото пътуване е приключено и заключено.')
            if change.operation=='add':
                rid=uuid.uuid4().hex
                cur.execute("SELECT COALESCE(MAX(row_order),-1)+1 FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses'",(change.trip_id,))
                order=cur.fetchone()[0]
                cur.execute('INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload) VALUES (%s,%s,%s,%s,%s)',
                            (change.trip_id,'expenses',rid,order,Jsonb(change.row)))
                version=1
            elif change.operation=='edit':
                cur.execute("UPDATE pixelapp_p932_rows SET payload=%s,version=version+1 WHERE trip_id=%s AND dataset='expenses' AND row_id=%s AND version=%s RETURNING version",
                            (Jsonb(change.row),change.trip_id,change.row_id,change.expected_version))
                result=cur.fetchone()
                if not result:raise HTTPException(409,'Записът е променен от другия профил. Обнови.')
                rid=change.row_id;version=result[0]
            else:
                cur.execute("DELETE FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses' AND row_id=%s AND version=%s RETURNING version",
                            (change.trip_id,change.row_id,change.expected_version))
                if not cur.fetchone():raise HTTPException(409,'Записът е променен от другия профил. Обнови.')
                rid=change.row_id;version=None
            cur.execute('UPDATE pixelapp_p932_workspaces SET revision=revision+1,updated_at=now() WHERE trip_id=%s RETURNING revision',(change.trip_id,))
            revision=cur.fetchone()[0]
            _p932_backup_schema(cur)
            cur.execute("""INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,%s) ON CONFLICT(trip_id) DO UPDATE SET wanted_revision=GREATEST(pixelapp_p932_backup_state.wanted_revision,excluded.wanted_revision),last_error=NULL""",(change.trip_id,revision))
        conn.commit()
    background_tasks.add_task(_p932_backup_worker,change.trip_id)
    return {'ok':True,'row_id':rid,'version':version,'revision':revision,
            'drive_modified':False,'stage_modified':False,'production_modified':False,
            'backup_required':True}


# P93.2 isolated backup queue, independent of P92.8/P92.4.
def _p932_backup_schema(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_p932_backup_state(
        trip_id text PRIMARY KEY REFERENCES pixelapp_p932_workspaces(trip_id),
        wanted_revision bigint NOT NULL DEFAULT 1,
        archived_revision bigint NOT NULL DEFAULT 0,
        archive_file text, last_error text, updated_at timestamptz DEFAULT now())""")

def _p932_backup_document(trip_id):
    # Internal backup worker also serves explicitly enabled P94.1 workspaces.
    # The external legacy P93.2 endpoints retain their strict test-only guard.
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT source_digest,revision FROM pixelapp_p932_workspaces WHERE trip_id=%s',(trip_id,))
            meta=cur.fetchone()
            if meta is None:raise HTTPException(404,'Няма P93.2 копие.')
            cur.execute('SELECT dataset,row_id,row_order,payload,version FROM pixelapp_p932_rows WHERE trip_id=%s ORDER BY dataset,row_order,row_id',(trip_id,))
            records=[{'dataset':k,'row_id':rid,'row_order':ord,'payload':p,'version':v} for k,rid,ord,p,v in cur.fetchall()]
    return {'format':'pixelapp-p932-test-workspace','schema_version':1,'trip_id':trip_id,
            'source_digest':meta[0],'revision':meta[1],'records':records}

def _p932_backup_worker(trip_id):
    # Errors are recorded; writes to Neon are already committed.
    try:
        from googleapiclient.http import MediaIoBaseUpload
        from datetime import datetime,timezone
        doc=_p932_backup_document(trip_id)
        service=drive_service()
        if service is None:raise RuntimeError('Drive не е свързан')
        raw=json.dumps(doc,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf-8')
        sha=hashlib.sha256(raw).hexdigest()
        root,_=folder_and_files(service)
        folder_name='PixelApp_Neon_Test_Backups'
        found=service.files().list(q="'%s' in parents and name = '%s' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"%(root,folder_name),fields='files(id)',pageSize=20).execute().get('files',[])
        folder=found[0]['id'] if found else service.files().create(body={'name':folder_name,'mimeType':'application/vnd.google-apps.folder','parents':[root]},fields='id').execute()['id']
        name='p932_workspace_'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S_%fZ')+'_'+sha[:12]+'.json'
        created=service.files().create(body={'name':name,'parents':[folder],'description':'Verified isolated P93.2 TEST migration workspace'},media_body=MediaIoBaseUpload(io.BytesIO(raw),mimetype='application/json',resumable=False),fields='id').execute()
        downloaded=service.files().get_media(fileId=created['id']).execute()
        if downloaded!=raw or hashlib.sha256(downloaded).hexdigest()!=sha:raise RuntimeError('Проверка на архива неуспешна')
        with _neon_demo_connection() as conn:
            with conn.cursor() as cur:
                _p932_backup_schema(cur)
                cur.execute("""UPDATE pixelapp_p932_backup_state SET archived_revision=GREATEST(archived_revision,%s),archive_file=%s,last_error=NULL,updated_at=now() WHERE trip_id=%s""",(doc['revision'],name,trip_id))
            conn.commit()
    except Exception as e:
        try:
            with _neon_demo_connection() as conn:
                with conn.cursor() as cur:
                    _p932_backup_schema(cur)
                    cur.execute('UPDATE pixelapp_p932_backup_state SET last_error=%s,updated_at=now() WHERE trip_id=%s',(str(e)[:240],trip_id))
                conn.commit()
        except Exception:pass

@app.get('/safe/p932-backup-status/{trip_id}',dependencies=[Depends(authorize)])
def p932_backup_status(trip_id:str):
    _p932_assert(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p932_backup_schema(cur)
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s',(trip_id,))
            meta=cur.fetchone()
            if not meta:raise HTTPException(404,'Няма P93.2 копие')
            cur.execute('SELECT wanted_revision,archived_revision,archive_file,last_error FROM pixelapp_p932_backup_state WHERE trip_id=%s',(trip_id,))
            row=cur.fetchone()
    return {'revision':meta[0],'wanted_revision':row[0] if row else meta[0],
            'archived_revision':row[1] if row else 0,'archive_file':row[2] if row else None,
            'last_error':row[3] if row else None,
            'up_to_date':bool(row and row[1]>=meta[0]),'scope':'p932-test-only'}

@app.post('/safe/p932-backup-retry/{trip_id}',dependencies=[Depends(authorize)])
def p932_backup_retry(trip_id:str,background_tasks:BackgroundTasks):
    _p932_assert(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p932_backup_schema(cur)
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s',(trip_id,))
            found=cur.fetchone()
            if not found:raise HTTPException(404,'Няма P93.2 копие')
            cur.execute("""INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,%s)
                ON CONFLICT(trip_id) DO UPDATE SET wanted_revision=GREATEST(pixelapp_p932_backup_state.wanted_revision,excluded.wanted_revision)""",(trip_id,found[0]))
        conn.commit()
    background_tasks.add_task(_p932_backup_worker,trip_id)
    return {'ok':True,'queued':True,'revision':found[0]}


# P93.3 — immutable batch stage of the remaining eight trips. No live source switching.
_P933_EXCLUDED = 'ТЕСТ_НОВО_–_PixelApp'

def _p933_schema(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_p933_stage (
        trip_id text PRIMARY KEY, digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS pixelapp_p933_rows (
        trip_id text NOT NULL REFERENCES pixelapp_p933_stage(trip_id),
        kind text NOT NULL, ord bigint NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY (trip_id,kind,ord))""")

def _p933_groups_from_drive():
    service=drive_service()
    if service is None:raise HTTPException(503,'Google Drive не е достъпен.')
    _,mapping=folder_and_files(service)
    all_rows={}
    for kind in _P930_KINDS:
        filename=FILENAMES[kind]
        if filename not in mapping:
            if kind in ('settings','expenses','budgets'):
                raise HTTPException(409,'Липсва задължителен Drive CSV: '+filename)
            all_rows[kind]=[]
            continue
        raw=service.files().get_media(fileId=mapping[filename]).execute()
        reader=csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
        if not reader.fieldnames or any(col not in reader.fieldnames for col in COLUMNS[kind]):
            raise HTTPException(409,'Невалиден Drive CSV: '+filename)
        rows=list(reader)
        if any(None in row for row in rows):raise HTTPException(409,'Невалиден CSV ред: '+filename)
        all_rows[kind]=rows
    ids=[str(row.get('trip_id','')).strip() for row in all_rows['settings']]
    if len(ids)!=9 or len(set(ids))!=9 or _P933_EXCLUDED not in ids or any(not item for item in ids):
        raise HTTPException(409,'Очаквани са точно 9 уникални пътувания, включително тестовото. Нищо не е копирано.')
    target_ids=sorted(tid for tid in ids if tid!=_P933_EXCLUDED)
    groups={tid:{kind:[] for kind in _P930_KINDS} for tid in target_ids}
    for kind,rows in all_rows.items():
        for row in rows:
            tid=str(row.get('trip_id','')).strip()
            if tid in groups:groups[tid][kind].append(row)
    return groups

@app.post('/safe/p933-stage-remaining',dependencies=[Depends(authorize)])
def p933_stage_remaining():
    from psycopg.types.json import Jsonb
    source=_p933_groups_from_drive()
    results=[]
    # One transaction: any conflict aborts ALL new staging inserts.
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p933_schema(cur)
            cur.execute("SELECT pg_advisory_xact_lock(hashtext('pixelapp-p933-batch'))")
            for tid,groups in source.items():
                digest=_p930_digest(groups)
                cur.execute('SELECT digest FROM pixelapp_p933_stage WHERE trip_id=%s FOR UPDATE',(tid,))
                old=cur.fetchone()
                if old and old[0]!=digest:
                    raise HTTPException(409,'Drive е променен след първото копиране на '+tid+'. Не е презаписано нищо; необходим е нов безопасен преглед.')
                if not old:
                    cur.execute('INSERT INTO pixelapp_p933_stage(trip_id,digest) VALUES (%s,%s)',(tid,digest))
                    for kind,items in groups.items():
                        for idx,row in enumerate(items):
                            cur.execute('INSERT INTO pixelapp_p933_rows(trip_id,kind,ord,payload) VALUES (%s,%s,%s,%s)',(tid,kind,idx,Jsonb(row)))
                cur.execute('SELECT kind,payload FROM pixelapp_p933_rows WHERE trip_id=%s ORDER BY kind,ord',(tid,))
                actual={kind:[] for kind in _P930_KINDS}
                for kind,payload in cur.fetchall():actual[kind].append(payload)
                if _p930_digest(actual)!=digest:
                    raise HTTPException(409,'Копието не премина проверката: '+tid)
                results.append({'trip_id':tid,'verified':True,'new':not bool(old),
                                'counts':{kind:len(rows) for kind,rows in groups.items()}})
        conn.commit()
    return {'ok':True,'staged_count':len(results),'trips':results,
            'production_modified':False,'drive_modified':False,'live_switch':False,
            'p930_modified':False,'p932_modified':False,
            'message':'Осем отделни Neon копия са проверени. Реалните екрани още използват Drive.'}

@app.get('/safe/p933-stage-remaining',dependencies=[Depends(authorize)])
def p933_verify_remaining():
    source=_p933_groups_from_drive()
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.pixelapp_p933_stage')::text")
            if cur.fetchone()[0] is None:
                return {'ok':False,'staged_count':0,'trips':[],'live_switch':False}
            results=[]
            for tid,groups in source.items():
                cur.execute('SELECT digest FROM pixelapp_p933_stage WHERE trip_id=%s',(tid,))
                row=cur.fetchone()
                if not row:
                    results.append({'trip_id':tid,'verified':False,'reason':'Няма копие'})
                    continue
                cur.execute('SELECT kind,payload FROM pixelapp_p933_rows WHERE trip_id=%s ORDER BY kind,ord',(tid,))
                staged={k:[] for k in _P930_KINDS}
                for kind,payload in cur.fetchall():staged[kind].append(payload)
                ok=_p930_digest(staged)==row[0]==_p930_digest(groups)
                results.append({'trip_id':tid,'verified':ok,
                                'reason':None if ok else 'Копието или Drive са променени'})
    return {'ok':all(t['verified'] for t in results),'staged_count':sum(t['verified'] for t in results),
            'trips':results,'live_switch':False,'drive_modified':False,'production_modified':False}


# P93.4.1 — read-only canary for the meaningful test trip, sourced from P93.0.
_P934_CANARY = 'ТЕСТ_НОВО_–_PixelApp'

@app.get('/safe/p934-canary-preview/{trip_id}', dependencies=[Depends(authorize)])
def p934_canary_preview(trip_id: str):
    if trip_id != _P934_CANARY:
        raise HTTPException(403, 'P93.4.1 е разрешен само за тестовото пътуване.')
    # Compare both immutable Neon staging and the latest Drive records. No writes.
    current = _p930_load_drive_trip(trip_id)
    current_digest = _p930_digest(current)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.pixelapp_p930_test_stage')::text")
            if cur.fetchone()[0] is None:
                raise HTTPException(409, 'Липсва провереното P93.0 копие.')
            cur.execute('SELECT digest FROM pixelapp_p930_test_stage WHERE trip_id=%s', (trip_id,))
            found = cur.fetchone()
            if not found:
                raise HTTPException(409, 'Пътуването няма P93.0 копие.')
            cur.execute('SELECT kind,ord,payload FROM pixelapp_p930_test_rows WHERE trip_id=%s ORDER BY kind,ord', (trip_id,))
            staged = {k: [] for k in _P930_KINDS}
            for kind, _, payload in cur.fetchall():
                if kind not in staged:
                    raise HTTPException(409, 'Непознат тип запис в Neon копието.')
                staged[kind].append(payload)
    if _p930_digest(staged) != found[0] or current_digest != found[0]:
        raise HTTPException(409, 'Drive е променен или Neon копието не съвпада. Прегледът е блокиран; няма промени.')
    return {'ok': True, 'readonly': True, 'trip_id': trip_id,
            'records': staged, 'source': 'p930_stage', 'matched_current_drive': True,
            'message': 'P93.4.1: проверено Neon копие, само за преглед; Drive остава основен източник.'}


# P93.8: budget mode writes on the isolated P93.2 workspace only.
class P938BudgetChange(BaseModel):
    trip_id: str
    expected_revision: int
    mode: str
    amount: str = '0'
    categories: dict[str,str] = Field(default_factory=dict)

@app.post('/safe/p938-test-budget', dependencies=[Depends(authorize)])
def p938_test_budget(change:P938BudgetChange, background_tasks:BackgroundTasks):
    _p932_assert(change.trip_id)
    if change.mode not in ('global','category') or change.expected_revision < 1:
        raise HTTPException(422,'Невалиден режим или версия.')
    def checked(v):
        try:
            n=Decimal(str(v).replace(',','.'))
            if not n.is_finite() or n < 0 or n > 10000000 or n.as_tuple().exponent < -2:raise ValueError()
            return str(n)
        except (InvalidOperation,ValueError):raise HTTPException(422,'Невалидна сума на бюджет.')
    if change.mode=='global':
        rows=[{'trip_id':change.trip_id,'category':'__GLOBAL__','budget':checked(change.amount)}]
    else:
        if not change.categories or len(change.categories)>60:raise HTTPException(422,'Добави бюджет по категории.')
        rows=[]
        for category,value in change.categories.items():
            if not isinstance(category,str) or not category.strip() or category=='__GLOBAL__' or len(category)>80:
                raise HTTPException(422,'Невалидна категория.')
            rows.append({'trip_id':change.trip_id,'category':category,'budget':checked(value)})
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s FOR UPDATE',(change.trip_id,))
            meta=cur.fetchone()
            if not meta or meta[0]!=change.expected_revision:
                raise HTTPException(409,'Пътуването е променено от другия профил. Обнови и опитай пак.')
            cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='settings'",(change.trip_id,))
            st=cur.fetchone()
            if st and (str(st[0].get('trip_finished','')).lower()=='да' or float(st[0].get('end_km') or 0)>0):
                raise HTTPException(409,'Тестовото пътуване е приключено и заключено.')
            cur.execute("DELETE FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='budgets'",(change.trip_id,))
            for i,row in enumerate(rows):
                cur.execute('INSERT INTO pixelapp_p932_rows (trip_id,dataset,row_id,row_order,payload) VALUES (%s,%s,%s,%s,%s)',(change.trip_id,'budgets',uuid.uuid4().hex,i,Jsonb(row)))
            cur.execute('UPDATE pixelapp_p932_workspaces SET revision=revision+1,updated_at=now() WHERE trip_id=%s RETURNING revision',(change.trip_id,))
            revision=cur.fetchone()[0]
            _p932_backup_schema(cur)
            cur.execute("""INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,%s) ON CONFLICT(trip_id) DO UPDATE SET wanted_revision=GREATEST(pixelapp_p932_backup_state.wanted_revision,excluded.wanted_revision),last_error=NULL""",(change.trip_id,revision))
        conn.commit()
    background_tasks.add_task(_p932_backup_worker,change.trip_id)
    return {'ok':True,'revision':revision,'drive_modified':False,'backup_required':True}


# P93.9: car lifecycle operations on the isolated P93.2 test copy only.
# Drive CSV, original P93.0 stage and every other trip are untouched.
class P939CarChange(BaseModel):
    trip_id: str
    expected_revision: int
    operation: str
    liters: str = '0'
    amount: str = '0'
    end_km: str = '0'

def _p939_decimal(value, maximum, allow_zero=False):
    try:
        number=Decimal(str(value).replace(',','.'))
        if not number.is_finite() or number<0 or (not allow_zero and number==0) or number>maximum or number.as_tuple().exponent < -2:
            raise ValueError()
        return number
    except (ValueError, InvalidOperation, TypeError):
        raise HTTPException(422,'Невалидна числова стойност.')

@app.post('/safe/p939-car-test', dependencies=[Depends(authorize)])
def p939_car_test(change:P939CarChange,background_tasks:BackgroundTasks):
    _p932_assert(change.trip_id)
    if change.operation not in ('missed_fuel','finish') or change.expected_revision<1:
        raise HTTPException(422,'Невалидна тестова операция или версия.')
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s FOR UPDATE',(change.trip_id,))
            meta=cur.fetchone()
            if not meta or meta[0]!=change.expected_revision:
                raise HTTPException(409,'Другият профил е променил пътуването. Обнови Neon и опитай отново.')
            cur.execute("SELECT row_id,payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='settings' FOR UPDATE",(change.trip_id,))
            settings_rows=cur.fetchall()
            if len(settings_rows)!=1:raise HTTPException(409,'Тестовите автомобилни настройки не са еднозначни.')
            settings_id,settings=settings_rows[0]
            if str(settings.get('car_trip','')).strip().lower()!='да':
                raise HTTPException(409,'Това не е автомобилно пътуване.')
            if str(settings.get('trip_finished','')).lower()=='да' or Decimal(str(settings.get('end_km') or 0).replace(',','.'))>0:
                raise HTTPException(409,'Пътуването е приключено и е заключено.')
            start=_p939_decimal(settings.get('start_km') or 0,100000000,True)
            cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses'",(change.trip_id,))
            expenses=[r[0] for r in cur.fetchall()]
            if change.operation=='initial_fuel':
                liters=_p939_decimal(change.liters,500,True)
                settings['manual_fuel']=str(liters)
            elif change.operation=='missed_fuel':
                liters=_p939_decimal(change.liters,500)
                amount=_p939_decimal(change.amount,10000,True)
                # Existing app treats missing refuels through the special marker and empty odometer.
                row={'trip_id':change.trip_id,'date':datetime.now(timezone.utc).date().isoformat(),
                     'amount':str(amount),'category':'Транспорт','description':'[ПРОПУСНАТО ГОРИВО] тест P93.9',
                     'type':'expense','liters':str(liters),'current_km':''}
                cur.execute('SELECT COALESCE(MAX(row_order),-1)+1 FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset=%s',(change.trip_id,'expenses'))
                order=cur.fetchone()[0]
                cur.execute('INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload) VALUES(%s,%s,%s,%s,%s)',
                            (change.trip_id,'expenses',uuid.uuid4().hex,order,Jsonb(row)))
            else:
                end=_p939_decimal(change.end_km,100000000)
                latest=start
                for row in expenses:
                    try:latest=max(latest,Decimal(str(row.get('current_km') or 0).replace(',','.')))
                    except (ValueError,InvalidOperation,TypeError):raise HTTPException(409,'Невалиден километраж в съществуващо зареждане.')
                if end<=latest or end!=end.to_integral_value():
                    raise HTTPException(422,'Крайният километраж трябва да е цяло число, по-голямо от началния и всички зареждания.')
                settings['end_km']=str(int(end));settings['trip_finished']='Да'
            if change.operation!='missed_fuel':
                cur.execute('UPDATE pixelapp_p932_rows SET payload=%s,version=version+1 WHERE trip_id=%s AND dataset=%s AND row_id=%s',
                            (Jsonb(settings),change.trip_id,'settings',settings_id))
            cur.execute('UPDATE pixelapp_p932_workspaces SET revision=revision+1,updated_at=now() WHERE trip_id=%s RETURNING revision',(change.trip_id,))
            revision=cur.fetchone()[0]
            _p932_backup_schema(cur)
            cur.execute("""INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,%s)
              ON CONFLICT(trip_id) DO UPDATE SET wanted_revision=GREATEST(pixelapp_p932_backup_state.wanted_revision,excluded.wanted_revision),last_error=NULL""",
              (change.trip_id,revision))
        conn.commit()
    background_tasks.add_task(_p932_backup_worker,change.trip_id)
    return {'ok':True,'revision':revision,'operation':change.operation,'backup_required':True,'drive_modified':False}


# P94.0 — common, authenticated, verified READ interface for all nine staged trips.
# This endpoint deliberately does not enable writes or choose Neon for live traffic.
# It reuses P93.0 / P93.3 immutable tables; no new data copies or migrations.
@app.get('/safe/neon/trip-snapshot/{trip_id}', dependencies=[Depends(authorize)])
def neon_trip_snapshot(trip_id: str):
    if not trip_id or len(trip_id) > 220 or '/' in trip_id:
        raise HTTPException(400, 'Невалиден идентификатор на пътуване.')
    if trip_id == _P933_EXCLUDED:
        live = _p930_load_drive_trip(trip_id)
        meta_table, rows_table = 'pixelapp_p930_test_stage', 'pixelapp_p930_test_rows'
    else:
        # Checking all nine source identifiers first prevents foreign/orphan rows
        # from being exposed as an apparently valid trip.
        groups = _p933_groups_from_drive()
        if trip_id not in groups:
            raise HTTPException(404, 'Няма такова пътуване в Google Drive.')
        live = groups[trip_id]
        meta_table, rows_table = 'pixelapp_p933_stage', 'pixelapp_p933_rows'
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT to_regclass(%s)::text', ('public.' + meta_table,))
            if cur.fetchone()[0] is None:
                raise HTTPException(409, 'Не е подготвено проверено Neon копие.')
            cur.execute('SELECT digest FROM ' + meta_table + ' WHERE trip_id=%s', (trip_id,))
            found = cur.fetchone()
            if not found:
                raise HTTPException(409, 'Липсва Neon копие на пътуването.')
            cur.execute('SELECT kind,payload FROM ' + rows_table + ' WHERE trip_id=%s ORDER BY kind,ord', (trip_id,))
            staged = {kind: [] for kind in _P930_KINDS}
            for kind, payload in cur.fetchall():
                if kind not in staged:
                    raise HTTPException(409, 'Неочакван тип запис в Neon копието.')
                staged[kind].append(payload)
    digest = _p930_digest(staged)
    if digest != found[0] or digest != _p930_digest(live):
        raise HTTPException(409, 'Drive или Neon се е променил след копирането; зареждането е блокирано.')
    return {'ok': True, 'trip_id': trip_id, 'records': staged,
            'source': 'verified_neon_stage', 'readonly': True,
            'matches_current_drive': True, 'writes_enabled': False,
            'production_switched': False}


# P94.1: shared WRITE foundation. No live UI cutover and no CSV modifications.
# Only the long-running test trip is enabled by default. An operator may explicitly
# enable other trip IDs using PIXELAPP_NEON_WRITE_TRIPS (semicolon-separated IDs)
# after independent review of their backup and migration readiness.
def _p941_write_allowed(trip_id):
    configured = os.environ.get('PIXELAPP_NEON_WRITE_TRIPS', _P932_TRIP)
    allowed = {v.strip() for v in configured.split(';') if v.strip()}
    if trip_id not in allowed or len(trip_id) > 220 or '/' in trip_id:
        raise HTTPException(403, 'Neon записът не е разрешен за това пътуване.')


def _p941_stage_source(trip_id):
    # Resolve one immutable and verified source without creating new staging tables.
    if trip_id == _P932_TRIP:
        return 'pixelapp_p930_test_stage', 'pixelapp_p930_test_rows'
    return 'pixelapp_p933_stage', 'pixelapp_p933_rows'


@app.post('/safe/neon/workspace/{trip_id}', dependencies=[Depends(authorize)])
def neon_prepare_workspace(trip_id: str):
    """Idempotent setup for a pre-authorized trip; does not change live data."""
    _p941_write_allowed(trip_id)
    from psycopg.types.json import Jsonb
    live = _p930_load_drive_trip(trip_id)
    digest = _p930_digest(live)
    meta_table, rows_table = _p941_stage_source(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p932_schema(cur)
            cur.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('p941:' + trip_id,))
            cur.execute('SELECT source_digest,revision FROM pixelapp_p932_workspaces WHERE trip_id=%s', (trip_id,))
            existing = cur.fetchone()
            if existing:
                # Do not reset edited workspaces or quietly merge different histories.
                return {'ok': True, 'existing': True, 'revision': existing[1],
                        'production_switched': False, 'drive_modified': False}
            cur.execute('SELECT to_regclass(%s)::text', ('public.' + meta_table,))
            if cur.fetchone()[0] is None:
                raise HTTPException(409, 'Липсва проверено миграционно копие.')
            cur.execute('SELECT digest FROM ' + meta_table + ' WHERE trip_id=%s', (trip_id,))
            found = cur.fetchone()
            if not found or found[0] != digest:
                raise HTTPException(409, 'Drive се е променил спрямо миграционното копие.')
            cur.execute('SELECT kind,ord,payload FROM ' + rows_table +
                        ' WHERE trip_id=%s ORDER BY kind,ord', (trip_id,))
            source = cur.fetchall()
            groups = {kind: [] for kind in _P930_KINDS}
            for kind, order, payload in source:
                if kind not in groups:
                    raise HTTPException(409, 'Непознат вид данни.')
                groups[kind].append(payload)
            if _p930_digest(groups) != digest:
                raise HTTPException(409, 'Neon копието не премина проверката.')
            cur.execute('INSERT INTO pixelapp_p932_workspaces(trip_id,source_digest) VALUES(%s,%s)', (trip_id,digest))
            for kind,order,payload in source:
                cur.execute('INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload) VALUES(%s,%s,%s,%s,%s)',
                            (trip_id,kind,uuid.uuid4().hex,order,Jsonb(payload)))
            _p932_backup_schema(cur)
            cur.execute('INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,1)',(trip_id,))
        conn.commit()
    return {'ok': True, 'existing': False, 'revision': 1,
            'production_switched': False, 'drive_modified': False}


@app.get('/safe/neon/workspace/{trip_id}', dependencies=[Depends(authorize)])
def neon_read_workspace(trip_id: str):
    _p941_write_allowed(trip_id)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s', (trip_id,))
            found = cur.fetchone()
            if not found:
                raise HTTPException(404, 'Няма подготвено работно Neon копие.')
            cur.execute('SELECT dataset,row_id,payload,version FROM pixelapp_p932_rows WHERE trip_id=%s ORDER BY dataset,row_order,row_id', (trip_id,))
            rows = {kind: [] for kind in _P930_KINDS}
            for kind,row_id,payload,version in cur.fetchall():
                if kind not in rows:
                    raise HTTPException(409, 'Неочакван вид данни.')
                rows[kind].append({'row_id':row_id,'data':payload,'version':version})
    return {'ok':True,'trip_id':trip_id,'revision':found[0],'records':rows,
            'production_switched':False,'drive_modified':False}


@app.post('/safe/neon/expense', dependencies=[Depends(authorize)])
def neon_shared_expense(change: P924Change, background_tasks: BackgroundTasks):
    """Common optimistic-locking expense writer. Existing live Drive path unaffected."""
    _p941_write_allowed(change.trip_id)
    if change.dataset != 'expenses' or change.operation not in ('add','edit','delete'):
        raise HTTPException(422, 'Разрешени са само операции с разходи.')
    if change.operation != 'add' and (not change.row_id or change.expected_version is None or change.expected_version < 1):
        raise HTTPException(422, 'Изисква се версия на записа.')
    if change.operation != 'delete':
        if not isinstance(change.row, dict) or set(change.row) != set(COLUMNS['expenses']):
            raise HTTPException(422, 'Невалидни колони на разхода.')
        if change.row.get('trip_id') != change.trip_id or any(not isinstance(v,str) for v in change.row.values()):
            raise HTTPException(422, 'Невалидни стойности.')
        if len(json.dumps(change.row,ensure_ascii=False)) > 12000:
            raise HTTPException(422, 'Твърде голям запис.')
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s FOR UPDATE', (change.trip_id,))
            if not cur.fetchone():
                raise HTTPException(409, 'Първо подготви Neon работното копие.')
            cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='settings'", (change.trip_id,))
            settings = cur.fetchone()
            if settings and (str(settings[0].get('trip_finished','')).lower()=='да' or float(settings[0].get('end_km') or 0)>0):
                raise HTTPException(409, 'Завършеното пътуване е заключено.')
            if change.operation == 'add':
                row_id = uuid.uuid4().hex
                cur.execute("SELECT COALESCE(MAX(row_order),-1)+1 FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses'",(change.trip_id,))
                order = cur.fetchone()[0]
                cur.execute('INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload) VALUES(%s,%s,%s,%s,%s)',
                            (change.trip_id,'expenses',row_id,order,Jsonb(change.row)))
                version = 1
            elif change.operation == 'edit':
                cur.execute("UPDATE pixelapp_p932_rows SET payload=%s,version=version+1 WHERE trip_id=%s AND dataset='expenses' AND row_id=%s AND version=%s RETURNING version",
                            (Jsonb(change.row),change.trip_id,change.row_id,change.expected_version))
                changed = cur.fetchone()
                if not changed: raise HTTPException(409,'Другият профил е променил записа. Обнови данните.')
                row_id,version = change.row_id,changed[0]
            else:
                cur.execute("DELETE FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses' AND row_id=%s AND version=%s RETURNING version",
                            (change.trip_id,change.row_id,change.expected_version))
                if not cur.fetchone(): raise HTTPException(409,'Другият профил е променил записа. Обнови данните.')
                row_id,version = change.row_id,None
            cur.execute('UPDATE pixelapp_p932_workspaces SET revision=revision+1,updated_at=now() WHERE trip_id=%s RETURNING revision',(change.trip_id,))
            revision=cur.fetchone()[0]
            _p932_backup_schema(cur)
            cur.execute("""INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,%s)
                ON CONFLICT(trip_id) DO UPDATE SET wanted_revision=GREATEST(pixelapp_p932_backup_state.wanted_revision,excluded.wanted_revision),last_error=NULL""",
                (change.trip_id,revision))
        conn.commit()
    background_tasks.add_task(_p932_backup_worker,change.trip_id)
    return {'ok':True,'trip_id':change.trip_id,'row_id':row_id,'version':version,
            'revision':revision,'backup_pending':True,'production_switched':False,'drive_modified':False}


# P94.8 — common optimistic-locking writer for non-financial trip collections.
# It is intentionally NOT connected to the production UI until all screen flows
# and the final live-Drive reconciliation are complete. Default allowlist remains
# the existing test trip; no new environment flags or staging tables.
_P948_EDITABLE_COLLECTIONS = frozenset(('budgets', 'tasks', 'points', 'categories'))

@app.post('/safe/neon/collection', dependencies=[Depends(authorize)])
def neon_shared_collection(change: P924Change, background_tasks: BackgroundTasks):
    _p941_write_allowed(change.trip_id)
    if change.dataset not in _P948_EDITABLE_COLLECTIONS:
        raise HTTPException(422, 'Този вид данни не се променя през общия интерфейс.')
    if change.operation not in ('add', 'edit', 'delete'):
        raise HTTPException(422, 'Невалидна операция.')
    if change.operation != 'add' and (not change.row_id or
        change.expected_version is None or change.expected_version < 1):
        raise HTTPException(422, 'Нужна е актуална версия на записа.')
    if change.operation != 'delete':
        if not isinstance(change.row, dict) or set(change.row) != set(COLUMNS[change.dataset]):
            raise HTTPException(422, 'Невалидна структура на записа.')
        if (change.row.get('trip_id') != change.trip_id or
            any(not isinstance(v, str) for v in change.row.values()) or
            len(json.dumps(change.row, ensure_ascii=False)) > 12000):
            raise HTTPException(422, 'Невалидни стойности за пътуването.')
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s FOR UPDATE',
                        (change.trip_id,))
            if not cur.fetchone():
                raise HTTPException(409, 'Липсва проверено Neon работно копие.')
            cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='settings'",
                        (change.trip_id,))
            settings = cur.fetchone()
            if settings and (str(settings[0].get('trip_finished', '')).lower() == 'да' or
                             float(settings[0].get('end_km') or 0) > 0):
                raise HTTPException(409, 'Завършеното пътуване е заключено.')
            if change.operation == 'add':
                row_id = uuid.uuid4().hex
                cur.execute('SELECT COALESCE(MAX(row_order),-1)+1 FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset=%s',
                            (change.trip_id, change.dataset))
                row_order = cur.fetchone()[0]
                cur.execute('INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload) VALUES(%s,%s,%s,%s,%s)',
                            (change.trip_id, change.dataset, row_id, row_order, Jsonb(change.row)))
                version = 1
            elif change.operation == 'edit':
                cur.execute('UPDATE pixelapp_p932_rows SET payload=%s,version=version+1 WHERE trip_id=%s AND dataset=%s AND row_id=%s AND version=%s RETURNING version',
                            (Jsonb(change.row), change.trip_id, change.dataset,
                             change.row_id, change.expected_version))
                result = cur.fetchone()
                if not result:
                    raise HTTPException(409, 'Записът е променен от другия профил. Обнови.')
                row_id, version = change.row_id, result[0]
            else:
                cur.execute('DELETE FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset=%s AND row_id=%s AND version=%s RETURNING version',
                            (change.trip_id, change.dataset, change.row_id, change.expected_version))
                if not cur.fetchone():
                    raise HTTPException(409, 'Записът е променен от другия профил. Обнови.')
                row_id, version = change.row_id, None
            cur.execute('UPDATE pixelapp_p932_workspaces SET revision=revision+1,updated_at=now() WHERE trip_id=%s RETURNING revision',
                        (change.trip_id,))
            revision = cur.fetchone()[0]
            _p932_backup_schema(cur)
            cur.execute("""INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,%s)
                ON CONFLICT(trip_id) DO UPDATE SET
                wanted_revision=GREATEST(pixelapp_p932_backup_state.wanted_revision,excluded.wanted_revision),
                last_error=NULL""", (change.trip_id, revision))
        conn.commit()
    background_tasks.add_task(_p932_backup_worker, change.trip_id)
    return {'ok': True, 'trip_id': change.trip_id, 'dataset': change.dataset,
            'row_id': row_id, 'version': version, 'revision': revision,
            'backup_pending': True, 'production_switched': False,
            'drive_modified': False}


# P95.1 — atomic map actions in the already existing Neon workspace.
# The points CSV contains both route stops and per-trip favorites. Reordering
# therefore must happen as one transaction, not two optimistic row edits.
class P951PointAction(BaseModel):
    trip_id: str
    kind: str
    operation: str
    expected_revision: int
    index: int = -1
    position: int = -1
    title: str = ''
    lat: float = 0
    lon: float = 0
    stop_type: str = 'planned'

@app.post('/safe/neon/points-action', dependencies=[Depends(authorize)])
def neon_points_action(change: P951PointAction, background_tasks: BackgroundTasks):
    _p941_write_allowed(change.trip_id)
    if change.kind not in ('route', 'favorite') or change.operation not in ('add','edit','delete','move'):
        raise HTTPException(422, 'Невалидно действие с картата.')
    if change.operation == 'move' and change.kind != 'route':
        raise HTTPException(422, 'Любимите места не се пренареждат.')
    if change.operation in ('add','edit'):
        if (not change.title.strip() or len(change.title.strip()) > 150 or
            not math.isfinite(change.lat) or not math.isfinite(change.lon) or
            abs(change.lat) > 90 or abs(change.lon) > 180):
            raise HTTPException(422, 'Невалидни координати или име.')
    if change.kind == 'route' and change.operation == 'add' and change.stop_type not in ('planned','unplanned'):
        raise HTTPException(422, 'Невалиден тип спирка.')
    from psycopg.types.json import Jsonb
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s FOR UPDATE', (change.trip_id,))
            meta=cur.fetchone()
            if not meta:raise HTTPException(409, 'Липсва Neon копието.')
            if meta[0] != change.expected_revision:
                raise HTTPException(409, 'Другият профил е променил данните. Обнови картата.')
            cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='settings'",(change.trip_id,))
            settings=cur.fetchone()
            if settings and (str(settings[0].get('trip_finished','')).lower()=='да' or
                             float(settings[0].get('end_km') or 0)>0):
                raise HTTPException(409,'Пътуването е приключено.')
            cur.execute("SELECT row_id,payload,version FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='points' ORDER BY row_order,row_id FOR UPDATE",(change.trip_id,))
            items=[{'id':r[0], 'row':r[1], 'version':r[2]} for r in cur.fetchall()]
            def is_route(entry):
                r=entry['row']
                return str(r.get('title','')).startswith('3b:') and r.get('color') in ('purple','orange')
            matches=[i for i,v in enumerate(items) if is_route(v)==(change.kind=='route')]
            if change.operation != 'add' and not (0<=change.index<len(matches)):
                raise HTTPException(409,'Мястото вече не съществува. Обнови картата.')
            if change.operation=='add':
                name=change.title.strip()
                if change.kind=='favorite' and any(
                    v['row'].get('title','').casefold()==name.casefold() and
                    abs(float(v['row']['lat'])-change.lat)<0.00001 and
                    abs(float(v['row']['lon'])-change.lon)<0.00001 for v in
                    (items[i] for i in matches)):
                    raise HTTPException(409,'Любимото място вече съществува.')
                data={'trip_id':change.trip_id,'lat':str(change.lat),'lon':str(change.lon),
                      'title':('3b: '+name) if change.kind=='route' else name,
                      'color':('purple' if change.stop_type=='planned' else 'orange') if change.kind=='route' else 'blue',
                      'stop_type':change.stop_type if change.kind=='route' else 'favorite'}
                new={'id':uuid.uuid4().hex,'row':data,'version':1,'new':True}
                if change.kind=='favorite':insert=len(items)
                elif change.position<0 or change.position>=len(matches):insert=matches[-1]+1 if matches else len(items)
                else:insert=matches[change.position]
                items.insert(insert,new)
            elif change.operation=='delete':
                items.pop(matches[change.index])
            elif change.operation=='edit':
                old=items[matches[change.index]]
                old['row']={**old['row'],'title':change.title.strip(),'lat':str(change.lat),'lon':str(change.lon)}
                old['version']+=1;old['edited']=True
            else:
                other=change.index+change.position
                if change.position not in (-1,1) or not 0<=other<len(matches):
                    raise HTTPException(422,'Невъзможно преместване.')
                a,b=matches[change.index],matches[other]
                items[a],items[b]=items[b],items[a]
            kept={x['id'] for x in items}
            cur.execute("SELECT row_id FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='points'",(change.trip_id,))
            for (old_id,) in cur.fetchall():
                if old_id not in kept:
                    cur.execute("DELETE FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='points' AND row_id=%s",(change.trip_id,old_id))
            for order,item in enumerate(items):
                if item.get('new'):
                    cur.execute("INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload,version) VALUES(%s,'points',%s,%s,%s,1)",(change.trip_id,item['id'],order,Jsonb(item['row'])))
                elif item.get('edited'):
                    cur.execute("UPDATE pixelapp_p932_rows SET row_order=%s,payload=%s,version=%s WHERE trip_id=%s AND dataset='points' AND row_id=%s",(order,Jsonb(item['row']),item['version'],change.trip_id,item['id']))
                else:
                    cur.execute("UPDATE pixelapp_p932_rows SET row_order=%s WHERE trip_id=%s AND dataset='points' AND row_id=%s",(order,change.trip_id,item['id']))
            cur.execute('UPDATE pixelapp_p932_workspaces SET revision=revision+1,updated_at=now() WHERE trip_id=%s RETURNING revision',(change.trip_id,))
            revision=cur.fetchone()[0]
            _p932_backup_schema(cur)
            cur.execute("""INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,%s)
                ON CONFLICT(trip_id) DO UPDATE SET wanted_revision=GREATEST(pixelapp_p932_backup_state.wanted_revision,excluded.wanted_revision),last_error=NULL""",(change.trip_id,revision))
        conn.commit()
    background_tasks.add_task(_p932_backup_worker,change.trip_id)
    return {'ok':True,'revision':revision,'backup_pending':True,'production_switched':False}


# P94.4 — read-only migration readiness audit. No new copies, flags or live switching.
# A workspace intentionally diverges from the original Drive snapshot after edits;
# compare *stages* with Drive, and assess workspace backup independently.
@app.get('/safe/neon/migration-readiness', dependencies=[Depends(authorize)])
def neon_migration_readiness():
    groups = _p933_groups_from_drive()
    trip_ids = [_P932_TRIP] + sorted(groups)
    if len(trip_ids) != 9:
        raise HTTPException(409, 'Очакват се девет пътувания. Не е извършена промяна.')

    items = []
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            # Treat missing tables as a non-ready state, never create them in a GET.
            table_names = ('pixelapp_p930_test_stage', 'pixelapp_p930_test_rows',
                           'pixelapp_p933_stage', 'pixelapp_p933_rows',
                           'pixelapp_p932_workspaces', 'pixelapp_p932_rows',
                           'pixelapp_p932_backup_state')
            present = {}
            for table in table_names:
                cur.execute('SELECT to_regclass(%s)::text', ('public.' + table,))
                present[table] = bool(cur.fetchone()[0])

            for tid in trip_ids:
                source_meta, source_rows = _p941_stage_source(tid)
                source_complete = present[source_meta] and present[source_rows]
                stage_digest = None
                stage_matches_drive = False
                counts = {kind: 0 for kind in _P930_KINDS}
                if source_complete:
                    cur.execute('SELECT digest FROM ' + source_meta + ' WHERE trip_id=%s', (tid,))
                    stage = cur.fetchone()
                    if stage:
                        stage_digest = stage[0]
                        cur.execute('SELECT kind,payload FROM ' + source_rows +
                                    ' WHERE trip_id=%s ORDER BY kind,ord', (tid,))
                        staged = {kind: [] for kind in _P930_KINDS}
                        invalid_kind = False
                        for kind, payload in cur.fetchall():
                            if kind not in staged:
                                invalid_kind = True
                            else:
                                staged[kind].append(payload)
                        counts = {kind: len(rows) for kind, rows in staged.items()}
                        # Compare to the independently loaded live Drive data.
                        live = _p930_load_drive_trip(tid) if tid == _P932_TRIP else groups[tid]
                        stage_matches_drive = (not invalid_kind and
                                               _p930_digest(staged) == stage_digest and
                                               _p930_digest(live) == stage_digest)

                workspace_revision = None
                workspace_rows = 0
                archived_revision = 0
                backup_error = None
                backup_file = None
                if present['pixelapp_p932_workspaces']:
                    cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s', (tid,))
                    workspace = cur.fetchone()
                    if workspace:
                        workspace_revision = workspace[0]
                        if present['pixelapp_p932_rows']:
                            cur.execute('SELECT count(*) FROM pixelapp_p932_rows WHERE trip_id=%s', (tid,))
                            workspace_rows = cur.fetchone()[0]
                        if present['pixelapp_p932_backup_state']:
                            cur.execute('SELECT archived_revision,archive_file,last_error FROM pixelapp_p932_backup_state WHERE trip_id=%s', (tid,))
                            backup = cur.fetchone()
                            if backup:
                                archived_revision,backup_file,backup_error = backup

                # An up-to-date archive is meaningful only for an existing workspace.
                backup_current = (workspace_revision is not None and
                                  archived_revision >= workspace_revision and
                                  bool(backup_file) and not backup_error)
                items.append({
                    'trip_id': tid,
                    'staged_copy_exists': stage_digest is not None,
                    'stage_matches_live_drive': stage_matches_drive,
                    'staged_record_counts': counts,
                    'workspace_exists': workspace_revision is not None,
                    'workspace_revision': workspace_revision,
                    'workspace_record_count': workspace_rows,
                    'backup_revision': archived_revision,
                    'backup_current': backup_current,
                    'backup_error': backup_error,
                    # No user-visible filenames or permanent Drive links are needed.
                    'safe_to_auto_cutover': False,
                })

    return {
        'ok': True,
        'read_only': True,
        'production_switched': False,
        'trip_count': len(items),
        'stage_matches_drive_count': sum(x['stage_matches_live_drive'] for x in items),
        'workspace_count': sum(x['workspace_exists'] for x in items),
        'backed_up_workspace_count': sum(x['backup_current'] for x in items),
        'all_trips_ready_for_cutover': False,
        'note': ('Readiness only. Existing editable test copy may differ from Drive intentionally. '
                 'Other trips must be reconciled and all data writers migrated before cutover.'),
        'trips': items,
    }



# P94.6 — one guarded preparation operation with independent database readback.
# This endpoint does NOT change the production data source. It stages the eight
# current Drive trips once, verifies all source rows, and reports backup status.
# The operator must explicitly arm the existing P94.5 flag; simply deploying
# this code does not copy, edit, or switch any trips.
@app.post('/safe/neon/execute-preparation', dependencies=[Depends(authorize)])
def neon_execute_preparation(background_tasks: BackgroundTasks):
    if os.environ.get('PIXELAPP_P945_ALLOW_PREPARE', '').strip() != '1':
        raise HTTPException(403, 'Подготовката не е разрешена в Render.')

    # Reuse the existing idempotent P94.5 transaction. In particular, do not
    # overwrite previously existing workspaces or touch original Drive CSVs.
    result = neon_prepare_remaining(background_tasks)
    created = {item['trip_id']: item for item in result['created']}
    existing = {item['trip_id']: item for item in result['already_existing_unchanged']}

    # Verify each newly created Neon workspace against the exact current Drive
    # documents. Re-read the DB itself; an INSERT success alone isn't evidence
    # that the migrated data survived unchanged.
    current = _p933_groups_from_drive()
    verification = []
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            for trip_id in sorted(current):
                cur.execute('SELECT source_digest,revision FROM pixelapp_p932_workspaces WHERE trip_id=%s', (trip_id,))
                meta = cur.fetchone()
                if not meta:
                    verification.append({'trip_id':trip_id,'state':'MISSING','matches_drive_now':False})
                    continue
                cur.execute('SELECT dataset,payload FROM pixelapp_p932_rows WHERE trip_id=%s ORDER BY dataset,row_order,row_id', (trip_id,))
                recovered = {kind: [] for kind in _P930_KINDS}
                unexpected = False
                for dataset,payload in cur.fetchall():
                    if dataset not in recovered:
                        unexpected = True
                    else:
                        recovered[dataset].append(payload)
                digest = _p930_digest(recovered) if not unexpected else None
                source_digest = _p930_digest(current[trip_id])
                exact = digest == meta[0] == source_digest
                cur.execute('SELECT archived_revision,archive_file,last_error FROM pixelapp_p932_backup_state WHERE trip_id=%s', (trip_id,))
                backup = cur.fetchone()
                backup_current = bool(backup and backup[0] >= meta[1] and backup[1] and not backup[2])
                verification.append({
                    'trip_id':trip_id,
                    'state':'CREATED' if trip_id in created else 'EXISTING',
                    'matches_drive_now':exact,
                    'neon_revision':meta[1],
                    'record_count':sum(map(len,recovered.values())),
                    'backup_current':backup_current,
                    'backup_pending':not backup_current,
                    'backup_error':backup[2] if backup else None,
                })

    # Existing workspaces that no longer match Drive remain intact, with an
    # explicit warning. Same for edits performed in Drive during preparation.
    all_match = all(v['matches_drive_now'] for v in verification)
    return {
        'ok':True,
        'created_count':len(created),
        'existing_count':len(existing),
        'neon_readback_matches_current_drive':all_match,
        'verification':verification,
        'drive_originals_modified':False,
        'live_writers_switched':False,
        'backup_queued_for_created':len(created),
        'all_backups_verified':all(v.get('backup_current') for v in verification),
        'requires_reconciliation':not all_match,
        'note':('Резервните копия се правят след HTTP отговора. '
                'Изчакай потвърждение за архивните версии в migration-readiness, '
                'преди каквото и да е превключване на работните екрани.'),
    }

# P94.5 — guarded, idempotent preparation of current Drive data for the 8
# non-test trips. Never rewrites an existing workspace or switches live writers.
@app.post('/safe/neon/prepare-remaining', dependencies=[Depends(authorize)])
def neon_prepare_remaining(background_tasks: BackgroundTasks):
    if os.environ.get('PIXELAPP_P945_ALLOW_PREPARE', '').strip() != '1':
        raise HTTPException(403, 'Подготовката е изключена. Не са променени данни.')

    from psycopg.types.json import Jsonb
    groups = _p933_groups_from_drive()
    if len(groups) != 8 or _P932_TRIP in groups:
        raise HTTPException(409, 'Очакват се осем отделни пътувания.')

    # Drive stays the authority. Read it again just before the transaction to
    # catch ordinary intervening edits; this is not an atomic Drive snapshot.
    fresh = _p933_groups_from_drive()
    if set(fresh) != set(groups) or any(
        _p930_digest(fresh[tid]) != _p930_digest(groups[tid]) for tid in groups
    ):
        raise HTTPException(409, 'Drive се промени по време на подготовката.')

    created = []
    existing = []
    # All new workspaces are inserted in one DB transaction, so failure cannot
    # leave a partly prepared batch. Each existing workspace is left intact.
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            _p932_schema(cur)
            _p932_backup_schema(cur)
            cur.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('p945:prepare-remaining',))
            for tid in sorted(fresh):
                cur.execute('SELECT source_digest,revision FROM pixelapp_p932_workspaces WHERE trip_id=%s FOR UPDATE', (tid,))
                old = cur.fetchone()
                if old:
                    # NEVER overwrite a possibly edited workspace.
                    existing.append({'trip_id': tid, 'revision': old[1],
                                     'source_matches_current_drive': old[0] == _p930_digest(fresh[tid])})
                    continue
                rows = fresh[tid]
                if len(rows['settings']) != 1 or any(
                    row.get('trip_id') != tid for values in rows.values() for row in values
                ):
                    raise HTTPException(409, 'Невалидни данни за пътуване; операцията е отменена.')
                digest = _p930_digest(rows)
                cur.execute('INSERT INTO pixelapp_p932_workspaces(trip_id,source_digest) VALUES(%s,%s)', (tid,digest))
                for kind in _P930_KINDS:
                    for order, payload in enumerate(rows[kind]):
                        cur.execute('INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload) VALUES(%s,%s,%s,%s,%s)',
                                    (tid,kind,uuid.uuid4().hex,order,Jsonb(payload)))
                cur.execute('INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,1) ON CONFLICT (trip_id) DO NOTHING', (tid,))
                created.append({'trip_id':tid,'counts':{k:len(v) for k,v in rows.items()},'revision':1})
        conn.commit()
    for item in created:
        background_tasks.add_task(_p932_backup_worker, item['trip_id'])
    return {'ok':True,'created':created,'already_existing_unchanged':existing,
            'backup_queued_for_created':len(created),
            'backup_verified':False,'drive_modified':False,
            'normal_app_switched':False,
            'note':'Drive остава активен. Преди превключване е нужна повторна проверка за нови Drive редакции и успешни архиви.'}



# P96.2 — verified, read-only REAL-trip Neon screen preview.
# No writes, migrations, environment write allowances, or source switching.
@app.get('/safe/neon/real-trip-preview/{trip_id}', dependencies=[Depends(authorize)])
def p962_real_trip_preview(trip_id: str):
    if not trip_id or trip_id == _P932_TRIP or len(trip_id) > 220 or '/' in trip_id:
        raise HTTPException(400, 'Разрешен е преглед само на осемте съществуващи пътувания.')
    live_trips = _p933_groups_from_drive()
    if trip_id not in live_trips:
        raise HTTPException(404, 'Пътуването не е в осемте проверени източника.')
    live = live_trips[trip_id]
    live_digest = _p930_digest(live)
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            for table in ('pixelapp_p933_stage','pixelapp_p932_workspaces','pixelapp_p932_rows','pixelapp_p932_backup_state'):
                cur.execute('SELECT to_regclass(%s)::text', ('public.' + table,))
                if cur.fetchone()[0] is None:
                    raise HTTPException(409, 'Липсва необходима миграционна таблица.')
            cur.execute('SELECT digest FROM pixelapp_p933_stage WHERE trip_id=%s', (trip_id,))
            stage = cur.fetchone()
            if not stage or stage[0] != live_digest:
                raise HTTPException(409, 'Текущият Google Drive не съвпада с първоначалното Neon копие.')
            cur.execute('SELECT revision,source_digest FROM pixelapp_p932_workspaces WHERE trip_id=%s', (trip_id,))
            meta = cur.fetchone()
            if not meta or meta[1] != live_digest:
                raise HTTPException(409, 'Работното Neon копие не е от проверения източник.')
            revision = meta[0]
            cur.execute('SELECT archived_revision,archive_file,last_error FROM pixelapp_p932_backup_state WHERE trip_id=%s', (trip_id,))
            backup = cur.fetchone()
            if not backup or backup[0] < revision or not backup[1] or backup[2]:
                raise HTTPException(409, 'Резервният архив не е актуален. Прегледът е блокиран.')
            cur.execute('SELECT dataset,payload FROM pixelapp_p932_rows WHERE trip_id=%s ORDER BY dataset,row_order,row_id', (trip_id,))
            records = {kind: [] for kind in _P930_KINDS}
            for kind, payload in cur.fetchall():
                if kind not in records:
                    raise HTTPException(409, 'Непознат вид Neon записи.')
                records[kind].append(payload)
    if len(records['settings']) != 1 or _p930_digest(records) != live_digest:
        raise HTTPException(409, 'Neon и текущият Drive се различават. Прегледът е блокиран.')
    return {
        'ok': True, 'trip_id': trip_id, 'read_only': True, 'source': 'neon_verified_workspace',
        'revision': revision, 'archive_revision': backup[0],
        'exact_match_live_drive': True, 'production_switched': False,
        'records': records,
    }

# P96.8: A single Neon source contract before and after future primary migration.
# No write permissions are granted by this endpoint. Before cutover it retains
# the strict Drive equality gate. After a separately authorized cutover, reads
# must NOT compare mutable Neon data to the original Drive CSVs.
@app.get('/safe/neon/real-trip-source/{trip_id}', dependencies=[Depends(authorize)])
def p968_real_trip_source(trip_id: str):
    if trip_id != _P966_PROTECTED_TRIP:
        raise HTTPException(403, 'Този източник е разрешен само за Livigno.')
    # Zero activation by default. This is a READ contract, not permission to
    # flip the switch; P96.8 does not enable the primary mode in production.
    primary = trip_id in {
        v.strip() for v in os.environ.get('PIXELAPP_NEON_PRIMARY_READ_TRIPS', '').split(';') if v.strip()
    }
    if not primary:
        preview = p962_real_trip_preview(trip_id)
        return {**preview, 'source_mode': 'verified_pre_cutover'}
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision,source_digest FROM pixelapp_p932_workspaces WHERE trip_id=%s', (trip_id,))
            meta=cur.fetchone()
            cur.execute('SELECT digest FROM pixelapp_p933_stage WHERE trip_id=%s',(trip_id,))
            source=cur.fetchone()
            if not meta or not source or meta[1] != source[0]:
                raise HTTPException(409, 'Neon няма потвърден миграционен произход.')
            cur.execute('SELECT archived_revision,archive_file,last_error FROM pixelapp_p932_backup_state WHERE trip_id=%s',(trip_id,))
            backup=cur.fetchone()
            if not backup or not backup[1]:
                raise HTTPException(409, 'Липсва регистриран резервен архив.')
            cur.execute('SELECT dataset,payload FROM pixelapp_p932_rows WHERE trip_id=%s ORDER BY dataset,row_order,row_id',(trip_id,))
            records={kind:[] for kind in _P930_KINDS}
            for kind,payload in cur.fetchall():
                if kind not in records:
                    raise HTTPException(409, 'Неочакван вид Neon записи.')
                records[kind].append(payload)
    if len(records['settings']) != 1:
        raise HTTPException(409, 'Настройките на пътуването са невалидни.')
    return {'ok':True,'trip_id':trip_id,'read_only':True,
            'source_mode':'neon_primary_read_only', 'production_switched':False,
            'exact_match_live_drive':False, 'revision':meta[0],
            'archive_revision':backup[0],
            'archive_current':bool(backup[0]>=meta[0] and not backup[2]),
            'records':records}


# P95.4: read-only preflight for finishing the already migrated test trip.
# This endpoint never updates a row, increments a revision or queues a backup.
def _p954_finished(settings):
    from decimal import Decimal, InvalidOperation
    try:
        end = Decimal(str(settings.get('end_km') or '0').replace(',', '.'))
        return str(settings.get('trip_finished', '')).strip().casefold() == 'да' or end > 0
    except (ValueError, InvalidOperation, TypeError):
        # Malformed lifecycle state must never grant write permission.
        return True


@app.get('/safe/neon/finish-safety/{trip_id}', dependencies=[Depends(authorize)])
def p954_finish_safety(trip_id: str):
    _p941_write_allowed(trip_id)
    # Strict scope: a read-only diagnostic for the existing P95.3 canary only.
    if trip_id != _P932_TRIP:
        raise HTTPException(403, 'Проверката е само за ТЕСТ НОВО.')
    from decimal import Decimal, InvalidOperation
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s', (trip_id,))
            meta = cur.fetchone()
            if not meta:
                raise HTTPException(404, 'Няма Neon работно копие.')
            cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='settings'", (trip_id,))
            settings_rows = cur.fetchall()
            if len(settings_rows) != 1:
                raise HTTPException(409, 'Настройките не са еднозначни.')
            settings = settings_rows[0][0]
            cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses'", (trip_id,))
            expense_rows = [item[0] for item in cur.fetchall()]
    def km_value(value):
        try:
            d = Decimal(str(value or '0').replace(',', '.'))
            if not d.is_finite() or d < 0 or d > 100000000 or d != d.to_integral_value():
                return None
            return int(d)
        except (InvalidOperation, ValueError, TypeError):
            return None
    start = km_value(settings.get('start_km'))
    readings = [km_value(r.get('current_km')) for r in expense_rows if str(r.get('current_km') or '').strip()]
    valid = start is not None and all(v is not None for v in readings)
    last = max([start, *readings]) if valid else None
    finished = _p954_finished(settings)
    is_car = str(settings.get('car_trip', '')).casefold() == 'да'
    can_finish = bool(valid and is_car and not finished)
    # Same lifecycle predicate used for the actual writers. These results
    # simulate the state AFTER finish; they do not execute actual writes.
    simulated = dict(settings, trip_finished='Да', end_km=str((last or 0) + 1))
    locks = {key:_p954_finished(simulated) for key in
             ('разходи', 'задачи и категории', 'бюджет', 'маршрут и любими', 'гориво и настройки')}
    return {'ok':True,'readonly':True,'trip_id':trip_id,'revision':int(meta[0]),
            'finished_now':finished,'can_finish':can_finish,'car_trip':is_car,
            'start_km':start,'last_recorded_km':last,
            'minimum_end_km':max(start+1,last) if can_finish else None,
            'odometer_valid':valid,'simulated_locked':locks,
            'all_simulated_locked':all(locks.values()),'records_changed':False,
            'note':'Само проверка на правилото за заключване. Не изпраща заявки за запис и не доказва реален отказ след приключване.'}


# P95.2 — normal car and fuel writes in the pre-existing Neon workspace.
# Only the explicit test trip is enabled by the P94.1 allowlist; live Drive CSVs
# remain unchanged. No initial-tank-fuel field, and no trip completion here.
class P952FuelAction(BaseModel):
    trip_id: str
    operation: str  # refuel, missed, track_fuel
    expected_revision: int
    amount: str = '0'
    liters: str = '0'
    current_km: str = ''
    full: bool = True
    description: str = ''
    track_fuel: str = ''
    end_km: str = ''
    confirmation: str = ''

@app.post('/safe/neon/car-action', dependencies=[Depends(authorize)])
def p952_car_action(change: P952FuelAction, background_tasks: BackgroundTasks):
    _p941_write_allowed(change.trip_id)
    if change.operation not in ('refuel', 'missed', 'track_fuel', 'finish') or change.expected_revision < 1:
        raise HTTPException(422, 'Невалидна автомобилна операция или версия.')
    from psycopg.types.json import Jsonb
    from decimal import Decimal, InvalidOperation
    def numeric(value, maximum, allow_zero=False):
        try:
            result = Decimal(str(value).replace(',', '.'))
            if not result.is_finite() or result < 0 or (result == 0 and not allow_zero) or result > maximum or result.as_tuple().exponent < -2:
                raise ValueError()
            return result
        except (ValueError, InvalidOperation, TypeError):
            raise HTTPException(422, 'Невалидна сума или количество.')
    if change.operation in ('refuel', 'missed'):
        liters = numeric(change.liters, 200 if change.operation == 'refuel' else 500)
        amount = numeric(change.amount, 100000, True)
    if change.operation == 'refuel':
        if not str(change.current_km).isdigit() or len(str(change.current_km)) > 9:
            raise HTTPException(422, 'Въведи валиден цял километраж.')
        km = int(change.current_km)
        if km <= 0:
            raise HTTPException(422, 'Невалиден километраж.')
        if len(change.description) > 250:
            raise HTTPException(422, 'Описанието е твърде дълго.')
    if change.operation == 'track_fuel' and change.track_fuel not in ('Да', 'Не', 'Добави впоследствие'):
        raise HTTPException(422, 'Невалидна настройка за проследяване на гориво.')
    if change.operation == 'finish':
        if change.confirmation != 'ПРИКЛЮЧИ ПЪТУВАНЕТО':
            raise HTTPException(422, 'Липсва изрично потвърждение за приключване.')
        if not re.fullmatch(r'[0-9]{1,9}', str(change.end_km)):
            raise HTTPException(422, 'Крайният километраж трябва да е цяло число.')
        finish_km = int(change.end_km)
        if finish_km <= 0 or finish_km > 99999999:
            raise HTTPException(422, 'Невалиден краен километраж.')
    with _neon_demo_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM pixelapp_p932_workspaces WHERE trip_id=%s FOR UPDATE', (change.trip_id,))
            found = cur.fetchone()
            if not found or int(found[0]) != change.expected_revision:
                raise HTTPException(409, 'Другият профил е променил данните. Обнови пътуването.')
            cur.execute("SELECT row_id,payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='settings' FOR UPDATE", (change.trip_id,))
            settings_rows = cur.fetchall()
            if len(settings_rows) != 1:
                raise HTTPException(409, 'Настройките на пътуването не са еднозначни.')
            settings_id, settings = settings_rows[0]
            if str(settings.get('car_trip', '')).lower() != 'да':
                raise HTTPException(409, 'Пътуването не е с автомобил.')
            if str(settings.get('trip_finished', '')).lower() == 'да' or numeric(settings.get('end_km') or '0', 100000000, True) > 0:
                raise HTTPException(409, 'Пътуването е приключено.')
            if change.operation == 'finish':
                start = numeric(settings.get('start_km') or '0', 100000000, True)
                cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses'", (change.trip_id,))
                last_km = start
                for (row,) in cur.fetchall():
                    # All actual odometer readings, not manual/missed litres.
                    raw = str(row.get('current_km') or '').strip()
                    if not raw: continue
                    reading = numeric(raw, 100000000, True)
                    if reading != reading.to_integral_value():
                        raise HTTPException(409, 'Невалиден километраж в историята.')
                    last_km = max(last_km, reading)
                if Decimal(finish_km) <= start or Decimal(finish_km) < last_km:
                    raise HTTPException(422, f'Крайните километри трябва да са над началните и поне {int(last_km)} км.')
                settings['end_km'] = str(finish_km)
                settings['trip_finished'] = 'Да'
                cur.execute("UPDATE pixelapp_p932_rows SET payload=%s,version=version+1 WHERE trip_id=%s AND dataset='settings' AND row_id=%s", (Jsonb(settings), change.trip_id, settings_id))
            elif change.operation == 'track_fuel':
                settings['track_fuel'] = change.track_fuel
                cur.execute("UPDATE pixelapp_p932_rows SET payload=%s,version=version+1 WHERE trip_id=%s AND dataset='settings' AND row_id=%s", (Jsonb(settings), change.trip_id, settings_id))
            else:
                cur.execute("SELECT payload FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses'", (change.trip_id,))
                existing = [r[0] for r in cur.fetchall()]
                if change.operation == 'refuel':
                    start = numeric(settings.get('start_km') or '0', 100000000, True)
                    largest = start
                    for row in existing:
                        if row.get('current_km'):
                            prior = numeric(row['current_km'], 100000000, True)
                            largest = max(largest, prior)
                    if Decimal(km) <= largest:
                        raise HTTPException(409, 'Километражът трябва да е над последния запис. Обнови историята.')
                    tag = '[ПЪЛНО ЗАРЕЖДАНЕ]' if change.full else '[ЧАСТИЧНО ЗАРЕЖДАНЕ]'
                    description = tag + ' ' + (change.description.strip() or 'Гориво')
                    odometer = str(km)
                else:
                    description = '[ПРОПУСНАТО ГОРИВО]'
                    odometer = ''
                row = {'trip_id':change.trip_id,'date':sofia_now().date().isoformat(),
                       'amount':str(amount),'category':'Транспорт','description':description,
                       'type':'expense','liters':str(liters),'current_km':odometer}
                cur.execute("SELECT COALESCE(MAX(row_order),-1)+1 FROM pixelapp_p932_rows WHERE trip_id=%s AND dataset='expenses'", (change.trip_id,))
                order = cur.fetchone()[0]
                cur.execute('INSERT INTO pixelapp_p932_rows(trip_id,dataset,row_id,row_order,payload) VALUES(%s,%s,%s,%s,%s)',
                            (change.trip_id,'expenses',uuid.uuid4().hex,order,Jsonb(row)))
            cur.execute('UPDATE pixelapp_p932_workspaces SET revision=revision+1,updated_at=now() WHERE trip_id=%s RETURNING revision',(change.trip_id,))
            revision = cur.fetchone()[0]
            _p932_backup_schema(cur)
            cur.execute("""INSERT INTO pixelapp_p932_backup_state(trip_id,wanted_revision) VALUES(%s,%s)
                ON CONFLICT(trip_id) DO UPDATE SET wanted_revision=GREATEST(pixelapp_p932_backup_state.wanted_revision,excluded.wanted_revision),last_error=NULL""",
                (change.trip_id,revision))
        conn.commit()
    background_tasks.add_task(_p932_backup_worker,change.trip_id)
    return {'ok':True,'revision':revision,'operation':change.operation,
            'backup_pending':True,'production_switched':False,'drive_modified':False}
