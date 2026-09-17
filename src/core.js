import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let cached;

function now() {
  return new Date().toISOString();
}

export function dataRoot() {
  return process.env.INVOICE_DESK_DATA_ROOT
    ? path.resolve(process.env.INVOICE_DESK_DATA_ROOT)
    : path.resolve("data");
}

function database() {
  const file = path.join(dataRoot(), "invoice-desk.sqlite");
  if (cached?.file === file) return cached.db;
  cached?.db.close();
  mkdirSync(dataRoot(), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  migrate(db);
  cached = { file, db };
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS business_settings(
      id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, email TEXT NOT NULL,
      address TEXT NOT NULL, gst_number TEXT NOT NULL DEFAULT '', qst_number TEXT NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL, accountant_email TEXT NOT NULL,
      payment_instructions TEXT NOT NULL, paypal_fallback_url TEXT NOT NULL,
      etransfer_email TEXT NOT NULL DEFAULT '',
      invoice_prefix TEXT NOT NULL, next_invoice_number INTEGER NOT NULL CHECK(next_invoice_number > 0)
    );
    CREATE TABLE IF NOT EXISTS clients(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, company TEXT NOT NULL,
      address TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      source_key TEXT NOT NULL DEFAULT '',
      marketing_status TEXT NOT NULL DEFAULT 'needs_review' CHECK(marketing_status IN ('needs_review','express','implied','unsubscribed')),
      marketing_consent_source TEXT NOT NULL DEFAULT '', marketing_consent_at TEXT,
      marketing_consent_expires_at TEXT, marketing_unsubscribed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      category TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
      rate_minor INTEGER NOT NULL CHECK(rate_minor >= 0), active INTEGER NOT NULL DEFAULT 1,
      pricing_type TEXT NOT NULL DEFAULT 'fixed' CHECK(pricing_type IN ('fixed','percentage')),
      percentage_thousandths INTEGER NOT NULL DEFAULT 0 CHECK(percentage_thousandths BETWEEN 0 AND 100000),
      source_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices(
      id TEXT PRIMARY KEY, invoice_number TEXT UNIQUE, client_id TEXT NOT NULL REFERENCES clients(id),
      state TEXT NOT NULL CHECK(state IN ('draft','issued','void')),
      currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')), issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
      terms TEXT NOT NULL, notes TEXT NOT NULL, lines_json TEXT NOT NULL, taxes_json TEXT NOT NULL,
      subtotal_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL, total_minor INTEGER NOT NULL,
      snapshot_json TEXT, pdf_filename TEXT, void_reason TEXT,
      replaces_invoice_id TEXT REFERENCES invoices(id), replaced_by_invoice_id TEXT REFERENCES invoices(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issued_at TEXT
    );
    CREATE TABLE IF NOT EXISTS payments(
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), payment_date TEXT NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('paypal','bank_transfer','stripe','other')),
      currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), reference TEXT NOT NULL, notes TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','corrected')),
      correction_of_id TEXT REFERENCES payments(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events(
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      action TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stripe_sessions(
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')), url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','paid','expired')),
      livemode INTEGER NOT NULL CHECK(livemode IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stripe_events(
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gmail_connection(
      id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL,
      refresh_token_cipher TEXT NOT NULL, connected_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_outbox(
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
      recipient_type TEXT NOT NULL CHECK(recipient_type IN ('client','accountant')),
      recipient_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','preview','provider_accepted','failed')),
      provider_message_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
      attempt_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      accepted_at TEXT, UNIQUE(invoice_id,recipient_type)
    );
    CREATE TABLE IF NOT EXISTS campaigns(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','sending','sent','partial')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS campaign_recipients(
      campaign_id TEXT NOT NULL REFERENCES campaigns(id), client_id TEXT NOT NULL REFERENCES clients(id),
      recipient_email TEXT NOT NULL, recipient_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','skipped')),
      provider_message_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', sent_at TEXT,
      PRIMARY KEY(campaign_id,client_id)
    );
    CREATE INDEX IF NOT EXISTS invoice_client_idx ON invoices(client_id);
    CREATE INDEX IF NOT EXISTS payment_invoice_idx ON payments(invoice_id);
    CREATE INDEX IF NOT EXISTS stripe_invoice_idx ON stripe_sessions(invoice_id);
    CREATE INDEX IF NOT EXISTS service_name_idx ON services(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS email_invoice_idx ON email_outbox(invoice_id);
    CREATE INDEX IF NOT EXISTS campaign_status_idx ON campaigns(status,created_at);
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES (1, ?)").run(
    now(),
  );
  db.prepare(
    "INSERT OR IGNORE INTO business_settings(id,name,email,address,logo_url,accountant_email,payment_instructions,paypal_fallback_url,invoice_prefix,next_invoice_number) VALUES (1,?,?,?,?,?,?,?,?,?)",
  ).run(
    "Your Management Agency",
    "billing@youragency.com",
    "Add your business address in Settings",
    "",
    "",
    "Payment instructions are provided separately.",
    "",
    "INV-",
    1001,
  );
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=2").get()
  ) {
    const drafts = db
      .prepare(
        "SELECT id, lines_json, taxes_json FROM invoices WHERE state='draft'",
      )
      .all();
    const update = db.prepare(
      "UPDATE invoices SET taxes_json=?,subtotal_minor=?,tax_minor=?,total_minor=?,updated_at=? WHERE id=?",
    );
    for (const draft of drafts) {
      let changed = false;
      const taxes = JSON.parse(draft.taxes_json).flatMap((tax) => {
        const oldRate = tax.rateThousandths ?? tax.rateBasisPoints * 10;
        if (tax.label.toUpperCase() !== "HST" || oldRate !== 13000)
          return [tax];
        changed = true;
        return [
          { label: "GST", rateThousandths: 5000 },
          { label: "QST", rateThousandths: 9975 },
        ];
      });
      if (changed) {
        const amounts = calculate(JSON.parse(draft.lines_json), taxes);
        update.run(
          JSON.stringify(amounts.taxes),
          amounts.subtotalMinor,
          amounts.taxMinor,
          amounts.totalMinor,
          now(),
          draft.id,
        );
      }
    }
    db.prepare("INSERT INTO schema_migrations VALUES (2, ?)").run(now());
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=3").get()
  ) {
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(business_settings)")
        .all()
        .map((row) => row.name),
    );
    if (!columns.has("gst_number"))
      db.exec(
        "ALTER TABLE business_settings ADD COLUMN gst_number TEXT NOT NULL DEFAULT ''",
      );
    if (!columns.has("qst_number"))
      db.exec(
        "ALTER TABLE business_settings ADD COLUMN qst_number TEXT NOT NULL DEFAULT ''",
      );
    const paymentsSql = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'",
      )
      .get().sql;
    if (!paymentsSql.includes("'stripe'")) {
      db.exec(`
        PRAGMA foreign_keys=OFF;
        CREATE TABLE payments_v3(
          id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), payment_date TEXT NOT NULL,
          method TEXT NOT NULL CHECK(method IN ('paypal','bank_transfer','stripe','other')),
          currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
          amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), reference TEXT NOT NULL, notes TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','corrected')),
          correction_of_id TEXT REFERENCES payments_v3(id), created_at TEXT NOT NULL
        );
        INSERT INTO payments_v3 SELECT * FROM payments;
        DROP TABLE payments;
        ALTER TABLE payments_v3 RENAME TO payments;
        CREATE INDEX payment_invoice_idx ON payments(invoice_id);
        PRAGMA foreign_keys=ON;
      `);
    }
    db.prepare("INSERT INTO schema_migrations VALUES (3, ?)").run(now());
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=4").get()
  ) {
    const clientColumns = new Set(
      db
        .prepare("PRAGMA table_info(clients)")
        .all()
        .map((row) => row.name),
    );
    if (!clientColumns.has("phone"))
      db.exec("ALTER TABLE clients ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
    if (!clientColumns.has("notes"))
      db.exec("ALTER TABLE clients ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
    if (!clientColumns.has("source_key"))
      db.exec("ALTER TABLE clients ADD COLUMN source_key TEXT NOT NULL DEFAULT ''");
    db.exec(`
      CREATE TABLE IF NOT EXISTS services(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        category TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
        rate_minor INTEGER NOT NULL CHECK(rate_minor >= 0), active INTEGER NOT NULL DEFAULT 1,
        source_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS service_name_idx ON services(name COLLATE NOCASE);
    `);
    db.prepare("INSERT INTO schema_migrations VALUES (4, ?)").run(now());
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=5").get()
  ) {
    const settingsColumns = new Set(
      db
        .prepare("PRAGMA table_info(business_settings)")
        .all()
        .map((row) => row.name),
    );
    if (!settingsColumns.has("etransfer_email"))
      db.exec(
        "ALTER TABLE business_settings ADD COLUMN etransfer_email TEXT NOT NULL DEFAULT ''",
      );
    db.prepare("INSERT INTO schema_migrations VALUES (5, ?)").run(now());
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=6").get()
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gmail_connection(
        id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL,
        refresh_token_cipher TEXT NOT NULL, connected_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_outbox(
        id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
        recipient_type TEXT NOT NULL CHECK(recipient_type IN ('client','accountant')),
        recipient_email TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','preview','provider_accepted','failed')),
        provider_message_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        accepted_at TEXT, UNIQUE(invoice_id,recipient_type)
      );
      CREATE INDEX IF NOT EXISTS email_invoice_idx ON email_outbox(invoice_id);
    `);
    db.prepare("INSERT INTO schema_migrations VALUES (6, ?)").run(now());
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=7").get()
  ) {
    const clientColumns = new Set(
      db.prepare("PRAGMA table_info(clients)").all().map((row) => row.name),
    );
    if (!clientColumns.has("marketing_status"))
      db.exec("ALTER TABLE clients ADD COLUMN marketing_status TEXT NOT NULL DEFAULT 'needs_review'");
    if (!clientColumns.has("marketing_consent_source"))
      db.exec("ALTER TABLE clients ADD COLUMN marketing_consent_source TEXT NOT NULL DEFAULT ''");
    if (!clientColumns.has("marketing_consent_at"))
      db.exec("ALTER TABLE clients ADD COLUMN marketing_consent_at TEXT");
    if (!clientColumns.has("marketing_consent_expires_at"))
      db.exec("ALTER TABLE clients ADD COLUMN marketing_consent_expires_at TEXT");
    if (!clientColumns.has("marketing_unsubscribed_at"))
      db.exec("ALTER TABLE clients ADD COLUMN marketing_unsubscribed_at TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','sending','sent','partial')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT
      );
      CREATE TABLE IF NOT EXISTS campaign_recipients(
        campaign_id TEXT NOT NULL REFERENCES campaigns(id), client_id TEXT NOT NULL REFERENCES clients(id),
        recipient_email TEXT NOT NULL, recipient_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','skipped')),
        provider_message_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', sent_at TEXT,
        PRIMARY KEY(campaign_id,client_id)
      );
      CREATE INDEX IF NOT EXISTS campaign_status_idx ON campaigns(status,created_at);
    `);
    db.prepare("INSERT INTO schema_migrations VALUES (7, ?)").run(now());
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=8").get()
  ) {
    const serviceColumns = new Set(
      db.prepare("PRAGMA table_info(services)").all().map((row) => row.name),
    );
    if (!serviceColumns.has("pricing_type"))
      db.exec(
        "ALTER TABLE services ADD COLUMN pricing_type TEXT NOT NULL DEFAULT 'fixed' CHECK(pricing_type IN ('fixed','percentage'))",
      );
    if (!serviceColumns.has("percentage_thousandths"))
      db.exec(
        "ALTER TABLE services ADD COLUMN percentage_thousandths INTEGER NOT NULL DEFAULT 0 CHECK(percentage_thousandths BETWEEN 0 AND 100000)",
      );
    db.prepare(
      "UPDATE services SET pricing_type='percentage' WHERE category IN ('Sponsorship','Purse Percentage')",
    ).run();
    db.prepare("INSERT INTO schema_migrations VALUES (8, ?)").run(now());
  }
}

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function text(value, name, maximum = 1000, required = false) {
  if (typeof value !== "string") throw problem(400, `${name} is required`);
  const clean = value.trim();
  if (required && !clean) throw problem(400, `${name} is required`);
  if (clean.length > maximum) throw problem(400, `${name} is too long`);
  return clean;
}

function email(value, name, required = false) {
  const clean = text(value, name, 254, required);
  if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean))
    throw problem(400, `${name} is not a valid email`);
  return clean;
}

function date(value, name) {
  const clean = text(value, name, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean))
    throw problem(400, `${name} is invalid`);
  return clean;
}

function optionalDate(value, name) {
  const clean = text(value ?? "", name, 10);
  if (clean && !/^\d{4}-\d{2}-\d{2}$/.test(clean))
    throw problem(400, `${name} is invalid`);
  return clean || null;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw problem(400, `${name} is invalid`);
  return value;
}

function currency(value) {
  if (value !== "CAD" && value !== "USD")
    throw problem(400, "Currency must be CAD or USD");
  return value;
}

function parseQuantity(value) {
  const clean = text(value, "Quantity", 20, true);
  if (!/^\d{1,7}(?:\.\d{1,4})?$/.test(clean))
    throw problem(
      400,
      "Quantity must be a positive number with up to four decimals",
    );
  const [whole, fraction = ""] = clean.split(".");
  return {
    clean,
    scaled: BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0")),
  };
}

function roundRatio(numerator, denominator) {
  return Number((numerator + denominator / 2n) / denominator);
}

export function calculate(lines, taxes) {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100)
    throw problem(400, "Add at least one service");
  const calculatedLines = lines.map((line) => {
    const pricingType = line.pricingType === "percentage" ? "percentage" : "fixed";
    const quantity = parseQuantity(pricingType === "percentage" ? "1" : line.quantity);
    const percentageBaseMinor =
      pricingType === "percentage"
        ? integer(line.percentageBaseMinor, "Percentage base", 0, 10_000_000_000)
        : 0;
    const percentageThousandths =
      pricingType === "percentage"
        ? integer(line.percentageThousandths, "Percentage", 0, 100000)
        : 0;
    const rateMinor =
      pricingType === "percentage"
        ? roundRatio(
            BigInt(percentageBaseMinor) * BigInt(percentageThousandths),
            100000n,
          )
        : integer(line.rateMinor, "Rate", 0, 10_000_000_000);
    const category = text(
      line.category ?? "Other",
      "Revenue category",
      80,
      true,
    );
    if (
      ![
        "Medical Services",
        "Fighter Management",
        "Sponsorship",
        "Purse Percentage",
        "Services",
        "Products",
        "Consulting",
        "Commission",
        "Other",
      ].includes(category)
    )
      throw problem(400, "Revenue category is invalid");
    const calculated = {
      description: text(line.description, "Service description", 500, true),
      quantity: quantity.clean,
      rateMinor,
      category,
      serviceId: text(line.serviceId ?? "", "Saved service", 100),
      amountMinor: roundRatio(quantity.scaled * BigInt(rateMinor), 10000n),
    };
    if (pricingType === "percentage")
      Object.assign(calculated, {
        pricingType,
        percentageBaseMinor,
        percentageThousandths,
      });
    return calculated;
  });
  if (!Array.isArray(taxes) || taxes.length > 10)
    throw problem(400, "Too many tax lines");
  const subtotalMinor = calculatedLines.reduce(
    (sum, line) => sum + line.amountMinor,
    0,
  );
  const calculatedTaxes = taxes.map((tax) => {
    const rateThousandths = integer(
      tax.rateThousandths ?? tax.rateBasisPoints * 10,
      "Tax rate",
      0,
      100000,
    );
    return {
      label: text(tax.label, "Tax label", 40, true),
      rateThousandths,
      amountMinor: roundRatio(
        BigInt(subtotalMinor) * BigInt(rateThousandths),
        100000n,
      ),
    };
  });
  const taxMinor = calculatedTaxes.reduce(
    (sum, tax) => sum + tax.amountMinor,
    0,
  );
  return {
    lines: calculatedLines,
    taxes: calculatedTaxes,
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
  };
}

function settings(db = database()) {
  const row = db.prepare("SELECT * FROM business_settings WHERE id=1").get();
  return {
    name: row.name,
    email: row.email,
    address: row.address,
    gstNumber: row.gst_number,
    qstNumber: row.qst_number,
    logoUrl: row.logo_url,
    accountantEmail: row.accountant_email,
    paymentInstructions: row.payment_instructions,
    paypalFallbackUrl: row.paypal_fallback_url,
    etransferEmail: row.etransfer_email ?? "",
    invoicePrefix: row.invoice_prefix,
    nextInvoiceNumber: Number(row.next_invoice_number),
  };
}

export function marketingEligibility(client, asOf = new Date().toISOString().slice(0, 10)) {
  if (!client.email) return { eligible: false, reason: "No email address" };
  if (client.marketingStatus === "unsubscribed")
    return { eligible: false, reason: "Unsubscribed" };
  if (client.marketingStatus === "express")
    return { eligible: true, reason: "Express consent recorded" };
  if (client.marketingStatus === "implied") {
    if (!client.marketingConsentExpiresAt)
      return { eligible: false, reason: "Add the implied-consent expiry date" };
    if (client.marketingConsentExpiresAt < asOf)
      return { eligible: false, reason: "Implied consent expired" };
    return { eligible: true, reason: `Implied consent until ${client.marketingConsentExpiresAt}` };
  }
  return { eligible: false, reason: "Marketing permission needs review" };
}

function clientView(row) {
  const client = {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    address: row.address,
    phone: row.phone ?? "",
    notes: row.notes ?? "",
    marketingStatus: row.marketing_status ?? "needs_review",
    marketingConsentSource: row.marketing_consent_source ?? "",
    marketingConsentAt: row.marketing_consent_at ?? "",
    marketingConsentExpiresAt: row.marketing_consent_expires_at ?? "",
    marketingUnsubscribedAt: row.marketing_unsubscribed_at ?? "",
  };
  return { ...client, marketing: marketingEligibility(client) };
}

function serviceView(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    currency: row.currency,
    rateMinor: Number(row.rate_minor),
    pricingType: row.pricing_type ?? "fixed",
    percentageThousandths: Number(row.percentage_thousandths ?? 0),
    active: Boolean(row.active),
  };
}

function invoiceView(row, db = database()) {
  const paid = Number(
    db
      .prepare(
        "SELECT COALESCE(SUM(amount_minor),0) paid FROM payments WHERE invoice_id=? AND status='active'",
      )
      .get(row.id).paid,
  );
  const total = Number(row.total_minor);
  const balance = Math.max(0, total - paid);
  const stripe = db
    .prepare(
      "SELECT id,amount_minor,currency,url,status,livemode FROM stripe_sessions WHERE invoice_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(row.id);
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    clientId: row.client_id,
    clientName: row.client_name ?? "",
    clientEmail: row.client_email ?? "",
    state: row.state,
    paymentStatus:
      paid === 0 ? "unpaid" : balance === 0 ? "paid" : "partially_paid",
    overdue:
      row.state === "issued" &&
      balance > 0 &&
      row.due_date < new Date().toISOString().slice(0, 10),
    currency: row.currency,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    terms: row.terms,
    notes: row.notes,
    lines: JSON.parse(row.lines_json),
    taxes: JSON.parse(row.taxes_json),
    subtotalMinor: Number(row.subtotal_minor),
    taxMinor: Number(row.tax_minor),
    totalMinor: total,
    paymentsMinor: paid,
    balanceMinor: balance,
    voidReason: row.void_reason,
    replacesInvoiceId: row.replaces_invoice_id,
    replacedByInvoiceId: row.replaced_by_invoice_id,
    stripeCheckout: stripe
      ? {
          id: stripe.id,
          amountMinor: Number(stripe.amount_minor),
          currency: stripe.currency,
          url: stripe.url,
          status: stripe.status,
          livemode: Boolean(stripe.livemode),
        }
      : null,
  };
}

function outboxView(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number ?? "",
    recipientType: row.recipient_type,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    bodyText: row.body_text,
    status: row.status,
    providerMessageId: row.provider_message_id,
    lastError: row.last_error,
    attemptCount: Number(row.attempt_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
  };
}

function campaignView(row, db = database()) {
  const recipients = db
    .prepare(
      "SELECT * FROM campaign_recipients WHERE campaign_id=? ORDER BY recipient_name COLLATE NOCASE",
    )
    .all(row.id)
    .map((recipient) => ({
      clientId: recipient.client_id,
      email: recipient.recipient_email,
      name: recipient.recipient_name,
      status: recipient.status,
      providerMessageId: recipient.provider_message_id,
      lastError: recipient.last_error,
      sentAt: recipient.sent_at,
    }));
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    bodyText: row.body_text,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    recipients,
  };
}

function findOutbox(outboxId, db = database()) {
  const id = text(outboxId, "Email", 100, true);
  const row = db
    .prepare(
      "SELECT e.*,i.invoice_number FROM email_outbox e JOIN invoices i ON i.id=e.invoice_id WHERE e.id=?",
    )
    .get(id);
  if (!row) throw problem(404, "Email record not found");
  return row;
}

function findInvoice(id, db = database()) {
  const row = db
    .prepare(
      "SELECT i.*, c.name client_name, c.email client_email FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?",
    )
    .get(id);
  if (!row) throw problem(404, "Invoice not found");
  return invoiceView(row, db);
}

function audit(db, entityType, entityId, action, details) {
  db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?)").run(
    randomUUID(),
    entityType,
    entityId,
    action,
    JSON.stringify(details),
    now(),
  );
}

export function dashboard() {
  const db = database();
  const clients = db
    .prepare("SELECT * FROM clients ORDER BY name COLLATE NOCASE")
    .all()
    .map(clientView);
  const invoices = db
    .prepare(
      "SELECT i.*, c.name client_name, c.email client_email FROM invoices i JOIN clients c ON c.id=i.client_id ORDER BY i.created_at DESC",
    )
    .all()
    .map((row) => invoiceView(row, db));
  const services = db
    .prepare("SELECT * FROM services WHERE active=1 ORDER BY category, name COLLATE NOCASE")
    .all()
    .map(serviceView);
  const payments = db
    .prepare(
      "SELECT p.*, i.invoice_number FROM payments p JOIN invoices i ON i.id=p.invoice_id ORDER BY p.payment_date DESC, p.created_at DESC",
    )
    .all()
    .map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      paymentDate: row.payment_date,
      method: row.method,
      currency: row.currency,
      amountMinor: Number(row.amount_minor),
      reference: row.reference,
      notes: row.notes,
      status: row.status,
      correctionOfId: row.correction_of_id,
    }));
  const emailOutbox = db
    .prepare(
      "SELECT e.*,i.invoice_number FROM email_outbox e JOIN invoices i ON i.id=e.invoice_id ORDER BY e.created_at DESC",
    )
    .all()
    .map(outboxView);
  const campaigns = db
    .prepare("SELECT * FROM campaigns ORDER BY created_at DESC")
    .all()
    .map((row) => campaignView(row, db));
  return { settings: settings(db), clients, services, invoices, payments, emailOutbox, campaigns };
}

export function createClient(input) {
  return saveClient(input);
}

export function saveClient(input, id) {
  const db = database();
  const clientId = id ? text(id, "Client", 100, true) : randomUUID();
  const existing = id
    ? db.prepare("SELECT * FROM clients WHERE id=?").get(clientId)
    : null;
  if (id && !existing) throw problem(404, "Client not found");
  const timestamp = now();
  const value = {
    name: text(input.name, "Client name", 160, true),
    email: email(input.email ?? "", "Client email"),
    company: text(input.company ?? "", "Company", 160),
    address: text(input.address ?? "", "Address", 1000),
    phone: text(input.phone ?? "", "Phone", 80),
    notes: text(input.notes ?? "", "Client notes", 2000),
    marketingStatus: text(
      input.marketingStatus ?? existing?.marketing_status ?? "needs_review",
      "Marketing permission",
      30,
      true,
    ),
    marketingConsentSource: text(
      input.marketingConsentSource ?? existing?.marketing_consent_source ?? "",
      "Permission source",
      500,
    ),
    marketingConsentAt: optionalDate(
      input.marketingConsentAt ?? existing?.marketing_consent_at ?? "",
      "Permission date",
    ),
    marketingConsentExpiresAt: optionalDate(
      input.marketingConsentExpiresAt ?? existing?.marketing_consent_expires_at ?? "",
      "Permission expiry",
    ),
    sourceKey: text(
      input.sourceKey ?? existing?.source_key ?? "",
      "Source key",
      500,
    ),
  };
  if (!["needs_review", "express", "implied", "unsubscribed"].includes(value.marketingStatus))
    throw problem(400, "Marketing permission is invalid");
  if (value.marketingStatus === "express" && !value.marketingConsentSource)
    throw problem(400, "Record how express consent was obtained");
  if (value.marketingStatus === "implied" && !value.marketingConsentExpiresAt)
    throw problem(400, "Add the implied-consent expiry date");
  const unsubscribedAt =
    value.marketingStatus === "unsubscribed"
      ? existing?.marketing_unsubscribed_at ?? timestamp
      : existing?.marketing_unsubscribed_at ?? null;
  if (id) {
    db.prepare(
      `UPDATE clients SET name=?,email=?,company=?,address=?,phone=?,notes=?,source_key=?,
       marketing_status=?,marketing_consent_source=?,marketing_consent_at=?,
       marketing_consent_expires_at=?,marketing_unsubscribed_at=?,updated_at=? WHERE id=?`,
    ).run(
      value.name,
      value.email,
      value.company,
      value.address,
      value.phone,
      value.notes,
      value.sourceKey,
      value.marketingStatus,
      value.marketingConsentSource,
      value.marketingConsentAt,
      value.marketingConsentExpiresAt,
      unsubscribedAt,
      timestamp,
      clientId,
    );
    audit(db, "client", clientId, "updated", { name: value.name });
  } else {
    db.prepare(
      `INSERT INTO clients(id,name,email,company,address,phone,notes,source_key,
       marketing_status,marketing_consent_source,marketing_consent_at,
       marketing_consent_expires_at,marketing_unsubscribed_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      clientId,
      value.name,
      value.email,
      value.company,
      value.address,
      value.phone,
      value.notes,
      value.sourceKey,
      value.marketingStatus,
      value.marketingConsentSource,
      value.marketingConsentAt,
      value.marketingConsentExpiresAt,
      unsubscribedAt,
      timestamp,
      timestamp,
    );
    audit(db, "client", clientId, "created", { name: value.name });
  }
  return { id: clientId, ...value };
}

export function saveService(input, id) {
  const db = database();
  const serviceId = id ? text(id, "Service", 100, true) : randomUUID();
  const existing = id
    ? db.prepare("SELECT * FROM services WHERE id=?").get(serviceId)
    : null;
  if (id && !existing) throw problem(404, "Service not found");
  const timestamp = now();
  const category = text(
    input.category ?? "Other",
    "Revenue category",
    80,
    true,
  );
  const percentageCategory = ["Sponsorship", "Purse Percentage"].includes(
    category,
  );
  const pricingType = percentageCategory ? "percentage" : "fixed";
  const value = {
    name: text(input.name, "Service name", 160, true),
    description: text(input.description ?? input.name, "Description", 500, true),
    category,
    currency: currency(input.currency ?? "CAD"),
    rateMinor:
      pricingType === "fixed"
        ? integer(input.rateMinor, "Rate", 0, 10_000_000_000)
        : 0,
    pricingType,
    percentageThousandths:
      pricingType === "percentage"
        ? integer(
            input.percentageThousandths ?? 0,
            "Percentage",
            0,
            100000,
          )
        : 0,
    sourceKey: text(
      input.sourceKey ?? existing?.source_key ?? "",
      "Source key",
      500,
    ),
  };
  if (
    ![
      "Medical Services",
      "Fighter Management",
      "Sponsorship",
      "Purse Percentage",
      "Services",
      "Products",
      "Consulting",
      "Commission",
      "Other",
    ].includes(value.category)
  )
    throw problem(400, "Revenue category is invalid");
  if (id) {
    db.prepare(
      "UPDATE services SET name=?,description=?,category=?,currency=?,rate_minor=?,pricing_type=?,percentage_thousandths=?,source_key=?,updated_at=? WHERE id=?",
    ).run(
      value.name,
      value.description,
      value.category,
      value.currency,
      value.rateMinor,
      value.pricingType,
      value.percentageThousandths,
      value.sourceKey,
      timestamp,
      serviceId,
    );
    audit(db, "service", serviceId, "updated", { name: value.name });
  } else {
    db.prepare(
      "INSERT INTO services(id,name,description,category,currency,rate_minor,active,pricing_type,percentage_thousandths,source_key,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?)",
    ).run(
      serviceId,
      value.name,
      value.description,
      value.category,
      value.currency,
      value.rateMinor,
      value.pricingType,
      value.percentageThousandths,
      value.sourceKey,
      timestamp,
      timestamp,
    );
    audit(db, "service", serviceId, "created", { name: value.name });
  }
  return serviceView(
    db.prepare("SELECT * FROM services WHERE id=?").get(serviceId),
  );
}

export function saveSettings(input) {
  const value = {
    name: text(input.name, "Business name", 160, true),
    email: email(input.email, "Billing email", true),
    address: text(input.address ?? "", "Business address", 1000),
    gstNumber: text(input.gstNumber ?? "", "GST number", 40),
    qstNumber: text(input.qstNumber ?? "", "QST number", 40),
    logoUrl: text(input.logoUrl ?? "", "Logo URL", 1000),
    accountantEmail: email(input.accountantEmail ?? "", "Accountant email"),
    paymentInstructions: text(
      input.paymentInstructions ?? "",
      "Payment instructions",
      2000,
    ),
    paypalFallbackUrl: text(input.paypalFallbackUrl ?? "", "PayPal link", 1000),
    etransferEmail: email(input.etransferEmail ?? "", "e-Transfer email"),
    invoicePrefix: text(input.invoicePrefix, "Invoice prefix", 12, true),
    nextInvoiceNumber: integer(
      input.nextInvoiceNumber,
      "Next invoice number",
      1,
      9_999_999,
    ),
  };
  if (!/^[A-Z0-9-]+$/.test(value.invoicePrefix))
    throw problem(
      400,
      "Invoice prefix can use capital letters, numbers and hyphens",
    );
  const db = database();
  db.prepare(
    "UPDATE business_settings SET name=?,email=?,address=?,gst_number=?,qst_number=?,logo_url=?,accountant_email=?,payment_instructions=?,paypal_fallback_url=?,etransfer_email=?,invoice_prefix=?,next_invoice_number=? WHERE id=1",
  ).run(
    value.name,
    value.email,
    value.address,
    value.gstNumber,
    value.qstNumber,
    value.logoUrl,
    value.accountantEmail,
    value.paymentInstructions,
    value.paypalFallbackUrl,
    value.etransferEmail,
    value.invoicePrefix,
    value.nextInvoiceNumber,
  );
  audit(db, "business", "1", "settings_updated", {
    invoicePrefix: value.invoicePrefix,
  });
  return value;
}

function validatedDraft(input) {
  const value = {
    clientId: text(input.clientId, "Client", 100, true),
    currency: currency(input.currency),
    issueDate: date(input.issueDate, "Invoice date"),
    dueDate: date(input.dueDate, "Due date"),
    terms: text(input.terms ?? "", "Terms", 2000),
    notes: text(input.notes ?? "", "Notes", 5000),
  };
  if (value.dueDate < value.issueDate)
    throw problem(400, "Due date cannot be before invoice date");
  return { ...value, ...calculate(input.lines, input.taxes ?? []) };
}

export function saveDraft(input, id) {
  const db = database();
  const value = validatedDraft(input);
  if (!db.prepare("SELECT id FROM clients WHERE id=?").get(value.clientId))
    throw problem(400, "Choose a saved client");
  const timestamp = now();
  if (id) {
    const existing = findInvoice(id, db);
    if (existing.state !== "draft")
      throw problem(409, "Issued invoices are frozen and cannot be edited");
    db.prepare(
      "UPDATE invoices SET client_id=?,currency=?,issue_date=?,due_date=?,terms=?,notes=?,lines_json=?,taxes_json=?,subtotal_minor=?,tax_minor=?,total_minor=?,updated_at=? WHERE id=?",
    ).run(
      value.clientId,
      value.currency,
      value.issueDate,
      value.dueDate,
      value.terms,
      value.notes,
      JSON.stringify(value.lines),
      JSON.stringify(value.taxes),
      value.subtotalMinor,
      value.taxMinor,
      value.totalMinor,
      timestamp,
      id,
    );
    audit(db, "invoice", id, "draft_updated", {
      totalMinor: value.totalMinor,
      currency: value.currency,
    });
    return findInvoice(id, db);
  }
  const invoiceId = randomUUID();
  db.prepare(
    "INSERT INTO invoices(id,invoice_number,client_id,state,currency,issue_date,due_date,terms,notes,lines_json,taxes_json,subtotal_minor,tax_minor,total_minor,snapshot_json,pdf_filename,void_reason,replaces_invoice_id,replaced_by_invoice_id,created_at,updated_at,issued_at) VALUES (?,NULL,?,'draft',?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,NULL)",
  ).run(
    invoiceId,
    value.clientId,
    value.currency,
    value.issueDate,
    value.dueDate,
    value.terms,
    value.notes,
    JSON.stringify(value.lines),
    JSON.stringify(value.taxes),
    value.subtotalMinor,
    value.taxMinor,
    value.totalMinor,
    timestamp,
    timestamp,
  );
  audit(db, "invoice", invoiceId, "draft_created", {
    totalMinor: value.totalMinor,
    currency: value.currency,
  });
  return findInvoice(invoiceId, db);
}

export function deleteDraft(invoiceId) {
  const db = database();
  const id = text(invoiceId, "Invoice", 100, true);
  db.exec("BEGIN IMMEDIATE");
  try {
    const invoice = findInvoice(id, db);
    if (invoice.state !== "draft")
      throw problem(409, "Only drafts can be deleted");

    db.prepare(
      "UPDATE invoices SET replaced_by_invoice_id=NULL,updated_at=? WHERE replaced_by_invoice_id=?",
    ).run(now(), id);
    db.prepare("DELETE FROM invoices WHERE id=? AND state='draft'").run(id);
    audit(db, "invoice", id, "draft_deleted", {
      clientId: invoice.clientId,
      currency: invoice.currency,
      totalMinor: invoice.totalMinor,
      replacesInvoiceId: invoice.replacesInvoiceId,
    });
    db.exec("COMMIT");
    return { deleted: true, invoiceId: id };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function pdfEscape(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, "?");
}

function makePdf(snapshot) {
  const money = (minor) => `${snapshot.currency} ${(minor / 100).toFixed(2)}`;
  const rows = [
    { text: snapshot.business.name, size: 20 },
    { text: snapshot.business.email, size: 10 },
    ...snapshot.business.address
      .split("\n")
      .map((text) => ({ text, size: 10 })),
    ...(snapshot.business.gstNumber
      ? [{ text: `GST number: ${snapshot.business.gstNumber}`, size: 9 }]
      : []),
    ...(snapshot.business.qstNumber
      ? [{ text: `QST number: ${snapshot.business.qstNumber}`, size: 9 }]
      : []),
    { text: "", size: 10 },
    { text: "INVOICE", size: 24 },
    { text: `Invoice ${snapshot.invoiceNumber}`, size: 12 },
    {
      text: `Issued ${snapshot.issueDate}  |  Due ${snapshot.dueDate}`,
      size: 11,
    },
    { text: "", size: 10 },
    { text: `Bill to: ${snapshot.client.name}`, size: 13 },
    { text: snapshot.client.company, size: 10 },
    ...snapshot.client.address.split("\n").map((text) => ({ text, size: 10 })),
    { text: "", size: 10 },
    { text: "Services", size: 13 },
    ...snapshot.lines.map((line) => ({
      text:
        line.pricingType === "percentage"
          ? `${line.description}   ${(line.percentageThousandths / 1000).toFixed(3).replace(/\.?0+$/, "")}% of ${money(line.percentageBaseMinor)}   ${money(line.amountMinor)}`
          : `${line.description}   ${line.quantity} x ${money(line.rateMinor)}   ${money(line.amountMinor)}`,
      size: 10,
    })),
    { text: "", size: 10 },
    { text: `Subtotal: ${money(snapshot.subtotalMinor)}`, size: 11 },
    ...snapshot.taxes.map((tax) => ({
      text: `${tax.label} (${(tax.rateThousandths / 1000).toFixed(3).replace(/\.?0+$/, "")}%): ${money(tax.amountMinor)}`,
      size: 10,
    })),
    { text: `TOTAL: ${money(snapshot.totalMinor)}`, size: 15 },
    { text: "", size: 10 },
    { text: `Terms: ${snapshot.terms || "None"}`, size: 10 },
    { text: `Notes: ${snapshot.notes || "None"}`, size: 10 },
    {
      text: `Payment: ${snapshot.business.paymentInstructions || "Contact us for payment instructions."}`,
      size: 10,
    },
    {
      text: "Preferred payment: secure Stripe card link supplied with this invoice.",
      size: 10,
    },
    ...(snapshot.business.etransferEmail
      ? [
          {
            text: `Interac e-Transfer: ${snapshot.business.etransferEmail}`,
            size: 10,
          },
        ]
      : []),
    ...(snapshot.business.paypalFallbackUrl
      ? [{ text: `PayPal: ${snapshot.business.paypalFallbackUrl}`, size: 10 }]
      : []),
  ];
  const wrapped = rows.flatMap((row) => {
    if (!row.text) return [row];
    const limit = row.size >= 20 ? 42 : row.size >= 13 ? 64 : 88;
    const words = row.text.split(/\s+/);
    const lines = [];
    let current = "";
    for (const word of words) {
      if (current && `${current} ${word}`.length > limit) {
        lines.push(current);
        current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    if (current) lines.push(current);
    return (lines.length ? lines : [""]).map((text) => ({ ...row, text }));
  });
  const pages = [];
  for (let index = 0; index < wrapped.length; index += 36)
    pages.push(wrapped.slice(index, index + 36));
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((page, index) => {
    const contentId = 5 + index * 2;
    let y = 755;
    const content = page
      .map((row) => {
        const line = `BT /F1 ${row.size} Tf 54 ${y} Td (${pdfEscape(row.text)}) Tj ET`;
        y -= row.size + 8;
        return line;
      })
      .join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  });
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

export function issueInvoice(id) {
  const db = database();
  let savedPdf;
  let temporaryPdf;
  db.exec("BEGIN IMMEDIATE");
  try {
    const invoice = findInvoice(id, db);
    if (invoice.state !== "draft")
      throw problem(409, "Only a draft can be issued");
    const business = settings(db);
    const client = clientView(
      db.prepare("SELECT * FROM clients WHERE id=?").get(invoice.clientId),
    );
    const amounts = calculate(invoice.lines, invoice.taxes);
    const invoiceNumber = `${business.invoicePrefix}${String(business.nextInvoiceNumber).padStart(5, "0")}`;
    const snapshot = {
      business,
      client,
      invoiceNumber,
      currency: invoice.currency,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      terms: invoice.terms,
      notes: invoice.notes,
      ...amounts,
    };
    const pdfRoot = path.join(dataRoot(), "pdfs");
    mkdirSync(pdfRoot, { recursive: true });
    temporaryPdf = path.join(pdfRoot, `${id}.${randomUUID()}.tmp`);
    savedPdf = path.join(pdfRoot, `${id}.pdf`);
    writeFileSync(temporaryPdf, makePdf(snapshot), { flag: "wx" });
    renameSync(temporaryPdf, savedPdf);
    temporaryPdf = undefined;
    const timestamp = now();
    db.prepare(
      "UPDATE business_settings SET next_invoice_number=next_invoice_number+1 WHERE id=1",
    ).run();
    db.prepare(
      "UPDATE invoices SET invoice_number=?,state='issued',lines_json=?,taxes_json=?,subtotal_minor=?,tax_minor=?,total_minor=?,snapshot_json=?,pdf_filename=?,issued_at=?,updated_at=? WHERE id=?",
    ).run(
      invoiceNumber,
      JSON.stringify(amounts.lines),
      JSON.stringify(amounts.taxes),
      amounts.subtotalMinor,
      amounts.taxMinor,
      amounts.totalMinor,
      JSON.stringify(snapshot),
      `${id}.pdf`,
      timestamp,
      timestamp,
      id,
    );
    audit(db, "invoice", id, "issued", {
      invoiceNumber,
      totalMinor: amounts.totalMinor,
      currency: invoice.currency,
    });
    db.exec("COMMIT");
    return findInvoice(id, db);
  } catch (error) {
    db.exec("ROLLBACK");
    if (savedPdf && existsSync(savedPdf)) unlinkSync(savedPdf);
    if (temporaryPdf && existsSync(temporaryPdf)) unlinkSync(temporaryPdf);
    throw error;
  }
}

export function recordPayment(input) {
  const db = database();
  const value = {
    invoiceId: text(input.invoiceId, "Invoice", 100, true),
    paymentDate: date(input.paymentDate, "Payment date"),
    method: input.method,
    amountMinor: integer(input.amountMinor, "Amount", 1, 10_000_000_000),
    currency: currency(input.currency),
    reference: text(input.reference ?? "", "Reference", 200),
    notes: text(input.notes ?? "", "Notes", 1000),
  };
  if (!["paypal", "bank_transfer", "other"].includes(value.method))
    throw problem(400, "Payment method is invalid");
  const invoice = findInvoice(value.invoiceId, db);
  if (invoice.state !== "issued")
    throw problem(409, "Payments can only be added to issued invoices");
  if (invoice.currency !== value.currency)
    throw problem(400, "Payment currency must match the invoice");
  if (value.amountMinor > invoice.balanceMinor)
    throw problem(400, "Payment is more than the remaining balance");
  const id = randomUUID();
  db.prepare("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    value.invoiceId,
    value.paymentDate,
    value.method,
    value.currency,
    value.amountMinor,
    value.reference,
    value.notes,
    "active",
    null,
    now(),
  );
  audit(db, "payment", id, "recorded", {
    invoiceId: value.invoiceId,
    amountMinor: value.amountMinor,
    currency: value.currency,
  });
  return findInvoice(value.invoiceId, db);
}

export function correctPayment(input) {
  const db = database();
  const paymentId = text(input.paymentId, "Payment", 100, true);
  const amountMinor = integer(input.amountMinor, "Amount", 1, 10_000_000_000);
  db.exec("BEGIN IMMEDIATE");
  try {
    const original = db
      .prepare("SELECT * FROM payments WHERE id=?")
      .get(paymentId);
    if (!original || original.status !== "active")
      throw problem(404, "Active payment not found");
    const invoice = findInvoice(original.invoice_id, db);
    if (amountMinor > invoice.balanceMinor + Number(original.amount_minor))
      throw problem(400, "Corrected payment is more than the invoice balance");
    db.prepare("UPDATE payments SET status='corrected' WHERE id=?").run(
      paymentId,
    );
    const id = randomUUID();
    db.prepare("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      id,
      original.invoice_id,
      original.payment_date,
      original.method,
      original.currency,
      amountMinor,
      text(input.reference ?? "", "Reference", 200),
      text(input.notes ?? "", "Notes", 1000),
      "active",
      paymentId,
      now(),
    );
    audit(db, "payment", id, "corrected", {
      correctionOfId: paymentId,
      oldAmountMinor: original.amount_minor,
      newAmountMinor: amountMinor,
    });
    db.exec("COMMIT");
    return findInvoice(original.invoice_id, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function voidAndReissue(invoiceId, rawReason) {
  const db = database();
  const reason = text(rawReason, "Reason", 1000, true);
  db.exec("BEGIN IMMEDIATE");
  try {
    const original = findInvoice(invoiceId, db);
    if (original.state !== "issued")
      throw problem(409, "Only an issued invoice can be voided");
    if (original.paymentsMinor > 0)
      throw problem(
        409,
        "Paid or partially paid invoices need accountant review",
      );
    const replacementId = randomUUID();
    const timestamp = now();
    db.prepare(
      "INSERT INTO invoices(id,invoice_number,client_id,state,currency,issue_date,due_date,terms,notes,lines_json,taxes_json,subtotal_minor,tax_minor,total_minor,snapshot_json,pdf_filename,void_reason,replaces_invoice_id,replaced_by_invoice_id,created_at,updated_at,issued_at) VALUES (?,NULL,?,'draft',?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,?,NULL)",
    ).run(
      replacementId,
      original.clientId,
      original.currency,
      original.issueDate,
      original.dueDate,
      original.terms,
      original.notes,
      JSON.stringify(
        original.lines.map(({ amountMinor: _amount, ...line }) => line),
      ),
      JSON.stringify(
        original.taxes.map(({ amountMinor: _amount, ...tax }) => tax),
      ),
      original.subtotalMinor,
      original.taxMinor,
      original.totalMinor,
      invoiceId,
      timestamp,
      timestamp,
    );
    db.prepare(
      "UPDATE invoices SET state='void',void_reason=?,replaced_by_invoice_id=?,updated_at=? WHERE id=?",
    ).run(reason, replacementId, timestamp, invoiceId);
    audit(db, "invoice", invoiceId, "voided", { reason, replacementId });
    db.exec("COMMIT");
    return findInvoice(replacementId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function duplicateInvoice(invoiceId) {
  const original = findInvoice(text(invoiceId, "Invoice", 100, true));
  const issueDate = new Date().toISOString().slice(0, 10);
  const due = new Date(`${issueDate}T12:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 30);
  return saveDraft({
    clientId: original.clientId,
    currency: original.currency,
    issueDate,
    dueDate: due.toISOString().slice(0, 10),
    terms: original.terms,
    notes: original.notes,
    lines: original.lines.map(({ amountMinor: _amount, ...line }) => line),
    taxes: original.taxes.map(({ amountMinor: _amount, ...tax }) => tax),
  });
}

export function payableInvoice(invoiceId) {
  return findInvoice(text(invoiceId, "Invoice", 100, true));
}

export function reusableStripeSession(invoiceId) {
  const invoice = payableInvoice(invoiceId);
  const session = database()
    .prepare(
      "SELECT * FROM stripe_sessions WHERE invoice_id=? AND status='open' AND amount_minor=? AND currency=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(invoice.id, invoice.balanceMinor, invoice.currency);
  return session
    ? {
        id: session.id,
        invoiceId: session.invoice_id,
        amountMinor: Number(session.amount_minor),
        currency: session.currency,
        url: session.url,
        status: session.status,
        livemode: Boolean(session.livemode),
      }
    : null;
}

export function saveStripeSession(invoiceId, stripeSession) {
  const db = database();
  const invoice = findInvoice(invoiceId, db);
  if (invoice.state !== "issued" || invoice.balanceMinor < 1)
    throw problem(409, "This invoice has no payable balance");
  const value = {
    id: text(stripeSession.id, "Stripe session", 255, true),
    amountMinor: integer(
      stripeSession.amount_total,
      "Stripe amount",
      1,
      10_000_000_000,
    ),
    currency: currency(String(stripeSession.currency ?? "").toUpperCase()),
    url: text(stripeSession.url, "Stripe payment URL", 3000, true),
    livemode: stripeSession.livemode ? 1 : 0,
  };
  if (value.amountMinor !== invoice.balanceMinor)
    throw problem(409, "Stripe amount does not match the invoice balance");
  if (value.currency !== invoice.currency)
    throw problem(409, "Stripe currency does not match the invoice");
  if (!value.url.startsWith("https://"))
    throw problem(409, "Stripe did not return a secure payment URL");
  const timestamp = now();
  db.prepare("INSERT INTO stripe_sessions VALUES (?,?,?,?,?,'open',?,?,?)").run(
    value.id,
    invoice.id,
    value.amountMinor,
    value.currency,
    value.url,
    value.livemode,
    timestamp,
    timestamp,
  );
  audit(db, "invoice", invoice.id, "stripe_checkout_created", {
    sessionId: value.id,
    amountMinor: value.amountMinor,
    currency: value.currency,
    livemode: Boolean(value.livemode),
  });
  return findInvoice(invoice.id, db);
}

export function stripeSessionsToSync() {
  return database()
    .prepare(
      "SELECT id,invoice_id FROM stripe_sessions WHERE status='open' ORDER BY created_at",
    )
    .all()
    .map((row) => ({ id: row.id, invoiceId: row.invoice_id }));
}

export function updateStripeSessionStatus(sessionId, status) {
  if (!["open", "expired"].includes(status))
    throw problem(400, "Stripe session status is invalid");
  database()
    .prepare("UPDATE stripe_sessions SET status=?,updated_at=? WHERE id=?")
    .run(status, now(), text(sessionId, "Stripe session", 255, true));
}

export function recordStripePayment(input) {
  const db = database();
  const eventId = text(input.eventId, "Stripe event", 255, true);
  const sessionId = text(input.sessionId, "Stripe session", 255, true);
  db.exec("BEGIN IMMEDIATE");
  try {
    const session = db
      .prepare("SELECT * FROM stripe_sessions WHERE id=?")
      .get(sessionId);
    if (!session) throw problem(404, "Stripe session was not found");
    if (input.invoiceId && input.invoiceId !== session.invoice_id)
      throw problem(409, "Stripe invoice reference does not match");
    const invoice = findInvoice(session.invoice_id, db);
    if (db.prepare("SELECT id FROM stripe_events WHERE id=?").get(eventId)) {
      db.exec("COMMIT");
      return invoice;
    }
    const amountMinor = integer(
      input.amountMinor,
      "Stripe amount",
      1,
      10_000_000_000,
    );
    const paidCurrency = currency(String(input.currency ?? "").toUpperCase());
    if (
      amountMinor !== Number(session.amount_minor) ||
      paidCurrency !== session.currency
    )
      throw problem(409, "Stripe payment does not match the saved checkout");
    if (session.status === "paid") {
      db.prepare("INSERT INTO stripe_events VALUES (?,?,?)").run(
        eventId,
        text(input.eventType ?? "sync", "Stripe event type", 100, true),
        now(),
      );
      db.exec("COMMIT");
      return invoice;
    }
    if (invoice.balanceMinor < amountMinor)
      throw problem(
        409,
        "Stripe payment is greater than the current invoice balance; review it manually",
      );
    const paymentId = randomUUID();
    const timestamp = now();
    db.prepare("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      paymentId,
      invoice.id,
      timestamp.slice(0, 10),
      "stripe",
      session.currency,
      amountMinor,
      session.id,
      "Verified Stripe Checkout payment",
      "active",
      null,
      timestamp,
    );
    db.prepare(
      "UPDATE stripe_sessions SET status='paid',updated_at=? WHERE id=?",
    ).run(timestamp, session.id);
    db.prepare("INSERT INTO stripe_events VALUES (?,?,?)").run(
      eventId,
      text(input.eventType ?? "sync", "Stripe event type", 100, true),
      timestamp,
    );
    audit(db, "payment", paymentId, "stripe_payment_recorded", {
      invoiceId: invoice.id,
      sessionId: session.id,
      amountMinor,
      currency: session.currency,
    });
    db.exec("COMMIT");
    return findInvoice(invoice.id, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readPdf(id) {
  const row = database()
    .prepare(
      "SELECT invoice_number,pdf_filename,state FROM invoices WHERE id=?",
    )
    .get(id);
  if (!row?.pdf_filename || row.state === "draft")
    throw problem(404, "Issued PDF not found");
  const file = path.join(dataRoot(), "pdfs", row.pdf_filename);
  if (!existsSync(file))
    throw problem(500, "The saved PDF is missing; restore it from backup");
  return { bytes: readFileSync(file), filename: `${row.invoice_number}.pdf` };
}

export function gmailConnection() {
  const row = database()
    .prepare("SELECT * FROM gmail_connection WHERE id=1")
    .get();
  return row
    ? {
        email: row.email,
        refreshTokenCipher: row.refresh_token_cipher,
        connectedAt: row.connected_at,
      }
    : null;
}

export function saveGmailConnection(input) {
  const db = database();
  const value = {
    email: email(input.email, "Connected Gmail address", true),
    refreshTokenCipher: text(
      input.refreshTokenCipher,
      "Gmail authorization",
      10000,
      true,
    ),
  };
  const timestamp = now();
  db.prepare(
    `INSERT INTO gmail_connection(id,email,refresh_token_cipher,connected_at,updated_at)
     VALUES (1,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET email=excluded.email,
       refresh_token_cipher=excluded.refresh_token_cipher,updated_at=excluded.updated_at`,
  ).run(value.email, value.refreshTokenCipher, timestamp, timestamp);
  audit(db, "gmail", "1", "connected", { email: value.email });
  return { email: value.email, connectedAt: timestamp };
}

export function disconnectGmail() {
  const db = database();
  const existing = gmailConnection();
  db.prepare("DELETE FROM gmail_connection WHERE id=1").run();
  if (existing)
    audit(db, "gmail", "1", "disconnected", { email: existing.email });
  return { disconnected: true };
}

function findCampaign(campaignId, db = database()) {
  const id = text(campaignId, "Campaign", 100, true);
  const row = db.prepare("SELECT * FROM campaigns WHERE id=?").get(id);
  if (!row) throw problem(404, "Campaign not found");
  return row;
}

export function buildCampaignBody(campaign, recipient, business) {
  const businessName = text(business.name, "Business name", 160, true);
  const businessEmail = email(business.email, "Business email", true);
  const businessAddress = text(business.address, "Business address", 1000, true);
  if (/^add your business address/i.test(businessAddress))
    throw problem(400, "Add the real business mailing address in Settings before sending a campaign");
  return [
    `Hello ${text(recipient.name, "Recipient name", 160, true)},`,
    "",
    text(campaign.bodyText, "Campaign message", 10000, true),
    "",
    "---",
    `Sent by ${businessName}`,
    businessAddress,
    `Contact: ${businessEmail}`,
    `To stop marketing emails, reply with UNSUBSCRIBE or email ${businessEmail} with the subject “Unsubscribe”.`,
  ].join("\r\n");
}

export function saveCampaign(input, id) {
  const db = database();
  const campaignId = id ? text(id, "Campaign", 100, true) : randomUUID();
  const existing = id ? findCampaign(campaignId, db) : null;
  if (existing && existing.status !== "draft")
    throw problem(409, "A campaign can only be edited before it is sent");
  const clientIds = [...new Set(Array.isArray(input.clientIds) ? input.clientIds : [])]
    .map((clientId) => text(clientId, "Selected client", 100, true));
  if (!clientIds.length) throw problem(400, "Choose at least one eligible client");
  if (clientIds.length > 50)
    throw problem(400, "Choose no more than 50 clients for one campaign");
  const clients = clientIds.map((clientId) => {
    const row = db.prepare("SELECT * FROM clients WHERE id=?").get(clientId);
    if (!row) throw problem(404, "A selected client no longer exists");
    const client = clientView(row);
    if (!client.marketing.eligible)
      throw problem(400, `${client.name} cannot receive campaigns: ${client.marketing.reason}`);
    return client;
  });
  const value = {
    name: text(input.name, "Campaign name", 160, true),
    subject: text(input.subject, "Email subject", 200, true),
    bodyText: text(input.bodyText, "Campaign message", 10000, true),
  };
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO campaigns(id,name,subject,body_text,status,created_at,updated_at,sent_at)
       VALUES (?,?,?,?,'draft',?,?,NULL)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,subject=excluded.subject,
       body_text=excluded.body_text,updated_at=excluded.updated_at`,
    ).run(campaignId, value.name, value.subject, value.bodyText, timestamp, timestamp);
    db.prepare("DELETE FROM campaign_recipients WHERE campaign_id=?").run(campaignId);
    const add = db.prepare(
      `INSERT INTO campaign_recipients(
       campaign_id,client_id,recipient_email,recipient_name,status,provider_message_id,last_error,sent_at
       ) VALUES (?,?,?,?,'pending','','',NULL)`,
    );
    for (const client of clients)
      add.run(campaignId, client.id, client.email, client.name);
    audit(db, "campaign", campaignId, existing ? "updated" : "created", {
      recipientCount: clients.length,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return campaignView(findCampaign(campaignId, db), db);
}

export function campaignPayloads(campaignId) {
  const db = database();
  const campaign = campaignView(findCampaign(campaignId, db), db);
  if (campaign.status === "sent") return [];
  if (!["draft", "partial"].includes(campaign.status))
    throw problem(409, "This campaign is already being sent");
  const business = settings(db);
  buildCampaignBody(campaign, { name: "Preview recipient" }, business);
  const rows = db
    .prepare(
      `SELECT r.*,c.* FROM campaign_recipients r
       JOIN clients c ON c.id=r.client_id
       WHERE r.campaign_id=? AND r.status IN ('pending','failed')
       ORDER BY r.recipient_name COLLATE NOCASE`,
    )
    .all(campaign.id);
  if (!rows.length) return [];
  if (rows.length > 50) throw problem(400, "Campaigns are limited to 50 recipients");
  const payloads = [];
  for (const row of rows) {
    const client = clientView(row);
    if (!client.marketing.eligible) {
      db.prepare(
        "UPDATE campaign_recipients SET status='skipped',last_error=? WHERE campaign_id=? AND client_id=?",
      ).run(client.marketing.reason, campaign.id, client.id);
      continue;
    }
    payloads.push({
      campaignId: campaign.id,
      clientId: client.id,
      recipientEmail: row.recipient_email,
      subject: campaign.subject,
      bodyText: buildCampaignBody(campaign, { name: row.recipient_name }, business),
      unsubscribeEmail: business.email,
    });
  }
  db.prepare("UPDATE campaigns SET status='sending',updated_at=? WHERE id=?").run(now(), campaign.id);
  return payloads;
}

export function markCampaignRecipient(campaignId, clientId, result) {
  const db = database();
  const campaign = findCampaign(campaignId, db);
  const recipientId = text(clientId, "Client", 100, true);
  const status = result?.providerMessageId ? "sent" : "failed";
  const timestamp = now();
  const providerId = result?.providerMessageId
    ? text(result.providerMessageId, "Gmail message", 500, true)
    : "";
  const error = providerId
    ? ""
    : text(result?.error ?? "Email provider rejected the message", "Email error", 1000, true);
  db.prepare(
    `UPDATE campaign_recipients SET status=?,provider_message_id=?,last_error=?,sent_at=?
     WHERE campaign_id=? AND client_id=? AND status!='sent'`,
  ).run(status, providerId, error, providerId ? timestamp : null, campaign.id, recipientId);
  audit(db, "campaign", campaign.id, `recipient_${status}`, { clientId: recipientId });
  return campaignView(findCampaign(campaign.id, db), db);
}

export function finishCampaign(campaignId) {
  const db = database();
  const campaign = findCampaign(campaignId, db);
  const counts = db
    .prepare(
      `SELECT status,COUNT(*) count FROM campaign_recipients WHERE campaign_id=? GROUP BY status`,
    )
    .all(campaign.id);
  const totals = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
  const complete = !totals.pending && !totals.failed;
  const status = complete ? "sent" : "partial";
  const timestamp = now();
  db.prepare(
    "UPDATE campaigns SET status=?,updated_at=?,sent_at=COALESCE(sent_at,?) WHERE id=?",
  ).run(status, timestamp, timestamp, campaign.id);
  audit(db, "campaign", campaign.id, status, totals);
  return campaignView(findCampaign(campaign.id, db), db);
}

export function queueInvoiceEmail(invoiceId, mode = "queued") {
  if (!['queued', 'preview'].includes(mode))
    throw problem(400, "Email mode is invalid");
  const db = database();
  const invoice = findInvoice(text(invoiceId, "Invoice", 100, true), db);
  if (invoice.state !== "issued")
    throw problem(409, "Finalize the invoice before sending it");
  const row = db
    .prepare("SELECT snapshot_json FROM invoices WHERE id=?")
    .get(invoice.id);
  const snapshot = JSON.parse(row.snapshot_json);
  const recipientEmail = email(
    snapshot.client.email,
    "Client email",
    true,
  );
  const existing = db
    .prepare(
      "SELECT e.*,i.invoice_number FROM email_outbox e JOIN invoices i ON i.id=e.invoice_id WHERE e.invoice_id=? AND e.recipient_type='client'",
    )
    .get(invoice.id);
  if (existing?.status === "provider_accepted") return outboxView(existing);
  const paymentLines = [];
  if (invoice.stripeCheckout?.url)
    paymentLines.push(`Pay securely with Stripe: ${invoice.stripeCheckout.url}`);
  if (snapshot.business.etransferEmail)
    paymentLines.push(`Interac e-Transfer: ${snapshot.business.etransferEmail}`);
  if (snapshot.business.paypalFallbackUrl)
    paymentLines.push(`PayPal: ${snapshot.business.paypalFallbackUrl}`);
  if (!paymentLines.length && snapshot.business.paymentInstructions)
    paymentLines.push(snapshot.business.paymentInstructions);
  const subject = `${snapshot.business.name} invoice ${snapshot.invoiceNumber}`;
  const bodyText = [
    `Hello ${snapshot.client.name},`,
    "",
    `Your ${snapshot.business.name} invoice ${snapshot.invoiceNumber} for ${snapshot.currency} ${(snapshot.totalMinor / 100).toFixed(2)} is attached.`,
    `Payment is due ${snapshot.dueDate}.`,
    "",
    ...(paymentLines.length ? ["Payment options:", ...paymentLines, ""] : []),
    "Thank you,",
    snapshot.business.name,
    snapshot.business.email,
  ].join("\r\n");
  const id = existing?.id ?? randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO email_outbox(
       id,invoice_id,recipient_type,recipient_email,subject,body_text,status,
       provider_message_id,last_error,attempt_count,created_at,updated_at,accepted_at
     ) VALUES (?,?,'client',?,?,?,?, '', '',0,?,?,NULL)
     ON CONFLICT(invoice_id,recipient_type) DO UPDATE SET
       recipient_email=excluded.recipient_email,subject=excluded.subject,
       body_text=excluded.body_text,status=excluded.status,
       provider_message_id='',last_error='',updated_at=excluded.updated_at,accepted_at=NULL`,
  ).run(
    id,
    invoice.id,
    recipientEmail,
    subject,
    bodyText,
    mode,
    timestamp,
    timestamp,
  );
  audit(db, "email", id, mode === "preview" ? "preview_created" : "queued", {
    invoiceId: invoice.id,
    recipientType: "client",
  });
  return outboxView(
    db
      .prepare(
        "SELECT e.*,i.invoice_number FROM email_outbox e JOIN invoices i ON i.id=e.invoice_id WHERE e.id=?",
      )
      .get(id),
  );
}

export function emailPayload(outboxId) {
  const db = database();
  const row = findOutbox(outboxId, db);
  const invoice = db
    .prepare("SELECT snapshot_json FROM invoices WHERE id=?")
    .get(row.invoice_id);
  const snapshot = JSON.parse(invoice.snapshot_json);
  return {
    ...outboxView(row),
    businessName: snapshot.business.name,
    pdf: readPdf(row.invoice_id),
  };
}

export function markEmailAccepted(outboxId, providerMessageId) {
  const db = database();
  const id = text(outboxId, "Email", 100, true);
  const providerId = text(providerMessageId, "Gmail message", 500, true);
  const timestamp = now();
  const result = db
    .prepare(
      "UPDATE email_outbox SET status='provider_accepted',provider_message_id=?,last_error='',attempt_count=attempt_count+1,updated_at=?,accepted_at=? WHERE id=? AND status!='provider_accepted'",
    )
    .run(providerId, timestamp, timestamp, id);
  if (result.changes) audit(db, "email", id, "provider_accepted", { providerId });
  return outboxView(findOutbox(id, db));
}

export function markEmailFailed(outboxId, rawError) {
  const db = database();
  const id = text(outboxId, "Email", 100, true);
  const error = text(rawError || "Email provider rejected the message", "Email error", 1000, true);
  db.prepare(
    "UPDATE email_outbox SET status='failed',last_error=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status!='provider_accepted'",
  ).run(error, now(), id);
  audit(db, "email", id, "failed", { error });
  return outboxView(findOutbox(id, db));
}

function csvCell(value) {
  let clean = String(value ?? "");
  if (/^[\t\r\n ]*[=+\-@]/.test(clean)) clean = `'${clean}`;
  return `"${clean.replace(/"/g, '""')}"`;
}

export function invoiceCsv() {
  return invoiceCsvFor(dashboard().invoices.filter((invoice) => invoice.state !== "draft"));
}

function taxBreakdown(invoice) {
  const result = { gstMinor: 0, qstMinor: 0, otherTaxMinor: 0 };
  for (const tax of invoice.taxes) {
    const label = String(tax.label).trim().toUpperCase();
    if (["GST", "TPS"].includes(label)) result.gstMinor += tax.amountMinor;
    else if (["QST", "TVQ"].includes(label)) result.qstMinor += tax.amountMinor;
    else result.otherTaxMinor += tax.amountMinor;
  }
  return result;
}

function invoiceCsvFor(invoices) {
  const rows = invoices.map((invoice) => {
    const taxes = taxBreakdown(invoice);
    return [
      invoice.invoiceNumber,
      invoice.clientName,
      invoice.issueDate,
      invoice.dueDate,
      invoice.currency,
      (invoice.subtotalMinor / 100).toFixed(2),
      (taxes.gstMinor / 100).toFixed(2),
      (taxes.qstMinor / 100).toFixed(2),
      (taxes.otherTaxMinor / 100).toFixed(2),
      (invoice.taxMinor / 100).toFixed(2),
      (invoice.totalMinor / 100).toFixed(2),
      (invoice.paymentsMinor / 100).toFixed(2),
      (invoice.balanceMinor / 100).toFixed(2),
      invoice.state,
      [...new Set(invoice.lines.map((line) => line.category ?? "Other"))].join("; "),
    ];
  });
  return [
    [
      "invoice_number",
      "client",
      "issue_date",
      "due_date",
      "currency",
      "subtotal",
      "gst",
      "qst",
      "other_tax",
      "tax",
      "total",
      "payments",
      "balance",
      "invoice_state",
      "revenue_categories",
    ],
    ...rows,
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

export function paymentCsv() {
  return paymentCsvFor(dashboard().payments);
}

function paymentCsvFor(payments) {
  const rows = payments.map((payment) => [
    payment.invoiceNumber,
    payment.paymentDate,
    payment.method,
    payment.currency,
    (payment.amountMinor / 100).toFixed(2),
    payment.reference,
    payment.status,
  ]);
  return [
    [
      "invoice_reference",
      "payment_date",
      "method",
      "currency",
      "amount",
      "transaction_reference",
      "status",
    ],
    ...rows,
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function accountantPeriod(rawPeriod) {
  if (rawPeriod === undefined || rawPeriod === null || rawPeriod === "")
    return null;
  const period = String(rawPeriod);
  if (!/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(period))
    throw problem(400, "Choose a valid month or year");
  const year = Number(period.slice(0, 4));
  if (year < 2000 || year > 2200)
    throw problem(400, "Choose a year from 2000 to 2200");
  return period;
}

function categoryCsvFor(invoices) {
  const totals = new Map();
  for (const invoice of invoices.filter((item) => item.state === "issued")) {
    for (const line of invoice.lines) {
      const category = line.category ?? "Other";
      const key = `${invoice.currency}\u0000${category}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(line.amountMinor));
    }
  }
  const rows = [...totals.entries()]
    .map(([key, subtotal]) => {
      const [currencyCode, category] = key.split("\u0000");
      return [category, currencyCode, (subtotal / 100).toFixed(2)];
    })
    .sort((left, right) =>
      `${left[1]} ${left[0]}`.localeCompare(`${right[1]} ${right[0]}`),
    );
  return [["revenue_category", "currency", "subtotal"], ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents, "utf8");
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + contents.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function packageSummary({ business, period, invoices, payments }) {
  const active = invoices.filter((invoice) => invoice.state === "issued");
  const currencies = [...new Set([...invoices, ...payments].map((item) => item.currency))].sort();
  const lines = [
    "INVOICE DESK - ACCOUNTANT PACKAGE",
    "",
    `Business: ${business.name}`,
    `Period: ${period ?? "All records"}`,
    `Created: ${new Date().toISOString()}`,
    `Finalized invoices included: ${invoices.length}`,
    `Payments included: ${payments.length}`,
    "",
    "TOTALS BY CURRENCY (active invoices only; void invoices are excluded)",
  ];
  for (const currency of currencies) {
    const matchingInvoices = active.filter((invoice) => invoice.currency === currency);
    const matchingPayments = payments.filter(
      (payment) => payment.currency === currency && payment.status === "active",
    );
    const totals = matchingInvoices.reduce(
      (sum, invoice) => {
        const taxes = taxBreakdown(invoice);
        sum.subtotal += invoice.subtotalMinor;
        sum.gst += taxes.gstMinor;
        sum.qst += taxes.qstMinor;
        sum.otherTax += taxes.otherTaxMinor;
        sum.total += invoice.totalMinor;
        sum.balance += invoice.balanceMinor;
        return sum;
      },
      { subtotal: 0, gst: 0, qst: 0, otherTax: 0, total: 0, balance: 0 },
    );
    const paid = matchingPayments.reduce((sum, payment) => sum + payment.amountMinor, 0);
    const amount = (minor) => `${currency} ${(minor / 100).toFixed(2)}`;
    lines.push(
      "",
      currency,
      `  Subtotal: ${amount(totals.subtotal)}`,
      `  GST: ${amount(totals.gst)}`,
      `  QST: ${amount(totals.qst)}`,
      `  Other tax: ${amount(totals.otherTax)}`,
      `  Invoice total: ${amount(totals.total)}`,
      `  Active payments dated in period: ${amount(paid)}`,
      `  Current balance on included invoices: ${amount(totals.balance)}`,
    );
  }
  lines.push("", "REVENUE BY CATEGORY (before tax; active invoices only)");
  const categoryRows = categoryCsvFor(active).split("\r\n").slice(1);
  if (categoryRows.length) lines.push(...categoryRows.map((row) => `  ${row}`));
  else lines.push("  No active invoice revenue in this period.");
  lines.push(
    "",
    "NOTES",
    "- CAD and USD totals are intentionally kept separate and are never converted.",
    "- invoice-records.csv includes separate GST, QST, other-tax, and total-tax columns.",
    "- payment-records.csv includes active and corrected entries for an audit trail.",
    "- Void invoices are included as records but excluded from the totals above.",
    "- Drafts are never included.",
  );
  return lines.join("\r\n");
}

export function accountantPackage(rawPeriod) {
  const period = accountantPeriod(rawPeriod);
  const data = dashboard();
  const inPeriod = (date) => !period || String(date).startsWith(period);
  const invoices = data.invoices.filter(
    (invoice) => invoice.state !== "draft" && inPeriod(invoice.issueDate),
  );
  const payments = data.payments.filter((payment) => inPeriod(payment.paymentDate));
  const entries = [
    {
      name: "README.txt",
      contents: packageSummary({
        business: data.settings,
        period,
        invoices,
        payments,
      }),
    },
    { name: "invoice-records.csv", contents: invoiceCsvFor(invoices) },
    { name: "payment-records.csv", contents: paymentCsvFor(payments) },
    { name: "revenue-by-category.csv", contents: categoryCsvFor(invoices) },
  ];
  for (const invoice of invoices) {
    const pdf = readPdf(invoice.id);
    entries.push({ name: `invoices/${pdf.filename}`, contents: pdf.bytes });
  }
  return {
    bytes: zip(entries),
    filename: `accountant-package-${period ?? "all-records"}.zip`,
    invoiceCount: invoices.length,
    paymentCount: payments.length,
  };
}

export function closeDatabase() {
  cached?.db.close();
  cached = undefined;
}
