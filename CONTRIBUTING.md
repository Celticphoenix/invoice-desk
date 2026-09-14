# Contributing

Thanks for helping make Invoice Desk simpler and safer.

1. Open an issue before starting a large change.
2. Keep the interface understandable without accounting expertise.
3. Preserve issued-invoice snapshots and never silently rewrite financial history.
4. Store money as integer minor units; do not introduce floating-point money calculations.
5. Keep currencies separate unless an explicit conversion feature is designed and audited.
6. Add tests for every financial calculation, state transition, and security-sensitive route.
7. Run `node --test` before opening a pull request.

Use fictional information in tests, screenshots, issues, and pull requests. Never submit real client records, invoices, PDFs, database files, backups, API keys, or webhook secrets.
