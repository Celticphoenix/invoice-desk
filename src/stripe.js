import { createHmac, timingSafeEqual } from "node:crypto";

const defaultApiBase = "https://api.stripe.com";

function clean(value) {
  return String(value ?? "").trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requiredConfiguration() {
  const secretKey = clean(process.env.STRIPE_SECRET_KEY);
  const successUrl = clean(process.env.STRIPE_SUCCESS_URL);
  if (!secretKey)
    throw Object.assign(new Error("Stripe is not configured yet"), {
      status: 409,
    });
  if (!/^sk_(?:test|live)_/.test(secretKey))
    throw Object.assign(new Error("Stripe secret key is not valid"), {
      status: 409,
    });
  try {
    const parsed = new URL(successUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
      throw new Error();
  } catch {
    throw Object.assign(
      new Error("Stripe needs a valid HTTPS success page URL"),
      { status: 409 },
    );
  }
  const cancelUrl = clean(process.env.STRIPE_CANCEL_URL) || successUrl;
  try {
    const parsed = new URL(cancelUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
      throw new Error();
  } catch {
    throw Object.assign(
      new Error("Stripe needs a valid HTTPS cancellation page URL"),
      { status: 409 },
    );
  }
  return {
    secretKey,
    successUrl,
    cancelUrl,
    apiBase: clean(process.env.STRIPE_API_BASE) || defaultApiBase,
  };
}

export function stripeStatus() {
  const secretKey = clean(process.env.STRIPE_SECRET_KEY);
  const successUrl = clean(process.env.STRIPE_SUCCESS_URL);
  return {
    enabled: Boolean(secretKey && successUrl),
    mode: secretKey.startsWith("sk_live_")
      ? "live"
      : secretKey.startsWith("sk_test_")
        ? "test"
        : "not configured",
    webhookConfigured: clean(process.env.STRIPE_WEBHOOK_SECRET).startsWith(
      "whsec_",
    ),
  };
}

async function stripeRequest(pathname, options = {}) {
  const configuration = requiredConfiguration();
  const response = await fetch(`${configuration.apiBase}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Basic ${Buffer.from(`${configuration.secretKey}:`).toString("base64")}`,
      ...(options.headers ?? {}),
    },
  });
  const result = await response.json();
  if (!response.ok) {
    const message =
      result?.error?.message || "Stripe could not complete the request";
    throw Object.assign(new Error(message), { status: 502 });
  }
  return result;
}

export async function createCheckoutSession(invoice) {
  const configuration = requiredConfiguration();
  if (invoice.state !== "issued" || invoice.balanceMinor < 1)
    throw Object.assign(new Error("This invoice has no payable balance"), {
      status: 409,
    });
  const successUrl = new URL(configuration.successUrl);
  successUrl.searchParams.set("invoice", invoice.invoiceNumber);
  successUrl.searchParams.set("stripe", "paid");
  const cancelUrl = new URL(configuration.cancelUrl);
  cancelUrl.searchParams.set("invoice", invoice.invoiceNumber);
  cancelUrl.searchParams.set("stripe", "cancelled");
  const form = new URLSearchParams({
    mode: "payment",
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
    client_reference_id: invoice.id,
    customer_email: invoice.clientEmail,
    "metadata[invoice_id]": invoice.id,
    "metadata[invoice_number]": invoice.invoiceNumber,
    "payment_intent_data[metadata][invoice_id]": invoice.id,
    "payment_intent_data[metadata][invoice_number]": invoice.invoiceNumber,
    "line_items[0][price_data][currency]": invoice.currency.toLowerCase(),
    "line_items[0][price_data][product_data][name]": `Invoice ${invoice.invoiceNumber}`,
    "line_items[0][price_data][product_data][description]": `Outstanding balance for ${invoice.clientName}`,
    "line_items[0][price_data][unit_amount]": String(invoice.balanceMinor),
    "line_items[0][quantity]": "1",
  });
  return stripeRequest("/v1/checkout/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

export async function retrieveCheckoutSession(sessionId) {
  return stripeRequest(
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export function verifyStripeWebhook(rawBody, signatureHeader) {
  const secret = clean(process.env.STRIPE_WEBHOOK_SECRET);
  if (!secret.startsWith("whsec_"))
    throw Object.assign(new Error("Stripe webhook is not configured"), {
      status: 409,
    });
  const parts = String(signatureHeader ?? "").split(",");
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  if (!timestamp || !signatures.length)
    throw Object.assign(new Error("Invalid Stripe signature"), { status: 400 });
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
    throw Object.assign(new Error("Expired Stripe signature"), { status: 400 });
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  if (!signatures.some((signature) => safeEqual(signature, expected)))
    throw Object.assign(new Error("Invalid Stripe signature"), { status: 400 });
  try {
    return JSON.parse(rawBody);
  } catch {
    throw Object.assign(new Error("Invalid Stripe event"), { status: 400 });
  }
}
