/* waylo build 2026-06-26 v4 · coach-hints (Grok via Edge Fn) + auth-fix */
/* ===========================================================================
   НАСТРОЙКА: вставь свой anon-ключ (Supabase → Settings → API → anon public).
   anon-ключ публичный и безопасный для клиента — доступ к данным режет RLS.
   =========================================================================== */
const SUPABASE_URL = "https://rfxenahasipffiuommvx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmeGVuYWhhc2lwZmZpdW9tbXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDE3NTEsImV4cCI6MjA5NjcxNzc1MX0.4inQoQjNxBmpn_zsuJj6cdW283-kzTGB-TCj14G1KYw";

const app = document.getElementById('app');

// lock:noLock убирает зависания supabase-js (межвкладочный navigator.locks).
// С ним сессию можно безопасно хранить — persistSession:true, чтобы НЕ выкидывать
// из кабинета при обновлении страницы. autoRefreshToken НЕ включаем — он вешал supabase-js.
const noLock = async (_name, _timeout, fn) => await fn();
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { lock: noLock, persistSession: true, autoRefreshToken: false, detectSessionInUrl: true },
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
let _firstAuth = false;
let loginMode = 'signin';
let pendingOnboard = null;  // {name,type,country} | null — намерение создать компанию при регистрации

async function loadProfile() {
  const { data: mems } = await db.from('membership').select('role, org_id, organization(id,type,name,country)');
  const { data: plt } = await db.from('platform_operator').select('user_id');
  const platform = (plt || []).length > 0;
  const ctx = (mems || []).map(m => ({ key:m.org_id, kind:'org', orgId:m.org_id, orgType:m.organization?.type, orgName:m.organization?.name, role:m.role }));
  if (platform) ctx.unshift({ key:'platform', kind:'platform', orgName:'Waylo', orgType:'PLATFORM', role:'operator' });
  state.contexts = ctx; state.isPlatform = platform;
  if (!ctx.find(c => c.key === state.activeKey)) state.activeKey = ctx[0]?.key || null;
}

function boot() {
  // Показываем экран сразу. Сохранённую сессию подхватит onAuthStateChange
  // (событие INITIAL_SESSION) и догрузит кабинет. Страница не виснет на «Загрузка…».
  render();
}

// Жёсткий таймаут на любой сетевой/auth-вызов. Гарантия: UI НИКОГДА не зависнет
// навсегда — вместо вечного «Входим…» покажем ошибку и вернём рабочую форму.
function withTimeout(p, ms, label) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('Превышено время ожидания: ' + label + '. Проверьте соединение и попробуйте снова.')), ms)),
  ]);
}
function readOnboard() {
  if (pendingOnboard) return pendingOnboard;
  try { return JSON.parse(localStorage.getItem('waylo_onboard') || 'null'); } catch (_e) { return null; }
}
function clearOnboard() { pendingOnboard = null; try { localStorage.removeItem('waylo_onboard'); } catch (_e) {} }

let _authUid = null;     // id уже загруженного пользователя (защита от задвоения)
let _entering = false;   // идёт вход прямо сейчас (защита от гонок)
let _loginError = null;  // текст ошибки для экрана входа

// Единая идемпотентная точка входа в кабинет. Вызывается НАПРЯМУЮ из обработчика
// кнопки (детерминированно, по результату signInWithPassword) и из
// onAuthStateChange (восстановление сессии при перезагрузке и возврат после Google).
// Защиты _authUid/_entering исключают двойную работу и гонки между этими путями.
async function enterApp(user) {
  if (!user) return;
  if (_authUid === user.id && state.contexts.length) { state.user = user; return; }
  if (_entering) return;
  _entering = true; _firstAuth = true;
  state.user = user; state.tab = null; state.openReq = null;
  try {
    try { await withTimeout(db.rpc('accept_pending_invites'), 8000, 'приглашения'); } catch (_e) {}
    await withTimeout(loadProfile(), 12000, 'загрузка профиля');
    // нет организации, но есть намерение зарегистрировать компанию → создаём её
    if (!state.contexts.length) {
      const intent = readOnboard();
      if (intent && intent.name) {
        try { await withTimeout(db.rpc('onboard_organization', { p_name: intent.name, p_type: intent.type, p_country: intent.country, p_city: intent.city }), 12000, 'создание компании'); } catch (_e) {}
        clearOnboard();
        await withTimeout(loadProfile(), 12000, 'загрузка профиля');
      }
    }
    _authUid = user.id; _loginError = null;
  } catch (e) {
    // Профиль не загрузился — НЕ виснем: сбрасываем и показываем форму с ошибкой.
    _authUid = null; state.user = null; state.contexts = []; state.isPlatform = false;
    _loginError = (e && e.message) || String(e);
  } finally {
    _entering = false;
  }
  render();
}

db.auth.onAuthStateChange((_e, session) => {
  // ВАЖНО: тело откладываем через setTimeout(0), чтобы выйти из контекста
  // блокировки GoTrue. Вызовы db.* прямо внутри колбэка onAuthStateChange — главная
  // фундаментальная причина «вечных» зависаний supabase-js; так deadlock исключён.
  setTimeout(() => {
    const user = session?.user || null;
    if (!user) {                                  // выход / нет сессии
      _authUid = null; clearOnboard();
      state.user = null; state.contexts = []; state.isPlatform = false;
      state.activeKey = null; state.tab = null; state.openReq = null;
      _firstAuth = true; render(); return;
    }
    // INITIAL_SESSION (перезагрузка) или SIGNED_IN (возврат после Google).
    // Интерактивный вход по паролю уже вызвал enterApp напрямую — здесь сработает
    // защита _authUid и повторной работы не будет.
    enterApp(user);
  }, 0);
});

function render() { state.user ? renderShell() : renderLogin(); }

/* ── login ───────────────────────────────────────────────────────────────── */
function renderLogin() {
  if (loginMode === 'signup') return renderSignup();
  const SEGMENTS = [
    { key:'agency',      label:'Travel Agency', sub:'Турагентства и DMC (Казахстан) — заявки, маршруты, документы, статусы.', email:'dmc@waylo.test' },
    { key:'hospitality', label:'Hospitality',   sub:'Отели и резорты — подтверждения, доступность, цены.',                 email:'hotel@waylo.test' },
    { key:'transfer',    label:'Transfer',      sub:'Перевозчики — автопарк, доступность, подтверждения.',                 email:'transfer@waylo.test' },
  ];
  let seg = SEGMENTS[0];
  app.innerHTML = `
    <div class="login-wrap"><form class="login-card" id="loginForm">
      <div class="brand">Waylo</div>
      <div class="tag">Операционный коридор · вход в кабинет</div>
      <div class="field"><label>Кто вы?</label>
        <select class="input" id="segSel" style="width:100%">${SEGMENTS.map(s => `<option value="${s.key}" ${s.key===seg.key?'selected':''}>${esc(s.label)}</option>`).join('')}</select>
      </div>
      <div class="seg-sub" id="segSub">${esc(seg.sub)}</div>
      <div class="field"><label>Почта</label><input type="email" id="email" autocomplete="username" placeholder="you@company.com" value="${seg.email}" required></div>
      <div class="field"><label>Пароль</label><input type="password" id="password" autocomplete="current-password" required></div>
      <div id="loginErr">${_loginError ? `<div class="notice notice--err">${esc(_loginError)}</div>` : ''}</div>
      <button class="btn btn--primary" id="loginBtn">Войти</button>
      <button type="button" class="btn btn--ghost" id="googleBtn" style="width:100%;justify-content:center;display:flex;margin-top:8px">Войти через Google</button>
      <div class="login-creds">Тест (пароль <code>waylo-test-pass</code>): <code id="segCred">${esc(seg.email)}</code></div>
      <div class="op-link">Оператор Waylo — <a id="opLink">platform@waylo.test</a></div>
      <div class="op-link" style="margin-top:6px">Впервые здесь? <a id="toSignup">Регистрация компании →</a></div>
    </form></div>`;
  const pick = (s) => {
    seg = s;
    $('#segSub').textContent = s.sub;
    $('#segCred').textContent = s.email;
    $('#email').value = s.email;
  };
  $('#segSel').onchange = () => pick(SEGMENTS.find(x => x.key === $('#segSel').value));
  $('#opLink').onclick = () => { $('#email').value = 'platform@waylo.test'; $('#segCred').textContent = 'platform@waylo.test'; };
  $('#toSignup').onclick = () => { loginMode = 'signup'; renderLogin(); };
  const gb = $('#googleBtn'); if (gb) gb.onclick = () => googleSignIn(null);
  coach('login');
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    _loginError = null;
    const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'Входим…';
    try {
      const { data, error } = await withTimeout(
        db.auth.signInWithPassword({ email: $('#email').value, password: $('#password').value }), 15000, 'вход');
      if (error) throw error;
      await enterApp(data.user);   // детерминированный переход в кабинет, без ожидания события
    } catch (err) {
      _loginError = (err && err.message) || String(err);
      render();                    // вернуть форму с ошибкой и рабочей кнопкой
    }
  };
}

/* ── регистрация: новая компания или вход по приглашению ────────────────────
   Пользователь выбирает тип компании (DMC-клиент / Отель-резорт / Транспорт).
   После входа: если есть приглашение в существующую организацию — оно
   принимается (accept_pending_invites), а введённые тип/название игнорируются.
   Иначе создаётся новая организация выбранного типа через RPC
   onboard_organization, и регистрант становится её суперадмином. */
function renderSignup() {
  app.innerHTML = `
    <div class="login-wrap"><form class="login-card" id="suForm">
      <div class="brand">Waylo</div>
      <div class="tag">Регистрация компании</div>
      <div class="seg-sub">Выберите, кто вы — создадим кабинет нужного типа, вы станете суперадмином. Если вас пригласили в существующую компанию, доступ выдастся по приглашению автоматически (тип и название можно не трогать).</div>
      <div class="field"><label>Тип компании</label>
        <select class="input" id="suType">
          <option value="DMC">DMC / турагентство</option>
          <option value="HOTEL">Отель / резорт</option>
          <option value="TRANSPORT">Транспортная компания</option>
        </select>
      </div>
      <div class="field"><label>Название компании</label><input class="input" id="suName" placeholder="Например: Silk Road DMC"></div>
      <div class="field"><label>Страна</label><input class="input" id="suCountry" placeholder="KZ / UZ"></div>
      <div class="field"><label>Город</label><input class="input" id="suCity" placeholder="Например: Ташкент"></div>
      <div class="field"><label>Почта</label><input type="email" id="suEmail" autocomplete="username" placeholder="you@company.com" required></div>
      <div class="field"><label>Пароль</label><input type="password" id="suPass" autocomplete="new-password" placeholder="не менее 6 символов" required></div>
      <div class="field"><label>Повтор пароля</label><input type="password" id="suPass2" autocomplete="new-password" required></div>
      <div id="suErr"></div>
      <button class="btn btn--primary" id="suBtn">Зарегистрироваться</button>
      <button type="button" class="btn btn--ghost" id="suGoogleBtn" style="width:100%;justify-content:center;display:flex;margin-top:8px">Зарегистрировать через Google</button>
      <div class="op-link" style="margin-top:8px"><a id="toSignin">← Уже есть аккаунт? Войти</a></div>
    </form></div>`;
  $('#toSignin').onclick = () => { loginMode = 'signin'; renderLogin(); };
  coach('signup');
  const sug = $('#suGoogleBtn'); if (sug) sug.onclick = () => {
    const nm = ($('#suName').value || '').trim();
    if (!nm) { $('#suErr').innerHTML = `<div class="notice notice--err">Для регистрации через Google укажите название компании.</div>`; return; }
    googleSignIn({ name: nm, type: $('#suType').value, country: ($('#suCountry').value||'').trim()||null, city: ($('#suCity').value||'').trim()||null });
  };
  $('#suForm').onsubmit = async (e) => {
    e.preventDefault();
    const type = $('#suType').value;
    const name = ($('#suName').value || '').trim();
    const country = ($('#suCountry').value || '').trim() || null;
    const city = ($('#suCity').value || '').trim() || null;
    const email = ($('#suEmail').value || '').trim().toLowerCase();
    const p1 = $('#suPass').value, p2 = $('#suPass2').value;
    if (!name) { $('#suErr').innerHTML = `<div class="notice notice--err">Укажите название компании (или, если вас пригласили, попросите суперадмина пригласить именно этот email).</div>`; return; }
    if (p1.length < 6) { $('#suErr').innerHTML = `<div class="notice notice--err">Пароль не короче 6 символов.</div>`; return; }
    if (p1 !== p2) { $('#suErr').innerHTML = `<div class="notice notice--err">Пароли не совпадают.</div>`; return; }
    const btn = $('#suBtn'); btn.disabled = true; btn.textContent = 'Регистрируем…';
    // намерение создать компанию: применится после входа, только если приглашения нет
    const intent = { name, type, country, city };
    pendingOnboard = intent;
    try { localStorage.setItem('waylo_onboard', JSON.stringify(intent)); } catch (_e) {}
    try {
      const { data, error } = await withTimeout(db.auth.signUp({ email, password: p1 }), 15000, 'регистрация');
      if (error) throw error;
      if (data && data.session) {
        const { data: d2, error: e2 } = await withTimeout(
          db.auth.signInWithPassword({ email, password: p1 }), 15000, 'вход');
        if (e2) throw e2;
        await enterApp(d2.user);   // создаст компанию (pendingOnboard) и откроет кабинет
      } else {
        clearOnboard();
        $('#suErr').innerHTML = `<div class="notice">Аккаунт создан. Подтвердите почту по ссылке из письма, затем войдите.</div>`;
        btn.disabled = false; btn.textContent = 'Зарегистрироваться';
        loginMode = 'signin';
      }
    } catch (err) {
      clearOnboard();
      $('#suErr').innerHTML = `<div class="notice notice--err">${esc((err && err.message) || String(err))}</div>`;
      btn.disabled = false; btn.textContent = 'Зарегистрироваться';
    }
  };
}

async function googleSignIn(intent) {
  try { if (intent && intent.name) localStorage.setItem('waylo_onboard', JSON.stringify(intent)); else localStorage.removeItem('waylo_onboard'); } catch (_e) {}
  const redirectTo = location.href.split('#')[0].split('?')[0];
  const { error } = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) alert('Google: ' + error.message);
}

/* ── shell ───────────────────────────────────────────────────────────────── */
function renderShell() {
  const active = state.contexts.find(c => c.key === state.activeKey);
  const roleLabel = { superadmin:'суперадмин', admin:'админ', operator:'оператор' };
  const tag = active && active.orgName ? active.orgName.replace(/[^A-Za-zА-Яа-я0-9]/g, '').slice(0, 2).toUpperCase() : 'W';
  app.innerHTML = `
    <div class="appwrap">
      <aside class="sidebar">
        <div class="side-brand">Waylo</div>
        <div class="side-cab">
          ${state.contexts.length > 1 ? `<select id="orgSel" class="input">${state.contexts.map(c => `<option value="${c.key}" ${c.key===state.activeKey?'selected':''}>${esc(c.orgName)}${c.kind==='org'?` · ${c.orgType}`:''}</option>`).join('')}</select>` : ''}
          ${active ? `<div class="org-chip"><div class="org-tag">${esc(tag)}</div><div class="org-meta"><div class="org-name">${esc(active.orgName||'')}</div><div class="org-role">${esc(roleLabel[active.role]||active.role||'')}</div></div></div>` : ''}
        </div>
        <nav class="side-nav" id="navlist"></nav>
        <button class="side-logout" id="logout"><span class="dot"></span>Выйти из кабинета</button>
      </aside>
      <main class="appmain">
        <header class="apphead" id="apphead"></header>
        <div class="appcontent" id="content"><div id="main"><div class="center-state">Загрузка…</div></div></div>
      </main>
    </div>`;
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
  const nav = document.getElementById('navlist');
  if (nav) {
    nav.innerHTML = tabs.map(t => `<button data-tab="${t.id}" class="${state.tab===t.id?'active':''}"><span class="ndot"></span>${esc(t.label)}</button>`).join('');
    nav.querySelectorAll('button[data-tab]').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; state.openReq = null; renderCabinet(); });
  }
  const head = document.getElementById('apphead');
  if (head) {
    head.innerHTML = `<div><div class="ah-title">${esc(kicker)}</div></div><div class="ah-right"><button id="hintsToggle" class="coach-toggle${_hintsOn ? '' : ' off'}" title="Подсказки по заполнению">💡 <span>${_hintsOn ? 'Подсказки' : 'Подсказки выкл'}</span></button><span class="user-email">${esc(state.user?.email || '')}</span></div>`;
    const ht = document.getElementById('hintsToggle');
    if (ht) ht.onclick = () => {
      _hintsOn = !_hintsOn;
      try { localStorage.setItem('waylo_hints', _hintsOn ? 'on' : 'off'); } catch (_e) {}
      ht.classList.toggle('off', !_hintsOn);
      ht.querySelector('span').textContent = _hintsOn ? 'Подсказки' : 'Подсказки выкл';
      if (_hintsOn) { _coachSeen.delete(coachKey(state.tab)); coach(state.tab); } else clearToasts();
    };
  }
  const main = document.getElementById('main');
  if (main) main.innerHTML = `<div class="center-state">Загрузка…</div>`;
  coach(state.tab);
}

/* ── Coach: всплывающие подсказки на каждом шаге ─────────────────────────────
   База показывается мгновенно (оффлайн), затем Grok (через Edge Function
   waylo-hints) может улучшить текст. Если AI недоступен — остаётся база.
   Каждая подсказка появляется один раз за сессию на экран. */
let _hintsOn = (function () { try { return localStorage.getItem('waylo_hints') !== 'off'; } catch (_e) { return true; } })();
const _coachSeen = new Set();
let _toastSeq = 0;

const HINTS = {
  'guest/signup': { title: 'Регистрация компании', text: 'Выберите тип компании — создадим кабинет, вы станете суперадмином. Если вас уже пригласили в существующую компанию, доступ выдастся автоматически по вашему email (название можно не трогать).' },
  'guest/login':  { title: 'Вход в Waylo', text: 'Выберите, кто вы (турагентство, отель или перевозчик), и войдите по почте. Впервые здесь — нажмите «Регистрация компании».' },

  'DMC/dash':     { title: 'С чего начать', text: 'Это сводка по вашим турам и статусам. Чтобы собрать новый тур, откройте «Каталог» и добавьте отели и трансферы.' },
  'DMC/catalog':  { title: 'Каталог поставщиков', text: 'Отели и трансферы с ценой к продаже. Кликните по фото объекта — откроется галерея. Себестоимость поставщика скрыта.' },
  'DMC/calc':     { title: 'Калькулятор тура', text: 'Укажите даты, номера и трансферы — справа считается цена к продаже. При оформлении система захолдирует места у поставщика, чтобы их не заняли.' },
  'DMC/requests': { title: 'Ваши туры', text: 'Собранные заявки и их статусы. Откройте тур, чтобы увидеть состав, оплату и ваучер.' },
  'DMC/pay':      { title: 'Оплаты', text: 'Счета по заявкам. Важно: поставщик подтвердит бронь только после оплаты — оплатите здесь и приложите подтверждение.' },
  'DMC/finance':  { title: 'Финансы', text: 'История платежей и баланс по вашим турам.' },

  'HOTEL/cats':     { title: 'Объекты и категории', text: 'Сначала заведите объект (здание/резорт), затем добавьте категории номеров с вместимостью и дефолт-доступностью. Фото — до 10 с диска. Цены задаёт платформа отдельно.' },
  'HOTEL/avail':    { title: 'Доступность', text: 'Сколько номеров каждой категории свободно по датам. Пусто = берётся дефолт-доступность категории. Меняйте остаток на конкретные дни, чтобы не было овербукинга.' },
  'HOTEL/bookings': { title: 'Шахматка броней', text: 'Брони и временные холды по дням — видно реальную загрузку. Так вы избегаете двойных продаж одного номера.' },
  'HOTEL/confirm':  { title: 'Подтверждения', text: 'Заявки от DMC. Подтвердить можно только после оплаты — об этом скажет плашка. После подтверждения DMC получает ваучер.' },
  'HOTEL/finance':  { title: 'Финансы', text: 'Начисления и взаиморасчёты с платформой по подтверждённым заявкам.' },
  'HOTEL/team':     { title: 'Команда', text: 'Пригласите сотрудников по email. Суперадмин выдаёт права админа. Каждый входит под своей почтой — общий аккаунт не нужен.' },

  'TRANSPORT/fleet':   { title: 'Автопарк', text: 'Добавьте классы машин (седан, минивэн, автобус…) с вместимостью pax. Тарифы задаёт платформа.' },
  'TRANSPORT/avail':   { title: 'Доступность транспорта', text: 'Укажите, сколько машин каждого класса свободно по датам и городам — иначе класс не получится забронировать.' },
  'TRANSPORT/confirm': { title: 'Подтверждения', text: 'Заявки на трансферы от DMC. Подтверждайте после оплаты.' },

  'platform/orgs':     { title: 'Организации', text: 'Все компании контура. Здесь онбордите участников и управляете доступом.' },
  'platform/pricing':  { title: 'Цены', text: 'Задайте цену к продаже для категорий и трансферов. Без цены объект не виден в каталоге DMC.' },
  'platform/payments': { title: 'Оплаты', text: 'Входящие платежи DMC. Подтверждение брони поставщиком открывается только после оплаты.' },
  'platform/recon':    { title: 'Сверка', text: 'Сверяйте начисления поставщикам и поступления от DMC.' },
  'platform/log':      { title: 'Журнал', text: 'Неизменяемая история событий контура — кто и что менял.' },
};

function coachRole() {
  const active = state.contexts.find(c => c.key === state.activeKey);
  if (!active) return 'guest';
  return active.kind === 'platform' ? 'platform' : (active.orgType || 'guest');
}
function coachKey(screen) { return coachRole() + '/' + screen; }

function coach(screen) {
  if (!_hintsOn || !screen) return;
  const key = coachKey(screen);
  const base = HINTS[key];
  if (!base || _coachSeen.has(key)) return;
  _coachSeen.add(key);
  const id = showToast(base.title, base.text, false);
  grokHint(coachRole(), screen, base.text).then(h => { if (h && _hintsOn) updateToast(id, base.title, h, true); });
}

async function grokHint(role, screen, base) {
  try {
    const r = await withTimeout(fetch(`${SUPABASE_URL}/functions/v1/waylo-hints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ role, screen, base }),
    }), 6000, 'подсказка');
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.hint ? String(j.hint).trim() : null;
  } catch (_e) { return null; }
}

function ensureCoachUI() {
  if (document.getElementById('coachStack')) return;
  const st = document.createElement('style');
  st.textContent = `
  #coachStack{position:fixed;right:18px;bottom:18px;z-index:9999;display:flex;flex-direction:column;gap:10px;max-width:340px}
  .coach-toast{background:var(--surface,#fff);border:1px solid var(--line,#e6e9e8);border-left:4px solid var(--accent,#0f766e);border-radius:12px;box-shadow:0 8px 28px rgba(20,33,29,.16);padding:13px 14px;animation:coachIn .25s ease;font-family:var(--sans,system-ui)}
  @keyframes coachIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  .coach-toast .ct-head{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13.5px;color:var(--ink,#17211d);margin-bottom:4px}
  .coach-toast .ct-ai{margin-left:auto;font-size:9.5px;font-weight:700;letter-spacing:.04em;color:var(--accent-ink,#0a544e);background:var(--accent-soft,#e3f1ee);border-radius:6px;padding:1px 6px}
  .coach-toast .ct-x{margin-left:6px;cursor:pointer;border:none;background:none;color:var(--muted,#76847e);font-size:16px;line-height:1;padding:0}
  .coach-toast .ct-body{font-size:12.8px;line-height:1.5;color:var(--ink-2,#3c4a44)}
  .coach-toggle{font:inherit;font-size:12.5px;font-weight:600;border:1px solid var(--line,#e6e9e8);background:var(--surface,#fff);color:var(--ink-2,#3c4a44);border-radius:9px;padding:6px 11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
  .coach-toggle.off{opacity:.55}`;
  document.head.appendChild(st);
  const div = document.createElement('div');
  div.id = 'coachStack';
  document.body.appendChild(div);
}
function clearToasts() { const s = document.getElementById('coachStack'); if (s) s.innerHTML = ''; }
function showToast(title, text, ai) {
  ensureCoachUI();
  const stack = document.getElementById('coachStack');
  const id = 'ct' + (++_toastSeq);
  const el = document.createElement('div');
  el.className = 'coach-toast'; el.id = id;
  el.innerHTML = `<div class="ct-head">💡 <span>${esc(title)}</span>${ai ? '<span class="ct-ai">AI</span>' : ''}<button class="ct-x" title="Закрыть">×</button></div><div class="ct-body">${esc(text)}</div>`;
  el.querySelector('.ct-x').onclick = () => el.remove();
  stack.appendChild(el);
  el._timer = setTimeout(() => el.remove(), 15000);
  return id;
}
function updateToast(id, title, text, ai) {
  const el = document.getElementById(id);
  if (!el) { showToast(title, text, ai); return; }
  clearTimeout(el._timer);
  el.querySelector('.ct-head').innerHTML = `💡 <span>${esc(title)}</span>${ai ? '<span class="ct-ai">AI</span>' : ''}<button class="ct-x" title="Закрыть">×</button>`;
  el.querySelector('.ct-body').textContent = text;
  el.querySelector('.ct-x').onclick = () => el.remove();
  el._timer = setTimeout(() => el.remove(), 17000);
}

/* ── DMC ─────────────────────────────────────────────────────────────────── */
async function renderDmc(active) {
  if (!state.tab || !['dash','catalog','requests','pay','finance'].includes(state.tab)) state.tab = 'dash';
  navShell('DMC · ' + active.orgName, [
    { id:'dash', label:'Дашборд' },
    { id:'catalog', label:'Каталог' },
    { id:'requests', label:'Туры' },
    { id:'pay', label:'Оплаты' },
    { id:'finance', label:'Финансы' },
  ]);
  if (state.tab === 'dash') dmcDashboard(active);
  else if (state.tab === 'catalog') dmcCatalog();
  else if (state.tab === 'pay') dmcPayments(active);
  else if (state.tab === 'finance') dmcFinance(active);
  else dmcRequests(active);
}

/* ── DMC · Дашборд (Atlas, на реальных данных) ───────────────────────────────*/
async function dmcDashboard(active) {
  const main = $('#main'); if (!main) return;
  const { data: reqs } = await db.from('request')
    .select('id,name,client_name,status,payment_code,currency,pax_count,created_at')
    .eq('dmc_org_id', active.orgId).order('created_at', { ascending: false });
  const ids = (reqs || []).map(r => r.id);
  const [{ data: lines }, { data: events }] = await Promise.all([
    ids.length ? db.from('request_line').select('request_id,sell_price,quantity,from_date,to_date,confirmation').in('request_id', ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from('payment_event').select('request_id,amount,status').in('request_id', ids) : Promise.resolve({ data: [] }),
  ]);
  const nights = (l) => Math.max(1, Math.round((new Date(l.to_date) - new Date(l.from_date)) / 86400000));
  const linesBy = {}; (lines || []).forEach(l => { (linesBy[l.request_id] = linesBy[l.request_id] || []).push(l); });
  const paidBy = {}; (events || []).forEach(e => { if (e.status === 'paid') paidBy[e.request_id] = (paidBy[e.request_id] || 0) + Number(e.amount || 0); });
  const sumOf = (id) => (linesBy[id] || []).reduce((s, l) => s + Number(l.sell_price || 0) * l.quantity * nights(l), 0);
  const confOf = (id) => { const ls = linesBy[id] || []; if (!ls.length) return 'none'; const c = ls.filter(l => l.confirmation === 'confirmed').length; return c === 0 ? 'none' : c === ls.length ? 'all' : 'part'; };
  const list = reqs || [];
  const cur = (list[0] && list[0].currency) || 'USD';
  const kAwaiting = list.filter(r => r.payment_code && (paidBy[r.id] || 0) < sumOf(r.id)).length;
  const kPaid = list.filter(r => sumOf(r.id) > 0 && (paidBy[r.id] || 0) >= sumOf(r.id)).length;
  const kPipeline = list.reduce((s, r) => s + sumOf(r.id), 0);

  const actions = [];
  list.forEach(r => {
    const sum = sumOf(r.id), paid = paidBy[r.id] || 0;
    if (sum > 0 && !r.payment_code) actions.push({ issue: 'Выставить счёт клиенту', code: r.name || '—', who: r.client_name || '', dot: 'var(--blue)', act: 'К оплатам' });
    else if (r.payment_code && paid < sum) actions.push({ issue: 'Ожидает оплаты', code: r.name || '—', who: r.client_name || '', dot: 'var(--amber)', act: 'Открыть' });
    else if (sum > 0 && paid >= sum && confOf(r.id) !== 'all') actions.push({ issue: 'Ждёт подтверждения поставщика', code: r.name || '—', who: r.client_name || '', dot: 'var(--accent)', act: 'Открыть' });
  });

  const opBadge = (r) => { const sum = sumOf(r.id), paid = paidBy[r.id] || 0; if (sum > 0 && paid >= sum) return '<span class="badge badge--green">оплачено</span>'; if (r.payment_code) return '<span class="badge badge--amber">ожидает</span>'; return '<span class="badge badge--gray">нет счёта</span>'; };
  const cfBadge = (r) => { const c = confOf(r.id); return c === 'all' ? '<span class="badge badge--accent">подтв.</span>' : c === 'part' ? '<span class="badge badge--amber">частично</span>' : '<span class="badge badge--gray">—</span>'; };

  main.innerHTML = `
    <div class="page-head"><div><h1>Дашборд</h1><div class="sub">${esc(active.orgName)} · что двигает сделки дальше</div></div></div>
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Туров всего</div><div class="value">${list.length}</div><div class="delta" style="color:var(--muted)">в контуре</div></div>
      <div class="kpi"><div class="label">Ждут оплаты</div><div class="value" style="color:var(--amber)">${kAwaiting}</div><div class="delta" style="color:var(--muted)">счёт выставлен</div></div>
      <div class="kpi"><div class="label">Оплачено</div><div class="value" style="color:var(--green)">${kPaid}</div><div class="delta" style="color:var(--muted)">готовы к ваучеру</div></div>
      <div class="kpi"><div class="label">Сумма в работе</div><div class="value">${money(kPipeline, cur)}</div><div class="delta" style="color:var(--muted)">по всем турам</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">Требуют действия <span class="badge badge--${actions.length ? 'red' : 'gray'}">${actions.length}</span></div>
      ${actions.length ? actions.map(a => `<div class="act-row">
        <span class="act-dot" style="background:${a.dot}"></span>
        <div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:500">${esc(a.issue)}</div><div class="hint mono" style="font-size:11px">${esc(a.code)}${a.who ? ' · ' + esc(a.who) : ''}</div></div>
        <button class="btn btn--ghost btn--sm goPay">${esc(a.act)}</button>
      </div>`).join('') : `<div class="card-empty">Нет задач — всё в порядке.</div>`}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">Сделки в работе <span class="hint" style="font-weight:500">${list.length} в контуре</span></div>
      ${list.length ? `<table><thead><tr><th>Тур</th><th>Клиент</th><th style="text-align:right">Гости</th><th style="text-align:right">Сумма</th><th>Оплата</th><th>Подтв.</th></tr></thead><tbody>
        ${list.map(r => `<tr>
          <td><b>${esc(r.name || '—')}</b>${r.payment_code ? ` <span class="id-cell">${esc(r.payment_code)}</span>` : ''}</td>
          <td>${esc(r.client_name || '—')}</td>
          <td style="text-align:right" class="mono">${r.pax_count || '—'}</td>
          <td style="text-align:right" class="price">${money(sumOf(r.id), r.currency)}</td>
          <td>${opBadge(r)}</td>
          <td>${cfBadge(r)}</td>
        </tr>`).join('')}
      </tbody></table>` : `<div class="card-empty">Туров пока нет. Создайте тур во вкладке «Туры».</div>`}
    </div>`;

  document.querySelectorAll('.goPay').forEach(b => b.onclick = () => { state.tab = 'pay'; renderCabinet(); });
}

/* ── DMC · Каталог (Atlas-карточки, на реальных данных) ──────────────────────*/
/* ── простой лайтбокс просмотра фото объекта (DMC) ───────────────────────────*/
function openGallery(photos, title) {
  let i = 0;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,20,18,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px';
  const render = () => {
    ov.innerHTML = `
      <div style="color:#eafaf6;font-weight:600;margin-bottom:12px">${esc(title || '')} <span style="opacity:.7;font-weight:400">${i + 1}/${photos.length}</span></div>
      <img src="${esc(photos[i])}" style="max-width:90vw;max-height:72vh;object-fit:contain;border-radius:10px;background:#fff">
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;justify-content:center;max-width:90vw">
        ${photos.map((u, k) => `<img class="galThumb" data-k="${k}" src="${esc(u)}" style="width:58px;height:44px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid ${k === i ? '#fff' : 'transparent'}">`).join('')}
      </div>
      <div style="margin-top:14px;display:flex;gap:10px">
        ${photos.length > 1 ? '<button class="btn btn--ghost" id="galPrev">‹ Назад</button><button class="btn btn--ghost" id="galNext">Вперёд ›</button>' : ''}
        <button class="btn btn--primary" id="galClose">Закрыть</button>
      </div>`;
    ov.querySelectorAll('.galThumb').forEach(t => t.onclick = (e) => { e.stopPropagation(); i = +t.dataset.k; render(); });
    const pv = ov.querySelector('#galPrev'); if (pv) pv.onclick = (e) => { e.stopPropagation(); i = (i - 1 + photos.length) % photos.length; render(); };
    const nx = ov.querySelector('#galNext'); if (nx) nx.onclick = (e) => { e.stopPropagation(); i = (i + 1) % photos.length; render(); };
    const cl = ov.querySelector('#galClose'); if (cl) cl.onclick = () => ov.remove();
  };
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
  render();
  document.body.appendChild(ov);
}

async function dmcCatalog() {
  const main = $('#main'); if (!main) return;
  const [{ data: props }, { data: types }, { data: rates, error }, { data: vcs }, { data: trates }] = await Promise.all([
    db.from('property').select('id,name,city,kind,star_category,photo_url,photos').eq('is_active', true),
    db.from('room_type').select('id,property_id,name,photo_url,photos'),
    db.from('room_rate_public').select('room_type_id,sell_price,currency'),
    db.from('vehicle_class').select('id,name,pax_min,pax_max'),
    db.from('transport_rate_public').select('vehicle_class_id,basis,sell_price_per_unit,currency'),
  ]);
  if (error) { main.innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; return; }
  const tById = Object.fromEntries((types || []).map(t => [t.id, t]));
  const galByProp = {};
  (types || []).forEach(t => { const ph = (t.photos && t.photos.length) ? t.photos : (t.photo_url ? [t.photo_url] : []); if (ph.length) (galByProp[t.property_id] = galByProp[t.property_id] || []).push(...ph); });
  const rateByRt = {}; (rates || []).forEach(r => { if (!rateByRt[r.room_type_id]) rateByRt[r.room_type_id] = r; });
  // группируем тарифы по объекту: мин. цена + число категорий
  const byProp = {};
  (rates || []).forEach(r => { const t = tById[r.room_type_id]; if (!t) return; const pid = t.property_id; const e = byProp[pid] || { min: Infinity, cats: 0, cur: r.currency, photo: null }; e.min = Math.min(e.min, Number(r.sell_price) || 0); e.cats += 1; if (!e.photo && t.photo_url) e.photo = t.photo_url; byProp[pid] = e; });
  const cards = (props || []).filter(p => byProp[p.id]).map(p => ({ ...p, min: byProp[p.id].min, cats: byProp[p.id].cats, cur: byProp[p.id].cur, photo: byProp[p.id].photo, gallery: (function(){ const o = (p.photos && p.photos.length) ? p.photos.slice() : (p.photo_url ? [p.photo_url] : []); const all = o.concat(galByProp[p.id] || []); return all.length ? all : (byProp[p.id].photo ? [byProp[p.id].photo] : []); })() }))
    .sort((a, b) => (a.city || '').localeCompare(b.city || '', 'ru'));
  const vById = Object.fromEntries((vcs || []).map(v => [v.id, v]));
  const trows = (trates || []).map(r => { const v = vById[r.vehicle_class_id]; return v ? { ...r, vname: v.name, pax: `${v.pax_min}–${v.pax_max}` } : null; }).filter(Boolean);
  const KIND = { city: 'Отель', resort: 'Резорт' };

  main.innerHTML = `
    <div class="page-head"><div><h1>Каталог</h1><div class="sub">Цена — к продаже. Контрактная себестоимость поставщика не видна.</div></div>
      <input id="catSearch" placeholder="Поиск по городу или названию" style="min-width:240px"></div>
    <div id="catGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
      ${cards.length ? cards.map(c => `
        <div class="card catCard" data-q="${esc((c.name + ' ' + c.city).toLowerCase())}">
          <div class="catCover" data-id="${c.id}" style="height:110px;position:relative;display:flex;align-items:flex-end;padding:12px;overflow:hidden;background:repeating-linear-gradient(135deg,var(--line-2) 0 12px,var(--line) 12px 24px);cursor:${c.gallery.length ? 'zoom-in' : 'default'}">
            ${c.gallery.length ? `<img src="${esc(c.gallery[0])}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="this.remove()">` : ''}
            <span style="position:relative;z-index:1;background:rgba(255,255,255,.92);border-radius:7px;padding:4px 9px;font-size:11px;font-weight:600;color:${c.kind === 'resort' ? 'var(--accent-ink)' : 'var(--ink-2)'}">${esc(KIND[c.kind] || 'Объект')}</span>
            ${c.star_category ? `<span style="position:absolute;top:12px;right:12px;z-index:1;font-size:12px;color:var(--amber);font-weight:600;background:rgba(255,255,255,.85);border-radius:6px;padding:1px 6px">${'★'.repeat(c.star_category)}</span>` : ''}
            ${c.gallery.length ? `<span style="position:absolute;bottom:10px;right:10px;z-index:1;background:rgba(0,0,0,.6);color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600">\uD83D\uDCF7 ${c.gallery.length}</span>` : ''}
          </div>
          <div style="padding:15px 17px">
            <div style="font-weight:600;font-size:15px">${esc(c.name)}</div>
            <div class="hint">${esc(c.city || '')}</div>
            <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:14px;padding-top:13px;border-top:1px solid var(--line-2)">
              <div><div style="font-size:11px;color:var(--muted)">от · за ночь</div><div class="price" style="font-size:18px">${money(c.min, c.cur)}</div></div>
              <div class="hint" style="color:var(--accent-ink);font-weight:600">${c.cats} категор.</div>
            </div>
          </div>
        </div>`).join('') : `<div class="card" style="grid-column:1/-1"><div class="card-empty">Пока нет объектов с ценой. Платформа задаёт цены во вкладке «Цены».</div></div>`}
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head">Трансферы</div>
    ${trows.length ? `<table><thead><tr><th>Класс машины</th><th>Pax</th><th>Тариф</th><th style="text-align:right">Цена</th></tr></thead><tbody>
      ${trows.map(r => `<tr><td><b>${esc(r.vname)}</b></td><td class="mono">${esc(r.pax)}</td><td class="hint">${r.basis === 'per_transfer' ? 'за трансфер' : 'за день'}</td><td class="price" style="text-align:right">${money(r.sell_price_per_unit, r.currency)}</td></tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Пока нет трансферов.</div>`}</div>`;

  const search = $('#catSearch');
  if (search) search.oninput = () => {
    const q = (search.value || '').trim().toLowerCase();
    document.querySelectorAll('.catCard').forEach(el => { el.style.display = !q || el.dataset.q.includes(q) ? '' : 'none'; });
  };
  const galById = {}; cards.forEach(c => { galById[c.id] = { photos: c.gallery, name: c.name }; });
  document.querySelectorAll('.catCover').forEach(el => el.onclick = () => { const g = galById[el.dataset.id]; if (g && g.photos.length) openGallery(g.photos, g.name); });
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
  box.innerHTML = `<div class="center-state">Загрузка тура…</div>`;
  const { data: tour } = await db.from('request').select('id,name,client_name,destination,start_date,end_date,pax_count,currency,status,calc').eq('id', reqId).single();
  if (!tour) { box.innerHTML = ''; return; }
  if (!calcCat) { try { calcCat = await loadCalcCat(); } catch (e) { box.innerHTML = `<div class="notice notice--err" style="margin:10px 0">${esc(e.message)}</div>`; return; } }
  calcTour = { id: reqId, name: tour.name, pax: tour.pax_count || 1, currency: tour.currency || 'USD', start: tour.start_date };
  calcSt = normCalc(tour.calc);
  calcSync();
  const tHead = `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:14px 18px;flex-wrap:wrap">
      <div><div style="font-size:17px;font-weight:700">${esc(tour.name || 'Тур')}</div>
        <div class="hint" style="margin-top:3px">${esc(tour.destination || 'направление не указано')}</div></div>
      <div style="display:flex;gap:22px;font-size:13px;flex-wrap:wrap">
        <div><div class="hint">Клиент</div><div style="font-weight:600">${esc(tour.client_name || '—')}</div></div>
        <div><div class="hint">Даты</div><div style="font-weight:600">${tour.start_date ? esc(tour.start_date) + (tour.end_date ? ' → ' + esc(tour.end_date) : '') : '—'}</div></div>
        <div><div class="hint">PAX</div><div style="font-weight:600">${tour.pax_count ?? '—'}</div></div>
        <div><div class="hint">Валюта</div><div style="font-weight:600">${esc(tour.currency || 'USD')}</div></div>
      </div>
    </div></div>`;
  box.innerHTML = tHead + `<div id="calcWrap"></div>`;
  renderCalc(active);
  if (calcSt.stops.length) calcCompute();
}

// нормализуем сохранённый расчёт (или создаём пустой)
function normCalc(raw) {
  const base = newCalc();
  if (raw && typeof raw === 'object') {
    base.profit = (typeof raw.profit === 'number') ? raw.profit : base.profit;
    base.stops = Array.isArray(raw.stops) ? raw.stops : [];
    base.trans = Array.isArray(raw.trans) ? raw.trans : [];
    base.misc = Array.isArray(raw.misc) ? raw.misc : base.misc;
  }
  return base;
}

function renderAddLine(reqId, onAdded) {
  const slot = $('#addLineSlot'); if (!slot) return;
  slot.innerHTML = `<button class="btn btn--ghost btn--sm" id="addHotelBtn">+ Отель</button> <button class="btn btn--ghost btn--sm" id="addTransferBtn">+ Трансфер</button>`;
  $('#addHotelBtn').onclick = async () => {
    const [{ data: props }, { data: types }, { data: rates }] = await Promise.all([
      db.from('property').select('id,name,org_id').eq('is_active', true),
      db.from('room_type').select('id,property_id,name,photo_url,photos'),
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
        <div><div style="font-size:22px;font-weight:700;color:#0a7d6c">Waylo</div><div style="font-size:12px;color:#6b7a89;margin-top:2px">Операционный коридор · Узбекистан</div></div>
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
  if (!state.tab || !['cats', 'avail', 'bookings', 'confirm', 'finance', 'team'].includes(state.tab)) state.tab = 'cats';
  navShell('Отель · ' + active.orgName, [
    { id:'cats', label:'Категории' },
    { id:'avail', label:'Доступность' },
    { id:'bookings', label:'Шахматка броней' },
    { id:'confirm', label:'Подтверждения' },
    { id:'finance', label:'Финансы' },
    { id:'team', label:'Команда' },
  ]);
  if (state.tab === 'cats') hotelCats(active);
  else if (state.tab === 'avail') hotelAvail(active);
  else if (state.tab === 'bookings') hotelBookings(active);
  else if (state.tab === 'confirm') supplierConfirm(active, 'отель');
  else if (state.tab === 'team') cabinetTeam(active);
  else supplierFinance(active);
}

/* ── Команда: состав организации, роли, приглашения ─────────────────────────
   Используется в кабинете отеля/резорта (и пригодна для любого тенанта).
   Суперадмин приглашает админов (insert в invitation), меняет роли и удаляет
   участников (RLS в 0001 разрешает это только суперадмину своей орг.; триггер
   guard_last_superadmin не даёт убрать последнего суперадмина). Админ видит
   состав только для чтения. */
async function cabinetTeam(active) {
  const main = $('#main'); if (!main) return;
  const isSuper = active.role === 'superadmin';
  const [{ data: mems }, { data: invs }] = await Promise.all([
    db.from('membership').select('id, role, user_id, created_at, app_user(email,name)').eq('org_id', active.orgId).order('created_at'),
    db.from('invitation').select('id,email,role,status,created_at').eq('org_id', active.orgId).eq('status', 'pending').order('created_at'),
  ]);
  const roleLabel = { superadmin:'суперадмин', admin:'админ' };
  main.innerHTML = `
    <div class="page-head"><div><h1>Команда</h1><div class="sub">Сотрудники с доступом к кабинету «${esc(active.orgName)}». ${isSuper ? 'Суперадмин приглашает админов и управляет ролями.' : 'Менять состав может только суперадмин.'}</div></div></div>
    <div id="tMsg"></div>
    ${isSuper ? `<div class="card"><div class="card-head">Пригласить сотрудника</div>
      <div class="row" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:12px">
        <div class="field" style="flex:1;min-width:220px"><label>Email сотрудника</label><input class="input" type="email" id="invEmail" placeholder="colleague@hotel.com"></div>
        <div class="field" style="min-width:160px"><label>Роль</label><select class="input" id="invRole"><option value="admin">админ</option><option value="superadmin">суперадмин</option></select></div>
        <button class="btn btn--primary" id="invBtn">Пригласить</button>
      </div>
      <div class="hint" style="padding:0 12px 12px">Сотрудник получит доступ, зарегистрировавшись этим email на странице входа (Регистрация по приглашению).</div>
    </div>` : ''}
    <div class="card"><div class="card-head">Сотрудники (${(mems||[]).length})</div>
    ${(mems||[]).length ? `<table><thead><tr><th>Email</th><th>Имя</th><th>Роль</th>${isSuper ? '<th></th>' : ''}</tr></thead><tbody>
      ${mems.map(m => { const me = m.user_id === state.user.id; return `<tr><td>${esc(m.app_user?.email || '—')}${me ? ' <span class="hint">(вы)</span>' : ''}</td><td>${esc(m.app_user?.name || '—')}</td><td><span class="badge badge--${m.role==='superadmin'?'accent':'gray'}">${roleLabel[m.role]||m.role}</span></td>${isSuper ? `<td style="text-align:right;white-space:nowrap"><select class="input roleSel" data-id="${m.id}" style="width:auto;display:inline-block">${['admin','superadmin'].map(r=>`<option value="${r}" ${m.role===r?'selected':''}>${roleLabel[r]}</option>`).join('')}</select> <button class="btn btn--ghost btn--sm rmBtn" data-id="${m.id}">Удалить</button></td>` : ''}</tr>`; }).join('')}
    </tbody></table>` : `<div class="card-empty">Нет сотрудников.</div>`}</div>
    ${isSuper && (invs||[]).length ? `<div class="card"><div class="card-head">Приглашения (ожидают регистрации)</div>
      <table><thead><tr><th>Email</th><th>Роль</th><th></th></tr></thead><tbody>
      ${invs.map(i => `<tr><td>${esc(i.email)}</td><td>${roleLabel[i.role]||i.role}</td><td style="text-align:right"><button class="btn btn--ghost btn--sm revBtn" data-id="${i.id}">Отозвать</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}`;
  if (!isSuper) return;
  const err = (m) => { $('#tMsg').innerHTML = `<div class="notice notice--err">${esc(m)}</div>`; };
  const inv = $('#invBtn');
  if (inv) inv.onclick = async () => {
    const email = ($('#invEmail').value || '').trim().toLowerCase();
    const role = $('#invRole').value;
    if (!email) { err('Укажите email сотрудника.'); return; }
    inv.disabled = true; inv.textContent = 'Приглашаем…';
    const { error } = await db.from('invitation').insert({ org_id: active.orgId, email, role, invited_by: state.user.id });
    if (error) { err(error.message); inv.disabled = false; inv.textContent = 'Пригласить'; } else cabinetTeam(active);
  };
  document.querySelectorAll('.roleSel').forEach(s => s.onchange = async () => {
    const { error } = await db.from('membership').update({ role: s.value }).eq('id', s.dataset.id);
    if (error) err(error.message);
    cabinetTeam(active);
  });
  document.querySelectorAll('.rmBtn').forEach(b => b.onclick = async () => {
    if (!confirm('Убрать этого сотрудника из организации?')) return;
    const { error } = await db.from('membership').delete().eq('id', b.dataset.id);
    if (error) err(error.message); else cabinetTeam(active);
  });
  document.querySelectorAll('.revBtn').forEach(b => b.onclick = async () => {
    const { error } = await db.from('invitation').update({ status: 'revoked' }).eq('id', b.dataset.id);
    if (error) err(error.message); else cabinetTeam(active);
  });
}

async function supplierConfirm(active, word) {
  const main = $('#main'); if (!main) return;
  const { data: lines } = await db.from('request_line').select('*').eq('supplier_org_id', active.orgId).order('created_at', { ascending: false });
  const all = lines || [];
  const pending = all.filter(l => l.confirmation === 'pending');
  const confirmed = all.filter(l => l.confirmation === 'confirmed');
  // финансовое основание по заявкам (0019): is_request_paid через RPC (definer обходит RLS)
  const reqIds = [...new Set(all.map(l => l.request_id).filter(Boolean))];
  const paidArr = await Promise.all(reqIds.map(async rid => { const { data } = await db.rpc('is_request_paid', { p_request: rid }); return [rid, data === true]; }));
  const paidByReq = Object.fromEntries(paidArr);
  main.innerHTML = `
    <div class="page-head"><div><h1>Подтверждения</h1><div class="sub">Запросы от DMC. Подтверждение возможно только после оплаты заявки${word === 'отель' ? '; фиксирует холд и начисляет спред' : ' и фиксирует холд'}.</div></div></div>
    <div class="stat-row"><div class="stat"><div class="n">${pending.length}</div><div class="l">ждут подтверждения</div></div><div class="stat"><div class="n">${confirmed.length}</div><div class="l">подтверждено</div></div></div>
    <div id="cMsg"></div>
    <div class="card"><div class="card-head">Линии заявок</div>
    ${all.length ? `<table><thead><tr><th>Линия</th><th>Ресурс</th><th>Период</th><th>Кол-во</th><th>Цена</th><th>Оплата</th><th>Статус</th><th></th></tr></thead><tbody>
      ${all.map(l => { const paid = paidByReq[l.request_id]; return `<tr><td class="id-cell">${short(l.id)}</td><td class="id-cell">${short(l.resource_id)}</td><td class="hint">${esc(l.from_date)} — ${esc(l.to_date)}</td><td class="mono">${l.quantity}</td><td class="price">${money(l.sell_price)}</td><td>${paid ? '<span class="badge badge--green">оплачено</span>' : '<span class="badge badge--amber">ожидает оплаты</span>'}</td><td>${badge(l.confirmation)}</td><td style="text-align:right">${l.confirmation === 'pending' ? (paid ? `<button class="btn btn--primary btn--sm confirmBtn" data-id="${l.id}">Подтвердить</button>` : '<span class="hint">оплата не получена</span>') : ''}</td></tr>`; }).join('')}
    </tbody></table>` : `<div class="card-empty">Пока нет запросов на ваши услуги.</div>`}</div>`;
  document.querySelectorAll('.confirmBtn').forEach(b => b.onclick = async () => {
    const { error } = await db.rpc('confirm_hold', { p_request_line: b.dataset.id });
    if (error) $('#cMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`;
    else supplierConfirm(active, word);
  });
}

function ensureShaStyle() {
  if (document.getElementById('sha-style')) return;
  const st = document.createElement('style');
  st.id = 'sha-style';
  st.textContent = `
  .sha-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
  .sha{border-collapse:collapse;font-size:12px;width:max-content}
  .sha th,.sha td{border:1px solid var(--line-2)}
  .sha thead th{background:var(--bg);font-size:10.5px;color:var(--muted);font-weight:600;padding:5px 3px;text-align:center;min-width:40px;line-height:1.25}
  .sha thead th .wd{font-size:9px;text-transform:uppercase;letter-spacing:.02em;opacity:.8}
  .sha thead th.we{color:var(--red)}
  .sha .rh{position:sticky;left:0;z-index:2;background:var(--surface);text-align:left;padding:7px 12px;font-weight:600;font-size:12.5px;min-width:210px;color:var(--ink);box-shadow:1px 0 0 var(--line)}
  .sha thead .rh{z-index:3;background:var(--bg)}
  .sha .cell{text-align:center;font-family:var(--mono);font-weight:600;height:34px;min-width:40px}
  .sha-leg{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin:12px 2px 0}
  .sha-leg span{display:inline-flex;align-items:center;gap:6px}
  .sha-leg i{width:13px;height:13px;border-radius:3px;display:inline-block;border:1px solid var(--line-2)}
  .sha-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  `;
  document.head.appendChild(st);
}

function ensureSha2Style() {
  if (document.getElementById('sha2-style')) return;
  const st = document.createElement('style');
  st.id = 'sha2-style';
  st.textContent = `
  .sha2-wrap{overflow:auto;max-height:72vh;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
  .sha2{border-collapse:separate;border-spacing:0;font-size:12px;width:max-content}
  .sha2 th,.sha2 td{border-right:1px solid var(--line-2);border-bottom:1px solid var(--line-2);padding:3px 6px;text-align:center;white-space:nowrap;height:30px;box-sizing:border-box}
  .sha2 thead th{position:sticky;background:var(--bg);font-size:10px;color:var(--muted);font-weight:600;line-height:1.15}
  .sha2 thead tr.grp th{top:0;height:26px;background:var(--accent-soft);color:var(--accent-ink);font-weight:700;font-size:12px}
  .sha2 thead tr.sub th{top:26px}
  .sha2 .dh{position:sticky;left:0;z-index:2;background:var(--surface);text-align:left;min-width:124px;padding:4px 10px;font-weight:600;box-shadow:1px 0 0 var(--line)}
  .sha2 thead .dh{z-index:5;background:var(--bg)}
  .sha2 thead tr.grp .dh{z-index:6;background:var(--bg)}
  .sha2 tr.we td{background:#fafbfb}
  .sha2 tr.we td.dh{color:var(--red);background:#f6f7f8}
  .sha2 .wd{color:var(--muted);font-weight:400;font-size:10px;margin-left:5px}
  .sha2 .cl{cursor:pointer;font-size:13px;width:36px;user-select:none}
  .sha2 .avinp{width:50px;text-align:center;font:inherit;font-family:var(--mono);font-weight:600;border:1px solid transparent;border-radius:6px;padding:3px 2px;background:transparent;color:var(--ink)}
  .sha2 .avinp:hover{border-color:var(--line)}
  .sha2 .avinp:focus{border-color:var(--accent);outline:none;background:var(--surface)}
  .sha2 .av.man .avinp{background:var(--green-bg);color:var(--green)}
  .sha2 .defrst{color:var(--muted);cursor:pointer;border-bottom:1px dotted var(--muted);font-family:var(--mono)}
  .sha2 .fr{font-family:var(--mono);font-weight:700}
  .sha2 .fr.ok{color:var(--green)}
  .sha2 .fr.zero{background:#fdf4d4;color:var(--amber)}
  .sha2 .fr.over{background:var(--red-bg);color:var(--red)}
  .sha2 .fr.closed{background:#eef0f2;color:var(--muted)}
  .sha2 .bk{font-family:var(--mono);color:var(--ink-2)}
  .sha2 .cn{font-family:var(--mono);color:var(--blue)}
  .sha2-leg{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin:12px 2px 0}
  .sha2-leg span{display:inline-flex;align-items:center;gap:6px}
  .sha2-leg i{width:13px;height:13px;border-radius:3px;display:inline-block;border:1px solid var(--line-2)}
  .deftbl{border-collapse:collapse;font-size:13px}
  .deftbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600;padding:6px 12px;border-bottom:1px solid var(--line-2)}
  .deftbl td{padding:6px 12px;border-bottom:1px solid var(--line-2)}
  .deftbl .definp{width:90px;font:inherit;border:1px solid var(--line);border-radius:7px;padding:6px 8px;background:var(--surface);color:var(--ink);font-family:var(--mono)}
  `;
  document.head.appendChild(st);
}

let shaFrom = null, shaTo = null, shaProp = null;

const RU_MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const RU_WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

async function hotelAvail(active) {
  const main = $('#main'); if (!main) return;
  ensureSha2Style();

  const { data: props } = await db.from('property').select('id,name').eq('org_id', active.orgId).order('name');
  const propList = props || [];
  if (!propList.length) { main.innerHTML = `<div class="page-head"><div><h1>Доступность</h1></div></div><div class="card"><div class="card-empty">Нет объектов. Добавьте отель/резорт в каталоге.</div></div>`; return; }
  if (!shaProp || !propList.some(p => p.id === shaProp)) shaProp = propList[0].id;

  const today = new Date().toISOString().slice(0, 10);
  if (!shaFrom) shaFrom = today;
  if (!shaTo) shaTo = addDays(today, 29);
  if (shaTo < shaFrom) shaTo = shaFrom;
  // окно дат (с запасом по производительности)
  const days = []; let cur = shaFrom; let guard = 0;
  while (cur <= shaTo && guard < 92) { days.push(cur); cur = addDays(cur, 1); guard++; }
  const lastDay = days[days.length - 1];

  const { data: ts } = await db.from('room_type').select('id,name,default_availability').eq('property_id', shaProp).eq('is_active', true).order('name');
  const rts = ts || [];
  const rtIds = rts.map(r => r.id);
  const defOf = {}; rts.forEach(r => defOf[r.id] = r.default_availability || 0);

  const [{ data: al }, { data: hd }] = await Promise.all([
    rtIds.length ? db.from('room_allotment').select('room_type_id,day,quantity,closed').in('room_type_id', rtIds).gte('day', shaFrom).lte('day', lastDay) : Promise.resolve({ data: [] }),
    rtIds.length ? db.from('hold').select('resource_id,day,quantity,status,expires_at').eq('resource_type', 'room').in('resource_id', rtIds).gte('day', shaFrom).lte('day', lastDay) : Promise.resolve({ data: [] }),
  ]);
  const allot = {}; (al || []).forEach(a => { allot[a.room_type_id + '|' + a.day] = { quantity: a.quantity, closed: a.closed }; });
  const held = {}, conf = {}, canc = {};
  const now = Date.now();
  (hd || []).forEach(h => {
    const k = h.resource_id + '|' + h.day;
    if (h.status === 'confirmed') conf[k] = (conf[k] || 0) + h.quantity;
    else if (h.status === 'held') { if (!h.expires_at || new Date(h.expires_at).getTime() > now) held[k] = (held[k] || 0) + h.quantity; }
    else if (h.status === 'released' || h.status === 'expired') canc[k] = (canc[k] || 0) + h.quantity;
  });

  function cellState(rtId, day) {
    const k = rtId + '|' + day, a = allot[k];
    const base = a ? (a.closed ? 0 : a.quantity) : (defOf[rtId] || 0);
    const h = held[k] || 0, c = conf[k] || 0, booked = h + c, free = Math.max(0, base - booked);
    const closed = !!(a && a.closed);
    let cls, txt;
    if (closed) { cls = 'fr closed'; txt = '—'; }
    else if (booked > base) { cls = 'fr over'; txt = free; }
    else if (free === 0) { cls = 'fr zero'; txt = 0; }
    else { cls = 'fr ok'; txt = free; }
    return { a, base, h, c, booked, free, closed, cls, txt, man: !!a, avVal: a ? a.quantity : (defOf[rtId] || 0) };
  }
  function recompute(rtId, day) {
    const k = rtId + '|' + day, s = cellState(rtId, day);
    const cc = document.getElementById('c_' + k);
    if (cc) { cc.textContent = s.closed ? '✕' : '●'; cc.style.color = s.closed ? 'var(--red)' : 'var(--green)'; cc.title = s.closed ? 'Закрыто — нажмите, чтобы открыть' : 'Открыто — нажмите, чтобы закрыть'; }
    const aw = document.getElementById('aw_' + k); if (aw) aw.className = 'av' + (s.man ? ' man' : '');
    const ai = document.getElementById('a_' + k); if (ai && document.activeElement !== ai) ai.value = s.avVal;
    const fc = document.getElementById('f_' + k); if (fc) { fc.className = s.cls; fc.textContent = s.txt; fc.title = `Свободно ${s.free} из ${s.base} · холд ${s.h} · подтв ${s.c}`; }
    const bc = document.getElementById('b_' + k); if (bc) bc.textContent = s.c || '';
  }
  async function setAv(rtId, day, qty) {
    const k = rtId + '|' + day, prev = allot[k], closed = prev ? prev.closed : false;
    const { error } = await db.from('room_allotment').upsert({ room_type_id: rtId, day, quantity: qty, closed }, { onConflict: 'room_type_id,day' });
    if (error) { setMsg(error.message, true); return; }
    allot[k] = { quantity: qty, closed }; recompute(rtId, day); setMsg('сохранено', false);
  }
  async function toggleClose(rtId, day) {
    const k = rtId + '|' + day, prev = allot[k];
    const qty = prev ? prev.quantity : (defOf[rtId] || 0), closed = prev ? !prev.closed : true;
    const { error } = await db.from('room_allotment').upsert({ room_type_id: rtId, day, quantity: qty, closed }, { onConflict: 'room_type_id,day' });
    if (error) { setMsg(error.message, true); return; }
    allot[k] = { quantity: qty, closed }; recompute(rtId, day); setMsg(closed ? 'дата закрыта' : 'дата открыта', false);
  }
  async function resetDef(rtId, day) {
    const k = rtId + '|' + day;
    const { error } = await db.from('room_allotment').delete().eq('room_type_id', rtId).eq('day', day);
    if (error) { setMsg(error.message, true); return; }
    delete allot[k]; recompute(rtId, day); setMsg('сброшено к дефолту', false);
  }
  function setMsg(t, err) { const m = $('#shaMsg'); if (m) { m.textContent = (err ? '✕ ' : '✓ ') + t; m.style.color = err ? 'var(--red)' : 'var(--muted)'; if (!err) setTimeout(() => { if (m) m.textContent = ''; }, 2500); } }

  const grpHead = days.length ? new Date(shaFrom + 'T00:00:00Z').getUTCFullYear() : '';
  const subHead = `<th>Закр/Откр</th><th>Доступно</th><th>Дефолт</th><th>Свободно</th><th>Брони</th><th>Отмены</th>`;
  const bodyRows = days.map(d => {
    const dt = new Date(d + 'T00:00:00Z'), g = dt.getUTCDay(), we = (g === 0 || g === 6);
    const dl = `${dt.getUTCDate()} ${RU_MON[dt.getUTCMonth()]}<span class="wd">${RU_WD[g]}</span>`;
    const cells = rts.map(rt => {
      const k = rt.id + '|' + d, s = cellState(rt.id, d);
      return `<td class="cl" id="c_${k}" data-rt="${rt.id}" data-day="${d}" title="${s.closed ? 'Закрыто — открыть' : 'Открыто — закрыть'}" style="color:${s.closed ? 'var(--red)' : 'var(--green)'}">${s.closed ? '✕' : '●'}</td>`
        + `<td class="av${s.man ? ' man' : ''}" id="aw_${k}"><input type="number" min="0" class="avinp" id="a_${k}" data-rt="${rt.id}" data-day="${d}" value="${s.avVal}"></td>`
        + `<td><span class="defrst" data-rt="${rt.id}" data-day="${d}" title="сбросить к дефолту">${defOf[rt.id] || 0}</span></td>`
        + `<td class="${s.cls}" id="f_${k}" title="Свободно ${s.free} из ${s.base} · холд ${s.h} · подтв ${s.c}">${s.txt}</td>`
        + `<td class="bk" id="b_${k}">${s.c || ''}</td>`
        + `<td class="cn" id="n_${k}">${canc[k] || ''}</td>`;
    }).join('');
    return `<tr class="${we ? 'we' : ''}"><td class="dh">${dl}</td>${cells}</tr>`;
  }).join('');

  main.innerHTML = `
    <div class="page-head"><div><h1>Доступность</h1><div class="sub">Дефолт на категорию + календарь-шахматка: правьте число прямо в ячейке, закрывайте даты, видьте брони.</div></div></div>

    <div class="card"><div class="card-head">Объект и доступность по умолчанию</div><div style="padding:14px">
      ${propList.length > 1 ? `<div class="field" style="max-width:340px;margin-bottom:14px"><label>Объект</label><select class="input" id="shaProp">${propList.map(p => `<option value="${p.id}" ${p.id === shaProp ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : ''}
      ${rts.length ? `<table class="deftbl"><thead><tr><th>Категория номеров</th><th>Доступность по умолчанию</th></tr></thead><tbody>
        ${rts.map(rt => `<tr><td>${esc(rt.name)}</td><td><input type="number" min="0" class="definp" data-rt="${rt.id}" value="${defOf[rt.id] || 0}"></td></tr>`).join('')}
      </tbody></table>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center"><button class="btn btn--primary btn--sm" id="defSave">Сохранить дефолты</button><span id="defMsg" class="hint"></span></div>
      <div class="hint" style="margin-top:6px">Дефолт применяется к дням, где доступность не задана вручную в календаре.</div>` : `<div class="card-empty">Нет категорий номеров у объекта.</div>`}
    </div></div>

    <div class="card"><div class="card-head">Календарь · ${esc(propList.find(p => p.id === shaProp).name)}</div><div style="padding:14px">
      <div class="sha-nav">
        <span class="hint">Период с</span><input type="date" id="shaF" value="${shaFrom}">
        <span class="hint">по</span><input type="date" id="shaT" value="${shaTo}">
        <button class="btn btn--primary btn--sm" id="shaShow">Показать</button>
        <button class="btn btn--ghost btn--sm" id="grpBtn" style="margin-left:auto">Групповая операция</button>
        <span id="shaMsg" class="hint"></span>
      </div>
      <div id="grpPanel" style="display:none;border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px;background:var(--bg)">
        <div class="row" style="align-items:flex-end">
          <div class="field" style="min-width:200px"><label>Категория</label><select class="input" id="grpRt"><option value="">Все категории</option>${rts.map(rt => `<option value="${rt.id}">${esc(rt.name)}</option>`).join('')}</select></div>
          <div class="field"><label>С даты</label><input type="date" id="grpFrom" value="${shaFrom}"></div>
          <div class="field"><label>По дату</label><input type="date" id="grpTo" value="${shaTo}"></div>
          <div class="field" style="min-width:170px"><label>Действие</label><select class="input" id="grpAct"><option value="set">Задать доступно</option><option value="close">Закрыть продажи</option><option value="open">Открыть продажи</option></select></div>
          <div class="field" style="width:90px" id="grpNWrap"><label>Кол-во</label><input type="number" min="0" value="10" id="grpN"></div>
          <button class="btn btn--primary btn--sm" id="grpApply">Применить</button>
          <button class="btn btn--ghost btn--sm" id="grpCancel">Закрыть</button>
        </div><div id="grpMsg"></div>
      </div>
      ${rts.length ? `<div class="sha2-wrap"><table class="sha2">
        <thead>
          <tr class="grp"><th class="dh" rowspan="2">${grpHead}</th>${rts.map(rt => `<th colspan="6">${esc(rt.name)}</th>`).join('')}</tr>
          <tr class="sub">${rts.map(() => subHead).join('')}</tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table></div>
      <div class="sha2-leg">
        <span><i style="background:var(--green-bg)"></i>изменено вручную</span>
        <span><i style="background:#fdf4d4"></i>доступность исчерпана</span>
        <span><i style="background:var(--red-bg)"></i>overbooking</span>
        <span><i style="background:#eef0f2"></i>закрыто</span>
        <span>● открыто / ✕ закрыто · «Свободно» = к брони · «Брони» = подтверждено</span>
      </div>` : ''}
    </div></div>`;

  // ── обработчики ──
  const propSel = $('#shaProp'); if (propSel) propSel.onchange = (e) => { shaProp = e.target.value; hotelAvail(active); };
  $('#shaShow').onclick = () => { const f = $('#shaF').value, t = $('#shaT').value; if (f) shaFrom = f; if (t) shaTo = t; hotelAvail(active); };
  const ds = $('#defSave'); if (ds) ds.onclick = async () => {
    const ups = [...document.querySelectorAll('.definp')].map(i => db.from('room_type').update({ default_availability: Math.max(0, parseInt(i.value || '0', 10)) }).eq('id', i.dataset.rt));
    const res = await Promise.all(ups); const err = res.find(r => r.error);
    if (err) $('#defMsg').innerHTML = `<span style="color:var(--red)">${esc(err.error.message)}</span>`;
    else hotelAvail(active);
  };
  document.querySelectorAll('.avinp').forEach(i => { i.onchange = () => setAv(i.dataset.rt, i.dataset.day, Math.max(0, parseInt(i.value || '0', 10))); });
  document.querySelectorAll('.cl').forEach(c => { c.onclick = () => toggleClose(c.dataset.rt, c.dataset.day); });
  document.querySelectorAll('.defrst').forEach(s => { s.onclick = () => resetDef(s.dataset.rt, s.dataset.day); });

  const grpBtn = $('#grpBtn'); if (grpBtn) {
    const panel = $('#grpPanel');
    const syncN = () => { const w = $('#grpNWrap'); if (w) w.style.display = $('#grpAct').value === 'set' ? '' : 'none'; };
    grpBtn.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; syncN(); };
    $('#grpCancel').onclick = () => { panel.style.display = 'none'; };
    $('#grpAct').onchange = syncN;
    $('#grpApply').onclick = async () => {
      const rt = $('#grpRt').value, f = $('#grpFrom').value, t = $('#grpTo').value, act = $('#grpAct').value, n = Math.max(0, parseInt($('#grpN').value || '0', 10));
      if (!f || !t || f > t) { $('#grpMsg').innerHTML = `<div class="notice notice--err">Проверьте даты.</div>`; return; }
      const targetRts = rt ? [rt] : rtIds;
      const rng = []; let c2 = f, g2 = 0; while (c2 <= t && g2 < 400) { rng.push(c2); c2 = addDays(c2, 1); g2++; }
      let batch = [];
      if (act === 'set') {
        targetRts.forEach(r => rng.forEach(d => batch.push({ room_type_id: r, day: d, quantity: n, closed: false })));
      } else {
        // закрыть/открыть — сохранить существующее количество (или дефолт)
        const { data: ex } = await db.from('room_allotment').select('room_type_id,day,quantity').in('room_type_id', targetRts).gte('day', f).lte('day', t);
        const exMap = {}; (ex || []).forEach(e => exMap[e.room_type_id + '|' + e.day] = e.quantity);
        const closed = act === 'close';
        targetRts.forEach(r => rng.forEach(d => batch.push({ room_type_id: r, day: d, quantity: (exMap[r + '|' + d] != null ? exMap[r + '|' + d] : (defOf[r] || 0)), closed })));
      }
      const { error } = await db.from('room_allotment').upsert(batch, { onConflict: 'room_type_id,day' });
      if (error) $('#grpMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`;
      else hotelAvail(active);
    };
  }
}

function ensureBkgStyle() {
  if (document.getElementById('bkg-style')) return;
  const st = document.createElement('style');
  st.id = 'bkg-style';
  st.textContent = `
  .bkg-wrap{overflow:auto;max-height:74vh;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
  .bkg{border-collapse:separate;border-spacing:0;font-size:11.5px;width:max-content}
  .bkg th,.bkg td{border-right:1px solid var(--line-2);border-bottom:1px solid var(--line-2);height:26px;min-width:34px;text-align:center;white-space:nowrap;padding:0 3px;box-sizing:border-box}
  .bkg thead th{position:sticky;top:0;z-index:2;background:var(--bg);font-size:10px;color:var(--muted);font-weight:600;line-height:1.12}
  .bkg thead th.we{color:var(--red)}
  .bkg .rh{position:sticky;left:0;z-index:3;background:var(--surface);text-align:left;min-width:150px;padding:4px 10px;box-shadow:1px 0 0 var(--line)}
  .bkg thead .rh{z-index:4;background:var(--bg)}
  .bkg tr.catrow td{background:var(--accent-soft);font-weight:700;color:var(--accent-ink)}
  .bkg tr.catrow td.rh{color:var(--accent-ink)}
  .bkg td.wecell{background:#fafbfb}
  .bkg .av{font-family:var(--mono)}
  .bkg .slot{color:var(--muted);font-size:10.5px;font-weight:400}
  .bkg td.b{font-weight:600;overflow:hidden;text-overflow:ellipsis;font-size:10.5px;text-align:left;padding-left:6px;max-width:1px}
  .bkg td.b.pend{background:var(--amber-bg);color:var(--amber)}
  .bkg td.b.conf{background:var(--accent-soft);color:var(--accent-ink)}
  .bkg-leg{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:12px}
  .bkg-leg span{display:inline-flex;align-items:center;gap:6px}
  .bkg-leg i{width:13px;height:13px;border-radius:3px;display:inline-block;border:1px solid var(--line-2)}
  `;
  document.head.appendChild(st);
}

let catForm = null;          // null | {} (новая) | объект категории (правка)
let bkProp = null, bkFrom = null;
let propForm = null;  // null | {} (новый объект) | объект property (правка)

// загрузка фото с диска: сжатие в браузере → data-URL в скрытое поле (хранится в БД, колонка photo_url)
function pickPhoto(fileInputId, hiddenId, prevId) {
  const fi = document.getElementById(fileInputId); if (!fi) return;
  fi.onchange = () => {
    const f = fi.files && fi.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 900; let w = img.width, h = img.height;
        if (w > max || h > max) { const k = Math.min(max / w, max / h); w = Math.round(w * k); h = Math.round(h * k); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        const data = cv.toDataURL('image/jpeg', 0.75);
        const hid = document.getElementById(hiddenId); if (hid) hid.value = data;
        const pv = document.getElementById(prevId); if (pv) pv.innerHTML = `<img src="${data}" style="height:54px;border-radius:6px;object-fit:cover">`;
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(f);
  };
}

let objGallery = [];  // галерея фото объекта (ссылки на файлы в Storage)
function compressToBlob(file) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => { const img = new Image(); img.onload = () => {
      const max = 1400; let w = img.width, h = img.height;
      if (w > max || h > max) { const k = Math.min(max / w, max / h); w = Math.round(w * k); h = Math.round(h * k); }
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob(b => b ? resolve(b) : reject(new Error('canvas')), 'image/jpeg', 0.78);
    }; img.onerror = () => reject(new Error('image')); img.src = rd.result; };
    rd.onerror = () => reject(new Error('read')); rd.readAsDataURL(file);
  });
}
async function uploadToStorage(blob, folder) {
  const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2));
  const path = folder + '/' + id + '.jpg';
  const { error } = await db.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return db.storage.from('photos').getPublicUrl(path).data.publicUrl;
}
function renderObjGallery() {
  const g = document.getElementById('pfGallery'); if (!g) return;
  g.innerHTML = objGallery.length ? objGallery.map((u, i) => `<div style="position:relative;width:78px;height:58px"><img src="${esc(u)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;border:1px solid var(--line)">${i === 0 ? '<span style="position:absolute;bottom:2px;left:2px;font-size:9px;background:var(--accent);color:#fff;border-radius:4px;padding:0 4px">обложка</span>' : ''}<button type="button" class="pfImgDel" data-i="${i}" style="position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;border:none;background:var(--red);color:#fff;cursor:pointer;font-size:11px;line-height:1">×</button></div>`).join('') : '<span class="hint">фото не добавлены</span>';
  g.querySelectorAll('.pfImgDel').forEach(b => b.onclick = () => { objGallery.splice(+b.dataset.i, 1); renderObjGallery(); });
}
function bindObjGallery(active) {
  const fi = document.getElementById('pfPhotoFiles'); if (!fi) return;
  fi.onchange = async () => {
    const files = [...(fi.files || [])];
    const msg = document.getElementById('pfMsg');
    for (const f of files) {
      if (objGallery.length >= 20) { if (msg) msg.innerHTML = '<span style="color:var(--amber)">Максимум 20 фото на объект.</span>'; break; }
      try { const blob = await compressToBlob(f); const url = await uploadToStorage(blob, 'property/' + (active.orgId || 'x')); objGallery.push(url); renderObjGallery(); }
      catch (e) { if (msg) msg.innerHTML = `<span style="color:var(--red)">Загрузка не удалась: ${esc((e && e.message) || e)}. Проверьте, что применена миграция 0029 (бакет 'photos').</span>`; }
    }
    fi.value = '';
  };
}

let catGallery = [];  // галерея фото категории номера
function renderGallery(arr, elId) {
  const g = document.getElementById(elId); if (!g) return;
  g.innerHTML = arr.length ? arr.map((u, i) => `<div style="position:relative;width:78px;height:58px"><img src="${esc(u)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;border:1px solid var(--line)">${i === 0 ? '<span style="position:absolute;bottom:2px;left:2px;font-size:9px;background:var(--accent);color:#fff;border-radius:4px;padding:0 4px">обложка</span>' : ''}<button type="button" class="galDel" data-i="${i}" style="position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;border:none;background:var(--red);color:#fff;cursor:pointer;font-size:11px;line-height:1">×</button></div>`).join('') : '<span class="hint">фото не добавлены</span>';
  g.querySelectorAll('.galDel').forEach(b => b.onclick = () => { arr.splice(+b.dataset.i, 1); renderGallery(arr, elId); });
}
function bindGallery(fileInputId, arr, elId, folder, max, msgId) {
  const fi = document.getElementById(fileInputId); if (!fi) return;
  fi.onchange = async () => {
    const files = [...(fi.files || [])];
    const msg = msgId && document.getElementById(msgId);
    for (const f of files) {
      if (arr.length >= max) { if (msg) msg.innerHTML = `<span style="color:var(--amber)">Максимум ${max} фото.</span>`; break; }
      try { const blob = await compressToBlob(f); const url = await uploadToStorage(blob, folder); arr.push(url); renderGallery(arr, elId); }
      catch (e) { if (msg) msg.innerHTML = `<span style="color:var(--red)">Загрузка не удалась: ${esc((e && e.message) || e)}. Применена ли миграция 0029 (бакет photos)?</span>`; }
    }
    fi.value = '';
  };
}

async function hotelCats(active) {
  const main = $('#main'); if (!main) return;
  const { data: props } = await db.from('property').select('id,name,city,kind,star_category,is_active,photo_url,photos').eq('org_id', active.orgId).order('name');
  const propList = props || [];
  const pById = Object.fromEntries(propList.map(p => [p.id, p]));
  const ids = propList.map(p => p.id);
  const { data: cats } = ids.length ? await db.from('room_type').select('id,property_id,name,short_name,max_occupancy,default_availability,is_active,photo_url,photos').in('property_id', ids).order('name') : { data: [] };
  const list = cats || [];
  const KINDS = { city:'Городской отель', resort:'Резорт' };

  // ── форма объекта (property) ──
  let propFormHtml = '';
  if (propForm) {
    const p = propForm, isEdit = !!p.id;
    propFormHtml = `<div class="card" style="margin-bottom:14px"><div class="card-head">${isEdit ? 'Изменить объект' : 'Новый объект'}</div><div style="padding:14px">
      <div class="row">
        <div class="field" style="min-width:220px"><label>Название объекта</label><input class="input" id="pfName" value="${esc(p.name || '')}" placeholder="Hotel Registan Plaza"></div>
        <div class="field" style="min-width:160px"><label>Город / локация</label><input class="input" id="pfCity" value="${esc(p.city || '')}" placeholder="Самарканд"></div>
        <div class="field" style="width:170px"><label>Тип</label><select class="input" id="pfKind"><option value="city" ${p.kind !== 'resort' ? 'selected' : ''}>Городской отель</option><option value="resort" ${p.kind === 'resort' ? 'selected' : ''}>Резорт</option></select></div>
        <div class="field" style="width:90px"><label>Звёзды</label><input type="number" min="1" max="5" class="input" id="pfStar" value="${p.star_category || 4}"></div>
        <div class="field" style="width:90px"><label>Активен</label><select class="input" id="pfAct"><option value="1" ${p.is_active !== false ? 'selected' : ''}>Да</option><option value="0" ${p.is_active === false ? 'selected' : ''}>Нет</option></select></div>
        <div class="field" style="flex:1;min-width:320px"><label>Фото объекта (до 20, с диска)</label><input type="file" accept="image/*" multiple id="pfPhotoFiles"><div id="pfGallery" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px"></div></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button class="btn btn--primary btn--sm" id="pfSave">${isEdit ? 'Сохранить' : 'Создать объект'}</button>
        <button class="btn btn--ghost btn--sm" id="pfCancel">Отмена</button>
        <span id="pfMsg" class="hint"></span>
      </div>
    </div></div>`;
  }

  // ── форма категории (room_type) ──
  let formHtml = '';
  if (catForm) {
    const c = catForm, isEdit = !!c.id;
    formHtml = `<div class="card" style="margin-bottom:14px"><div class="card-head">${isEdit ? 'Изменить категорию' : 'Новая категория'}</div><div style="padding:14px">
      <div class="row">
        <div class="field" style="min-width:200px"><label>Объект</label><select class="input" id="cfProp" ${isEdit ? 'disabled' : ''}>${propList.map(p => `<option value="${p.id}" ${p.id === (c.property_id || propList[0] && propList[0].id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        <div class="field" style="min-width:210px"><label>Название категории</label><input class="input" id="cfName" value="${esc(c.name || '')}" placeholder="Standart Double"></div>
        <div class="field" style="width:130px"><label>Сокращённое</label><input class="input" id="cfShort" value="${esc(c.short_name || '')}" placeholder="std dbl"></div>
        <div class="field" style="width:120px"><label>Основных мест</label><input type="number" min="1" class="input" id="cfOcc" value="${c.max_occupancy || 2}"></div>
        <div class="field" style="width:140px"><label>Дефолт-доступность</label><input type="number" min="0" class="input" id="cfDef" value="${c.default_availability || 0}"></div>
        <div class="field" style="width:90px"><label>Активна</label><select class="input" id="cfAct"><option value="1" ${c.is_active !== false ? 'selected' : ''}>Да</option><option value="0" ${c.is_active === false ? 'selected' : ''}>Нет</option></select></div>
        <div class="field" style="flex:1;min-width:320px"><label>Фото категории (до 10, с диска)</label><input type="file" accept="image/*" multiple id="cfPhotoFiles"><div id="cfGallery" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px"></div></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button class="btn btn--primary btn--sm" id="cfSave">${isEdit ? 'Сохранить' : 'Создать'}</button>
        <button class="btn btn--ghost btn--sm" id="cfCancel">Отмена</button>
        <span id="cfMsg" class="hint"></span>
      </div>
      <div class="hint" style="margin-top:8px">Цены задаются платформой отдельно. Здесь — состав категорий и доступность.</div>
    </div></div>`;
  }

  main.innerHTML = `
    <div class="page-head"><div><h1>Объекты и категории</h1><div class="sub">Сначала заведите объект (здание отеля/резорт), затем — категории номеров в нём.</div></div>
      <button class="btn btn--primary" id="propAdd">+ Добавить объект</button></div>
    ${propFormHtml}
    <div class="card"><div class="card-head">Объекты (${propList.length})</div>
    ${propList.length ? `<table><thead><tr><th>Вкл.</th><th>Название</th><th>Локация</th><th>Тип</th><th style="text-align:center">★</th><th></th></tr></thead><tbody>
      ${propList.map(p => `<tr>
        <td>${p.is_active !== false ? '<span class="badge badge--accent">вкл</span>' : '<span class="badge">выкл</span>'}</td>
        <td><b>${esc(p.name)}</b></td>
        <td class="hint">${esc(p.city || '—')}</td>
        <td class="hint">${esc(KINDS[p.kind] || p.kind || '—')}</td>
        <td class="mono" style="text-align:center">${p.star_category || '—'}</td>
        <td style="text-align:right"><button class="btn btn--ghost btn--sm propEdit" data-id="${p.id}">Изменить</button></td>
      </tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Объектов пока нет. Нажмите «Добавить объект».</div>`}</div>

    <div class="page-head" style="margin-top:18px"><div><h2 style="margin:0;font-size:17px">Категории номеров</h2></div>
      ${propList.length ? `<button class="btn btn--primary" id="catAdd">+ Добавить категорию</button>` : ''}</div>
    ${formHtml}
    <div class="card"><div class="card-head">Список категорий</div>
    ${!propList.length ? `<div class="card-empty">Сначала добавьте объект — категории создаются внутри объекта.</div>`
      : list.length ? `<table><thead><tr><th>Вкл.</th><th>Объект</th><th>Название</th><th>Сокр.</th><th style="text-align:center">Мест</th><th style="text-align:center">Дефолт</th><th></th></tr></thead><tbody>
      ${list.map(c => `<tr>
        <td>${c.is_active ? '<span class="badge badge--accent">вкл</span>' : '<span class="badge">выкл</span>'}</td>
        <td class="hint">${esc(pById[c.property_id] && pById[c.property_id].name || '—')}</td>
        <td><div style="display:flex;align-items:center;gap:8px">${c.photo_url ? `<img src="${esc(c.photo_url)}" style="width:36px;height:27px;object-fit:cover;border-radius:5px" onerror="this.remove()">` : ''}<b>${esc(c.name)}</b></div></td>
        <td class="hint">${esc(c.short_name || '—')}</td>
        <td class="mono" style="text-align:center">${c.max_occupancy}</td>
        <td class="mono" style="text-align:center">${c.default_availability || 0}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn btn--ghost btn--sm catEdit" data-id="${c.id}">Изменить</button> <button class="btn btn--ghost btn--sm catDel" data-id="${c.id}">✕</button></td>
      </tr>`).join('')}
    </tbody></table>` : `<div class="card-empty">Категорий пока нет. Нажмите «Добавить категорию».</div>`}</div>`;

  if (propForm) {
    objGallery = (propForm.photos && propForm.photos.length) ? propForm.photos.slice() : (propForm.photo_url ? [propForm.photo_url] : []);
    renderObjGallery();
    bindObjGallery(active);
  }
  if (catForm) {
    catGallery = (catForm.photos && catForm.photos.length) ? catForm.photos.slice() : (catForm.photo_url ? [catForm.photo_url] : []);
    renderGallery(catGallery, 'cfGallery');
    bindGallery('cfPhotoFiles', catGallery, 'cfGallery', 'roomtype/' + (active.orgId || 'x'), 10, 'cfMsg');
  }
  // объект: обработчики
  const padd = $('#propAdd'); if (padd) padd.onclick = () => { propForm = {}; catForm = null; hotelCats(active); };
  const pcancel = $('#pfCancel'); if (pcancel) pcancel.onclick = () => { propForm = null; hotelCats(active); };
  document.querySelectorAll('.propEdit').forEach(b => b.onclick = () => { propForm = propList.find(x => x.id === b.dataset.id) || {}; catForm = null; hotelCats(active); });
  const psave = $('#pfSave'); if (psave) psave.onclick = async () => {
    const name = ($('#pfName').value || '').trim();
    if (!name) { $('#pfMsg').innerHTML = '<span style="color:var(--red)">Укажите название объекта.</span>'; return; }
    const payload = {
      name,
      city: ($('#pfCity').value || '').trim() || null,
      kind: $('#pfKind').value,
      star_category: Math.min(5, Math.max(1, parseInt($('#pfStar').value || '4', 10))),
      is_active: $('#pfAct').value === '1',
      photo_url: objGallery[0] || null,
      photos: objGallery.slice(),
    };
    let error;
    if (propForm.id) ({ error } = await db.from('property').update(payload).eq('id', propForm.id));
    else { payload.org_id = active.orgId; ({ error } = await db.from('property').insert(payload)); }
    if (error) { $('#pfMsg').innerHTML = `<span style="color:var(--red)">${esc(error.message)}</span>`; return; }
    propForm = null; hotelCats(active);
  };

  // категория: обработчики
  const add = $('#catAdd'); if (add) add.onclick = () => { catForm = {}; propForm = null; hotelCats(active); };
  const cancel = $('#cfCancel'); if (cancel) cancel.onclick = () => { catForm = null; hotelCats(active); };
  document.querySelectorAll('.catEdit').forEach(b => b.onclick = () => { catForm = list.find(x => x.id === b.dataset.id) || {}; propForm = null; hotelCats(active); });
  document.querySelectorAll('.catDel').forEach(b => b.onclick = async () => {
    const c = list.find(x => x.id === b.dataset.id);
    if (!confirm('Удалить категорию «' + (c && c.name || '') + '»? Будут удалены её доступность и тарифы.')) return;
    const { error } = await db.from('room_type').delete().eq('id', b.dataset.id);
    if (error) alert(error.message); else { catForm = null; hotelCats(active); }
  });
  const save = $('#cfSave'); if (save) save.onclick = async () => {
    const name = ($('#cfName').value || '').trim();
    if (!name) { $('#cfMsg').innerHTML = '<span style="color:var(--red)">Укажите название.</span>'; return; }
    const payload = {
      name,
      short_name: ($('#cfShort').value || '').trim() || null,
      max_occupancy: Math.max(1, parseInt($('#cfOcc').value || '2', 10)),
      default_availability: Math.max(0, parseInt($('#cfDef').value || '0', 10)),
      is_active: $('#cfAct').value === '1',
      photo_url: catGallery[0] || null,
      photos: catGallery.slice(),
    };
    let error;
    if (catForm.id) ({ error } = await db.from('room_type').update(payload).eq('id', catForm.id));
    else { payload.property_id = $('#cfProp').value; ({ error } = await db.from('room_type').insert(payload)); }
    if (error) { $('#cfMsg').innerHTML = `<span style="color:var(--red)">${esc(error.message)}</span>`; return; }
    catForm = null; hotelCats(active);
  };
}

async function hotelBookings(active) {
  const main = $('#main'); if (!main) return;
  ensureBkgStyle();
  const { data: props } = await db.from('property').select('id,name').eq('org_id', active.orgId).order('name');
  const propList = props || [];
  if (!propList.length) { main.innerHTML = `<div class="page-head"><div><h1>Шахматка броней</h1></div></div><div class="card"><div class="card-empty">Нет объектов.</div></div>`; return; }
  if (!bkProp || !propList.some(p => p.id === bkProp)) bkProp = propList[0].id;

  const today = new Date();
  if (!bkFrom) bkFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const N = 31;
  const days = []; for (let i = 0; i < N; i++) days.push(addDays(bkFrom, i));
  const endExcl = addDays(bkFrom, N);

  const { data: ts } = await db.from('room_type').select('id,name,default_availability').eq('property_id', bkProp).eq('is_active', true).order('name');
  const rts = ts || [];
  const rtIds = rts.map(r => r.id);

  const [{ data: al }, { data: lines }] = await Promise.all([
    rtIds.length ? db.from('room_allotment').select('room_type_id,day,quantity,closed').in('room_type_id', rtIds).gte('day', bkFrom).lt('day', endExcl) : Promise.resolve({ data: [] }),
    rtIds.length ? db.from('request_line').select('id,resource_id,from_date,to_date,quantity,confirmation,request_id').eq('type', 'HOTEL').in('resource_id', rtIds).lt('from_date', endExcl).gt('to_date', bkFrom).neq('confirmation', 'rejected') : Promise.resolve({ data: [] }),
  ]);
  const allot = {}; (al || []).forEach(a => allot[a.room_type_id + '|' + a.day] = { quantity: a.quantity, closed: a.closed });
  const defOf = {}; rts.forEach(r => defOf[r.id] = r.default_availability || 0);
  const baseAvail = (rtId, d) => { const a = allot[rtId + '|' + d]; return a ? (a.closed ? 0 : a.quantity) : (defOf[rtId] || 0); };

  const reqIds = [...new Set((lines || []).map(l => l.request_id))];
  const { data: reqs } = reqIds.length ? await db.from('request').select('id,name,client_name').in('id', reqIds) : { data: [] };
  const reqName = {}; (reqs || []).forEach(r => reqName[r.id] = r.name || r.client_name || 'Бронь');

  const linesByRt = {}; (lines || []).forEach(l => { (linesByRt[l.resource_id] = linesByRt[l.resource_id] || []).push(l); });

  const headCells = days.map(d => { const dt = new Date(d + 'T00:00:00Z'), g = dt.getUTCDay(); return `<th class="${g === 0 || g === 6 ? 'we' : ''}">${dt.getUTCDate()}<br><span style="font-weight:400">${RU_WD[g]}</span></th>`; }).join('');

  const sections = rts.map(rt => {
    const insts = [];
    (linesByRt[rt.id] || []).forEach(l => {
      const lbl = reqName[l.request_id] || 'Бронь';
      for (let i = 0; i < l.quantity; i++) insts.push({ from: l.from_date, to: l.to_date, conf: l.confirmation, lbl });
    });
    insts.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
    const slotEnd = [];
    insts.forEach(ins => { let s = slotEnd.findIndex(e => e <= ins.from); if (s < 0) { s = slotEnd.length; slotEnd.push(ins.to); } else slotEnd[s] = ins.to; ins.slot = s; });
    let peak = 0; days.forEach(d => { peak = Math.max(peak, baseAvail(rt.id, d)); });
    const nSlots = Math.min(25, Math.max(slotEnd.length, peak, 1));
    const cellInst = {};
    insts.forEach(ins => { let c = ins.from; while (c < ins.to) { cellInst[ins.slot + '|' + c] = { ins, start: c === ins.from }; c = addDays(c, 1); } });

    const availRow = `<tr class="catrow"><td class="rh">${esc(rt.name)}</td>${days.map(d => `<td class="av" title="доступно ${baseAvail(rt.id, d)}">${baseAvail(rt.id, d)}</td>`).join('')}</tr>`;
    const slotRows = [];
    for (let s = 0; s < nSlots; s++) {
      let cells = '', i = 0;
      while (i < days.length) {
        const d = days[i], ci = cellInst[s + '|' + d];
        if (ci) {
          let span = 0, c = d;
          while (c < ci.ins.to && (i + span) < days.length) { span++; c = addDays(c, 1); }
          const cls = ci.ins.conf === 'confirmed' ? 'conf' : 'pend';
          cells += `<td class="b ${cls}" colspan="${span}" title="${esc(ci.ins.lbl)} · ${ci.ins.conf === 'confirmed' ? 'подтверждено' : 'холд'}">${esc(ci.ins.lbl)}</td>`;
          i += span;
        } else {
          const dt = new Date(d + 'T00:00:00Z'), we = (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
          cells += `<td class="${we ? 'wecell' : ''}"></td>`; i++;
        }
      }
      slotRows.push(`<tr><td class="rh slot">место ${s + 1}</td>${cells}</tr>`);
    }
    return availRow + slotRows.join('');
  }).join('');

  const monLabel = new Date(bkFrom + 'T00:00:00Z').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  main.innerHTML = `
    <div class="page-head"><div><h1>Шахматка броней</h1><div class="sub">Кто и когда забронировал. Полоса — бронь тура; «холд» ждёт вашего подтверждения во вкладке «Подтверждения».</div></div></div>
    <div class="card"><div class="card-head">Объект и период</div><div style="padding:14px">
      <div class="sha-nav">
        ${propList.length > 1 ? `<select class="input" id="bkProp" style="max-width:260px">${propList.map(p => `<option value="${p.id}" ${p.id === bkProp ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
        <button class="btn btn--ghost btn--sm" id="bkPrev">‹</button>
        <b style="min-width:160px;text-align:center;text-transform:capitalize">${monLabel}</b>
        <button class="btn btn--ghost btn--sm" id="bkNext">›</button>
        <button class="btn btn--ghost btn--sm" id="bkToday">Текущий месяц</button>
      </div>
      ${rts.length ? `<div class="bkg-wrap"><table class="bkg"><thead><tr><th class="rh">Категория / место</th>${headCells}</tr></thead><tbody>${sections}</tbody></table></div>
      <div class="bkg-leg">
        <span><i style="background:var(--accent-soft)"></i>подтверждено</span>
        <span><i style="background:var(--amber-bg)"></i>холд (ждёт подтверждения)</span>
        <span>число в строке категории = доступно на дату</span>
      </div>` : `<div class="card-empty">Нет активных категорий. Создайте их во вкладке «Категории».</div>`}
    </div></div>`;

  const ps = $('#bkProp'); if (ps) ps.onchange = e => { bkProp = e.target.value; hotelBookings(active); };
  $('#bkPrev').onclick = () => { const d = new Date(bkFrom + 'T00:00:00Z'); bkFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10); hotelBookings(active); };
  $('#bkNext').onclick = () => { const d = new Date(bkFrom + 'T00:00:00Z'); bkFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); hotelBookings(active); };
  $('#bkToday').onclick = () => { const t = new Date(); bkFrom = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).toISOString().slice(0, 10); hotelBookings(active); };
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
  const { data: vcs } = await db.from('vehicle_class').select('id,name,pax_min,pax_max,cities').eq('org_id', active.orgId).order('pax_min');
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
        <div class="field" style="flex:1;min-width:220px"><label>Города (через запятую)</label><input class="input" id="flCities" placeholder="Ташкент, Чарвак, Акташ"></div>
        <button class="btn btn--primary btn--sm" id="flSave">Добавить</button>
      </div>
      <div class="hint" id="flCalc" style="margin-top:8px"></div>
      <div id="flMsg"></div>
    </div></div>
    <div class="card"><div class="card-head">Мой автопарк</div>
    ${(vcs||[]).length ? `<table><thead><tr><th>Класс</th><th>Pax</th><th style="text-align:right">Ваша цена (net)</th><th style="text-align:right">Цена DMC (sell)</th><th style="text-align:right">Комиссия Waylo</th><th>Города</th><th></th></tr></thead><tbody>
      ${vcs.map(v => { const r = rByVc[v.id]; const net = r?.net_price_per_unit ?? null, sell = r?.sell_price_per_unit ?? null; const com = (net!=null && sell!=null) ? (sell - net) : null; return `<tr><td>${esc(v.name)}</td><td class="mono">${v.pax_min}–${v.pax_max}</td><td class="price" style="text-align:right">${money(net,r?.currency)}</td><td class="price" style="text-align:right">${money(sell,r?.currency)}</td><td class="mono" style="text-align:right">${money(com,r?.currency)}</td><td><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${(v.cities&&v.cities.length)?v.cities.map(c=>`<span class="badge badge--gray">${esc(c)}</span>`).join(''):'<span class="hint">все города</span>'} <button class="btn btn--ghost btn--sm flCit" data-id="${v.id}">Изменить</button></div></td><td style="text-align:right"><button class="btn btn--ghost btn--sm flDel" data-id="${v.id}">Удалить</button></td></tr>`; }).join('')}
    </tbody></table>` : `<div class="card-empty">Автопарк пуст — добавьте класс выше.</div>`}</div>`;
  const calc = () => { const net = Number($('#flNet').value || 0); $('#flCalc').textContent = net > 0 ? `DMC увидит ${money(Math.round(net*1.1))}, комиссия Waylo ${money(Math.round(net*1.1)-net)} (10%).` : ''; };
  $('#flNet').oninput = calc;
  $('#flSave').onclick = async () => {
    const t = FLEET_TIERS[Number($('#flTier').value)]; const net = Number($('#flNet').value || 0);
    if (!t || net <= 0) { $('#flMsg').innerHTML = `<div class="notice notice--err">Укажите класс и цену.</div>`; return; }
    const flCities = ($('#flCities').value || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    const { data: vc, error: e1 } = await db.from('vehicle_class').insert({ org_id:active.orgId, name:t.name, pax_min:t.pax_min, pax_max:t.pax_max, cities: flCities.length ? flCities : null }).select().single();
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
  document.querySelectorAll('.flCit').forEach(b => b.onclick = async () => {
    const v = (vcs || []).find(x => x.id === b.dataset.id);
    const cur = (v && v.cities && v.cities.length) ? v.cities.join(', ') : '';
    const raw = prompt('Города обслуживания через запятую (пусто = все города):', cur);
    if (raw === null) return;
    const cities = raw.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    const { error } = await db.from('vehicle_class').update({ cities: cities.length ? cities : null }).eq('id', b.dataset.id);
    if (error) { $('#flMsg') && ($('#flMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`); }
    else transportFleet(active);
  });
}

let shaFromT = null; // окно шахматки трансфера

async function transportAvail(active) {
  const main = $('#main'); if (!main) return;
  ensureShaStyle();
  const N = 21;
  if (!shaFromT) shaFromT = new Date().toISOString().slice(0, 10);
  const fromD = shaFromT, toD = addDays(shaFromT, N);
  const days = []; for (let i = 0; i < N; i++) days.push(addDays(shaFromT, i));

  const { data: vcs } = await db.from('vehicle_class').select('id,name,pax_min,pax_max,cities').eq('org_id', active.orgId).order('pax_min');
  const classes = (vcs || []).map(v => ({ id: v.id, label: `${v.name} (${v.pax_min}–${v.pax_max} pax)` }));
  const ids = classes.map(c => c.id);

  const [{ data: av }, { data: hd }] = await Promise.all([
    ids.length ? db.from('transport_availability').select('vehicle_class_id,day,units').in('vehicle_class_id', ids).gte('day', fromD).lt('day', toD) : Promise.resolve({ data: [] }),
    ids.length ? db.from('hold').select('resource_id,day,quantity,status').eq('resource_type', 'vehicle').in('resource_id', ids).gte('day', fromD).lt('day', toD).in('status', ['held', 'confirmed']) : Promise.resolve({ data: [] }),
  ]);
  const units = {}; (av || []).forEach(a => { units[a.vehicle_class_id + '|' + a.day] = a.units; });
  const held = {}, conf = {};
  (hd || []).forEach(h => { const k = h.resource_id + '|' + h.day; if (h.status === 'confirmed') conf[k] = (conf[k] || 0) + h.quantity; else held[k] = (held[k] || 0) + h.quantity; });

  const wd = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const headCells = days.map(d => {
    const dt = new Date(d + 'T00:00:00Z'); const g = dt.getUTCDay(); const we = (g === 0 || g === 6);
    return `<th class="${we ? 'we' : ''}">${dt.getUTCDate()}<br><span class="wd">${wd[g]}</span></th>`;
  }).join('');

  const cell = (vcId, d) => {
    const k = vcId + '|' + d, total = units[k];
    if (total == null) return `<td class="cell" style="background:#f4f5f6;color:var(--muted)" title="Доступность не задана">·</td>`;
    const h = held[k] || 0, c = conf[k] || 0, free = total - h - c;
    let bg, col;
    if (free <= 0) { bg = 'var(--red-bg)'; col = 'var(--red)'; }
    else if (h + c > 0) { bg = 'var(--amber-bg)'; col = 'var(--amber)'; }
    else { bg = 'var(--green-bg)'; col = 'var(--green)'; }
    return `<td class="cell" style="background:${bg};color:${col}" title="Свободно ${free} из ${total} · холд ${h} · подтв ${c}">${free}</td>`;
  };

  const rows = classes.length ? classes.map(c => `<tr><td class="rh">${esc(c.label)}</td>${days.map(d => cell(c.id, d)).join('')}</tr>`).join('')
    : `<tr><td class="rh" colspan="${N + 1}" style="color:var(--muted);font-weight:400">Нет классов машин. Добавьте автопарк.</td></tr>`;

  main.innerHTML = `
    <div class="page-head"><div><h1>Доступность</h1><div class="sub">Шахматка машин: сколько свободно по датам. Цвет — свободно / есть холды / занято.</div></div></div>
    <div class="card"><div class="card-head">Выделить машины под Waylo</div><div style="padding:14px">
      <div class="row">
        <div class="field" style="min-width:240px"><label>Класс машины</label><select class="input" id="tvVc"><option value="">— выбрать —</option>${classes.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field"><label>С даты</label><input type="date" id="tvFrom" value="${fromD}"></div>
        <div class="field"><label>По дату (вкл.)</label><input type="date" id="tvTo" value="${days[N - 1]}"></div>
        <div class="field" style="width:90px"><label>Машин</label><input type="number" min="0" value="1" id="tvUnits"></div>
        <button class="btn btn--primary btn--sm" id="tvSave">Выделить</button>
      </div><div class="hint" style="margin-top:6px">Выставит количество на каждый день диапазона (перезапишет существующее).</div><div id="tvMsg"></div></div></div>
    <div class="card"><div class="card-head">Шахматка · ${fromD} — ${days[N - 1]}</div><div style="padding:14px">
      <div class="sha-nav">
        <button class="btn btn--ghost btn--sm" id="shaPrevT">‹ Раньше</button>
        <button class="btn btn--ghost btn--sm" id="shaTodayT">Сегодня</button>
        <button class="btn btn--ghost btn--sm" id="shaNextT">Позже ›</button>
        <input type="date" id="shaJumpT" value="${fromD}" style="margin-left:6px">
      </div>
      <div class="sha-wrap"><table class="sha"><thead><tr><th class="rh">Класс машины</th>${headCells}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="sha-leg">
        <span><i style="background:var(--green-bg)"></i>свободно</span>
        <span><i style="background:var(--amber-bg)"></i>есть холды</span>
        <span><i style="background:var(--red-bg)"></i>занято</span>
        <span><i style="background:#f4f5f6"></i>не задано</span>
        <span>число в ячейке = свободных машин</span>
      </div>
    </div></div>`;

  $('#tvSave').onclick = async () => {
    const vc = $('#tvVc').value, f = $('#tvFrom').value, tt = $('#tvTo').value, u = Number($('#tvUnits').value || 0);
    if (!vc || !f || !tt) { $('#tvMsg').innerHTML = `<div class="notice notice--err">Выберите класс и обе даты.</div>`; return; }
    if (f > tt) { $('#tvMsg').innerHTML = `<div class="notice notice--err">«С даты» позже, чем «по дату».</div>`; return; }
    const batch = []; let cur = f; let guard = 0;
    while (cur <= tt && guard < 400) { batch.push({ vehicle_class_id: vc, day: cur, units: u }); cur = addDays(cur, 1); guard++; }
    const { error } = await db.from('transport_availability').upsert(batch, { onConflict: 'vehicle_class_id,day' });
    if (error) $('#tvMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`;
    else transportAvail(active);
  };
  $('#shaPrevT').onclick = () => { shaFromT = addDays(shaFromT, -N); transportAvail(active); };
  $('#shaNextT').onclick = () => { shaFromT = addDays(shaFromT, N); transportAvail(active); };
  $('#shaTodayT').onclick = () => { shaFromT = new Date().toISOString().slice(0, 10); transportAvail(active); };
  $('#shaJumpT').onchange = (e) => { if (e.target.value) { shaFromT = e.target.value; transportAvail(active); } };
}

/* ── PLATFORM ────────────────────────────────────────────────────────────── */
const ORG_BADGE = { DMC:'blue', HOTEL:'green', TRANSPORT:'amber', PLATFORM:'accent' };

let priceForm = null;  // null | {room_type_id, id?, ...} — форма тарифа номера (только платформа)
let feeEdit = false;   // редактирование настройки сервисного сбора

/* ── Платформа · Цены ───────────────────────────────────────────────────────
   Прозрачная модель (0017): DMC видит НЕТТО (sell = net). Доход Waylo — отдельный
   раскрытый сервисный сбор (platform_setting.service_fee), применяется к счёту в
   0018. Здесь платформа задаёт нетто-цену на категорию и настраивает сбор. */
async function platformPricing() {
  const main = $('#main'); if (!main) return;
  const [{ data: props }, { data: types }, { data: rates, error }, { data: settings }] = await Promise.all([
    db.from('property').select('id,name,city,org_id,is_active').order('name'),
    db.from('room_type').select('id,property_id,name,short_name,is_active').order('name'),
    db.from('room_rate').select('id,room_type_id,valid_from,valid_to,net_price,sell_price,supplier_retail,sgl_supplement,currency').order('valid_from'),
    db.from('platform_setting').select('key,value').eq('key', 'service_fee'),
  ]);
  if (error) { main.innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; return; }
  const fee = (settings && settings[0] && settings[0].value) || { fee_type: 'percent', fee_value: 0, currency: 'USD' };
  const feeText = fee.fee_type === 'fixed' ? `${money(fee.fee_value, fee.currency || 'USD')} за бронь` : `${Number(fee.fee_value) || 0}% от нетто`;
  const pById = Object.fromEntries((props || []).map(p => [p.id, p]));
  const ratesByRt = {}; (rates || []).forEach(r => { (ratesByRt[r.room_type_id] = ratesByRt[r.room_type_id] || []).push(r); });
  const typeList = (types || []).filter(t => pById[t.property_id]);
  const byProp = {};
  typeList.forEach(t => { (byProp[t.property_id] = byProp[t.property_id] || []).push(t); });
  const propIds = Object.keys(byProp).sort((a, b) => (pById[a].name || '').localeCompare(pById[b].name || '', 'ru'));

  // ── форма тарифа: одна нетто-цена (sell = net) ──
  let formHtml = '';
  if (priceForm) {
    const f = priceForm, isEdit = !!f.id;
    const rt = typeList.find(t => t.id === f.room_type_id);
    const pr = rt && pById[rt.property_id];
    const price = f.net_price != null ? f.net_price : (f.sell_price != null ? f.sell_price : '');
    formHtml = `<div class="card" style="margin-bottom:14px"><div class="card-head">${isEdit ? 'Изменить тариф' : 'Новый тариф'} · ${esc(pr ? pr.name : '')} — ${esc(rt ? rt.name : '')}</div><div style="padding:14px">
      <div class="row">
        <div class="field" style="width:170px"><label>Цена нетто (видит DMC)</label><input type="number" min="0" step="0.01" class="input" id="prPrice" value="${price}" placeholder="50"></div>
        <div class="field" style="width:150px"><label>SGL-надбавка</label><input type="number" min="0" step="0.01" class="input" id="prSgl" value="${f.sgl_supplement != null ? f.sgl_supplement : 0}"></div>
        <div class="field" style="width:150px"><label>Retail (опц.)</label><input type="number" min="0" step="0.01" class="input" id="prRetail" value="${f.supplier_retail != null ? f.supplier_retail : ''}" placeholder="—"></div>
        <div class="field" style="width:90px"><label>Валюта</label><input class="input" id="prCur" value="${esc(f.currency || 'USD')}"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div class="field" style="width:160px"><label>Действует с</label><input type="date" class="input" id="prFrom" value="${esc(f.valid_from || '2026-01-01')}"></div>
        <div class="field" style="width:160px"><label>по</label><input type="date" class="input" id="prTo" value="${esc(f.valid_to || '2026-12-31')}"></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button class="btn btn--primary btn--sm" id="prSave">${isEdit ? 'Сохранить' : 'Создать тариф'}</button>
        <button class="btn btn--ghost btn--sm" id="prCancel">Отмена</button>
        <span id="prMsg" class="hint"></span>
      </div>
      <div class="hint" style="margin-top:8px">Прозрачно: DMC видит эту цену как есть. Доход Waylo — отдельный сервисный сбор (см. сверху), применяется к счёту. Retail, если задан, должен быть больше цены.</div>
    </div></div>`;
  }

  main.innerHTML = `
    <div class="page-head"><div><h1>Цены</h1><div class="sub">Прозрачные нетто-тарифы на категории. DMC видит нетто; доход Waylo — отдельный раскрытый сбор.</div></div></div>
    <div id="prTop"></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head">Сервисный сбор Waylo</div><div style="padding:14px">
      ${feeEdit ? `<div class="row" style="align-items:flex-end">
        <div class="field" style="width:200px"><label>Тип сбора</label><select class="input" id="feeType"><option value="percent" ${fee.fee_type !== 'fixed' ? 'selected' : ''}>% от нетто</option><option value="fixed" ${fee.fee_type === 'fixed' ? 'selected' : ''}>фикс за бронь</option></select></div>
        <div class="field" style="width:140px"><label>Значение</label><input type="number" min="0" step="0.01" class="input" id="feeVal" value="${Number(fee.fee_value) || 0}"></div>
        <div class="field" style="width:90px"><label>Валюта</label><input class="input" id="feeCur" value="${esc(fee.currency || 'USD')}"></div>
        <button class="btn btn--primary btn--sm" id="feeSave">Сохранить</button>
        <button class="btn btn--ghost btn--sm" id="feeCancel">Отмена</button>
      </div>` : `<div style="display:flex;align-items:center;gap:12px"><div><b>${esc(feeText)}</b> <span class="hint">— раскрытая строка в счёте (применяется в 0018)</span></div><button class="btn btn--ghost btn--sm" id="feeEditBtn">Изменить</button></div>`}
    </div></div>
    ${formHtml}
    ${propIds.length ? propIds.map(pid => {
      const p = pById[pid];
      return `<div class="card" style="margin-bottom:12px"><div class="card-head">${esc(p.name)} · <span class="hint">${esc(p.city || '')}</span></div>
      <table><thead><tr><th>Категория</th><th>Период</th><th style="text-align:right">Цена нетто (= DMC)</th><th style="text-align:right">SGL</th><th></th></tr></thead><tbody>
      ${byProp[pid].map(rt => {
        const rs = ratesByRt[rt.id] || [];
        const addBtn = `<button class="btn btn--ghost btn--sm prAdd" data-rt="${rt.id}">+ тариф</button>`;
        if (!rs.length) return `<tr><td><b>${esc(rt.name)}</b>${rt.is_active === false ? ' <span class="badge">выкл</span>' : ''}</td><td colspan="3" class="card-empty" style="padding:8px">Цена не задана — DMC не видит эту категорию</td><td style="text-align:right">${addBtn}</td></tr>`;
        return rs.map((r, i) => `<tr><td>${i === 0 ? `<b>${esc(rt.name)}</b>` : ''}</td><td class="hint">${esc(r.valid_from)} — ${esc(r.valid_to)}</td><td class="price" style="text-align:right">${money(r.sell_price, r.currency)}</td><td class="mono" style="text-align:right">${money(r.sgl_supplement, r.currency)}</td><td style="text-align:right;white-space:nowrap"><button class="btn btn--ghost btn--sm prEdit" data-id="${r.id}">Изменить</button> <button class="btn btn--ghost btn--sm prDel" data-id="${r.id}">✕</button>${i === rs.length - 1 ? ' ' + addBtn : ''}</td></tr>`).join('');
      }).join('')}
      </tbody></table></div>`;
    }).join('') : `<div class="card"><div class="card-empty">Пока нет категорий. Их создаёт отель/резорт в своём кабинете (вкладка «Категории»).</div></div>`}`;

  // ── сервисный сбор ──
  const feeBtn = $('#feeEditBtn'); if (feeBtn) feeBtn.onclick = () => { feeEdit = true; platformPricing(); };
  const feeCancel = $('#feeCancel'); if (feeCancel) feeCancel.onclick = () => { feeEdit = false; platformPricing(); };
  const feeSave = $('#feeSave'); if (feeSave) feeSave.onclick = async () => {
    const value = { fee_type: $('#feeType').value, fee_value: parseFloat($('#feeVal').value || '0') || 0, currency: ($('#feeCur').value || 'USD').trim().toUpperCase() };
    const { error } = await db.from('platform_setting').upsert({ key: 'service_fee', value }, { onConflict: 'key' });
    if (error) { $('#prTop').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; return; }
    feeEdit = false; platformPricing();
  };

  // ── тарифы ──
  const allRates = rates || [];
  const padd = (rtId) => { priceForm = { room_type_id: rtId, sgl_supplement: 0, currency: 'USD', valid_from: '2026-01-01', valid_to: '2026-12-31' }; platformPricing(); };
  document.querySelectorAll('.prAdd').forEach(b => b.onclick = () => padd(b.dataset.rt));
  document.querySelectorAll('.prEdit').forEach(b => b.onclick = () => { priceForm = allRates.find(r => r.id === b.dataset.id) || null; platformPricing(); });
  document.querySelectorAll('.prDel').forEach(b => b.onclick = async () => {
    if (!confirm('Удалить тариф? DMC перестанет видеть эту цену.')) return;
    const { error } = await db.from('room_rate').delete().eq('id', b.dataset.id);
    if (error) $('#prTop').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; else { priceForm = null; platformPricing(); }
  });
  const cancel = $('#prCancel'); if (cancel) cancel.onclick = () => { priceForm = null; platformPricing(); };
  const save = $('#prSave'); if (save) save.onclick = async () => {
    const price = parseFloat($('#prPrice').value);
    const retailRaw = ($('#prRetail').value || '').trim();
    const retail = retailRaw === '' ? null : parseFloat(retailRaw);
    const sgl = parseFloat($('#prSgl').value || '0') || 0;
    const cur = ($('#prCur').value || 'USD').trim().toUpperCase();
    const from = $('#prFrom').value, to = $('#prTo').value;
    const msg = (t) => { $('#prMsg').innerHTML = `<span style="color:var(--red)">${esc(t)}</span>`; };
    if (!(price >= 0)) return msg('Укажите цену нетто.');
    if (retail != null && !(price < retail)) return msg('Retail должен быть больше цены.');
    if (!from || !to || from > to) return msg('Период задан неверно.');
    // прозрачно: net = sell = нетто-цена
    const payload = { net_price: price, sell_price: price, supplier_retail: retail, sgl_supplement: sgl, currency: cur, valid_from: from, valid_to: to };
    let error;
    if (priceForm.id) ({ error } = await db.from('room_rate').update(payload).eq('id', priceForm.id));
    else { payload.room_type_id = priceForm.room_type_id; ({ error } = await db.from('room_rate').insert(payload)); }
    if (error) return msg(error.message);
    priceForm = null; platformPricing();
  };
}

/* ── Платформа · Журнал событий (read-only) ─────────────────────────────────
   Лента из event_log (0016). RLS отдаёт её только платформе. Неизменяемая. */
async function platformLog() {
  const main = $('#main'); if (!main) return;
  const { data: rows, error } = await db.from('event_log')
    .select('id, actor, action, entity_type, entity_id, request_id, at')
    .order('at', { ascending: false }).limit(200);
  if (error) { main.innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; return; }
  const ACT = { insert:['green','создано'], update:['blue','изменено'], delete:['red','удалено'] };
  const fmt = (t) => { try { return new Date(t).toLocaleString('ru-RU'); } catch (_e) { return t; } };
  main.innerHTML = `
    <div class="page-head"><div><h1>Журнал событий</h1><div class="sub">Неизменяемая лента действий: заявки, линии, брони, цены. Последние 200.</div></div></div>
    <div class="card"><div class="card-head">События (${(rows || []).length})</div>
    ${(rows || []).length ? `<table><thead><tr><th>Время</th><th>Кто</th><th>Действие</th><th>Сущность</th><th>Заявка</th></tr></thead><tbody>
      ${rows.map(r => { const op = String(r.action || '').split('.').pop(); const [c, l] = ACT[op] || ['gray', op]; return `<tr><td class="hint">${esc(fmt(r.at))}</td><td>${esc(r.actor?.email || '—')}</td><td><span class="badge badge--${c}">${esc(l)}</span> <span class="hint">${esc(r.entity_type)}</span></td><td class="id-cell">${short(r.entity_id)}</td><td class="id-cell">${r.request_id ? short(r.request_id) : '—'}</td></tr>`; }).join('')}
    </tbody></table>` : `<div class="card-empty">Событий пока нет.</div>`}</div>`;
}

/* ── Оплаты (MVP, 0018) ──────────────────────────────────────────────────────
   Сумма к оплате = Σ(sell × кол-во × ночи) + сервисный сбор (platform_setting).
   DMC выставляет счёт (payment_code), платформа (фин.) отмечает оплату вручную —
   через apply_payment_event (единый шов; банк/n8n позже в ту же точку). */
const _nights = (l) => Math.max(1, Math.round((new Date(l.to_date) - new Date(l.from_date)) / 86400000));
function _feeOf(fee, linesTotal) {
  if (!fee) return 0;
  return fee.fee_type === 'fixed' ? (Number(fee.fee_value) || 0) : Math.round(linesTotal * (Number(fee.fee_value) || 0)) / 100;
}

async function dmcPayments(active) {
  const main = $('#main'); if (!main) return;
  const [{ data: reqs }, { data: setting }] = await Promise.all([
    db.from('request').select('id,name,client_name,status,payment_code,due_date,currency,created_at').eq('dmc_org_id', active.orgId).order('created_at', { ascending: false }),
    db.from('platform_setting').select('value').eq('key', 'service_fee'),
  ]);
  const ids = (reqs || []).map(r => r.id);
  const [{ data: lines }, { data: events }] = await Promise.all([
    ids.length ? db.from('request_line').select('request_id,sell_price,quantity,from_date,to_date,confirmation').in('request_id', ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from('payment_event').select('request_id,amount,status').in('request_id', ids) : Promise.resolve({ data: [] }),
  ]);
  const fee = (setting && setting[0] && setting[0].value) || { fee_type: 'percent', fee_value: 0 };
  const linesBy = {}; (lines || []).forEach(l => { (linesBy[l.request_id] = linesBy[l.request_id] || []).push(l); });
  const paidBy = {}; (events || []).forEach(e => { if (e.status === 'paid') paidBy[e.request_id] = (paidBy[e.request_id] || 0) + Number(e.amount || 0); });
  const confBy = {}; (lines || []).forEach(l => { if (l.confirmation === 'confirmed') confBy[l.request_id] = true; });
  const lt = (id) => (linesBy[id] || []).reduce((s, l) => s + Number(l.sell_price || 0) * l.quantity * _nights(l), 0);
  const total = (id) => { const x = lt(id); return x + _feeOf(fee, x); };

  main.innerHTML = `
    <div class="page-head"><div><h1>Оплаты</h1><div class="sub">Счёт к оплате по туру: проживание + транспорт + сервисный сбор Waylo. Выставьте счёт и оплатите по коду.</div></div></div>
    <div id="payMsg"></div>
    <div class="card"><div class="card-head">Туры и счета</div>
    ${(reqs || []).length ? `<table><thead><tr><th>Тур</th><th>Клиент</th><th style="text-align:right">Линии</th><th style="text-align:right">Сбор</th><th style="text-align:right">К оплате</th><th>Код платежа</th><th>Статус</th><th></th></tr></thead><tbody>
      ${reqs.map(r => { const x = lt(r.id), f = _feeOf(fee, x), t = x + f, paid = paidBy[r.id] || 0; const isPaid = t > 0 && paid >= t;
        return `<tr>
          <td><b>${esc(r.name || '—')}</b></td>
          <td class="hint">${esc(r.client_name || '—')}</td>
          <td class="price" style="text-align:right">${money(x, r.currency)}</td>
          <td class="price" style="text-align:right">${money(f, r.currency)}</td>
          <td class="price" style="text-align:right"><b>${money(t, r.currency)}</b></td>
          <td class="mono">${r.payment_code ? esc(r.payment_code) : '<span class="hint">—</span>'}${r.due_date ? `<div class="hint">до ${esc(r.due_date)}</div>` : ''}</td>
          <td>${isPaid ? '<span class="badge badge--green">оплачено</span>' : r.payment_code ? '<span class="badge badge--amber">ожидает оплаты</span>' : '<span class="badge badge--gray">счёт не выставлен</span>'}</td>
          <td style="text-align:right">${!r.payment_code && t > 0 ? `<button class="btn btn--primary btn--sm issInv" data-req="${r.id}">Выставить счёт</button>` : ''}${isPaid && confBy[r.id] ? ` <button class="btn btn--ghost btn--sm vouBtn" data-req="${r.id}">Ваучер</button>` : ''}</td>
        </tr>`; }).join('')}
    </tbody></table>` : `<div class="card-empty">Туров пока нет. Создайте тур во вкладке «Туры» и забронируйте.</div>`}</div>`;

  document.querySelectorAll('.issInv').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Выставляем…';
    const { error } = await db.rpc('issue_request_invoice', { p_request: b.dataset.req });
    if (error) { $('#payMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; b.disabled = false; b.textContent = 'Выставить счёт'; }
    else dmcPayments(active);
  });
  document.querySelectorAll('.vouBtn').forEach(b => b.onclick = () => dmcVoucher(active, b.dataset.req));
}

async function platformPayments() {
  const main = $('#main'); if (!main) return;
  const [{ data: reqs }, { data: orgs }, { data: setting }] = await Promise.all([
    db.from('request').select('id,name,dmc_org_id,payment_code,due_date,currency,created_at').not('payment_code', 'is', null).order('created_at', { ascending: false }),
    db.from('organization').select('id,name'),
    db.from('platform_setting').select('value').eq('key', 'service_fee'),
  ]);
  const ids = (reqs || []).map(r => r.id);
  const [{ data: lines }, { data: events }] = await Promise.all([
    ids.length ? db.from('request_line').select('request_id,sell_price,quantity,from_date,to_date').in('request_id', ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from('payment_event').select('request_id,amount,status').in('request_id', ids) : Promise.resolve({ data: [] }),
  ]);
  const fee = (setting && setting[0] && setting[0].value) || { fee_type: 'percent', fee_value: 0 };
  const orgName = Object.fromEntries((orgs || []).map(o => [o.id, o.name]));
  const linesBy = {}; (lines || []).forEach(l => { (linesBy[l.request_id] = linesBy[l.request_id] || []).push(l); });
  const paidBy = {}; (events || []).forEach(e => { if (e.status === 'paid') paidBy[e.request_id] = (paidBy[e.request_id] || 0) + Number(e.amount || 0); });
  const lt = (id) => (linesBy[id] || []).reduce((s, l) => s + Number(l.sell_price || 0) * l.quantity * _nights(l), 0);

  main.innerHTML = `
    <div class="page-head"><div><h1>Оплаты</h1><div class="sub">Выставленные счета покупателям. Отметка оплаты — единая точка фиксации (apply_payment_event); позже сюда подключится банк/n8n.</div></div></div>
    <div id="ppMsg"></div>
    <div class="card"><div class="card-head">Счета (${(reqs || []).length})</div>
    ${(reqs || []).length ? `<table><thead><tr><th>Тур</th><th>DMC</th><th>Код</th><th style="text-align:right">К оплате</th><th style="text-align:right">Оплачено</th><th>Статус</th><th></th></tr></thead><tbody>
      ${reqs.map(r => { const x = lt(r.id), t = x + _feeOf(fee, x), paid = paidBy[r.id] || 0; const isPaid = t > 0 && paid >= t;
        return `<tr>
          <td><b>${esc(r.name || '—')}</b>${r.due_date ? ` <span class="hint">до ${esc(r.due_date)}</span>` : ''}</td>
          <td>${esc(orgName[r.dmc_org_id] || '—')}</td>
          <td class="mono">${esc(r.payment_code || '—')}</td>
          <td class="price" style="text-align:right"><b>${money(t, r.currency)}</b></td>
          <td class="price" style="text-align:right">${money(paid, r.currency)}</td>
          <td>${isPaid ? '<span class="badge badge--green">оплачено</span>' : '<span class="badge badge--amber">ожидает</span>'}</td>
          <td style="text-align:right">${isPaid ? '✓' : `<button class="btn btn--primary btn--sm markPaid" data-req="${r.id}" data-amt="${(t - paid).toFixed(2)}" data-cur="${esc(r.currency || 'USD')}">Отметить оплачено</button>`}</td>
        </tr>`; }).join('')}
    </tbody></table>` : `<div class="card-empty">Выставленных счетов пока нет.</div>`}</div>`;

  document.querySelectorAll('.markPaid').forEach(b => b.onclick = async () => {
    const def = b.dataset.amt;
    const raw = prompt('Сумма поступившей оплаты:', def);
    if (raw == null) return;
    const amt = parseFloat(raw);
    if (!(amt > 0)) { $('#ppMsg').innerHTML = `<div class="notice notice--err">Сумма должна быть больше 0.</div>`; return; }
    b.disabled = true; b.textContent = 'Проводим…';
    const { error } = await db.rpc('apply_payment_event', { p_request: b.dataset.req, p_amount: amt, p_currency: b.dataset.cur, p_source: 'manual' });
    if (error) { $('#ppMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; b.disabled = false; b.textContent = 'Отметить оплачено'; }
    else platformPayments();
  });
}

/* ── Ваучер (печатный документ из подтверждённой брони, 0020) ────────────────*/
function ensureVoucherStyle() {
  if (document.getElementById('vou-style')) return;
  const st = document.createElement('style'); st.id = 'vou-style';
  st.textContent = '@media print{.topbar,.nav,.no-print{display:none!important}.shell{display:block!important}#content,#main{padding:0!important;margin:0!important}.voucher-card{box-shadow:none!important;border:1px solid #999!important;page-break-inside:avoid}}';
  document.head.appendChild(st);
}

async function dmcVoucher(active, reqId) {
  const main = $('#main'); if (!main) return;
  ensureVoucherStyle();
  const { error: vErr } = await db.rpc('issue_vouchers', { p_request: reqId });   // идемпотентно
  if (vErr) { main.innerHTML = `<div class="notice notice--err">${esc(vErr.message)}</div><div style="margin-top:10px"><button class="btn btn--ghost" id="vouBack">← Назад</button></div>`; const bb = $('#vouBack'); if (bb) bb.onclick = () => dmcPayments(active); return; }
  const [{ data: req }, { data: vouchers }, { data: lines }, { data: orgs }] = await Promise.all([
    db.from('request').select('id,name,client_name,currency').eq('id', reqId).single(),
    db.from('voucher').select('*').eq('request_id', reqId),
    db.from('request_line').select('*').eq('request_id', reqId).eq('confirmation', 'confirmed'),
    db.from('organization').select('id,name'),
  ]);
  const rtIds = (lines || []).filter(l => l.type === 'HOTEL').map(l => l.resource_id);
  const vcIds = (lines || []).filter(l => l.type === 'TRANSPORT').map(l => l.resource_id);
  const [{ data: rts }, { data: vcs }] = await Promise.all([
    rtIds.length ? db.from('room_type').select('id,name,property_id').in('id', rtIds) : Promise.resolve({ data: [] }),
    vcIds.length ? db.from('vehicle_class').select('id,name').in('id', vcIds) : Promise.resolve({ data: [] }),
  ]);
  const propIds = (rts || []).map(r => r.property_id);
  const { data: props } = propIds.length ? await db.from('property').select('id,name,city').in('id', propIds) : { data: [] };
  const propById = Object.fromEntries((props || []).map(p => [p.id, p]));
  const rtById = Object.fromEntries((rts || []).map(r => [r.id, { ...r, prop: propById[r.property_id] }]));
  const vcById = Object.fromEntries((vcs || []).map(v => [v.id, v]));
  const orgName = Object.fromEntries((orgs || []).map(o => [o.id, o.name]));
  const resName = (l) => l.type === 'HOTEL'
    ? `${rtById[l.resource_id]?.prop?.name || ''} — ${rtById[l.resource_id]?.name || ''}${rtById[l.resource_id]?.prop?.city ? ' · ' + rtById[l.resource_id].prop.city : ''}`
    : (vcById[l.resource_id]?.name || 'Транспорт');
  const bySup = {}; (lines || []).forEach(l => { (bySup[l.supplier_org_id] = bySup[l.supplier_org_id] || []).push(l); });
  const vouBySup = Object.fromEntries((vouchers || []).map(v => [v.supplier_org_id, v]));

  main.innerHTML = `
    <div class="page-head no-print"><div><h1>Ваучеры · ${esc(req?.name || '')}</h1><div class="sub">Документ исполнения для поставщика — печатайте и передавайте при заселении/трансфере.</div></div>
      <div><button class="btn btn--ghost" id="vouBack">← Назад</button> <button class="btn btn--primary" id="vouPrint">Печать</button></div></div>
    ${Object.keys(bySup).map(sup => { const v = vouBySup[sup]; return `
      <div class="card voucher-card" style="margin-bottom:14px"><div style="padding:18px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--ink);padding-bottom:10px;margin-bottom:12px">
          <div><div style="font-size:20px;font-weight:700">Waylo Ваучер</div><div class="hint">VOUCHER / CONFIRMATION</div></div>
          <div style="text-align:right"><div class="mono"><b>${esc(v?.voucher_no || '—')}</b></div><div class="hint">${v?.issued_at ? esc(new Date(v.issued_at).toLocaleDateString('ru-RU')) : ''}</div></div>
        </div>
        <div class="row" style="gap:24px;margin-bottom:10px">
          <div><div class="hint">Поставщик</div><b>${esc(orgName[sup] || '—')}</b></div>
          <div><div class="hint">Тур</div><b>${esc(req?.name || '—')}</b></div>
          <div><div class="hint">Турист / группа</div><b>${esc(req?.client_name || '—')}</b></div>
        </div>
        <table><thead><tr><th>Услуга</th><th>Период</th><th style="text-align:center">Кол-во</th></tr></thead><tbody>
          ${bySup[sup].map(l => `<tr><td>${esc(resName(l))}</td><td class="hint">${esc(l.from_date)} — ${esc(l.to_date)}</td><td class="mono" style="text-align:center">${l.quantity}</td></tr>`).join('')}
        </tbody></table>
        <div class="hint" style="margin-top:12px">Подтверждено и оплачено через Waylo. Код заявки: ${short(reqId)}.</div>
      </div></div>`; }).join('') || `<div class="card"><div class="card-empty">Нет подтверждённых услуг для ваучера.</div></div>`}`;
  const back = $('#vouBack'); if (back) back.onclick = () => dmcPayments(active);
  const pr = $('#vouPrint'); if (pr) pr.onclick = () => window.print();
}

/* ── Платформа · Сверка (0020) ───────────────────────────────────────────────*/
async function platformReconcile() {
  const main = $('#main'); if (!main) return;
  const [{ data: reqs }, { data: orgs }, { data: setting }, { data: recons }] = await Promise.all([
    db.from('request').select('id,name,dmc_org_id,payment_code,currency,created_at').not('payment_code', 'is', null).order('created_at', { ascending: false }),
    db.from('organization').select('id,name'),
    db.from('platform_setting').select('value').eq('key', 'service_fee'),
    db.from('reconciliation').select('request_id,status,buyer_total,paid_amount,confirmed_total,discrepancy,created_at').order('created_at', { ascending: false }),
  ]);
  const ids = (reqs || []).map(r => r.id);
  const [{ data: lines }, { data: events }] = await Promise.all([
    ids.length ? db.from('request_line').select('request_id,sell_price,quantity,from_date,to_date').in('request_id', ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from('payment_event').select('request_id,amount,status').in('request_id', ids) : Promise.resolve({ data: [] }),
  ]);
  const fee = (setting && setting[0] && setting[0].value) || { fee_type: 'percent', fee_value: 0 };
  const orgName = Object.fromEntries((orgs || []).map(o => [o.id, o.name]));
  const linesBy = {}; (lines || []).forEach(l => { (linesBy[l.request_id] = linesBy[l.request_id] || []).push(l); });
  const paidBy = {}; (events || []).forEach(e => { if (e.status === 'paid') paidBy[e.request_id] = (paidBy[e.request_id] || 0) + Number(e.amount || 0); });
  const lastRec = {}; (recons || []).forEach(r => { if (!lastRec[r.request_id]) lastRec[r.request_id] = r; });
  const lt = (id) => (linesBy[id] || []).reduce((s, l) => s + Number(l.sell_price || 0) * l.quantity * _nights(l), 0);

  main.innerHTML = `
    <div class="page-head"><div><h1>Сверка</h1><div class="sub">Счёт ↔ оплата ↔ исполнение по заявкам. «Сверить» фиксирует снимок состояния.</div></div></div>
    <div id="rcMsg"></div>
    <div class="card"><div class="card-head">Заявки со счётом (${(reqs || []).length})</div>
    ${(reqs || []).length ? `<table><thead><tr><th>Тур</th><th>DMC</th><th style="text-align:right">К оплате</th><th style="text-align:right">Оплачено</th><th>Сверка</th><th></th></tr></thead><tbody>
      ${reqs.map(r => { const x = lt(r.id), t = x + _feeOf(fee, x), paid = paidBy[r.id] || 0; const rec = lastRec[r.id];
        const recBadge = !rec ? '<span class="badge badge--gray">не сверено</span>'
          : rec.status === 'matched' ? '<span class="badge badge--green">сверено</span>'
          : `<span class="badge badge--red">расхождение ${money(rec.discrepancy, r.currency)}</span>`;
        return `<tr>
          <td><b>${esc(r.name || '—')}</b></td>
          <td>${esc(orgName[r.dmc_org_id] || '—')}</td>
          <td class="price" style="text-align:right">${money(t, r.currency)}</td>
          <td class="price" style="text-align:right">${money(paid, r.currency)}</td>
          <td>${recBadge}${rec ? `<div class="hint">${esc(new Date(rec.created_at).toLocaleDateString('ru-RU'))}</div>` : ''}</td>
          <td style="text-align:right"><button class="btn btn--ghost btn--sm recBtn" data-req="${r.id}">Сверить</button></td>
        </tr>`; }).join('')}
    </tbody></table>` : `<div class="card-empty">Нет заявок со счётом.</div>`}</div>`;

  document.querySelectorAll('.recBtn').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Сверяем…';
    const { error } = await db.rpc('run_reconciliation', { p_request: b.dataset.req });
    if (error) { $('#rcMsg').innerHTML = `<div class="notice notice--err">${esc(error.message)}</div>`; b.disabled = false; b.textContent = 'Сверить'; }
    else platformReconcile();
  });
}

async function renderPlatform() {
  if (!state.tab) state.tab = 'orgs';
  navShell('Платформа · Waylo', [{ id:'orgs', label:'Организации' }, { id:'pricing', label:'Цены' }, { id:'payments', label:'Оплаты' }, { id:'recon', label:'Сверка' }, { id:'invoices', label:'Деньги' }, { id:'log', label:'Журнал' }]);
  const main = $('#main'); if (!main) return;
  if (state.tab === 'pricing') return platformPricing();
  if (state.tab === 'log') return platformLog();
  if (state.tab === 'payments') return platformPayments();
  if (state.tab === 'recon') return platformReconcile();
  if (state.tab === 'orgs') {
    const [{ data: orgs }, { data: invs }] = await Promise.all([
      db.from('organization').select('*').order('type'),
      db.from('invitation').select('id,org_id,email,role,status').eq('status', 'pending'),
    ]);
    const invByOrg = {}; (invs||[]).forEach(i => { (invByOrg[i.org_id] = invByOrg[i.org_id] || []).push(i); });
    main.innerHTML = `
      <div class="page-head"><div><h1>Организации</h1><div class="sub">Платформа заводит организацию и приглашает её суперадмина. Каждый отель — отдельная организация со своим кабинетом.</div></div></div>
      <div id="oMsg"></div>
      <div class="card"><div class="card-head">Добавить организацию</div>
        <div class="row" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:12px">
          <div class="field" style="flex:1;min-width:200px"><label>Название</label><input class="input" id="orgName" placeholder="Hotel Registan Plaza"></div>
          <div class="field" style="min-width:150px"><label>Тип</label><select class="input" id="orgType"><option value="HOTEL">Отель/Резорт</option><option value="TRANSPORT">Трансфер</option><option value="DMC">DMC</option></select></div>
          <div class="field" style="width:90px"><label>Страна</label><input class="input" id="orgCountry" placeholder="UZ" value="UZ"></div>
          <div class="field" style="flex:1;min-width:200px"><label>Email суперадмина</label><input class="input" type="email" id="orgEmail" placeholder="owner@hotel.com"></div>
          <button class="btn btn--primary" id="orgBtn">Создать + пригласить</button>
        </div>
        <div class="hint" style="padding:0 12px 12px">Суперадмин получит доступ, зарегистрировавшись этим email на странице входа (Регистрация по приглашению).</div>
      </div>
      <div class="card"><div class="card-head">Участники</div>
      ${(orgs||[]).length ? `<table><thead><tr><th>Название</th><th>Тип</th><th>Страна</th><th>Статус</th><th>Приглашения</th><th>ID</th><th></th></tr></thead><tbody>
        ${orgs.map(o => `<tr><td>${esc(o.name)}</td><td><span class="badge badge--${ORG_BADGE[o.type]||'gray'}">${esc(o.type)}</span></td><td>${esc(o.country||'—')}</td><td>${badge(o.status)}</td><td class="hint">${(invByOrg[o.id]||[]).map(i=>esc(i.email)+' ('+(i.role==='superadmin'?'суперадмин':'админ')+')').join('<br>')||'—'}</td><td class="id-cell">${short(o.id)}</td><td style="text-align:right;white-space:nowrap">${o.status!=='active'?`<button class="btn btn--ghost btn--sm actBtn" data-id="${o.id}">Активировать</button>`:`<button class="btn btn--ghost btn--sm suspBtn" data-id="${o.id}">Приостановить</button>`} <button class="btn btn--ghost btn--sm invSaBtn" data-id="${o.id}" data-name="${esc(o.name)}">+ суперадмин</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="card-empty">Нет организаций.</div>`}</div>`;
    const oErr = (m) => { $('#oMsg').innerHTML = `<div class="notice notice--err">${esc(m)}</div>`; };
    $('#orgBtn').onclick = async () => {
      const name = ($('#orgName').value||'').trim();
      const type = $('#orgType').value;
      const country = ($('#orgCountry').value||'').trim() || null;
      const email = ($('#orgEmail').value||'').trim().toLowerCase();
      if (!name || !email) { oErr('Заполните название и email суперадмина.'); return; }
      const b = $('#orgBtn'); b.disabled = true; b.textContent = 'Создаём…';
      const { data: org, error } = await db.from('organization').insert({ name, type, country, status:'active' }).select().single();
      if (error) { oErr(error.message); b.disabled = false; b.textContent = 'Создать + пригласить'; return; }
      const { error: e2 } = await db.from('invitation').insert({ org_id: org.id, email, role:'superadmin', invited_by: state.user.id });
      if (e2) oErr('Организация создана, но приглашение не отправлено: ' + e2.message);
      renderPlatform();
    };
    document.querySelectorAll('.actBtn').forEach(b => b.onclick = async () => { const { error } = await db.from('organization').update({ status:'active' }).eq('id', b.dataset.id); if (error) oErr(error.message); else renderPlatform(); });
    document.querySelectorAll('.suspBtn').forEach(b => b.onclick = async () => { const { error } = await db.from('organization').update({ status:'suspended' }).eq('id', b.dataset.id); if (error) oErr(error.message); else renderPlatform(); });
    document.querySelectorAll('.invSaBtn').forEach(b => b.onclick = async () => {
      const email = (prompt('Email суперадмина для «' + b.dataset.name + '»:') || '').trim().toLowerCase();
      if (!email) return;
      const { error } = await db.from('invitation').insert({ org_id: b.dataset.id, email, role:'superadmin', invited_by: state.user.id });
      if (error) oErr(error.message); else renderPlatform();
    });
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
let calcCat = null;   // каталог: {acc:[...], cities:[...], veh:[...]}
let calcSt  = null;   // расчёт текущего тура
let calcTour = null;  // {id,name,pax,currency}

async function loadCalcCat() {
  const [{ data: props }, { data: types }, { data: rates }, { data: vcs }, { data: trates }] = await Promise.all([
    db.from('property').select('id,name,city,kind,org_id').eq('is_active', true),
    db.from('room_type').select('id,property_id,name,photo_url,photos'),
    db.from('room_rate_public').select('room_type_id,sell_price,sgl_supplement'),
    db.from('vehicle_class').select('id,name,org_id,cities'),
    db.from('transport_rate_public').select('vehicle_class_id,sell_price_per_unit'),
  ]);
  const pById = {}; (props || []).forEach(p => pById[p.id] = p);
  const rByRt = {}; (rates || []).forEach(r => { if (!rByRt[r.room_type_id]) rByRt[r.room_type_id] = r; });
  const acc = (types || []).filter(t => rByRt[t.id] && pById[t.property_id]).map(t => {
    const p = pById[t.property_id], r = rByRt[t.id], twin = Number(r.sell_price) || 0;
    return { id: t.id, city: p.city, kind: p.kind, prop: p.name, room: t.name, twin, sgl: twin + (Number(r.sgl_supplement) || 0), supplier: p.org_id };
  });
  const cities = [...new Set(acc.map(a => a.city))].sort((a, b) => a.localeCompare(b, 'ru'));
  const tByVc = {}; (trates || []).forEach(r => { if (!tByVc[r.vehicle_class_id]) tByVc[r.vehicle_class_id] = r; });
  const veh = (vcs || []).filter(v => tByVc[v.id]).map(v => ({ id: v.id, name: v.name, day: Number(tByVc[v.id].sell_price_per_unit) || 0, supplier: v.org_id, cities: v.cities || [] })).sort((a, b) => a.day - b.day);
  return { acc, cities, veh };
}

function newCalc() {
  return { profit: 250, stops: [], trans: [], misc: [{ name: 'Вода', sum: 0 }, { name: 'Портеры', sum: 0 }] };
}

// транспорт — по одному городу маршрута (дни = ночи); значения сохраняем по городу
function calcSync() {
  const s = calcSt;
  const ex = {}; s.trans.forEach(t => ex[t.city] = t);
  s.trans = s.stops.filter(st => st.city).map(st => { const e = ex[st.city] || {}; return { city: st.city, days: st.nights, vehId: e.vehId || '', price: e.price || 0 }; });
}

function cityOptions(sel) {
  let h = '<option value="">— город —</option>';
  calcCat.cities.forEach(c => { h += `<option value="${esc(c)}"${c === sel ? ' selected' : ''}>${esc(c)}</option>`; });
  return h;
}
function accOptionsForCity(city, selId) {
  let h = '<option value="">— отель / резорт —</option>';
  if (!city) return h;
  calcCat.acc.filter(a => a.city === city).forEach(a => {
    const tag = a.kind === 'resort' ? ' · резорт' : '';
    h += `<option value="${a.id}"${a.id === selId ? ' selected' : ''}>${esc(a.prop)} · ${esc(a.room)} — $${a.twin}${tag}</option>`;
  });
  return h;
}
function vehOptions(selId, city) {
  let h = '<option value="">— класс —</option>';
  const norm = (x) => String(x || '').trim().toLowerCase();
  const c = norm(city);
  calcCat.veh.forEach(v => {
    const cities = v.cities || [];
    const serves = !c || !cities.length || cities.some(x => norm(x) === c);
    if (!serves && v.id !== selId) return;
    h += `<option value="${v.id}"${v.id === selId ? ' selected' : ''}>${esc(v.name)} — $${v.day}/дн</option>`;
  });
  return h;
}
function suppOf(st) { return Math.round(((st.sgl || 0) - (st.twin || 0) / 2) * (st.nights || 0)); }
function suppTxt(st) { return (st.sgl || 0) === 0 ? '—' : '+$' + suppOf(st).toLocaleString('ru'); }

function ensureCalcStyle() {
  if (document.getElementById('wcalc-style')) return;
  const st = document.createElement('style');
  st.id = 'wcalc-style';
  st.textContent = `
  .wcalc{font-size:13.5px;color:var(--ink)}
  .wcalc .clayout{display:flex;gap:14px;align-items:flex-start}
  .wcalc .cinputs{flex:1;min-width:0;display:flex;flex-direction:column;gap:14px}
  .wcalc .cresult{width:300px;flex-shrink:0;position:sticky;top:14px}
  @media (max-width:760px){.wcalc .clayout{flex-direction:column}.wcalc .cresult{width:100%;position:static}}
  .wcalc .card{overflow:hidden}
  .wcalc .cgr,.wcalc .cghead{display:grid;gap:8px;align-items:center}
  .wcalc .cgr{padding:7px 14px;border-bottom:1px solid var(--line-2)}
  .wcalc .cgr:last-of-type{border-bottom:none}
  .wcalc .cgr>*{min-width:0}
  .wcalc .cghead{padding:8px 14px;border-bottom:1px solid var(--line-2)}
  .wcalc .cghead>div{font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wcalc .acc{grid-template-columns:1.3fr 2.4fr .7fr .95fr .95fr 1fr 28px}
  .wcalc .gtr{grid-template-columns:1.6fr .8fr 2.4fr 1fr 1fr}
  .wcalc .ms{grid-template-columns:3fr 1.4fr 28px}
  .wcalc .cgr input,.wcalc .cgr select{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:7px;padding:7px 8px;background:var(--surface);color:var(--ink);width:100%;min-width:0}
  .wcalc .cgr input:focus,.wcalc .cgr select:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .wcalc .cgr input.cauto{background:var(--accent-soft);border-color:var(--accent-soft);color:var(--accent-ink);pointer-events:none;text-align:center}
  .wcalc .csupp{color:var(--blue);font-weight:600;font-size:12.5px;text-align:right;white-space:nowrap;overflow:hidden}
  .wcalc .cright{text-align:right}
  .wcalc .cdel{width:28px;height:28px;border:0;background:none;cursor:pointer;color:var(--muted);font-size:16px;border-radius:6px;justify-self:end}
  .wcalc .cdel:hover{color:var(--red);background:var(--red-bg)}
  .wcalc .caddrow{padding:10px 14px;border-top:1px solid var(--line-2)}
  .wcalc .csub{padding:10px 14px;font-size:12px;color:var(--muted)}
  .wcalc .ctot{padding:9px 14px;font-size:12.5px;font-weight:600;color:var(--blue);border-top:1px solid var(--line-2);background:var(--blue-bg)}
  .wcalc .crt{width:100%;border-collapse:collapse;table-layout:fixed}
  .wcalc .crt th{text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600;padding:7px 10px;border-bottom:1px solid var(--line-2)}
  .wcalc .crt th:first-child{text-align:center;width:42px}
  .wcalc .crt td{padding:6px 10px;border-bottom:1px solid var(--line-2);text-align:right;font-size:12.5px}
  .wcalc .crt td:first-child{text-align:center;color:var(--muted)}
  .wcalc .crt tr:last-child td{border-bottom:none}
  .wcalc .crt .num{font-family:var(--mono);font-weight:600}
  .wcalc .crt tr.tourpax td{background:var(--accent-soft)}
  .wcalc .crt tr.tourpax td:first-child{color:var(--accent-ink);font-weight:700}
  .wcalc .crt tr.best td{background:var(--green-bg)}
  .wcalc .crt tr.best.tourpax td{background:var(--accent-soft)}
  .wcalc .crph{text-align:center;padding:22px 12px;color:var(--muted);font-size:12.5px;line-height:1.7}
  `;
  document.head.appendChild(st);
}

function renderCalc(active) {
  coach('calc');
  const s = calcSt;
  const totSupp = s.stops.reduce((a, st) => a + suppOf(st), 0);
  const stopRows = s.stops.length ? s.stops.map((st, i) => `<div class="cgr acc">
    <select class="cCity" data-i="${i}">${cityOptions(st.city)}</select>
    <select class="cAcc" data-i="${i}">${accOptionsForCity(st.city, st.accId)}</select>
    <input type="number" min="1" class="cNig" data-i="${i}" value="${st.nights || 1}">
    <input type="number" min="0" class="cTwn" data-i="${i}" value="${st.twin || 0}">
    <input type="number" min="0" class="cSgl" data-i="${i}" value="${st.sgl || 0}">
    <span class="csupp" id="csupp-${i}">${suppTxt(st)}</span>
    <button class="cdel" data-act="delstop" data-i="${i}">×</button>
  </div>`).join('') : `<div class="csub">Добавьте первую локацию маршрута.</div>`;
  const transRows = s.trans.length ? s.trans.map((t, i) => `<div class="cgr gtr">
    <input class="cauto" value="${esc(t.city)}" readonly>
    <input class="cauto" value="${t.days}" readonly>
    <select class="cTveh" data-i="${i}">${vehOptions(t.vehId, t.city)}</select>
    <input type="number" min="0" class="cTpr" data-i="${i}" value="${t.price || 0}">
    <div class="hint cright">${t.price && t.days ? '$' + (t.price * t.days).toLocaleString('ru') : '—'}</div>
  </div>`).join('') : `<div class="csub">Появится автоматически после добавления локаций.</div>`;
  const miscRows = s.misc.map((m, i) => `<div class="cgr ms">
    <input class="cMn" data-i="${i}" value="${esc(m.name)}" placeholder="Статья…">
    <input type="number" min="0" class="cMs" data-i="${i}" value="${m.sum || ''}" placeholder="0">
    <button class="cdel" data-act="delmisc" data-i="${i}">×</button>
  </div>`).join('');

  ensureCalcStyle();
  $('#calcWrap').innerHTML = `<div class="wcalc">
    <div class="card" style="margin-bottom:14px"><div style="padding:16px 20px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
      <div>
        <div style="font-size:18px;font-weight:600">${esc((calcTour && calcTour.name) || 'Тур')} ${(calcTour && calcTour.pax) ? `<span class="hint mono">PAX ${calcTour.pax}</span>` : ''}</div>
        <div class="hint" style="margin-top:4px">${esc(active.orgName || '')}${(calcTour && calcTour.start) ? ' · от ' + esc(calcTour.start) : ''}</div>
      </div>
      <div style="text-align:right"><div class="hint">Валюта</div><div class="mono" style="font-weight:600;font-size:16px">${esc((calcTour && calcTour.currency) || 'USD')}</div></div>
    </div></div>
    <div class="clayout">
      <div class="cinputs">

        <div class="card">
          <div class="card-head">Маршрут · проживание</div>
          <div class="cghead acc"><div>Город</div><div>Отель / резорт</div><div>Ноч.</div><div>Twin $</div><div>SGL $</div><div>SGL suppl.</div><div></div></div>
          ${stopRows}
          <div class="caddrow"><button class="btn btn--ghost btn--sm" data-act="addstop">+ Добавить локацию</button></div>
          <div class="ctot" id="cTotSupp" style="${totSupp > 0 ? '' : 'display:none'}">Single supplement итого: +$${totSupp.toLocaleString('ru')}</div>
        </div>

        <div class="card">
          <div class="card-head">Транспорт <span class="badge badge--accent">из каталога · по городам</span></div>
          <div class="cghead gtr"><div>Город</div><div>Дней</div><div>Класс</div><div>$/день</div><div class="cright">Итого</div></div>
          ${transRows}
        </div>

        <div class="card">
          <div class="card-head">Прочие расходы <span class="hint" style="font-weight:400">за группу</span></div>
          <div class="cghead ms"><div>Статья</div><div>$ за группу</div><div></div></div>
          ${miscRows}
          <div class="caddrow"><button class="btn btn--ghost btn--sm" data-act="addmisc">+ Статья</button></div>
        </div>

      </div>

      <div class="cresult">
        <div class="card" style="overflow:hidden">
          <div style="padding:18px 20px;background:var(--accent);color:#eafaf6">
            <div style="font-size:12.5px;opacity:.85">Цена с человека · PAX ${(calcTour && calcTour.pax) || '—'}</div>
            <div id="cMain" style="font-family:var(--mono);font-size:34px;font-weight:600;letter-spacing:-.01em;margin-top:2px">—</div>
            <div style="display:flex;gap:18px;margin-top:8px;font-size:12px">
              <div>FOC лидер: <b id="cFoc" style="font-family:var(--mono)">—</b></div>
              <div>Группа: <b id="cGrp" style="font-family:var(--mono)">—</b></div>
            </div>
          </div>
          <div style="padding:14px 16px 8px;display:flex;align-items:center;justify-content:space-between">
            <span class="hint">Прибыль $/чел</span>
            <div style="display:flex;align-items:center;gap:12px;border:1px solid var(--line);border-radius:8px;padding:5px 12px">
              <span id="cProfMinus" style="cursor:pointer;color:var(--muted);user-select:none;font-size:16px">−</span>
              <span id="cProfVal" style="font-family:var(--mono);font-weight:600;min-width:26px;text-align:center">${s.profit}</span>
              <span id="cProfPlus" style="cursor:pointer;color:var(--muted);user-select:none;font-size:16px">+</span>
            </div>
          </div>
          <div class="cghead" style="grid-template-columns:.6fr 1fr 1fr 1.1fr;padding:8px 16px 6px;border-top:1px solid var(--line-2)"><div>PAX</div><div class="cright">Без FOC</div><div class="cright">FOC</div><div class="cright">Группа</div></div>
          <div style="max-height:340px;overflow:auto"><table class="crt" style="table-layout:fixed;width:100%"><tbody id="cResBody"><tr><td colspan="4" class="crph">Добавьте локации<br>маршрута</td></tr></tbody></table></div>
          <div style="padding:14px 16px;border-top:1px solid var(--line-2)">
            <div id="cSaveMsg" class="hint" style="margin-bottom:8px;min-height:14px"></div>
            <div style="display:flex;gap:9px">
              <button class="btn btn--ghost btn--sm" id="cSaveBtn" style="flex:1">Сохранить</button>
              <button class="btn btn--primary btn--sm" id="cBookBtn" style="flex:1.3">Забронировать</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  bindCalc(active);
  if (s.stops.length) calcCompute();
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
    else if (act === 'addmisc') { s.misc.push({ name: '', sum: 0 }); renderCalc(active); }
    else if (act === 'delmisc') { s.misc.splice(i, 1); renderCalc(active); }
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('cCity')) {
      const st = s.stops[+t.dataset.i];
      st.city = t.value; st.accId = ''; st.twin = 0; st.sgl = 0;
      reflow();
    } else if (t.classList.contains('cAcc')) {
      const a = accById[t.value]; const st = s.stops[+t.dataset.i];
      if (a) { st.accId = a.id; st.city = a.city; st.twin = a.twin; st.sgl = a.sgl; } else { st.accId = ''; }
      reflow();
    } else if (t.classList.contains('cTveh')) {
      const v = calcCat.veh.find(x => x.id === t.value); const tr = s.trans[+t.dataset.i];
      if (v) { tr.vehId = v.id; tr.price = v.day; } else { tr.vehId = ''; }
      renderCalc(active);
    } else if (t.classList.contains('cNig')) {
      reflow();
    }
  });

  root.addEventListener('input', (e) => {
    const t = e.target, v = t.value, i = +t.dataset.i;
    if (t.id === 'cProfit') { s.profit = +v || 0; calcCompute(); }
    else if (t.classList.contains('cNig')) { s.stops[i].nights = +v || 1; updSupp(i); calcCompute(); }
    else if (t.classList.contains('cTwn')) { s.stops[i].twin = +v || 0; updSupp(i); calcCompute(); }
    else if (t.classList.contains('cSgl')) { s.stops[i].sgl = +v || 0; updSupp(i); calcCompute(); }
    else if (t.classList.contains('cTpr')) { s.trans[i].price = +v || 0; calcCompute(); }
    else if (t.classList.contains('cMn')) { s.misc[i].name = v; }
    else if (t.classList.contains('cMs')) { s.misc[i].sum = +v || 0; calcCompute(); }
  });

  const _pm = $('#cProfMinus'), _pp = $('#cProfPlus');
  const _setProf = (d) => { s.profit = Math.max(0, (s.profit || 0) + d); const pv = $('#cProfVal'); if (pv) pv.textContent = s.profit; calcCompute(); };
  if (_pm) _pm.onclick = () => _setProf(-5);
  if (_pp) _pp.onclick = () => _setProf(5);
  $('#cSaveBtn').onclick = () => calcSave();
  $('#cBookBtn').onclick = () => calcBook();
}

function calcCompute() {
  const s = calcSt;
  calcSync();
  const tn = s.stops.reduce((a, st) => a + (st.nights || 0), 0);
  const body = $('#cResBody'); if (!body) return;
  if (!tn) { body.innerHTML = `<tr><td colspan="4" class="crph">Добавьте локации<br>маршрута</td></tr>`; return; }
  const profit = s.profit || 0;
  const transFixed = s.trans.reduce((a, t) => a + (t.price || 0) * (t.days || 0), 0);
  const miscFixed = s.misc.reduce((a, x) => a + (x.sum || 0), 0);
  const totalFixed = transFixed + miscFixed;
  const hotelSgl1 = s.stops.reduce((a, st) => a + (st.sgl || 0) * (st.nights || 0), 0);
  const hotelCost = (pax) => s.stops.reduce((a, st) => a + Math.ceil(pax / 2) * (st.twin || 0) * (st.nights || 0), 0);

  let minCpp = Infinity, bestPax = 1;
  for (let p = 1; p <= 39; p++) { const cpp = (hotelCost(p) + totalFixed) / p + profit; if (cpp < minCpp) { minCpp = cpp; bestPax = p; } }
  const tourPax = (calcTour && calcTour.pax) || 0;

  let html = '';
  for (let pax = 1; pax <= 39; pax++) {
    const cost = hotelCost(pax) + totalFixed;
    const noFoc = cost / pax + profit;
    const foc = noFoc + hotelSgl1 / pax;
    const grp = noFoc * pax;
    const cls = (pax === bestPax ? 'best ' : '') + (pax === tourPax ? 'tourpax' : '');
    html += `<tr class="${cls.trim()}"><td>${pax}</td><td class="num">$${Math.round(noFoc).toLocaleString('ru')}</td><td class="num" style="color:var(--accent-ink)">$${Math.round(foc).toLocaleString('ru')}</td><td class="num" style="color:var(--muted)">$${Math.round(grp).toLocaleString('ru')}</td></tr>`;
  }
  const _tp = (calcTour && calcTour.pax) || 0;
  const _setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  if (_tp >= 1 && _tp <= 39) {
    const _c = hotelCost(_tp) + totalFixed, _no = _c / _tp + profit, _fo = _no + hotelSgl1 / _tp, _gr = _no * _tp;
    _setT('cMain', '$' + Math.round(_no).toLocaleString('ru'));
    _setT('cFoc', '$' + Math.round(_fo).toLocaleString('ru'));
    _setT('cGrp', '$' + Math.round(_gr).toLocaleString('ru'));
  } else { _setT('cMain', '—'); _setT('cFoc', '—'); _setT('cGrp', '—'); }
  body.innerHTML = html;
}

async function calcSave() {
  if (!calcTour) return;
  const msg = $('#cSaveMsg');
  const btn = $('#cSaveBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Сохраняю…'; }
  try {
    calcSync();
    const { error } = await db.from('request').update({ calc: calcSt }).eq('id', calcTour.id);
    if (error) throw error;
    if (msg) { msg.textContent = '✓ сохранено в туре'; setTimeout(() => { if (msg) msg.textContent = ''; }, 3000); }
  } catch (e) {
    if (msg) msg.textContent = '✕ ' + (e.message || 'ошибка');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
  }
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function calcBook() {
  if (!calcTour) return;
  const msg = $('#cSaveMsg');
  const fail = (t) => { if (msg) msg.textContent = '✕ ' + t; };
  if (!calcTour.start) { fail('у тура не задана дата начала'); return; }
  if (!calcSt.stops.length) { fail('добавьте хотя бы одну локацию'); return; }
  const accById = {}; (calcCat.acc || []).forEach(a => accById[a.id] = a);
  const vehById = {}; (calcCat.veh || []).forEach(v => vehById[v.id] = v);
  const rooms = Math.ceil((calcTour.pax || 1) / 2);
  let cursor = calcTour.start;
  const lines = [];
  for (const st of calcSt.stops) {
    if (!st.accId) { fail('выберите отель/резорт во всех локациях'); return; }
    const a = accById[st.accId]; if (!a) { fail('не найден отель в каталоге'); return; }
    const from = cursor, to = addDays(cursor, st.nights || 1);
    lines.push({ supplier: a.supplier, type: 'HOTEL', res: 'room', resource_id: st.accId, from, to, quantity: rooms, sell: st.twin });
    const t = (calcSt.trans || []).find(x => x.city === st.city && x.vehId);
    if (t) { const v = vehById[t.vehId]; if (v) lines.push({ supplier: v.supplier, type: 'TRANSPORT', res: 'vehicle', resource_id: t.vehId, from, to, quantity: 1, sell: t.price }); }
    cursor = to;
  }
  if (!confirm('Отправить бронь поставщикам?\n\nПозиций: ' + lines.length + '\nНомеров на локацию: ' + rooms + ' (PAX ' + (calcTour.pax || 1) + ', по 2 в номере)\nДаты от ' + calcTour.start + '\n\nПрежние холды по этому туру будут пересозданы.')) return;
  const btn = $('#cBookBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Бронирую…'; }
  try {
    await db.from('request').update({ calc: calcSt }).eq('id', calcTour.id);
    const { data, error } = await db.rpc('book_tour', { p_request: calcTour.id, p_lines: lines });
    if (error) throw error;
    if (msg) msg.textContent = '✓ отправлено поставщикам — позиций: ' + data;
  } catch (e) {
    fail(e.message || 'ошибка');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Забронировать'; }
  }
}
boot();
