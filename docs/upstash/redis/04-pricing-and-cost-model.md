# Upstash Redis — Pricing & Cost Model

Covers the full command budget for the current Redis usage (rate limiting, distributed locks, maintenance mode), growth projections by MAU, data size analysis, and guidance on when to leave the free tier.

---

## What Redis Is Used For

Three distinct use cases with very different command profiles:

| Use case | Where | Commands per event | Frequency |
|---|---|---|---|
| **Rate limiting** | `lib/rate-limit.ts` (11 limiters) | ~2 per `limit()` call | Every rate-limited request |
| **Maintenance state** | `lib/maintenance-edge.ts` | 2 GETs per cache miss | Once per 30s per edge instance |
| **Distributed locks** | `lib/redis.ts` (payouts, approval-payments, appointments) | ~3 (SET NX + Lua eval) | Per payment/booking only |

### Rate limiters at a glance

| Limiter | Endpoint | Window | Key | Layer |
|---|---|---|---|---|
| `authLimiter` | POST `/api/auth/sign-in,sign-up,forget-password` | 10/15 min | IP | Edge |
| `searchLimiter` | GET `/api/user/consultants` | 60/min | IP | Edge |
| `eligibilityLimiter` | GET `/api/trials/check-eligibility` | 20/min | IP | Edge |
| `newsletterLimiter` | POST `/api/newsletter/subscribe` | 3/hr | IP | Edge |
| `availabilityLimiter` | GET `/api/slots/availability/[id]` | 30/min | IP | Edge |
| `checkoutLimiter` | POST `/api/checkout` | 5/min | user ID | Handler |
| `discountLimiter` | POST `/api/payments/discounts/validate` | 10/min | user ID | Handler |
| `referralApplyLimiter` | POST `/api/referrals/apply` | 3/24 hr | user ID | Handler |
| `spamLimiter` | support tickets, feedbacks, reviews, report | 5/hr | user ID | Handler |
| `waitlistLimiter` | POST `/api/waitlist` | 5/hr | user ID | Handler |
| `requestApprovalLimiter` | POST `/api/slots/request-for-approval` | 10/hr | user ID | Handler |

### Maintenance mode — the 30-second cache

`getMaintenanceState()` in `lib/maintenance-edge.ts` fires 2 Redis GETs per call but is **cached in-memory for 30 seconds per edge instance**. In the normal `OFF` state (always the case unless you explicitly trigger maintenance), the result is cached and the vast majority of requests never touch Redis for maintenance. Actual Redis hits: roughly 1 call per 10–20 middleware invocations at moderate traffic.

---

## Commands per User per Month

### Active consultee (visits 7×/month, books 1–2 sessions)

| Action | Commands |
|---|---|
| 7 browse sessions × 3 search pages × 2 cmds | 42 |
| 7 sessions × 2 availability checks × 2 cmds | 28 |
| 1 login × 2 cmds | 2 |
| 1 booking: checkout (2) + lock acquire/release (3) | 5 |
| Maintenance amortized (7 sessions × 3 req × 0.1 cmd) | ~2 |
| **Total** | **~80 cmds/month** |

### Active consultant (visits 4–5×/month, no booking)

| Action | Commands |
|---|---|
| 4 sessions × 2 searches × 2 cmds | 16 |
| 4 logins × 2 cmds | 8 |
| Maintenance amortized | ~2 |
| **Total** | **~26 cmds/month** |

**Blended average across all user types:** ~55–60 commands/MAU/month

---

## Growth Projections

Exchange rate: ₹90.7/$1. Free tier: 500K commands/month. Pay-as-you-go: $0.20 per 100K commands after the free allowance.

| Stage | MAU | Commands/month | Free tier used | PAYG cost | Monthly cost (₹) |
|---|---|---|---|---|---|
| Launch (M1) | 50 | ~3K | 0.6% | $0 | ₹0 |
| Early traction (M3) | 200 | ~12K | 2.4% | $0 | ₹0 |
| Growing (M6) | 700 | ~42K | 8% | $0 | ₹0 |
| Scale (M12) | 1,500 | ~90K | 18% | $0 | ₹0 |
| Strong growth (M18) | 5,000 | ~300K | 60% | $0 | ₹0 |
| **Free tier ceiling** | **~8,300 MAU** | **~500K** | 100% | $0 | **₹0** |
| Post-ceiling | 10,000 | ~600K | — | $0.20 | ₹18 |
| | 20,000 | ~1.2M | — | $1.40 | ₹127 |
| | 50,000 | ~3M | — | $5.00 | ₹454 |
| | 100,000 | ~6M | — | $11.00 | ₹998 |

**Bottom line:** Redis is effectively free through all of Year 1 and most of Year 2. Even at 10K MAU the cost is ₹18/month — well below the noise floor compared to the Stream.io cliff (₹36K/month).

---

## Data Size

Rate limit keys are sorted sets with short TTLs (1 min – 24 hr). At 100 concurrent users, all live rate limit keys together occupy ~200 KB. At 10,000 concurrent users: ~15–20 MB. The free tier's 256 MB data limit is not the binding constraint — the 500K command ceiling is hit first, and even that is at ~8,300 MAU.

| Concurrent users | Est. live Redis data |
|---|---|
| 100 | ~200 KB |
| 1,000 | ~2 MB |
| 10,000 | ~15–20 MB |
| Free tier limit | 256 MB |

---

## Plan Decision Guide

| Plan | Price | When it makes sense |
|---|---|---|
| **Free** | $0 | Up to ~8,300 MAU. Stay here. |
| **Pay-as-you-go** | $0.20/100K cmds | 8,300–165,000 MAU. Cheapest option beyond free. |
| **Fixed 1 GB** | $20/mo (₹1,814) | Only rational at ~10M cmds/month ≈ 165K MAU, where PAYG also costs ~$20. |
| **Fixed 5 GB** | $100/mo (₹9,070) | ~50M cmds/month ≈ 830K MAU. |

**Stay on Pay-as-you-go until Fixed becomes cheaper.** At current usage patterns, the crossover to Fixed 1 GB happens at ~165K MAU — a scale unlikely to be reached before a Series A.

> **Note on future caching:** If query caching (consultant profiles, availability, search results) is ever added on top of rate limiting, the command budget per user will increase significantly and these projections will need updating. See `docs/roadmap/infrastructure/12-caching-upstash-redis.md`.

---

## Monitoring

Set an alert at **400K commands/month (80% of the free tier)** in the Upstash dashboard to get advance warning before the free tier expires.

| Metric | Where | Alert threshold |
|---|---|---|
| Monthly commands | Upstash Dashboard → Usage | 400K/month |
| Data size | Upstash Dashboard → Usage | 200 MB |
| Daily commands spike | Dashboard → Daily Commands chart | >20K/day (sudden traffic or abuse) |

---

## Related Documents

- [`docs/finances/06-saas-expenditures.md`](../../finances/06-saas-expenditures.md) — Full SaaS cost breakdown by growth stage
- [`docs/upstash/redis/locking/00_README.md`](./locking/00_README.md) — Distributed locking implementation (the other Redis use case)
- [`docs/roadmap/infrastructure/12-caching-upstash-redis.md`](../../roadmap/infrastructure/12-caching-upstash-redis.md) — Future query caching roadmap (different command budget)
