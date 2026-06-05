# Familiarise Enterprise — documentation

The **enterprise layer** is a capability-driven B2B surface on top of the marketplace: organizations sponsor and/or host, fund sessions through wallets / invoices / licenses, run programs with seat or credit caps, and settle money through a double-entry ledger. This folder is the engineer's map of it — the numbered docs `00`→`52` are written to be read **in order, as one continuous story**, each section building on the last, with [`explainers/complete-guide`](explainers/complete-guide.md) as the connective end-to-end narrative.

> **New here?** Read [00-overview](00-overview.md) for the system shape, then [explainers/complete-guide](explainers/complete-guide.md) for the end-to-end narrative. For money specifically, start at [06-money-model-overview](06-money-model-overview.md) and walk the `06→14` band.

---

## How to read this

```mermaid
flowchart LR
  START([new developer]) --> OV["00 overview<br/>01 org types · 02 funding"]
  OV --> PATH{your area?}
  PATH -->|money / ledger| MONEY["06 → 07 → 08 → 09<br/>→ 10 → 11 → 12 → 13 → 14"]
  PATH -->|identity / SSO| IAM["03 roles · 15 SSO · 16 JIT<br/>17 SCIM · 18 limits · 19 headers"]
  PATH -->|programs / app| PROG["20 concurrency · 21 programs · 22 experts<br/>23 dashboard · 24 discovery · 25 flags<br/>26 contracts · 27 cycle engine"]
  PATH -->|compliance / data| COMP["30 compliance · 31 deletion<br/>32 export · 33 webhooks · 34 prefs · 35 integrations"]
  PATH -->|on-call / ops| OPS["40 API · 41 routes · 42 runbooks<br/>43 monitoring · 44 events · 45 payout go-live"]
  PATH -->|sales / partners| SALES["50 scenarios · 51 verdict · 52 partners<br/>playbooks/"]
```

---

## Section map

| Band | Section | Docs |
| --- | --- | --- |
| `00–05` | **Foundations** | overview, org types, funding & programs, roles, lifecycle, hierarchy |
| `06–14` | **Money & ledger** | money model, chart of accounts, postings, wallet, booking→earnings, payouts, invoicing, payment legs, integrity |
| `15–19` | **IAM / SSO / security** | SSO, JIT, SCIM, rate-limiting, security headers |
| `20–27` | **Programs / dashboard / discovery / lifecycle** | concurrency & idempotency, programs, experts, dashboard, discovery, feature flags, contract lifecycle, cycle engine & rollover |
| `30–35` | **Compliance / integrations / data** | compliance map, deletion, data export, outbound webhooks, workspace prefs, cross-cutting integrations |
| `40–45` | **Operations** | API reference, route migration, runbooks, monitoring, system events, live-payout go-live |
| `50–52` | **Scenarios / verdict / partners** | worked scenarios, harness verdict, design-partner set |

---

## Full index

### Foundations
| # | Doc | Focus |
|---|---|---|
| 00 | [overview](00-overview.md) | system shape, master ER, capability model |
| 01 | [organization-types](01-organization-types.md) | `canSponsor`/`canHost` → BUYER/HOST/HYBRID/INERT |
| 02 | [funding-and-programs](02-funding-and-programs.md) | `FundingSource` enum + program subtypes |
| 03 | [roles-and-permissions](03-roles-and-permissions.md) | `MemberRole` ladder + every API gate |
| 04 | [organization-lifecycle](04-organization-lifecycle.md) | `OrgStatus` + contract/program state machines |
| 05 | [hierarchy](05-hierarchy.md) | `parentOrganizationId`/`rootOrganizationId` (UI deferred) |

### Money & ledger
| # | Doc | Focus |
|---|---|---|
| 06 | [money-model-overview](06-money-model-overview.md) | integer paise, double-entry, derived balances, what #772 changed |
| 07 | [chart-of-accounts](07-chart-of-accounts.md) | the 10 accounts, normal sides, deterministic ids |
| 08 | [ledger-and-postings](08-ledger-and-postings.md) | `postLedgerTxn`, the balance invariant, every flow's legs |
| 09 | [wallet-and-topups](09-wallet-and-topups.md) | `WalletTopUp` lifecycle, wallet-as-cache |
| 10 | [booking-to-earnings](10-booking-to-earnings.md) | booking → earnings → bps split, rate cards |
| 11 | [payout-pipeline](11-payout-pipeline.md) | earnings roll-up → payout, TDS/MSME, `ORG_PAYOUT` |
| 12 | [invoicing](12-invoicing.md) | GST, IRN, PO match, `ORG_RECEIVABLE`, refunds |
| 13 | [payment-legs](13-payment-legs.md) | stackable funding legs → ledger debits |
| 14 | [ledger-integrity](14-ledger-integrity.md) | the reconciler: 7 checks + report |

### IAM / SSO / security
| # | Doc | Focus |
|---|---|---|
| 15 | [sso-and-authentication](15-sso-and-authentication.md) | `OrganizationSSOSettings`, `SsoProvider`, domain claims |
| 16 | [jit-and-session-refresh](16-jit-and-session-refresh.md) | JIT auto-join, `sessionGeneration`, role-change refresh |
| 17 | [scim-provisioning](17-scim-provisioning.md) | SCIM tokens + provisioning |
| 18 | [rate-limiting](18-rate-limiting.md) | coverage matrix; why BetterAuth's limiter is off |
| 19 | [security-headers](19-security-headers.md) | CSP + header posture |

### Programs / dashboard / discovery
| # | Doc | Focus |
|---|---|---|
| 20 | [concurrency-and-idempotency](20-concurrency-and-idempotency.md) | atomic patterns + every idempotency key |
| 21 | [programs](21-programs.md) | program / assignment / `BookingUtilization` internals |
| 22 | [expert-lifecycle](22-expert-lifecycle.md) | expert apply/approve; `PayoutRecipient` |
| 23 | [dashboard-pages](23-dashboard-pages.md) | every `app/dashboard/organization/[orgId]/**` page |
| 24 | [public-pages-and-discovery](24-public-pages-and-discovery.md) | org catalog, search, marketplace identity |
| 25 | [feature-flags-and-rollout](25-feature-flags-and-rollout.md) | `ENABLE_HOST_ORGS` + capability-gated UI |
| 26 | [contract-lifecycle](26-contract-lifecycle.md) | `Contract` state machine, auto-renew, supersession, end-early guard |
| 27 | [cycle-engine-and-rollover](27-cycle-engine-and-rollover.md) | `ProgramAssignment` lifecycle, nightly cycle-advance, successor mint |

### Compliance / integrations / data
| # | Doc | Focus |
|---|---|---|
| 30 | [compliance-dpdp-gst-tds-msme](30-compliance-dpdp-gst-tds-msme.md) | enterprise touchpoints → `../compliance/*` |
| 31 | [deletion-policy](31-deletion-policy.md) | erasure, retention, immutable ledger |
| 32 | [data-export](32-data-export.md) | `OrgDataExportJob` |
| 33 | [outbound-webhooks](33-outbound-webhooks.md) | `WebhookEndpoint`, delivery, signing |
| 34 | [workspace-preferences](34-workspace-preferences.md) | `OrgWorkspaceProfile` prefs |
| 35 | [cross-cutting-integrations](35-cross-cutting-integrations.md) | per-subsystem wired/skipped map |

### Operations
| # | Doc | Focus |
|---|---|---|
| 40 | [api-reference](40-api-reference.md) | exhaustive route table (roles + audit actions) |
| 41 | [route-migration-table](41-route-migration-table.md) | old-route → new-route map |
| 42 | [runbooks](42-runbooks.md) | incident response + scheduled tasks |
| 43 | [monitoring](43-monitoring.md) | log taxonomy, alerts, dashboards |
| 44 | [system-events](44-system-events.md) | system-event / audit-action taxonomy |
| 45 | [live-payout-go-live-runbook](45-live-payout-go-live-runbook.md) | flip `ENABLE_LIVE_PAYOUTS` safely (sandbox proof + rollback) |

### Scenarios / verdict / partners
| # | Doc | Focus |
|---|---|---|
| 50 | [scenarios-and-examples](50-scenarios-and-examples.md) | worked end-to-end scenarios |
| 51 | [harness-verdict](51-harness-verdict.md) | scenario-by-scenario verdict |
| 52 | [design-partner-customer-set](52-design-partner-customer-set.md) | seed cohort / design partners |

### The complete guide
| File | Purpose |
|---|---|
| [explainers/complete-guide](explainers/complete-guide.md) | the single end-to-end narrative walkthrough across every enterprise concept — read it alongside the numbered band above |

---

## Ground-truth files

Docs **defer to code** when prose drifts. The load-bearing sources:

- `prisma/schema.prisma` — the schema is the source of truth; docs cite model/field names verbatim.
- `lib/payments/ledger/post.ts` — `postLedgerTxn`, `ledgerAccountId`, `ledgerBalancePaise`.
- `scripts/reconcile/reconcile-ledgers.ts` — the integrity invariants.
- `lib/api/organizations/{wallet,program-helpers,rate-card}.ts` — transactional primitives.
- `lib/enterprise/cycle-engine.ts` — assignment roll-vs-close + successor mint (#779 §A/§B → [27](27-cycle-engine-and-rollover.md)).
- `lib/enterprise/config-lock.ts` — which contract/program term fields freeze once in use (#779 §A → [26](26-contract-lifecycle.md)).
- `lib/enterprise/org-activation.ts` — the one org-state model behind the activation checklist + action-required banners (#777 §A / #779 §F); server-side reads split into `org-activation-signals.ts`.
- `lib/enterprise/governance.ts` — `verifiedAt`-gated feature locks (SSO / INVOICE billing / unverified seat cap) (#675/#687).
- `lib/auth/billing-admin-gate.ts` — OWNER-or-`BILLING_ADMIN` disjunction gate for the financial surface.
- `lib/labels/org-labels.ts`, `lib/enterprise/{audit-actions,role-transitions}.ts`, `lib/auth.ts` (the `customSession` hook).

---

## Post-#772 note

> **The double-entry journal (`LedgerTransaction` / `LedgerEntry` / `LedgerAccount`) replaced the three single-entry logs.** `FundingLedgerEntry`, `WalletEntry`, and `SettlementLedgerEntry` (+ `SettlementKind`) are **gone**; `WalletTopUp` carries top-up lifecycle, and balances derive from the journal. Revenue splits are integer **basis points**, not floats. If you find any of those removed names anywhere in this doc set, it's a stale reference — fix it.

## Post-v2 note

> **The v2 mega-audit (#777/#778/#779) was absorbed into these docs on 2026-06-05.** It closed the "silent stuck money / zombie row" gaps: the `Contract` lifecycle (auto-renew, supersede, end-early) → [26](26-contract-lifecycle.md); the cycle engine + assignment rollover (nightly cycle-advance, successor mint) → [27](27-cycle-engine-and-rollover.md); the `OverageEvent` system (breaker / surcharge / `CHARGE_MEMBER` timeout); dunning; wallet auto-top-up (**notify-only today** — the cron warns, it does not charge); SSO break-glass; verification resubmit; webhook secret-rotation grace; field-level RBAC on org/contract/program edits; and the IRN payload mapper behind `ENABLE_IRP_UPLOADER`. `TdsAdjustment` is schema-only (unwired). New idempotency anchors: `rolledAt` (cycle mint), `autoRenewedAt` (contract renew), `autoTopUpLastFiredAt` (auto-top-up).

## Conventions

- **Money is integer paise**; splits/percentages are integer **basis points** (`10000 = 100%`).
- **Idempotency keys** are structured: money keys like `booking:<paymentId>`, `topup:<providerOrderId>`, `orgpayout:<payoutId>`; cron claims gate on a stamped timestamp — `rolledAt` (cycle mint), `autoRenewedAt` (contract renew), `autoTopUpLastFiredAt` (auto-top-up) ([20-concurrency-and-idempotency](20-concurrency-and-idempotency.md)).
- **Ledger rows are immutable** — corrections are counter-transactions, never edits or deletes.
- **Balances are derived** by summing the journal; the few cached numbers are reconciled nightly.
