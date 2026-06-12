/* ===========================================================================
   НАСТРОЙКА: вставь свой anon-ключ (Supabase → Settings → API → anon public).
   anon-ключ публичный и безопасный для клиента — доступ к данным режет RLS.
   =========================================================================== */
const SUPABASE_URL = "https://rfxenahasipffiuommvx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmeGVuYWhhc2lwZmZpdW9tbXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDE3NTEsImV4cCI6MjA5NjcxNzc1MX0.4inQoQjNxBmpn_zsuJj6cdW283-kzTGB-TCj14G1KYw";

const app = document.getElementById('app');

// Стабильность и скорость важнее автосохранения сессии. Отключаем всё, что
// вешало supabase-js: межвкладочный navigator.locks, фоновое обновление токена
// и хранение сессии. Старт мгновенный, вход — один быстрый запрос.
const noLock = async (_name, _timeout, fn) => await fn();
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { lock: noLock, persistSession: false, autoRefreshToken: false },
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

function boot() {
  // Мгновенный старт: на загрузке НЕ дёргаем getSession (именно он вешал
  // страницу через navigator.locks). Сразу показываем вход; дальше всем
  // управляет onAuthStateChange — он отрисует кабинет после успешного входа.
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
    const { error } = await db.auth.signInWithPassword({ email:$('#email').value, password:$('#password').value });
    if (error) { $('#loginErr').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; btn.disabled = false; btn.textContent = 'Войти'; }
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
  navShell('DMC · ' + active.orgName, [{ id:'catalog', label:'Каталог' }, { id:'requests', label:'Туры' }, { id:'calc', label:'Калькулятор' }, { id:'finance', label:'Финансы' }]);
  if (state.tab === 'catalog') dmcCatalog();
  else if (state.tab === 'calc') dmcCalculator(active);
  else if (state.tab === 'finance') dmcFinance(active);
  else dmcRequests(active);
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
  const { data: reqs, error } = await db.from('request')
    .select('id,name,client_name,destination,start_date,end_date,travel_date,pax_count,currency,status,created_at')
    .order('created_at', { ascending:false });
  if (error) { main.innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; return; }
  const ids = (reqs || []).map(r => r.id);
  let withLines = new Set();
  if (ids.length) { const { data: ls } = await db.from('request_line').select('request_id').in('request_id', ids); withLines = new Set((ls || []).map(x => x.request_id)); }
  // «пустые» = черновики без услуг и без названия (мусор старого потока)
  const emptyDrafts = (reqs || []).filter(r => r.status === 'draft' && !withLines.has(r.id) && !r.name);
  const dates = (r) => r.start_date ? esc(r.start_date) + (r.end_date ? ' → ' + esc(r.end_date) : '') : '—';
  main.innerHTML = `
    <div class="page-head"><div><h1>Туры</h1><div class="sub">Создайте тур — даты, направление и группу. Отели, трансферы и цены добавите внутри.</div></div>
      <div style="display:flex;gap:8px">${emptyDrafts.length ? `<button class="btn btn--ghost" id="clrDrafts">Очистить пустые (${emptyDrafts.length})</button>` : ''}<button class="btn btn--primary" id="newReq">Новый тур</button></div></div>
    <div id="newReqForm"></div>
    <div class="card">
      ${reqs.length ? `<table><thead><tr><th>Тур</th><th>Клиент / группа</th><th>Направление</th><th>Даты</th><th>PAX</th><th>Статус</th><th></th></tr></thead><tbody>
        ${reqs.map(r => `<tr>
          <td><div style="font-weight:600">${esc(r.name || 'Без названия')}</div><div class="id-cell" style="font-size:11px">${short(r.id)}</div></td>
          <td>${esc(r.client_name || '—')}</td>
          <td>${esc(r.destination || '—')}</td>
          <td class="hint">${dates(r)}</td>
          <td class="mono">${r.pax_count ?? '—'}</td>
          <td>${badge(r.status)}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn btn--ghost btn--sm openReq" data-id="${r.id}">${state.openReq===r.id?'Скрыть':'Открыть'}</button> <button class="btn btn--ghost btn--sm delReq" data-id="${r.id}" title="Удалить тур">✕</button></td>
        </tr>`).join('')}
      </tbody></table>` : `<div class="card-empty">Туров пока нет — создайте первый.</div>`}
    </div><div id="reqDetail"></div>`;
  $('#newReq').onclick = () => {
    const box = $('#newReqForm');
    const L = 'style="display:flex;flex-direction:column;gap:5px;font-size:13px;color:#445;font-weight:500"';
    const I = 'style="padding:9px 11px;border:1px solid #cdd6de;border-radius:8px;font:inherit;background:#fff"';
    const req = '<span style="color:#c0392b">*</span>';
    box.innerHTML = `<div class="card">
      <div class="card-head">Новый тур</div>
      <div style="padding:10px 18px 0;font-size:13px;color:#6b7a89">Заполните основные данные — услуги, цены и туристов добавите внутри тура.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;padding:14px 18px 4px">
        <label ${L}>Название тура ${req}<input id="trName" ${I} placeholder="напр. Экспедиция по Шёлковому пути"></label>
        <label ${L}>Клиент / название группы<input id="trClient" ${I} placeholder="напр. Acme Corp / Семья Смит"></label>
        <label ${L} style="grid-column:1/3">Направление<input id="trDest" ${I} placeholder="напр. Самарканд, Бухара, Хива"></label>
        <label ${L}>Дата начала ${req}<input type="date" id="trStart" ${I}></label>
        <label ${L}>Дата окончания ${req}<input type="date" id="trEnd" ${I}></label>
        <label ${L}>PAX (кол-во чел.) ${req}<input type="number" id="trPax" min="1" value="1" ${I}></label>
        <label ${L}>Базовая валюта<select id="trCur" ${I}><option value="USD">USD (Доллар США)</option><option value="EUR">EUR (Евро)</option><option value="KZT">KZT (Тенге)</option><option value="UZS">UZS (Сум)</option></select></label>
      </div>
      <div id="trMsg"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-top:1px solid #e3e9ee;margin-top:8px">
        <button class="btn btn--ghost btn--sm" id="trCancel">Отмена</button>
        <button class="btn btn--primary" id="trCreate">Создать тур</button>
      </div></div>`;
    const err = (t) => `<div class="notice notice--err" style="margin:0 18px 10px">${esc(t)}</div>`;
    $('#trCancel').onclick = () => { box.innerHTML = ''; };
    $('#trCreate').onclick = async () => {
      const name = $('#trName').value.trim();
      const client = $('#trClient').value.trim() || null;
      const dest = $('#trDest').value.trim() || null;
      const start = $('#trStart').value || null;
      const end = $('#trEnd').value || null;
      const pax = parseInt($('#trPax').value, 10) || 1;
      const cur = $('#trCur').value || 'USD';
      if (!name) { $('#trMsg').innerHTML = err('Укажите название тура.'); return; }
      if (!start || !end) { $('#trMsg').innerHTML = err('Укажите даты начала и окончания.'); return; }
      if (end < start) { $('#trMsg').innerHTML = err('Дата окончания раньше даты начала.'); return; }
      const { data, error: e2 } = await db.from('request').insert({
        dmc_org_id: active.orgId, status: 'draft', name, client_name: client, destination: dest,
        start_date: start, end_date: end, travel_date: start, pax_count: pax, currency: cur,
      }).select().single();
      if (e2) { $('#trMsg').innerHTML = err(e2.message); return; }
      state.openReq = data.id; dmcRequests(active);
    };
  };
  const clr = $('#clrDrafts');
  if (clr) clr.onclick = async () => {
    if (!confirm('Удалить пустые черновики: ' + emptyDrafts.length + ' шт.?')) return;
    const { error: e3 } = await db.from('request').delete().in('id', emptyDrafts.map(r => r.id));
    if (e3) { alert(e3.message); return; }
    dmcRequests(active);
  };
  document.querySelectorAll('.delReq').forEach(b => b.onclick = async () => {
    if (!confirm('Удалить тур ' + short(b.dataset.id) + '?')) return;
    const { error: e4 } = await db.from('request').delete().eq('id', b.dataset.id);
    if (e4) { alert(e4.message); return; }
    if (state.openReq === b.dataset.id) state.openReq = null;
    dmcRequests(active);
  });
  document.querySelectorAll('.openReq').forEach(b => b.onclick = () => { state.openReq = state.openReq === b.dataset.id ? null : b.dataset.id; dmcRequests(active); });
  if (state.openReq) renderReqDetail(active, state.openReq);
}

async function dmcFinance(active) {
  const main = $('#main'); if (!main) return;
  const { data: inv } = await db.from('invoice').select('*').eq('kind', 'client').order('issued_at', { ascending:false });
  const list = inv || [];
  const owed = list.filter(v => v.status !== 'paid' && v.status !== 'cancelled').reduce((s, v) => s + Number(v.amount), 0);
  main.innerHTML = `
    <div class="page-head"><div><h1>Финансы</h1><div class="sub">Счета от Waylo за подтверждённые бронирования. Оплата — в адрес Waylo, одним контрагентом.</div></div></div>
    <div class="stat-row"><div class="stat"><div class="n">${money(owed)}</div><div class="l">к оплате Waylo</div></div><div class="stat"><div class="n">${list.length}</div><div class="l">счетов</div></div></div>
    <div class="card"><div class="card-head">Счета от Waylo</div>
    ${list.length ? `<table><thead><tr><th>Счёт</th><th>Заявка</th><th>Сумма</th><th>Статус</th><th>Дата</th><th></th></tr></thead><tbody>
      ${list.map(v => `<tr><td class="id-cell">${short(v.id)}</td><td class="id-cell">${v.request_id?short(v.request_id):'—'}</td><td class="price">${money(v.amount,v.currency)}</td><td>${badge(v.status)}</td><td class="hint">${v.issued_at?new Date(v.issued_at).toLocaleDateString('ru-RU'):'—'}</td><td style="text-align:right">${v.status!=='paid'?`<button class="btn btn--primary btn--sm payCli" data-inv="${v.id}" data-amt="${v.amount}">Оплатить</button>`:'✓ оплачено'}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Счетов пока нет. Waylo выставит счёт после того, как поставщик подтвердит услуги по заявке.</div>`}</div>`;
  document.querySelectorAll('.payCli').forEach(b => b.onclick = async () => {
    if (!confirm('Оплатить счёт Waylo на сумму ' + money(Number(b.dataset.amt)) + '?')) return;
    b.disabled = true; b.textContent = 'Оплата…';
    const { error } = await db.rpc('record_payment', { p_invoice: b.dataset.inv, p_amount: Number(b.dataset.amt) });
    if (error) { alert(error.message); b.disabled = false; b.textContent = 'Оплатить'; }
    else dmcFinance(active);
  });
}

async function renderReqDetail(active, reqId) {
  const box = $('#reqDetail'); if (!box) return;
  const { data: tour } = await db.from('request').select('name,client_name,destination,start_date,end_date,pax_count,currency,status').eq('id', reqId).single();
  const { data: lines } = await db.from('request_line').select('*').eq('request_id', reqId).order('created_at');
  let holdsBy = {};
  if ((lines || []).length) {
    const { data: hs } = await db.from('hold').select('*').in('request_line_id', lines.map(l => l.id));
    (hs || []).forEach(h => { (holdsBy[h.request_line_id] ||= []).push(h); });
  }
  const tHead = tour ? `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px 18px;flex-wrap:wrap">
      <div><div style="font-size:17px;font-weight:700">${esc(tour.name || 'Тур')}</div>
        <div class="hint" style="margin-top:3px">${esc(tour.destination || 'направление не указано')}</div></div>
      <div style="display:flex;gap:22px;font-size:13px;flex-wrap:wrap">
        <div><div class="hint">Клиент</div><div style="font-weight:600">${esc(tour.client_name || '—')}</div></div>
        <div><div class="hint">Даты</div><div style="font-weight:600">${tour.start_date ? esc(tour.start_date) + (tour.end_date ? ' → ' + esc(tour.end_date) : '') : '—'}</div></div>
        <div><div class="hint">PAX</div><div style="font-weight:600">${tour.pax_count ?? '—'}</div></div>
        <div><div class="hint">Валюта</div><div style="font-weight:600">${esc(tour.currency || 'USD')}</div></div>
      </div>
    </div></div>` : '';
  box.innerHTML = tHead + `
    <div class="card">
      <div class="card-head">Блоки услуг <span id="addLineSlot"></span>${(lines||[]).length ? ` <button class="btn btn--ghost btn--sm" id="voucherBtn">Ваучер</button>` : ''}</div>
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
  const vb = $('#voucherBtn'); if (vb) vb.onclick = () => renderVoucher(reqId, lines);
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
    await db.from('request').update({ status:'submitted' }).eq('id', reqId).eq('status', 'draft');
    onAdded();
  };
}

/* ── Ваучер (печатный документ по заявке) ────────────────────────────────── */
async function renderVoucher(reqId, lines) {
  const hotelIds = [...new Set(lines.filter(l => l.type === 'HOTEL').map(l => l.resource_id))];
  const transIds = [...new Set(lines.filter(l => l.type === 'TRANSPORT').map(l => l.resource_id))];
  const [{ data: req }, { data: rts }, { data: vcs }, { data: orgs }] = await Promise.all([
    db.from('request').select('id,travel_date,pax_count,dmc_org_id,status').eq('id', reqId).single(),
    hotelIds.length ? db.from('room_type').select('id,name,property_id').in('id', hotelIds) : Promise.resolve({ data: [] }),
    transIds.length ? db.from('vehicle_class').select('id,name').in('id', transIds) : Promise.resolve({ data: [] }),
    db.from('organization').select('id,name,country'),
  ]);
  const propIds = [...new Set((rts || []).map(r => r.property_id))];
  const { data: props } = propIds.length ? await db.from('property').select('id,name,city').in('id', propIds) : { data: [] };
  const orgName = Object.fromEntries((orgs || []).map(o => [o.id, o.name]));
  const propById = Object.fromEntries((props || []).map(p => [p.id, p]));
  const rtById = Object.fromEntries((rts || []).map(r => [r.id, r]));
  const vcById = Object.fromEntries((vcs || []).map(v => [v.id, v]));
  const resName = (l) => {
    if (l.type === 'HOTEL') { const rt = rtById[l.resource_id]; const p = rt && propById[rt.property_id]; return p ? `${p.name} · ${rt.name} (${p.city})` : 'Размещение'; }
    const v = vcById[l.resource_id]; return v ? `Трансфер · ${v.name}` : 'Трансфер';
  };
  const nights = (l) => Math.max(1, Math.round((new Date(l.to_date) - new Date(l.from_date)) / 86400000));
  const lineTotal = (l) => Number(l.sell_price || 0) * l.quantity * nights(l);
  const grand = lines.reduce((s, l) => s + lineTotal(l), 0);
  const today = new Date().toLocaleDateString('ru-RU');

  const ov = document.createElement('div');
  ov.id = 'voucherOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,40,.5);display:flex;align-items:flex-start;justify-content:center;overflow:auto;z-index:1000;padding:32px';
  ov.innerHTML = `
    <style>@media print{body>*:not(#voucherOverlay){display:none!important}#voucherOverlay{position:static!important;background:#fff!important;padding:0!important;display:block!important}#voucherOverlay .vchr-actions{display:none!important}#voucherOverlay .vchr-doc{box-shadow:none!important;width:100%!important;max-width:none!important}}</style>
    <div class="vchr-doc" style="background:#fff;width:760px;max-width:100%;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.3);font-family:system-ui,'Segoe UI',sans-serif;color:#1a2530">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:32px 36px 20px;border-bottom:2px solid #0a7d6c">
        <div><div style="font-size:22px;font-weight:700;color:#0a7d6c">Waylo <span style="color:#1a2530">KZ</span></div><div style="font-size:12px;color:#6b7a89;margin-top:2px">Операционный коридор · Узбекистан</div></div>
        <div style="text-align:right"><div style="font-size:20px;font-weight:700;letter-spacing:1px">ВАУЧЕР</div><div style="font-size:12px;color:#6b7a89">VOUCHER</div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:18px;justify-content:space-between;padding:20px 36px;font-size:13px">
        <div><div style="color:#6b7a89">Ваучер №</div><div style="font-weight:600;font-family:monospace">${short(reqId)}</div></div>
        <div><div style="color:#6b7a89">Дата выпуска</div><div style="font-weight:600">${today}</div></div>
        <div><div style="color:#6b7a89">Турагентство (DMC)</div><div style="font-weight:600">${esc(orgName[req?.dmc_org_id] || '—')}</div></div>
        <div><div style="color:#6b7a89">Дата поездки</div><div style="font-weight:600">${esc(req?.travel_date || '—')}</div></div>
        <div><div style="color:#6b7a89">Туристов</div><div style="font-weight:600">${req?.pax_count ?? '—'}</div></div>
      </div>
      <div style="padding:0 36px 8px"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;color:#6b7a89;border-bottom:1px solid #e3e9ee">
          <th style="padding:8px 6px">Услуга</th><th style="padding:8px 6px">Поставщик</th><th style="padding:8px 6px">Период</th><th style="padding:8px 6px;text-align:center">Кол-во</th><th style="padding:8px 6px;text-align:center">Статус</th><th style="padding:8px 6px;text-align:right">Сумма</th>
        </tr></thead><tbody>
        ${lines.map(l => `<tr style="border-bottom:1px solid #f0f3f6">
          <td style="padding:9px 6px">${esc(resName(l))}</td>
          <td style="padding:9px 6px">${esc(orgName[l.supplier_org_id] || '—')}</td>
          <td style="padding:9px 6px;color:#6b7a89">${esc(l.from_date)} → ${esc(l.to_date)}</td>
          <td style="padding:9px 6px;text-align:center">${l.quantity}</td>
          <td style="padding:9px 6px;text-align:center">${l.confirmation==='confirmed'?'<span style="color:#0a7d6c">подтверждено</span>':'<span style="color:#b07a00">ожидает</span>'}</td>
          <td style="padding:9px 6px;text-align:right;font-weight:600">${money(lineTotal(l))}</td>
        </tr>`).join('')}
        </tbody><tfoot><tr><td colspan="5" style="padding:12px 6px;text-align:right;font-weight:600">Итого:</td><td style="padding:12px 6px;text-align:right;font-weight:700;font-size:15px;color:#0a7d6c">${money(grand)}</td></tr></tfoot>
      </table></div>
      <div style="padding:16px 36px 28px;font-size:11px;color:#8a97a4;line-height:1.5;border-top:1px solid #e3e9ee;margin-top:8px">
        Документ сформирован платформой Waylo на основе условий заявки. Ваучер служит подтверждением бронирования услуг у поставщиков Узбекистана. Цены указаны к продаже для DMC.
      </div>
      <div class="vchr-actions" style="display:flex;gap:10px;justify-content:flex-end;padding:0 36px 28px">
        <button id="vchrClose" style="padding:9px 18px;border:1px solid #cdd6de;background:#fff;border-radius:8px;cursor:pointer;font:inherit">Закрыть</button>
        <button id="vchrPrint" style="padding:9px 18px;border:0;background:#0a7d6c;color:#fff;border-radius:8px;cursor:pointer;font:inherit">Печать / Сохранить PDF</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#vchrClose').onclick = close;
  ov.querySelector('#vchrPrint').onclick = () => window.print();
}

/* ── HOTEL ───────────────────────────────────────────────────────────────── */
async function renderHotel(active) {
  if (!state.tab) state.tab = 'confirm';
  navShell('Отель · ' + active.orgName, [{ id:'confirm', label:'Подтверждения' }, { id:'avail', label:'Доступность' }, { id:'finance', label:'Финансы' }]);
  if (state.tab === 'confirm') supplierConfirm(active, 'отель');
  else if (state.tab === 'avail') hotelAvail(active);
  else supplierFinance(active);
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

async function supplierFinance(active) {
  const main = $('#main'); if (!main) return;
  const orgId = active.orgId;
  const [{ data: lines }, { data: accr }, { data: inv }] = await Promise.all([
    db.from('request_line').select('id,type,from_date,to_date,quantity,sell_price,confirmation').eq('supplier_org_id', orgId).eq('confirmation', 'confirmed').order('created_at', { ascending:false }),
    db.from('commission_accrual').select('request_line_id,amount').eq('supplier_org_id', orgId),
    db.from('invoice').select('*').eq('kind', 'payout').eq('payee_org_id', orgId).order('issued_at', { ascending:false }),
  ]);
  const spreadByLine = Object.fromEntries((accr || []).map(a => [a.request_line_id, Number(a.amount)]));
  const nights = (l) => Math.max(1, Math.round((new Date(l.to_date) - new Date(l.from_date)) / 86400000));
  const netOf = (l) => Number(l.sell_price || 0) * l.quantity * nights(l) - (spreadByLine[l.id] || 0);
  const netTotal = (lines || []).reduce((s, l) => s + netOf(l), 0);
  const invList = inv || [];
  const paidOut = invList.filter(v => v.status === 'paid').reduce((s, v) => s + Number(v.amount), 0);
  const pendingOut = invList.filter(v => v.status !== 'paid' && v.status !== 'cancelled').reduce((s, v) => s + Number(v.amount), 0);
  main.innerHTML = `
    <div class="page-head"><div><h1>Финансы</h1><div class="sub">Выплаты от Waylo за подтверждённые услуги. Сумма — ваше нетто; Waylo — единый плательщик.</div></div></div>
    <div class="stat-row"><div class="stat"><div class="n">${money(netTotal)}</div><div class="l">нетто подтверждено</div></div><div class="stat"><div class="n">${money(pendingOut)}</div><div class="l">выплата ожидается</div></div><div class="stat"><div class="n">${money(paidOut)}</div><div class="l">выплачено</div></div></div>
    <div class="card"><div class="card-head">Подтверждённые услуги (нетто к выплате)</div>
    ${(lines||[]).length ? `<table><thead><tr><th>Линия</th><th>Тип</th><th>Период</th><th>Кол-во</th><th style="text-align:right">Нетто</th></tr></thead><tbody>
      ${lines.map(l => `<tr><td class="id-cell">${short(l.id)}</td><td>${typeBadge(l.type)}</td><td class="hint">${esc(l.from_date)} — ${esc(l.to_date)}</td><td class="mono">${l.quantity}</td><td class="price" style="text-align:right">${money(netOf(l))}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Нет подтверждённых услуг. Подтвердите холды во вкладке «Подтверждения».</div>`}</div>
    <div class="card"><div class="card-head">Выплаты от Waylo</div>
    ${invList.length ? `<table><thead><tr><th>Выплата</th><th>Заявка</th><th>Сумма</th><th>Статус</th><th>Дата</th></tr></thead><tbody>
      ${invList.map(v => `<tr><td class="id-cell">${short(v.id)}</td><td class="id-cell">${v.request_id?short(v.request_id):'—'}</td><td class="price">${money(v.amount,v.currency)}</td><td>${badge(v.status)}</td><td class="hint">${v.issued_at?new Date(v.issued_at).toLocaleDateString('ru-RU'):'—'}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Выплат пока нет. Waylo проведёт выплату после подтверждения услуг.</div>`}</div>`;
}

/* ── TRANSPORT ───────────────────────────────────────────────────────────── */
async function renderTransport(active) {
  if (!state.tab) state.tab = 'fleet';
  navShell('Трансфер · ' + active.orgName, [{ id:'fleet', label:'Автопарк' }, { id:'avail', label:'Доступность' }, { id:'confirm', label:'Подтверждения' }, { id:'finance', label:'Финансы' }]);
  if (state.tab === 'fleet') transportFleet(active);
  else if (state.tab === 'avail') transportAvail(active);
  else if (state.tab === 'confirm') supplierConfirm(active, 'трансфер');
  else supplierFinance(active);
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
    const [{ data: orgs }, { data: reqs }, { data: lines }, { data: accr }, { data: inv }] = await Promise.all([
      db.from('organization').select('id,name,type'),
      db.from('request').select('id,dmc_org_id'),
      db.from('request_line').select('id,request_id,supplier_org_id,quantity,sell_price,from_date,to_date').eq('confirmation', 'confirmed'),
      db.from('commission_accrual').select('request_line_id,amount,supplier_org_id'),
      db.from('invoice').select('*').in('kind', ['client', 'payout']).order('issued_at', { ascending:false }),
    ]);
    const orgName = Object.fromEntries((orgs||[]).map(o => [o.id, o.name]));
    const reqById = Object.fromEntries((reqs||[]).map(r => [r.id, r]));
    const spreadByLine = Object.fromEntries((accr||[]).map(a => [a.request_line_id, Number(a.amount)]));
    const nights = (l) => Math.max(1, Math.round((new Date(l.to_date) - new Date(l.from_date)) / 86400000));
    const sellOf = (l) => Number(l.sell_price||0) * l.quantity * nights(l);
    const byReq = {};
    (lines||[]).forEach(l => { const r = byReq[l.request_id] || { sell:0, spread:0, suppliers:new Set() }; r.sell += sellOf(l); r.spread += (spreadByLine[l.id]||0); r.suppliers.add(l.supplier_org_id); byReq[l.request_id] = r; });
    const reqRows = Object.entries(byReq);
    const invList = inv || [];
    const marginTotal = reqRows.reduce((s, [, v]) => s + v.spread, 0);
    const recvPaid = invList.filter(v => v.kind==='client' && v.status==='paid').reduce((s,v)=>s+Number(v.amount),0);
    const paidOut = invList.filter(v => v.kind==='payout' && v.status==='paid').reduce((s,v)=>s+Number(v.amount),0);
    const hasClient = new Set(invList.filter(v => v.kind==='client').map(v => v.request_id));
    const payoutKey = new Set(invList.filter(v => v.kind==='payout').map(v => v.request_id + '|' + v.payee_org_id));
    main.innerHTML = `
      <div class="page-head"><div><h1>Деньги</h1><div class="sub">Waylo — расчётный центр: получаем с DMC (sell), платим поставщикам (net), оставляем спред.</div></div></div>
      <div class="stat-row"><div class="stat"><div class="n">${money(marginTotal)}</div><div class="l">маржа Waylo (спред)</div></div><div class="stat"><div class="n">${money(recvPaid)}</div><div class="l">получено с клиентов</div></div><div class="stat"><div class="n">${money(paidOut)}</div><div class="l">выплачено поставщикам</div></div></div>
      <div class="card"><div class="card-head">Расчёты по заявкам</div>
      ${reqRows.length ? `<table><thead><tr><th>Заявка</th><th>DMC</th><th style="text-align:right">С клиента (sell)</th><th style="text-align:right">Поставщикам (net)</th><th style="text-align:right">Маржа</th><th></th></tr></thead><tbody>
        ${reqRows.map(([rid, v]) => { const dmc = reqById[rid]?.dmc_org_id; const net = v.sell - v.spread; const sups = [...v.suppliers]; const allPaid = sups.length && sups.every(s => payoutKey.has(rid + '|' + s)); return `<tr><td class="id-cell">${short(rid)}</td><td>${esc(orgName[dmc]||'—')}</td><td class="price" style="text-align:right">${money(v.sell)}</td><td class="price" style="text-align:right">${money(net)}</td><td class="price" style="text-align:right"><b>${money(v.spread)}</b></td><td style="text-align:right;white-space:nowrap">${hasClient.has(rid)?'<span class="hint">счёт ✓</span>':`<button class="btn btn--primary btn--sm issCli" data-req="${rid}">Счёт клиенту</button>`} ${allPaid?'<span class="hint">выплачено ✓</span>':`<button class="btn btn--ghost btn--sm issPay" data-req="${rid}" data-sups="${sups.join(',')}">Выплатить</button>`}</td></tr>`; }).join('')}
      </tbody></table>` : `<div class="card-empty">Нет подтверждённых услуг для расчёта.</div>`}</div>
      <div class="card"><div class="card-head">Счета и выплаты</div>
      ${invList.length ? `<table><thead><tr><th>Док</th><th>Тип</th><th>Плательщик → Получатель</th><th style="text-align:right">Сумма</th><th>Статус</th><th></th></tr></thead><tbody>
        ${invList.map(v => `<tr><td class="id-cell">${short(v.id)}</td><td>${v.kind==='client'?'счёт DMC':'выплата'}</td><td>${esc(orgName[v.payer_org_id] || short(v.payer_org_id))} → ${esc(orgName[v.payee_org_id] || short(v.payee_org_id))}</td><td class="price" style="text-align:right">${money(v.amount, v.currency)}</td><td>${badge(v.status)}</td><td style="text-align:right">${v.status!=='paid' ? `<button class="btn btn--ghost btn--sm payInv" data-inv="${v.id}" data-amt="${v.amount}">Отметить оплату</button>` : '✓ оплачено'}</td></tr>`).join('')}
      </tbody></table>` : `<div class="card-empty">Документов пока нет.</div>`}</div>`;
    document.querySelectorAll('.issCli').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Выставляем…';
      const { error } = await db.rpc('issue_client_invoice', { p_request: b.dataset.req });
      if (error) { alert(error.message); b.disabled = false; b.textContent = 'Счёт клиенту'; } else renderPlatform();
    });
    document.querySelectorAll('.issPay').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Выплата…';
      const sups = b.dataset.sups.split(',').filter(Boolean);
      let err = null;
      for (const s of sups) { const { error } = await db.rpc('issue_supplier_payout', { p_request: b.dataset.req, p_supplier: s }); if (error) { err = error; break; } }
      if (err) { alert(err.message); b.disabled = false; b.textContent = 'Выплатить'; } else renderPlatform();
    });
    document.querySelectorAll('.payInv').forEach(b => b.onclick = async () => {
      if (!confirm('Отметить как оплачено на сумму ' + money(Number(b.dataset.amt)) + '?')) return;
      b.disabled = true; b.textContent = 'Проводим…';
      const { error } = await db.rpc('record_payment', { p_invoice: b.dataset.inv, p_amount: Number(b.dataset.amt) });
      if (error) { alert(error.message); b.disabled = false; b.textContent = 'Отметить оплату'; } else renderPlatform();
    });
  }
}

/* ════════ DMC · КАЛЬКУЛЯТОР ТУРА (catalog-backed, стиль TourFlow) ════════
   Маршрут по локациям → проживание (отели/резорты из каталога Waylo; цена к
   продаже = себестоимость DMC) → транспорт/питание/билеты по городам → гид,
   шоу, прочее → прибыль $/чел → цена для клиента по размеру группы. */
let calcCat = null;   // каталог из базы: {acc:[...], veh:[...]}
let calcSt  = null;   // рабочее состояние расчёта

async function loadCalcCat() {
  const [{ data: props }, { data: types }, { data: rates }, { data: vcs }, { data: trates }] = await Promise.all([
    db.from('property').select('id,name,city,kind,star_category').eq('is_active', true),
    db.from('room_type').select('id,property_id,name,max_occupancy'),
    db.from('room_rate_public').select('room_type_id,sell_price,sgl_supplement'),
    db.from('vehicle_class').select('id,name,pax_min,pax_max'),
    db.from('transport_rate_public').select('vehicle_class_id,sell_price_per_unit'),
  ]);
  const pById = {}; (props || []).forEach(p => pById[p.id] = p);
  const rByRt = {}; (rates || []).forEach(r => { if (!rByRt[r.room_type_id]) rByRt[r.room_type_id] = r; });
  const acc = (types || []).filter(t => rByRt[t.id] && pById[t.property_id]).map(t => {
    const p = pById[t.property_id], r = rByRt[t.id], twin = Number(r.sell_price) || 0;
    return { id: t.id, city: p.city, kind: p.kind, prop: p.name, room: t.name,
             twin, sgl: twin + (Number(r.sgl_supplement) || 0) };
  }).sort((a, b) => a.city.localeCompare(b.city, 'ru') || a.prop.localeCompare(b.prop, 'ru'));
  const tByVc = {}; (trates || []).forEach(r => { if (!tByVc[r.vehicle_class_id]) tByVc[r.vehicle_class_id] = r; });
  const veh = (vcs || []).filter(v => tByVc[v.id]).map(v => ({ id: v.id, name: v.name, day: Number(tByVc[v.id].sell_price_per_unit) || 0 }))
    .sort((a, b) => a.day - b.day);
  return { acc, veh };
}

function newCalc() {
  return {
    name: '', profit: 250,
    stops: [],
    trans: [], meals: [], entr: {},
    shows: [], misc: [{ name: 'Вода', sum: 0 }, { name: 'Портеры', sum: 0 }],
    guide: { fee: 120, transport: 225, mealOn: false, meal: 0, hotelOn: false, hotel: 0 },
  };
}

function calcSync() {
  const s = calcSt;
  const exT = {}; s.trans.forEach(t => exT[t.city] = t);
  s.trans = s.stops.map(st => { const e = exT[st.city] || {}; return { city: st.city, days: st.nights, vehId: e.vehId || '', price: e.price || 0 }; });
  const exM = {}; s.meals.forEach(m => exM[m.city] = m);
  s.meals = s.stops.map(st => { const e = exM[st.city] || {}; return { city: st.city, days: st.nights, fb: ('fb' in e) ? e.fb : true, price: e.price || 0 }; });
  const ne = {}; s.stops.forEach(st => { ne[st.city] = s.entr[st.city] || { desc: '', sum: 0 }; }); s.entr = ne;
}

function accOptions(selId) {
  const byCity = {};
  calcCat.acc.forEach(a => { (byCity[a.city] = byCity[a.city] || []).push(a); });
  let html = '<option value="">— отель / резорт —</option>';
  Object.keys(byCity).sort((a, b) => a.localeCompare(b, 'ru')).forEach(city => {
    html += `<optgroup label="${esc(city)}">`;
    byCity[city].forEach(a => {
      const tag = a.kind === 'resort' ? ' · резорт' : '';
      html += `<option value="${a.id}"${a.id === selId ? ' selected' : ''}>${esc(a.prop)} · ${esc(a.room)} — $${a.twin}${tag}</option>`;
    });
    html += '</optgroup>';
  });
  return html;
}
function vehOptions(selId) {
  let html = '<option value="">— класс —</option>';
  calcCat.veh.forEach(v => { html += `<option value="${v.id}"${v.id === selId ? ' selected' : ''}>${esc(v.name)} — $${v.day}/дн</option>`; });
  return html;
}
function suppOf(st) { return Math.round(((st.sgl || 0) - (st.twin || 0) / 2) * (st.nights || 0)); }
function suppTxt(st) { return (st.sgl || 0) === 0 ? '—' : '+$' + suppOf(st).toLocaleString('ru'); }

function ensureCalcFonts() {
  if (document.getElementById('wcalc-fonts')) return;
  const l = document.createElement('link');
  l.id = 'wcalc-fonts'; l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Mono:wght@300;400;500&display=swap';
  document.head.appendChild(l);
}

function calcStyle() {
  if (document.getElementById('wcalc-style')) return '';
  return `<style id="wcalc-style">
  .wcalc{--bg:#f2efe8;--sf:#faf8f4;--sf2:#ece9e2;--bd:#d8d3c8;--bd2:#b0a898;--ink:#1c1610;--ink2:#5a5044;--ink3:#9a9080;--ac:#c85520;--ac2:#1b6b4a;--ac3:#1a4a8c;font-family:"DM Mono",ui-monospace,monospace;font-size:12px;color:var(--ink)}
  .wcalc *{box-sizing:border-box}
  .wcalc .ctop{display:flex;align-items:center;gap:10px;height:44px;background:var(--ink);border-radius:7px;padding:0 12px;margin-bottom:10px;flex-wrap:wrap}
  .wcalc .clogo{font-family:"Syne",sans-serif;font-size:16px;font-weight:800;letter-spacing:-.03em;color:#fff;white-space:nowrap}
  .wcalc .clogo em{font-style:normal;color:#f07840}
  .wcalc .csep{width:1px;height:18px;background:rgba(255,255,255,.12)}
  .wcalc .ctname{flex:1;min-width:150px;height:28px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#fff;border-radius:4px;padding:0 9px;font:inherit;font-size:11px;outline:none}
  .wcalc .ctname::placeholder{color:rgba(255,255,255,.28)}
  .wcalc .ctname:focus{border-color:#f07840}
  .wcalc .ctlbl{font-size:10px;letter-spacing:.05em;color:rgba(255,255,255,.4);text-transform:uppercase;white-space:nowrap}
  .wcalc .ctprofit{width:70px;height:28px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14);color:#fff;border-radius:4px;text-align:right;padding:0 8px;font:inherit;outline:none}
  .wcalc .ctprofit:focus{border-color:#f07840}
  .wcalc .cgo{height:28px;padding:0 15px;background:var(--ac);color:#fff;border:0;border-radius:4px;font-family:"Syne",sans-serif;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;cursor:pointer}
  .wcalc .cgo:hover{background:#a84418}
  .wcalc .cbody{display:flex;gap:10px;align-items:flex-start}
  .wcalc .cres{width:312px;flex-shrink:0;border:2px solid var(--ink);border-radius:7px;overflow:hidden;background:var(--sf);position:sticky;top:8px}
  .wcalc .crh{padding:8px 12px;background:var(--ink);color:#fff}
  .wcalc .crh b{font-family:"Syne",sans-serif;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;display:block;margin-bottom:2px}
  .wcalc .crh span{font-size:10px;color:rgba(255,255,255,.35)}
  .wcalc .crscroll{max-height:600px;overflow:auto}
  .wcalc .crt{width:100%;border-collapse:collapse;font-size:11px}
  .wcalc .crt thead th{position:sticky;top:0;font-size:9px;letter-spacing:.06em;text-transform:uppercase;font-weight:400;color:var(--ink3);padding:5px 10px;border-bottom:2px solid var(--bd);background:var(--sf2);text-align:right}
  .wcalc .crt th:first-child{text-align:center;width:34px}
  .wcalc .crt td{padding:4px 10px;border-bottom:1px solid var(--bd);text-align:right}
  .wcalc .crt td:first-child{text-align:center;color:var(--ink3);background:var(--sf2);font-weight:500}
  .wcalc .crt tr:hover td{background:var(--sf2)}
  .wcalc .crt tr.best td{background:rgba(27,107,74,.08)}
  .wcalc .crt tr.best td:first-child{background:rgba(27,107,74,.16);color:var(--ac2);font-weight:700}
  .wcalc .cfoc{font-family:"Syne",sans-serif;font-weight:700;color:var(--ac3)}
  .wcalc .cnf{font-family:"Syne",sans-serif;font-weight:700;color:var(--ink)}
  .wcalc .cgp{color:var(--ink3);font-size:10px}
  .wcalc .crph{text-align:center;padding:26px 12px;color:var(--ink3);font-size:10px;line-height:1.7}
  .wcalc .csave{display:flex;gap:6px;padding:8px;border-top:1px solid var(--bd);background:var(--sf2)}
  .wcalc .csave input{flex:1;height:26px;border:1px solid var(--bd);border-radius:4px;background:var(--sf);font:inherit;font-size:11px;padding:0 8px;outline:none}
  .wcalc .csave button{height:26px;padding:0 12px;background:var(--ac3);color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:10px}
  .wcalc .cins{flex:1;min-width:0}
  .wcalc .cgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .wcalc .s12{grid-column:1/3}.wcalc .s34{grid-column:3/5}.wcalc .s3{grid-column:3/4}.wcalc .s4{grid-column:4/5}
  .wcalc .csec{background:var(--sf);border:1px solid var(--bd);border-radius:6px;overflow:hidden;display:flex;flex-direction:column}
  .wcalc .csh{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;background:var(--sf2);border-bottom:1px solid var(--bd)}
  .wcalc .cst{font-family:"Syne",sans-serif;font-weight:700;font-size:10px;letter-spacing:.07em;text-transform:uppercase;display:flex;align-items:center;gap:6px}
  .wcalc .cnum{font-size:9px;color:var(--ink3);background:var(--bg);border:1px solid var(--bd);border-radius:3px;padding:1px 5px}
  .wcalc .cauto{font-size:9px;color:var(--ac2);background:rgba(27,107,74,.08);border:1px solid rgba(27,107,74,.18);border-radius:3px;padding:1px 6px}
  .wcalc table.ct{width:100%;border-collapse:collapse}
  .wcalc .ct th{font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);font-weight:400;padding:3px 6px 4px;border-bottom:1px solid var(--bd);text-align:left;white-space:nowrap}
  .wcalc .ct td{padding:2px 4px;border-bottom:1px solid var(--bd);vertical-align:middle}
  .wcalc .ct tr:last-child td{border-bottom:none}
  .wcalc .ct tr:hover td{background:var(--sf2)}
  .wcalc .ct input,.wcalc .ct select{height:24px;border:1px solid var(--bd);border-radius:3px;background:var(--sf);font-family:"DM Mono",ui-monospace,monospace;font-size:11px;color:var(--ink);padding:0 5px;outline:none;width:100%}
  .wcalc .ct input:focus,.wcalc .ct select:focus{border-color:var(--ac3)}
  .wcalc input.cro{background:rgba(27,107,74,.05);border-color:rgba(27,107,74,.22);color:var(--ac2);pointer-events:none}
  .wcalc .csupp{font-family:"Syne",sans-serif;font-size:10px;font-weight:600;white-space:nowrap;padding:0 6px}
  .wcalc .ctotsupp{display:none;padding:4px 10px;font-family:"Syne",sans-serif;font-size:10px;font-weight:700;color:var(--ac3);border-top:1px solid var(--bd);background:rgba(26,74,140,.04)}
  .wcalc .cadd{display:flex;align-items:center;padding:4px 10px;cursor:pointer;color:var(--ink3);font-size:10px;background:none;border:0;border-top:1px dashed var(--bd);width:100%}
  .wcalc .cadd:hover{color:var(--ac3);background:rgba(26,74,140,.04)}
  .wcalc .cdel{width:18px;height:18px;border:0;background:none;cursor:pointer;color:var(--ink3);font-size:15px;line-height:1;border-radius:3px}
  .wcalc .cdel:hover{color:var(--ac)}
  .wcalc .cbb{display:inline-flex;align-items:center;padding:1px 7px;border-radius:3px;font-size:10px;cursor:pointer;border:1px solid var(--bd);background:var(--sf2);color:var(--ink2);user-select:none;white-space:nowrap}
  .wcalc .cbb.on{border-color:var(--ac2);background:rgba(27,107,74,.1);color:var(--ac2)}
  .wcalc .cg{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 10px}
  .wcalc .cgrow{display:flex;flex-direction:column;gap:3px}
  .wcalc .cgl{font-size:9px;color:var(--ink3);letter-spacing:.04em;text-transform:uppercase}
  .wcalc .cgv{display:flex;align-items:center;gap:5px}
  .wcalc .cgrow input{height:24px;border:1px solid var(--bd);border-radius:3px;background:var(--sf);font-family:"DM Mono",ui-monospace,monospace;font-size:11px;padding:0 5px;outline:none;width:100%}
  .wcalc .cgrow input:focus{border-color:var(--ac3)}
  .wcalc .ctog{width:26px;height:14px;border-radius:7px;border:1px solid var(--bd2);background:var(--sf2);display:inline-flex;align-items:center;padding:2px;cursor:pointer;flex-shrink:0}
  .wcalc .ctog.on{background:var(--ac2);border-color:var(--ac2)}
  .wcalc .ctdot{width:10px;height:10px;border-radius:50%;background:var(--ink3);transition:.15s}
  .wcalc .ctog.on .ctdot{background:#fff;transform:translateX(12px)}
  .wcalc .cnote{font-size:9px;color:var(--ink3);padding:3px 10px}
  @media (max-width:1080px){.wcalc .cbody{flex-direction:column}.wcalc .cres{width:100%;position:static}.wcalc .cgrid{grid-template-columns:1fr 1fr}.wcalc .s12,.wcalc .s34{grid-column:1/3}.wcalc .s3,.wcalc .s4{grid-column:auto}}
  @media (max-width:680px){.wcalc .cgrid{grid-template-columns:1fr}.wcalc .s12,.wcalc .s34,.wcalc .s3,.wcalc .s4{grid-column:1/-1}}
  </style>`;
}

async function dmcCalculator(active) {
  const main = $('#main'); if (!main) return;
  ensureCalcFonts();
  main.innerHTML = `<div class="center-state">Загрузка каталога…</div>`;
  if (!calcCat) { try { calcCat = await loadCalcCat(); } catch (e) { main.innerHTML = `<div class="notice notice--err">${esc(e.message)}</div>`; return; } }
  if (!calcSt) { calcSt = newCalc(); }
  if (!calcCat.acc.length) { main.innerHTML = `<div class="notice notice--err" style="margin:10px">В каталоге нет отелей/резортов с ценами. Сначала примените сиды каталога и резортов.</div>`; return; }
  calcSync();
  renderCalc(active);
}

function renderCalc(active) {
  const s = calcSt;
  const totSupp = s.stops.reduce((a, st) => a + suppOf(st), 0);
  const stopRows = s.stops.map((st, i) => `<tr>
    <td style="min-width:150px"><select class="cAcc" data-i="${i}">${accOptions(st.accId)}</select></td>
    <td style="width:84px"><input class="cCity" data-i="${i}" value="${esc(st.city || '')}" placeholder="Город"></td>
    <td style="width:40px"><input type="number" min="1" class="cNig" data-i="${i}" value="${st.nights || 1}"></td>
    <td style="width:52px"><input type="number" min="0" class="cTwn" data-i="${i}" value="${st.twin || 0}"></td>
    <td style="width:52px"><input type="number" min="0" class="cSgl" data-i="${i}" value="${st.sgl || 0}"></td>
    <td class="csupp" id="csupp-${i}">${suppTxt(st)}</td>
    <td style="width:18px"><button class="cdel" data-act="delstop" data-i="${i}">×</button></td>
  </tr>`).join('');
  const transRows = s.trans.map((t, i) => `<tr>
    <td style="width:82px"><input class="cro" value="${esc(t.city)}" readonly></td>
    <td style="width:40px"><input class="cro" value="${t.days}" readonly></td>
    <td><select class="cTveh" data-i="${i}">${vehOptions(t.vehId)}</select></td>
    <td style="width:52px"><input type="number" min="0" class="cTpr" data-i="${i}" value="${t.price || 0}"></td>
    <td style="width:50px;font-size:10px;color:var(--ink3)">${t.price && t.days ? '$' + (t.price * t.days) : '—'}</td>
  </tr>`).join('');
  const mealRows = s.meals.map((m, i) => `<tr>
    <td style="width:82px"><input class="cro" value="${esc(m.city)}" readonly></td>
    <td style="width:40px"><input class="cro" value="${m.days}" readonly></td>
    <td style="width:84px"><span class="cbb ${m.fb ? 'on' : ''}" data-act="board" data-i="${i}">${m.fb ? 'Full board' : 'Half board'}</span></td>
    <td style="width:66px"><input type="number" min="0" class="cMpr" data-i="${i}" value="${m.price || 0}" ${m.fb ? '' : 'disabled'}></td>
    <td style="width:56px;font-size:10px;color:var(--ink3)">${m.fb ? '×PAX×' + m.days : '$0'}</td>
  </tr>`).join('');
  const entrRows = s.stops.map(st => { const e = s.entr[st.city] || { desc: '', sum: 0 }; return `<tr>
    <td style="width:78px"><input class="cro" value="${esc(st.city)}" readonly></td>
    <td><input class="cEd" data-city="${esc(st.city)}" value="${esc(e.desc)}" placeholder="Регистан, Биби-Ханым…"></td>
    <td style="width:62px"><input type="number" min="0" class="cEs" data-city="${esc(st.city)}" value="${e.sum || ''}" placeholder="0"></td>
  </tr>`; }).join('');
  const showRows = s.shows.map((sh, i) => `<tr>
    <td><input class="cSn" data-i="${i}" value="${esc(sh.name)}" placeholder="Вечер с музыкой…"></td>
    <td style="width:60px"><input type="number" min="0" class="cSs" data-i="${i}" value="${sh.sum || ''}" placeholder="0"></td>
    <td style="width:18px"><button class="cdel" data-act="delshow" data-i="${i}">×</button></td>
  </tr>`).join('');
  const miscRows = s.misc.map((m, i) => `<tr>
    <td><input class="cMn" data-i="${i}" value="${esc(m.name)}" placeholder="Статья…"></td>
    <td style="width:74px"><input type="number" min="0" class="cMs" data-i="${i}" value="${m.sum || ''}" placeholder="0"></td>
    <td style="width:18px"><button class="cdel" data-act="delmisc" data-i="${i}">×</button></td>
  </tr>`).join('');
  const g = s.guide;

  $('#main').innerHTML = calcStyle() + `<div class="wcalc">
    <div class="ctop">
      <div class="clogo">Waylo<em>·</em>tour</div>
      <div class="csep"></div>
      <input class="ctname" id="cName" value="${esc(s.name)}" placeholder="Название тура…">
      <div class="csep"></div>
      <span class="ctlbl">Прибыль $/чел</span>
      <input type="number" min="0" class="ctprofit" id="cProfit" value="${s.profit}">
      <button class="cgo" id="cCalc">▶ Рассчитать</button>
    </div>
    <div class="cbody">
      <div class="cres">
        <div class="crh"><b>Цена для клиента</b><span>Twin/DBL · 1–39 чел · с прибылью</span></div>
        <div class="crscroll"><table class="crt"><thead><tr><th>Чел</th><th>FOC</th><th>без FOC</th><th>Группа</th></tr></thead>
        <tbody id="cResBody"><tr><td colspan="4" class="crph">Заполните маршрут<br>и нажмите «Рассчитать»</td></tr></tbody></table></div>
        <div class="csave"><input id="cSaveName" placeholder="Название расчёта…"><button id="cSaveBtn">Сохранить</button></div>
      </div>
      <div class="cins"><div class="cgrid">

        <div class="csec s12">
          <div class="csh"><span class="cst"><span class="cnum">01</span>Маршрут · проживание</span></div>
          <table class="ct"><thead><tr><th>Отель / резорт</th><th>Город</th><th>Ноч.</th><th>Twin $</th><th>SGL $</th><th>SGL suppl.</th><th></th></tr></thead>
          <tbody>${stopRows || `<tr><td colspan="7" class="cnote">Добавьте первую локацию маршрута.</td></tr>`}</tbody></table>
          <button class="cadd" data-act="addstop">+ добавить локацию</button>
          <div class="ctotsupp" id="cTotSupp" style="${totSupp > 0 ? 'display:block' : ''}">Single supplement итого: +$${totSupp.toLocaleString('ru')}</div>
        </div>

        <div class="csec s34">
          <div class="csh"><span class="cst"><span class="cnum">02</span>Транспорт</span><span class="cauto">из каталога · по городам</span></div>
          <table class="ct"><thead><tr><th>Город</th><th>Дней</th><th>Класс</th><th>$/день</th><th>Итого</th></tr></thead>
          <tbody>${transRows || `<tr><td colspan="5" class="cnote">—</td></tr>`}</tbody></table>
        </div>

        <div class="csec s12">
          <div class="csh"><span class="cst"><span class="cnum">03</span>Питание</span><span class="cauto">по городам</span></div>
          <table class="ct"><thead><tr><th>Город</th><th>Дней</th><th>Тип</th><th>$/чел/день</th><th>Итого</th></tr></thead>
          <tbody>${mealRows || `<tr><td colspan="5" class="cnote">—</td></tr>`}</tbody></table>
          <div class="cnote">Full board: $/чел/день × PAX × дней. Half board = $0.</div>
        </div>

        <div class="csec s3">
          <div class="csh"><span class="cst"><span class="cnum">04</span>Билеты</span><span class="cauto">по городам</span></div>
          <table class="ct"><thead><tr><th>Город</th><th>Объекты</th><th>$ группа</th></tr></thead>
          <tbody>${entrRows || `<tr><td colspan="3" class="cnote">—</td></tr>`}</tbody></table>
          <div class="cnote">Сумма за группу ÷ PAX.</div>
          <div class="csh" style="border-top:1px solid var(--bd)"><span class="cst"><span class="cnum">06</span>Шоу / мероприятия</span></div>
          <table class="ct"><thead><tr><th>Название</th><th>$ группа</th><th></th></tr></thead>
          <tbody>${showRows || `<tr><td colspan="3" class="cnote">—</td></tr>`}</tbody></table>
          <button class="cadd" data-act="addshow">+ мероприятие</button>
        </div>

        <div class="csec s4">
          <div class="csh"><span class="cst"><span class="cnum">05</span>Гид</span></div>
          <div class="cg">
            <div class="cgrow"><div class="cgl">Гонорар $/день</div><input type="number" min="0" id="gFee" value="${g.fee}"></div>
            <div class="cgrow"><div class="cgl">Транспорт $</div><input type="number" min="0" id="gTr" value="${g.transport}"></div>
            <div class="cgrow"><div class="cgl">Питание $/день</div><div class="cgv"><div class="ctog ${g.mealOn ? 'on' : ''}" data-act="gmeal"><div class="ctdot"></div></div><input type="number" min="0" id="gMeal" value="${g.meal}" ${g.mealOn ? '' : 'disabled'}></div></div>
            <div class="cgrow"><div class="cgl">Прожив. $/ночь</div><div class="cgv"><div class="ctog ${g.hotelOn ? 'on' : ''}" data-act="ghotel"><div class="ctdot"></div></div><input type="number" min="0" id="gHotel" value="${g.hotel}" ${g.hotelOn ? '' : 'disabled'}></div></div>
          </div>
          <div class="csh" style="border-top:1px solid var(--bd)"><span class="cst"><span class="cnum">07</span>Прочие расходы</span></div>
          <table class="ct"><thead><tr><th>Статья</th><th>$ группа</th><th></th></tr></thead>
          <tbody>${miscRows}</tbody></table>
          <button class="cadd" data-act="addmisc">+ статья</button>
          <div class="cnote" style="padding-bottom:4px">Все суммы — за всю группу.</div>
        </div>

      </div></div>
    </div>
  </div>`;

  bindCalc(active);
}

function bindCalc(active) {
  const root = $('.wcalc'); if (!root) return;
  const s = calcSt;
  const accById = {}; calcCat.acc.forEach(a => accById[a.id] = a);
  const reflow = () => { calcSync(); renderCalc(active); };
  const updSupp = (i) => {
    const el = document.getElementById('csupp-' + i); if (el) el.textContent = suppTxt(s.stops[i]);
    const tot = s.stops.reduce((a, st) => a + suppOf(st), 0);
    const te = document.getElementById('cTotSupp'); if (te) { te.textContent = 'Single supplement итого: +$' + tot.toLocaleString('ru'); te.style.display = tot > 0 ? 'block' : 'none'; }
  };

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, i = +el.dataset.i;
    if (act === 'addstop') { s.stops.push({ accId: '', city: '', nights: 1, twin: 0, sgl: 0 }); reflow(); }
    else if (act === 'delstop') { s.stops.splice(i, 1); reflow(); }
    else if (act === 'board') { s.meals[i].fb = !s.meals[i].fb; if (!s.meals[i].fb) s.meals[i].price = 0; renderCalc(active); }
    else if (act === 'addshow') { s.shows.push({ name: '', sum: 0 }); renderCalc(active); }
    else if (act === 'delshow') { s.shows.splice(i, 1); renderCalc(active); }
    else if (act === 'addmisc') { s.misc.push({ name: '', sum: 0 }); renderCalc(active); }
    else if (act === 'delmisc') { s.misc.splice(i, 1); renderCalc(active); }
    else if (act === 'gmeal') { s.guide.mealOn = !s.guide.mealOn; if (!s.guide.mealOn) s.guide.meal = 0; renderCalc(active); }
    else if (act === 'ghotel') { s.guide.hotelOn = !s.guide.hotelOn; if (!s.guide.hotelOn) s.guide.hotel = 0; renderCalc(active); }
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('cAcc')) {
      const a = accById[t.value]; const st = s.stops[+t.dataset.i];
      if (a) { st.accId = a.id; st.city = a.city; st.twin = a.twin; st.sgl = a.sgl; } else { st.accId = ''; }
      reflow();
    } else if (t.classList.contains('cTveh')) {
      const v = calcCat.veh.find(x => x.id === t.value); const tr = s.trans[+t.dataset.i];
      if (v) { tr.vehId = v.id; tr.price = v.day; } else { tr.vehId = ''; }
      renderCalc(active);
    } else if (t.classList.contains('cNig') || t.classList.contains('cCity')) {
      reflow();
    }
  });

  root.addEventListener('input', (e) => {
    const t = e.target, v = t.value;
    if (t.id === 'cName') s.name = v;
    else if (t.id === 'cProfit') s.profit = +v || 0;
    else if (t.classList.contains('cCity')) { s.stops[+t.dataset.i].city = v; }
    else if (t.classList.contains('cNig')) { s.stops[+t.dataset.i].nights = +v || 1; updSupp(+t.dataset.i); }
    else if (t.classList.contains('cTwn')) { s.stops[+t.dataset.i].twin = +v || 0; updSupp(+t.dataset.i); }
    else if (t.classList.contains('cSgl')) { s.stops[+t.dataset.i].sgl = +v || 0; updSupp(+t.dataset.i); }
    else if (t.classList.contains('cTpr')) { s.trans[+t.dataset.i].price = +v || 0; }
    else if (t.classList.contains('cMpr')) { s.meals[+t.dataset.i].price = +v || 0; }
    else if (t.classList.contains('cEd')) { (s.entr[t.dataset.city] = s.entr[t.dataset.city] || { desc: '', sum: 0 }).desc = v; }
    else if (t.classList.contains('cEs')) { (s.entr[t.dataset.city] = s.entr[t.dataset.city] || { desc: '', sum: 0 }).sum = +v || 0; }
    else if (t.classList.contains('cSn')) { s.shows[+t.dataset.i].name = v; }
    else if (t.classList.contains('cSs')) { s.shows[+t.dataset.i].sum = +v || 0; }
    else if (t.classList.contains('cMn')) { s.misc[+t.dataset.i].name = v; }
    else if (t.classList.contains('cMs')) { s.misc[+t.dataset.i].sum = +v || 0; }
    else if (t.id === 'gFee') s.guide.fee = +v || 0;
    else if (t.id === 'gTr') s.guide.transport = +v || 0;
    else if (t.id === 'gMeal') s.guide.meal = +v || 0;
    else if (t.id === 'gHotel') s.guide.hotel = +v || 0;
  });

  $('#cCalc').onclick = () => calcCompute();
  $('#cSaveBtn').onclick = () => calcSave();
}

function calcCompute() {
  const s = calcSt;
  calcSync();
  const tn = s.stops.reduce((a, st) => a + (st.nights || 0), 0);
  if (!tn) return;
  const td = tn + 1;
  const profit = s.profit || 0;
  const transFixed = s.trans.reduce((a, t) => a + (t.price || 0) * (t.days || 0), 0);
  const guideFixed = (s.guide.fee || 0) * td + (s.guide.transport || 0)
    + (s.guide.mealOn ? (s.guide.meal || 0) * td : 0) + (s.guide.hotelOn ? (s.guide.hotel || 0) * tn : 0);
  const showsFixed = s.shows.reduce((a, x) => a + (x.sum || 0), 0);
  const miscFixed = s.misc.reduce((a, x) => a + (x.sum || 0), 0);
  const entrFixed = Object.values(s.entr).reduce((a, x) => a + (x.sum || 0), 0);
  const totalFixed = transFixed + guideFixed + showsFixed + miscFixed + entrFixed;
  const mealPerPax = s.meals.reduce((a, m) => a + (m.fb ? (m.price || 0) * (m.days || 0) : 0), 0);
  const hotelSgl1 = s.stops.reduce((a, st) => a + (st.sgl || 0) * (st.nights || 0), 0);
  const hotelCost = (pax) => s.stops.reduce((a, st) => a + Math.ceil(pax / 2) * (st.twin || 0) * (st.nights || 0), 0);

  let minCpp = Infinity, bestPax = 1;
  for (let p = 1; p <= 39; p++) { const cpp = (hotelCost(p) + mealPerPax * p + totalFixed) / p + profit; if (cpp < minCpp) { minCpp = cpp; bestPax = p; } }

  let html = '';
  for (let pax = 1; pax <= 39; pax++) {
    const cost = hotelCost(pax) + mealPerPax * pax + totalFixed;
    const noFoc = cost / pax + profit;
    const foc = noFoc + (hotelSgl1 + mealPerPax * pax + entrFixed) / pax;
    const grp = noFoc * pax;
    html += `<tr class="${pax === bestPax ? 'best' : ''}"><td>${pax}</td><td class="cfoc">$${Math.round(foc).toLocaleString('ru')}</td><td class="cnf">$${Math.round(noFoc).toLocaleString('ru')}</td><td class="cgp">$${Math.round(grp).toLocaleString('ru')}</td></tr>`;
  }
  const body = $('#cResBody'); if (body) body.innerHTML = html;
}

function calcSave() {
  const s = calcSt;
  const name = ($('#cSaveName') && $('#cSaveName').value.trim()) || s.name.trim();
  if (!name) { alert('Введите название расчёта.'); return; }
  try {
    const key = 'waylo_calc_' + Date.now();
    const list = JSON.parse(localStorage.getItem('waylo_calc_index') || '[]');
    list.unshift({ key, name, at: new Date().toISOString() });
    localStorage.setItem('waylo_calc_index', JSON.stringify(list));
    localStorage.setItem(key, JSON.stringify({ name, state: s }));
    if ($('#cSaveName')) $('#cSaveName').value = '';
    alert('Расчёт «' + name + '» сохранён.');
  } catch (e) { alert('Не удалось сохранить: ' + e.message); }
}
boot();
