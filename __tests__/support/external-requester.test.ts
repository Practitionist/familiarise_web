/** @jest-environment node */

jest.mock("../../lib/email/deliver", () => ({
  __esModule: true,
  stage: jest.fn(async () => ({ id: "row", idempotencyKey: "key" })),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    supportCase: { findFirst: jest.fn() },
    supportCaseEvent: { findFirst: jest.fn(), create: jest.fn() },
    supportCaseMessage: { findMany: jest.fn(async () => []) },
    supportCaseDecision: { findMany: jest.fn(async () => []) },
  };
  return {
    __esModule: true,
    default: { ...db, $transaction: jest.fn(async (fn) => fn(db)) },
  };
});

import prisma from "../../lib/prisma";
import { stage } from "../../lib/email/deliver";
import {
  EXTERNAL_EMAIL_VERIFY_TTL_MS,
  PUBLIC_INTAKE_USER_EMAIL,
  confirmExternalRequesterEmail,
  externalEmailToken,
  resolvePublicIntakeUserId,
  stageExternalRequesterEmail,
  verifyExternalEmailToken,
} from "../../lib/support/external-requester";

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; create: jest.Mock };
  supportCase: { findFirst: jest.Mock };
  supportCaseEvent: { findFirst: jest.Mock; create: jest.Mock };
  supportCaseMessage: { findMany: jest.Mock };
};
const stageMock = stage as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("external email verification token", () => {
  const now = Date.UTC(2026, 9, 21);
  const token = externalEmailToken("case-1", "Outside@Example.com", now);

  it("accepts its own signature case-insensitively on the address", () => {
    expect(
      verifyExternalEmailToken(
        "case-1",
        "outside@example.com",
        token,
        now,
        now,
      ),
    ).toBe(true);
  });

  it("rejects another case, another address, expiry and forgery", () => {
    expect(
      verifyExternalEmailToken(
        "case-2",
        "outside@example.com",
        token,
        now,
        now,
      ),
    ).toBe(false);
    expect(
      verifyExternalEmailToken("case-1", "victim@example.com", token, now, now),
    ).toBe(false);
    expect(
      verifyExternalEmailToken(
        "case-1",
        "outside@example.com",
        token,
        now,
        now + EXTERNAL_EMAIL_VERIFY_TTL_MS + 1,
      ),
    ).toBe(false);
    expect(
      verifyExternalEmailToken(
        "case-1",
        "outside@example.com",
        "0".repeat(64),
        now,
        now,
      ),
    ).toBe(false);
  });
});

describe("emails to an anonymous complainant", () => {
  const input = {
    caseId: "case-1",
    reference: "FAM-000123",
    to: "outside@example.com",
    subject: "Support response — FAM-000123",
    text: "Staff reply with account details\n\nReference: FAM-000123",
    emailType: "SUPPORT_TICKET_RESPONSE",
    entityRef: "case-message:m1",
  };

  it("carries only the reference and a confirmation link until the address is confirmed", async () => {
    db.supportCaseEvent.findFirst.mockResolvedValue(null);
    const { message } = await stageExternalRequesterEmail(input);

    expect(message.text).toContain("FAM-000123");
    expect(message.text).toContain("/api/support/external-verify?case=case-1");
    expect(message.text).not.toContain("Staff reply");
    expect(message.html).not.toContain("Staff reply");
    expect(stageMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "outside@example.com" }),
      "SUPPORT_TICKET_RESPONSE",
      expect.objectContaining({ entityRef: "case-message:m1" }),
    );
  });

  it("carries the staff content once the address is confirmed", async () => {
    db.supportCaseEvent.findFirst.mockResolvedValue({ id: "verified" });
    const { message } = await stageExternalRequesterEmail(input);
    expect(message.text).toContain("Staff reply with account details");
  });
});

describe("confirming the address", () => {
  const issuedAt = Date.now();
  const caseRow = {
    id: "case-1",
    referenceNumber: "FAM-000123",
    title: "[Grievance] Refund not received",
    description:
      "Submitted via public form by Asha <outside@example.com>\n\nMy refund is missing.",
    externalRequesterEmail: "outside@example.com",
  };

  it("records the confirmation once and sends the withheld replies", async () => {
    db.supportCase.findFirst.mockResolvedValue(caseRow);
    db.supportCaseEvent.findFirst.mockResolvedValue(null);
    db.supportCaseMessage.findMany.mockResolvedValue([
      { body: "Withheld staff reply", createdAt: new Date() },
    ]);

    const outcome = await confirmExternalRequesterEmail({
      caseId: "case-1",
      token: externalEmailToken("case-1", "outside@example.com", issuedAt),
      issuedAt,
    });

    expect(outcome).toBe("VERIFIED");
    expect(db.supportCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        caseId: "case-1",
        kind: "VISIBILITY_CHANGED",
        toValue: "EXTERNAL_EMAIL_VERIFIED",
      }),
    });
    expect(stageMock.mock.calls[0][0].text).toContain("Withheld staff reply");
  });

  it("sends the complaint as recorded only once the address is confirmed", async () => {
    db.supportCase.findFirst.mockResolvedValue(caseRow);
    db.supportCaseEvent.findFirst.mockResolvedValue(null);
    db.supportCaseMessage.findMany.mockResolvedValue([]);

    await confirmExternalRequesterEmail({
      caseId: "case-1",
      token: externalEmailToken("case-1", "outside@example.com", issuedAt),
      issuedAt,
    });

    expect(stageMock).toHaveBeenCalledTimes(1);
    const [message, emailType, options] = stageMock.mock.calls[0];
    expect(message.to).toBe("outside@example.com");
    expect(message.subject).toContain("Your grievance as recorded");
    expect(message.text).toContain("FAM-000123");
    expect(message.text).toContain("My refund is missing.");
    expect(emailType).toBe("SUPPORT_TICKET_RECEIVED");
    expect(options).toEqual(
      expect.objectContaining({ entityRef: "case-complaint-copy:case-1" }),
    );
  });

  it("sends no complaint copy for an unconfirmable link", async () => {
    db.supportCase.findFirst.mockResolvedValue(caseRow);
    await confirmExternalRequesterEmail({
      caseId: "case-1",
      token: externalEmailToken("case-1", "attacker@example.com", issuedAt),
      issuedAt,
    });
    expect(stageMock).not.toHaveBeenCalled();
  });

  it("withholds presenter replies while digesting the staff ones", async () => {
    db.supportCase.findFirst.mockResolvedValue(caseRow);
    db.supportCaseEvent.findFirst.mockResolvedValue(null);
    db.supportCaseMessage.findMany.mockResolvedValue([
      {
        body: "Withheld staff reply",
        createdAt: new Date(),
        metadata: null,
      },
      {
        body: "Presenter-only reply",
        createdAt: new Date(),
        metadata: { actorKind: "PRESENTER" },
      },
    ]);

    await confirmExternalRequesterEmail({
      caseId: "case-1",
      token: externalEmailToken("case-1", "outside@example.com", issuedAt),
      issuedAt,
    });

    const digest = stageMock.mock.calls[0][0].text;
    expect(digest).toContain("Withheld staff reply");
    expect(digest).not.toContain("Presenter-only reply");
  });

  it("is a no-op for a link already used", async () => {
    db.supportCase.findFirst.mockResolvedValue(caseRow);
    db.supportCaseEvent.findFirst.mockResolvedValue({ id: "verified" });
    const outcome = await confirmExternalRequesterEmail({
      caseId: "case-1",
      token: externalEmailToken("case-1", "outside@example.com", issuedAt),
      issuedAt,
    });
    expect(outcome).toBe("ALREADY_VERIFIED");
    expect(db.supportCaseEvent.create).not.toHaveBeenCalled();
  });

  it("refuses a token for another address", async () => {
    db.supportCase.findFirst.mockResolvedValue(caseRow);
    const outcome = await confirmExternalRequesterEmail({
      caseId: "case-1",
      token: externalEmailToken("case-1", "attacker@example.com", issuedAt),
      issuedAt,
    });
    expect(outcome).toBe("INVALID");
    expect(db.supportCaseEvent.create).not.toHaveBeenCalled();
  });
});

describe("public intake owner", () => {
  it("creates the non-staff system account once and reuses it", async () => {
    db.user.findUnique.mockResolvedValueOnce(null);
    db.user.create.mockResolvedValueOnce({
      id: "system-public-grievance-intake",
    });
    await expect(resolvePublicIntakeUserId()).resolves.toBe(
      "system-public-grievance-intake",
    );
    expect(db.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: PUBLIC_INTAKE_USER_EMAIL,
        emailVerified: true,
      }),
      select: { id: true },
    });
    const created = db.user.create.mock.calls[0][0].data;
    expect(created).not.toHaveProperty("role");

    db.user.findUnique.mockResolvedValueOnce({
      id: "system-public-grievance-intake",
    });
    await resolvePublicIntakeUserId();
    expect(db.user.create).toHaveBeenCalledTimes(1);
  });
});
