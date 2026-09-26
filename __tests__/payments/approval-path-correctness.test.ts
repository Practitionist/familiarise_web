/**
 * #1169 PR 2 — approval-path source contracts.
 *
 * These pin the five behaviors this PR establishes, so a refactor that
 * quietly reintroduces any of them fails loudly:
 * 1. No fabricated appointments: the paid-without-appointment state refuses
 *    (PaidWithoutAppointmentError) instead of inventing a slot at now+1h on
 *    the global client (CORE-3).
 * 2. Approval confirm never re-flips RESCHEDULED slots.
 * 3. No gateway round-trip inside the approval Serializable transaction —
 *    pay-links are minted after commit, with a retry path when minting fails.
 * 4. Approval links mint on RAZORPAY, unified across all three request types
 *    (#1165).
 * 5. Org sponsorship survives the approval flow (#1166 ORG-9): the request
 *    validates and stamps organizationId, and the payment carries it.
 */

import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const consultationsRoute = read(
  "app/api/bookings/consultations/[consultationId]/route.ts",
);
const subscriptionsRoute = read(
  "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
);
// #1775 C-7 — a paid trial mints at request, not on accept.
const trialRequestRoute = read("app/api/trials/route.ts");
const approvalPayment = read("lib/payments/operations/approval-payment.ts");
const requestForApproval = read(
  "app/api/scheduling/request-for-approval/route.ts",
);
const checkout = read("lib/payments/operations/checkout.ts");
// #1775 B-9 — the one post-commit mint every approval writer calls.
const approveRequest = read("lib/booking/approve-request.ts");

describe("CORE-3 — no fabricated appointments on approval", () => {
  it("has removed createAppointmentForConsultation entirely", () => {
    expect(consultationsRoute).not.toContain(
      "async function createAppointmentForConsultation",
    );
    expect(consultationsRoute).not.toContain("addHours(startDate");
  });

  it("refuses the paid-without-appointment state with a typed 409", () => {
    expect(consultationsRoute).toContain("class PaidWithoutAppointmentError");
    expect(consultationsRoute).toContain(
      "throw new PaidWithoutAppointmentError(",
    );
    expect(consultationsRoute).toContain(
      "error instanceof PaidWithoutAppointmentError",
    );
  });
});

describe("approval confirm excludes RESCHEDULED slots", () => {
  it.each([
    ["consultations", consultationsRoute],
    ["subscriptions", subscriptionsRoute],
  ])("%s route filters completionStatus on the confirm flip", (_name, src) => {
    const confirmBlocks = src
      .split("data: { isTentative: false }")
      .slice(0, -1);
    expect(confirmBlocks.length).toBeGreaterThan(0);
    for (const block of confirmBlocks) {
      const tail = block.slice(-400);
      expect(tail).toContain('completionStatus: "SCHEDULED"');
    }
  });
});

describe("no gateway call inside the approval transaction", () => {
  // #1775 C-1 — a plan never mints on approval; only its legacy retry remains.
  it.each([
    ["consultations", consultationsRoute, "generatePaymentLink(", true],
    [
      "subscriptions",
      subscriptionsRoute,
      "generatePaymentLinkForSubscription(",
      false,
    ],
  ] as const)(
    "%s mints AFTER commit with a retry marker",
    (_name, src, mintCall, mintsOnApprove) => {
      // #1775 B-9 — the mint moved into the shared block; the route's own
      // name for it is gone, and the shared call must also sit after the tx.
      expect(src).not.toContain(mintCall);
      const txStart = src.indexOf("prisma.$transaction(");
      const txOptions = src.indexOf(
        "isolationLevel: Prisma.TransactionIsolationLevel.Serializable",
        txStart,
      );
      const inTx = src.slice(txStart, txOptions);
      expect(inTx).not.toContain("mintApprovalPaymentAfterCommit(");
      expect(src.includes("needsPaymentLink: true")).toBe(mintsOnApprove);
      expect(src).toContain("needsLinkRetry");
    },
  );
});

describe("#1165 — approval gateway unified on RAZORPAY", () => {
  it("no approval mint site mints on STRIPE", () => {
    for (const src of [approveRequest, trialRequestRoute]) {
      expect(src).not.toContain("PaymentGateway.STRIPE");
      expect(src).toContain("PaymentGateway.RAZORPAY");
    }
    for (const src of [consultationsRoute, subscriptionsRoute]) {
      expect(src).not.toContain("PaymentGateway.");
      expect(src).toContain("mintApprovalPaymentAfterCommit({");
    }
  });
});

describe("#1166 ORG-9 — org sponsorship survives the approval flow", () => {
  it("the request validates and stamps organizationId", () => {
    expect(requestForApproval).toContain("canSponsor");
    expect(requestForApproval).toContain(
      "organizationId: organizationId ?? null",
    );
  });

  it("the approval payment carries organizationId to the Payment row and metadata", () => {
    expect(approvalPayment).toContain("organizationId?: string");
    expect(approvalPayment).toContain(
      "organizationId: params.organizationId ?? null",
    );
    expect(approvalPayment).toContain(
      "metadata.organizationId = params.organizationId",
    );
  });
});

describe("checkout hardening (#1093 tail + tentative visibility)", () => {
  it("the pre-booking conflict check sees live tentative holds", () => {
    const start = checkout.indexOf(
      "const existingBooking = await tx.appointmentOccurrence.findFirst(",
    );
    expect(start).toBeGreaterThan(-1);
    const query = checkout
      .slice(start, checkout.indexOf("if (existingBooking)", start))
      // Comments in this window explain the removed predicate by name.
      .replace(/^\s*\/\/.*$/gm, "");
    // A confirmed-only predicate here hides an in-flight hold; occupancy
    // status is the whole check.
    expect(query).not.toContain("isTentative");
    expect(query).toContain("OR: buildOccupiedAppointmentFilter()");
  });

  it("the STEP-5 Serializable transaction is retried on P2034", () => {
    const step5 = checkout.indexOf(
      "// STEP 5: Create tentative appointment + payment record",
    );
    // #1435 — the window is measured in characters, so the comment block
    // between the marker and the call decides whether this passes. Strip the
    // comments and assert on the code instead of enlarging it again.
    const window = checkout
      .slice(step5, step5 + 2000)
      .replace(/^\s*\/\/.*$/gm, "");
    expect(window).toContain("withSerializableRetry(");
  });
});

describe("#1775 — the detail PATCH refuses self-approval", () => {
  it.each([
    ["consultations", consultationsRoute, "existingConsultation"],
    ["subscriptions", subscriptionsRoute, "existingSubscription"],
  ])(
    "%s: same user on both sides → 403 SELF_APPROVAL before any transition",
    (_name, src, row) => {
      const patchStart = src.indexOf("export async function PATCH(");
      const guard = src.indexOf('code: "SELF_APPROVAL"', patchStart);
      const tx = src.indexOf("prisma.$transaction(", patchStart);
      expect(guard).toBeGreaterThan(patchStart);
      expect(guard).toBeLessThan(tx);
      const block = src.slice(guard - 600, guard);
      expect(block).toContain("APPROVAL_STATUSES_DETAIL_ONLY.has(status)");
      expect(block).toContain(`${row}.requestedBy.user.id`);
      expect(block).toContain("!isPrivileged(session.user.role)");
      expect(src.slice(guard, guard + 80)).toContain("status: 403");
    },
  );
});

describe("#1775 C-1 — an unpaid plan is never approved", () => {
  const schedulingService = read(
    "utils/scheduling-engine/SchedulingService.ts",
  );

  it("the detail PATCH refuses with SUBSCRIPTION_UNPAID and never parks the plan awaiting payment", () => {
    expect(subscriptionsRoute).toContain('"SUBSCRIPTION_UNPAID"');
    expect(subscriptionsRoute).toContain("...SETTLED_SUBSCRIPTION");
    expect(subscriptionsRoute).not.toContain(
      "to: AppointmentStatus.APPROVED_PENDING_PAYMENT",
    );
  });

  it("the allocate path refuses instead of minting for a subscription", () => {
    const arm = schedulingService
      .split('case "subscription":\n        return this.approveByMoney(')[1]
      .split('case "webinar"')[0];
    expect(arm).toContain('"SUBSCRIPTION_UNPAID"');
    expect(arm).toMatch(/SETTLED_SUBSCRIPTION,\s*async \(\) =>/);
  });
});
