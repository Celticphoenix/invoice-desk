import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

async function freePort() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

test("runs the complete exact-amount Stripe payment flow", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "invoice-desk-server-"));
  let paid = false;
  let stripeSession;
  const stripe = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method === "POST") {
      const form = new URLSearchParams(raw);
      stripeSession = {
        id: "cs_test_server_flow",
        client_reference_id: form.get("client_reference_id"),
        metadata: { invoice_id: form.get("metadata[invoice_id]") },
        amount_total: Number(
          form.get("line_items[0][price_data][unit_amount]"),
        ),
        currency: form.get("line_items[0][price_data][currency]"),
        payment_status: "unpaid",
        status: "open",
        url: "https://checkout.stripe.test/pay/cs_test_server_flow",
        livemode: false,
      };
    }
    const result = {
      ...stripeSession,
      payment_status: paid ? "paid" : "unpaid",
      status: paid ? "complete" : "open",
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => stripe.listen(0, "127.0.0.1", resolve));
  const appPort = await freePort();
  const app = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      INVOICE_DESK_PORT: String(appPort),
      INVOICE_DESK_DATA_ROOT: dataRoot,
      STRIPE_SECRET_KEY: "sk_test_server_flow",
      STRIPE_SUCCESS_URL: "https://agency.example/paid",
      STRIPE_CANCEL_URL: "https://agency.example/cancelled",
      STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Invoice Desk did not start")),
        5000,
      );
      app.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("Invoice Desk is ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      app.once("exit", (code) => reject(new Error(`Server exited ${code}`)));
    });
    const origin = `http://127.0.0.1:${appPort}`;
    const login = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ password: "invoice-demo" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const action = async (payload) => {
      const response = await fetch(`${origin}/api/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      assert.equal(response.status, 200, result.error);
      return result;
    };
    const client = await action({
      action: "create-client",
      client: {
        name: "Stripe Test Client",
        email: "client@example.test",
        company: "",
        address: "Montreal, QC",
      },
    });
    const dashboardResponse = async () => {
      const response = await fetch(`${origin}/api/dashboard`, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const settings = (await dashboardResponse()).settings;
    await action({
      action: "save-settings",
      settings: {
        ...settings,
        gstNumber: "123456789RT0001",
        qstNumber: "1234567890TQ0001",
      },
    });
    const draft = await action({
      action: "save-draft",
      invoice: {
        clientId: client.id,
        currency: "CAD",
        issueDate: "2026-09-13",
        dueDate: "2026-10-13",
        terms: "Net 30",
        notes: "",
        lines: [{ description: "Management", quantity: "1", rateMinor: 10000 }],
        taxes: [
          { label: "GST", rateThousandths: 5000 },
          { label: "QST", rateThousandths: 9975 },
        ],
      },
    });
    const invoice = await action({ action: "issue", invoiceId: draft.id });
    assert.equal(invoice.totalMinor, 11498);
    const checkout = await action({
      action: "stripe-create",
      invoiceId: invoice.id,
    });
    assert.equal(checkout.amountMinor, 11498);
    assert.equal(stripeSession.amount_total, 11498);
    paid = true;
    const paidDashboard = await dashboardResponse();
    assert.equal(paidDashboard.invoices[0].paymentStatus, "paid");
    assert.equal(paidDashboard.payments.length, 1);
    assert.equal((await dashboardResponse()).payments.length, 1);
    const pdf = await fetch(`${origin}/api/pdf/${invoice.id}`, {
      headers: { Cookie: cookie },
    });
    const pdfText = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    assert.match(pdfText, /GST number: 123456789RT0001/);
    assert.match(pdfText, /QST number: 1234567890TQ0001/);
  } finally {
    app.kill("SIGTERM");
    await new Promise((resolve) => app.once("exit", resolve));
    stripe.closeAllConnections();
    await new Promise((resolve) => stripe.close(resolve));
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
