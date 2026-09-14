# Security policy

Invoice Desk handles business contact and financial records. Treat its data directory, backups, environment variables, and Stripe credentials as sensitive.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue. Use the repository's **Security** tab to open a private vulnerability report. Include the affected version, reproduction steps, and potential impact. Do not include real invoice data or credentials.

## Deployment boundary

Invoice Desk is a small self-hosted application, not a multi-tenant SaaS platform. Its built-in password is a second line of defence for a trusted small team; it is not intended to be the only control on a public Internet deployment.

- Keep the default server binding on `127.0.0.1` for local use.
- Put shared deployments behind HTTPS and an identity-aware proxy such as Cloudflare Access, Tailscale, or an equivalent trusted gateway.
- Set unique, long values for `INVOICE_DESK_PASSWORD` and `INVOICE_DESK_SESSION_SECRET`.
- Set `INVOICE_DESK_SECURE_COOKIES=true` whenever users reach the app over HTTPS.
- Store secrets in environment variables or a secret manager, never in source control.
- Restrict and back up the persistent data directory.
- Start with Stripe test mode and verify webhook signatures before accepting live payments.

The server refuses to bind beyond the local computer unless the password and session secret are explicitly configured.

## Supported version

Security fixes are applied to the latest version on the `main` branch. There are no long-term-support branches yet.
