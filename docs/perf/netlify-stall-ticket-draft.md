# Netlify Pro support ticket — FINAL, ready to paste (prepared 2026-09-13)

Paste everything from the Subject line to the end of the Impact section into the Netlify support form as the account owner; the ticket needs the owner's session. Record the ticket number on #1124 once filed.

> Subject: Next.js server handler (`___netlify-server-handler`): brand-new instances block their event loop ~24s on first invocation when created concurrently — is this expected scale-out behavior?
>
> Site: familiarise.netlify.app (site id `1a1ad7d0-fda0-4efe-9d58-aa0ce0fd6d5c`)
> Plan: Pro · Region: `ap-southeast-1` (`sin`) functions · Adapter: `@netlify/plugin-nextjs@5.15.13` (runtime API v2, single consolidated SSR+ISR function) · Next.js 15.5.15, Node 22

## Summary

Since at least July 2026 we have measured a reproducible, bimodal latency pathology on the Next.js server handler. A function instance created **in isolation** boots and serves a real database-backed page end-to-end in **~1.9s**. Instances created **under concurrent load** each stall for roughly **24 seconds with a blocked event loop before executing any application code**, then serve normally. There is nothing between the two modes: across ~90 instrumented cold renders we observed zero samples between ~6s and ~31s.

## Evidence

**1. Bimodality correlates exactly with instance creation count.**
Four batches against one deploy preview, client-side TTFB via curl, correlated with function logs and an in-app diagnostic route that reports per-instance id + `process.uptime()` + event-loop-lag probe:

| Batch | Concurrency         | Instance state   | Samples | Result                                 |
| ----- | ------------------- | ---------------- | ------- | -------------------------------------- |
| A     | strictly sequential | new each time    | 8       | 1.80–2.72s, no outliers                |
| B     | 12 concurrent       | ~6 pre-existing  | 12      | six at 1.9–4.7s, six at 31.0–33.1s     |
| C     | 16 concurrent       | ~12 pre-existing | 16      | twelve at 2.6–2.9s, four at 30.8–33.1s |
| D     | 12 concurrent       | all warm         | 12      | 3.3–5.9s, zero slow                    |

Slow-count equals newly-created-instance-count in every batch. The diagnostic route confirmed every stalled sample ran on an instance aged <100ms serving invocation #1.

**2. The stall is an event-loop block BEFORE any application work.**
On stalled first invocations, a diagnostic route that awaits 400ms of idle _before_ touching the database reported the idle phase taking **23.9–24.8s**, max loop lag 23.7–24.7s, while instance age was <100ms. The subsequent DB query connected in ~0.9–1.0s. On warm instances the same probe shows 400–453ms / lag 1–70ms. Downstream effects: `pg` connect timers are plain `setTimeout`s, so they fire only after the stall ends (~26s), which initially misdiagnosed this as a database problem.

**3. Memory/CPU scaling does not touch it.**
We configured the v2 handler correctly by name (`___netlify-server-handler`; verified via `searchSiteFunctions`, field `m`) at **2048 MB** — i.e. doubled vCPU, since your docs state memory and vCPU scale together. Result under the identical 12-way burst protocol:

| Config                | Deploy id (ready UTC 2026-08-22)                  | commit_ref          | searchSiteFunctions `m` | Result                                             |
| --------------------- | ------------------------------------------------- | ------------------- | ----------------------- | -------------------------------------------------- |
| control 1024 MB       | `6a894a2398d6…` (07:05) / `6a895a3f4651…` (08:13) | 74f58138 / 08b10ce4 | 1024                    | 11/12 slow, TTFB 27.8–31.0s                        |
| **treatment 2048 MB** | **`6a8954981e6f…` (07:49)**                       | **17228d7e**        | **2048**                | **11/12 slow, TTFB 35.9–37.6s + one platform 500** |
| post-revert re-run    | `6a8974a11d65…` (10:06)                           | 0646d8f5            | 1024                    | 12/12 slow, TTFB 32.6–38.0s                        |

(An intermediate burst on `6a895c2e7d70…`/58fb03fc at 08:22 came back 16/16 fast — an anomaly attributable to residual warm capacity from three deploys and two concurrent agent sessions within nine minutes, not to the memory setting; recorded for completeness.)

No improvement (possibly worse). We reverted.

**4. Not our bundle's init work.** Sequential brand-new instances complete module loading + init + a full SSR render in <2s total, so first-invocation application work cannot account for 24s; and if the stall were proportional to per-instance init CPU, doubling CPU should have moved it. Confirmed again on 2026-08-23: a build carrying lazy-initialized payment SDK clients (#1221, deploy-preview-1221, commit 353cef1e) still stalled **12/12 at 29.5–31.5s** after ≥30 min idle, while its sequential profile was normal (first-ever request 5.84s settling to ~0.26s warm).

**5. Observability gap:** this function emits no `Init Duration:` log line (only `Duration:`/`Memory Usage:`), so cold starts can't be discriminated from logs; we had to build an in-app instance-age probe. A forum report from May 2025 describes the same absence.

**6. Unchanged on the current runtime, and now inconsistent with the documented limit.** The ten cold invocations after our 2026-09-12 14:28 UTC production publish (deploy `6aa55feffc312e0008f33d62`, `@netlify/plugin-nextjs@5.15.13`, `nodejs22.x`, region `sin`) reported `Duration` 28.0–32.3 s and `Memory Usage` 892–1012 MB, against p50 219 ms and 116 MB warm. Your functions configuration page now lists the synchronous execution limit as 60 seconds and not configurable; the bare platform 500s we recorded at ~39 s (item 3) were therefore returned under the documented limit, which we would like explained separately. We also observe the edge returning a 504 at roughly 26 seconds to responses that have not started streaming, while the function runs to completion and its database write lands; that timeout's value and configurability are not documented anywhere we can find. On 2026-09-13 a burst of only three concurrent unique-key requests to `https://familiarisenow.com/explore/experts` on the published production deploy reproduced the pattern again: two at 1.06–1.14 s TTFB, one at 30.35 s.

## Questions

1. Is concurrent instance-creation contention (e.g., simultaneous sandbox provisioning, deployment-artifact fetch, or shared-host CPU scheduling during burst scale-out) a known cause of multi-second stalls on runtime-API-v2 handlers? Is there a known incident or fix in flight since mid-2026?
2. Does Netlify have, or plan, anything equivalent to provisioned concurrency / minimum instances for framework-generated functions like `___netlify-server-handler`? Scheduled keep-warm pings keep at most one instance warm and cannot protect bursts.
3. Why does the server handler not emit AWS-style `Init Duration` in its logs, and are there plans to expose it? It makes cold-start SLO work impractical.
4. Any guidance on reducing burst-time instance-creation latency from within the deployment (bundle shape, esbuild vs default bundling, region placement), given memory/vcpu scaling showed no effect?
5. What is the edge's inactivity timeout for a response that has not started streaming (we observe ~26 s), is it configurable on Pro, and why did invocations at ~39 s receive platform 500s when the documented synchronous limit is 60 s?
6. Are Background Functions expected to execute on Deploy Previews and branch deploys? On this site (`background_functions: true` on the account), a POST to a `-background` function on a Deploy Preview or a branch deploy answers 202 in about one second and then nothing runs: the function log shows exactly one `info` record with an empty message per kick, no console output, and no `Duration` report line, and the function's side effects never happen. This reproduces with a function whose only statement is a `console.log`, in both declaration forms (`-background` suffix and `config = { background: true }`), on deploys `6aa6bed52185aa0008a728af` (Deploy Preview) and `6aa6dc1e9831c30008de6c6e` (branch deploy), while the same deploys run synchronous and scheduled functions normally. The documentation states this restriction for scheduled functions only.

## Impact

User-visible: landing-page/explore clicks stall 20–30s then render (the "site is down" perception), worst right after deploys and during traffic bursts from a cold pool. We ship ISR-first architecture and deploy-warming workflows, but the tail persists whenever concurrency forces new instances.

## Additions from the 2026-09-15 research pass (fold into the ticket before sending)

Three facts pre-empt the three most likely first responses. First, the pattern is not a preview artifact: it reproduced on the published production deployment on 2026-09-13 with only three concurrent requests. Second, more memory is not the answer and has been measured: at 2048 MB the same twelve-request burst landed 11 of 12 at 35.9–37.6 s plus one platform 500, against 11 of 12 at 27.8–31.0 s at 1024 MB, so the setting was reverted. Third, there is no native Prisma engine to blame: the deployed client is the WASM query compiler with the `pg` driver adapter (`query_compiler_fast_bg.wasm`, no `.node` binary). The framing should be a report of an apparently undocumented pattern backed by isolation evidence — the sequential-versus-concurrent contrast (1.8–2.7 s alone, 27–39 s under concurrent creation, from the same deploy) is what proves these are real new-instance events — rather than a request to fix a known issue. The isolation probe's numbers (`docs/perf/2026-09-15-cold-start-isolation-results.md`) go in as the fourth fact once they exist.
