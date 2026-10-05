# Subagents in this repo

`.claude/agents/` is flat — Claude Code does not support nesting agent definitions the way project skills nest under a domain folder. This page is the index: the tier table an orchestrator uses to pick a model and effort level, the role agents that carry those tiers, the Razorpay vendor pack, and the dispatch rule that ties them together.

## The tier table

The full rationale — session-budget economics, the resume-from-worktree pattern, and the worked example that motivated the split — lives in `.claude/skills/workflow/references/model-orchestration.md`. The summary:

| Role                                            | Model                                  | Effort                                                      | Why                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Advisor (judgment, not keystrokes)              | Fable                                  | max (audit/design day) or high (orchestration day)          | Owns architecture and doctrine decisions, money-path review, adversarial verification of other agents' claims. Costs roughly 2× Opus per token, so it should write specs an executor can run without judgment calls rather than execute breadth work itself. |
| Teacher (executes complex, well-specified work) | Opus                                   | high (build a PR) or medium (triage)                        | Multi-file coherence in money code, and claim-vs-code verification on review threads.                                                                                                                                                                        |
| Student (mechanical breadth)                    | Sonnet, or Haiku for the smallest jobs | medium (doc regen, enumeration) or low (rename, lint sweep) | Regenerates a reference doc, sweeps unused imports, applies an already-decided change across many files.                                                                                                                                                     |

## The role agents

| Agent           | Model  | Effort | Role                                                                                                                                                                                                                   |
| --------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr-builder.md` | opus   | high   | Builds or resumes one PR from a numbered spec inside a dedicated worktree. The multi-file-coherence executor for money code.                                                                                           |
| `pr-triager.md` | opus   | medium | Review-comment triage on a non-money PR (docs, cron plumbing, UI, config), checking each claim against current code. Money-semantics threads are reported as needs-decision, never changed.                            |
| `sweeper.md`    | sonnet | medium | Mechanical breadth work with some judgment — E2E scenarios, docs regeneration, cron plumbing, a small Netlify function.                                                                                                |
| `mechanic.md`   | sonnet | low    | Purely mechanical breadth work — relabels, formatting, YAML sweeps, rename/lint passes, doc regeneration from an already-written verdict.                                                                              |
| `qa-preview.md` | sonnet | xhigh  | End-to-end QA of one pull request on its Netlify deploy preview — chrome-devtools for the browser, the Supabase MCP for money truth, the Sentry MCP for the release sweep; writes a per-case report, never edits code. |

## The `razorpay-*` pack

Nine vendor-specific agents operate on and audit this repo's Razorpay and RazorpayX integration (`Prisma` + `BigInt` paise, Orders/Standard Checkout, saved cards, webhooks, two-phase refunds, REST disputes API, RazorpayX payouts + Penny Drop / Reverse Penny Drop, and in-house GST invoicing): `razorpay-setup`, `razorpay-one-time-payment`, `razorpay-subscription`, `razorpay-webhook`, `razorpay-test-webhook`, `razorpay-invoice`, `razorpay-db-schema`, `razorpay-diagnostics`, and `razorpay-code-audit`. They are narrower and more mechanical than the role agents above, are scoped to Razorpay integration code specifically, and are documented in full at `.claude/skills/finance/references/razorpay/README.md`.

## The multi-gateway & cross-border pack

Four gateway-expansion and compliance agents cover our sanctioned backup gateways, foreign consultant payout treasury, high-ticket B2B export rail, and MoR/FEMA regulatory guardrails (documented in `.claude/skills/finance/references/gateways/README.md` and `docs/payments/gateways/gateway-evaluation-2026.md`):

| Agent | Scope |
| --- | --- |
| `cashfree-integration.md` | **Cashfree Payments (`CASHFREE`) & Cashfree Payouts v2**: Our #1 full-stack domestic + PA-CB backup to Razorpay PG and RazorpayX Payouts (`x-api-version: 2025-01-01`, decimal rupee conversion at boundary vs `BigInt` paise in Prisma, `x-webhook-timestamp + rawBody` base64 HMAC, Secure ID Penny Drop / Reverse Penny Drop, and Easy Split). |
| `tazapay-global-payouts.md` | **Tazapay (`TAZAPAY`) Global Checkout & Foreign Consultant Payouts**: 80+ local collection rails in 173+ countries + multi-currency `USD`/`EUR`/`GBP` treasury to pay foreign (non-Indian) consultants in 70+ countries (`POST /v3/payout`, `purpose: "PYR003"`) without double-FX conversion or Indian Section 393 / Forms 145 & 146 (pre-cutover Section 195 / Forms 15CA & 15CB) friction. |
| `xflow-b2b-export.md` | **Xflow (`XFLOW`) High-Ticket (`>= $500`) & B2B Export Collection**: Stripe + JPMorgan Chase N.A. local USD/EUR/GBP accounts (`0.4%–0.6%` tiered fee, `0%` FX markup over live Google rate, `POST /v1/receivables` with export invoice & RBI purpose code `P1006`, `Webhook-Id` / `Webhook-Timestamp` / `Webhook-Signature` Base64 verification, and 24-hour automated `e-FIRA`). |
| `gateway-compliance-advisor.md` | **Regulatory & Gateway Routing Guardrails**: Enforces why **Dodo Payments (`DODO_PAYMENTS`)** and **Polar.sh** are disqualified for 1:1 consulting and marketplaces under their official AUPs (Dodo Clauses #2/#10/#14/#30/#31 + $425k fine; Polar Items #2/#4), US LLC FEMA Overseas Direct Investment (ODI) rules (`Form FC` + `UIN` + `APR` + IRS `Form 5472`), and RBI PA-CB limits. |

## Dispatch rule

Money code goes to `pr-builder` at opus/high. Money review triage also goes to `pr-builder`, because verifying a reviewer's claim against money-path code needs the same multi-file coherence as building the code did. Non-money triage goes to `pr-triager`. Docs work goes to `sweeper`; end-to-end preview QA goes to `qa-preview`. Purely mechanical work goes to `mechanic`.
