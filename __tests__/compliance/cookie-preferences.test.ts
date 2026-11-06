/** @jest-environment node */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
import { txDouble } from "../fixtures/tx-double";
import { buildConsentArtifact } from "@/lib/compliance/dpdp";
import {
  readCookiePreferences,
  saveCookiePreferences,
} from "@/lib/compliance/cookie-preferences";
import { TERMS_VERSION } from "@/lib/compliance/purpose-codes";

function fixture() {
  let prefs = { analytics: false, marketing: false };
  const grants: Array<
    ReturnType<typeof buildConsentArtifact> & {
      id: string;
      withdrawnAt: Date | null;
    }
  > = [];
  const findFirst = jest.fn(
    async ({
      where,
    }: {
      where: {
        userId: string;
        dataFiduciary: string;
        version: number;
        purposeCodes: { hasSome: string[] };
        auditRetainedUntil: { gt: Date };
      };
    }) =>
      grants.find(
        (grant) =>
          grant.userId === where.userId &&
          grant.dataFiduciary === where.dataFiduciary &&
          grant.version === where.version &&
          !grant.withdrawnAt &&
          grant.auditRetainedUntil > where.auditRetainedUntil.gt &&
          grant.purposeCodes.some((code) =>
            where.purposeCodes.hasSome.includes(code),
          ),
      ) ?? null,
  );
  const create = jest.fn(
    async ({ data }: { data: ReturnType<typeof buildConsentArtifact> }) => {
      const row = { ...data, id: `grant-${grants.length}`, withdrawnAt: null };
      grants.push(row);
      return row;
    },
  );
  const upsert = jest.fn(
    async ({ update }: { update: Partial<typeof prefs> }) => {
      prefs = { ...prefs, ...update };
      return prefs;
    },
  );
  const tx = txDouble({
    cookiePreference: { findUnique: jest.fn(async () => prefs), upsert },
    consentArtifact: {
      findFirst,
      create,
      findMany: jest.fn(async () => grants),
      updateMany: jest.fn(async () => {
        grants.forEach((grant) => (grant.withdrawnAt = new Date()));
        return { count: grants.length };
      }),
    },
  });
  return {
    tx,
    grants,
    create,
    upsert,
    findFirst,
    setPrefs: (next: typeof prefs) => (prefs = next),
  };
}
it("commits account cookie choices with current single-purpose analytics evidence and reuses a live grant", async () => {
  const f = fixture();
  expect(
    (
      await saveCookiePreferences(
        f.tx,
        { userId: "user" },
        { analytics: true, marketing: false },
      )
    ).preferences,
  ).toEqual({ essential: true, analytics: true, marketing: false });
  expect(f.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      userId: "user",
      dataFiduciary: "Familiarise",
      purposeCodes: ["ANALYTICS"],
      version: TERMS_VERSION,
    }),
  });
  await saveCookiePreferences(f.tx, { userId: "user" }, { analytics: true });
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      update: expect.objectContaining({ essential: true }),
    }),
  );
});
it("withdraws analytics with its flag and does not reuse the withdrawn artifact on a fresh grant", async () => {
  const f = fixture();
  await saveCookiePreferences(f.tx, { userId: "user" }, { analytics: true });
  expect(
    (
      await saveCookiePreferences(
        f.tx,
        { userId: "user" },
        { analytics: false },
      )
    ).preferences.analytics,
  ).toBe(false);
  expect(f.grants[0].withdrawnAt).toBeInstanceOf(Date);
  await saveCookiePreferences(f.tx, { userId: "user" }, { analytics: true });
  expect(f.create).toHaveBeenCalledTimes(2);
});
it.each([
  "missing",
  "stale_version",
  "other_purpose",
  "other_fiduciary",
  "expired",
])(
  "does not treat a legacy true flag as permission with %s evidence",
  async (kind) => {
    const f = fixture();
    f.setPrefs({ analytics: true, marketing: false });
    if (kind !== "missing")
      f.grants.push({
        ...buildConsentArtifact({
          userId: "user",
          dataFiduciary: kind === "other_fiduciary" ? "Other" : "Familiarise",
          purposeCodes:
            kind === "other_purpose" ? ["MARKETING_COMMS"] : ["ANALYTICS"],
          language: "en-IN",
          version: kind === "stale_version" ? TERMS_VERSION - 1 : TERMS_VERSION,
        }),
        id: "old",
        withdrawnAt: null,
        ...(kind === "expired" ? { auditRetainedUntil: new Date(0) } : {}),
      });
    expect(
      (await readCookiePreferences(f.tx, { userId: "user" })).analytics,
    ).toBe(false);
  },
);
it("keeps marketing cookies separate from email consent and does not attach anonymous permission to an account", async () => {
  const f = fixture();
  const result = await saveCookiePreferences(
    f.tx,
    { sessionId: "browser" },
    { analytics: true, marketing: true },
  );
  expect(result.preferences).toEqual({
    essential: true,
    analytics: true,
    marketing: true,
  });
  expect(f.create).not.toHaveBeenCalled();
  expect(f.findFirst).not.toHaveBeenCalled();
  expect(f.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { sessionId: "browser" },
      create: expect.not.objectContaining({ userId: expect.anything() }),
    }),
  );
});
it("propagates evidence failure so the owning transaction can roll back the preference", async () => {
  const f = fixture();
  f.create.mockRejectedValueOnce(new Error("evidence unavailable"));
  await expect(
    saveCookiePreferences(f.tx, { userId: "user" }, { analytics: true }),
  ).rejects.toThrow("evidence unavailable");
});

it("does not turn authenticated marketing-cookie permission into marketing email consent", async () => {
  const f = fixture();
  expect(
    (await saveCookiePreferences(f.tx, { userId: "user" }, { marketing: true }))
      .preferences,
  ).toEqual({ essential: true, analytics: false, marketing: true });
  expect(f.create).not.toHaveBeenCalled();
  expect(f.findFirst).not.toHaveBeenCalled();
});
