const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let D = {};
let services = [];
let mailTypes = [];
let provinces = [];
let parcelIndex = {};
let parcelMethod = 'ordinary';
let intlScope = 'international';

const mailNames = {
  LETTER: '信函', POSTCARD: '明信片', AEROGRAMME: '航空邮简', PRINTED_MATTER: '印刷品',
  LETTER_SHEET: '邮简', MILITARY_FREE_LETTER: '义务兵免费信函', LITERATURE_FOR_BLIND: '盲人读物',
  SMALL_PACKET: '小包', PRINTED_MATTER_BAG: '印刷品专袋', PARCEL: '包裹'
};
const transportNames = { AIR: '航空', SAL: '空运水陆路（SAL）', SURFACE: '水陆路' };
const customDestinationNames = new Map();

async function j(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
const money = (n) => `¥ ${Number(n).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function countryName(code) {
  if (customDestinationNames.has(code)) return customDestinationNames.get(code);
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) || code; }
  catch { return code; }
}

function pricingType(p) { return p?.type || p?.pricingType || null; }
function needsWeight(type) {
  return !['flat', 'free', 'value_increment', 'value_increment_with_minimum', 'external_rule'].includes(type);
}

function calcBase(p, weight, declaredValue = null) {
  const type = pricingType(p);
  if (type === 'flat') return p.price;
  if (type === 'free') return 0;
  if (type === 'base_plus_increment') {
    if (!(weight > 0)) throw new Error('请输入有效重量');
    if (weight <= p.baseWeight) return p.basePrice;
    return p.basePrice + Math.ceil((weight - p.baseWeight) / p.incrementWeight) * p.incrementPrice;
  }
  if (type === 'surcharge_per_increment' || type === 'air_surcharge_only') {
    if (!(weight > 0)) throw new Error('请输入有效重量');
    return Math.ceil(weight / p.incrementWeight) * p.incrementPrice;
  }
  if (type === 'weight_tiers') {
    if (!(weight > 0)) throw new Error('请输入有效重量');
    const tier = p.tiers.find((x) =>
      (x.minWeight == null || weight >= x.minWeight) &&
      (x.minWeightExclusive == null || weight > x.minWeightExclusive) &&
      (x.maxWeight == null || weight <= x.maxWeight) &&
      (x.maxWeightExclusive == null || weight < x.maxWeightExclusive)
    );
    if (!tier) throw new Error('重量超出当前资费范围');
    return tier.price;
  }
  if (type === 'value_increment' || type === 'value_increment_with_minimum') {
    if (!(declaredValue > 0)) throw new Error('已选择保价业务，请输入有效保价金额');
    if (p.maximumInsuredValue != null && declaredValue > p.maximumInsuredValue) {
      throw new Error(`保价金额不得超过 ${p.maximumInsuredValue} 元`);
    }
    const raw = Math.ceil(declaredValue / p.valueIncrement) * p.incrementPrice;
    return type === 'value_increment_with_minimum' ? Math.max(p.minimumPrice, raw) : raw;
  }
  throw new Error(`暂不支持计费类型 ${type}`);
}

function calcTieredIncremental(p, weight, locality) {
  if (!(weight > 0) || weight > p.maxWeight) throw new Error('重量超出当前资费范围');
  let total = 0;
  for (const tier of p.tiers) {
    const lo = tier.fromWeightExclusive;
    const hi = Math.min(weight, tier.toWeight);
    if (hi > lo) total += Math.ceil((hi - lo) / tier.incrementWeight) * tier.prices[locality];
  }
  return total;
}

function showBreakdown(el, total, meta, lines = [], notes = []) {
  const breakdown = lines.length ? `<div class="breakdown">${lines.map(x => `<div class="line"><span>${esc(x.label)}</span><strong>${esc(x.value)}</strong></div>`).join('')}</div>` : '';
  const noteHtml = notes.filter(Boolean).map(x => `<div class="condition-note">${esc(x)}</div>`).join('');
  el.innerHTML = `<div class="price">${money(total)}</div><div class="meta">${meta}</div>${breakdown}${noteHtml}`;
}
function warn(el, msg) { el.innerHTML = `<div class="warn">${esc(msg)}</div>`; }

function categoryForMailType(mailType) { return mailType === 'PARCEL' ? 'PARCEL' : 'LETTER_POST'; }

function rateApplies(rate, { destination, mailType }) {
  if (rate.applicableDestinations?.length && !rate.applicableDestinations.includes(destination)) return false;
  if (rate.excludedDestinations?.includes(destination)) return false;
  const hasCats = !!rate.applicableCategories?.length;
  const hasTypes = !!rate.applicableMailTypes?.length;
  if (hasCats || hasTypes) {
    const categoryMatch = hasCats && rate.applicableCategories.includes(categoryForMailType(mailType));
    const mailMatch = hasTypes && rate.applicableMailTypes.includes(mailType);
    if (!categoryMatch && !mailMatch) return false;
  }
  return true;
}

function specialPriceLabel(rate) {
  const p = rate.pricing;
  const type = pricingType(p);
  if (type === 'flat') return money(p.price);
  if (type === 'free') return '免费';
  if (type === 'value_increment') return `每 ${p.valueIncrement} 元或零数 +${money(p.incrementPrice)}`;
  if (type === 'value_increment_with_minimum') return `按保价金额计费，最低 ${money(p.minimumPrice)}`;
  if (type === 'surcharge_per_increment' || type === 'air_surcharge_only') return `每 ${p.incrementWeight}g 或零数 +${money(p.incrementPrice)}`;
  if (type === 'external_rule') return p.ruleRefZh || '按外部规则';
  return type || '—';
}

function renderSpecials(container, rates, context) {
  const bagHasSpecific = context.mailType === 'PRINTED_MATTER_BAG' && rates.some(r => r.id === 'PRINTED_MATTER_BAG_REGISTRATION_FEE');
  const rows = rates.filter(rate => {
    if (bagHasSpecific && rate.id === 'REGISTRATION_FEE') return false;
    return rateApplies(rate, context);
  }).map(rate => {
    const p = rate.pricing;
    const type = pricingType(p);
    const conditional = !!rate.conditions?.length;
    const external = type === 'external_rule';
    const disabled = conditional || external;
    const valueInput = ['value_increment','value_increment_with_minimum'].includes(type)
      ? `<div class="special-extra"><span>保价金额（元）</span><input type="number" min="0.01" step="0.01" data-value-for="${esc(rate.id)}" placeholder="请输入保价金额"></div>` : '';
    const conditionText = conditional ? `<div class="condition-note">需满足条件：${esc(rate.conditions.join(' / '))}；网页暂不自动计费。</div>` : '';
    const noteText = rate.noteZh ? `<div class="condition-note">${esc(rate.noteZh)}</div>` : '';
    return `<div class="special-row ${disabled ? 'special-disabled' : ''}">
      <div class="special-main">
        <input type="checkbox" id="sp-${esc(container.id)}-${esc(rate.id)}" data-rate-id="${esc(rate.id)}" ${disabled ? 'disabled' : ''}>
        <label for="sp-${esc(container.id)}-${esc(rate.id)}">${esc(rate.nameZh)}</label>
        <span class="special-price">${esc(specialPriceLabel(rate))}</span>
      </div>${valueInput}${conditionText}${noteText}
    </div>`;
  });
  container.innerHTML = rows.length ? rows.join('') : '<p class="hint">当前业务暂无可直接选择的特别业务。</p>';
}

function collectSpecials(container, rates, { weight, destination, mailType }) {
  const checked = [...container.querySelectorAll('input[type=checkbox][data-rate-id]:checked')];
  const selectedIds = new Set(checked.map(x => x.dataset.rateId));
  const lines = [];
  const notes = [];
  let total = 0;
  const handlingIncludesRegistration = selectedIds.has('INSURED_LETTER_HANDLING_FEE') && selectedIds.has('REGISTRATION_FEE');
  if (handlingIncludesRegistration) notes.push('保价函件手续费已包含挂号费，本次未重复计收挂号费。');
  for (const box of checked) {
    const id = box.dataset.rateId;
    if (handlingIncludesRegistration && id === 'REGISTRATION_FEE') continue;
    const rate = rates.find(r => r.id === id);
    if (!rate || !rateApplies(rate, { destination, mailType })) continue;
    const input = container.querySelector(`[data-value-for="${CSS.escape(id)}"]`);
    const declaredValue = input ? Number(input.value) : null;
    const amount = calcBase(rate.pricing, weight, declaredValue);
    total += amount;
    lines.push({ label: rate.nameZh, value: money(amount) });
  }
  return { total, lines, notes };
}

async function init() {
  try {
    const idx = await j('./postage/index.json');
    $('#version').textContent = `数据规范 ${idx.standardVersion}`;
    const registry = await j('./postage/services.json');
    services = registry.services;
    mailTypes = registry.mailTypes;
    [D.basic, provinces, parcelIndex, D.hometown, D.hmt, D.specialDomestic, D.specialIntl, D.specialHmt, D.specialNotices] = await Promise.all([
      j('./postage/rates/domestic/basic.json'),
      j('./postage/domestic/provinces.json').then(x => x.regions),
      j('./postage/rates/domestic/ordinary-parcel/index.json'),
      j('./postage/rates/domestic/hometown-parcel-sticker.json'),
      j('./postage/rates/hong-kong-macau-taiwan/basic.json'),
      j('./postage/special-rates/domestic.json'),
      j('./postage/special-rates/international.json'),
      j('./postage/special-rates/hong-kong-macau-taiwan.json'),
      j('./postage/special-rates/notices.json')
    ]);
    setupTabs(); setupDomestic(); setupParcel(); await setupIntl();
  } catch (e) {
    document.body.innerHTML = `<main><div class="card"><h2>数据加载失败</h2><p>${esc(e.message)}</p></div></main>`;
  }
}

function setupTabs() {
  $$('.tab').forEach(b => b.onclick = () => { $$('.tab').forEach(x => x.classList.remove('active')); $$('.page').forEach(x => x.classList.remove('active')); b.classList.add('active'); $('#' + b.dataset.page).classList.add('active'); });
  $$('.subtab').forEach(b => b.onclick = () => { $$('.subtab').forEach(x => x.classList.remove('active')); $$('#domestic .panel').forEach(x => x.classList.remove('active')); b.classList.add('active'); $('#' + b.dataset.panel).classList.add('active'); });
}

function setupDomestic() {
  const domesticServices = services.filter(s => s.scope === 'domestic' && s.mailType !== 'PARCEL');
  $('#domMail').innerHTML = domesticServices.map(s => `<option value="${s.mailType}">${esc(mailNames[s.mailType] || s.mailType)}</option>`).join('');
  $('#domMail').onchange = syncDom; syncDom();
  $('#calcDomestic').onclick = () => {
    try {
      const id = $('#domMail').value, p = D.basic.mailTypes[id], weight = Number($('#domWeight').value), locality = $('#domLocality').value;
      let base;
      if (p.pricingType === 'tiered_incremental') base = calcTieredIncremental(p, weight, locality);
      else if (p.pricingType === 'flat_by_locality') base = p.prices[locality];
      else base = calcBase(p, weight);
      const specials = collectSpecials($('#domSpecials'), D.specialDomestic.rates, { weight, destination: null, mailType: id });
      const total = base + specials.total;
      const localityText = p.sameForAllLocalities ? '全国统一' : ['tiered_incremental','flat_by_locality'].includes(p.pricingType) ? (locality === 'LOCAL' ? '本埠' : '外埠') : '';
      const meta = [mailNames[id], localityText, needsWeight(p.pricingType) ? `${weight}g` : ''].filter(Boolean).join(' · ');
      showBreakdown($('#domResult'), total, esc(meta), [{ label: '基础寄递资费', value: money(base) }, ...specials.lines], specials.notes);
    } catch (e) { warn($('#domResult'), e.message); }
  };
}
function syncDom() {
  const id = $('#domMail').value, p = D.basic.mailTypes[id]; if (!p) return;
  $('#domLocalityWrap').classList.toggle('hidden', !['tiered_incremental','flat_by_locality'].includes(p.pricingType));
  $('#domWeightWrap').classList.toggle('hidden', !needsWeight(p.pricingType));
  renderSpecials($('#domSpecials'), D.specialDomestic.rates, { destination: null, mailType: id }); $('#domResult').innerHTML = '';
}

function setupParcel() {
  const populated = Object.keys(parcelIndex.originFiles);
  $('#parcelOrigin').innerHTML = populated.map(id => `<option value="${id}">${esc(provinces.find(x => x.id === id)?.shortNameZh || id)}</option>`).join('');
  $('#parcelDest').innerHTML = provinces.map(x => `<option value="${x.id}">${esc(x.shortNameZh)}</option>`).join('');
  $('#parcelDiscount').innerHTML += parcelIndex.discounts.credentials.map(x => `<option value="${x.id}">${esc(x.nameZh)}（${Math.round(x.pricing.multiplier * 10)}折）</option>`).join('');
  $$('.method').forEach(b => b.onclick = () => { $$('.method').forEach(x => x.classList.remove('active')); b.classList.add('active'); parcelMethod = b.dataset.method; $('#ordinaryFields').classList.toggle('hidden', parcelMethod !== 'ordinary'); $('#hometownFields').classList.toggle('hidden', parcelMethod !== 'hometown'); $('#parcelRuleHint').textContent = parcelMethod === 'ordinary' ? '普通包裹优惠一次只能使用一种，不得叠加，也不得用于家乡包裹贴。' : '家乡包裹贴按全国统一重量档计费，不适用普通包裹任何证件/优惠卡折扣。'; $('#parcelResult').innerHTML = ''; });
  $('#calcParcel').onclick = async () => {
    try {
      if (parcelMethod === 'hometown') { const weight = Number($('#hometownWeight').value) * 1000, total = calcBase(D.hometown, weight); return showBreakdown($('#parcelResult'), total, `家乡包裹贴 · ${weight / 1000}kg`, [{ label: '寄递资费', value: money(total) }], ['普通包裹优惠凭证不适用于家乡包裹贴。']); }
      const origin = $('#parcelOrigin').value, dest = $('#parcelDest').value, weight = Number($('#parcelWeight').value) * 1000;
      if (!(weight > 0) || weight > 50000) throw new Error('普通包裹重量须大于0且不超过50kg');
      const band = parcelIndex.weightBands.find(x => weight > x.minWeightExclusive && weight <= x.maxWeight); if (!band) throw new Error('没有匹配的重量档');
      const filePath = parcelIndex.originFiles[origin]; if (!filePath) throw new Error('该起寄省暂无普通包裹资费数据');
      const file = await j(`./postage/rates/domestic/ordinary-parcel/${filePath.replace('./','')}`), group = file.routeGroups.find(x => x.destinations.includes(dest)); if (!group) throw new Error('该起寄/寄达组合暂无资费');
      const p = group.prices[band.id], base = weight <= band.baseWeight ? p.basePrice : p.basePrice + Math.ceil((weight - band.baseWeight) / band.incrementWeight) * p.incrementPrice;
      const discountId = $('#parcelDiscount').value; let total = base; const lines = [{ label: '普通包裹基础资费', value: money(base) }];
      if (discountId) { const discount = parcelIndex.discounts.credentials.find(x => x.id === discountId); if (!discount || discount.status !== 'active') throw new Error('优惠凭证不可用'); total = base * discount.pricing.multiplier; lines.push({ label: `${discount.nameZh}（${Math.round(discount.pricing.multiplier * 10)}折）`, value: `-${money(base - total)}` }); }
      const destinationName = provinces.find(x => x.id === dest)?.shortNameZh || dest;
      showBreakdown($('#parcelResult'), total, `${esc(file.originNameZh)} → ${esc(destinationName)} · ${weight / 1000}kg`, lines, ['优惠凭证最多选择一种，不能叠加。']);
    } catch (e) { warn($('#parcelResult'), e.message); }
  };
}

async function setupIntl() {
  const intlServices = services.filter(x => x.scope === 'international');
  $('#intlService').innerHTML = intlServices.map(s => `<option value="${s.id}">${esc(transportNames[s.transport])} · ${esc(mailNames[s.mailType] || s.mailType)}</option>`).join('');
  $('#intlService').onchange = syncIntlService; $('#intlDest').onchange = refreshIntlSpecials; await syncIntlService();
  $('#hmtMail').innerHTML = Object.keys(D.hmt.mailTypes).map(id => `<option value="${id}">${esc(mailNames[id] || id)}</option>`).join('');
  $('#hmtMail').onchange = syncHmt; $('#hmtDest').onchange = syncHmt; syncHmt();
  $$('.scope').forEach(b => b.onclick = async () => { $$('.scope').forEach(x => x.classList.remove('active')); b.classList.add('active'); intlScope = b.dataset.scope; $('#intlFields').classList.toggle('hidden', intlScope !== 'international'); $('#hmtFields').classList.toggle('hidden', intlScope !== 'hmt'); $('#intlResult').innerHTML = ''; if (intlScope === 'international') refreshIntlSpecials(); else syncHmt(); });
  $('#calcIntl').onclick = () => intlScope === 'hmt' ? calcHmt() : calcInternational();
}

async function syncIntlService() {
  const s = services.find(x => x.id === $('#intlService').value); if (!s) return;
  const zoneFile = await j(s.zoneFile), items = [];
  for (const zone of zoneFile.zones) { for (const c of zone.countries || []) items.push({ id: c, name: countryName(c) }); for (const p of zone.postalDestinations || []) { customDestinationNames.set(p.id, p.nameZh); items.push({ id: p.id, name: p.nameZh }); } }
  if (zoneFile.zones.some(x => x.isDefault)) { const master = await j('./postage/zones/air-other-mail.json'); for (const zone of master.zones) for (const c of zone.countries || []) items.push({ id: c, name: countryName(c) }); }
  const unique = [...new Map(items.map(x => [x.id, x])).values()].sort((a,b) => a.name.localeCompare(b.name, 'zh-CN')), old = $('#intlDest').value;
  $('#intlDest').innerHTML = unique.map(x => `<option value="${x.id}">${esc(x.name)} (${esc(x.id)})</option>`).join(''); if (unique.some(x => x.id === old)) $('#intlDest').value = old;
  $('#intlWeightWrap').classList.toggle('hidden', ['POSTCARD','AEROGRAMME'].includes(s.mailType)); refreshIntlSpecials();
}
function refreshIntlSpecials() { const s = services.find(x => x.id === $('#intlService').value); if (!s) return; renderSpecials($('#intlSpecials'), D.specialIntl.rates, { destination: $('#intlDest').value, mailType: s.mailType }); updateIntlNotice('international', $('#intlDest').value); }
function syncHmt() { const mailType = $('#hmtMail').value, p = D.hmt.mailTypes[mailType]; if (!p) return; $('#hmtWeightWrap').classList.toggle('hidden', !needsWeight(p.pricingType)); const destination = $('#hmtDest').value; renderSpecials($('#intlSpecials'), D.specialHmt.rates, { destination, mailType }); updateIntlNotice('hong-kong-macau-taiwan', destination); $('#intlResult').innerHTML = ''; }
function updateIntlNotice(rateScope, destination) { const matches = (D.specialNotices.notices || []).filter(n => n.enabled && n.scope?.rateScope === rateScope && (n.scope.destination == null || n.scope.destination === destination)); const area = $('#intlNotice'); if (!matches.length) { area.classList.add('hidden'); area.innerHTML = ''; return; } area.classList.remove('hidden'); area.innerHTML = matches.map(n => `<strong>${esc(n.title)}</strong><br>${esc(n.message)}`).join('<hr>'); }
function findZone(zoneFile, destination) { return zoneFile.zones.find(x => (x.countries || []).includes(destination) || (x.postalDestinations || []).some(p => p.id === destination)) || zoneFile.zones.find(x => x.isDefault); }

async function calcInternational() {
  try {
    const s = services.find(x => x.id === $('#intlService').value), destination = $('#intlDest').value, weight = Number($('#intlWeight').value, zoneFile = await j(s.zoneFile));
    const zone = findZone(zoneFile, destination); if (!zone) throw new Error('该业务未找到此目的地的资费分组');
    const rateFile = await j(s.rateFile); let p;
    if (s.mailType === 'LETTER') p = rateFile.rates.find(x => x.zoneId === zone.id)?.pricing;
    else if (rateFile.mailTypes) { p = rateFile.mailTypes[s.mailType]; if (p?.zones) p = { ...p, ...p.zones[zone.id] }; }
    else if (rateFile.ratesByMailType) { const m = rateFile.ratesByMailType[s.mailType]; p = m?.pricing || m?.zones?.[zone.id]; }
    if (!p) throw new Error('该业务在此目的地暂无资费');
    const base = calcBase(p, weight), specials = collectSpecials($('#intlSpecials'), D.specialIntl.rates, { weight, destination, mailType: s.mailType }), total = base + specials.total;
    const meta = `${transportNames[s.transport]} · ${mailNames[s.mailType]} · ${countryName(destination)} · ${zone.nameZh || zone.id}${needsWeight(pricingType(p)) ? ` · ${weight}g` : ''}`;
    showBreakdown($('#intlResult'), total, esc(meta), [{ label: '基础寄递资费', value: money(base) }, ...specials.lines], specials.notes);
  } catch (e) { warn($('#intlResult'), e.message); }
}
function calcHmt() { try { const mailType = $('#hmtMail').value, p = D.hmt.mailTypes[mailType], weight = Number($('#hmtWeight').value), destination = $('#hmtDest').value, base = calcBase(p, weight), specials = collectSpecials($('#intlSpecials'), D.specialHmt.rates, { weight, destination, mailType }), total = base + specials.total, name = { HK:'香港', MO:'澳门', TW:'台湾' }[destination], meta = `${name} · ${mailNames[mailType]}${needsWeight(p.pricingType) ? ` · ${weight}g` : ''}`; showBreakdown($('#intlResult'), total, esc(meta), [{ label:'基础寄递资费', value:money(base) }, ...specials.lines], specials.notes); } catch (e) { warn($('#intlResult'), e.message); } }

init();
