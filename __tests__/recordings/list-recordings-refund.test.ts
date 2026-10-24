/**
 * @jest-environment node
 */

const mockFindMany = jest.fn();
const mockPayments = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recording: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: jest.fn(async () => 2),
    },
    payment: { findMany: (...args: unknown[]) => mockPayments(...args) },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import { listRecordingsScoped } from "../../lib/api/scope/list-recordings";

const row = (id: string, appointmentId: string, appointmentType: string) => ({
  id,
  thumbnailUrl: `https://cdn.example/${id}.jpg`,
  previewClipUrl: `https://cdn.example/${id}.mp4`,
  previewClipDuration: 30,
  meeting: {
    id: `m-${id}`,
    occurrence: {
      appointment: { id: appointmentId, appointmentType, organizationId: null },
    },
  },
});

describe("listRecordingsScoped: refunded 1:1 learner", () => {
  it("strips preview media only where every paid payment was fully refunded", async () => {
    mockFindMany.mockResolvedValue([
      row("refunded", "a-refunded", "CONSULTATION"),
      row("partial", "a-partial", "CONSULTATION"),
    ]);
    mockPayments.mockResolvedValue([
      {
        appointmentId: "a-refunded",
        amount: 50_000,
        refunds: [{ amountPaise: 50_000, status: "SUCCEEDED" }],
      },
      {
        appointmentId: "a-partial",
        amount: 50_000,
        refunds: [{ amountPaise: 10_000, status: "SUCCEEDED" }],
      },
    ]);

    const { items } = await listRecordingsScoped({
      scope: { kind: "personal" },
      userId: "learner-1",
    });

    expect(mockPayments.mock.calls[0][0].where).toMatchObject({
      appointmentId: { in: ["a-refunded", "a-partial"] },
      userId: "learner-1",
      paymentStatus: "SUCCEEDED",
    });
    expect(items[0]).toMatchObject({
      id: "refunded",
      thumbnailUrl: null,
      previewClipUrl: null,
    });
    expect(items[1]).toMatchObject({
      id: "partial",
      thumbnailUrl: "https://cdn.example/partial.jpg",
    });
  });
});
