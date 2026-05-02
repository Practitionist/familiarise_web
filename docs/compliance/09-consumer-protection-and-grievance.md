# 09 — Consumer Protection / E-Commerce Rules 2020

> **Status:** 🔴 not implemented in product UI. Mentioned in research docs (`docs/payments/international-research/04-international-refunds-disputes.md:112`, `docs/hiring/contractor-research-report.md:160`) but no live grievance officer page, no SLA dashboard, no marketplace seller-detail disclosure.
> **Audience:** product + admin dashboards; public-facing pages.
> **Last reviewed:** 2026-05-02
> **Linked issues:** [#737 §4](https://github.com/Practitionist/familiarise_web/issues/737), [#738 Phase 3 PR 3.1](https://github.com/Practitionist/familiarise_web/issues/738).

## What it is

The Consumer Protection Act 2019 + Consumer Protection (E-Commerce) Rules 2020 — the backstop for consumer rights against any e-commerce entity in India.

**Key obligations (Rule 4 + Rule 5):**

| # | Rule | What it requires |
|---|------|------------------|
| 1 | **Rule 4(5)** — Grievance Officer | Appoint one. Display name, designation, contact details prominently on the website. **Acknowledge complaints in 48 hours, resolve in 1 month.** |
| 2 | **Rule 4(11)** — Refund timeline | Effect refunds within "a reasonable period" — RBI norm 7-14 days for cards, 5-7 for UPI. |
| 3 | **Rule 5(1)** — Seller details | Marketplace must display seller (consultant) — legal name, principal address, GSTIN, customer-care channel. |
| 4 | **Rule 5(3)** — No misleading guarantees | Marketplace cannot advertise services in a manner that misleads consumers about seller responsibility. |
| 5 | **Rule 6** — Inventory e-commerce entity | Doesn't apply — we're a marketplace, not an inventory entity. |
| 6 | **Section 17 CPA** — Consumer grievance | Establishes the Central Consumer Protection Authority (CCPA) as the recourse if our internal grievance flow fails. |

**Note**: this is a SEPARATE grievance flow from DPDP's grievance officer ([doc 08](./08-dpdp-and-privacy.md)). They cover different complaint types:
- Consumer Protection officer: refund delays, service quality, misrepresentation, billing disputes.
- DPDP officer: data privacy, consent, erasure requests.

It's permissible (and common) to have one person fill both roles, but the public-facing pages must clearly distinguish the two complaint categories.

## When it applies

### B2C (consumer marketplace)

- **Applies fully.** We are a "marketplace e-commerce entity" under Rule 3(d). Rule 4 + Rule 5 + Rule 6 all bite.
- The consumer-facing public pages must show: Grievance Officer details, refund policy, dispute resolution channel, consultant (seller) details.

### B2B (org-sponsored)

- **Inherits the same Grievance Officer**. Org-side complaints (a member having an issue with an org-sponsored booking) route through the same officer.
- Rule 5 (seller details) — the consultant detail page must show the same info regardless of whether the booking was B2C or B2B.

## Current code

| Item | What it does | State |
|---|---|---|
| Grievance officer page | **Missing** | 🔴 |
| `Grievance` model | **Missing** | 🔴 |
| `app/api/grievances/route.ts` | **Missing** | 🔴 |
| 48-hour acknowledgement cron | **Missing** | 🔴 |
| 30-day resolution SLA dashboard | **Missing** | 🔴 |
| Refund SLA tracking | **Missing** — `Refund` model has PENDING/SUCCEEDED/FAILED but no `targetCompletionDate` | 🔴 |
| Customer-facing "expected refund date" | **Missing** | 🔴 |
| Seller (consultant) details on profile page | ⚠️ partial — name + bio shown; legal name, principal address, GSTIN missing | 🟠 |
| Customer-care channel disclosure | **Missing** | 🔴 |
| Misrepresentation gate (Rule 5(3)) | N/A — currently no advertising of consultants beyond their own profile | 🟢 |

## Gap

| Gap | Severity |
|---|---|
| No Grievance Officer page (Rule 4(5)) | 🔴 |
| No grievance form / API | 🔴 |
| No 48-hour ack cron | 🔴 |
| No 30-day resolution SLA tracking | 🔴 |
| No refund SLA `targetCompletionDate` | 🟠 |
| Consultant detail page missing GSTIN + principal address (Rule 5(1)) | 🟠 |
| No customer-care channel published | 🔴 |
| No CCPA escalation pathway documented for users | 🟡 |

## Required

### A. Grievance officer page (PR 1)

1. Public page at `/grievance` (or `/legal/grievance`):
   - Officer name, designation, email, phone (or chat-bot link).
   - Acknowledgement SLA: "We will respond in 48 hours."
   - Resolution SLA: "We aim to resolve within 30 days."
   - Categories: "Refund/billing", "Service quality", "Data privacy" (links to DPDP officer if separate).
   - CCPA escalation: link + brief note that consumers can also approach CCPA at [consumerhelpline.gov.in](https://consumerhelpline.gov.in/).
2. Footer link from every page.

### B. Grievance backend (PR 1 cont.)

```prisma
model Grievance {
  id              String          @id @default(cuid())
  userId          String?         // null when filed by anonymous email
  contactEmail    String
  category        GrievanceCategory  // BILLING / SERVICE / PRIVACY / OTHER
  subject         String
  body            String          @db.Text
  attachmentUrls  String[]        @default([])
  status          GrievanceStatus @default(SUBMITTED)
  acknowledgedAt  DateTime?
  resolvedAt      DateTime?
  resolutionNotes String?         @db.Text
  ackBreachedAt   DateTime?       // populated by cron if 48h missed
  resolutionBreachedAt DateTime?  // populated by cron if 30d missed
  assignedToUserId String?
  createdAt       DateTime        @default(now())

  @@index([status])
  @@index([category])
  @@index([createdAt])
}

enum GrievanceCategory {
  BILLING
  SERVICE
  PRIVACY
  OTHER
}

enum GrievanceStatus {
  SUBMITTED
  ACKNOWLEDGED
  IN_PROGRESS
  RESOLVED
  ESCALATED
  CLOSED
}
```

### C. SLA cron (PR 1 cont.)

`jobs/compliance/grievance-sla-sweeper.ts`:
- Runs hourly.
- For grievances where `status = SUBMITTED` AND `createdAt + 48h < now`: fire `ackBreachedAt`, alert admin Slack/email.
- For `status NOT IN (RESOLVED, CLOSED)` AND `createdAt + 30d < now`: fire `resolutionBreachedAt`, alert admin.
- Auto-acknowledge email at 47h to prevent breach (template apology + ETA).

### D. Admin grievance dashboard (PR 1 cont.)

`/dashboard/admin/grievances`:
- Inbox with filters by status / category / SLA-state.
- Detail view with timeline, attachments, response form.
- "Mark resolved" + "Escalate to CCPA" actions.
- Export CSV for compliance audits.

### E. Refund SLA (PR 2)

1. `Refund.targetCompletionDate` = `initiatedAt + 7d` (cards) / `initiatedAt + 5d` (UPI).
2. `jobs/compliance/refund-sla-sweeper.ts` — daily — flags `WHERE status = PENDING AND targetCompletionDate < now`; alerts admin.
3. Customer-facing: order detail page shows "Refund expected by {targetCompletionDate}".
4. On webhook completion (Razorpay/Stripe), close the SLA loop.

### F. Consultant seller-detail disclosure (PR 3)

On `app/explore/consultants/[slug]/page.tsx` (or wherever the public profile lives):
1. Legal name (separate from display name if different).
2. Principal address (city + state minimum; full address optional for privacy).
3. GSTIN if registered, with a "Not GST registered" indicator otherwise.
4. Customer-care email — typically `support@familiarise.com` for marketplace orders, plus the consultant's preferred channel.

### G. Customer-care channel (PR 4)

1. Footer link to `/support`.
2. `support@familiarise.com` published prominently.
3. Optional: in-app chat-bot or contact form.
4. Response SLA: 24 hr first response, separate from grievance SLA.

## Acceptance

- A consumer files a grievance → gets an automated ack email within 1 hour; human response within 48 hours; resolution within 30 days; if breached, alert fires.
- Refund initiated → customer sees expected completion date; if missed, alert fires.
- Consultant detail page shows legal name + state + GSTIN (if registered).
- Footer of every page links to /grievance + /support + /legal/refund-policy.
- Admin dashboard has a single pane to triage grievances with SLA-state visibility.

## Don't build

| Don't build | Reason |
|---|---|
| In-app dispute resolution (ADR / mediation) | Out of scope; CCPA + civil court are the consumer's recourse if our internal SLA fails. |
| Consultant-side grievance against the consumer | Marketplace ECO Rule covers consumer rights, not seller rights. Track separately if needed. |

## References

- [Consumer Protection (E-Commerce) Rules 2020 — full text](https://thc.nic.in/Central%20Governmental%20Rules/Consumer%20Protection%20(E-Commerce)%20Rules,%202020.pdf)
- [Consumer Protection Act 2019](https://consumeraffairs.nic.in/sites/default/files/CP_Act_2019.pdf)
- [Consumer Helpline (CCPA)](https://consumerhelpline.gov.in/)
- [E-Commerce Rules summary (IndiaLaw)](https://www.indialaw.in/blog/civil/consumer-protection-e-commerce-rules/)
- See also: [08](./08-dpdp-and-privacy.md) (DPDP grievance — different officer), [05](./05-refund-and-chargeback-tax-adjustments.md) (refund cascade).
