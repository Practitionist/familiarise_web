import { isApprovedStatus } from "@/lib/appointments/status";

export const SUPPORT_PATH = "/support";

/**
 * Where an expert places a new time on a booking with no session left: the
 * allocation grid takes an approved request; anything else goes to support.
 */
export function newTimeDoor(args: {
  consultantId: string;
  status: string | null | undefined;
  consultationId?: string | null;
  subscriptionId?: string | null;
}): { label: string; href: string } {
  const requestId = args.consultationId ?? args.subscriptionId;
  if (!isApprovedStatus(args.status) || !requestId) {
    return { label: "Contact support", href: SUPPORT_PATH };
  }
  const type = args.consultationId ? "consultation" : "subscription";
  return {
    label: "Place a new time",
    href: `/dashboard/consultant/${encodeURIComponent(args.consultantId)}/requests/${encodeURIComponent(requestId)}/allocate?type=${type}`,
  };
}
