# Invoice Desk

**A tiny, self-hosted invoicing app for people who want to send the invoice and get back to work.**

Invoice Desk started as an internal tool for a small professional-management team. It is intentionally compact: no dashboards full of accounting jargon, no currency conversion guesses, and no framework-sized dependency tree.

> [!IMPORTANT]
> Invoice Desk is early beta software, not accounting, tax, or legal advice. It is designed for local or private-network self-hosting. Do not expose the development server directly to the public Internet.

## What it does

- Saves reusable clients and business details
- Creates CAD and USD invoice drafts
- Adds Québec GST (5%) and QST (9.975%) or custom tax lines
- Assigns invoice numbers only when a draft is finalized
- Freezes finalized invoice data and saves the exact PDF
- Tracks partial, final, Stripe, and corrected payments
- Creates optional Stripe-hosted Checkout links for the exact unpaid balance
- Exports formula-safe invoice and payment CSV files
- Downloads an accountant ZIP containing PDFs, records, and separate GST/QST totals
- Keeps an audit-friendly history for payment corrections and voided invoices

## Deliberate limitations

This is not a multi-tenant SaaS platform. One installation represents one business and uses one shared application password. It does not include expense accounting, payroll, bank feeds, automatic email delivery, exchange-rate conversion, or tax filing.

## Quick start

Requires Node.js 22.5 or newer. There are no package dependencies to install.

```bash
git clone https://github.com/Celticphoenix/invoice-desk.git
cd invoice-desk
node src/server.js
```

Open `http://127.0.0.1:3210` and use the development password `invoice-demo`.

Windows users can double-click `Start Invoice Desk.cmd`.

### Docker

Copy `.env.example` to `.env`, add a long password and session secret, then run:

```bash
docker compose up --build -d
```

The Compose configuration exposes Invoice Desk only on the host's loopback interface. Put a shared deployment behind an authenticated HTTPS reverse proxy or private network gateway; do not simply change it to a public port.

## Configuration

| Variable | Purpose |
| --- | --- |
| `INVOICE_DESK_HOST` | Listening address; defaults to `127.0.0.1` |
| `INVOICE_DESK_PORT` | HTTP port; defaults to `3210` |
| `INVOICE_DESK_DATA_ROOT` | Persistent private database and PDF directory |
| `INVOICE_DESK_PASSWORD` | Application password; required in production |
| `INVOICE_DESK_SESSION_SECRET` | Long random session-signing secret; required in production |
| `INVOICE_DESK_SECURE_COOKIES` | `true` for HTTPS deployments; local Compose defaults to `false` |
| `STRIPE_SECRET_KEY` | Optional Stripe test or live secret key |
| `STRIPE_SUCCESS_URL` | Required HTTPS return page when Stripe is enabled |
| `STRIPE_CANCEL_URL` | Optional HTTPS cancellation page |
| `STRIPE_WEBHOOK_SECRET` | Optional hosted-deployment webhook signing secret |

The server refuses to listen beyond the local computer unless an explicit password and session secret are configured.

When a reverse proxy provides HTTPS, set `INVOICE_DESK_SECURE_COOKIES=true`. The included Compose file binds only to `127.0.0.1` and therefore defaults this setting to `false` for local HTTP access.

## Stripe

Start in Stripe test mode. On Windows, `Configure Stripe.cmd` stores Stripe values as user-level environment variables. On other platforms, use environment variables or your host's secret manager.

Never paste Stripe secrets into a client record, invoice, payment instructions, issue, chat, or committed configuration file. Each self-hosted installation uses its owner's Stripe account.

The signed webhook endpoint is `POST /api/stripe/webhook`. Keep all other application routes behind authentication.

## Data and backups

Private state lives in `data/` by default. That directory is ignored by Git and must be stored on a persistent, access-controlled disk.

```bash
node scripts/backup.mjs backup
node scripts/backup.mjs smoke
node scripts/backup.mjs restore /path/to/backup /empty/restore-folder
```

Backups include SQLite and issued PDFs. Restore refuses to overwrite a non-empty folder and checks database integrity and PDF completeness.

## Test

```bash
node --test
```

Tests cover financial rounding, Québec taxes, concurrent invoice numbering, immutable records and PDFs, currency separation, payments and corrections, void-and-reissue, safe exports, accountant ZIPs, exact Stripe amounts, and signed webhooks.

## Security

Read [SECURITY.md](SECURITY.md) before sharing an installation. The repository excludes application data and secrets, but operators remain responsible for access control, HTTPS, backups, updates, and compliance appropriate to their use.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and use fictional data in every report and test.

## License

MIT — use it, modify it, and build on it. See [LICENSE](LICENSE).
