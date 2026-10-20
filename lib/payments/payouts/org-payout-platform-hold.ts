import type { PayoutStatus } from "@prisma/client";

import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import type { Tx } from "@/lib/prisma";

type HoldDb = Pick<Tx, "organizationPayout">;

/** Only a payout not yet handed to the gateway can be held. */
const HOLDABLE: PayoutStatus[] = ["PENDING", "APPROVED"];

async function readPayout(db: HoldDb, id: string) {
  const row = await db.organizationPayout.findUnique({
    where: { id },
    select: { status: true, platformHeldAt: true },
  });
  if (!row) {
    throw new OpsRefusal("ORG_PAYOUT_NOT_FOUND", "Payout not found.", 404);
  }
  return row;
}

/** Stamps `platformHeldAt`, which the payout run's claim refuses; answers the status it held. */
export async function holdOrgPayout(
  db: HoldDb,
  id: string,
): Promise<PayoutStatus> {
  const row = await readPayout(db, id);
  if (row.platformHeldAt) {
    throw new OpsRefusal(
      "ORG_PAYOUT_ALREADY_HELD",
      "This payout is already held.",
    );
  }
  if (!HOLDABLE.includes(row.status)) {
    throw new OpsRefusal(
      "ORG_PAYOUT_NOT_HOLDABLE",
      `Only a pending or approved payout can be held (this one is ${row.status}).`,
    );
  }
  const held = await db.organizationPayout.updateMany({
    where: { id, status: { in: HOLDABLE }, platformHeldAt: null },
    data: { platformHeldAt: new Date() },
  });
  if (held.count === 0) {
    throw new OpsRefusal(
      "ORG_PAYOUT_CHANGED",
      "The payout changed while you were acting on it — reload and try again.",
    );
  }
  return row.status;
}

/** Clears the hold; answers the payout's status. */
export async function releaseOrgPayoutHold(
  db: HoldDb,
  id: string,
): Promise<PayoutStatus> {
  const row = await readPayout(db, id);
  const released = await db.organizationPayout.updateMany({
    where: { id, platformHeldAt: { not: null } },
    data: { platformHeldAt: null },
  });
  if (released.count === 0) {
    throw new OpsRefusal("ORG_PAYOUT_NOT_HELD", "This payout is not held.");
  }
  return row.status;
}
