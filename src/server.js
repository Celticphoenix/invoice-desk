import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  accountantPackage,
  campaignPayloads,
  closeDatabase,
  correctPayment,
  createClient,
  dashboard,
  disconnectGmail,
  duplicateInvoice,
  emailPayload,
  finishCampaign,
  gmailConnection,
  invoiceCsv,
  issueInvoice,
  markEmailAccepted,
  markEmailFailed,
  markCampaignRecipient,
  paymentCsv,
  payableInvoice,
  readPdf,
  recordPayment,
  recordStripePayment,
  reusableStripeSession,
  queueInvoiceEmail,
  saveDraft,
  saveClient,
  saveCampaign,
  saveGmailConnection,
  saveService,
  saveSettings,
  saveStripeSession,
  stripeSessionsToSync,
  updateStripeSessionStatus,
  voidAndReissue,
} from "./core.js";
import {
  encryptRefreshToken,
  exchangeGmailCode,
  gmailAuthorizationUrl,
  gmailStatus,
  sendGmailMessage,
  sendGmailTextMessage,
} from "./email.js";
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

function cookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2),
  );
}

function signedIn(request) {
  const [expires, supplied] = String(
    cookies(request).invoice_session ?? "",
  ).split(".");
  return Boolean(
    expires &&
    supplied &&
    Number(expires) > Date.now() &&
    safeEqual(supplied, signature(expires)),
  );
}

function redirect(response, location, cookie = "") {
  response.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...securityHeaders,
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  });
  response.end();
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

async function sendOutbox(outboxId) {
  const connection = gmailConnection();
  const state = gmailStatus(connection);
  const payload = emailPayload(outboxId);
  if (payload.status === "provider_accepted" || !state.connected) return payload;
  try {
    const sent = await sendGmailMessage(payload, connection);
    return markEmailAccepted(outboxId, sent.id);
  } catch (error) {
    markEmailFailed(outboxId, error.message);
    throw error;
  }
}

async function reviewAndSend(invoiceId) {
  let invoice = dashboard().invoices.find((item) => item.id === invoiceId);
  if (!invoice)
    throw Object.assign(new Error("Invoice not found"), { status: 404 });
  if (!invoice.clientEmail)
    throw Object.assign(
      new Error("Add an email address to this client before finalizing and sending"),
      { status: 400 },
    );
  if (invoice.state === "draft") invoice = issueInvoice(invoice.id);
  if (invoice.state !== "issued")
    throw Object.assign(new Error("Only an active invoice can be emailed"), {
      status: 409,
    });
  if (invoice.balanceMinor > 0 && stripeStatus().enabled)
    await createStripePayment(invoice.id);
  const connection = gmailConnection();
  const state = gmailStatus(connection);
  const outbox = queueInvoiceEmail(
    invoice.id,
    state.connected ? "queued" : "preview",
  );
  return state.connected ? sendOutbox(outbox.id) : outbox;
}

async function retryEmail(outboxId) {
  const prior = emailPayload(outboxId);
  if (prior.status === "provider_accepted") return prior;
  const connection = gmailConnection();
  const state = gmailStatus(connection);
  const refreshed = queueInvoiceEmail(
    prior.invoiceId,
    state.connected ? "queued" : "preview",
  );
  return state.connected ? sendOutbox(refreshed.id) : refreshed;
}

async function sendCampaign(campaignId) {
  const connection = gmailConnection();
  if (!gmailStatus(connection).connected)
    throw Object.assign(new Error("Connect Gmail in Settings before sending a campaign"), {
      status: 409,
    });
  const senderName = dashboard().settings.name;
  const payloads = campaignPayloads(campaignId);
  for (const payload of payloads) {
    try {
      const sent = await sendGmailTextMessage({ ...payload, senderName }, connection);
      markCampaignRecipient(payload.campaignId, payload.clientId, {
        providerMessageId: sent.id,
      });
    } catch (error) {
      markCampaignRecipient(payload.campaignId, payload.clientId, {
        error: error.message,
      });
    }
  }
  return finishCampaign(campaignId);
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
    if (request.method === "GET" && url.pathname === "/api/gmail/callback") {
      const expectedState = String(cookies(request).gmail_oauth_state ?? "");
      const suppliedState = String(url.searchParams.get("state") ?? "");
      if (
        !expectedState ||
        !suppliedState ||
        !safeEqual(expectedState, suppliedState)
      )
        return json(response, 403, {
          error: "Gmail connection expired. Start again from Settings.",
        });
      const expiredStateCookie =
        "gmail_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
      if (url.searchParams.get("error"))
        return redirect(response, "/?gmail=not-connected", expiredStateCookie);
      const result = await exchangeGmailCode(
        String(url.searchParams.get("code") ?? ""),
      );
      const expectedEmail = dashboard().settings.email.toLowerCase();
      if (result.email !== expectedEmail)
        throw Object.assign(
          new Error(`Please connect ${expectedEmail}, not ${result.email}`),
          { status: 409 },
        );
      saveGmailConnection({
        email: result.email,
        refreshTokenCipher: encryptRefreshToken(result.refreshToken),
      });
      return redirect(response, "/?gmail=connected", expiredStateCookie);
    }
    if (!signedIn(request))
      return json(response, 401, { error: "Sign in required" });
    if (request.method === "GET" && url.pathname === "/api/gmail/connect") {
      const state = randomBytes(32).toString("base64url");
      const location = gmailAuthorizationUrl(
        state,
        dashboard().settings.email,
      );
      return redirect(
        response,
        location,
        `gmail_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secureCookies ? "; Secure" : ""}`,
      );
    }
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
        email: gmailStatus(gmailConnection()),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      if (!sameOrigin(request))
        return json(response, 403, { error: "Invalid request origin" });
      const input = await body(request);
      const actions = {
        "create-client": () => createClient(input.client),
        "save-client": () => saveClient(input.client, input.clientId),
        "save-campaign": () => saveCampaign(input.campaign, input.campaignId),
        "send-campaign": () => sendCampaign(input.campaignId),
        "save-service": () => saveService(input.service, input.serviceId),
        "save-settings": () => saveSettings(input.settings),
        "save-draft": () => saveDraft(input.invoice, input.invoiceId),
        issue: () => issueInvoice(input.invoiceId),
        "record-payment": () => recordPayment(input.payment),
        "correct-payment": () => correctPayment(input.correction),
        "void-reissue": () => voidAndReissue(input.invoiceId, input.reason),
        "stripe-create": () => createStripePayment(input.invoiceId),
        "stripe-sync": () => syncStripePayments(),
        duplicate: () => duplicateInvoice(input.invoiceId),
        "review-send": () => reviewAndSend(input.invoiceId),
        "retry-email": () => retryEmail(input.outboxId),
        "disconnect-gmail": () => disconnectGmail(),
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
      const bundle = accountantPackage(url.searchParams.get("period"));
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
