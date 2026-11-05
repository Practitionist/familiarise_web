/** @jest-environment node */
const mockStageBells = jest.fn(async (..._args: unknown[]) => []);
const mockStageEmail = jest.fn(async (..._args: unknown[]) => []);
const mockRoster = jest.fn(async (..._args: unknown[]) => ["owner", "manager"]);
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBells: (...args: unknown[]) => mockStageBells(...args),
}));
jest.mock("../../lib/email/senders/money", () => ({
  stageClawbackNoticeEmail: (...args: unknown[]) => mockStageEmail(...args),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  rosterForOrg: (...args: unknown[]) => mockRoster(...args),
  VISIBILITY_ROLES: ["OWNER", "MAINTAINER", "MANAGER"],
}));
import { txDouble } from "../fixtures/tx-double";
import { stageClawbackNotice } from "@/lib/payments/payouts/clawback-notifications";
import { CLAWBACK_NOTICE_COPY } from "@/emails/payments/ClawbackNoticeEmail";
import { toWire } from "@/lib/novu/templates";

beforeEach(() => jest.clearAllMocks());
const input = {
  payoutId: "payout",
  journalId: "journal",
  event: "OFFSET_RESERVED",
  amountPaise: 12345,
} as const;

it("stages the consultant's actual payee with a journal identity and the supplied transaction", async () => {
  const lookup = jest.fn(async () => ({ userId: "expert" }));
  const tx = txDouble({ consultantProfile: { findUnique: lookup } });
  await stageClawbackNotice(tx, {
    ...input,
    payee: { rail: "CONSULTANT", consultantProfileId: "profile" },
  });
  expect(lookup).toHaveBeenCalledWith({
    where: { id: "profile" },
    select: { userId: true },
  });
  expect(mockStageBells).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      recipients: ["expert"],
      workflowId: "payout-clawback",
      dedupeKey: "journal",
      payload: expect.objectContaining({
        eventKind: "OFFSET_RESERVED",
        amount: "₹123.45",
      }),
    }),
  );
  expect(mockStageEmail).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      recipientUserIds: ["expert"],
      amountPaise: 12345,
      organization: false,
    }),
  );
  expect(mockRoster).not.toHaveBeenCalled();
});

it("uses the existing active organisation finance visibility roster and organisation destination", async () => {
  const tx = txDouble({});
  await stageClawbackNotice(tx, {
    ...input,
    payee: { rail: "ORG", organizationId: "org" },
  });
  expect(mockRoster).toHaveBeenCalledWith(
    "org",
    ["OWNER", "MAINTAINER", "MANAGER"],
    tx,
  );
  expect(mockStageBells).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      recipients: ["owner", "manager"],
      workflowId: "org-payout-clawback",
      payload: expect.objectContaining({
        dashboardUrl: "/dashboard/organization/org/payouts",
      }),
    }),
  );
  expect(mockStageEmail).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      organization: true,
      recipientUserIds: ["owner", "manager"],
    }),
  );
});

it("propagates either channel's staging failure to its owning transaction", async () => {
  const tx = txDouble({
    consultantProfile: {
      findUnique: jest.fn(async () => ({ userId: "expert" })),
    },
  });
  mockStageBells.mockRejectedValueOnce(new Error("bell write failed"));
  await expect(
    stageClawbackNotice(tx, {
      ...input,
      payee: { rail: "CONSULTANT", consultantProfileId: "profile" },
    }),
  ).rejects.toThrow("bell write failed");
  expect(mockStageEmail).not.toHaveBeenCalled();
  mockStageEmail.mockRejectedValueOnce(new Error("render failed"));
  await expect(
    stageClawbackNotice(tx, {
      ...input,
      payee: { rail: "CONSULTANT", consultantProfileId: "profile" },
    }),
  ).rejects.toThrow("render failed");
});

it("does not invent a recipient or block accounting when the profile is gone", async () => {
  const tx = txDouble({
    consultantProfile: { findUnique: jest.fn(async () => null) },
  });
  await expect(
    stageClawbackNotice(tx, {
      ...input,
      payee: { rail: "CONSULTANT", consultantProfileId: "gone" },
    }),
  ).resolves.toBeUndefined();
  expect(mockStageBells).not.toHaveBeenCalled();
  expect(mockStageEmail).not.toHaveBeenCalled();
});

it.each(["payout-clawback", "org-payout-clawback"] as const)(
  "keeps %s in an existing workflow family",
  (workflow) => {
    const wire = toWire(workflow, {
      payoutId: "payout",
      eventKind: "OFFSET_RESERVED",
      amount: "₹123.45",
      dashboardUrl: "/dashboard",
    });
    expect(wire.workflowId).toBe(
      workflow === "payout-clawback" ? "payout" : "org-billing",
    );
    expect(wire.payload.event).toBe(workflow);
  },
);

it("distinguishes a reserved offset from a completed transfer and a released offset from forgiven debt", () => {
  expect(CLAWBACK_NOTICE_COPY.OFFSET_RESERVED.description).toContain(
    "has not been confirmed as completed",
  );
  expect(CLAWBACK_NOTICE_COPY.OFFSET_RELEASED.description).toContain(
    "remains owed",
  );
  expect(CLAWBACK_NOTICE_COPY.RAISED.description).toContain(
    "does not mean your bank account was debited",
  );
  expect(CLAWBACK_NOTICE_COPY.VOIDED.description).toContain(
    "Previously recovered amounts remain accounted for",
  );
});
