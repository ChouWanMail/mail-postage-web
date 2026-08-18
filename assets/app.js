const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let D = {}, services = [], provinces = [], parcelIndex = {}, parcelMethod = 'ordinary', intlScope = 'international';
let intlDestination = null, intlDestinationList = [], intlSearchTimer = null;

const names = {
  LETTER:'信函', POSTCARD:'明信片', AEROGRAMME:'航空邮简', PRINTED_MATTER:'印刷品',
  LETTER_SHEET:'邮简', MILITARY_FREE_LETTER:'义务兵免费信函', LITERATURE_FOR_BLIND:'盲人读物',
  SMALL_PACKET:'小包', PRINTED_MATTER_BAG:'印刷品专袋', PARCEL:'包裹'
};
const trans = { AIR:'航空', SAL:'空运水陆路（SAL）', SURFACE:'水陆路' };
const customNames = new Map();
const aliasToCode = new Map([['UK','GB']]);

async function j(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

const money = n => `¥ ${Number(n).toFixed(2)}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ptype = p => p?.type || p?.pricingType;
const needsWeight = t => !['flat','free','value_increment','value_increment_with_minimum','declared_value_percentage','external_rule'].includes(t);
const category = mailType => mailType === 'PARCEL' ? 'PARCEL' : 'LETTER_POST';

function countryName(code) {
  if (customNames.has(code)) return customNames.get(code);
  try { return new Intl.DisplayNames(['zh-CN'], {type:'region'}).of(code) || code; }
  catch { return code; }
}

function calcPricing(p, weight, declaredValue) {
  const t = ptype(p);
  if (t === 'flat') return p.price;
  if (t === 'free') return 0;
  if (t === 'base_plus_increment') {
    if (!(weight > 0)) throw new Error('请输入有效重量');
    return weight <= p.baseWeight ? p.basePrice : p.basePrice + Math.ceil((weight - p.baseWeight) / p.incrementWeight) * p.incrementPrice;
  }
  if (t === 'surcharge_per_increment' || t === 'air_surcharge_only') {
    if (!(weight > 0)) throw new Error('请输入有效重量');
    return Math.ceil(weight / p.incrementWeight) * p.incrementPrice;
  }
  if (t === 'weight_tiers') {
    if (!(weight > 0)) throw new Error('请输入有效重量');
    const tier = p.tiers.find(x =>
      (x.minWeight == null || weight >= x.minWeight) &&
      (x.minWeightExclusive == null || weight > x.minWeightExclusive) &&
      (x.maxWeight == null || weight <= x.maxWeight) &&
      (x.maxWeightExclusive == null || weight < x.maxWeightExclusive)
    );
    if (!tier) throw new Error('重量超出当前资费范围');
    return tier.price;
  }
  if (t === 'value_increment' || t === 'value_increment_with_minimum') {
    if (!(declaredValue > 0)) throw new Error('已选择保价，请输入有效保价金额');
    if (p.maximumInsuredValue != null && declaredValue > p.maximumInsuredValue) throw new Error(`保价金额不得超过 ${p.maximumInsuredValue} 元`);
    const raw = Math.ceil(declaredValue / p.valueIncrement) * p.incrementPrice;
    return t === 'value_increment_with_minimum' ? Math.max(p.minimumPrice, raw) : raw;
  }
  if (t === 'declared_value_percentage') {
    if (!(declaredValue > 0)) throw new Error('已选择保价，请输入有效保价金额');
    if (p.maximumInsuredValue != null && declaredValue > p.maximumInsuredValue) throw new Error(`保价金额不得超过 ${p.maximumInsuredValue} 元`);
    const raw = declaredValue * p.percentage;
    return p.minimumPrice == null ? raw : Math.max(p.minimumPrice, raw);
  }
  if (t === 'external_rule') throw new Error('该项目仅公示，不能自动计费');
  throw new Error(`暂不支持计费类型 ${t}`);
}

function tiered(p, weight, locality) {
  if (!(weight > 0) || weight > p.maxWeight) throw new Error('重量超出当前资费范围');
  let sum = 0;
  for (const x of p.tiers) {
    const hi = Math.min(weight, x.toWeight), lo = x.fromWeightExclusive;
    if (hi > lo) sum += Math.ceil((hi - lo) / x.incrementWeight) * x.prices[locality];
  }
  return sum;
}

function warn(el, msg) { el.innerHTML = `<div class="warn">${esc(msg)}</div>`; }
function out(el, total, meta, lines = [], notes = []) {
  el.innerHTML = `<div class="price">${money(total)}</div><div class="meta">${meta}</div>` +
    (lines.length ? `<div class="breakdown">${lines.map(x => `<div class="line"><span>${esc(x.label)}</span><strong>${esc(x.value)}</strong></div>`).join('')}</div>` : '') +
    notes.map(n => `<div class="condition-note">${esc(n)}</div>`).join('');
}

function applies(rate, ctx) {
  const { destination = null, mailType = null, serviceId = null } = ctx;
  if (rate.excludedServiceIds?.includes(serviceId)) return false;
  if (rate.applicableDestinations?.length && !rate.applicableDestinations.includes(destination)) return false;
  if (rate.excludedDestinations?.includes(destination)) return false;
  const selectors = [];
  if (rate.applicableCategories?.length) selectors.push(rate.applicableCategories.includes(category(mailType)));
  if (rate.applicableMailTypes?.length) selectors.push(rate.applicableMailTypes.includes(mailType));
  if (rate.applicableServiceIds?.length) selectors.push(rate.applicableServiceIds.includes(serviceId));
  if (selectors.length && !selectors.some(Boolean)) return false;
  return true;
}

function pricingLabel(rate) {
  const p = rate.pricing, t = ptype(p);
  if (t === 'flat') return money(p.price);
  if (t === 'free') return '免费';
  if (t === 'value_increment') return `每${p.valueIncrement}元或零数 ${money(p.incrementPrice)}`;
  if (t === 'value_increment_with_minimum') return `按保价金额，最低 ${money(p.minimumPrice)}`;
  if (t === 'declared_value_percentage') return `${(p.percentage * 100).toFixed(0)}%（最高保价 ${p.maximumInsuredValue ?? '—'} 元）`;
  if (t === 'surcharge_per_increment' || t === 'air_surcharge_only') return `每${p.incrementWeight}g或零数 ${money(p.incrementPrice)}`;
  if (t === 'external_rule') return p.ruleRefZh || '按外部规则';
  return t || '—';
}

function serviceDependencySatisfied(rate, ctx) {
  const dep = rate.dependencies?.serviceSatisfiedBy?.[ctx.serviceId];
  if (!dep) return false;
  return !!ctx.capabilities?.[dep];
}

function specialInputHtml(rate) {
  const t = ptype(rate.pricing);
  if (!['value_increment','value_increment_with_minimum','declared_value_percentage'].includes(t)) return '';
  const max = rate.pricing.maximumInsuredValue ? ` max="${rate.pricing.maximumInsuredValue}"` : '';
  return `<div class="special-extra"><span>保价金额（元）</span><input type="number" min="0.01" step="0.01"${max} data-value-for="${esc(rate.id)}" disabled></div>`;
}

function renderSpecials(el, rates, ctx) {
  const applicable = rates.filter(r => applies(r, ctx));
  const selectable = applicable.filter(r => r.selection?.mode !== 'display-only');
  const displayOnly = applicable.filter(r => r.selection?.mode === 'display-only');

  const selectableHtml = selectable.map(r => {
    const disabled = !!r.conditions?.length;
    return `<div class="special-row" data-row-id="${esc(r.id)}">
      <div class="special-main">
        <input type="checkbox" data-rate-id="${esc(r.id)}" ${disabled ? 'disabled' : ''}>
        <label>${esc(r.nameZh)}</label><span class="special-price">${esc(pricingLabel(r))}</span>
      </div>${specialInputHtml(r)}
      ${r.noteZh ? `<div class="condition-note">${esc(r.noteZh)}</div>` : ''}
    </div>`;
  }).join('');

  const publicHtml = displayOnly.length ? `<div class="public-only-group"><div class="public-only-title">仅公示</div>${displayOnly.map(r => `
    <div class="special-row public-only-row">
      <div class="special-main"><span class="public-badge">仅公示</span><label>${esc(r.nameZh)}</label><span class="special-price">${esc(pricingLabel(r))}</span></div>
      ${r.noteZh ? `<div class="condition-note">${esc(r.noteZh)}</div>` : ''}
    </div>`).join('')}</div>` : '';

  el.innerHTML = selectableHtml + publicHtml || '<p class="hint">当前业务暂无特别业务。</p>';
  el._specialRates = applicable;
  el._specialCtx = ctx;
  el.querySelectorAll('[data-rate-id]').forEach(box => box.addEventListener('change', () => handleSpecialChange(el, box.dataset.rateId, box.checked)));
}

function checkbox(el, id) { return el.querySelector(`[data-rate-id="${CSS.escape(id)}"]`); }
function selectedIds(el) { return new Set([...el.querySelectorAll('[data-rate-id]:checked')].map(x => x.dataset.rateId)); }

function setChecked(el, id, checked) {
  const box = checkbox(el, id);
  if (!box) return false;
  box.checked = checked;
  const valueInput = el.querySelector(`[data-value-for="${CSS.escape(id)}"]`);
  if (valueInput) valueInput.disabled = !checked;
  return true;
}

function selectWithDependencies(el, id, stack = new Set()) {
  if (stack.has(id)) return;
  stack.add(id);
  const rates = el._specialRates || [], map = new Map(rates.map(r => [r.id, r]));
  const rate = map.get(id), box = checkbox(el, id);
  if (!rate || !box) return;
  box.checked = true;
  const val = el.querySelector(`[data-value-for="${CSS.escape(id)}"]`); if (val) val.disabled = false;

  for (const excluded of rate.dependencies?.excludesRateIds || []) unselectCascade(el, excluded);
  for (const req of rate.dependencies?.requiresRateIds || []) selectWithDependencies(el, req, stack);

  if (!serviceDependencySatisfied(rate, el._specialCtx || {})) {
    const any = rate.dependencies?.requiresAnyRateIds || [];
    if (any.length) {
      const sel = selectedIds(el);
      if (!any.some(x => sel.has(x))) {
        const candidate = any.find(x => checkbox(el, x) && !checkbox(el, x).disabled);
        if (candidate) selectWithDependencies(el, candidate, stack);
      }
    }
  }

  for (const replaced of rate.dependencies?.replacesRateIds || []) {
    setChecked(el, replaced, false);
    cascadeInvalid(el);
  }
}

function dependencyValid(rate, el, sel) {
  if (serviceDependencySatisfied(rate, el._specialCtx || {})) return true;
  const all = rate.dependencies?.requiresRateIds || [];
  if (all.some(x => !sel.has(x))) return false;
  const any = rate.dependencies?.requiresAnyRateIds || [];
  if (any.length && !any.some(x => sel.has(x))) return false;
  return true;
}

function cascadeInvalid(el) {
  const rates = el._specialRates || [], map = new Map(rates.map(r => [r.id, r]));
  let changed = true;
  while (changed) {
    changed = false;
    const sel = selectedIds(el);
    for (const id of [...sel]) {
      const rate = map.get(id);
      if (!rate) continue;
      if (!dependencyValid(rate, el, sel)) {
        setChecked(el, id, false);
        changed = true;
      }
    }
  }
  updateSpecialLocks(el);
}

function unselectCascade(el, id) {
  setChecked(el, id, false);
  cascadeInvalid(el);
}

function updateSpecialLocks(el) {
  const rates = el._specialRates || [], map = new Map(rates.map(r => [r.id, r])), sel = selectedIds(el);
  const replaced = new Set();
  for (const id of sel) for (const x of map.get(id)?.dependencies?.replacesRateIds || []) replaced.add(x);
  el.querySelectorAll('[data-rate-id]').forEach(box => {
    const rate = map.get(box.dataset.rateId);
    const baseDisabled = !!rate?.conditions?.length;
    box.disabled = baseDisabled || replaced.has(box.dataset.rateId);
    if (replaced.has(box.dataset.rateId)) setChecked(el, box.dataset.rateId, false);
  });
}

function handleSpecialChange(el, id, checked) {
  if (checked) selectWithDependencies(el, id);
  else unselectCascade(el, id);
  cascadeInvalid(el);
  updateSpecialLocks(el);
}

function collectSpecials(el, weight) {
  const rates = el._specialRates || [], map = new Map(rates.map(r => [r.id, r])), sel = selectedIds(el);
  const included = new Set();
  for (const id of sel) for (const x of map.get(id)?.dependencies?.includesRateIds || []) included.add(x);
  let total = 0; const lines = [], notes = [];
  for (const id of sel) {
    if (included.has(id)) continue;
    const r = map.get(id); if (!r) continue;
    const input = el.querySelector(`[data-value-for="${CSS.escape(id)}"]`);
    const value = input ? Number(input.value) : null;
    const amount = calcPricing(r.pricing, weight, value);
    total += amount; lines.push({label:r.nameZh, value:money(amount)});
  }
  if (sel.has('INSURED_LETTER_HANDLING_FEE')) notes.push('保价函件手续费已包含挂号费，未重复计收挂号费。');
  return { total, lines, notes };
}

function setupTabs() {
  $$('.tab').forEach(b => b.onclick = () => {
    $$('.tab').forEach(x => x.classList.remove('active')); $$('.page').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); $('#' + b.dataset.page).classList.add('active');
  });
  $$('.subtab').forEach(b => b.onclick = () => {
    $$('.subtab').forEach(x => x.classList.remove('active')); $$('#domestic .panel').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); $('#' + b.dataset.panel).classList.add('active');
  });
}

function domesticServiceForMail(mailType) { return services.find(s => s.scope === 'domestic' && s.mailType === mailType && s.mailType !== 'PARCEL'); }

function setupDomestic() {
  const list = services.filter(s => s.scope === 'domestic' && s.mailType !== 'PARCEL');
  $('#domMail').innerHTML = list.map(s => `<option value="${s.mailType}">${esc(names[s.mailType] || s.mailType)}</option>`).join('');
  $('#domMail').onchange = syncDomestic; syncDomestic();
  $('#calcDomestic').onclick = () => {
    try {
      const mailType = $('#domMail').value, p = D.basic.mailTypes[mailType], weight = Number($('#domWeight').value), loc = $('#domLocality').value;
      const base = p.pricingType === 'tiered_incremental' ? tiered(p, weight, loc) : p.pricingType === 'flat_by_locality' ? p.prices[loc] : calcPricing(p, weight);
      const sp = collectSpecials($('#domSpecials'), weight);
      const meta = [names[mailType], ['tiered_incremental','flat_by_locality'].includes(p.pricingType) ? (loc === 'LOCAL' ? '本埠' : '外埠') : '', needsWeight(p.pricingType) ? `${weight}g` : ''].filter(Boolean).join(' · ');
      out($('#domResult'), base + sp.total, esc(meta), [{label:'基础寄递资费', value:money(base)}, ...sp.lines], sp.notes);
    } catch (e) { warn($('#domResult'), e.message); }
  };
}

function syncDomestic() {
  const mailType = $('#domMail').value, p = D.basic.mailTypes[mailType], s = domesticServiceForMail(mailType);
  if (!p || !s) return;
  $('#domLocalityWrap').classList.toggle('hidden', !['tiered_incremental','flat_by_locality'].includes(p.pricingType));
  $('#domWeightWrap').classList.toggle('hidden', !needsWeight(p.pricingType));
  renderSpecials($('#domSpecials'), D.spDom.rates, {serviceId:s.id, mailType, capabilities:{}});
  $('#domResult').innerHTML = '';
}

function parcelRateForWeight(file, destination, weightG) {
  if (!(weightG > 0) || weightG > 50000) throw new Error('普通包裹计费重量须大于0且不超过50kg');
  const band = parcelIndex.weightBands.find(x => weightG > x.minWeightExclusive && weightG <= x.maxWeight);
  const group = file.routeGroups.find(x => x.destinations.includes(destination));
  if (!band || !group) throw new Error('该路向/重量暂无普通包裹资费');
  const p = group.prices[band.id];
  return weightG <= band.baseWeight ? p.basePrice : p.basePrice + Math.ceil((weightG - band.baseWeight) / band.incrementWeight) * p.incrementPrice;
}

function renderParcelSpecials() {
  const ordinary = parcelMethod === 'ordinary';
  const serviceId = ordinary ? 'DOMESTIC_ORDINARY_PARCEL' : 'DOMESTIC_HOMETOWN_PARCEL_STICKER';
  const capabilities = ordinary ? parcelIndex.serviceCapabilities : D.hometown.serviceCapabilities;
  renderSpecials($('#parcelSpecials'), D.spDom.rates, {serviceId, mailType:'PARCEL', capabilities});
}

function setupParcel() {
  const populated = Object.keys(parcelIndex.originFiles);
  $('#parcelOrigin').innerHTML = populated.map(id => `<option value="${id}">${esc(provinces.find(x => x.id === id)?.shortNameZh || id)}</option>`).join('');
  $('#parcelDest').innerHTML = provinces.map(x => `<option value="${x.id}">${esc(x.shortNameZh)}</option>`).join('');
  $('#parcelDiscount').innerHTML += parcelIndex.discounts.credentials.map(x => `<option value="${x.id}">${esc(x.nameZh)}（${Math.round(x.pricing.multiplier * 10)}折）</option>`).join('');
  renderParcelSpecials();

  $$('.method').forEach(b => b.onclick = () => {
    $$('.method').forEach(x => x.classList.remove('active')); b.classList.add('active'); parcelMethod = b.dataset.method;
    $('#ordinaryFields').classList.toggle('hidden', parcelMethod !== 'ordinary'); $('#hometownFields').classList.toggle('hidden', parcelMethod !== 'hometown');
    $('#parcelRuleHint').textContent = parcelMethod === 'ordinary'
      ? '普通包裹基础资费已含挂号；可保价、可回执且二者不冲突。优惠只打基础寄递费，保价/回执费不打折。'
      : '家乡包裹贴可保价（保价金额1%，最高10万元），不可回执；不适用普通包裹优惠和泡重规则。';
    renderParcelSpecials(); $('#parcelResult').innerHTML = '';
  });

  $('#calcParcel').onclick = async () => {
    try {
      if (parcelMethod === 'hometown') {
        const weightG = Number($('#hometownWeight').value) * 1000;
        const base = calcPricing(D.hometown, weightG);
        const sp = collectSpecials($('#parcelSpecials'), weightG);
        return out($('#parcelResult'), base + sp.total, `家乡包裹贴 · ${weightG/1000}kg`, [{label:'基础寄递资费', value:money(base)}, ...sp.lines], sp.notes);
      }

      const origin = $('#parcelOrigin').value, destination = $('#parcelDest').value, actualKg = Number($('#parcelWeight').value);
      if (!(actualKg > 0)) throw new Error('请输入有效实际重量');
      const path = parcelIndex.originFiles[origin]; if (!path) throw new Error('该起寄省暂无资费数据');
      const file = await j(`./postage/rates/domestic/ordinary-parcel/${path.replace('./','')}`);
      const actualBase = parcelRateForWeight(file, destination, actualKg * 1000);
      const L = Number($('#parcelLength').value), W = Number($('#parcelWidth').value), H = Number($('#parcelHeight').value);
      const dimsEntered = [L,W,H].some(x => Number.isFinite(x) && x > 0);
      const dimsComplete = [L,W,H].every(x => Number.isFinite(x) && x > 0);
      if (dimsEntered && !dimsComplete) throw new Error('体积尺寸请完整填写长、宽、高，或全部留空');

      let volumetricKg = null, volumetricBase = null, chosenBase = actualBase;
      if (dimsComplete) {
        volumetricKg = L * W * H / parcelIndex.volumetricWeight.divisor;
        volumetricBase = parcelRateForWeight(file, destination, volumetricKg * 1000);
        chosenBase = Math.max(actualBase, volumetricBase);
      }

      const discountId = $('#parcelDiscount').value;
      let discountedBase = chosenBase, discountLine = null;
      if (discountId) {
        const dis = parcelIndex.discounts.credentials.find(x => x.id === discountId);
        discountedBase = chosenBase * dis.pricing.multiplier;
        discountLine = {label:`${dis.nameZh}（${Math.round(dis.pricing.multiplier*10)}折，仅基础寄递费）`, value:`-${money(chosenBase - discountedBase)}`};
      }
      const sp = collectSpecials($('#parcelSpecials'), actualKg * 1000);
      const lines = [];
      if (dimsComplete) {
        lines.push({label:`实际重量资费 ${actualKg.toFixed(3)}kg${actualBase >= volumetricBase ? '（较高/采用）' : ''}`, value:money(actualBase)});
        lines.push({label:`泡重资费 ${volumetricKg.toFixed(3)}kg${volumetricBase > actualBase ? '（较高/采用）' : ''}`, value:money(volumetricBase)});
      } else lines.push({label:'普通包裹基础资费', value:money(actualBase)});
      if (discountLine) lines.push(discountLine);
      lines.push(...sp.lines);
      const total = discountedBase + sp.total;
      out($('#parcelResult'), total, `${esc(file.originNameZh)} → ${esc(provinces.find(x => x.id === destination)?.shortNameZh || destination)}`, lines, ['保价费、回执费等特别业务费按原价另加，不参与8折/7折。', ...sp.notes]);
    } catch (e) { warn($('#parcelResult'), e.message); }
  };
}

function currentIntlService() {
  const mailType = $('#intlMailType').value, transport = $('#intlTransport').value;
  return services.find(s => s.scope === 'international' && s.mailType === mailType && s.transport === transport);
}

function setupIntlSelectors() {
  const ints = services.filter(s => s.scope === 'international');
  const mailTypes = [...new Set(ints.map(s => s.mailType))];
  $('#intlMailType').innerHTML = mailTypes.map(m => `<option value="${m}">${esc(names[m] || m)}</option>`).join('');
  $('#intlMailType').onchange = syncIntlTransport;
  $('#intlTransport').onchange = syncIntlService;
  syncIntlTransport();
}

function syncIntlTransport() {
  const mailType = $('#intlMailType').value;
  const transports = services.filter(s => s.scope === 'international' && s.mailType === mailType).map(s => s.transport);
  $('#intlTransport').innerHTML = [...new Set(transports)].map(t => `<option value="${t}">${esc(trans[t] || t)}</option>`).join('');
  syncIntlService();
}

async function buildDestinationList(service) {
  if (!service) return [];
  const z = await j(service.zoneFile), items = [];
  for (const zone of z.zones) {
    for (const c of zone.countries || []) items.push({id:c, name:countryName(c)});
    for (const p of zone.postalDestinations || []) { customNames.set(p.id, p.nameZh); items.push({id:p.id, name:p.nameZh}); }
  }
  if (z.zones.some(x => x.isDefault)) {
    const master = await j('./postage/zones/air-other-mail.json');
    for (const zone of master.zones) for (const c of zone.countries || []) items.push({id:c, name:countryName(c)});
  }
  return [...new Map(items.map(x => [x.id, x])).values()].sort((a,b) => a.name.localeCompare(b.name, 'zh-CN'));
}

async function syncIntlService() {
  const s = currentIntlService(); if (!s) return;
  intlDestination = null; $('#intlDestInput').value = ''; $('#intlDestSuggestions').classList.add('hidden');
  intlDestinationList = await buildDestinationList(s);
  $('#intlWeightWrap').classList.toggle('hidden', ['POSTCARD','AEROGRAMME'].includes(s.mailType));
  renderSpecials($('#intlSpecials'), D.spIntl.rates, {serviceId:s.id, mailType:s.mailType, destination:null, capabilities:{}});
  $('#intlResult').innerHTML = '';
}

function showDestSuggestions(query) {
  const q = query.trim();
  const box = $('#intlDestSuggestions');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const upper = q.toUpperCase(), alias = aliasToCode.get(upper);
  const matches = intlDestinationList.filter(x => x.name.includes(q) || x.id.toUpperCase().includes(upper) || (alias && x.id === alias)).slice(0, 20);
  box.innerHTML = matches.length ? matches.map(x => `<button type="button" data-dest="${esc(x.id)}"><span>${esc(x.name)}</span><small>${esc(x.id)}</small></button>`).join('') : '<div class="no-suggestion">没有匹配目的地</div>';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-dest]').forEach(b => b.onclick = () => {
    const id = b.dataset.dest, item = intlDestinationList.find(x => x.id === id);
    intlDestination = id; $('#intlDestInput').value = `${item?.name || countryName(id)} (${id})`; box.classList.add('hidden'); refreshIntlSpecials();
  });
}

function refreshIntlSpecials() {
  const s = currentIntlService(); if (!s) return;
  renderSpecials($('#intlSpecials'), D.spIntl.rates, {serviceId:s.id, mailType:s.mailType, destination:intlDestination, capabilities:{}});
  updateNotice('international', intlDestination);
}

function setupDestinationSearch() {
  $('#intlDestInput').addEventListener('input', e => {
    intlDestination = null;
    clearTimeout(intlSearchTimer);
    intlSearchTimer = setTimeout(() => showDestSuggestions(e.target.value), 1000);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.autocomplete')) $('#intlDestSuggestions').classList.add('hidden'); });
}

function zoneFor(z, destination) {
  return z.zones.find(x => (x.countries || []).includes(destination) || (x.postalDestinations || []).some(p => p.id === destination)) || z.zones.find(x => x.isDefault);
}

async function intlPricing(service, destination) {
  const z = await j(service.zoneFile), zone = zoneFor(z, destination); if (!zone) throw new Error('该业务未找到此目的地的资费分组');
  const rf = await j(service.rateFile); let p;
  if (service.mailType === 'LETTER') p = rf.rates.find(x => x.zoneId === zone.id)?.pricing;
  else if (rf.mailTypes) {
    p = rf.mailTypes[service.mailType];
    if (p?.zones) p = {...p, ...p.zones[zone.id]};
  } else if (rf.ratesByMailType) {
    const m = rf.ratesByMailType[service.mailType]; p = m?.pricing || m?.zones?.[zone.id];
  }
  if (!p) throw new Error('该业务在此目的地暂无资费');
  return {p, zone};
}

function updateNotice(scope, destination) {
  const el = $('#intlNotice');
  const matches = (D.spNotices.notices || []).filter(n => n.enabled && n.scope?.rateScope === scope && (n.scope.destination == null || n.scope.destination === destination));
  el.classList.toggle('hidden', !matches.length);
  el.innerHTML = matches.map(n => `<strong>${esc(n.title)}</strong><br>${esc(n.message)}`).join('<hr>');
}

function syncHmt() {
  const mailType = $('#hmtMail').value, p = D.hmt.mailTypes[mailType], destination = $('#hmtDest').value;
  if (!p) return;
  $('#hmtWeightWrap').classList.toggle('hidden', !needsWeight(p.pricingType));
  const service = services.find(s => s.scope === 'hong-kong-macau-taiwan' && s.mailType === mailType);
  renderSpecials($('#intlSpecials'), D.spHmt.rates, {serviceId:service?.id, mailType, destination, capabilities:{}});
  updateNotice('hong-kong-macau-taiwan', destination);
  $('#intlResult').innerHTML = '';
}

async function setupIntl() {
  setupIntlSelectors(); setupDestinationSearch();
  $('#hmtMail').innerHTML = Object.keys(D.hmt.mailTypes).map(m => `<option value="${m}">${esc(names[m] || m)}</option>`).join('');
  $('#hmtMail').onchange = syncHmt; $('#hmtDest').onchange = syncHmt; syncHmt();
  $$('.scope').forEach(b => b.onclick = () => {
    $$('.scope').forEach(x => x.classList.remove('active')); b.classList.add('active'); intlScope = b.dataset.scope;
    $('#intlFields').classList.toggle('hidden', intlScope !== 'international'); $('#hmtFields').classList.toggle('hidden', intlScope !== 'hmt');
    $('#intlResult').innerHTML = ''; if (intlScope === 'international') refreshIntlSpecials(); else syncHmt();
  });
  $('#calcIntl').onclick = () => intlScope === 'hmt' ? calcHmt() : calcInternational();
}

async function calcInternational() {
  try {
    const s = currentIntlService(); if (!s) throw new Error('请选择有效的邮件种类和运输方式');
    if (!intlDestination) throw new Error('请从目的地联想结果中选择一个国家/地区');
    const weight = Number($('#intlWeight').value), {p, zone} = await intlPricing(s, intlDestination);
    const base = calcPricing(p, weight), sp = collectSpecials($('#intlSpecials'), weight);
    const meta = `${trans[s.transport]} · ${names[s.mailType]} · ${countryName(intlDestination)} · ${zone.nameZh || zone.id}${needsWeight(ptype(p)) ? ` · ${weight}g` : ''}`;
    out($('#intlResult'), base + sp.total, esc(meta), [{label:'基础寄递资费', value:money(base)}, ...sp.lines], sp.notes);
  } catch (e) { warn($('#intlResult'), e.message); }
}

function calcHmt() {
  try {
    const mailType = $('#hmtMail').value, p = D.hmt.mailTypes[mailType], weight = Number($('#hmtWeight').value), destination = $('#hmtDest').value;
    const base = calcPricing(p, weight), sp = collectSpecials($('#intlSpecials'), weight);
    const destName = {HK:'香港', MO:'澳门', TW:'台湾'}[destination];
    const meta = `${destName} · ${names[mailType]}${needsWeight(p.pricingType) ? ` · ${weight}g` : ''}`;
    out($('#intlResult'), base + sp.total, esc(meta), [{label:'基础寄递资费', value:money(base)}, ...sp.lines], sp.notes);
  } catch (e) { warn($('#intlResult'), e.message); }
}

async function init() {
  try {
    const [idx, svc, basic, prov, parcel, hometown, hmt, spDom, spIntl, spHmt, spNotices] = await Promise.all([
      j('./postage/index.json'), j('./postage/services.json'), j('./postage/rates/domestic/basic.json'), j('./postage/domestic/provinces.json'),
      j('./postage/rates/domestic/ordinary-parcel/index.json'), j('./postage/rates/domestic/hometown-parcel-sticker.json'), j('./postage/rates/hong-kong-macau-taiwan/basic.json'),
      j('./postage/special-rates/domestic.json'), j('./postage/special-rates/international.json'), j('./postage/special-rates/hong-kong-macau-taiwan.json'), j('./postage/special-rates/notices.json')
    ]);
    D = {idx, basic, hometown, hmt, spDom, spIntl, spHmt, spNotices}; services = svc.services; provinces = prov.regions; parcelIndex = parcel;
    $('#version').textContent = `数据规范 ${idx.standardVersion}`;
    setupTabs(); setupDomestic(); setupParcel(); await setupIntl();
  } catch (e) {
    console.error(e); $('#version').textContent = '数据读取失败';
  }
}

init();
