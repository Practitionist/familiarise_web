// Write path 3 of 5 — auto allocation.
//
//   PATCH /api/bookings/{consultations|subscriptions|webinars|classes}/[id]/allocate
//
// The method is PATCH, not POST. The body is `allocationRequestSchema`
// (schemas/slotAllocation/validationSchemas.ts); `isAuto: true` is the whole
// request in auto mode, and `slots` is required only for manual mode. The
// dedupe credential is the `Idempotency-Key` HEADER here, not a body field —
// the opposite of checkout, which reads `clientIdempotencyKey` from the body.
//
// The route is limited by `eventMutationLimiter` keyed on the caller's user id,
// so scenario 14c's realism depends on having several org-admin credentials:
// N admins racing is a different measurement from one admin retrying N times.
//
// Standalone:
//   k6 run --env BASE_URL=... --env ALLOCATE_EVENT_IDS=... \
//          --env ALLOCATE_EVENT_KIND=consultations load-tests/booking/allocate.js

import { check, sleep } from "k6";
import {
  ALLOCATE_EVENT_IDS,
  ALLOCATE_EVENT_KIND,
  DURATION,
  PEAK_VUS,
} from "./lib/config.js";
import { idempotencyKey, json, patch, rotate } from "./lib/http.js";
import { allocateDuration, isAcceptableLoss, record } from "./lib/metrics.js";
import { establishSessions, pick } from "./lib/session.js";
import { ALL_THRESHOLDS, summarize } from "./lib/thresholds.js";

export const options = {
  stages: [
    { duration: "30s", target: PEAK_VUS },
    { duration: DURATION, target: PEAK_VUS },
    { duration: "30s", target: 0 },
  ],
  thresholds: ALL_THRESHOLDS,
};

export function setup() {
  if (ALLOCATE_EVENT_IDS.length === 0) {
    throw new Error("ALLOCATE_EVENT_IDS is required for the allocate path");
  }
  return establishSessions();
}

/**
 * @param data      setup() output
 * @param eventId   pin every racer to one event (14c) or leave undefined to
 *                  spread across the pool
 * @param useOrgAdmins  drive the call as an org admin rather than a buyer
 */
export function runAllocate(data, eventId, useOrgAdmins) {
  const pool =
    useOrgAdmins && data.orgAdmins && data.orgAdmins.length > 0
      ? data.orgAdmins
      : data.buyers;
  const cookie = pick(pool, __VU + __ITER);
  const target = eventId || rotate(ALLOCATE_EVENT_IDS, __VU * 31 + __ITER);
  const key = idempotencyKey("alc");
  const res = patch(
    `/api/bookings/${ALLOCATE_EVENT_KIND}/${target}/allocate`,
    { isAuto: true },
    { cookie, tag: "allocate", key },
  );
  allocateDuration.add(res.timings.duration, { path: "allocate" });
  const verdict = record(res);
  check(res, {
    "allocate resolved without a platform timeout": () => verdict !== "timeout",
    "allocate allocated or refused cleanly": () =>
      verdict === "win" || isAcceptableLoss(verdict),
  });
  return { verdict, res, body: json(res), eventId: target };
}

export default function (data) {
  runAllocate(data);
  sleep(1);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(summarize(data), null, 2),
    "load-gate-summary.json": JSON.stringify(summarize(data), null, 2),
  };
}
