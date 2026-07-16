# Background Jobs with Inngest - Implementation Guide

> **Priority:** 🟠 HIGH
> **Effort:** 6-8 hours
> **Dependencies:** None

## Executive Summary

Inngest provides serverless background job processing with TypeScript-first development, automatic retries, and durable execution. It's ideal for webhook processing, email sending, scheduled tasks, and long-running operations.

---

## Table of Contents

1. [Why Inngest](#1-why-inngest)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Function Types](#4-function-types)
5. [Webhook Processing](#5-webhook-processing)
6. [Email Jobs](#6-email-jobs)
7. [Scheduled Jobs](#7-scheduled-jobs)
8. [Step Functions](#8-step-functions)
9. [Error Handling](#9-error-handling)
10. [Monitoring](#10-monitoring)

---

## 1. Why Inngest

### Problems It Solves

| Current Issue                       | Inngest Solution                    |
| ----------------------------------- | ----------------------------------- |
| Webhook processing blocks response  | Async processing with immediate 200 |
| No retry on failure                 | Automatic retries with backoff      |
| Cleanup jobs run via GitHub Actions | Native cron scheduling              |
| Email sending blocks API routes     | Background email jobs               |
| No visibility into job status       | Full dashboard and logging          |

### Inngest vs QStash Comparison

| Feature            | Inngest            | QStash         |
| ------------------ | ------------------ | -------------- |
| TypeScript Support | ✅ First-class     | ⚠️ Basic       |
| Local Development  | ✅ Built-in server | ❌ Needs ngrok |
| Step Functions     | ✅ Yes             | ❌ No          |
| Automatic Retries  | ✅ Customizable    | ✅ Built-in    |
| Dashboard          | ✅ Full UI         | ❌ None        |
| Debugging          | ✅ Excellent       | ⚠️ Limited     |
| Durable Execution  | ✅ Yes             | ❌ No          |

### Use Cases for Your App

```
Inngest Jobs:
├── Payment Webhooks
│   ├── Stripe webhook processing
│   └── Razorpay webhook processing
├── Email
│   ├── Welcome emails
│   ├── Booking confirmations
│   ├── Reminder notifications
│   └── Password reset
├── Scheduled
│   ├── Cleanup abandoned payments
│   ├── Expire pending bookings
│   └── Send reminder notifications
└── Sync
    ├── Stream channel sync
    └── Calendar sync
```

---

## 2. Installation

### Step 1: Install Package

```bash
npm install inngest
```

### Step 2: Get API Keys

1. Go to [app.inngest.com](https://app.inngest.com)
2. Create a new app
3. Copy the Event Key and Signing Key

### Step 3: Environment Variables

```env
# .env.local
INNGEST_EVENT_KEY=xxx
INNGEST_SIGNING_KEY=signkey-xxx-xxx

# For production
INNGEST_BRANCH=main
```

---

## 3. Configuration

### Create Inngest Client

```typescript
// lib/inngest/client.ts
import { Inngest } from "inngest";

// Define all event types
type Events = {
  // Payment events
  "payment/webhook.received": {
    data: {
      gateway: "stripe" | "razorpay";
      eventId: string;
      eventType: string;
      payload: Record<string, unknown>;
    };
  };
  "payment/succeeded": {
    data: {
      paymentIntentId: string;
      userId: string;
      amount: number;
    };
  };
  "payment/failed": {
    data: {
      paymentIntentId: string;
      userId: string;
      reason: string;
    };
  };

  // Email events
  "email/send": {
    data: {
      to: string;
      template: EmailTemplate;
      variables: Record<string, unknown>;
    };
  };
  "email/booking.confirmed": {
    data: {
      appointmentId: string;
      userId: string;
      consultantId: string;
    };
  };
  "email/booking.reminder": {
    data: {
      appointmentId: string;
      userId: string;
    };
  };

  // Sync events
  "stream/sync.channels": {
    data: {
      userId: string;
    };
  };

  // Cleanup events (scheduled)
  "cleanup/abandoned-payments": {
    data: Record<string, never>;
  };
  "cleanup/expired-slots": {
    data: Record<string, never>;
  };
};

type EmailTemplate =
  | "welcome"
  | "booking-confirmation"
  | "booking-reminder"
  | "password-reset"
  | "payment-receipt";

// Create Inngest client
export const inngest = new Inngest({
  id: "familiarise",
  schemas: new EventSchemas().fromRecord<Events>(),
});
```

### Create API Route

```typescript
// app/api/inngest/route.ts
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";

// Import all functions
import { processPaymentWebhook } from "@/lib/inngest/functions/payment";
import { sendEmail } from "@/lib/inngest/functions/email";
import { syncStreamChannels } from "@/lib/inngest/functions/stream";
import {
  cleanupAbandonedPayments,
  cleanupExpiredSlots,
} from "@/lib/inngest/functions/cleanup";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processPaymentWebhook,
    sendEmail,
    syncStreamChannels,
    cleanupAbandonedPayments,
    cleanupExpiredSlots,
  ],
});
```

---

## 4. Function Types

### Basic Function

```typescript
// Simple function that runs once
export const myFunction = inngest.createFunction(
  {
    id: "my-function",
    name: "My Function",
  },
  { event: "my/event" },
  async ({ event }) => {
    // Process event
    console.log("Received:", event.data);
    return { success: true };
  },
);
```

### Function with Retries

```typescript
export const myFunction = inngest.createFunction(
  {
    id: "my-function",
    retries: 5, // Retry up to 5 times
  },
  { event: "my/event" },
  async ({ event }) => {
    // This will retry on failure
    await riskyOperation();
  },
);
```

### Scheduled Function (Cron)

```typescript
export const myScheduledFunction = inngest.createFunction(
  { id: "my-scheduled-function" },
  { cron: "*/15 * * * *" }, // Every 15 minutes
  async () => {
    // Runs on schedule
  },
);
```

### Rate-Limited Function

```typescript
export const myRateLimitedFunction = inngest.createFunction(
  {
    id: "my-rate-limited-function",
    rateLimit: {
      limit: 100,
      period: "1m", // 100 per minute
    },
  },
  { event: "my/event" },
  async ({ event }) => {
    // Rate limited
  },
);
```

---

## 5. Webhook Processing

### Stripe Webhook Handler

```typescript
// lib/inngest/functions/payment.ts
import { inngest } from "../client";
import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";

export const processPaymentWebhook = inngest.createFunction(
  {
    id: "process-payment-webhook",
    name: "Process Payment Webhook",
    retries: 3,
    concurrency: {
      limit: 10,
    },
  },
  { event: "payment/webhook.received" },
  async ({ event, step }) => {
    const { gateway, eventId, eventType, payload } = event.data;

    // Step 1: Check if already processed (idempotency)
    const existing = await step.run("check-duplicate", async () => {
      return prisma.webhookLog.findUnique({
        where: {
          eventId_gateway: { eventId, gateway },
        },
      });
    });

    if (existing) {
      return { status: "already_processed", eventId };
    }

    // Step 2: Log the webhook
    await step.run("log-webhook", async () => {
      return prisma.webhookLog.create({
        data: {
          eventId,
          gateway,
          eventType,
          payload: payload as any,
        },
      });
    });

    // Step 3: Process based on event type
    switch (eventType) {
      case "payment_intent.succeeded":
      case "payment.captured":
      case "order.paid":
        return await processPaymentSuccess(step, payload, gateway);

      case "payment_intent.payment_failed":
      case "payment.failed":
        return await processPaymentFailure(step, payload, gateway);

      case "charge.refunded":
      case "refund.created":
        return await processRefund(step, payload, gateway);

      case "charge.dispute.created":
        return await processDispute(step, payload, gateway);

      default:
        return { status: "unhandled", eventType };
    }
  },
);

async function processPaymentSuccess(step: any, payload: any, gateway: string) {
  const paymentIntentId = payload.id || payload.payment_id;

  // Get payment record
  const payment = await step.run("get-payment", async () => {
    return prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: {
        appointment: {
          include: {
            consultation: true,
            subscription: true,
          },
        },
      },
    });
  });

  if (!payment) {
    throw new Error(`Payment not found: ${paymentIntentId}`);
  }

  if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
    return { status: "already_processed", paymentId: payment.id };
  }

  // Update payment status
  await step.run("update-payment", async () => {
    return prisma.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.SUCCEEDED },
    });
  });

  // Confirm slots
  await step.run("confirm-slots", async () => {
    return prisma.slotOfAppointment.updateMany({
      where: { appointmentId: payment.appointmentId! },
      data: { isTentative: false },
    });
  });

  // Send confirmation email
  await step.sendEvent("send-confirmation-email", {
    name: "email/booking.confirmed",
    data: {
      appointmentId: payment.appointmentId!,
      userId: payment.userId!,
      consultantId:
        payment.appointment?.consultation?.consultationPlan
          ?.consultantProfileId ||
        payment.appointment?.subscription?.subscriptionPlan
          ?.consultantProfileId,
    },
  });

  return { status: "success", paymentId: payment.id };
}
```

### Updated Webhook Route

```typescript
// app/api/webhooks/stripe/route.ts
import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (error) {
    console.error("Webhook signature verification failed:", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Send to Inngest for async processing
  await inngest.send({
    name: "payment/webhook.received",
    data: {
      gateway: "stripe",
      eventId: event.id,
      eventType: event.type,
      payload: event.data.object as Record<string, unknown>,
    },
  });

  // Return immediately
  return NextResponse.json({ received: true });
}
```

---

## 6. Email Jobs

### Email Function

```typescript
// lib/inngest/functions/email.ts
import { inngest } from "../client";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendEmail = inngest.createFunction(
  {
    id: "send-email",
    name: "Send Email",
    retries: 3,
    rateLimit: {
      limit: 100,
      period: "1m",
    },
  },
  { event: "email/send" },
  async ({ event }) => {
    const { to, template, variables } = event.data;

    const templateConfig = getEmailTemplate(template, variables);

    const result = await resend.emails.send({
      from: "Familiarise <noreply@familiarise.com>",
      to,
      subject: templateConfig.subject,
      html: templateConfig.html,
    });

    return { messageId: result.data?.id };
  },
);

export const sendBookingConfirmation = inngest.createFunction(
  {
    id: "send-booking-confirmation",
    name: "Send Booking Confirmation",
  },
  { event: "email/booking.confirmed" },
  async ({ event, step }) => {
    const { appointmentId, userId, consultantId } = event.data;

    // Get appointment details
    const appointment = await step.run("get-appointment", async () => {
      return prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          slotsOfAppointment: true,
          consultation: {
            include: {
              consultationPlan: {
                include: { consultantProfile: { include: { user: true } } },
              },
            },
          },
        },
      });
    });

    if (!appointment) {
      throw new Error(`Appointment not found: ${appointmentId}`);
    }

    // Get user
    const user = await step.run("get-user", async () => {
      return prisma.user.findUnique({
        where: { id: userId },
      });
    });

    if (!user?.email) {
      throw new Error(`User not found: ${userId}`);
    }

    // Send email
    await step.sendEvent("send-email", {
      name: "email/send",
      data: {
        to: user.email,
        template: "booking-confirmation" as const,
        variables: {
          userName: user.name,
          consultantName:
            appointment.consultation?.consultationPlan?.consultantProfile?.user
              ?.name,
          dateTime: appointment.slotsOfAppointment[0]?.startsAt,
          duration: appointment.consultation?.consultationPlan?.durationInHours,
        },
      },
    });

    return { sent: true };
  },
);

// Scheduled reminder
export const sendBookingReminders = inngest.createFunction(
  {
    id: "send-booking-reminders",
    name: "Send Booking Reminders",
  },
  { cron: "0 * * * *" }, // Every hour
  async ({ step }) => {
    // Get appointments starting in 24 hours
    const upcomingAppointments = await step.run("get-upcoming", async () => {
      const tomorrow = new Date();
      tomorrow.setHours(tomorrow.getHours() + 24);
      const tomorrowEnd = new Date(tomorrow);
      tomorrowEnd.setHours(tomorrowEnd.getHours() + 1);

      return prisma.appointment.findMany({
        where: {
          slotsOfAppointment: {
            some: {
              startsAt: {
                gte: tomorrow,
                lt: tomorrowEnd,
              },
              isTentative: false,
            },
          },
        },
        include: {
          slotsOfAppointment: true,
          consultation: {
            include: { requestedBy: { include: { user: true } } },
          },
        },
      });
    });

    // Send reminders
    for (const appointment of upcomingAppointments) {
      await step.sendEvent(`reminder-${appointment.id}`, {
        name: "email/booking.reminder",
        data: {
          appointmentId: appointment.id,
          userId: appointment.consultation?.requestedBy?.userId!,
        },
      });
    }

    return { reminded: upcomingAppointments.length };
  },
);
```

---

## 7. Scheduled Jobs

### Cleanup Abandoned Payments

```typescript
// lib/inngest/functions/cleanup.ts
import { inngest } from "../client";
import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";

export const cleanupAbandonedPayments = inngest.createFunction(
  {
    id: "cleanup-abandoned-payments",
    name: "Cleanup Abandoned Payments",
  },
  { cron: "*/15 * * * *" }, // Every 15 minutes
  async ({ step }) => {
    // Find abandoned payments
    const abandoned = await step.run("find-abandoned", async () => {
      return prisma.appointment.findMany({
        where: {
          payment: {
            some: {
              AND: [
                { paymentStatus: PaymentStatus.PENDING },
                {
                  OR: [
                    { expiresAt: { lt: new Date() } },
                    {
                      AND: [
                        { expiresAt: null },
                        {
                          createdAt: {
                            lt: new Date(Date.now() - 30 * 60 * 1000),
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          slotsOfAppointment: {
            some: { isTentative: true },
          },
        },
        include: {
          payment: true,
          slotsOfAppointment: true,
        },
        take: 100,
      });
    });

    let cleaned = 0;

    for (const appointment of abandoned) {
      try {
        await step.run(`cleanup-${appointment.id}`, async () => {
          await prisma.$transaction(async (tx) => {
            // Cancel payment intent with gateway if needed
            // ...

            // Delete slots
            await tx.slotOfAppointment.deleteMany({
              where: { appointmentId: appointment.id },
            });

            // Update payment status
            await tx.payment.updateMany({
              where: { appointmentId: appointment.id },
              data: { paymentStatus: PaymentStatus.FAILED },
            });

            // Delete appointment
            await tx.appointment.delete({
              where: { id: appointment.id },
            });
          });
        });
        cleaned++;
      } catch (error) {
        console.error(`Failed to cleanup ${appointment.id}:`, error);
      }
    }

    return { found: abandoned.length, cleaned };
  },
);

export const cleanupExpiredSlots = inngest.createFunction(
  {
    id: "cleanup-expired-slots",
    name: "Cleanup Expired Tentative Slots",
  },
  { cron: "*/5 * * * *" }, // Every 5 minutes
  async ({ step }) => {
    const result = await step.run("delete-expired-slots", async () => {
      return prisma.slotOfAppointment.deleteMany({
        where: {
          isTentative: true,
          createdAt: {
            lt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes old
          },
        },
      });
    });

    return { deleted: result.count };
  },
);
```

---

## 8. Step Functions

### Long-Running Workflow

```typescript
// lib/inngest/functions/onboarding.ts
import { inngest } from "../client";

export const onboardingWorkflow = inngest.createFunction(
  {
    id: "onboarding-workflow",
    name: "User Onboarding Workflow",
  },
  { event: "user/signed.up" },
  async ({ event, step }) => {
    const { userId, email, name } = event.data;

    // Step 1: Send welcome email immediately
    await step.sendEvent("send-welcome", {
      name: "email/send",
      data: {
        to: email,
        template: "welcome",
        variables: { name },
      },
    });

    // Step 2: Wait 1 day
    await step.sleep("wait-1-day", "1d");

    // Step 3: Check if user completed profile
    const user = await step.run("check-profile", async () => {
      return prisma.user.findUnique({
        where: { id: userId },
        include: { consulteeProfile: true, consultantProfile: true },
      });
    });

    if (!user?.consulteeProfile && !user?.consultantProfile) {
      // Send reminder to complete profile
      await step.sendEvent("send-profile-reminder", {
        name: "email/send",
        data: {
          to: email,
          template: "complete-profile",
          variables: { name },
        },
      });
    }

    // Step 4: Wait 3 more days
    await step.sleep("wait-3-days", "3d");

    // Step 5: Check for first booking
    const bookings = await step.run("check-bookings", async () => {
      return prisma.appointment.count({
        where: {
          OR: [
            { consultation: { requestedBy: { userId } } },
            { subscription: { requestedBy: { userId } } },
          ],
        },
      });
    });

    if (bookings === 0) {
      // Send booking encouragement
      await step.sendEvent("send-booking-nudge", {
        name: "email/send",
        data: {
          to: email,
          template: "first-booking",
          variables: { name },
        },
      });
    }

    return { completed: true };
  },
);
```

### Wait for Event

```typescript
export const bookingFollowUp = inngest.createFunction(
  {
    id: "booking-follow-up",
    name: "Post-Booking Follow Up",
  },
  { event: "booking/completed" },
  async ({ event, step }) => {
    const { appointmentId, userId } = event.data;

    // Wait for meeting to end (or timeout after 3 hours)
    const meetingEnded = await step.waitForEvent("wait-for-meeting-end", {
      event: "meeting/ended",
      match: "data.appointmentId",
      timeout: "3h",
    });

    if (!meetingEnded) {
      // Meeting didn't end signal, check manually
      const appointment = await step.run("check-appointment", async () => {
        return prisma.appointment.findUnique({
          where: { id: appointmentId },
          include: { slotsOfAppointment: true },
        });
      });

      const endTime = appointment?.slotsOfAppointment[0]?.endsAt;
      if (endTime && new Date() < endTime) {
        // Meeting still in progress, wait more
        await step.sleepUntil("wait-until-end", endTime);
      }
    }

    // Wait 1 hour after meeting
    await step.sleep("wait-before-review", "1h");

    // Send review request
    await step.sendEvent("request-review", {
      name: "email/send",
      data: {
        to: await getUserEmail(userId),
        template: "review-request",
        variables: { appointmentId },
      },
    });

    return { reviewRequested: true };
  },
);
```

---

## 9. Error Handling

### Retry Configuration

```typescript
export const myFunction = inngest.createFunction(
  {
    id: "my-function",
    retries: 5,
    // Custom backoff
    backoff: {
      type: "exponential",
      minDelay: 1000, // 1 second
      maxDelay: 300000, // 5 minutes
      factor: 2,
    },
  },
  { event: "my/event" },
  async ({ event, attempt }) => {
    console.log(`Attempt ${attempt} of processing`);

    if (attempt > 3) {
      // On later retries, try alternative approach
      return await alternativeProcessing(event);
    }

    return await normalProcessing(event);
  },
);
```

### Error Handling in Steps

```typescript
export const myFunction = inngest.createFunction(
  { id: "my-function" },
  { event: "my/event" },
  async ({ event, step }) => {
    try {
      await step.run("risky-step", async () => {
        await riskyOperation();
      });
    } catch (error) {
      // Log error but continue
      await step.run("log-error", async () => {
        await logError(error);
      });

      // Try fallback
      await step.run("fallback", async () => {
        await fallbackOperation();
      });
    }

    return { completed: true };
  },
);
```

### Dead Letter Handling

```typescript
// Capture failed jobs
export const handleFailedJobs = inngest.createFunction(
  {
    id: "handle-failed-jobs",
    name: "Handle Failed Jobs",
  },
  { event: "inngest/function.failed" },
  async ({ event }) => {
    const { function_id, error, event: originalEvent } = event.data;

    // Log to error tracking
    Sentry.captureException(new Error(error.message), {
      tags: { function_id },
      extra: { originalEvent },
    });

    // Alert team
    await sendSlackAlert({
      channel: "#alerts",
      message: `Job failed: ${function_id}`,
      error: error.message,
    });
  },
);
```

---

## 10. Monitoring

### Inngest Dashboard

The Inngest dashboard provides:

- Function execution history
- Event timeline
- Step-by-step execution view
- Error details and stack traces
- Retry history
- Cron job status

### Integration with PostHog

```typescript
// Track job metrics in PostHog
import posthog from "posthog-node";

const ph = new posthog.PostHog(process.env.POSTHOG_PERSONAL_API_KEY!);

export const myFunction = inngest.createFunction(
  { id: "my-function" },
  { event: "my/event" },
  async ({ event, step }) => {
    const start = Date.now();

    try {
      const result = await processEvent(event);

      ph.capture({
        distinctId: "system",
        event: "inngest_job_completed",
        properties: {
          function_id: "my-function",
          duration_ms: Date.now() - start,
        },
      });

      return result;
    } catch (error) {
      ph.capture({
        distinctId: "system",
        event: "inngest_job_failed",
        properties: {
          function_id: "my-function",
          error: error.message,
        },
      });

      throw error;
    }
  },
);
```

---

## Quick Reference

### Environment Variables

```env
INNGEST_EVENT_KEY=xxx
INNGEST_SIGNING_KEY=signkey-xxx
```

### Common Patterns

```typescript
// Send event
await inngest.send({
  name: "event/name",
  data: { key: "value" },
});

// Send multiple events
await inngest.send([
  { name: "event/one", data: {} },
  { name: "event/two", data: {} },
]);

// Schedule for later
await inngest.send({
  name: "event/name",
  data: {},
  ts: Date.now() + 3600000, // 1 hour from now
});
```

### Local Development

```bash
# Start Inngest dev server
npx inngest-cli dev

# Or with npm script
npm run inngest:dev
```

### Verification Checklist

- [ ] Inngest package installed
- [ ] Environment variables set
- [ ] Client created with event types
- [ ] API route configured
- [ ] Payment webhook function created
- [ ] Email functions created
- [ ] Cleanup cron jobs created
- [ ] Webhook routes updated to use Inngest
- [ ] Local dev server tested
- [ ] Production deployment verified
