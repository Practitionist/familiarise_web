import { AppointmentStatus, PaymentStatus, type Prisma } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { assertExpertVerified } from "@/lib/booking/booking-rule-error";

/**
 * Approving a request nobody has paid for needs a verified expert: the detail
 * PATCH routes and allocation ask this before the approval write. A booking
 * already approved, or one with a captured payment, is honoured and passes.
 */
export async function assertUnpaidApprovalVerified(
  tx: Pick<Tx, "consultation" | "subscription">,
  kind: "consultation" | "subscription",
  id: string,
): Promise<void> {
  const select = {
    status: true,
    appointment: {
      select: {
        payment: {
          where: { paymentStatus: PaymentStatus.SUCCEEDED, deletedAt: null },
          take: 1,
          select: { id: true },
        },
      },
    },
  } satisfies Prisma.ConsultationSelect & Prisma.SubscriptionSelect;
  const expert = {
    select: { consultantProfile: { select: { verificationStatus: true } } },
  } as const;
  const row =
    kind === "consultation"
      ? await tx.consultation.findUnique({
          where: { id },
          select: { ...select, consultationPlan: expert },
        })
      : await tx.subscription.findUnique({
          where: { id },
          select: { ...select, subscriptionPlan: expert },
        });
  if (!row || row.status === AppointmentStatus.APPROVED) return;
  if ((row.appointment?.payment?.length ?? 0) > 0) return;
  const plan =
    "consultationPlan" in row ? row.consultationPlan : row.subscriptionPlan;
  // Refuses on the expert's recorded status; a profile-less plan has none.
  const status = plan?.consultantProfile?.verificationStatus;
  assertExpertVerified(
    status ? { verificationStatus: status } : null,
    kind === "consultation" ? "This consultation" : "This subscription",
  );
}
