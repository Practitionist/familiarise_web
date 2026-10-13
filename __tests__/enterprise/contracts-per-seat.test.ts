/**
 * @jest-environment node
 *
 * #770 & #1844 — Enterprise Contract Lifecycle:
 * - PER_SEAT & FLAT_FEE validation + BillingSubscription creation on POST /contracts
 * - PER_SEAT & FLAT_FEE license updates on POST /contracts/[contractId]/supersede
 * - PAUSED + ACTIVE live assignment guard on PATCH /contracts/[contractId] (status: TERMINATED)
 */

const mockRequireOrgAccess = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: (...args: unknown[]) => mockRequireOrgAccess(...args),
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

const mockBillingAccountFindUnique = jest.fn();
const mockContractFindMany = jest.fn();
const mockContractFindFirst = jest.fn();
const mockContractCreate = jest.fn();
const mockContractUpdate = jest.fn(
  async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: where.id,
    ...data,
  }),
);
const mockContractUpdateMany = jest.fn();
const mockRateCardFindFirst = jest.fn();
const mockBillingSubscriptionFindUnique = jest.fn();
const mockBillingSubscriptionCreate = jest.fn();
const mockBillingSubscriptionUpdate = jest.fn();
const mockProgramAssignmentCount = jest.fn();
const mockProgramUpdateMany = jest.fn();
const mockPurchaseOrderUpdateMany = jest.fn();
const mockOrgAuditLogCreate = jest.fn();

const mockTx = {
  billingAccount: { findUnique: mockBillingAccountFindUnique },
  contract: {
    findFirst: mockContractFindFirst,
    create: mockContractCreate,
    update: mockContractUpdate,
    updateMany: mockContractUpdateMany,
  },
  rateCard: {
    findFirst: mockRateCardFindFirst,
  },
  billingSubscription: {
    findUnique: mockBillingSubscriptionFindUnique,
    create: mockBillingSubscriptionCreate,
    update: mockBillingSubscriptionUpdate,
  },
  programAssignment: { count: mockProgramAssignmentCount },
  program: { updateMany: mockProgramUpdateMany },
  purchaseOrder: { updateMany: mockPurchaseOrderUpdateMany },
  orgAuditLog: { create: mockOrgAuditLogCreate },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    billingAccount: {
      findUnique: (...args: unknown[]) => mockBillingAccountFindUnique(...args),
    },
    contract: {
      findMany: (...args: unknown[]) => mockContractFindMany(...args),
      findFirst: (...args: unknown[]) => mockContractFindFirst(...args),
    },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

import { NextRequest } from "next/server";
import {
  GET as listContracts,
  POST as createContract,
} from "../../app/api/organizations/[orgId]/contracts/route";
import { PATCH as patchContract } from "../../app/api/organizations/[orgId]/contracts/[contractId]/route";
import { POST as supersedeContract } from "../../app/api/organizations/[orgId]/contracts/[contractId]/supersede/route";

describe("#770 & #1844 — Enterprise Contracts PER_SEAT & Termination Guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireOrgAccess.mockResolvedValue({
      session: { user: { id: "user_owner" } },
      org: { id: "org_1", status: "ACTIVE" },
      member: { id: "mem_owner", role: "OWNER" },
    });
  });

  describe("POST /api/organizations/[orgId]/contracts", () => {
    it("creates a PER_SEAT BillingSubscription when licenseModel=PER_SEAT and licenseRatePerSeatPaise are provided", async () => {
      mockBillingAccountFindUnique.mockResolvedValue({
        id: "ba_1",
        ownerOrgId: "org_1",
        fundingSource: "LICENSE",
      });
      mockContractCreate.mockResolvedValue({
        id: "con_per_seat",
        organizationId: "org_1",
        billingAccountId: "ba_1",
        status: "ACTIVE",
        effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
        effectiveTo: new Date("2027-04-01T00:00:00.000Z"),
        paymentTermsDays: 60,
        autoRenew: true,
      });
      mockBillingSubscriptionCreate.mockResolvedValue({ id: "sub_per_seat" });
      mockOrgAuditLogCreate.mockResolvedValue({ id: "aud_1" });

      const req = new NextRequest(
        "http://localhost/api/organizations/org_1/contracts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            billingAccountId: "ba_1",
            effectiveFrom: "2026-04-01T00:00:00.000Z",
            effectiveTo: "2027-04-01T00:00:00.000Z",
            autoRenew: true,
            status: "ACTIVE",
            licenseModel: "PER_SEAT",
            licenseRatePerSeatPaise: 150000,
            licenseCycle: "MONTHLY",
          }),
        },
      );

      const res = await createContract(req, {
        params: Promise.resolve({ orgId: "org_1" }),
      });
      expect(res.status).toBe(201);

      expect(mockBillingSubscriptionCreate).toHaveBeenCalledTimes(1);
      expect(mockBillingSubscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billingAccountId: "ba_1",
            contractId: "con_per_seat",
            model: "PER_SEAT",
            cycle: "MONTHLY",
            ratePerSeatPaise: BigInt(150000),
            flatFeePaise: null,
            activeSeatCount: 0,
          }),
        }),
      );
    });

    it("rejects PER_SEAT when licenseRatePerSeatPaise is missing or when licenseFeePaise is also passed", async () => {
      const reqMissingRate = new NextRequest(
        "http://localhost/api/organizations/org_1/contracts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            billingAccountId: "ba_1",
            effectiveFrom: "2026-04-01T00:00:00.000Z",
            licenseModel: "PER_SEAT",
            licenseCycle: "ANNUAL",
          }),
        },
      );
      const res1 = await createContract(reqMissingRate, {
        params: Promise.resolve({ orgId: "org_1" }),
      });
      expect(res1.status).toBe(400);

      const reqBothFees = new NextRequest(
        "http://localhost/api/organizations/org_1/contracts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            billingAccountId: "ba_1",
            effectiveFrom: "2026-04-01T00:00:00.000Z",
            licenseModel: "PER_SEAT",
            licenseRatePerSeatPaise: 150000,
            licenseFeePaise: 5000000,
            licenseCycle: "ANNUAL",
          }),
        },
      );
      const res2 = await createContract(reqBothFees, {
        params: Promise.resolve({ orgId: "org_1" }),
      });
      expect(res2.status).toBe(400);

      const reqMissingCycle = new NextRequest(
        "http://localhost/api/organizations/org_1/contracts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            billingAccountId: "ba_1",
            effectiveFrom: "2026-04-01T00:00:00.000Z",
            licenseModel: "PER_SEAT",
            licenseRatePerSeatPaise: 150000,
          }),
        },
      );
      const res3 = await createContract(reqMissingCycle, {
        params: Promise.resolve({ orgId: "org_1" }),
      });
      expect(res3.status).toBe(400);
    });
  });

  describe("GET /api/organizations/[orgId]/contracts", () => {
    it("selects ratePerSeatPaise, activeSeatCount, and supersession fields", async () => {
      mockContractFindMany.mockResolvedValue([
        {
          id: "con_1",
          status: "ACTIVE",
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          effectiveTo: null,
          paymentTermsDays: 60,
          autoRenew: false,
          signedAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          supersededByContractId: null,
          supersededAt: null,
          supersessionReason: null,
          billingAccount: {
            id: "ba_1",
            fundingSource: "LICENSE",
            currency: "INR",
          },
          purchaseOrder: null,
          programs: [],
          subscription: {
            id: "sub_1",
            model: "PER_SEAT",
            cycle: "MONTHLY",
            flatFeePaise: null,
            ratePerSeatPaise: 150000,
            activeSeatCount: 12,
          },
          _count: { programs: 0 },
        },
      ]);

      const req = new NextRequest(
        "http://localhost/api/organizations/org_1/contracts",
      );
      const res = await listContracts(req, {
        params: Promise.resolve({ orgId: "org_1" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data[0].subscription).toEqual({
        id: "sub_1",
        model: "PER_SEAT",
        cycle: "MONTHLY",
        flatFeePaise: null,
        ratePerSeatPaise: 150000,
        activeSeatCount: 12,
      });
    });
  });

  describe("POST /api/organizations/[orgId]/contracts/[contractId]/supersede", () => {
    it("updates subscription to PER_SEAT with ratePerSeatPaise and clears flatFeePaise on supersession", async () => {
      mockContractFindFirst.mockResolvedValue({
        id: "con_old",
        organizationId: "org_1",
        billingAccountId: "ba_1",
        purchaseOrderId: null,
        status: "ACTIVE",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: new Date("2027-01-01T00:00:00.000Z"),
        paymentTermsDays: 60,
        autoRenew: false,
        rateCardId: null,
        supersededByContractId: null,
      });
      mockBillingSubscriptionFindUnique.mockResolvedValue({
        id: "sub_1",
        contractId: "con_old",
        model: "FLAT_FEE",
        cycle: "ANNUAL",
        flatFeePaise: BigInt(5000000),
        ratePerSeatPaise: null,
      });
      mockContractCreate.mockResolvedValue({
        id: "con_new",
        organizationId: "org_1",
        billingAccountId: "ba_1",
        status: "ACTIVE",
        effectiveFrom: new Date("2026-05-01T00:00:00.000Z"),
        effectiveTo: new Date("2027-05-01T00:00:00.000Z"),
        paymentTermsDays: 60,
        autoRenew: true,
      });
      mockContractUpdateMany.mockResolvedValue({ count: 1 });
      mockProgramUpdateMany.mockResolvedValue({ count: 2 });
      mockBillingSubscriptionUpdate.mockResolvedValue({ id: "sub_1" });
      mockOrgAuditLogCreate.mockResolvedValue({ id: "aud_2" });

      const req = new NextRequest(
        "http://localhost/api/organizations/org_1/contracts/con_old/supersede",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "AMENDMENT",
            effectiveFrom: "2026-05-01T00:00:00.000Z",
            effectiveTo: "2027-05-01T00:00:00.000Z",
            autoRenew: true,
            licenseModel: "PER_SEAT",
            licenseRatePerSeatPaise: 200000,
            licenseCycle: "MONTHLY",
          }),
        },
      );

      const res = await supersedeContract(req, {
        params: Promise.resolve({ orgId: "org_1", contractId: "con_old" }),
      });
      expect(res.status).toBe(201);
      expect(mockBillingSubscriptionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub_1" },
          data: expect.objectContaining({
            contractId: "con_new",
            model: "PER_SEAT",
            ratePerSeatPaise: 200000,
            flatFeePaise: null,
            cycle: "MONTHLY",
          }),
        }),
      );
    });

    it("rejects licenseRatePerSeatPaise < 1 on supersession with 400", async () => {
      const req = new NextRequest(
        "http://localhost/api/organizations/org_1/contracts/con_old/supersede",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "AMENDMENT",
            licenseModel: "PER_SEAT",
            licenseRatePerSeatPaise: 0,
            licenseCycle: "MONTHLY",
          }),
        },
      );

      const res = await supersedeContract(req, {
        params: Promise.resolve({ orgId: "org_1", contractId: "con_old" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/organizations/[orgId]/contracts/[contractId] termination guard", () => {
    it("blocks contract termination with 409 when PAUSED program assignments exist", async () => {
      mockContractFindFirst.mockResolvedValue({
        id: "con_1",
        organizationId: "org_1",
        status: "ACTIVE",
        signedAt: new Date("2026-01-01T00:00:00.000Z"),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        paymentTermsDays: 60,
        autoRenew: false,
      });
      // Simulate 1 PAUSED assignment returned by the status: { in: ["ACTIVE", "PAUSED"] } count
      mockProgramAssignmentCount.mockResolvedValue(1);

      const req = new NextRequest(
        "http://localhost/api/organizations/org_1/contracts/con_1",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "TERMINATED" }),
        },
      );

      const res = await patchContract(req, {
        params: Promise.resolve({ orgId: "org_1", contractId: "con_1" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/active assignment/i);
      expect(mockProgramAssignmentCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            program: { contractId: "con_1" },
            status: { in: ["ACTIVE", "PAUSED"] },
          }),
        }),
      );
    });
  });
});
