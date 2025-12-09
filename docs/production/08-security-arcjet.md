# Security with Arcjet - Implementation Guide

> **Priority:** 🔴 CRITICAL
> **Effort:** 4-6 hours
> **Dependencies:** None

## Executive Summary

Arcjet provides comprehensive security for Next.js applications including rate limiting, bot detection, WAF protection, and DDoS mitigation. This replaces the need for multiple security tools and custom implementations.

---

## Table of Contents

1. [Why Arcjet](#1-why-arcjet)
2. [Features Overview](#2-features-overview)
3. [Installation](#3-installation)
4. [Configuration](#4-configuration)
5. [Implementation Patterns](#5-implementation-patterns)
6. [Endpoint-Specific Rules](#6-endpoint-specific-rules)
7. [Monitoring & Debugging](#7-monitoring--debugging)
8. [Migration from Current Setup](#8-migration-from-current-setup)

---

## 1. Why Arcjet

### Problems It Solves

| Current Issue | Arcjet Solution |
|---------------|-----------------|
| 77 unprotected API endpoints | Middleware-based protection |
| No rate limiting on auth endpoints | Built-in rate limiting |
| No bot detection | AI-powered bot detection |
| No SQL injection protection | Shield WAF |
| No DDoS protection | Built-in DDoS mitigation |
| Custom rate limit code complexity | Declarative configuration |

### Performance

- **Local decisions:** <1ms latency
- **Cloud decisions:** 20-30ms latency
- **Caching:** In-memory caching for repeated requests
- **HTTP/2:** Persistent connections for faster API calls

### What It Replaces

```
BEFORE (Multiple tools):
├── Upstash Rate Limiting (custom code)
├── Cloudflare WAF (external)
├── Custom bot detection (none)
├── Custom SQL injection checks (none)
└── Multiple middleware layers

AFTER (Arcjet only):
└── Arcjet (all-in-one)
    ├── Rate Limiting
    ├── Bot Detection
    ├── Shield WAF
    ├── Email Validation
    └── PII Detection
```

---

## 2. Features Overview

### Core Features

| Feature | Description | Use Case |
|---------|-------------|----------|
| **Rate Limiting** | Token bucket & sliding window | API abuse prevention |
| **Bot Detection** | AI-powered bot identification | Scraping prevention |
| **Shield WAF** | SQL injection, XSS protection | Attack prevention |
| **Email Validation** | Disposable/invalid email detection | Signup protection |
| **Sensitive Info** | PII detection and redaction | Data protection |

### Bot Categories

```typescript
// Arcjet categorizes bots into types
type BotCategory =
  | "AUTOMATED"           // Generic automation
  | "LIKELY_AUTOMATED"    // Probably a bot
  | "LIKELY_NOT_A_BOT"    // Probably human
  | "VERIFIED_BOT"        // Known good bot (Googlebot, etc.)

// You can allow/deny by category
allow: [
  "CATEGORY:SEARCH_ENGINE",  // Google, Bing, etc.
  "CATEGORY:MONITOR",        // Uptime monitors
  "CATEGORY:PREVIEW",        // Link previews (Slack, etc.)
]
```

---

## 3. Installation

### Step 1: Install Package

```bash
npm install @arcjet/next
```

### Step 2: Get API Key

1. Go to [app.arcjet.com](https://app.arcjet.com)
2. Create a new site
3. Copy the API key

### Step 3: Add Environment Variable

```env
# .env.local
ARCJET_KEY=ajkey_xxxxxxxxxxxxxxxxxxxxx
```

### Step 4: Add to .env.example

```env
# Security - Arcjet
ARCJET_KEY=
```

---

## 4. Configuration

### Basic Setup

```typescript
// lib/arcjet.ts
import arcjet, {
  shield,
  detectBot,
  rateLimit,
  validateEmail,
  sensitiveInfo,
} from "@arcjet/next";

// Base configuration used across the app
export const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ["ip.src"], // Track by IP address
  rules: [
    // Shield WAF - Always enabled
    shield({
      mode: "LIVE", // Use "DRY_RUN" for testing
    }),

    // Global rate limit
    rateLimit({
      mode: "LIVE",
      refillRate: 100,    // 100 requests
      interval: 60,       // per 60 seconds
      capacity: 100,      // bucket size
    }),
  ],
});

// Stricter configuration for auth endpoints
export const ajAuth = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),

    // Very strict rate limit for auth
    rateLimit({
      mode: "LIVE",
      refillRate: 5,      // 5 requests
      interval: 60,       // per minute
      capacity: 10,       // max burst of 10
    }),

    // Bot detection
    detectBot({
      mode: "LIVE",
      allow: [], // No bots allowed on auth
    }),
  ],
});

// Configuration for public API endpoints
export const ajApi = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),

    rateLimit({
      mode: "LIVE",
      refillRate: 60,
      interval: 60,
      capacity: 100,
    }),

    detectBot({
      mode: "LIVE",
      allow: [
        "CATEGORY:SEARCH_ENGINE",
        "CATEGORY:MONITOR",
        "CATEGORY:PREVIEW",
      ],
    }),
  ],
});

// Configuration for webhook endpoints
export const ajWebhook = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),

    // Allow more requests from payment providers
    rateLimit({
      mode: "LIVE",
      refillRate: 200,
      interval: 60,
      capacity: 500,
    }),

    // Allow automated systems
    detectBot({
      mode: "LIVE",
      allow: ["CATEGORY:AUTOMATED"],
    }),
  ],
});
```

---

## 5. Implementation Patterns

### Pattern 1: Middleware (Global Protection)

```typescript
// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { aj } from "@/lib/arcjet";

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Skip static assets
  if (
    path.startsWith("/_next") ||
    path.startsWith("/favicon") ||
    path.includes(".")
  ) {
    return NextResponse.next();
  }

  // Apply Arcjet protection
  const decision = await aj.protect(request);

  // Log for debugging
  if (decision.isDenied()) {
    console.log("Arcjet blocked request:", {
      path,
      reason: decision.reason,
      ip: request.ip,
    });
  }

  if (decision.isDenied()) {
    if (decision.reason.isRateLimit()) {
      return NextResponse.json(
        { error: "Too many requests", retryAfter: 60 },
        { status: 429 }
      );
    }

    if (decision.reason.isBot()) {
      return NextResponse.json(
        { error: "Bot detected" },
        { status: 403 }
      );
    }

    if (decision.reason.isShield()) {
      return NextResponse.json(
        { error: "Request blocked" },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all API routes
    "/api/:path*",
    // Match auth routes
    "/auth/:path*",
  ],
};
```

### Pattern 2: Per-Route Protection

```typescript
// app/api/auth/register/route.ts
import { NextRequest, NextResponse } from "next/server";
import { ajAuth } from "@/lib/arcjet";
import { validateEmail } from "@arcjet/next";

// Create route-specific protection
const aj = ajAuth.withRule(
  validateEmail({
    mode: "LIVE",
    deny: ["DISPOSABLE", "INVALID", "NO_MX_RECORDS"],
  })
);

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { email, password } = body;

  // Check Arcjet with email validation
  const decision = await aj.protect(req, { email });

  if (decision.isDenied()) {
    if (decision.reason.isEmail()) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }

    if (decision.reason.isRateLimit()) {
      return NextResponse.json(
        { error: "Too many registration attempts" },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: "Registration blocked" },
      { status: 403 }
    );
  }

  // Continue with registration...
}
```

### Pattern 3: User-Based Rate Limiting

```typescript
// app/api/checkout/route.ts
import { NextRequest, NextResponse } from "next/server";
import arcjet, { rateLimit, shield } from "@arcjet/next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  // Rate limit by user ID instead of IP
  characteristics: ["userId"],
  rules: [
    shield({ mode: "LIVE" }),
    rateLimit({
      mode: "LIVE",
      refillRate: 10,     // 10 checkouts
      interval: 3600,     // per hour
      capacity: 10,
    }),
  ],
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit by user ID
  const decision = await aj.protect(req, {
    userId: session.user.id,
  });

  if (decision.isDenied()) {
    return NextResponse.json(
      { error: "Too many checkout attempts" },
      { status: 429 }
    );
  }

  // Continue with checkout...
}
```

### Pattern 4: Sensitive Information Detection

```typescript
// app/api/support/route.ts
import { NextRequest, NextResponse } from "next/server";
import arcjet, { sensitiveInfo, shield } from "@arcjet/next";

const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  rules: [
    shield({ mode: "LIVE" }),
    sensitiveInfo({
      mode: "LIVE",
      deny: ["EMAIL", "PHONE_NUMBER", "CREDIT_CARD_NUMBER"],
    }),
  ],
});

export async function POST(req: NextRequest) {
  const body = await req.text();

  const decision = await aj.protect(req, { body });

  if (decision.isDenied()) {
    if (decision.reason.isSensitiveInfo()) {
      return NextResponse.json(
        { error: "Please do not include sensitive information" },
        { status: 400 }
      );
    }
  }

  // Process support request...
}
```

---

## 6. Endpoint-Specific Rules

### Recommended Configuration

| Endpoint Pattern | Rate Limit | Bot Detection | Shield | Notes |
|------------------|------------|---------------|--------|-------|
| `/api/auth/register` | 3/hour | Block all | ✅ | + Email validation |
| `/api/auth/login` | 10/15min | Block all | ✅ | Per IP+email |
| `/api/auth/forgot-password` | 3/15min | Block all | ✅ | Per email |
| `/api/auth/reset-password` | 5/hour | Block all | ✅ | Per token |
| `/api/webhooks/*` | 200/min | Allow automated | ✅ | High limit for providers |
| `/api/checkout/*` | 10/hour | Block all | ✅ | Per user ID |
| `/api/user/*` | 60/min | Allow search engines | ✅ | Standard API limit |
| `/api/events/*` | 60/min | Allow search engines | ✅ | Standard API limit |
| `/api/admin/*` | 200/min | Block all | ✅ | Higher for admin |

### Implementation

```typescript
// lib/arcjet/rules.ts
import arcjet, { shield, rateLimit, detectBot, validateEmail } from "@arcjet/next";

const baseKey = process.env.ARCJET_KEY!;

// Auth: Register
export const ajRegister = arcjet({
  key: baseKey,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),
    rateLimit({ mode: "LIVE", refillRate: 3, interval: 3600, capacity: 5 }),
    detectBot({ mode: "LIVE", allow: [] }),
    validateEmail({ mode: "LIVE", deny: ["DISPOSABLE", "INVALID"] }),
  ],
});

// Auth: Login
export const ajLogin = arcjet({
  key: baseKey,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),
    rateLimit({ mode: "LIVE", refillRate: 10, interval: 900, capacity: 15 }),
    detectBot({ mode: "LIVE", allow: [] }),
  ],
});

// Auth: Forgot Password
export const ajForgotPassword = arcjet({
  key: baseKey,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),
    rateLimit({ mode: "LIVE", refillRate: 3, interval: 900, capacity: 5 }),
    detectBot({ mode: "LIVE", allow: [] }),
  ],
});

// Webhooks
export const ajWebhook = arcjet({
  key: baseKey,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),
    rateLimit({ mode: "LIVE", refillRate: 200, interval: 60, capacity: 500 }),
    detectBot({ mode: "LIVE", allow: ["CATEGORY:AUTOMATED"] }),
  ],
});

// Checkout
export const ajCheckout = arcjet({
  key: baseKey,
  characteristics: ["userId"],
  rules: [
    shield({ mode: "LIVE" }),
    rateLimit({ mode: "LIVE", refillRate: 10, interval: 3600, capacity: 10 }),
    detectBot({ mode: "LIVE", allow: [] }),
  ],
});

// Standard API
export const ajApi = arcjet({
  key: baseKey,
  characteristics: ["ip.src"],
  rules: [
    shield({ mode: "LIVE" }),
    rateLimit({ mode: "LIVE", refillRate: 60, interval: 60, capacity: 100 }),
    detectBot({
      mode: "LIVE",
      allow: ["CATEGORY:SEARCH_ENGINE", "CATEGORY:MONITOR"],
    }),
  ],
});

// Admin API
export const ajAdmin = arcjet({
  key: baseKey,
  characteristics: ["userId"],
  rules: [
    shield({ mode: "LIVE" }),
    rateLimit({ mode: "LIVE", refillRate: 200, interval: 60, capacity: 300 }),
    detectBot({ mode: "LIVE", allow: [] }),
  ],
});
```

---

## 7. Monitoring & Debugging

### Logging Decisions

```typescript
// lib/arcjet/logger.ts
import { ArcjetDecision } from "@arcjet/next";

export function logArcjetDecision(
  decision: ArcjetDecision,
  context: { path: string; method: string; ip?: string }
) {
  const log = {
    timestamp: new Date().toISOString(),
    path: context.path,
    method: context.method,
    ip: context.ip,
    conclusion: decision.conclusion,
    isDenied: decision.isDenied(),
    reason: decision.reason,
    results: decision.results.map((r) => ({
      ruleId: r.ruleId,
      conclusion: r.conclusion,
      reason: r.reason,
    })),
  };

  if (decision.isDenied()) {
    console.warn("[Arcjet Denied]", JSON.stringify(log));
  } else if (process.env.NODE_ENV === "development") {
    console.log("[Arcjet Allowed]", JSON.stringify(log));
  }
}
```

### Dashboard Integration

```typescript
// Track decisions in PostHog
import posthog from "posthog-js";

function trackSecurityEvent(decision: ArcjetDecision, path: string) {
  if (decision.isDenied()) {
    posthog.capture("security_block", {
      path,
      reason: decision.reason.toString(),
      isRateLimit: decision.reason.isRateLimit(),
      isBot: decision.reason.isBot(),
      isShield: decision.reason.isShield(),
    });
  }
}
```

### Debug Mode

```typescript
// Use DRY_RUN mode for testing
const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  rules: [
    shield({
      mode: process.env.NODE_ENV === "production" ? "LIVE" : "DRY_RUN",
    }),
    rateLimit({
      mode: process.env.NODE_ENV === "production" ? "LIVE" : "DRY_RUN",
      refillRate: 100,
      interval: 60,
      capacity: 100,
    }),
  ],
});
```

---

## 8. Migration from Current Setup

### Current Rate Limiting Code to Remove

```typescript
// REMOVE: lib/redis.ts rate limiting code
// This is replaced by Arcjet

// BEFORE
import { Ratelimit } from "@upstash/ratelimit";
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(5, "10 s"),
});

// AFTER
// Keep Upstash Redis for caching only
// Rate limiting handled by Arcjet
```

### Migration Steps

1. **Install Arcjet**
   ```bash
   npm install @arcjet/next
   ```

2. **Add Environment Variable**
   ```env
   ARCJET_KEY=ajkey_xxx
   ```

3. **Create Arcjet Configuration**
   - Create `lib/arcjet.ts` with configurations
   - Create `lib/arcjet/rules.ts` for endpoint-specific rules

4. **Update Middleware**
   - Add Arcjet protection to middleware
   - Remove old rate limiting code

5. **Update API Routes**
   - Add Arcjet protection to auth endpoints
   - Add protection to checkout endpoints

6. **Test in DRY_RUN Mode**
   - Verify decisions are correct
   - Check logs for false positives

7. **Switch to LIVE Mode**
   - Update mode to "LIVE"
   - Monitor for issues

8. **Remove Old Code**
   - Remove Upstash rate limiting imports
   - Keep Redis for caching only

### Verification Checklist

- [ ] Arcjet package installed
- [ ] Environment variable set
- [ ] Middleware updated
- [ ] Auth endpoints protected
- [ ] Webhook endpoints protected
- [ ] Checkout endpoints protected
- [ ] DRY_RUN testing complete
- [ ] LIVE mode enabled
- [ ] Old rate limiting code removed
- [ ] Monitoring configured

---

## Quick Reference

### Decision Types

```typescript
decision.isDenied()           // Request should be blocked
decision.isAllowed()          // Request should proceed

decision.reason.isRateLimit() // Blocked due to rate limit
decision.reason.isBot()       // Blocked as bot
decision.reason.isShield()    // Blocked by WAF
decision.reason.isEmail()     // Invalid email
decision.reason.isSensitiveInfo() // Contains PII
```

### Response Codes

| Reason | HTTP Status | Response |
|--------|-------------|----------|
| Rate Limit | 429 | Too Many Requests |
| Bot | 403 | Forbidden |
| Shield (attack) | 403 | Forbidden |
| Invalid Email | 400 | Bad Request |
| Sensitive Info | 400 | Bad Request |

### Useful Links

- [Arcjet Documentation](https://docs.arcjet.com/)
- [Next.js Integration](https://docs.arcjet.com/get-started/nextjs)
- [Bot Protection](https://docs.arcjet.com/bot-protection/quick-start)
- [Rate Limiting](https://docs.arcjet.com/rate-limiting/quick-start)
- [Shield WAF](https://docs.arcjet.com/shield/quick-start)
