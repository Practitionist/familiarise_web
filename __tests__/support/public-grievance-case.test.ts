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
jest.mock("../../lib/prisma", () => {
  const db = {
    user: { findFirst: jest.fn(async () => ({ id: "queue-custodian" })) },
    supportCase: { create: jest.fn(async () => ({ id: "case" })) },
  };
  return {
    __esModule: true,
    default: { ...db, $transaction: jest.fn(async (fn) => fn(db)) },
  };
});

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { sendContactInquiryEmail } from "../../lib/email";
import { POST } from "../../app/api/contact/route";

it("records an external complainant explicitly and preserves the public receipt without fabricating a customer author", async () => {
  const response = await POST(
    new NextRequest("https://test/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Outside",
        lastName: "Customer",
        email: "outside@example.com",
        subject: "Complaint",
        message: "Please investigate",
        category: "grievance",
      }),
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
