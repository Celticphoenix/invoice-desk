-- Reference migration for Invoice Desk Stage 1.
-- src/core.js applies this schema automatically to the local SQLite database.
CREATE TABLE business_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, email TEXT NOT NULL,
  address TEXT NOT NULL, gst_number TEXT NOT NULL DEFAULT '', qst_number TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL, accountant_email TEXT NOT NULL,
  payment_instructions TEXT NOT NULL, paypal_fallback_url TEXT NOT NULL,
  etransfer_email TEXT NOT NULL DEFAULT '',
  invoice_prefix TEXT NOT NULL, next_invoice_number INTEGER NOT NULL CHECK(next_invoice_number > 0)
);
CREATE TABLE clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, company TEXT NOT NULL,
  address TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE services (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  category TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  rate_minor INTEGER NOT NULL CHECK(rate_minor >= 0), active INTEGER NOT NULL DEFAULT 1,
  source_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE invoices (
  id TEXT PRIMARY KEY, invoice_number TEXT UNIQUE, client_id TEXT NOT NULL REFERENCES clients(id),
  state TEXT NOT NULL CHECK(state IN ('draft','issued','void')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')), issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
  terms TEXT NOT NULL, notes TEXT NOT NULL, lines_json TEXT NOT NULL, taxes_json TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL, total_minor INTEGER NOT NULL,
  snapshot_json TEXT, pdf_filename TEXT, void_reason TEXT, replaces_invoice_id TEXT REFERENCES invoices(id),
  replaced_by_invoice_id TEXT REFERENCES invoices(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issued_at TEXT
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), payment_date TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('paypal','bank_transfer','stripe','other')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  reference TEXT NOT NULL, notes TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','corrected')),
  correction_of_id TEXT REFERENCES payments(id), created_at TEXT NOT NULL
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  action TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE stripe_sessions (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  url TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','paid','expired')),
  livemode INTEGER NOT NULL CHECK(livemode IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, processed_at TEXT NOT NULL
);
CREATE TABLE gmail_connection (
  id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL,
  refresh_token_cipher TEXT NOT NULL, connected_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('client','accountant')),
  recipient_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','preview','provider_accepted','failed')),
  provider_message_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  accepted_at TEXT, UNIQUE(invoice_id,recipient_type)
);
