import { EarningStatus, type Prisma } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import {
  RELEASABLE_PAYMENT,
  clearOfIncidents,
  undecidedIncidents,
} from "@/scripts/earnings/release-earnings";

export interface TrustParkRelease {
  ready: number;
  pending: number;
  heldRestamped: number;
}

/**
 * Releases every earning parked on sponsor `sponsorOrgId`'s trust, consultant
 * and host-org alike, keyed on the payment's sponsor rather than the earner.
 * A matured, releasable row goes READY, any other PENDING; a HELD row will
 * restore to PENDING when its last hold lifts. A row whose booking has a
 * session inside an undecided incident is not releasable, as in the release run.
 */
export async function releaseSponsorTrustPark(
  tx: Pick<
    Tx,
    "consultantEarnings" | "organizationEarnings" | "platformIncident"
  >,
  sponsorOrgId: string,
  now: Date = new Date(),
): Promise<TrustParkRelease> {
  const sponsored = { organizationId: sponsorOrgId };
  const incidents = await undecidedIncidents(tx);
  const matured = {
    status: EarningStatus.PENDING_TRUST,
    holdUntil: { lte: now },
    payment: { ...RELEASABLE_PAYMENT, ...sponsored },
    ...clearOfIncidents(incidents),
  } satisfies Prisma.ConsultantEarningsWhereInput &
    Prisma.OrganizationEarningsWhereInput;
  const parked = {
    status: EarningStatus.PENDING_TRUST,
    payment: sponsored,
  } satisfies Prisma.ConsultantEarningsWhereInput &
    Prisma.OrganizationEarningsWhereInput;
  const held = {
    status: EarningStatus.HELD,
    preHoldStatus: EarningStatus.PENDING_TRUST,
    payment: sponsored,
  } satisfies Prisma.ConsultantEarningsWhereInput &
    Prisma.OrganizationEarningsWhereInput;

  const ready =
    (
      await tx.consultantEarnings.updateMany({
        where: matured,
        data: { status: EarningStatus.READY },
      })
    ).count +
    (
      await tx.organizationEarnings.updateMany({
        where: matured,
        data: { status: EarningStatus.READY },
      })
    ).count;
  const pending =
    (
      await tx.consultantEarnings.updateMany({
        where: parked,
        data: { status: EarningStatus.PENDING },
      })
    ).count +
    (
      await tx.organizationEarnings.updateMany({
        where: parked,
        data: { status: EarningStatus.PENDING },
      })
    ).count;
  const heldRestamped =
    (
      await tx.consultantEarnings.updateMany({
        where: held,
        data: { preHoldStatus: EarningStatus.PENDING },
      })
    ).count +
    (
      await tx.organizationEarnings.updateMany({
        where: held,
        data: { preHoldStatus: EarningStatus.PENDING },
      })
    ).count;
  return { ready, pending, heldRestamped };
}
