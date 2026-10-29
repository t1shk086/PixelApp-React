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

function TripDetails({trip,detail,readOnly,onOpenPreview,expenseDraft}) {
 const [section,setSection]=useState('summary');
 const [taskDrafts,setTaskDrafts]=useState([]);
 const [taskOverrides,setTaskOverrides]=useState({});
 const [taskName,setTaskName]=useState('');
 const [taskEditing,setTaskEditing]=useState(null);
 const [taskEditText,setTaskEditText]=useState('');
 useEffect(()=>{setSection('summary');setTaskDrafts([]);setTaskOverrides({});setTaskName('');setTaskEditing(null);},[trip?.id]);
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
 const avgLiters=rows.reduce((sum,r)=>sum+number(r.liters),0)+number(settings.manual_fuel)+paidManualPreview;
 const avg=km>0&&avgLiters>0?avgLiters/km*100:0;
 const fullFuelRows=rows.filter(r=>r.type==='expense'&&r.category==='Транспорт'&&number(r.current_km)>begin&&/ПЪЛЕН|ПЪЛНО/i.test(String(r.description||'')));
 const lastFull=[...fullFuelRows].sort((a,b)=>number(a.current_km)-number(b.current_km)).at(-1);
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
 <div className="travel-hero"><div className="p34-hero-heading"><div className="travel-overline">🐾 МОЕТО ПЪТУВАНЕ</div><button className="p34-settings-icon" type="button" onClick={()=>onOpenPreview('trip-demo')} title="Настройки на пътуването" aria-label="Настройки на пътуването">⚙️</button></div><h2>🚙 {trip.name}</h2><div className="travel-dates">{dateText}</div><div className="travel-facts visual-top-facts"><div><small>💸 Общо изхарчено</small><strong>{money(allCosts)}</strong></div><div><small>🎯 Бюджет</small><strong>{budgetTotal?money(budgetTotal):'—'}</strong></div><div><small>🚙 Изминати км</small><strong>{km.toLocaleString('bg-BG')}</strong></div></div>{budgetTotal>0&&<div className="travel-progress"><div style={{width:Math.min(100,allCosts/budgetTotal*100)+'%'}}/></div>}</div>
 {readOnly&&<p className="p34-read-only-note">🔒 Обикновените промени са временни · само потвърдените тестови записи се запазват в Drive</p>}
 <div className="travel-menu">{sections.map(([id,label])=><button type="button" key={id} onClick={()=>setSection(id)} className={section===id?'selected':''}>{label}</button>)}</div>
 {!detail?<div className="travel-card">Зареждаме данните за пътуването…</div>:<>
 {section==='summary'&&<>
 <div className="travel-card visual-section"><h3>✨ Пътуването с един поглед</h3><div className="visual-overview-stats"><div className="overview-tile"><span>🧾</span><small>Записи</small><strong>{rows.length}</strong></div><div className="overview-tile"><span>✅</span><small>Задачи</small><strong>{done} <em>/ {previewTasks.length}</em></strong></div><div className="overview-tile"><span>📍</span><small>Места</small><strong>{validPoints.length}</strong></div><div className="overview-tile"><span>⛽</span><small>Гориво</small><strong>{liters.toLocaleString('bg-BG',{maximumFractionDigits:1})} <em>л</em></strong></div></div></div>
 <div className="travel-card visual-section"><h3>💳 Разходи по категории</h3>{Object.keys(byCat).length?Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([name,val],i)=>{const ratio=allCosts>0?Math.max(0,Math.min(100,val/allCosts*100)):0;return <div className="visual-category" key={name}><div className="visual-category-head"><span><i className={'visual-category-dot visual-palette-'+i%5}/>{name}</span><strong>{money(val)}</strong></div><div className="visual-category-bar"><span className={'visual-palette-bg-'+i%5} style={{width:ratio+'%'}}/></div><small>{ratio.toFixed(1)}% от общите разходи</small></div>}):<p className="muted">Няма записани разходи.</p>}</div>
 <div className="travel-card visual-section"><h3>🚗 Гориво и път</h3><div className="visual-overview-stats visual-road-stats"><div className="overview-tile"><span>🛣️</span><small>Изминато</small><strong>{km.toLocaleString('bg-BG')} <em>км</em></strong></div><div className="overview-tile"><span>⛽</span><small>Среден разход</small><strong>{avg?avg.toFixed(1):'—'} <em>л/100 км</em></strong></div></div></div>
 </>}
 {section==='expenses'&&<><div className="p24-section-actions"><button type="button" onClick={()=>onOpenPreview('quick-demo')}>➕ Добави или редактирай разход</button></div><ExpenseHistory rows={rows}/></>}
 {section==='fuel'&&<>

 <div className="travel-card"><h3>🚙 Пробег на автомобила</h3>
 {settings.car_trip==='Не'?<p className="muted">Това пътуване е отбелязано като пътуване без собствен автомобил. Показаните данни са само записаните показания, ако има такива.</p>:null}
 <div className="fuel-road" aria-hidden="true"><span className="fuel-road-node fuel-road-start">S</span><span className="fuel-road-line"/><span className="fuel-road-node fuel-road-current">🚗</span><span className="fuel-road-line"/><span className="fuel-road-node fuel-road-finish">F</span></div>
 <div className="fuel-odometer"><div><small>Старт</small><b>{begin?begin.toLocaleString('bg-BG')+' км':'—'}</b></div><div><small>Изминати</small><b className="fuel-accent">{km.toLocaleString('bg-BG')} км</b></div><div><small>{finish>begin?'Краен':'Последни км'}</small><b>{effectiveReading>0?effectiveReading.toLocaleString('bg-BG')+' км':'—'}</b></div></div>
 {finish>begin&&<p className="fuel-note">Пътуването има записани крайни километри.</p>}
 </div>
 <div className="travel-card"><h3>⛽ Разход на гориво</h3>
 {finish>begin?<div className="fuel-metrics visual-gauges"><div><small className="gauge-label gauge-label-red">РЕАЛЕН РАЗХОД</small><div className="gauge-circle gauge-circle-red"><b>{realConsumption>0?realConsumption.toFixed(1):'—'}</b><em>л/100 км</em></div><small>{realConsumption>0?'Потвърден етап „до горе“':'Няма потвърден етап'}</small></div><div><small className="gauge-label gauge-label-orange">СРЕДЕН РАЗХОД</small><div className="gauge-circle gauge-circle-orange"><b>{avg>0?avg.toFixed(1):'—'}</b><em>л/100 км</em></div><small>Ориентир: всички литри ÷ целия пробег</small></div></div>:<div className="fuel-metrics visual-gauges p20-active-gauge"><div><small className="gauge-label gauge-label-orange">ТЕКУЩ РАЗХОД</small><div className="gauge-circle gauge-circle-orange"><b>{(realConsumption>0?realConsumption:avg)>0?(realConsumption>0?realConsumption:avg).toFixed(1):'—'}</b><em>л/100 км</em></div><small>{realConsumption>0?'Последен потвърден етап „до горе“':'Ориентир до момента по общите литри'}</small></div></div>}
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
  
  <form className="task-preview-form" onSubmit={addPreviewTask}><input aria-label="Нова задача" value={taskName} maxLength={200} onChange={e=>setTaskName(e.target.value)} placeholder="Нова задача…"/><button type="submit" disabled={!taskName.trim()}>➕ Добави</button></form>
  {previewTasks.length?previewTasks.map(t=>{const complete=taskIsDone(t);const isEditing=taskEditing===t._previewKey;return <div key={t._previewKey} className={'task-visual-item task-preview-item'+(complete?' task-visual-done':'')}>
   <button type="button" className="task-preview-check" aria-label={complete?'Отбележи като предстояща':'Отбележи като готова'} onClick={()=>setPreviewTask(t,{done:!complete})}>{complete?'✓':'○'}</button>
   {isEditing?<form className="task-preview-edit" onSubmit={e=>{e.preventDefault();if(taskEditText.trim())setPreviewTask(t,{title:taskEditText.trim()});setTaskEditing(null)}}><input autoFocus value={taskEditText} maxLength={200} onChange={e=>setTaskEditText(e.target.value)}/><button type="submit">Запази</button><button type="button" className="ghost" onClick={()=>setTaskEditing(null)}>Отказ</button></form>:<><span className="task-preview-name">{t.title||'Задача'}</span><button type="button" className="task-preview-action" onClick={()=>{setTaskEditing(t._previewKey);setTaskEditText(t.title||'')}} aria-label={'Редактирай '+(t.title||'задача')}>✎</button>{t._isDraft&&<button type="button" className="task-preview-action" aria-label="Премахни пробната задача" onClick={()=>setTaskDrafts(items=>items.filter(x=>x._previewKey!==t._previewKey))}>✕</button>}</>}
  </div>}):<p className="muted">Няма задачи за това пътуване.</p>}
  {(taskDrafts.length>0||Object.keys(taskOverrides).length>0)&&<button type="button" className="task-preview-reset" onClick={resetTaskPreview}>↺ Отмени промените</button>}
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
function TripManagementPreview({trips,onClose,loadTrip,initialTripId,defaultPanel='basic',expenseDrafts={},onUpdateDraft}){
 const blank=()=>({name:'',startDate:'',endDate:'',car:true,trackFuel:'Да',startKm:'',endKm:'',manualFuel:'',finished:false});
 const [source,setSource]=useState(initialTripId||'__new');
 const [panel,setPanel]=useState(defaultPanel);
 const [form,setForm]=useState(blank);
 const [initial,setInitial]=useState(blank);
 const [confirmed,setConfirmed]=useState(false);
 const [notice,setNotice]=useState('');
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
 const finishReady=form.name.trim()&&dateValid&&carReady&&(!form.car||kmValid);
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

 function finish(){if(!finishReady)return;setForm(f=>({...f,finished:true}));setConfirmed(true);setNotice('Пробно приключване — НЕ е записано в Google Drive.')}
 return <div className="overlay" onClick={onClose}><div className="dialog p21-dialog" role="dialog" aria-modal="true" aria-label="Управление на пътувания — тест" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>✈️ Управление на пътуването</h3><button type="button" className="ghost" onClick={onClose} aria-label="Затвори">✕</button></div><button className="p26-return" type="button" onClick={onClose}>{initialTripId?"← Назад към пътуването":"← Назад към началото"}</button>
  <p className="p26-modal-safe">🔒 Без запис · промените са временни</p>
  <div className="p25-tabs" role="tablist" aria-label="Управление на пътуване">
   {[['basic','⚙️ Основни'],['fuel','⛽ Пропуснато гориво'],['finish','🏁 Приключване']].map(([key,label])=><button type="button" key={key} role="tab" aria-selected={panel===key} className={panel===key?'p25-selected':''} onClick={()=>setPanel(key)}>{label}</button>)}
  </div>
  <label>Пътуване<select value={source} onChange={e=>load(e.target.value)}><option value="__new">➕ Ново пътуване</option>{trips.map(t=><option key={t.id} value={t.id}>{t.name||t.id}</option>)}</select></label>
  {panel==='basic'&&<><div className="p21-grid"><label>Дестинация<input value={form.name} onChange={e=>patch('name',e.target.value)} placeholder="Напр. Livigno Italy"/></label><label>Тип пътуване<select value={form.car?'car':'other'} onChange={e=>patch('car',e.target.value==='car')}><option value="car">🚗 С автомобил</option><option value="other">✈️ Без автомобил</option></select></label><label>От дата<input type="date" value={form.startDate} onChange={e=>patch('startDate',e.target.value)}/></label><label>До дата<input type="date" value={form.endDate} onChange={e=>patch('endDate',e.target.value)}/></label></div>
  {!dateValid&&<p className="p21-warning">Крайната дата трябва да е след началната.</p>}
  {form.car&&<section className="p21-section"><h4>🚗 Настройки на автомобила</h4><div className="p21-grid"><label>Начален километраж<input type="number" min="0" step="1" value={form.startKm} onChange={e=>patch('startKm',e.target.value)} placeholder="100000"/></label><label>Проследяване на горивото<select value={form.trackFuel} onChange={e=>patch('trackFuel',e.target.value)}><option>Да</option><option>Не</option><option>Добави впоследствие</option></select></label></div></section>}
  </>}
  {panel==='fuel'&&form.car&&<section className="p21-section p22-manual"><div className="p31-manual-head"><span className="p31-manual-icon">⛽</span><div><h4>Пропуснато гориво</h4><small>Само забравени литри или зареждания</small></div></div>
   <form onSubmit={addManual} className="p22-form">
    <label>Пропуснато гориво (литри)<input type="number" step="0.01" min="0.01" placeholder="Напр. 25" value={manualLiters} onChange={e=>setManualLiters(e.target.value)} disabled={form.finished}/></label>
    {manualLiters!==''&&Number(manualLiters)>0&&<label className="p22-check"><input type="checkbox" checked={manualHasPrice} onChange={e=>setManualHasPrice(e.target.checked)} disabled={form.finished}/> 💵 Помня и платената сума?</label>}
    {manualHasPrice&&<label>Платена сума (€)<input type="number" step="0.01" min="0.01" placeholder="Напр. 42" value={manualAmount} onChange={e=>setManualAmount(e.target.value)} disabled={form.finished}/></label>}
    <p className="muted p31-compact-note">{manualHasPrice?'При добавяне: сумата ще участва в пробните транспортни разходи; литрите се броят само веднъж.':'При добавяне: ще се отчетат само литрите, без паричен разход.'}</p>
    <button type="submit" disabled={!manualValid||form.finished}>➕ Добави литрите</button>
   </form>
   <div className="p22-stats p31-manual-stats"><div><small>Добавени литри</small><strong>{manualAddedLiters.toLocaleString('bg-BG')} л</strong></div><div><small>Известни разходи</small><strong>{money(manualAddedCost)}</strong></div></div>
   <details className="p31-fuel-details"><summary>📊 Проверка на изчисленията</summary><section className="p23-consumption-preview" aria-label="Пробна проверка на средния разход">
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
</details>
   {manualEntries.length>0&&<><div className="p22-entry-list">{manualEntries.map(entry=><div key={entry.id} className="p22-entry"><span><strong>{entry.hasPrice?'💵 С известна сума':'📝 Само литри'}</strong><small>{entry.liters.toLocaleString('bg-BG')} л · {entry.description}</small></span><b>{entry.hasPrice?money(entry.amount):'Без цена'}</b><button type="button" className="ghost" title="Премахни пробния запис" onClick={()=>setManualEntries(rows=>rows.filter(r=>r.id!==entry.id))}>✕</button></div>)}</div><button type="button" className="ghost" onClick={resetManual}>🗑️ Изчисти само пробното ръчно гориво</button></>}
  </section>}
  {panel==='fuel'&&!form.car&&<p className="p21-warning">За ръчно гориво първо избери „С автомобил“ в „Основни“.</p>}
  {panel==='finish'&&<section className="p21-section"><h4>🏁 Приключване на пътуването</h4>{form.car&&<label>Краен километраж — въвежда се едва при приключване<input type="number" min="0" step="1" value={form.endKm} onChange={e=>patch('endKm',e.target.value)} placeholder="Напр. 100950"/></label>}<div className="p21-grid"><div className="p21-number"><small>Начален километраж</small><strong>{form.car&&form.startKm!==''?startKm.toLocaleString('bg-BG')+' км':'—'}</strong></div><div className="p21-number"><small>Краен километраж</small><strong>{form.car&&form.endKm!==''?endKm.toLocaleString('bg-BG')+' км':'—'}</strong></div><div className="p21-number p21-wide"><small>Общ пробег</small><strong>{form.car&&totalKm!==null?totalKm.toLocaleString('bg-BG')+' км':form.car?'Въведи валидни километри':'Без автомобил'}</strong></div></div>
   {form.car&&form.endKm!==''&&!kmValid&&<p className="p21-warning">Крайните километри не могат да са по-малко от началните.</p>}
   <div className="p21-actions"><button type="button" disabled={!finishReady} onClick={finish}>🏁 Приключи пробно</button><button type="button" className="ghost" onClick={()=>{setForm({...initial});setConfirmed(false);setNotice('Пробните промени са върнати.');resetManual()}}>↶ Възстанови</button></div>
   {(confirmed||form.finished)&&<p className="p21-success">✅ {confirmed?'Приключено пробно':'Пътуването е отбелязано като приключено в оригиналните настройки'}. {form.car&&totalKm!==null?`Пробег: ${totalKm.toLocaleString('bg-BG')} км.`:''}</p>}{notice&&<p className="muted">{notice}</p>}
  </section>}
  
 </div></div>
}

// Patch 38 — display-only latest activity card and original Streamlit comparison modes.
function LatestActivityCard({activity}){
 if(!activity)return null;
 const raw=String(activity.description||'Без описание');
 const stage=raw.match(/\(Етап:\s*([^)]*)\)/i);
 const isFuel=/\[(?:ПЪЛНО|ПЪЛЕН|ЧАСТИЧНО)\s+ЗАРЕЖДАНЕ\]/i.test(raw);
 const title=raw.replace(/\[(?:ПЪЛНО|ПЪЛЕН|ЧАСТИЧНО)\s+ЗАРЕЖДАНЕ\]/gi,'').replace(/\(Етап:\s*[^)]*\)/gi,'').trim()||'Зареждане';
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
function AdminSettingsPreview({trips,readOnly,apiBase,onClose,onRefresh,onPreflight,onTestWrite,testWriteArmed}){
 const [preflight,setPreflight]=useState(null);
 const [checking,setChecking]=useState(false);
 const [checkError,setCheckError]=useState('');
 async function check(){setChecking(true);setCheckError('');setPreflight(null);try{setPreflight(await onPreflight())}catch(e){setCheckError(String(e.message||e))}finally{setChecking(false)}}
 const [testAmount,setTestAmount]=useState('1.00');
 const [testDescription,setTestDescription]=useState('Проверка Пач 42');
 const [testCategory,setTestCategory]=useState('Други');
 const [testConfirmed,setTestConfirmed]=useState(false);
 const [testBusy,setTestBusy]=useState(false);
 const [testResult,setTestResult]=useState('');
 async function writeTest(e){e.preventDefault();setTestResult('');if(!preflight?.expenses_sha256||!preflight?.drive_matches_local||!preflight?.test_trip_found){setTestResult('Първо направи успешна проверка.');return;}setTestBusy(true);try{const res=await onTestWrite({trip_id:preflight.test_trip_id,amount:Number(testAmount),category:testCategory,description:testDescription.trim(),expected_sha256:preflight.expenses_sha256,confirmation:'ЗАПИШИ САМО В ТЕСТ'});setTestResult('✅ Записано и проверено в Drive. Архив: '+res.backup_id);setPreflight(null);setTestConfirmed(false);onRefresh();}catch(err){setTestResult('⚠️ '+String(err.message||err));setPreflight(null);}finally{setTestBusy(false)}}
 const [section,setSection]=useState('data');
 const entries=[['data','☁️','Данни и синхронизация'],['backup','📦','Архивиране и възстановяване'],['trips','🚙','Управление на пътувания'],['labels','🏷️','Категории и имена'],['access','👥','Потребители и достъп'],['fuel','⛽','Настройки на горивото']];
 return <div className="overlay p37-admin-overlay" onClick={onClose} role="presentation"><div className="dialog p37-admin-dialog" role="dialog" aria-modal="true" aria-label="Настройки на PixelApp" onClick={e=>e.stopPropagation()}>
  <div className="dialoghead"><h3>⚙️ Настройки на PixelApp</h3><button className="ghost" onClick={onClose} aria-label="Затвори">✕</button></div>
  <p className="p37-admin-notice">🛡️ Административни настройки. Само отделният изрично разрешен тестов запис може да променя Drive.</p>
  <div className="p37-admin-navigation">{entries.map(([id,icon,title])=><button type="button" key={id} className={section===id?'p37-selected':''} onClick={()=>setSection(id)}><span>{icon}</span> {title}</button>)}</div>
  <div className="p37-admin-content">
   {section==='data'&&<><h4>☁️ Данни и синхронизация</h4><div className="p37-status"><span>Достъп през React</span><strong>{readOnly?'🔒 Само за четене':'⚠️ Записът е разрешен от сървъра'}</strong></div><div className="p37-status"><span>Заредени пътувания</span><strong>{trips.length}</strong></div><p>При обновяване React прочита данните от FastAPI. Ръчната синхронизация от Google Drive остава на началния екран.</p><button type="button" className="p37-admin-action" onClick={()=>{onClose();onRefresh()}}>🔄 Обнови данните</button><div className="p41-safety"><strong>🛡️ Подготовка на тестовото пътуване</strong><p>Проверка само за четене: търси „ТЕСТ – PixelApp“ и сверява текущите CSV файлове с Google Drive. Не записва нищо.</p><button type="button" className="p37-admin-action" onClick={check} disabled={checking}>{checking?'⏳ Проверявам…':'🔍 Провери безопасността'}</button>{checkError&&<p className="error">{checkError}</p>}{preflight&&<div className="p41-check-results"><div className="p37-status"><span>Тестово пътуване</span><strong>{preflight.test_trip_found?'✅ '+preflight.test_trip_id:preflight.test_trip_count>1?'⚠️ Няколко съвпадения':'⚠️ Не е намерено'}</strong></div><div className="p37-status"><span>CSV файлове ↔ Drive</span><strong>{preflight.drive_matches_local?'✅ Съвпадат':'⚠️ Има разлики или липсващи файлове'}</strong></div><div className="p37-status"><span>Записване</span><strong>{preflight?.test_write_armed===true?'⚠️ Тестов запис разрешен':'🔒 Изключено'}</strong></div>{preflight.drive_error&&<p className="error">{preflight.drive_error}</p>}{(preflight.csv_checks||[]).map(f=><div className="p41-check-file" key={f.file}><span>{f.file}</span><b>{f.matches?'✓':'!'}</b></div>)}<small>{preflight.note}</small></div>}</div><div className="p42-test-write"><h4>🧪 Пач 42 · Един тестов разход</h4><p>Само за „ТЕСТ – PixelApp“. Старите пътувания и обикновените бутони остават заключени. Преди теста затвори Streamlit и запази резервен ZIP.</p><p><strong>{preflight?.test_write_armed===true?'⚠️ Разрешен е само тестовият маршрут за запис':'🔒 Тестовият маршрут не е активиран в Render'}</strong></p><form onSubmit={writeTest}><label>Сума (€)<input type="number" min="0.01" max="1000" step="0.01" value={testAmount} onChange={e=>setTestAmount(e.target.value)} required/></label><label>Категория<select value={testCategory} onChange={e=>setTestCategory(e.target.value)}><option>Други</option><option>Храна и напитки</option><option>Транспорт</option><option>Нощувки/Хотел</option></select></label><label>Описание<input value={testDescription} maxLength={200} minLength={1} onChange={e=>setTestDescription(e.target.value)} required/></label><label className="p42-confirm"><input type="checkbox" checked={testConfirmed} onChange={e=>setTestConfirmed(e.target.checked)}/> Затворих Streamlit и имам резервен архив</label><button type="submit" disabled={preflight?.test_write_armed!==true||!preflight?.drive_matches_local||!preflight?.test_trip_found||!testConfirmed||testBusy}>{testBusy?'⏳ Записвам…':'🧪 Запиши само тестовия разход'}</button></form>{testResult&&<p role="status">{testResult}</p>}<small>След запис направи нова проверка. Пълен междупроцесен lock със Streamlit все още няма.</small></div><small>Всички останали операции за запис са заключени.</small></>}
   {section==='backup'&&<><h4>📦 Архивиране и възстановяване</h4><p>Старият Streamlit има работещ ZIP архив на основните CSV данни. Засега използвай него за резервно копие.</p><p>В React ще добавим архивиране и проверка на съдържанието, преди да включим запис. Възстановяването няма да може да презаписва файлове без потвърждение и предварително копие.</p><div className="p37-admin-safe">✅ Няма активни бутони за изтриване или възстановяване.</div></>}
   {section==='trips'&&<><h4>🚙 Управление на пътувания</h4><p>Пътуванията, които виждаш в React: <b>{trips.length}</b>. Преименуването и временното отключване на приключено пътуване ще се добавят след тест на записването.</p><p><b>Тест:</b> създаваме отделно пътуване „ТЕСТ – PixelApp“, но засега не разрешаваме промени по старите данни.</p><div className="p37-admin-safe">🔒 Стари пътувания: без запис от React.</div></>}
   {section==='labels'&&<><h4>🏷️ Категории и имена</h4><p>Ще запазим от Streamlit персоналните категории за отделно пътуване, имената „Куче / Котка / Домашен любимец“, хотелските категории и етикетите на картата.</p><p>Промяната на визуалното име не бива да променя вече записаните категории или финансовите изчисления.</p></>}
   {section==='access'&&<><h4>👥 Потребители и достъп</h4><p>Тук ще бъдат администраторският профил, личните профили и поканите за общо пътуване. Сегашният API ключ остава непроменен до внедряването на сигурно вписване.</p><p>Административните операции ще изискват проверка на правата от сървъра, не само скрит бутон в React.</p></>}
   {section==='fuel'&&<><h4>⛽ Настройки на горивото</h4><p>От старото приложение запазваме прага за висока цена на литър. Текущата начална стойност в стария код е 1,80 €/л.</p><p>Тук ще може да се настройва прагът, когато имаме безопасно записване на глобалните настройки. Редовните зареждания остават в „Бърз разход“.</p></>}
  </div>
  <div className="p37-admin-bottom">Етап 1 · Преглед и подготовка · Без промени по данните</div>
 </div></div>;
}

function App(){
 const [key,setKey]=useState(sessionStorage.getItem('pixel_api_key')||'');
 const [adminOpen,setAdminOpen]=useState(false);
 const [comparisonOpen,setComparisonOpen]=useState(false);
 const [readOnly,setReadOnly]=useState(true);
 const [testWriteArmed,setTestWriteArmed]=useState(false);
 const [entry,setEntry]=useState(''); const [trips,setTrips]=useState([]);const [current,setCurrent]=useState(null);
 const [detail,setDetail]=useState(null);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
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
 async function req(path,method='GET',body){const r=await fetch(`${apiBase}${path}`,{method,headers:{'X-API-Key':key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok){let msg=await r.text();throw Error(`${r.status}: ${msg}`)}return r.json()}
 async function reload(selected=current){if(!key)return;setLoading(true);setError('');try{const all=await req('/trips');setTrips(all);try{setDashboard(await req('/dashboard'))}catch(_){setDashboard(null)}try{setHomePlaces(await req('/home/places'))}catch(_){setHomePlaces([])}if(selected){const d=await req(`/trips/${encodeURIComponent(selected)}`);setDetail(d)}}catch(e){setError(String(e.message))}finally{setLoading(false)}}
 useEffect(()=>{if(key){fetch(`${apiBase}/health`,{cache:'no-store'}).then(r=>r.json()).then(x=>{setReadOnly(x.read_only!==false);setTestWriteArmed(x.test_write_armed===true)}).catch(()=>setReadOnly(true));reload()}},[key]);
 const chosen=trips.find(x=>x.id===current);
 async function run(job){if(readOnly){setError('Режим само за четене: промените са изключени, за да пазим данните.');return;}setError('');try{await job();await reload();setModal('')}catch(e){setError(String(e.message))}}
 const comparisonLoader=React.useCallback(id=>req(`/trips/${encodeURIComponent(id)}`),[key]);
 function connect(e){e.preventDefault();const value=entry.trim();if(!value)return;sessionStorage.setItem('pixel_api_key',value);setKey(value);setEntry('')}
 function logout(){sessionStorage.removeItem('pixel_api_key');setKey('');setTrips([]);setExpenseDrafts({});}
 if(!key)return <main className="auth"><div className="brand">🐾 <span>PixelApp</span></div><p>Travel Manager — React preview</p><section className="panel"><h3>Личен достъп</h3><p>Въведи ключа от <code>PIXELAPP_API_KEY</code> на твоя Python сървър. Google токените никога не се въвеждат тук.</p><form onSubmit={connect}><input type="password" autoComplete="off" value={entry} onChange={e=>setEntry(e.target.value)} placeholder="API ключ"/><button>Влез</button></form></section></main>;
 return <main className="app"><header><div className="brand">🐾 <span>PixelApp</span></div><div className="sub">Travel Manager</div></header>
 {readOnly&&!current&&<aside className="p34-global-read-only">🔒 Обикновените промени са временни · защитените тестови записи са отделни</aside>}
 <nav><button className="ghost" onClick={()=>{if(current){setCurrent(null);setDetail(null)}else if(comparisonOpen){setComparisonOpen(false)}else{sessionStorage.removeItem('pixel_api_key');setKey('');setTrips([]);setExpenseDrafts({})}}}>{current||comparisonOpen?<><ArrowLeft size={17}/> Начало</>:<><LogOut size={17}/> Изход</>}</button>{!current&&!comparisonOpen&&<button className="ghost p37-settings-button" onClick={()=>setAdminOpen(true)}>⚙️ Настройки</button>}<button className="ghost" onClick={()=>reload()}><RefreshCcw size={17}/> Обнови</button></nav>
 {error&&<aside className="error">{error}</aside>}{loading&&<div className="muted">Зареждане…</div>}
 {!current?comparisonOpen?<TripComparison trips={trips} loadTrip={comparisonLoader} expenseDrafts={expenseDrafts} onClose={()=>setComparisonOpen(false)}/>:<>
 <NextTripCountdown trips={trips}/>
 <div className="actions home-actions p28-home-actions"><button onClick={()=>setModal('trip-demo')}>✈️ <span><b>Ново пътуване</b><small>Попълни основните данни</small></span></button><button onClick={()=>setModal('quick-demo')}>💳 <span><b>Бърз разход</b><small>Добави към избрано пътуване</small></span></button></div>
 <div className="home-sync"><button className="ghost" onClick={async()=>{setLoading(true);setError('');try{await req('/sync-from-drive','POST');await reload()}catch(e){setError(String(e.message))}finally{setLoading(false)}}}><RefreshCcw size={15}/> Прочети данните от Google Drive</button></div>
 <h4 className="home-heading">Моите пътувания <span>{trips.length} пътувания</span></h4>
 {(() => {const ranked=[...trips].sort((a,b)=>{const rank={active:0,upcoming:1,finished:2},sa=tripState(a),sb=tripState(b);if(rank[sa]!==rank[sb])return rank[sa]-rank[sb];const da=asDate(sa==='finished'?a.settings?.end_date:sa==='upcoming'?a.settings?.start_date:a.settings?.end_date);const db=asDate(sb==='finished'?b.settings?.end_date:sb==='upcoming'?b.settings?.start_date:b.settings?.end_date);return sa==='finished'?(db?.getTime()||0)-(da?.getTime()||0):(da?.getTime()||Infinity)-(db?.getTime()||Infinity)});const ended=ranked.filter(t=>tripState(t)==='finished');const visible=ranked.filter(t=>tripState(t)!=='finished').concat(showFinished?ended:ended.slice(0,1));return <>
 {visible.map(t=>{const state=tripState(t),previewSpent=Number(t.spent||0)+expenseDraftDelta(expenseDrafts[t.id]),pct=t.budget>0?Math.min(100,Math.max(0,previewSpent/t.budget*100)):0;return <button key={t.id} className={'trip home-trip state-'+state} onClick={async()=>{setCurrent(t.id);setTab('overview');setDetail(null);try{setDetail(await req(`/trips/${encodeURIComponent(t.id)}`))}catch(e){setError(e.message)}}}><div className="triptitle">🚙 {t.name}</div><div className="tripstatus">{statusDot[state]} {statusText[state]} <span>{t.settings.start_date||''}{t.settings.end_date&&t.settings.end_date!==t.settings.start_date?' → '+t.settings.end_date:''}</span></div>{state==='finished'?<div className="numbers">💰 Общо изхарчено: <strong>{money(Number(t.spent||0)+expenseDraftDelta(expenseDrafts[t.id]))}</strong>{hasExpenseChanges(expenseDrafts[t.id])&&<small className="p27-draft-label"> · временно</small>}</div>:t.budget>0?<><div className="numbers"><strong>{money(previewSpent)}</strong> / {money(t.budget)} <strong> · {Math.round(pct)}%</strong></div><div className="remaining">💳 Остават <strong>{money(Math.max(0,t.budget-previewSpent))}</strong></div><div className="track"><div style={{width:`${pct}%`}}/></div></>:<div className="numbers">💳 Разходи: <strong>{money(previewSpent)}</strong><small className="muted"> · Без зададен бюджет</small></div>}</button>})}
 {ended.length>1&&<button className="show-completed" onClick={()=>setShowFinished(x=>!x)}>{showFinished?'Скрий старите приключения':'Виж всички приключени'} · {ended.length}</button>}
 </>})()}
 {!trips.length&&!loading&&<p className="muted">Няма заредени пътувания. Използвай „Прочети данните от Google Drive“.</p>}
 {Object.values(expenseDrafts).some(hasExpenseChanges)&&<div className="p27-home-warning">● Сумите за пътуванията включват временни промени. Те ще изчезнат при презареждане. Google Drive не е променен.</div>}
 {dashboard?.last_activity&&<LatestActivityCard activity={dashboard.last_activity}/>}
 <div className="home-extra"><div className="home-extra-title">📊 БЪРЗ ПОГЛЕД</div><div className="home-stats"><div><strong>{dashboard?.trips??trips.length}</strong><small>ПЪТУВАНИЯ</small></div><div><strong>{money((dashboard?.spent??trips.reduce((n,t)=>n+Number(t.spent||0),0))+Object.entries(expenseDrafts).reduce((n,[id,d])=>n+expenseDraftDelta(d),0))}</strong><small>РАЗХОДИ</small></div><div><strong>{Number(dashboard?.km||0).toLocaleString('bg-BG')}</strong><small>КМ</small></div></div></div>
 <HomePlaces points={homePlaces}/>
 <div className="p39-compare-section"><div className="p39-compare-section-title">ОЩЕ ЗА ТВОИТЕ ПРИКЛЮЧЕНИЯ</div><button type="button" className="p38-compare-launch" onClick={()=>setComparisonOpen(true)}>📊 <span><b>Сравнение на пътуванията</b><small>Всички пътувания или две едно срещу друго</small></span><span aria-hidden="true">›</span></button></div>
 </>: <>{chosen&&<TripDetails trip={chosen} detail={detail} readOnly={readOnly} expenseDraft={currentExpenseDraft} onOpenPreview={setModal}/>}</>}
 {adminOpen&&<AdminSettingsPreview trips={trips} readOnly={readOnly} apiBase={apiBase} onClose={()=>setAdminOpen(false)} onRefresh={()=>reload()} onPreflight={()=>req('/safety/preflight')} onTestWrite={payload=>req('/safety/test-expense','POST',payload)} testWriteArmed={testWriteArmed}/>}
 {(modal==='trip-demo'||modal==='trip-fuel')&&<TripManagementPreview trips={trips} initialTripId={current||undefined} defaultPanel={modal==='trip-fuel'?'fuel':'basic'} loadTrip={id=>req(`/trips/${encodeURIComponent(id)}`)} expenseDrafts={expenseDrafts} onUpdateDraft={updateExpenseDraft} onClose={()=>setModal('')}/>}
 {modal==='fuel-demo'&&<FuelEntryPreview trips={trips} initialTripId={current||undefined} loadTrip={id=>req(`/trips/${encodeURIComponent(id)}`)} onClose={()=>setModal('')}/>}
 {modal==='quick-demo'&&<QuickExpensePreview trips={trips} initialTripId={current||undefined} expenseDrafts={expenseDrafts} onUpdateDraft={updateExpenseDraft} loadTrip={id=>req(`/trips/${encodeURIComponent(id)}`)} onSafetyPreflight={()=>req('/safety/preflight')} onTestWrite={payload=>req('/safety/test-expense','POST',payload)} onTestChange={payload=>req('/safety/test-expense-change','POST',payload)} onSaved={id=>reload(id)} onClose={()=>setModal('')}/>}
 {modal&&modal!=='quick-demo'&&modal!=='fuel-demo'&&modal!=='trip-demo'&&modal!=='trip-fuel'&&<div className="overlay" onClick={()=>setModal('')}><div className="dialog" onClick={e=>e.stopPropagation()}><div className="dialoghead"><h3>{modal==='trip'?'Ново пътуване':'Нов разход'}</h3><button className="ghost" onClick={()=>setModal('')}>✕</button></div>{modal==='trip'?<form onSubmit={e=>{e.preventDefault();run(()=>req('/trips','POST',{name,start_date:start?start.split('-').reverse().join('.'): '',end_date:end?end.split('-').reverse().join('.'): '',car_trip:car}))}}><label>Дестинация<input value={name} onChange={e=>setName(e.target.value)} required/></label><label>Начална дата<input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label><label>Крайна дата<input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label><label className="toggle"><input type="checkbox" checked={car} onChange={e=>setCar(e.target.checked)}/> Пътуване с автомобил</label><button>Създай</button></form>:<form onSubmit={e=>{e.preventDefault();run(()=>req(`/trips/${encodeURIComponent(current)}/expenses`,'POST',{amount:Number(amount),category,description:desc,is_deposit:category==='Депозит/Резервация'}));setAmount('');setDesc('')}}><label>Сума (€)<input type="number" step="0.01" min="0" value={amount} onChange={e=>setAmount(e.target.value)} required/></label><label>Категория<select value={category} onChange={e=>setCategory(e.target.value)}>{categories.map(x=><option key={x}>{x}</option>)}</select></label><label>Описание<input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Без описание"/></label><button>Добави разход</button></form>}</div></div>}
 <footer>PixelApp React · Етап 1 · Данните остават в Google Drive</footer></main>
}

createRoot(document.getElementById('root')).render(<App/>);
