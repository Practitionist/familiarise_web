# Cron Schedules & Cleanup Jobs

> **Removed in wave 5 (#1319).** The `GET /api/cleanup/approval-payments` route described below was shaped for Vercel Cron and was never scheduled on this deployment (GitHub Actions runs the `jobs/**` wrappers only). Its cohort, requests approved but never paid, is handled by `scripts/payments/cleanup-abandoned-payments.ts` (`cleanupExpiredApprovalPendingPayments`, every 15 minutes), which now moves the request to EXPIRED through the CAS helper and soft-cancels the tentative slots. The sections below are kept as history until the docs refresh PR rewrites this file.

## Overview

The payment approval workflow includes automated cleanup jobs to handle expired payment links and maintain data integrity. These jobs run on scheduled intervals using **Vercel Cron** or manual API triggers.

## Cleanup Jobs

### 1. Expired Payment Link Cleanup

**Purpose**: Revert `APPROVED_PENDING_PAYMENT` requests to `PENDING` after 48 hours

**Schedule**: Every hour (0 _/1 _ \* \*)

**File**: `app/api/cleanup/approval-payments/route.ts`

#### Flow Diagram

```
┌─────────────────────────────────┐
│   Cron Job Trigger (Hourly)    │
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│  Find APPROVED_PENDING_PAYMENT  │
│   WHERE updatedAt < 48hrs ago   │
└───────────────┬─────────────────┘
                │
                ▼
        ┌───────────────┐
        │ For Each Item │
        └───────┬───────┘
                │
                ▼
┌─────────────────────────────────┐
│   Update Status to PENDING      │
│   Add expiry note to comments   │
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│  Send Notification Email        │
│  (Consultee + Consultant)       │
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│    Log Cleanup Results          │
└─────────────────────────────────┘
```

## Implementation

### Cleanup Endpoint

```typescript
// app/api/cleanup/approval-payments/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client"; // renamed from `RequestStatus`

/**
 * Cleanup expired payment links (48 hours)
 * Reverts APPROVED_PENDING_PAYMENT → PENDING
 *
 * Runs via:
 * 1. Vercel Cron: Hourly
 * 2. Manual trigger: GET /api/cleanup/approval-payments
 */
export async function GET() {
  try {
    const now = new Date();
    const expiryThreshold = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago

    console.log(`🔄 Starting approval payment cleanup at ${now.toISOString()}`);
    console.log(`🕐 Expiry threshold: ${expiryThreshold.toISOString()}`);

    // Find expired consultations
    const expiredConsultations = await prisma.consultation.findMany({
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: {
          lt: expiryThreshold,
        },
      },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: { user: true },
            },
          },
        },
        requestedBy: {
          include: { user: true },
        },
      },
    });

    // Find expired subscriptions
    const expiredSubscriptions = await prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: {
          lt: expiryThreshold,
        },
      },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: { user: true },
            },
          },
        },
        requestedBy: {
          include: { user: true },
        },
      },
    });

    // Revert consultations
    const revertedConsultations = await Promise.all(
      expiredConsultations.map(async (consultation) => {
        try {
          const updated = await prisma.consultation.update({
            where: { id: consultation.id },
            data: {
              status: AppointmentStatus.PENDING,
              requestNotes: consultation.requestNotes
                ? `${consultation.requestNotes}\n\n[System] Payment link expired after 48 hours. Reverted to pending status at ${now.toISOString()}`
                : `[System] Payment link expired after 48 hours. Reverted to pending status at ${now.toISOString()}`,
            },
          });

          // TODO: Send notification email to consultee and consultant
          console.log(`✅ Reverted consultation ${consultation.id} to PENDING`);

          return { id: consultation.id, type: "consultation", success: true };
        } catch (error) {
          console.error(
            `❌ Failed to revert consultation ${consultation.id}:`,
            error,
          );
          return {
            id: consultation.id,
            type: "consultation",
            success: false,
            error,
          };
        }
      }),
    );

    // Revert subscriptions
    const revertedSubscriptions = await Promise.all(
      expiredSubscriptions.map(async (subscription) => {
        try {
          const updated = await prisma.subscription.update({
            where: { id: subscription.id },
            data: {
              status: AppointmentStatus.PENDING,
              requestNotes: subscription.requestNotes
                ? `${subscription.requestNotes}\n\n[System] Payment link expired after 48 hours. Reverted to pending status at ${now.toISOString()}`
                : `[System] Payment link expired after 48 hours. Reverted to pending status at ${now.toISOString()}`,
            },
          });

          // TODO: Send notification email to consultee and consultant
          console.log(`✅ Reverted subscription ${subscription.id} to PENDING`);

          return { id: subscription.id, type: "subscription", success: true };
        } catch (error) {
          console.error(
            `❌ Failed to revert subscription ${subscription.id}:`,
            error,
          );
          return {
            id: subscription.id,
            type: "subscription",
            success: false,
            error,
          };
        }
      }),
    );

    const totalReverted =
      revertedConsultations.filter((r) => r.success).length +
      revertedSubscriptions.filter((r) => r.success).length;

    const totalFailed =
      revertedConsultations.filter((r) => !r.success).length +
      revertedSubscriptions.filter((r) => !r.success).length;

    console.log(
      `✅ Cleanup complete: ${totalReverted} reverted, ${totalFailed} failed`,
    );

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      summary: {
        consultations: {
          found: expiredConsultations.length,
          reverted: revertedConsultations.filter((r) => r.success).length,
          failed: revertedConsultations.filter((r) => !r.success).length,
        },
        subscriptions: {
          found: expiredSubscriptions.length,
          reverted: revertedSubscriptions.filter((r) => r.success).length,
          failed: revertedSubscriptions.filter((r) => !r.success).length,
        },
        total: {
          reverted: totalReverted,
          failed: totalFailed,
        },
      },
      details: {
        consultations: revertedConsultations,
        subscriptions: revertedSubscriptions,
      },
    });
  } catch (error) {
    console.error("❌ Cleanup job failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
```

## Vercel Cron Configuration

### vercel.json

```json
{
  "crons": [
    {
      "path": "/api/cleanup/approval-payments",
      "schedule": "0 */1 * * *"
    }
  ]
}
```

### Cron Syntax Explained

```
0 */1 * * *
│ │  │ │ │
│ │  │ │ └─── Day of week (0-7, 0 and 7 = Sunday)
│ │  │ └───── Month (1-12)
│ │  └─────── Day of month (1-31)
│ └────────── Hour (0-23)
└──────────── Minute (0-59)

0 */1 * * * = Every hour at minute 0
```

### Alternative Schedules

```json
// Every 30 minutes
"schedule": "*/30 * * * *"

// Every 2 hours
"schedule": "0 */2 * * *"

// Daily at midnight
"schedule": "0 0 * * *"

// Every weekday at 9 AM
"schedule": "0 9 * * 1-5"
```

## Manual Trigger

### Via API Call

```bash
# Production
curl https://familiarise.com/api/cleanup/approval-payments

# Development
curl http://localhost:3000/api/cleanup/approval-payments
```

### Via Admin Dashboard

```typescript
// Future enhancement: Add button in admin panel
<Button onClick={async () => {
  const response = await fetch('/api/cleanup/approval-payments');
  const result = await response.json();
  console.log('Cleanup result:', result);
}}>
  Run Cleanup Now
</Button>
```

## Monitoring & Logging

### Log Output

```
🔄 Starting approval payment cleanup at 2025-01-15T10:00:00.000Z
🕐 Expiry threshold: 2025-01-13T10:00:00.000Z
✅ Reverted consultation clx123abc to PENDING
✅ Reverted subscription clx456def to PENDING
✅ Cleanup complete: 2 reverted, 0 failed
```

### Response Format

```json
{
  "success": true,
  "timestamp": "2025-01-15T10:00:00.000Z",
  "summary": {
    "consultations": {
      "found": 1,
      "reverted": 1,
      "failed": 0
    },
    "subscriptions": {
      "found": 1,
      "reverted": 1,
      "failed": 0
    },
    "total": {
      "reverted": 2,
      "failed": 0
    }
  },
  "details": {
    "consultations": [
      {
        "id": "clx123abc",
        "type": "consultation",
        "success": true
      }
    ],
    "subscriptions": [
      {
        "id": "clx456def",
        "type": "subscription",
        "success": true
      }
    ]
  }
}
```

## Error Handling

### Partial Failures

```typescript
// Continue processing even if some items fail
const results = await Promise.all(
  items.map(async (item) => {
    try {
      await processItem(item);
      return { id: item.id, success: true };
    } catch (error) {
      console.error(`Failed to process ${item.id}:`, error);
      return { id: item.id, success: false, error };
    }
  }),
);

// Report both successes and failures
const successCount = results.filter((r) => r.success).length;
const failureCount = results.filter((r) => !r.success).length;
```

### Database Transaction Errors

```typescript
try {
  await prisma.consultation.update({ ... });
} catch (error) {
  if (error.code === 'P2025') {
    console.error("Consultation not found (already deleted?)");
  } else {
    console.error("Database error:", error);
  }
  return { success: false, error };
}
```

## Testing Cleanup Job

### Unit Test

```typescript
// __tests__/api/cleanup/approval-payments.test.ts
import { GET } from "@/app/api/cleanup/approval-payments/route";

describe("Approval Payment Cleanup", () => {
  beforeEach(async () => {
    // Seed database with expired payments
    await prisma.consultation.create({
      data: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: new Date(Date.now() - 49 * 60 * 60 * 1000), // 49 hours ago
        // ... other required fields
      },
    });
  });

  it("should revert expired consultations to PENDING", async () => {
    const response = await GET();
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.summary.consultations.reverted).toBe(1);

    const consultation = await prisma.consultation.findFirst({
      where: { status: AppointmentStatus.PENDING },
    });

    expect(consultation).toBeDefined();
    expect(consultation.requestNotes).toContain("Payment link expired");
  });

  it("should not revert recent approvals", async () => {
    await prisma.consultation.create({
      data: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
        // ... other required fields
      },
    });

    const response = await GET();
    const data = await response.json();

    expect(data.summary.consultations.found).toBe(1); // Only expired one
  });
});
```

### Integration Test

```typescript
describe("End-to-End Cleanup Flow", () => {
  it("should complete full cleanup cycle", async () => {
    // 1. Create expired payment
    const consultation = await createExpiredPayment();

    // 2. Run cleanup
    const response = await fetch("/api/cleanup/approval-payments");
    const result = await response.json();

    // 3. Verify status changed
    const updated = await prisma.consultation.findUnique({
      where: { id: consultation.id },
    });
    expect(updated.status).toBe(AppointmentStatus.PENDING);

    // 4. Verify notification sent
    // TODO: Check email service mock
  });
});
```

## Performance Considerations

### Batch Processing

```typescript
// Process in batches to avoid memory issues
const batchSize = 100;
const totalExpired = expiredItems.length;

for (let i = 0; i < totalExpired; i += batchSize) {
  const batch = expiredItems.slice(i, i + batchSize);
  await Promise.all(batch.map(processItem));
  console.log(
    `Processed batch ${i / batchSize + 1}/${Math.ceil(totalExpired / batchSize)}`,
  );
}
```

### Query Optimization

```typescript
// Use indexed fields in WHERE clause
where: {
  status: AppointmentStatus.APPROVED_PENDING_PAYMENT, // Indexed
  updatedAt: { lt: expiryThreshold },                    // Indexed
}

// Add database index
@@index([status, updatedAt])  // renamed from `@@index([requestStatus, updatedAt])`
```

### Timeout Handling

```typescript
// Set timeout for entire cleanup job (Vercel: 10s free tier, 300s pro)
export const maxDuration = 60; // 60 seconds

export async function GET() {
  const startTime = Date.now();
  const timeoutMs = 55000; // 55 seconds (buffer before Vercel timeout)

  // Check timeout before each batch
  if (Date.now() - startTime > timeoutMs) {
    console.warn("Cleanup timeout approaching, stopping early");
    break;
  }
}
```

## Best Practices

### ✅ DO

1. **Log all cleanup operations**

```typescript
console.log(`🔄 Starting cleanup: ${items.length} items to process`);
console.log(
  `✅ Cleanup complete: ${successCount} succeeded, ${failCount} failed`,
);
```

2. **Handle partial failures gracefully**

```typescript
// Don't throw - process all items even if some fail
const results = await Promise.all(
  items.map((item) => processItem(item).catch((error) => ({ error }))),
);
```

3. **Add safety checks**

```typescript
// Verify item is actually expired
const hoursSinceApproval = (now - updatedAt) / (1000 * 60 * 60);
if (hoursSinceApproval < 48) {
  console.warn(`Item ${id} not yet expired (${hoursSinceApproval}h)`);
  continue;
}
```

4. **Monitor cleanup results**

```typescript
// Return detailed results for monitoring
return NextResponse.json({
  success: true,
  summary: { reverted, failed },
  details: results,
});
```

### ❌ DON'T

1. **Don't fail entire job if one item fails**

```typescript
// ❌ Bad: One error stops everything
for (const item of items) {
  await processItem(item); // throws on error
}

// ✅ Good: Continue processing
for (const item of items) {
  try {
    await processItem(item);
  } catch (error) {
    console.error(`Failed ${item.id}:`, error);
  }
}
```

2. **Don't delete payment data**

```typescript
// ❌ Bad: Delete payment records
await prisma.payment.delete({ where: { id } });

// ✅ Good: Keep for audit trail, just revert status
await prisma.consultation.update({
  data: { status: AppointmentStatus.PENDING },
});
```

3. **Don't run cleanup synchronously in request handler**

```typescript
// ❌ Bad: Block approval request with cleanup
await runCleanup();
await approveRequest();

// ✅ Good: Cleanup runs independently on schedule
// Approval happens immediately, cleanup runs hourly
```

## Future Enhancements

1. **Email Notifications**: Send expiry notice to consultee and consultant
2. **Retry Mechanism**: Retry failed reversions after delay
3. **Soft Delete**: Mark as expired instead of reverting status
4. **Analytics**: Track expiry rates and reasons
5. **Grace Period**: Allow consultants to extend payment deadline
6. **Auto-Reschedule**: Automatically create new payment link
7. **Batch Notifications**: Group notifications to reduce email volume
8. **Monitoring Dashboard**: Real-time cleanup job status in admin panel
