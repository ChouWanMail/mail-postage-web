const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let D = {}, services = [], provinces = [], parcelIndex = {}, parcelMethod = 'ordinary', intlScope = 'international';
let intlDestination = null, intlDestTimer = null, intlCatalog = [];

const names = {
  LETTER:'信函', POSTCARD:'明信片', AEROGRAMME:'航空邮简', PRINTED_MATTER:'印刷品',
  LETTER_SHEET:'邮简', MILITARY_FREE_LETTER:'义务兵免费信函', LITERATURE_FOR_BLIND:'盲人读物',
  SMALL_PACKET:'小包', PRINTED_MATTER_BAG:'印刷品专袋', PARCEL:'包裹'
};
const trans = {AIR:'航空', SAL:'空运水陆路（SAL）', SURFACE:'水陆路'};
const aliases = {GB:['UK','英国','英'], US:['USA','美国'], KR:['韩国','南韩'], KP:['朝鲜','北韩']};
const customNames = new Map();

async function j(path){ const r = await fetch(path); if(!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); }
const money = n => `¥ ${Number(n).toFixed(2)}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ptype = p => p?.type || p?.pricingType;
const category = mailType => mailType === 'PARCEL' ? 'PARCEL' : 'LETTER_POST';
const needsWeight = t => !['flat','free','value_increment','value_increment_with_minimum','external_rule'].includes(t);

function cName(code){
  if(customNames.has(code)) return customNames.get(code);
  try { return new Intl.DisplayNames(['zh-CN'],{type:'region'}).of(code) || code; } catch { return code; }
}

function calc(p, weight, declaredValue){
  const t = ptype(p);
  if(t === 'flat') return p.price;
  if(t === 'free') return 0;
  if(t === 'base_plus_increment'){
    if(!(weight > 0)) throw new Error('请输入有效重量');
    return weight <= p.baseWeight ? p.basePrice : p.basePrice + Math.ceil((weight-p.baseWeight)/p.incrementWeight)*p.incrementPrice;
  }
  if(t === 'surcharge_per_increment' || t === 'air_surcharge_only'){
    if(!(weight > 0)) throw new Error('请输入有效重量');
    return Math.ceil(weight/p.incrementWeight)*p.incrementPrice;
  }
  if(t === 'weight_tiers'){
    if(!(weight > 0)) throw new Error('请输入有效重量');
    const x = p.tiers.find(x =>
      (x.minWeight == null || weight >= x.minWeight) &&
      (x.minWeightExclusive == null || weight > x.minWeightExclusive) &&
      (x.maxWeight == null || weight <= x.maxWeight) &&
      (x.maxWeightExclusive == null || weight < x.maxWeightExclusive)
    );
    if(!x) throw new Error('重量超出当前资费范围');
    return x.price;
  }
  if(t === 'value_increment' || t === 'value_increment_with_minimum'){
    if(!(declaredValue > 0)) throw new Error('已选择保价业务，请输入有效保价金额');
    if(p.maximumInsuredValue != null && declaredValue > p.maximumInsuredValue) throw new Error(`保价金额不得超过 ${p.maximumInsuredValue} 元`);
    const raw = Math.ceil(declaredValue/p.valueIncrement)*p.incrementPrice;
    return t === 'value_increment_with_minimum' ? Math.max(p.minimumPrice, raw) : raw;
  }
  throw new Error(`暂不支持计费类型 ${t}`);
}

function tiered(p,w,loc){
  if(!(w > 0) || w > p.maxWeight) throw new Error('重量超出当前资费范围');
  let sum = 0;
  for(const x of p.tiers){ const hi = Math.min(w,x.toWeight), lo = x.fromWeightExclusive; if(hi > lo) sum += Math.ceil((hi-lo)/x.incrementWeight)*x.prices[loc]; }
  return sum;
}

function out(el,total,meta,lines=[],notes=[]){
  el.innerHTML = `<div class="price">${money(total)}</div><div class="meta">${meta}</div>${lines.length?`<div class="breakdown">${lines.map(x=>`<div class="line"><span>${esc(x.label)}</span><strong>${esc(x.value)}</strong></div>`).join('')}</div>`:''}${notes.map(n=>`<div class="condition-note">${esc(n)}</div>`).join('')}`;
}
const warn = (el,msg) => el.innerHTML = `<div class="warn">${esc(msg)}</div>`;

function rateApplies(rate,{destination=null,mailType,serviceId}){
  if(rate.excludedDestinations?.includes(destination)) return false;
  if(rate.applicableDestinations?.length && !rate.applicableDestinations.includes(destination)) return false;
  if(rate.excludedServiceIds?.includes(serviceId)) return false;
  const selectors = [];
  if(rate.applicableCategories?.length) selectors.push(rate.applicableCategories.includes(category(mailType)));
  if(rate.applicableMailTypes?.length) selectors.push(rate.applicableMailTypes.includes(mailType));
  if(rate.applicableServiceIds?.length) selectors.push(rate.applicableServiceIds.includes(serviceId));
  return selectors.length ? selectors.some(Boolean) : true;
}

function spLabel(rate){
  const p = rate.pricing, t = ptype(p);
  if(t === 'flat') return money(p.price);
  if(t === 'free') return '免费';
  if(t === 'value_increment') return `每${p.valueIncrement}元或零数 +${money(p.incrementPrice)}`;
  if(t === 'value_increment_with_minimum') return `按保价金额，最低 ${money(p.minimumPrice)}`;
  if(t === 'surcharge_per_increment' || t === 'air_surcharge_only') return `每${p.incrementWeight}g或零数 +${money(p.incrementPrice)}`;
  if(t === 'external_rule') return p.ruleRefZh || '按外部规则';
  return t || '—';
}

function renderSpecials(el,rates,ctx,{allowedSelectableIds=null,extraPublic=[]}={}){
  const bagSpecific = ctx.mailType === 'PRINTED_MATTER_BAG' && rates.some(r=>r.id==='PRINTED_MATTER_BAG_REGISTRATION_FEE');
  const rows = [];
  for(const rate of rates){
    if(bagSpecific && rate.id === 'REGISTRATION_FEE') continue;
    if(!rateApplies(rate,ctx)) continue;
    const mode = rate.selection?.mode || 'selectable';
    if(mode === 'selectable' && allowedSelectableIds && !allowedSelectableIds.includes(rate.id)) continue;
    const t = ptype(rate.pricing), displayOnly = mode === 'display-only' || t === 'external_rule' || !!rate.conditions?.length;
    if(displayOnly){
      rows.push(`<div class="special-row public-row"><div class="special-main"><span class="public-badge">仅公示</span><label>${esc(rate.nameZh)}</label><span class="special-price">${esc(spLabel(rate))}</span></div>${rate.noteZh?`<div class="condition-note">${esc(rate.noteZh)}</div>`:''}</div>`);
      continue;
    }
    const value = ['value_increment','value_increment_with_minimum'].includes(t)
      ? `<div class="special-extra"><span>保价金额（元）</span><input type="number" min="0.01" step="0.01" data-value-for="${esc(rate.id)}"></div>` : '';
    rows.push(`<div class="special-row"><div class="special-main"><input type="checkbox" data-rate-id="${esc(rate.id)}"><label>${esc(rate.nameZh)}</label><span class="special-price">${esc(spLabel(rate))}</span></div>${value}${rate.noteZh?`<div class="condition-note">${esc(rate.noteZh)}</div>`:''}</div>`);
  }
  for(const item of extraPublic) rows.push(`<div class="special-row public-row"><div class="special-main"><span class="public-badge">能力</span><label>${esc(item.title)}</label><span class="special-price">${esc(item.value||'')}</span></div>${item.note?`<div class="condition-note">${esc(item.note)}</div>`:''}</div>`);
  el.innerHTML = rows.length ? rows.join('') : '<p class="hint">当前业务暂无附加项目。</p>';
}

function collectSpecials(el,rates,ctx,{serviceCapabilities=null}={}){
  const selected = new Set([...el.querySelectorAll('[data-rate-id]:checked')].map(x=>x.dataset.rateId));
  const notes = [], lines = [];
  const satisfies = id => id === 'REGISTRATION_FEE' && serviceCapabilities?.registrationIncludedInDeliveryPostage;
  const addDeps = id => {
    const r = rates.find(x=>x.id===id); if(!r) return;
    for(const dep of r.dependencies?.requiresRateIds || []){
      if(satisfies(dep)){ notes.push('挂号前提已由基础寄递服务满足，不另收挂号费。'); continue; }
      if(!selected.has(dep)){ selected.add(dep); notes.push(`已自动加入：${rates.find(x=>x.id===dep)?.nameZh || dep}`); addDeps(dep); }
    }
  };
  [...selected].forEach(addDeps);
  for(const id of selected){
    const r = rates.find(x=>x.id===id); if(!r) continue;
    for(const ex of r.dependencies?.excludesRateIds || []) if(selected.has(ex)) throw new Error(`${r.nameZh} 与 ${rates.find(x=>x.id===ex)?.nameZh || ex} 不能同时使用`);
  }
  const included = new Set();
  for(const id of selected){ const r = rates.find(x=>x.id===id); for(const inc of r?.dependencies?.includesRateIds || []) included.add(inc); }
  for(const inc of included) if(selected.has(inc)){ selected.delete(inc); notes.push(`${rates.find(x=>x.id===inc)?.nameZh || inc} 已包含在其他所选费用中，不重复计收。`); }
  let sum = 0;
  for(const id of selected){
    const rate = rates.find(x=>x.id===id);
    if(!rate || rate.selection?.mode === 'display-only' || !rateApplies(rate,ctx)) continue;
    const input = el.querySelector(`[data-value-for="${CSS.escape(id)}"]`);
    const amount = calc(rate.pricing, ctx.weight, input ? Number(input.value) : null);
    sum += amount; lines.push({label:rate.nameZh,value:money(amount)});
  }
  return {sum,lines,notes};
}

function setupTabs(){
  $$('.tab').forEach(b=>b.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('active'));$$('.page').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.page).classList.add('active')});
  $$('.subtab').forEach(b=>b.onclick=()=>{$$('.subtab').forEach(x=>x.classList.remove('active'));$$('#domestic .panel').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.panel).classList.add('active')});
}

function setupDomestic(){
  const list = services.filter(s=>s.scope==='domestic' && s.mailType!=='PARCEL');
  $('#domMail').innerHTML = list.map(s=>`<option value="${s.mailType}">${names[s.mailType]}</option>`).join('');
  $('#domMail').onchange = syncDomestic; syncDomestic();
  $('#calcDomestic').onclick = () => {
    try{
      const m=$('#domMail').value, s=services.find(x=>x.scope==='domestic'&&x.mailType===m), p=D.basic.mailTypes[m], w=Number($('#domWeight').value), loc=$('#domLocality').value;
      const base = p.pricingType==='tiered_incremental' ? tiered(p,w,loc) : p.pricingType==='flat_by_locality' ? p.prices[loc] : calc(p,w);
      const sp = collectSpecials($('#domSpecials'),D.spDom.rates,{weight:w,destination:null,mailType:m,serviceId:s.id});
      const meta=[names[m],['tiered_incremental','flat_by_locality'].includes(p.pricingType)?(loc==='LOCAL'?'本埠':'外埠'):'',needsWeight(p.pricingType)?`${w}g`:''].filter(Boolean).join(' · ');
      out($('#domResult'),base+sp.sum,esc(meta),[{label:'基础寄递资费',value:money(base)},...sp.lines],sp.notes);
    }catch(e){warn($('#domResult'),e.message)}
  };
}
function syncDomestic(){
  const m=$('#domMail').value,p=D.basic.mailTypes[m],s=services.find(x=>x.scope==='domestic'&&x.mailType===m); if(!p||!s)return;
  $('#domLocalityWrap').classList.toggle('hidden',!['tiered_incremental','flat_by_locality'].includes(p.pricingType));
  $('#domWeightWrap').classList.toggle('hidden',!needsWeight(p.pricingType));
  renderSpecials($('#domSpecials'),D.spDom.rates,{destination:null,mailType:m,serviceId:s.id}); $('#domResult').innerHTML='';
}

async function parcelBase(origin,dest,weightKg){
  const w=weightKg*1000; if(!(w>0)||w>50000) throw new Error('普通包裹计费重量须大于0且不超过50kg');
  const band=parcelIndex.weightBands.find(x=>w>x.minWeightExclusive&&w<=x.maxWeight),path=parcelIndex.originFiles[origin];
  if(!band||!path) throw new Error('该起寄省/重量暂无资费');
  const f=await j(`./postage/rates/domestic/ordinary-parcel/${path.replace('./','')}`),g=f.routeGroups.find(x=>x.destinations.includes(dest));
  if(!g) throw new Error('该路向暂无资费');
  const p=g.prices[band.id],fee=w<=band.baseWeight?p.basePrice:p.basePrice+Math.ceil((w-band.baseWeight)/band.incrementWeight)*p.incrementPrice;
  return {fee,file:f};
}

function syncParcelSpecials(){
  const el=$('#parcelSpecials');
  if(parcelMethod==='ordinary'){
    renderSpecials(el,D.spDom.rates,{destination:null,mailType:'PARCEL',serviceId:'DOMESTIC_ORDINARY_PARCEL'},{allowedSelectableIds:parcelIndex.availableSpecialRateIds,extraPublic:[{title:'保价',value:'可办理',note:'当前数据未提供国内普通包裹保价费率，因此只公示能力，不自动计算；可与回执同时办理。'}]});
  }else{
    renderSpecials(el,D.spDom.rates,{destination:null,mailType:'PARCEL',serviceId:'DOMESTIC_HOMETOWN_PARCEL_STICKER'},{allowedSelectableIds:[],extraPublic:[{title:'保价',value:'可办理',note:'当前数据未提供家乡包裹贴保价费率，因此只公示能力，不自动计算。'},{title:'回执',value:'不可办理'}]});
  }
}

function setupParcel(){
  const pop=Object.keys(parcelIndex.originFiles);
  $('#parcelOrigin').innerHTML=pop.map(id=>`<option value="${id}">${provinces.find(x=>x.id===id)?.shortNameZh||id}</option>`).join('');
  $('#parcelDest').innerHTML=provinces.map(x=>`<option value="${x.id}">${x.shortNameZh}</option>`).join('');
  $('#parcelDiscount').innerHTML += parcelIndex.discounts.credentials.map(x=>`<option value="${x.id}">${x.nameZh}（${Math.round(x.pricing.multiplier*10)}折）</option>`).join('');
  $$('.method').forEach(b=>b.onclick=()=>{
    $$('.method').forEach(x=>x.classList.remove('active')); b.classList.add('active'); parcelMethod=b.dataset.method;
    $('#ordinaryFields').classList.toggle('hidden',parcelMethod!=='ordinary'); $('#hometownFields').classList.toggle('hidden',parcelMethod!=='hometown');
    $('#parcelRuleHint').textContent=parcelMethod==='ordinary'?'普通包裹基础资费已含挂号；回执不另收挂号费。优惠只打基础寄递费，回执/保价等特别业务费不打折。':'家乡包裹贴可保价但不可回执；当前保价费率未录入，不参与自动计算。';
    syncParcelSpecials(); $('#parcelResult').innerHTML='';
  });
  syncParcelSpecials();
  $('#calcParcel').onclick=async()=>{
    try{
      if(parcelMethod==='hometown'){
        const w=Number($('#hometownWeight').value)*1000,total=calc(D.hometown,w);
        return out($('#parcelResult'),total,`家乡包裹贴 · ${w/1000}kg`,[{label:'基础寄递资费',value:money(total)}],['可办理保价，但当前保价费率未录入；不可办理回执。']);
      }
      const o=$('#parcelOrigin').value,d=$('#parcelDest').value,actualKg=Number($('#parcelWeight').value);
      const dims=[$('#parcelLength').value,$('#parcelWidth').value,$('#parcelHeight').value].map(v=>v===''?null:Number(v));
      const anyDim=dims.some(v=>v!=null),allDim=dims.every(v=>v!=null&&v>0); if(anyDim&&!allDim) throw new Error('请完整填写长、宽、高，或全部留空');
      const actual=await parcelBase(o,d,actualKg); let volumetric=null;
      if(allDim){ const kg=dims[0]*dims[1]*dims[2]/parcelIndex.volumetricWeight.divisor; volumetric={kg,...await parcelBase(o,d,kg)}; }
      const chosenBase=volumetric?Math.max(actual.fee,volumetric.fee):actual.fee;
      const did=$('#parcelDiscount').value,dis=did?parcelIndex.discounts.credentials.find(x=>x.id===did):null,discounted=dis?chosenBase*dis.pricing.multiplier:chosenBase;
      const sp=collectSpecials($('#parcelSpecials'),D.spDom.rates,{weight:actualKg*1000,destination:null,mailType:'PARCEL',serviceId:'DOMESTIC_ORDINARY_PARCEL'},{serviceCapabilities:parcelIndex.serviceCapabilities});
      const total=discounted+sp.sum, destinationName=provinces.find(x=>x.id===d)?.shortNameZh||d;
      const comparisons=volumetric?`<div class="weight-compare"><div class="weight-card ${actual.fee>=volumetric.fee?'higher':''}"><span>实重资费</span><strong>${money(actual.fee)}</strong><small>${actualKg.toFixed(3)} kg</small></div><div class="weight-card ${volumetric.fee>=actual.fee?'higher':''}"><span>泡重资费</span><strong>${money(volumetric.fee)}</strong><small>${volumetric.kg.toFixed(3)} kg</small></div></div>`:'';
      const lines=[{label:'采用的基础寄递资费',value:money(chosenBase)}];
      if(dis) lines.push({label:`${dis.nameZh}（仅基础资费${Math.round(dis.pricing.multiplier*10)}折）`,value:`-${money(chosenBase-discounted)}`});
      lines.push(...sp.lines);
      $('#parcelResult').innerHTML=`${comparisons}<div class="price">${money(total)}</div><div class="meta">${esc(actual.file.originNameZh)} → ${esc(destinationName)} · 实重 ${actualKg}kg</div><div class="breakdown">${lines.map(x=>`<div class="line"><span>${esc(x.label)}</span><strong>${esc(x.value)}</strong></div>`).join('')}</div>${sp.notes.map(n=>`<div class="condition-note">${esc(n)}</div>`).join('')}<div class="condition-note">回执/保价等特别业务费不参与8折/7折。</div>`;
    }catch(e){warn($('#parcelResult'),e.message)}
  };
}

function serviceForIntl(){ return services.find(s=>s.scope==='international'&&s.mailType===$('#intlMailType').value&&s.transport===$('#intlTransport').value); }
async function destinationsForService(s){
  const z=await j(s.zoneFile),set=new Map();
  for(const zone of z.zones){ for(const c of zone.countries||[]) set.set(c,{id:c,name:cName(c)}); for(const p of zone.postalDestinations||[]){customNames.set(p.id,p.nameZh);set.set(p.id,{id:p.id,name:p.nameZh});} }
  if(z.zones.some(x=>x.isDefault)) for(const x of intlCatalog) set.set(x.id,x);
  return [...set.values()];
}
function searchHay(item){ return [item.name,item.id,...(aliases[item.id]||[])].join(' ').toLowerCase(); }
async function showDestSuggestions(){
  const q=$('#intlDestInput').value.trim().toLowerCase(),box=$('#intlDestSuggestions'); if(!q){box.classList.add('hidden');box.innerHTML='';return;}
  const s=serviceForIntl(); if(!s)return; const allowed=await destinationsForService(s);
  const matches=allowed.filter(x=>searchHay(x).includes(q)).sort((a,b)=>{const ae=(aliases[a.id]||[]).some(v=>v.toLowerCase()===q)||a.id.toLowerCase()===q||a.name.toLowerCase()===q;const be=(aliases[b.id]||[]).some(v=>v.toLowerCase()===q)||b.id.toLowerCase()===q||b.name.toLowerCase()===q;return Number(be)-Number(ae)||a.name.localeCompare(b.name,'zh-CN')}).slice(0,20);
  box.innerHTML=matches.length?matches.map(x=>`<button type="button" data-dest="${esc(x.id)}"><span>${esc(x.name)}</span><small>${esc(x.id)}${x.id==='GB'?' / UK':''}</small></button>`).join(''):'<div class="no-suggestion">没有匹配的目的地</div>';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-dest]').forEach(b=>b.onclick=()=>{intlDestination=b.dataset.dest;$('#intlDestInput').value=`${cName(intlDestination)} (${intlDestination})`;box.classList.add('hidden');refreshIntlSpecials();});
}
async function buildIntlCatalog(){
  const map=new Map();
  for(const s of services.filter(x=>x.scope==='international')){
    const z=await j(s.zoneFile); for(const zone of z.zones){for(const c of zone.countries||[])map.set(c,{id:c,name:cName(c)});for(const p of zone.postalDestinations||[]){customNames.set(p.id,p.nameZh);map.set(p.id,{id:p.id,name:p.nameZh});}}
  }
  intlCatalog=[...map.values()];
}
function syncIntlTransport(){
  const m=$('#intlMailType').value,available=[...new Set(services.filter(s=>s.scope==='international'&&s.mailType===m).map(s=>s.transport))];
  const old=$('#intlTransport').value; $('#intlTransport').innerHTML=available.map(t=>`<option value="${t}">${trans[t]}</option>`).join(''); if(available.includes(old))$('#intlTransport').value=old;
  syncIntlService();
}
async function syncIntlService(){
  const s=serviceForIntl(); if(!s)return; intlDestination=null; $('#intlDestInput').value=''; $('#intlDestSuggestions').classList.add('hidden');
  $('#intlWeightWrap').classList.toggle('hidden',['POSTCARD','AEROGRAMME'].includes(s.mailType)); refreshIntlSpecials();
}
function refreshIntlSpecials(){ const s=serviceForIntl(); if(!s)return; renderSpecials($('#intlSpecials'),D.spIntl.rates,{destination:intlDestination,mailType:s.mailType,serviceId:s.id}); updateNotice('international',intlDestination); }
function syncHmt(){ const m=$('#hmtMail').value,p=D.hmt.mailTypes[m],s=services.find(x=>x.scope==='hong-kong-macau-taiwan'&&x.mailType===m); if(!p||!s)return; $('#hmtWeightWrap').classList.toggle('hidden',!needsWeight(p.pricingType)); renderSpecials($('#intlSpecials'),D.spHmt.rates,{destination:$('#hmtDest').value,mailType:m,serviceId:s.id}); updateNotice('hong-kong-macau-taiwan',$('#hmtDest').value); }
function updateNotice(scope,d){ const a=(D.spNotices.notices||[]).filter(n=>n.enabled&&n.scope?.rateScope===scope&&(n.scope.destination==null||n.scope.destination===d)),el=$('#intlNotice');el.classList.toggle('hidden',!a.length);el.innerHTML=a.map(n=>`<strong>${esc(n.title)}</strong><br>${esc(n.message)}`).join('<hr>'); }
function zoneFor(z,d){ return z.zones.find(x=>(x.countries||[]).includes(d)||(x.postalDestinations||[]).some(p=>p.id===d))||z.zones.find(x=>x.isDefault); }

async function resolveTypedDestination(){
  if(intlDestination)return intlDestination; const q=$('#intlDestInput').value.trim().toLowerCase(); if(!q)return null;
  const s=serviceForIntl(),allowed=await destinationsForService(s),exact=allowed.filter(x=>x.id.toLowerCase()===q||x.name.toLowerCase()===q||(aliases[x.id]||[]).some(a=>a.toLowerCase()===q));
  if(exact.length===1){intlDestination=exact[0].id;return intlDestination;} return null;
}

async function calcInternational(){
  try{
    const s=serviceForIntl(),d=await resolveTypedDestination(); if(!d)throw new Error('请先从目的地联想结果中选择一个国家或地区');
    const w=Number($('#intlWeight').value),z=await j(s.zoneFile),zone=zoneFor(z,d); if(!zone)throw new Error('该业务未找到此目的地的资费分组');
    const rf=await j(s.rateFile); let p;
    if(s.mailType==='LETTER') p=rf.rates.find(x=>x.zoneId===zone.id)?.pricing;
    else if(rf.mailTypes){ p=rf.mailTypes[s.mailType]; if(p?.zones)p={...p,...p.zones[zone.id]}; }
    else if(rf.ratesByMailType){ const m=rf.ratesByMailType[s.mailType]; p=m?.pricing || m?.zones?.[zone.id]; }
    if(!p)throw new Error('该业务在此目的地暂无资费');
    const base=calc(p,w),sp=collectSpecials($('#intlSpecials'),D.spIntl.rates,{weight:w,destination:d,mailType:s.mailType,serviceId:s.id}),total=base+sp.sum;
    out($('#intlResult'),total,`${trans[s.transport]} · ${names[s.mailType]} · ${esc(cName(d))} · ${esc(zone.nameZh||zone.id)}${needsWeight(ptype(p))?` · ${w}g`:''}`,[{label:'基础寄递资费',value:money(base)},...sp.lines],sp.notes);
  }catch(e){warn($('#intlResult'),e.message)}
}
function calcHmt(){
  try{
    const m=$('#hmtMail').value,p=D.hmt.mailTypes[m],d=$('#hmtDest').value,s=services.find(x=>x.scope==='hong-kong-macau-taiwan'&&x.mailType===m),w=Number($('#hmtWeight').value),base=calc(p,w),sp=collectSpecials($('#intlSpecials'),D.spHmt.rates,{weight:w,destination:d,mailType:m,serviceId:s.id}),name={HK:'香港',MO:'澳门',TW:'台湾'}[d];
    out($('#intlResult'),base+sp.sum,`${name} · ${names[m]}${needsWeight(p.pricingType)?` · ${w}g`:''}`,[{label:'基础寄递资费',value:money(base)},...sp.lines],sp.notes);
  }catch(e){warn($('#intlResult'),e.message)}
}

async function setupIntl(){
  await buildIntlCatalog();
  const mail=[...new Set(services.filter(s=>s.scope==='international').map(s=>s.mailType))];
  $('#intlMailType').innerHTML=mail.map(m=>`<option value="${m}">${names[m]}</option>`).join('');
  $('#intlMailType').onchange=syncIntlTransport; $('#intlTransport').onchange=syncIntlService;
  $('#intlDestInput').oninput=()=>{intlDestination=null;clearTimeout(intlDestTimer);intlDestTimer=setTimeout(showDestSuggestions,1000);};
  $('#intlDestInput').onfocus=()=>{if($('#intlDestInput').value.trim())showDestSuggestions();};
  document.addEventListener('click',e=>{if(!e.target.closest('.autocomplete'))$('#intlDestSuggestions').classList.add('hidden');});
  syncIntlTransport();
  $('#hmtMail').innerHTML=Object.keys(D.hmt.mailTypes).map(m=>`<option value="${m}">${names[m]}</option>`).join(''); $('#hmtMail').onchange=syncHmt; $('#hmtDest').onchange=syncHmt; syncHmt();
  $$('.scope').forEach(b=>b.onclick=()=>{$$('.scope').forEach(x=>x.classList.remove('active'));b.classList.add('active');intlScope=b.dataset.scope;$('#intlFields').classList.toggle('hidden',intlScope!=='international');$('#hmtFields').classList.toggle('hidden',intlScope!=='hmt');$('#intlResult').innerHTML='';intlScope==='international'?refreshIntlSpecials():syncHmt();});
  $('#calcIntl').onclick=()=>intlScope==='hmt'?calcHmt():calcInternational();
}

async function init(){
  try{
    const idx=await j('./postage/index.json'); $('#version').textContent=`数据规范 ${idx.standardVersion}`;
    const reg=await j('./postage/services.json'); services=reg.services;
    [D.basic,provinces,parcelIndex,D.hometown,D.hmt,D.spDom,D.spIntl,D.spHmt,D.spNotices]=await Promise.all([
      j('./postage/rates/domestic/basic.json'),j('./postage/domestic/provinces.json').then(x=>x.regions),j('./postage/rates/domestic/ordinary-parcel/index.json'),j('./postage/rates/domestic/hometown-parcel-sticker.json'),j('./postage/rates/hong-kong-macau-taiwan/basic.json'),j('./postage/special-rates/domestic.json'),j('./postage/special-rates/international.json'),j('./postage/special-rates/hong-kong-macau-taiwan.json'),j('./postage/special-rates/notices.json')
    ]);
    setupTabs(); setupDomestic(); setupParcel(); await setupIntl();
  }catch(e){document.body.innerHTML=`<main><div class="card"><h2>数据加载失败</h2><p>${esc(e.message)}</p></div></main>`}
}
init();
