// Wedding Enquiry Tracker — Cloudflare Worker API backed by D1.
// Static frontend lives in /public and is served by Workers Static Assets.

import schemaSql from '../migrations/0001_init.sql';

const SESSION_COOKIE = 'wet_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000; // Workers' maximum for PBKDF2
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'date', 'select', 'checkbox', 'duration'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      await ensureSchema(env.DB);
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Schema: created automatically the first time the app runs against an empty database.

let schemaReady = null;

function ensureSchema(db) {
  schemaReady ??= (async () => {
    const exists = await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").first();
    if (exists) return;
    const statements = schemaSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((sql) => sql.replace(/\s+--[^'\n]*$/gm, '').trim())
      .filter(Boolean)
      .map((sql) => db.prepare(sql));
    await db.batch(statements);
  })().catch((err) => {
    schemaReady = null; // retry on the next request
    throw err;
  });
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Routing

async function route(request, env, url) {
  const method = request.method;
  const parts = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '').split('/');
  const db = env.DB;

  // Mutating requests must be JSON — together with SameSite cookies this blocks CSRF.
  if (method !== 'GET' && method !== 'HEAD') {
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/json')) throw new HttpError(415, 'Expected JSON body.');
  }

  // Public routes
  if (parts[0] === 'setup' && parts.length === 1) {
    if (method === 'GET') return json({ needsSetup: await userCount(db) === 0, appName: await getAppName(db) });
    if (method === 'POST') return setup(request, db);
  }
  if (parts[0] === 'login' && method === 'POST') return login(request, db);
  if (parts[0] === 'logout' && method === 'POST') return logout(request, db);

  // Everything else needs a signed-in user
  const user = await currentUser(request, db);
  if (!user) throw new HttpError(401, 'Please sign in.');

  if (parts[0] === 'me') {
    if (parts.length === 1 && method === 'GET') return json({ user: publicUser(user) });
    if (parts[1] === 'password' && method === 'PUT') return changeOwnPassword(request, db, user);
  }

  if (parts[0] === 'config' && method === 'GET') return json(await loadConfig(db, user));

  if (parts[0] === 'enquiries') {
    const id = parts[1] ? toId(parts[1]) : null;
    if (!id) {
      if (method === 'GET') return listEnquiries(db);
      if (method === 'POST') return createEnquiry(request, db, user);
    } else if (parts.length === 2) {
      if (method === 'GET') return getEnquiry(db, id);
      if (method === 'PUT') return updateEnquiry(request, db, user, id, false);
      if (method === 'PATCH') return updateEnquiry(request, db, user, id, true);
      if (method === 'DELETE') {
        requireAdmin(user);
        return deleteEnquiry(db, id);
      }
    } else if (parts[2] === 'activity' && method === 'GET') {
      return listActivity(db, id);
    } else if (parts[2] === 'notes' && method === 'POST') {
      return addNote(request, db, user, id);
    }
  }

  if (parts[0] === 'admin') {
    requireAdmin(user);
    const [, resource, sub] = parts;
    const id = sub && sub !== 'order' ? toId(sub) : null;

    if (resource === 'settings' && method === 'PUT') return updateSettings(request, db);

    if (resource === 'fields') {
      if (sub === 'order' && method === 'PUT') return reorder(request, db, 'fields');
      if (!sub && method === 'POST') return createField(request, db);
      if (id && method === 'PUT') return updateField(request, db, id);
      if (id && method === 'DELETE') return archiveField(db, id);
    }

    if (resource === 'stages') {
      if (sub === 'order' && method === 'PUT') return reorder(request, db, 'stages');
      if (!sub && method === 'POST') return createStage(request, db);
      if (id && method === 'PUT') return updateStage(request, db, id);
      if (id && method === 'DELETE') return deleteStage(db, id, url);
    }

    if (resource === 'users') {
      if (!sub && method === 'GET') return listUsers(db);
      if (!sub && method === 'POST') return createUser(request, db);
      if (id && method === 'PUT') return updateUser(request, db, user, id);
    }
  }

  throw new HttpError(404, 'Not found.');
}

// ---------------------------------------------------------------------------
// Helpers

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

function toId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found.');
  return n;
}

function str(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function requireAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only admins can do that.');
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active };
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function userCount(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row.n;
}

async function getAppName(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'app_name'").first();
  return row ? row.value : 'Wedding Enquiries';
}

// ---------------------------------------------------------------------------
// Passwords & sessions

const enc = new TextEncoder();

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const actual = await pbkdf2(password, unb64(salt), Number(iter));
  const expected = unb64(hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  if (password.length > 200) throw new HttpError(400, 'Password is too long.');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return b64(new Uint8Array(digest));
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

async function startSession(db, userId) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = b64(raw).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256(token), userId, now + SESSION_TTL_MS),
  ]);
  return sessionCookie(token, SESSION_TTL_MS / 1000);
}

async function currentUser(request, db) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
    )
    .bind(await sha256(token), Date.now())
    .first();
  return row || null;
}

async function setup(request, db) {
  if ((await userCount(db)) > 0) throw new HttpError(409, 'Setup has already been completed.');
  const body = await readJson(request);
  const name = str(body.name, 100);
  const email = str(body.email, 200).toLowerCase();
  if (!name || !email.includes('@')) throw new HttpError(400, 'Name and a valid email are required.');
  validatePassword(body.password);
  const result = await db
    .prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)")
    .bind(email, name, await hashPassword(body.password))
    .run();
  const cookie = await startSession(db, result.meta.last_row_id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

async function login(request, db) {
  const body = await readJson(request);
  const email = str(body.email, 200).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const genericError = new HttpError(401, 'Incorrect email or password.');

  if (!user || !user.active) {
    // Spend comparable time so response timing doesn't reveal which emails exist.
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
    throw genericError;
  }
  if (user.locked_until && user.locked_until > Date.now()) {
    throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    const failed = user.failed_logins + 1;
    const lockedUntil = failed >= MAX_FAILED_LOGINS ? Date.now() + LOCKOUT_MS : null;
    await db
      .prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
      .bind(lockedUntil ? 0 : failed, lockedUntil, user.id)
      .run();
    throw genericError;
  }
  await db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(user.id).run();
  const cookie = await startSession(db, user.id);
  return json({ user: publicUser(user) }, 200, { 'set-cookie': cookie });
}

async function logout(request, db) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

async function changeOwnPassword(request, db, user) {
  const body = await readJson(request);
  if (!(await verifyPassword(String(body.current || ''), user.password_hash))) {
    throw new HttpError(400, 'Your current password is incorrect.');
  }
  validatePassword(body.password);
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(body.password), user.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  const cookie = await startSession(db, user.id);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

// ---------------------------------------------------------------------------
// Config (fields, stages, users for assignment)

function rowToField(row) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    options: parseJson(row.options, []),
    config: parseJson(row.config, {}),
    section: row.section,
    required: !!row.required,
    show_in_list: !!row.show_in_list,
    position: row.position,
    archived: !!row.archived,
  };
}

function rowToStage(row) {
  return { id: row.id, name: row.name, color: row.color, position: row.position, is_won: !!row.is_won, is_lost: !!row.is_lost };
}

async function loadFields(db, includeArchived = false) {
  const sql = includeArchived
    ? 'SELECT * FROM fields ORDER BY archived, position, id'
    : 'SELECT * FROM fields WHERE archived = 0 ORDER BY position, id';
  const { results } = await db.prepare(sql).all();
  return results.map(rowToField);
}

async function loadStages(db) {
  const { results } = await db.prepare('SELECT * FROM stages ORDER BY position, id').all();
  return results.map(rowToStage);
}

async function loadConfig(db, user) {
  const [fields, stages, users, appName] = await Promise.all([
    loadFields(db, user.role === 'admin'),
    loadStages(db),
    db.prepare('SELECT id, name, email, role, active FROM users ORDER BY name').all(),
    getAppName(db),
  ]);
  return { appName, fields, stages, users: users.results.map(publicUser), me: publicUser(user) };
}

async function updateSettings(request, db) {
  const body = await readJson(request);
  const appName = str(body.appName, 80);
  if (!appName) throw new HttpError(400, 'Name cannot be empty.');
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('app_name', ?)").bind(appName).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Enquiries

const ENQUIRY_SELECT = `
  SELECT e.*, cu.name AS created_by_name, uu.name AS updated_by_name
  FROM enquiries e
  LEFT JOIN users cu ON cu.id = e.created_by
  LEFT JOIN users uu ON uu.id = e.updated_by`;

function rowToEnquiry(row) {
  return {
    id: row.id,
    stage_id: row.stage_id,
    assigned_to: row.assigned_to,
    data: parseJson(row.data, {}),
    created_by_name: row.created_by_name,
    updated_by_name: row.updated_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listEnquiries(db) {
  const { results } = await db.prepare(`${ENQUIRY_SELECT} ORDER BY e.created_at DESC, e.id DESC`).all();
  return json({ enquiries: results.map(rowToEnquiry) });
}

async function fetchEnquiry(db, id) {
  const row = await db.prepare(`${ENQUIRY_SELECT} WHERE e.id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Enquiry not found.');
  return rowToEnquiry(row);
}

async function getEnquiry(db, id) {
  return json({ enquiry: await fetchEnquiry(db, id) });
}

// Coerce one submitted value to the shape its field type expects.
function cleanValue(field, value) {
  if (value === undefined || value === null || value === '') return null;
  switch (field.type) {
    case 'checkbox':
      return value === true || value === 'true' || value === 1;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new HttpError(400, `"${field.label}" must be a number.`);
      return n;
    }
    case 'date': {
      const s = String(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `"${field.label}" must be a date.`);
      return s;
    }
    case 'select': {
      const s = str(value, 200);
      if (field.options.length && !field.options.includes(s)) {
        throw new HttpError(400, `"${s}" is not an option for "${field.label}".`);
      }
      return s;
    }
    case 'textarea':
      return str(value, 10000) || null;
    case 'duration':
      return null; // computed in the browser from two date fields
    default:
      return str(value, 500) || null;
  }
}

function isEmpty(value) {
  return value === null || value === undefined || value === '' || value === false;
}

// Merge submitted data into existing data. Values for archived fields are kept untouched.
function mergeData(fields, existing, incoming, partial) {
  const data = { ...existing };
  for (const field of fields) {
    if (field.type === 'duration') continue;
    if (partial && !(field.key in incoming)) continue;
    const value = cleanValue(field, incoming[field.key]);
    if (value === null) delete data[field.key];
    else data[field.key] = value;
  }
  for (const field of fields) {
    if (field.required && isEmpty(data[field.key])) throw new HttpError(400, `"${field.label}" is required.`);
  }
  return data;
}

async function resolveStage(db, stageId) {
  if (stageId === null || stageId === undefined || stageId === '') return null;
  const row = await db.prepare('SELECT id FROM stages WHERE id = ?').bind(Number(stageId)).first();
  if (!row) throw new HttpError(400, 'Unknown stage.');
  return row.id;
}

async function resolveAssignee(db, userId) {
  if (userId === null || userId === undefined || userId === '') return null;
  const row = await db.prepare('SELECT id FROM users WHERE id = ?').bind(Number(userId)).first();
  if (!row) throw new HttpError(400, 'Unknown staff member.');
  return row.id;
}

async function createEnquiry(request, db, user) {
  const body = await readJson(request);
  const fields = await loadFields(db);
  const data = mergeData(fields, {}, body.data || {}, false);
  let stageId = await resolveStage(db, body.stage_id);
  if (stageId === null) {
    const first = await db.prepare('SELECT id FROM stages ORDER BY position, id LIMIT 1').first();
    stageId = first ? first.id : null;
  }
  const assignee = await resolveAssignee(db, body.assigned_to);
  const result = await db
    .prepare('INSERT INTO enquiries (stage_id, data, assigned_to, created_by, updated_by) VALUES (?, ?, ?, ?, ?)')
    .bind(stageId, JSON.stringify(data), assignee, user.id, user.id)
    .run();
  const id = result.meta.last_row_id;
  await logActivity(db, id, user.id, 'created', 'Enquiry created');
  return json({ enquiry: await fetchEnquiry(db, id) }, 201);
}

function formatForLog(field, value) {
  if (value === undefined || value === null || value === '') return '(blank)';
  if (field.type === 'checkbox') return value ? 'ticked' : 'unticked';
  return String(value).length > 60 ? String(value).slice(0, 57) + '…' : String(value);
}

async function updateEnquiry(request, db, user, id, partial) {
  const body = await readJson(request);
  const existing = await fetchEnquiry(db, id);
  const fields = await loadFields(db);
  const data = body.data ? mergeData(fields, existing.data, body.data, partial) : existing.data;
  const stageId = 'stage_id' in body ? await resolveStage(db, body.stage_id) : existing.stage_id;
  const assignee = 'assigned_to' in body ? await resolveAssignee(db, body.assigned_to) : existing.assigned_to;

  const changes = [];
  for (const field of fields) {
    if (field.type === 'duration') continue;
    const before = existing.data[field.key];
    const after = data[field.key];
    if ((before ?? null) !== (after ?? null) && !(isEmpty(before) && isEmpty(after))) {
      changes.push(`${field.label}: ${formatForLog(field, before)} → ${formatForLog(field, after)}`);
    }
  }
  if (stageId !== existing.stage_id) {
    const names = Object.fromEntries((await loadStages(db)).map((s) => [s.id, s.name]));
    changes.push(`Stage: ${names[existing.stage_id] || '(none)'} → ${names[stageId] || '(none)'}`);
  }
  if (assignee !== existing.assigned_to) {
    const row = assignee ? await db.prepare('SELECT name FROM users WHERE id = ?').bind(assignee).first() : null;
    changes.push(`Assigned to: ${row ? row.name : '(nobody)'}`);
  }

  if (changes.length) {
    await db
      .prepare(
        "UPDATE enquiries SET data = ?, stage_id = ?, assigned_to = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(JSON.stringify(data), stageId, assignee, user.id, id)
      .run();
    await logActivity(db, id, user.id, 'updated', changes.join('\n'));
  }
  return json({ enquiry: await fetchEnquiry(db, id) });
}

async function deleteEnquiry(db, id) {
  await db.batch([
    db.prepare('DELETE FROM activity WHERE enquiry_id = ?').bind(id),
    db.prepare('DELETE FROM enquiries WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function logActivity(db, enquiryId, userId, kind, message) {
  await db
    .prepare('INSERT INTO activity (enquiry_id, user_id, kind, message) VALUES (?, ?, ?, ?)')
    .bind(enquiryId, userId, kind, message)
    .run();
}

async function listActivity(db, id) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.kind, a.message, a.created_at, u.name AS user_name
       FROM activity a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.enquiry_id = ? ORDER BY a.created_at DESC, a.id DESC`
    )
    .bind(id)
    .all();
  return json({ activity: results });
}

async function addNote(request, db, user, id) {
  await fetchEnquiry(db, id);
  const body = await readJson(request);
  const message = str(body.message, 5000);
  if (!message) throw new HttpError(400, 'Note cannot be empty.');
  await logActivity(db, id, user.id, 'note', message);
  return listActivity(db, id);
}

// ---------------------------------------------------------------------------
// Admin: fields

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'field'
  );
}

function cleanFieldInput(body, existing = {}) {
  const label = str(body.label ?? existing.label, 100);
  if (!label) throw new HttpError(400, 'Field label is required.');
  const type = body.type ?? existing.type;
  if (!FIELD_TYPES.includes(type)) throw new HttpError(400, 'Unknown field type.');

  let options = [];
  if (type === 'select') {
    const raw = Array.isArray(body.options) ? body.options : existing.options || [];
    options = [...new Set(raw.map((o) => str(o, 200)).filter(Boolean))];
    if (!options.length) throw new HttpError(400, 'Dropdown fields need at least one option.');
  }

  let config = {};
  if (type === 'duration') {
    const cfg = body.config || existing.config || {};
    if (!cfg.from || !cfg.to) throw new HttpError(400, 'Choose the two date fields to measure between.');
    config = { from: str(cfg.from, 60), to: str(cfg.to, 60) };
  }

  return {
    label,
    type,
    options: JSON.stringify(options),
    config: JSON.stringify(config),
    section: str(body.section ?? existing.section, 60) || 'Details',
    required: (body.required ?? existing.required) ? 1 : 0,
    show_in_list: (body.show_in_list ?? existing.show_in_list) ? 1 : 0,
  };
}

async function createField(request, db) {
  const body = await readJson(request);
  const f = cleanFieldInput(body);
  const base = slugify(f.label);
  let key = base;
  for (let i = 2; await db.prepare('SELECT 1 FROM fields WHERE key = ?').bind(key).first(); i++) key = `${base}_${i}`;
  const max = await db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM fields').first();
  await db
    .prepare(
      `INSERT INTO fields (key, label, type, options, config, section, required, show_in_list, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(key, f.label, f.type, f.options, f.config, f.section, f.required, f.show_in_list, max.p + 1)
    .run();
  return json({ fields: await loadFields(db, true) }, 201);
}

async function updateField(request, db, id) {
  const body = await readJson(request);
  const row = await db.prepare('SELECT * FROM fields WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Field not found.');
  const f = cleanFieldInput(body, rowToField(row));
  const archived = 'archived' in body ? (body.archived ? 1 : 0) : row.archived;
  await db
    .prepare(
      `UPDATE fields SET label = ?, type = ?, options = ?, config = ?, section = ?, required = ?, show_in_list = ?, archived = ?
       WHERE id = ?`
    )
    .bind(f.label, f.type, f.options, f.config, f.section, f.required, f.show_in_list, archived, id)
    .run();
  return json({ fields: await loadFields(db, true) });
}

// Fields are archived rather than deleted so historical answers are never lost.
async function archiveField(db, id) {
  await db.prepare('UPDATE fields SET archived = 1 WHERE id = ?').bind(id).run();
  return json({ fields: await loadFields(db, true) });
}

async function reorder(request, db, table) {
  const body = await readJson(request);
  if (!Array.isArray(body.ids)) throw new HttpError(400, 'Expected a list of ids.');
  const statements = body.ids.map((id, i) =>
    db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).bind(i + 1, Number(id))
  );
  if (statements.length) await db.batch(statements);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin: stages

function cleanStageInput(body, existing = {}) {
  const name = str(body.name ?? existing.name, 60);
  if (!name) throw new HttpError(400, 'Stage name is required.');
  const color = str(body.color ?? existing.color, 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'Colour must look like #aabbcc.');
  return {
    name,
    color,
    is_won: (body.is_won ?? existing.is_won) ? 1 : 0,
    is_lost: (body.is_lost ?? existing.is_lost) ? 1 : 0,
  };
}

async function createStage(request, db) {
  const s = cleanStageInput(await readJson(request));
  const max = await db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM stages').first();
  await db
    .prepare('INSERT INTO stages (name, color, position, is_won, is_lost) VALUES (?, ?, ?, ?, ?)')
    .bind(s.name, s.color, max.p + 1, s.is_won, s.is_lost)
    .run();
  return json({ stages: await loadStages(db) }, 201);
}

async function updateStage(request, db, id) {
  const row = await db.prepare('SELECT * FROM stages WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Stage not found.');
  const s = cleanStageInput(await readJson(request), rowToStage(row));
  await db
    .prepare('UPDATE stages SET name = ?, color = ?, is_won = ?, is_lost = ? WHERE id = ?')
    .bind(s.name, s.color, s.is_won, s.is_lost, id)
    .run();
  return json({ stages: await loadStages(db) });
}

async function deleteStage(db, id, url) {
  const used = await db.prepare('SELECT COUNT(*) AS n FROM enquiries WHERE stage_id = ?').bind(id).first();
  const moveTo = url.searchParams.get('move_to');
  if (used.n > 0) {
    if (!moveTo) throw new HttpError(409, `${used.n} enquiries are in this stage. Choose where to move them.`);
    const target = await resolveStage(db, moveTo);
    if (target === id) throw new HttpError(400, 'Choose a different stage to move enquiries to.');
    await db.prepare('UPDATE enquiries SET stage_id = ? WHERE stage_id = ?').bind(target, id).run();
  }
  await db.prepare('DELETE FROM stages WHERE id = ?').bind(id).run();
  return json({ stages: await loadStages(db) });
}

// ---------------------------------------------------------------------------
// Admin: users

async function listUsers(db) {
  const { results } = await db.prepare('SELECT * FROM users ORDER BY active DESC, name').all();
  return json({ users: results.map(publicUser) });
}

async function createUser(request, db) {
  const body = await readJson(request);
  const name = str(body.name, 100);
  const email = str(body.email, 200).toLowerCase();
  const role = body.role === 'admin' ? 'admin' : 'staff';
  if (!name || !email.includes('@')) throw new HttpError(400, 'Name and a valid email are required.');
  validatePassword(body.password);
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'Someone already has an account with that email.');
  }
  await db
    .prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)')
    .bind(email, name, role, await hashPassword(body.password))
    .run();
  return listUsers(db);
}

async function updateUser(request, db, me, id) {
  const body = await readJson(request);
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'User not found.');

  const name = str(body.name ?? row.name, 100);
  const email = str(body.email ?? row.email, 200).toLowerCase();
  const role = (body.role ?? row.role) === 'admin' ? 'admin' : 'staff';
  const active = 'active' in body ? (body.active ? 1 : 0) : row.active;
  if (!name || !email.includes('@')) throw new HttpError(400, 'Name and a valid email are required.');

  if (id === me.id && (role !== 'admin' || !active)) {
    throw new HttpError(400, "You can't remove your own admin access or deactivate yourself.");
  }
  if (email !== row.email && (await db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').bind(email, id).first())) {
    throw new HttpError(409, 'Someone already has an account with that email.');
  }

  const statements = [
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, active = ? WHERE id = ?').bind(name, email, role, active, id),
  ];
  if (body.password) {
    validatePassword(body.password);
    statements.push(
      db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?')
        .bind(await hashPassword(body.password), id)
    );
  }
  // Sign the user out everywhere when they lose access or get a new password.
  if (body.password || !active || role !== row.role) {
    statements.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  await db.batch(statements);
  return listUsers(db);
}
