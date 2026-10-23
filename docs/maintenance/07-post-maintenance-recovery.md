# Post-Maintenance Recovery

Complete these steps after ending maintenance mode. Items are ordered by priority.

## 1. End Maintenance Mode

- [ ] Navigate to: Dashboard > Maintenance
- [ ] Click **"End Maintenance"**
- [ ] Verify:
  - [ ] Phase shows as OFF in the admin panel
  - [ ] Maintenance banner disappears (may take up to 60s due to polling interval)
  - [ ] Maintenance page redirects to home (polls every 30s)

**What happens automatically when you end maintenance**:

- Redis keys updated: `maintenance:phase` = `"OFF"` (and local Node `readMaintenancePhase` cache invalidated)
- Prisma: `MaintenanceWindow` record updated with `endedAt` and `endedBy`
- Stream chat channels unfrozen via `unfreezeChannelsAfterMaintenance()` (`deriveChannelsToUnfreeze()` queries `MeetingSession.endedReason = "maintenance"` within `LIVE_SESSION_WINDOW_MS`)
- BetterStack incident auto-resolved (if one was created)
- Novu "we're back" notification sent

## 2. Verify Core Connectivity

- [ ] **Database**: Hit `/api/health` and confirm `status: "healthy"`

  ```
  curl https://your-domain.com/api/health
  ```

  Expected: `{ "status": "healthy", "maintenance": { "phase": "OFF" } }`

- [ ] **Redis**: Maintenance state should read as OFF
  - This was already verified by ending maintenance, but confirm `/api/health` responds

- [ ] **Auth**: Try logging in/out in an incognito window
  - BetterAuth sessions should work normally

## 3. Check Webhook Deliveries

This is the most critical post-maintenance step for financial integrity.

- [ ] **Razorpay**: Check for failed webhook deliveries
  - Path: Razorpay Dashboard > Webhooks > Recent Deliveries
  - Filter by time range covering the maintenance window
  - **Action**: Resend any failed delivery from the dashboard (the receiver dedupes on the event id), then run the stuck-event sweep; see [webhook recovery](../finance/70-operations/04-webhook-recovery.md)

## 4. Run Critical Reconciliation Jobs

The money recovery order, with each job run as `POST /api/cleanup/<slug>` and the bearer secret (or from the admin system-jobs runner), is in [the maintenance gate and recovery for money](../finance/70-operations/03-maintenance-gate-and-recovery.md#re-driving-money-after-maintenance-ends). It covers stuck webhook events, payment status, orphaned captures and top-ups, earnings, refunds, disputes and payouts.

Two non-money jobs belong in this step as well; run them the same way:

- `reconcile-occurrence-availability` fixes occurrence-availability inconsistencies from interrupted operations. Verify that no double bookings or orphaned tentative flags remain.
- `reconcile-document-storage` syncs document-storage state that drifted during the window. Verify that no orphaned or missing rows are flagged.

## 5. Verify BetterStack

- [ ] **Check `/api/health` for BetterStack status**:

  ```bash
  curl https://familiarisenow.com/api/health
  ```

  Expected response now includes:

  ```json
  {
    "status": "healthy",
    "maintenance": { "phase": "OFF", "reason": null, "estimatedEnd": null },
    "betterstack": {
      "configured": true,
      "reachable": true,
      "monitors": [
        { "name": "https://familiarisenow.com", "status": "up" },
        { "name": "https://familiarisenow.com/api/health", "status": "up" }
      ]
    },
    "timestamp": "..."
  }
  ```

- [ ] **Verify the BetterStack incident was auto-resolved** (OFFLINE mode only):
  - Path: https://uptime.betterstack.com/team/t332379/incidents
  - The incident created when entering OFFLINE should show as "Resolved"
  - Auto-resolution happens via `DELETE /api/admin/maintenance` calling `resolveIncident(betterstackIncidentId)`

- [ ] **Verify the public status page shows "All systems operational"**:
  - Path: https://familiarise.betteruptime.com
  - Resolved incidents are reflected within 1-2 minutes

- [ ] **If the incident was NOT auto-resolved** (the `DELETE` response body shows `betterstackIncidentId: null`):
  - Incident creation failed when maintenance started, or was skipped (DEGRADED mode)
  - Resolve manually: BetterStack dashboard → Incidents → find the incident → click "Resolve"
  - Check server logs for `[BetterStack] Failed to create incident:` during the POST call

## 6. Verify Notifications

- [ ] Check that the "we're back" Novu notification was sent
  - Path: Novu dashboard > Activity feed
  - Look for the maintenance-ended notification

## 7. Monitor for Errors

- [ ] **Monitor application logs** for 30 minutes post-recovery
  - Watch for: database connection errors, Prisma query failures, unexpected 500s
  - Path: Netlify Dashboard > Deployments > Functions > Logs (or your logging provider)

- [ ] **Monitor cron job executions** for the next scheduled cycle
  - Check that the next cron job run completes successfully
  - Money and recovery jobs run on the Netlify ticker: read the `cron-tick` function's JSON line in Netlify Dashboard > Functions > Logs (each target lands in `ok`, `lockHeld` or `failed`) and the tick's Sentry cron check-in
  - Non-money housekeeping jobs run in GitHub Actions: GitHub Actions > Workflows > look for green checks

- [ ] **Check error rates** in your monitoring dashboard
  - Compare error rates to pre-maintenance baseline
  - Elevated errors may indicate schema compatibility issues

## 8. Verify Cron Job Resume

- [ ] Check that jobs resume on their next schedule. The Netlify ticker (`netlify/functions/cron-tick.mts`, every five minutes) is the scheduler for the money and recovery jobs; the schedule of each money job is in [scheduled money jobs](../finance/70-operations/01-scheduled-jobs.md), and a job held during DEGRADED simply runs again on its next slot.
- [ ] Verify `/api/health` reports `cron.stale: false`.

## Recovery Troubleshooting

### Maintenance mode stuck (can't end)

1. Check Redis directly: Is `maintenance:phase` stuck?
2. Try the API directly:
   ```
   curl -X DELETE https://your-domain.com/api/admin/maintenance \
     -H "Cookie: <your-auth-cookie>"
   ```
3. If Redis is unreachable: The fail-open design means the site is already serving traffic. Fix Redis connection separately.

### Webhooks failed and can't be retried

1. Check the `WebhookEvent` table for failed events:
   ```sql
   SELECT * FROM "WebhookEvent"
   WHERE processed = false
   AND "createdAt" > NOW() - INTERVAL '24 hours'
   ORDER BY "createdAt" DESC;
   ```
2. Use the Razorpay dashboard to resend specific events, or run `sweep-stuck-webhook-events` (see [webhook recovery](../finance/70-operations/04-webhook-recovery.md))

### Appointments created with wrong data

1. Run `reconcile-occurrence-availability` to fix slot state
2. Check recently created appointments against payment records
3. Contact affected users if their appointment details are incorrect

### Users still see maintenance page

1. Check that Redis `maintenance:phase` is set to `"OFF"`
2. The maintenance page polls every 30 seconds -- wait for the next poll
3. Users with cached pages may need a hard refresh (Ctrl+Shift+R)
4. Check that the `/api/health` endpoint returns `phase: "OFF"`
