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
jest.mock("../../lib/support/case-service", () => ({
  stageSupportCaseIntakeTx: jest.fn(async () => undefined),
}));
jest.mock("../../lib/support/external-requester", () => ({
  resolvePublicIntakeUserId: jest.fn(
    async () => "system-public-grievance-intake",
  ),
  stageExternalIntakeReceiptTx: jest.fn(async () => null),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    user: {
      findUnique: jest.fn(async () => ({
        id: "member-1",
        email: "member@account.example",
        name: "Account Holder",
      })),
    },
    supportCase: {
      create: jest.fn(async ({ data }) => ({ ...data, id: "case" })),
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
import { stageSupportCaseIntakeTx } from "../../lib/support/case-service";
import { stageExternalIntakeReceiptTx } from "../../lib/support/external-requester";
import { POST } from "../../app/api/contact/route";

const file = (email = "outside@example.com") =>
  POST(
    new NextRequest("https://test/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Outside",
        lastName: "Customer",
        email,
        subject: "Complaint",
        message: "Please investigate",
        category: "grievance",
      }),
    }),
  );

beforeEach(() => jest.clearAllMocks());

it("holds an anonymous grievance on the system intake account and sends only a confirmation receipt", async () => {
  const response = await file();
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    referenceNumber: "SUP-000001",
  });
  expect(prisma.supportCase.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      externalRequesterEmail: "outside@example.com",
      externalRequesterName: "Outside Customer",
      requesterUserId: "system-public-grievance-intake",
      submitterUserId: "system-public-grievance-intake",
      scopeKey: expect.stringMatching(/^GRIEVANCE:[0-9a-f-]{36}$/),
      messages: {
        create: expect.objectContaining({
          authorUserId: null,
          body: "Please investigate",
          metadata: expect.objectContaining({ origin: "public-grievance" }),
        }),
      },
    }),
  });
  expect(stageExternalIntakeReceiptTx).toHaveBeenCalledWith(expect.anything(), {
    caseId: "case",
    reference: "SUP-000001",
    to: "outside@example.com",
  });
  expect(sendContactInquiryEmail).toHaveBeenCalledWith(
    expect.objectContaining({
      email: "outside@example.com",
      referenceNumber: "SUP-000001",
    }),
  );
});

it("files a signed-in grievance on the account, ignoring the typed address", async () => {
  (getSession as jest.Mock).mockResolvedValueOnce({
    user: { id: "member-1" },
  });

  const response = await file("typo@stranger.example");

  expect(response.status).toBe(202);
  const { data } = (prisma.supportCase.create as jest.Mock).mock.calls[0][0];
  expect(data).toMatchObject({
    externalRequesterEmail: null,
    externalRequesterName: null,
    requesterUserId: "member-1",
    submitterUserId: "member-1",
  });
  expect(data.description).not.toContain("typo@stranger.example");
  expect(data.messages.create.authorUserId).toBe("member-1");
  expect(stageSupportCaseIntakeTx).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ id: "case", externalRequesterEmail: null }),
    "USER",
  );
  expect(stageExternalIntakeReceiptTx).not.toHaveBeenCalled();
});
