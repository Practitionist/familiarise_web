# Emergency failback to Netlify

This runbook preserves Netlify as a prebuilt fallback when another host becomes active. Netlify remains the current verified host; the multi-host cutover and its recovery-time objective must be demonstrated in a drill. The target is less than 90 seconds for traffic restoration, not a measured guarantee of global DNS propagation, worker completion or webhook delivery.

## Implemented scheduler preference

The current Netlify ticker reads the Upstash REST key ops:active_cron_platform once at the start of each five-minute invocation. The implementation is otherActivePlatform in netlify/functions/cron-tick.mts.

| Read result                                                         | Netlify behavior                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| String netlify                                                      | Dispatch due targets                                        |
| Another string                                                      | Log skipped=true with otherPlatform and dispatch no targets |
| Absent key / credentials, timeout, unreadable reply or HTTP failure | Dispatch due targets (fail open)                            |

The read timeout is one second. There is no CRON_SCHEDULER_ENABLED override in this implementation. This preference changes the next tick's admission without rebuilding; it cannot mute a running worker, revoke a vendor request or guarantee exclusive dispatch during a Redis outage. A key update also does not initiate a tick. Scheduled recovery can wait until the next five-minute slot, and calendar jobs may wait for their next eligible window.

Postgres job leases, domain claims/CAS and external idempotency keys remain necessary during failback. A shared lease prevents overlap for the same job name, but permits sequential re-execution. Do not use simultaneous automatic schedulers as a safety mechanism.

## Readiness before leaving Netlify

1. Keep netlify.toml and the Netlify ticker alongside the new host's configuration. Verify the exact production SHA has a successful, prebuilt standby deployment and the correct environment.
2. Keep custom domains attached to Netlify and verify a valid certificate and intended host routing before cutover. Record certificate expiry and test renewal while traffic is on the primary host. A certificate issued by Cloudflare Origin CA requires Cloudflare proxying; direct public clients must receive a publicly trusted certificate. Do not infer TLS readiness from the default netlify.app domain alone.
3. Establish independent control of traffic routing. Record the actual DNS/proxy configuration, access and propagation behavior. The target RTO requires a measured rehearsal from outside both compute vendors.
4. Verify auth secrets, cookie/domain policy, OAuth redirects, webhook endpoints and vendor credentials on both hosts. Shared state makes continuity possible but does not prove correct configuration.
5. Implement and verify the new host's scheduler adapter, including its own fleet preference read and authenticated worker dispatch. Replace Netlify-specific background destinations for Stream copy/lifecycle work before cutover, with equivalent runtime, lease and completion checks. The current Netlify implementation alone does not establish that another host observes the switch.
6. Size the database budget across live traffic, standby probes and background workers. Netlify retains PG_POOL_MAX=1; a multi-request host uses a bounded shared pool. Preserve direct storage transfers for large binaries and host-scoped trusted IP headers.
7. Configure independent worker-completion/absence monitoring and vendor backlog checks. Record expected normal holds, calendar windows and manual recovery procedures. A dispatcher HTTP 200 does not establish readiness.

## Incident procedure

### 1. Establish standby readiness and contain the old clock

Confirm the standby SHA, certificate, auth, application health and database reachability using read-only checks. Inspect whether the failed primary is still running workers. Disable its automatic trigger through that platform's control plane when reachable; keep the old host's in-flight work visible in execution history.

Read the current scheduler preference using an authenticated Upstash REST GET. Normalize a trailing slash before appending the command path, as described by the [REST API semantics](https://upstash.com/docs/redis/features/restapi#api-semantics). Do not print credentials or place them in a URL. The following commands are operator actions for an authorized incident, not automatic maintenance steps.

```bash
OPS_REDIS_BASE="${UPSTASH_REDIS_REST_URL%/}"
curl --fail-with-body --silent --show-error   "${OPS_REDIS_BASE}/get/ops%3Aactive_cron_platform"   -H "Authorization: Bearer ${UPSTASH_REDIS_REST_TOKEN}"
```

### 2. Select Netlify for subsequent ticks

```bash
OPS_REDIS_BASE="${UPSTASH_REDIS_REST_URL%/}"
curl --fail-with-body --silent --show-error -X POST   "${OPS_REDIS_BASE}/set/ops%3Aactive_cron_platform/netlify"   -H "Authorization: Bearer ${UPSTASH_REDIS_REST_TOKEN}"
```

Require an OK response and read back the key. Then inspect Netlify tick logs for the expected selection and target results. A failed write or read is an ambiguous handoff; because Netlify fails open, it may already be dispatching. Do not infer that the old host stopped.

### 3. Restore traffic through the prepared route

Use the rehearsed DNS/proxy origin change to the prebuilt Netlify production and staging deployments. Verify public TLS, the custom host, auth/session continuity and webhook reachability. Keep maintenance admission appropriate to the incident. Changing DNS does not stop a platform-native scheduled function.

### 4. Verify recovery effects

Inspect failed, held, lockHeld and completed worker results. Repeated 409s require identifying the owner and its lease/runtime; do not delete a live lease just to make a retry run. Wait for the applicable claim expiry or use an explicitly reviewed recovery path.

If webhook recovery is required, an authorized operator can invoke the canonical bounded door:

```bash
curl --fail-with-body --silent --show-error -X POST   "https://familiarisenow.com/api/cleanup/sweep-stuck-webhook-events?limit=50"   -H "Authorization: Bearer ${CRON_SECRET}"
```

Verify eventual domain effects and execution history, not only the response status. Check captures/bookings, refunds owed, outbox delivery and calendar jobs that may have missed a window. Avoid unbounded manual fleet runs during an outage.

Record observed traffic RTO, worker recovery time, missing capabilities and any ambiguous vendor outcomes. Reconcile before restoring the former primary clock.

## Sources and boundaries

The fleet behavior above is checked against `otherActivePlatform` in the current Netlify ticker; revalidate it when changing the adapter. The [deployment guide](README.md) describes portability requirements; [Netlify schedules](https://docs.netlify.com/build/functions/scheduled-functions/) and [function limits](https://docs.netlify.com/build/functions/configuration/) describe the scheduler/runtime boundaries. Redis preference, job lease and traffic routing are separate controls.

## Deprecated & Superseded Approaches

**Sub-millisecond failover claims.** A REST key update is not a measured failback time. The ticker reads once per invocation with a one-second timeout; it does not cancel existing work or start the next tick. Less than 90 seconds remains a traffic restoration objective requiring a drill.

**An unimplemented switch or a static cron override.** The Redis preference exists. The earlier description of a 250 ms read, a CRON_SCHEDULER_ENABLED override and a muted response was incorrect for the checked implementation; it logs skipped and otherPlatform instead.

**Removing the standby configuration or relying only on rebuilt environment variables.** Both require deployment work during the incident. Preserve a tested standby artifact, current TLS and the runtime fleet preference before leaving Netlify.
