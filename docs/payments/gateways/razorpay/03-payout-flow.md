# Razorpay Payout Flow (Route)

## Overview

This document explains how consultants get paid through Razorpay Route. This is the most important document for understanding our payout system.

### The Key Question: How Does a Consultant Get Paid?

```
Short Answer:
+-- Customer pays us
+-- We keep our commission (20%)
+-- Consultant's share (80%) goes to their BANK ACCOUNT
+-- They don't need a Razorpay account!
```

---

## Key Concept: Linked Accounts

### What is a Linked Account?

```
Think of it like this:

+--------------------------------------------------+
|                                                  |
|   FAMILIARISE has ONE Razorpay account           |
|   (Master Merchant Account)                      |
|                                                  |
|   Under this account, we create "sub-accounts"   |
|   for each consultant. These are LINKED ACCOUNTS.|
|                                                  |
|   Linked Account = Consultant's bank details     |
|                    stored securely with Razorpay |
|                                                  |
+--------------------------------------------------+

The consultant NEVER needs to:
- Create a Razorpay account
- Log into any Razorpay dashboard
- Do anything on Razorpay's website

They just give us their bank details, we handle the rest.
```

### Visual: Our Account Structure

```
+---------------------------------------------------------------------+
|                FAMILIARISE RAZORPAY ACCOUNT                         |
|                    (Master Merchant)                                 |
|                                                                      |
|  +---------------+  +---------------+  +---------------+             |
|  |   Linked      |  |   Linked      |  |   Linked      |  ...       |
|  |   Account     |  |   Account     |  |   Account     |             |
|  |               |  |               |  |               |             |
|  | Priya Sharma  |  | Rahul Verma   |  | Sneha Gupta   |             |
|  | acc_HjVXtmk   |  | acc_KmNpQrs   |  | acc_LoPqRst   |             |
|  +-------+-------+  +-------+-------+  +-------+-------+             |
|          |                  |                  |                     |
+----------+------------------+------------------+---------------------+
           |                  |                  |
           v                  v                  v
    +-------------+    +-------------+    +-------------+
    |  HDFC Bank  |    | ICICI Bank  |    |  SBI Bank   |
    | ********4521|    | ********8976|    | ********3412|
    | (Priya's)   |    | (Rahul's)   |    | (Sneha's)   |
    +-------------+    +-------------+    +-------------+

When we transfer to acc_HjVXtmk, money goes to Priya's HDFC account.
Razorpay handles the actual bank transfer.
```

---

## Consultant Onboarding Flow

### What We Collect From Consultant

```
Step 1: Basic Details
+---------------------+
| Full Name           |  Priya Sharma
| Email               |  priya@email.com
| Phone               |  +91 98765 43210
+---------------------+

Step 2: KYC Documents
+---------------------+
| PAN Number          |  ABCDE1234F
| Aadhaar (optional)  |  ************
+---------------------+

Step 3: Bank Details
+---------------------+
| Bank Name           |  HDFC Bank
| Account Number      |  50100123456789
| IFSC Code           |  HDFC0001234
| Account Type        |  Savings / Current
+---------------------+
```

### What Happens Behind the Scenes

```
Consultant fills form on Familiarise
            |
            v
+------------------------+
| Our server receives    |
| bank details           |
+------------------------+
            |
            v
+------------------------+
| Call Razorpay API      |
| POST /v2/accounts      |
+------------------------+
            |
            v
+------------------------+
| Razorpay creates       |
| Linked Account         |
| Returns: acc_HjVXtmk   |
+------------------------+
            |
            v
+------------------------+
| We store ONLY the ID   |
| acc_HjVXtmk            |
| NOT the bank details!  |
+------------------------+
            |
            v
+------------------------+
| Consultant ready for   |
| payouts!               |
+------------------------+

IMPORTANT: We never store actual bank account numbers.
Only the Razorpay linked account ID.
```

### API Call to Create Linked Account

```typescript
// What we send to Razorpay
const linkedAccount = await razorpay.accounts.create({
  email: "priya@email.com",
  phone: "+919876543210",
  legal_business_name: "Priya Sharma",
  business_type: "individual",
  contact_name: "Priya Sharma",
  profile: {
    category: "education",
    subcategory: "tutoring_services",
    addresses: {
      registered: {
        street1: "123 MG Road",
        city: "Bangalore",
        state: "Karnataka",
        postal_code: 560001,
        country: "IN",
      },
    },
  },
  legal_info: {
    pan: "ABCDE1234F",
  },
  bank_account: {
    beneficiary_name: "Priya Sharma",
    account_number: "50100123456789",
    account_type: "savings",
    ifsc_code: "HDFC0001234",
  },
});

// What we get back
{
  "id": "acc_HjVXtmkFHdMrPT",  // THIS IS WHAT WE STORE
  "type": "route",
  "status": "created",
  "email": "priya@email.com",
  ...
}
```

---

## The Payout Cycle

### Timeline Overview

```
+-----------------------------------------------------------------------+
|                        WEEKLY PAYOUT CYCLE                             |
+-----------------------------------------------------------------------+
|                                                                        |
|  Mon-Sun: Consultations happen, earnings accumulate                    |
|           |                                                            |
|           | Each payment creates an EARNINGS record                    |
|           | Status: PENDING (in 24hr hold)                             |
|           v                                                            |
|  +----------------+                                                    |
|  | PENDING        |  Rs.776 from Monday's session                      |
|  | PENDING        |  Rs.1,552 from Tuesday's sessions                  |
|  | PENDING        |  Rs.776 from Wednesday's session                   |
|  +----------------+                                                    |
|           |                                                            |
|           | After 24 hours, hold releases                              |
|           v                                                            |
|  +----------------+                                                    |
|  | AVAILABLE      |  Rs.776                                            |
|  | AVAILABLE      |  Rs.1,552                                          |
|  | AVAILABLE      |  Rs.776                                            |
|  +----------------+                                                    |
|           |        Total Available: Rs.3,104                           |
|           |                                                            |
|  Monday 11 PM IST: Weekly payout job runs                              |
|           |                                                            |
|           v                                                            |
|  +-------------------+                                                 |
|  | PAYOUT INITIATED  |  Transfer Rs.3,104 to acc_HjVXtmk              |
|  +-------------------+                                                 |
|           |                                                            |
|           | Razorpay processes transfer                                |
|           | Status: PROCESSING                                         |
|           |                                                            |
|  Wednesday (T+2): Funds settle to bank                                 |
|           |                                                            |
|           v                                                            |
|  +-------------------+                                                 |
|  | SETTLED           |  Rs.3,104 in Priya's HDFC account              |
|  +-------------------+                                                 |
|                                                                        |
+-----------------------------------------------------------------------+
```

### Why the 24-Hour Hold?

```
+----------------------------------------------------------------------+
|                        WHY WE HOLD EARNINGS                           |
+----------------------------------------------------------------------+
|                                                                       |
|  Scenario: Customer books, pays, then demands refund before session   |
|                                                                       |
|  WITHOUT hold:                                                        |
|  +-- Customer pays Rs.1000                                            |
|  +-- We immediately pay consultant Rs.776                             |
|  +-- Customer cancels, wants refund                                   |
|  +-- We're stuck! Consultant already has the money                    |
|                                                                       |
|  WITH 24-hour hold:                                                   |
|  +-- Customer pays Rs.1000                                            |
|  +-- Earnings are PENDING (not available yet)                         |
|  +-- Customer cancels within 24 hours                                 |
|  +-- We refund from our account, cancel the pending earning           |
|  +-- No money was sent to consultant yet!                             |
|                                                                       |
+----------------------------------------------------------------------+
```

---

## Payout States

### Earnings States

```
+------------------+     +------------------+     +------------------+
|    PENDING       | --> |    AVAILABLE     | --> |   PROCESSING     |
| (In 24hr hold)   |     | (Ready for       |     | (In payout batch)|
|                  |     |  payout)         |     |                  |
+------------------+     +------------------+     +--------+---------+
                                                          |
                                   +----------------------+
                                   |
                                   v
+------------------+     +------------------+
|      PAID        | <-- |    (Transfer     |
| (In bank)        |     |     succeeded)   |
+------------------+     +------------------+

Special States:
+------------------+
|    DISPUTED      |  Customer raised dispute, earnings frozen
+------------------+

+------------------+
|    REFUNDED      |  Payment was refunded, earnings cancelled
+------------------+
```

### Payout States

```
PENDING      --> Transfer not yet initiated
PROCESSING   --> Transfer sent to Razorpay
SUCCEEDED    --> Razorpay confirmed transfer
FAILED       --> Transfer failed (will retry)
SETTLED      --> Money in consultant's bank (T+2)
REVERSED     --> Bank rejected/returned funds
```

---

## Transfer Execution

### When Payouts Happen

```
+----------------------------------------------------------------------+
|                     PAYOUT SCHEDULE                                   |
+----------------------------------------------------------------------+
|                                                                       |
|  WHEN: Every Monday at 11:00 PM IST                                   |
|                                                                       |
|  WHO: All consultants with:                                           |
|       +-- Available balance >= Rs.500 (minimum payout)                |
|       +-- Active linked account (KYC verified)                        |
|                                                                       |
|  HOW: GitHub Actions runs our payout job                              |
|       +-- Finds eligible consultants                                  |
|       +-- Creates transfer for each                                   |
|       +-- Updates status to PROCESSING                                |
|                                                                       |
|  SETTLEMENT: Wednesday (T+2 business days)                            |
|                                                                       |
+----------------------------------------------------------------------+
```

### Transfer API Call

```typescript
// For each eligible consultant:
const transfer = await razorpay.transfers.create({
  account: "acc_HjVXtmkFHdMrPT", // Consultant's linked account
  amount: 310400, // Rs.3,104 in paise
  currency: "INR",
  notes: {
    payout_id: "payout_abc123",
    consultant_id: "consultant_xyz",
    week: "2024-W49",
  },
});

// Response:
{
  "id": "trf_xxxxxxxxx",
  "account": "acc_HjVXtmkFHdMrPT",
  "amount": 310400,
  "currency": "INR",
  "status": "processed",
  ...
}
```

---

## Webhook Events for Payouts

### Events We Handle

```
+------------------------+--------------------------------------------+
| Event                  | What Happened                              |
+------------------------+--------------------------------------------+
| transfer.processed     | Transfer initiated, being processed        |
| transfer.settled       | Money reached consultant's bank            |
| transfer.failed        | Transfer failed, needs attention           |
| transfer.reversed      | Bank rejected, money returned              |
+------------------------+--------------------------------------------+
```

### Webhook Flow

```
Razorpay                        Our Server
   |                                 |
   |  transfer.processed             |
   |-------------------------------->|  Mark payout as PROCESSING
   |                                 |  Mark earnings as PROCESSING
   |                                 |
   |  transfer.settled (T+2)         |
   |-------------------------------->|  Mark payout as SETTLED
   |                                 |  Mark earnings as PAID
   |                                 |  Update lastPayoutAt
   |                                 |

   OR if failed:

   |  transfer.failed                |
   |-------------------------------->|  Mark payout as FAILED
   |                                 |  Restore available balance
   |                                 |  Queue for retry
   |                                 |
```

---

## What Consultant Sees

### Dashboard View

```
+-----------------------------------------------------------------------+
|                     CONSULTANT DASHBOARD                               |
+-----------------------------------------------------------------------+
|                                                                        |
|   Earnings Overview                                                    |
|   +----------------------------------------------------------------+  |
|   |                                                                |  |
|   |   Total Earned (December 2024)     Rs. 45,600                  |  |
|   |                                                                |  |
|   |   +-------------+  +-------------+  +-------------+            |  |
|   |   |  ON HOLD    |  |  AVAILABLE  |  |    PAID     |            |  |
|   |   |  Rs. 2,400  |  |  Rs. 8,200  |  | Rs. 35,000  |            |  |
|   |   | (24hr wait) |  | (Ready for  |  | (In your    |            |  |
|   |   |             |  |  payout)    |  |  bank)      |            |  |
|   |   +-------------+  +-------------+  +-------------+            |  |
|   |                                                                |  |
|   +----------------------------------------------------------------+  |
|                                                                        |
|   Bank Account                                                         |
|   +----------------------------------------------------------------+  |
|   |   Bank: HDFC Bank                                              |  |
|   |   Account: ************4521                                    |  |
|   |   Status: Verified                                             |  |
|   +----------------------------------------------------------------+  |
|                                                                        |
|   Next Payout                                                          |
|   +----------------------------------------------------------------+  |
|   |   Date: Monday, Dec 9 at 11:00 PM                              |  |
|   |   Amount: Rs. 8,200                                            |  |
|   |   Expected in Bank: Wednesday, Dec 11                          |  |
|   +----------------------------------------------------------------+  |
|                                                                        |
|   Recent Payouts                                                       |
|   +----------------------------------------------------------------+  |
|   |   Dec 4   Rs. 12,400   Settled (HDFC ****4521)                 |  |
|   |   Nov 27  Rs. 8,600    Settled (HDFC ****4521)                 |  |
|   |   Nov 20  Rs. 14,000   Settled (HDFC ****4521)                 |  |
|   +----------------------------------------------------------------+  |
|                                                                        |
+-----------------------------------------------------------------------+
```

### Balance Breakdown

```
+------------------+------------------------------------------------+
| Balance Type     | Meaning                                        |
+------------------+------------------------------------------------+
| On Hold          | Earned in last 24 hours, waiting for          |
|                  | refund window to pass                          |
+------------------+------------------------------------------------+
| Available        | Ready to be paid out on Monday                 |
+------------------+------------------------------------------------+
| Paid             | Already transferred to your bank               |
+------------------+------------------------------------------------+
```

---

## Common Scenarios

### Scenario 1: Normal Weekly Payout

```
Monday:    Priya does 2 sessions, earns Rs.1,552
Tuesday:   1 session, earns Rs.776
Wednesday: No sessions
Thursday:  3 sessions, earns Rs.2,328
Friday:    1 session, earns Rs.776
           --------------------------
           Total Available: Rs.5,432

Monday 11 PM: Payout job runs
              Transfer Rs.5,432 to acc_HjVXtmk

Wednesday: Rs.5,432 lands in Priya's HDFC account
```

### Scenario 2: Customer Refund Before Session

```
Monday 10 AM: Customer pays Rs.1,000
              Priya's earnings: Rs.776 (PENDING)

Monday 2 PM:  Customer cancels, requests refund

              What happens:
              +-- Refund Rs.1,000 to customer
              +-- Cancel Priya's earnings record
              +-- Priya's balance unchanged

              Priya never sees this money because
              it was still in 24-hour hold.
```

### Scenario 3: Refund After Session

```
Monday 10 AM: Customer pays Rs.1,000
Monday 11 AM: Session happens
Monday 12 PM: Hold released, Rs.776 AVAILABLE

Tuesday 3 PM: Customer requests refund

              What happens:
              +-- We decide to refund (policy decision)
              +-- Refund Rs.1,000 to customer
              +-- Deduct Rs.776 from Priya's available balance

              If already paid out:
              +-- Deduct from next payout
              +-- Or recover manually
```

### Scenario 4: Failed Transfer

```
Monday 11 PM: Payout initiated for Rs.5,432
              Transfer to acc_HjVXtmk

Wednesday:    Razorpay webhook: transfer.failed
              Reason: "Invalid bank account"

              What happens:
              +-- Mark payout as FAILED
              +-- Restore Rs.5,432 to available balance
              +-- Send email to Priya: "Update bank details"
              +-- Admin alerted

Next Monday:  After Priya updates bank details,
              next payout includes this amount
```

---

## Error Handling

### Common Payout Errors

```
+---------------------------+------------------------------------------+
| Error                     | Resolution                               |
+---------------------------+------------------------------------------+
| INSUFFICIENT_BALANCE      | Wait for more payments to settle         |
| INVALID_ACCOUNT           | Consultant needs to update bank details  |
| ACCOUNT_SUSPENDED         | Contact Razorpay, re-verify KYC          |
| TRANSFER_LIMIT_EXCEEDED   | Split into multiple transfers            |
| BANK_ACCOUNT_CLOSED       | Consultant needs new bank details        |
+---------------------------+------------------------------------------+
```

### Retry Logic

```
Transfer failed?
     |
     v
Mark as FAILED
Restore balance
     |
     v
Wait for next Monday
     |
     v
If consultant updated details -> Retry automatically
If not -> Send reminder email
     |
     v
After 3 failed weeks -> Flag for manual review
```

---

## Security & Compliance

### What We Store vs What Razorpay Stores

```
+------------------------+------------------------+
|     WE STORE           |    RAZORPAY STORES     |
+------------------------+------------------------+
| Linked Account ID      | Full bank account      |
| (acc_xxxxx)            | number                 |
|                        |                        |
| Masked display         | IFSC code              |
| (HDFC ****4521)        |                        |
|                        | Beneficiary name       |
| KYC status             |                        |
| (VERIFIED/PENDING)     | PAN details            |
|                        |                        |
| Payout history         | Verification status    |
+------------------------+------------------------+

We NEVER store full bank account numbers.
This is for security and PCI compliance.
```

### Audit Trail

```
Every payout action is logged:

+-- Who initiated (system/admin)
+-- When (timestamp)
+-- Amount
+-- Status changes
+-- Any errors
+-- Webhook events received
```

---

## Related Documents

- [01-setup.md](./01-setup.md) - Razorpay setup
- [02-architecture-and-flow.md](./02-architecture-and-flow.md) - Payment flow
- [/docs/payments/payouts/razorpay-payouts-code.md](/docs/payments/payouts/razorpay-payouts-code.md) - Code implementation
- [Razorpay Route Docs](https://razorpay.com/docs/payments/route/)
