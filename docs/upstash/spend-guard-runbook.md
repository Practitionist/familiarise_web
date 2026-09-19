# Upstash spend guard — caps, alerts, and the tripped-cap runbook

> Status: policy decided (dashboard cap + alert). Pricing verified April 2026 in
> `docs/upstash/00-pricing-overview.md`. Update the numbers below when the plan
> or traffic profile changes.

## 1. Why a cap exists

Upstash pay-per-request scales with traffic — including hostile traffic. A scrape
loop against a rate-limited endpoint still _executes_ the limit check (2 cmds),
so spend grows with attack volume even while users stay protected. The cap bounds
the bill; fail-open design (`lib/rate-limit.ts`, maintenance reads) bounds the
blast radius when the cap trips.

## 2. Current posture

| Pattern                                                   | Commands per request              | Failure mode                                                          |
| --------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| Edge rate limits (`middleware.ts` → `@upstash/ratelimit`) | ~2                                | **Fail open** — allowed when Redis errors                             |
| Handler rate limits (`lib/rate-limit.ts`)                 | ~2                                | **Fail open**                                                         |
| Maintenance flag reads                                    | 1–2 (30s in-memory cache at edge) | Fail open (OFF)                                                       |
| Cron/distributed locks (`SET NX EX`)                      | 2–3                               | Lock skipped → single-flight lost, work still runs once via DB guards |
| Content cache-aside (future, #1754)                       | 1–2 + backfill                    | Fail open (origin fetch)                                              |

Rule: **no pattern may fail closed on a Redis error.** Any new Upstash call must
document its failure mode in this table.

## 3. Cap + alert

- Upstash dashboard → Redis database → _Usage alerts_: daily command cap at **2×
  the trailing-30-day peak**, alert (email + webhook) at **1.2× peak**.
- Re-baseline quarterly or after any launch/traffic event.
- Cost breakpoints (April 2026): pay-per-request wins under ~500K cmds/day;
  fixed $10/mo wins 500K–5M/day. Switch plans, don't just raise caps.

## 4. Tripped-cap runbook

1. **Confirm scope.** Upstash dashboard → per-key-prefix volume (`rl:*`,
   `maintenance:*`, `lock:*`, `cron:*`). Identify which pattern spiked.
2. **Attack vs organic.** `rl:*` spike with 429s rising = scrape/abuse (protection
   working, spend is the cost). `maintenance:*`/`lock:*` spike without traffic
   change = code regression (hot loop) — fix the caller, not the cap.
3. **Immediate relief.** Tighten the offending limiter window in
   `lib/rate-limit.ts` (smaller window, lower ceiling for anonymous) and deploy;
   add the abusive prefix to the middleware blocklist if it is a single actor.
4. **Raise, don't remove.** Bump the cap to the new peak × 2, keep the alert.
   Never disable the cap; never switch a pattern to fail-closed to "save"
   commands.
5. **Post-mortem.** Record peak, pattern, cause, and new baseline in the
   decision log (`docs/enterprise/70-design-decisions/`).

## 5. Inspection cheat sheet

```bash
# CLI (upstash) — keyspace and hot keys
upstash redis keys "rl:*" --limit 20
upstash redis ttl "maintenance:phase"
# Usage per pattern is in the dashboard; per-prefix attribution comes from
# our key naming (rl:, maintenance:, lock:, cron:) — keep it namespaced.
```

MCP flows for live inspection are tracked in #1754; this file stays the
human-readable contract until that lands.
