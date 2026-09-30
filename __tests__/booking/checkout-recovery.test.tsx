/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AvailabilityRecovery } from "@/app/checkout/components/AvailabilityRecovery";
import {
  consultationRecoveryHref,
  isAvailabilityRefusal,
} from "@/lib/booking/checkout-recovery";

it("preserves the plan, reopens booking and requests fresh availability without retaining a stale time", () => {
  const url = new URL(
    consultationRecoveryHref("expert", "plan / one"),
    "https://example.test",
  );
  expect(url.pathname).toBe("/explore/experts/expert");
  expect(url.searchParams.get("plan")).toBe("plan / one");
  expect(url.searchParams.get("action")).toBe("book");
  expect(url.searchParams.get("conflict")).toBe("1");
  expect(url.searchParams.has("startsAt")).toBe(false);
});
it("only treats definitive availability refusals as reselection, not transient locks or gateway failures", () => {
  expect(isAvailabilityRefusal({ errorType: "AVAILABILITY_ERROR" })).toBe(true);
  for (const errorType of [
    "CONSULTEE_BOOKING_BUSY",
    "EVENT_CHECKOUT_BUSY",
    "SERIALIZATION_CONFLICT",
    "LOCK_CONTENTION_ERROR",
    "UNKNOWN_ERROR",
  ])
    expect(isAvailabilityRefusal({ errorType })).toBe(false);
});
it("only promises that the card was not charged when the server explicitly says so", () => {
  expect(
    renderToStaticMarkup(
      <AvailabilityRecovery
        href="/explore/experts/expert"
        notCharged={false}
      />,
    ),
  ).not.toContain("Your card has not been charged");
  expect(
    renderToStaticMarkup(
      <AvailabilityRecovery href="/explore/experts/expert" notCharged />,
    ),
  ).toContain("Your card has not been charged");
});
