/**
 * @deprecated since Arch 4-Modified (Issue #681).
 *
 * Seat-based entitlement was replaced by `Program` + `ProgramAssignment`
 * — see `lib/api/organizations/program-helpers.ts`. The
 * `OrganizationProfile.seatsTotal` / `seatsUsed` pair no longer exists.
 *
 * This shim is intentionally NOT a working implementation — any remaining
 * caller hits a thrown error and must be migrated to
 * `claimProgramAssignment` / `recordBookingUtilization` from
 * `./program-helpers.ts`.
 *
 * The file will be deleted at the end of Phase 2 once all callers are
 * rewritten.
 */

import type { Prisma } from "@prisma/client";

type TxClient = Prisma.TransactionClient;

function notImplemented(name: string): never {
  throw new Error(
    `[arch4-migration] ${name} has been removed. Use program-helpers.ts instead.`,
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function acquireSeat(
  _tx: TxClient,
  _billingAccountId: string,
): Promise<boolean> {
  notImplemented("acquireSeat");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function releaseSeat(
  _tx: TxClient,
  _billingAccountId: string,
): Promise<void> {
  notImplemented("releaseSeat");
}
