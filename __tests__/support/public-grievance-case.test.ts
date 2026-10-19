/** @jest-environment node */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => null),
}));
jest.mock("../../lib/email", () => ({
  sendContactInquiryEmail: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/rate-limit", () => ({
  getClientIp: () => "127.0.0.1",
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));
jest.mock("../../lib/support/reference", () => ({
  allocateTicketReference: jest.fn(async () => "SUP-000001"),
}));
// The case service pulls the notification outbox in; this suite is about who
// may READ the grievance, not about bells.
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    user: { findFirst: jest.fn(async () => ({ id: "queue-custodian" })) },
    supportCase: {
      create: jest.fn(async () => ({ id: "case" })),
      findUnique: jest.fn(async () => null),
    },
  };
  return {
    __esModule: true,
    default: { ...db, $transaction: jest.fn(async (fn) => fn(db)) },
  };
});

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { getSession } from "../../lib/auth-server";
import { sendContactInquiryEmail } from "../../lib/email";
import { readSupportCaseForViewer } from "../../lib/support/case-service";
import { POST } from "../../app/api/contact/route";

const createCase = prisma.supportCase.create as jest.Mock;
const findCase = prisma.supportCase.findUnique as jest.Mock;

function grievance(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://test/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("records an external complainant explicitly and preserves the public receipt without fabricating a customer author", async () => {
  const response = await POST(
    grievance({
      firstName: "Outside",
      lastName: "Customer",
      email: "outside@example.com",
      subject: "Complaint",
      message: "Please investigate",
      category: "grievance",
    }),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    referenceNumber: "SUP-000001",
  });
  expect(prisma.supportCase.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      externalRequesterEmail: "outside@example.com",
      externalRequesterName: "Outside Customer",
      requesterUserId: "queue-custodian",
      submitterUserId: "queue-custodian",
      messages: {
        create: expect.objectContaining({
          authorUserId: null,
          body: "Please investigate",
          metadata: expect.objectContaining({ origin: "public-grievance" }),
        }),
      },
    }),
  });
  expect(sendContactInquiryEmail).toHaveBeenCalledWith(
    expect.objectContaining({
      email: "outside@example.com",
      referenceNumber: "SUP-000001",
    }),
  );
});

it("keeps a signed-in complainant's own grievance visible to them", async () => {
  // A signed-in filer OWNS the grievance. Marking it as an external request
  // would hide the case from the very person who filed it: the case reader
  // answers null for any non-staff viewer once the external email is set.
  (getSession as jest.Mock).mockResolvedValueOnce({
    user: { id: "filer-1" },
  });

  const response = await POST(
    grievance({
      firstName: "Riya",
      lastName: "Sen",
      email: "riya@example.com",
      subject: "Complaint",
      message: "Please investigate",
      category: "grievance",
    }),
  );
  expect(response.status).toBe(202);

  const created = createCase.mock.calls[0][0].data as Record<string, unknown>;
  // No external-requester fields: the case belongs to the filer, not to the
  // queue custodian.
  expect(created.externalRequesterEmail).toBeUndefined();
  expect(created.externalRequesterName).toBeUndefined();
  expect(created.requesterUserId).toBe("filer-1");
  expect(created.submitterUserId).toBe("filer-1");
  expect(
    (created.messages as { create: { authorUserId: string | null } }).create
      .authorUserId,
  ).toBe("filer-1");

  // And the filer can actually read it back.
  findCase.mockResolvedValueOnce({
    ...created,
    id: "case-1",
    deletedAt: null,
    ownershipScope: "PERSONAL",
    messages: [],
    events: [],
    subjects: [],
  });
  const view = await readSupportCaseForViewer("case-1", {
    userId: "filer-1",
    isStaff: false,
    role: "CONSULTEE",
  });
  expect(view).not.toBeNull();
  expect(view).toMatchObject({ id: "case-1" });
});
