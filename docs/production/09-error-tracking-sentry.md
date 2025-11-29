# Error Tracking with Sentry - Implementation Guide

> **Priority:** 🔴 CRITICAL
> **Effort:** 2-4 hours
> **Dependencies:** None

## Executive Summary

Sentry provides real-time error tracking, crash reports, and performance monitoring. It's essential for identifying and fixing production issues quickly before they impact users.

---

## Table of Contents

1. [Why Sentry](#1-why-sentry)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Error Boundaries](#4-error-boundaries)
5. [Custom Error Tracking](#5-custom-error-tracking)
6. [Performance Monitoring](#6-performance-monitoring)
7. [Release Tracking](#7-release-tracking)
8. [Alerting](#8-alerting)

---

## 1. Why Sentry

### Problems It Solves

| Problem | Sentry Solution |
|---------|-----------------|
| Users report vague errors | Full stack traces with context |
| Can't reproduce bugs | Session replay shows what happened |
| Don't know about errors until users complain | Real-time alerts |
| No visibility into API failures | Request/response tracking |
| Performance issues go unnoticed | Performance monitoring |

### What You Get

```
Sentry Dashboard
├── Issues (grouped errors)
│   ├── Stack traces
│   ├── Breadcrumbs (user actions before error)
│   ├── Device/browser info
│   └── User info
├── Performance
│   ├── Transaction traces
│   ├── Database query times
│   └── API latency
├── Releases
│   ├── Which deploy caused issues
│   ├── Crash-free rate
│   └── Regression detection
└── Alerts
    ├── New error types
    ├── Error spike detection
    └── Performance degradation
```

---

## 2. Installation

### Step 1: Install Sentry Next.js SDK

```bash
npx @sentry/wizard@latest -i nextjs
```

This wizard will:
- Install `@sentry/nextjs`
- Create configuration files
- Set up source maps
- Add environment variables

### Step 2: Manual Installation (if wizard fails)

```bash
npm install @sentry/nextjs
```

### Step 3: Get DSN

1. Go to [sentry.io](https://sentry.io)
2. Create a new project (Next.js)
3. Copy the DSN

### Step 4: Environment Variables

```env
# .env.local
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
SENTRY_ORG=your-org
SENTRY_PROJECT=familiarise-web
SENTRY_AUTH_TOKEN=sntrys_xxx

# Optional: Disable in development
NEXT_PUBLIC_SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
```

---

## 3. Configuration

### sentry.client.config.ts

```typescript
// sentry.client.config.ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Environment
  environment: process.env.NODE_ENV,

  // Performance Monitoring
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Session Replay
  replaysSessionSampleRate: 0.1, // 10% of sessions
  replaysOnErrorSampleRate: 1.0, // 100% of sessions with errors

  // Integrations
  integrations: [
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
    }),
  ],

  // Filter out noise
  ignoreErrors: [
    // Browser extensions
    "top.GLOBALS",
    "ResizeObserver loop limit exceeded",
    // Network errors (user's connection)
    "Failed to fetch",
    "NetworkError",
    "Load failed",
    // User cancelled
    "AbortError",
  ],

  // Don't send errors in development
  enabled: process.env.NODE_ENV === "production",

  // Attach user info
  beforeSend(event) {
    // Remove sensitive data
    if (event.request?.cookies) {
      delete event.request.cookies;
    }
    return event;
  },
});
```

### sentry.server.config.ts

```typescript
// sentry.server.config.ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  environment: process.env.NODE_ENV,

  // Performance
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Integrations
  integrations: [
    // Prisma integration
    Sentry.prismaIntegration(),
  ],

  // Enable profiling
  profilesSampleRate: 0.1,

  enabled: process.env.NODE_ENV === "production",
});
```

### sentry.edge.config.ts

```typescript
// sentry.edge.config.ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  enabled: process.env.NODE_ENV === "production",
});
```

### next.config.js

```javascript
// next.config.js
const { withSentryConfig } = require("@sentry/nextjs");

const nextConfig = {
  // Your existing config
};

module.exports = withSentryConfig(nextConfig, {
  // Sentry options
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Upload source maps
  silent: true,
  widenClientFileUpload: true,

  // Performance
  hideSourceMaps: true,
  disableLogger: true,

  // Automatically instrument
  automaticVercelMonitors: true,
});
```

### instrumentation.ts

```typescript
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
```

---

## 4. Error Boundaries

### Global Error Boundary

```typescript
// app/global-error.tsx
"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <div className="flex min-h-screen flex-col items-center justify-center">
          <h2 className="text-2xl font-bold">Something went wrong!</h2>
          <p className="text-gray-600 mt-2">
            We've been notified and are working on it.
          </p>
          <button
            onClick={reset}
            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
```

### Route Error Boundary

```typescript
// app/error.tsx
"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="p-8">
      <h2 className="text-xl font-bold text-red-600">Something went wrong!</h2>
      <p className="mt-2 text-gray-600">{error.message}</p>
      <button
        onClick={reset}
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
      >
        Try again
      </button>
    </div>
  );
}
```

---

## 5. Custom Error Tracking

### Capturing Errors Manually

```typescript
// In any component or API route
import * as Sentry from "@sentry/nextjs";

// Capture an exception
try {
  await riskyOperation();
} catch (error) {
  Sentry.captureException(error, {
    tags: {
      feature: "checkout",
      paymentGateway: "stripe",
    },
    extra: {
      orderId: order.id,
      amount: order.amount,
    },
  });
  throw error; // Re-throw if needed
}

// Capture a message
Sentry.captureMessage("User attempted invalid action", {
  level: "warning",
  tags: { action: "invalid_refund" },
});
```

### Setting User Context

```typescript
// After user signs in
import * as Sentry from "@sentry/nextjs";

function setUserContext(user: User) {
  Sentry.setUser({
    id: user.id,
    email: user.email,
    username: user.name,
    // Custom fields
    role: user.role,
    plan: user.subscription?.plan,
  });
}

// On sign out
function clearUserContext() {
  Sentry.setUser(null);
}
```

### Adding Breadcrumbs

```typescript
// Track user actions leading to errors
import * as Sentry from "@sentry/nextjs";

function trackUserAction(action: string, data?: Record<string, any>) {
  Sentry.addBreadcrumb({
    category: "user-action",
    message: action,
    data,
    level: "info",
  });
}

// Usage
trackUserAction("clicked_checkout", { planId: "pro" });
trackUserAction("selected_payment_method", { method: "stripe" });
trackUserAction("submitted_payment");
```

### API Route Error Handling

```typescript
// app/api/example/route.ts
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

export async function POST(req: NextRequest) {
  const transaction = Sentry.startTransaction({
    op: "api",
    name: "POST /api/example",
  });

  try {
    Sentry.setContext("request", {
      url: req.url,
      method: req.method,
    });

    const body = await req.json();

    // Your logic here
    const result = await processRequest(body);

    transaction.setStatus("ok");
    return NextResponse.json(result);
  } catch (error) {
    transaction.setStatus("internal_error");

    Sentry.captureException(error, {
      tags: { endpoint: "/api/example" },
    });

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  } finally {
    transaction.finish();
  }
}
```

---

## 6. Performance Monitoring

### Automatic Instrumentation

Sentry automatically tracks:
- Page loads
- API routes
- Database queries (with Prisma integration)
- HTTP requests

### Custom Transactions

```typescript
import * as Sentry from "@sentry/nextjs";

async function processPayment(paymentData: PaymentData) {
  const transaction = Sentry.startTransaction({
    op: "payment",
    name: "Process Payment",
  });

  try {
    // Track individual spans
    const validateSpan = transaction.startChild({
      op: "validate",
      description: "Validate payment data",
    });
    await validatePaymentData(paymentData);
    validateSpan.finish();

    const chargeSpan = transaction.startChild({
      op: "charge",
      description: "Charge payment",
    });
    const result = await chargePayment(paymentData);
    chargeSpan.finish();

    const appointmentSpan = transaction.startChild({
      op: "db",
      description: "Create appointment",
    });
    await createAppointment(result);
    appointmentSpan.finish();

    transaction.setStatus("ok");
    return result;
  } catch (error) {
    transaction.setStatus("internal_error");
    throw error;
  } finally {
    transaction.finish();
  }
}
```

### Database Query Tracking

```typescript
// Prisma is automatically instrumented
// You can add custom context

import * as Sentry from "@sentry/nextjs";

async function getConsultantWithAvailability(id: string) {
  Sentry.addBreadcrumb({
    category: "query",
    message: `Fetching consultant ${id}`,
    level: "info",
  });

  return prisma.consultantProfile.findUnique({
    where: { id },
    include: {
      weeklyAvailabilitySlots: true,
      consultationPlans: true,
    },
  });
}
```

---

## 7. Release Tracking

### Automatic Release Detection

```javascript
// next.config.js
const { withSentryConfig } = require("@sentry/nextjs");

module.exports = withSentryConfig(nextConfig, {
  // Use git commit SHA as release
  release: process.env.VERCEL_GIT_COMMIT_SHA,
});
```

### Manual Release

```typescript
// sentry.client.config.ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: `familiarise-web@${process.env.npm_package_version}`,
});
```

### Vercel Integration

```yaml
# vercel.json
{
  "build": {
    "env": {
      "SENTRY_ORG": "@your-org",
      "SENTRY_PROJECT": "familiarise-web"
    }
  }
}
```

---

## 8. Alerting

### Recommended Alert Rules

#### Critical Alerts (Immediate)

```yaml
Alert: New Error Type
Condition: A new issue is created
Action: Slack + Email
Threshold: Immediately

Alert: Error Spike
Condition: Error frequency increases by 100%
Action: Slack + PagerDuty
Threshold: Within 5 minutes

Alert: Payment Errors
Condition: Error in transaction tagged "payment"
Action: Slack + Email
Threshold: Immediately
```

#### Warning Alerts (Daily Digest)

```yaml
Alert: Unhandled Rejections
Condition: Unhandled promise rejection
Action: Daily email digest
Threshold: > 10 per day

Alert: Performance Degradation
Condition: P95 latency > 2s
Action: Slack
Threshold: Sustained for 10 minutes
```

### Setting Up Slack Integration

1. Go to Sentry Settings > Integrations
2. Add Slack integration
3. Configure alert routing:
   - Critical → #alerts-critical
   - Warnings → #alerts-general
   - Performance → #alerts-performance

### Issue Assignment

```typescript
// Assign issues based on tags
Sentry.captureException(error, {
  tags: {
    team: "payments",  // Routes to payments team
  },
});
```

---

## Quick Reference

### Common Patterns

```typescript
// Wrap async functions
const wrappedFn = Sentry.withScope((scope) => {
  scope.setTag("feature", "checkout");
  return originalFn();
});

// Set context for a scope
Sentry.withScope((scope) => {
  scope.setExtra("orderDetails", order);
  scope.setTag("paymentMethod", "stripe");
  Sentry.captureException(error);
});

// Flush before serverless function ends
await Sentry.flush(2000);
```

### Environment Configuration

```env
# Development (disabled)
SENTRY_DSN=
NODE_ENV=development

# Staging
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
NODE_ENV=staging

# Production
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
NODE_ENV=production
SENTRY_AUTH_TOKEN=sntrys_xxx
```

### Verification Checklist

- [ ] Sentry package installed
- [ ] DSN configured
- [ ] Client config created
- [ ] Server config created
- [ ] Edge config created
- [ ] Error boundaries implemented
- [ ] Source maps uploading
- [ ] Alerts configured
- [ ] Slack integration set up
- [ ] Test error captured in dashboard
