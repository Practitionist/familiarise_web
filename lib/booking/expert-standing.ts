import { ConsultantVerificationStatus, Prisma } from "@prisma/client";
import { z } from "zod";

import type { Tx } from "@/lib/prisma";
import { expertNotVerifiedError } from "@/lib/booking/booking-rule-error";
import { isPublicExpertProfile } from "@/lib/profiles/public-profile";

const StandingRowsSchema = z.array(
  z.object({
    verificationStatus: z.nativeEnum(ConsultantVerificationStatus),
    deletedAt: z.date().nullable(),
  }),
);

/**
 * Refuses a sale for an expert who is not verified or is deleted, reading the
 * profile under a share lock: a reject's profile write waits for this
 * transaction, so the unpaid-sale ending that follows it sees what this wrote.
 */
export async function assertExpertStandsInTx(
  tx: Pick<Tx, "$queryRaw">,
  consultantProfileId: string,
  label: string,
): Promise<void> {
  const [row] = StandingRowsSchema.parse(
    await tx.$queryRaw(
      Prisma.sql`SELECT "verificationStatus", "deletedAt" FROM "ConsultantProfile" WHERE "id" = ${consultantProfileId} FOR SHARE`,
    ),
  );
  if (row && !isPublicExpertProfile(row)) throw expertNotVerifiedError(label);
}

/** The refusal copy each checkout type answers with. */
export const CHECKOUT_LABEL: Record<string, string> = {
  CONSULTATION: "This consultation",
  SUBSCRIPTION: "This subscription",
  WEBINAR: "This webinar",
  CLASS: "This class",
};

/** The plan's expert, re-read with the sale's write; an ownerless event plan has none. */
export async function assertPlanExpertStandsInTx(
  tx: Pick<
    Tx,
    | "consultationPlan"
    | "subscriptionPlan"
    | "webinarPlan"
    | "classPlan"
    | "$queryRaw"
  >,
  appointmentType: string,
  planId: string,
): Promise<void> {
  const where = {
    where: { id: planId },
    select: { consultantProfileId: true },
  };
  const plan =
    appointmentType === "CONSULTATION"
      ? await tx.consultationPlan.findUnique(where)
      : appointmentType === "SUBSCRIPTION"
        ? await tx.subscriptionPlan.findUnique(where)
        : appointmentType === "WEBINAR"
          ? await tx.webinarPlan.findUnique(where)
          : appointmentType === "CLASS"
            ? await tx.classPlan.findUnique(where)
            : null;
  if (!plan?.consultantProfileId) return;
  await assertExpertStandsInTx(
    tx,
    plan.consultantProfileId,
    CHECKOUT_LABEL[appointmentType] ?? "This booking",
  );
}
