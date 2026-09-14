import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  stripeStatus,
  verifyStripeWebhook,
} from "../src/stripe.js";

let server;
let requests;

beforeEach(async () => {
  requests = [];
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "cs_test_exact_invoice",
        client_reference_id: "invoice-1",
        metadata: { invoice_id: "invoice-1" },
        amount_total: 11498,
        currency: "cad",
        payment_status: request.method === "GET" ? "paid" : "unpaid",
        status: "open",
        url: "https://checkout.stripe.test/pay/cs_test_exact_invoice",
        livemode: false,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.STRIPE_SECRET_KEY = "sk_test_invoice_desk";
  process.env.STRIPE_SUCCESS_URL = "https://agency.example/payment-received";
  process.env.STRIPE_CANCEL_URL = "https://agency.example/payment-cancelled";
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const name of [
    "STRIPE_SECRET_KEY",
    "STRIPE_SUCCESS_URL",
    "STRIPE_CANCEL_URL",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_API_BASE",
  ])
    delete process.env[name];
});

test("creates exact Stripe Checkout Sessions without exposing the key", async () => {
  const invoice = {
    id: "invoice-1",
    invoiceNumber: "INV-01001",
    state: "issued",
    balanceMinor: 11498,
    currency: "CAD",
    clientName: "Test Client",
    clientEmail: "client@example.test",
  };
  const session = await createCheckoutSession(invoice);
  assert.equal(session.amount_total, 11498);
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].authorization, /^Basic /);
  assert.doesNotMatch(requests[0].body, /sk_test_invoice_desk/);
  const form = new URLSearchParams(requests[0].body);
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "11498");
  assert.equal(form.get("line_items[0][price_data][currency]"), "cad");
  assert.equal(form.get("client_reference_id"), "invoice-1");
  assert.equal(stripeStatus().mode, "test");
  assert.equal(
    (await retrieveCheckoutSession("cs_test_exact_invoice")).payment_status,
    "paid",
  );
});

test("verifies signed webhook raw bodies", () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_invoice_desk";
  const raw = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  assert.equal(
    verifyStripeWebhook(raw, `t=${timestamp},v1=${signature}`).id,
    "evt_1",
  );
  assert.throws(
    () => verifyStripeWebhook(raw, `t=${timestamp},v1=incorrect`),
    /Invalid Stripe signature/,
  );
});
