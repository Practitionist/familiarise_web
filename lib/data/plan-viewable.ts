import { renderMemo } from "@/lib/render-memo";
import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { isPlanViewable } from "@/lib/api/plans/visibility";
import type {
  ConsultantVerificationStatus,
  OfferingPlanStatus,
  OrgPlanVisibility,
} from "@prisma/client";

// Per-request memo so a layout and its page share one membership query.
const hasActiveMembership = renderMemo(
  async (userId: string, organizationId: string): Promise<boolean> =>
    (await prisma.membership.findFirst({
      where: { userId, organizationId, status: "ACTIVE" },
      select: { id: true },
    })) !== null,
);

/**
 * Server-side wiring for {@link isPlanViewable}.
 *
 * Split from the pure predicate so the gate itself stays unit-testable without
 * a database, and so the four detail pages share one membership query rather
 * than each inventing their own.
 */
export async function canViewPlanDetail(
  plan: {
    visibility: OrgPlanVisibility;
    organizationId: string | null;
    archivedAt?: Date | null;
    /** #1527 Q4 — select it on 1:1 and subscription plans so drafts 404. */
    status?: OfferingPlanStatus | null;
    /** Select `publicProfileFacts` so an unverified expert's plan 404s. */
    consultantProfile: {
      verificationStatus: ConsultantVerificationStatus;
      deletedAt: Date | null;
    } | null;
  } | null,
  // Pass a session already fetched alongside the plan (e.g. via Promise.all
  // in the detail pages) so the gate doesn't serialize behind it. When
  // omitted, the gate fetches its own session exactly as before.
  session?: Awaited<ReturnType<typeof getSession>> | null,
): Promise<boolean> {
  // A session-lookup failure is treated as anonymous by design (matches
  // app/api/newsletter/route.ts's identical fallback) — captured for
  // visibility only; the anonymous-fallback outcome itself is unchanged.
  const resolvedSession =
    session !== undefined
      ? session
      : await getSession().catch((error) => {
          reportSentryError(error, { subsystem: "plans", expected: true });
          return null;
        });
  return isPlanViewable(
    plan,
    resolvedSession?.user?.id ?? null,
    (args) => hasActiveMembership(args.userId, args.organizationId),
    // Owner preview: an author sees their own DRAFT / archived offering at the
    // real detail URL. Nobody else's access changes.
    resolvedSession?.user?.consultantProfileId ?? null,
  );
}

/**
 * The by-id plan API gate. A public plan reads no session; otherwise a failed
 * lookup throws `SessionLookupFailedError` (503), so it never reads as hidden.
 */
export async function canViewPlanById(
  plan: Parameters<typeof canViewPlanDetail>[0],
): Promise<boolean> {
  if (await canViewPlanDetail(plan, null)) return true;
  return canViewPlanDetail(plan, await getSession());
}
