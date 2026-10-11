/**
 * @jest-environment node
 */

import { PATCH } from "../../app/api/documents/bulk-review/route";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { applyRateLimit } from "@/lib/rate-limit";

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));
jest.mock("../../lib/prisma", () => {
  const txClient = {
    appointmentDocument: {
      updateManyAndReturn: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  return {
    __esModule: true,
    default: {
      ...txClient,
      $transaction: jest.fn((fn: (tx: typeof txClient) => unknown) =>
        fn(txClient),
      ),
    },
  };
});
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  documentReviewLimiter: {},
}));

const mockedGetSession = getSession as jest.Mock;
const mockedApplyRateLimit = applyRateLimit as jest.Mock;
const mockedUpdateManyAndReturn = prisma.appointmentDocument
  .updateManyAndReturn as jest.Mock;
const mockedUpdateMany = prisma.appointmentDocument.updateMany as jest.Mock;

function req(body: unknown) {
  return new Request("http://localhost/api/documents/bulk-review", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as never;
}

function rawReq(text: string) {
  return new Request("http://localhost/api/documents/bulk-review", {
    method: "PATCH",
    body: text,
    headers: { "Content-Type": "application/json" },
  }) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedApplyRateLimit.mockResolvedValue(null);
  mockedGetSession.mockResolvedValue({ user: { id: "consultant-user-1" } });
  mockedUpdateMany.mockResolvedValue({ count: 0 });
  mockedUpdateManyAndReturn.mockResolvedValue([
    {
      id: "d1",
      appointmentId: "apt-1",
      originalName: "draft-1.pdf",
      appointment: {
        organizationId: null,
        consultation: null,
        subscription: null,
      },
    },
    {
      id: "d2",
      appointmentId: "apt-1",
      originalName: "draft-2.pdf",
      appointment: {
        organizationId: null,
        consultation: null,
        subscription: null,
      },
    },
  ]);
});

describe("PATCH /api/documents/bulk-review", () => {
  it("401s without a session and never writes", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await PATCH(
      req({ documentIds: ["d1"], reviewStatus: "APPROVED" }),
    );
    expect(res.status).toBe(401);
    expect(mockedUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it("400s on an invalid review status", async () => {
    const res = await PATCH(
      req({ documentIds: ["d1"], reviewStatus: "NONSENSE" }),
    );
    expect(res.status).toBe(400);
    expect(mockedUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it("400s on an empty document list", async () => {
    const res = await PATCH(req({ documentIds: [], reviewStatus: "APPROVED" }));
    expect(res.status).toBe(400);
    expect(mockedUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it("400s on a malformed JSON body (not 500)", async () => {
    const res = await PATCH(rawReq("{ not valid json"));
    expect(res.status).toBe(400);
    expect(mockedUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it("returns the rate-limit response and skips the write", async () => {
    mockedApplyRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
      }),
    );
    const res = await PATCH(
      req({ documentIds: ["d1"], reviewStatus: "APPROVED" }),
    );
    expect(res.status).toBe(429);
    expect(mockedUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it("updates only non-terminal consultee submissions owned by the consultant and stamps reviewer on status transitions", async () => {
    const res = await PATCH(
      req({
        documentIds: ["d1", "d2"],
        reviewStatus: "APPROVED",
        reviewNotes: "  looks good  ",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { updated: 2, requested: 2 },
    });

    const arg = mockedUpdateManyAndReturn.mock.calls[0][0];
    expect(arg.where.id).toEqual({ in: ["d1", "d2"] });
    expect(arg.where.uploadedByRole).toBe("CONSULTEE");
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.appointment.OR).toHaveLength(2);
    expect(arg.data.reviewStatus).toBe("APPROVED");
    expect(arg.data.reviewedById).toBe("consultant-user-1");
    expect(arg.data.reviewedAt).toBeInstanceOf(Date);
    expect(arg.data.reviewNotes).toBe("looks good");
  });

  it("updates reviewNotes without overwriting reviewedAt when updating rows already in target status", async () => {
    mockedUpdateManyAndReturn.mockResolvedValue([]);
    mockedUpdateMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      req({
        documentIds: ["d1"],
        reviewStatus: "IN_REVIEW",
        reviewNotes: "Updated note only",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { updated: 1, requested: 1 },
    });

    expect(mockedUpdateMany).toHaveBeenCalledTimes(1);
    const sameStatusArg = mockedUpdateMany.mock.calls[0][0];
    expect(sameStatusArg.where.reviewStatus).toBe("IN_REVIEW");
    expect(sameStatusArg.data).toEqual({ reviewNotes: "Updated note only" });
    expect("reviewedAt" in sameStatusArg.data).toBe(false);
    expect("reviewedById" in sameStatusArg.data).toBe(false);
  });

  it("omits reviewNotes when none is provided (does not clear existing notes)", async () => {
    await PATCH(req({ documentIds: ["d1"], reviewStatus: "IN_REVIEW" }));
    const arg = mockedUpdateManyAndReturn.mock.calls[0][0];
    expect("reviewNotes" in arg.data).toBe(false);
  });
});
