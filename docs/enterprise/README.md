# Familiarise Enterprise — documentation

The **enterprise layer** is a capability-driven B2B surface on top of the marketplace: organizations sponsor and/or host, fund sessions through wallets / invoices / licenses, run programs with seat or credit caps, and settle money through a double-entry ledger. This folder is the engineer's map of it — the **banded folders** are written to be read **in order, as one continuous story**, each band building on the last: `00-foundations/` → `10-money-and-ledger/` → `20-iam-and-security/` → `30-programs-and-lifecycle/` → `40-compliance-and-data/` → `50-operations/` → `60-scenarios-and-verdicts/`, with `90-audits/` as the audit-artifacts annex and [`explainers/complete-guide`](explainers/complete-guide.md) as the parallel connective narrative.

> **New here?** Read [overview](00-foundations/01-overview.md) for the system shape, then [explainers/complete-guide](explainers/complete-guide.md) for the end-to-end narrative. For money specifically, start at [money-model-overview](10-money-and-ledger/01-money-model-overview.md) and walk the `10-money-and-ledger/` band.

---

## How to read this

```mermaid
flowchart LR
  START([new developer]) --> OV["00-foundations/<br/>overview · org-types · funding-and-programs"]
  OV --> PATH{your area?}
  PATH -->|money / ledger| MONEY["10-money-and-ledger/<br/>money-model · chart-of-accounts · postings · wallet<br/>booking→earnings · payouts · invoicing · payment-legs · integrity"]
  PATH -->|identity / SSO| IAM["roles-and-permissions (00-foundations/)<br/>20-iam-and-security/<br/>sso · jit · scim · rate-limiting · security-headers"]
  PATH -->|programs / app| PROG["30-programs-and-lifecycle/<br/>concurrency · programs · expert-lifecycle<br/>dashboard · discovery · feature-flags<br/>contract-lifecycle · cycle-engine"]
  PATH -->|compliance / data| COMP["40-compliance-and-data/<br/>compliance · deletion · data-export<br/>webhooks · workspace-prefs · integrations"]
  PATH -->|on-call / ops| OPS["50-operations/<br/>api-reference · route-migration · runbooks<br/>monitoring · system-events · payout-go-live"]
  PATH -->|sales / partners| SALES["60-scenarios-and-verdicts/<br/>scenarios · harness-verdict · design-partners"]
```

---

## Section map

| Band folder | Section | Docs |
| --- | --- | --- |
| `00-foundations/` | **Foundations** | overview, org types, funding & programs, roles, lifecycle, hierarchy |
| `10-money-and-ledger/` | **Money & ledger** | money model, chart of accounts, postings, wallet, booking→earnings, payouts, invoicing, payment legs, integrity |
| `20-iam-and-security/` | **IAM / SSO / security** | SSO, JIT, SCIM, rate-limiting, security headers |
| `30-programs-and-lifecycle/` | **Programs / dashboard / discovery / lifecycle** | concurrency & idempotency, programs, experts, dashboard, discovery, feature flags, contract lifecycle, cycle engine & rollover |
| `40-compliance-and-data/` | **Compliance / integrations / data** | compliance map, deletion, data export, outbound webhooks, workspace prefs, cross-cutting integrations |
| `50-operations/` | **Operations** | API reference, route migration, runbooks, monitoring, system events, live-payout go-live |
| `60-scenarios-and-verdicts/` | **Scenarios / verdict / partners** | worked scenarios, harness verdict, design-partner set |
| `90-audits/` | **Audit artifacts (annex)** | readiness audit, subsystem checklist, verification guide, simplification proposal, superseded 2026-05-02 production-grade checklist |

---

## Full index

### Foundations — `00-foundations/`
| # | Doc | Focus |
|---|---|---|
| 01 | [overview](00-foundations/01-overview.md) | system shape, master ER, capability model |
| 02 | [organization-types](00-foundations/02-organization-types.md) | `canSponsor`/`canHost` → BUYER/HOST/HYBRID/INERT |
| 03 | [funding-and-programs](00-foundations/03-funding-and-programs.md) | `FundingSource` enum + program subtypes |
| 04 | [roles-and-permissions](00-foundations/04-roles-and-permissions.md) | `MemberRole` ladder + every API gate |
| 05 | [organization-lifecycle](00-foundations/05-organization-lifecycle.md) | `OrgStatus` + contract/program state machines |
| 06 | [hierarchy](00-foundations/06-hierarchy.md) | `parentOrganizationId`/`rootOrganizationId` (UI deferred) |

### Money & ledger — `10-money-and-ledger/`
| # | Doc | Focus |
|---|---|---|
| 01 | [money-model-overview](10-money-and-ledger/01-money-model-overview.md) | integer paise, double-entry, derived balances, what #772 changed |
| 02 | [chart-of-accounts](10-money-and-ledger/02-chart-of-accounts.md) | the 10 accounts, normal sides, deterministic ids |
| 03 | [ledger-and-postings](10-money-and-ledger/03-ledger-and-postings.md) | `postLedgerTxn`, the balance invariant, every flow's legs |
| 04 | [wallet-and-topups](10-money-and-ledger/04-wallet-and-topups.md) | `WalletTopUp` lifecycle, wallet-as-cache |
| 05 | [booking-to-earnings](10-money-and-ledger/05-booking-to-earnings.md) | booking → earnings → bps split, rate cards |
| 06 | [payout-pipeline](10-money-and-ledger/06-payout-pipeline.md) | earnings roll-up → payout, TDS/MSME, `ORG_PAYOUT` |
| 07 | [invoicing](10-money-and-ledger/07-invoicing.md) | GST, IRN, PO match, `ORG_RECEIVABLE`, refunds |
| 08 | [payment-legs](10-money-and-ledger/08-payment-legs.md) | stackable funding legs → ledger debits |
| 09 | [ledger-integrity](10-money-and-ledger/09-ledger-integrity.md) | the reconciler: 7 checks + report |

### IAM / SSO / security — `20-iam-and-security/`
| # | Doc | Focus |
|---|---|---|
| 01 | [sso-and-authentication](20-iam-and-security/01-sso-and-authentication.md) | `OrganizationSSOSettings`, `SsoProvider`, domain claims |
| 02 | [jit-and-session-refresh](20-iam-and-security/02-jit-and-session-refresh.md) | JIT auto-join, `sessionGeneration`, role-change refresh |
| 03 | [scim-provisioning](20-iam-and-security/03-scim-provisioning.md) | SCIM tokens + provisioning |
| 04 | [rate-limiting](20-iam-and-security/04-rate-limiting.md) | coverage matrix; why BetterAuth's limiter is off |
| 05 | [security-headers](20-iam-and-security/05-security-headers.md) | CSP + header posture |

### Programs / dashboard / discovery / lifecycle — `30-programs-and-lifecycle/`
| # | Doc | Focus |
|---|---|---|
| 01 | [concurrency-and-idempotency](30-programs-and-lifecycle/01-concurrency-and-idempotency.md) | atomic patterns + every idempotency key |
| 02 | [programs](30-programs-and-lifecycle/02-programs.md) | program / assignment / `BookingUtilization` internals |
| 03 | [expert-lifecycle](30-programs-and-lifecycle/03-expert-lifecycle.md) | expert apply/approve; `PayoutRecipient` |
| 04 | [dashboard-pages](30-programs-and-lifecycle/04-dashboard-pages.md) | every `app/dashboard/organization/[orgId]/**` page |
| 05 | [public-pages-and-discovery](30-programs-and-lifecycle/05-public-pages-and-discovery.md) | org catalog, search, marketplace identity |
| 06 | [feature-flags-and-rollout](30-programs-and-lifecycle/06-feature-flags-and-rollout.md) | `ENABLE_HOST_ORGS` + capability-gated UI |
| 07 | [contract-lifecycle](30-programs-and-lifecycle/07-contract-lifecycle.md) | `Contract` state machine, auto-renew, supersession, end-early guard |
| 08 | [cycle-engine-and-rollover](30-programs-and-lifecycle/08-cycle-engine-and-rollover.md) | `ProgramAssignment` lifecycle, nightly cycle-advance, successor mint |

### Compliance / integrations / data — `40-compliance-and-data/`
| # | Doc | Focus |
|---|---|---|
| 01 | [compliance-dpdp-gst-tds-msme](40-compliance-and-data/01-compliance-dpdp-gst-tds-msme.md) | enterprise touchpoints → `../compliance/*` |
| 02 | [deletion-policy](40-compliance-and-data/02-deletion-policy.md) | erasure, retention, immutable ledger |
| 03 | [data-export](40-compliance-and-data/03-data-export.md) | `OrgDataExportJob` |
| 04 | [outbound-webhooks](40-compliance-and-data/04-outbound-webhooks.md) | `WebhookEndpoint`, delivery, signing |
| 05 | [workspace-preferences](40-compliance-and-data/05-workspace-preferences.md) | `OrgWorkspaceProfile` prefs |
| 06 | [cross-cutting-integrations](40-compliance-and-data/06-cross-cutting-integrations.md) | per-subsystem wired/skipped map |

### Operations — `50-operations/`
| # | Doc | Focus |
|---|---|---|
| 01 | [api-reference](50-operations/01-api-reference.md) | exhaustive route table (roles + audit actions) |
| 02 | [route-migration-table](50-operations/02-route-migration-table.md) | old-route → new-route map |
| 03 | [runbooks](50-operations/03-runbooks.md) | incident response + scheduled tasks |
| 04 | [monitoring](50-operations/04-monitoring.md) | log taxonomy, alerts, dashboards |
| 05 | [system-events](50-operations/05-system-events.md) | system-event / audit-action taxonomy |
| 06 | [live-payout-go-live-runbook](50-operations/06-live-payout-go-live-runbook.md) | flip `ENABLE_LIVE_PAYOUTS` safely (sandbox proof + rollback) |

### Scenarios / verdict / partners — `60-scenarios-and-verdicts/`
| # | Doc | Focus |
|---|---|---|
| 01 | [scenarios-and-examples](60-scenarios-and-verdicts/01-scenarios-and-examples.md) | worked end-to-end scenarios |
| 02 | [harness-verdict](60-scenarios-and-verdicts/02-harness-verdict.md) | scenario-by-scenario verdict |
| 03 | [design-partner-customer-set](60-scenarios-and-verdicts/03-design-partner-customer-set.md) | seed cohort / design partners |

### Audit artifacts (annex) — `90-audits/`
| # | Doc | Focus |
|---|---|---|
| 01 | [readiness-audit](90-audits/01-readiness-audit.md) | enterprise readiness audit |
| 02 | [subsystem-checklist](90-audits/02-subsystem-checklist.md) | per-subsystem completeness checklist |
| 03 | [verification-guide](90-audits/03-verification-guide.md) | how to verify the enterprise subsystem |
| 04 | [simplification-proposal](90-audits/04-simplification-proposal.md) | scope-simplification proposal |
| 05 | [production-grade-checklist-2026-05-02](90-audits/05-production-grade-checklist-2026-05-02.md) | superseded 2026-05-02 production-grade checklist |

### The complete guide
| File | Purpose |
|---|---|
| [explainers/complete-guide](explainers/complete-guide.md) | the single end-to-end narrative walkthrough across every enterprise concept — read it alongside the banded folders above |

---

## Ground-truth files

Docs **defer to code** when prose drifts. The load-bearing sources:

- `prisma/schema.prisma` — the schema is the source of truth; docs cite model/field names verbatim.
- `lib/payments/ledger/post.ts` — `postLedgerTxn`, `ledgerAccountId`, `ledgerBalancePaise`.
- `scripts/reconcile/reconcile-ledgers.ts` — the integrity invariants.
- `lib/api/organizations/{wallet,program-helpers,rate-card}.ts` — transactional primitives.
- `lib/enterprise/cycle-engine.ts` — assignment roll-vs-close + successor mint (#779 §A/§B → [cycle-engine-and-rollover](30-programs-and-lifecycle/08-cycle-engine-and-rollover.md)).
- `lib/enterprise/config-lock.ts` — which contract/program term fields freeze once in use (#779 §A → [contract-lifecycle](30-programs-and-lifecycle/07-contract-lifecycle.md)).
- `lib/enterprise/org-activation.ts` — the one org-state model behind the activation checklist + action-required banners (#777 §A / #779 §F); server-side reads split into `org-activation-signals.ts`.
- `lib/enterprise/governance.ts` — `verifiedAt`-gated feature locks (SSO / INVOICE billing / unverified seat cap) (#675/#687).
- `lib/auth/billing-admin-gate.ts` — OWNER-or-`BILLING_ADMIN` disjunction gate for the financial surface.
- `lib/labels/org-labels.ts`, `lib/enterprise/{audit-actions,role-transitions}.ts`, `lib/auth.ts` (the `customSession` hook).

---

## Post-#772 note

> **The double-entry journal (`LedgerTransaction` / `LedgerEntry` / `LedgerAccount`) replaced the three single-entry logs.** `FundingLedgerEntry`, `WalletEntry`, and `SettlementLedgerEntry` (+ `SettlementKind`) are **gone**; `WalletTopUp` carries top-up lifecycle, and balances derive from the journal. Revenue splits are integer **basis points**, not floats. If you find any of those removed names anywhere in this doc set, it's a stale reference — fix it.

## Post-v2 note

> **The v2 mega-audit (#777/#778/#779) was absorbed into these docs on 2026-06-05.** It closed the "silent stuck money / zombie row" gaps: the `Contract` lifecycle (auto-renew, supersede, end-early) → [contract-lifecycle](30-programs-and-lifecycle/07-contract-lifecycle.md); the cycle engine + assignment rollover (nightly cycle-advance, successor mint) → [cycle-engine-and-rollover](30-programs-and-lifecycle/08-cycle-engine-and-rollover.md); the `OverageEvent` system (breaker / surcharge / `CHARGE_MEMBER` timeout); dunning; wallet auto-top-up (**notify-only today** — the cron warns, it does not charge); SSO break-glass; verification resubmit; webhook secret-rotation grace; field-level RBAC on org/contract/program edits; and the IRN payload mapper behind `ENABLE_IRP_UPLOADER`. `TdsAdjustment` is schema-only (unwired). New idempotency anchors: `rolledAt` (cycle mint), `autoRenewedAt` (contract renew), `autoTopUpLastFiredAt` (auto-top-up).

## Conventions

- **Money is integer paise**; splits/percentages are integer **basis points** (`10000 = 100%`).
- **Idempotency keys** are structured: money keys like `booking:<paymentId>`, `topup:<providerOrderId>`, `orgpayout:<payoutId>`; cron claims gate on a stamped timestamp — `rolledAt` (cycle mint), `autoRenewedAt` (contract renew), `autoTopUpLastFiredAt` (auto-top-up) ([concurrency-and-idempotency](30-programs-and-lifecycle/01-concurrency-and-idempotency.md)).
- **Ledger rows are immutable** — corrections are counter-transactions, never edits or deletes.
- **Balances are derived** by summing the journal; the few cached numbers are reconciled nightly.
