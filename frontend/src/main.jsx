import React,{useEffect,useMemo,useState,useRef} from 'react';
import{createRoot}from'react-dom/client';
import{ArrowLeft,Plus,Wallet,MapPin,CheckCircle,RefreshCcw,Trash2,CalendarDays,LogOut}from'lucide-react';
import{MapContainer,TileLayer,Marker,Popup,useMap}from'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';

const apiBase=import.meta.env.VITE_API_URL||'http://localhost:8000';

// Patch 56: encrypted, device-local snapshot. No Google token or API key is saved in the cache.
// A cached snapshot is for display ONLY; network validation is required before any real write.
const FAST_CACHE_KEY='pixelapp_home_snapshot_v56';
const FAST_CACHE_MAX_AGE=7*24*60*60*1000;
async function fastCacheCryptoKey(secret){
 const bytes=new TextEncoder().encode(`${apiBase}\n${secret}`);
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function readFastCache(secret){
 try{
  if(!secret||!globalThis.crypto?.subtle)return null;
  const raw=localStorage.getItem(FAST_CACHE_KEY);if(!raw)return null;
  const record=JSON.parse(raw);
  if(!record||record.v!==56||!Number.isFinite(record.at)||Date.now()-record.at>FAST_CACHE_MAX_AGE||record.at>Date.now()+60000)return null;
  const bytes=Uint8Array.from(atob(record.data),c=>c.charCodeAt(0));
  const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:Uint8Array.from(record.iv)},await fastCacheCryptoKey(secret),bytes);
  const snapshot=JSON.parse(new TextDecoder().decode(decrypted));
  return Array.isArray(snapshot.trips)?{...snapshot,at:record.at}:null;
 }catch(_){return null}
}
async function writeFastCache(secret,snapshot){
 try{
  if(!secret||!globalThis.crypto?.subtle||!Array.isArray(snapshot.trips))return;
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},await fastCacheCryptoKey(secret),new TextEncoder().encode(JSON.stringify(snapshot)));
  const data=Array.from(new Uint8Array(ciphertext),b=>String.fromCharCode(b)).join('');
  localStorage.setItem(FAST_CACHE_KEY,JSON.stringify({v:56,at:Date.now(),iv:Array.from(iv),data:btoa(data)}));
 }catch(_){/* Storage limits/privacy mode: app continues normally without a cache. */}
}

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
function FocusRoutePoint({target}){
 const map=useMap();
 useEffect(()=>{if(target && Number.isFinite(target.lat) && Number.isFinite(target.lon)){
  map.flyTo([target.lat,target.lon],Math.max(map.getZoom(),10),{duration:0.65});
 }},[map,target]);
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
 const [view,setView]=useState('categories');
 const [expanded,setExpanded]=useState({});
 const amount=r=>{const n=Number(r.amount);return Number.isFinite(n)?n:0};
 const isPayment=r=>['expense','deposit'].includes(String(r.type||'').toLowerCase());
 const categoryName=r=>r.type==='deposit'?'Нощувки/Хотел':(r.category||'Други');
 const all=rows.filter(isPayment);
 const options=Array.from(new Set(all.map(categoryName))).sort((a,b)=>a.localeCompare(b,'bg'));
 const visible=all.filter(r=>{
  if(category!=='all'&&categoryName(r)!==category)return false;
  if(kind!=='all'&&String(r.type)!==kind)return false;
  const q=search.trim().toLocaleLowerCase('bg');
  return !q||[r.date,r.description,r.category,categoryName(r),r.amount].join(' ').toLocaleLowerCase('bg').includes(q);
 });
 const total=visible.reduce((sum,r)=>sum+amount(r),0);
 const groups=options.map(name=>({name,items:visible.filter(r=>categoryName(r)===name)})).filter(g=>g.items.length).sort((a,b)=>b.items.reduce((n,r)=>n+amount(r),0)-a.items.reduce((n,r)=>n+amount(r),0));
 const categoryIcon=name=>name==='Транспорт'?'🚗':name==='Храна и напитки'?'🍔':name==='Нощувки/Хотел'?'🏨':name==='Депозит/Резервация'?'💳':name==='Куче'?'🐾':'☀️';
 const colors=['#65c9ed','#e6b768','#b49cff','#7fd4ad','#e698b0','#9caebd'];
 const renderItem=(r,i)=>{
  const text=String(r.description||'Без описание');
  const fuel=/\[(?:ПЪЛНО|ПЪЛЕН|ЧАСТИЧНО)\s+ЗАРЕЖДАНЕ\]/i.test(text);
  const full=/\[(?:ПЪЛНО|ПЪЛЕН)\s+ЗАРЕЖДАНЕ\]/i.test(text);
  const label=fuel?text.replace(/\[(?:ПЪЛНО|ПЪЛЕН|ЧАСТИЧНО)\s+ЗАРЕЖДАНЕ\]/gi,'').replace(/\(Етап:.*?\)/i,'').trim()||'Гориво':text;
  const stage=text.match(/(?:Реален разход:|Разход:)\s*([0-9.,]+)\s*л\s*\/\s*100/i);
  return <div key={`${r._key||r.date||'row'}-${i}`} className="p29-expense-item">
    <div className="p29-expense-info"><strong>{fuel?'⛽ ':''}{label}</strong><small>{r.date||'Без дата'}{r._original===false?' · Временно':''}</small>
      {fuel&&<span className={'p29-fuel-tag '+(full?'full':'partial')}>{full?'Пълно зареждане':'Частично зареждане'}</span>}
      {(Number(r.liters)>0||stage)&&<small className="p29-expense-extra">{Number(r.liters)>0?`${Number(r.liters).toLocaleString('bg-BG')} л`:''}{Number(r.current_km)>0?` · ${Number(r.current_km).toLocaleString('bg-BG')} км`:''}{stage?` · ${stage[1]} л/100 км`:''}</small>}
    </div><b>{money(amount(r))}</b>
  </div>;
 };
 return <div className="travel-card p29-expense-history">
  <div className="p29-expense-heading"><div><small>PIXELAPP · ФИНАНСИ</small><h3>💳 Моите разходи</h3></div><span>🧾</span></div>
  <div className="p29-total-panel"><small>Общо по избраните филтри</small><strong>{money(total)}</strong><span>{visible.length} от {all.length} плащания</span>
   {total>0&&<div className="p29-distribution">{groups.map((g,i)=><span key={g.name} style={{width:Math.max(0,g.items.reduce((n,r)=>n+amount(r),0)/total*100)+'%',background:colors[options.indexOf(g.name)%colors.length]}}/>)}</div>}
  </div>
  <div className="expense-filters p29-expense-filters">
   <label className="expense-search">Търси разход<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Описание, дата или сума" type="search"/></label>
   <label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}><option value="all">Всички категории</option>{options.map(c=><option value={c} key={c}>{c}</option>)}</select></label>
   <label>Вид<select value={kind} onChange={e=>setKind(e.target.value)}><option value="all">Всички плащания</option><option value="expense">Разходи</option><option value="deposit">Депозити</option></select></label>
  </div>
  <div className="p29-view-tabs"><button type="button" className={view==='categories'?'selected':''} onClick={()=>setView('categories')}>◫ По категории</button><button type="button" className={view==='timeline'?'selected':''} onClick={()=>setView('timeline')}>☷ Хронология</button></div>
  {visible.length?view==='categories'?<div className="p29-category-stack">{groups.map((g,i)=>{
   const opened=expanded[g.name]??(i===0);
   const subtotal=g.items.reduce((n,r)=>n+amount(r),0);
   return <section className="p29-category-card" key={g.name}>
    <button type="button" className="p29-category-head" onClick={()=>setExpanded(prev=>({...prev,[g.name]:!(prev[g.name]??(i===0))}))} aria-expanded={opened}>
     <span className="p29-category-icon" style={{background:colors[options.indexOf(g.name)%colors.length]+'22'}}>{categoryIcon(g.name)}</span>
     <span className="p29-category-title"><strong>{g.name}</strong><small>{g.items.length} {g.items.length===1?'разход':'разхода'}</small></span>
     <span className="p29-category-value"><b>{money(subtotal)}</b><small>{opened?'⌃':'⌄'}</small></span>
    </button>
    {opened&&<div className="p29-category-entries">{[...g.items].reverse().map(renderItem)}</div>}
   </section>;
  })}</div>:<div className="p29-timeline">{[...visible].reverse().map(renderItem)}</div>:<p className="muted">Няма разходи за избраните филтри.</p>}
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
 const normalCount=all.filter(r=>!r._manual).length;
 const manualCount=all.length-normalCount;
 const fmt=n=>num(n).toLocaleString('bg-BG',{minimumFractionDigits:2,maximumFractionDigits:2});
 return <div className="travel-card fuel-history-card"><h3 className="p35-history-heading">🧾 История на горивото</h3><div className="p35-history-counters"><span>⛽ Зареждания: <b>{normalCount}</b></span><span>✍️ Ръчно: <b>{manualCount}</b></span></div>
 {all.length?<>{all.slice(selected,selected+1).map((r,offset)=>{
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
  if(r._manual){
   return <div className="p33-manual-card" key={`${r._index}-${r.date}`}>
    <div className="p33-manual-head"><span>✍️ Пропуснато гориво</span><span className="p33-manual-tag">Ръчно</span></div>
    <div className="p33-manual-amount">{fmt(r._liters)} <small>л</small></div>
    <div className="p33-manual-footer"><span>{r.date||'Без дата'}</span><strong>{num(r.amount)>0?money(r.amount):'Без известна сума'}</strong></div>
   </div>;
  }
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
 })}<nav className="fuel-history-pager" aria-label="Преглед на зареждания"><button type="button" aria-label="Предишно зареждане" disabled={selected===0} onClick={()=>setSelected(i=>Math.max(0,i-1))}>‹</button><span><strong>{Math.min(selected+1,all.length)} / {all.length}</strong><small>Запис за гориво</small></span><button type="button" aria-label="Следващо зареждане" disabled={selected>=all.length-1} onClick={()=>setSelected(i=>Math.min(all.length-1,i+1))}>›</button></nav></>:<p className="muted">Няма записани зареждания с литри.</p>}
 </div>;
}

// Patch 71: confirmed full-to-full consumption, independently derived from stored fuel rows.
// First full tank is a reference point, not a measured stage. Partial refills between
// two full tanks are included in the second full tank's measured fuel.
function confirmedFuelStage(rows,startKm){
 const number=v=>{const n=Number(String(v??'').replace(',','.'));return Number.isFinite(n)?n:0};
 const readings=(rows||[]).filter(r=>String(r.type)==='expense'&&String(r.category)==='Транспорт'&&number(r.liters)>0&&number(r.current_km)>0)
  .map(r=>({km:number(r.current_km),liters:number(r.liters),desc:String(r.description||'')}))
  .sort((a,b)=>a.km-b.km);
 let lastFull=null,partial=0,latest=null;
 for(const r of readings){
  if(r.km<=number(startKm))continue;
  const full=/\[ПЪЛН(?:О|ЕН)\s+ЗАРЕЖДАНЕ\]/i.test(r.desc);
  const part=/\[ЧАСТИЧНО\s+ЗАРЕЖДАНЕ\]/i.test(r.desc);
  if(!full&&!part)continue;
  if(full){
   if(lastFull&&r.km>lastFull.km){
    const distance=r.km-lastFull.km;
    const usedLiters=partial+r.liters;
    latest={distance,liters:usedLiters,consumption:usedLiters/distance*100,fromKm:lastFull.km,toKm:r.km};
   }
   lastFull=r;partial=0;
  }else if(lastFull){partial+=r.liters}
 }
 return latest;
}

// Пач 27: обща временна памет за пробните разходи; никога не изпраща POST към Drive.
const blankExpenseDraft=()=>({newRows:[],edits:{},deleted:[],baseRows:[]});
const paymentRow=r=>['expense','deposit'].includes(String(r.type||'').toLowerCase());
// Temporary fuel edits are recalculated in odometer order so a later full tank
// never displays an obsolete real-consumption value after deleting/editing a refill.
function recalculateFuelStages(rows){
 const number=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
 const fuel=rows.map((r,i)=>({...r,_position:i})).filter(r=>r.type==='expense'&&r.category==='Транспорт'&&number(r.liters)>0&&number(r.current_km)>0).sort((a,b)=>number(a.current_km)-number(b.current_km));
 const replacements=new Map();let priorFull=null;let partialLiters=0;
 for(const r of fuel){
  const raw=String(r.description||'');
  const isFull=/\[ПЪЛН(?:О|ЕН)\s+ЗАРЕЖДАНЕ\]/i.test(raw);
  const isPartial=/\[ЧАСТИЧНО\s+ЗАРЕЖДАНЕ\]/i.test(raw);
  if(!isFull&&!isPartial)continue;
  if(isFull){
   const clean=raw.replace(/\s*\(Етап:\s*[^)]*?Реален разход:\s*[^)]*\)/gi,'').trim();
   let next=clean;
   if(priorFull){const dist=number(r.current_km)-number(priorFull.current_km);const liters=partialLiters+number(r.liters);
    if(dist>0&&liters>0)next+=` (Етап: ${Math.round(dist)}км, Реален разход: ${(liters/dist*100).toFixed(1)}л/100км)`;
   }
   replacements.set(r._position,{...rows[r._position],description:next});priorFull=r;partialLiters=0;
  }else if(priorFull){partialLiters+=number(r.liters)}
 }
 return rows.map((r,i)=>replacements.get(i)||r);
}
function applyExpenseDraft(rows,draft){
 if(!draft)return rows||[];
 let paymentIndex=0;
 const output=[];
 for(const row of rows||[]){
  if(!paymentRow(row)){output.push(row);continue;}
  const id=`old-${paymentIndex++}`;
  if((draft.deleted||[]).includes(id))continue;
  const change=(draft.edits||{})[id]||{};
  output.push({...row,...change,_temporaryEdited:Object.keys(change).length>0});
 }
 const merged=output.concat((draft.newRows||[]).map(r=>({...r,_temporary:true})));
 const originalPayments=(rows||[]).filter(paymentRow);
 const fuelTouched=(draft.newRows||[]).some(r=>Number(r.liters)>0) ||
  (draft.deleted||[]).some(key=>{const i=Number(String(key).replace('old-',''));return Number(originalPayments[i]?.liters)>0;}) ||
  Object.keys(draft.edits||{}).some(key=>{const i=Number(String(key).replace('old-',''));return Number(originalPayments[i]?.liters)>0||Number(draft.edits[key]?.liters)>0;});
 return fuelTouched?recalculateFuelStages(merged):merged;
}
function expenseDraftDelta(draft){
 if(!draft)return 0;
 const original=(draft.baseRows||[]).filter(paymentRow);
 const before=original.reduce((sum,r)=>sum+Number(r.amount||0),0);
 const after=applyExpenseDraft(original,draft).filter(paymentRow).reduce((sum,r)=>sum+Number(r.amount||0),0);
 return after-before;
}
function hasExpenseChanges(draft){return !!draft&&((draft.newRows||[]).length>0||(draft.deleted||[]).length>0||Object.keys(draft.edits||{}).length>0)}

// Budget insight panel: follows Streamlit's daily-pace exclusions and calendar logic.
function BudgetInsights({rows,settings,budgetTotal,globalBudget,budgetEntries,budgetScopedCosts,allCosts,byCat}) {
 const validDate=value=>{const m=String(value||'').match(/^(\d{2})\.(\d{2})\.(\d{4})/);if(m){const d=new Date(+m[3],+m[2]-1,+m[1]);return d.getFullYear()===+m[3]&&d.getMonth()===+m[2]-1?d:null}const iso=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);if(iso){const d=new Date(+iso[1],+iso[2]-1,+iso[3]);return d.getFullYear()===+iso[1]&&d.getMonth()===+iso[2]-1?d:null}return null};
 const start=validDate(settings.start_date),end=validDate(settings.end_date);
 const today=new Date();today.setHours(0,0,0,0);
 const calendarOk=!!(start&&end&&end>=start);
 const totalDays=calendarOk?Math.max(1,Math.round((end-start)/86400000)+1):1;
 const elapsedDays=calendarOk?Math.max(1,Math.min(totalDays,Math.floor((today-start)/86400000)+1)):1;
 const remainingDays=calendarOk?Math.max(0,totalDays-elapsedDays):null;
 const hasBudget=budgetTotal>0;
 const spent=budgetScopedCosts,remaining=budgetTotal-spent,pct=hasBudget?spent/budgetTotal*100:0;
 const spendRows=rows.filter(r=>['expense','deposit'].includes(String(r.type||'').toLowerCase()));
 // Streamlit: daily spending is on-site spending excluding hotel payments;
 // deposits are not part of on-site spending.
 const dailySpent=Math.max(0,spendRows.filter(r=>r.type==='expense'&&r.category!=='Нощувки/Хотел').reduce((sum,r)=>sum+Number(r.amount||0),0));
 const hotelSpend=spendRows.filter(r=>r.type==='expense'&&r.category==='Нощувки/Хотел').reduce((sum,r)=>sum+Number(r.amount||0),0);
 const deposits=spendRows.filter(r=>r.type==='deposit').reduce((sum,r)=>sum+Number(r.amount||0),0);
 const hotelBudget=budgetEntries.find(b=>b.category==='Нощувки/Хотел');
 const dailyPool=globalBudget>0?Math.max(0,budgetTotal-hotelSpend-deposits):Math.max(0,budgetTotal-Number(hotelBudget?.budget||0));
 const dailyTarget=dailyPool/totalDays,actualDaily=dailySpent/elapsedDays,forecast=actualDaily*totalDays,diff=actualDaily-dailyTarget;
 const paceRatio=dailyTarget>0?actualDaily/dailyTarget:0;
 const mood=paceRatio<=.8?'🟢 БЮДЖЕТЪТ ВЪРВИ ДОБРЕ':paceRatio<=1?'🟡 ХАРЧИШ БЛИЗО ДО ПЛАНА':'🔴 ХАРЧИШ ПРЕКАЛЕНО БЪРЗО';
 const dayTotals=new Map();spendRows.forEach(r=>{const d=validDate(r.date);if(!d)return;const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;dayTotals.set(key,(dayTotals.get(key)||0)+Number(r.amount||0))});
 const days=[...dayTotals.entries()].sort((a,b)=>a[0].localeCompare(b[0])).slice(-7).map(([day,amount])=>({day,amount}));
 const maxDay=Math.max(1,...days.map(d=>d.amount));
 const cats=Object.entries(byCat).filter(([,amount])=>amount>0).sort((a,b)=>b[1]-a[1]).slice(0,6);
 const catTotal=Object.values(byCat).reduce((a,b)=>a+Number(b||0),0);
 return <section className="travel-card p36-budget" aria-label="Финансово табло">
  <div className="p36-budget-head"><h3>📊 Финансово табло</h3><span>{globalBudget>0?'Общ бюджет':'Бюджети по категории'}</span></div>
  {!hasBudget&&<p className="p36-budget-note">Няма зададен бюджет. Разходите по дни и категории остават достъпни, но дневният план изисква бюджет.</p>}
  <div className="p36-kpis">
   <div><small>ОБЩ БЮДЖЕТ</small><strong className="p36-green">{hasBudget?money(budgetTotal):'—'}</strong><span>{globalBudget>0?'Общ бюджет':'По категории'}</span></div>
   <div><small>ПОХАРЧЕНО</small><strong className="p36-blue">{money(hasBudget?spent:allCosts)}</strong><span>{hasBudget?`${pct.toFixed(1)}% от бюджета`:'Всички разходи'}</span></div>
   <div><small>ОСТАВАЩО</small><strong className={remaining<0?'p36-red':'p36-blue'}>{hasBudget?money(remaining):'—'}</strong><span>{hasBudget?(remaining>=0?'В бюджета':'Над бюджета'):'Няма бюджет'}</span></div>
   <div><small>ОСТАВАЩИ ДНИ</small><strong className="p36-orange">{remainingDays===null?'—':remainingDays}</strong><span>{calendarOk?`от ${totalDays} дни`:'Не са зададени дати'}</span></div>
  </div>
  {hasBudget&&<div className="p36-progress"><div><span>БЮДЖЕТЕН ПРОГРЕС</span><b>{pct.toFixed(1)}%</b></div><div className="p36-progress-track"><span className={remaining<0?'p36-over':''} style={{width:Math.min(100,Math.max(0,pct))+'%'}}/></div></div>}
  <div className="p36-panels">
   <section className="p36-panel"><h4>📈 РАЗХОДИ ПО ДНИ</h4>{days.length?<div className="p36-bars">{days.map(({day,amount})=><div key={day} className="p36-bar-column"><span>{Math.round(amount)} €</span><div className="p36-bar-space"><i style={{height:Math.max(7,amount/maxDay*100)+'%'}}/></div><small>{day.slice(8,10)}.{day.slice(5,7)}</small></div>)}</div>:<p className="muted">Няма достатъчно данни за дневна графика.</p>}<small className="p36-panel-note">Последните до 7 дни със записани разходи</small></section>
   <section className="p36-panel"><h4>📊 ПО КАТЕГОРИЯ</h4>{cats.length?cats.map(([name,value],i)=><div className="p36-category" key={name}><div><span>{name}</span><b>{money(value)}</b></div><div className="p36-cat-track"><i style={{width:(catTotal>0?value/catTotal*100:0)+'%',background:['#36ce83','#4eb6ef','#9f71ff','#ed955a','#f3c962','#67d6ba'][i%6]}}/></div></div>):<p className="muted">Няма разходи по категории.</p>}</section>
   <section className="p36-panel p36-pace"><h4>📅 ДНЕВЕН ТЕМП</h4>{hasBudget&&calendarOk?<><strong>{money(dailyTarget)}</strong><small>планирано на ден</small><div className="p36-pace-details"><div>Реално: <b>{money(actualDaily)}/ден</b></div><div>Прогноза: <b>{money(forecast)}</b></div></div><div className="p36-pace-state"><b>{mood}</b><span>{diff<0?`Под плана си с ${money(-diff)}/ден`:diff>0?`Над плана си с ${money(diff)}/ден`:'Точно по плана си'}</span><span>Остават: {money(dailyPool-dailySpent)}</span></div><small className="p36-panel-note">Темпото не включва хотелски разходи и депозити.</small></>:<p className="muted">За дневен план са нужни бюджет и начална/крайна дата.</p>}</section>
  </div>
 </section>;
}

function TripDetails({trip,detail,readOnly,onOpenPreview,expenseDraft,financeOwned=false,onTaskPreflight,onTaskChange,onTasksSaved,onRoutePreflight,onRouteChange,onRouteSaved,onFavoritesLoad,onFavoriteChange}) {
 const [section,setSection]=useState('summary');
 const [mapTab,setMapTab]=useState('route');
 const [taskBusy,setTaskBusy]=useState(false);
 const [taskMessage,setTaskMessage]=useState('');
 const [taskName,setTaskName]=useState('');
 const [taskEditing,setTaskEditing]=useState(null);
 const [taskEditText,setTaskEditText]=useState('');
 const [taskEditRevision,setTaskEditRevision]=useState('');
 const [taskEditOriginal,setTaskEditOriginal]=useState(null);
 const [routeBusy,setRouteBusy]=useState(false);
 const [routeMessage,setRouteMessage]=useState('');
 const [routeName,setRouteName]=useState('');
 const [routeLat,setRouteLat]=useState('');
 const [routeLon,setRouteLon]=useState('');
 const [routeType,setRouteType]=useState('planned');
 const [routePosition,setRoutePosition]=useState('-1');
 const [routeFocus,setRouteFocus]=useState(null);
 const [roadRoute,setRoadRoute]=useState({status:'idle',legs:[],total:0});

 const [favorites,setFavorites]=useState([]);
 const [favoriteHash,setFavoriteHash]=useState('');
 const [favoriteBusy,setFavoriteBusy]=useState(false);
 const [favoriteMessage,setFavoriteMessage]=useState('');
 const [favoriteEditing,setFavoriteEditing]=useState(-1);
 const [favoriteEditorOpen,setFavoriteEditorOpen]=useState(false);
 const [favoriteName,setFavoriteName]=useState('');
 const [favoriteLat,setFavoriteLat]=useState('');
 const [favoriteLon,setFavoriteLon]=useState('');
 const refreshFavorites=async()=>{
  const result=await onFavoritesLoad();
  setFavorites(result.places||[]);setFavoriteHash(result.sha256||'');
 };
 useEffect(()=>{if(section==='map')void refreshFavorites().catch(e=>setFavoriteMessage('⚠️ '+String(e.message||e)));},[section,trip?.id]);
 const saveFavorite=async(operation,index=-1)=>{
  if(!routeEditable||favoriteBusy)return;
  const title=favoriteName.trim(),lat=Number(favoriteLat),lon=Number(favoriteLon);
  if(operation!=='delete'&&(!title||!favoriteLat.trim()||!favoriteLon.trim()||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)){
   setFavoriteMessage('⚠️ Въведи валидно име и координати.');return;
  }
  setFavoriteBusy(true);setFavoriteMessage('');
  try{
   const current=await onFavoritesLoad();
   if(!current.can_write)throw Error('Google Drive се е променил. Обнови страницата.');
   await onFavoriteChange({operation,index,title,lat,lon,expected_sha256:current.sha256});
   await refreshFavorites();setFavoriteEditing(-1);setFavoriteEditorOpen(false);setFavoriteName('');setFavoriteLat('');setFavoriteLon('');
   setFavoriteMessage('✅ Записано и проверено в Google Drive.');
  }catch(e){setFavoriteMessage('⚠️ '+String(e.message||e))}finally{setFavoriteBusy(false)}
 };
 const [gpsBusy,setGpsBusy]=useState(false);
 const [gpsMessage,setGpsMessage]=useState('');
 const useCurrentGps=()=>{
  if(!navigator.geolocation){setGpsMessage('Този браузър не поддържа GPS местоположение.');return;}
  setGpsBusy(true);setGpsMessage('Определям текущото местоположение…');
  navigator.geolocation.getCurrentPosition(
   position=>{
    const lat=position.coords.latitude,lon=position.coords.longitude;
    setRouteLat(lat.toFixed(6));setRouteLon(lon.toFixed(6));
    setRouteName(name=>name.trim()||'📍 Моята локация');
    setRouteFocus({lat,lon});
    setGpsMessage('📍 Координатите са попълнени. Провери ги и натисни „Запиши спирката“, ако искаш да ги запазиш.');
    setGpsBusy(false);
   },
   error=>{
    setGpsBusy(false);
    setGpsMessage(error.code===1?'GPS достъпът е отказан. Разреши местоположението от настройките на браузъра.': 'GPS местоположението не беше определено. Опитай на открито или използвай търсенето.');
   },{enableHighAccuracy:true,timeout:12000,maximumAge:30000}
  );
 };
 const [placeQuery,setPlaceQuery]=useState('');
 const [placeResults,setPlaceResults]=useState([]);
 const [placeSearching,setPlaceSearching]=useState(false);
 const [placeSearchError,setPlaceSearchError]=useState('');
 const placeSearchLast=useRef(0);
 const placeSearchSeq=useRef(0);
 const searchRoutePlace=async(e)=>{
  e.preventDefault();
  const query=placeQuery.trim();
  if(query.length<3||placeSearching)return;
  const now=Date.now();
  if(now-placeSearchLast.current<1100){setPlaceSearchError('Изчакай секунда преди ново търсене.');return;}
  placeSearchLast.current=now;
  const requestId=++placeSearchSeq.current;
  setPlaceSearching(true);setPlaceSearchError('');setPlaceResults([]);
  try{
   // Nominatim public search: only explicit user clicks, no autocomplete/bulk requests.
   const url=new URL('https://nominatim.openstreetmap.org/search');
   url.searchParams.set('q',query);url.searchParams.set('format','jsonv2');
   url.searchParams.set('limit','5');url.searchParams.set('addressdetails','1');
   url.searchParams.set('accept-language','bg,en');
   const response=await fetch(url.toString(),{headers:{Accept:'application/json'}});
   if(!response.ok)throw new Error(`Услугата за търсене не отговори (${response.status}).`);
   const results=await response.json();
   if(requestId!==placeSearchSeq.current)return;
   if(!Array.isArray(results))throw new Error('Невалиден отговор от търсенето.');
   let places=results.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))).slice(0,5);
   // Photon indexes multilingual OpenStreetMap names and can find places that
   // Nominatim misses with a localized spelling. Only search on button click.
   if(!places.length){
    try{
     const fallback=new URL('https://photon.komoot.io/api/');
     fallback.searchParams.set('q',query);
     fallback.searchParams.set('limit','5');
     const photonResponse=await fetch(fallback.toString(),{headers:{Accept:'application/json'}});
     if(photonResponse.ok){
      const photonData=await photonResponse.json();
      const features=Array.isArray(photonData?.features)?photonData.features:[];
      places=features.map((f,i)=>{
       const p=f.properties||{},coords=f.geometry?.coordinates||[];
       const parts=[p.name,p.street,p.city,p.state,p.country].filter(Boolean);
       return {place_id:`photon-${p.osm_id||i}`,name:p.name||p.city||query,
        display_name:[...new Set(parts)].join(', ')||query,lon:coords[0],lat:coords[1]};
      }).filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))).slice(0,5);
     }
    }catch(_fallbackError){/* Manual coordinates remain available. */}
   }
   if(requestId!==placeSearchSeq.current)return;
   setPlaceResults(places);
   if(!places.length)setPlaceSearchError('Няма намерени места. Опитай с международното име (например Colosseo, Roma) или въведи координати.');
  }catch(error){if(requestId===placeSearchSeq.current)setPlaceSearchError('Търсенето не успя. Можеш да въведеш координатите ръчно. '+String(error.message||error));}
  finally{if(requestId===placeSearchSeq.current)setPlaceSearching(false);}
 };
 const chooseRoutePlace=(p)=>{
  const fullName=String(p.display_name||'').trim();
  const shortName=String(p.name||fullName.split(',')[0]||placeQuery).trim();
  setRouteName(shortName.slice(0,150));setRouteLat(String(p.lat));setRouteLon(String(p.lon));
  setPlaceQuery(fullName);setPlaceResults([]);setPlaceSearchError('');
 };

 useEffect(()=>{setSection('summary');setTaskName('');setTaskEditing(null);setTaskEditRevision('');setTaskEditOriginal(null);setTaskMessage('');},[trip?.id]);
 const rows=applyExpenseDraft(detail?.expenses||[],expenseDraft), settings=detail?.settings||trip?.settings||{}, budgets=detail?.budgets||[], tasks=detail?.tasks||[], points=detail?.points||[];
 const number=x=>Number.isFinite(Number(x))?Number(x):0;
 const allCosts=rows.filter(r=>['expense','deposit'].includes(r.type)).reduce((a,r)=>a+number(r.amount),0);
 const byCat={};rows.filter(paymentRow).forEach(r=>{const category=r.type==='deposit'?'Нощувки/Хотел':(r.category||'Други');byCat[category]=(byCat[category]||0)+number(r.amount)});
 const budgetEntries=budgets.filter(r=>r.category!=='__GLOBAL__'&&number(r.budget)>0);
 const globalBudget=budgets.filter(r=>r.category==='__GLOBAL__').reduce((a,r)=>a+number(r.budget),0);
 const budgetTotal=globalBudget>0?globalBudget:budgetEntries.reduce((a,r)=>a+number(r.budget),0);
 const fuelRows=rows.filter(r=>r.type==='expense'&&r.category==='Транспорт'&&number(r.liters)>0);
 // Streamlit: paid missing fuel is counted through manual_fuel, not row.liters.
 // The original settings already include old paid missing fuel; only newly drafted rows add here.
 const paidManualPreview=(expenseDraft?.newRows||[]).filter(r=>r._manualFromSettings&&r._manualFuelDelta>0).reduce((a,r)=>a+number(r._manualFuelDelta),0);
 const liters=fuelRows.reduce((a,r)=>a+number(r.liters),0)+number(settings.manual_fuel)+paidManualPreview;
 const fuelSpend=rows.filter(r=>r.type==='expense'&&r.category==='Транспорт'&&(number(r.liters)>0||/газ|гориво|зареждане|бензин|дизел/i.test(String(r.description||'')))).reduce((a,r)=>a+number(r.amount),0);
 const begin=number(settings.start_km),finish=number(settings.end_km);
 const maxReading=Math.max(0,...rows.map(r=>number(r.current_km)));
 const effectiveReading=finish>0?finish:maxReading;
 const km=Math.max(0,effectiveReading-begin);
 const avgLiters=fuelRows.reduce((sum,r)=>sum+number(r.liters),0)+number(settings.manual_fuel)+paidManualPreview;
 const avg=km>0&&avgLiters>0?avgLiters/km*100:0;
 const measuredFuel=confirmedFuelStage(rows,begin);
 const realConsumption=measuredFuel?.consumption??0;
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
 const previewTasks=tasks.map((t,i)=>({...t,_previewKey:String(t.item_id??`old-${i}`)}));
 const done=previewTasks.filter(taskIsDone).length;
 const taskEditable=financeOwned && !trip?.settings?.trip_finished?.toLowerCase?.().includes('да');
 const changeTask=async(operation,t=null,title='')=>{
  if(!taskEditable||taskBusy)return;
  setTaskBusy(true);setTaskMessage('');
  try{
   // An edit must use the revision captured when the editor was opened.
   // Fetching a fresh revision at save time silently overwrites another user's edit.
   if(operation==='edit'&&(!taskEditRevision||!taskEditOriginal||String(taskEditOriginal.item_id)!==String(t?.item_id)))
    throw Error('Редакцията няма валидна начална версия. Отвори задачата отново.');
   const pre=operation==='edit'
     ? {can_write:true,sha256:taskEditRevision}
     : await onTaskPreflight();
   if(!pre.can_write)throw Error('Записът не е разрешен или Google Drive е променен. Обнови страницата.');
   await onTaskChange({operation,item_id:t?.item_id||'',title,expected_sha256:pre.sha256,
    ...(operation==='edit'?{expected_title:taskEditOriginal.title,expected_done:taskEditOriginal.done}:{} )});
   await onTasksSaved();
   setTaskName('');setTaskEditing(null);setTaskEditRevision('');setTaskEditOriginal(null);setTaskMessage('✅ Записано и проверено в Google Drive.');
  }catch(err){setTaskMessage('⚠️ '+String(err.message||err));}
  finally{setTaskBusy(false);}
 };
 const beginTaskEdit=async t=>{
  if(!taskEditable||taskBusy)return;
  setTaskBusy(true);setTaskMessage('');
  try{
   const pre=await onTaskPreflight();
   if(!pre.can_write)throw Error('Задачите са променени. Обнови списъка преди редакция.');
   // Don't open the editor against a different version of the task itself.
   const remote=(pre.tasks||[]).find(x=>String(x.item_id)===String(t.item_id));
   if(!remote||String(remote.title||'')!==String(t.title||'')||String(remote.done||'').toLowerCase()!==String(t.done||'').toLowerCase())
    throw Error('Тази задача е променена на друго устройство. Обнови списъка.');
   setTaskEditRevision(pre.sha256);
   setTaskEditOriginal({item_id:String(remote.item_id),title:String(remote.title||''),done:String(remote.done||'')});
   setTaskEditing(t._previewKey);setTaskEditText(t.title||'');
  }catch(err){setTaskMessage('⚠️ '+String(err.message||err));}
  finally{setTaskBusy(false);}
 };
 const addPreviewTask=e=>{e.preventDefault();if(taskName.trim())void changeTask('add',null,taskName.trim())};
 const validPoints=points.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))&&Math.abs(Number(p.lat))<=90&&Math.abs(Number(p.lon))<=180);
 const routeStops=validPoints.filter(p=>String(p.title||'').startsWith('3b:')&&['purple','orange'].includes(p.color));
 const savedPlaces=validPoints.filter(p=>!routeStops.includes(p));
 const routeEditable=financeOwned && tripState(trip)!=='finished';
 const routeSignature=routeStops.map(p=>`${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`).join(';');
 useEffect(()=>{
  const coords=routeSignature.split(';').filter(Boolean);
  if(coords.length<2){setRoadRoute({status:'idle',legs:[],total:0});return;}
  // OSRM returns road distances for the ordered route. Never write these to Drive.
  const controller=new AbortController();
  setRoadRoute({status:'loading',legs:[],total:0});
  const path=coords.map(c=>{const [lat,lon]=c.split(',');return `${lon},${lat}`}).join(';');
  fetch(`https://router.project-osrm.org/route/v1/driving/${path}?overview=false&steps=false`,{signal:controller.signal})
   .then(r=>{if(!r.ok)throw Error('Routing service unavailable');return r.json()})
   .then(data=>{
    const legs=data?.routes?.[0]?.legs;
    if(data?.code!=='Ok'||!Array.isArray(legs)||legs.length!==coords.length-1)throw Error('Road route not found');
    setRoadRoute({status:'ready',legs:legs.map(x=>x.distance/1000),total:legs.reduce((sum,x)=>sum+x.distance/1000,0)});
   }).catch(error=>{if(error.name!=='AbortError')setRoadRoute({status:'error',legs:[],total:0})});
  return ()=>controller.abort();
 },[routeSignature]);
 const roadCumulative=index=>roadRoute.legs.slice(0,index).reduce((a,b)=>a+b,0);
 const routeSegments=[];
 // Shared boundary stop between segments; maximum 5 points (3 middle waypoints) per link.
 for(let start=0;start<routeStops.length-1;start+=4)routeSegments.push(routeStops.slice(start,Math.min(start+5,routeStops.length)));
 const makeGoogleRouteLink=p=>{
  const coord=x=>`${Number(x.lat)},${Number(x.lon)}`;
  const url=new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api','1');url.searchParams.set('origin',coord(p[0]));url.searchParams.set('destination',coord(p[p.length-1]));
  if(p.length>2)url.searchParams.set('waypoints',p.slice(1,-1).map(coord).join('|'));
  url.searchParams.set('travelmode','driving');return url.toString();
 };
 const routeAction=async(operation,index=-1,position=-1)=>{
  if(!routeEditable||routeBusy)return;
  setRouteBusy(true);setRouteMessage('');
  try{
   const pre=await onRoutePreflight();
   if(!pre.can_write)throw Error('Маршрутът не е готов за запис. Обнови данните от Google Drive.');
   await onRouteChange({operation,index,position,expected_sha256:pre.sha256,title:routeName.trim(),lat:Number(routeLat),lon:Number(routeLon),stop_type:routeType});
   await onRouteSaved();setRouteName('');setRouteLat('');setRouteLon('');setRouteMessage('✅ Записано и проверено в Google Drive.');
  }catch(e){setRouteMessage('⚠️ '+String(e.message||e))}finally{setRouteBusy(false)}
 };
 const sections=[['summary','Обзор'],['expenses','Разходи'],['fuel','Автомобил'],['budget','Бюджети'],['tasks','Задачи'],['map','Карта'],['check','Проверка']];
 const dateText=(settings.start_date||'')+(settings.end_date&&settings.end_date!==settings.start_date?' → '+settings.end_date:'');
 return <div className="travel-detail">
 <div className="travel-hero"><div className="p34-hero-heading"><div className="travel-overline">🐾 МОЕТО ПЪТУВАНЕ</div><button className="p34-settings-icon" type="button" onClick={()=>onOpenPreview('trip-demo')} title="Настройки на пътуването" aria-label="Настройки на пътуването">⚙️</button></div><h2>🚙 {trip.name}</h2><div className="travel-dates">{dateText}</div><div className="travel-facts visual-top-facts"><div><small>💸 Общо изхарчено</small><strong>{money(allCosts)}</strong></div><div><small>🎯 Бюджет</small><strong>{budgetTotal?money(budgetTotal):'—'}</strong></div><div><small>🚙 Изминати км</small><strong>{km.toLocaleString('bg-BG')}</strong></div></div>{budgetTotal>0&&<div className="travel-progress"><div style={{width:Math.min(100,allCosts/budgetTotal*100)+'%'}}/></div>}</div>
 
 <div className="travel-menu">{sections.map(([id,label])=><button type="button" key={id} onClick={()=>setSection(id)} className={section===id?'selected':''}>{label}</button>)}</div>
 {!detail?<div className="travel-card">Зареждаме данните за пътуването…</div>:<>
 {section==='summary'&&<>
 <div className="travel-card visual-section"><h3>✨ Пътуването с един поглед</h3><div className="visual-overview-stats"><div className="overview-tile"><span>🧾</span><small>Записи</small><strong>{rows.length}</strong></div><div className="overview-tile"><span>✅</span><small>Задачи</small><strong>{done} <em>/ {previewTasks.length}</em></strong></div><div className="overview-tile"><span>📍</span><small>Места</small><strong>{validPoints.length}</strong></div><div className="overview-tile"><span>⛽</span><small>Гориво</small><strong>{liters.toLocaleString('bg-BG',{maximumFractionDigits:1})} <em>л</em></strong></div></div></div>
 <div className="travel-card visual-section"><h3>💳 Разходи по категории</h3>{Object.keys(byCat).length?Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([name,val],i)=>{const ratio=allCosts>0?Math.max(0,Math.min(100,val/allCosts*100)):0;return <div className="visual-category" key={name}><div className="visual-category-head"><span><i className={'visual-category-dot visual-palette-'+i%5}/>{name}</span><strong>{money(val)}</strong></div><div className="visual-category-bar"><span className={'visual-palette-bg-'+i%5} style={{width:ratio+'%'}}/></div><small>{ratio.toFixed(1)}% от общите разходи</small></div>}):<p className="muted">Няма записани разходи.</p>}</div>
 <div className="travel-card visual-section"><h3>🚗 Гориво и път</h3><div className="visual-overview-stats visual-road-stats"><div className="overview-tile"><span>🛣️</span><small>Изминато</small><strong>{km.toLocaleString('bg-BG')} <em>км</em></strong></div><div className="overview-tile"><span>⛽</span><small>Среден разход</small><strong>{avg?avg.toFixed(1):'—'} <em>л/100 км</em></strong></div></div></div>
 </>}
 {section==='expenses'&&<><div className="p24-section-actions"><button type="button" onClick={()=>onOpenPreview('quick-demo')}>➕ Добави или редактирай разход</button>{financeOwned&&<button type="button" className="ghost" onClick={()=>onOpenPreview('pilot-budget')}>🎯 Бюджет</button>}</div><ExpenseHistory rows={rows}/></>}
 {section==='fuel'&&<>

 <div className="travel-card"><h3>🚙 Пробег на автомобила</h3>
 {settings.car_trip==='Не'?<p className="muted">Това пътуване е отбелязано като пътуване без собствен автомобил. Показаните данни са само записаните показания, ако има такива.</p>:null}
 <div className="fuel-road" aria-hidden="true"><span className="fuel-road-node fuel-road-start">S</span><span className="fuel-road-line"/><span className="fuel-road-node fuel-road-current">🚗</span><span className="fuel-road-line"/><span className="fuel-road-node fuel-road-finish">F</span></div>
 <div className="fuel-odometer"><div><small>Старт</small><b>{begin?begin.toLocaleString('bg-BG')+' км':'—'}</b></div><div><small>Изминати</small><b className="fuel-accent">{km.toLocaleString('bg-BG')} км</b></div><div><small>{finish>begin?'Краен':'Последни км'}</small><b>{effectiveReading>0?effectiveReading.toLocaleString('bg-BG')+' км':'—'}</b></div></div>
 {finish>begin&&<p className="fuel-note">Пътуването има записани крайни километри.</p>}
 </div>
 <div className="travel-card"><h3>⛽ Разход на гориво</h3>
 {realConsumption>0&&avg>0?<div className="fuel-metrics visual-gauges"><div><small className="gauge-label gauge-label-red">РЕАЛЕН РАЗХОД</small><div className="gauge-circle gauge-circle-red"><b>{realConsumption.toFixed(1)}</b><em>л/100 км</em></div><small>{measuredFuel?`Етап: ${measuredFuel.fromKm.toLocaleString('bg-BG')} → ${measuredFuel.toKm.toLocaleString('bg-BG')} км · ${measuredFuel.liters.toLocaleString('bg-BG')} л`:'Последен потвърден етап'}</small></div><div><small className="gauge-label gauge-label-orange">СРЕДЕН РАЗХОД</small><div className="gauge-circle gauge-circle-orange"><b>{avg.toFixed(1)}</b><em>л/100 км</em></div><small>Ориентир: всички отчетени литри ÷ общия пробег</small></div></div>:<div className="fuel-metrics visual-gauges p20-active-gauge"><div><small className="gauge-label gauge-label-orange">{realConsumption>0?'РЕАЛЕН РАЗХОД · ЕТАП':avg>0?'СРЕДЕН РАЗХОД · ОРИЕНТИР':'РАЗХОД НА ГОРИВО'}</small><div className="gauge-circle gauge-circle-orange"><b>{realConsumption>0?realConsumption.toFixed(1):avg>0?avg.toFixed(1):'—'}</b><em>л/100 км</em></div><small>{realConsumption>0&&measuredFuel?`Етап между пълни зареждания: ${measuredFuel.distance.toLocaleString('bg-BG')} км · ${measuredFuel.liters.toLocaleString('bg-BG')} л`:avg>0?'Ориентир по общите отчетени литри и пробег':'Няма достатъчно данни за изчисление'}</small></div></div>}
 <div className="p35-fuel-summary"><div className="p35-fuel-total"><div className="p35-summary-heading"><span className="p35-summary-icon">⛽</span><small>Общо гориво</small></div><strong>{liters.toLocaleString('bg-BG',{maximumFractionDigits:2})} л</strong><small>Всички отчетени литри</small></div><div className="p35-fuel-paid"><div className="p35-summary-heading"><span className="p35-summary-icon">💳</span><small>Платено гориво</small></div><strong>{money(fuelSpend)}</strong><small>Известни разходи за гориво</small></div></div>
 {number(settings.manual_fuel)>0&&<p className="fuel-note">В общото количество са включени {number(settings.manual_fuel).toLocaleString('bg-BG')} л ръчно добавено гориво.</p>}
 </div>
 <FuelHistory rows={rows}/>
 </>}
 {section==='budget'&&<>
 <BudgetInsights rows={rows} settings={settings} budgetTotal={budgetTotal} globalBudget={globalBudget} budgetEntries={budgetEntries} budgetScopedCosts={budgetScopedCosts} allCosts={allCosts} byCat={byCat}/>
 <div className="travel-card budget-showcase"><h3>🎯 Бюджет на пътуването</h3><div className="budget-showcase-total"><small>ОСТАВАЩ БЮДЖЕТ</small><strong className={budgetTotal>0&&allCosts>budgetTotal?'negative':''}>{budgetTotal?money(budgetTotal-allCosts):'—'}</strong></div><div className="budget-showcase-grid"><div><small>Планирано</small><b>{budgetTotal?money(budgetTotal):'—'}</b></div><div><small>Изразходвано</small><b>{money(allCosts)}</b></div></div>{budgetTotal>0&&<><div className="budget-showcase-progress"><span style={{width:Math.min(100,allCosts/budgetTotal*100)+'%'}}/></div><div className="budget-showcase-caption"><span>{Math.round(allCosts/budgetTotal*100)}% използвани</span><span>{allCosts>budgetTotal?'Над бюджета':'Остатък'}</span></div></>}</div>
 <div className="travel-card"><h3>🗂️ Бюджети по категории</h3>{budgetEntries.length?budgetEntries.map((b,i)=>{const spent=number(byCat[b.category]),limit=number(b.budget),percent=limit>0?Math.min(100,spent/limit*100):0;return <div className="budget-visual-row" key={b.category}><div className="budget-visual-head"><strong><span className={'visual-category-dot visual-palette-'+i%5}/>{b.category}</strong><b>{money(spent)} <span>/ {money(limit)}</span></b></div><div className="budget-visual-track"><span style={{width:percent+'%',background:spent>limit?'linear-gradient(90deg,#ee866a,#fd4e77)':'linear-gradient(90deg,#45d0ff,#725cff)'}}/></div><div className="budget-visual-foot"><small>{Math.round(limit>0?spent/limit*100:0)}% от бюджета</small><small>{spent>limit?'Над бюджета: '+money(spent-limit):'Остават: '+money(limit-spent)}</small></div></div>}):<p className="muted">Няма зададени отделни бюджети по категории.</p>}</div>
 </>}
 {section==='tasks'&&<>
 <div className="travel-card task-showcase"><h3>✅ План и задачи</h3><div className="task-progress-head"><div><small>ИЗПЪЛНЕНИ ЗАДАЧИ</small><strong>{done} <em>/ {previewTasks.length}</em></strong></div><span>{previewTasks.length?Math.round(done/previewTasks.length*100):0}%</span></div><div className="task-progress-track"><span style={{width:(previewTasks.length?done/previewTasks.length*100:0)+'%'}}/></div></div>
 <div className="travel-card task-preview-panel">
  <div className="task-preview-heading"><h3>📋 Списък със задачи</h3></div>
  
   {taskEditable?<p className="muted">🔐 Запис в Google Drive с проверка за промени и резервно копие.</p>:<p className="muted">🔒 Старите и приключените пътувания са само за преглед.</p>}
  <form className="task-preview-form" onSubmit={addPreviewTask}><input aria-label="Нова задача" value={taskName} maxLength={200} disabled={!taskEditable||taskBusy} onChange={e=>setTaskName(e.target.value)} placeholder="Нова задача…"/><button type="submit" disabled={!taskEditable||taskBusy||!taskName.trim()}>➕ Добави</button></form>
  {previewTasks.length?previewTasks.map(t=>{const complete=taskIsDone(t);const isEditing=taskEditing===t._previewKey;return <div key={t._previewKey} className={'task-visual-item task-preview-item'+(complete?' task-visual-done':'')}>
   <button type="button" className="task-preview-check" disabled={!taskEditable||taskBusy} aria-label={complete?'Отбележи като предстояща':'Отбележи като готова'} onClick={()=>changeTask('toggle',t)}>{complete?'✓':'○'}</button>
   {isEditing?<form className="task-preview-edit" onSubmit={e=>{e.preventDefault();if(taskEditText.trim())void changeTask('edit',t,taskEditText.trim())}}><input autoFocus value={taskEditText} maxLength={200} disabled={taskBusy} onChange={e=>setTaskEditText(e.target.value)}/><button type="submit" disabled={taskBusy||!taskEditText.trim()}>Запази</button><button type="button" className="ghost" onClick={()=>{setTaskEditing(null);setTaskEditRevision('');setTaskEditOriginal(null)}}>Отказ</button></form>:<><span className="task-preview-name">{t.title||'Задача'}</span>{taskEditable&&<><button type="button" className="task-preview-action" disabled={taskBusy} onClick={()=>void beginTaskEdit(t)} aria-label={'Редактирай '+(t.title||'задача')}>✎</button><button type="button" className="task-preview-action" disabled={taskBusy} aria-label="Изтрий задача" onClick={()=>{if(window.confirm('Изтриване на задача: '+t.title+'?'))void changeTask('delete',t)}}>✕</button></>}</>}
  </div>}):<p className="muted">Няма задачи за това пътуване.</p>}
  {taskBusy&&<p className="muted">🔄 Проверявам и записвам…</p>}
  {taskMessage&&<p role="status" className="muted">{taskMessage}</p>}
 </div>
 </>}
 {section==='map'&&<div className="travel-card map-showcase route82-shell"><div className="route82-header"><span className="route82-symbol">▣</span><div><small>PIXELAPP · TRAVEL</small><h3>Места и маршрут</h3></div></div><nav className="route82-tabs" aria-label="Раздели на картата">{[['route','Маршрут'],['favorites','Любими'],['add','Добавяне']].map(([id,label])=><button type="button" key={id} className={mapTab===id?'active':''} aria-current={mapTab===id?'page':undefined} onClick={()=>setMapTab(id)}>{label}</button>)}</nav>
 {mapTab==='route'&&<div className="route82-panel route82-route">
 {validPoints.length?<div className="travel-map"><MapContainer center={[Number(validPoints[0].lat),Number(validPoints[0].lon)]} zoom={8} style={{height:320,width:'100%'}}><FocusRoutePoint target={routeFocus}/><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>{validPoints.map((p,i)=><Marker key={i} position={[Number(p.lat),Number(p.lon)]} icon={homePin}><Popup>{String(p.title||'Място').replace(/^3b:\s*/,'')}</Popup></Marker>)}</MapContainer></div>:<p className="muted">Все още няма точки за това пътуване.</p>}
<div className="route82-route-meta"><span>{routeStops.length} спирки</span><b>{roadRoute.status==='ready'?`${Math.round(roadRoute.total).toLocaleString('bg-BG')} км`:'Маршрут'}</b></div>
 <div className="route76-wrap"><h3>🧭 Спирки по маршрута <span className="map-point-count">{routeStops.length}</span></h3>

 {routeStops.map((p,i)=><div key={`${p.lat}-${p.lon}-${i}`} className="route76-stop route78-stop">
  <button type="button" className="route78-stop-head" onClick={()=>{setRouteFocus({lat:Number(p.lat),lon:Number(p.lon)});}} title="Покажи на картата" aria-label={`Покажи ${String(p.title||'').replace(/^3b:\s*/,'')} на картата`}>
   <span className="route76-num">{i+1}</span><span className="route76-info"><b>{String(p.title||'').replace(/^3b:\s*/,'')}</b><small>{p.color==='orange'?'🟠 Непланирана':'🟣 Планирана'} · 📍 На картата</small></span><span className="route78-pin">⌖</span>
  </button>
  {roadRoute.status==='ready'&&i>0&&<div className="route78-kms"><span>🚗 От предишната: <b>{Math.round(roadRoute.legs[i-1]).toLocaleString('bg-BG')} км</b></span><span>Σ От началото: <b>{Math.round(roadCumulative(i)).toLocaleString('bg-BG')} км</b></span></div>}
  {routeEditable&&<div className="route76-actions"><button type="button" disabled={routeBusy||i===0} onClick={()=>routeAction('move',i,-1)} title="Нагоре" aria-label="Премести нагоре">↑</button><button type="button" disabled={routeBusy||i===routeStops.length-1} onClick={()=>routeAction('move',i,1)} title="Надолу" aria-label="Премести надолу">↓</button><button type="button" disabled={routeBusy} onClick={()=>{if(window.confirm('Да изтрия спирката?'))void routeAction('delete',i)}} title="Изтрий" aria-label="Изтрий спирката">×</button></div>}
 </div>)}
 {roadRoute.status==='loading'&&<p className="muted">🚗 Изчислявам пътните разстояния…</p>}
 {roadRoute.status==='error'&&routeStops.length>1&&<p className="muted">Пътните километри временно не са достъпни. Маршрутът и Google Maps продължават да работят.</p>}
 {roadRoute.status==='ready'&&<div className="route78-total">🚗 Ориентировъчен маршрут по пътищата: <b>{Math.round(roadRoute.total).toLocaleString('bg-BG')} км</b><small>OSRM · не влияе на действителния пробег и горивото</small></div>}
 {routeSegments.length>0&&<div className="route78-links"><b>🗺️ Навигация в Google Maps</b>{routeSegments.map((part,i)=><a key={i} href={makeGoogleRouteLink(part)} target="_blank" rel="noopener noreferrer" className="route76-nav">Етап {i+1}/{routeSegments.length} · точки {i*4+1}–{i*4+part.length}</a>)}{routeSegments.length>1&&<small>Всеки следващ етап започва от последната точка на предишния.</small>}</div>}
 </div></div>}{mapTab==='favorites'&&<div className="route82-panel route82-favorite-panel"><section className="route79-saved route81-favorites" aria-label="Любими места">
 <div className="route81-heading p83-heading"><h3>Любими места</h3><span className="p83-count">{favorites.length} {favorites.length===1?'място':'места'}</span></div>
 {favorites.length?<div className="route81-list p83-list">{favorites.map(p=><div key={p.index} className="p83-card">
 <div className="p83-main"><button type="button" className="p83-place" title="Покажи на картата" onClick={()=>{setRouteFocus({lat:Number(p.lat),lon:Number(p.lon)});setMapTab('route')}}><span className="p83-pin" aria-hidden="true">♥</span><span className="p83-name">{p.title}</span></button>
 {routeEditable&&<details className="p83-menu"><summary aria-label={`Действия за ${p.title}`} title="Още действия">⋯</summary><div className="p83-dropdown"><button type="button" onClick={e=>{e.currentTarget.closest('details').open=false;setFavoriteEditing(p.index);setFavoriteName(p.title);setFavoriteLat(String(p.lat));setFavoriteLon(String(p.lon));setFavoriteEditorOpen(true);}}>✎ Редактирай</button><button type="button" className="p83-danger" disabled={favoriteBusy} onClick={()=>{if(window.confirm('Да изтрия любимото място?'))void saveFavorite('delete',p.index)}}>× Изтрий</button></div></details>}</div>
 <div className="p83-bottom"><span className="p83-desc">Запазена локация</span><div className="p83-quick"><button type="button" title="На картата" aria-label={`Покажи ${p.title} на картата`} onClick={()=>{setRouteFocus({lat:Number(p.lat),lon:Number(p.lon)});setMapTab('route')}}>⌖</button>{routeEditable&&<button type="button" title="Към маршрута" aria-label={`Избери ${p.title} за нова спирка`} onClick={()=>{setRouteName(p.title);setRouteLat(String(p.lat));setRouteLon(String(p.lon));setGpsMessage('Избрано любимо място — запиши като спирка.');setMapTab('add')}}>＋</button>}</div></div>
 </div>)}</div>:<p className="muted">Все още няма любими места.</p>}
 {routeEditable&&<button className="p83-add" type="button" onClick={()=>{if(favoriteEditorOpen&&favoriteEditing<0){setFavoriteEditorOpen(false)}else{setFavoriteEditing(-1);setFavoriteName('');setFavoriteLat('');setFavoriteLon('');setFavoriteEditorOpen(true)}}} aria-expanded={favoriteEditorOpen}>＋ {favoriteEditorOpen&&favoriteEditing<0?'Затвори':'Добави любимо място'}</button>}
 {routeEditable&&favoriteEditorOpen&&<div className="route80-editor route81-editor"><div className="route81-editor-head"><h4>{favoriteEditing>=0?'✏️ Редактирай място':'➕ Ново любимо място'}</h4><button type="button" aria-label="Затвори формата" onClick={()=>{setFavoriteEditorOpen(false);setFavoriteEditing(-1);setFavoriteName('');setFavoriteLat('');setFavoriteLon('');}}>×</button></div>
 <button type="button" className="route80-import" onClick={()=>{setFavoriteName(routeName);setFavoriteLat(routeLat);setFavoriteLon(routeLon);}}>📋 Използвай избраното място от търсенето/GPS</button>
 <input placeholder="Име на любимо място" aria-label="Име на любимо място" maxLength={150} value={favoriteName} onChange={e=>setFavoriteName(e.target.value)}/>
 <div className="route76-grid"><input type="number" step="any" min="-90" max="90" placeholder="Ширина" aria-label="Ширина на любимо място" value={favoriteLat} onChange={e=>setFavoriteLat(e.target.value)}/><input type="number" step="any" min="-180" max="180" placeholder="Дължина" aria-label="Дължина на любимо място" value={favoriteLon} onChange={e=>setFavoriteLon(e.target.value)}/></div>
 <div className="route81-editor-actions"><button type="button" disabled={favoriteBusy||!favoriteName.trim()||!favoriteLat.trim()||!favoriteLon.trim()} onClick={()=>void saveFavorite(favoriteEditing>=0?'edit':'add',favoriteEditing)}>💾 {favoriteEditing>=0?'Запази промяната':'Запази мястото'}</button><button type="button" onClick={()=>{setFavoriteEditorOpen(false);setFavoriteEditing(-1);setFavoriteName('');setFavoriteLat('');setFavoriteLon('');}}>Отказ</button></div>
 </div>}
 {favoriteMessage&&<p role="status" className="muted">{favoriteMessage}</p>}
 </section></div>}{mapTab==='add'&&<div className="route82-panel route82-add-panel">
 {routeEditable?<form className="route76-form" onSubmit={e=>{e.preventDefault();void routeAction('add',-1,Number(routePosition))}}><h3>➕ Нова спирка</h3><div className="route77-search"><label htmlFor="route77-place">🔎 Намери място по име или адрес</label><div className="route77-search-row"><input id="route77-place" type="search" value={placeQuery} onChange={e=>{setPlaceQuery(e.target.value);setPlaceResults([]);setPlaceSearchError('');}} placeholder="Напр. Колизеум, Рим" minLength={3} maxLength={180}/><button type="button" onClick={searchRoutePlace} disabled={placeSearching||placeQuery.trim().length<3}>{placeSearching?'Търся…':'Търси'}</button></div>{placeSearchError&&<p className="route77-search-message" role="status">{placeSearchError}</p>}{placeResults.length>0&&<div className="route77-results" aria-label="Намерени места">{placeResults.map((p,i)=><button key={`${p.place_id||i}-${p.lat}`} type="button" onClick={()=>chooseRoutePlace(p)}><span>📍 {String(p.display_name||p.name||'Място')}</span><small>{Number(p.lat).toFixed(5)}, {Number(p.lon).toFixed(5)}</small></button>)}</div>}<small>Търсене чрез © OpenStreetMap contributors / Nominatim. Избери резултат, после провери данните и запиши спирката.</small></div><div className="route79-gps"><button type="button" onClick={useCurrentGps} disabled={gpsBusy}>{gpsBusy?'📍 Определям местоположение…':'📍 Използвай текущата ми GPS позиция'}</button><small>GPS се използва само след натискане и разрешение от телефона. Не се записва автоматично.</small>{gpsMessage&&<p role="status">{gpsMessage}</p>}</div><input aria-label="Име на спирката" placeholder="Име на мястото" required maxLength={150} value={routeName} onChange={e=>setRouteName(e.target.value)}/><div className="route76-grid"><input type="number" step="any" min="-90" max="90" required placeholder="Ширина (lat)" aria-label="Географска ширина" value={routeLat} onChange={e=>setRouteLat(e.target.value)}/><input type="number" step="any" min="-180" max="180" required placeholder="Дължина (lon)" aria-label="Географска дължина" value={routeLon} onChange={e=>setRouteLon(e.target.value)}/></div><div className="route76-grid"><select value={routeType} onChange={e=>setRouteType(e.target.value)} aria-label="Тип спирка"><option value="planned">Планирана</option><option value="unplanned">Непланирана</option></select><select value={routePosition} onChange={e=>setRoutePosition(e.target.value)} aria-label="Позиция"><option value="-1">В края</option>{routeStops.map((p,i)=><option key={i} value={i}>Преди {i+1}. {String(p.title||'').replace(/^3b:\s*/,'')}</option>)}</select></div><button type="submit" disabled={routeBusy||!routeName.trim()||!routeLat.trim()||!routeLon.trim()}>💾 Запиши спирката</button><small className="muted">Координатите се попълват при избор от търсенето. Можеш и да ги въведеш ръчно.</small></form>:<p className="muted">🔒 За старите и приключените пътувания маршрутът е само за преглед.</p>}
 {routeBusy&&<p className="muted">🔄 Проверявам и записвам…</p>}{routeMessage&&<p role="status" className="muted">{routeMessage}</p>}</div>}</div>}
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

 </>}
 </div>;
}


// Безопасен прототип: изчисленията са само локални, без POST към API.
function FuelEntryPreview({trips,loadTrip,onClose,initialTripId}){
 const [tripId,setTripId]=useState(initialTripId||trips[0]?.id||'');
 const [detail,setDetail]=useState(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [amount,setAmount]=useState('');
 const [liters,setLiters]=useState('');
 const [kmInput,setKmInput]=useState('');
 const [description,setDescription]=useState('Гориво');
 const [fuelType,setFuelType]=useState('full');
 const [mock,setMock]=useState([]);
 const [endKmTest,setEndKmTest]=useState('');
 useEffect(()=>{let live=true;setDetail(null);setMock([]);setError('');setAmount('');setLiters('');setKmInput('');setEndKmTest('');if(!tripId)return;
  setBusy(true);loadTrip(tripId).then(data=>{if(live)setDetail(data)}).catch(err=>{if(live)setError(String(err.message||err))}).finally(()=>{if(live)setBusy(false)});
  return()=>{live=false};
 },[tripId]);
 const num=x=>{const n=Number(String(x??'').replace(',','.'));return Number.isFinite(n)?n:0};
 const settings=detail?.settings||trips.find(t=>t.id===tripId)?.settings||{};
 const start=num(settings.start_km),manual=num(settings.manual_fuel);
 const realRows=(detail?.expenses||[]).filter(r=>String(r.category)==='Транспорт'&&num(r.current_km)>0);
 const recorded=realRows.concat(mock).sort((a,b)=>num(a.current_km)-num(b.current_km));
 const valid=recorded.filter(r=>num(r.current_km)>0);
 const lastKm=valid.length?Math.max(...valid.map(r=>num(r.current_km))):start;
 const lastFull=[...valid].reverse().find(r=>/ПЪЛЕН|ПЪЛНО/i.test(String(r.description||'')));
 const lastFullKm=lastFull?num(lastFull.current_km):start;
 const valLiters=num(liters),valMoney=num(amount),valKm=num(kmInput);
 // Original Streamlit: sum partial litres after previous full tank plus the current full fill;
 // if there is no previous full tank, include all recorded fuel and manual initial litres.
 const earlierLiters=lastFull?valid.filter(r=>num(r.current_km)>lastFullKm).reduce((sum,r)=>sum+num(r.liters),0):valid.reduce((sum,r)=>sum+num(r.liters),0)+manual;
 const segmentKm=valKm-lastFullKm;
 const segmentLiters=earlierLiters+valLiters;
 // First full tank is not a reliable consumption measurement without a known starting fuel baseline.
 const firstFullUnverified=fuelType==='full'&&!lastFull;
 const consumption=fuelType==='full'&&!!lastFull&&valLiters>0&&valKm>lastKm&&segmentKm>0&&segmentLiters>0?segmentLiters/segmentKm*100:null;
 const pricePerLiter=valLiters>0&&valMoney>0?valMoney/valLiters:null;
 const pastFuel=valid.filter(r=>num(r.amount)>0&&num(r.liters)>0);
 const oldPrice=pastFuel.length?num(pastFuel[pastFuel.length-1].amount)/num(pastFuel[pastFuel.length-1].liters):null;
 const spentBefore=(detail?.expenses||[]).filter(r=>['expense','deposit'].includes(String(r.type))).reduce((sum,r)=>sum+num(r.amount),0);
 const budgets=detail?.budgets||[];
 const globalBudget=budgets.filter(b=>b.category==='__GLOBAL__').reduce((sum,b)=>sum+num(b.budget),0);
 const budgetCats=budgets.filter(b=>b.category!=='__GLOBAL__'&&num(b.budget)>0);
 const budgetTotal=globalBudget>0?globalBudget:budgetCats.reduce((sum,b)=>sum+num(b.budget),0);
 const transportInBudget=globalBudget>0||!budgetCats.length||budgetCats.some(b=>b.category==='Транспорт');
 const actualScope=(detail?.expenses||[]).filter(r=>['expense','deposit'].includes(String(r.type))&&(globalBudget>0||!budgetCats.length||budgetCats.some(b=>b.category===(r.type==='deposit'?'Нощувки/Хотел':r.category)))).reduce((sum,r)=>sum+num(r.amount),0);
 const mockTotal=mock.reduce((sum,r)=>sum+num(r.amount),0);
 const recordedEnd=num(settings.end_km);
 const trialEndKm=endKmTest.trim()?num(endKmTest):null;
 const trialEndValid=trialEndKm!==null&&Number.isInteger(trialEndKm)&&trialEndKm>=lastKm&&trialEndKm>=start;
 const trialDistance=trialEndValid?trialEndKm-start:null;
 const currentDistance=Math.max(0,lastKm-start);
 // Същият ориентировъчен показател като в Streamlit: всички записани литри / текущ пробег.
 // За пробно приключване пробегът стига до въведения краен километраж.
 const totalFuelLiters=(detail?.expenses||[]).reduce((sum,r)=>sum+num(r.liters),0)+manual+mock.reduce((sum,r)=>sum+num(r.liters),0);
 const previewDistance=trialEndValid?trialDistance:(recordedEnd>start?recordedEnd-start:currentDistance);
 const averagePreview=previewDistance>0&&totalFuelLiters>0?totalFuelLiters/previewDistance*100:null;
 // Етапният разход е отделен — използва се записаният резултат от последното пълно зареждане.
 const lastConfirmed=[...valid].reverse().find(r=>/\[ПЪЛНО\s+ЗАРЕЖДАНЕ\]/i.test(String(r.description||''))&&/(?:Реален разход:|Разход:)\s*([0-9]+(?:[.,][0-9]+)?)/i.test(String(r.description||'')));
 const confirmedMatch=lastConfirmed&&String(lastConfirmed.description||'').match(/(?:Реален разход:|Разход:)\s*([0-9]+(?:[.,][0-9]+)?)/i);
 const confirmedReal=confirmedMatch?num(confirmedMatch[1]):null;
 function addMock(e){e.preventDefault();
  if(!Number.isFinite(valMoney)||valMoney<=0||!Number.isFinite(valLiters)||valLiters<=0){setError('Въведи положителна сума и литри.');return;}
  if(!Number.isInteger(valKm)||valKm<=lastKm){setError(`Километражът трябва да е цяло число, по-голямо от ${lastKm.toLocaleString('bg-BG')} км.`);return;}
  const full=fuelType==='full';
  let desc=`[${full?'ПЪЛНО':'ЧАСТИЧНО'} ЗАРЕЖДАНЕ] ${description.trim()||'Гориво'}`;
  if(full&&consumption!==null)desc+=` (Етап: ${segmentKm.toFixed(0)}км, Реален разход: ${consumption.toFixed(1)}л/100км)`;
  setMock(current=>[...current,{type:'expense',category:'Транспорт',amount:Math.round(valMoney*100)/100,liters:valLiters,current_km:valKm,description:desc,date:'ТЕСТ'}]);
  setError('');setAmount('');setLiters('');setKmInput('');setDescription('Гориво');
 }
 return <div className="overlay quick-demo-overlay" onClick={onClose}><div className="dialog quick-demo-dialog fuel-test-dialog" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>⛽ Зареждане на гориво</h3><button className="ghost" type="button" onClick={onClose} aria-label="Затвори">✕</button></div><button className="p26-return" type="button" onClick={onClose}>← Назад към пътуването</button>
  <div className="p26-modal-safe">🧪 Режим за проби: обикновените бутони променят само екрана. Истинските действия са означени с „в Google Drive“, позволени са само за „ТЕСТ – PixelApp“ и изискват отделно разрешение от Render.</div>
  <label>Пътуване<select value={tripId} onChange={e=>setTripId(e.target.value)}>{trips.map(t=><option value={t.id} key={t.id}>{t.name}{tripState(t)==='finished'?' · приключено (само тест)':''}</option>)}</select></label>
  {busy&&<p className="muted">Зареждане…</p>}{error&&<p className="error">{error}</p>}
  {detail&&<>
    <div className="p18-odometer"><span>Начални км <b>{start.toLocaleString('bg-BG')}</b></span><span>Последни км <b>{lastKm.toLocaleString('bg-BG')}</b></span></div>
    <form className="quick-demo-form" onSubmit={addMock}>
     <label>Сума (€)<input type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} required/></label>
     <label>Описание<input value={description} onChange={e=>setDescription(e.target.value)}/></label>
     <label>Литри<input type="number" min="0.01" step="any" inputMode="decimal" value={liters} onChange={e=>setLiters(e.target.value)} required/></label>
     <label>Тип зареждане<select value={fuelType} onChange={e=>setFuelType(e.target.value)}><option value="full">Да, до горе — пълен резервоар</option><option value="partial">Не — частично зареждане</option></select></label>
     <label>Текущ километраж<input type="number" min={Math.floor(lastKm)+1} step="1" inputMode="numeric" placeholder={`Над ${lastKm.toLocaleString('bg-BG')} км`} value={kmInput} onChange={e=>setKmInput(e.target.value)} required/></label>
     <div className="p18-preview-grid"><div><small>Цена на литър</small><strong>{pricePerLiter!==null?`${pricePerLiter.toLocaleString('bg-BG',{minimumFractionDigits:2,maximumFractionDigits:2})} €/л`:'—'}</strong></div><div><small>Разлика спрямо предишното</small><strong>{pricePerLiter!==null&&oldPrice!==null?`${(pricePerLiter-oldPrice).toLocaleString('bg-BG',{minimumFractionDigits:2,maximumFractionDigits:2,signDisplay:'always'})} €/л`:'—'}</strong></div></div>
     {fuelType==='full'?<section className="p18-calc"><strong>🚗 Реален разход за етапа</strong><b>{firstFullUnverified?'Недостатъчно данни за реален разход':consumption!==null?`${consumption.toFixed(1)} л/100 км`:'Въведи литри и нов километраж'}</b><small>{lastFull?`От предишното пълно зареждане на ${lastFullKm.toLocaleString('bg-BG')} км`:'Първо пълно зареждане: не знаем надеждно колко гориво е имало в началото.'}</small>{consumption!==null&&<small>{segmentLiters.toLocaleString('bg-BG',{maximumFractionDigits:2})} л за {segmentKm.toLocaleString('bg-BG')} км</small>}</section>:<p className="muted">Частично зареждане: литрите участват в изчислението при следващото пълно зареждане.</p>}
     <button type="submit">➕ Добави пробно зареждане</button>
    </form>
    <section className="p19-trip-end"><h4>🏁 Проверка при приключване</h4>
      <p className="muted">Пробен краен километраж, без реално приключване и без запис в Google Drive. Не променя разхода за завършените горивни етапи.</p>
      <div className="p19-end-grid"><div><small>Начални километри</small><strong>{start.toLocaleString('bg-BG')} км</strong></div><div><small>Последни заредени километри</small><strong>{lastKm.toLocaleString('bg-BG')} км</strong></div><div><small>Пробег до последното зареждане</small><strong>{currentDistance.toLocaleString('bg-BG')} км</strong></div><div><small>Крайни км в Streamlit</small><strong>{recordedEnd>0?recordedEnd.toLocaleString('bg-BG')+' км':'Няма записани'}</strong></div></div>
      <label>Пробен краен километраж<input type="number" inputMode="numeric" step="1" min={Math.ceil(lastKm)} placeholder={`Не по-малко от ${lastKm.toLocaleString('bg-BG')} км`} value={endKmTest} onChange={e=>setEndKmTest(e.target.value)}/></label>
      {endKmTest.trim()&&(trialEndValid?<div className="p19-end-result"><small>Общ пробег при приключване</small><strong>{trialDistance.toLocaleString('bg-BG')} км</strong><span>Допълнително след последното зареждане: {(trialEndKm-lastKm).toLocaleString('bg-BG')} км</span></div>:<p className="error">Крайният километраж трябва да е цяло число и не може да е под последния километраж ({lastKm.toLocaleString('bg-BG')} км).</p>)}
      <button className="ghost" type="button" onClick={()=>setEndKmTest('')}>↶ Изчисти пробния краен километраж</button>
    </section>
    <section className="p20-fuel-comparison"><h4>📈 Разход на гориво · проверка като в Streamlit</h4>
      <p className="muted">Двата показателя имат различна цел. Ориентировъчният използва общия пробег, а реалният — последния завършен етап между пълни зареждания.</p>
      <div className="p20-fuel-summary-grid">
        <div><small>Реален разход · последен етап</small><strong>{confirmedReal!==null?confirmedReal.toFixed(1)+' л/100 км':'Недостатъчно данни'}</strong><span>Не се изменя от километри след последното пълно зареждане.</span></div>
        <div><small>Среден разход · ориентир</small><strong>{averagePreview!==null?averagePreview.toFixed(1)+' л/100 км':'Недостатъчно данни'}</strong><span>{totalFuelLiters.toLocaleString('bg-BG',{maximumFractionDigits:2})} л / {previewDistance.toLocaleString('bg-BG')} км общ пробег</span></div>
      </div>
      <p className="muted">{trialEndValid?'Пробният краен километраж участва само в ориентировъчния среден разход.':'За тест на приключено пътуване въведи пробен краен километраж по-горе.'} Всичко е локална симулация.</p>
    </section>
    <section className="quick-demo-summary"><h4>📊 Влияние върху разходите</h4><div className="quick-demo-grid"><div><small>Разходи преди</small><strong>{money(spentBefore)}</strong></div><div><small>След пробните зареждания</small><strong>{money(spentBefore+mockTotal)}</strong></div><div><small>Бюджет</small><strong>{budgetTotal?money(budgetTotal):'Няма зададен'}</strong></div><div><small>Остатък по бюджетния обхват</small><strong>{budgetTotal?money(budgetTotal-actualScope-(transportInBudget?mockTotal:0)):'—'}</strong></div></div><small className="muted">Проверка по същия принцип като Пач 17; бюджетните правила предстои да се сравнят изцяло със Streamlit.</small></section>
    <section className="quick-demo-list"><h4>⛽ Нови зареждания · {mock.length}</h4>{mock.length>0&&<button className="ghost" type="button" onClick={()=>{setMock([]);setError('');}}>↶ Изчисти пробните зареждания</button>}{[...mock].reverse().map((r,i)=><div className="p17-row" key={`${r.current_km}-${i}`}><span><b>{r.description}</b><small>{num(r.liters).toLocaleString('bg-BG')} л · {num(r.current_km).toLocaleString('bg-BG')} км · ТЕСТ</small></span><strong>{money(r.amount)}</strong></div>)}</section>
   </>}
  </div></div>;
}

function QuickExpensePreview({trips,loadTrip,onClose,initialTripId,expenseDrafts,onUpdateDraft,onSafetyPreflight,onTestWrite,onTestChange,onSaved}){
 const [tripId,setTripId]=useState(initialTripId||trips[0]?.id||'');
 const [details,setDetails]=useState(null);
 const [fetchError,setFetchError]=useState('');
 const [busy,setBusy]=useState(false);
 const [amount,setAmount]=useState('');
 const [category,setCategory]=useState('Храна и напитки');
 const [description,setDescription]=useState('');
 const [fuelLiters,setFuelLiters]=useState('');
 const [fuelKm,setFuelKm]=useState('');
 const [fuelKind,setFuelKind]=useState('full');
 const [realConfirmed,setRealConfirmed]=useState(false);
 const [realBusy,setRealBusy]=useState(false);
 const [realResult,setRealResult]=useState('');
 const [realChangeConfirmed,setRealChangeConfirmed]=useState(false);
 const [realChangeResult,setRealChangeResult]=useState('');
 const [lastRealChange,setLastRealChange]=useState(null);
 const draft=expenseDrafts[tripId]||blankExpenseDraft();
 const {newRows,edits,deleted}=draft;
 const update=(field,value)=>onUpdateDraft(tripId,field,value);
 const setNewRows=v=>update('newRows',v);
 const setEdits=v=>update('edits',v);
 const setDeleted=v=>update('deleted',v);
 const [editing,setEditing]=useState(null);
 const [editAmount,setEditAmount]=useState('');
 const [editCategory,setEditCategory]=useState('');
 const [editDescription,setEditDescription]=useState('');
 const [editLiters,setEditLiters]=useState('');
 const [editKm,setEditKm]=useState('');
 const [editFuelKind,setEditFuelKind]=useState('full');
 useEffect(()=>{let active=true;setDetails(null);setEditing(null);setFetchError('');setRealResult('');setRealConfirmed(false);setRealChangeConfirmed(false);setRealChangeResult('');setLastRealChange(null);if(!tripId)return;
  setBusy(true);loadTrip(tripId).then(d=>{if(active){setDetails(d);onUpdateDraft(tripId,'baseRows',d?.expenses||[]);}}).catch(e=>{if(active)setFetchError(e.message||String(e))}).finally(()=>{if(active)setBusy(false)});
  return()=>{active=false};
 },[tripId]);
 const val=v=>{const n=Number(String(v??0).replace(',','.'));return Number.isFinite(n)?n:0};
 const isExpense=r=>['expense','deposit'].includes(String(r.type||'').toLowerCase());
 const expenseCategory=r=>r.type==='deposit'?'Нощувки/Хотел':(r.category||'Други');
 const isFuel=r=>r.type==='expense'&&r.category==='Транспорт'&&(val(r.liters)>0||/гориво|зареждане|бензин|дизел|газ/i.test(String(r.description||'')));
 const original=(details?.expenses||[]).filter(isExpense).map((r,i)=>({...r,_key:`old-${i}`,_original:true}));
 const effectiveOld=original.filter(r=>!deleted.includes(r._key)).map(r=>({...r,...(edits[r._key]||{})}));
 const allEffective=applyExpenseDraft(details?.expenses||[],draft).filter(isExpense).map((r,i)=>({...r,_key:r._key||`old-${i}`,_original:r._original!==false&&!r._temporary}));
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
 const fuelKeyword=category==='Транспорт'&&/газ|гориво|зареждане|бензин|дизел/i.test(description);
 const numeric=v=>{const n=Number(String(v??'').replace(',','.'));return Number.isFinite(n)?n:0};
 const pastFuelRows=allEffective.filter(r=>r.type==='expense'&&r.category==='Транспорт'&&numeric(r.liters)>0&&numeric(r.current_km)>0).sort((a,b)=>numeric(a.current_km)-numeric(b.current_km));
 const startKm=numeric(details?.settings?.start_km);
 const lastKm=pastFuelRows.length?Math.max(startKm,...pastFuelRows.map(r=>numeric(r.current_km))):startKm;
 const lastFull=[...pastFuelRows].reverse().find(r=>/ПЪЛЕН|ПЪЛНО/i.test(String(r.description||'')));
 const lastFullKm=lastFull?numeric(lastFull.current_km):startKm;
 const pendingKm=numeric(fuelKm),pendingLiters=numeric(fuelLiters);
 const segmentLiters=lastFull?pastFuelRows.filter(r=>numeric(r.current_km)>lastFullKm).reduce((sum,r)=>sum+numeric(r.liters),pendingLiters):0;
 const stageKm=pendingKm-lastFullKm;
 const measured=fuelKind==='full'&&lastFull&&stageKm>0&&segmentLiters>0&&pendingKm>lastKm?segmentLiters/stageKm*100:null;
 function addTest(e){e.preventDefault();const n=val(amount);if(!(n>0))return;
  if(fuelKeyword&&(pendingLiters<=0||!Number.isInteger(pendingKm)||pendingKm<=lastKm)){
   setFetchError(`За зареждане въведи положителни литри и километраж над ${lastKm.toLocaleString('bg-BG')} км.`);return;
  }
  const fuelDesc=fuelKeyword?`[${fuelKind==='full'?'ПЪЛНО':'ЧАСТИЧНО'} ЗАРЕЖДАНЕ] ${description.trim()}${measured!==null?` (Етап: ${stageKm.toFixed(0)}км, Реален разход: ${measured.toFixed(1)}л/100км)`:''}`:description.trim();
  setFetchError('');setNewRows(items=>items.concat([{_key:`new-${Date.now()}-${items.length}`,_original:false,type:'expense',amount:Math.round(n*100)/100,category,description:fuelDesc,date:'Временно',liters:fuelKeyword?pendingLiters:0,current_km:fuelKeyword?pendingKm:0}]));setAmount('');setDescription('');setFuelLiters('');setFuelKm('');
 }
 const selectedIsTest=String(tripId||'').replace(/[^\p{L}\p{N}]/gu,'').toLocaleLowerCase()===String('ТЕСТ PixelApp').replace(/[^\p{L}\p{N}]/gu,'').toLocaleLowerCase();
 const realCategories=['Храна и напитки','Транспорт','Други','Нощувки/Хотел'];
 const realEligible=selectedIsTest&&realCategories.includes(category)&&!fuelKeyword&&!/газ|гориво|зареждане|бензин|дизел/i.test(description);
 async function addRealTest(){
  if(realBusy||!realConfirmed||!realEligible)return;
  const n=Number(amount),desc=description.trim();
  if(!Number.isFinite(n)||n<=0||n>1000||Math.abs(Math.round(n*100)-n*100)>1e-7||!desc||desc.length>200){setRealResult('⚠️ Въведи описание и сума от 0,01 до 1000,00 € с два знака.');return;}
  setRealBusy(true);setRealResult('');
  try{
   // Fetch a fresh hash immediately before the write; server checks again before upload.
   const proof=await onSafetyPreflight();
   if(proof.test_write_armed!==true||!proof.test_trip_found||proof.test_trip_id!==tripId||!proof.drive_matches_local||!proof.expenses_sha256){
    throw Error('Тестовото записване не е разрешено или данните са различни от Drive. Не е записано нищо.');
   }
   const result=await onTestWrite({trip_id:tripId,amount:n,category,description:desc,expected_sha256:proof.expenses_sha256,confirmation:'ЗАПИШИ САМО В ТЕСТ P44'});
   setLastRealChange({before:totalBefore,after:totalBefore+n});
   setRealResult('✅ Записано и проверено в Google Drive. Архив: '+result.backup_id);
   setAmount('');setDescription('');setRealConfirmed(false);
   const fresh=await loadTrip(tripId);
   setDetails(fresh);onUpdateDraft(tripId,'baseRows',fresh?.expenses||[]);
   await onSaved(tripId);
  }catch(err){setRealResult('⚠️ '+String(err?.message||err)+' Не повтаряй записа, докато не провериш Drive.');}
  finally{setRealBusy(false)}
 }
 function beginEdit(r){
  setFetchError('');setRealChangeResult('');setRealChangeConfirmed(false);setEditing(r._key);setEditAmount(String(val(r.amount)));setEditCategory(expenseCategory(r));setEditDescription(String(r.description||'').replace(/^\[P44 TEST\]\s*/,'').replace(/\s*\(Етап:\s*[^)]*?Реален разход:\s*[^)]*\)/gi,'').replace(/\[(?:ПЪЛНО|ПЪЛЕН|ЧАСТИЧНО)\s+ЗАРЕЖДАНЕ\]\s*/gi,'').trim());
  setEditLiters(String(numeric(r.liters)||''));setEditKm(String(numeric(r.current_km)||''));setEditFuelKind(/ПЪЛНО|ПЪЛЕН/i.test(String(r.description||''))?'full':'partial');
 }
 const editingRow=allEffective.find(r=>r._key===editing);
 const editingFuel=!!editingRow&&isFuel(editingRow);
 const otherFuel=allEffective.filter(r=>r._key!==editing&&r.type==='expense'&&r.category==='Транспорт'&&numeric(r.liters)>0&&numeric(r.current_km)>0);
 function saveEdit(e){e.preventDefault();const n=val(editAmount);if(!(n>0))return;
  const row=allEffective.find(r=>r._key===editing);if(!row)return;
  let update={amount:Math.round(n*100)/100,category:editCategory,description:editDescription.trim()};
  if(editingFuel){
   const liters=numeric(editLiters),km=numeric(editKm),occupied=otherFuel.some(r=>numeric(r.current_km)===km);
   if(editCategory!=='Транспорт'||!liters||!Number.isInteger(km)||km<=numeric(details?.settings?.start_km)||occupied){
    setFetchError('Зареждането трябва да остане в „Транспорт“, с положителни литри и уникален цял километраж над началния.');return;
   }
   update={...update,liters,current_km:km,description:`[${editFuelKind==='full'?'ПЪЛНО':'ЧАСТИЧНО'} ЗАРЕЖДАНЕ] ${editDescription.trim()}`};
  }else if(editCategory==='Транспорт'&&/гориво|зареждане|бензин|дизел|газ/i.test(update.description)){
   setFetchError('За ново зареждане използвай „Добави разход“, за да въведеш и литрите и километража.');return;
  }
  setFetchError('');if(row._original)setEdits(prev=>({...prev,[editing]:update}));else setNewRows(prev=>prev.map(r=>r._key===editing?{...r,...update}:r));setEditing(null);
 }
 const editingOriginal=original.find(r=>r._key===editing);
 const realChangeEligible=selectedIsTest&&!!editingOriginal&&/^\[P44 TEST\] /.test(String(editingOriginal.description||''))&&!isFuel(editingOriginal)&&editingOriginal.type==='expense'&&['0','0.0',''].includes(String(editingOriginal.liters??''))&&['0','0.0',''].includes(String(editingOriginal.current_km??''));
 async function doRealChange(operation){
  if(realBusy||!realChangeConfirmed||!realChangeEligible)return;
  const amountNum=Number(editAmount), desc=editDescription.trim();
  if(operation==='edit'&&(!Number.isFinite(amountNum)||amountNum<=0||amountNum>1000||Math.abs(Math.round(amountNum*100)-amountNum*100)>1e-7||!desc||desc.length>200||!realCategories.includes(editCategory)||/газ|гориво|зареждане|бензин|дизел/i.test(desc))){
   setRealChangeResult('⚠️ Разрешени са само обикновени разходи до 1000 € с валидно описание.');return;
  }
  setRealBusy(true);setRealChangeResult('');
  try{
   const proof=await onSafetyPreflight();
   if(proof.test_write_armed!==true||!proof.test_trip_found||proof.test_trip_id!==tripId||!proof.drive_matches_local||!proof.expenses_sha256)throw Error('Разрешението или сверяването с Drive липсва.');
   const originalData=Object.fromEntries(['date','amount','category','description','type','liters','current_km'].map(k=>[k,String(editingOriginal[k]??'')]));
   const payload={trip_id:tripId,operation,original:originalData,expected_sha256:proof.expenses_sha256,confirmation:'ПРОМЕНИ САМО P44 ТЕСТ'};
   if(operation==='edit')Object.assign(payload,{amount:amountNum,category:editCategory,description:desc});
   const result=await onTestChange(payload);
   setLastRealChange({before:totalBefore,after:totalBefore+(operation==='edit'?amountNum-val(editingOriginal.amount):-val(editingOriginal.amount))});
   setRealChangeResult('✅ '+(operation==='edit'?'Редактирано':'Изтрито')+' и проверено в Google Drive. Архив: '+result.backup_id);
   setEditing(null);setRealChangeConfirmed(false);
   // Discard local draft changes for this trip, so they cannot hide the saved result.
   onUpdateDraft(tripId,'newRows',[]);onUpdateDraft(tripId,'edits',{});onUpdateDraft(tripId,'deleted',[]);
   const fresh=await loadTrip(tripId);
   setDetails(fresh);onUpdateDraft(tripId,'baseRows',fresh?.expenses||[]);
   await onSaved(tripId);
  }catch(err){setRealChangeResult('⚠️ '+String(err?.message||err)+' Не повтаряй, преди да свериш Drive.');}
  finally{setRealBusy(false)}
 }
 function removeTest(r){
  setFetchError('');if(r._original)setDeleted(prev=>prev.includes(r._key)?prev:prev.concat(r._key));else setNewRows(prev=>prev.filter(x=>x._key!==r._key));if(editing===r._key)setEditing(null);
 }
 function restore(){setNewRows([]);setEdits({});setDeleted([]);setEditing(null);setFetchError('');}
 return <div className="overlay quick-demo-overlay" onClick={onClose}><div className="dialog quick-demo-dialog" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>💳 Управление на разходи</h3><button className="ghost" type="button" onClick={onClose} aria-label="Затвори">✕</button></div><button className="p26-return" type="button" onClick={onClose}>← Затвори разходите</button>
  <div className="p26-modal-safe">🧪 Режим за проби: обикновените бутони променят само екрана. Истинските действия са означени с „в Google Drive“, позволени са само за „ТЕСТ – PixelApp“ и изискват отделно разрешение от Render.</div>
  {!trips.length?<p>Няма заредени пътувания. Прочети данните от Google Drive и опитай отново.</p>:<>
   <label>Пътуване<select value={tripId} onChange={e=>setTripId(e.target.value)}>{trips.map(t=><option key={t.id} value={t.id}>{t.name}{tripState(t)!=='active'?' · само тест':''}</option>)}</select></label>
   {busy&&<p className="muted">Зареждане…</p>}{fetchError&&<p className="error">{fetchError}</p>}
   {details&&<>
    <form className="quick-demo-form" onSubmit={addTest}>
     <h4>➕ Добави разход</h4>
     <label>Сума (€)<input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required/></label>
     <label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}>{options.map(c=><option key={c} value={c}>{c}</option>)}</select></label>
     <label>Описание<input value={description} onChange={e=>setDescription(e.target.value)} placeholder="Гориво, паркинг, обяд…"/></label>
     {fuelKeyword&&<section className="p29-auto-fuel"><strong>⛽ Разпознато зареждане</strong><small>Автоматично по описание + категория „Транспорт“</small>
      <label>Литри<input type="number" inputMode="decimal" min="0.01" step="any" value={fuelLiters} onChange={e=>setFuelLiters(e.target.value)} required/></label>
      <label>Тип зареждане<select value={fuelKind} onChange={e=>setFuelKind(e.target.value)}><option value="full">Пълен резервоар · до горе</option><option value="partial">Частично зареждане</option></select></label>
      <label>Километраж<input type="number" inputMode="numeric" step="1" min={Math.floor(lastKm)+1} value={fuelKm} onChange={e=>setFuelKm(e.target.value)} placeholder={`Над ${lastKm.toLocaleString('bg-BG')} км`} required/></label>
      {fuelKind==='full'&&<div className="p29-stage">Реален разход: <b>{measured!==null?`${measured.toFixed(1)} л/100 км`:'—'}</b><small>{!lastFull?'Първо пълно зареждане — няма надежден предишен етап.':'Показва се след валидни литри и километраж.'}</small></div>}
     </section>}
     {selectedIsTest&&<div className="p44-real-write"><strong>🛡️ Реален запис · само „ТЕСТ – PixelApp“</strong><small>Разрешен само при включен тестов режим в Render. Проверява CSV файловете и архивира преди запис. Засега само обикновени разходи; без гориво и депозити.</small><label className="p42-confirm"><input type="checkbox" checked={realConfirmed} onChange={e=>setRealConfirmed(e.target.checked)} disabled={realBusy}/> Streamlit е затворен и имам резервно копие</label><button type="button" disabled={!realConfirmed||!realEligible||realBusy||!description.trim()||!amount} onClick={addRealTest}>{realBusy?'⏳ Проверявам и записвам…':'💾 Запиши в Drive · само ТЕСТ'}</button>{!realEligible&&<small>Този вид разход още не е разрешен за реален запис. Можеш да го тестваш временно.</small>}{realResult&&<p role="status">{realResult}</p>}</div>}
     <button type="submit">{fuelKeyword?'Добави зареждане и разход · временно':'Добави разход · временно'}</button>
    </form>
    <section className="quick-demo-summary"><h4>📊 Контрол на бюджета</h4>
     <div className="quick-demo-grid"><div><small>Разходи преди</small><strong>{money(lastRealChange?.before??totalBefore)}</strong></div><div><small>Разходи след</small><strong>{money(lastRealChange?.after??totalAfter)}</strong></div><div><small>Бюджет</small><strong>{budgetTotal?money(budgetTotal):'Не е зададен'}</strong></div><div><small>Остава по бюджетен обхват</small><strong>{budgetTotal?money(budgetTotal-scopeAfter):'—'}</strong></div></div>
     {budgetTotal>0&&<div className="quick-demo-meter"><span style={{width:Math.min(100,Math.max(0,scopeAfter/budgetTotal*100))+'%'}}/></div>}
     <p className="quick-demo-note">Разлика на разходите: <b>{money(lastRealChange?lastRealChange.after-lastRealChange.before:totalAfter-totalBefore)}</b> · Разлика по бюджетния обхват: <b>{money(lastRealChange&&globalBudget>0?lastRealChange.after-lastRealChange.before:scopeAfter-scopeBefore)}</b></p>
     {lastRealChange&&<small className="p45-persisted-label">✅ Последна записана промяна в Drive; не е временна симулация.</small>}<small className="muted">При бюджет по категории участват само съответните категории. Това е локална проверка, не окончателно сравнение с оригиналните формули.</small>
    </section>
    <section className="quick-demo-list"><h4>📋 История на разходите · {allEffective.length}</h4><p className="p46-actions-note">✏️ Отвори разхода за редакция. При тестовите записи от Пач 44 там са действията „в Google Drive“. Бутонът „✕“ е <b>само временен</b> и не изтрива от Drive.</p>
     {changes>0&&<button type="button" className="ghost" onClick={restore}>↶ Отмени временните промени ({changes})</button>}
     {[...allEffective].reverse().map(r=><div className="p17-row" key={r._key}><span><b>{expenseCategory(r)}</b><small>{r.description||'Без описание'} · {r.date||'Без дата'}{r._original?'':' · ТЕСТ'}</small></span><strong>{money(r.amount)}</strong><span className="p17-actions"><button className="ghost p46-edit-action" type="button" onClick={()=>beginEdit(r)} title="Отвори редакцията (ако е тестов запис от Пач 44: и действията в Google Drive)" aria-label={`Отвори редакция: ${r.description||expenseCategory(r)}`}>✏️</button>{selectedIsTest&&r._original&&String(r.description||'').startsWith('[P44 TEST] ')?<span className="p46-saved-tag" title="За истинско изтриване отвори редакцията с моливчето">Drive</span>:<button className="ghost p46-local-remove" type="button" onClick={()=>removeTest(r)} title="Премахни само временно · без Google Drive" aria-label="Премахни само временно">✕ <span>временно</span></button>}</span></div>)}
     <small className="muted">⛽ Временните промени на гориво не се записват в Drive. За реална промяна на обикновен разход от Пач 44 отвори ✏️ и използвай изрично означения бутон „в Drive“.</small>
    </section>
    {realChangeResult&&<p className="p45-change-result" role="status">{realChangeResult}</p>}
    {editing&&<form className="quick-demo-form p17-edit" onSubmit={saveEdit}><h4>✏️ Редакция на разход</h4><label>Сума (€)<input type="number" step="0.01" min="0.01" value={editAmount} onChange={e=>setEditAmount(e.target.value)} required/></label><label>Категория<select value={editCategory} onChange={e=>setEditCategory(e.target.value)}>{options.map(c=><option key={c} value={c}>{c}</option>)}</select></label><label>Описание<input value={editDescription} onChange={e=>setEditDescription(e.target.value)}/></label>
     {editingFuel&&<section className="p30-fuel-edit"><strong>⛽ Редакция на зареждане</strong><label>Литри<input type="number" min="0.01" step="any" inputMode="decimal" value={editLiters} onChange={e=>setEditLiters(e.target.value)} required/></label><label>Километраж<input type="number" min={Math.floor(numeric(details?.settings?.start_km))+1} step="1" inputMode="numeric" value={editKm} onChange={e=>setEditKm(e.target.value)} required/></label><label>Вид зареждане<select value={editFuelKind} onChange={e=>setEditFuelKind(e.target.value)}><option value="full">Пълно · до горе</option><option value="partial">Частично</option></select></label><small>Реалният разход между две пълни зареждания се обновява автоматично.</small></section>}
     {realChangeEligible&&<div className="p44-real-write p45-real-change"><strong>☁️ ИСТИНСКА промяна в Google Drive · само Пач 44</strong><small>Работи само при разрешен тестов режим в Render, затворен Streamlit и резервен архив. Следва проверка на CSV и нов архив в Drive. Няма поддръжка за гориво и депозити.</small><label className="p42-confirm"><input type="checkbox" checked={realChangeConfirmed} onChange={e=>setRealChangeConfirmed(e.target.checked)} disabled={realBusy}/> Streamlit е затворен и имам резервно копие</label><div className="p45-action-row"><button type="button" disabled={!realChangeConfirmed||realBusy} onClick={()=>doRealChange('edit')}>💾 Редактирай в Drive</button><button type="button" className="p45-delete-btn" disabled={!realChangeConfirmed||realBusy} onClick={()=>doRealChange('delete')}>🗑️ Изтрий истински от Drive</button></div><small>Изтриването е необратимо от този екран, но създаваме архив преди него. Натискай само веднъж.</small></div>}
     <div className="p17-actions"><button type="submit" className="p46-temporary-save">🧪 Запази само временно · без Drive</button><button type="button" className="ghost" onClick={()=>setEditing(null)}>Отказ</button></div></form>}
   </>}
  </>}
 </div></div>;
}


// Пач 21: изцяло локален тест на настройките и приключването; без API записи.
// Safe missed fuel entry belongs to the car settings, not ordinary expenses.
function SettingsMissedFuelSave({onPreflight,onSave,onSaved,disabled=false}){
 const [liters,setLiters]=useState('');
 const [hasPrice,setHasPrice]=useState(false);
 const [amount,setAmount]=useState('');
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const parse=v=>Number(String(v).trim().replace(',','.'));
 const valid=v=>/^\d+(?:[.,]\d{1,2})?$/.test(String(v).trim());
 const ok=valid(liters)&&parse(liters)>0&&parse(liters)<=500&&(!hasPrice||(valid(amount)&&parse(amount)>0&&parse(amount)<=10000));
 async function save(e){
  e.preventDefault();if(!ok||busy||disabled)return;
  setBusy(true);setMessage('');
  try{
   const check=await onPreflight();
   if(!check?.can_write||!check?.drive_matches_local||!check?.sha256)throw Error('Данните в Google Drive не са потвърдени или записът е заключен.');
   const request_id=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
   const response=await onSave({liters:parse(liters),amount:hasPrice?parse(amount):0,expected_sha256:check.sha256,request_id});
   if(!response?.ok)throw Error('Сървърът не потвърди записа.');
   setLiters('');setHasPrice(false);setAmount('');
   setMessage('✅ Записано и проверено в Google Drive. '+(response.already_saved?'Без дублиране.':''));
   await onSaved?.();
  }catch(err){setMessage('⚠️ '+String(err.message||err)+' Провери данните, преди да повтаряш.');}
  finally{setBusy(false)}
 }
 return <form onSubmit={save} className="p22-form">
  <p className="muted">Реален запис за това пътуване. Забравените литри се добавят само веднъж, без километраж.</p>
  <label>Пропуснато гориво (литри)<input type="text" inputMode="decimal" placeholder="Напр. 15,5" value={liters} onChange={e=>setLiters(e.target.value)} disabled={disabled||busy}/></label>
  <label className="p22-check"><input type="checkbox" checked={hasPrice} onChange={e=>setHasPrice(e.target.checked)} disabled={disabled||busy}/> 💵 Помня и платената сума?</label>
  {hasPrice&&<label>Платена сума (€)<input type="text" inputMode="decimal" placeholder="Напр. 20,00" value={amount} onChange={e=>setAmount(e.target.value)} disabled={disabled||busy}/></label>}
  <button type="submit" disabled={!ok||busy||disabled}>{busy?'⏳ Записвам…':'💾 Запиши пропуснатото гориво'}</button>
  {message&&<p role="status" className={message.startsWith('⚠️')?'error':'muted'}>{message}</p>}
 </form>;
}

function TripManagementPreview({trips,onClose,loadTrip,initialTripId,defaultPanel='basic',expenseDrafts={},onUpdateDraft,onFuelPreflight,onMissedFuelSave,onSaved,onFinishPreflight,onFinishSave,onBasicPreflight,onBasicSave,reactOwned=false}){
 const blank=()=>({name:'',startDate:'',endDate:'',car:true,trackFuel:'Да',startKm:'',endKm:'',manualFuel:'',finished:false});
 const [source,setSource]=useState(initialTripId||'__new');
 const [panel,setPanel]=useState(defaultPanel);
 const [form,setForm]=useState(blank);
 const [initial,setInitial]=useState(blank);
 const [confirmed,setConfirmed]=useState(false);
 const [notice,setNotice]=useState('');
 const [finishBusy,setFinishBusy]=useState(false);
 const [basicBusy,setBasicBusy]=useState(false);
 // Локален тест: [ПРОПУСНАТО ГОРИВО] с цена се отчита чрез manual_fuel;
 // [ГОРИВО БЕЗ СТОЙНОСТ] се отчита чрез реда liters — никога и по двата начина.
 const [newTripManualEntries,setNewTripManualEntries]=useState([]);
 // Same draft as quick expenses. Shared across closing/reopening settings for existing trips.
 const isManualRow=r=>r._manualFromSettings===true;
 const manualEntries=source==='__new'?newTripManualEntries:(expenseDrafts[source]?.newRows||[]).filter(isManualRow).map(r=>({id:r._key,liters:r._manualLiters,amount:r.amount,hasPrice:r._manualFuelDelta>0,description:r.description,storedLiters:r.liters,manualFuelDelta:r._manualFuelDelta}));
 const setManualEntries=updater=>{
  if(source==='__new'){setNewTripManualEntries(updater);return}
  if(!onUpdateDraft)return;
  onUpdateDraft(source,'newRows',previous=>{
   const prev=previous||[];
   const current=prev.filter(isManualRow).map(r=>({id:r._key,liters:r._manualLiters,amount:r.amount,hasPrice:r._manualFuelDelta>0,description:r.description,storedLiters:r.liters,manualFuelDelta:r._manualFuelDelta}));
   const next=typeof updater==='function'?updater(current):updater;
   return prev.filter(r=>!isManualRow(r)).concat(next.map(e=>({
    _key:e.id,_manualFromSettings:true,_manualLiters:e.liters,_manualFuelDelta:e.manualFuelDelta,
    type:'expense',category:'Транспорт',description:e.description,amount:e.amount,liters:e.storedLiters,current_km:0,date:new Date().toLocaleDateString('bg-BG'),_original:false
   })));
  });
 };
 const [manualLiters,setManualLiters]=useState('');
 const [manualHasPrice,setManualHasPrice]=useState(false);
 const [manualAmount,setManualAmount]=useState('');
 const [sourceDetail,setSourceDetail]=useState(null);
 const [detailBusy,setDetailBusy]=useState(false);
 const [detailError,setDetailError]=useState('');
 useEffect(()=>{
  let alive=true;
  setSourceDetail(null);setDetailError('');
  if(source==='__new')return ()=>{alive=false};
  setDetailBusy(true);
  loadTrip(source).then(data=>{if(alive)setSourceDetail(data)}).catch(e=>{if(alive)setDetailError(String(e.message||e))}).finally(()=>{if(alive)setDetailBusy(false)});
  return ()=>{alive=false};
 },[source]);

 const resetManual=()=>{if(source==='__new')setNewTripManualEntries([]);setManualLiters('');setManualHasPrice(false);setManualAmount('')};
 const patch=(key,value)=>{setForm(f=>({...f,[key]:value}));setConfirmed(false);setNotice('')};
 const toISO=value=>{const m=String(value||'').match(/^(\d\d)\.(\d\d)\.(\d{4})$/);return m?`${m[3]}-${m[2]}-${m[1]}`:''};
 const dateBG=value=>value?value.split('-').reverse().join('.'):'';
 const load=(id)=>{setSource(id);let next;if(id==='__new'){next=blank()}else{const tr=trips.find(t=>t.id===id)||{};const s=tr.settings||{};next={name:tr.name||tr.id||'',startDate:toISO(s.start_date),endDate:toISO(s.end_date),car:String(s.car_trip||'').toLowerCase()==='да',trackFuel:String(s.track_fuel||'Добави впоследствие'),startKm:String(Number(s.start_km||0)||''),endKm:String(Number(s.end_km||0)||''),manualFuel:String(Number(s.manual_fuel||0)||''),finished:String(s.trip_finished||'').toLowerCase()==='да'||Number(s.end_km||0)>0}}setForm(next);setInitial({...next});setConfirmed(false);setNotice('');resetManual()};
 useEffect(()=>{if(initialTripId)load(initialTripId)},[initialTripId]);
 const startKm=Number(form.startKm),endKm=Number(form.endKm),kmValid=Number.isFinite(startKm)&&Number.isFinite(endKm)&&endKm>=startKm&&String(form.endKm).trim()!=='';
 const dateValid=!(form.startDate&&form.endDate&&form.endDate<form.startDate);
 const carReady=!form.car||String(form.startKm).trim()!==''&&startKm>=0;
 const finishReady=form.name.trim()&&dateValid&&carReady&&(!form.car||(kmValid&&endKm>startKm));
 const totalKm=kmValid?endKm-startKm:null;
 const manualValid=manualLiters.trim()!==''&&Number.isFinite(Number(manualLiters))&&Number(manualLiters)>0&&(!manualHasPrice||(manualAmount.trim()!==''&&Number.isFinite(Number(manualAmount))&&Number(manualAmount)>0));
 const manualAddedLiters=manualEntries.reduce((v,e)=>v+e.liters,0);
 const manualAddedCost=manualEntries.reduce((v,e)=>v+e.amount,0);
 const manualBaseKnown=Number(form.manualFuel)||0;
 const manualPaidLiters=manualEntries.filter(e=>e.hasPrice).reduce((v,e)=>v+e.liters,0);
 const manualNoCostLiters=manualEntries.filter(e=>!e.hasPrice).reduce((v,e)=>v+e.liters,0);
 // Същата база като Streamlit: всички записани liters + manual_fuel.
 // Пропуснато гориво С цена се записва със storedLiters=0 и manualFuelDelta=литрите;
 // без цена — със storedLiters=литрите и manualFuelDelta=0. Всяко количество участва точно веднъж.
 const oldExpenses=source==='__new'?[]:applyExpenseDraft(sourceDetail?.expenses||[],{
  ...(expenseDrafts[source]||blankExpenseDraft()),
  newRows:(expenseDrafts[source]?.newRows||[]).filter(r=>!r._manualFromSettings)
 });
 const num=x=>{const n=Number(x);return Number.isFinite(n)?n:0};
 const oldStoredLiters=oldExpenses.reduce((sum,r)=>sum+num(r.liters),0);
 const oldManualLiters=num(sourceDetail?.settings?.manual_fuel??manualBaseKnown);
 const oldTotalLiters=oldStoredLiters+oldManualLiters;
 const extraStoredLiters=manualEntries.reduce((sum,r)=>sum+r.storedLiters,0);
 const extraManualLiters=manualEntries.reduce((sum,r)=>sum+r.manualFuelDelta,0);
 const previewLiters=oldTotalLiters+extraStoredLiters+extraManualLiters;
 const oldMaxKm=Math.max(0,...oldExpenses.map(r=>num(r.current_km)));
 const existingFinish=num(sourceDetail?.settings?.end_km);
 // Крайният километраж се използва само при пробно приключване; дотогава — последният реален запис.
 const canUseTrialEnd=form.finished&&kmValid;
 const previewKm=canUseTrialEnd?endKm:(existingFinish>startKm?existingFinish:oldMaxKm);
 const previewDistance=Math.max(0,previewKm-startKm);
 const meanBefore=previewDistance>0&&oldTotalLiters>0?oldTotalLiters/previewDistance*100:null;
 const meanAfter=previewDistance>0&&previewLiters>0?previewLiters/previewDistance*100:null;
 const fullRows=oldExpenses.filter(r=>r.category==='Транспорт'&&num(r.current_km)>startKm&&/ПЪЛЕН|ПЪЛНО/i.test(String(r.description||'')));
 const lastFullDesc=String(fullRows.at(-1)?.description||'');
 const stageMatch=lastFullDesc.match(/(?:Реален разход:|Разход:)\s*([0-9]+(?:[.,][0-9]+)?)/i);
 const realStage=stageMatch?Number(stageMatch[1].replace(',','.')):null;
 const fuelFmt=v=>v===null?'—':`${v.toLocaleString('bg-BG',{minimumFractionDigits:1,maximumFractionDigits:1})} л/100 км`;

 function addManual(e){e.preventDefault();if(!manualValid||form.finished)return;
  const liters=Number(manualLiters),amount=manualHasPrice?Number(manualAmount):0;
  setManualEntries(prev=>[...prev,{id:`m-${prev.length}-${Date.now()}`,liters,amount,hasPrice:manualHasPrice,
   description:manualHasPrice?`[ПРОПУСНАТО ГОРИВО] Добавени ${liters.toFixed(1)} литра`:`[ГОРИВО БЕЗ СТОЙНОСТ] Добавени ${liters.toFixed(1)} литра`,
   storedLiters:manualHasPrice?0:liters,manualFuelDelta:manualHasPrice?liters:0}]);
  setManualLiters('');setManualHasPrice(false);setManualAmount('');setNotice('Добавено само за проба. Google Drive не е променян.');
 }

 async function saveBasic(){
  if(!reactOwned||source!==initialTripId||form.finished||basicBusy||!dateValid||!form.startDate||!form.endDate)return;
  setBasicBusy(true);setNotice('');
  try{
   const check=await onBasicPreflight();
   if(!check?.can_write||!check?.sha256)throw Error('Настройките не са готови за запис. Обнови приложението.');
   // Prevent stale form from overwriting someone else's edits, even when preflight is fresh.
   if(check.start_date!==dateBG(initial.startDate)||check.end_date!==dateBG(initial.endDate)||check.track_fuel!==initial.trackFuel)
    throw Error('Настройките са променени на друго устройство. Обнови приложението.');
   const saved=await onBasicSave({start_date:dateBG(form.startDate),end_date:dateBG(form.endDate),track_fuel:form.trackFuel,expected_sha256:check.sha256});
   if(!saved?.ok)throw Error('Записът не е потвърден.');
   setInitial({...form});setNotice('✅ Основните настройки са записани и проверени в Google Drive.');
   await onSaved?.();
  }catch(error){setNotice('⚠️ '+String(error.message||error)+' Провери настройките преди повторен опит.');}
  finally{setBasicBusy(false)}
 }
 async function finish(){
  if(!finishReady||finishBusy)return;
  if(!reactOwned||source!==initialTripId){setForm(f=>({...f,finished:true}));setConfirmed(true);setNotice('Пробно приключване — НЕ е записано в Google Drive.');return;}
  if(!onFinishPreflight||!onFinishSave)return;
  setFinishBusy(true);setNotice('');
  try{
   const check=await onFinishPreflight();
   if(!check?.can_write||!check?.drive_matches_local||!check.sha256)throw Error('Пътуването е заключено или данните са променени.');
   if(check.car_trip!==form.car||Number(check.start_km)!==startKm)throw Error('Настройките в Drive се различават от показаните. Обнови екрана.');
   if(!window.confirm(`Окончателно приключване на ${form.name}\n${form.car?'Краен километраж: '+endKm+' км':'Без автомобил'}\nСлед това пътуването ще бъде заключено. Продължаваме?`))return;
   const result=await onFinishSave({end_km:form.car?endKm:0,expected_sha256:check.sha256});
   if(!result?.ok)throw Error('Сървърът не потвърди записа.');
   setForm(f=>({...f,finished:true}));setConfirmed(true);
   setNotice('✅ Записано и проверено в Google Drive. Пътуването е заключено.');
   await onSaved?.();
  }catch(error){setNotice('⚠️ '+String(error.message||error)+' Провери статуса преди повторен опит.');}
  finally{setFinishBusy(false)}
 }
 return <div className="overlay" onClick={onClose}><div className="dialog p21-dialog" role="dialog" aria-modal="true" aria-label="Управление на пътувания — тест" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>✈️ Управление на пътуването</h3><button type="button" className="ghost" onClick={onClose} aria-label="Затвори">✕</button></div><button className="p26-return" type="button" onClick={onClose}>{initialTripId?"← Назад към пътуването":"← Назад към началото"}</button>
  <p className="p26-modal-safe">Редакцията на дати и проследяване на горивото се записва за активни React пътувания. Името, типът и началният километраж остават защитени.</p>
  <div className="p25-tabs" role="tablist" aria-label="Управление на пътуване">
   {[['basic','⚙️ Основни'],['fuel','⛽ Пропуснато гориво'],['finish','🏁 Приключване']].map(([key,label])=><button type="button" key={key} role="tab" aria-selected={panel===key} className={panel===key?'p25-selected':''} onClick={()=>setPanel(key)}>{label}</button>)}
  </div>
  <label>Пътуване<select value={source} onChange={e=>load(e.target.value)}><option value="__new">➕ Ново пътуване</option>{trips.map(t=><option key={t.id} value={t.id}>{t.name||t.id}</option>)}</select></label>
  {panel==='basic'&&<><div className="p21-grid"><label>Дестинация<input value={form.name} readOnly title="Преименуването ще бъде отделна защитена операция"/></label><label>Тип пътуване<select value={form.car?'car':'other'} disabled><option value="car">🚗 С автомобил</option><option value="other">✈️ Без автомобил</option></select></label><label>От дата<input type="date" value={form.startDate} onChange={e=>patch('startDate',e.target.value)} disabled={!reactOwned||source!==initialTripId||form.finished}/></label><label>До дата<input type="date" value={form.endDate} onChange={e=>patch('endDate',e.target.value)} disabled={!reactOwned||source!==initialTripId||form.finished}/></label></div>
  {!dateValid&&<p className="p21-warning">Крайната дата трябва да е след началната.</p>}
  {form.car&&<section className="p21-section"><h4>🚗 Настройки на автомобила</h4><div className="p21-grid"><label>Начален километраж<input type="number" value={form.startKm} readOnly title="Началният километраж е защитен"/></label><label>Проследяване на горивото<select value={form.trackFuel} onChange={e=>patch('trackFuel',e.target.value)} disabled={!reactOwned||source!==initialTripId||form.finished}><option>Да</option><option>Не</option><option>Добави впоследствие</option></select></label></div></section>}
  {reactOwned&&source===initialTripId&&!form.finished&&<div className="p21-actions"><button type="button" disabled={basicBusy||!dateValid||!form.startDate||!form.endDate||(form.startDate===initial.startDate&&form.endDate===initial.endDate&&form.trackFuel===initial.trackFuel)} onClick={saveBasic}>{basicBusy?'Записвам…':'💾 Запази настройките в Google Drive'}</button></div>}
  {!reactOwned&&<p className="muted">Старите пътувания са само за преглед.</p>}
  {notice&&<p role="status" className="muted">{notice}</p>}
  </>}
  {panel==='fuel'&&form.car&&<section className="p21-section p22-manual"><div className="p31-manual-head"><span className="p31-manual-icon">⛽</span><div><h4>Пропуснато гориво</h4><small>Само забравени литри или зареждания</small></div></div>
   {reactOwned&&source===initialTripId?<SettingsMissedFuelSave key={source} onPreflight={onFuelPreflight} onSave={onMissedFuelSave} onSaved={onSaved} disabled={form.finished||detailBusy}/>:<form onSubmit={addManual} className="p22-form">
    <label>Пропуснато гориво (литри)<input type="number" step="0.01" min="0.01" placeholder="Напр. 25" value={manualLiters} onChange={e=>setManualLiters(e.target.value)} disabled={form.finished}/></label>
    {manualLiters!==''&&Number(manualLiters)>0&&<label className="p22-check"><input type="checkbox" checked={manualHasPrice} onChange={e=>setManualHasPrice(e.target.checked)} disabled={form.finished}/> 💵 Помня и платената сума?</label>}
    {manualHasPrice&&<label>Платена сума (€)<input type="number" step="0.01" min="0.01" placeholder="Напр. 42" value={manualAmount} onChange={e=>setManualAmount(e.target.value)} disabled={form.finished}/></label>}
    <p className="muted p31-compact-note">{manualHasPrice?'При добавяне: сумата ще участва в пробните транспортни разходи; литрите се броят само веднъж.':'При добавяне: ще се отчетат само литрите, без паричен разход.'}</p>
    <button type="submit" disabled={!manualValid||form.finished}>➕ Добави литрите</button>
   </form>}
   {!reactOwned&&<div className="p22-stats p31-manual-stats"><div><small>Добавени литри</small><strong>{manualAddedLiters.toLocaleString('bg-BG')} л</strong></div><div><small>Известни разходи</small><strong>{money(manualAddedCost)}</strong></div></div>}
   {!reactOwned&&<details className="p31-fuel-details"><summary>📊 Проверка на изчисленията</summary><section className="p23-consumption-preview" aria-label="Пробна проверка на средния разход">
    <h4>📈 Влияние върху средния разход</h4>
    <p className="muted">Използваме реално записаните литри от избраното пътуване плюс новите пробни количества. Няма двойно броене и няма запис в Drive.</p>
    {detailBusy?<p className="muted">Четем записаните зареждания…</p>:detailError?<p className="p21-warning">Не успях да прочета историята: {detailError}. Изчисление не се показва.</p>:<>
     <div className="p23-stats-grid">
      <div><small>Записани литри (преди)</small><strong>{oldTotalLiters.toLocaleString('bg-BG',{maximumFractionDigits:2})} л</strong></div>
      <div><small>Пробно добавени</small><strong>+{(extraStoredLiters+extraManualLiters).toLocaleString('bg-BG',{maximumFractionDigits:2})} л</strong></div>
      <div><small>Общо за ориентира</small><strong>{previewLiters.toLocaleString('bg-BG',{maximumFractionDigits:2})} л</strong></div>
      <div><small>Пробег</small><strong>{previewDistance>0?`${previewDistance.toLocaleString('bg-BG')} км`:'Неизвестен'}</strong></div>
     </div>
     <div className="p23-consumption-grid">
      <div><small>Среден · преди</small><strong>{fuelFmt(meanBefore)}</strong></div>
      <div><small>Среден · след пробата</small><strong>{fuelFmt(meanAfter)}</strong></div>
      <div><small>Реален · последен етап</small><strong>{fuelFmt(realStage)}</strong><em>Не се променя от ръчните литри</em></div>
     </div>
     {previewDistance<=0&&<p className="muted">За средния разход са нужни изминати километри. При ново пътуване те ще станат известни от зарежданията или при приключване.</p>}
     {source==='__new'&&<p className="muted">Ново пътуване: няма стари зареждания — виждаш само новите пробни количества.</p>}
    </>}
   </section>
   <p className="muted">Контрол срещу двойно броене: с известна сума — {manualPaidLiters.toLocaleString('bg-BG')} л към ръчното гориво; без сума — {manualNoCostLiters.toLocaleString('bg-BG')} л в отделни пробни записи. Вече съществуващи записи без цена не се включват в този тестов сбор, ако не са заредени тук.</p>
</details>}
   {!reactOwned&&manualEntries.length>0&&<><div className="p22-entry-list">{manualEntries.map(entry=><div key={entry.id} className="p22-entry"><span><strong>{entry.hasPrice?'💵 С известна сума':'📝 Само литри'}</strong><small>{entry.liters.toLocaleString('bg-BG')} л · {entry.description}</small></span><b>{entry.hasPrice?money(entry.amount):'Без цена'}</b><button type="button" className="ghost" title="Премахни пробния запис" onClick={()=>setManualEntries(rows=>rows.filter(r=>r.id!==entry.id))}>✕</button></div>)}</div><button type="button" className="ghost" onClick={resetManual}>🗑️ Изчисти само пробното ръчно гориво</button></>}
  </section>}
  {panel==='fuel'&&!form.car&&<p className="p21-warning">За ръчно гориво първо избери „С автомобил“ в „Основни“.</p>}
  {panel==='finish'&&<section className="p21-section"><h4>🏁 Приключване на пътуването</h4>{form.car&&<label>Краен километраж — въвежда се едва при приключване<input type="number" min="0" step="1" value={form.endKm} onChange={e=>patch('endKm',e.target.value)} placeholder="Напр. 100950"/></label>}<div className="p21-grid"><div className="p21-number"><small>Начален километраж</small><strong>{form.car&&form.startKm!==''?startKm.toLocaleString('bg-BG')+' км':'—'}</strong></div><div className="p21-number"><small>Краен километраж</small><strong>{form.car&&form.endKm!==''?endKm.toLocaleString('bg-BG')+' км':'—'}</strong></div><div className="p21-number p21-wide"><small>Общ пробег</small><strong>{form.car&&totalKm!==null?totalKm.toLocaleString('bg-BG')+' км':form.car?'Въведи валидни километри':'Без автомобил'}</strong></div></div>
   {form.car&&form.endKm!==''&&!kmValid&&<p className="p21-warning">Крайните километри не могат да са по-малко от началните.</p>}
   <div className="p21-actions"><button type="button" disabled={!finishReady||finishBusy||form.finished} onClick={finish}>{finishBusy?'⏳ Записвам…':reactOwned&&source===initialTripId?'🔒 Приключи в Google Drive':'🏁 Приключи пробно'}</button><button type="button" className="ghost" onClick={()=>{setForm({...initial});setConfirmed(false);setNotice('Пробните промени са върнати.');resetManual()}}>↶ Възстанови</button></div>
   {(confirmed||form.finished)&&<p className="p21-success">✅ {confirmed?(reactOwned&&source===initialTripId?'Приключено':'Приключено пробно'):'Пътуването е отбелязано като приключено в оригиналните настройки'}. {form.car&&totalKm!==null?`Пробег: ${totalKm.toLocaleString('bg-BG')} км.`:''}</p>}{notice&&<p className="muted">{notice}</p>}
  </section>}
  
 </div></div>
}

// Patch 38 — display-only latest activity card and original Streamlit comparison modes.
function LatestActivityCard({activity}){
 if(!activity)return null;
 const raw=String(activity.description||'Без описание');
 const stage=raw.match(/\(Етап:\s*([^)]*)\)/i);
 const isFuel=/\[(?:ПЪЛНО|ПЪЛЕН|ЧАСТИЧНО)\s+ЗАРЕЖДАНЕ\]/i.test(raw);
 const title=raw.replace(/\[(?:ПЪЛНО|ПЪЛЕН|ЧАСТИЧНО)\s+ЗАРЕЖДАНЕ\]/gi,'').replace(/\(Етап:\s*[^)]*\)/gi,'').replace(/\[(?:P\d+[A-Za-z0-9:._-]*|[a-f0-9]{24,})\]/gi,'').trim()||'Зареждане';
 return <section className="p38-latest" aria-label="Последна активност">
  <div className="p38-latest-top"><span>◷ ПОСЛЕДНА АКТИВНОСТ</span><span className="p38-latest-pill">{isFuel?'⛽ Гориво':'🧾 Разход'}</span></div>
  <div className="p38-latest-main"><span className="p38-latest-icon">{isFuel?'⛽':'💳'}</span><div className="p38-latest-text"><strong>{title}</strong><small>{activity.trip||'Пътуване'} · {activity.category||'Разход'}</small></div><b>{money(activity.amount)}</b></div>
  {stage&&<div className="p38-latest-foot">🚗 {stage[1].replace(/,\s*/g,' · ')}</div>}
 </section>
}
const compareOptions=[['Общо','€'],['€ / ден','€/ден'],['Цена / км','€/км'],['Км','км'],['Гориво','€'],['л / 100 км','л/100 км'],['Хотел','€'],['Други','€']];
const compareHelp={'Общо':'Всички отчетени разходи за пътуването.','€ / ден':'Общо разходи, разделени на календарните дни, включително първия и последния.','Цена / км':'Обща стойност за един изминат километър.','Км':'Пробег от началния до крайния или последно записания километраж.','Гориво':'Платена сума за гориво.','л / 100 км':'Отчетени литри за целия пробег, не реален разход между две пълни зареждания.','Хотел':'Хотели и депозити.','Други':'Разходите в категория „Други“.'};
function comparisonMetrics(trip,detail,draft){
 const rows=applyExpenseDraft(detail?.expenses||[],draft),s=detail?.settings||trip.settings||{};
 const num=x=>{const v=Number(x);return Number.isFinite(v)?v:0};
 const payments=rows.filter(r=>['expense','deposit'].includes(String(r.type)));
 const total=payments.reduce((a,r)=>a+num(r.amount),0);
 const hotel=payments.filter(r=>['Нощувки/Хотел','Депозит/Резервация'].includes(String(r.category||''))||r.type==='deposit').reduce((a,r)=>a+num(r.amount),0);
 const other=payments.filter(r=>r.category==='Други').reduce((a,r)=>a+num(r.amount),0);
 const fuel=payments.filter(r=>r.category==='Транспорт'&&(num(r.liters)>0||/газ|гориво|зареждане|бензин|дизел/i.test(String(r.description||''))));
 const fuelCost=fuel.reduce((a,r)=>a+num(r.amount),0),fuelLiters=fuel.reduce((a,r)=>a+num(r.liters),0);
 const startKm=num(s.start_km),endKm=num(s.end_km),lastKm=Math.max(0,...payments.filter(r=>r.type==='expense').map(r=>num(r.current_km)));
 const effectiveEnd=endKm>0?endKm:lastKm,km=effectiveEnd>startKm?effectiveEnd-startKm:0;
 const sd=asDate(s.start_date),ed=asDate(s.end_date);
 const days=sd&&ed?Math.max(1,Math.round((Date.UTC(ed.getFullYear(),ed.getMonth(),ed.getDate())-Date.UTC(sd.getFullYear(),sd.getMonth(),sd.getDate()))/86400000)+1):1;
 return {id:trip.id,name:trip.name||trip.id,'Общо':total,'€ / ден':total/days,'Цена / км':km?total/km:null,'Км':km,'Гориво':fuelCost,'л / 100 км':km&&fuelLiters?fuelLiters/km*100:null,'Хотел':hotel,'Други':other};
}
function TripComparison({trips,loadTrip,expenseDrafts,onClose}){
 const [mode,setMode]=useState('all'),[metric,setMetric]=useState('Общо'),[items,setItems]=useState([]),[busy,setBusy]=useState(true),[failure,setFailure]=useState('');
 const [a,setA]=useState(''),[b,setB]=useState('');
 useEffect(()=>{let cancelled=false;async function go(){setBusy(true);setFailure('');try{
  const result=[];let errors=0;
  for(let i=0;i<trips.length;i+=4){const batch=await Promise.allSettled(trips.slice(i,i+4).map(t=>loadTrip(t.id)));
   if(cancelled)return;
   batch.forEach((out,j)=>{if(out.status==='fulfilled')result.push(comparisonMetrics(trips[i+j],out.value,expenseDrafts[trips[i+j].id]));else errors++});
  }
  if(!cancelled){setItems(result);setA(result[0]?.id||'');setB(result[1]?.id||'');if(errors)setFailure(`${errors} пътувания не можаха да бъдат заредени и не участват в сравнението.`)}
 }catch(e){if(!cancelled)setFailure(String(e.message))}finally{if(!cancelled)setBusy(false)}}go();return()=>{cancelled=true};},[trips,loadTrip,expenseDrafts]);
 const unit=compareOptions.find(x=>x[0]===metric)?.[1]||'';
 const valid=items.filter(x=>x[metric]!==null&&Number.isFinite(x[metric]));
 const sorted=[...valid].sort((x,y)=>metric==='Км'?y[metric]-x[metric]:x[metric]-y[metric]);
 const selected=mode==='pair'?items.filter(x=>x.id===a||x.id===b).sort((x,y)=>(x.id===a?-1:1)):sorted;
 const max=Math.max(1,...selected.map(x=>x[metric]||0));
 const fmt=v=>v===null||!Number.isFinite(v)?'Няма данни':Number(v).toLocaleString('bg-BG',{maximumFractionDigits:2});
 const winner=mode==='pair'&&selected.length===2&&selected.every(x=>x[metric]!==null)?selected[0][metric]===selected[1][metric]?'Равен резултат':metric==='Км'?(selected[0][metric]>selected[1][metric]?selected[0].name:selected[1].name):(selected[0][metric]<selected[1][metric]?selected[0].name:selected[1].name):null;
 return <section className="p38-comparison"><div className="p38-comparison-head"><div><small>PIXELAPP · АНАЛИЗ</small><h2>📊 Сравнение</h2><p>Всички пътувания или две конкретни приключения — както в Streamlit.</p></div><button className="ghost" onClick={onClose}>✕ Затвори</button></div>
  <div className="p38-toggle"><button className={mode==='all'?'active':''} onClick={()=>setMode('all')}>Всички пътувания</button><button className={mode==='pair'?'active':''} onClick={()=>setMode('pair')}>Две пътувания</button></div>
  <label className="p38-metric">Показател<select value={metric} onChange={e=>setMetric(e.target.value)}>{compareOptions.map(([label])=><option key={label}>{label}</option>)}</select></label>
  <p className="p38-hint">ⓘ {compareHelp[metric]}</p>
  {mode==='pair'&&<div className="p38-pair"><label>Пътуване 1<select value={a} onChange={e=>{setA(e.target.value);if(e.target.value===b)setB(items.find(x=>x.id!==e.target.value)?.id||'')}}>{items.map(x=><option value={x.id} key={x.id}>{x.name}</option>)}</select></label><label>Пътуване 2<select value={b} onChange={e=>setB(e.target.value)}>{items.filter(x=>x.id!==a).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div>}
  {busy?<p className="p38-hint">Зареждам данните за сравнение…</p>:<>{failure&&<p className="p38-warning">{failure}</p>}{items.length===0?<p className="p38-hint">Няма данни за сравнение.</p>:mode==='pair'&&items.length<2?<p className="p38-hint">Нужни са поне две пътувания.</p>:<>
  <div className="p38-compare-bars">{selected.map(x=><div key={x.id} className="p38-compare-row"><div className="p38-compare-row-head"><span>{x.name}</span><strong>{fmt(x[metric])}{x[metric]!==null?' '+unit:''}</strong></div><div className="p38-compare-track"><span style={{width:`${Math.max(0,(x[metric]||0)/max*100)}%`}}/></div></div>)}</div>
  {mode==='pair'?<div className="p38-compare-result">🏆 {winner||'Няма достатъчно данни за победител'}</div>:sorted.length>0?<div className="p38-compare-result"><div>🏆 {metric==='Км'?'Най-голям пробег':'Най-ниска стойност'}: <b>{metric==='Км'?[...sorted].sort((x,y)=>y[metric]-x[metric])[0].name:[...sorted].sort((x,y)=>x[metric]-y[metric])[0].name}</b></div><div>📈 Най-висока стойност: <b>{[...sorted].sort((x,y)=>y[metric]-x[metric])[0].name}</b></div></div>:<p className="p38-hint">Няма налични стойности за този показател.</p>}
  </>}</>}
  <small className="p38-compare-note">🔒 Само за преглед. Нищо не се записва в Google Drive.</small>
 </section>;
}

// Patch 37 — local-only admin overview and the next-trip countdown.
// No POST/PUT/DELETE API call is made by this panel.
function NextTripCountdown({trips}){
 const [today,setToday]=useState(()=>isoDay(new Date()));
 const [pictureFailed,setPictureFailed]=useState(false);
 useEffect(()=>{
  const interval=setInterval(()=>{const n=isoDay(new Date());setToday(old=>old.getTime()===n.getTime()?old:n)},60000);
  return ()=>clearInterval(interval);
 },[]);
 const upcoming=trips.map(trip=>({trip,start:asDate(trip.settings?.start_date)}))
  .filter(x=>x.start&&x.start>=today&&tripState(x.trip)!=='finished')
  .sort((a,b)=>a.start-b.start)[0];
 const cover=upcoming?.trip?.cover_photo_url || upcoming?.trip?.cover_image_url || upcoming?.trip?.photo_url;
 // Only an explicitly supplied HTTPS gallery URL can be used; never guess photos by destination.
 const photoUrl=typeof cover==='string'&&/^https:\/\/[^\s]+$/i.test(cover)?cover:null;
 useEffect(()=>setPictureFailed(false),[photoUrl]);
 if(!upcoming)return null;
 const days=Math.max(0,Math.round((Date.UTC(upcoming.start.getFullYear(),upcoming.start.getMonth(),upcoming.start.getDate())-Date.UTC(today.getFullYear(),today.getMonth(),today.getDate()))/86400000));
 const start=upcoming.trip.settings?.start_date||'';
 const end=upcoming.trip.settings?.end_date;
 return <section className={'p40-countdown'+(photoUrl&&!pictureFailed?' p40-countdown-photo':'')} aria-label="Обратен брояч до следващото пътуване">
  {photoUrl&&!pictureFailed&&<img className="p40-countdown-cover" src={photoUrl} alt="" loading="lazy" onError={()=>setPictureFailed(true)}/>}
  <div className="p40-countdown-content">
   <div className="p40-countdown-overline"><span aria-hidden="true">✈</span> СЛЕДВАЩОТО ПРИКЛЮЧЕНИЕ</div>
   <h2>{upcoming.trip.name||'Следващо пътуване'}</h2>
   <p className="p40-countdown-date"><span aria-hidden="true">▦</span> {start}{end&&end!==start?' → '+end:''}</p>
   <div className="p40-countdown-progress" aria-hidden="true"><span/></div>
   <p className="p40-countdown-footnote">{days===0?'Днес потегляме! 🚗✨':days===1?'Утре потегляме! 🚗✨':'Скоро тръгваме! 🚗✨'}</p>
  </div>
  <div className="p40-countdown-ring" aria-label={days===0?'Пътуването започва днес':`${days} дни остават до пътуването`}><strong>{days===0?'ДНЕС':days}</strong><span>{days===0?'Време е за път!':days===1?'ден остава':'дни остават'}</span></div>
 </section>;
}
function NewTripSafetyPreview({onClose,onPreflight,onCreate,onSaved}){
 const [start,setStart]=useState('');const [end,setEnd]=useState('');
 const [car,setCar]=useState(true);const [startKm,setStartKm]=useState('');
 const [proof,setProof]=useState(null);const [busy,setBusy]=useState(false);
 const [confirmed,setConfirmed]=useState(false);const [message,setMessage]=useState('');
 const dayBG=s=>s?`${s.slice(8,10)}.${s.slice(5,7)}.${s.slice(0,4)}`:'';
 const valid=!!start&&!!end&&end>=start&&(!car||startKm.trim()!==''&&Number.isInteger(Number(startKm))&&Number(startKm)>=0);
 async function check(){setProof(null);setConfirmed(false);setBusy(true);setMessage('');try{const p=await onPreflight();setProof(p);if(!p.drive_matches_local)setMessage('⚠️ Настройките в Render и Google Drive се различават. Записът остава забранен.');else if(p.already_exists)setMessage('ℹ️ Тестовото пътуване вече съществува. Няма да го създаваме повторно.');else if(!p.armed)setMessage('🔒 API е готов, но тестовото записване е изключено в Render — точно както трябва за първата проверка.');else setMessage('✅ Сверката е успешна. Само тестовото пътуване може да бъде създадено след потвърждение.');}catch(e){setMessage('⚠️ '+String(e.message||e))}finally{setBusy(false)}}
 async function create(e){e.preventDefault();if(!confirmed||!valid||!proof?.can_test||!proof?.armed||busy)return;
  setBusy(true);setMessage('');try{
   // Repeat the read-only preflight immediately before making a test write.
   const fresh=await onPreflight();setProof(fresh);
   if(!fresh?.armed||!fresh?.can_test||!fresh?.drive_matches_local||!fresh?.settings_sha256)throw Error('Проверката не позволява запис. Не е създадено пътуване.');
   const result=await onCreate({name:'ТЕСТ НОВО – PixelApp',start_date:dayBG(start),end_date:dayBG(end),car_trip:car,start_km:car?Number(startKm):0,expected_sha256:fresh.settings_sha256,confirmation:'СЪЗДАЙ САМО ТЕСТОВО ПЪТУВАНЕ'});
   setConfirmed(false);setMessage('✅ Създадено е само '+result.trip_id+'. Архив: '+result.backup_id);await onSaved();
  }catch(e){setMessage('⚠️ '+String(e.message||e)+' Ако заявката е прекъснала, първо провери дали пътуването вече съществува.');}finally{setBusy(false)}}
 return <div className="overlay" onClick={onClose}><div className="dialog p21-dialog" role="dialog" aria-modal="true" aria-label="Безопасно създаване на тестово пътуване" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>🧪 Ново пътуване · безопасен тест</h3><button type="button" className="ghost" onClick={onClose}>✕</button></div>
  <p className="p26-modal-safe">Създава се единствено „ТЕСТ НОВО – PixelApp“. Всички стари пътувания остават заключени. Първо правим проверка, без запис.</p>
  <button type="button" className="ghost" disabled={busy} onClick={check}>{busy?'⏳ Проверявам…':'🔎 Провери готовността за тест'}</button>
  {proof&&<div className="travel-card"><p><b>Google Drive ↔ Render:</b> {proof.drive_matches_local?'✅ Съвпадат':'⚠️ Различни данни'}</p><p><b>Тестово записване:</b> {proof.armed?'⚠️ Разрешено в Render':'🔒 Изключено'}</p><p><b>Пътуването съществува:</b> {proof.already_exists?'Да':'Не'}</p></div>}
  <form className="quick-demo-form" onSubmit={create}>
   <label>Име<input value="ТЕСТ НОВО – PixelApp" readOnly/></label>
   <label>Начална дата<input type="date" value={start} onChange={e=>{setStart(e.target.value);setConfirmed(false)}} required/></label>
   <label>Крайна дата<input type="date" value={end} onChange={e=>{setEnd(e.target.value);setConfirmed(false)}} required/></label>
   <label>Автомобил<select value={car?'yes':'no'} onChange={e=>{setCar(e.target.value==='yes');setConfirmed(false)}}><option value="yes">С автомобил</option><option value="no">Без автомобил</option></select></label>
   {car&&<label>Начален километраж<input type="number" min="0" step="1" value={startKm} onChange={e=>{setStartKm(e.target.value);setConfirmed(false)}} placeholder="Например 100000" required/></label>}
   {proof?.armed&&proof?.can_test&&<label className="p42-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Потвърждавам, че това е единствено тестово пътуване и имам архив на данните.</label>}
   <button type="submit" disabled={busy||!valid||!confirmed||!proof?.armed||!proof?.can_test||!proof?.drive_matches_local}>💾 Създай само тестовото пътуване</button>
   {!proof?.armed&&<small className="muted">🔒 Реалният запис остава заключен. Не променяй настройките на Render за тази проверка.</small>}
  </form>
  {message&&<p role="status" className={message.startsWith('⚠️')?'error':'muted'}>{message}</p>}
 </div></div>;
}

function TestTripEditPreview({onClose,onPreflight,onEdit,onSaved}){
 const [proof,setProof]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [start,setStart]=useState(''),[end,setEnd]=useState(''),[car,setCar]=useState(true),[km,setKm]=useState(''),[confirmed,setConfirmed]=useState(false);
 const dateISO=s=>/^\d{2}\.\d{2}\.\d{4}$/.test(s)?s.slice(6)+'-'+s.slice(3,5)+'-'+s.slice(0,2):'';
 const dateBG=s=>s?s.slice(8)+'.'+s.slice(5,7)+'.'+s.slice(0,4):'';
 const valid=!!start&&!!end&&end>=start&&(!car||(km!==''&&Number.isInteger(Number(km))&&Number(km)>=0&&Number(km)<=9999999));
 async function check(){setBusy(true);setConfirmed(false);setMessage('');try{const p=await onPreflight();setProof(p);if(p.trip_found){setStart(dateISO(p.test_trip.start_date));setEnd(dateISO(p.test_trip.end_date));setCar(p.test_trip.car_trip==='Да');setKm(p.test_trip.start_km||'0')}setMessage(p.can_edit?'✅ Готово за контролирана редакция.':'🔒 Проверката е само за четене. За редакция са нужни съвпадащи данни и отделно разрешение в Render.');}catch(e){setProof(null);setMessage('⚠️ '+String(e.message||e))}finally{setBusy(false)}}
 async function save(e){e.preventDefault();if(!valid||!confirmed||!proof?.can_edit||busy)return;setBusy(true);setMessage('');try{
  const fresh=await onPreflight();setProof(fresh);
  if(!fresh.can_edit||!fresh.settings_sha256)throw Error('Сверката е неуспешна. Няма запис.');
  const result=await onEdit({start_date:dateBG(start),end_date:dateBG(end),car_trip:car,start_km:car?Number(km):0,expected_sha256:fresh.settings_sha256,confirmation:'РЕДАКТИРАЙ САМО ТЕСТОВОТО ПЪТУВАНЕ'});
  setConfirmed(false);setMessage('✅ Редакцията е потвърдена в Google Drive. Архив: '+result.backup_id);await onSaved();
 }catch(e){setConfirmed(false);setMessage('⚠️ '+String(e.message||e)+' Не опитвай повторно преди нова проверка.')}finally{setBusy(false)}}
 return <div className="overlay" onClick={onClose}><div className="dialog p21-dialog" role="dialog" aria-modal="true" aria-label="Редакция само на тестовото пътуване" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>🧪 Редакция · само тестово пътуване</h3><button className="ghost" type="button" onClick={onClose}>✕</button></div>
  <p className="p26-modal-safe">Само „ТЕСТ НОВО – PixelApp“. Името и идентификаторът остават непроменени. Старите пътувания са заключени.</p>
  <button type="button" className="ghost" disabled={busy} onClick={check}>{busy?'⏳ Проверявам…':'🔎 Провери редакцията'}</button>
  {proof&&<div className="travel-card"><p><b>Drive ↔ Render:</b> {proof.drive_matches_local?'✅ Съвпадат':'⚠️ Различни'}</p><p><b>Тестово пътуване:</b> {proof.trip_found?'✅ Намерено':'⚠️ Липсва'}</p><p><b>Редакция:</b> {proof.armed?'⚠️ Разрешена':'🔒 Заключена'}</p></div>}
  <form className="quick-demo-form" onSubmit={save}>
   <label>Начална дата<input type="date" required value={start} onChange={e=>{setStart(e.target.value);setConfirmed(false)}}/></label>
   <label>Крайна дата<input type="date" required value={end} onChange={e=>{setEnd(e.target.value);setConfirmed(false)}}/></label>
   <label>Автомобил<select value={car?'yes':'no'} onChange={e=>{setCar(e.target.value==='yes');setConfirmed(false)}}><option value="yes">С автомобил</option><option value="no">Без автомобил</option></select></label>
   {car&&<label>Начален километраж<input type="number" min="0" max="9999999" required step="1" value={km} onChange={e=>{setKm(e.target.value);setConfirmed(false)}}/></label>}
   {proof?.can_edit&&<label className="p42-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Имам резервно копие, Streamlit е затворен и променям само тестовото пътуване.</label>}
   <button type="submit" disabled={!valid||!proof?.can_edit||!confirmed||busy}>{busy?'⏳ Записвам…':'💾 Запиши само тестовата редакция'}</button>
  </form>
  {message&&<p role="status" className={message.startsWith('⚠️')?'error':'muted'}>{message}</p>}
 </div></div>
}


// Patch 62: dedicated, lockable financial test for the NEW trip only.
// Patch 65: normal expense editor using verified Patch 64 server protection.
// The server still restricts writes to the single test trip; this UI does not grant permissions.
function TestFinancePreview({onClose,onPreflight,onSave,onSaved,onFuelPreflight,onFuelSave,onMissedFuelSave,carTrip=false,expensesOnly=false,tripName='ТЕСТ НОВО – PixelApp'}){
 const [proof,setProof]=useState(null),[busy,setBusy]=useState(false),[msg,setMsg]=useState('');
 const [view,setView]=useState(expensesOnly?'expenses':'budget');
 const [budget,setBudget]=useState('');
 const [amount,setAmount]=useState(''),[category,setCategory]=useState('Храна и напитки'),[desc,setDesc]=useState('');
 const [original,setOriginal]=useState(null),[showSafety,setShowSafety]=useState(false);
 const [fuelLiters,setFuelLiters]=useState(''),[fuelKm,setFuelKm]=useState(''),[fuelFull,setFuelFull]=useState(true);
 const [missedLiters,setMissedLiters]=useState(''),[missedPaid,setMissedPaid]=useState(false),[missedAmount,setMissedAmount]=useState('');
 const fuelSelected=category==='Транспорт'&&/газ|гориво|зареждане|бензин|дизел/i.test(desc.trim());
 const fuelNumeric=v=>/^\d+(?:[.,]\d{1,2})?$/.test(String(v).trim())&&Number(String(v).replace(',','.'))>0;
 const fuelReady=original?false:!fuelSelected||(carTrip&&!!onFuelPreflight&&!!onFuelSave&&fuelNumeric(fuelLiters)&&fmtFuel(fuelLiters)<=200&&/^\d+$/.test(fuelKm)&&Number(fuelKm)>0);
 function fmtFuel(v){return Number(String(v).replace(',','.'))}

 const moneyValid=v=>/^\d+(?:[.,]\d{1,2})?$/.test(String(v).trim())&&Number(String(v).replace(',','.'))>=0&&Number(String(v).replace(',','.'))<=100000;
 const fmtAmount=v=>Number(String(v||'0').replace(',','.'));
 const resetExpense=()=>{setOriginal(null);setAmount('');setCategory('Храна и напитки');setDesc('');setFuelLiters('');setFuelKm('');setFuelFull(true)};
 async function check(silent=false){
  setBusy(true);if(!silent)setMsg('');
  try{const p=await onPreflight();setProof(p);setBudget(p.budgets?.find(x=>x.category==='__GLOBAL__')?.budget||'0');
   if(!silent&&!p.can_write)setMsg('🔒 Записването е заключено или данните са се променили.');
  }catch(e){setProof(null);setMsg('⚠️ '+String(e.message||e));}finally{setBusy(false)}
 }
 async function change(operation,expense){
  if(!proof?.can_write||busy)return;
  setBusy(true);setMsg('');
  try{
   const p=await onPreflight();setProof(p);
   if(!p.can_write)throw Error('Данните са променени или записът е заключен.');
   // Fuel is a single, normal expense. Dedicated guarded API writes the same CSV row,
   // with liters / odometer / fill type; never call finance and fuel writes together.
   if(operation==='expense-add'&&fuelSelected){
    if(!carTrip||!onFuelPreflight||!onFuelSave)throw Error('Гориво се записва само при пътуване със собствен автомобил.');
    if(!moneyValid(amount)||fmtAmount(amount)<=0||!fuelNumeric(fuelLiters)||fmtFuel(fuelLiters)>200||!/^\d+$/.test(fuelKm))throw Error('Попълни сума, литри и километраж.');
    const fuelProof=await onFuelPreflight();
    if(!fuelProof.can_write||!fuelProof.sha256)throw Error('Горивото е заключено или Drive не съвпада.');
    if(Number(fuelKm)<=Number(fuelProof.last_km))throw Error('Километражът трябва да е над '+Number(fuelProof.last_km).toLocaleString('bg-BG')+' км.');
    const result=await onFuelSave({amount:fmtAmount(amount),liters:fmtFuel(fuelLiters),current_km:Number(fuelKm),full:fuelFull,description:desc.trim(),expected_sha256:fuelProof.sha256});
    const verified=await onPreflight();setProof(verified);resetExpense();
    setMsg('✅ Горивото е записано като един разход в Google Drive. Архив: '+(result.backup_id||'създаден'));
    await onSaved();return;
   }
   const kind=operation==='budget'?'budgets':'expenses';const sha=p.files?.[kind]?.sha256;
   if(!sha)throw Error('Липсва потвърден SHA256 за файла.');
   const payload={operation,expected_sha256:sha,confirmation:'ЗАПИШИ САМО ТЕСТОВИ ФИНАНСИ'};
   if(operation==='budget'){
    if(!moneyValid(budget))throw Error('Въведи валиден бюджет.');payload.amount=fmtAmount(budget);
   }else if(operation==='expense-add'||operation==='expense-edit'){
    if(!moneyValid(amount)||fmtAmount(amount)<=0||!desc.trim())throw Error('Въведи сума и описание.');
    Object.assign(payload,{amount:fmtAmount(amount),category,description:desc.trim()});
   }
   if(operation==='expense-edit'||operation==='expense-delete'){
    if(!expense)throw Error('Не е избран разход.');
    payload.original=Object.fromEntries(['trip_id','date','amount','category','description','type','liters','current_km'].map(k=>[k,String(expense[k]??'')]));
   }
   const result=await onSave(payload);
   // Re-read the backend-verified snapshot instead of assuming success from local state.
   const verified=await onPreflight();setProof(verified);
   setBudget(verified.budgets?.find(x=>x.category==='__GLOBAL__')?.budget||'0');
   resetExpense();
   setMsg('✅ Запазено и проверено в Google Drive. Резервно копие: '+(result.backup_id||'създадено'));
   await onSaved();
  }catch(e){setMsg('⚠️ '+String(e.message||e)+' Провери данните, преди да опиташ отново.');}
  finally{setBusy(false)}
 }
 async function saveMissed(){
  if(!proof?.can_write||busy||!onFuelPreflight||!onMissedFuelSave)return;
  if(!fuelNumeric(missedLiters)||fmtFuel(missedLiters)>500||missedPaid&&(!moneyValid(missedAmount)||fmtAmount(missedAmount)<=0)){
   setMsg('⚠️ Попълни валидни литри и сума.');return;
  }
  setBusy(true);setMsg('');
  try{
   const state=await onFuelPreflight();
   if(!state?.can_write||!state.sha256)throw Error('Горивото е заключено или данните не съвпадат.');
   const requestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
   const response=await onMissedFuelSave({liters:fmtFuel(missedLiters),amount:missedPaid?fmtAmount(missedAmount):0,expected_sha256:state.sha256,request_id:requestId});
   if(!response.ok)throw Error('Липсва потвърждение от сървъра.');
   setMissedLiters('');setMissedAmount('');setMissedPaid(false);
   setMsg('✅ Пропуснатите литри са записани в Google Drive. '+(response.backup_id?'Архив: '+response.backup_id:response.note||''));
   const verified=await onPreflight();setProof(verified);await onSaved();
  }catch(e){setMsg('⚠️ '+String(e.message||e)+' Не повтаряй без проверка на данните.');}
  finally{setBusy(false)}
 }
 useEffect(()=>{check(true)},[]);
 const expenses=(proof?.expenses||[]).filter(x=>x.type==='expense');
 const spent=expenses.reduce((sum,x)=>sum+Number(x.amount||0),0);
 const budgetNumber=Number(proof?.budgets?.find(x=>x.category==='__GLOBAL__')?.budget||0);
 const eligible=x=>x.description?.startsWith('[P62] ')&&x.type==='expense'&&['0','0.0','0.00',''].includes(String(x.liters??''))&&['0','0.0','0.00',''].includes(String(x.current_km??''));
 function beginEdit(x){setView('expenses');setOriginal(x);setAmount(String(x.amount||''));setCategory(x.category||'Други');setDesc(String(x.description||'').replace(/^\[P62\] /,''));setMsg('')}
 return <div className="overlay" onClick={onClose}><div className="dialog p21-dialog" role="dialog" aria-modal="true" aria-label="Разходи и бюджет" onClick={e=>e.stopPropagation()}>
 <div className="dialoghead"><h3>💳 Разходи и бюджет</h3><button type="button" className="ghost" onClick={onClose} aria-label="Затвори">✕</button></div>
 <p className="muted" style={{marginTop:0}}>🚙 {tripName}</p>
 <div className="actions" style={{gap:8,display:'flex',flexWrap:'wrap',marginBottom:12}}>
  <button type="button" className={view==='expenses'?'':'ghost'} onClick={()=>setView('expenses')}>💳 Разходи</button>
  <button type="button" className={view==='budget'?'':'ghost'} onClick={()=>setView('budget')}>🎯 Бюджет</button>

 </div>
 {!proof?<p className="muted">{busy?'⏳ Проверявам данните в Google Drive…':'⚠️ Няма потвърдени данни. Използвай „Обнови данните“.'}</p>:<div className="quick-demo-grid" style={{marginBottom:14}}>
  <div><small>Бюджет</small><strong>{money(budgetNumber)}</strong></div>
  <div><small>Разходи</small><strong>{money(spent)}</strong></div>
  <div><small>Остават</small><strong>{money(budgetNumber-spent)}</strong></div>
 </div>}
 {!proof?.can_write&&proof&&<p className="error">🔒 Записът е недостъпен. Провери дали данните в Drive съвпадат.</p>}
 <div className="quick-demo-form">
 {view==='budget'?<>
  <h4>🎯 Общ бюджет на пътуването</h4>
  <label>Общ бюджет (€)<input type="text" inputMode="decimal" value={budget} placeholder="Например 280,00" onChange={e=>setBudget(e.target.value)} /></label>
  <button type="button" disabled={!proof?.can_write||busy||!moneyValid(budget)} onClick={()=>change('budget')}>{busy?'⏳ Записвам…':'💾 Запази бюджета'}</button>
  <small className="muted">Бюджетът се записва само за избраното ново пътуване.</small>
 </>:<>
  <h4>{original?'✏️ Редактирай разход':'➕ Нов разход'}</h4>
  <label>Сума (€)<input type="text" inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0,00" /></label>
  <label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}>{['Храна и напитки','Транспорт','Други','Нощувки/Хотел'].map(x=><option key={x}>{x}</option>)}</select></label>
  <label>Описание<input type="text" maxLength={120} value={desc} onChange={e=>setDesc(e.target.value)} placeholder="За какво е разходът?" /></label>
  {fuelSelected&&!original&&<section className="p21-section" style={{margin:'10px 0',padding:12,border:'1px solid #357b9b',borderRadius:12}}>
   <strong>⛽ Данни за зареждането</strong>
   <small className="muted" style={{display:'block',marginBottom:8}}>Автоматично разпознато: Транспорт + ключова дума. Един запис в разходите и горивото.</small>
   {!carTrip?<p className="error">🚗 Това пътуване не е със собствен автомобил — не можем да запишем гориво.</p>:<>
    <label>Литри<input type="text" inputMode="decimal" value={fuelLiters} onChange={e=>setFuelLiters(e.target.value)} placeholder="Напр. 35,5" /></label>
    <label>Тип зареждане<select value={fuelFull?'full':'partial'} onChange={e=>setFuelFull(e.target.value==='full')}><option value="full">Да, до горе (пълен резервоар)</option><option value="partial">Не, частично (за конкретна сума)</option></select></label>
    <label>Текущ километраж<input type="number" inputMode="numeric" min="1" step="1" value={fuelKm} onChange={e=>setFuelKm(e.target.value)} placeholder="Км на таблото" /></label>
   </>}
  </section>}
  <small className="muted">Дата: автоматично при записването. {fuelSelected?'Горивото се записва веднъж с литрите и километража.':'За гориво избери „Транспорт“ и напиши газ, гориво, зареждане, бензин или дизел.'}</small>
  <div className="actions" style={{display:'flex',flexWrap:'wrap',gap:8}}>
   <button type="button" disabled={!proof?.can_write||busy||!moneyValid(amount)||fmtAmount(amount)<=0||!desc.trim()||!fuelReady} onClick={()=>change(original?'expense-edit':'expense-add',original)}>{busy?'⏳ Записвам…':original?'💾 Запази редакцията':'➕ Добави разход'}</button>
   {original&&<button type="button" className="ghost" disabled={busy} onClick={resetExpense}>Откажи</button>}
  </div>
  <h4>🧾 Записани разходи</h4>
  {!expenses.length&&<p className="muted">Няма записани разходи.</p>}
  {expenses.map((x,i)=><div key={`${x.date}-${x.description}-${i}`} className="travel-card" style={{padding:12,marginBottom:8}}>
   <div style={{display:'flex',justifyContent:'space-between',alignItems:'start',gap:8}}><div><b>{String(x.description||'').replace(/^\[P62\] /,'')}</b><div className="muted" style={{fontSize:12}}>{x.category} · {x.date}</div></div><strong>{money(x.amount)}</strong></div>
   {eligible(x)&&<div className="actions" style={{display:'flex',gap:8,marginTop:8}}>
    <button type="button" className="ghost" disabled={busy} onClick={()=>beginEdit(x)}>✏️ Редактирай</button>
    <button type="button" className="ghost" disabled={busy||!proof?.can_write} onClick={()=>{if(window.confirm('Да изтрия ли този тестов разход?'))change('expense-delete',x)}}>🗑️ Изтрий</button>
   </div>}
  </div>)}
 </>}
 </div>
 <details style={{marginTop:12}} open={showSafety} onToggle={e=>setShowSafety(e.currentTarget.open)}><summary className="muted">🔐 Защита и синхронизация</summary>
  <p className="muted">Записва се само за новосъздадени пътувания в React. Старите пътувания са само за четене. Не прави едновременно промени през Streamlit.</p>
  {proof&&<p className="muted">Google Drive: {proof.files?.budgets?.drive_matches_local&&proof.files?.expenses?.drive_matches_local?'✅ Синхронизиран':'⚠️ Разминаване'} · {proof.can_write?'✅ Пилотът е разрешен':'🔒 Заключено'}</p>}
  <button type="button" className="ghost" disabled={busy} onClick={()=>check(false)}>🔄 Обнови данните</button>
 </details>
 {msg&&<p role="status" className={msg.startsWith('⚠️')?'error':'muted'}>{msg}</p>}
 </div></div>;
}


function RegularNewTrip({onClose,onPreflight,onCreate,onSaved}){
 const [name,setName]=useState(''),[start,setStart]=useState(''),[end,setEnd]=useState('');
 const [car,setCar]=useState(true),[km,setKm]=useState(''),[busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const toBG=s=>s?`${s.slice(8,10)}.${s.slice(5,7)}.${s.slice(0,4)}`:'';
 const valid=name.trim().length>=2&&!!start&&!!end&&end>=start&&(!car||(km.trim()!==''&&Number.isInteger(Number(km))&&Number(km)>=0));
 async function submit(e){e.preventDefault();if(!valid||busy)return;
  setBusy(true);setMessage('');
  try{
   const check=await onPreflight();
   if(!check.enabled||!check.drive_matches_local||!check.settings_sha256)throw Error('Данните не са синхронизирани или създаването е спряно. Няма запис.');
   const result=await onCreate({name:name.trim(),start_date:toBG(start),end_date:toBG(end),car_trip:car,start_km:car?Number(km):0,expected_sha256:check.settings_sha256});
   setMessage('✅ Създадено: '+result.trip_id+'. Архив в Google Drive: '+result.backup_id);
   await onSaved(result.trip_id);
  }catch(err){setMessage('⚠️ '+String(err.message||err)+' Ако връзката е прекъснала, първо провери списъка с пътувания, вместо да натискаш повторно.');}
  finally{setBusy(false)}
 }
 return <div className="overlay" onClick={onClose}><div className="dialog p21-dialog" role="dialog" aria-modal="true" aria-label="Ново пътуване" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>✈️ Ново пътуване</h3><button type="button" className="ghost" onClick={onClose}>✕</button></div>
  <p className="muted">Създаване с автоматична сверка и архив в Google Drive. Старите пътувания не се променят. Не използвай едновременно Streamlit.</p>
  <form className="quick-demo-form" onSubmit={submit}>
   <label>Име на пътуването<input value={name} onChange={e=>setName(e.target.value)} maxLength={80} placeholder="Например: Италия 2027" required/></label>
   <label>Начална дата<input type="date" value={start} onChange={e=>setStart(e.target.value)} required/></label>
   <label>Крайна дата<input type="date" value={end} min={start||undefined} onChange={e=>setEnd(e.target.value)} required/></label>
   <label>Пътуване<select value={car?'yes':'no'} onChange={e=>setCar(e.target.value==='yes')}><option value="yes">С автомобил</option><option value="no">Без автомобил</option></select></label>
   {car&&<label>Начален километраж<input type="number" min="0" step="1" placeholder="Задължително" value={km} onChange={e=>setKm(e.target.value)} required/></label>}
   <button type="submit" disabled={!valid||busy}>{busy?'⏳ Записвам…':'💾 Създай пътуването'}</button>
  </form>
  {message&&<p role="status" className={message.startsWith('⚠️')?'error':'muted'}>{message}</p>}
  <p className="muted" style={{fontSize:12}}>Бюджетите и обикновените разходи са налични след създаване на новото пътуване. Горивото остава отделно.</p>
 </div></div>;
}

function MyProfile({username,onChangePassword,onLogout,onClose}){
 const [oldPass,setOldPass]=useState('');
 const [newPass,setNewPass]=useState('');
 const [repeat,setRepeat]=useState('');
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 async function save(e){
  e.preventDefault();setMessage('');
  if(newPass!==repeat){setMessage('Новите пароли не съвпадат.');return;}
  setBusy(true);
  try{await onChangePassword({current_password:oldPass,new_password:newPass});setOldPass('');setNewPass('');setRepeat('');setMessage('✅ Паролата е сменена и потвърдена.');}
  catch(err){setMessage('⚠️ '+String(err.message||err))}
  finally{setBusy(false)}
 }
 return <section className="panel" style={{margin:'12px 0',padding:16}} aria-label="Моят профил">
  <div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}}><h3 style={{margin:0}}>Моят профил</h3><button type="button" className="ghost" onClick={onClose}>Затвори</button></div>
  <p>Влязъл профил: <strong>{username||'Зарежда се…'}</strong></p>
  <form onSubmit={save} style={{display:'grid',gap:10,maxWidth:420}}>
   <label>Текуща парола<input type="password" autoComplete="current-password" value={oldPass} onChange={e=>setOldPass(e.target.value)} required/></label>
   <label>Нова парола (4–12 символа)<input type="password" autoComplete="new-password" minLength={4} maxLength={12} value={newPass} onChange={e=>setNewPass(e.target.value)} required/></label>
   <label>Повтори новата парола<input type="password" autoComplete="new-password" minLength={4} maxLength={12} value={repeat} onChange={e=>setRepeat(e.target.value)} required/></label>
   <button type="submit" disabled={busy}>{busy?'Записвам…':'Смени паролата'}</button>
  </form>
  {message&&<p role="status">{message}</p>}
  <button type="button" className="ghost" onClick={onLogout} style={{marginTop:12}}>Изход от профила</button>
 </section>
}

function App(){
 const [key,setKey]=useState(sessionStorage.getItem('pixel_auth_session')||sessionStorage.getItem('pixel_api_key')||'');
 // A previously authenticated session can render immediately. The server still verifies each request.
 const [authMode,setAuthMode]=useState(()=>sessionStorage.getItem('pixel_auth_session')?'accounts':'checking');
 const [authConfigError,setAuthConfigError]=useState('');
 const [authRetry,setAuthRetry]=useState(0);
 const [authUser,setAuthUser]=useState('');
 const [authPassword,setAuthPassword]=useState('');
 const [authError,setAuthError]=useState('');
 useEffect(()=>{
  let live=true;
  // Do not block an existing account session on a second cold-start request.
  if(!sessionStorage.getItem('pixel_auth_session'))setAuthMode('checking');
  setAuthConfigError('');
  fetch(`${apiBase}/auth/config`,{cache:'no-store',headers:{'Accept':'application/json'}})
   .then(async r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json()})
   .then(x=>{
    if(!live)return;
    if(x?.mode!=='accounts'&&x?.mode!=='legacy')throw Error('Непознат режим на вход от сървъра.');
    if(x.mode==='accounts'){
     sessionStorage.removeItem('pixel_api_key');
     setKey(sessionStorage.getItem('pixel_auth_session')||'');
    }else{
     sessionStorage.removeItem('pixel_auth_session');
     setKey(sessionStorage.getItem('pixel_api_key')||'');
    }
    setAuthMode(x.mode);
   })
   .catch(err=>{if(live){setAuthConfigError(`Не успях да проверя режима на вход от сървъра (${String(err.message||err)}).`);setAuthMode('error');setKey('');}});
  return()=>{live=false};
 },[authRetry]);
 const newTestTripId='ТЕСТ_НОВО_–_PixelApp';
 const [reactOwnedTrips,setReactOwnedTrips]=useState([]);
 const [adminOpen,setAdminOpen]=useState(false);
 const [skin,setSkin]=useState(()=>localStorage.getItem('pixelapp_skin_'+(sessionStorage.getItem('pixel_account_name')||'legacy'))||'standard');
 const [profileOpen,setProfileOpen]=useState(false);
 const [profileUser,setProfileUser]=useState(()=>sessionStorage.getItem('pixel_account_name')||'');
 useEffect(()=>{const user=profileUser||'legacy';setSkin(localStorage.getItem('pixelapp_skin_'+user)||'standard')},[profileUser]);
 useEffect(()=>{document.documentElement.dataset.pixelappSkin=skin;return()=>{delete document.documentElement.dataset.pixelappSkin}},[skin]);
 const changeSkin=(value)=>{setSkin(value);localStorage.setItem('pixelapp_skin_'+(profileUser||'legacy'),value)};
 useEffect(()=>{if(authMode!=='accounts'||!key)return;let active=true;
  fetch(`${apiBase}/auth/me`,{headers:{Authorization:`Bearer ${key}`}})
   .then(r=>r.ok?r.json():Promise.reject(Error('session')))
   .then(x=>{if(active){setProfileUser(x.username||'');sessionStorage.setItem('pixel_account_name',x.username||'')}})
   .catch(()=>{});
  return()=>{active=false};
 },[authMode,key]);
 const [comparisonOpen,setComparisonOpen]=useState(false);
 const [readOnly,setReadOnly]=useState(true);
 const [testWriteArmed,setTestWriteArmed]=useState(false);
 const [entry,setEntry]=useState(''); const [trips,setTrips]=useState([]);const [current,setCurrent]=useState(null);
 const [detail,setDetail]=useState(null);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
 const [dataFreshness,setDataFreshness]=useState('none');const [cachedAt,setCachedAt]=useState(null);
 const [expenseDrafts,setExpenseDrafts]=useState({});
 function updateExpenseDraft(tripId,field,value){
  setExpenseDrafts(prev=>{
   const draft=prev[tripId]||blankExpenseDraft();
   const nextValue=typeof value==='function'?value(draft[field]):value;
   return {...prev,[tripId]:{...draft,[field]:nextValue}};
  });
 }
 const currentExpenseDraft=expenseDrafts[current];
 const [modal,setModal]=useState('');const [name,setName]=useState('');const [start,setStart]=useState('');const [end,setEnd]=useState('');const [car,setCar]=useState(false);
 const [amount,setAmount]=useState('');const [category,setCategory]=useState(categories[0]);const [desc,setDesc]=useState('');const [task,setTask]=useState('');
 const [budget,setBudget]=useState('');const [tab,setTab]=useState('overview');const [dashboard,setDashboard]=useState(null);const [showFinished,setShowFinished]=useState(false);const [homePlaces,setHomePlaces]=useState([]);
 // Retry only transient connection/server errors. Authentication and client errors must not be retried.
 async function reqWithRetry(path,attempts=3){
  let lastError;
  for(let attempt=0;attempt<attempts;attempt++){
   try{return await req(path)}catch(err){
    lastError=err;
    const message=String(err?.message||err);
    if(/^4\d\d:/.test(message) || !(/^(500|502|503|504):/.test(message)||err instanceof TypeError))throw err;
    if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,1200*(attempt+1)));
   }
  }
  throw lastError;
 }
 async function req(path,method='GET',body){const r=await fetch(`${apiBase}${path}`,{method,headers:{...(authMode==='accounts'?{'Authorization':`Bearer ${key}`}:{'X-API-Key':key}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok){let msg=await r.text();throw Error(`${r.status}: ${msg}`)}return r.json()}
 async function reload(selected=current){
  if(!key)return;
  setLoading(true);setError('');
  try{
   // Fetch the trip index FIRST: optional widgets can trigger multiple Drive reads
   // and compete with it on a cold Render instance.
   const freshTrips=await reqWithRetry('/trips');
   if(!Array.isArray(freshTrips))throw Error('Невалиден списък с пътувания от сървъра.');
   setTrips(freshTrips);setDataFreshness('fresh');setCachedAt(Date.now());
   if(freshTrips.length>0)void writeFastCache(key,{trips:freshTrips,dashboard:null,homePlaces:[]});
   // Optional sections start after the trips become available. Their failures
   // must never hide the list or discard a previously successful snapshot.
   const extras=Promise.all([
    req('/dashboard').catch(()=>null),
    req('/home/places').catch(()=>null),
    req('/safe/react-owned-trips').catch(()=>null)
   ]).then(([freshDashboard,placesRaw,ownedRaw])=>{
    if(ownedRaw?.trip_ids)setReactOwnedTrips(ownedRaw.trip_ids);
    const freshPlaces=Array.isArray(placesRaw)?placesRaw:null;
    if(freshDashboard!==null)setDashboard(freshDashboard);
    if(freshPlaces!==null)setHomePlaces(freshPlaces);
    if(freshTrips.length>0&&freshDashboard!==null&&freshPlaces!==null)
     void writeFastCache(key,{trips:freshTrips,dashboard:freshDashboard,homePlaces:freshPlaces});
   });
   // Don't await optional extras for the initial loading indicator.
   void extras;
   if(selected){const d=await req(`/trips/${encodeURIComponent(selected)}`);setDetail(d)}
  }catch(e){if(authMode==='accounts'&&String(e.message||e).startsWith('401:')){sessionStorage.removeItem('pixel_auth_session');setKey('');return;}setError(`Неуспешно обновяване: ${String(e.message||e)}. ${dataFreshness==='cached'?'Показани са последно запазените данни.':''}`)}
  finally{setLoading(false)}
 }
 useEffect(()=>{
  if(!key)return;
  let live=true;
  setReadOnly(true);setDataFreshness('none');setCachedAt(null);
  // Restore first, then request new data; no empty screen during normal reopening.
  (async()=>{
   const cached=await readFastCache(key);
   if(!live)return;
   if(cached){setTrips(cached.trips);setDashboard(cached.dashboard??null);setHomePlaces(cached.homePlaces??[]);setCachedAt(cached.at);setDataFreshness('cached')}
   if(!live)return;
   await reload();
  })();
  fetch(`${apiBase}/health`,{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('health');return r.json()}).then(x=>{if(live){setReadOnly(x.read_only!==false);setTestWriteArmed(x.test_write_armed===true)}}).catch(()=>{if(live){setReadOnly(true);setTestWriteArmed(false)}});
  return()=>{live=false};
 },[key]);
 // P89.1: Refresh read-only views when this browser tab becomes active again.
 // This is best-effort UI synchronization; write conflict checks remain server-side.
 useEffect(()=>{
  if(!key)return;
  let disposed=false;
  let inFlight=false;
  let lastChecked=Date.now(); // initial load already runs above
  const refreshOnReturn=async()=>{
   if(disposed||inFlight||document.visibilityState==='hidden'||modal)return;
   if(Date.now()-lastChecked<2000)return;
   // Avoid overwriting what someone is in the middle of typing or editing.
   const editing=document.querySelector('.task-preview-edit, .task-preview-form input');
   if(editing?.matches?.('.task-preview-edit'))return;
   if(editing?.value?.trim())return;
   const active=document.activeElement;
   if(active?.matches?.('input,textarea,select,[contenteditable="true"]'))return;
   lastChecked=Date.now();inFlight=true;
   try{
    if(current){
     const freshDetail=await req(`/trips/${encodeURIComponent(current)}`);
     if(!disposed)setDetail(freshDetail);
    }else{
     const freshTrips=await req('/trips');
     if(!disposed&&Array.isArray(freshTrips)){
      setTrips(freshTrips);
      setDataFreshness('fresh');
      setCachedAt(Date.now());
     }
    }
   }catch(err){/* Keep the existing data; manual Refresh remains available. */}
   finally{inFlight=false}
  };
  const onFocus=()=>{void refreshOnReturn()};
  const onVisibility=()=>{if(document.visibilityState==='visible')void refreshOnReturn()};
  window.addEventListener('focus',onFocus);
  document.addEventListener('visibilitychange',onVisibility);
  return()=>{disposed=true;window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onVisibility)};
 },[key,current,modal,authMode]);
 const chosen=trips.find(x=>x.id===current);
 async function run(job){if(readOnly||dataFreshness!=='fresh'){setError('Режим само за четене: промените са изключени, за да пазим данните.');return;}setError('');try{await job();await reload();setModal('')}catch(e){setError(String(e.message))}}
 const comparisonLoader=React.useCallback(id=>req(`/trips/${encodeURIComponent(id)}`),[key]);
 async function connect(e){
  e.preventDefault();setAuthError('');
  if(authMode==='accounts'){
   try{
    const response=await fetch(`${apiBase}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:authUser.trim(),password:authPassword})});
    if(!response.ok)throw Error(response.status===401?'Неправилно потребителско име или парола.':'Неуспешен вход. Провери настройките на сървъра.');
    const result=await response.json();sessionStorage.setItem('pixel_auth_session',result.token);sessionStorage.removeItem('pixel_api_key');
    setAuthPassword('');setProfileUser(result.username||'');sessionStorage.setItem('pixel_account_name',result.username||'');setKey(result.token);
   }catch(err){setAuthError(String(err.message||err))}
   return;
  }
  const value=entry.trim();if(!value)return;sessionStorage.setItem('pixel_api_key',value);setKey(value);setEntry('');
 }
 function logout(){setProfileOpen(false);setProfileUser('');sessionStorage.removeItem('pixel_account_name');sessionStorage.removeItem('pixel_api_key');sessionStorage.removeItem('pixel_auth_session');localStorage.removeItem(FAST_CACHE_KEY);setKey('');setTrips([]);setExpenseDrafts({});setDataFreshness('none');}
 if(authMode==='checking'||authMode==='error'||!key)return <main className="auth"><div className="brand">🐾 <span>PixelApp</span></div><p>Travel Manager</p><section className="panel"><h3>{authMode==='accounts'?'Вход в профила':authMode==='legacy'?'Личен достъп':'Проверка на връзката'}</h3>{authMode==='error'?<><p role="alert" className="error">{authConfigError}</p><p>Опитай отново. Ако проблемът продължи, провери дали Render е Live и дали адресът на API е правилен.</p><button type="button" onClick={()=>setAuthRetry(n=>n+1)}>Провери отново</button></>:authMode==='checking'?<p>Проверявам какъв вход използва сървърът…</p>:<form onSubmit={connect}>{authMode==='accounts'?<><input autoComplete="username" value={authUser} onChange={e=>setAuthUser(e.target.value)} placeholder="Потребителско име" required/><input type="password" autoComplete="current-password" value={authPassword} onChange={e=>setAuthPassword(e.target.value)} placeholder="Парола" required/></>:<><p>Въведи личния API ключ. Google токените не се въвеждат тук.</p><input type="password" autoComplete="off" value={entry} onChange={e=>setEntry(e.target.value)} placeholder="API ключ" required/></>}<button>Влез</button></form>}{authError&&authMode!=='error'&&<p className="error" role="alert">{authError}</p>}</section></main>;
 return <main className="app"><header><div className="brand">🐾 <span>PixelApp</span></div><div className="sub">Travel Manager</div></header>
 
 <nav><button className="ghost" onClick={()=>{if(current){setCurrent(null);setDetail(null)}else if(comparisonOpen){setComparisonOpen(false)}else{logout()}}}>{current||comparisonOpen?<><ArrowLeft size={17}/> Начало</>:<><LogOut size={17}/> Изход</>}</button>{!current&&!comparisonOpen&&<button type="button" aria-expanded={adminOpen} aria-controls="pixelapp-admin-settings" className="ghost p37-settings-button" onClick={()=>setAdminOpen(v=>!v)}>⚙️ {adminOpen?"Затвори настройки":"Настройки"}</button>}<button className="ghost" onClick={()=>reload()}><RefreshCcw size={17}/> Обнови</button></nav>
 {!current&&!comparisonOpen&&profileOpen&&authMode==='accounts'&&<MyProfile username={profileUser} onChangePassword={payload=>req('/auth/change-password','POST',payload)} onLogout={logout} onClose={()=>setProfileOpen(false)}/>}
 {!current&&!comparisonOpen&&adminOpen&&<section id="pixelapp-admin-settings" className="p881-admin-inline" aria-label="Настройки на PixelApp"><div className="dialog p37-admin-dialog"><div className="dialoghead"><h3>⚙️ Настройки на PixelApp</h3><button type="button" className="ghost" onClick={()=>setAdminOpen(false)} aria-label="Затвори">✕</button></div><div className="p37-admin-content"><h4>☁️ Данни и синхронизация</h4><div className="p37-status"><span>Заредени пътувания</span><strong>{trips.length}</strong></div><button type="button" className="p37-admin-action" onClick={()=>{setAdminOpen(false);reload()}}><RefreshCcw size={16}/> Обнови данните</button><div className="pixelapp-settings-group"><h4>🎨 Външен вид</h4><label htmlFor="pixelapp-skin-select">Скин на този профил</label><select id="pixelapp-skin-select" value={skin} onChange={e=>changeSkin(e.target.value)}><option value="standard">Стандартен · Синьо</option><option value="graphite">Графит</option></select><p className="muted">Изборът е само за този профил на това устройство.</p></div>{authMode==='accounts'&&<div className="pixelapp-settings-group"><h4>👤 Потребителски профил</h4><button type="button" className="p37-admin-action" onClick={()=>{setAdminOpen(false);setProfileOpen(true)}}>Моят профил · Парола и изход</button></div>}<div className="pixelapp-settings-group"><button type="button" className="ghost" onClick={async()=>{setAdminOpen(false);setLoading(true);setError('');try{await req('/sync-from-drive','POST');await reload()}catch(e){setError(String(e.message))}finally{setLoading(false)}}}>Прочети от Google Drive</button></div></div></div></section>}
 {dataFreshness==='cached'&&<aside role="status" style={{padding:'10px 12px',borderRadius:10,background:'rgba(255,190,80,.12)',color:'inherit',margin:'10px 0',fontSize:13}}>🕘 Показани са последно запазените данни{cachedAt?` (${new Date(cachedAt).toLocaleString('bg-BG')})`:''}. Обновяването още не е потвърдено. Записването върху тези данни не е разрешено.</aside>}
 {error&&<aside className="error">{error}</aside>}{loading&&<div className="muted">🔄 Обновявам данните…</div>}
 {!current?comparisonOpen?<TripComparison trips={trips} loadTrip={comparisonLoader} expenseDrafts={expenseDrafts} onClose={()=>setComparisonOpen(false)}/>:<>
 <NextTripCountdown trips={trips}/>

  <div className="actions home-actions p28-home-actions"><button onClick={()=>setModal('regular-new-trip')}>✈️ <span><b>Ново пътуване</b><small>Попълни основните данни</small></span></button><button onClick={()=>setModal('normal-expenses')}>💳 <span><b>Бърз разход</b><small>Отвори разходите</small></span></button></div>

 <h4 className="home-heading">Моите пътувания <span>{trips.length} пътувания</span></h4>
 {(() => {const ranked=[...trips].sort((a,b)=>{const rank={active:0,upcoming:1,finished:2},sa=tripState(a),sb=tripState(b);if(rank[sa]!==rank[sb])return rank[sa]-rank[sb];const da=asDate(sa==='finished'?a.settings?.end_date:sa==='upcoming'?a.settings?.start_date:a.settings?.end_date);const db=asDate(sb==='finished'?b.settings?.end_date:sb==='upcoming'?b.settings?.start_date:b.settings?.end_date);return sa==='finished'?(db?.getTime()||0)-(da?.getTime()||0):(da?.getTime()||Infinity)-(db?.getTime()||Infinity)});const ended=ranked.filter(t=>tripState(t)==='finished');const visible=ranked.filter(t=>tripState(t)!=='finished').concat(showFinished?ended:ended.slice(0,1));return <>
 {visible.map(t=>{const state=tripState(t),previewSpent=Number(t.spent||0)+expenseDraftDelta(expenseDrafts[t.id]),pct=t.budget>0?Math.min(100,Math.max(0,previewSpent/t.budget*100)):0;return <button key={t.id} className={'trip home-trip state-'+state} onClick={async()=>{setCurrent(t.id);setTab('overview');setDetail(null);try{setDetail(await req(`/trips/${encodeURIComponent(t.id)}`))}catch(e){setError(e.message)}}}><div className="triptitle">🚙 {t.name}</div><div className="tripstatus">{statusDot[state]} {statusText[state]} <span>{t.settings.start_date||''}{t.settings.end_date&&t.settings.end_date!==t.settings.start_date?' → '+t.settings.end_date:''}</span></div>{state==='finished'?<div className="numbers">💰 Общо изхарчено: <strong>{money(Number(t.spent||0)+expenseDraftDelta(expenseDrafts[t.id]))}</strong>{hasExpenseChanges(expenseDrafts[t.id])&&<small className="p27-draft-label"> · временно</small>}</div>:t.budget>0?<><div className="numbers"><strong>{money(previewSpent)}</strong> / {money(t.budget)} <strong> · {Math.round(pct)}%</strong></div><div className="remaining">💳 Остават <strong>{money(Math.max(0,t.budget-previewSpent))}</strong></div><div className="track"><div style={{width:`${pct}%`}}/></div></>:<div className="numbers">💳 Разходи: <strong>{money(previewSpent)}</strong><small className="muted"> · Без зададен бюджет</small></div>}</button>})}
 {ended.length>1&&<button className="show-completed" onClick={()=>setShowFinished(x=>!x)}>{showFinished?'Скрий старите приключения':'Виж всички приключени'} · {ended.length}</button>}
 </>})()}
 {!trips.length&&loading&&<p role="status" className="muted">⏳ Зареждам пътуванията от сървъра. При първо отваряне Render може да се събужда…</p>}
 {!trips.length&&!loading&&dataFreshness==='none'&&<p role="alert" className="muted">⚠️ Пътуванията още не са заредени. Това не означава, че са изтрити. Натисни „Обнови“ за повторен опит.</p>}
 {!trips.length&&!loading&&dataFreshness==='fresh'&&<p className="muted">Сървърът върна празен списък с пътувания. Провери синхронизацията с Google Drive преди нов запис.</p>}
 {Object.values(expenseDrafts).some(hasExpenseChanges)&&<div className="p27-home-warning">● Сумите за пътуванията включват временни промени. Те ще изчезнат при презареждане. Google Drive не е променен.</div>}
 {dashboard?.last_activity&&<LatestActivityCard activity={dashboard.last_activity}/>}
 <div className="home-extra"><div className="home-extra-title">📊 БЪРЗ ПОГЛЕД</div><div className="home-stats"><div><strong>{dashboard?.trips??trips.length}</strong><small>ПЪТУВАНИЯ</small></div><div><strong>{money((dashboard?.spent??trips.reduce((n,t)=>n+Number(t.spent||0),0))+Object.entries(expenseDrafts).reduce((n,[id,d])=>n+expenseDraftDelta(d),0))}</strong><small>РАЗХОДИ</small></div><div><strong>{Number(dashboard?.km||0).toLocaleString('bg-BG')}</strong><small>КМ</small></div></div></div>
 <HomePlaces points={homePlaces}/>
 <div className="p39-compare-section"><div className="p39-compare-section-title">ОЩЕ ЗА ТВОИТЕ ПРИКЛЮЧЕНИЯ</div><button type="button" className="p38-compare-launch" onClick={()=>setComparisonOpen(true)}>📊 <span><b>Сравнение на пътуванията</b><small>Всички пътувания или две едно срещу друго</small></span><span aria-hidden="true">›</span></button></div>
 </>: <>{chosen&&<TripDetails trip={chosen} detail={detail} readOnly={readOnly} financeOwned={reactOwnedTrips.includes(current)} expenseDraft={currentExpenseDraft} onTaskPreflight={()=>req(`/safe/tasks-preflight/${encodeURIComponent(current)}`)} onTaskChange={payload=>req(`/safe/tasks/${encodeURIComponent(current)}`,'POST',payload)} onTasksSaved={()=>reload(current)} onRoutePreflight={()=>req(`/safe/route-preflight/${encodeURIComponent(current)}`)} onRouteChange={payload=>req(`/safe/route/${encodeURIComponent(current)}`,'POST',payload)} onRouteSaved={()=>reload(current)} onFavoritesLoad={()=>req(`/safe/trip-places/${encodeURIComponent(current)}`)} onFavoriteChange={payload=>req(`/safe/trip-places/${encodeURIComponent(current)}`,'POST',payload)} onOpenPreview={m=>setModal((m==='pilot-budget'||m==='quick-demo')&&reactOwnedTrips.includes(current)?(m==='pilot-budget'?'owned-budget':'owned-expenses'):m)}/>}</>}
 
  {modal==='normal-expenses'&&<TestFinancePreview expensesOnly carTrip={trips.find(t=>t.id===newTestTripId)?.settings?.car_trip==='Да'} onFuelPreflight={()=>req(`/safe/fuel-preflight/${encodeURIComponent(newTestTripId)}`)} onFuelSave={payload=>req(`/safe/fuel/${encodeURIComponent(newTestTripId)}`,'POST',payload)} onMissedFuelSave={payload=>req(`/safe/missed-fuel/${encodeURIComponent(newTestTripId)}`,'POST',payload)} onClose={()=>setModal('')} onPreflight={()=>req('/safety/test-finance-preflight')} onSave={payload=>req('/safety/test-finance','POST',payload)} onSaved={()=>reload(current===newTestTripId?current:null)}/> }
  {(modal==='owned-expenses'||modal==='owned-budget')&&current&&reactOwnedTrips.includes(current)&&<TestFinancePreview key={current} expensesOnly={modal==='owned-expenses'} tripName={trips.find(t=>t.id===current)?.name||current} carTrip={trips.find(t=>t.id===current)?.settings?.car_trip==='Да'} onFuelPreflight={()=>req(`/safe/fuel-preflight/${encodeURIComponent(current)}`)} onFuelSave={payload=>req(`/safe/fuel/${encodeURIComponent(current)}`,'POST',payload)} onMissedFuelSave={payload=>req(`/safe/missed-fuel/${encodeURIComponent(current)}`,'POST',payload)} onClose={()=>setModal('')} onPreflight={()=>req(`/safe/trip-finance-preflight/${encodeURIComponent(current)}`)} onSave={payload=>req(`/safe/trip-finance/${encodeURIComponent(current)}`,'POST',payload)} onSaved={()=>reload(current)}/>}
  {modal==='test-finance'&&<TestFinancePreview onClose={()=>setModal('')} onPreflight={()=>req('/safety/test-finance-preflight')} onSave={payload=>req('/safety/test-finance','POST',payload)} onSaved={()=>reload()}/> }
 {modal==='edit-test-trip'&&<TestTripEditPreview onClose={()=>setModal('')} onPreflight={()=>req('/safety/test-trip-edit-preflight')} onEdit={payload=>req('/safety/test-trip-edit','POST',payload)} onSaved={()=>reload()}/> }
 {modal==='regular-new-trip'&&<RegularNewTrip onClose={()=>setModal('')} onPreflight={()=>req('/safe/new-trip-preflight')} onCreate={payload=>req('/safe/new-trip','POST',payload)} onSaved={async()=>{await reload();}}/>}
 {modal==='new-trip-safety'&&<NewTripSafetyPreview onClose={()=>setModal('')} onPreflight={()=>req('/safety/new-trip-preflight')} onCreate={payload=>req('/safety/new-trip-create','POST',payload)} onSaved={()=>reload()}/>}
 {(modal==='trip-demo'||modal==='trip-fuel')&&<TripManagementPreview trips={trips} initialTripId={current||undefined} defaultPanel={modal==='trip-fuel'?'fuel':'basic'} loadTrip={id=>req(`/trips/${encodeURIComponent(id)}`)} expenseDrafts={expenseDrafts} onUpdateDraft={updateExpenseDraft} reactOwned={reactOwnedTrips.includes(current)} onFuelPreflight={()=>req(`/safe/fuel-preflight/${encodeURIComponent(current)}`)} onMissedFuelSave={payload=>req(`/safe/missed-fuel/${encodeURIComponent(current)}`,'POST',payload)} onFinishPreflight={()=>req(`/safe/finish-preflight/${encodeURIComponent(current)}`)} onFinishSave={payload=>req(`/safe/finish/${encodeURIComponent(current)}`,'POST',payload)} onBasicPreflight={()=>req(`/safe/basic-preflight/${encodeURIComponent(current)}`)} onBasicSave={payload=>req(`/safe/basic/${encodeURIComponent(current)}`,'POST',payload)} onSaved={()=>reload(current)} onClose={()=>setModal('')}/>}
 {modal==='fuel-demo'&&<FuelEntryPreview trips={trips} initialTripId={current||undefined} loadTrip={id=>req(`/trips/${encodeURIComponent(id)}`)} onClose={()=>setModal('')}/>}
 {modal==='quick-demo'&&<QuickExpensePreview trips={trips} initialTripId={current||undefined} expenseDrafts={expenseDrafts} onUpdateDraft={updateExpenseDraft} loadTrip={id=>req(`/trips/${encodeURIComponent(id)}`)} onSafetyPreflight={()=>req('/safety/preflight')} onTestWrite={payload=>req('/safety/test-expense','POST',payload)} onTestChange={payload=>req('/safety/test-expense-change','POST',payload)} onSaved={id=>reload(id)} onClose={()=>setModal('')}/>}
 {modal&&modal!=='quick-demo'&&modal!=='fuel-demo'&&modal!=='trip-demo'&&modal!=='trip-fuel'&&modal!=='new-trip-safety'&&modal!=='regular-new-trip'&&modal!=='edit-test-trip'&&modal!=='test-finance'&&modal!=='normal-expenses'&&modal!=='owned-expenses'&&modal!=='owned-budget'&&<div className="overlay" onClick={()=>setModal('')}><div className="dialog" onClick={e=>e.stopPropagation()}><div className="dialoghead"><h3>{modal==='trip'?'Ново пътуване':'Нов разход'}</h3><button className="ghost" onClick={()=>setModal('')}>✕</button></div>{modal==='trip'?<form onSubmit={e=>{e.preventDefault();run(()=>req('/trips','POST',{name,start_date:start?start.split('-').reverse().join('.'): '',end_date:end?end.split('-').reverse().join('.'): '',car_trip:car}))}}><label>Дестинация<input value={name} onChange={e=>setName(e.target.value)} required/></label><label>Начална дата<input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label><label>Крайна дата<input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label><label className="toggle"><input type="checkbox" checked={car} onChange={e=>setCar(e.target.checked)}/> Пътуване с автомобил</label><button>Създай</button></form>:<form onSubmit={e=>{e.preventDefault();run(()=>req(`/trips/${encodeURIComponent(current)}/expenses`,'POST',{amount:Number(amount),category,description:desc,is_deposit:category==='Депозит/Резервация'}));setAmount('');setDesc('')}}><label>Сума (€)<input type="number" step="0.01" min="0" value={amount} onChange={e=>setAmount(e.target.value)} required/></label><label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}>{categories.map(x=><option key={x}>{x}</option>)}</select></label><label>Описание<input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Без описание"/></label><button>Добави разход</button></form>}</div></div>}
 <footer>PixelApp · Travel Manager</footer></main>
}

createRoot(document.getElementById('root')).render(<App/>);
