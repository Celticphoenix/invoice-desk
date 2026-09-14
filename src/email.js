import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

const GOOGLE_AUTH_BASE =
  process.env.GOOGLE_AUTH_BASE ?? "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_BASE =
  process.env.GOOGLE_TOKEN_BASE ?? "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_BASE =
  process.env.GOOGLE_USERINFO_BASE ?? "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_API_BASE =
  process.env.GMAIL_API_BASE ?? "https://gmail.googleapis.com/gmail/v1";

function config() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ??
      "http://127.0.0.1:3210/api/gmail/callback",
  };
}

function tokenKey() {
  const secret =
    process.env.INVOICE_DESK_TOKEN_SECRET ??
    process.env.INVOICE_DESK_SESSION_SECRET ??
    (process.env.NODE_ENV === "production"
      ? ""
      : "local-invoice-desk-session-only");
  if (!secret)
    throw Object.assign(
      new Error("Set INVOICE_DESK_TOKEN_SECRET before connecting Gmail"),
      { status: 503 },
    );
  return createHash("sha256").update(secret).digest();
}

export function gmailStatus(connection) {
  const value = config();
  const configured = Boolean(value.clientId && value.clientSecret && value.redirectUri);
  return {
    configured,
    connected: Boolean(connection),
    email: connection?.email ?? "",
    mode: configured ? "gmail" : "preview",
    redirectUri: value.redirectUri,
  };
}

export function encryptRefreshToken(refreshToken) {
  if (!refreshToken) throw new Error("Google did not return a refresh token");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(refreshToken, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptRefreshToken(value) {
  const [version, iv, tag, encrypted] = String(value ?? "").split(".");
  if (version !== "v1" || !iv || !tag || !encrypted)
    throw new Error("Stored Gmail authorization is invalid");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    tokenKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function gmailAuthorizationUrl(state, loginHint) {
  const value = config();
  if (!value.clientId || !value.clientSecret)
    throw Object.assign(
      new Error("Configure Google email credentials before connecting Gmail"),
      { status: 503 },
    );
  const url = new URL(GOOGLE_AUTH_BASE);
  url.search = new URLSearchParams({
    client_id: value.clientId,
    redirect_uri: value.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    scope:
      "openid email https://www.googleapis.com/auth/gmail.send",
    state,
    login_hint: loginHint,
  });
  return url.toString();
}

async function googleRequest(url, options, label) {
  const response = await fetch(url, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(`${label} failed${result.error_description ? `: ${result.error_description}` : ""}`),
      { status: 502 },
    );
  return result;
}

export async function exchangeGmailCode(code) {
  const value = config();
  const tokens = await googleRequest(
    GOOGLE_TOKEN_BASE,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: value.clientId,
        client_secret: value.clientSecret,
        redirect_uri: value.redirectUri,
        grant_type: "authorization_code",
      }),
    },
    "Google authorization",
  );
  if (!tokens.access_token || !tokens.refresh_token)
    throw Object.assign(
      new Error("Google did not return the required email authorization"),
      { status: 502 },
    );
  const profile = await googleRequest(
    GOOGLE_USERINFO_BASE,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    "Google account check",
  );
  if (!profile.email || profile.email_verified === false)
    throw Object.assign(new Error("Google did not confirm the email address"), {
      status: 502,
    });
  return {
    email: String(profile.email).toLowerCase(),
    refreshToken: tokens.refresh_token,
  };
}

async function accessToken(connection) {
  const value = config();
  const tokens = await googleRequest(
    GOOGLE_TOKEN_BASE,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: value.clientId,
        client_secret: value.clientSecret,
        refresh_token: decryptRefreshToken(connection.refreshTokenCipher),
        grant_type: "refresh_token",
      }),
    },
    "Gmail sign-in refresh",
  );
  if (!tokens.access_token)
    throw Object.assign(new Error("Gmail did not return a sending token"), {
      status: 502,
    });
  return tokens.access_token;
}

function header(value, name) {
  const clean = String(value ?? "").trim();
  if (!clean || /[\r\n]/.test(clean)) throw new Error(`${name} is invalid`);
  return clean;
}

function base64Lines(value) {
  return Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function mimeMessage(payload, fromEmail) {
  const boundary = `invoice-desk-${randomUUID()}`;
  const filename = header(payload.pdf.filename, "PDF filename").replaceAll('"', "");
  const message = [
    `From: ${header(payload.businessName ?? "Invoice Desk", "Sender name")} <${header(fromEmail, "Sender")}>`,
    `To: ${header(payload.recipientEmail, "Recipient")}`,
    `Subject: ${header(payload.subject, "Subject")}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(payload.bodyText),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(payload.pdf.bytes),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

export async function sendGmailMessage(payload, connection) {
  if (!connection) throw new Error("Connect Gmail before sending");
  const token = await accessToken(connection);
  const result = await googleRequest(
    `${GMAIL_API_BASE}/users/me/messages/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: mimeMessage(payload, connection.email) }),
    },
    "Gmail send",
  );
  if (!result.id)
    throw Object.assign(new Error("Gmail accepted no message identifier"), {
      status: 502,
    });
  return { id: result.id };
}
