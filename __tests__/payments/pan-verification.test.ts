/**
 * @jest-environment node
 */

/**
 * The 194-O rate reads a PAN as on file only once verified: the admin door
 * verifies or rejects it, and a consultant entering a PAN always resets it.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const role = { current: "ADMIN" };
jest.mock("../../lib/auth-helpers", () => {
  const { hasBackofficePermission } = jest.requireActual(
    "../../lib/auth/backoffice-permissions",
  );
  const { NextResponse } = jest.requireActual("next/server");
  return {
    requireBackofficeSurface: async (surface: string) =>
      hasBackofficePermission(role.current, surface)
        ? {
            session: {
              user: { id: "u_admin", role: role.current },
              session: { createdAt: new Date() },
            },
          }
        : { error: NextResponse.json({}, { status: 403 }) },
  };
});
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/api/consultant-profile", () => ({
  requireOwnConsultantProfile: async () => ({ profileId: "cp_1" }),
}));
jest.mock("../../lib/payments/tax/pan-crypto", () => ({
  encryptPAN: () => ({ encrypted: new Uint8Array([9]), last4: "234F" }),
}));

const PAN = new Uint8Array([1, 2, 3]);
const tx = {
  consultantProfile: { findUnique: jest.fn() },
  payoutAccount: { findFirst: jest.fn() },
  consultantTaxInfo: { updateMany: jest.fn() },
  opsActionLog: { create: jest.fn(async (_args: unknown) => ({ id: "log" })) },
};
const db = {
  $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  consultantTaxInfo: { upsert: jest.fn(async () => ({ panVerified: false })) },
  consultantProfile: {
    update: jest.fn(),
    findUnique: jest.fn(async () => null),
  },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/users/[userId]/tax-info/verify-pan/route";
import { PUT } from "../../app/api/consultant/tax-info/route";

const verifyPan = (body: Record<string, unknown>) =>
  POST(
    new NextRequest("https://x.test/api", {
      method: "POST",
      body: JSON.stringify({ reason: "checked on the IT portal", ...body }),
    }),
    { params: Promise.resolve({ userId: "u_1" }) },
  );

function consultant(name: string, holder: string | null) {
  tx.consultantProfile.findUnique.mockResolvedValue({
    id: "cp_1",
    user: { name },
    taxInfo: {
      id: "ti_1",
      panEncrypted: PAN,
      panLast4: "234F",
      panVerified: false,
    },
  });
  tx.payoutAccount.findFirst.mockResolvedValue(
    holder ? { accountHolderName: holder } : null,
  );
}

const logged = () => tx.opsActionLog.create.mock.calls.at(-1)?.[0];

beforeEach(() => {
  jest.clearAllMocks();
  role.current = "ADMIN";
  tx.consultantTaxInfo.updateMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/admin/users/[userId]/tax-info/verify-pan", () => {
  it("refuses STAFF before reading anything", async () => {
    role.current = "STAFF";
    expect((await verifyPan({ decision: "VERIFY" })).status).toBe(403);
    expect(tx.consultantTaxInfo.updateMany).not.toHaveBeenCalled();
  });

  it("verifies on a clean match after normalising case, punctuation and honorifics", async () => {
    consultant("Dr. Asha  Rao", "ASHA RAO");
    const res = await verifyPan({ decision: "VERIFY" });
    expect(res.status).toBe(200);
    expect(tx.consultantTaxInfo.updateMany).toHaveBeenCalledWith({
      where: { id: "ti_1", panEncrypted: { equals: PAN } },
      data: { panVerified: true },
    });
    expect(logged()).toMatchObject({
      data: {
        action: "taxInfo.pan.verify",
        after: { namesMatch: true, overrideNameMismatch: false },
      },
    });
  });

  it.each([
    ["a different name", "RAVI KUMAR"],
    ["no verified payout account", null],
  ])(
    "answers 409 PAN_NAME_MISMATCH on %s, and verifies with the override logged",
    async (_label, holder) => {
      consultant("Asha Rao", holder);
      const refused = await verifyPan({ decision: "VERIFY" });
      expect(refused.status).toBe(409);
      expect((await refused.json()).code).toBe("PAN_NAME_MISMATCH");
      expect(tx.consultantTaxInfo.updateMany).not.toHaveBeenCalled();

      const res = await verifyPan({
        decision: "VERIFY",
        overrideNameMismatch: true,
      });
      expect(res.status).toBe(200);
      expect(logged()).toMatchObject({
        data: { after: { panVerified: true, overrideNameMismatch: true } },
      });
    },
  );

  it("rejects without a name check", async () => {
    consultant("Asha Rao", null);
    const res = await verifyPan({ decision: "REJECT" });
    expect(res.status).toBe(200);
    expect(tx.consultantTaxInfo.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { panVerified: false } }),
    );
    expect(logged()).toMatchObject({
      data: { action: "taxInfo.pan.reject" },
    });
  });

  it("answers 409 PAN_CHANGED when the PAN changed under the read", async () => {
    consultant("Asha Rao", "Asha Rao");
    tx.consultantTaxInfo.updateMany.mockResolvedValue({ count: 0 });
    const res = await verifyPan({ decision: "VERIFY" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PAN_CHANGED");
  });
});

it("PUT /api/consultant/tax-info never carries a verified PAN: create leaves it at the false default, update resets it", async () => {
  await PUT(
    new NextRequest("https://x.test/api", {
      method: "PUT",
      body: JSON.stringify({ panNumber: "ABCDE1234F" }),
    }),
  );
  const upsertCalls: unknown[][] = db.consultantTaxInfo.upsert.mock.calls;
  expect(upsertCalls[0][0]).toMatchObject({
    create: { panEncrypted: new Uint8Array([9]) },
    update: { panEncrypted: new Uint8Array([9]), panVerified: false },
  });
  expect(upsertCalls[0][0]).not.toHaveProperty("create.panVerified");
});
