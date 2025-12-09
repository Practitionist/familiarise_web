# Stripe Connect Payout Flow

## Overview

This document explains how consultants receive their earnings through Stripe Connect. If you're new to the team, read this to understand how international consultants get paid.

### Quick Summary

```
Payment captured from customer
        |
        v
   [ EARNINGS CREATED ]
   Status: ON_HOLD (24hr)
        |
        | After 24 hours
        v
   [ EARNINGS AVAILABLE ]
   Ready for payout
        |
        | Monday (weekly payout)
        v
   [ TRANSFER CREATED ]
   Money sent to Connected Account
        |
        | 2-7 business days
        v
   [ MONEY IN BANK ]
   Consultant paid!
```

---

## Key Concept: Connected Accounts

### The Big Idea

```
+------------------------------------------------------------------+
|                                                                    |
|   Q: Does the consultant need a Stripe account?                    |
|   A: NO! We create a "Connected Account" for them.                 |
|                                                                    |
|   The consultant just provides:                                    |
|   - Nothing upfront! Stripe collects everything via hosted flow    |
|                                                                    |
|   Stripe handles:                                                  |
|   - ID verification (country-specific)                             |
|   - Bank account collection                                        |
|   - Tax information (W-9, W-8BEN, etc.)                            |
|   - Compliance per country                                         |
|                                                                    |
+------------------------------------------------------------------+
```

### Connected Account Model

```
+--------------------------------------------------------------------+
|              FAMILIARISE STRIPE PLATFORM ACCOUNT                    |
|                    (Master Account)                                 |
|                                                                     |
|  +---------------+  +---------------+  +---------------+            |
|  |   Connected   |  |   Connected   |  |   Connected   |            |
|  |   Account 1   |  |   Account 2   |  |   Account 3   |   ...      |
|  |   (USA)       |  |   (UK)        |  |   (Germany)   |            |
|  | acct_xxxxx1   |  | acct_xxxxx2   |  | acct_xxxxx3   |            |
|  +-------+-------+  +-------+-------+  +-------+-------+            |
|          |                  |                  |                    |
+--------------------------------------------------------------------+
           |                  |                  |
           v                  v                  v
    +------------+     +------------+     +------------+
    | Chase Bank |     | Barclays   |     | Deutsche   |
    | (USD)      |     | (GBP)      |     | Bank (EUR) |
    +------------+     +------------+     +------------+

Each consultant gets their OWN Connected Account
Money goes directly to THEIR bank account
In THEIR local currency!
```

### Stripe vs Razorpay: Connected vs Linked

```
+-----------------------------+------------------+------------------+
| Feature                     | Razorpay Route   | Stripe Connect   |
+-----------------------------+------------------+------------------+
| Account Type                | Linked Account   | Connected Account|
| Who Collects KYC?           | We do (via API)  | Stripe (hosted)  |
| Consultant Provides         | PAN, Bank, IFSC  | Just clicks link |
| Countries Supported         | India only       | 45+ countries    |
| Currency                    | INR only         | 135+ currencies  |
| KYC Complexity              | Simple (Indian)  | Varies by country|
| Onboarding Experience       | Form in our app  | Stripe's UI      |
| Settlement Time             | T+2 days         | 2-7 business days|
+-----------------------------+------------------+------------------+
```

---

## Connected Account Types

### Express Accounts (What We Use)

```
+------------------------------------------------------------------+
|                    EXPRESS ACCOUNTS                                |
+------------------------------------------------------------------+
|                                                                    |
|  Best for: Marketplaces like Familiarise                           |
|                                                                    |
|  Characteristics:                                                  |
|  +-- Stripe handles ALL onboarding                                 |
|  +-- Stripe handles ALL identity verification                      |
|  +-- Stripe handles ALL compliance                                 |
|  +-- Consultant uses Stripe's dashboard (limited)                  |
|  +-- We control transfers and payout schedule                      |
|                                                                    |
|  Our Responsibility:                                               |
|  +-- Provide onboarding link                                       |
|  +-- Create transfers when ready                                   |
|  +-- Handle webhook events                                         |
|                                                                    |
|  Stripe's Responsibility:                                          |
|  +-- Collect personal information                                  |
|  +-- Verify identity documents                                     |
|  +-- Collect bank account details                                  |
|  +-- Handle tax forms (1099, W-8BEN, etc.)                         |
|  +-- Ensure compliance per country                                 |
|                                                                    |
+------------------------------------------------------------------+
```

### Account Type Comparison

```
+------------------+------------------+------------------+------------------+
| Feature          | Standard         | Express          | Custom           |
+------------------+------------------+------------------+------------------+
| Onboarding       | Their own        | Stripe hosted    | You build it     |
| Branding         | Stripe           | Stripe + yours   | Fully custom     |
| Dashboard        | Full Stripe      | Limited Stripe   | Your own         |
| Effort           | Low              | Low              | High             |
| Control          | Low              | Medium           | High             |
+------------------+------------------+------------------+------------------+

We use EXPRESS because:
- Low development effort
- Stripe handles compliance
- Good user experience
- Sufficient control for our needs
```

---

## Consultant Onboarding Flow

### Step-by-Step Process

```
+-------------+          +-------------+          +-------------+
| Familiarise |          |   Stripe    |          | Consultant  |
|   Server    |          |   Servers   |          |  (Browser)  |
+------+------+          +------+------+          +------+------+
       |                        |                        |
       |  1. Create Account     |                        |
       |----------------------->|                        |
       |                        |                        |
       |  2. Return account_id  |                        |
       |     (acct_xxxxx)       |                        |
       |<-----------------------|                        |
       |                        |                        |
       |  3. Create Account Link|                        |
       |----------------------->|                        |
       |                        |                        |
       |  4. Return onboarding URL                       |
       |<-----------------------|                        |
       |                        |                        |
       |  5. Send URL to consultant                      |
       |------------------------------------------------>|
       |                        |                        |
       |                        |  6. Consultant opens   |
       |                        |     Stripe onboarding  |
       |                        |<-----------------------|
       |                        |                        |
       |                        |  7. Fills in details:  |
       |                        |     - Personal info    |
       |                        |     - ID verification  |
       |                        |     - Bank account     |
       |                        |     - Tax info         |
       |                        |<---------------------->|
       |                        |                        |
       |  8. Webhook: account.updated                    |
       |<-----------------------|                        |
       |                        |                        |
       |  9. Consultant redirected back                  |
       |<------------------------------------------------|
```

### What Consultant Sees

```
STRIPE ONBOARDING FLOW (Consultant's View)
==========================================

Screen 1: Personal Information
+------------------------------------------+
|         Complete your profile            |
|                                          |
|  First Name: [________________]          |
|  Last Name:  [________________]          |
|  Email:      [________________]          |
|  Phone:      [________________]          |
|                                          |
|  Date of Birth: [__] / [__] / [____]     |
|                                          |
|  Address:                                |
|  [____________________________________]  |
|  [____________________________________]  |
|  City:    [________________]             |
|  Country: [United States      v]         |
|  ZIP:     [________________]             |
|                                          |
|              [ Continue ]                |
+------------------------------------------+

Screen 2: Identity Verification
+------------------------------------------+
|       Verify your identity               |
|                                          |
|  Upload a government-issued ID:          |
|                                          |
|  +------------------------------------+  |
|  |                                    |  |
|  |  [ Upload front of ID ]            |  |
|  |                                    |  |
|  +------------------------------------+  |
|                                          |
|  +------------------------------------+  |
|  |                                    |  |
|  |  [ Upload back of ID ]             |  |
|  |                                    |  |
|  +------------------------------------+  |
|                                          |
|  Accepted: Passport, Driver's License,   |
|            National ID Card              |
|                                          |
|              [ Continue ]                |
+------------------------------------------+

Screen 3: Bank Account
+------------------------------------------+
|      Add your bank account               |
|                                          |
|  Country: [United States      v]         |
|                                          |
|  Account Holder Name:                    |
|  [____________________________________]  |
|                                          |
|  Routing Number (9 digits):              |
|  [____________________________________]  |
|                                          |
|  Account Number:                         |
|  [____________________________________]  |
|                                          |
|  Account Type:                           |
|  ( ) Checking  ( ) Savings               |
|                                          |
|              [ Continue ]                |
+------------------------------------------+

Screen 4: Tax Information (US Example)
+------------------------------------------+
|      Tax information                     |
|                                          |
|  Are you a US person for tax purposes?   |
|  ( ) Yes - I'll provide W-9 info         |
|  ( ) No - I'll provide W-8BEN info       |
|                                          |
|  Social Security Number:                 |
|  [___]-[__]-[____]                       |
|                                          |
|  OR Tax ID:                              |
|  [____________________________________]  |
|                                          |
|              [ Submit ]                  |
+------------------------------------------+

Screen 5: Complete!
+------------------------------------------+
|                                          |
|              SUCCESS!                    |
|                                          |
|    Your account setup is complete.       |
|    You can now receive payouts from      |
|    Familiarise.                          |
|                                          |
|    [ Return to Familiarise ]             |
|                                          |
+------------------------------------------+
```

### Account Status States

```
                    +-------------------+
                    | restricted        |  Just created, needs onboarding
                    +--------+----------+
                             |
                             | Consultant completes onboarding
                             v
                    +-------------------+
                    | pending           |  Under Stripe review
                    +--------+----------+
                             |
                             | Stripe approves
                             v
                    +-------------------+
                    | enabled           |  Ready for transfers!
                    +-------------------+

                             OR

                    +-------------------+
                    | restricted        |  Additional docs needed
                    +-------------------+

State Descriptions:
+------------------+-----------------------------------------------+
| State            | Meaning                                       |
+------------------+-----------------------------------------------+
| restricted       | Can't receive payouts, action needed          |
| pending          | Under Stripe review                           |
| enabled          | Fully operational, can receive transfers      |
+------------------+-----------------------------------------------+
```

---

## Transfer Flow (Payouts)

### Weekly Payout Cycle

```
WEEKLY PAYOUT TIMELINE (International Consultants)
==================================================

Sunday Night
+-----------------------------------------------------------------+
|  Scheduled job runs to identify eligible payouts                 |
|  - Find all earnings with status = AVAILABLE                     |
|  - Group by consultant's connected account                       |
|  - Check: Account status = enabled                               |
|  - Check: Available balance > minimum threshold                  |
+-----------------------------------------------------------------+
                              |
                              v
Monday 12:00 AM UTC
+-----------------------------------------------------------------+
|  Create Stripe Transfers                                         |
|  - For each eligible consultant:                                 |
|    - Calculate total available balance                           |
|    - Create transfer to connected account                        |
|    - Update earnings status to PROCESSING                        |
+-----------------------------------------------------------------+
                              |
                              v
Monday - Friday (2-7 business days, varies by country)
+-----------------------------------------------------------------+
|  Stripe processes transfers                                      |
|  - Converts currency if needed                                   |
|  - Initiates bank transfer                                       |
|  - Webhook: transfer.paid when complete                          |
+-----------------------------------------------------------------+
                              |
                              v
Settlement Day
+-----------------------------------------------------------------+
|  Money arrives in consultant's bank                              |
|  - Update earnings status to SETTLED                             |
|  - Update payout record                                          |
|  - Notify consultant                                             |
+-----------------------------------------------------------------+


Settlement Times by Country:
+------------------+------------------+
| Country          | Settlement       |
+------------------+------------------+
| USA              | 2 business days  |
| UK               | 3 business days  |
| EU (SEPA)        | 4 business days  |
| Australia        | 3 business days  |
| Canada           | 2 business days  |
| Others           | 5-7 business days|
+------------------+------------------+
```

### Transfer Creation Flow

```
+-------------+          +-------------+          +-------------+
| Payout Job  |          |   Stripe    |          | Consultant  |
|  (Server)   |          |   API       |          |  Account    |
+------+------+          +------+------+          +------+------+
       |                        |                        |
       |  1. Get available balance                       |
       |     for consultant                              |
       |----------------------->|                        |
       |                        |                        |
       |  2. Return balance     |                        |
       |<-----------------------|                        |
       |                        |                        |
       |  3. Create transfer    |                        |
       |     amount: $156       |                        |
       |     destination: acct_xxx                       |
       |----------------------->|                        |
       |                        |                        |
       |  4. Transfer created   |                        |
       |     tr_xxxxx           |                        |
       |<-----------------------|                        |
       |                        |                        |
       |                        |  5. Funds added to     |
       |                        |     connected account  |
       |                        |----------------------->|
       |                        |                        |
       |                        |  6. Stripe initiates   |
       |                        |     bank payout        |
       |                        |----------------------->|
       |                        |                        |
       |  7. Webhook: transfer.paid                      |
       |<-----------------------|                        |
```

### Multi-Currency Transfers

```
CURRENCY CONVERSION EXAMPLE
===========================

Customer in USA pays: $100 USD
                        |
                        v
Platform receives: $100 USD (after Stripe fees)
                        |
                        | Calculate consultant share
                        v
Consultant in UK gets: ~62 GBP
                        |
                        | Stripe converts automatically
                        v
Deposited in: Barclays Bank (GBP)


How It Works:
+------------------------------------------------------------------+
|                                                                    |
|  1. Customer pays in THEIR currency (USD)                          |
|  2. We hold funds in platform currency (USD)                       |
|  3. When we create transfer, Stripe converts to consultant's       |
|     bank account currency (GBP)                                    |
|  4. Consultant receives in THEIR currency (GBP)                    |
|                                                                    |
|  Stripe handles:                                                   |
|  - Real-time exchange rates                                        |
|  - Currency conversion fees (~2% built into rate)                  |
|  - Settlement in local currency                                    |
|                                                                    |
+------------------------------------------------------------------+

Transfer Options:
+------------------------------------------------------------------+
| Option A: Transfer in source currency (what we do)                 |
|                                                                    |
|   stripe.transfers.create({                                        |
|     amount: 7800,  // $78.00 USD                                   |
|     currency: 'usd',                                               |
|     destination: 'acct_xxxxx',                                     |
|   });                                                              |
|                                                                    |
|   Stripe converts to consultant's bank currency                    |
+------------------------------------------------------------------+
| Option B: Transfer in destination currency                         |
|                                                                    |
|   stripe.transfers.create({                                        |
|     amount: 6200,  // 62.00 GBP                                    |
|     currency: 'gbp',                                               |
|     destination: 'acct_xxxxx',                                     |
|   });                                                              |
|                                                                    |
|   You handle conversion, more control over FX                      |
+------------------------------------------------------------------+
```

---

## Payout States

### Earnings Status Flow

```
                    +-------------------+
                    |     ON_HOLD       |  24hr hold after payment
                    +--------+----------+
                             |
                             | Hold period expires
                             v
                    +-------------------+
                    |    AVAILABLE      |  Ready for weekly payout
                    +--------+----------+
                             |
                             | Weekly payout job runs
                             v
                    +-------------------+
                    |   PROCESSING      |  Transfer created
                    +--------+----------+
                             |
           +-----------------+-----------------+
           |                                   |
           | transfer.paid                     | transfer.failed
           v                                   v
    +-------------+                    +-------------+
    |    PAID     |                    |   FAILED    |
    +------+------+                    +------+------+
           |                                   |
           | Bank confirms                     | Retry next week
           v                                   |
    +-------------+                            |
    |   SETTLED   |<---------------------------+
    +-------------+    (After retry succeeds)


Status Descriptions:
+------------------+-----------------------------------------------+
| Status           | Meaning                                       |
+------------------+-----------------------------------------------+
| ON_HOLD          | Payment captured, waiting 24hr hold           |
| AVAILABLE        | Ready to be included in weekly payout         |
| PROCESSING       | Transfer created, in transit                  |
| PAID             | Stripe confirmed transfer complete            |
| SETTLED          | Money confirmed in consultant's bank          |
| FAILED           | Transfer failed, will retry                   |
| REFUNDED         | Payment was refunded, earnings reversed       |
+------------------+-----------------------------------------------+
```

### Transfer Webhook Events

```
+---------------------------+-------------------------------------------+
| Event                     | When It Fires                             |
+---------------------------+-------------------------------------------+
| transfer.created          | Transfer initiated                        |
| transfer.paid             | Transfer completed successfully           |
| transfer.failed           | Transfer failed (bad bank info, etc.)     |
| transfer.reversed         | Transfer reversed (rare)                  |
+---------------------------+-------------------------------------------+
```

### What We Do On Each Event

```
transfer.created:
+-- Log transfer initiation
+-- Update payout record status to PROCESSING
+-- No action needed (informational)

transfer.paid:
+-- Update earnings status to PAID
+-- Update payout record with completion time
+-- Send notification to consultant
+-- Log for audit

transfer.failed:
+-- Update earnings status back to AVAILABLE
+-- Update payout record with failure reason
+-- Alert operations team
+-- Will retry on next payout cycle
+-- Common reasons:
    - Invalid bank account
    - Account closed
    - Account restricted
    - Compliance issue

transfer.reversed:
+-- Rare - usually means bank returned funds
+-- Update earnings status to AVAILABLE
+-- Alert operations team
+-- Contact consultant about bank issue
```

---

## Consultant Dashboard View

### What They See

```
CONSULTANT EARNINGS DASHBOARD
=============================

+------------------------------------------------------------------+
|                    EARNINGS OVERVIEW                              |
+------------------------------------------------------------------+
|                                                                    |
|  +----------------+  +----------------+  +----------------+        |
|  |   PENDING      |  |   AVAILABLE    |  |   TOTAL PAID  |        |
|  |    $156.00     |  |    $312.00     |  |   $2,340.00   |        |
|  | (In 24hr hold) |  | (Ready for     |  | (Lifetime)    |        |
|  |                |  |  next payout)  |  |               |        |
|  +----------------+  +----------------+  +----------------+        |
|                                                                    |
+------------------------------------------------------------------+

RECENT EARNINGS
---------------
+----------+-------------------+--------+------------+---------------+
| Date     | Session           | Gross  | Net        | Status        |
+----------+-------------------+--------+------------+---------------+
| Dec 7    | John D. - Career  | $100   | $77.44     | ON_HOLD       |
| Dec 6    | Sarah M. - Resume | $100   | $77.44     | ON_HOLD       |
| Dec 5    | Mike R. - Career  | $100   | $77.44     | AVAILABLE     |
| Dec 4    | Lisa K. - Mock    | $100   | $77.44     | AVAILABLE     |
| Dec 3    | Tom B. - Career   | $100   | $77.44     | AVAILABLE     |
| Dec 2    | Jane D. - Resume  | $100   | $77.44     | AVAILABLE     |
+----------+-------------------+--------+------------+---------------+

PAYOUT HISTORY
--------------
+----------+------------+-------------------+------------+
| Date     | Amount     | Account           | Status     |
+----------+------------+-------------------+------------+
| Dec 2    | $310.00    | Chase ****4567    | SETTLED    |
| Nov 25   | $465.00    | Chase ****4567    | SETTLED    |
| Nov 18   | $232.00    | Chase ****4567    | SETTLED    |
+----------+------------+-------------------+------------+

NEXT PAYOUT
-----------
+------------------------------------------------------------------+
|  Amount: $309.76 (4 sessions)                                     |
|  Scheduled: Monday, Dec 9, 2024                                   |
|  Expected arrival: Dec 11-12, 2024                                |
|  Destination: Chase Bank ****4567                                 |
+------------------------------------------------------------------+
```

### Breakdown View

```
EARNING BREAKDOWN (Single Session)
==================================

+------------------------------------------------------------------+
|  Session: Career Consultation with John D.                        |
|  Date: December 7, 2024                                           |
+------------------------------------------------------------------+
|                                                                    |
|  Customer Paid:                      $100.00                       |
|                                                                    |
|  Deductions:                                                       |
|  +-- Gateway Fee (Stripe 2.9%+$0.30): - $3.20                      |
|  +-- Platform Commission (20%):       - $19.36                     |
|                                       --------                     |
|  Your Earnings:                        $77.44                      |
|                                                                    |
|  Status: ON_HOLD (Available Dec 8)                                 |
|                                                                    |
+------------------------------------------------------------------+
```

---

## Code Examples

### Create Connected Account

```typescript
// lib/payments/payouts/stripe/connected-accounts.ts

import stripe from "@/lib/payments/core/stripe";

export async function createConnectedAccount(consultantId: string) {
  // Create Express account
  const account = await stripe.accounts.create({
    type: "express",
    country: "US", // Will be determined by consultant
    email: consultant.email,
    metadata: {
      consultantId,
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });

  // Store account ID
  await prisma.consultantProfile.update({
    where: { id: consultantId },
    data: {
      stripeConnectedAccountId: account.id,
    },
  });

  return account;
}
```

### Create Onboarding Link

```typescript
export async function createOnboardingLink(accountId: string) {
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/payout-settings?refresh=true`,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/payout-settings?success=true`,
    type: "account_onboarding",
  });

  return accountLink.url;
}
```

### Create Transfer

```typescript
// lib/payments/payouts/stripe/transfers.ts

export async function createPayout(
  connectedAccountId: string,
  amount: number,
  currency: string,
  earningIds: string[]
) {
  // Create transfer to connected account
  const transfer = await stripe.transfers.create({
    amount: amount, // Already in smallest unit (cents)
    currency: currency.toLowerCase(),
    destination: connectedAccountId,
    metadata: {
      earningIds: earningIds.join(","),
    },
  });

  // Update earnings status
  await prisma.consultantEarnings.updateMany({
    where: { id: { in: earningIds } },
    data: {
      status: "PROCESSING",
      payoutTransferId: transfer.id,
    },
  });

  // Create payout record
  await prisma.consultantPayout.create({
    data: {
      consultantProfileId: consultant.id,
      amount,
      currency,
      gateway: "STRIPE",
      transferId: transfer.id,
      status: "PROCESSING",
    },
  });

  return transfer;
}
```

### Handle Transfer Webhook

```typescript
// app/api/webhooks/stripe-connect/route.ts

export async function POST(req: Request) {
  const body = await req.text();
  const signature = headers().get("stripe-signature")!;

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET!
    );
  } catch (err) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  switch (event.type) {
    case "transfer.paid":
      await handleTransferPaid(event.data.object);
      break;

    case "transfer.failed":
      await handleTransferFailed(event.data.object);
      break;

    case "account.updated":
      await handleAccountUpdated(event.data.object);
      break;
  }

  return Response.json({ received: true });
}

async function handleTransferPaid(transfer: Stripe.Transfer) {
  const earningIds = transfer.metadata.earningIds.split(",");

  await prisma.consultantEarnings.updateMany({
    where: { id: { in: earningIds } },
    data: {
      status: "PAID",
      paidAt: new Date(),
    },
  });

  await prisma.consultantPayout.update({
    where: { transferId: transfer.id },
    data: {
      status: "PAID",
      completedAt: new Date(),
    },
  });

  // Notify consultant
  await sendPayoutNotification(transfer.destination, transfer.amount);
}

async function handleTransferFailed(transfer: Stripe.Transfer) {
  const earningIds = transfer.metadata.earningIds.split(",");

  // Revert earnings back to available
  await prisma.consultantEarnings.updateMany({
    where: { id: { in: earningIds } },
    data: {
      status: "AVAILABLE",
      payoutTransferId: null,
    },
  });

  await prisma.consultantPayout.update({
    where: { transferId: transfer.id },
    data: {
      status: "FAILED",
      failureReason: transfer.failure_message,
    },
  });

  // Alert operations
  await alertOperationsTeam({
    type: "TRANSFER_FAILED",
    accountId: transfer.destination,
    amount: transfer.amount,
    reason: transfer.failure_message,
  });
}
```

---

## Common Scenarios

### Scenario 1: Normal Payout

```
Timeline:
---------
Monday:    Customer pays $100 for consultation
           - Payment captured by Stripe
           - Earnings created: $77.44 (ON_HOLD)

Tuesday:   24-hour hold expires
           - Earnings status: AVAILABLE

Sunday:    Weekly payout job identifies consultant
           - Available balance: $77.44
           - Account status: enabled

Monday:    Transfer created
           - $77.44 sent to connected account
           - Earnings status: PROCESSING

Wednesday: Transfer completes (US bank, 2 days)
           - Webhook: transfer.paid
           - Earnings status: PAID
           - Consultant notified
```

### Scenario 2: Refund During Hold

```
Timeline:
---------
Monday:    Customer pays $100
           - Earnings created: ON_HOLD

Tuesday:   Customer requests refund (within 24hr)
           - Refund processed
           - Earnings status: REFUNDED
           - Consultant never sees funds

Result: Platform absorbs any fees, consultant not affected
```

### Scenario 3: Refund After Session

```
Timeline:
---------
Monday:    Customer pays $100, session happens
           - Earnings: ON_HOLD -> AVAILABLE

Wednesday: Customer disputes, we refund
           - If not yet paid: Earnings status: REFUNDED
           - If already paid: Recovery process

Recovery Process:
- Platform covers the refund immediately
- Consultant notified of refund
- Next payout reduced by refund amount
- OR: Consultant balance goes negative (rare)
```

### Scenario 4: Failed Transfer

```
Timeline:
---------
Monday:    Transfer created to consultant

Tuesday:   Transfer fails
           - Reason: "Bank account closed"
           - Webhook: transfer.failed

Actions:
- Earnings reverted to AVAILABLE
- Operations team alerted
- Consultant notified to update bank
- Will retry on next payout cycle
```

### Scenario 5: Account Restricted

```
Timeline:
---------
Consultant onboarded successfully

Later:     Stripe restricts account
           - Reason: Additional verification needed

Impact:
- Transfers blocked
- Consultant notified
- Must complete verification
- Funds accumulate until resolved
```

---

## Testing

### Test Connected Accounts

```bash
# Using Stripe CLI

# Create test connected account
stripe accounts create \
  --type express \
  --country US \
  --email test@example.com

# Get account link for testing
stripe account_links create \
  --account acct_xxxxx \
  --type account_onboarding \
  --refresh-url http://localhost:3000/refresh \
  --return-url http://localhost:3000/return
```

### Test Transfers

```bash
# Create test transfer
stripe transfers create \
  --amount 5000 \
  --currency usd \
  --destination acct_xxxxx

# Trigger transfer events
stripe trigger transfer.paid
stripe trigger transfer.failed
```

### Testing Checklist

```
Connected Account Setup:
[ ] Account creation works
[ ] Onboarding link generated
[ ] Consultant can complete onboarding
[ ] account.updated webhook received
[ ] Account status tracked correctly

Transfer Flow:
[ ] Transfer creation works
[ ] Correct amount calculated
[ ] transfer.paid webhook handled
[ ] transfer.failed webhook handled
[ ] Earnings status updated correctly
[ ] Payout record created

Edge Cases:
[ ] Account restricted during payout
[ ] Insufficient platform balance
[ ] Currency conversion works
[ ] Multiple earnings in one transfer
```

---

## Error Handling

### Common Errors

```
+--------------------------------+------------------------------------------+
| Error                          | What To Do                               |
+--------------------------------+------------------------------------------+
| account_invalid                | Account doesn't exist or was deleted     |
| amount_too_large               | Exceeds available balance                |
| amount_too_small               | Below minimum ($1.00)                    |
| insufficient_funds             | Platform balance too low                 |
| account_country_invalid        | Account in unsupported country           |
+--------------------------------+------------------------------------------+
```

### Retry Strategy

```
For transfer failures:

1. Log failure with reason
2. Alert operations team
3. Update earnings back to AVAILABLE
4. Will automatically retry next payout cycle

For persistent failures (3+ attempts):
1. Flag account for manual review
2. Contact consultant directly
3. May need to update bank details
```

---

## Related Documents

- [01-setup.md](./01-setup.md) - Initial Stripe setup
- [02-architecture-and-flow.md](./02-architecture-and-flow.md) - Payment flow
- [stripe-payouts-code.md](../../payouts/stripe-payouts-code.md) - Full code implementation
- [Stripe Connect Docs](https://stripe.com/docs/connect)
- [Stripe Transfers API](https://stripe.com/docs/api/transfers)
