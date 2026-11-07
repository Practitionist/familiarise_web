/**
 * @jest-environment node
 *
 * Referral notices stage inside the transaction that moves the credit: the
 * bell is policy-filtered and formatted, one row per payment or referral, and
 * a credits-applied email rendered before the capture is staged, not re-rendered.
 */

const mockUsers = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { user: { findMany: (...args: unknown[]) => mockUsers(...args) } },
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: jest.fn(),
}));
const mockRender = jest.fn(async () => ({ html: "<p>x</p>", text: "x" }));
jest.mock("../../lib/email/render", () => ({
  renderEmail: (...args: unknown[]) => mockRender(...(args as [])),
}));
jest.mock("../../lib/url", () => ({ getAppUrl: () => "http://localhost" }));

import {
  prepareCreditsAppliedEmail,
  readCreditsApplied,
  stageCreditsApplied,
  stageReferralReward,
} from "@/lib/referrals/referral-notify";

const people: Record<string, Record<string, unknown>> = {
  buyer: { id: "buyer", email: "buyer@example.com", name: "Buyer" },
  muted: {
    id: "muted",
    email: "muted@example.com",
    name: "Muted",
    notificationPreferences: {
      allNotifications: true,
      emailEnabled: true,
      inAppEnabled: false,
    },
  },
};
const findPeople = async (q: { where: { id: { in: string[] } } }) =>
  q.where.id.in.map((id) => people[id]).filter(Boolean);

function makeTx() {
  const bells: Record<string, unknown>[] = [];
  const emails: Record<string, unknown>[] = [];
  const tx = {
    user: { findMany: jest.fn(findPeople) },
    referralCreditUsage: {
      findMany: jest.fn(async () => [
        { originalAmount: 3000 },
        { originalAmount: 1500 },
      ]),
    },
    referralCredit: {
      findMany: jest.fn(async () => [{ remainingAmount: 2500 }]),
    },
    notificationOutbox: {
      upsert: jest.fn(
        async (q: {
          where: { transactionId: string };
          create: Record<string, unknown>;
        }) => {
          const known = bells.find(
            (b) => b.transactionId === q.where.transactionId,
          );
          if (!known) bells.push(q.create);
          return { id: q.where.transactionId, ...(known ?? q.create) };
        },
      ),
    },
    failedEmail: {
      create: jest.fn(async (q: { data: Record<string, unknown> }) => {
        emails.push(q.data);
        return { id: `fe_${emails.length}` };
      }),
    },
    emailSuppression: { findUnique: jest.fn(async () => null) },
  };
  return { tx, bells, emails };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers.mockImplementation(findPeople);
  process.env.EMAIL_DELIVERY_MODE = "live";
});

it("capture: what checkout redeemed, rendered before the transaction and only staged inside it", async () => {
  const { tx, bells, emails } = makeTx();
  const applied = await readCreditsApplied(tx as never, {
    userId: "buyer",
    paymentId: "pay_1",
    appointmentType: "CONSULTATION",
  });
  expect(applied).toMatchObject({
    creditsUsedPaise: 4500,
    remainingPaise: 2500,
  });
  const pre = await prepareCreditsAppliedEmail(applied!);
  mockRender.mockClear();

  await stageCreditsApplied(tx as never, applied!, pre);
  await stageCreditsApplied(tx as never, applied!, pre);

  expect(mockRender).not.toHaveBeenCalled();
  expect(bells).toEqual([
    expect.objectContaining({
      workflowId: "referral-credits-applied",
      recipients: ["buyer"],
      entityRef: "payment:pay_1",
      payload: expect.objectContaining({
        creditsUsed: "₹45.00",
        remainingCredits: "₹25.00",
      }),
    }),
  ]);
  expect(emails[0]).toMatchObject({
    emailType: "REFERRAL_CREDITS_APPLIED",
    entityRef: "payment:pay_1:referral-credits-applied",
  });
});

it("a payment that redeemed nothing stages nothing", async () => {
  const { tx } = makeTx();
  tx.referralCreditUsage.findMany.mockResolvedValueOnce([]);
  await expect(
    readCreditsApplied(tx as never, {
      userId: "buyer",
      paymentId: "pay_2",
      appointmentType: "CONSULTATION",
    }),
  ).resolves.toBeNull();
});

it("rewards: the bell is policy-filtered and keyed per referral; the email follows its own switch", async () => {
  const { tx, bells, emails } = makeTx();
  const reward = {
    kind: "BONUS_EARNED" as const,
    referralId: "ref_1",
    counterpartyName: "Asha",
    amountPaise: 20_000,
  };
  await stageReferralReward(tx as never, { ...reward, userId: "buyer" });
  await stageReferralReward(tx as never, { ...reward, userId: "buyer" });
  await stageReferralReward(tx as never, { ...reward, userId: "muted" });

  expect(bells).toEqual([
    expect.objectContaining({
      workflowId: "referral-bonus-earned",
      recipients: ["buyer"],
      payload: expect.objectContaining({ bonusAmount: "₹200.00" }),
    }),
  ]);
  expect(emails.map((e) => e.recipient)).toContain("muted@example.com");
});

it("welcome: states the discount as a cap", async () => {
  const { tx, emails } = makeTx();
  await stageReferralReward(tx as never, {
    kind: "WELCOME_BONUS",
    userId: "buyer",
    referralId: "ref_2",
    counterpartyName: "Asha",
    amountPaise: 15_000,
  });
  expect(emails[0]).toMatchObject({
    subject: "Welcome discount: up to ₹150.00 on an eligible first booking",
  });
});
