# Monitoring & Observability - Implementation Guide

> **Priority:** 🟡 MEDIUM
> **Effort:** 4-6 hours
> **Dependencies:** Sentry, PostHog (already configured)

## Executive Summary

This document covers additional monitoring tools for logging, uptime monitoring, and creating operational dashboards. Combined with Sentry (errors) and PostHog (analytics), this provides complete observability.

---

## Table of Contents

1. [Observability Stack](#1-observability-stack)
2. [Structured Logging](#2-structured-logging)
3. [Uptime Monitoring](#3-uptime-monitoring)
4. [Operational Dashboards](#4-operational-dashboards)
5. [Alerting Strategy](#5-alerting-strategy)
6. [Health Checks](#6-health-checks)
7. [Runbooks](#7-runbooks)

---

## 1. Observability Stack

### Complete Stack Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                      OBSERVABILITY STACK                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │   SENTRY    │  │   POSTHOG   │  │   VERCEL    │                 │
│  │   Errors    │  │  Analytics  │  │  Analytics  │                 │
│  │   Crashes   │  │  Sessions   │  │  Web Vitals │                 │
│  │   Traces    │  │  Funnels    │  │  Traffic    │                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │ BETTER STACK│  │   CHECKLY   │  │  INNGEST    │                 │
│  │   Logtail   │  │   Uptime    │  │    Jobs     │                 │
│  │   Logs      │  │   Synthetics│  │  Dashboard  │                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Tool Responsibilities

| Tool | Category | What It Monitors |
|------|----------|------------------|
| **Sentry** | Errors | Exceptions, crashes, performance |
| **PostHog** | Analytics | User behavior, conversions, features |
| **Vercel Analytics** | Performance | Web Vitals, page speed |
| **Better Stack (Logtail)** | Logging | Application logs, audit trails |
| **Checkly** | Uptime | API endpoints, critical flows |
| **Inngest** | Jobs | Background job execution |

---

## 2. Structured Logging

### Why Better Stack / Logtail

- Structured JSON logging
- Real-time log streaming
- Query and search
- Alerts on log patterns
- Integrates with Vercel

### Installation

```bash
npm install @logtail/next
```

### Environment Variables

```env
LOGTAIL_SOURCE_TOKEN=xxx
```

### Logger Configuration

```typescript
// lib/logger.ts
import { Logtail } from "@logtail/next";

// Create Logtail instance
const logtail = new Logtail(process.env.LOGTAIL_SOURCE_TOKEN!);

// Log levels
type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  userId?: string;
  requestId?: string;
  path?: string;
  method?: string;
  duration?: number;
  [key: string]: unknown;
}

// Logger class
class Logger {
  private context: LogContext = {};

  withContext(context: LogContext): Logger {
    const logger = new Logger();
    logger.context = { ...this.context, ...context };
    return logger;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    const logEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      service: "familiarise-web",
      ...this.context,
      ...data,
    };

    // Log to console in development
    if (process.env.NODE_ENV === "development") {
      console[level](JSON.stringify(logEntry, null, 2));
    }

    // Send to Logtail
    logtail[level](message, logEntry);
  }

  debug(message: string, data?: Record<string, unknown>) {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>) {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    this.log("warn", message, data);
  }

  error(message: string, error?: Error, data?: Record<string, unknown>) {
    this.log("error", message, {
      ...data,
      error: error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : undefined,
    });
  }
}

export const logger = new Logger();

// Request logger middleware helper
export function createRequestLogger(req: Request) {
  const requestId = crypto.randomUUID();
  const url = new URL(req.url);

  return logger.withContext({
    requestId,
    path: url.pathname,
    method: req.method,
  });
}
```

### Usage in API Routes

```typescript
// app/api/checkout/route.ts
import { createRequestLogger } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const log = createRequestLogger(req);
  const start = Date.now();

  try {
    log.info("Checkout started");

    const body = await req.json();
    log.debug("Checkout payload", { planId: body.planId });

    // Process checkout
    const result = await processCheckout(body);

    log.info("Checkout completed", {
      duration: Date.now() - start,
      orderId: result.orderId,
    });

    return NextResponse.json(result);
  } catch (error) {
    log.error("Checkout failed", error as Error, {
      duration: Date.now() - start,
    });

    throw error;
  }
}
```

### Audit Logging

```typescript
// lib/audit.ts
import { logger } from "./logger";

interface AuditEvent {
  action: string;
  userId: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export function auditLog(event: AuditEvent) {
  logger.info(`AUDIT: ${event.action}`, {
    audit: true,
    ...event,
    timestamp: new Date().toISOString(),
  });
}

// Usage
auditLog({
  action: "appointment.cancelled",
  userId: session.user.id,
  targetType: "appointment",
  targetId: appointmentId,
  details: { reason: "user_requested" },
  ip: req.ip,
});
```

---

## 3. Uptime Monitoring

### Why Checkly

- Synthetic monitoring (browser checks)
- API monitoring
- Multi-location checks
- Playwright-based scripts
- Slack/PagerDuty integration

### Setup

1. Go to [app.checklyhq.com](https://app.checklyhq.com)
2. Create account
3. Set up checks

### Critical Checks to Create

#### API Health Check

```javascript
// Checkly API Check: /api/health
const response = await fetch('https://familiarise.com/api/health');
const data = await response.json();

assert(response.status === 200, 'Health check should return 200');
assert(data.status === 'ok', 'Status should be ok');
assert(data.database === 'connected', 'Database should be connected');
```

#### Authentication Flow

```javascript
// Checkly Browser Check: Auth Flow
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();

// Navigate to sign in
await page.goto('https://familiarise.com/auth/signin');

// Fill form
await page.fill('input[name="email"]', process.env.TEST_USER_EMAIL);
await page.fill('input[name="password"]', process.env.TEST_USER_PASSWORD);

// Submit
await page.click('button[type="submit"]');

// Wait for redirect
await page.waitForURL('**/dashboard/**');

// Verify dashboard loaded
const heading = await page.textContent('h1');
assert(heading.includes('Dashboard'), 'Should show dashboard');

await browser.close();
```

#### Checkout Flow

```javascript
// Checkly Browser Check: Checkout Availability
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();

// Navigate to a consultant
await page.goto('https://familiarise.com/explore/experts');

// Wait for results
await page.waitForSelector('[data-testid="consultant-card"]');

// Click first consultant
await page.click('[data-testid="consultant-card"]:first-child');

// Wait for profile
await page.waitForSelector('[data-testid="book-button"]');

// Verify booking button exists
const bookButton = await page.$('[data-testid="book-button"]');
assert(bookButton !== null, 'Book button should exist');

await browser.close();
```

### Check Schedule

| Check | Frequency | Locations |
|-------|-----------|-----------|
| API Health | Every 1 min | US, EU, APAC |
| Auth Flow | Every 5 min | US, EU |
| Checkout Available | Every 5 min | US, EU |
| Payment Flow | Every 15 min | US |

---

## 4. Operational Dashboards

### Key Metrics Dashboard

#### Business Metrics (PostHog)

```
Dashboard: Business Overview
├── Daily Active Users
├── New Sign-ups (by source)
├── Conversion Rate (visit → signup → booking)
├── Revenue (daily/weekly/monthly)
├── Average Order Value
├── Top Consultants (by bookings)
└── Booking Completion Rate
```

#### Technical Metrics (Mixed Sources)

```
Dashboard: Technical Health
├── Error Rate (Sentry)
├── API Latency P50/P95/P99 (Vercel/Sentry)
├── Cache Hit Rate (Custom)
├── Database Query Time (Sentry)
├── Background Job Success Rate (Inngest)
├── Uptime Percentage (Checkly)
└── Active Connections (Upstash)
```

### Creating Dashboards

#### PostHog Dashboard

```typescript
// Insight definitions for PostHog

// 1. Daily Active Users
{
  insight: "TRENDS",
  events: [{ id: "$pageview", math: "dau" }],
  interval: "day"
}

// 2. Sign-up Funnel
{
  insight: "FUNNELS",
  events: [
    { id: "$pageview", properties: { path: "/auth/signup" } },
    { id: "user_signed_up" },
    { id: "onboarding_completed" },
    { id: "checkout_started" },
    { id: "checkout_completed" }
  ]
}

// 3. Revenue by Plan Type
{
  insight: "TRENDS",
  events: [{ id: "checkout_completed", math: "sum", math_property: "amount" }],
  breakdown: "plan_type",
  interval: "day"
}
```

#### Custom Metrics Endpoint

```typescript
// app/api/metrics/route.ts
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import prisma from "@/lib/prisma";

export async function GET() {
  // Only allow from internal monitoring
  // Add authentication check here

  const [
    totalUsers,
    totalConsultants,
    totalBookings,
    pendingPayments,
    cacheInfo,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.consultantProfile.count(),
    prisma.appointment.count(),
    prisma.payment.count({ where: { paymentStatus: "PENDING" } }),
    redis.info("memory"),
  ]);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    metrics: {
      users: {
        total: totalUsers,
        consultants: totalConsultants,
      },
      bookings: {
        total: totalBookings,
        pending_payments: pendingPayments,
      },
      cache: {
        memory: cacheInfo,
      },
    },
  });
}
```

---

## 5. Alerting Strategy

### Alert Categories

| Category | Severity | Channel | Response Time |
|----------|----------|---------|---------------|
| Downtime | Critical | PagerDuty + Slack | Immediate |
| Error Spike | High | Slack #alerts | 15 minutes |
| Performance | Medium | Slack #alerts | 1 hour |
| Business | Low | Email | Next business day |

### Alert Definitions

#### Critical Alerts

```yaml
# Site Down
trigger: Checkly health check fails
condition: 2 consecutive failures
action: PagerDuty + Slack #critical
runbook: docs/runbooks/site-down.md

# Database Connection Failure
trigger: Health check returns database: disconnected
condition: Any failure
action: PagerDuty + Slack #critical
runbook: docs/runbooks/database-down.md

# Payment Processing Failure
trigger: Sentry error with tag payment: true, error_rate > 5%
condition: Within 5 minute window
action: PagerDuty + Slack #critical
runbook: docs/runbooks/payment-issues.md
```

#### High Alerts

```yaml
# Error Rate Spike
trigger: Sentry error frequency increase > 200%
condition: Compared to same period last week
action: Slack #alerts
runbook: docs/runbooks/error-spike.md

# API Latency Degradation
trigger: P95 latency > 2 seconds
condition: Sustained for 10 minutes
action: Slack #alerts
runbook: docs/runbooks/slow-api.md

# Background Job Failures
trigger: Inngest function failure rate > 10%
condition: Over 100+ executions
action: Slack #alerts
runbook: docs/runbooks/job-failures.md
```

#### Medium Alerts

```yaml
# Cache Hit Rate Low
trigger: Cache hit rate < 70%
condition: Sustained for 30 minutes
action: Slack #alerts-low
investigate: Cache invalidation issue or traffic spike

# Disk Usage High
trigger: Supabase storage > 80%
condition: Any
action: Email + Slack #alerts-low
investigate: Large file uploads or data growth
```

### Slack Integration

```typescript
// lib/alerts/slack.ts
interface SlackAlert {
  channel: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  message: string;
  fields?: { name: string; value: string }[];
  runbook?: string;
}

export async function sendSlackAlert(alert: SlackAlert) {
  const color = {
    critical: "#ff0000",
    high: "#ff6600",
    medium: "#ffcc00",
    low: "#00ccff",
  }[alert.severity];

  await fetch(process.env.SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: alert.channel,
      attachments: [
        {
          color,
          title: `[${alert.severity.toUpperCase()}] ${alert.title}`,
          text: alert.message,
          fields: alert.fields?.map((f) => ({
            title: f.name,
            value: f.value,
            short: true,
          })),
          footer: alert.runbook
            ? `Runbook: ${alert.runbook}`
            : undefined,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    }),
  });
}
```

---

## 6. Health Checks

### Comprehensive Health Check

```typescript
// app/api/health/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { redis } from "@/lib/redis";

interface HealthStatus {
  status: "ok" | "degraded" | "down";
  timestamp: string;
  version: string;
  checks: {
    database: CheckResult;
    redis: CheckResult;
    external: {
      stripe: CheckResult;
      stream: CheckResult;
    };
  };
}

interface CheckResult {
  status: "ok" | "error";
  latency?: number;
  message?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", latency: Date.now() - start };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await redis.ping();
    return { status: "ok", latency: Date.now() - start };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkStripe(): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Simple API call to verify connectivity
    const response = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    return {
      status: response.ok ? "ok" : "error",
      latency: Date.now() - start,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkStream(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const response = await fetch(
      `https://chat.stream-io-api.com/api/v1.0/check?api_key=${process.env.NEXT_PUBLIC_STREAM_API_KEY}`
    );
    return {
      status: response.ok ? "ok" : "error",
      latency: Date.now() - start,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function GET() {
  const [database, redisCheck, stripe, stream] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkStripe(),
    checkStream(),
  ]);

  const checks = {
    database,
    redis: redisCheck,
    external: { stripe, stream },
  };

  // Determine overall status
  const hasError = Object.values(checks).some((c) => {
    if ("status" in c) return c.status === "error";
    return Object.values(c).some((ec) => ec.status === "error");
  });

  const status: HealthStatus = {
    status: hasError ? "degraded" : "ok",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "unknown",
    checks,
  };

  return NextResponse.json(status, {
    status: hasError ? 503 : 200,
  });
}
```

### Readiness and Liveness

```typescript
// app/api/health/ready/route.ts
// Readiness - can the app handle traffic?
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ready: true });
  } catch {
    return NextResponse.json({ ready: false }, { status: 503 });
  }
}

// app/api/health/live/route.ts
// Liveness - is the app running?
export async function GET() {
  return NextResponse.json({ live: true });
}
```

---

## 7. Runbooks

### Template

```markdown
# Runbook: [Issue Name]

## Overview
Brief description of the issue

## Severity
Critical / High / Medium / Low

## Symptoms
- What alerts fire
- What users experience
- What logs show

## Diagnosis Steps
1. Step 1
2. Step 2
3. Step 3

## Resolution Steps
1. Step 1
2. Step 2
3. Step 3

## Rollback Procedure
If resolution doesn't work

## Post-Incident
- Who to notify
- What to document
```

### Example: Database Connection Issues

```markdown
# Runbook: Database Connection Issues

## Overview
Database connections failing or timing out

## Severity
Critical

## Symptoms
- Health check shows `database: error`
- API routes returning 500 errors
- Sentry errors mentioning Prisma/PostgreSQL
- Users unable to sign in or view data

## Diagnosis Steps
1. Check Supabase dashboard for database status
2. Check connection pool metrics
3. Review recent deployments
4. Check for slow/blocking queries

## Resolution Steps
1. **If Supabase outage:**
   - Check status.supabase.com
   - Wait for resolution
   - Enable maintenance page if needed

2. **If connection pool exhausted:**
   - Restart Vercel deployment
   - Review and optimize slow queries
   - Consider increasing pool size

3. **If blocking query:**
   - Identify blocking query in Supabase logs
   - Terminate if safe: `SELECT pg_terminate_backend(pid)`
   - Add index if needed

## Rollback Procedure
- Revert recent deployment if caused by code change
- Scale down if traffic spike caused exhaustion

## Post-Incident
- Notify: Engineering team, Product
- Document: Root cause, timeline, resolution
- Action items: Prevent recurrence
```

---

## Quick Reference

### Environment Variables

```env
# Logging (Better Stack / Logtail)
LOGTAIL_SOURCE_TOKEN=xxx

# Alerts
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx
PAGERDUTY_ROUTING_KEY=xxx
```

### Monitoring URLs

| Service | Dashboard URL |
|---------|---------------|
| Sentry | sentry.io/organizations/xxx |
| PostHog | app.posthog.com/project/xxx |
| Vercel | vercel.com/xxx/analytics |
| Better Stack | logs.betterstack.com |
| Checkly | app.checklyhq.com |
| Inngest | app.inngest.com |
| Upstash | console.upstash.com |
| Supabase | app.supabase.com/project/xxx |

### Verification Checklist

- [ ] Logtail configured
- [ ] Structured logging implemented
- [ ] Checkly uptime monitors created
- [ ] Health check endpoints working
- [ ] Slack alerts configured
- [ ] Critical runbooks documented
- [ ] Dashboards created
- [ ] Alert thresholds tuned
