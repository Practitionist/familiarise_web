# Inngest on a ~26 s edge-timeout host: experiment report

Scope: every timeout result below comes from a synthetic 26 s 504 proxy in front of a plain Node server, so it shows how Inngest reacts to a 504 and not how a real host ends an in-flight function. The real-host duplicate-execution tests are in [netlify-inngest-qstash.md](./netlify-inngest-qstash.md) and [netlify-real-qstash.md](./netlify-real-qstash.md), which corroborate it: a 30 s step on real Netlify got a 504 and ran twice.

## Versions

- Node v26.9.0 (no incompatibility seen)
- inngest SDK 4.26.2 (`inngest/node` serve adapter, plain `http` server)
- inngest-cli 1.49.0-28cb5336b (`npx inngest-cli@latest dev -u http://localhost:3001/api/inngest --no-discovery`), local dev server on :8288, no account, no Docker
- Run date 2026-10-31

## Code (all in a scratch directory outside the repository)

- `app.mjs` plain Node server :3000 with all functions, logs every request (REQ> / REQ<) plus step bodies. Run with `INNGEST_DEV=1`.
- `proxy.mjs` :3001 -> :3000. If upstream has not sent headers in 26 s, answers 504 and does NOT abort upstream (logs "upstream finished late ... response discarded").
- `send.mjs <event>` sends one event to the dev server.
- Raw logs: `logs/app.log`, `logs/proxy.log`, `logs/devserver.log`, `logs/side-effects.log`.
- Side note: the 5-second `PUT` requests in app.log are the dev server re-syncing; ignore them.

## SDK setting for claim 4 (found in node_modules/inngest/types.d.ts, `CheckpointingOptions`)

`createFunction({ checkpointing: true | false | { maxRuntime, bufferedSteps, maxInterval } })`.
`maxRuntime`: "maximum amount of time the function should be allowed to checkpoint before falling back to async execution ... recommend a value slightly lower than your platform's request timeout ... `0` disables. Default 10 seconds for serve (HTTP), 5 minutes for connect."
So checkpointing is ON by default and already carries a 10 s per-request cap for HTTP serve.

## A. Three 1 s steps: request count

Run: `lab/A-default` (checkpointing default) and `lab/A-off` (`checkpointing: false`).

```
A-default: ONE request
09:53:09.796 REQ> POST ?fnId=lab-A-default&stepId=step ctx.attempt=0 stack=0 steps=0
  [A-default] step s1 / s2 / s3 body start (09:53:09.8, :10.8, :11.8) ; DONE 09:53:12.8
09:53:12.852 REQ< POST ... status=206 took=3.1s

A-off: FOUR requests
09:53:18.035 REQ> POST ... stack=0 steps=0   -> s1 ; REQ< 206 took=1.0s
09:53:19.095 REQ> POST ... stack=1 steps=1   -> s2 ; REQ< 206 took=1.0s
09:53:20.149 REQ> POST ... stack=2 steps=2   -> s3 ; REQ< 206 took=1.0s
09:53:21.190 REQ> POST ... stack=3 steps=3   -> DONE ; REQ< 200 took=0.0s
```

Verdict: default checkpointing = 1 request for 3 steps; disabled = one request per step plus a final one (N+1). Claim 1 confirmed: Inngest POSTs to our endpoint.

## B. One 40 s step with a side effect

Function appends a line to `logs/side-effects.log` then sleeps 40 s, `retries: 2`. Two variants.

B-default (checkpointing on):

```
app   09:53:33.342 [B] long step start attempt=0        (side-effect line written once)
proxy 09:53:59.339 PROXY 504 (no headers in 26s)
devsv 09:53:59.348 ERROR error handling queue item "invalid status code: 504"
app   09:54:13.344 [B] long step end (40s elapsed)  ; REQ< 206 took=40.0s
proxy 09:54:13.355 PROXY upstream finished late after 40.0s status=206 (response discarded)
app   09:54:40.097 REQ> POST ... ctx.attempt=1 stack=1 steps=1   -> "[B] DONE" (step NOT re-run)
side-effects.log: 1 line (attempt=0)
```

Likely reason, not measured: in checkpoint mode the SDK may report the step result to Inngest on a side channel that bypasses the proxy. The test server is a plain Node `http` server, not a Lambda runtime. The late result still arrived, so the retry (attempt 1, ~41 s after the 504) found the step memoized and the side effect ran once.

B-off (`checkpointing: false`, the response body is the only carrier of the result):

```
09:57:31.847 attempt=0 start (side effect)   proxy 504 at 09:57:57.840   app finishes 09:58:11.8 (response discarded)
09:58:28.857 attempt=1 start (side effect)   proxy 504 at 09:58:54.857   (retry 31 s after the 504)
09:59:54.059 attempt=2 start (side effect)   proxy 504 at 10:00:20.055   (retry 60 s after the 504)
devsv 10:00:20.299 received event inngest/function.failed
side-effects.log:
09:57:31.847Z B-40s-off side-effect attempt=0
09:58:28.862Z B-40s-off side-effect attempt=1
09:59:54.063Z B-40s-off side-effect attempt=2
```

Verdict: the proxy returned 504 at 26 s, Inngest treated it as a failed request (`invalid status code: 504`), retried with growing backoff (about 31 s then 60 s), and with retries:2 the function ended `function.failed`. The 40 s step body ran to completion every time on the "timed out" request (the host keeps running), so the side effect was written 3 times. With checkpointing on, the result can still survive via the side channel, but that is not guaranteed (see C-nolimit).

## C. Ten 5 s steps (50 s)

C-default (default checkpointing, so maxRuntime 10 s):

```
10:01:11.899 REQ> stack=0 ... t1,t2 ... REQ< 206 took=10.1s
10:01:22.087 REQ> stack=2 ... t3 ... REQ< 206 took=5.0s
10:01:27.193 REQ> stack=3 ... t4,t5 ... took=10.0s
10:01:37.238 REQ> stack=5 ... t6 ... took=5.0s
10:01:42.361 REQ> stack=6 ... t7,t8 ... took=10.0s
10:01:52.543 REQ> stack=8 ... t9 ... took=5.0s
10:01:57.643 REQ> stack=9 ... t10, DONE ... took=5.0s
```

No 504, completes, 7 requests, each <= 10 s. (Steps are not interrupted mid-run; the cap is checked between steps.)

C-limit20 (`checkpointing: { maxRuntime: "20s" }`): 5 requests, longest 20.1s, completed. Splitting works. Note a step that starts at 19.9 s still runs to its end, so set maxRuntime below (host limit minus the longest step).

```
10:02:29.892 REQ> stack=0 t1-t4 REQ< took=20.0s
10:02:49.991 REQ> stack=4 t5 took=5.0s
10:02:55.087 REQ> stack=5 t6-t9 took=20.1s
10:03:15.187 REQ> stack=9 t10 took=5.0s
10:03:20.288 REQ> stack=10 DONE took=0.0s
```

C-nolimit (`maxRuntime: 0`, the proxy 504s at 26 s):

```
10:03:39.648 REQ> stack=0, t1..t10 run in ONE request
proxy 10:04:05.659 PROXY 504 (no headers in 26s)          <- after t5/t6 started
devsv 10:04:05.735 ERROR "invalid status code: 504"
app   10:04:24.959 REQ> ctx.attempt=1 stack=9 steps=9  [C-nolimit] step t10 start   (retry ~19 s later; t1-t9 memoized via side channel)
app   10:04:24.884 [C-nolimit] step t10 start  (the ORIGINAL request also ran t10, so t10 ran twice, concurrently)
proxy 10:04:29.899 upstream finished late after 50.3s status=206 (response discarded)
```

Verdict: with no cap, the 26 s edge 504 fails the request even though the Lambda ran all 50 s; Inngest retried and step t10 executed twice. Default (10 s) and 20 s settings avoid the 504 entirely.

## D. step.sleep("10s")

```
10:06:14.613 REQ> POST ...lab-D-sleep stack=0   [D] before   REQ< 206 took=0.0s
   (no request open for 10 s)
10:06:24.644 REQ> POST ... stack=2 steps=2       [D] after    REQ< 206 took=0.0s
```

Verdict: the sleep is held by Inngest; the app saw two separate sub-millisecond requests 10.0 s apart.

## E. Cron every minute

```
09:54:00.036 REQ> POST ?fnId=lab-E-cron&stepId=step ... 09:54:00.046 REQ< 206 took=0.0s
09:55:00.039 ... 09:58:00.047 ... 10:00:00.063 (one request per minute on the minute)
```

Dev server log shows `received event inngest/scheduled.timer` each minute. Verdict: dev server triggers the cron and POSTs to our endpoint.

## Verdict table

| #   | Claim                                                                                                                                              | Result                    | Evidence                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Inngest never runs our code; it POSTs to our serve() endpoint, once per step (non-checkpoint) or several steps per request (checkpointing default) | CONFIRMED                 | A (1 vs 4 requests), D, E                                                                                                                                                                                                                                                                                |
| 2   | A step or batch exceeding the host deadline fails/retries; Inngest does not lift the host limit                                                    | CONFIRMED                 | B-off (504 -> retries -> function.failed), C-nolimit (504 at 26 s). Default `maxRuntime` of 10 s sidesteps it only for sequences of short steps; a single step over 26 s still fails (B)                                                                                                                 |
| 3   | When the host times out but the side effect already happened, retry runs it twice                                                                  | CONFIRMED (with a nuance) | B-off: 3 lines in side-effects.log. C-nolimit: t10 ran twice. B-default (checkpointing on): side effect ran ONCE because the result reached Inngest out-of-band before the retry; so duplicates are not guaranteed with checkpointing, but the host does not stop the work and at-least-once still holds |
| 4   | Checkpointing has a per-request runtime cap that splits long step sequences                                                                        | CONFIRMED                 | `checkpointing.maxRuntime` (default 10 s for serve, `0` disables, also `bufferedSteps`, `maxInterval`); C-default (7 requests), C-limit20 (5 requests), C-nolimit (fails). The cap is checked between steps, not mid-step                                                                                |

## Cleanup

All processes (dev server, app, proxy) killed; `ps` shows 0 matching processes.
