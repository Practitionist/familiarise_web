/**
 * @jest-environment node
 */

/**
 * #1675 PR-Y2 — the Get-paid page. Y2-2: each account face and each
 * eligibility reason renders its own CTA/state, the PAN card shows the
 * Section 194-O sentence only while the PAN is missing, and no full account
 * number or PAN ever reaches the DOM; the reverse-penny-drop settle step
 * persists the masked row only (mock-Prisma call-shape assertion). Y2-3: the
 * Home row's predicate.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payoutAccount: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    consultantProfile: { findUniqueOrThrow: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  __esModule: true,
  isRazorpayPayoutsConfigured: jest.fn(() => true),
  getRazorpayPayoutsService: jest.fn(),
}));

import * as React from "react";
import { readFileSync } from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import prisma from "@/lib/prisma";
import { getRazorpayPayoutsService } from "@/lib/payments/payouts/razorpay-payouts";
import { settleReversePennyDrop } from "@/lib/payments/payouts/reverse-penny-drop";
import { payoutRequirements } from "@/lib/payments/payouts/payout-requirements";
import { payoutSetupNeeded } from "@/lib/data/needs-you";
import { deriveConsultantActionItems } from "@/lib/dashboard/action-items";
import { GetPaidView } from "@/app/dashboard/consultant/[consultantId]/(features)/settings/payouts/GetPaidClient";
import type { PayoutSetup } from "@/app/dashboard/consultant/[consultantId]/(features)/settings/payouts/get-paid-api";

const FULL_ACCOUNT = "765432123456789";
const CP = "cp-1";

function account(
  overrides: Partial<PayoutSetup["accounts"][number]> = {},
): PayoutSetup["accounts"][number] {
  return {
    id: "pa-1",
    provider: "RAZORPAY",
    accountType: "BANK_ACCOUNT",
    accountHolderName: "Asha Rao",
    bankName: "HDFC",
    accountNumberLast4: "6789",
    ifscCode: "HDFC0000053",
    upiId: null,
    isVerified: true,
    isDefault: true,
    createdAt: new Date("2026-09-20T00:00:00Z"),
    ...overrides,
  };
}

type SetupOverrides = Omit<Partial<PayoutSetup>, "taxInfo"> & {
  taxInfo?: Partial<PayoutSetup["taxInfo"]>;
};

function setup(overrides: SetupOverrides = {}): PayoutSetup {
  const accounts = overrides.accounts ?? [];
  const taxInfo: PayoutSetup["taxInfo"] = {
    hasTaxInfo: false,
    panMasked: null,
    panVerified: false,
    gstin: null,
    gstinVerified: false,
    country: "IN",
    isIndianResident: true,
    taxEntityType: null,
    msmeStatus: "NONE",
    udyamNumber: null,
    msmeWrittenAgreement: false,
    ...overrides.taxInfo,
  };
  const defaultAccount = accounts.find((a) => a.isDefault) ?? null;
  return {
    accounts,
    requirements: payoutRequirements({
      consultantProfileId: CP,
      taxInfo: taxInfo.panMasked
        ? { panLast4: taxInfo.panMasked.slice(-4), gstin: taxInfo.gstin }
        : null,
      defaultAccount,
      earningsCount: 1,
      isIndianResident: true,
      livePayoutsEnabled: true,
    }),
    eligibilityReason: null,
    readyAmount: 0,
    minimumAmount: 50_000,
    livePayoutsEnabled: true,
    razorpayConfigured: true,
    ...overrides,
    taxInfo,
  };
}

function render(s: PayoutSetup): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GetPaidView consultantId={CP} setup={s} />
    </QueryClientProvider>,
  );
}

describe("Y2-2 Get-paid page faces", () => {
  it("no account → both ways in; PAN missing → the 194-O sentence", () => {
    const html = render(setup({ eligibilityReason: "NO_ACCOUNT" }));
    expect(html).toContain("Show the ₹1 request");
    expect(html).toContain("Add a payout account");
    expect(html).toContain("Add a bank account or UPI ID");
    expect(html).toContain(
      "Without a PAN the law makes us withhold more tax (Section 194-O)",
    );
    expect(html).toContain("Not added");
  });

  it("unverified → penny-drop copy and Check again; verified → masked tail and Change", () => {
    const pending = render(
      setup({
        accounts: [account({ isVerified: false })],
        eligibilityReason: "UNVERIFIED",
      }),
    );
    expect(pending).toContain("Pending verification");
    expect(pending).toContain("Check again");
    expect(pending).toContain("waiting on the ₹1 verification");

    const verified = render(
      setup({
        accounts: [account()],
        taxInfo: { panMasked: "XXXXXX234F", taxEntityType: "INDIVIDUAL" },
        eligibilityReason: "BELOW_MINIMUM",
      }),
    );
    expect(verified).toContain("•••• 6789");
    expect(verified).toContain("Change");
    expect(verified).toContain("PAN XXXXXX234F");
    expect(verified).toContain("Individual");
    expect(verified).not.toContain("Section 194-O");
    expect(verified).toContain("reaches the minimum");
    expect(verified).not.toContain(FULL_ACCOUNT);
  });

  it.each([
    ["LIVE_PAYOUTS_OFF", "Payouts begin at launch"],
    ["NON_INDIA", "Indian bank accounts"],
  ] as const)("%s reads its own line", (reason, copy) => {
    expect(render(setup({ eligibilityReason: reason }))).toContain(copy);
  });
});

describe("Y2-2 reverse penny drop persists a reference-only row", () => {
  it("writes last4 + IFSC + fund-account id and never the full account number", async () => {
    const svc = {
      fetchFundAccountValidation: jest.fn().mockResolvedValue({
        id: "fav_1",
        status: "completed",
        referenceId: CP,
        accountStatus: "valid",
        registeredName: "ASHA RAO",
        nameMatchScore: null,
        failureReason: null,
        bankAccount: {
          accountNumber: FULL_ACCOUNT,
          ifsc: "HDFC0000053",
          bankName: "HDFC",
          accountType: "Savings",
        },
        upiIntent: null,
      }),
      createContact: jest.fn().mockResolvedValue({ id: "cont_1" }),
      createFundAccount: jest.fn().mockResolvedValue({ id: "fa_1" }),
    };
    (getRazorpayPayoutsService as jest.Mock).mockReturnValue(svc);
    // No matching row, then no current default → the new account is default.
    (prisma.payoutAccount.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.$transaction as jest.Mock).mockImplementation(
      (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
    (prisma.consultantProfile.findUniqueOrThrow as jest.Mock).mockResolvedValue(
      { user: { name: "Asha", email: "a@x.in" }, payoutAccounts: [] },
    );
    (prisma.payoutAccount.create as jest.Mock).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "pa-new",
        ...data,
      }),
    );

    const outcome = await settleReversePennyDrop(CP, "fav_1");
    expect(outcome.status).toBe("verified");

    const call = (prisma.payoutAccount.create as jest.Mock).mock.calls[0][0];
    expect(call.data).toMatchObject({
      accountNumberLast4: "6789",
      ifscCode: "HDFC0000053",
      razorpayFundAccId: "fa_1",
      razorpayContactId: "cont_1",
      accountHolderName: "ASHA RAO",
      isVerified: true,
      isDefault: true,
    });
    expect(JSON.stringify(call)).not.toContain(FULL_ACCOUNT);
    // The full number goes to RazorpayX once, to mint the fund account.
    expect(
      svc.createFundAccount.mock.calls[0][0].bankAccount.accountNumber,
    ).toBe(FULL_ACCOUNT);
  });

  it("refuses a validation minted for someone else and stays pending until the rupee lands", async () => {
    const svc = {
      fetchFundAccountValidation: jest
        .fn()
        .mockResolvedValueOnce({
          id: "fav_2",
          status: "created",
          referenceId: "cp-other",
        })
        .mockResolvedValueOnce({
          id: "fav_3",
          status: "created",
          referenceId: CP,
        }),
    };
    (getRazorpayPayoutsService as jest.Mock).mockReturnValue(svc);
    await expect(settleReversePennyDrop(CP, "fav_2")).rejects.toMatchObject({
      code: "RPD_NOT_YOURS",
    });
    await expect(settleReversePennyDrop(CP, "fav_3")).resolves.toEqual({
      status: "pending",
    });
  });
});

describe("Y2-3 Home needs-you row", () => {
  const reqs = (overrides: Partial<Parameters<typeof payoutRequirements>[0]>) =>
    payoutRequirements({
      consultantProfileId: CP,
      taxInfo: null,
      defaultAccount: null,
      earningsCount: 1,
      isIndianResident: true,
      livePayoutsEnabled: false,
      ...overrides,
    });

  it("flag off + no account + one earning → row; flag off + verified account → none; no earnings → none", () => {
    expect(
      payoutSetupNeeded({ requirements: reqs({}), earningsCount: 1 }),
    ).toBe(true);
    expect(
      payoutSetupNeeded({
        requirements: reqs({ defaultAccount: { isVerified: false } }),
        earningsCount: 2,
      }),
    ).toBe(true);
    expect(
      payoutSetupNeeded({
        requirements: reqs({ defaultAccount: { isVerified: true } }),
        earningsCount: 2,
      }),
    ).toBe(false);
    expect(
      payoutSetupNeeded({
        requirements: reqs({ earningsCount: 0 }),
        earningsCount: 0,
      }),
    ).toBe(false);
  });

  it("the row words itself by the flag and links to the settings route", () => {
    const base = {
      pendingApprovals: 0,
      upcomingSessions: [],
      basePath: `/dashboard/consultant/${CP}`,
      payoutSetupNeeded: true,
    };
    const off = deriveConsultantActionItems({
      ...base,
      livePayoutsEnabled: false,
    });
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({
      key: "payout-setup",
      title: "Add your bank account — payouts begin at launch",
      ctaHref: `/dashboard/consultant/${CP}/settings/get-paid`,
    });
    expect(
      deriveConsultantActionItems({ ...base, livePayoutsEnabled: true })[0]
        .title,
    ).toBe("Add your bank account to get paid");
  });
});

describe("Y2-2 the server page imports no client-module function", () => {
  it("page.tsx takes only the default component from GetPaidClient.tsx and its key from a directive-free module", () => {
    const dir = path.join(
      process.cwd(),
      "app/dashboard/consultant/[consultantId]/(features)/settings/payouts",
    );
    // #1785 L-2 — the page moved to the hub's get-paid section; the
    // components stayed under payouts/.
    const page = readFileSync(
      path.join(dir, "..", "get-paid", "page.tsx"),
      "utf8",
    );
    // FAMILIARISE_WEB-5Q: calling a `"use client"` export from the RSC 500s
    // on every load. Only the component may cross that line.
    const fromClient = page.match(
      /import\s*\{([^}]*)\}\s*from\s*"\.\.\/payouts\/GetPaidClient"/,
    );
    expect(fromClient?.[1].trim()).toBe("GetPaidClient");
    expect(page).toContain('from "../payouts/payout-setup-keys"');
    const keys = readFileSync(path.join(dir, "payout-setup-keys.ts"), "utf8");
    expect(keys).not.toMatch(/^"use client"/m);
    expect(keys).not.toMatch(/^import /m);
  });
});
