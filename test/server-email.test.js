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

test("finalizes once and captures duplicate-safe email previews", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "invoice-desk-email-"));
  const appPort = await freePort();
  const app = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      INVOICE_DESK_PORT: String(appPort),
      INVOICE_DESK_DATA_ROOT: dataRoot,
      STRIPE_SECRET_KEY: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
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
        name: "Email Preview Client",
        email: "preview@example.test",
        company: "",
        address: "Montreal, QC",
      },
    });
    const draft = await action({
      action: "save-draft",
      invoice: {
        clientId: client.id,
        currency: "CAD",
        issueDate: "2026-09-14",
        dueDate: "2026-10-14",
        terms: "Net 30",
        notes: "",
        lines: [
          {
            description: "Fictional service",
            category: "Other",
            quantity: "1",
            rateMinor: 10000,
          },
        ],
        taxes: [],
      },
    });
    const first = await action({ action: "review-send", invoiceId: draft.id });
    const second = await action({ action: "review-send", invoiceId: draft.id });
    assert.equal(first.status, "preview");
    assert.equal(second.id, first.id);
    const dashboard = await fetch(`${origin}/api/dashboard`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json());
    assert.equal(dashboard.invoices[0].state, "issued");
    assert.equal(dashboard.emailOutbox.length, 1);
    assert.equal(dashboard.email.mode, "preview");
  } finally {
    app.kill("SIGTERM");
    await new Promise((resolve) => app.once("exit", resolve));
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
