/**
 * Consent is checked by purpose: a grant stamped with an older notice version
 * still counts after TERMS_VERSION is bumped.
 */
import prisma from "../../lib/prisma";
import { buildConsentArtifact, checkConsent } from "../../lib/compliance/dpdp";
import { TERMS_VERSION } from "../../lib/compliance/purpose-codes";
import { seedUser } from "./seed";

it("counts a version 1 MARKETING_COMMS grant under the current notice", async () => {
  expect(TERMS_VERSION).toBeGreaterThan(1);
  const { userId } = await seedUser();
  await prisma.consentArtifact.create({
    data: buildConsentArtifact({
      userId,
      dataFiduciary: "Familiarise",
      purposeCodes: ["MARKETING_COMMS"],
      language: "en-IN",
      version: 1,
    }),
  });

  expect(await checkConsent({ userId, purposeCode: "MARKETING_COMMS" })).toBe(
    true,
  );
  expect(await checkConsent({ userId, purposeCode: "ANALYTICS" })).toBe(false);
});
