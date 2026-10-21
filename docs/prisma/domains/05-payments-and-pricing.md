---
type: reference
title: Familiarise — Schema map, Payments & Pricing
---

# Schema map — Payments & Pricing

Money in, money back, and the platform's own fee policy.

Part 5 of 10 of the domain map. The
[map index](../00-schema-map.md) holds the master diagram, the enforcer
inventory and the enum reference.

## 1. Payments, Refunds & Disputes

Money enters through `Payment` and is funded by one or more `PaymentLeg` rows. A `Refund` reverses it, a `Dispute` is the gateway's chargeback, `IdempotencyRecord` makes a write replay-safe, `WebhookEvent` deduplicates gateway callbacks, and `DiscountCode` carries the promotional reduction.

```mermaid
erDiagram
    Payment {
        id string PK
        amount bigint
        attributionReferralId string FK
        userId string FK
        appointmentId string FK
        discountCodeId string FK
    }
    PaymentLeg {
        id string PK
        amountPaise bigint
        paymentId string FK
        createdAt datetime
        source paymentlegsource
        sourceRef string
    }
    Refund {
        id string PK
        status refundstatus
        amountPaise bigint
        paymentId string FK
        createdAt datetime
        currency currency
    }
    Dispute {
        id string PK
        status disputestatus
        amountPaise bigint
        paymentId string FK
        assignedToUserId string FK
        createdAt datetime
    }
    IdempotencyRecord {
        id string PK
        createdAt datetime
        scope string
        key string
        userId string
        requestHash string
    }
    WebhookEvent {
        id string PK
        provider string
        eventId string UK
        eventType string
        payload json
        signature string
    }
    DiscountCode {
        id string PK
        createdAt datetime
        code string UK
        description string
        discountType discounttype
        discountValue int
    }
    User {
        id string PK
    }
    Appointment {
        id string PK
    }
    Organization {
        id string PK
    }
    BillingAccount {
        id string PK
    }
    Payment }o--|| User : "user"
    Payment }o--o| Appointment : "appointment"
    Payment }o--o| DiscountCode : "discountCode"
    Payment }o--o| Organization : "organization"
    Payment }o--o| Organization : "hostOrganization"
    Payment }o--o| BillingAccount : "billingAccount"
    Payment }o--o| Payment : "parentPayment"
    PaymentLeg }o--|| Payment : "payment"
    Refund }o--|| Payment : "payment"
    Dispute }o--|| Payment : "payment"
    Dispute }o--o| User : "assignedTo"
    Appointment }o--o| Organization : "organization"
    Organization }o--o| BillingAccount : "billingAccount"
```

- **All money columns are `BigInt` paise.** Settlement is INR only, and `payment_currency_inr`, `refund_currency_inr` and `dispute_currency_inr` refuse any other currency at the database level.
- **The legs must sum to the payment.** `payment_legs_sum_to_amount` is a constraint trigger that refuses a `Payment` whose legs do not add up, and `payment_amount_vs_legs` keeps the header amount consistent with them. `payment_refunds_within_amount` refuses refunds beyond the captured amount.
- **`Payment.paymentStatus = SUCCEEDED` is written by exactly one pipeline** — the payment confirmation handler. Every other status transition is a conditional update that names the expected prior status in its `WHERE` clause.

## 2. Platform Pricing & Fee Policy

The platform's own pricing knobs. `PlatformPricingConfig` holds global floors such as the minimum trial price; `PlatformFeeSchedule` is the effective fee table with a validity window; `ConsultantFeeWaiver` is a per-consultant concession.

```mermaid
erDiagram
    PlatformPricingConfig {
        id string PK
        minTrialPriceInPaise bigint
        createdAt datetime
        updatedAt datetime
    }
    PlatformFeeSchedule {
        id string PK
        createdAt datetime
        marketplaceBps int
        ownLinkBps int
        effectiveFrom datetime
        makerUserId string
    }
    ConsultantFeeWaiver {
        id string PK
        consultantProfileId string FK
        referralId string FK
        createdAt datetime
        reason consultantfeewaiverreason
        sessionsRemaining int
    }
    ConsultantProfile {
        id string PK
    }
    ConsultantFeeWaiver }o--|| ConsultantProfile : "consultantProfile"
```

- **Fee policy is versioned by validity window, not edited.** `platform_fee_schedule_valid` refuses a schedule whose window or basis points are nonsense, and the pricing code reads the schedule effective on the booking date, not the newest one.
