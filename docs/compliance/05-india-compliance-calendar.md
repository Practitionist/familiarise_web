# India compliance calendar — data protection and consumer protection

> **Status:** deadline reference for the DPDP and consumer-protection duties. Tax and filing dates the jobs are timed against live in [MSME, statutory exports and calendar](../finance/60-tax/04-msme-statutory-exports-and-calendar.md).
> **Audience:** compliance and support operators.
> **Last reviewed:** 2026-06-05

## DPDP Rules 2025 — phased rollout

| Phase       | Deadline           | Obligation                                                                          |
| ----------- | ------------------ | ----------------------------------------------------------------------------------- |
| **Phase 1** | Done (13 Nov 2025) | Data Protection Board operational                                                   |
| **Phase 2** | **13 Nov 2026**    | Consent Manager framework live                                                      |
| **Phase 3** | **13 May 2027**    | All substantive obligations enforceable: consent, notice, rights, breach, retention |

See [DPDP and privacy](./02-dpdp-and-privacy.md). Phase 3 is the hard deadline for consumer signup consent and the data-subject request endpoints.

## Per-event deadlines

| Trigger                                           | Deadline                                         | Action                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Personal-data breach detected                     | "Without delay"; operational target **72 hours** | Email the Data Protection Board and affected users. `databreach-deadline-alerts` fires at T+60h and T+72h. |
| Refund initiated (cards)                          | **7 working days**                               | RBI norm; tracked by `Refund.targetCompletionDate`.                                                        |
| Refund initiated (UPI)                            | **5–7 days**                                     | Same.                                                                                                      |
| Chargeback evidence window                        | **7 days** from the gateway notice               | See [chargebacks](../finance/30-refunds-disputes/02-chargebacks.md).                                       |
| Grievance acknowledgement (E-Commerce Rules 4(5)) | **48 hours**                                     | See [consumer protection and grievance](./03-consumer-protection-and-grievance.md).                        |
| Grievance resolution                              | **30 days**                                      | Same.                                                                                                      |
| Razorpay marketplace self-declaration             | **Annually**                                     | See the RBI posture in the [overview](./00-overview.md#rbi-payment-aggregator-posture).                    |

## Penalty reference

| Breach                                   | Penalty                                          |
| ---------------------------------------- | ------------------------------------------------ |
| DPDP breach not reported within 72h      | Penalty up to ₹250 cr (Schedule, DPDP Act)       |
| Consumer Protection grievance SLA breach | Damages and civil court risk via CCPA escalation |

Update this page whenever a MeitY notification or consumer-protection rule changes a deadline, and bump "Last reviewed".
