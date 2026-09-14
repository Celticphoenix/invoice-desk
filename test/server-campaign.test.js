import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function freePort() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

test("sends an eligible campaign individually and will not send it twice", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "invoice-desk-campaign-"));
  const tokenSecret = "fictional-campaign-encryption-secret";
  process.env.INVOICE_DESK_DATA_ROOT = dataRoot;
  process.env.INVOICE_DESK_TOKEN_SECRET = tokenSecret;
  const core = await import(`../src/core.js?campaign=${Date.now()}`);
  const email = await import(`../src/email.js?campaign=${Date.now()}`);
  const settings = core.dashboard().settings;
  core.saveSettings({
    ...settings,
    name: "Fictional Agency",
    email: "sender@example.test",
    address: "123 Fictional Business Street, Montreal, QC",
  });
  const client = core.createClient({
    name: "Fictional Recipient",
    email: "recipient@example.test",
    marketingStatus: "express",
    marketingConsentSource: "Fictional test fixture",
  });
  const campaign = core.saveCampaign({
    name: "Fictional campaign",
    subject: "Fictional subject",
    bodyText: "This message is generated only by an automated test.",
    clientIds: [client.id],
  });
  core.saveGmailConnection({
    email: "sender@example.test",
    refreshTokenCipher: email.encryptRefreshToken("fictional-refresh-token"),
  });
  core.closeDatabase();
  delete process.env.INVOICE_DESK_DATA_ROOT;
  delete process.env.INVOICE_DESK_TOKEN_SECRET;

  let sends = 0;
  const gmail = createServer(async (request, response) => {
    for await (const _chunk of request) void _chunk;
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/token")
      return response.end(JSON.stringify({ access_token: "fictional-access-token" }));
    sends += 1;
    return response.end(JSON.stringify({ id: `fictional-message-${sends}` }));
  });
  await new Promise((resolve) => gmail.listen(0, "127.0.0.1", resolve));
  const gmailBase = `http://127.0.0.1:${gmail.address().port}`;
  const appPort = await freePort();
  const app = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      INVOICE_DESK_PORT: String(appPort),
      INVOICE_DESK_DATA_ROOT: dataRoot,
      INVOICE_DESK_TOKEN_SECRET: tokenSecret,
      GOOGLE_CLIENT_ID: "fictional-client-id",
      GOOGLE_CLIENT_SECRET: "fictional-client-secret",
      GOOGLE_TOKEN_BASE: `${gmailBase}/token`,
      GMAIL_API_BASE: gmailBase,
      STRIPE_SECRET_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Invoice Desk did not start")), 5000);
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
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const action = async (payload) => {
      const response = await fetch(`${origin}/api/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      assert.equal(response.status, 200, result.error);
      return result;
    };
    const first = await action({ action: "send-campaign", campaignId: campaign.id });
    const second = await action({ action: "send-campaign", campaignId: campaign.id });
    assert.equal(first.status, "sent");
    assert.equal(second.status, "sent");
    assert.equal(first.recipients[0].status, "sent");
    assert.equal(sends, 1);
  } finally {
    app.kill("SIGTERM");
    await new Promise((resolve) => app.once("exit", resolve));
    await new Promise((resolve) => gmail.close(resolve));
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
