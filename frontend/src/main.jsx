import React,{useEffect,useMemo,useState} from 'react';
import{createRoot}from'react-dom/client';
import{ArrowLeft,Plus,Wallet,MapPin,CheckCircle,RefreshCcw,Trash2,CalendarDays,LogOut}from'lucide-react';
import{MapContainer,TileLayer,Marker,Popup,useMap}from'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';

const apiBase=import.meta.env.VITE_API_URL||'http://localhost:8000';
const categories=['Храна и напитки','Транспорт','Куче','Други','Нощувки/Хотел','Депозит/Резервация'];
const money=n=>new Intl.NumberFormat('bg-BG',{style:'currency',currency:'EUR'}).format(Number(n||0));

const asDate=s=>{if(!s||String(s).toLowerCase()==='nan')return null;const m=String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);if(!m)return null;const d=new Date(Number(m[3]),Number(m[2])-1,Number(m[1]));return Number.isNaN(d.getTime())?null:d};
const isoDay=d=>{const x=new Date(d);x.setHours(0,0,0,0);return x};
function tripState(t){const s=t.settings||{},today=isoDay(new Date()),start=asDate(s.start_date),end=asDate(s.end_date),car=s.car_trip==='Да',finished=car?Number(s.end_km||0)>0:String(s.trip_finished||'').trim().toLowerCase()==='да';if(finished||(end&&today>end))return 'finished';if(start&&start>today)return 'upcoming';return 'active'}
const statusText={active:'Активно',upcoming:'Предстоящо',finished:'Приключено'};
const statusDot={active:'🟢',upcoming:'🟡',finished:'🔴'};

// SVG-free markers: Leaflet's default marker assets need bundler configuration.
const homePin=L.divIcon({className:'pixel-pin',html:'<span aria-hidden="true">📍</span>',iconSize:[30,36],iconAnchor:[15,32],popupAnchor:[0,-27]});
function FitPlaces({points}){
 const map=useMap();
 useEffect(()=>{
   if(!points.length)return;
   const bounds=L.latLngBounds(points.map(p=>[p.lat,p.lon]));
   if(bounds.isValid()){
     if(points.length===1)map.setView(bounds.getCenter(),9);
     else map.fitBounds(bounds,{padding:[25,25],maxZoom:10});
   }
 },[map,points]);
 return null;
}
function HomePlaces({points}){
 const safe=points.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))&&Math.abs(Number(p.lat))<=90&&Math.abs(Number(p.lon))<=180).map(p=>({...p,lat:Number(p.lat),lon:Number(p.lon)}));
 return <section className="home-places"><div className="home-places-head"><b>🌍 МОИТЕ МЕСТА</b><span>{safe.length} места</span></div>
 {safe.length ? <MapContainer center={[safe[0].lat,safe[0].lon]} zoom={6} scrollWheelZoom={false} className="home-places-map"><TileLayer attribution='&copy; OpenStreetMap contributors' url='https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'/><FitPlaces points={safe}/>{safe.map((p,i)=><Marker key={`${p.trip_id}-${i}`} position={[p.lat,p.lon]} icon={homePin}><Popup><strong>{p.title||'Място'}</strong><div>{p.trip_name||p.trip_id}</div></Popup></Marker>)}</MapContainer> : <p className="muted">Няма записани места за показване.</p>}
 </section>;
}


function TripDetails({trip,detail,readOnly}) {
 const [section,setSection]=useState('summary');
 useEffect(()=>setSection('summary'),[trip?.id]);
 const rows=detail?.expenses||[], settings=detail?.settings||trip?.settings||{}, budgets=detail?.budgets||[], tasks=detail?.tasks||[], points=detail?.points||[];
 const number=x=>Number.isFinite(Number(x))?Number(x):0;
 const allCosts=rows.filter(r=>['expense','deposit'].includes(r.type)).reduce((a,r)=>a+number(r.amount),0);
 const byCat={};rows.forEach(r=>{const category=r.type==='deposit'?'Нощувки/Хотел':(r.category||'Други');byCat[category]=(byCat[category]||0)+number(r.amount)});
 const budgetEntries=budgets.filter(r=>r.category!=='__GLOBAL__'&&number(r.budget)>0);
 const globalBudget=budgets.filter(r=>r.category==='__GLOBAL__').reduce((a,r)=>a+number(r.budget),0);
 const budgetTotal=globalBudget>0?globalBudget:budgetEntries.reduce((a,r)=>a+number(r.budget),0);
 const fuelRows=rows.filter(r=>number(r.liters)>0);
 const liters=fuelRows.reduce((a,r)=>a+number(r.liters),0)+number(settings.manual_fuel);
 const fuelSpend=fuelRows.reduce((a,r)=>a+number(r.amount),0);
 const begin=number(settings.start_km),finish=number(settings.end_km);
 const maxReading=Math.max(0,...rows.map(r=>number(r.current_km)));
 const km=Math.max(0,(finish>0?finish:maxReading)-begin);
 const avg=km>0&&liters>0?liters/km*100:0;
 const done=tasks.filter(t=>['true','1','да','yes'].includes(String(t.done||'').toLowerCase())).length;
 const validPoints=points.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))&&Math.abs(Number(p.lat))<=90&&Math.abs(Number(p.lon))<=180);
 const sections=[['summary','Обзор'],['expenses','Разходи'],['fuel','Автомобил'],['budget','Бюджети'],['tasks','Задачи'],['map','Карта']];
 const dateText=(settings.start_date||'')+(settings.end_date&&settings.end_date!==settings.start_date?' → '+settings.end_date:'');
 return <div className="travel-detail">
 <div className="travel-hero"><div className="travel-overline">🐾 МОЕТО ПЪТУВАНЕ</div><h2>🚙 {trip.name}</h2><div className="travel-dates">{dateText}</div><div className="travel-facts"><div><small>Общо изхарчено</small><strong>{money(allCosts)}</strong></div><div><small>Бюджет</small><strong>{budgetTotal?money(budgetTotal):'—'}</strong></div><div><small>Изминати км</small><strong>{km.toLocaleString('bg-BG')}</strong></div></div>{budgetTotal>0&&<div className="travel-progress"><div style={{width:Math.min(100,allCosts/budgetTotal*100)+'%'}}/></div>}</div>
 <div className="travel-menu">{sections.map(([id,label])=><button type="button" key={id} onClick={()=>setSection(id)} className={section===id?'selected':''}>{label}</button>)}</div>
 {!detail?<div className="travel-card">Зареждаме данните за пътуването…</div>:<>
 {section==='summary'&&<><div className="travel-card"><h3>📊 Бърз преглед</h3><div className="travel-facts"><div><small>Разходи</small><strong>{rows.length}</strong></div><div><small>Задачи</small><strong>{done}/{tasks.length}</strong></div><div><small>Места</small><strong>{validPoints.length}</strong></div></div></div><div className="travel-card"><h3>💳 Разходи по категории</h3>{Object.keys(byCat).length?Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([name,val])=><div className="travel-line" key={name}><span>{name}</span><strong>{money(val)}</strong></div>):<p className="muted">Няма записани разходи.</p>}</div><div className="travel-card"><h3>⛽ Гориво и път</h3><div className="travel-facts"><div><small>Гориво</small><strong>{liters.toFixed(1)} л</strong></div><div><small>Среден разход</small><strong>{avg?avg.toFixed(1)+' л/100 км':'—'}</strong></div></div></div></>}
 {section==='expenses'&&<div className="travel-card"><h3>💳 История на разходите</h3>{rows.length?[...rows].reverse().map((r,i)=><div className="travel-line" key={i}><div><strong>{r.description||'Без описание'}</strong><small>{r.date} · {r.category}{r.type==='deposit'?' · Депозит':''}</small></div><b>{money(r.amount)}</b></div>):<p className="muted">Няма записани разходи.</p>}</div>}
 {section==='fuel'&&<><div className="travel-card"><h3>🚙 Автомобил и километри</h3><div className="travel-facts"><div><small>Начални км</small><strong>{begin||'—'}</strong></div><div><small>Крайни / последни</small><strong>{finish||maxReading||'—'}</strong></div><div><small>Изминати</small><strong>{km.toLocaleString('bg-BG')} км</strong></div></div></div><div className="travel-card"><h3>⛽ Зареждания</h3><div className="travel-facts"><div><small>Литри общо</small><strong>{liters.toFixed(1)} л</strong></div><div><small>Разход за зареждания</small><strong>{money(fuelSpend)}</strong></div><div><small>Среден разход</small><strong>{avg?avg.toFixed(1)+' л/100 км':'—'}</strong></div></div>{fuelRows.length?fuelRows.map((r,i)=><div key={i} className="travel-line"><div><strong>{r.date}</strong><small>{r.description}</small></div><div style={{textAlign:'right'}}><b>{number(r.liters).toFixed(1)} л</b><small>{money(r.amount)}</small></div></div>):<p className="muted">Няма записани зареждания с литри.</p>}</div></>}
 {section==='budget'&&<><div className="travel-card"><h3>💰 Бюджет на пътуването</h3><div className="travel-facts"><div><small>Бюджет</small><strong>{budgetTotal?money(budgetTotal):'—'}</strong></div><div><small>Платено общо</small><strong>{money(allCosts)}</strong></div><div><small>Остават</small><strong>{budgetTotal?money(budgetTotal-allCosts):'—'}</strong></div></div></div><div className="travel-card"><h3>📋 Бюджети по категории</h3>{budgetEntries.length?budgetEntries.map(b=><div className="travel-line" key={b.category}><div><strong>{b.category}</strong><small>Изхарчено: {money(byCat[b.category]||0)}</small></div><b>{money(b.budget)}</b></div>):<p className="muted">Няма зададени отделни бюджети по категории.</p>}</div></>}
 {section==='tasks'&&<div className="travel-card"><h3>✅ План и задачи · {done}/{tasks.length}</h3>{tasks.length?tasks.map(t=><div key={t.item_id} className="travel-line"><span>{['true','1','да','yes'].includes(String(t.done||'').toLowerCase())?'✅':'⬜'} {t.title}</span></div>):<p className="muted">Няма задачи за това пътуване.</p>}</div>}
 {section==='map'&&<div className="travel-card"><h3>🌍 Маршрут и места · {validPoints.length}</h3>{validPoints.length?<><div className="travel-map"><MapContainer center={[Number(validPoints[0].lat),Number(validPoints[0].lon)]} zoom={8} style={{height:320,width:'100%'}}><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>{validPoints.map((p,i)=><Marker key={i} position={[Number(p.lat),Number(p.lon)]} icon={homePin}><Popup>{p.title}</Popup></Marker>)}</MapContainer></div>{validPoints.map((p,i)=><div key={i} className="travel-line"><span>📍 {p.title||'Място'}</span></div>)}</>:<p className="muted">Няма записани точки за това пътуване.</p>}</div>}
 </>}
 {readOnly&&<p className="travel-safety">🔒 Само преглед. Оригиналните данни в Google Drive не се променят.</p>}
 </div>;
}

function App(){
 const [key,setKey]=useState(sessionStorage.getItem('pixel_api_key')||'');
 const [readOnly,setReadOnly]=useState(true);
 const [entry,setEntry]=useState(''); const [trips,setTrips]=useState([]);const [current,setCurrent]=useState(null);
 const [detail,setDetail]=useState(null);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
 const [modal,setModal]=useState('');const [name,setName]=useState('');const [start,setStart]=useState('');const [end,setEnd]=useState('');const [car,setCar]=useState(false);
 const [amount,setAmount]=useState('');const [category,setCategory]=useState(categories[0]);const [desc,setDesc]=useState('');const [task,setTask]=useState('');
 const [budget,setBudget]=useState('');const [tab,setTab]=useState('overview');const [dashboard,setDashboard]=useState(null);const [showFinished,setShowFinished]=useState(false);const [homePlaces,setHomePlaces]=useState([]);
 async function req(path,method='GET',body){const r=await fetch(`${apiBase}${path}`,{method,headers:{'X-API-Key':key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok){let msg=await r.text();throw Error(`${r.status}: ${msg}`)}return r.json()}
 async function reload(selected=current){if(!key)return;setLoading(true);setError('');try{const all=await req('/trips');setTrips(all);try{setDashboard(await req('/dashboard'))}catch(_){setDashboard(null)}try{setHomePlaces(await req('/home/places'))}catch(_){setHomePlaces([])}if(selected){const d=await req(`/trips/${encodeURIComponent(selected)}`);setDetail(d)}}catch(e){setError(String(e.message))}finally{setLoading(false)}}
 useEffect(()=>{if(key){fetch(`${apiBase}/health`).then(r=>r.json()).then(x=>setReadOnly(x.read_only!==false)).catch(()=>setReadOnly(true));reload()}},[key]);
 const chosen=trips.find(x=>x.id===current);
 async function run(job){if(readOnly){setError('Режим само за четене: промените са изключени, за да пазим данните.');return;}setError('');try{await job();await reload();setModal('')}catch(e){setError(String(e.message))}}
 function connect(e){e.preventDefault();const value=entry.trim();if(!value)return;sessionStorage.setItem('pixel_api_key',value);setKey(value);setEntry('')}
 function logout(){sessionStorage.removeItem('pixel_api_key');setKey('');setTrips([]);}
 if(!key)return <main className="auth"><div className="brand">🐾 <span>PixelApp</span></div><p>Travel Manager — React preview</p><section className="panel"><h3>Личен достъп</h3><p>Въведи ключа от <code>PIXELAPP_API_KEY</code> на твоя Python сървър. Google токените никога не се въвеждат тук.</p><form onSubmit={connect}><input type="password" autoComplete="off" value={entry} onChange={e=>setEntry(e.target.value)} placeholder="API ключ"/><button>Влез</button></form></section></main>;
 return <main className="app"><header><div className="brand">🐾 <span>PixelApp</span></div><div className="sub">Travel Manager</div></header>
 {readOnly&&<aside className="muted" style={{padding:'9px 12px',border:'1px solid #355',borderRadius:10,marginBottom:12}}>🔒 Безопасен преглед: данните в Google Drive са само за четене. Добавянето и редакциите ще бъдат активирани след настройване на синхронизацията.</aside>}
 <nav><button className="ghost" onClick={()=>{if(current){setCurrent(null);setDetail(null)}else{sessionStorage.removeItem('pixel_api_key');setKey('');setTrips([])}}}>{current?<><ArrowLeft size={17}/> Начало</>:<><LogOut size={17}/> Изход</>}</button><button className="ghost" onClick={()=>reload()}><RefreshCcw size={17}/> Обнови</button></nav>
 {error&&<aside className="error">{error}</aside>}{loading&&<div className="muted">Зареждане…</div>}
 {!current?<>
 <div className="actions home-actions"><button disabled={readOnly} onClick={()=>setModal('expense')}>➕ <span><b>Бърз разход</b><small>Добави разход за секунди</small></span></button><button disabled={readOnly} onClick={()=>setModal('trip')}>✈️ <span><b>Ново пътуване</b><small>Създай ново приключение</small></span></button></div>
 <div className="home-sync"><button className="ghost" onClick={async()=>{setLoading(true);setError('');try{await req('/sync-from-drive','POST');await reload()}catch(e){setError(String(e.message))}finally{setLoading(false)}}}><RefreshCcw size={15}/> Прочети данните от Google Drive</button></div>
 <h4 className="home-heading">Моите пътувания <span>{trips.length} пътувания</span></h4>
 {(() => {const ranked=[...trips].sort((a,b)=>{const rank={active:0,upcoming:1,finished:2},sa=tripState(a),sb=tripState(b);if(rank[sa]!==rank[sb])return rank[sa]-rank[sb];const da=asDate(sa==='finished'?a.settings?.end_date:sa==='upcoming'?a.settings?.start_date:a.settings?.end_date);const db=asDate(sb==='finished'?b.settings?.end_date:sb==='upcoming'?b.settings?.start_date:b.settings?.end_date);return sa==='finished'?(db?.getTime()||0)-(da?.getTime()||0):(da?.getTime()||Infinity)-(db?.getTime()||Infinity)});const ended=ranked.filter(t=>tripState(t)==='finished');const visible=ranked.filter(t=>tripState(t)!=='finished').concat(showFinished?ended:ended.slice(0,1));return <>
 {visible.map(t=>{const state=tripState(t),pct=t.budget>0?Math.min(100,Math.max(0,t.spent/t.budget*100)):0;return <button key={t.id} className={'trip home-trip state-'+state} onClick={async()=>{setCurrent(t.id);setTab('overview');setDetail(null);try{setDetail(await req(`/trips/${encodeURIComponent(t.id)}`))}catch(e){setError(e.message)}}}><div className="triptitle">🚙 {t.name}</div><div className="tripstatus">{statusDot[state]} {statusText[state]} <span>{t.settings.start_date||''}{t.settings.end_date&&t.settings.end_date!==t.settings.start_date?' → '+t.settings.end_date:''}</span></div>{state==='finished'?<div className="numbers">💰 Общо изхарчено: <strong>{money(t.spent)}</strong></div>:t.budget>0?<><div className="numbers"><strong>{money(t.spent)}</strong> / {money(t.budget)} <strong> · {Math.round(pct)}%</strong></div><div className="remaining">💳 Остават <strong>{money(Math.max(0,t.budget-t.spent))}</strong></div><div className="track"><div style={{width:`${pct}%`}}/></div></>:<div className="numbers muted">Без зададен бюджет</div>}</button>})}
 {ended.length>1&&<button className="show-completed" onClick={()=>setShowFinished(x=>!x)}>{showFinished?'Скрий старите приключения':'Виж всички приключени'} · {ended.length}</button>}
 </>})()}
 {!trips.length&&!loading&&<p className="muted">Няма заредени пътувания. Използвай „Прочети данните от Google Drive“.</p>}
 {dashboard?.next_trip&&<div className="home-extra"><div className="home-extra-title">✈️ СЛЕДВАЩО ПЪТУВАНЕ</div><strong>{dashboard.next_trip.name}</strong><small>{dashboard.next_trip.date} · {dashboard.next_trip.days===0?'днес':`след ${dashboard.next_trip.days} дни`}</small></div>}
 {dashboard?.last_activity&&<div className="home-extra"><div className="home-extra-title">🕐 ПОСЛЕДНА АКТИВНОСТ</div><strong>{money(dashboard.last_activity.amount)}</strong><small>{dashboard.last_activity.trip} · {dashboard.last_activity.category} · {dashboard.last_activity.description}</small></div>}
 <div className="home-extra"><div className="home-extra-title">📊 БЪРЗ ПОГЛЕД</div><div className="home-stats"><div><strong>{dashboard?.trips??trips.length}</strong><small>ПЪТУВАНИЯ</small></div><div><strong>{money(dashboard?.spent??trips.reduce((n,t)=>n+Number(t.spent||0),0))}</strong><small>РАЗХОДИ</small></div><div><strong>{Number(dashboard?.km||0).toLocaleString('bg-BG')}</strong><small>КМ</small></div></div></div>
 <HomePlaces points={homePlaces}/>
 </>: <>{chosen&&<TripDetails trip={chosen} detail={detail} readOnly={readOnly}/>}</>}
 {modal&&<div className="overlay" onClick={()=>setModal('')}><div className="dialog" onClick={e=>e.stopPropagation()}><div className="dialoghead"><h3>{modal==='trip'?'Ново пътуване':'Нов разход'}</h3><button className="ghost" onClick={()=>setModal('')}>✕</button></div>{modal==='trip'?<form onSubmit={e=>{e.preventDefault();run(()=>req('/trips','POST',{name,start_date:start?start.split('-').reverse().join('.'): '',end_date:end?end.split('-').reverse().join('.'): '',car_trip:car}))}}><label>Дестинация<input value={name} onChange={e=>setName(e.target.value)} required/></label><label>Начална дата<input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label><label>Крайна дата<input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label><label className="toggle"><input type="checkbox" checked={car} onChange={e=>setCar(e.target.checked)}/> Пътуване с автомобил</label><button>Създай</button></form>:<form onSubmit={e=>{e.preventDefault();run(()=>req(`/trips/${encodeURIComponent(current)}/expenses`,'POST',{amount:Number(amount),category,description:desc,is_deposit:category==='Депозит/Резервация'}));setAmount('');setDesc('')}}><label>Сума (€)<input type="number" step="0.01" min="0" value={amount} onChange={e=>setAmount(e.target.value)} required/></label><label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}>{categories.map(x=><option key={x}>{x}</option>)}</select></label><label>Описание<input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Без описание"/></label><button>Добави разход</button></form>}</div></div>}
 <footer>PixelApp React · Етап 1 · Данните остават в Google Drive</footer></main>
}

createRoot(document.getElementById('root')).render(<App/>);
