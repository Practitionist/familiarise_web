---
title: MSME deadlines, statutory exports and the job calendar
type: reference
audience: engineers and finance staff who run or read the scheduled compliance jobs
status: live
last-reviewed: 2026-10-23
---

# MSME deadlines, statutory exports and the job calendar

Four scheduled jobs produce the platform's statutory outputs: the monthly GST register, the quarterly TDS return draft, the e-invoice uploader and the MSME payment alerts. This page describes the MSME rule the alerts enforce, each job's cadence, lock and output, and the few statutory dates the jobs are timed against. The tax rules behind the outputs are in [GST, tax invoices and credit notes](02-gst-invoices-and-credit-notes.md) and [TDS rules and returns](03-tds-rules-and-returns.md).

## The MSME payment deadline

Section 43B(h) of the Income-tax Act says that an expense owed to a micro or small enterprise can be deducted only in the year it is paid if it is paid within 15 days, or within 45 days when a written agreement exists. A payment made later is disallowed as an expense until it is actually paid. The platform pays experts and host organisations, so a payee who is a micro or small enterprise puts a deadline on the platform's payout.

`computeMsmePaymentDeadline` (`lib/compliance/msme.ts`) takes the payee's MSME status and whether a written agreement is on file, and returns the date.

| Payee's MSME status | Written agreement on file | Deadline from the payout's creation |
| ------------------- | ------------------------- | ----------------------------------- |
| `MICRO` or `SMALL`  | No (the default)          | 15 days                             |
| `MICRO` or `SMALL`  | Yes                       | 45 days                             |
| `MEDIUM` or `NONE`  | Either                    | 60 days                             |

The 15 and 45 days are a hard ceiling that a longer payment term cannot extend. The agreement flag defaults to false, so a forgotten flag errs toward the shorter deadline rather than toward a tax disallowance. The status comes from the consultant's profile (`msmeStatus`, `writtenAgreementWithFamiliarise`) or the organisation's MSME information, not from the buyer. `isValidUdyamNumber` checks the registration number format `UDYAM-XX-NN-NNNNNNN`.

Both payout models stamp the deadline when the payout is created, through `resolvePayoutMsmeDeadline` (`lib/payments/payouts/shared-lifecycle.ts`): `mustPayByDate` on `ConsultantPayout` and on `OrganizationPayout`. The date counts from the moment the payout is created (the call time inside the creating transaction), and a payee with no status is treated as `NONE`, so every payout has a deadline.

For example, LearnPro Academy declares itself a small enterprise with a written agreement. A payout created on 2026-10-20 gets `mustPayByDate` 2026-12-04, 45 days later. Without the agreement it would be 2026-11-04. A payee with status `NONE` would get 2026-12-19.

### The alert job

`msme-payment-alerts` (`jobs/compliance/msme-payment-alerts.ts`) runs once a day. The ticker fires it in a one-hour window from 03:00 UTC at the :45 slot, 03:45 UTC or 09:15 IST. It is one slot on purpose: the digest email is not idempotent, so it must not repeat.

1. It reads consultant and organisation payouts that are not COMPLETED and whose `mustPayByDate` falls within the next 5 days or has passed, earliest first, up to 21 rows per rail.
2. If any exist, it sends a compliance alert through the notification service to every administrator, an email to the same people, and a direct email to `MSME_ALERT_EMAIL` when that address is set and is not already an administrator. The link goes to the Compliance page in the back office, tab `msme`.
3. It logs a structured line, `msme.payout.at_risk`, with the count.

The lock is fail-open (`withCronLock`, `failMode: "open"`), because the side effects are alerts. The job is not in `FINANCIAL_JOB_NAMES`, so it keeps running while maintenance is DEGRADED.

## The statutory jobs

All four run from the Netlify five-minute ticker (`netlify/functions/cron-tick.mts`), each inside a calendar window, in bounded slices.

| Job                           | When (UTC)                                                                  | When (IST)                           | Lock        | Held while DEGRADED | Output                                                                   |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------ | ----------- | ------------------- | ------------------------------------------------------------------------ |
| `gst-outward-register-export` | The 2nd of each month, hourly slices at :45 from 04:45 to 22:45             | 10:15 on the 2nd to 04:15 on the 3rd | fail-closed | Yes                 | `compliance/gst/<first day>_<last day>.csv` for the previous India month |
| `tds-return-draft`            | The 5th of January, April, July and October, 01:55 and 02:55                | 07:25 and 08:25                      | fail-open   | No                  | `compliance/tds/<FY>-Q<n>.csv` plus a masked draft in the job log        |
| `irp-uploader`                | Daily from 03:00 for 17 hours, hourly slices at :25, ten invoices per slice | 08:55 onward                         | fail-closed | Yes                 | IRN, acknowledgement and QR stored on the organisation invoice           |
| `msme-payment-alerts`         | Daily at 03:45                                                              | 09:15                                | fail-open   | No                  | A digest to administrators and finance                                   |

Fail-closed means the job does nothing if the lease cannot be taken, because two concurrent runs would damage a gapless number series (the register's healer) or register an e-invoice twice. Fail-open means the job runs unlocked when the lease cannot be taken for a reason other than a lost database connection. For `tds-return-draft` an overlapping run only rewrites the same CSV; `msme-payment-alerts` is not idempotent, so a fail-open run or a manual rerun can send its digest twice. Every job in this table is also reachable by its HTTP twin, `POST /api/cleanup/<slug>` with `Authorization: Bearer $CRON_SECRET`, which is how to run one by hand.

### What each export needs to run

- **GST register.** Nothing beyond the invoices themselves. Its healer needs the platform GSTIN to mint missing consumer invoices.
- **TDS draft.** `TdsRate` rows, and the private storage bucket, which creates itself.
- **IRP uploader.** The platform GSTIN and the ClearTax API key, token and GSTIN. Missing any of them, the job touches no invoice and reports a skip. Only organisation invoices that carry the buyer's GSTIN, are PENDING for the IRP and were issued in the last 30 days are sent, and a windowed run skips an invoice already attempted since the window opened, so a retry is spent at most once a day.
- **MSME alerts.** Payouts with a deadline, and optionally `MSME_ALERT_EMAIL`.

## The statutory dates the jobs are timed against

The code does not enforce these dates; the jobs are scheduled to be ready before them. The accountant owns the filing.

| Date                                                                                        | What it is                                                                                           | The job that feeds it                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| The 11th of each month                                                                      | GSTR-1, outward supplies for the prior month                                                         | The register is ready on the 2nd                                  |
| 31 July, 31 October, 31 January, 31 May                                                     | The quarterly TDS return for the quarter ending in the preceding June, September, December and March | The draft is ready on the 5th of the month after the quarter ends |
| 15 or 45 days after a payout's creation for a `MICRO` or `SMALL` payee (60 days for others) | The section 43B(h) payment deadline (statutory only for `MICRO` and `SMALL`)                         | `msme-payment-alerts`, five days before                           |

TDS deposit, advance tax, the half-yearly MSME-1 return and annual GST returns are statutory obligations too, but no job produces them, so they are not tracked here.

## Rules and their enforcers

| Rule                                                       | Enforcer                                                              | Test                                                          | Repair                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| A micro or small payee's deadline is at most 15 or 45 days | `computeMsmePaymentDeadline`                                          | `__tests__/enterprise/msme-deadline.test.ts`                  | Correct the payee's status or agreement flag |
| Every payout has a deadline                                | `resolvePayoutMsmeDeadline` called by both batch builders             | `__tests__/enterprise/msme-deadline.test.ts`                  | Stamp the date on the row by hand            |
| The digest email is sent once a day                        | A one-slot window in `TARGET_WINDOWS` in `cron-tick.mts`              | `__tests__/maintenance/cron-tick-targets.test.ts`             | None needed                                  |
| A register slice never leaves a gap in the invoice series  | Fail-closed lock; the healer takes numbers inside its own transaction | `__tests__/compliance/gst-register-upload-then-stamp.test.ts` | Re-run the job                               |
| A register row is stamped only after the file is uploaded  | Upload then stamp order in the job                                    | `__tests__/compliance/gst-register-upload-then-stamp.test.ts` | Re-run the job                               |

## Where in code

- `lib/compliance/msme.ts`, `lib/compliance/ist-period.ts`.
- `jobs/compliance/msme-payment-alerts.ts`, `gst-outward-register-export.ts`, `tds-26q-draft-export.ts`, `irp-uploader.ts`.
- `netlify/functions/cron-tick.mts` — `TARGET_WINDOWS`, `TARGET_EVERY_MINUTES`.
- `lib/cron/cleanup-registry.ts` — the HTTP twins.

## Related

- [Scheduled jobs](../70-operations/01-scheduled-jobs.md)
- [GST, tax invoices and credit notes](02-gst-invoices-and-credit-notes.md)
- [TDS rules and returns](03-tds-rules-and-returns.md)

## Deprecated & Superseded Approaches

- **Compliance jobs run by GitHub Actions** (`cron-daily.yml`, `irp-uploader.yml`, `dunning.yml`). No workflow names a money or compliance job. Everything above runs on the Netlify ticker.
- **`ENABLE_IRP_UPLOADER`.** The variable exists nowhere in the code. The uploader is gated by the GSTIN and ClearTax settings.
- **A `quarterly-return-prep` job and a Form 16A generator.** Neither exists.
- **A hard-coded 03:40 UTC for the MSME digest.** The comment in the job file says so; the slot comes from the ticker and is 03:45.
- **A shipping checklist and a roadmap of compliance phases.** Those planning documents described work that is either done or obsolete and were retired.
