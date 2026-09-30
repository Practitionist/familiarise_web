/** A definitive slot refusal, not transient lock contention or a payment failure. */
export function isAvailabilityRefusal(error: { errorType?: string }) {
  return error.errorType === "AVAILABILITY_ERROR";
}

export function consultationRecoveryHref(consultantId: string, planId: string) {
  const params = new URLSearchParams({
    plan: planId,
    action: "book",
    conflict: "1",
  });
  return `/explore/experts/${encodeURIComponent(consultantId)}?${params}`;
}
