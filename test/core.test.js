import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  accountantPackage,
  calculate,
  closeDatabase,
  correctPayment,
  createClient,
  dashboard,
  duplicateInvoice,
  emailPayload,
  invoiceCsv,
  issueInvoice,
  markEmailAccepted,
  markEmailFailed,
  queueInvoiceEmail,
  readPdf,
  recordPayment,
  recordStripePayment,
  saveDraft,
  saveClient,
  saveService,
  saveSettings,
  saveStripeSession,
  voidAndReissue,
} from "../src/core.js";

let root;
let clientId;

function draft(clientId, currency = "CAD") {
  return {
    clientId,
    currency,
    issueDate: "2026-09-13",
    dueDate: "2026-10-13",
    terms: "Net 30",
    notes: "Fictional test invoice",
    lines: [
      { description: "Management", quantity: "2.5", rateMinor: 1001 },
      { description: "Coordination", quantity: "1", rateMinor: 4999 },
    ],
    taxes: [{ label: "Test tax", rateThousandths: 13000 }],
  };
}

function zipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    assert.equal(method, 0);
    const nameStart = offset + 30;
    const contentsStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString();
    entries.set(name, bytes.subarray(contentsStart, contentsStart + size));
    offset = contentsStart + size;
  }
  return entries;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "invoice-desk-test-"));
  process.env.INVOICE_DESK_DATA_ROOT = root;
  assert.equal(dashboard().clients.length, 0);
  clientId = createClient({
    name: "Test Client",
    email: "client@example.test",
    company: "Example Company",
    address: "123 Example Street",
  }).id;
});

afterEach(() => {
  closeDatabase();
  delete process.env.INVOICE_DESK_DATA_ROOT;
  rmSync(root, { recursive: true, force: true });
});

test("rounds quantities and taxes deterministically", () => {
  assert.deepEqual(
    calculate(
      [{ description: "A", quantity: "1.005", rateMinor: 100 }],
      [{ label: "Tax", rateThousandths: 13000 }],
    ),
    {
      lines: [
        {
          description: "A",
          quantity: "1.005",
          rateMinor: 100,
          category: "Other",
          serviceId: "",
          amountMinor: 101,
        },
      ],
      taxes: [{ label: "Tax", rateThousandths: 13000, amountMinor: 13 }],
      subtotalMinor: 101,
      taxMinor: 13,
      totalMinor: 114,
    },
  );
  assert.deepEqual(
    calculate(
      [{ description: "Quebec service", quantity: "1", rateMinor: 10000 }],
      [
        { label: "GST", rateThousandths: 5000 },
        { label: "QST", rateThousandths: 9975 },
      ],
    ),
    {
      lines: [
        {
          description: "Quebec service",
          quantity: "1",
          rateMinor: 10000,
          category: "Other",
          serviceId: "",
          amountMinor: 10000,
        },
      ],
      taxes: [
        { label: "GST", rateThousandths: 5000, amountMinor: 500 },
        { label: "QST", rateThousandths: 9975, amountMinor: 998 },
      ],
      subtotalMinor: 10000,
      taxMinor: 1498,
      totalMinor: 11498,
    },
  );
});

test("issues unique numbers when requests arrive together and survives restart", async () => {
  const drafts = Array.from({ length: 8 }, () => saveDraft(draft(clientId)));
  const issued = await Promise.all(
    drafts.map(
      (invoice) =>
        new Promise((resolve) =>
          setImmediate(() => resolve(issueInvoice(invoice.id))),
        ),
    ),
  );
  assert.equal(new Set(issued.map((invoice) => invoice.invoiceNumber)).size, 8);
  closeDatabase();
  assert.equal(
    dashboard().invoices.filter((invoice) => invoice.state === "issued").length,
    8,
  );
});

test("freezes issued records and the exact PDF", () => {
  saveSettings({
    ...dashboard().settings,
    gstNumber: "123456789RT0001",
    qstNumber: "1234567890TQ0001",
  });
  const invoice = issueInvoice(saveDraft(draft(clientId)).id);
  const first = readPdf(invoice.id).bytes;
  saveSettings({ ...dashboard().settings, name: "Changed after issue" });
  assert.equal(readPdf(invoice.id).bytes.equals(first), true);
  assert.throws(() => saveDraft(draft(clientId), invoice.id), /frozen/);
  assert.equal(first.subarray(0, 4).toString(), "%PDF");
  assert.match(first.toString("latin1"), /GST number: 123456789RT0001/);
  assert.match(first.toString("latin1"), /QST number: 1234567890TQ0001/);
});

test("records a verified Stripe Checkout payment exactly once", () => {
  const invoice = issueInvoice(saveDraft(draft(clientId)).id);
  saveStripeSession(invoice.id, {
    id: "cs_test_invoice_desk",
    amount_total: invoice.balanceMinor,
    currency: invoice.currency.toLowerCase(),
    url: "https://checkout.stripe.test/pay/cs_test_invoice_desk",
    livemode: false,
  });
  const payment = {
    eventId: "evt_test_invoice_desk",
    eventType: "checkout.session.completed",
    sessionId: "cs_test_invoice_desk",
    amountMinor: invoice.balanceMinor,
    currency: invoice.currency,
  };
  assert.equal(recordStripePayment(payment).paymentStatus, "paid");
  assert.equal(recordStripePayment(payment).paymentStatus, "paid");
  assert.equal(dashboard().payments.length, 1);
  assert.equal(dashboard().payments[0].method, "stripe");
});

test("tracks partial, corrected and final payments without currency mixing", () => {
  const cad = issueInvoice(saveDraft(draft(clientId, "CAD")).id);
  issueInvoice(saveDraft(draft(clientId, "USD")).id);
  const partial = recordPayment({
    invoiceId: cad.id,
    paymentDate: "2026-09-13",
    method: "paypal",
    amountMinor: 1000,
    currency: "CAD",
    reference: "PP-TEST",
    notes: "Gross payment",
  });
  assert.equal(partial.paymentStatus, "partially_paid");
  const payment = dashboard().payments.find(
    (item) => item.reference === "PP-TEST",
  );
  const corrected = correctPayment({
    paymentId: payment.id,
    amountMinor: 900,
    reference: "PP-CORRECTED",
    notes: "Correction",
  });
  assert.equal(corrected.paymentsMinor, 900);
  const paid = recordPayment({
    invoiceId: cad.id,
    paymentDate: "2026-09-14",
    method: "bank_transfer",
    amountMinor: corrected.balanceMinor,
    currency: "CAD",
    reference: "BANK-TEST",
    notes: "",
  });
  assert.equal(paid.paymentStatus, "paid");
  assert.throws(
    () =>
      recordPayment({
        invoiceId: cad.id,
        paymentDate: "2026-09-14",
        method: "other",
        amountMinor: 1,
        currency: "USD",
        reference: "BAD",
        notes: "",
      }),
    /currency/,
  );
});

test("voids only unpaid invoices and creates a linked draft", () => {
  const original = issueInvoice(saveDraft(draft(clientId)).id);
  const replacement = voidAndReissue(original.id, "Wrong service date");
  assert.equal(replacement.state, "draft");
  assert.equal(replacement.replacesInvoiceId, original.id);
  assert.equal(
    dashboard().invoices.find((invoice) => invoice.id === original.id).state,
    "void",
  );
});

test("exports formula-safe records", () => {
  const unsafe = createClient({
    name: " =SUM(A1:A2)",
    email: "safe@example.test",
    company: "",
    address: "",
  });
  issueInvoice(saveDraft(draft(unsafe.id)).id);
  assert.match(invoiceCsv(), /"'=SUM\(A1:A2\)"/);
});

test("saves reusable services, edits imported clients and duplicates invoices", () => {
  const service = saveService({
    name: "Pre-fight medical",
    description: "Pre-fight medical coordination",
    category: "Services",
    currency: "CAD",
    rateMinor: 27500,
  });
  assert.equal(dashboard().services[0].name, "Pre-fight medical");
  saveClient(
    {
      name: "Updated Client",
      email: "",
      company: "Example Company",
      phone: "514-555-0100",
      address: "Montreal, QC",
      notes: "Imported and reviewed",
    },
    clientId,
  );
  const original = issueInvoice(
    saveDraft({
      ...draft(clientId),
      lines: [
        {
          serviceId: service.id,
          description: service.description,
          category: service.category,
          quantity: "1",
          rateMinor: service.rateMinor,
        },
      ],
    }).id,
  );
  const copy = duplicateInvoice(original.id);
  assert.equal(copy.state, "draft");
  assert.equal(copy.clientId, original.clientId);
  assert.equal(copy.lines[0].category, "Services");
  assert.equal(dashboard().clients[0].phone, "514-555-0100");
});

test("keeps a persistent duplicate-safe invoice email outbox", () => {
  const invoice = issueInvoice(saveDraft(draft(clientId)).id);
  const preview = queueInvoiceEmail(invoice.id, "preview");
  assert.equal(preview.status, "preview");
  assert.equal(preview.recipientEmail, "client@example.test");
  assert.match(preview.bodyText, new RegExp(invoice.invoiceNumber));
  assert.equal(
    emailPayload(preview.id).pdf.bytes.subarray(0, 4).toString(),
    "%PDF",
  );
  const failed = markEmailFailed(preview.id, "Fictional provider failure");
  assert.equal(failed.status, "failed");
  assert.equal(failed.attemptCount, 1);
  const retried = queueInvoiceEmail(invoice.id, "queued");
  assert.equal(retried.id, preview.id);
  const accepted = markEmailAccepted(retried.id, "gmail-message-test");
  assert.equal(accepted.status, "provider_accepted");
  assert.equal(
    queueInvoiceEmail(invoice.id, "queued").status,
    "provider_accepted",
  );
  assert.equal(dashboard().emailOutbox.length, 1);
});

test("builds a period-filtered accountant ZIP with PDFs and separate Quebec taxes", () => {
  saveSettings({
    ...dashboard().settings,
    gstNumber: "123456789RT0001",
    qstNumber: "1234567890TQ0001",
  });
  const current = issueInvoice(
    saveDraft({
      ...draft(clientId),
      taxes: [
        { label: "GST", rateThousandths: 5000 },
        { label: "QST", rateThousandths: 9975 },
      ],
    }).id,
  );
  recordPayment({
    invoiceId: current.id,
    paymentDate: "2026-09-14",
    method: "bank_transfer",
    amountMinor: 1000,
    currency: "CAD",
    reference: "BANK-ACCOUNTANT-TEST",
    notes: "",
  });
  const older = issueInvoice(
    saveDraft({
      ...draft(clientId),
      issueDate: "2025-12-01",
      dueDate: "2025-12-31",
    }).id,
  );

  const bundle = accountantPackage("2026");
  assert.equal(bundle.invoiceCount, 1);
  assert.equal(bundle.paymentCount, 1);
  assert.equal(bundle.filename, "accountant-package-2026.zip");
  assert.equal(bundle.bytes.subarray(0, 2).toString(), "PK");
  const entries = zipEntries(bundle.bytes);
  assert.deepEqual([...entries.keys()], [
    "README.txt",
    "invoice-records.csv",
    "payment-records.csv",
    "revenue-by-category.csv",
    `invoices/${current.invoiceNumber}.pdf`,
  ]);
  assert.match(entries.get("README.txt").toString(), /GST: CAD 3\.75/);
  assert.match(entries.get("README.txt").toString(), /QST: CAD 7\.48/);
  assert.match(entries.get("invoice-records.csv").toString(), /"gst","qst","other_tax"/);
  assert.match(entries.get("invoice-records.csv").toString(), /"3\.75","7\.48"/);
  assert.match(entries.get("payment-records.csv").toString(), /BANK-ACCOUNTANT-TEST/);
  assert.match(entries.get("revenue-by-category.csv").toString(), /Other/);
  assert.equal(entries.has(`invoices/${older.invoiceNumber}.pdf`), false);
  assert.equal(accountantPackage("2026-09").invoiceCount, 1);
  assert.equal(accountantPackage().invoiceCount, 2);
  assert.throws(() => accountantPackage("twenty"), /valid month or year/);
});
