import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  accountantPackage,
  closeDatabase,
  correctPayment,
  createClient,
  dashboard,
  invoiceCsv,
  issueInvoice,
  paymentCsv,
  payableInvoice,
  readPdf,
  recordPayment,
  recordStripePayment,
  reusableStripeSession,
  saveDraft,
  saveSettings,
  saveStripeSession,
  stripeSessionsToSync,
  updateStripeSessionStatus,
  voidAndReissue,
} from "./core.js";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  stripeStatus,
  verifyStripeWebhook,
} from "./stripe.js";

const port = Number(process.env.INVOICE_DESK_PORT ?? 3210);
const host = process.env.INVOICE_DESK_HOST ?? "127.0.0.1";
const production = process.env.NODE_ENV === "production";
const secureCookies =
  process.env.INVOICE_DESK_SECURE_COOKIES === undefined
    ? production
    : process.env.INVOICE_DESK_SECURE_COOKIES === "true";
const password =
  process.env.INVOICE_DESK_PASSWORD ?? (production ? "" : "invoice-demo");
const secret =
  process.env.INVOICE_DESK_SESSION_SECRET ??
  (production ? "" : "local-invoice-desk-session-only");

if (!password || !secret) {
  console.error(
    "Set INVOICE_DESK_PASSWORD and INVOICE_DESK_SESSION_SECRET before production use.",
  );
  process.exit(1);
}

if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  (!process.env.INVOICE_DESK_PASSWORD ||
    !process.env.INVOICE_DESK_SESSION_SECRET)
) {
  console.error(
    "Refusing to listen beyond this computer without an explicit password and session secret.",
  );
  process.exit(1);
}

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function signature(value) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionToken() {
  const expires = String(Date.now() + 12 * 60 * 60 * 1000);
  return `${expires}.${signature(expires)}`;
}

function signedIn(request) {
  const cookies = Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2),
  );
  const [expires, supplied] = String(cookies.invoice_session ?? "").split(".");
  return Boolean(
    expires &&
    supplied &&
    Number(expires) > Date.now() &&
    safeEqual(supplied, signature(expires)),
  );
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders,
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function rawBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000)
      throw Object.assign(new Error("Request is too large"), { status: 413 });
  }
  return raw;
}

async function body(request) {
  const raw = await rawBody(request);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("Invalid request"), { status: 400 });
  }
}

function verifiedStripePayment(session, eventId, eventType) {
  if (session.payment_status !== "paid") return null;
  const invoiceId = session.client_reference_id || session.metadata?.invoice_id;
  if (!invoiceId)
    throw Object.assign(new Error("Stripe payment has no invoice reference"), {
      status: 409,
    });
  return recordStripePayment({
    eventId,
    eventType,
    sessionId: session.id,
    invoiceId,
    amountMinor: Number(session.amount_total),
    currency: String(session.currency ?? "").toUpperCase(),
  });
}

async function syncStripePayments() {
  if (!stripeStatus().enabled) return;
  for (const saved of stripeSessionsToSync()) {
    const session = await retrieveCheckoutSession(saved.id);
    if (
      session.client_reference_id !== saved.invoiceId &&
      session.metadata?.invoice_id !== saved.invoiceId
    )
      throw Object.assign(new Error("Stripe invoice reference mismatch"), {
        status: 409,
      });
    if (session.payment_status === "paid")
      verifiedStripePayment(
        session,
        `sync:${session.id}:paid`,
        "checkout.session.synced",
      );
    else if (session.status === "expired")
      updateStripeSessionStatus(session.id, "expired");
  }
}

const stripeCreations = new Map();

async function createStripePayment(invoiceId) {
  if (stripeCreations.has(invoiceId)) return stripeCreations.get(invoiceId);
  const pending = (async () => {
    const existing = reusableStripeSession(invoiceId);
    if (existing) return existing;
    const invoice = payableInvoice(invoiceId);
    const session = await createCheckoutSession(invoice);
    if (
      session.client_reference_id !== invoice.id ||
      Number(session.amount_total) !== invoice.balanceMinor ||
      String(session.currency ?? "").toUpperCase() !== invoice.currency
    )
      throw Object.assign(
        new Error("Stripe checkout did not match the invoice"),
        { status: 502 },
      );
    return saveStripeSession(invoice.id, session).stripeCheckout;
  })();
  stripeCreations.set(invoiceId, pending);
  try {
    return await pending;
  } finally {
    stripeCreations.delete(invoiceId);
  }
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  return (
    !origin ||
    origin === `http://${request.headers.host}` ||
    origin === `https://${request.headers.host}`
  );
}

const staticFiles = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  try {
    if (request.method === "GET" && staticFiles[url.pathname]) {
      const [filename, type] = staticFiles[url.pathname];
      const contents = readFileSync(path.resolve("public", filename));
      response.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        ...securityHeaders,
      });
      return response.end(contents);
    }
    if (request.method === "GET" && url.pathname === "/api/health")
      return json(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/api/session")
      return json(response, 200, {
        authenticated: signedIn(request),
        developmentMode: !production,
      });
    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!sameOrigin(request))
        return json(response, 403, { error: "Invalid request origin" });
      const input = await body(request);
      if (!safeEqual(String(input.password ?? ""), password))
        return json(response, 401, { error: "Incorrect password" });
      return json(
        response,
        200,
        { ok: true },
        {
          "Set-Cookie": `invoice_session=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookies ? "; Secure" : ""}`,
        },
      );
    }
    if (request.method === "POST" && url.pathname === "/api/stripe/webhook") {
      const raw = await rawBody(request);
      const event = verifyStripeWebhook(
        raw,
        request.headers["stripe-signature"],
      );
      if (
        [
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
        ].includes(event.type)
      )
        verifiedStripePayment(event.data.object, event.id, event.type);
      else if (event.type === "checkout.session.expired")
        updateStripeSessionStatus(event.data.object.id, "expired");
      return json(response, 200, { received: true });
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      if (!sameOrigin(request))
        return json(response, 403, { error: "Invalid request origin" });
      return json(
        response,
        200,
        { ok: true },
        {
          "Set-Cookie":
            "invoice_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        },
      );
    }
    if (!signedIn(request))
      return json(response, 401, { error: "Sign in required" });
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      let stripeError = "";
      try {
        await syncStripePayments();
      } catch (error) {
        stripeError = error.message;
      }
      return json(response, 200, {
        ...dashboard(),
        stripe: { ...stripeStatus(), error: stripeError },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      if (!sameOrigin(request))
        return json(response, 403, { error: "Invalid request origin" });
      const input = await body(request);
      const actions = {
        "create-client": () => createClient(input.client),
        "save-settings": () => saveSettings(input.settings),
        "save-draft": () => saveDraft(input.invoice, input.invoiceId),
        issue: () => issueInvoice(input.invoiceId),
        "record-payment": () => recordPayment(input.payment),
        "correct-payment": () => correctPayment(input.correction),
        "void-reissue": () => voidAndReissue(input.invoiceId, input.reason),
        "stripe-create": () => createStripePayment(input.invoiceId),
        "stripe-sync": () => syncStripePayments(),
      };
      if (!Object.hasOwn(actions, input.action))
        return json(response, 400, { error: "Unknown action" });
      return json(response, 200, await actions[input.action]());
    }
    const pdfMatch = url.pathname.match(/^\/api\/pdf\/([a-f0-9-]+)$/i);
    if (request.method === "GET" && pdfMatch) {
      const pdf = readPdf(pdfMatch[1]);
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdf.filename}"`,
        "Cache-Control": "private, no-store",
        ...securityHeaders,
      });
      return response.end(pdf.bytes);
    }
    if (request.method === "GET" && url.pathname === "/api/export/invoices") {
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=invoice-records.csv",
        "Cache-Control": "private, no-store",
        ...securityHeaders,
      });
      return response.end(invoiceCsv());
    }
    if (request.method === "GET" && url.pathname === "/api/export/payments") {
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=payment-records.csv",
        "Cache-Control": "private, no-store",
        ...securityHeaders,
      });
      return response.end(paymentCsv());
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/export/accountant-package"
    ) {
      const bundle = accountantPackage(url.searchParams.get("year"));
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${bundle.filename}"`,
        "Content-Length": bundle.bytes.length,
        "Cache-Control": "private, no-store",
        ...securityHeaders,
      });
      return response.end(bundle.bytes);
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status === 500)
      console.error("Invoice Desk request failed", error?.message ?? error);
    return json(response, status, {
      error: status === 500 ? "Unexpected local server error" : error.message,
    });
  }
});

server.listen(port, host, () => {
  console.log(`Invoice Desk is ready at http://${host}:${port}`);
  if (!production) console.log("Local demo password: invoice-demo");
});

function shutdown() {
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
