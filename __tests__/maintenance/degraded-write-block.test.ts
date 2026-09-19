/**
 * @jest-environment node
 */

/**
 * DEGRADED mode lets people read and refuses their writes. Which writes it
 * refuses is decided entirely by `isWriteBlockedInDegraded`, and until this
 * sweep that decision was made by a `startsWith(prefix) && endsWith(suffix)`
 * wildcard, which pinned the match to the END of the path. A pattern therefore
 * blocked only the exact leaf it named: `/api/appointments/<id>/reschedule` was
 * refused while `/reschedule/respond` and `/reschedule/withdraw` — the two
 * routes that actually move a booking — were allowed through.
 *
 * These cases pin the prefix semantics that replaced it, plus the routes the
 * list had never covered at all: slot availability, per-appointment documents,
 * feedback and support, and every org money rail.
 */

import { isWriteBlockedInDegraded } from "../../lib/maintenance-edge";

const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];

const BLOCKED = [
  // Pre-existing coverage, kept as a regression floor.
  "/api/checkout",
  "/api/appointments/appt_1/cancel",
  "/api/bookings/consultations",
  "/api/bookings/booking_1/allocate",
  "/api/trials",
  "/api/payments/disputes",
  "/api/admin/payouts",

  // Prefix semantics: the subtree under a named route is blocked too.
  "/api/appointments/appt_1/reschedule",
  "/api/appointments/appt_1/reschedule/respond",
  "/api/appointments/appt_1/reschedule/withdraw",
  "/api/appointments/appt_1/cancel/preview",
  "/api/appointments/appt_1/documents",
  "/api/appointments/appt_1/documents/doc_1",
  "/api/appointments/appt_1/documents/consultant",
  "/api/appointments/appt_1/feedback",
  "/api/appointments/appt_1/support",

  // Slots: approval-rail bookings and every availability write.
  "/api/scheduling/request-for-approval",
  "/api/scheduling/availability/weekly",
  "/api/scheduling/availability/weekly/avail_1",
  "/api/scheduling/availability/custom",
  "/api/scheduling/availability/custom/avail_1",
  "/api/scheduling/availability/consultant_1",

  // Org money rails, none of which were reachable by the old list.
  "/api/organizations/org_1/billing-account/wallet/top-ups",
  "/api/organizations/org_1/billing-account/wallet/top-ups/topup_1",
  "/api/organizations/org_1/billing-account/invoices",
  "/api/organizations/org_1/billing-account/invoices/inv_1",
  "/api/organizations/org_1/billing-account/invoices/inv_1/pay",
  "/api/organizations/org_1/billing-account/purchase-orders",
  "/api/organizations/org_1/billing-account/purchase-orders/po_1",
  "/api/organizations/org_1/programs",
  "/api/organizations/org_1/programs/prog_1",
  "/api/organizations/org_1/programs/prog_1/assignments",
  "/api/organizations/org_1/programs/prog_1/assignments/asg_1",
  "/api/organizations/org_1/programs/prog_1/auto-enroll",
  "/api/organizations/org_1/contracts",
  "/api/organizations/org_1/contracts/ctr_1/supersede",
  "/api/organizations/org_1/rate-cards",
  "/api/organizations/org_1/rate-cards/card_1",
  "/api/organizations/org_1/payouts",
  "/api/organizations/org_1/payouts/payout_1",
  "/api/organizations/org_1/payout-account",
  "/api/organizations/org_1/members",
  "/api/organizations/org_1/members/mem_1",
  "/api/organizations/org_1/members/bulk-import",
  "/api/organizations/org_1/invitations",
  "/api/organizations/org_1/invitations/inv_1",

  // #1599 — real paths, and the doors the list used to miss.
  "/api/bookings/consultations/0b6f4a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b/allocate",
  "/api/collaborations/collab_1/respond",
  "/api/participants/webinar/web_1",
  "/api/payments/pay_1/recover",
  "/api/recordings/rec_1/purchase",
  "/api/overage/ov_1/order",
  "/api/meetings/mtg_1/join",
  "/api/meetings/mtg_1/end",

  // #1598 P1-W02a — admin money doors: refund front door, TDS marks, unfreeze.
  "/api/admin/refunds",
  "/api/admin/tds",
  "/api/admin/billing-accounts/ba_1/unfreeze",
];

const NOT_BLOCKED = [
  // The org read surfaces stay writable-by-omission: only the money rails and
  // seat changes are on the list, so ordinary org routes must not match.
  "/api/organizations/org_1/appointments",
  "/api/organizations/org_1/settings",
  "/api/organizations/org_1/support-threads",
  // A different prefix that merely starts with a blocked one.
  "/api/scheduling/availability-with-allocation/consultant_1",
  // `/api/scheduling/appointments` was removed from the list: both of its routes
  // are GET-only, so the pattern only ever pretended to guard something.
  "/api/scheduling/appointments",
  "/api/scheduling/appointments/appt_1",
  // The wildcard stands for one non-empty segment, never for nothing.
  "/api/bookings/allocate",
  "/api/appointments/reschedule",
  // Neighbours that share a textual prefix but not a path segment.
  "/api/checkouts",
  "/api/appointments/appt_1/rescheduled",
  // The old entry named a directory that does not exist (#1599 F-P0-02).
  "/api/collaborators",
  // Recording consent is not a money door; only join and end are.
  "/api/meetings/mtg_1/recording-consent",
];

describe("isWriteBlockedInDegraded", () => {
  it.each(BLOCKED)("blocks writes to %s", (pathname) => {
    for (const method of WRITE_METHODS) {
      expect(isWriteBlockedInDegraded(pathname, method)).toBe(true);
    }
  });

  it.each(NOT_BLOCKED)("allows writes to %s", (pathname) => {
    for (const method of WRITE_METHODS) {
      expect(isWriteBlockedInDegraded(pathname, method)).toBe(false);
    }
  });

  it.each(["GET", "HEAD", "OPTIONS", "get", "head", "options"])(
    "never blocks %s, however deep the path",
    (method) => {
      for (const pathname of BLOCKED) {
        expect(isWriteBlockedInDegraded(pathname, method)).toBe(false);
      }
    },
  );

  // #1599 R-P0-02 — GET /api/checkout/verify?sync=true drives the capture
  // pipeline, so DEGRADED must answer it the way it answers the POST doors.
  it("blocks the syncing verify GET and allows the plain one", () => {
    const sync = new URLSearchParams("intent=order_1&sync=true");
    const plain = new URLSearchParams("intent=order_1");
    expect(isWriteBlockedInDegraded("/api/checkout/verify", "GET", sync)).toBe(
      true,
    );
    expect(isWriteBlockedInDegraded("/api/checkout/verify", "GET", plain)).toBe(
      false,
    );
    expect(isWriteBlockedInDegraded("/api/checkout/verify", "GET")).toBe(false);
  });

  it("leaves GET /api/admin/refunds readable (#1598 P1-W02a)", () => {
    expect(isWriteBlockedInDegraded("/api/admin/refunds", "GET")).toBe(false);
  });

  it("leaves a GET on an org appointments route alone", () => {
    // The one case the org additions must not regress: reading an org's
    // bookings is exactly what DEGRADED is supposed to keep working.
    expect(
      isWriteBlockedInDegraded("/api/organizations/org_1/appointments", "GET"),
    ).toBe(false);
  });
});
