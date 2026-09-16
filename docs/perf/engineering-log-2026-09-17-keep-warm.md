---
title: Engineering log — 2026-09-17 — parallel keep-warm on the ticker
band: perf
audience: sde3
status: live
last-reviewed: 2026-09-17
---

# Engineering log — 2026-09-17 — parallel keep-warm on the ticker

Netlify's answer to ticket #1112198 (recorded in `.claude/skills/deployment/netlify/platform-limits.md`) closed the question the isolation probe had opened: the ~28 s stall on new instances is theirs, no plan offers provisioned concurrency, and the only mitigation on the platform is to keep several instances warm at once, because one warm instance serves one request. The five-minute ticker (`netlify/functions/cron-tick.mts`) now fires `KEEP_WARM_CONCURRENCY` (default 5) unique-key requests at `/api/perf/probe-bare` on every tick, in parallel with the due targets, each awaited for at most four seconds; the request reaching the edge is what creates or retains the instance, so the answer is irrelevant and the tick stays under its 30-second cap. Setting the variable to `0` disables it. The pin in `__tests__/maintenance/cron-tick-targets.test.ts` covers the concurrency parsing and the unique-key URLs. The cost is roughly 1,440 invocations a day against the plan's 125,000 a month. This protects the first handful of simultaneous users, not a launch-day spike; the hosting decision in ADR 32 is unchanged and the Vercel burst measurement is the next input.
