# Invoice Desk

**A tiny, self-hosted invoicing app for people who want to send the invoice and get back to work.**

Invoice Desk started as an internal tool for a small professional-management team. It is intentionally compact: no dashboards full of accounting jargon, no currency conversion guesses, and no framework-sized dependency tree.

> [!IMPORTANT]
> Invoice Desk is early beta software, not accounting, tax, or legal advice. It is designed for local or private-network self-hosting. Do not expose the development server directly to the public Internet.

## What it does

- Saves reusable clients, business details, services, and normal prices
- Edits client contact details and keeps private notes off invoices
- Creates CAD and USD invoice drafts
- Fills invoice lines from the saved service catalogue
- Calculates percentage-based fees without a spreadsheet
- Adds Québec GST (5%) and QST (9.975%) or custom tax lines
- Assigns invoice numbers only when a draft is finalized
- Freezes finalized invoice data and saves the exact PDF
- Duplicates an earlier invoice into a new editable draft
- Tracks partial, final, Stripe, and corrected payments
- Creates optional Stripe-hosted Checkout links for the exact unpaid balance
- Sends invoices and PDF attachments through optional send-only Gmail authorization
- Uses a persistent outbox, safe preview mode, retries, and duplicate-send protection
- Sends small, selected-client email campaigns as separate messages through Gmail
- Records express, time-limited implied, needs-review, and unsubscribed marketing states
- Rechecks permission before every campaign message and limits each send to 50 recipients
- Exports formula-safe invoice and payment CSV files
- Downloads a monthly accountant ZIP with PDFs, records, GST/QST totals, and revenue by category
- Imports authorized FreshBooks client and item exports with duplicate-safe reruns
- Keeps an audit-friendly history for payment corrections and voided invoices

## Deliberate limitations

This is not a multi-tenant SaaS platform. One installation represents one business and uses one shared application password. It does not include expense accounting, payroll, bank feeds, exchange-rate conversion, tax filing, automated unsubscribe web links, bounce processing, delivery analytics, or open tracking.

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
| `INVOICE_DESK_TOKEN_SECRET` | Long secret used to encrypt a connected Gmail refresh token |
| `INVOICE_DESK_SECURE_COOKIES` | `true` for HTTPS deployments; local Compose defaults to `false` |
| `STRIPE_SECRET_KEY` | Optional Stripe test or live secret key |
| `STRIPE_SUCCESS_URL` | Required HTTPS return page when Stripe is enabled |
| `STRIPE_CANCEL_URL` | Optional HTTPS cancellation page |
| `STRIPE_WEBHOOK_SECRET` | Optional hosted-deployment webhook signing secret |
| `GOOGLE_CLIENT_ID` | Optional Google OAuth web-client ID for Gmail sending |
| `GOOGLE_CLIENT_SECRET` | Optional Google OAuth web-client secret |
| `GOOGLE_REDIRECT_URI` | Gmail OAuth callback; defaults to the local Invoice Desk callback |

The server refuses to listen beyond the local computer unless an explicit password and session secret are configured.

When a reverse proxy provides HTTPS, set `INVOICE_DESK_SECURE_COOKIES=true`. The included Compose file binds only to `127.0.0.1` and therefore defaults this setting to `false` for local HTTP access.

## Stripe

Start in Stripe test mode. On Windows, `Configure Stripe.cmd` stores Stripe values as user-level environment variables. On other platforms, use environment variables or your host's secret manager.

Never paste Stripe secrets into a client record, invoice, payment instructions, issue, chat, or committed configuration file. Each self-hosted installation uses its owner's Stripe account.

The signed webhook endpoint is `POST /api/stripe/webhook`. Keep all other application routes behind authentication.

## Gmail delivery

Without Google credentials, **Review & Send** stays in safe preview mode and transmits nothing. To enable sending:

1. Enable the Gmail API in a Google Cloud project and create an OAuth 2.0 **Web application** client.
2. Add `http://127.0.0.1:3210/api/gmail/callback` as an authorized redirect URI for local use, or use your deployed HTTPS callback.
3. On Windows, double-click `Configure Gmail.cmd`; on other platforms, set the Google variables and a long `INVOICE_DESK_TOKEN_SECRET` through your host's secret manager.
4. Restart Invoice Desk, enter the Gmail or Google Workspace address as the business billing email, and select **Connect Gmail** in Settings.
5. Approve the single Gmail send scope and test with an address you control before emailing clients.

Invoice Desk cannot read the connected inbox. The Google refresh token is encrypted before SQLite storage. Every installation must use its own Google OAuth application credentials; no credentials are included in this repository.

### Selected-client campaigns

Campaign email is deliberately conservative. New and imported clients default to **Needs review** and cannot receive a campaign. An operator must record express consent or a still-valid implied-consent expiry date. Unsubscribed clients are always blocked, and eligibility is checked again immediately before each individual message is sent.

Every campaign message includes the business identity, mailing address, contact email, and instructions to unsubscribe by reply or email. The app also adds a `List-Unsubscribe` mailto header. It sends separate messages—never a visible recipient list—and limits one action to 50 recipients.

Operators remain responsible for determining whether they have lawful permission, keeping adequate consent evidence, promptly recording unsubscribe requests, and following the laws that apply to them. For Canadian use, review the [CRTC’s CASL guidance](https://crtc.gc.ca/eng/com500/guide.htm). This feature is not legal advice or a replacement for a dedicated marketing platform when automation, one-click web unsubscribe, bounce handling, or high-volume delivery is required.

## Data and backups

Private state lives in `data/` by default. That directory is ignored by Git and must be stored on a persistent, access-controlled disk.

```bash
node scripts/backup.mjs backup
node scripts/backup.mjs smoke
node scripts/backup.mjs restore /path/to/backup /empty/restore-folder
```

Backups include SQLite and issued PDFs. Restore refuses to overwrite a non-empty folder and checks database integrity and PDF completeness.

## FreshBooks import

Back up Invoice Desk, export the authorized client and item CSV files from FreshBooks, then run:

```bash
npm run import:freshbooks -- "/path/to/FreshBooks export" CAD
```

Use `USD` instead of `CAD` when appropriate. The importer adds or updates clients and saved services without importing bookkeeping history. Missing client details are preserved for review instead of being silently discarded.

## Test

```bash
node --test
```

Tests cover financial rounding, Québec taxes, concurrent invoice numbering, immutable records and PDFs, currency separation, saved services, client editing, invoice duplication, payments and corrections, void-and-reissue, safe exports, monthly accountant ZIPs, consent-aware campaigns, Gmail authorization and delivery, exact Stripe amounts, and signed webhooks.

## Email safety

**Review & Send** finalizes a draft only once, saves the exact PDF, and creates one client email record. In preview mode, the message is saved without being transmitted. With Gmail connected, Invoice Desk marks the message as accepted only after Gmail returns a message ID. Failed messages can be retried without assigning another invoice number, while accepted messages are protected from duplicate sends.

## Security

Read [SECURITY.md](SECURITY.md) before sharing an installation. The repository excludes application data and secrets, but operators remain responsible for access control, HTTPS, backups, updates, and compliance appropriate to their use.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and use fictional data in every report and test.

## License

MIT — use it, modify it, and build on it. See [LICENSE](LICENSE).
