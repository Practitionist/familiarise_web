// Write path 1 of 5 — `POST /api/checkout` for a 1:1 consultation.
//
// Body shape is `checkoutSchema` (schemas/checkout.ts). For CONSULTATION the
// superRefine demands startsAt, endsAt, and exactly one of the two availability
// ids; the whole window must also sit inside the consultant's published
// availability (#1320), so the slot times handed to this script must be times
// the target consultant genuinely publishes.
//
// `isMockPayment` is read off the RAW body by the route, not off the parsed
// schema, and it is honoured only when the target runs with
// NODE_ENV=development. On a Netlify deploy preview — a production build — the
// flag is ignored and the checkout mints a real gateway order. See the runbook.
//
// Standalone:
//   k6 run --env BASE_URL=... --env BUYER_COOKIES=... load-tests/booking/checkout-consultation.js

import { check, sleep } from "k6";
import {
  CONSULTANT_IDS,
  DURATION,
  MOCK_PAYMENT,
  PEAK_VUS,
  PLAN_IDS,
  SLOT_AVAILABILITY_CUSTOM_ID,
  SLOT_AVAILABILITY_WEEKLY_ID,
} from "./lib/config.js";
import { idempotencyKey, json, post, rotate } from "./lib/http.js";
import { checkoutDuration, isAcceptableLoss, record } from "./lib/metrics.js";
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
  return establishSessions();
}

/** One slot start per (VU, iteration) so the mix spreads over the calendar. */
function slotWindow(offset) {
  // Start on tomorrow's hour boundary and walk forward in 30-minute atoms,
  // which is the calendar's unit (ADR B1). A booking window must be an exact
  // multiple of it or the allocator reads a 60-minute row as one 30-minute
  // slot.
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCHours(4, 0, 0, 0); // 09:30 IST — inside a typical seeded workday
  const startsAt = new Date(base.getTime() + offset * 30 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

/**
 * Reusable body builder. `scenarios.js` calls this too, and so does the
 * hot-slot storm, which pins every buyer to one window instead of spreading.
 */
export function consultationBody({ planId, startsAt, endsAt, key }) {
  const body = {
    appointmentType: "CONSULTATION",
    planId,
    startsAt,
    endsAt,
    clientIdempotencyKey: key,
    paymentGateway: "RAZORPAY",
    isMockPayment: MOCK_PAYMENT,
  };
  // Exactly one, or the schema's cross-field check rejects the request.
  if (SLOT_AVAILABILITY_WEEKLY_ID) {
    body.slotOfAvailabilityWeeklyId = SLOT_AVAILABILITY_WEEKLY_ID;
  } else if (SLOT_AVAILABILITY_CUSTOM_ID) {
    body.slotOfAvailabilityCustomId = SLOT_AVAILABILITY_CUSTOM_ID;
  }
  return body;
}

/** The unit of work, exported so scenarios.js can compose it. */
export function runCheckoutConsultation(data, offsetSeed) {
  const offset = offsetSeed === undefined ? __VU * 97 + __ITER : offsetSeed;
  const cookie = pick(data.buyers, __VU + __ITER);
  const planId = rotate(PLAN_IDS, offset);
  if (!planId) {
    throw new Error("PLAN_IDS is required for the consultation checkout path");
  }
  const window = slotWindow(offset);
  const key = idempotencyKey("cco");
  const res = post(
    "/api/checkout",
    consultationBody({ planId, ...window, key }),
    { cookie, tag: "checkout_consultation", key },
  );
  checkoutDuration.add(res.timings.duration, { path: "checkout_consultation" });
  const verdict = record(res);
  check(res, {
    "consultation checkout resolved without a platform timeout": () =>
      verdict !== "timeout",
    "consultation checkout won or lost cleanly": () =>
      verdict === "win" || isAcceptableLoss(verdict),
  });
  return { verdict, res, body: json(res), planId, window };
}

export default function (data) {
  runCheckoutConsultation(data);
  // The checkout limiter is 5 per minute per USER, so a VU that never pauses
  // measures the limiter. One second between attempts keeps a small credential
  // pool under it while still applying pressure through concurrency.
  sleep(1);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(summarize(data), null, 2),
    "load-gate-summary.json": JSON.stringify(summarize(data), null, 2),
  };
}

/** Documented so a reader of CONSULTANT_IDS knows why it exists here. */
export const BROWSE_TARGETS = CONSULTANT_IDS;
