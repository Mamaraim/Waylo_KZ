/* ===========================================================================
   НАСТРОЙКА: вставь свой anon-ключ (Supabase → Settings → API → anon public).
   anon-ключ публичный и безопасный для клиента — доступ к данным режет RLS.
   =========================================================================== */
const SUPABASE_URL = "https://rfxenahasipffiuommvx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmeGVuYWhhc2lwZmZpdW9tbXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDE3NTEsImV4cCI6MjA5NjcxNzc1MX0.4inQoQjNxBmpn_zsuJj6cdW283-kzTGB-TCj14G1KYw";

const app = document.getElementById('app');

if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.startsWith("ВСТАВЬ")) {
  app.innerHTML = `<div class="config-warn"><b>Нужен anon-ключ.</b><br>
    Открой Supabase → Settings → API, скопируй <code>anon public</code> и вставь его в этом файле
    в строку <code>const SUPABASE_ANON_KEY = "…"</code>. После этого обнови страницу.</div>`;
  throw new Error("anon key not set");
}

// Pass-through lock: некоторые расширения/браузеры блокируют navigator.locks,
// из-за чего supabase-js v2 зависает на getSession. Свой lock убирает зависание.
const passthroughLock = async (_name, _timeout, fn) => await fn();
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { lock: passthroughLock, persistSession: true, autoRefreshToken: true },
});

/* ── helpers ─────────────────────────────────────────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (v, cur = 'USD') => v == null ? '—' : new Intl.NumberFormat('ru-RU', { style:'currency', currency:cur, maximumFractionDigits:0 }).format(v);
const short = (id) => id ? String(id).slice(0, 8) : '—';
const STATUS = {
  draft:['gray','черновик'], submitted:['blue','отправлена'], confirmed:['green','подтверждена'],
  in_progress:['blue','в работе'], completed:['green','выполнена'], closed:['gray','закрыта'], cancelled:['red','отменена'],
  pending:['amber','ожидает'], rejected:['red','отклонена'], held:['amber','захолдировано'], released:['gray','освобождён'],
  expired:['gray','истёк'], issued:['blue','выставлен'], partially_paid:['amber','частично'], paid:['green','оплачен'],
  overdue:['red','просрочен'], accrued:['amber','начислено'], invoiced:['blue','в счёте'], settled:['green','погашено'],
  active:['green','активна'], suspended:['red','приостановлена'],
};
const badge = (status, label) => { const [c, l] = STATUS[status] || ['gray', status || '—']; return `<span class="badge badge--${c}">${esc(label || l)}</span>`; };
const typeBadge = (t) => t === 'HOTEL' ? `<span class="badge badge--accent">отель</span>` : `<span class="badge badge--amber">транспорт</span>`;

/* ── state ───────────────────────────────────────────────────────────────── */
let state = { user:null, contexts:[], isPlatform:false, activeKey:null, tab:null, openReq:null };

async function loadProfile() {
  const { data: mems } = await db.from('membership').select('role, org_id, organization(id,type,name,country)');
  const { data: plt } = await db.from('platform_operator').select('user_id');
  const platform = (plt || []).length > 0;
  const ctx = (mems || []).map(m => ({ key:m.org_id, kind:'org', orgId:m.org_id, orgType:m.organization?.type, orgName:m.organization?.name, role:m.role }));
  if (platform) ctx.unshift({ key:'platform', kind:'platform', orgName:'Waylo', orgType:'PLATFORM', role:'operator' });
  state.contexts = ctx; state.isPlatform = platform;
  if (!state.activeKey) state.activeKey = ctx[0]?.key || null;
}

async function boot() {
  let session = null;
  try {
    const res = await Promise.race([
      db.auth.getSession(),
      new Promise((resolve) => setTimeout(() => resolve({ data: { session: null } }), 4000)),
    ]);
    session = res?.data?.session || null;
  } catch (_) { session = null; }
  state.user = session?.user || null;
  if (state.user) { try { await loadProfile(); } catch (_) {} }
  render();
}
db.auth.onAuthStateChange(async (_e, session) => {
  state.user = session?.user || null;
  state.activeKey = null; state.tab = null; state.openReq = null;
  if (state.user) await loadProfile();
  render();
});

function render() { state.user ? renderShell() : renderLogin(); }

/* ── login ───────────────────────────────────────────────────────────────── */
function renderLogin() {
  const SEGMENTS = [
    { key:'agency',      label:'Travel Agency', sub:'Турагентства и DMC (Казахстан) — заявки, маршруты, документы, статусы.', email:'dmc@waylo.test' },
    { key:'hospitality', label:'Hospitality',   sub:'Отели и резорты — подтверждения, доступность, цены.',                 email:'hotel@waylo.test' },
    { key:'transfer',    label:'Transfer',      sub:'Перевозчики — автопарк, доступность, подтверждения.',                 email:'transfer@waylo.test' },
  ];
  let seg = SEGMENTS[0];
  app.innerHTML = `
    <div class="login-wrap"><form class="login-card" id="loginForm">
      <div class="brand">Waylo<span class="chev">›</span><span class="kz">KZ</span></div>
      <div class="tag">Операционный коридор · вход в кабинет</div>
      <div class="field"><label>Кто вы?</label>
        <select class="input" id="segSel" style="width:100%">${SEGMENTS.map(s => `<option value="${s.key}" ${s.key===seg.key?'selected':''}>${esc(s.label)}</option>`).join('')}</select>
      </div>
      <div class="seg-sub" id="segSub">${esc(seg.sub)}</div>
      <div class="field"><label>Почта</label><input type="email" id="email" autocomplete="username" placeholder="you@company.com" value="${seg.email}" required></div>
      <div class="field"><label>Пароль</label><input type="password" id="password" autocomplete="current-password" required></div>
      <div id="loginErr"></div>
      <button class="btn btn--primary" id="loginBtn">Войти</button>
      <div class="login-creds">Тест (пароль <code>waylo-test-pass</code>): <code id="segCred">${esc(seg.email)}</code></div>
      <div class="op-link">Оператор Waylo — <a id="opLink">platform@waylo.test</a></div>
    </form></div>`;
  const pick = (s) => {
    seg = s;
    $('#segSub').textContent = s.sub;
    $('#segCred').textContent = s.email;
    $('#email').value = s.email;
  };
  $('#segSel').onchange = () => pick(SEGMENTS.find(x => x.key === $('#segSel').value));
  $('#opLink').onclick = () => { $('#email').value = 'platform@waylo.test'; $('#segCred').textContent = 'platform@waylo.test'; };
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'Входим…';
    const fail = (msg) => { $('#loginErr').innerHTML = `<div class="notice notice--err">${esc(msg)}</div>`; btn.disabled = false; btn.textContent = 'Войти'; };
    try {
      const res = await Promise.race([
        db.auth.signInWithPassword({ email:$('#email').value, password:$('#password').value }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      if (res.error) fail(res.error.message);
      // успех → onAuthStateChange сам отрисует кабинет
    } catch (_) {
      fail('Сервер не отвечает. Похоже, расширение браузера (щит/адблок) блокирует подключение к Supabase — отключите его для этого сайта и войдите снова.');
    }
  };
}

/* ── shell ───────────────────────────────────────────────────────────────── */
function renderShell() {
  const active = state.contexts.find(c => c.key === state.activeKey);
  const roleLabel = { superadmin:'суперадмин', admin:'админ', operator:'оператор' };
  app.innerHTML = `
    <div class="topbar">
      <div class="brand">Waylo<span class="chev">›</span><span class="kz">KZ</span></div>
      <div class="spacer"></div>
      ${state.contexts.length ? `<div class="switcher">
        <select id="orgSel">${state.contexts.map(c => `<option value="${c.key}" ${c.key===state.activeKey?'selected':''}>${esc(c.orgName)}${c.kind==='org'?` · ${c.orgType}`:''}</option>`).join('')}</select>
        ${active ? `<span class="role-chip">${roleLabel[active.role]||active.role}</span>` : ''}
      </div>` : ''}
      <span class="user-email">${esc(state.user?.email || '')}</span>
      <button class="linkbtn" id="logout">Выйти</button>
    </div>
    <div id="content"></div>`;
  const sel = $('#orgSel');
  if (sel) sel.onchange = () => { state.activeKey = sel.value; state.tab = null; state.openReq = null; renderShell(); };
  $('#logout').onclick = () => db.auth.signOut();
  renderCabinet();
}

function renderCabinet() {
  const active = state.contexts.find(c => c.key === state.activeKey);
  if (!active) { $('#content').innerHTML = `<div class="center-state">Нет доступных организаций для этого аккаунта.</div>`; return; }
  if (active.kind === 'platform') return renderPlatform();
  if (active.orgType === 'DMC') return renderDmc(active);
  if (active.orgType === 'HOTEL') return renderHotel(active);
  if (active.orgType === 'TRANSPORT') return renderTransport(active);
  $('#content').innerHTML = `<div class="center-state">Неизвестный тип организации: ${esc(active.orgType)}</div>`;
}

function navShell(kicker, tabs) {
  $('#content').innerHTML = `
    <div class="shell">
      <nav class="nav"><div class="kicker">${esc(kicker)}</div>
        ${tabs.map(t => `<button data-tab="${t.id}" class="${state.tab===t.id?'active':''}">${esc(t.label)}</button>`).join('')}
      </nav>
      <main class="main" id="main"><div class="center-state">Загрузка…</div></main>
    </div>`;
  document.querySelectorAll('.nav button[data-tab]').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; state.openReq = null; renderCabinet(); });
}

/* ── DMC ─────────────────────────────────────────────────────────────────── */
async function renderDmc(active) {
  if (!state.tab) state.tab = 'catalog';
  navShell('DMC · ' + active.orgName, [{ id:'catalog', label:'Каталог' }, { id:'requests', label:'Заявки' }]);
  state.tab === 'catalog' ? dmcCatalog() : dmcRequests(active);
}

async function dmcCatalog() {
  const [{ data: props }, { data: types }, { data: rates, error }, { data: vcs }, { data: trates }] = await Promise.all([
    db.from('property').select('id,name,city,kind,star_category').eq('is_active', true),
    db.from('room_type').select('id,property_id,name'),
    db.from('room_rate_public').select('room_type_id,sell_price,sgl_supplement,currency,valid_from,valid_to'),
    db.from('vehicle_class').select('id,name,pax_min,pax_max'),
    db.from('transport_rate_public').select('vehicle_class_id,basis,sell_price_per_unit,currency,valid_from,valid_to'),
  ]);
  const main = $('#main'); if (!main) return;
  if (error) { main.innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; return; }
  const pById = Object.fromEntries((props || []).map(p => [p.id, p]));
  const tById = Object.fromEntries((types || []).map(t => [t.id, t]));
  const rows = (rates || []).map(r => { const t = tById[r.room_type_id]; const p = t && pById[t.property_id]; return p ? { ...r, room:t.name, property:p.name, city:p.city, kind:p.kind, star:p.star_category } : null; }).filter(Boolean);
  const vById = Object.fromEntries((vcs || []).map(v => [v.id, v]));
  const trows = (trates || []).map(r => { const v = vById[r.vehicle_class_id]; return v ? { ...r, vname:v.name, pax:`${v.pax_min}–${v.pax_max}` } : null; }).filter(Boolean);
  main.innerHTML = `
    <div class="page-head"><div><h1>Каталог</h1><div class="sub">Цена — к продаже. Контрактная себестоимость поставщика вам не видна.</div></div></div>
    <div class="card"><div class="card-head">Размещения</div>
    ${rows.length ? `<table><thead><tr><th>Объект</th><th>Город</th><th>Номер</th><th>Период</th><th style="text-align:right">Цена/ночь</th><th style="text-align:right">SGL</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(r.property)}${r.kind==='resort'?' <span class="badge badge--accent">резорт</span>':''}${r.star?` <span class="hint">· ${r.star}★</span>`:''}</td><td>${esc(r.city)}</td><td>${esc(r.room)}</td><td class="hint">${esc(r.valid_from)} — ${esc(r.valid_to)}</td><td class="price" style="text-align:right">${money(r.sell_price,r.currency)}</td><td class="mono" style="text-align:right">${money(r.sgl_supplement,r.currency)}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Пока нет активных тарифов.</div>`}</div>
    <div class="card"><div class="card-head">Трансферы</div>
    ${trows.length ? `<table><thead><tr><th>Класс машины</th><th>Pax</th><th>Тариф</th><th>Период</th><th style="text-align:right">Цена</th></tr></thead><tbody>
      ${trows.map(r => `<tr><td>${esc(r.vname)}</td><td class="mono">${esc(r.pax)}</td><td class="hint">${r.basis==='per_transfer'?'за трансфер':'за день'}</td><td class="hint">${esc(r.valid_from)} — ${esc(r.valid_to)}</td><td class="price" style="text-align:right">${money(r.sell_price_per_unit,r.currency)}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Пока нет трансферов.</div>`}</div>`;
}

async function dmcRequests(active) {
  const main = $('#main'); if (!main) return;
  const { data: reqs, error } = await db.from('request').select('id,travel_date,pax_count,status,created_at').order('created_at', { ascending:false });
  if (error) { main.innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; return; }
  main.innerHTML = `
    <div class="page-head"><div><h1>Заявки</h1><div class="sub">Создание заявок, блоки услуг и холды доступности.</div></div>
      <button class="btn btn--primary" id="newReq">Новая заявка</button></div>
    <div class="card">
      ${reqs.length ? `<table><thead><tr><th>Заявка</th><th>Дата поездки</th><th>Туристов</th><th>Статус</th><th></th></tr></thead><tbody>
        ${reqs.map(r => `<tr><td class="id-cell">${short(r.id)}</td><td>${esc(r.travel_date||'—')}</td><td class="mono">${r.pax_count??'—'}</td><td>${badge(r.status)}</td><td style="text-align:right"><button class="btn btn--ghost btn--sm openReq" data-id="${r.id}">${state.openReq===r.id?'Скрыть':'Открыть'}</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="card-empty">Заявок пока нет — создайте первую.</div>`}
    </div><div id="reqDetail"></div>`;
  $('#newReq').onclick = async () => {
    const { data, error } = await db.from('request').insert({ dmc_org_id:active.orgId, status:'draft', pax_count:2 }).select().single();
    if (error) { alert(error.message); return; }
    state.openReq = data.id; dmcRequests(active);
  };
  document.querySelectorAll('.openReq').forEach(b => b.onclick = () => { state.openReq = state.openReq === b.dataset.id ? null : b.dataset.id; dmcRequests(active); });
  if (state.openReq) renderReqDetail(active, state.openReq);
}

async function renderReqDetail(active, reqId) {
  const box = $('#reqDetail'); if (!box) return;
  const { data: lines } = await db.from('request_line').select('*').eq('request_id', reqId).order('created_at');
  let holdsBy = {};
  if ((lines || []).length) {
    const { data: hs } = await db.from('hold').select('*').in('request_line_id', lines.map(l => l.id));
    (hs || []).forEach(h => { (holdsBy[h.request_line_id] ||= []).push(h); });
  }
  box.innerHTML = `
    <div class="card">
      <div class="card-head">Блоки услуг <span id="addLineSlot"></span></div>
      <div id="lineMsg"></div>
      ${(lines||[]).length ? `<table><thead><tr><th>Тип</th><th>Ресурс</th><th>Период</th><th>Кол-во</th><th>Цена</th><th>Подтв.</th><th>Холд</th><th></th></tr></thead><tbody>
        ${lines.map(l => { const hs = holdsBy[l.id]||[]; const act = hs.filter(h => ['held','confirmed'].includes(h.status)); return `<tr><td>${typeBadge(l.type)}</td><td class="id-cell">${short(l.resource_id)}</td><td class="hint">${esc(l.from_date)} — ${esc(l.to_date)}</td><td class="mono">${l.quantity}</td><td class="price">${money(l.sell_price)}</td><td>${badge(l.confirmation)}</td><td>${act.length?badge(act[0].status):'<span class="hint">нет</span>'}</td><td style="text-align:right">${!act.length?`<button class="btn btn--ghost btn--sm holdBtn" data-id="${l.id}">Захолдить</button>`:''}</td></tr>`; }).join('')}
      </tbody></table>` : `<div class="card-empty">Добавьте блок из каталога.</div>`}
    </div>`;
  document.querySelectorAll('.holdBtn').forEach(b => b.onclick = async () => {
    const l = lines.find(x => x.id === b.dataset.id);
    const { error } = await db.rpc('place_hold', { p_request_line:l.id, p_resource_type:l.type==='HOTEL'?'room':'vehicle', p_resource_id:l.resource_id, p_from:l.from_date, p_to:l.to_date, p_quantity:l.quantity, p_idempotency_key:crypto.randomUUID() });
    if (error) $('#lineMsg').innerHTML = `<div class="notice notice--err" style="margin:10px 14px">${esc(error.message)}</div>`;
    else renderReqDetail(active, reqId);
  });
  renderAddLine(reqId, () => renderReqDetail(active, reqId));
}

function renderAddLine(reqId, onAdded) {
  const slot = $('#addLineSlot'); if (!slot) return;
  slot.innerHTML = `<button class="btn btn--ghost btn--sm" id="addHotelBtn">+ Отель</button> <button class="btn btn--ghost btn--sm" id="addTransferBtn">+ Трансфер</button>`;
  $('#addHotelBtn').onclick = async () => {
    const [{ data: props }, { data: types }, { data: rates }] = await Promise.all([
      db.from('property').select('id,name,org_id').eq('is_active', true),
      db.from('room_type').select('id,property_id,name'),
      db.from('room_rate_public').select('room_type_id,sell_price,currency'),
    ]);
    const pById = Object.fromEntries((props || []).map(p => [p.id, p]));
    const rateBy = Object.fromEntries((rates || []).map(r => [r.room_type_id, r]));
    const opts = (types || []).map(t => { const p = pById[t.property_id]; const r = rateBy[t.id]; return p && r ? { id:t.id, label:`${p.name} · ${t.name}`, supplier:p.org_id, sell:r.sell_price, currency:r.currency } : null; }).filter(Boolean);
    lineForm('HOTEL', opts, reqId, onAdded);
  };
  $('#addTransferBtn').onclick = async () => {
    const [{ data: vcs }, { data: rates }] = await Promise.all([
      db.from('vehicle_class').select('id,name,org_id,pax_min,pax_max'),
      db.from('transport_rate_public').select('vehicle_class_id,sell_price_per_unit,currency'),
    ]);
    const vById = Object.fromEntries((vcs || []).map(v => [v.id, v]));
    const opts = (rates || []).map(r => { const v = vById[r.vehicle_class_id]; return v ? { id:v.id, label:`${v.name} (${v.pax_min}–${v.pax_max} pax)`, supplier:v.org_id, sell:r.sell_price_per_unit, currency:r.currency } : null; }).filter(Boolean);
    lineForm('TRANSPORT', opts, reqId, onAdded);
  };
}

function lineForm(type, opts, reqId, onAdded) {
  const isHotel = type === 'HOTEL';
  const form = $('#lineMsg');
  const dateFields = isHotel
    ? `<div class="field"><label>Заезд</label><input type="date" id="lfFrom"></div><div class="field"><label>Выезд</label><input type="date" id="lfTo"></div>`
    : `<div class="field"><label>Дата</label><input type="date" id="lfDate"></div>`;
  form.innerHTML = `<div class="row" style="margin:10px 14px">
    <div class="field" style="min-width:240px"><label>${isHotel ? 'Номер' : 'Класс машины'}</label><select class="input" id="lfRes"><option value="">— выбрать —</option>${opts.map(o => `<option value="${o.id}">${esc(o.label)} (${money(o.sell,o.currency)})</option>`).join('')}</select></div>
    ${dateFields}
    <div class="field" style="width:90px"><label>${isHotel ? 'Номеров' : 'Машин'}</label><input type="number" min="1" value="1" id="lfQty"></div>
    <button class="btn btn--primary btn--sm" id="lfSave">Добавить</button>
    <button class="btn btn--ghost btn--sm" id="lfCancel">Отмена</button></div>`;
  $('#lfCancel').onclick = () => { form.innerHTML = ''; };
  $('#lfSave').onclick = async () => {
    const o = opts.find(x => x.id === $('#lfRes').value);
    let from, to;
    if (isHotel) { from = $('#lfFrom').value; to = $('#lfTo').value; }
    else { from = $('#lfDate').value; if (from) { const d = new Date(from); d.setDate(d.getDate() + 1); to = d.toISOString().slice(0, 10); } }
    const qty = Number($('#lfQty').value || 1);
    if (!o || !from || !to) { form.innerHTML = `<div class="notice notice--err" style="margin:10px 14px">Заполните поля.</div>`; return; }
    const { error } = await db.from('request_line').insert({ request_id:reqId, supplier_org_id:o.supplier, type, resource_id:o.id, from_date:from, to_date:to, quantity:qty, sell_price:o.sell, confirmation:'pending' });
    if (error) { form.innerHTML = `<div class="notice notice--err" style="margin:10px 14px">${esc(error.message)}</div>`; return; }
    onAdded();
  };
}

/* ── HOTEL ───────────────────────────────────────────────────────────────── */
async function renderHotel(active) {
  if (!state.tab) state.tab = 'confirm';
  navShell('Отель · ' + active.orgName, [{ id:'confirm', label:'Подтверждения' }, { id:'avail', label:'Доступность' }, { id:'finance', label:'Финансы' }]);
  if (state.tab === 'confirm') supplierConfirm(active, 'отель');
  else if (state.tab === 'avail') hotelAvail(active);
  else hotelFinance(active);
}

async function supplierConfirm(active, word) {
  const main = $('#main'); if (!main) return;
  const { data: lines } = await db.from('request_line').select('*').eq('supplier_org_id', active.orgId).order('created_at', { ascending:false });
  const pending = (lines || []).filter(l => l.confirmation === 'pending');
  const confirmed = (lines || []).filter(l => l.confirmation === 'confirmed');
  main.innerHTML = `
    <div class="page-head"><div><h1>Подтверждения</h1><div class="sub">Запросы от DMC на ваши услуги. Подтверждение фиксирует холд${word==='отель'?' и начисляет спред':''}.</div></div></div>
    <div class="stat-row"><div class="stat"><div class="n">${pending.length}</div><div class="l">ждут подтверждения</div></div><div class="stat"><div class="n">${confirmed.length}</div><div class="l">подтверждено</div></div></div>
    <div id="cMsg"></div>
    <div class="card"><div class="card-head">Линии заявок</div>
    ${(lines||[]).length ? `<table><thead><tr><th>Линия</th><th>Ресурс</th><th>Период</th><th>Кол-во</th><th>Цена</th><th>Статус</th><th></th></tr></thead><tbody>
      ${lines.map(l => `<tr><td class="id-cell">${short(l.id)}</td><td class="id-cell">${short(l.resource_id)}</td><td class="hint">${esc(l.from_date)} — ${esc(l.to_date)}</td><td class="mono">${l.quantity}</td><td class="price">${money(l.sell_price)}</td><td>${badge(l.confirmation)}</td><td style="text-align:right">${l.confirmation==='pending'?`<button class="btn btn--primary btn--sm confirmBtn" data-id="${l.id}">Подтвердить</button>`:''}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Пока нет запросов на ваши услуги.</div>`}</div>`;
  document.querySelectorAll('.confirmBtn').forEach(b => b.onclick = async () => {
    const { error } = await db.rpc('confirm_hold', { p_request_line:b.dataset.id });
    if (error) $('#cMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`;
    else supplierConfirm(active, word);
  });
}

async function hotelAvail(active) {
  const main = $('#main'); if (!main) return;
  const { data: props } = await db.from('property').select('id,name').eq('org_id', active.orgId);
  const ids = (props || []).map(p => p.id);
  const { data: ts } = ids.length ? await db.from('room_type').select('id,name,property_id').in('property_id', ids) : { data: [] };
  const pById = Object.fromEntries((props || []).map(p => [p.id, p.name]));
  const types = (ts || []).map(t => ({ id:t.id, label:`${pById[t.property_id]} · ${t.name}` }));
  const tIds = types.map(t => t.id);
  const { data: al } = tIds.length ? await db.from('room_allotment').select('*').in('room_type_id', tIds).order('day') : { data: [] };
  const tLabel = Object.fromEntries(types.map(t => [t.id, t.label]));
  main.innerHTML = `
    <div class="page-head"><div><h1>Доступность</h1><div class="sub">Сколько номеров каждого типа выделено под Waylo по датам.</div></div></div>
    <div class="card"><div class="card-head">Добавить / обновить</div><div style="padding:14px">
      <div class="row">
        <div class="field" style="min-width:240px"><label>Номер</label><select class="input" id="avRt"><option value="">— выбрать —</option>${types.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Дата</label><input type="date" id="avDay"></div>
        <div class="field" style="width:90px"><label>Кол-во</label><input type="number" min="0" value="1" id="avQty"></div>
        <button class="btn btn--primary btn--sm" id="avSave">Сохранить</button>
      </div><div id="avMsg"></div></div></div>
    <div class="card"><div class="card-head">Текущий аллотмент</div>
    ${(al||[]).length ? `<table><thead><tr><th>Номер</th><th>Дата</th><th style="text-align:right">Кол-во</th></tr></thead><tbody>
      ${al.map(a => `<tr><td>${esc(tLabel[a.room_type_id])}</td><td class="hint">${esc(a.day)}</td><td class="mono" style="text-align:right">${a.quantity}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Аллотмент не задан.</div>`}</div>`;
  $('#avSave').onclick = async () => {
    const rt = $('#avRt').value, day = $('#avDay').value, qty = Number($('#avQty').value || 0);
    if (!rt || !day) { $('#avMsg').innerHTML = `<div class="notice notice--err">Выберите номер и дату.</div>`; return; }
    const { error } = await db.from('room_allotment').upsert({ room_type_id:rt, day, quantity:qty }, { onConflict:'room_type_id,day' });
    if (error) $('#avMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`;
    else hotelAvail(active);
  };
}

async function hotelFinance(active) {
  const main = $('#main'); if (!main) return;
  const { data: ac } = await db.from('commission_accrual').select('*').eq('supplier_org_id', active.orgId).order('accrued_at', { ascending:false });
  const { data: inv } = await db.from('invoice').select('*').order('issued_at', { ascending:false });
  const total = (ac || []).filter(a => a.status === 'accrued').reduce((s, a) => s + Number(a.amount), 0);
  main.innerHTML = `
    <div class="page-head"><div><h1>Финансы</h1><div class="sub">Начисленный спред Waylo по подтверждённым линиям и счета.</div></div></div>
    <div class="stat-row"><div class="stat"><div class="n">${money(total)}</div><div class="l">спред к выставлению</div></div><div class="stat"><div class="n">${(ac||[]).length}</div><div class="l">начислений всего</div></div></div>
    <div class="card"><div class="card-head">Начисления спреда</div>
    ${(ac||[]).length ? `<table><thead><tr><th>Линия</th><th>Сумма</th><th>Статус</th><th>Начислено</th></tr></thead><tbody>
      ${ac.map(a => `<tr><td class="id-cell">${short(a.request_line_id)}</td><td class="price">${money(a.amount,a.currency)}</td><td>${badge(a.status)}</td><td class="hint">${new Date(a.accrued_at).toLocaleDateString('ru-RU')}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Пока нет — подтвердите линию во вкладке «Подтверждения».</div>`}</div>
    <div class="card"><div class="card-head">Счета</div>
    ${(inv||[]).length ? `<table><thead><tr><th>Счёт</th><th>Тип</th><th>Сумма</th><th>Статус</th></tr></thead><tbody>
      ${inv.map(v => `<tr><td class="id-cell">${short(v.id)}</td><td>${badge(v.kind==='commission'?'invoiced':'issued', v.kind==='commission'?'комиссия':'бронь')}</td><td class="price">${money(v.amount,v.currency)}</td><td>${badge(v.status)}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Счетов пока нет.</div>`}</div>`;
}

/* ── TRANSPORT ───────────────────────────────────────────────────────────── */
async function renderTransport(active) {
  if (!state.tab) state.tab = 'fleet';
  navShell('Трансфер · ' + active.orgName, [{ id:'fleet', label:'Автопарк' }, { id:'avail', label:'Доступность' }, { id:'confirm', label:'Подтверждения' }, { id:'finance', label:'Финансы' }]);
  if (state.tab === 'fleet') transportFleet(active);
  else if (state.tab === 'avail') transportAvail(active);
  else if (state.tab === 'confirm') supplierConfirm(active, 'трансфер');
  else hotelFinance(active);
}

// Стандартная линейка классов (pax → тип машины)
const FLEET_TIERS = [
  { name:'Седан',                     pax_min:1,  pax_max:2  },
  { name:'Минивэн (Hyundai Staria)',  pax_min:3,  pax_max:4  },
  { name:'Вэн (Toyota Hiace)',        pax_min:5,  pax_max:8  },
  { name:'Мидибас 18 мест (Sprinter)',pax_min:9,  pax_max:12 },
  { name:'Автобус 30–50 мест',        pax_min:13, pax_max:50 },
];

async function transportFleet(active) {
  const main = $('#main'); if (!main) return;
  const { data: vcs } = await db.from('vehicle_class').select('id,name,pax_min,pax_max').eq('org_id', active.orgId).order('pax_min');
  const ids = (vcs || []).map(v => v.id);
  const { data: rates } = ids.length
    ? await db.from('transport_rate').select('vehicle_class_id,net_price_per_unit,sell_price_per_unit,currency').in('vehicle_class_id', ids)
    : { data: [] };
  const rByVc = Object.fromEntries((rates || []).map(r => [r.vehicle_class_id, r]));
  main.innerHTML = `
    <div class="page-head"><div><h1>Автопарк</h1><div class="sub">Добавьте классы машин и свою цену (net). DMC видит цену +10% — это комиссия Waylo.</div></div></div>
    <div class="card"><div class="card-head">Добавить класс</div><div style="padding:14px">
      <div class="row">
        <div class="field" style="min-width:280px"><label>Класс машины</label><select class="input" id="flTier">
          ${FLEET_TIERS.map((t,i) => `<option value="${i}">${esc(t.name)} · ${t.pax_min}–${t.pax_max} pax</option>`).join('')}
        </select></div>
        <div class="field" style="width:170px"><label>Ваша цена, $ (за трансфер)</label><input type="number" min="0" step="1" id="flNet" placeholder="напр. 40"></div>
        <button class="btn btn--primary btn--sm" id="flSave">Добавить</button>
      </div>
      <div class="hint" id="flCalc" style="margin-top:8px"></div>
      <div id="flMsg"></div>
    </div></div>
    <div class="card"><div class="card-head">Мой автопарк</div>
    ${(vcs||[]).length ? `<table><thead><tr><th>Класс</th><th>Pax</th><th style="text-align:right">Ваша цена (net)</th><th style="text-align:right">Цена DMC (sell)</th><th style="text-align:right">Комиссия Waylo</th><th></th></tr></thead><tbody>
      ${vcs.map(v => { const r = rByVc[v.id]; const net = r?.net_price_per_unit ?? null, sell = r?.sell_price_per_unit ?? null; const com = (net!=null && sell!=null) ? (sell - net) : null; return `<tr><td>${esc(v.name)}</td><td class="mono">${v.pax_min}–${v.pax_max}</td><td class="price" style="text-align:right">${money(net,r?.currency)}</td><td class="price" style="text-align:right">${money(sell,r?.currency)}</td><td class="mono" style="text-align:right">${money(com,r?.currency)}</td><td style="text-align:right"><button class="btn btn--ghost btn--sm flDel" data-id="${v.id}">Удалить</button></td></tr>`; }).join('')}
    </tbody></table>` : `<div class="card-empty">Автопарк пуст — добавьте класс выше.</div>`}</div>`;
  const calc = () => { const net = Number($('#flNet').value || 0); $('#flCalc').textContent = net > 0 ? `DMC увидит ${money(Math.round(net*1.1))}, комиссия Waylo ${money(Math.round(net*1.1)-net)} (10%).` : ''; };
  $('#flNet').oninput = calc;
  $('#flSave').onclick = async () => {
    const t = FLEET_TIERS[Number($('#flTier').value)]; const net = Number($('#flNet').value || 0);
    if (!t || net <= 0) { $('#flMsg').innerHTML = `<div class="notice notice--err">Укажите класс и цену.</div>`; return; }
    const { data: vc, error: e1 } = await db.from('vehicle_class').insert({ org_id:active.orgId, name:t.name, pax_min:t.pax_min, pax_max:t.pax_max }).select().single();
    if (e1) { $('#flMsg').innerHTML = `<div class="notice notice--err">${esc(e1.message)}</div>`; return; }
    const { error: e2 } = await db.from('transport_rate').insert({ vehicle_class_id:vc.id, basis:'per_transfer', valid_from:'2026-01-01', valid_to:'2030-12-31', net_price_per_unit:net, sell_price_per_unit:Math.round(net*1.1*100)/100, currency:'USD' });
    if (e2) { $('#flMsg').innerHTML = `<div class="notice notice--err">${esc(e2.message)}</div>`; return; }
    transportFleet(active);
  };
  document.querySelectorAll('.flDel').forEach(b => b.onclick = async () => {
    const { error } = await db.from('vehicle_class').delete().eq('id', b.dataset.id);
    if (error) $('#flMsg') && ($('#flMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`);
    else transportFleet(active);
  });
}

async function transportAvail(active) {
  const main = $('#main'); if (!main) return;
  const { data: vcs } = await db.from('vehicle_class').select('id,name,pax_min,pax_max').eq('org_id', active.orgId);
  const classes = (vcs || []).map(v => ({ id:v.id, label:`${v.name} (${v.pax_min}–${v.pax_max} pax)` }));
  const ids = classes.map(c => c.id);
  const { data: av } = ids.length ? await db.from('transport_availability').select('*').in('vehicle_class_id', ids).order('day') : { data: [] };
  const cLabel = Object.fromEntries(classes.map(c => [c.id, c.label]));
  main.innerHTML = `
    <div class="page-head"><div><h1>Доступность</h1><div class="sub">Сколько машин каждого класса выделено под Waylo по датам.</div></div></div>
    <div class="card"><div class="card-head">Добавить / обновить</div><div style="padding:14px">
      <div class="row">
        <div class="field" style="min-width:240px"><label>Класс машины</label><select class="input" id="tvVc"><option value="">— выбрать —</option>${classes.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Дата</label><input type="date" id="tvDay"></div>
        <div class="field" style="width:90px"><label>Машин</label><input type="number" min="0" value="1" id="tvUnits"></div>
        <button class="btn btn--primary btn--sm" id="tvSave">Сохранить</button>
      </div><div id="tvMsg"></div></div></div>
    <div class="card"><div class="card-head">Текущая доступность</div>
    ${(av||[]).length ? `<table><thead><tr><th>Класс</th><th>Дата</th><th style="text-align:right">Машин</th></tr></thead><tbody>
      ${av.map(a => `<tr><td>${esc(cLabel[a.vehicle_class_id])}</td><td class="hint">${esc(a.day)}</td><td class="mono" style="text-align:right">${a.units}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Доступность не задана.</div>`}</div>`;
  $('#tvSave').onclick = async () => {
    const vc = $('#tvVc').value, day = $('#tvDay').value, units = Number($('#tvUnits').value || 0);
    if (!vc || !day) { $('#tvMsg').innerHTML = `<div class="notice notice--err">Выберите класс и дату.</div>`; return; }
    const { error } = await db.from('transport_availability').upsert({ vehicle_class_id:vc, day, units }, { onConflict:'vehicle_class_id,day' });
    if (error) $('#tvMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`;
    else transportAvail(active);
  };
}

/* ── PLATFORM ────────────────────────────────────────────────────────────── */
const ORG_BADGE = { DMC:'blue', HOTEL:'green', TRANSPORT:'amber', PLATFORM:'accent' };
async function renderPlatform() {
  if (!state.tab) state.tab = 'orgs';
  navShell('Платформа · Waylo', [{ id:'orgs', label:'Организации' }, { id:'invoices', label:'Деньги' }]);
  const main = $('#main'); if (!main) return;
  if (state.tab === 'orgs') {
    const { data: orgs } = await db.from('organization').select('*').order('type');
    main.innerHTML = `
      <div class="page-head"><div><h1>Организации</h1><div class="sub">Все участники коридора.</div></div></div>
      <div class="card"><div class="card-head">Участники</div>
      ${(orgs||[]).length ? `<table><thead><tr><th>Название</th><th>Тип</th><th>Страна</th><th>Статус</th><th>ID</th></tr></thead><tbody>
        ${orgs.map(o => `<tr><td>${esc(o.name)}</td><td><span class="badge badge--${ORG_BADGE[o.type]||'gray'}">${esc(o.type)}</span></td><td>${esc(o.country||'—')}</td><td>${badge(o.status)}</td><td class="id-cell">${short(o.id)}</td></tr>`).join('')}
      </tbody></table>` : `<div class="card-empty">Нет организаций.</div>`}</div>`;
  } else {
    const [{ data: orgs }, { data: acc }, { data: inv }] = await Promise.all([
      db.from('organization').select('id,name,type'),
      db.from('commission_accrual').select('supplier_org_id,amount,currency,status').eq('status', 'accrued'),
      db.from('invoice').select('*').order('issued_at', { ascending:false }),
    ]);
    const orgName = Object.fromEntries((orgs||[]).map(o => [o.id, o.name]));
    const bySup = {};
    (acc||[]).forEach(a => { const s = bySup[a.supplier_org_id] || { sum:0, cur:a.currency||'USD' }; s.sum += Number(a.amount||0); bySup[a.supplier_org_id] = s; });
    const supRows = Object.entries(bySup).filter(([, v]) => v.sum > 0);
    main.innerHTML = `
      <div class="page-head"><div><h1>Деньги</h1><div class="sub">Комиссия Waylo: начисления → счёт поставщику → оплата → погашено.</div></div></div>
      <div class="card"><div class="card-head">Спред к выставлению (по поставщикам)</div>
      ${supRows.length ? `<table><thead><tr><th>Поставщик</th><th style="text-align:right">Накоплено</th><th></th></tr></thead><tbody>
        ${supRows.map(([sid, v]) => `<tr><td>${esc(orgName[sid] || short(sid))}</td><td class="price" style="text-align:right">${money(v.sum, v.cur)}</td><td style="text-align:right"><button class="btn btn--primary btn--sm issueCom" data-sup="${sid}">Выставить commission-счёт</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="card-empty">Нет накопленного спреда к выставлению.</div>`}</div>
      <div class="card"><div class="card-head">Счета</div>
      ${(inv||[]).length ? `<table><thead><tr><th>Счёт</th><th>Тип</th><th>Плательщик → Получатель</th><th style="text-align:right">Сумма</th><th>Статус</th><th></th></tr></thead><tbody>
        ${inv.map(v => `<tr><td class="id-cell">${short(v.id)}</td><td>${v.kind==='commission'?'комиссия':'бронь'}</td><td>${esc(orgName[v.payer_org_id] || short(v.payer_org_id))} → ${esc(orgName[v.payee_org_id] || short(v.payee_org_id))}</td><td class="price" style="text-align:right">${money(v.amount, v.currency)}</td><td>${badge(v.status)}</td><td style="text-align:right">${v.status!=='paid' ? `<button class="btn btn--ghost btn--sm payInv" data-inv="${v.id}" data-amt="${v.amount}">Отметить оплату</button>` : '✓ оплачено'}</td></tr>`).join('')}
      </tbody></table>` : `<div class="card-empty">Счетов пока нет.</div>`}</div>`;
    document.querySelectorAll('.issueCom').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Выставляем…';
      const { error } = await db.rpc('issue_commission_invoice', { p_supplier: b.dataset.sup });
      if (error) { alert(error.message); b.disabled = false; b.textContent = 'Выставить commission-счёт'; }
      else renderPlatform();
    });
    document.querySelectorAll('.payInv').forEach(b => b.onclick = async () => {
      if (!confirm('Отметить счёт как оплаченный на сумму ' + money(Number(b.dataset.amt)) + '?')) return;
      b.disabled = true; b.textContent = 'Проводим…';
      const { error } = await db.rpc('record_payment', { p_invoice: b.dataset.inv, p_amount: Number(b.dataset.amt) });
      if (error) { alert(error.message); b.disabled = false; b.textContent = 'Отметить оплату'; }
      else renderPlatform();
    });
  }
}

boot();
