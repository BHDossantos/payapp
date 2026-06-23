// EuroFlow web client — vanilla ES modules, no build step. Talks to the same
// origin's JSON API and keeps the session token in localStorage.

const TOKEN_KEY = 'euroflow.token';
let token = localStorage.getItem(TOKEN_KEY);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const euro = (n) => `€${Number(n).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// A handle the user typed could be a username, email, or phone. Map it to the
// right field so the API can resolve it. Leading "@" is stripped for usernames.
function handleToFields(raw) {
  const h = raw.trim().replace(/^@/, '');
  if (h.includes('@')) return { email: h };
  if (/^\+?[0-9\s-]{7,}$/.test(h)) return { phone: h };
  return { username: h };
}

const fields = (form) => Object.fromEntries(new FormData(form).entries());

/* ---------------- Auth ---------------- */
$$('[data-auth-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('[data-auth-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    const which = tab.dataset.authTab;
    $('#login-form').hidden = which !== 'login';
    $('#register-form').hidden = which !== 'register';
  });
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  try {
    const res = await api('POST', '/auth/login', { ...handleToFields(f.identifier), password: f.password });
    startSession(res.token);
  } catch (err) { toast(err.message, 'error'); }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  const payload = { ...f, country: (f.country || '').toUpperCase() };
  if (!payload.username) delete payload.username;
  try {
    const res = await api('POST', '/auth/register', payload);
    startSession(res.token);
    toast('Welcome to EuroFlow!', 'success');
  } catch (err) { toast(err.message, 'error'); }
});

$('#logout-btn').addEventListener('click', () => {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
});

function startSession(newToken) {
  token = newToken;
  localStorage.setItem(TOKEN_KEY, token);
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  refreshAll();
}

/* ---------------- Navigation ---------------- */
function showView(name) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'activity') loadHistory();
  if (name === 'request') loadRequests('outgoing');
  if (name === 'split') loadSplits();
  if (name === 'business') loadMerchant();
  if (name === 'admin') loadAdmin();
  if (name === 'notifications') loadNotifications();
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));

/* ---------------- Data loading ---------------- */
async function refreshAll() {
  try {
    const me = await api('GET', '/me');
    $('#user-name').textContent = me.user.first_name;
    setBalance(me.wallet.balance);
    $('#admin-nav').hidden = !me.user.is_admin;
    refreshUnread();
    loadRequests('incoming');
  } catch (err) {
    if (err.status === 401) { $('#logout-btn').click(); }
    else toast(err.message, 'error');
  }
}

function setBalance(amount) {
  $('#balance').textContent = euro(amount);
  $('#balance-large').textContent = euro(amount);
}

async function loadRequests(box) {
  const targetId = box === 'incoming' ? '#incoming-requests' : '#outgoing-requests';
  try {
    const { requests } = await api('GET', `/wallet/requests?box=${box}`);
    const el = $(targetId);
    if (!requests.length) { el.innerHTML = '<p class="muted">Nothing here yet.</p>'; return; }
    el.innerHTML = requests.map((r) => {
      const other = box === 'incoming' ? r.requestor_name : r.recipient_name;
      const actions = (box === 'incoming' && r.status === 'pending')
        ? `<button class="btn primary small" data-pay-request="${r.request_id}">Pay</button>
           <button class="btn ghost small" data-decline-request="${r.request_id}">Decline</button>`
        : `<span class="tag ${r.status}">${r.status}</span>`;
      return `<div class="item">
        <div class="grow">
          <div class="title">${esc(other)} · ${euro(r.amount)}</div>
          <div class="sub">${esc(r.reason || 'No note')}</div>
        </div>${actions}</div>`;
    }).join('');
  } catch (err) { toast(err.message, 'error'); }
}

async function loadHistory() {
  try {
    const { transactions } = await api('GET', '/wallet/history');
    const el = $('#history-list');
    if (!transactions.length) { el.innerHTML = '<p class="muted">No transactions yet.</p>'; return; }
    el.innerHTML = transactions.map((t) => {
      const sent = t.direction === 'sent';
      const other = sent ? t.receiver_name : t.sender_name;
      const sign = sent ? '−' : '+';
      const cls = t.status !== 'completed' ? '' : (sent ? 'amount-neg' : 'amount-pos');
      return `<div class="item">
        <div class="grow">
          <div class="title">${sent ? 'To' : 'From'} ${esc(other)}</div>
          <div class="sub">${esc(t.reference || t.type)} · ${new Date(t.created_at).toLocaleString()}</div>
        </div>
        <div style="text-align:right">
          <div class="${cls}">${sign}${euro(t.amount)}</div>
          ${t.status !== 'completed' ? `<span class="tag ${t.status}">${t.status}</span>` : ''}
        </div></div>`;
    }).join('');
  } catch (err) { toast(err.message, 'error'); }
}

async function loadSplits() {
  try {
    const { splits } = await api('GET', '/splits');
    const el = $('#splits-list');
    if (!splits.length) { el.innerHTML = '<p class="muted">No splits yet.</p>'; return; }
    el.innerHTML = splits.map((g) => {
      const rows = g.participants.map((p) => `
        <div class="item">
          <div class="grow"><div class="title">${esc(p.name)}</div>
            <div class="sub">${euro(p.amount)}</div></div>
          <span class="tag ${p.status}">${p.status}</span>
        </div>`).join('');
      const payBtn = g.fully_settled ? '' : `<button class="btn primary small" data-pay-split="${g.group_id}">Pay my share</button>`;
      return `<div class="card" style="margin:0">
        <h3>${esc(g.name)} — ${euro(g.settled)}/${euro(g.total)} settled ${payBtn}</h3>
        <div class="list">${rows}</div></div>`;
    }).join('');
  } catch (err) { toast(err.message, 'error'); }
}

async function loadMerchant() {
  try {
    const m = await api('GET', '/merchant');
    $('#merchant-setup').hidden = true;
    $('#merchant-dashboard').hidden = false;
    $('#merchant-name').textContent = m.business_name;
    const link = $('#merchant-link');
    link.textContent = m.payment_link;
    link.href = m.payment_link;
    loadInvoices();
  } catch (err) {
    if (err.status === 404) {
      $('#merchant-setup').hidden = false;
      $('#merchant-dashboard').hidden = true;
    } else { toast(err.message, 'error'); }
  }
}

async function loadInvoices() {
  try {
    const { invoices } = await api('GET', '/invoices');
    const el = $('#invoices-list');
    if (!invoices.length) { el.innerHTML = '<p class="muted">No invoices yet.</p>'; return; }
    el.innerHTML = invoices.map((i) => `
      <div class="item">
        <div class="grow"><div class="title">${esc(i.customer_name)} · ${euro(i.amount)}</div>
          <div class="sub">${esc(i.description || '')}${i.due_date ? ` · due ${esc(i.due_date)}` : ''}</div></div>
        ${i.status === 'paid' ? '<span class="tag paid">paid</span>'
          : `<button class="btn ghost small" data-invoice-paid="${i.invoice_id}">Mark paid</button>`}
      </div>`).join('');
  } catch (err) { toast(err.message, 'error'); }
}

async function loadAdmin() {
  try {
    const [stats, merchants, alerts] = await Promise.all([
      api('GET', '/admin/stats'),
      api('GET', '/admin/merchants?status=pending'),
      api('GET', '/admin/aml/alerts'),
    ]);

    $('#admin-stats').innerHTML = `
      <div class="item"><div class="grow"><div class="title">${stats.users.total} users</div>
        <div class="sub">${stats.users.admins} admin(s) · KYC ${JSON.stringify(stats.users.by_kyc)}</div></div></div>
      <div class="item"><div class="grow"><div class="title">${stats.transactions.total} transactions</div>
        <div class="sub">${euro(stats.transactions.volume_completed)} settled volume</div></div></div>
      <div class="item"><div class="grow"><div class="title">${stats.merchants.total} merchants</div>
        <div class="sub">${JSON.stringify(stats.merchants.by_status)}</div></div></div>`;

    const mEl = $('#admin-merchants');
    mEl.innerHTML = merchants.merchants.length ? merchants.merchants.map((m) => `
      <div class="item">
        <div class="grow"><div class="title">${esc(m.business_name)}</div>
          <div class="sub">${esc(m.country)}${m.vat_number ? ` · VAT ${esc(m.vat_number)}` : ''}</div></div>
        <button class="btn primary small" data-merchant-action="approve" data-merchant="${m.merchant_id}">Approve</button>
        <button class="btn ghost small" data-merchant-action="reject" data-merchant="${m.merchant_id}">Reject</button>
      </div>`).join('') : '<p class="muted">No merchants awaiting approval.</p>';

    const aEl = $('#admin-alerts');
    aEl.innerHTML = alerts.alerts.length ? alerts.alerts.map((a) => `
      <div class="item">
        <div class="grow"><div class="title">${esc(a.type)} <span class="tag ${a.severity === 'high' ? 'failed' : 'pending'}">${esc(a.severity)}</span></div>
          <div class="sub">${esc(a.detail)}</div></div>
      </div>`).join('') : '<p class="muted">No open alerts.</p>';
  } catch (err) { toast(err.message, 'error'); }
}

/* ---------------- Notifications ---------------- */
async function refreshUnread() {
  try {
    const { unread_count: count } = await api('GET', '/notifications?unread=true');
    const badge = $('#unread-badge');
    badge.textContent = count;
    badge.hidden = count === 0;
  } catch { /* non-fatal */ }
}

async function loadNotifications() {
  try {
    const { notifications } = await api('GET', '/notifications');
    const el = $('#notifications-list');
    if (!notifications.length) { el.innerHTML = '<p class="muted">No notifications yet.</p>'; return; }
    el.innerHTML = notifications.map((n) => `
      <div class="item ${n.read ? '' : 'unread'}" data-notif="${n.notification_id}">
        ${n.read ? '' : '<span class="dot"></span>'}
        <div class="grow">
          <div class="title">${esc(n.title)}</div>
          <div class="sub">${esc(n.body)} · ${new Date(n.created_at).toLocaleString()}</div>
        </div>
      </div>`).join('');
  } catch (err) { toast(err.message, 'error'); }
}

$('#bell-btn').addEventListener('click', () => showView('notifications'));
$('#mark-all-btn').addEventListener('click', async () => {
  try {
    await api('POST', '/notifications/read-all');
    loadNotifications();
    refreshUnread();
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------------- Actions (forms) ---------------- */
$('#topup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  try {
    const w = await api('POST', '/wallet/topup', { amount: Number(f.amount) });
    setBalance(w.balance);
    e.target.reset();
    toast('Funds added', 'success');
  } catch (err) { toast(err.message, 'error'); }
});

$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  try {
    await api('POST', '/wallet/send', { ...handleToFields(f.handle), amount: Number(f.amount), note: f.note });
    e.target.reset();
    toast('Money sent', 'success');
    refreshAll();
    showView('activity');
  } catch (err) { toast(err.message, 'error'); }
});

$('#request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  try {
    await api('POST', '/wallet/request', { ...handleToFields(f.handle), amount: Number(f.amount), reason: f.reason });
    e.target.reset();
    toast('Request sent', 'success');
    loadRequests('outgoing');
  } catch (err) { toast(err.message, 'error'); }
});

$('#split-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  const participants = f.participants.split(',').map((h) => h.trim()).filter(Boolean).map(handleToFields);
  try {
    await api('POST', '/wallet/split', { name: f.name, split: 'equal', total: Number(f.total), participants });
    e.target.reset();
    toast('Split created', 'success');
    loadSplits();
  } catch (err) { toast(err.message, 'error'); }
});

$('#merchant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  try {
    await api('POST', '/merchant/register', { ...f, country: (f.country || '').toUpperCase() });
    toast('Merchant profile created', 'success');
    loadMerchant();
  } catch (err) { toast(err.message, 'error'); }
});

$('#invoice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  try {
    await api('POST', '/invoice/create', { ...f, amount: Number(f.amount) });
    e.target.reset();
    toast('Invoice created', 'success');
    loadInvoices();
  } catch (err) { toast(err.message, 'error'); }
});

$('#qr-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fields(e.target);
  const body = f.amount ? { type: 'dynamic', amount: Number(f.amount) } : { type: 'merchant' };
  try {
    const qr = await api('POST', '/qr/generate', body);
    const out = $('#qr-output');
    out.hidden = false;
    out.textContent = `Deep link:\n${qr.payload}\n\nWeb link:\n${qr.web_link}`;
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------------- Delegated click actions ---------------- */
document.addEventListener('click', async (e) => {
  const notif = e.target.closest('[data-notif]');
  if (notif && notif.classList.contains('unread')) {
    try {
      await api('POST', `/notifications/${notif.dataset.notif}/read`);
      notif.classList.remove('unread');
      notif.querySelector('.dot')?.remove();
      refreshUnread();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const btn = e.target.closest('[data-pay-request],[data-decline-request],[data-pay-split],[data-invoice-paid],[data-merchant-action]');
  if (!btn) return;
  try {
    if (btn.dataset.merchantAction) {
      await api('POST', `/admin/merchants/${btn.dataset.merchant}/${btn.dataset.merchantAction}`);
      toast(`Merchant ${btn.dataset.merchantAction}d`, 'success');
      loadAdmin();
      return;
    }
    if (btn.dataset.payRequest) {
      await api('POST', `/wallet/requests/${btn.dataset.payRequest}/pay`);
      toast('Request paid', 'success');
      refreshAll(); loadRequests('incoming');
    } else if (btn.dataset.declineRequest) {
      await api('POST', `/wallet/requests/${btn.dataset.declineRequest}/decline`);
      toast('Request declined');
      loadRequests('incoming');
    } else if (btn.dataset.paySplit) {
      await api('POST', `/splits/${btn.dataset.paySplit}/pay`);
      toast('Share paid', 'success');
      refreshAll(); loadSplits();
    } else if (btn.dataset.invoicePaid) {
      await api('POST', `/invoices/${btn.dataset.invoicePaid}/paid`);
      toast('Invoice marked paid', 'success');
      loadInvoices();
    }
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------------- Boot ---------------- */
if (token) {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  refreshAll();
}
