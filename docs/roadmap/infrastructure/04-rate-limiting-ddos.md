# Rate Limiting & DDoS Protection - Production Readiness

> **Severity Level:** HIGH
> **Last Updated:** 2024
> **Status:** Requires Immediate Implementation

## Executive Summary

The application has minimal rate limiting (5 requests/10 seconds globally) with no per-endpoint customization. Critical endpoints like authentication, webhooks, and resource-intensive queries are unprotected, creating significant DDoS and abuse vectors.

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Vulnerability Assessment](#2-vulnerability-assessment)
3. [Attack Scenarios](#3-attack-scenarios)
4. [Recommended Rate Limits](#4-recommended-rate-limits)
5. [Implementation Guide](#5-implementation-guide)
6. [DDoS Mitigation Strategies](#6-ddos-mitigation-strategies)
7. [Monitoring & Alerting](#7-monitoring--alerting)

---

## 1. Current State Analysis

### 1.1 Existing Rate Limiting

**File:** `lib/redis.ts:20-50`

```typescript
// Current configuration
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(5, "10 s"), // 5 requests per 10 seconds
  analytics: true,
});
```

### 1.2 Implementation Gaps

| Gap                             | Status     | Severity |
| ------------------------------- | ---------- | -------- |
| Global limit only               | ✅ Exists  | -        |
| Per-endpoint limits             | ❌ Missing | HIGH     |
| Per-user limits                 | ❌ Missing | HIGH     |
| Authentication endpoint limits  | ❌ Missing | CRITICAL |
| Webhook endpoint limits         | ❌ Missing | HIGH     |
| Resource-intensive query limits | ❌ Missing | HIGH     |
| Burst handling                  | ❌ Missing | MEDIUM   |

### 1.3 Unprotected Critical Endpoints

| Endpoint                    | Risk     | Attack Vector                 |
| --------------------------- | -------- | ----------------------------- |
| `/api/auth/register`        | CRITICAL | Account creation spam         |
| `/api/auth/forgot-password` | CRITICAL | Email enumeration, email spam |
| `/api/auth/reset-password`  | HIGH     | Token brute force             |
| `/api/webhooks/*`           | HIGH     | Webhook flooding              |
| `/api/user/consultants`     | HIGH     | Data scraping, DB exhaustion  |
| `/api/slots/appointments`   | HIGH     | Resource exhaustion           |
| `/api/stream/debug`         | CRITICAL | Data dump endpoint            |

---

## 2. Vulnerability Assessment

### 2.1 Database Exhaustion Attacks

**Vulnerable Endpoints:**

```
/api/user/consultants       → Complex queries with multiple joins
/api/bookings/subscriptions   → Deep nested includes (100+ queries)
/api/slots/appointments     → 7-level nested queries
/api/slots/availability/*   → Timezone calculations per request
```

**Attack Pattern:**

```
Attacker sends 1000 concurrent requests to /api/slots/appointments
→ Each request generates 100+ database queries
→ Database connection pool exhausted
→ Application becomes unresponsive
```

### 2.2 Email Spam Attacks

**Vulnerable Endpoint:** `/api/auth/forgot-password`

```
Attacker submits 10,000 forgot-password requests with random emails
→ System attempts to send 10,000 emails
→ Email provider rate limits triggered
→ Legitimate users can't receive emails
→ Potential email provider ban
```

### 2.3 Account Creation Spam

**Vulnerable Endpoint:** `/api/auth/register`

```
Attacker creates 100,000 fake accounts
→ Database bloated with fake users
→ Verification emails sent (if applicable)
→ Difficult to identify legitimate users
→ Analytics/metrics corrupted
```

### 2.4 Webhook Flooding

**Vulnerable Endpoints:** `/api/webhooks/*`

```
Attacker sends fake webhooks (even with invalid signatures)
→ Server processes signature verification for each
→ CPU exhausted on cryptographic operations
→ Legitimate webhooks delayed or dropped
```

---

## 3. Attack Scenarios

### 3.1 Scenario: Credential Stuffing Attack

**Target:** `/api/auth/[...nextauth]/`

```
Attack Flow:
1. Attacker has list of 1M leaked email:password combinations
2. Sends login attempts at 100 requests/second
3. Current limit: 5/10s = blocks after 5 attempts
4. Attacker uses 1000 rotating IPs
5. Result: 100 * 1000 = 100,000 attempts/second bypass limit

Defense Needed:
- Per-account rate limiting
- CAPTCHA after 3 failures
- Account lockout after 10 failures
- IP reputation checking
```

### 3.2 Scenario: Resource Exhaustion DDoS

**Target:** `/api/slots/appointments`

```
Attack Flow:
1. Attacker identifies expensive query endpoint
2. Sends requests with date ranges spanning years
3. Each request triggers 100+ database queries
4. Database connection pool (typically 10-20) exhausted
5. All users experience timeouts

Defense Needed:
- Request complexity limiting
- Query timeout enforcement
- Date range restrictions
- Per-endpoint rate limiting
```

### 3.3 Scenario: Data Scraping

**Target:** `/api/user/consultants`, `/api/user/consultees`

```
Attack Flow:
1. Attacker enumerates all consultant profiles
2. Uses pagination to extract all data
3. Builds competitor database
4. Potential privacy violations

Defense Needed:
- Authentication required
- Pagination limits (max 100)
- Rate limiting per user
- Request logging for anomaly detection
```

### 3.4 Scenario: Availability Slot Enumeration

**Target:** `/api/slots/availability/[consultantId]`

```
Attack Flow:
1. Attacker queries availability for all consultants
2. For each, requests full year of data
3. Builds complete schedule database
4. Identifies high-value consultants
5. Could be used for targeted attacks

Defense Needed:
- Date range limits (max 1 month)
- Rate limiting per consultant queried
- Authentication required
- Caching to reduce database load
```

---

## 4. Recommended Rate Limits

### 4.1 Tiered Rate Limit Configuration

```typescript
// lib/ratelimit.ts
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// Define rate limit tiers
export const RATE_LIMITS = {
  // Authentication - strictest limits
  AUTH_REGISTER: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(3, "1 h"), // 3 registrations per hour
    prefix: "ratelimit:auth:register",
  }),

  AUTH_LOGIN: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, "15 m"), // 10 attempts per 15 min
    prefix: "ratelimit:auth:login",
  }),

  AUTH_FORGOT_PASSWORD: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(3, "15 m"), // 3 requests per 15 min
    prefix: "ratelimit:auth:forgot",
  }),

  AUTH_RESET_PASSWORD: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "1 h"), // 5 attempts per hour
    prefix: "ratelimit:auth:reset",
  }),

  // Webhooks - allow bursts but limit sustained load
  WEBHOOK: new Ratelimit({
    redis,
    limiter: Ratelimit.tokenBucket(100, "1 m", 20), // 100/min, 20 burst
    prefix: "ratelimit:webhook",
  }),

  // API - General endpoints
  API_READ: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(100, "1 m"), // 100 reads per minute
    prefix: "ratelimit:api:read",
  }),

  API_WRITE: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, "1 m"), // 30 writes per minute
    prefix: "ratelimit:api:write",
  }),

  // Resource-intensive queries
  EXPENSIVE_QUERY: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, "1 m"), // 10 expensive queries per min
    prefix: "ratelimit:api:expensive",
  }),

  // Checkout/Payment - strict to prevent abuse
  CHECKOUT: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, "1 h"), // 10 checkouts per hour
    prefix: "ratelimit:checkout",
  }),

  // Admin endpoints - allow more
  ADMIN: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(200, "1 m"), // 200/min for admin
    prefix: "ratelimit:admin",
  }),
};

// Rate limit key generators
export function getUserKey(userId: string | undefined, ip: string): string {
  return userId || ip;
}

export function getEmailKey(email: string): string {
  return `email:${email.toLowerCase()}`;
}
```

### 4.2 Endpoint-Specific Limits

| Endpoint Pattern                  | Limit | Window | Key        |
| --------------------------------- | ----- | ------ | ---------- |
| `/api/auth/register`              | 3     | 1 hour | IP         |
| `/api/auth/[...nextauth]` (login) | 10    | 15 min | IP + Email |
| `/api/auth/forgot-password`       | 3     | 15 min | IP + Email |
| `/api/auth/reset-password`        | 5     | 1 hour | Token      |
| `/api/webhooks/*`                 | 100   | 1 min  | Gateway    |
| `/api/checkout/*`                 | 10    | 1 hour | User       |
| `/api/user/consultants`           | 30    | 1 min  | IP/User    |
| `/api/slots/appointments`         | 20    | 1 min  | IP/User    |
| `/api/admin/*`                    | 200   | 1 min  | User       |
| Default API                       | 60    | 1 min  | IP/User    |

---

## 5. Implementation Guide

### 5.1 Rate Limit Middleware

```typescript
// middleware/rateLimit.ts
import { NextRequest, NextResponse } from "next/server";
import { RATE_LIMITS, getUserKey, getEmailKey } from "@/lib/ratelimit";

interface RateLimitConfig {
  limiter: (typeof RATE_LIMITS)[keyof typeof RATE_LIMITS];
  keyGenerator?: (req: NextRequest) => string;
}

const ENDPOINT_CONFIG: Record<string, RateLimitConfig> = {
  "/api/auth/register": {
    limiter: RATE_LIMITS.AUTH_REGISTER,
    keyGenerator: (req) => req.ip || "unknown",
  },
  "/api/auth/forgot-password": {
    limiter: RATE_LIMITS.AUTH_FORGOT_PASSWORD,
    keyGenerator: async (req) => {
      const body = await req.clone().json();
      return getEmailKey(body.email);
    },
  },
  "/api/webhooks/stripe": {
    limiter: RATE_LIMITS.WEBHOOK,
    keyGenerator: () => "stripe",
  },
  "/api/webhooks/razorpay": {
    limiter: RATE_LIMITS.WEBHOOK,
    keyGenerator: () => "razorpay",
  },
  "/api/checkout": {
    limiter: RATE_LIMITS.CHECKOUT,
  },
  "/api/slots/appointments": {
    limiter: RATE_LIMITS.EXPENSIVE_QUERY,
  },
  "/api/user/consultants": {
    limiter: RATE_LIMITS.EXPENSIVE_QUERY,
  },
};

export async function rateLimit(
  req: NextRequest,
  config: RateLimitConfig,
  identifier: string,
): Promise<{ success: boolean; remaining: number; reset: number }> {
  const { success, remaining, reset } = await config.limiter.limit(identifier);

  return { success, remaining, reset };
}

export function getRateLimitHeaders(
  remaining: number,
  reset: number,
): Record<string, string> {
  return {
    "X-RateLimit-Remaining": remaining.toString(),
    "X-RateLimit-Reset": reset.toString(),
    "Retry-After": Math.ceil((reset - Date.now()) / 1000).toString(),
  };
}
```

### 5.2 API Route Integration

```typescript
// Example: /api/auth/register/route.ts
import { NextRequest, NextResponse } from "next/server";
import { RATE_LIMITS, getUserKey } from "@/lib/ratelimit";

export async function POST(req: NextRequest) {
  // Apply rate limit
  const identifier = req.ip || "unknown";
  const { success, remaining, reset } =
    await RATE_LIMITS.AUTH_REGISTER.limit(identifier);

  if (!success) {
    return NextResponse.json(
      {
        error: "Too many registration attempts. Please try again later.",
        retryAfter: Math.ceil((reset - Date.now()) / 1000),
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": reset.toString(),
          "Retry-After": Math.ceil((reset - Date.now()) / 1000).toString(),
        },
      },
    );
  }

  // Proceed with registration...
}
```

### 5.3 Middleware-Based Rate Limiting

```typescript
// middleware.ts - Add rate limiting section
import { RATE_LIMITS } from "@/lib/ratelimit";

// Add to existing middleware
const RATE_LIMITED_PATHS: Record<string, keyof typeof RATE_LIMITS> = {
  "/api/auth/register": "AUTH_REGISTER",
  "/api/auth/forgot-password": "AUTH_FORGOT_PASSWORD",
  "/api/checkout": "CHECKOUT",
};

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Check if path needs rate limiting
  for (const [pattern, limiterKey] of Object.entries(RATE_LIMITED_PATHS)) {
    if (path.startsWith(pattern)) {
      const limiter = RATE_LIMITS[limiterKey];
      const identifier = request.ip || "unknown";

      const { success, remaining, reset } = await limiter.limit(identifier);

      if (!success) {
        return NextResponse.json(
          { error: "Rate limit exceeded" },
          {
            status: 429,
            headers: {
              "Retry-After": Math.ceil((reset - Date.now()) / 1000).toString(),
            },
          },
        );
      }
    }
  }

  // Continue with existing middleware logic...
}
```

### 5.4 Request Complexity Limiting

```typescript
// lib/queryLimits.ts
export const QUERY_LIMITS = {
  // Pagination limits
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE_SIZE: 20,

  // Date range limits
  MAX_DATE_RANGE_DAYS: 90,

  // Include depth limits
  MAX_INCLUDE_DEPTH: 3,

  // Timeout limits (ms)
  QUERY_TIMEOUT: 10000, // 10 seconds

  // Result size limits
  MAX_RESULTS: 1000,
};

// Apply in API routes
export function validatePagination(searchParams: URLSearchParams) {
  const limit = Math.min(
    Math.max(parseInt(searchParams.get("limit") || "20"), 1),
    QUERY_LIMITS.MAX_PAGE_SIZE,
  );
  const page = Math.max(parseInt(searchParams.get("page") || "1"), 1);

  return { limit, page, skip: (page - 1) * limit };
}

export function validateDateRange(
  startDate: string,
  endDate: string,
): { start: Date; end: Date } {
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Validate dates are valid
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("Invalid date format");
  }

  // Check range doesn't exceed limit
  const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > QUERY_LIMITS.MAX_DATE_RANGE_DAYS) {
    throw new Error(
      `Date range cannot exceed ${QUERY_LIMITS.MAX_DATE_RANGE_DAYS} days`,
    );
  }

  return { start, end };
}
```

---

## 6. DDoS Mitigation Strategies

### 6.1 Multi-Layer Defense

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: CDN/Edge (Cloudflare, Vercel Edge)                 │
│ - Geographic blocking                                        │
│ - Bot detection                                              │
│ - DDoS absorption                                            │
│ - WAF rules                                                  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Application Middleware                              │
│ - Rate limiting (Upstash Redis)                              │
│ - Request validation                                         │
│ - IP reputation checking                                     │
│ - Session validation                                         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: API Endpoints                                       │
│ - Authentication/authorization                               │
│ - Input validation                                           │
│ - Query complexity limits                                    │
│ - Response size limits                                       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 4: Database                                            │
│ - Connection pooling                                         │
│ - Query timeouts                                             │
│ - Read replicas                                              │
│ - Query caching                                              │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Cloudflare Configuration

```yaml
# cloudflare-rules.yaml (conceptual)
rules:
  # Block known bad actors
  - name: "Block Tor Exit Nodes"
    expression: "ip.src in $cf.threat_intelligence.tor_exit_nodes"
    action: block

  # Rate limit authentication
  - name: "Auth Rate Limit"
    expression: "http.request.uri.path contains '/api/auth'"
    rateLimit:
      requests: 10
      period: 60
      action: block

  # Challenge suspicious requests
  - name: "Challenge Scrapers"
    expression: |
      http.request.uri.path contains "/api/user" and
      not cf.bot_management.verified_bot and
      cf.bot_management.score < 30
    action: challenge

  # Geographic restrictions (if applicable)
  - name: "Geo Block"
    expression: "ip.geoip.country in {'RU' 'CN' 'KP'}"
    action: challenge
```

### 6.3 Circuit Breaker Pattern

```typescript
// lib/circuitBreaker.ts
interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number; // ms
  halfOpenRequests: number;
}

class CircuitBreaker {
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenSuccesses = 0;

  constructor(private config: CircuitBreakerConfig) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.config.resetTimeout) {
        this.state = "HALF_OPEN";
        this.halfOpenSuccesses = 0;
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await fn();

      if (this.state === "HALF_OPEN") {
        this.halfOpenSuccesses++;
        if (this.halfOpenSuccesses >= this.config.halfOpenRequests) {
          this.state = "CLOSED";
          this.failureCount = 0;
        }
      }

      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.config.failureThreshold) {
        this.state = "OPEN";
      }

      throw error;
    }
  }
}

// Usage for database queries
const dbCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  halfOpenRequests: 3,
});

async function executeQuery<T>(query: () => Promise<T>): Promise<T> {
  return dbCircuitBreaker.execute(query);
}
```

### 6.4 Graceful Degradation

```typescript
// lib/degradation.ts
interface DegradationConfig {
  enabled: boolean;
  cacheOnly: boolean;
  reducedFunctionality: string[];
}

class GracefulDegradation {
  private config: DegradationConfig = {
    enabled: false,
    cacheOnly: false,
    reducedFunctionality: [],
  };

  // Check system health and adjust
  async checkHealth(): Promise<void> {
    const [dbHealth, redisHealth, apiHealth] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkExternalAPIs(),
    ]);

    if (!dbHealth) {
      this.config.enabled = true;
      this.config.cacheOnly = true;
    }

    if (!redisHealth) {
      this.config.reducedFunctionality.push("rate_limiting");
    }
  }

  isFeatureAvailable(feature: string): boolean {
    return !this.config.reducedFunctionality.includes(feature);
  }

  shouldUseCacheOnly(): boolean {
    return this.config.cacheOnly;
  }
}

// Usage in API routes
const degradation = new GracefulDegradation();

export async function GET(req: NextRequest) {
  // Check if we should use cache-only mode
  if (degradation.shouldUseCacheOnly()) {
    const cached = await redis.get(cacheKey);
    if (cached) return NextResponse.json(cached);
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  // Normal operation...
}
```

---

## 7. Monitoring & Alerting

### 7.1 Metrics to Track

```typescript
// lib/metrics.ts
export const RATE_LIMIT_METRICS = {
  // Request counts
  "ratelimit.request.total": "Counter",
  "ratelimit.request.allowed": "Counter",
  "ratelimit.request.blocked": "Counter",

  // By endpoint
  "ratelimit.endpoint.auth.blocked": "Counter",
  "ratelimit.endpoint.api.blocked": "Counter",
  "ratelimit.endpoint.webhook.blocked": "Counter",

  // Patterns
  "ratelimit.ip.unique": "Gauge",
  "ratelimit.ip.suspicious": "Counter",
  "ratelimit.burst.detected": "Counter",

  // Performance
  "ratelimit.latency": "Histogram",
  "ratelimit.redis.errors": "Counter",
};
```

### 7.2 Alert Thresholds

```yaml
# alerts.yaml
alerts:
  - name: "High Rate Limit Blocks"
    condition: "rate(ratelimit.request.blocked[5m]) > 100"
    severity: warning
    message: "High number of rate limit blocks detected"

  - name: "Auth Endpoint Under Attack"
    condition: "rate(ratelimit.endpoint.auth.blocked[1m]) > 50"
    severity: critical
    message: "Possible credential stuffing attack on auth endpoints"

  - name: "Webhook Flooding"
    condition: "rate(ratelimit.endpoint.webhook.blocked[1m]) > 100"
    severity: high
    message: "Webhook endpoints receiving excessive requests"

  - name: "Suspicious IP Surge"
    condition: "rate(ratelimit.ip.suspicious[5m]) > 20"
    severity: high
    message: "Surge in suspicious IP addresses detected"

  - name: "Redis Rate Limit Failures"
    condition: "rate(ratelimit.redis.errors[5m]) > 5"
    severity: critical
    message: "Rate limiting may be failing due to Redis errors"
```

### 7.3 Logging

```typescript
// lib/ratelimitLogger.ts
interface RateLimitLog {
  timestamp: Date;
  path: string;
  method: string;
  ip: string;
  userId?: string;
  allowed: boolean;
  remaining: number;
  reset: number;
  userAgent?: string;
}

async function logRateLimitEvent(event: RateLimitLog): Promise<void> {
  // Log to structured logging system
  console.log(
    JSON.stringify({
      level: event.allowed ? "info" : "warn",
      type: "ratelimit",
      ...event,
    }),
  );

  // Track suspicious patterns
  if (!event.allowed) {
    await trackSuspiciousIP(event.ip);
  }
}

async function trackSuspiciousIP(ip: string): Promise<void> {
  const key = `suspicious:${ip}`;
  const count = await redis.incr(key);
  await redis.expire(key, 3600); // 1 hour window

  if (count > 10) {
    // Flag for review
    await redis.sadd("suspicious_ips", ip);
    // Could trigger automatic blocking or CAPTCHA requirement
  }
}
```

### 7.4 Dashboard Queries

```sql
-- Rate limit blocks by endpoint (last hour)
SELECT
  path,
  COUNT(*) as blocked_count,
  COUNT(DISTINCT ip) as unique_ips
FROM rate_limit_logs
WHERE allowed = false
  AND timestamp > NOW() - INTERVAL '1 hour'
GROUP BY path
ORDER BY blocked_count DESC;

-- Suspicious IPs
SELECT
  ip,
  COUNT(*) as block_count,
  array_agg(DISTINCT path) as targeted_paths
FROM rate_limit_logs
WHERE allowed = false
  AND timestamp > NOW() - INTERVAL '1 hour'
GROUP BY ip
HAVING COUNT(*) > 10
ORDER BY block_count DESC;

-- Rate limit trends
SELECT
  date_trunc('minute', timestamp) as minute,
  SUM(CASE WHEN allowed THEN 1 ELSE 0 END) as allowed,
  SUM(CASE WHEN NOT allowed THEN 1 ELSE 0 END) as blocked
FROM rate_limit_logs
WHERE timestamp > NOW() - INTERVAL '1 hour'
GROUP BY minute
ORDER BY minute;
```

---

## Appendix: Quick Implementation Checklist

### Phase 1: Critical (Day 1)

- [ ] Add rate limiting to `/api/auth/register`
- [ ] Add rate limiting to `/api/auth/forgot-password`
- [ ] Add rate limiting to `/api/webhooks/*`
- [ ] Add pagination limits to all list endpoints

### Phase 2: High Priority (Week 1)

- [ ] Implement tiered rate limit configuration
- [ ] Add rate limiting middleware
- [ ] Add query complexity limits
- [ ] Implement date range restrictions

### Phase 3: Production Hardening (Week 2)

- [ ] Set up Cloudflare WAF rules
- [ ] Implement circuit breaker pattern
- [ ] Set up monitoring dashboards
- [ ] Configure alerting thresholds
- [ ] Test under load

### Testing Commands

```bash
# Test rate limiting
for i in {1..20}; do
  curl -w "\n%{http_code}\n" http://localhost:3000/api/auth/register \
    -X POST -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"test123"}'
done

# Expected: First 3 return 200/400, rest return 429

# Load test with k6
k6 run --vus 100 --duration 30s loadtest.js
```
