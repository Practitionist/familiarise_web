/**
 * @jest-environment node
 */

/** The operator home counts only succeeded payments and refunds. */

import { getOperatorDashboardStats } from "../../lib/api/operators/stats";

const mockPrisma = {
  payment: {
    count: jest.fn(),
    aggregate: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  refund: { count: jest.fn(), aggregate: jest.fn(), findMany: jest.fn() },
  dispute: { count: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));

describe("getOperatorDashboardStats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.payment.count.mockResolvedValue(0);
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockPrisma.payment.findMany.mockResolvedValue([]);
    mockPrisma.payment.groupBy.mockResolvedValue([]);
    mockPrisma.refund.count.mockResolvedValue(0);
    mockPrisma.refund.aggregate.mockResolvedValue({
      _sum: { amountPaise: 0 },
    });
    mockPrisma.refund.findMany.mockResolvedValue([]);
    mockPrisma.dispute.count.mockResolvedValue(0);
  });

  it("scopes the payments count to SUCCEEDED", async () => {
    await getOperatorDashboardStats();
    expect(mockPrisma.payment.count).toHaveBeenCalledWith({
      where: { paymentStatus: "SUCCEEDED" },
    });
  });

  it("scopes the refund count and sum to SUCCEEDED", async () => {
    await getOperatorDashboardStats();
    expect(mockPrisma.refund.count).toHaveBeenCalledWith({
      where: { status: "SUCCEEDED" },
    });
    expect(mockPrisma.refund.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "SUCCEEDED" } }),
    );
  });
});
