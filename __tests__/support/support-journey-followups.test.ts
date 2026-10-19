/**
 * @jest-environment node
 */

/**
 * Customer-journey follow-ups: who gets a "request received" receipt, how the
 * staff "create for a user" path treats callback markers, which validation
 * copy reaches the dialog, and what a malformed reply body answers.
 *
 * The canonical case API is `/api/support/cases`; the pre-cutover ticket and
 * response routes are retired, so every assertion here targets where the
 * behaviour now lives.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn(async () => true),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({ user: { id: "u1" } })),
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "staff-1", name: "S" } },
  })),
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "u1", name: "U", role: "CONSULTEE" } },
  })),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifySupportTicketCreated: jest.fn(async () => ({ success: true })),
  notifySupportTicketActivity: jest.fn(async () => []),
  notifySupportTicketResponse: jest.fn(async () => ({ success: true })),
}));

jest.mock("../../lib/novu/outbox", () => ({
  __esModule: true,
  stageTrigger: jest.fn(async () => ({ id: "outbox-1" })),
  attemptTrigger: jest.fn(async () => undefined),
}));

jest.mock("../../lib/email/senders/people", () => ({
  __esModule: true,
  sendSupportTicketReceivedEmail: jest.fn(async () => undefined),
}));

jest.mock("../../lib/prisma", () => {
  const created = {
    id: "c1",
    title: "Nobody joined",
    description: "Raised automatically.",
    organizationId: null,
    referenceNumber: "FAM-2026-000001",
    requesterUserId: "customer",
    submitterUserId: "customer",
    status: "OPEN",
    priority: "MEDIUM",
    activeChannel: "HUMAN",
    ownershipScope: "PERSONAL",
    deletedAt: null,
    externalRequesterEmail: null,
    caseKind: "INCIDENT",
    ackDueAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
  };
  const db = {
    supportCase: {
      // No open case on the scope, so intake creates rather than reuses.
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => ({
        ...created,
        // The signed-in viewer owns this case, so the read is permitted.
        requesterUserId: "u1",
        submitterUserId: "u1",
        subjects: [],
        messages: [],
        events: [],
      })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...created,
        ...data,
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    supportCaseMessage: { create: jest.fn(async () => ({})) },
    supportCaseEvent: { create: jest.fn(async () => ({})) },
    supportCaseSubject: { findFirst: jest.fn(async () => null) },
    supportTicketCounter: { upsert: jest.fn(async () => ({ nextSeq: 2 })) },
    user: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => ({ id: "customer", name: "C" })),
      findFirst: jest.fn(async () => ({ id: "customer" })),
    },
    organization: { findUnique: jest.fn(async () => null) },
    membership: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    payment: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(db),
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 5000,
    ALLOCATION_TX_TIMEOUT_MS: 15000,
  };
});

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { sendSupportTicketReceivedEmail } from "../../lib/email/senders/people";
import { stageTrigger } from "../../lib/novu/outbox";
import {
  createOutboundStaffSupportTicket,
  createSupportTicket,
} from "../../lib/support/create-ticket";
import { fieldErrorsOf } from "../../lib/support/error-copy";
import { POST as postReply } from "../../app/api/support/cases/[caseId]/messages/route";
import { POST as postStaffTicket } from "../../app/api/support/tickets/route";

const caseCreate = prisma.supportCase.create as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("requester receipt", () => {
  const base = {
    userId: "customer",
    title: "Nobody joined",
    description: "Raised automatically.",
  };

  it("is sent for a case the customer filed", async () => {
    await createSupportTicket({ ...base, filedBy: "requester" });
    expect(stageTrigger).toHaveBeenCalledTimes(1);
    expect(sendSupportTicketReceivedEmail).toHaveBeenCalledTimes(1);
  });

  it("is never sent for a case a system actor filed on their behalf", async () => {
    await createSupportTicket({ ...base, filedBy: "system" });
    expect(stageTrigger).not.toHaveBeenCalled();
    expect(sendSupportTicketReceivedEmail).not.toHaveBeenCalled();
  });
});

describe("staff create-for-user path", () => {
  it("strips a typed callback marker from the case", async () => {
    await createOutboundStaffSupportTicket({
      staffUserId: "staff-1",
      staffUserName: "S",
      targetLookup: "customer",
      title: "Follow-up",
      description: "[Callback Requested: +919876543210] Checking in",
    });
    const stored = caseCreate.mock.calls[0][0].data.description;
    expect(stored).toBe("Checking in");
  });
});

describe("staff create-for-user entrypoint", () => {
  it("refuses a description that is only a callback marker, creating nothing", async () => {
    const res = await postStaffTicket(
      new NextRequest("https://x.test/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetUserId: "customer",
          title: "Follow-up",
          description: "  [Callback Requested: +919876543210]  ",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_FAILED");
    expect(caseCreate).not.toHaveBeenCalled();
  });

  it("answers a legacy body with no targetUserId as the retired endpoint", async () => {
    // The retired shape is the body's MISSING targetUserId, so the check is
    // the key's presence. A body that simply omits it must be told the
    // endpoint moved (410), not that it lacks permission (403).
    const res = await postStaffTicket(
      new NextRequest("https://x.test/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Follow-up",
          description: "Checking in",
        }),
      }),
    );
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("ENDPOINT_RETIRED");
    expect(caseCreate).not.toHaveBeenCalled();
  });
});

describe("validation copy", () => {
  it("surfaces the first per-field message and ignores any other detail shape", () => {
    expect(
      fieldErrorsOf({
        formErrors: [],
        fieldErrors: { callbackPhone: ["Enter a valid phone", "second"] },
      }),
    ).toEqual({ callbackPhone: "Enter a valid phone" });
    expect(fieldErrorsOf([{ code: "invalid_type" }])).toEqual({});
  });

  it("answers a malformed reply body with the coded envelope and no raw issues", async () => {
    const res = await postReply(
      new NextRequest("http://localhost/api/support/cases/c1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
      { params: Promise.resolve({ caseId: "c1" }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_FAILED");
    expect(json).not.toHaveProperty("details");
  });
});
