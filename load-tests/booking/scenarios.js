// The composed load gate — chaos scenarios 6, 14c and 17.
//
// These three are the ones the chaos runbook lists as never having been run
// (docs/enterprise/50-operations/07-chaos-test-runbook.md), and together they
// are the exit gate for #837 and #1169 tracked on #874.
//
//   6    Load ramp to twice the expected peak, with a realistic mix. The four
//        gauges the runbook names are Netlify function duration against the
//        125-concurrent-invocation ceiling, pooler connection count, Redis lock
//        retries, and — the launch metric — the serializable-retry exhaustion
//        rate. This harness measures the first and the last directly; the
//        middle two are read off Supabase and Upstash while the run is live.
//
//   14c  Enterprise allocation races: N org admins auto-allocating against the
//        same consultant pool at once. The CAS guards shipped with #825/#826
//        and are exercised at the service level, but never at the API level.
//
//   17   Flash-sale storm: M buyers on ONE consultant-minute, and M buyers on a
//        nearly-full event. The invariants are exactly one confirmed
//        consultation slot, never more confirmations than the event has seats,
//        zero raw 502/504, and every non-winner receiving an honest 4xx.
//
// Run:
//   k6 run --env SCENARIO=17 --env BASE_URL=... load-tests/booking/scenarios.js
//
// Read docs/enterprise/50-operations/08-load-gate-runbook.md first. The target
// shares the production database.

import { check, sleep } from "k6";
import {
  ALLOCATE_EVENT_IDS,
  BROWSE_RPM,
  CONSULTANT_IDS,
  DURATION,
  EVENT_CAPACITY,
  EVENT_ID,
  EVENT_PLAN_ID,
  HOT_EVENT_BUYERS,
  HOT_PLAN_ID,
  HOT_SLOT_BUYERS,
  HOT_SLOT_ENDS_AT,
  HOT_SLOT_STARTS_AT,
  ORG_ADMIN_RACERS,
  PEAK_VUS,
  PLAN_IDS,
  SCENARIO,
  SEARCH_RPM,
} from "./lib/config.js";
import { get, idempotencyKey, post, rotate } from "./lib/http.js";
import { isAcceptableLoss, readDuration, record } from "./lib/metrics.js";
import { summaryOutputs } from "./lib/report.js";
import { establishSessions, pick } from "./lib/session.js";
import { ALL_THRESHOLDS } from "./lib/thresholds.js";
import { atomAt } from "./lib/window.js";
import {
  consultationBody,
  runCheckoutConsultation,
} from "./checkout-consultation.js";
import { runCheckoutEvent } from "./checkout-event.js";
import { runAllocate } from "./allocate.js";
import { runCancel } from "./cancel.js";
import { runReschedule, runRespond } from "./reschedule.js";

const wants = (name) => SCENARIO === "all" || SCENARIO === name;

/**
 * Chaos 6 asks for twice the expected peak, so PEAK_VUS is the *expected* peak
 * and the ramp doubles it rather than treating it as the ceiling. Getting this
 * backwards is the easiest way to run a gate that proves nothing.
 */
const TWICE_PEAK = PEAK_VUS * 2;

function scenarioSet() {
  const set = {};

  if (wants("6")) {
    // Browse. Its own arrival-rate executor rather than a VU ramp, because the
    // availability limiter is 30 per minute per IP and does not skip localhost:
    // a browse mix that scaled with the VUs would measure Upstash.
    set.ramp_browse = {
      executor: "constant-arrival-rate",
      exec: "browse",
      rate: BROWSE_RPM,
      timeUnit: "1m",
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 40,
      tags: { scenario: "6", path_group: "browse" },
    };
    set.ramp_search = {
      executor: "constant-arrival-rate",
      exec: "search",
      rate: SEARCH_RPM,
      timeUnit: "1m",
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 40,
      tags: { scenario: "6", path_group: "search" },
    };
    // The write mix. This is the part that actually ramps to 2x peak.
    set.ramp_checkout = {
      executor: "ramping-vus",
      exec: "checkoutMix",
      startVUs: 0,
      stages: [
        { duration: "1m", target: PEAK_VUS },
        { duration: DURATION, target: PEAK_VUS },
        { duration: "1m", target: TWICE_PEAK },
        { duration: DURATION, target: TWICE_PEAK },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
      tags: { scenario: "6", path_group: "checkout" },
    };
    // Cancels and reschedules alongside, at a quarter of the write pressure —
    // real traffic is not all creation, and the cancel path is where a lock TTL
    // longer than the function ceiling surfaces.
    set.ramp_mutations = {
      executor: "ramping-vus",
      exec: "mutationMix",
      startVUs: 0,
      stages: [
        { duration: "1m", target: Math.max(1, Math.round(PEAK_VUS / 4)) },
        { duration: DURATION, target: Math.max(1, Math.round(PEAK_VUS / 4)) },
        { duration: "1m", target: Math.max(1, Math.round(TWICE_PEAK / 4)) },
        { duration: DURATION, target: Math.max(1, Math.round(TWICE_PEAK / 4)) },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
      tags: { scenario: "6", path_group: "mutations" },
    };
  }

  if (wants("14c") && ALLOCATE_EVENT_IDS.length > 0) {
    // Every racer targets ALLOCATE_EVENT_IDS[0]: N admins auto-allocating
    // against ONE consultant pool is the race. Spreading them across events
    // would measure throughput instead.
    set.allocation_race = {
      executor: "per-vu-iterations",
      exec: "allocationRace",
      vus: ORG_ADMIN_RACERS,
      iterations: 1,
      maxDuration: "3m",
      startTime: wants("6") ? "30s" : "0s",
      tags: { scenario: "14c", path_group: "allocate" },
    };
  }

  if (wants("17")) {
    if (HOT_PLAN_ID || HOT_SLOT_STARTS_AT) {
      set.hot_slot = {
        executor: "per-vu-iterations",
        exec: "hotSlot",
        vus: HOT_SLOT_BUYERS,
        iterations: 1,
        maxDuration: "3m",
        startTime: wants("6") ? "1m" : "0s",
        tags: { scenario: "17", path_group: "hot_slot" },
      };
    }
    if (EVENT_ID && EVENT_PLAN_ID) {
      set.hot_event = {
        executor: "per-vu-iterations",
        exec: "hotEvent",
        vus: HOT_EVENT_BUYERS,
        iterations: 1,
        maxDuration: "3m",
        startTime: wants("6") ? "1m" : "0s",
        tags: { scenario: "17", path_group: "hot_event" },
      };
    }
  }

  if (Object.keys(set).length === 0) {
    throw new Error(
      `SCENARIO=${SCENARIO} selected no executable scenario — check that the fixtures for it are set (see the runbook).`,
    );
  }
  return set;
}

/**
 * Scenario 17's integrity invariants, encoded as thresholds on tag-scoped
 * sub-metrics so the run's exit code carries the verdict. A `count<=1` on the
 * hot slot IS the double-booking assertion; verify-integrity.js then confirms
 * it from the other side, through the read routes.
 */
const STORM_THRESHOLDS = {
  "booking_winners{path_group:hot_slot}": ["count<=1"],
  "booking_winners{path_group:hot_event}": [`count<=${EVENT_CAPACITY}`],
  "booking_gateway_timeouts_504{path_group:hot_slot}": ["count==0"],
  "booking_gateway_timeouts_504{path_group:hot_event}": ["count==0"],
  "booking_server_errors_5xx{path_group:allocate}": ["count==0"],
};

export const options = {
  scenarios: scenarioSet(),
  thresholds: Object.assign({}, ALL_THRESHOLDS, STORM_THRESHOLDS),
  // Keep the tag in the metric stream so the sub-metric thresholds above
  // resolve; k6 drops unrecognised tags from the summary otherwise.
  systemTags: [
    "status",
    "method",
    "url",
    "name",
    "group",
    "check",
    "error",
    "scenario",
    "expected_response",
  ],
};

export function setup() {
  return establishSessions();
}

// ---------------------------------------------------------------- scenario 6

export function browse() {
  const consultantId = rotate(CONSULTANT_IDS, __VU * 7 + __ITER);
  if (!consultantId) return;
  const date = new Date(atomAt(0).startsAt).toISOString();
  const res = get(
    `/api/slots/availability/${consultantId}?date=${encodeURIComponent(date)}&timeZone=UTC`,
    { tag: "read_availability" },
  );
  readDuration.add(res.timings.duration, { path: "read_availability" });
  const verdict = record(res, { path_group: "browse" });
  check(res, {
    "availability answered": () =>
      verdict === "win" || verdict === "rate_limited",
  });
}

export function search(data) {
  const res = get("/api/user/consultants?limit=20&page=1", {
    cookie: pick(data.buyers, __VU),
    tag: "read_search",
  });
  readDuration.add(res.timings.duration, { path: "read_search" });
  const verdict = record(res, { path_group: "search" });
  check(res, {
    "consultant search answered": () =>
      verdict === "win" || verdict === "rate_limited",
  });
}

export function checkoutMix(data) {
  // Four in five buyers want a 1:1; one in five wants a seat at the event.
  // Events are the capacity-limited path, so they stay the minority in the
  // realistic mix and get their own storm in scenario 17.
  if (EVENT_ID && EVENT_PLAN_ID && (__VU + __ITER) % 5 === 0) {
    runCheckoutEvent(data, { path_group: "checkout" });
  } else {
    runCheckoutConsultation(data, undefined, { path_group: "checkout" });
  }
  // The checkout limiter is 5 per minute per user. Without this pause a VU
  // measures the limiter; with it, pressure comes from concurrency.
  sleep(2);
}

export function mutationMix(data) {
  if ((__VU + __ITER) % 2 === 0) {
    runCancel(data, undefined, { path_group: "mutations" });
  } else {
    const { appointmentId } = runReschedule(data, undefined, {
      path_group: "mutations",
    });
    sleep(1);
    runRespond(data, appointmentId, "decline", { path_group: "mutations" });
  }
  // The event-mutation limiter is 10 per minute per user, twice the checkout
  // allowance, so this loop may cycle twice as fast.
  sleep(3);
}

// -------------------------------------------------------------- scenario 14c

export function allocationRace(data) {
  runAllocate(data, ALLOCATE_EVENT_IDS[0], true, { path_group: "allocate" });
}

// --------------------------------------------------------------- scenario 17

export function hotSlot(data) {
  const cookie = pick(data.buyers, __VU);
  const key = idempotencyKey("hot");
  // Every buyer names the SAME minute. Falling back to atom 0 of the marked
  // window keeps the storm runnable without hand-picking a time, at the cost
  // of booking into whatever that atom is.
  const startsAt = HOT_SLOT_STARTS_AT || atomAt(0).startsAt;
  const endsAt = HOT_SLOT_ENDS_AT || atomAt(0).endsAt;
  const planId = HOT_PLAN_ID || rotate(PLAN_IDS, 0);
  const res = post(
    "/api/checkout",
    consultationBody({ planId, startsAt, endsAt, key }),
    { cookie, tag: "hot_slot", key },
  );
  const verdict = record(res, { path_group: "hot_slot" });
  check(res, {
    // The whole point of the scenario: a loser is entitled to an answer, not a
    // hung request. A 504 here means a lock or its retry budget outlives the
    // function ceiling.
    "hot slot: no platform timeout": () => verdict !== "timeout",
    "hot slot: won or refused with an honest reason": () =>
      verdict === "win" || isAcceptableLoss(verdict),
  });
}

export function hotEvent(data) {
  const result = runCheckoutEvent(data, { path_group: "hot_event" });
  check(result.res, {
    "hot event: no platform timeout": () => result.verdict !== "timeout",
    "hot event: won or was told SOLD OUT / BUSY": () =>
      result.verdict === "win" || isAcceptableLoss(result.verdict),
  });
}

export function handleSummary(data) {
  return summaryOutputs(data);
}
