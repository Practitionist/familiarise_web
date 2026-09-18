---
title: Engineering log — 2026-09-17 — keep-warm as its own four-minute function, and six sweeps to fifteen minutes
band: perf
audience: sde3
status: live
last-reviewed: 2026-09-17
---

# Engineering log — 2026-09-17 — keep-warm as its own four-minute function, and six sweeps to fifteen minutes

Netlify's two answers to ticket #1112198 (recorded in `.claude/skills/deployment/netlify/platform-limits.md`) closed the question the isolation probe had opened and corrected the first version of this change. The ~28 s stall on new instances is contention in Netlify's shared regional Lambda pool; no plan offers a warm floor; execution environments are reclaimed after roughly five minutes idle, so a keep-warm that rides the five-minute ticker "races the reclaim window"; and a stall is billed as wall-clock duration, which on this site's own logs made three cold invocations out of fifty-two into 63% of the billed time.

The keep-warm therefore moved out of `cron-tick` into its own scheduled function, `netlify/functions/keep-warm.mts`, at `*/4 * * * *`. It fires `KEEP_WARM_CONCURRENCY` (default 3, Netlify's suggested three to five; `0` disables) unique-key requests at the zero-import probe `/api/perf/probe-bare`, each awaited for at most four seconds, and logs `warmed` and `answered`. Reaching the edge is what retains an instance, so the answer is not needed. The pin in `__tests__/maintenance/keep-warm.test.ts` covers the schedule, the concurrency parsing, and the unique-key URLs.

In the same change six sweeps moved from every tick to the fifteen-minute slots of `TARGET_EVERY_MINUTES` — `reconcile-ledgers`, `sync-payment-earnings`, `release-earnings`, `cascade-refund-earnings`, `reconcile-refunds`, `abandoned-payments` — because each one's GitHub Actions twin already tolerates fifteen minutes or slower, none delays anything a customer watches, and a five-minute tick on twelve parallel targets was a twelve-way cold burst that Netlify bills as duration. The customer-visible five and `sweep-stuck-webhook-events` stay on every tick; the pin in `cron-tick-targets.test.ts` holds both lists. ADR 27's consequences record the change. The invocation arithmetic (about 106,000 a month from the ticker before this change, 125,000 included) and the guards are in issue #1686; after this change the zero-user baseline is roughly 71,000 from the sweeps, 8,600 for the ticker, and 43,000 for the keep-warm and its own invocations — under the allowance, with the stall's GB-hours reduced by keeping the pool warm. Those figures assumed one invocation per tick; the ticker had in fact been re-invoked three times per tick whenever a target answered 500 (see the 2026-09-18 log on ticker retries), and with that fixed the assumption holds.
