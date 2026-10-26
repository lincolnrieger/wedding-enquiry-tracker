-- Safe to run more than once: the Worker runs this automatically on first use.

-- Users: admins can manage workflow + users, staff can manage enquiries.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Pipeline stages (fully editable by admins).
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8a9a8b',
  position INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  is_lost INTEGER NOT NULL DEFAULT 0
);

-- Custom fields shown on the enquiry form (fully editable by admins).
-- type: text | textarea | email | phone | number | date | select | checkbox | duration
-- options: JSON array of choices for select fields
-- config: JSON, e.g. {"from":"date_of_enquiry","to":"booking_confirmed"} for duration fields
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  config TEXT NOT NULL DEFAULT '{}',
  section TEXT NOT NULL DEFAULT 'Details',
  required INTEGER NOT NULL DEFAULT 0,
  show_in_list INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_id INTEGER REFERENCES stages(id) ON DELETE SET NULL,
  data TEXT NOT NULL DEFAULT '{}',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enquiries_stage ON enquiries(stage_id);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, -- created | updated | note
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_enquiry ON activity(enquiry_id);

-- Default workflow, based on the original "Tracked Wedding Conversion Summary" spreadsheet.
INSERT OR IGNORE INTO stages (id, name, color, position, is_won, is_lost) VALUES
  (1, 'New enquiry',     '#c9a227', 1, 0, 0),
  (2, 'Responded',       '#7a9cc6', 2, 0, 0),
  (3, 'Tour booked',     '#9b7ec8', 3, 0, 0),
  (4, 'Toured',          '#d08c60', 4, 0, 0),
  (5, 'Booked',          '#5f9e6e', 5, 1, 0),
  (6, 'Lost / declined', '#b05a5a', 6, 0, 1);

INSERT OR IGNORE INTO fields (key, label, type, options, config, section, required, show_in_list, position) VALUES
  ('name',              'Couple name(s)',           'text',     '[]', '{}', 'Contact',  1, 1, 1),
  ('email',             'Email',                    'email',    '[]', '{}', 'Contact',  0, 1, 2),
  ('phone',             'Phone',                    'phone',    '[]', '{}', 'Contact',  0, 0, 3),
  ('date_of_enquiry',   'Date of enquiry',          'date',     '[]', '{}', 'Enquiry',  1, 1, 4),
  ('date_of_response',  'Date of response',         'date',     '[]', '{}', 'Enquiry',  0, 0, 5),
  ('enquiry_source',    'Enquiry source',           'select',
     '["Website","Instagram","Facebook","Easy Weddings","Referral","Wedding expo","Phone","Walk-in","Other"]',
     '{}', 'Enquiry', 0, 1, 6),
  ('proposed_date',     'Proposed date / season',   'text',     '[]', '{}', 'Wedding',  0, 1, 7),
  ('guest_numbers',     'Approx. guest numbers',    'number',   '[]', '{}', 'Wedding',  0, 1, 8),
  ('responded',         'Initial response sent',    'checkbox', '[]', '{}', 'Progress', 0, 0, 9),
  ('tour_confirmed',    'Confirmed tour',           'date',     '[]', '{}', 'Progress', 0, 0, 10),
  ('tour_date',         'Tour date',                'date',     '[]', '{}', 'Progress', 0, 1, 11),
  ('tour_type',         'Tour type',                'select',   '["Personalised","Open day","Virtual"]', '{}', 'Progress', 0, 0, 12),
  ('amendments',        'Amendments',               'text',     '[]', '{}', 'Progress', 0, 0, 13),
  ('booking_confirmed', 'Booking confirmed (date)', 'date',     '[]', '{}', 'Booking',  0, 0, 14),
  ('days_to_confirm',   'Days to confirm',          'duration', '[]',
     '{"from":"date_of_enquiry","to":"booking_confirmed"}', 'Booking', 0, 1, 15),
  ('wedding_date',      'Wedding date',             'date',     '[]', '{}', 'Booking',  0, 1, 16),
  ('deposit_paid',      'Deposit paid',             'checkbox', '[]', '{}', 'Booking',  0, 0, 17),
  ('comments',          'Comments',                 'textarea', '[]', '{}', 'Notes',    0, 0, 18);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', 'Wedding Enquiries');
