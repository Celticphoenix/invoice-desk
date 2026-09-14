import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";

let server;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "GOOGLE_TOKEN_BASE",
    "GOOGLE_USERINFO_BASE",
    "GMAIL_API_BASE",
    "INVOICE_DESK_TOKEN_SECRET",
  ])
    delete process.env[name];
});

test("exchanges Google authorization and sends a PDF through Gmail", async () => {
  const requests = [];
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/token")
      return response.end(
        JSON.stringify({
          access_token: "fictional-access-token",
          refresh_token: body.includes("authorization_code")
            ? "fictional-refresh-token"
            : undefined,
        }),
      );
    if (request.url === "/userinfo")
      return response.end(
        JSON.stringify({ email: "sender@example.test", email_verified: true }),
      );
    return response.end(JSON.stringify({ id: "gmail-message-123" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.GOOGLE_CLIENT_ID = "fictional.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "fictional-client-secret";
  process.env.GOOGLE_REDIRECT_URI = "http://127.0.0.1/callback";
  process.env.GOOGLE_TOKEN_BASE = `${base}/token`;
  process.env.GOOGLE_USERINFO_BASE = `${base}/userinfo`;
  process.env.GMAIL_API_BASE = base;
  process.env.INVOICE_DESK_TOKEN_SECRET = "fictional-test-encryption-secret";
  const email = await import(`../src/email.js?gmail=${Date.now()}`);
  const authorization = await email.exchangeGmailCode("fictional-code");
  assert.equal(authorization.email, "sender@example.test");
  const sent = await email.sendGmailMessage(
    {
      recipientEmail: "client@example.test",
      subject: "Invoice INV-TEST",
      bodyText: "A fictional invoice is attached.",
      pdf: { filename: "INV-TEST.pdf", bytes: Buffer.from("%PDF-fictional") },
    },
    {
      email: authorization.email,
      refreshTokenCipher: email.encryptRefreshToken(authorization.refreshToken),
    },
  );
  assert.equal(sent.id, "gmail-message-123");
  const gmailRequest = requests.find((entry) =>
    entry.url.includes("/users/me/messages/send"),
  );
  assert.equal(gmailRequest.authorization, "Bearer fictional-access-token");
  const raw = JSON.parse(gmailRequest.body).raw;
  const mime = Buffer.from(raw, "base64url").toString();
  assert.match(mime, /To: client@example\.test/);
  assert.match(mime, /Subject: Invoice INV-TEST/);
  assert.match(mime, /INV-TEST\.pdf/);
});
