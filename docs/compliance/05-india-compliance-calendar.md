# India compliance calendar — data protection and consumer protection

> **Status:** deadline reference for the DPDP and consumer-protection duties. Tax and filing dates the jobs are timed against live in [MSME, statutory exports and calendar](../finance/60-tax/04-msme-statutory-exports-and-calendar.md).
> **Audience:** compliance and support operators.
> **Last reviewed:** 2026-11-09

## Dated milestones

| Date             | What happens                                                                                                                                            | What we do                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **13 Nov 2026**  | DPDP Rule 4 (Consent Manager registration) commences, one year after G.S.R. 846(E)                                                                      | Nothing to build; we integrate a registered Consent Manager only if one is offered (see [DPDP and privacy](./02-dpdp-and-privacy.md), Don't build). |
| **31 Dec 2026**  | Our deadline for the dark-pattern self-audit and the displayed certificate                                                                              | Signed audit record in the repo and the certificate page live (#2666).                                                                              |
| **1 Jan 2027**   | Consumer Protection (E-Commerce) (Amendment) Rules 2026, G.S.R. 789(E), in force: dark-pattern duties, certificate, 30-day prior price, seller identity | See [consumer protection and grievance](./03-consumer-protection-and-grievance.md), section 5. Re-audit every year after.                           |
| **~13 May 2027** | DPDP Rules 3 and 5–16 (the substantive duties) and the Act's operative sections commence (18 months)                                                    | Consent record integrity, breach lifecycle, erasure clock, processor register.                                                                      |

## DPDP Rules 2025 — phased rollout

| Phase       | Deadline           | Obligation                                                                          |
| ----------- | ------------------ | ----------------------------------------------------------------------------------- |
| **Phase 1** | Done (13 Nov 2025) | Data Protection Board operational                                                   |
| **Phase 2** | **13 Nov 2026**    | Rule 4: Consent Manager framework live                                              |
| **Phase 3** | **~13 May 2027**   | All substantive obligations enforceable: consent, notice, rights, breach, retention |

See [DPDP and privacy](./02-dpdp-and-privacy.md). Phase 3 is the hard deadline for the data-subject request endpoints and the other substantive duties; sign-up consent and the 18+ age gate are already live.

## Per-event deadlines

| Trigger                                 | Deadline                                         | Action                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal-data breach detected           | "Without delay"; operational target **72 hours** | Email the Data Protection Board and affected users. `databreach-deadline-alerts` fires at T+60h and T+72h.                                                                                                                   |
| Refund initiated (cards)                | **7 working days**                               | RBI norm; tracked by `Refund.targetCompletionDate`.                                                                                                                                                                          |
| Refund initiated (UPI)                  | **5–7 days**                                     | Same.                                                                                                                                                                                                                        |
| Chargeback evidence window              | **7 days** from the gateway notice               | See [chargebacks](../finance/30-refunds-disputes/02-chargebacks.md).                                                                                                                                                         |
| Grievance acknowledgement               | **24 hours** (platform standard)                 | The statutory ceilings are 24 hours (IT Rules 3(2)) and 48 hours (E-Commerce Rules 4(5)); `STATUTORY_ACK_HOURS` in `lib/support/sla.ts`. See [consumer protection and grievance](./03-consumer-protection-and-grievance.md). |
| Grievance resolution                    | **7 days** (platform standard)                   | The statutory ceilings are 15 days (IT Rules 3(2)), one month (E-Commerce Rules) and 90 days (DPDP Rule 14(3)); `STATUTORY_RESOLUTION_DAYS` in `lib/support/sla.ts`.                                                         |
| Dark-pattern self-audit and certificate | **Annually**, first by 31 Dec 2026               | E-Commerce (Amendment) Rules 2026, in force 1 Jan 2027; tracked in #2666.                                                                                                                                                    |
| Razorpay marketplace self-declaration   | **Annually**                                     | See the RBI posture in the [overview](./00-overview.md#rbi-payment-aggregator-posture).                                                                                                                                      |

## Penalty reference

| Breach                                   | Penalty                                          |
| ---------------------------------------- | ------------------------------------------------ |
| DPDP breach not reported within 72h      | Penalty up to ₹250 cr (Schedule, DPDP Act)       |
| Consumer Protection grievance SLA breach | Damages and civil court risk via CCPA escalation |

Update this page whenever a MeitY notification or consumer-protection rule changes a deadline, and bump "Last reviewed".

## Deprecated & Superseded Approaches

- **A 48-hour acknowledgement and 30-day resolution row (replaced 2026-11-09).** This page quoted the E-Commerce Rules ceilings as the deadline. The platform promises 24 hours and 7 days (`lib/support/sla.ts`); the statutory figures are ceilings only.
