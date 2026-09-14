# Optional launch copy

## Short post

I built a tiny invoicing app because most invoicing software feels heavier than the job.

Invoice Desk is free, open source, self-hosted, and intentionally boring: saved clients and services, invoices, Québec taxes, PDFs, payment tracking, optional Gmail and Stripe connections, accountant-ready exports, and now small consent-aware client email campaigns.

It started as an internal tool. I am sharing the code in case it is useful to another small team—and in case someone wants to make it better.

## LinkedIn post — version 1.2

What started as a small internal invoicing tool keeps teaching me what a real workflow actually needs.

The newest addition to Invoice Desk is deliberately modest: selected-client email campaigns. You record whether a client has express consent, time-limited implied consent, needs review, or has unsubscribed. The app blocks ineligible contacts, rechecks them before sending, and emails each approved person separately through Gmail. No visible mailing list and no tracking pixels.

It is still mainly an invoicing app: saved clients and prices, frozen PDFs, Québec GST/QST, payment tracking, optional Stripe and Gmail, and a monthly accountant package. It is not trying to become full accounting software or a full marketing platform.

I made it for a small team that needed something simple enough to understand without training. I have released the generic version free and open source under the MIT licence in case it helps someone else—or gives a developer a useful starting point.

It is early beta software, so please use fictional data while testing and read the setup and security notes before hosting it.

https://github.com/Celticphoenix/invoice-desk

If you try it, I would genuinely like to hear what feels confusing, useful, or unnecessary.

#OpenSource #SmallBusiness #Invoicing #BuildInPublic #SelfHosted #CanadianBusiness

## Suggested repository description

A tiny, self-hosted invoicing app for small teams—saved services, Gmail delivery, consent-aware campaigns, PDFs, payments, Québec taxes, Stripe Checkout, and monthly accountant exports.

## Comparison graphic

Use `invoice-desk-comparison.png` as the optional LinkedIn image. The comparison is intentionally narrow and includes the limitation that Invoice Desk is focused invoicing rather than full accounting software. Pricing and plan claims are documented in `comparison-notes.md`.
