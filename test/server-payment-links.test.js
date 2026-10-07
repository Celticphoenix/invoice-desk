import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("durable invoice links renew expired checkout and block duplicate or void payments", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "invoice-desk-links-"));
  const sessions = new Map();
  let creations = 0;
  let unavailable = false;
  const stripe = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (unavailable) {
      response.writeHead(503, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ error: { message: "Fixture offline" } }));
    }
    let session;
    if (request.method === "POST" && request.url === "/v1/checkout/sessions") {
      const form = new URLSearchParams(raw);
      const id = `cs_test_durable_${++creations}`;
      session = {
        id, client_reference_id: form.get("client_reference_id"),
        metadata: { invoice_id: form.get("metadata[invoice_id]") },
        amount_total: Number(form.get("line_items[0][price_data][unit_amount]")),
        currency: form.get("line_items[0][price_data][currency]"),
        status: "open", payment_status: "unpaid", livemode: false,
        url: `https://checkout.stripe.test/pay/${id}`, payment_intent: null,
      };
      sessions.set(id, session);
    } else {
      const id = request.url.split("?")[0].split("/")[4];
      session = sessions.get(id);
      if (request.method === "POST" && request.url.endsWith("/expire"))
        session.status = "expired";
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(session));
  });
  await new Promise((resolve) => stripe.listen(0, "127.0.0.1", resolve));
  const appPort = await freePort();
  const origin = `http://127.0.0.1:${appPort}`;
  let app;
  let cookie;
  async function start() {
    app = spawn(process.execPath, ["src/server.js"], {
      cwd: path.resolve("."),
      env: { ...process.env, NODE_ENV: "development", PORT: String(appPort),
        INVOICE_DESK_HOST: "127.0.0.1", INVOICE_DESK_DATA_ROOT: dataRoot,
        INVOICE_DESK_PASSWORD: "invoice-demo", INVOICE_DESK_SESSION_SECRET: "test-links-secret",
        INVOICE_DESK_SECURE_COOKIES: "false", INVOICE_DESK_PUBLIC_URL: origin,
        STRIPE_SECRET_KEY: "sk_test_durable", STRIPE_SUCCESS_URL: "https://agency.example/paid",
        STRIPE_CANCEL_URL: "https://agency.example/cancel", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "",
        STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`Server did not start: ${stderr}`)), 5000);
      app.stderr.on("data", (data) => { stderr += data; });
      app.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("Invoice Desk is ready")) { clearTimeout(timer); resolve(); }
      });
      app.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const login = await fetch(`${origin}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ password: "invoice-demo" }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie").split(";")[0];
  }
  async function stop() {
    const exited = new Promise((resolve) => app.once("exit", resolve));
    app.kill("SIGTERM");
    await exited;
  }
  async function action(payload) {
    const response = await fetch(`${origin}/api/action`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
      body: JSON.stringify(payload),
    });
    const value = await response.json();
    assert.equal(response.status, 200, value.error);
    return value;
  }
  const dashboard = () => fetch(`${origin}/api/dashboard`, { headers: { Cookie: cookie } }).then((r) => r.json());
  const open = (url) => fetch(url, { redirect: "manual" });
  const pay = (url) => fetch(url, { method: "POST", redirect: "manual", headers: { Origin: origin } });
  try {
    await start();
    const client = await action({ action: "create-client", client: {
      name: "Private Fighter Name", email: "fighter@example.test", company: "", address: "Private address",
    } });
    const newInvoice = async () => {
      const draft = await action({ action: "save-draft", invoice: {
        clientId: client.id, currency: "CAD", issueDate: "2026-10-07", dueDate: "2026-11-07",
        terms: "Net 30", notes: "Private notes", lines: [{ description: "Private service", quantity: "1", rateMinor: 14372 }], taxes: [],
      } });
      return action({ action: "issue", invoiceId: draft.id });
    };
    const invoice = await newInvoice();
    const link = (await dashboard()).invoices.find((i) => i.id === invoice.id).paymentUrl;
    assert.match(link, new RegExp(`^${origin}/pay/[A-Za-z0-9_-]{43}$`));
    assert.equal((await dashboard()).invoices.find((i) => i.id === invoice.id).paymentUrl, link);
    const preview = await action({ action: "review-send", invoiceId: invoice.id });
    assert.match(preview.bodyText, new RegExp(link));
    assert.doesNotMatch(preview.bodyText, /checkout\.stripe/);
    assert.equal(creations, 0, "Email and page reads must not create Stripe sessions");
    const landing = await open(link);
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.match(landing.headers.get("cache-control"), /no-store/);
    assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
    const text = await landing.text();
    assert.match(text, /143\.72/);
    assert.match(text, /Continue to secure payment/);
    assert.doesNotMatch(text, /fighter@example|Private address|Private notes|Private service|sk_test|api\/dashboard/);
    assert.equal((await open(`${origin}/api/dashboard`)).status, 401);
    assert.equal((await open(`${origin}/pay/${"x".repeat(43)}`)).status, 404);
    assert.equal((await open(`${origin}/pay/${invoice.id}`)).status, 404);
    const blocked = await fetch(link, { method: "POST", headers: { Origin: "https://attacker.example" } });
    assert.equal(blocked.status, 403);
    assert.equal(creations, 0);
    const first = await pay(link);
    assert.equal(first.status, 303);
    assert.equal(creations, 1);
    assert.equal(sessions.get("cs_test_durable_1").amount_total, 14372);
    assert.equal((await pay(link)).headers.get("location"), first.headers.get("location"));
    assert.equal(creations, 1, "Reuse an existing open checkout");
    sessions.get("cs_test_durable_1").status = "expired";
    assert.equal((await open(link)).status, 200);
    assert.equal(creations, 1);
    const renewed = await pay(link);
    assert.equal(renewed.status, 303);
    assert.equal(creations, 2);
    assert.notEqual(renewed.headers.get("location"), first.headers.get("location"));
    await stop();
    await start();
    assert.equal((await dashboard()).invoices.find((i) => i.id === invoice.id).paymentUrl, link, "Token survives restart");
    const current = sessions.get("cs_test_durable_2");
    current.status = "expired";
    const concurrent = await Promise.all([pay(link), pay(link)]);
    assert.equal(creations, 3, "Concurrent clicks only create one new session");
    assert.equal(concurrent[0].headers.get("location"), concurrent[1].headers.get("location"));
    const complete = sessions.get("cs_test_durable_3");
    complete.status = "complete";
    assert.equal((await open(link)).status, 202, "Pending payment cannot be charged again");
    assert.equal((await pay(link)).status, 409);
    assert.equal(creations, 3);
    complete.payment_status = "paid";
    complete.payment_intent = "pi_test_durable_3";
    const paidPage = await open(link);
    assert.match(await paidPage.text(), /Invoice already paid/);
    assert.equal((await pay(link)).status, 200);
    assert.equal(creations, 3, "Paid invoices cannot create another checkout before a webhook");
    assert.equal((await dashboard()).invoices.find((i) => i.id === invoice.id).balanceMinor, 0);
    const partial = await newInvoice();
    const partialLink = (await dashboard()).invoices.find((i) => i.id === partial.id).paymentUrl;
    await pay(partialLink);
    const stale = sessions.get("cs_test_durable_4");
    await action({ action: "record-payment", payment: {
      invoiceId: partial.id, amountMinor: 5000, currency: "CAD", method: "bank_transfer",
      paymentDate: "2026-10-07", reference: "fixture", notes: "",
    } });
    await pay(partialLink);
    assert.equal(stale.status, "expired");
    assert.equal(sessions.get("cs_test_durable_5").amount_total, 9372, "Charge only the new remaining balance");
    const voided = await newInvoice();
    const voidLink = (await dashboard()).invoices.find((i) => i.id === voided.id).paymentUrl;
    await action({ action: "void-reissue", invoiceId: voided.id, reason: "Test replacement" });
    assert.equal((await open(voidLink)).status, 410);
    assert.equal((await pay(voidLink)).status, 410);
    const offline = await newInvoice();
    const offlineLink = (await dashboard()).invoices.find((i) => i.id === offline.id).paymentUrl;
    await pay(offlineLink);
    const beforeOffline = creations;
    unavailable = true;
    assert.equal((await open(offlineLink)).status, 503);
    assert.equal((await pay(offlineLink)).status, 503);
    assert.equal(creations, beforeOffline, "Never create unchecked duplicate charges during a Stripe outage");
  } finally {
    if (app && app.exitCode === null) await stop();
    stripe.closeAllConnections();
    await new Promise((resolve) => stripe.close(resolve));
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
