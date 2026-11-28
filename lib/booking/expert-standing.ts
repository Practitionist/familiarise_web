import {
  BookingMode,
  ConsultantVerificationStatus,
  Prisma,
} from "@prisma/client";
import { z } from "zod";

import type { Tx } from "@/lib/prisma";
import { expertNotVerifiedError } from "@/lib/booking/booking-rule-error";
import { isPublicExpertProfile } from "@/lib/profiles/public-profile";

const StandingRowsSchema = z.array(
  z.object({
    verificationStatus: z.nativeEnum(ConsultantVerificationStatus),
    deletedAt: z.date().nullable(),
    acceptingRequests: z.boolean(),
    bookingMode: z.nativeEnum(BookingMode),
    maxOpenRequests: z.number().int().nullable(),
  }),
);

/** The expert's row as the share-locked read returns it: standing and intake settings. */
export type ExpertStanding = z.infer<typeof StandingRowsSchema>[number];

/**
 * The expert's standing and intake settings (pause, booking mode, open-request
 * cap) read under a share lock, so a profile write waits for this transaction
 * and a door decides on what the row holds now, not on what it read earlier.
 */
export async function readExpertStandingForShare(
  tx: Pick<Tx, "$queryRaw">,
  consultantProfileId: string,
): Promise<ExpertStanding | null> {
  const [row] = StandingRowsSchema.parse(
    await tx.$queryRaw(
      Prisma.sql`SELECT "verificationStatus", "deletedAt", "acceptingRequests", "bookingMode", "maxOpenRequests" FROM "ConsultantProfile" WHERE "id" = ${consultantProfileId} FOR SHARE`,
    ),
  );
  return row ?? null;
}

/**
 * Refuses a sale for an expert who is not verified or is deleted, reading the
 * profile under a share lock: a reject's profile write waits for this
 * transaction, so the unpaid-sale ending that follows it sees what this wrote.
 * Returns the locked row for a door that also decides on the intake settings.
 */
export async function assertExpertStandsInTx(
  tx: Pick<Tx, "$queryRaw">,
  consultantProfileId: string,
  label: string,
): Promise<ExpertStanding | null> {
  const row = await readExpertStandingForShare(tx, consultantProfileId);
  if (row && !isPublicExpertProfile(row)) throw expertNotVerifiedError(label);
  return row;
}

/** The refusal copy each checkout type answers with. */
export const CHECKOUT_LABEL: Record<string, string> = {
  CONSULTATION: "This consultation",
  SUBSCRIPTION: "This subscription",
  WEBINAR: "This webinar",
  CLASS: "This class",
};

type PlanOwnerTx = Pick<
  Tx,
  "consultationPlan" | "subscriptionPlan" | "webinarPlan" | "classPlan"
>;

function readPlanOwner(
  tx: PlanOwnerTx,
  appointmentType: string,
  planId: string,
): Promise<{ consultantProfileId: string | null } | null> {
  const where = {
    where: { id: planId },
    select: { consultantProfileId: true },
  } as const;
  switch (appointmentType) {
    case "CONSULTATION":
      return tx.consultationPlan.findUnique(where);
    case "SUBSCRIPTION":
      return tx.subscriptionPlan.findUnique(where);
    case "WEBINAR":
      return tx.webinarPlan.findUnique(where);
    case "CLASS":
      return tx.classPlan.findUnique(where);
    default:
      return Promise.resolve(null);
  }
}

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
  const plan = await readPlanOwner(tx, appointmentType, planId);
  if (!plan?.consultantProfileId) return;
  await assertExpertStandsInTx(
    tx,
    plan.consultantProfileId,
    CHECKOUT_LABEL[appointmentType] ?? "This booking",
  );
}
