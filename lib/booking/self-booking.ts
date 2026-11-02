import { Refusal } from "@/lib/errors/refusal";

/**
 * Nobody books, requests or trials a plan they own or co-host (ACCEPTED or
 * PENDING, as checkout loads them). One person may hold both profiles, so
 * without this a seller could route a sponsor's money, a request hold or a
 * trial to their own calendar and payout.
 * Every buyer door (checkout, request-for-approval, trial create, backup
 * interest) calls it with the caller's consultant profile id.
 */
export function assertNotSelfBooking(
  buyerConsultantProfileId: string | null | undefined,
  plan: {
    consultantProfileId: string | null;
    collaboratorProfileIds?: readonly string[];
  },
): void {
  if (!buyerConsultantProfileId) return;
  if (
    plan.consultantProfileId === buyerConsultantProfileId ||
    (plan.collaboratorProfileIds ?? []).includes(buyerConsultantProfileId)
  ) {
    throw new Refusal({
      code: "SELF_BOOKING",
      httpStatus: 409,
      userMessage: "You cannot book your own plan.",
    });
  }
}
