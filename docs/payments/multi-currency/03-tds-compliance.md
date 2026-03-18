# TDS Compliance — Section 194J

## Overview

Tax Deducted at Source (TDS) under Section 194J applies to payments for professional/technical services to consultants. Familiarise must deduct TDS when cumulative payments to a consultant exceed ₹50,000 in a financial year.

## Rules

| Parameter | Value |
|-----------|-------|
| **Section** | 194J (Fees for professional/technical services) |
| **Threshold** | ₹50,000 per financial year |
| **Rate (with PAN)** | 10% |
| **Rate (without PAN)** | 20% (Section 206AA) |
| **Financial Year** | April 1 – March 31 |
| **Deposit deadline** | 7th of the month following deduction |
| **Filing** | Quarterly Form 26Q |
| **Due dates** | Q1: Jul 31, Q2: Oct 31, Q3: Jan 31, Q4: May 31 |

## How It Works

### Threshold Tracking

The system tracks cumulative `grossAmount` from `ConsultantEarnings` for each financial year. When cumulative payments cross ₹50,000:

1. **First time crossing**: TDS calculated only on the excess amount
2. **Already above threshold**: TDS on full payout amount

### Deduction Flow

```
[Payout batch created]
    ↓
[For each payout: calculateTDS()]
    ↓
[If above threshold:]
    ↓
[netAmount = amount - tdsAmount]
    ↓
[Send netAmount to Razorpay/Stripe (not gross)]
    ↓
[Record TDSRecord for Form 26Q filing]
```

### PAN Verification

- **10% rate**: Applied when `ConsultantTaxInfo.panVerified === true`
- **20% rate**: Applied when PAN is not provided or not verified
- PAN should be collected during consultant onboarding (not blocking, but encouraged)
- PAN verification resets if PAN number is changed

## Database Models

### ConsultantTaxInfo
Stores PAN, GSTIN, country, and LUT info per consultant.

### TDSRecord
One record per deduction event, linked to payout. Tracks:
- Financial year + quarter
- Cumulative gross payments at time of deduction
- TDS amount and rate
- Form 26Q filing status

## Admin Dashboard

### Endpoints

- `GET /api/admin/tds?fy=2026-27` — FY summary (quarterly breakdown)
- `GET /api/admin/tds?fy=2026-27&view=consultants` — Per-consultant breakdown
- `POST /api/admin/tds` — Mark records as filed in Form 26Q

### Filing Workflow

1. At quarter end, admin views TDS summary
2. Downloads per-consultant breakdown for CA
3. CA files Form 26Q with IT department
4. Admin marks records as filed via POST endpoint

## Consultant API

- `GET /api/consultant/tax-info` — View masked PAN, GSTIN, verification status
- `PUT /api/consultant/tax-info` — Update PAN, GSTIN, country

## Key Files

| File | Purpose |
|------|---------|
| `lib/payments/tax/tds-service.ts` | Core TDS calculation + record-keeping |
| `lib/payments/payouts/payout-service.ts` | TDS integration in payout processing |
| `app/api/admin/tds/route.ts` | Admin TDS dashboard API |
| `app/api/consultant/tax-info/route.ts` | Consultant tax info CRUD |
| `prisma/schema.prisma` | `ConsultantTaxInfo` + `TDSRecord` models |
