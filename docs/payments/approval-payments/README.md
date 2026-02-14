# Approval Payments Workflow

## Overview

The **Approval Payments** feature enables consultants to approve consultation and subscription requests before payment, generating a payment link for consultees to complete payment within 48 hours. This addresses the business requirement of allowing consultants to reserve slots while awaiting payment confirmation.

> Previously referred to as "Pay Later" in the codebase. The underlying code uses `approval-payment.ts` in `lib/payments/operations/`.

## Business Flow

```mermaid
sequenceDiagram
    participant Consultee
    participant System
    participant Consultant
    participant Payment Gateway
    participant Email Service

    Consultee->>System: Submit consultation/subscription request
    System->>System: Status: PENDING
    System->>Consultant: Notify new request

    Consultant->>System: Approve request (PATCH)

    alt Payment exists
        System->>System: Create appointments immediately
        System->>System: Status: APPROVED
    else No payment
        System->>System: Generate payment link
        System->>System: Status: APPROVED_PENDING_PAYMENT
        System->>Email Service: Send payment link email
        Email Service->>Consultee: Email with payment URL (48hr expiry)
    end

    Consultee->>Payment Gateway: Complete payment via link
    Payment Gateway->>System: Webhook: payment success
    System->>System: Create/confirm appointments
    System->>System: Status: APPROVED
```

## Documents

| # | Document | Description |
|---|----------|-------------|
| 01 | [Architecture](./01-architecture.md) | System components, approval state machine, payment link generation |
| 02 | [API Reference](./02-api-reference.md) | Endpoints for approval, payment link, status checking |
| 03 | [Cron Schedules](./03-cron-schedules.md) | Auto-expiry jobs for unpaid approval links |
| 04 | [Distributed Locking](./04-distributed-locking.md) | Race condition prevention during approval |
| 05 | [Email Notifications](./05-email-notifications.md) | Payment link emails, reminders, expiry notices |
| 06 | [Testing](./06-testing.md) | Test scenarios and verification steps |
| 07 | [Troubleshooting](./07-troubleshooting.md) | Common issues and debugging guide |
