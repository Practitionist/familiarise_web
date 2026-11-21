/**
 * @jest-environment node
 */

/** Each operator-home money tile takes its count and value from one aggregate row. */

import { getOperatorDashboardStats } from "../../lib/api/operators/stats";

const mockPrisma = {
  payment: { aggregate: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  refund: { aggregate: jest.fn(), findMany: jest.fn() },
  dispute: { count: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));

const STATUS_ROWS = [
  {
    paymentStatus: "SUCCEEDED",
    _count: { _all: 3 },
    _sum: { amount: BigInt(150000) },
  },
  {
    paymentStatus: "PENDING",
    _count: { _all: 1 },
    _sum: { amount: BigInt(20000) },
  },
];

describe("getOperatorDashboardStats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.payment.groupBy.mockImplementation(
      async (args: { by: string[] }) =>
        args.by[0] === "paymentStatus"
          ? STATUS_ROWS
          : [{ paymentGateway: "RAZORPAY", _count: 4 }],
    );
    mockPrisma.payment.findMany.mockResolvedValue([]);
    mockPrisma.refund.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _sum: { amountPaise: BigInt(30000) },
    });
    mockPrisma.refund.findMany.mockResolvedValue([]);
    mockPrisma.dispute.count.mockResolvedValue(0);
  });

  it("reads the payment tiles from one groupBy per status", async () => {
    const stats = await getOperatorDashboardStats();
    expect(mockPrisma.payment.groupBy).toHaveBeenCalledWith({
      by: ["paymentStatus"],
      where: { paymentStatus: { in: ["SUCCEEDED", "PENDING", "EXPIRED"] } },
      _count: { _all: true },
      _sum: { amount: true },
    });
    expect(mockPrisma.payment.aggregate).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      totalPayments: 3,
      totalPaymentsValue: 150000,
      pendingPayments: 1,
      pendingPaymentsValue: 20000,
      expiredPayments: 0,
    });
  });

  it("reads the refund tile's count and value from one SUCCEEDED aggregate", async () => {
    const stats = await getOperatorDashboardStats();
    expect(mockPrisma.refund.aggregate).toHaveBeenCalledWith({
      where: { status: "SUCCEEDED" },
      _count: { _all: true },
      _sum: { amountPaise: true },
    });
    expect(stats.totalRefunds).toBe(2);
    expect(stats.totalRefundsValue).toBe(30000);
  });
});
