import { NextRequest } from "next/server";

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxAttempts: number; // Maximum attempts per window
  keyGenerator?: (req: NextRequest, userId?: string) => string;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory store for rate limiting
// In production, consider using Redis for distributed rate limiting
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of Array.from(rateLimitStore.entries())) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 1000); // Clean up every minute

// Default key generator: combines IP and user ID
const defaultKeyGenerator = (req: NextRequest, userId?: string): string => {
  // Get IP from various possible headers
  const ip = 
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    req.headers.get("cf-connecting-ip") ?? // Cloudflare
    "unknown";
  return userId ? `${ip}:${userId}` : ip;
};

export class RateLimiter {
  private config: Required<RateLimitConfig>;

  constructor(config: RateLimitConfig) {
    this.config = {
      keyGenerator: defaultKeyGenerator,
      ...config,
    };
  }

  // Check if request should be rate limited
  public checkLimit(req: NextRequest, userId?: string): {
    allowed: boolean;
    remaining: number;
    resetTime: number;
    retryAfter?: number;
  } {
    const key = this.config.keyGenerator(req, userId);
    const now = Date.now();
    const windowStart = now;
    const windowEnd = now + this.config.windowMs;

    let entry = rateLimitStore.get(key);

    // Create new entry if doesn't exist or window has expired
    if (!entry || now > entry.resetTime) {
      entry = {
        count: 0,
        resetTime: windowEnd,
      };
      rateLimitStore.set(key, entry);
    }

    // Check if limit exceeded
    if (entry.count >= this.config.maxAttempts) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
        retryAfter: Math.ceil((entry.resetTime - now) / 1000), // seconds
      };
    }

    // Increment count and allow request
    entry.count++;
    rateLimitStore.set(key, entry);

    return {
      allowed: true,
      remaining: this.config.maxAttempts - entry.count,
      resetTime: entry.resetTime,
    };
  }

  // Reset limit for a specific key (useful for successful completions)
  public resetLimit(req: NextRequest, userId?: string): void {
    const key = this.config.keyGenerator(req, userId);
    rateLimitStore.delete(key);
  }

  // Get current status without incrementing
  public getStatus(req: NextRequest, userId?: string): {
    count: number;
    remaining: number;
    resetTime: number;
  } {
    const key = this.config.keyGenerator(req, userId);
    const entry = rateLimitStore.get(key);
    const now = Date.now();

    if (!entry || now > entry.resetTime) {
      return {
        count: 0,
        remaining: this.config.maxAttempts,
        resetTime: now + this.config.windowMs,
      };
    }

    return {
      count: entry.count,
      remaining: Math.max(0, this.config.maxAttempts - entry.count),
      resetTime: entry.resetTime,
    };
  }
}

// Pre-configured rate limiters for different operations
export const checkoutRateLimiter = new RateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  maxAttempts: 10, // Max 10 checkout attempts per 5 minutes per user/IP
});

export const checkoutPerSlotRateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxAttempts: 3, // Max 3 attempts per slot per minute
  keyGenerator: (req: NextRequest, userId?: string, slotKey?: string) => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown";
    const baseKey = userId ? `${ip}:${userId}` : ip;
    return slotKey ? `${baseKey}:slot:${slotKey}` : baseKey;
  },
});

export const webhookRateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxAttempts: 100, // Max 100 webhook requests per minute (generous for legitimate webhooks)
  keyGenerator: (req: NextRequest) => {
    // For webhooks, we use IP only as they don't have user context
    return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
           req.headers.get("x-real-ip") ??
           req.headers.get("cf-connecting-ip") ??
           "unknown";
  },
});

// Utility function to create standardized rate limit response
export function createRateLimitResponse(result: { 
  allowed: boolean; 
  retryAfter?: number; 
  remaining: number;
  resetTime: number;
}) {
  if (result.allowed) {
    throw new Error("Cannot create rate limit response for allowed request");
  }
  
  const retryAfter = result.retryAfter ?? 60; // Default to 60 seconds if not provided
  
  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded",
      message: `Too many requests. Please try again in ${retryAfter} seconds.`,
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": retryAfter.toString(),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": new Date(result.resetTime).toISOString(),
      },
    }
  );
}