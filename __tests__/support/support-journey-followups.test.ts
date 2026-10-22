/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "staff", name: "Operator" } },
  })),
}));
jest.mock("../../lib/support/case-service", () => ({
  createOrReuseSupportCase: jest.fn(async () => ({
    supportCase: { id: "case" },
    reused: false,
  })),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findFirst: jest.fn(async () => ({ id: "customer" })),
      findUnique: jest.fn(async () => ({ id: "customer" })),
    },
  },
}));
jest.mock("../../lib/novu", () => ({
  notifySupportTicketCreated: jest.fn(),
  notifySupportTicketActivity: jest.fn(),
}));
jest.mock("../../lib/email/senders/people", () => ({
  sendSupportTicketReceivedEmail: jest.fn(),
}));
import { NextRequest } from "next/server";
import {
  createSupportTicket,
  createOutboundStaffSupportTicket,
} from "../../lib/support/create-ticket";
import { createOrReuseSupportCase } from "../../lib/support/case-service";
import { fieldErrorsOf } from "../../lib/support/error-copy";
import { POST } from "../../app/api/support/tickets/route";
beforeEach(() => jest.clearAllMocks());
it("marks customer intake for a transactional receipt", async () => {
  await createSupportTicket({
    userId: "customer",
    title: "Help",
    description: "Question",
    filedBy: "requester",
  });
  expect(createOrReuseSupportCase).toHaveBeenCalledWith(
    expect.objectContaining({
      initialSender: "USER",
      activeChannel: "HUMAN",
      requesterUserId: "customer",
      submitterUserId: "customer",
    }),
  );
});
it("marks system-created intake without impersonating a customer message", async () => {
  await createSupportTicket({
    userId: "customer",
    title: "Help",
    description: "Automated concern",
    filedBy: "system",
  });
  expect(createOrReuseSupportCase).toHaveBeenCalledWith(
    expect.objectContaining({ initialSender: "SYSTEM" }),
  );
});
it("an outbound staff message belongs to the target customer and strips forged callback markers", async () => {
  await createOutboundStaffSupportTicket({
    staffUserId: "staff",
    staffUserName: "Operator",
    targetLookup: "customer",
    title: "Follow-up",
    description: "[Callback Requested: +919876543210] Checking in",
  });
  expect(createOrReuseSupportCase).toHaveBeenCalledWith(
    expect.objectContaining({
      submitterUserId: "customer",
      requesterUserId: "customer",
      initialAuthorUserId: "staff",
      initialSender: "AGENT",
      description: "Checking in",
    }),
  );
});
it("refuses a description containing only a callback marker", async () => {
  const response = await POST(
    new NextRequest("https://example.test/api/support/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetUserId: "customer",
        title: "Follow-up",
        description: "[Callback Requested: +919876543210]",
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect(createOrReuseSupportCase).not.toHaveBeenCalled();
});
it("surfaces field validation copy without exposing unrelated detail", () => {
  expect(
    fieldErrorsOf({
      formErrors: [],
      fieldErrors: { callbackPhone: ["Enter a valid phone", "second"] },
    }),
  ).toEqual({ callbackPhone: "Enter a valid phone" });
  expect(fieldErrorsOf([{ code: "invalid_type" }])).toEqual({});
});
