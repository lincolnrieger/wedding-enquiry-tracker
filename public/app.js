// Wedding Enquiry Tracker — single-page frontend (no build step).

// ---------------------------------------------------------------------------
// Tiny DOM helper. Strings are always added as text nodes, so user data can't inject HTML.

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const $app = document.getElementById('app');

function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = 'toast'), 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') {
    state.config = null;
    renderAuth();
    throw new Error(data.error || 'Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// State

const state = {
  config: null, // { appName, fields, stages, users, me }
  enquiries: [],
  view: localStorage.getItem('wet_view') || 'list',
  adminTab: 'fields',
  search: '',
  stageFilter: '',
  sort: { key: '_created', dir: -1 },
};

const isAdmin = () => state.config?.me.role === 'admin';
const activeFields = () => state.config.fields.filter((f) => !f.archived);
const stageById = (id) => state.config.stages.find((s) => s.id === id);
const userById = (id) => state.config.users.find((u) => u.id === id);

function titleOf(enquiry) {
  const first = activeFields().find((f) => f.type === 'text');
  return (first && enquiry.data[first.key]) || `Enquiry #${enquiry.id}`;
}

// ---------------------------------------------------------------------------
// Formatting

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(sqlUtc) {
  if (!sqlUtc) return '';
  return new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = Date.UTC(...fromIso.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  const b = Date.UTC(...toIso.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  return Math.round((b - a) / 86400000);
}

function durationValue(field, data) {
  return daysBetween(data[field.config.from], data[field.config.to]);
}

function fmtDuration(days) {
  if (days === null) return '';
  const label = `${days} day${Math.abs(days) === 1 ? '' : 's'}`;
  if (Math.abs(days) >= 60) return `${label} (≈ ${Math.round(days / 30.4)} mths)`;
  if (Math.abs(days) >= 14) return `${label} (≈ ${Math.round(days / 7)} wks)`;
  return label;
}

function displayValue(field, data) {
  const v = data[field.key];
  switch (field.type) {
    case 'date': return fmtDate(v);
    case 'checkbox': return v ? '✓' : '';
    case 'duration': return fmtDuration(durationValue(field, data));
    default: return v ?? '';
  }
}

function sortValue(field, data) {
  if (field.type === 'duration') return durationValue(field, data);
  const v = data[field.key];
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' ? v.toLowerCase() : Number(v);
}

function stagePill(stage) {
  if (!stage) return h('span', { class: 'muted' }, '—');
  return h('span', { class: 'pill', style: { background: stage.color + '22', color: stage.color, borderColor: stage.color + '55' } },
    h('span', { class: 'dot', style: { background: stage.color } }), stage.name);
}

// ---------------------------------------------------------------------------
// Boot & auth

async function boot() {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (invite) return renderInvite(invite);
  try {
    const setup = await fetch('/api/setup').then((r) => r.json());
    document.title = setup.appName;
    if (setup.needsSetup) return renderSetup(setup.appName);
    await loadAll();
    renderApp();
  } catch {
    // loadAll() hits 401 → api() already rendered the sign-in screen.
    if (!state.config && !$app.querySelector('.auth')) renderAuth();
  }
}

async function loadAll() {
  const [config, list] = await Promise.all([api('config'), api('enquiries')]);
  state.config = config;
  state.enquiries = list.enquiries;
  document.title = config.appName;
}

function authShell(title, subtitle, form) {
  $app.replaceChildren(
    h('div', { class: 'auth' },
      h('div', { class: 'auth-card' },
        h('h1', {}, title),
        subtitle && h('p', { class: 'muted', style: { textAlign: 'center', margin: 0 } }, subtitle),
        form))
  );
  form.querySelector('input')?.focus();
}

function renderAuth() {
  const err = h('div', { class: 'error hidden' });
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    h('label', { class: 'field' }, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
    h('label', { class: 'field' }, 'Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    err,
    h('button', { class: 'primary', type: 'submit' }, 'Sign in'),
    h('p', { class: 'muted small', style: { textAlign: 'center', margin: 0 } }, 'Forgotten your password? Ask an admin to send you a reset link.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    try {
      await api('login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      await loadAll();
      renderApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });
  authShell(document.title || 'Wedding Enquiries', 'Sign in to manage enquiries', form);
}

async function renderInvite(token) {
  const goToSignIn = () => {
    history.replaceState(null, '', location.pathname);
    boot();
  };
  let info;
  try {
    info = await api(`invite?token=${encodeURIComponent(token)}`);
  } catch (ex) {
    const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'error' }, ex.message),
      h('button', { class: 'primary', onclick: goToSignIn }, 'Go to sign in'));
    return authShell(document.title || 'Wedding Enquiries', null, box);
  }
  const err = h('div', { class: 'error hidden' });
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    h('label', { class: 'field' }, 'Email', h('input', { type: 'email', value: info.email, disabled: true, autocomplete: 'username' })),
    h('label', { class: 'field' }, info.isNew ? 'Choose a password' : 'New password',
      h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' })),
    h('label', { class: 'field' }, 'Type it again', h('input', { name: 'confirm', type: 'password', required: true, autocomplete: 'new-password' })),
    err,
    h('button', { class: 'primary', type: 'submit' }, info.isNew ? 'Create my account' : 'Save new password'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    if (form.password.value !== form.confirm.value) {
      err.textContent = "The two passwords don't match.";
      return err.classList.remove('hidden');
    }
    try {
      await api('invite', { method: 'POST', body: { token, password: form.password.value } });
      history.replaceState(null, '', location.pathname);
      await loadAll();
      renderApp();
      toast(info.isNew ? `Welcome, ${info.name}!` : 'Password updated');
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });
  authShell(`Hi ${info.name}`, info.isNew ? 'Choose a password to finish setting up your account.' : 'Choose a new password.', form);
  form.password.focus();
}

function renderSetup(appName) {
  const err = h('div', { class: 'error hidden' });
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    h('label', { class: 'field' }, 'Your name', h('input', { name: 'name', required: true })),
    h('label', { class: 'field' }, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
    h('label', { class: 'field' }, 'Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' })),
    err,
    h('button', { class: 'primary', type: 'submit' }, 'Create admin account'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('setup', { method: 'POST', body: { name: form.name.value, email: form.email.value, password: form.password.value } });
      await loadAll();
      renderApp();
      toast('Welcome! Your admin account is ready.');
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });
  authShell(appName, 'First-time setup — create the admin account.', form);
}

// ---------------------------------------------------------------------------
// App shell

function setView(view) {
  state.view = view;
  localStorage.setItem('wet_view', view);
  renderApp();
}

function renderApp() {
  if (!state.config) return renderAuth();
  if (state.view === 'admin' && !isAdmin()) state.view = 'list';
  const tabs = [
    ['list', 'Enquiries'],
    ['board', 'Board'],
    ['summary', 'Summary'],
    ...(isAdmin() ? [['admin', 'Admin settings']] : []),
  ];
  const me = state.config.me;
  const header = h('header', { class: 'top' },
    h('h1', {}, state.config.appName),
    h('nav', { class: 'tabs' }, tabs.map(([key, label]) =>
      h('button', { class: state.view === key ? 'active' : '', onclick: () => setView(key) }, label))),
    h('div', { class: 'user-menu' },
      h('span', { id: 'sync-status', class: 'muted small' }),
      h('span', {}, me.name),
      h('span', { class: 'role-badge' }, me.role),
      h('button', { class: 'ghost', onclick: openPasswordModal }, 'Password'),
      h('button', { class: 'ghost', onclick: signOut }, 'Sign out')));

  const views = { list: renderList, board: renderBoard, summary: renderSummary, admin: renderAdmin };
  const wide = state.view === 'list' || state.view === 'board';
  $app.replaceChildren(header, h('main', { class: wide ? 'wide' : '' }, views[state.view]()));
  updateSyncStatus();
}

// ---------------------------------------------------------------------------
// Background saving: the screen updates instantly and the database catches up behind it.
// Saves for the same enquiry run in order, so a quick drag-then-tick never arrives out of order.

const saveQueues = new WeakMap();
const queuedCount = new WeakMap();
let pendingSaves = 0;

function updateSyncStatus() {
  const el = document.getElementById('sync-status');
  if (el) el.textContent = pendingSaves ? 'Saving…' : '';
}

window.addEventListener('beforeunload', (e) => {
  if (pendingSaves) e.preventDefault();
});

function queueSave(enquiry, task) {
  const prev = saveQueues.get(enquiry) || Promise.resolve();
  queuedCount.set(enquiry, (queuedCount.get(enquiry) || 0) + 1);
  pendingSaves++;
  updateSyncStatus();
  const run = prev.then(task).catch(async (ex) => {
    toast(`Couldn't save: ${ex.message}`, true);
    await refreshEnquiries().catch(() => {});
    renderApp();
  }).finally(() => {
    queuedCount.set(enquiry, queuedCount.get(enquiry) - 1);
    pendingSaves--;
    updateSyncStatus();
  });
  saveQueues.set(enquiry, run);
  return run;
}

const whenSaved = (enquiry) => saveQueues.get(enquiry) || Promise.resolve();

// Copy what the server saved, unless newer local changes are still waiting to go out.
function settle(enquiry, saved) {
  const { data, stage_id, assigned_to, ...meta } = saved;
  Object.assign(enquiry, meta);
  if (queuedCount.get(enquiry) <= 1) Object.assign(enquiry, { data, stage_id, assigned_to });
}

function applyLocal(enquiry, body) {
  if ('stage_id' in body) enquiry.stage_id = body.stage_id;
  if ('assigned_to' in body) enquiry.assigned_to = body.assigned_to;
  if (body.data) {
    enquiry.data = { ...enquiry.data };
    for (const [k, v] of Object.entries(body.data)) {
      if (v === '' || v === null || v === undefined) delete enquiry.data[k];
      else enquiry.data[k] = v;
    }
  }
}

async function signOut() {
  await api('logout', { method: 'POST', body: {} }).catch(() => {});
  state.config = null;
  renderAuth();
}

async function refreshEnquiries() {
  state.enquiries = (await api('enquiries')).enquiries;
}

async function refreshConfig() {
  state.config = await api('config');
  document.title = state.config.appName;
}

// ---------------------------------------------------------------------------
// Enquiry list

function filteredEnquiries() {
  const q = state.search.trim().toLowerCase();
  const fields = activeFields();
  return state.enquiries.filter((e) => {
    if (state.stageFilter && String(e.stage_id) !== state.stageFilter) return false;
    if (!q) return true;
    return fields.some((f) => String(displayValue(f, e.data)).toLowerCase().includes(q));
  });
}

function toolbar(extra) {
  const search = h('input', {
    type: 'search', placeholder: 'Search enquiries…', value: state.search,
    oninput: (e) => {
      state.search = e.target.value;
      const pos = e.target.selectionStart;
      renderApp();
      const el = $app.querySelector('input[type=search]');
      el.focus();
      el.setSelectionRange(pos, pos);
    },
  });
  const stageSel = h('select', { onchange: (e) => { state.stageFilter = e.target.value; renderApp(); } },
    h('option', { value: '' }, 'All stages'),
    state.config.stages.map((s) => h('option', { value: String(s.id), selected: state.stageFilter === String(s.id) }, s.name)));
  return h('div', { class: 'toolbar' },
    search, stageSel, h('div', { class: 'grow' }), extra,
    h('button', { onclick: exportCsv }, 'Export CSV'),
    h('button', { class: 'primary', onclick: () => openEnquiry(null) }, '+ Add new enquiry'));
}

function renderList() {
  const fields = activeFields().filter((f) => f.show_in_list);
  const tickFields = activeFields().filter((f) => f.type === 'checkbox');
  const rows = filteredEnquiries();

  const { key, dir } = state.sort;
  const sortField = fields.find((f) => f.key === key) || tickFields.find((f) => f.key === key);
  rows.sort((a, b) => {
    let va, vb;
    if (key === '_stage') { va = stageById(a.stage_id)?.position ?? 999; vb = stageById(b.stage_id)?.position ?? 999; }
    else if (sortField) { va = sortValue(sortField, a.data); vb = sortValue(sortField, b.data); }
    else { va = a.created_at + String(a.id).padStart(8, '0'); vb = b.created_at + String(b.id).padStart(8, '0'); }
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return (va < vb ? -1 : 1) * dir;
  });

  const sortHead = (label, k, cls = '') => h('th', {
    class: cls,
    onclick: () => { state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; renderApp(); },
  }, label, state.sort.key === k ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : '');

  const tickCols = tickFields.filter((f) => !f.show_in_list);
  const table = h('table', {},
    h('thead', {}, h('tr', {},
      sortHead('Stage', '_stage'),
      fields.map((f) => sortHead(f.label, f.key, f.type === 'checkbox' ? 'center' : '')),
      tickCols.length ? h('th', { class: 'nosort' }, 'Checklist') : null)),
    h('tbody', {}, rows.map((e) => h('tr', { onclick: () => openEnquiry(e) },
      h('td', { onclick: (ev) => ev.stopPropagation() }, stageSelect(e)),
      fields.map((f) => f.type === 'checkbox' ? tickCell(e, f) : h('td', {}, displayValue(f, e.data))),
      tickCols.length ? h('td', { onclick: (ev) => ev.stopPropagation() }, h('div', { class: 'ticks' }, tickCols.map((f) => tickChip(e, f)))) : null))));

  return h('div', {},
    toolbar(h('span', { class: 'muted' }, `${rows.length} of ${state.enquiries.length}`)),
    h('div', { class: 'card table-wrap' },
      rows.length ? table : h('div', { class: 'empty' },
        state.enquiries.length ? 'No enquiries match your filters.' : 'No enquiries yet — click “Add new enquiry” to log the first one.')));
}

function stageSelect(enquiry) {
  const stage = stageById(enquiry.stage_id);
  const sel = h('select', {
    class: 'stage-select',
    style: stage ? { color: stage.color, borderColor: stage.color + '88', background: stage.color + '14' } : {},
    onchange: (e) => quickUpdate(enquiry, { stage_id: Number(e.target.value) }),
  }, state.config.stages.map((s) => h('option', { value: s.id, selected: s.id === enquiry.stage_id }, s.name)));
  return sel;
}

function tickCell(enquiry, field) {
  return h('td', { class: 'center', onclick: (e) => e.stopPropagation() },
    h('input', {
      type: 'checkbox', checked: !!enquiry.data[field.key], title: field.label,
      onchange: (e) => quickUpdate(enquiry, { data: { [field.key]: e.target.checked } }),
    }));
}

function tickChip(enquiry, field) {
  const on = !!enquiry.data[field.key];
  return h('button', {
    type: 'button', class: 'tick-chip' + (on ? ' on' : ''), title: on ? `Untick “${field.label}”` : `Tick “${field.label}”`,
    onclick: () => quickUpdate(enquiry, { data: { [field.key]: !on } }),
  }, (on ? '✓ ' : '') + field.label);
}

function quickUpdate(enquiry, body) {
  applyLocal(enquiry, body);
  renderApp();
  queueSave(enquiry, async () => {
    const { enquiry: saved } = await api(`enquiries/${enquiry.id}`, { method: 'PATCH', body });
    settle(enquiry, saved);
  });
}

// ---------------------------------------------------------------------------
// Board (drag cards between stages)

let dragging = null;

function renderBoard() {
  const rows = filteredEnquiries();
  const listFields = activeFields().filter((f) => f.show_in_list && f.type !== 'checkbox').slice(1, 4);
  const ticks = activeFields().filter((f) => f.type === 'checkbox');

  const columns = state.config.stages.map((stage) => {
    const items = rows.filter((e) => e.stage_id === stage.id);
    const body = h('div', { class: 'column-body' }, items.map((e) =>
      h('div', {
        class: 'board-card', draggable: 'true',
        ondragstart: (ev) => { dragging = e; ev.dataTransfer.setData('text/plain', ''); },
        onclick: () => openEnquiry(e),
      },
        h('div', { class: 'title' }, titleOf(e)),
        h('div', { class: 'meta' }, listFields.map((f) => {
          const v = displayValue(f, e.data);
          return v !== '' ? h('span', {}, `${f.label}: ${v}`) : null;
        })),
        ticks.length ? h('div', { class: 'ticks' }, ticks.map((f) =>
          h('span', { class: 'tick-chip' + (e.data[f.key] ? ' on' : '') }, (e.data[f.key] ? '✓ ' : '') + f.label))) : null)));
    const col = h('div', { class: 'column' },
      h('div', { class: 'column-head' }, h('span', { class: 'dot pill', style: { background: stage.color, width: '10px', height: '10px', padding: 0 } }), stage.name, h('span', { class: 'count' }, items.length)),
      body);
    col.addEventListener('dragover', (ev) => { ev.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', (ev) => {
      ev.preventDefault();
      col.classList.remove('drag-over');
      const e = dragging;
      dragging = null;
      if (e && e.stage_id !== stage.id) quickUpdate(e, { stage_id: stage.id });
    });
    return col;
  });

  const unstaged = rows.filter((e) => !stageById(e.stage_id));
  return h('div', {},
    toolbar(h('span', { class: 'muted' }, 'Drag cards between columns to move them along')),
    h('div', { class: 'board' }, columns),
    unstaged.length ? h('p', { class: 'muted' }, `${unstaged.length} enquiries have no stage — find them in the Enquiries tab.`) : null);
}

// ---------------------------------------------------------------------------
// Summary

function renderSummary() {
  const all = state.enquiries;
  const stages = state.config.stages;
  const won = all.filter((e) => stageById(e.stage_id)?.is_won).length;
  const lost = all.filter((e) => stageById(e.stage_id)?.is_lost).length;
  const open = all.length - won - lost;
  const decided = won + lost;

  const stat = (label, value, hint) => h('div', { class: 'card stat' },
    h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'muted small' }, hint) : null);

  const tiles = [
    stat('Total enquiries', all.length),
    stat('Open', open),
    stat('Booked', won),
    stat('Conversion rate', all.length ? Math.round((won / all.length) * 100) + '%' : '—',
      decided ? `${Math.round((won / decided) * 100)}% of decided enquiries` : null),
  ];
  for (const f of activeFields().filter((x) => x.type === 'duration')) {
    const vals = all.map((e) => durationValue(f, e.data)).filter((v) => v !== null);
    if (vals.length) tiles.push(stat(`Avg. ${f.label.toLowerCase()}`, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) + 'd', `across ${vals.length} enquiries`));
  }

  const bars = (title, entries) => {
    const max = Math.max(1, ...entries.map(([, n]) => n));
    return h('div', { class: 'card' }, h('h3', {}, title),
      entries.length ? entries.map(([name, n, color]) => h('div', { class: 'bar-row' },
        h('span', { class: 'name', title: name }, name),
        h('div', { class: 'bar' }, h('span', { style: { width: (n / max) * 100 + '%', background: color || 'var(--accent)' } })),
        h('span', { class: 'n' }, n))) : h('p', { class: 'muted' }, 'No data yet.'));
  };

  const panels = [bars('By stage', stages.map((s) => [s.name, all.filter((e) => e.stage_id === s.id).length, s.color]))];
  for (const f of activeFields().filter((x) => x.type === 'select')) {
    const counts = {};
    for (const e of all) {
      const v = e.data[f.key] || 'Not set';
      counts[v] = (counts[v] || 0) + 1;
    }
    panels.push(bars(`By ${f.label.toLowerCase()}`, Object.entries(counts).sort((a, b) => b[1] - a[1])));
  }
  const ticks = activeFields().filter((f) => f.type === 'checkbox');
  if (ticks.length) panels.push(bars('Checklist progress', ticks.map((f) => [f.label, all.filter((e) => e.data[f.key]).length])));

  const byMonth = {};
  for (const e of all) {
    const dateField = activeFields().find((f) => f.type === 'date');
    const d = (dateField && e.data[dateField.key]) || e.created_at.slice(0, 10);
    const m = d.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  const months = Object.keys(byMonth).sort().slice(-12);
  panels.push(bars('Enquiries per month', months.map((m) => {
    const [y, mo] = m.split('-').map(Number);
    return [new Date(y, mo - 1, 1).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }), byMonth[m]];
  })));

  return h('div', {}, h('div', { class: 'stats' }, tiles), h('div', { class: 'summary-grid' }, panels));
}

// ---------------------------------------------------------------------------
// Enquiry modal (add + edit)

function closeModal() {
  document.querySelector('.overlay')?.remove();
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }

function modal(title, body, footer, { narrow = false, headExtra } = {}) {
  closeModal();
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) closeModal(); } },
    h('div', { class: 'modal' + (narrow ? ' narrow' : ''), role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h2', {}, title), headExtra, h('button', { class: 'ghost icon', onclick: closeModal, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null));
  document.body.append(overlay);
  document.addEventListener('keydown', escClose);
  overlay.querySelector('input, select, textarea')?.focus();
  return overlay;
}

function fieldInput(field, value, data) {
  const name = `f_${field.key}`;
  switch (field.type) {
    case 'textarea':
      return h('textarea', { name, value: value ?? '' });
    case 'number':
      return h('input', { name, type: 'number', step: 'any', value: value ?? '' });
    case 'date':
      return h('input', { name, type: 'date', value: value ?? '' });
    case 'email':
      return h('input', { name, type: 'email', value: value ?? '' });
    case 'phone':
      return h('input', { name, type: 'tel', value: value ?? '' });
    case 'select': {
      const opts = [...field.options];
      if (value && !opts.includes(value)) opts.push(value);
      return h('select', { name }, h('option', { value: '' }, '— Select —'),
        opts.map((o) => h('option', { value: o, selected: o === value }, o)));
    }
    case 'checkbox':
      return h('span', { class: 'check-box' }, h('input', { name, type: 'checkbox', checked: !!value }), 'Yes');
    case 'duration':
      return h('div', { class: 'computed', 'data-duration': field.key }, fmtDuration(durationValue(field, data)) || 'Calculated automatically');
    default:
      return h('input', { name, type: 'text', value: value ?? '' });
  }
}

function openEnquiry(enquiry) {
  const isNew = !enquiry;
  const data = enquiry ? { ...enquiry.data } : {};
  if (isNew) {
    // Pre-fill the first date field (usually "Date of enquiry") with today.
    const firstDate = activeFields().find((f) => f.type === 'date');
    if (firstDate) data[firstDate.key] = new Date().toLocaleDateString('en-CA');
  }

  const sections = [];
  for (const f of activeFields()) {
    let sec = sections.find((s) => s.name === f.section);
    if (!sec) sections.push((sec = { name: f.section, fields: [] }));
    sec.fields.push(f);
  }

  const err = h('div', { class: 'error hidden' });
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '20px' } },
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, 'Stage',
        h('select', { name: 'stage_id' }, state.config.stages.map((s) =>
          h('option', { value: s.id, selected: enquiry ? s.id === enquiry.stage_id : s === state.config.stages[0] }, s.name)))),
      h('label', { class: 'field' }, 'Assigned to',
        h('select', { name: 'assigned_to' }, h('option', { value: '' }, '— Nobody —'),
          state.config.users.filter((u) => u.active || u.id === enquiry?.assigned_to).map((u) =>
            h('option', { value: u.id, selected: enquiry?.assigned_to === u.id }, u.name))))),
    sections.map((sec) => h('div', { class: 'form-section' },
      h('h3', {}, sec.name),
      h('div', { class: 'form-grid' }, sec.fields.map((f) =>
        h('label', { class: 'field' + (f.type === 'textarea' ? ' wide' : '') },
          h('span', {}, f.label, f.required ? h('span', { class: 'req' }, ' *') : null),
          fieldInput(f, data[f.key], data)))))),
    err);

  // Keep calculated durations live as dates change.
  form.addEventListener('input', () => {
    const current = readForm(form).data;
    for (const el of form.querySelectorAll('[data-duration]')) {
      const f = activeFields().find((x) => x.key === el.dataset.duration);
      el.textContent = fmtDuration(durationValue(f, current)) || 'Calculated automatically';
    }
  });

  const save = () => {
    err.classList.add('hidden');
    const body = readForm(form);
    const missing = activeFields().find((f) => f.required && (body.data[f.key] === '' || body.data[f.key] === false));
    if (missing) {
      err.textContent = `"${missing.label}" is required.`;
      err.classList.remove('hidden');
      err.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Update the screen straight away; the database save happens in the background.
    if (isNew) {
      const draft = {
        id: null, stage_id: body.stage_id ?? state.config.stages[0]?.id ?? null, assigned_to: body.assigned_to, data: {},
        created_by_name: state.config.me.name, created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };
      applyLocal(draft, body);
      state.enquiries.unshift(draft);
      queueSave(draft, async () => {
        const { enquiry: created } = await api('enquiries', { method: 'POST', body });
        settle(draft, created);
      });
      toast('Enquiry added');
    } else {
      applyLocal(enquiry, body);
      queueSave(enquiry, async () => {
        const { enquiry: saved } = await api(`enquiries/${enquiry.id}`, { method: 'PUT', body });
        settle(enquiry, saved);
      });
      toast('Changes saved');
    }
    closeModal();
    renderApp();
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  const body = [form];
  if (!isNew) body.push(activityPanel(enquiry));

  const footer = [
    !isNew && isAdmin() ? h('button', { class: 'danger left', onclick: () => deleteEnquiry(enquiry) }, 'Delete') : null,
    !isNew ? h('span', { class: 'muted small left' }, `Added by ${enquiry.created_by_name || 'unknown'} · ${fmtDateTime(enquiry.created_at)}`) : null,
    h('button', { onclick: closeModal }, 'Cancel'),
    h('button', { class: 'primary', onclick: save }, isNew ? 'Add enquiry' : 'Save changes'),
  ];
  modal(isNew ? 'New enquiry' : titleOf(enquiry), body, footer, { headExtra: enquiry ? stagePill(stageById(enquiry.stage_id)) : null });
}

function readForm(form) {
  const data = {};
  for (const f of activeFields()) {
    const el = form.elements[`f_${f.key}`];
    if (!el) continue;
    data[f.key] = f.type === 'checkbox' ? el.checked : el.value;
  }
  return {
    data,
    stage_id: Number(form.elements.stage_id.value) || null,
    assigned_to: form.elements.assigned_to.value ? Number(form.elements.assigned_to.value) : null,
  };
}

function activityPanel(enquiry) {
  const list = h('div', { class: 'activity' }, h('span', { class: 'muted' }, 'Loading history…'));
  const draw = (items) => list.replaceChildren(...(items.length ? items.map((a) =>
    h('div', { class: 'activity-item' + (a.kind === 'note' ? ' note' : '') },
      h('div', { class: 'muted small' }, `${a.user_name || 'Someone'} · ${fmtDateTime(a.created_at)}${a.kind === 'note' ? ' · note' : ''}`),
      h('div', { class: 'msg' }, a.message))) : [h('span', { class: 'muted' }, 'No history yet.')]));
  whenSaved(enquiry).then(() => api(`enquiries/${enquiry.id}/activity`)).then((r) => draw(r.activity)).catch(() => {});

  const note = h('textarea', { placeholder: 'Add a note (phone call, follow-up, etc.)…' });
  const addNote = () => {
    const message = note.value.trim();
    if (!message) return;
    note.value = '';
    list.prepend(h('div', { class: 'activity-item note' },
      h('div', { class: 'muted small' }, `${state.config.me.name} · just now · note`), h('div', { class: 'msg' }, message)));
    queueSave(enquiry, async () => {
      const r = await api(`enquiries/${enquiry.id}/notes`, { method: 'POST', body: { message } });
      if (list.isConnected) draw(r.activity);
    });
  };
  return h('div', { class: 'form-section' },
    h('h3', {}, 'Notes & history'),
    h('div', { class: 'note-form' }, note, h('button', { type: 'button', onclick: addNote }, 'Add note')),
    h('div', { style: { height: '12px' } }),
    list);
}

function deleteEnquiry(enquiry) {
  if (!confirm(`Delete "${titleOf(enquiry)}"? This can't be undone.`)) return;
  state.enquiries = state.enquiries.filter((e) => e !== enquiry);
  closeModal();
  renderApp();
  toast('Enquiry deleted');
  queueSave(enquiry, () => api(`enquiries/${enquiry.id}`, { method: 'DELETE', body: {} }));
}

// ---------------------------------------------------------------------------
// CSV export

function exportCsv() {
  const fields = activeFields();
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Stage', 'Assigned to', ...fields.map((f) => f.label), 'Created'];
  const lines = [header.map(esc).join(',')];
  for (const e of filteredEnquiries()) {
    lines.push([
      stageById(e.stage_id)?.name,
      userById(e.assigned_to)?.name,
      ...fields.map((f) => {
        if (f.type === 'checkbox') return e.data[f.key] ? 'Yes' : 'No';
        if (f.type === 'duration') return durationValue(f, e.data) ?? '';
        return e.data[f.key];
      }),
      e.created_at,
    ].map(esc).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `wedding-enquiries-${new Date().toLocaleDateString('en-CA')}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// Password

function openPasswordModal() {
  const err = h('div', { class: 'error hidden' });
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    h('label', { class: 'field' }, 'Current password', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', { class: 'field' }, 'New password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' })),
    err);
  const save = async () => {
    try {
      await api('me/password', { method: 'PUT', body: { current: form.current.value, password: form.password.value } });
      closeModal();
      toast('Password changed');
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  modal('Change password', form, [h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: save }, 'Change password')], { narrow: true });
}

// ---------------------------------------------------------------------------
// Admin settings

function renderAdmin() {
  const tabs = [['fields', 'Form fields'], ['stages', 'Workflow stages'], ['users', 'Staff accounts'], ['general', 'General']];
  const panels = { fields: adminFields, stages: adminStages, users: adminUsers, general: adminGeneral };
  const panel = h('div', { class: 'card admin-panel' }, h('span', { class: 'muted' }, 'Loading…'));
  Promise.resolve(panels[state.adminTab]()).then((content) => panel.replaceChildren(...[content].flat(Infinity).filter(Boolean)));
  return h('div', { class: 'admin-layout' },
    h('div', { class: 'admin-nav' }, tabs.map(([k, label]) =>
      h('button', { class: state.adminTab === k ? 'active' : '', onclick: () => { state.adminTab = k; renderApp(); } }, label))),
    panel);
}

async function adminAction(fn, message) {
  try {
    await fn();
    await refreshConfig();
    if (message) toast(message);
    renderApp();
    return true;
  } catch (ex) {
    toast(ex.message, true);
    return false;
  }
}

const TYPE_LABELS = {
  text: 'Short text', textarea: 'Long text / notes', email: 'Email', phone: 'Phone', number: 'Number',
  date: 'Date', select: 'Dropdown', checkbox: 'Tick box', duration: 'Days between two dates (auto)',
};

function moveButtons(list, index, table) {
  const move = (delta) => {
    const ids = list.map((x) => x.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    adminAction(() => api(`admin/${table}/order`, { method: 'PUT', body: { ids } }));
  };
  return [
    h('button', { class: 'ghost icon', title: 'Move up', disabled: index === 0, onclick: () => move(-1) }, '↑'),
    h('button', { class: 'ghost icon', title: 'Move down', disabled: index === list.length - 1, onclick: () => move(1) }, '↓'),
  ];
}

function adminFields() {
  const all = state.config.fields;
  const live = all.filter((f) => !f.archived);
  const archived = all.filter((f) => f.archived);
  return [
    h('div', { class: 'head' }, h('h2', {}, 'Form fields'), h('button', { class: 'primary', onclick: () => openFieldModal(null) }, '+ Add field')),
    h('p', { class: 'muted' }, 'These are the questions on the "Add new enquiry" form. Add tick boxes, dropdowns, dates and more. Removing a field hides it but keeps any answers already saved, so you can restore it later.'),
    live.map((f, i) => h('div', { class: 'list-row' },
      moveButtons(live, i, 'fields'),
      h('div', { class: 'grow' }, h('strong', {}, f.label), h('div', { class: 'muted small' }, `${TYPE_LABELS[f.type]} · Section: ${f.section}`)),
      f.required ? h('span', { class: 'tag' }, 'Required') : null,
      f.show_in_list ? h('span', { class: 'tag' }, 'Shown in list') : null,
      h('button', { onclick: () => openFieldModal(f) }, 'Edit'),
      h('button', { class: 'danger', onclick: () => {
        if (confirm(`Remove "${f.label}" from the form? Saved answers are kept and you can restore it later.`)) {
          adminAction(() => api(`admin/fields/${f.id}`, { method: 'DELETE', body: {} }), 'Field removed');
        }
      } }, 'Remove'))),
    archived.length ? [h('h3', { style: { marginTop: '24px' } }, 'Removed fields'),
      archived.map((f) => h('div', { class: 'list-row archived' },
        h('div', { class: 'grow' }, h('strong', {}, f.label), h('div', { class: 'muted small' }, TYPE_LABELS[f.type])),
        h('button', { onclick: () => adminAction(() => api(`admin/fields/${f.id}`, { method: 'PUT', body: { archived: false } }), 'Field restored') }, 'Restore')))] : null,
  ];
}

function openFieldModal(field) {
  const isNew = !field;
  const f = field || { label: '', type: 'checkbox', options: [], config: {}, section: 'Progress', required: false, show_in_list: false };
  const sections = [...new Set(state.config.fields.map((x) => x.section))];
  const dateFields = activeFields().filter((x) => x.type === 'date');

  let options = f.options.length ? [...f.options] : [''];
  const optionsBox = h('div', { class: 'options-editor' });
  const drawOptions = () => optionsBox.replaceChildren(
    ...options.map((o, i) => h('div', { class: 'opt' },
      h('input', { value: o, placeholder: `Option ${i + 1}`, oninput: (e) => (options[i] = e.target.value) }),
      h('button', { type: 'button', class: 'ghost icon', disabled: options.length === 1, onclick: () => { options.splice(i, 1); drawOptions(); } }, '✕'))),
    h('button', { type: 'button', onclick: () => { options.push(''); drawOptions(); optionsBox.querySelectorAll('input')[options.length - 1].focus(); } }, '+ Add option'));
  drawOptions();

  const dateSelect = (name, selected) => h('select', { name },
    h('option', { value: '' }, '— Choose a date field —'),
    dateFields.map((d) => h('option', { value: d.key, selected: d.key === selected }, d.label)));

  const optionsWrap = h('label', { class: 'field wide' }, 'Dropdown options', optionsBox);
  const durationWrap = h('div', { class: 'form-grid wide' },
    h('label', { class: 'field' }, 'From date', dateSelect('from', f.config.from)),
    h('label', { class: 'field' }, 'To date', dateSelect('to', f.config.to)));

  const err = h('div', { class: 'error hidden' });
  const typeSel = h('select', { name: 'type' }, Object.entries(TYPE_LABELS).map(([k, v]) => h('option', { value: k, selected: k === f.type }, v)));
  const form = h('form', { class: 'form-grid' },
    h('label', { class: 'field' }, 'Label', h('input', { name: 'label', value: f.label, required: true, placeholder: 'e.g. Brochure sent' })),
    h('label', { class: 'field' }, 'Type', typeSel),
    h('label', { class: 'field' }, 'Section (groups fields on the form)',
      h('input', { name: 'section', value: f.section, list: 'section-list' }),
      h('datalist', { id: 'section-list' }, sections.map((s) => h('option', { value: s })))),
    h('div', { class: 'field', style: { justifyContent: 'flex-end', gap: '10px' } },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'required', checked: f.required }), 'Required'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'show_in_list', checked: f.show_in_list }), 'Show as a column in the list')),
    optionsWrap, durationWrap, h('div', { class: 'wide' }, err));

  const syncType = () => {
    optionsWrap.classList.toggle('hidden', typeSel.value !== 'select');
    durationWrap.classList.toggle('hidden', typeSel.value !== 'duration');
  };
  typeSel.addEventListener('change', syncType);
  syncType();

  const save = async () => {
    const body = {
      label: form.label.value,
      type: typeSel.value,
      section: form.section.value,
      required: form.required.checked,
      show_in_list: form.show_in_list.checked,
      options: options.map((o) => o.trim()).filter(Boolean),
      config: { from: form.from.value, to: form.to.value },
    };
    try {
      await api(isNew ? 'admin/fields' : `admin/fields/${f.id}`, { method: isNew ? 'POST' : 'PUT', body });
      closeModal();
      await refreshConfig();
      renderApp();
      toast(isNew ? 'Field added' : 'Field updated');
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  modal(isNew ? 'Add field' : `Edit “${f.label}”`, form,
    [h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: save }, isNew ? 'Add field' : 'Save')]);
}

function adminStages() {
  const stages = state.config.stages;
  return [
    h('div', { class: 'head' }, h('h2', {}, 'Workflow stages'), h('button', { class: 'primary', onclick: () => openStageModal(null) }, '+ Add stage')),
    h('p', { class: 'muted' }, 'The steps an enquiry moves through. Mark the stage that means "booked" as a win so the summary can work out your conversion rate.'),
    stages.map((s, i) => h('div', { class: 'list-row' },
      moveButtons(stages, i, 'stages'),
      h('span', { class: 'swatch', style: { background: s.color } }),
      h('div', { class: 'grow' }, h('strong', {}, s.name), h('div', { class: 'muted small' },
        `${state.enquiries.filter((e) => e.stage_id === s.id).length} enquiries`)),
      s.is_won ? h('span', { class: 'tag' }, 'Counts as booked') : null,
      s.is_lost ? h('span', { class: 'tag' }, 'Counts as lost') : null,
      h('button', { onclick: () => openStageModal(s) }, 'Edit'),
      h('button', { class: 'danger', disabled: stages.length === 1, onclick: () => deleteStage(s) }, 'Delete'))),
  ];
}

function openStageModal(stage) {
  const isNew = !stage;
  const s = stage || { name: '', color: '#8a9a8b', is_won: false, is_lost: false };
  const err = h('div', { class: 'error hidden' });
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    h('label', { class: 'field' }, 'Name', h('input', { name: 'name', value: s.name, required: true })),
    h('label', { class: 'field' }, 'Colour', h('input', { name: 'color', type: 'color', value: s.color })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'is_won', checked: s.is_won }), 'This stage means the wedding is booked'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'is_lost', checked: s.is_lost }), 'This stage means the enquiry was lost'),
    err);
  const save = async () => {
    const body = { name: form.name.value, color: form.color.value, is_won: form.is_won.checked, is_lost: form.is_lost.checked };
    try {
      await api(isNew ? 'admin/stages' : `admin/stages/${s.id}`, { method: isNew ? 'POST' : 'PUT', body });
      closeModal();
      await refreshConfig();
      renderApp();
      toast(isNew ? 'Stage added' : 'Stage updated');
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  modal(isNew ? 'Add stage' : `Edit “${s.name}”`, form,
    [h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: save }, 'Save')], { narrow: true });
}

function deleteStage(stage) {
  const count = state.enquiries.filter((e) => e.stage_id === stage.id).length;
  const others = state.config.stages.filter((s) => s.id !== stage.id);
  const run = (moveTo) => adminAction(async () => {
    await api(`admin/stages/${stage.id}${moveTo ? `?move_to=${moveTo}` : ''}`, { method: 'DELETE', body: {} });
    closeModal();
    await refreshEnquiries();
  }, 'Stage deleted');

  if (!count) {
    if (confirm(`Delete the "${stage.name}" stage?`)) run(null);
    return;
  }
  const sel = h('select', {}, others.map((s) => h('option', { value: s.id }, s.name)));
  modal(`Delete “${stage.name}”`,
    [h('p', {}, `${count} enquir${count === 1 ? 'y is' : 'ies are'} in this stage. Move them to:`), sel],
    [h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'danger', onclick: () => run(sel.value) }, 'Move & delete')],
    { narrow: true });
}

async function adminUsers() {
  const { users } = await api('admin/users');
  const me = state.config.me;
  return [
    h('div', { class: 'head' }, h('h2', {}, 'Staff accounts'), h('button', { class: 'primary', onclick: () => openUserModal(null) }, '+ Add account')),
    h('p', { class: 'muted' }, 'Staff can add and update enquiries. Admins can also change the form, workflow and accounts. When you add someone, you get a link to send them so they can choose their own password. Use “Get link” any time someone needs a new password.'),
    users.map((u) => h('div', { class: 'list-row' + (u.active ? '' : ' archived') },
      h('div', { class: 'grow' }, h('strong', {}, u.name, u.id === me.id ? ' (you)' : ''), h('div', { class: 'muted small' }, u.email)),
      h('span', { class: 'tag' }, u.role === 'admin' ? 'Admin' : 'Staff'),
      u.pending ? h('span', { class: 'tag pending' }, 'Hasn’t set password yet') : null,
      u.active ? null : h('span', { class: 'tag' }, 'Deactivated'),
      u.active && u.id !== me.id ? h('button', { onclick: () => sendLink(u) }, u.pending ? 'Get invite link' : 'Get password reset link') : null,
      h('button', { onclick: () => openUserModal(u) }, 'Edit'))),
  ];
}

async function sendLink(user) {
  try {
    const { inviteUrl } = await api(`admin/users/${user.id}/invite`, { method: 'POST', body: {} });
    showLinkModal(user, inviteUrl, user.pending);
    if (state.adminTab === 'users') renderApp();
  } catch (ex) { toast(ex.message, true); }
}

function showLinkModal(user, url, isNew) {
  const appName = state.config.appName;
  const subject = isNew ? `Your ${appName} account` : `Reset your ${appName} password`;
  const message = isNew
    ? `Hi ${user.name},\n\nYou've been given an account for ${appName}. Open this link to choose your password:\n\n${url}\n\nThe link works once and expires in 7 days.`
    : `Hi ${user.name},\n\nOpen this link to choose a new password for ${appName}:\n\n${url}\n\nThe link works once and expires in 7 days.`;
  const input = h('input', { value: url, readOnly: true, onfocus: (e) => e.target.select() });
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); toast(`${label} copied`); }
    catch { input.select(); document.execCommand('copy'); toast(`${label} copied`); }
  };
  modal(isNew ? 'Send this link to ' + user.name : 'Password reset link for ' + user.name, [
    h('p', { style: { margin: 0 } }, isNew
      ? `Send this link to ${user.name} (${user.email}) however you like (email, text or chat). They open it and choose their own password.`
      : `Send this link to ${user.name}. They open it and choose a new password. Their old password stops working once they do.`),
    input,
    h('p', { class: 'muted small', style: { margin: 0 } }, 'The link works once and expires in 7 days. You can always get a fresh one from Staff accounts.'),
  ], [
    h('a', { class: 'btn left', href: `mailto:${encodeURIComponent(user.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}` }, 'Open in email'),
    h('button', { onclick: () => copy(message, 'Message') }, 'Copy message'),
    h('button', { class: 'primary', onclick: () => copy(url, 'Link') }, 'Copy link'),
  ], { narrow: true });
}

function openUserModal(user) {
  const isNew = !user;
  const u = user || { name: '', email: '', role: 'staff', active: true };
  const isMe = user && user.id === state.config.me.id;
  const err = h('div', { class: 'error hidden' });
  const pwInput = h('input', { name: 'password', type: 'text', autocomplete: 'off' });
  const pwField = h('label', { class: 'field' + (isNew ? ' hidden' : '') }, isNew ? 'Password' : 'Set a new password (leave blank to keep the current one)', pwInput);
  const method = isNew ? h('div', { class: 'field' },
    'How will they get their password?',
    h('label', { class: 'check', style: { fontWeight: 400 } },
      h('input', { type: 'radio', name: 'method', value: 'link', checked: true, onchange: () => pwField.classList.add('hidden') }),
      'Send them a link to choose their own (recommended)'),
    h('label', { class: 'check', style: { fontWeight: 400 } },
      h('input', { type: 'radio', name: 'method', value: 'password', onchange: () => { pwField.classList.remove('hidden'); pwInput.focus(); } }),
      'I’ll set a password for them now')) : null;
  const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    h('label', { class: 'field' }, 'Name', h('input', { name: 'name', value: u.name, required: true })),
    h('label', { class: 'field' }, 'Email (used to sign in)', h('input', { name: 'email', type: 'email', value: u.email, required: true })),
    h('label', { class: 'field' }, 'Role', h('select', { name: 'role', disabled: isMe },
      h('option', { value: 'staff', selected: u.role === 'staff' }, 'Wedding staff: can add and update enquiries'),
      h('option', { value: 'admin', selected: u.role === 'admin' }, 'Admin: can also change settings and accounts'))),
    method,
    pwField,
    isNew || isMe ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: u.active }), 'Account active (untick to block sign-in)'),
    err);
  const save = async () => {
    err.classList.add('hidden');
    const body = { name: form.name.value, email: form.email.value, role: form.role.value };
    const setPassword = !isNew || form.querySelector('input[name=method]:checked').value === 'password';
    if (setPassword && pwInput.value) body.password = pwInput.value;
    if (isNew && setPassword && !pwInput.value) {
      err.textContent = 'Enter a password, or choose to send them a link instead.';
      return err.classList.remove('hidden');
    }
    if (form.active) body.active = form.active.checked;
    try {
      const result = await api(isNew ? 'admin/users' : `admin/users/${u.id}`, { method: isNew ? 'POST' : 'PUT', body });
      closeModal();
      await refreshConfig();
      renderApp();
      if (result.inviteUrl) showLinkModal({ name: body.name, email: body.email }, result.inviteUrl, true);
      else toast(isNew ? 'Account created' : 'Account updated');
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  modal(isNew ? 'Add account' : `Edit ${u.name}`, form,
    [h('button', { onclick: closeModal }, 'Cancel'), h('button', { class: 'primary', onclick: save }, isNew ? 'Create account' : 'Save')], { narrow: true });
}

function adminGeneral() {
  const input = h('input', { value: state.config.appName });
  return [
    h('div', { class: 'head' }, h('h2', {}, 'General')),
    h('label', { class: 'field', style: { maxWidth: '400px' } }, 'App / venue name', input),
    h('div', { style: { marginTop: '14px' } },
      h('button', { class: 'primary', onclick: () => adminAction(() => api('admin/settings', { method: 'PUT', body: { appName: input.value } }), 'Saved') }, 'Save')),
  ];
}

// Opening an invite link in a tab that already has the app open only changes the #hash.
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).get('invite')) boot();
});

boot();
