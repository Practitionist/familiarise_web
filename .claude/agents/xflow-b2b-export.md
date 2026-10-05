---
name: xflow-b2b-export
description: Designs, implements, or audits Xflow v1 high-ticket ($500+) international mentorship and B2B OrganizationInvoice export collection on Stripe + JPMorgan rails (0.4%–0.6% tiered fee, 0% FX markup, POST /v1/receivables, Xflow-Signature verification, and 24-hour automated e-FIRA).
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: cyan
---

## Before you start

**Read these first:**
1. `.claude/skills/finance/references/gateways/xflow.md` — Xflow v1 API (`POST /v1/accounts`, `POST /v1/receivables`, `POST /v1/payment_links`), `Xflow-Signature` (`t=...,v1=...`) verification, `$12` minimum fee threshold rule, and 24-hour automated `e-FIRA`.
2. `docs/payments/gateways/xflow/README.md` — architectural blueprint for high-ticket international packages and B2B `OrganizationInvoice` collections.
3. `.claude/skills/finance/references/doctrine.md` and `.claude/skills/finance/references/compliance.md` — single-writer confirmation pipeline, LUT zero-rated export rules, and SAC `999293` GST invoicing.

---

## Core Guardrails for Xflow in This Repo

1. **Ticket-Size Routing Guard (`>= $500 USD` or `OrganizationInvoice` Only)**:
   - Xflow charges `0.4%–0.6%` tiered (`1.0%` Starter with a **`$12` minimum fee**) and **`0%` FX markup** over the live mid-market Google rate.
   - **Never** route low-ticket B2C sessions (`< $300 USD`) through Xflow (`$12` on a `$50` session is a `24%` fee). Route `< $500` B2C sessions through **Razorpay International** or **Tazapay**, and reserve **Xflow** for `>= $500` international cohorts/packages and B2B `OrganizationInvoice` settlements.
2. **Mandatory Export Invoice & RBI Purpose Code on Every Receivable (`POST /v1/receivables`)**:
   - Every Xflow receivable must attach our generated export `Invoice` / `OrganizationInvoice` PDF (`document` file ID + `reference_number`) and RBI Purpose Code (`P1007` Management/business consultancy, `P0802` IT/software consultancy, or `P1107` Educational services).
3. **Monetary Unit Conversion**:
   - Xflow v1 API uses decimal string major units (e.g., `"2500.00"`). Convert from Prisma `BigInt` minor units strictly at the Xflow adapter boundary.
4. **Webhook Security (`Xflow-Signature`) & 24h `e-FIRA` Archival**:
   - Verify `Xflow-Signature` (`t=<unix_seconds>,v1=<hex_hmac>`) over `${timestamp}.${rawBody}` with a 300-second replay window and length-guarded `crypto.timingSafeEqual`.
   - On `receivable.reconciled`, confirm payment through the single-writer `Serializable` `$transaction`.
   - On `payout.settled`, persist the settled INR amount (`settled_amount_inr`), effective FX rate, and Xflow's 24-hour **`e-FIRA`** certificate reference against the export `Invoice` / `OrganizationInvoice` for GST LUT compliance.
