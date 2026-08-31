/**
 * @jest-environment node
 */

/**
 * #1280 PR 7 — the org tag, and the logout gap next to it.
 *
 * Measured live on 2026-08-30: ZERO of 886 Stream channels carried
 * `organization_id`, in any form, and `dmo-` was 0. The org Messages tab and
 * the `/api/organizations/[orgId]/stream/channels` compliance route both filter
 * on that field, so both returned empty for every organization — a compliance
 * export that reported "no channels" rather than failing.
 *
 * #746 §1 records per-org channel tagging as done. It was not.
 */

import { bookingOrgId } from "../../lib/stream-utils";

describe("bookingOrgId — one resolver for every booking shape", () => {
  it("resolves an event plan's org", () => {
    // Webinars and classes were the gap: the helper only knew about
    // consultation and subscription plans, so the lazy event-channel create
    // path had nothing to ask and tagged nothing.
    expect(bookingOrgId({ webinarPlan: { organizationId: "org-1" } })).toBe(
      "org-1",
    );
    expect(bookingOrgId({ classPlan: { organizationId: "org-2" } })).toBe(
      "org-2",
    );
  });

  it("prefers the PLAN over the appointment, for every booking kind", () => {
    // The precedence is the whole point of having one resolver. A second
    // implementation for events is how the tag came to disagree between the
    // creator, approval and the reconciler in the first place.
    for (const planKey of [
      "consultationPlan",
      "subscriptionPlan",
      "webinarPlan",
      "classPlan",
    ] as const) {
      expect(
        bookingOrgId({
          [planKey]: { organizationId: "from-plan" },
          appointment: { organizationId: "from-appointment" },
        }),
      ).toBe("from-plan");
    }
  });

  it("falls back to the first ORG-TAGGED appointment, not appointments[0]", () => {
    // A class or subscription holds many appointments and is funded once, and
    // the array arrives unordered. Reading `[0]` is what made one path mint
    // `dmo-…` and another `dm-…` for the same relationship.
    expect(
      bookingOrgId({
        classPlan: { organizationId: null },
        appointments: [{ organizationId: null }, { organizationId: "org-3" }],
      }),
    ).toBe("org-3");
  });

  it("returns null for a wholly personal booking", () => {
    // Null must stay null: the create path spreads the field in only when it is
    // set, because a literal `organization_id: null` is a SET on Stream's side
    // and the reconciler's `$exists` filters treat that differently from absent.
    expect(
      bookingOrgId({
        consultationPlan: { organizationId: null },
        appointment: { organizationId: null },
      }),
    ).toBeNull();
  });
});
