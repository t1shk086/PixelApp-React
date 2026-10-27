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



function ExpenseHistory({rows}) {
 const [search,setSearch]=useState('');
 const [category,setCategory]=useState('all');
 const [kind,setKind]=useState('all');
 const amount=r=>{const n=Number(r.amount);return Number.isFinite(n)?n:0};
 const isPayment=r=>['expense','deposit'].includes(String(r.type||'').toLowerCase());
 const categoryName=r=>r.type==='deposit'?'Нощувки/Хотел':(r.category||'Други');
 const payments=rows.filter(isPayment);
 const options=Array.from(new Set(payments.map(categoryName))).sort((a,b)=>a.localeCompare(b,'bg'));
 const visible=payments.filter(r=>{
  if(category!=='all'&&categoryName(r)!==category)return false;
  if(kind!=='all'&&String(r.type)!==kind)return false;
  if(search.trim()){
   const text=[r.date,r.description,r.category,categoryName(r),r.amount].join(' ').toLocaleLowerCase('bg');
   if(!text.includes(search.trim().toLocaleLowerCase('bg')))return false;
  }
  return true;
 });
 const total=visible.reduce((sum,r)=>sum+amount(r),0);
 return <div className="travel-card expense-history">
  <h3>💳 История на разходите</h3>
  <div className="expense-filters">
   <label className="expense-search">Търси разход<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Описание, дата или сума" type="search"/></label>
   <label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}><option value="all">Всички категории</option>{options.map(c=><option value={c} key={c}>{c}</option>)}</select></label>
   <label>Вид<select value={kind} onChange={e=>setKind(e.target.value)}><option value="all">Всички плащания</option><option value="expense">Разходи</option><option value="deposit">Депозити</option></select></label>
  </div>
  <div className="expense-overview"><span><b>{visible.length}</b> от {payments.length} плащания</span><strong>Общо: {money(total)}</strong></div>
  {visible.length?[...visible].reverse().map((r,i)=><div className="travel-line expense-entry" key={`${r.date}-${r.description}-${i}`}><div><strong>{r.description||'Без описание'}</strong><small>{r.date||'Без дата'} · {categoryName(r)}{r.type==='deposit'?' · Депозит':''}</small>{Number(r.liters)>0&&<small>⛽ {Number(r.liters).toLocaleString('bg-BG')} л</small>}</div><b>{money(amount(r))}</b></div>):<p className="muted">{payments.length?'Няма плащания, които отговарят на филтрите.':'Няма записани разходи за това пътуване.'}</p>}
 </div>;
}


// Fuel history mirrors the original Streamlit comparison: amount/liters versus the immediately previous record.
function FuelHistory({rows}) {
 const [selected,setSelected]=useState(0);
 const num=v=>{const n=Number(String(v??'').replace(',','.'));return Number.isFinite(n)?n:0};
 const manualPattern=/\[(?:ПРОПУСНАТО\s+ГОРИВО|ГОРИВО\s+БЕЗ\s+СТОЙНОСТ)\]/i;
 const all=rows.filter(r=>String(r.category)==='Транспорт'&&String(r.type)==='expense').map((r,i)=>{
  const desc=String(r.description||'');let l=num(r.liters);let manual=manualPattern.test(desc);
  if(manual){const m=desc.match(/Добавени\s*([0-9]+(?:[.,][0-9]+)?)\s*литра/i);if(m)l=num(m[1]);}
  return {...r,_index:i,_liters:l,_manual:manual,_price:l>0&&num(r.amount)>0?num(r.amount)/l:0};
 }).filter(r=>r._liters>0).reverse();
 const fmt=n=>num(n).toLocaleString('bg-BG',{minimumFractionDigits:2,maximumFractionDigits:2});
 return <div className="travel-card fuel-history-card"><h3>🧾 История на зарежданията <span className="fuel-history-count">{all.length} записа</span></h3>
 {all.length?<><nav className="fuel-history-pager" aria-label="Преглед на зареждания"><button type="button" aria-label="Предишно зареждане" disabled={selected===0} onClick={()=>setSelected(i=>Math.max(0,i-1))}>‹</button><span><strong>{Math.min(selected+1,all.length)} / {all.length}</strong><small>Зареждане</small></span><button type="button" aria-label="Следващо зареждане" disabled={selected>=all.length-1} onClick={()=>setSelected(i=>Math.min(all.length-1,i+1))}>›</button></nav>{all.slice(selected,selected+1).map((r,offset)=>{
  const i=selected+offset;
  const prev=all[i+1],prevPrice=prev?prev._price:0,delta=r._price-prevPrice;
  const label=r._manual?'РЪЧНО ДОБАВЕНО ГОРИВО':/\[ПЪЛНО\s+ЗАРЕЖДАНЕ\]/i.test(String(r.description||''))?'ПЪЛНО ЗАРЕЖДАНЕ':/\[ЧАСТИЧНО\s+ЗАРЕЖДАНЕ\]/i.test(String(r.description||''))?'ЧАСТИЧНО ЗАРЕЖДАНЕ':'ЗАРЕЖДАНЕ';
  const clean=String(r.description||'').replace(/^\[(?:ПЪЛНО\s+ЗАРЕЖДАНЕ|ЧАСТИЧНО\s+ЗАРЕЖДАНЕ)\]\s*/i,'').trim();
  const opened=true;
  let comparison='Няма предишно зареждане за сравнение.';
  let tone='neutral';
  if(prev){if(r._price<=0){comparison='Няма цена за сравнение — въведени са само литрите.';}
   else if(prevPrice>0){tone=delta<0?'cheaper':delta>0?'dearer':'neutral';comparison=delta<0?`€${fmt(Math.abs(delta))}/л по-евтино · предишно €${fmt(prevPrice)}/л → сега €${fmt(r._price)}/л`:delta>0?`€${fmt(delta)}/л по-скъпо · предишно €${fmt(prevPrice)}/л → сега €${fmt(r._price)}/л`:`Същата цена · €${fmt(r._price)}/л`;}}
  const real=String(r.description||'').match(/(?:Реален разход:|Разход:)\s*([0-9]+(?:[.,][0-9]+)?)/i);
  return <div className={'fuel-history-item'+(opened?' is-open':'')} key={`${r._index}-${r.date}`}>
    <div className="fuel-history-summary">
     <span className="fuel-history-left"><span className={'fuel-history-kind'+(label==='ПЪЛНО ЗАРЕЖДАНЕ'?' is-full':'')}>{label}</span><strong>{clean||'Гориво'}</strong><small>{r.date||'Без дата'}{!r._manual&&num(r.current_km)>0?' · '+num(r.current_km).toLocaleString('bg-BG')+' км':''}</small></span>
     <span className="fuel-history-right"><b>{fmt(r._liters)} л</b><strong>{num(r.amount)>0?money(r.amount):'—'}</strong></span>
    </div>
    {opened&&<div className="fuel-history-analysis"><div className="fuel-analysis-grid">
     <div><small>Литри</small><b className="fuel-blue">{fmt(r._liters)} <em>л</em></b></div>
     <div><small>Стойност</small><b className="fuel-gold">{num(r.amount)>0?money(r.amount):'—'}</b></div>
     <div><small>Цена / л</small><b className={r._price>1.8?'fuel-red':'fuel-green'}>{r._price>0?`€${fmt(r._price)}`:'—'}</b></div>
     <div><small>Километраж</small><b>{!r._manual&&num(r.current_km)>0?num(r.current_km).toLocaleString('bg-BG')+' км':'—'}</b></div>
    </div>
    {real&&<p className="fuel-analysis-stage">🚗 Реален разход за етапа: {real[1].replace(',','.')} л/100 км</p>}
    <div className={'fuel-analysis-compare '+tone}>{comparison}</div>
    {r._manual&&<small className="fuel-analysis-hint">Ръчно добавено гориво — не е записана стойност или километраж.</small>}
    </div>}
   </div>;
 })}</>:<p className="muted">Няма записани зареждания с литри.</p>}
 </div>;
}

function TripDetails({trip,detail,readOnly}) {
 const [section,setSection]=useState('summary');
 const [taskDrafts,setTaskDrafts]=useState([]);
 const [taskOverrides,setTaskOverrides]=useState({});
 const [taskName,setTaskName]=useState('');
 const [taskEditing,setTaskEditing]=useState(null);
 const [taskEditText,setTaskEditText]=useState('');
 useEffect(()=>{setSection('summary');setTaskDrafts([]);setTaskOverrides({});setTaskName('');setTaskEditing(null);},[trip?.id]);
 const rows=detail?.expenses||[], settings=detail?.settings||trip?.settings||{}, budgets=detail?.budgets||[], tasks=detail?.tasks||[], points=detail?.points||[];
 const number=x=>Number.isFinite(Number(x))?Number(x):0;
 const allCosts=rows.filter(r=>['expense','deposit'].includes(r.type)).reduce((a,r)=>a+number(r.amount),0);
 const byCat={};rows.forEach(r=>{const category=r.type==='deposit'?'Нощувки/Хотел':(r.category||'Други');byCat[category]=(byCat[category]||0)+number(r.amount)});
 const budgetEntries=budgets.filter(r=>r.category!=='__GLOBAL__'&&number(r.budget)>0);
 const globalBudget=budgets.filter(r=>r.category==='__GLOBAL__').reduce((a,r)=>a+number(r.budget),0);
 const budgetTotal=globalBudget>0?globalBudget:budgetEntries.reduce((a,r)=>a+number(r.budget),0);
 const fuelRows=rows.filter(r=>r.type==='expense'&&r.category==='Транспорт'&&number(r.liters)>0);
 const liters=fuelRows.reduce((a,r)=>a+number(r.liters),0)+number(settings.manual_fuel);
 const fuelSpend=rows.filter(r=>r.type==='expense'&&r.category==='Транспорт'&&(number(r.liters)>0||/газ|гориво|зареждане|бензин|дизел/i.test(String(r.description||'')))).reduce((a,r)=>a+number(r.amount),0);
 const begin=number(settings.start_km),finish=number(settings.end_km);
 const maxReading=Math.max(0,...rows.map(r=>number(r.current_km)));
 const effectiveReading=finish>0?finish:maxReading;
 const km=Math.max(0,effectiveReading-begin);
 const avg=km>0&&liters>0?liters/km*100:0;
 const fullFuelRows=rows.filter(r=>r.type==='expense'&&r.category==='Транспорт'&&number(r.current_km)>begin&&/ПЪЛЕН|ПЪЛНО/i.test(String(r.description||'')));
 const lastFull=fullFuelRows.at(-1);
 const realMatch=lastFull&&String(lastFull.description||'').match(/(?:Реален разход:|Разход:)\s*([0-9]+(?:[.,][0-9]+)?)/i);
 const realConsumption=realMatch?number(realMatch[1].replace(',','.')):0;
 // Контролна справка — не променя основните изчисления или данните.
 const budgetCats=new Set(budgetEntries.map(b=>b.category));
 const budgetScopedCosts=globalBudget>0||!budgetCats.size?allCosts:rows.reduce((sum,r)=>{
   if(r.type==='expense'&&budgetCats.has(r.category))return sum+number(r.amount);
   if(r.type==='deposit'&&budgetCats.has('Нощувки/Хотел'))return sum+number(r.amount);
   return sum;
 },0);
 const serverSpent=number(trip?.spent),serverBudget=number(trip?.budget);
 const near=(a,b)=>Math.abs(a-b)<0.011;
 const controlRows=[
  ['Разходи — същият бюджетен обхват',budgetScopedCosts,serverSpent,'€'],
  ['Бюджет',budgetTotal,serverBudget,'€'],
 ];
 const controlOk=controlRows.every(([,a,b])=>near(a,b));
 const taskIsDone=t=>['true','1','да','yes'].includes(String(t.done??'').toLowerCase());
 const previewTasks=tasks.map((t,i)=>({...t,...(taskOverrides[String(t.item_id??`old-${i}`)]||{}),_previewKey:String(t.item_id??`old-${i}`)})).concat(taskDrafts);
 const done=previewTasks.filter(taskIsDone).length;
 const setPreviewTask=(t,changes)=>{
  if(t._isDraft)setTaskDrafts(items=>items.map(x=>x._previewKey===t._previewKey?{...x,...changes}:x));
  else setTaskOverrides(old=>({...old,[t._previewKey]:{...(old[t._previewKey]||{}),...changes}}));
 };
 const addPreviewTask=e=>{e.preventDefault();const name=taskName.trim();if(!name)return;setTaskDrafts(items=>items.concat([{_previewKey:`test-${Date.now()}-${items.length}`,_isDraft:true,title:name,done:false}]));setTaskName('')};
 const resetTaskPreview=()=>{setTaskDrafts([]);setTaskOverrides({});setTaskEditing(null);setTaskName('')};
 const validPoints=points.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))&&Math.abs(Number(p.lat))<=90&&Math.abs(Number(p.lon))<=180);
 const sections=[['summary','Обзор'],['expenses','Разходи'],['fuel','Автомобил'],['budget','Бюджети'],['tasks','Задачи'],['map','Карта'],['check','Проверка']];
 const dateText=(settings.start_date||'')+(settings.end_date&&settings.end_date!==settings.start_date?' → '+settings.end_date:'');
 return <div className="travel-detail">
 <div className="travel-hero"><div className="travel-overline">🐾 МОЕТО ПЪТУВАНЕ</div><h2>🚙 {trip.name}</h2><div className="travel-dates">{dateText}</div><div className="travel-facts visual-top-facts"><div><small>💸 Общо изхарчено</small><strong>{money(allCosts)}</strong></div><div><small>🎯 Бюджет</small><strong>{budgetTotal?money(budgetTotal):'—'}</strong></div><div><small>🚙 Изминати км</small><strong>{km.toLocaleString('bg-BG')}</strong></div></div>{budgetTotal>0&&<div className="travel-progress"><div style={{width:Math.min(100,allCosts/budgetTotal*100)+'%'}}/></div>}</div>
 <div className="travel-menu">{sections.map(([id,label])=><button type="button" key={id} onClick={()=>setSection(id)} className={section===id?'selected':''}>{label}</button>)}</div>
 {!detail?<div className="travel-card">Зареждаме данните за пътуването…</div>:<>
 {section==='summary'&&<>
 <div className="travel-card visual-section"><h3>✨ Пътуването с един поглед</h3><div className="visual-overview-stats"><div className="overview-tile"><span>🧾</span><small>Записи</small><strong>{rows.length}</strong></div><div className="overview-tile"><span>✅</span><small>Задачи</small><strong>{done} <em>/ {previewTasks.length}</em></strong></div><div className="overview-tile"><span>📍</span><small>Места</small><strong>{validPoints.length}</strong></div><div className="overview-tile"><span>⛽</span><small>Гориво</small><strong>{liters.toLocaleString('bg-BG',{maximumFractionDigits:1})} <em>л</em></strong></div></div></div>
 <div className="travel-card visual-section"><h3>💳 Разходи по категории</h3>{Object.keys(byCat).length?Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([name,val],i)=>{const ratio=allCosts>0?Math.max(0,Math.min(100,val/allCosts*100)):0;return <div className="visual-category" key={name}><div className="visual-category-head"><span><i className={'visual-category-dot visual-palette-'+i%5}/>{name}</span><strong>{money(val)}</strong></div><div className="visual-category-bar"><span className={'visual-palette-bg-'+i%5} style={{width:ratio+'%'}}/></div><small>{ratio.toFixed(1)}% от общите разходи</small></div>}):<p className="muted">Няма записани разходи.</p>}</div>
 <div className="travel-card visual-section"><h3>🚗 Гориво и път</h3><div className="visual-overview-stats visual-road-stats"><div className="overview-tile"><span>🛣️</span><small>Изминато</small><strong>{km.toLocaleString('bg-BG')} <em>км</em></strong></div><div className="overview-tile"><span>⛽</span><small>Среден разход</small><strong>{avg?avg.toFixed(1):'—'} <em>л/100 км</em></strong></div></div></div>
 </>}
 {section==='expenses'&&<ExpenseHistory rows={rows}/>}
 {section==='fuel'&&<>
 <div className="travel-card"><h3>🚙 Пробег на автомобила</h3>
 {settings.car_trip==='Не'?<p className="muted">Това пътуване е отбелязано като пътуване без собствен автомобил. Показаните данни са само записаните показания, ако има такива.</p>:null}
 <div className="fuel-road" aria-hidden="true"><span className="fuel-road-node fuel-road-start">S</span><span className="fuel-road-line"/><span className="fuel-road-node fuel-road-current">🚗</span><span className="fuel-road-line"/><span className="fuel-road-node fuel-road-finish">F</span></div>
 <div className="fuel-odometer"><div><small>Старт</small><b>{begin?begin.toLocaleString('bg-BG')+' км':'—'}</b></div><div><small>Изминати</small><b className="fuel-accent">{km.toLocaleString('bg-BG')} км</b></div><div><small>{finish>begin?'Краен':'Последни км'}</small><b>{effectiveReading>0?effectiveReading.toLocaleString('bg-BG')+' км':'—'}</b></div></div>
 {finish>begin&&<p className="fuel-note">Пътуването има записани крайни километри.</p>}
 </div>
 <div className="travel-card"><h3>⛽ Разход на гориво</h3>
 <div className="fuel-metrics visual-gauges"><div><small className="gauge-label gauge-label-orange">СРЕДЕН РАЗХОД</small><div className="gauge-circle gauge-circle-orange"><b>{avg>0?avg.toFixed(1):'—'}</b><em>л/100 км</em></div><small>По всички записани литри и километри</small></div><div><small className="gauge-label gauge-label-red">РЕАЛЕН РАЗХОД</small><div className="gauge-circle gauge-circle-red"><b>{realConsumption>0?realConsumption.toFixed(1):'—'}</b><em>л/100 км</em></div><small>{realConsumption>0?'От последното пълно зареждане':'Няма записано пълно зареждане с разход'}</small></div></div>
 <div className="travel-facts"><div><small>Гориво общо</small><strong>{liters.toLocaleString('bg-BG',{maximumFractionDigits:2})} л</strong></div><div><small>Платено гориво</small><strong>{money(fuelSpend)}</strong></div><div><small>Зареждания</small><strong>{fuelRows.length}</strong></div></div>
 {number(settings.manual_fuel)>0&&<p className="fuel-note">В общото количество са включени {number(settings.manual_fuel).toLocaleString('bg-BG')} л ръчно добавено гориво.</p>}
 </div>
 <FuelHistory rows={rows}/>
 </>}
 {section==='budget'&&<>
 <div className="travel-card budget-showcase"><h3>🎯 Бюджет на пътуването</h3><div className="budget-showcase-total"><small>ОСТАВАЩ БЮДЖЕТ</small><strong className={budgetTotal>0&&allCosts>budgetTotal?'negative':''}>{budgetTotal?money(budgetTotal-allCosts):'—'}</strong></div><div className="budget-showcase-grid"><div><small>Планирано</small><b>{budgetTotal?money(budgetTotal):'—'}</b></div><div><small>Изразходвано</small><b>{money(allCosts)}</b></div></div>{budgetTotal>0&&<><div className="budget-showcase-progress"><span style={{width:Math.min(100,allCosts/budgetTotal*100)+'%'}}/></div><div className="budget-showcase-caption"><span>{Math.round(allCosts/budgetTotal*100)}% използвани</span><span>{allCosts>budgetTotal?'Над бюджета':'Остатък'}</span></div></>}</div>
 <div className="travel-card"><h3>🗂️ Бюджети по категории</h3>{budgetEntries.length?budgetEntries.map((b,i)=>{const spent=number(byCat[b.category]),limit=number(b.budget),percent=limit>0?Math.min(100,spent/limit*100):0;return <div className="budget-visual-row" key={b.category}><div className="budget-visual-head"><strong><span className={'visual-category-dot visual-palette-'+i%5}/>{b.category}</strong><b>{money(spent)} <span>/ {money(limit)}</span></b></div><div className="budget-visual-track"><span style={{width:percent+'%',background:spent>limit?'linear-gradient(90deg,#ee866a,#fd4e77)':'linear-gradient(90deg,#45d0ff,#725cff)'}}/></div><div className="budget-visual-foot"><small>{Math.round(limit>0?spent/limit*100:0)}% от бюджета</small><small>{spent>limit?'Над бюджета: '+money(spent-limit):'Остават: '+money(limit-spent)}</small></div></div>}):<p className="muted">Няма зададени отделни бюджети по категории.</p>}</div>
 </>}
 {section==='tasks'&&<>
 <div className="travel-card task-showcase"><h3>✅ План и задачи</h3><div className="task-progress-head"><div><small>ИЗПЪЛНЕНИ ЗАДАЧИ</small><strong>{done} <em>/ {previewTasks.length}</em></strong></div><span>{previewTasks.length?Math.round(done/previewTasks.length*100):0}%</span></div><div className="task-progress-track"><span style={{width:(previewTasks.length?done/previewTasks.length*100:0)+'%'}}/></div></div>
 <div className="travel-card task-preview-panel">
  <div className="task-preview-heading"><h3>📋 Списък със задачи</h3><span className="task-test-label">ТЕСТ · без записване</span></div>
  <p className="muted">Можеш да добавяш, отбелязваш и редактираш тук. Промените са само временни и не достигат до Google Drive.</p>
  <form className="task-preview-form" onSubmit={addPreviewTask}><input aria-label="Нова пробна задача" value={taskName} maxLength={200} onChange={e=>setTaskName(e.target.value)} placeholder="Нова задача…"/><button type="submit" disabled={!taskName.trim()}>➕ Добави</button></form>
  {previewTasks.length?previewTasks.map(t=>{const complete=taskIsDone(t);const isEditing=taskEditing===t._previewKey;return <div key={t._previewKey} className={'task-visual-item task-preview-item'+(complete?' task-visual-done':'')}>
   <button type="button" className="task-preview-check" aria-label={complete?'Отбележи като предстояща':'Отбележи като готова'} onClick={()=>setPreviewTask(t,{done:!complete})}>{complete?'✓':'○'}</button>
   {isEditing?<form className="task-preview-edit" onSubmit={e=>{e.preventDefault();if(taskEditText.trim())setPreviewTask(t,{title:taskEditText.trim()});setTaskEditing(null)}}><input autoFocus value={taskEditText} maxLength={200} onChange={e=>setTaskEditText(e.target.value)}/><button type="submit">Запази</button><button type="button" className="ghost" onClick={()=>setTaskEditing(null)}>Отказ</button></form>:<><span className="task-preview-name">{t.title||'Задача'}{t._isDraft&&<small> · пробна</small>}</span><button type="button" className="task-preview-action" onClick={()=>{setTaskEditing(t._previewKey);setTaskEditText(t.title||'')}} aria-label={'Редактирай '+(t.title||'задача')}>✎</button>{t._isDraft&&<button type="button" className="task-preview-action" aria-label="Премахни пробната задача" onClick={()=>setTaskDrafts(items=>items.filter(x=>x._previewKey!==t._previewKey))}>✕</button>}</>}
  </div>}):<p className="muted">Няма задачи за това пътуване. Добави пробна задача горе.</p>}
  {(taskDrafts.length>0||Object.keys(taskOverrides).length>0)&&<button type="button" className="task-preview-reset" onClick={resetTaskPreview}>↺ Изчисти пробните промени</button>}
 </div>
 </>}
 {section==='map'&&<div className="travel-card map-showcase"><h3>🌍 Маршрут и места <span className="map-point-count">{validPoints.length} точки</span></h3>{validPoints.length?<><div className="travel-map"><MapContainer center={[Number(validPoints[0].lat),Number(validPoints[0].lon)]} zoom={8} style={{height:320,width:'100%'}}><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>{validPoints.map((p,i)=><Marker key={i} position={[Number(p.lat),Number(p.lon)]} icon={homePin}><Popup>{p.title}</Popup></Marker>)}</MapContainer></div><div className="map-place-list">{validPoints.map((p,i)=><div key={i} className="map-place-row"><span className="map-place-pin">📍</span><div><strong>{p.title||'Място'}</strong><small>{Number(p.lat).toFixed(4)}°, {Number(p.lon).toFixed(4)}°</small></div></div>)}</div></>:<p className="muted">Няма записани точки за това пътуване.</p>}</div>}
 {section==='check'&&<div className="travel-card visual-section">
 <h3>🧮 Контрол на изчисленията</h3>
 <p className="muted">Проверка между обобщението на API и детайлните записи, заредени от Google Drive. Това не е още пълно сравнение с всички формули в стария Streamlit.</p>
 <div className="visual-overview-stats">
  <div className="overview-tile"><small>Всички разходи</small><strong>{money(allCosts)}</strong></div>
  <div className="overview-tile"><small>Разходи в бюджетния обхват</small><strong>{money(budgetScopedCosts)}</strong></div>
  <div className="overview-tile"><small>Брой плащания</small><strong>{rows.filter(r=>r.type==='expense'||r.type==='deposit').length}</strong></div>
  <div className="overview-tile"><small>Изминати километри</small><strong>{km.toLocaleString('bg-BG')} км</strong></div>
 </div>
 <h3>Сверка с API</h3>
 {controlRows.map(([label,local,remote,unit])=><div key={label} className="travel-line" style={{alignItems:'center',gap:12}}><div><strong>{label}</strong><small>Детайлно: {unit==='€'?money(local):local} · Обобщение: {unit==='€'?money(remote):remote}</small></div><b style={{color:near(local,remote)?'#41d6a5':'#ffc267'}}>{near(local,remote)?'✓ Съвпада':'⚠ Разлика'}</b></div>)}
 <p style={{color:controlOk?'#41d6a5':'#ffc267',fontWeight:700}}>{controlOk?'✓ Обобщените суми съвпадат.':'⚠ Има разлика между обобщението и подробните данни.'}</p>
 {globalBudget<=0&&budgetCats.size>0&&<p className="muted">Пътуването използва бюджети по категории. „Всички разходи“ може да е повече от „Разходи в бюджетния обхват“, защото извънбюджетните категории не се броят в бюджетното обобщение.</p>}
 <p className="muted">Среден разход по всички записани литри: {avg>0?avg.toFixed(1)+' л/100 км':'няма достатъчно данни'}. Реален разход от записано пълно зареждане: {realConsumption>0?realConsumption.toFixed(1)+' л/100 км':'няма записан резултат'}.</p>
 <p className="muted">Тези проверки не гарантират пълна идентичност със Streamlit. Записването остава изключено.</p>
 </div>}
 {readOnly&&<p className="travel-safety">🔒 Само преглед. Оригиналните данни в Google Drive не се променят.</p>}
 </>}
 </div>;
}


// Безопасен прототип: изчисленията са само локални, без POST към API.
function QuickExpensePreview({trips,loadTrip,onClose}){
 const [tripId,setTripId]=useState(trips[0]?.id||'');
 const [details,setDetails]=useState(null);
 const [fetchError,setFetchError]=useState('');
 const [busy,setBusy]=useState(false);
 const [amount,setAmount]=useState('');
 const [category,setCategory]=useState('Храна и напитки');
 const [description,setDescription]=useState('');
 const [newRows,setNewRows]=useState([]);
 const [edits,setEdits]=useState({});
 const [deleted,setDeleted]=useState([]);
 const [editing,setEditing]=useState(null);
 const [editAmount,setEditAmount]=useState('');
 const [editCategory,setEditCategory]=useState('');
 const [editDescription,setEditDescription]=useState('');
 useEffect(()=>{let active=true;setDetails(null);setNewRows([]);setEdits({});setDeleted([]);setEditing(null);setFetchError('');if(!tripId)return;
  setBusy(true);loadTrip(tripId).then(d=>{if(active)setDetails(d)}).catch(e=>{if(active)setFetchError(e.message||String(e))}).finally(()=>{if(active)setBusy(false)});
  return()=>{active=false};
 },[tripId]);
 const val=v=>{const n=Number(String(v??0).replace(',','.'));return Number.isFinite(n)?n:0};
 const isExpense=r=>['expense','deposit'].includes(String(r.type||'').toLowerCase());
 const expenseCategory=r=>r.type==='deposit'?'Нощувки/Хотел':(r.category||'Други');
 const isFuel=r=>r.type==='expense'&&r.category==='Транспорт'&&(val(r.liters)>0||/гориво|зареждане|бензин|дизел|газ/i.test(String(r.description||'')));
 const original=(details?.expenses||[]).filter(isExpense).map((r,i)=>({...r,_key:`old-${i}`,_original:true}));
 const effectiveOld=original.filter(r=>!deleted.includes(r._key)).map(r=>({...r,...(edits[r._key]||{})}));
 const allEffective=effectiveOld.concat(newRows);
 const budgets=details?.budgets||[];
 const budgetItems=budgets.filter(b=>b.category!=='__GLOBAL__'&&val(b.budget)>0);
 const globalBudget=budgets.filter(b=>b.category==='__GLOBAL__').reduce((a,b)=>a+val(b.budget),0);
 const budgetTotal=globalBudget>0?globalBudget:budgetItems.reduce((a,b)=>a+val(b.budget),0);
 const budgetCats=new Set(budgetItems.map(b=>b.category));
 const included=r=>globalBudget>0||!budgetCats.size||budgetCats.has(expenseCategory(r));
 const totalFor=items=>items.reduce((a,r)=>a+val(r.amount),0);
 const scopeFor=items=>items.reduce((a,r)=>a+(included(r)?val(r.amount):0),0);
 const totalBefore=totalFor(original),totalAfter=totalFor(allEffective);
 const scopeBefore=scopeFor(original),scopeAfter=scopeFor(allEffective);
 const options=[...new Set([...categories.filter(c=>c!=='Депозит/Резервация'),...budgetItems.map(b=>b.category),...original.map(expenseCategory)])].filter(Boolean);
 const changes=newRows.length+deleted.length+Object.keys(edits).length;
 const changeType=(r,c)=>({...r,category:c,type:r.type==='deposit'&&c!=='Нощувки/Хотел'?'expense':r.type});
 function addTest(e){e.preventDefault();const n=val(amount);if(!(n>0))return;
  if(category==='Транспорт'&&/гориво|зареждане|бензин|дизел|газ/i.test(description)){setFetchError('За горивото ще използваме отделната форма с литри, километраж и пълно/частично зареждане.');return;}
  setFetchError('');setNewRows(items=>items.concat([{_key:`new-${Date.now()}-${items.length}`,_original:false,type:'expense',amount:Math.round(n*100)/100,category,description:description.trim(),date:'ТЕСТ'}]));setAmount('');setDescription('');
 }
 function beginEdit(r){if(isFuel(r))return;setEditing(r._key);setEditAmount(String(val(r.amount)));setEditCategory(expenseCategory(r));setEditDescription(String(r.description||''));}
 function saveEdit(e){e.preventDefault();const n=val(editAmount);if(!(n>0))return;
  const row=allEffective.find(r=>r._key===editing);if(!row)return;
  const update={amount:Math.round(n*100)/100,category:editCategory,description:editDescription.trim()};
  if(editCategory==='Транспорт'&&/гориво|зареждане|бензин|дизел|газ/i.test(update.description)){setFetchError('Зареждане на гориво се редактира отделно.');return;}
  setFetchError('');if(row._original)setEdits(prev=>({...prev,[editing]:update}));else setNewRows(prev=>prev.map(r=>r._key===editing?{...r,...update}:r));setEditing(null);
 }
 function removeTest(r){if(r._original)setDeleted(prev=>prev.concat(r._key));else setNewRows(prev=>prev.filter(x=>x._key!==r._key));if(editing===r._key)setEditing(null);}
 function restore(){setNewRows([]);setEdits({});setDeleted([]);setEditing(null);setFetchError('');}
 return <div className="overlay quick-demo-overlay" onClick={onClose}><div className="dialog quick-demo-dialog" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>🧪 Управление на разходи · ТЕСТ</h3><button className="ghost" type="button" onClick={onClose}>✕</button></div>
  <div className="quick-demo-alert">🔒 Само симулация — добавянето, редактирането и изтриването НЕ записват в Google Drive. При затваряне всичко се възстановява.</div>
  {!trips.length?<p>Няма заредени пътувания. Прочети данните от Google Drive и опитай отново.</p>:<>
   <label>Пътуване<select value={tripId} onChange={e=>setTripId(e.target.value)}>{trips.map(t=><option key={t.id} value={t.id}>{t.name}{tripState(t)!=='active'?' · само тест':''}</option>)}</select></label>
   {busy&&<p className="muted">Зареждане…</p>}{fetchError&&<p className="error">{fetchError}</p>}
   {details&&<>
    <form className="quick-demo-form" onSubmit={addTest}>
     <h4>➕ Пробен разход</h4>
     <label>Сума (€)<input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required/></label>
     <label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}>{options.map(c=><option key={c} value={c}>{c}</option>)}</select></label>
     <label>Описание<input value={description} onChange={e=>setDescription(e.target.value)} placeholder="Паркинг, обяд…"/></label>
     <button type="submit">Добави тестов разход</button>
    </form>
    <section className="quick-demo-summary"><h4>📊 Контрол на бюджета</h4>
     <div className="quick-demo-grid"><div><small>Разходи преди</small><strong>{money(totalBefore)}</strong></div><div><small>Разходи след</small><strong>{money(totalAfter)}</strong></div><div><small>Бюджет</small><strong>{budgetTotal?money(budgetTotal):'Не е зададен'}</strong></div><div><small>Остава по бюджетен обхват</small><strong>{budgetTotal?money(budgetTotal-scopeAfter):'—'}</strong></div></div>
     {budgetTotal>0&&<div className="quick-demo-meter"><span style={{width:Math.min(100,Math.max(0,scopeAfter/budgetTotal*100))+'%'}}/></div>}
     <p className="quick-demo-note">Разлика на разходите: <b>{money(totalAfter-totalBefore)}</b> · Разлика по бюджетния обхват: <b>{money(scopeAfter-scopeBefore)}</b></p>
     <small className="muted">При бюджет по категории участват само съответните категории. Това е локална проверка, не окончателно сравнение с оригиналните формули.</small>
    </section>
    <section className="quick-demo-list"><h4>📋 История на разходите · {allEffective.length}</h4>
     {changes>0&&<button type="button" className="ghost" onClick={restore}>↶ Възстанови всичко ({changes} тестови промени)</button>}
     {[...allEffective].reverse().map(r=><div className="p17-row" key={r._key}><span><b>{expenseCategory(r)}</b><small>{r.description||'Без описание'} · {r.date||'Без дата'}{r._original?'':' · ТЕСТ'}</small></span><strong>{money(r.amount)}</strong>{isFuel(r)?<small title="Зарежданията се редактират в отделен модул">⛽</small>:<span className="p17-actions"><button className="ghost" type="button" onClick={()=>beginEdit(r)} title="Редактирай пробно">✎</button><button className="ghost" type="button" onClick={()=>removeTest(r)} title="Изтрий пробно">✕</button></span>}</div>)}
     <small className="muted">⛽ Зарежданията са заключени в този тест — необходимо е отделно преизчисляване на горивото.</small>
    </section>
    {editing&&<form className="quick-demo-form p17-edit" onSubmit={saveEdit}><h4>✏️ Редакция · ТЕСТ</h4><label>Сума (€)<input type="number" step="0.01" min="0.01" value={editAmount} onChange={e=>setEditAmount(e.target.value)} required/></label><label>Категория<select value={editCategory} onChange={e=>setEditCategory(e.target.value)}>{options.map(c=><option key={c} value={c}>{c}</option>)}</select></label><label>Описание<input value={editDescription} onChange={e=>setEditDescription(e.target.value)}/></label><div className="p17-actions"><button type="submit">Запази тестово</button><button type="button" className="ghost" onClick={()=>setEditing(null)}>Отказ</button></div></form>}
   </>}
  </>}
 </div></div>;
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
 <div className="actions home-actions"><button onClick={()=>setModal('quick-demo')}>➕ <span><b>Бърз разход · ТЕСТ</b><small>Пробвай без записване</small></span></button><button disabled={readOnly} onClick={()=>setModal('trip')}>✈️ <span><b>Ново пътуване</b><small>Създай ново приключение</small></span></button></div>
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
 {modal==='quick-demo'&&<QuickExpensePreview trips={trips} loadTrip={id=>req(`/trips/${encodeURIComponent(id)}`)} onClose={()=>setModal('')}/>}
 {modal&&modal!=='quick-demo'&&<div className="overlay" onClick={()=>setModal('')}><div className="dialog" onClick={e=>e.stopPropagation()}><div className="dialoghead"><h3>{modal==='trip'?'Ново пътуване':'Нов разход'}</h3><button className="ghost" onClick={()=>setModal('')}>✕</button></div>{modal==='trip'?<form onSubmit={e=>{e.preventDefault();run(()=>req('/trips','POST',{name,start_date:start?start.split('-').reverse().join('.'): '',end_date:end?end.split('-').reverse().join('.'): '',car_trip:car}))}}><label>Дестинация<input value={name} onChange={e=>setName(e.target.value)} required/></label><label>Начална дата<input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label><label>Крайна дата<input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label><label className="toggle"><input type="checkbox" checked={car} onChange={e=>setCar(e.target.checked)}/> Пътуване с автомобил</label><button>Създай</button></form>:<form onSubmit={e=>{e.preventDefault();run(()=>req(`/trips/${encodeURIComponent(current)}/expenses`,'POST',{amount:Number(amount),category,description:desc,is_deposit:category==='Депозит/Резервация'}));setAmount('');setDesc('')}}><label>Сума (€)<input type="number" step="0.01" min="0" value={amount} onChange={e=>setAmount(e.target.value)} required/></label><label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}>{categories.map(x=><option key={x}>{x}</option>)}</select></label><label>Описание<input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Без описание"/></label><button>Добави разход</button></form>}</div></div>}
 <footer>PixelApp React · Етап 1 · Данните остават в Google Drive</footer></main>
}

createRoot(document.getElementById('root')).render(<App/>);
