---
title: Cold-start isolation results, 2026-09-15
band: perf
audience: sde3
status: live
last-reviewed: 2026-09-15
---

# Cold-start isolation results, 2026-09-15

This is the experiment issue #1124 designed on 2026-08-22 and never ran, executed on 2026-09-15 against the deploy preview of PR #1656 (`https://deploy-preview-1656--familiarise.netlify.app`, commit `a90b46394`, functions in `sin` at 1024 MB). Two additive Route Handlers share one probe (`app/api/perf/_probe.ts`): `probe-bare` imports nothing from the application, and `probe-full` imports Sentry, `@/lib/auth-helpers`, `@/lib/observability/report`, and `@/lib/prisma` at module scope without calling them. Each answers with `process.uptime()` at handler entry, the age of its own module, and the largest gap an idle 50 ms timer loop observed. The question was whether a brand-new instance stalls when it has evaluated none of this application's code.

## Protocol

Four twelve-request bursts with unique cache-busting keys (`scripts/perf/burst-ttfb.sh`'s protocol, run with the response bodies captured): A on the bare route against the fresh deploy, then B on the full route, C on the bare route, and D on the full route, separated by fifteen-minute idle gaps so that each burst would create new instances. Raw rows, including every `x-nf-request-id`, are in the session's `temp/probe-results-1656.txt`; the tables below carry the columns that matter. A second measurement campaign driven by a subagent overlapped bursts C and D from the same preview, which weakens the "twelve of twelve slow" severity of those two rounds but cannot affect the per-instance columns: an instance whose uptime at entry is 2.5 s is new, whoever else was sending traffic.

## Results

The bare route, burst A, on the fresh deploy:

| Landed on | Requests | TTFB | Uptime at entry | Module age | Largest idle gap |
| --- | --- | --- | --- | --- | --- |
| a warm instance | 7 | 1.4–2.4 s | 49 s | 33 s | 0–6 ms |
| a half-warm instance | 1 | 7.7 s | 32 s | 15 s | 1 ms |
| **a new instance** | **3** | **30.8–31.3 s** | **2.5–2.6 s** | **35–48 ms** | **26.1–26.4 s** |
| a warm instance, held before dispatch | 1 | 31.8 s | 49 s | 33 s | 0 ms |

The full route, burst B, after fifteen minutes idle:

| Landed on | Requests | TTFB | Uptime at entry | Module age | Largest idle gap |
| --- | --- | --- | --- | --- | --- |
| a warm instance | 2 | 1.7–7.2 s | 36–41 s | 31–36 s | 0–30 ms |
| **a new instance** | **7** | **30.2–30.9 s** | **4.7–5.0 s** | **40–50 ms** | **22.4–23.3 s** |
| a warm instance, held before dispatch | 2 | 32.0–32.1 s | 30 s | 25 s | 10–29 ms |
| edge timeout (500) | 1 | 36.4 s | — | — | — |

The single request sent to the full route before burst B, after the fifteen-minute gap, answered `500 the edge function timed out` at 37.6 s: one new instance, no burst, stalled past the edge cliff. That sample may have overlapped the parallel campaign and is recorded as one observation, not a rate.

The bare route, burst C, and the full route, burst D, after further idle gaps (both overlapped by the parallel campaign):

| Burst | Slow (> 10 s) | Edge timeouts (500 at ~37.9 s) | New instances observed | Their idle gap | Warm instances held before dispatch |
| --- | --- | --- | --- | --- | --- |
| C, bare | 12 of 12 | 6 | 1 (uptime 2.7 s) | 26.5 s | 5, including one alive for 410 s that took 33.7 s with a 1 ms gap |
| D, full | 12 of 12 | 3 | 1 (uptime 4.9 s) + 1 six-minute-old instance evaluating the route for the first time | 23.3 s and 23.4 s | 6, including one alive for 410 s |

## What the numbers say

The bare route stalls. Three new instances in burst A and one in burst C evaluated a route module that imports nothing from this application in 35–48 ms and then sat idle for 26.1–26.5 s before their timer fired. Nothing of ours was loaded, so nothing of ours was slow; the application is exonerated for the stall itself.

The stall is a window measured from instance start, not work proportional to what was loaded. On every new instance in all four bursts, uptime at handler entry plus the idle gap came to 27.1–29.1 s: the bare route reached its handler at 2.5 s and stalled 26.2 s, the full route reached its handler at 4.9 s and stalled 23.0 s. The application's extra 2.4 s of module evaluation was subtracted from the stall, not added to the response. One exception in burst D is recorded rather than smoothed over: an instance that had been alive for six minutes and evaluated the full route's module for the first time also stalled 23.4 s, so the window is not purely a boot timer; whatever it is, it fires inside the platform on both a new instance and, at least once, on an old one loading a new route chunk.

Warm instances are not spared. In every burst, several requests reached a warm instance whose handler measured a 0–30 ms gap, yet took 30–34 s to answer, and in bursts C and D one of those instances had been alive for 410 s. The time was spent before the handler was invoked: the platform held the request while new instances were being created, even though an idle warm instance existed. This is the second signature #1124 could not separate from the first, and it means a warm-instance pool cannot mitigate a burst on its own.

Under sustained concurrent creation the edge cliff dominates. Bursts C and D produced six and three `500 the edge function timed out` answers at 37.9 s, and the solo full-route request before burst B produced one. A user whose request lands in that window does not see a slow page; they see an error.

## Conclusion, with the caveat it deserves

On this platform, at this account's configuration, a brand-new instance created while other instances are being created stalls for a fixed window of roughly 28 s from its start, before running a single line of the application, and requests routed to warm instances during that creation are held for a similar time. Four bursts and two routes agree; the overlap of a second campaign inflates the severity of the last two rounds but not the per-instance evidence. The hypothesis ranking in `2026-09-15-cold-start-research.md` stands: this is the platform's instance creation under concurrency, and the on-Netlify levers that remain (bundle trimming, engine choices, memory) act on the 2.4 s that was already being subtracted from the window. The decision rule in ADR 31 has its Netlify half; the Vercel branch-deploy measurement in `vercel-experiment-runbook.md` supplies the other, and the Netlify ticket goes out with these tables attached.
