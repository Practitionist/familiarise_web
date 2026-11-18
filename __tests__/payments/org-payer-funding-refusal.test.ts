/**
 * @jest-environment node
 */

// Invariant: the checkout preview names the refusal checkout itself would give an
// organisation payer (no covering programme, or org billing without GST registration).

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    webinarPlan: { findFirst: jest.fn(async () => ({ price: 50_000 })) },
    billingAccount: { findUnique: jest.fn() },
    programAssignment: { findFirst: jest.fn() },
    organization: { findUnique: jest.fn() },
    membership: { findUnique: jest.fn() },
  },
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({ member: { id: "m_1" } })),
}));
jest.mock("@/lib/payments/billing/overage-preview", () => ({
  previewOverageForBooking: jest.fn(async () => ({
    applicable: false,
    programName: null,
    overageBehavior: null,
    coveredPaise: 0,
    marginalPaise: 0,
    surchargePaise: 0,
    willExceedCap: false,
    willBlock: false,
    chargeTo: null,
    reason: "no org-covered allocation",
  })),
}));
jest.mock("@/lib/pdf/supplier", () => ({
  isPlatformGstRegistered: jest.fn(() => true),
}));
jest.mock("@/lib/compliance/dpdp", () => ({
  checkConsent: jest.fn(async () => true),
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { isPlatformGstRegistered } from "@/lib/pdf/supplier";
import { GET } from "@/app/api/organizations/[orgId]/checkout/overage-preview/route";
import { resolveOrgFunding } from "@/lib/payments/checkout/org-funding";
import { CheckoutPreviewResponseSchema } from "@/schemas/organizations";
import type { CheckoutInput } from "@/schemas/checkout";

const db = jest.mocked(prisma, { shallow: false });

async function preview() {
  const res = await GET(
    new NextRequest(
      "http://localhost/api/organizations/org_1/checkout/overage-preview?planType=WEBINAR&planId=wp_1",
    ),
    { params: Promise.resolve({ orgId: "org_1" }) },
  );
  expect(res.status).toBe(200);
  return CheckoutPreviewResponseSchema.parse(await res.json());
}

beforeEach(() => {
  jest.clearAllMocks();
  db.billingAccount.findUnique.mockResolvedValue({
    fundingSource: "WALLET",
  } as never);
  db.programAssignment.findFirst.mockResolvedValue(null);
  jest.mocked(isPlatformGstRegistered).mockReturnValue(true);
});

describe("checkout preview fundingRefusal", () => {
  it("names the refusal checkout gives a wallet organisation with no programme covering the plan", async () => {
    db.organization.findUnique.mockResolvedValue({
      id: "org_1",
      status: "ACTIVE",
      canSponsor: true,
      billingAccount: {
        id: "ba_1",
        fundingSource: "WALLET",
        creditLimit: null,
        walletBalance: 100_000,
      },
    } as never);
    db.membership.findUnique.mockResolvedValue({
      id: "m_1",
      role: "LEARNER",
      status: "ACTIVE",
    } as never);

    const { fundingRefusal } = await preview();

    const checkout = resolveOrgFunding(
      { organizationId: "org_1" } as CheckoutInput,
      "u_1",
      "WEBINAR",
    );
    await expect(checkout).rejects.toMatchObject({
      code: "PROGRAM_ASSIGNMENT_INACTIVE",
      message: fundingRefusal?.message,
    });
    expect(fundingRefusal?.code).toBe("PROGRAM_ASSIGNMENT_INACTIVE");
    expect(fundingRefusal?.message).toContain("covers WEBINAR");
  });

  it("names the GST refusal when the programme covers the plan but org billing is unavailable", async () => {
    db.programAssignment.findFirst.mockResolvedValue({
      id: "pa_1",
      programId: "p_1",
    } as never);
    jest.mocked(isPlatformGstRegistered).mockReturnValue(false);
    delete process.env.PLATFORM_GSTIN;

    const { fundingRefusal } = await preview();

    expect(fundingRefusal).toEqual({
      code: "GST_REGISTRATION_REQUIRED",
      message:
        "Booking on your organisation's account isn't available yet. You can still pay yourself.",
    });
  });

  it("answers null when a covering programme exists and org billing is available", async () => {
    db.programAssignment.findFirst.mockResolvedValue({
      id: "pa_1",
      programId: "p_1",
    } as never);

    expect((await preview()).fundingRefusal).toBeNull();
  });

  it("answers null for a PERSONAL organisation without reading assignments", async () => {
    db.billingAccount.findUnique.mockResolvedValue({
      fundingSource: "PERSONAL",
    } as never);

    expect((await preview()).fundingRefusal).toBeNull();
    expect(db.programAssignment.findFirst).not.toHaveBeenCalled();
  });
});
