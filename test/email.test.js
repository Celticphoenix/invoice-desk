import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

afterEach(() => {
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "INVOICE_DESK_TOKEN_SECRET",
  ])
    delete process.env[name];
});

test("encrypts Gmail refresh tokens and requests send-only access", async () => {
  process.env.GOOGLE_CLIENT_ID = "fictional.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "fictional-client-secret";
  process.env.GOOGLE_REDIRECT_URI =
    "http://127.0.0.1:3210/api/gmail/callback";
  process.env.INVOICE_DESK_TOKEN_SECRET = "fictional-test-encryption-secret";
  const email = await import(`../src/email.js?test=${Date.now()}`);
  const cipher = email.encryptRefreshToken("fictional-refresh-token");
  assert.equal(cipher.includes("fictional-refresh-token"), false);
  assert.equal(email.decryptRefreshToken(cipher), "fictional-refresh-token");
  const url = new URL(
    email.gmailAuthorizationUrl("fictional-state", "sender@example.test"),
  );
  assert.equal(url.searchParams.get("state"), "fictional-state");
  assert.equal(url.searchParams.get("login_hint"), "sender@example.test");
  assert.match(
    url.searchParams.get("scope"),
    /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/,
  );
  assert.doesNotMatch(url.searchParams.get("scope"), /gmail\.readonly/);
});
